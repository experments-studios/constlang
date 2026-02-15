(function(global) {

    let compiledShellCache = null;
    let extractedShellConfigCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.sh')) mimeType = 'text/plain';
        if(filename.endsWith('.bash')) mimeType = 'text/plain';
        
        element.setAttribute('href', `data:${mimeType};charset=utf-8,` + encodeURIComponent(text));
        element.setAttribute('download', filename);
        element.style.display = 'none';
        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);
    }

    async function _traverseDirectory(handle, path = "") {
        for await (const entry of handle.values()) {
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                if (entry.name.endsWith('.clg') || entry.name.endsWith('.nat')) {
                    const content = await file.text();
                    sessionStorage.setItem(entry.name, content);
                    console.log(`[READ] ${entry.name}`);
                }
            } else if (entry.kind === 'directory') {
                await _traverseDirectory(entry, path ? `${path}/${entry.name}` : entry.name);
            }
        }
    }

    async function _bundle(startFile) {
        console.log(`[PHASE 1] Bundling....'${startFile}'`);
        
        const fileCache = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key.endsWith('.clg') || key.endsWith('.nat')) {
                fileCache[key] = sessionStorage.getItem(key);
            }
        }

        if (!fileCache[startFile]) {
            console.error(`ENTRY FILE NOT FOUND: (${startFile})`);
            return null;
        }

        const processedFiles = new Set();

        async function processFile(filename, moduleFilter = null) {
            if (processedFiles.has(filename)) return "";
            processedFiles.add(filename);

            let content = fileCache[filename];
            if (!content) return "";

            if (filename.endsWith('.nat')) {
                const moduleRegex = /<module="([^"]+)">([\s\S]*?)<\/module>/g;
                let matches;
                let moduleContent = "";
                
                while ((matches = moduleRegex.exec(content)) !== null) {
                    const moduleName = matches[1];
                    const moduleBody = matches[2];
                    
                    if (!moduleFilter || moduleFilter === moduleName) {
                        moduleContent += moduleBody + "\n";
                    }
                }
                
                return moduleContent;
            }

            const installRegex = /^\s*#install\s+(.*?);?\s*$/gm;
            const importRegex = /^\s*#import\s+nat:\s*([a-zA-Z0-9_.]+)(?:\s+mod:\s*([a-zA-Z0-9_]+))?\s*;?\s*$/gm;
            const importClgRegex = /^\s*#import\s+clg:\s*([a-zA-Z0-9_.]+)\s*;?\s*$/gm;
            const importDirectRegex = /^\s*#import\s+([a-zA-Z0-9_.]+)\s*;?\s*$/gm;
            const compiledRegex = /^\s*#compiled\s+([a-zA-Z0-9_.]+)\s*;?\s*$/gm;
            let bundledDependencies = "";

            const installMatches = [...content.matchAll(installRegex)];
            for (const match of installMatches) {
                try {
                    const res = await fetch(match[1].trim());
                    bundledDependencies += `# ${await res.text()}\n\n`;
                } catch (e) { console.error("Install Error", e); }
            }
            content = content.replace(installRegex, '');

            const importNatMatches = [...content.matchAll(importRegex)];
            for (const match of importNatMatches) {
                const natFile = match[1].trim();
                const module = match[2] ? match[2].trim() : null;
                bundledDependencies += await processFile(natFile, module) + "\n\n";
            }
            content = content.replace(importRegex, '');

            const importClgMatches = [...content.matchAll(importClgRegex)];
            for (const match of importClgMatches) {
                bundledDependencies += await processFile(match[1].trim()) + "\n\n";
            }
            content = content.replace(importClgRegex, '');

            const importDirectMatches = [...content.matchAll(importDirectRegex)];
            for (const match of importDirectMatches) {
                let file = match[1].trim();
                if (!file.endsWith('.clg') && !file.endsWith('.nat')) {
                    file += '.clg';
                }
                bundledDependencies += await processFile(file) + "\n\n";
            }
            content = content.replace(importDirectRegex, '');

            const compiledMatches = [...content.matchAll(compiledRegex)];
            for (const match of compiledMatches) {
                bundledDependencies += await processFile(match[1].trim()) + "\n\n";
            }
            content = content.replace(compiledRegex, '');

            return `\n${bundledDependencies}\n${content}\n`;
        }

        return await processFile(startFile);
    }

    function _containsSpecialCommand(code) {
        if (code.includes('cmd.fn')) return true;
        if (code.includes('cmd.save')) return true;
        if (code.includes('create.ctfile')) return true;
        if (code.includes('create.ctfolder')) return true;
        
        const hashCommands = ['#import', '#install', '#compiled'];
        for (const cmd of hashCommands) {
            const regex = new RegExp(`^\\s*${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm');
            if (regex.test(code)) return true;
        }
        return false;
    }

    function _transpile(constlangCode) {
        console.log("[TRANSPILE] Compiler loading...");
        let shCode = constlangCode;
        let passCount = 0;

        const hasSpecialCommands = _containsSpecialCommand(shCode);
        
        if (hasSpecialCommands) {
            console.log("[PHASE 1-4] Special commands detected. Starting multi-pass compilation loop...");
            
            while (passCount < MAX_COMPILATION_PASSES) {
                passCount++;
                const beforeCode = shCode;
                console.log(`[PASS ${passCount}] Processing...`);

                const macros = [];
                const macroRegex = /cmd\.fn\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
                shCode = shCode.replace(macroRegex, (match, pattern, template) => {
                    macros.push({ pattern: pattern.trim(), template: template.trim() });
                    return "";
                });

                for (const macro of macros) {
                    let regexPattern = macro.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const varNames = [];
                    regexPattern = regexPattern.replace(/\\\$\\\{cmd\\\^(.*?)\\\}/g, (match, varName) => {
                        varNames.push(varName);
                        return '([\\s\\S]*?)';
                    });
                    
                    let shTemplate = macro.template;
                    for (let i = 0; i < varNames.length; i++) {
                        shTemplate = shTemplate.replace(new RegExp(`\\$\\{cmd\\^${varNames[i]}\\}|\\$\\{${varNames[i]}}`, 'g'), `$${i + 1}`);
                    }
                    try { shCode = shCode.replace(new RegExp(regexPattern, 'gm'), shTemplate); } catch (e) {}
                }

                shCode = shCode.replace(/cmd\.save\(\s*([^)]*)\s*\)/g, 'echo "$1"');
                shCode = shCode.replace(/create\.ctfolder\s*\(\s*([a-zA-Z0-9_"'\s]+)\s*\)/g, 'mkdir -p $1');
                shCode = shCode.replace(/create\.ctfile\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\{([\s\S]*?)\}/g, 
                    (match, filename, varname, content) => {
                        return `echo "${content.trim()}" > $1`;
                    }
                );

                if (!_containsSpecialCommand(shCode)) {
                    console.log(`[PASS ${passCount}/PHASE 5] Validation complete. No special commands found. Loop exiting.`);
                    break;
                }

                if (shCode === beforeCode) {
                    console.log(`[PASS ${passCount}/PHASE 5] No changes detected in this pass but special commands remain.`);
                    console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                    return null;
                }
            }

            if (passCount >= MAX_COMPILATION_PASSES && _containsSpecialCommand(shCode)) {
                console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                return null;
            }
        } else {
            console.log("[PHASE 1-4] No special commands found in initial code. Skipping loop.");
        }

        if (_containsSpecialCommand(shCode)) {
            console.error(`COMPILATION ERROR: Special commands remain after compilation.`);
            return null;
        }

        shCode = shCode.replace(/\/\/.*/g, '');
        shCode = shCode.replace(/\/\*[\s\S]*?\*\//g, '');

        const configRegex = /config\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        shCode = shCode.replace(configRegex, (match, content) => {
            extractedShellConfigCache += content.trim() + "\n";
            return "";
        });

        shCode = shCode.replace(/addon\.app\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');

        // PHASE 2: Tip dönüşümleri
        console.log("[PHASE 2] Type conversions...");
        shCode = shCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, '$1=$2');
        shCode = shCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, '$1=$2');
        shCode = shCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, '$1=$2');

        // PHASE 3: Print işlemleri
        console.log("[PHASE 3] Print operations...");
        shCode = shCode.replace(/print\s*\(([\s\S]*?)\);?/g, 'echo "$1"');
        shCode = shCode.replace(/print\.text\s*\(([\s\S]*?)\);?/g, 'echo -n "$1"');
        shCode = shCode.replace(/print\.ln\s*\(([\s\S]*?)\);?/g, 'echo "$1"');
        shCode = shCode.replace(/print\.error\s*\(([\s\S]*?)\);?/g, 'echo "$1" >&2');
        shCode = shCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'echo "$1"');
        shCode = shCode.replace(/console\.error\(([\s\S]*?)\);?/g, 'echo "$1" >&2');
        shCode = shCode.replace(/error\.log\s*\(([\s\S]*?)\);?/g, 'echo "$1" >> error.log');
        shCode = shCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'echo "$1"');

        // PHASE 4: Input işlemleri
        console.log("[PHASE 4] Input operations...");
        shCode = shCode.replace(/input\s*\(([\s\S]*?)\);?/g, 'read INPUT');
        shCode = shCode.replace(/input\.line\s*\(([\s\S]*?)\);?/g, 'read INPUT');
        shCode = shCode.replace(/read\.line\s*\(\s*\);?/g, 'read INPUT');
        shCode = shCode.replace(/read\.data\s*\(([\s\S]*?)\);?/g, 'read -p "$1" INPUT');

        // PHASE 5: String işlemleri
        console.log("[PHASE 5] String operations...");
        shCode = shCode.replace(/string\.tolower\(([\s\S]*?)\);?/g, 'echo "$1" | tr "[:upper:]" "[:lower:]"');
        shCode = shCode.replace(/string\.toupper\(([\s\S]*?)\);?/g, 'echo "$1" | tr "[:lower:]" "[:upper:]"');
        shCode = shCode.replace(/string\.trim\(([\s\S]*?)\);?/g, 'echo "$1" | xargs');
        shCode = shCode.replace(/string\.replace\(([\s\S]*?),([\s\S]*?),([\s\S]*?)\);?/g, 'echo "$1" | sed "s/$2/$3/g"');
        shCode = shCode.replace(/string\.split\(([\s\S]*?),([\s\S]*?)\);?/g, 'echo "$1" | cut -d "$2" -f1');
        shCode = shCode.replace(/string\.contains\(([\s\S]*?),([\s\S]*?)\);?/g, '[[ "$1" == *"$2"* ]]');
        shCode = shCode.replace(/string\.startswith\(([\s\S]*?),([\s\S]*?)\);?/g, '[[ "$1" == "$2"* ]]');
        shCode = shCode.replace(/string\.endswith\(([\s\S]*?),([\s\S]*?)\);?/g, '[[ "$1" == *"$2" ]]');
        shCode = shCode.replace(/string\.length\(([\s\S]*?)\);?/g, '${#$1}');
        shCode = shCode.replace(/string\.concat\(([\s\S]*?),([\s\S]*?)\);?/g, '"$1$2"');
        shCode = shCode.replace(/string\.join\(([\s\S]*?),([\s\S]*?)\);?/g, 'printf "%s$1" $2');

        // PHASE 6: Array/List işlemleri
        console.log("[PHASE 6] Array operations...");
        shCode = shCode.replace(/\.list\.add\(([\s\S]*?)\);?/g, 'list+=("$1")');
        shCode = shCode.replace(/\.list\.size\s*\(\s*\);?/g, '${#list[@]}');
        shCode = shCode.replace(/\.list\.count\(([\s\S]*?)\);?/g, '${#list[@]}');
        shCode = shCode.replace(/\.list\.clear\s*\(\s*\);?/g, 'list=()');
        shCode = shCode.replace(/\.list\.delete\(([\s\S]*?)\);?/g, 'unset list[$1]');
        shCode = shCode.replace(/\.list\.get\(([\s\S]*?)\);?/g, '${list[$1]}');
        shCode = shCode.replace(/\.list\.contains\(([\s\S]*?)\);?/g, '[[ " ${list[@]} " =~ " $1 " ]]');

        // PHASE 7: Dosya işlemleri
        console.log("[PHASE 7] File operations...");
        shCode = shCode.replace(/file\.add\(([\s\S]*?)\);?/g, 'touch $1');
        shCode = shCode.replace(/folder\.add\(([\s\S]*?)\);?/g, 'mkdir -p $1');
        shCode = shCode.replace(/file\.load\(([\s\S]*?)\);?/g, 'cat $1');
        shCode = shCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'open $1');
        shCode = shCode.replace(/open\.folder\(([\s\S]*?)\);?/g, 'open -a Finder $1');
        shCode = shCode.replace(/file\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'mv $1 $2');
        shCode = shCode.replace(/folder\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'mv $1 $2');
        shCode = shCode.replace(/file\.copy\(([\s\S]*?),([\s\S]*?)\);?/g, 'cp $1 $2');
        shCode = shCode.replace(/folder\.fileinfo\(([\s\S]*?)\);?/g, 'ls -la $1');
        shCode = shCode.replace(/folder\.folderinfo\(([\s\S]*?)\);?/g, 'ls -d $1/*/');

        // PHASE 8: System işlemleri
        console.log("[PHASE 8] System operations...");
        shCode = shCode.replace(/system\.beep\(([\s\S]*?)\);?/g, 'echo -e "\\a"');
        shCode = shCode.replace(/system\.stop\(([\s\S]*?)\);?/g, 'sleep $(($1/1000))');
        shCode = shCode.replace(/system\.stop\.seconds\(([\s\S]*?)\);?/g, 'sleep $1');
        shCode = shCode.replace(/system\.stop\.minutes\(([\s\S]*?)\);?/g, 'sleep $(($1*60))');
        shCode = shCode.replace(/system\.stop\.hours\(([\s\S]*?)\);?/g, 'sleep $(($1*3600))');
        shCode = shCode.replace(/system\.stop\.ms\(([\s\S]*?)\);?/g, 'usleep $(($1*1000))');
        shCode = shCode.replace(/open\.window\s*\(([\s\S]*?)\);?/g, 'open -a "$1"');
        shCode = shCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, 'uname -s');

        // PHASE 9: Math işlemleri
        console.log("[PHASE 9] Math operations...");
        shCode = shCode.replace(/math\.abs\(([\s\S]*?)\);?/g, 'echo "sqrt(($1)^2)" | bc');
        shCode = shCode.replace(/math\.sqrt\(([\s\S]*?)\);?/g, 'echo "sqrt($1)" | bc -l');
        shCode = shCode.replace(/math\.pow\(([\s\S]*?),([\s\S]*?)\);?/g, 'echo "$1^$2" | bc -l');
        shCode = shCode.replace(/math\.floor\(([\s\S]*?)\);?/g, 'echo "$1" | cut -d. -f1');
        shCode = shCode.replace(/math\.ceil\(([\s\S]*?)\);?/g, 'awk "{print int($1) + (($1 > int($1)) ? 1 : 0)}"');
        shCode = shCode.replace(/math\.round\(([\s\S]*?)\);?/g, 'printf "%.0f\\n" $1');
        shCode = shCode.replace(/math\.random\s*\(\s*\);?/g, '$(($RANDOM % 100))');

        // PHASE 10: Loop yapıları
        console.log("[PHASE 10] Loop structures...");
        shCode = shCode.replace(/\bfor\s*\(\s*let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(\d+);\s*\1\s*<\s*(\d+);\s*\1\s*\+\+\s*\)/g, 'for (($2; $1 < $3; $1++))');
        shCode = shCode.replace(/\bwhile\s*\(([\s\S]*?)\)/g, 'while [[ $1 ]]; do');
        shCode = shCode.replace(/\bdo\s*{([\s\S]*?)}\s*while\s*\(([\s\S]*?)\)/g, 'while [[ $2 ]]; do\n$1\ndone');
        shCode = shCode.replace(/foreach\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, 'for $1 in ${$2[@]}; do');

        // PHASE 11: Conditional statements
        console.log("[PHASE 11] Conditional structures...");
        shCode = shCode.replace(/\bif\s*\(/g, 'if [[ ');
        shCode = shCode.replace(/\)\s*{/g, ' ]]; then');
        shCode = shCode.replace(/}\s*else\s+if\s*\(/g, 'elif [[ ');
        shCode = shCode.replace(/}\s*else\s*{/g, 'else');
        shCode = shCode.replace(/}/g, 'fi');
        shCode = shCode.replace(/==\s*/g, ' == ');
        shCode = shCode.replace(/!=\s*/g, ' != ');
        shCode = shCode.replace(/<\s*/g, ' -lt ');
        shCode = shCode.replace(/>\s*/g, ' -gt ');

        // PHASE 12: Function declarations
        console.log("[PHASE 12] Function declarations...");
        shCode = shCode.replace(/\bfunc\.void\s+([\w\d]+)\s*\((.*?)\)\s*{/g, '$1() {\n\t# Function: $1($2)');
        shCode = shCode.replace(/\breturn\s+/g, 'return ');

        // PHASE 13: Static declarations
        console.log("[PHASE 13] Static declarations...");
        shCode = shCode.replace(/^\s*static\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'declare -r $1=$2');

        // PHASE 14: Header ekleme
        console.log("[PHASE 14] Adding header...");
        if (!shCode.includes('#!/bin/bash')) {
            shCode = `#!/bin/bash\n# Auto-generated Shell Script\nset -e\n\n${shCode}`;
        }

        // PHASE 15: Footer ekleme
        console.log("[PHASE 15] Adding footer...");
        shCode += `\n\nexit 0`;

        console.log("[COMPILATION] Successfully completed all passes and validation.");
        return shCode;
    }

    const compiler = {};

    compiler.add = async function() {
        try {
            const dirHandle = await global.showDirectoryPicker();
            sessionStorage.clear();
            extractedShellConfigCache = "";
            
            console.log("Analyzing directory...");
            await _traverseDirectory(dirHandle);
            console.log("Files loaded. Compile with: 'compiler.start()'.");
        } catch (e) {
            console.error("Directory selection error:", e);
        }
    };

    compiler.start = async function() {
        console.log("%c[COMPILATION START]", "color: lime; font-weight: bold;");
        compiledShellCache = null;
        extractedShellConfigCache = "";

        const bundledCode = await _bundle(entryPoint);
        if (!bundledCode) return;

        try {
            const shBody = _transpile(bundledCode);
            
            if (!shBody) {
                console.error("[COMPILATION FAILED] Transpilation returned null. Check error log above.");
                return;
            }

            compiledShellCache = `${shBody}`;

            console.log("%c[COMPILATION SUCCESSFUL]", "color: lime; font-weight: bold;");
            console.log("Download with: 'compiler.download()'.");

        } catch (e) {
            console.error("[COMPILATION ERROR]:", e);
        }
    };

    compiler.download = function(filename = "main.sh") {
        if (!compiledShellCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        console.log("Downloading Shell Script...");
        _downloadFile(filename, compiledShellCache);

        if (extractedShellConfigCache.trim() !== "") {
            console.log("Downloading Config File...");
            _downloadFile("config.sh", extractedShellConfigCache);
        }
    };

    compiler.compile = async function() {
        console.log(`%c[SHELL COMPILATION START]`, "color: yellow; font-weight: bold;");
        await compiler.add();
        await compiler.start();
        console.log(`%c[SHELL COMPILATION COMPLETE]`, "color: yellow; font-weight: bold;");
    };

    global.shellCompiler = compiler;

})(typeof window !== 'undefined' ? window : global);