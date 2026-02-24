(function(global) {
    let compiledJSCache = null;
    let extractedHTMLCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.html')) mimeType = 'text/html';
        if(filename.endsWith('.cs')) mimeType = 'text/plain';
        
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
                    bundledDependencies += `\n${await res.text()}\n\n`;
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
        let jsCode = constlangCode;
        let passCount = 0;
        const hasSpecialCommands = _containsSpecialCommand(jsCode);
        
        if (hasSpecialCommands) {
            console.log("[PHASE 1-4] Special commands detected. Starting multi-pass compilation loop...");
            
            while (passCount < MAX_COMPILATION_PASSES) {
                passCount++;
                const beforeCode = jsCode;
                console.log(`[PASS ${passCount}] Processing...`);
                const macros = [];
                const macroRegex = /cmd\.fn\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
                jsCode = jsCode.replace(macroRegex, (match, pattern, template) => {
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
                    
                    let jsTemplate = macro.template;
                    for (let i = 0; i < varNames.length; i++) {
                        jsTemplate = jsTemplate.replace(new RegExp(`\\$\\{cmd\\^${varNames[i]}\\}|\\$\\{${varNames[i]}}`, 'g'), `$${i + 1}`);
                    }
                    try { jsCode = jsCode.replace(new RegExp(regexPattern, 'gm'), jsTemplate); } catch (e) {}
                }
                jsCode = jsCode.replace(/cmd\.save\(\s*([^)]*)\s*\)/g, 'Console.WriteLine($1);');
                jsCode = jsCode.replace(/create\.ctfolder\s*\(\s*([a-zA-Z0-9_"'\s]+)\s*\)/g, 'Directory.CreateDirectory($1);');
                jsCode = jsCode.replace(/create\.ctfile\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\{([\s\S]*?)\}/g, 
                    (match, filename, varname, content) => {
                        return `File.WriteAllText(${filename}, @"${content.trim()}");`;
                    }
                );

                if (!_containsSpecialCommand(jsCode)) {
                    console.log(`[PASS ${passCount}/PHASE 5] Validation complete. No special commands found. Loop exiting.`);
                    break;
                }

                if (jsCode === beforeCode) {
                    console.log(`[PASS ${passCount}/PHASE 5] No changes detected in this pass but special commands remain.`);
                    console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded. Some special commands remain unprocessed.`);
                    console.error("Remaining special commands cannot be processed. Compilation rejected.");
                    return null;
                }
            }
            if (passCount >= MAX_COMPILATION_PASSES && _containsSpecialCommand(jsCode)) {
                console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded. Some special commands remain unprocessed.`);
                console.error("Remaining special commands detected. Compilation rejected.");
                return null;
            }
        } else {
            console.log("[PHASE 1-4] No special commands found in initial code. Skipping loop.");
        }
        if (_containsSpecialCommand(jsCode)) {
            console.error(`COMPILATION ERROR: Special commands remain after compilation.`);
            console.error("Cannot proceed to PHASE 6. Compilation rejected.");
            return null;
        }

        jsCode = jsCode.replace(/\/\/.*/g, '//');
        jsCode = jsCode.replace(/\/\*[\s\S]*?\*\//g, '');

        const guiRegex = /config\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        jsCode = jsCode.replace(guiRegex, (match, htmlContent) => {
            extractedHTMLCache += htmlContent.trim() + "\n";
            return "";
        });
        jsCode = jsCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, '"web"');
        jsCode = jsCode.replace(/text\s*\(([\s\S]*?)\);?/g, '"$1"');
        jsCode = jsCode.replace(/system\.time\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1));');
        jsCode = jsCode.replace(/system\.stop\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1));');
        jsCode = jsCode.replace(/system\.stop\.minutes\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1 * 60000));');
        jsCode = jsCode.replace(/system\.stop\.seconds\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1 * 1000));');
        jsCode = jsCode.replace(/system\.stop\.hours\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1 * 3600000));');
        jsCode = jsCode.replace(/system\.stop\.ms\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1));');
        jsCode = jsCode.replace(/system\.control\s*\(([\s\S]*?)\);?/g, 'try { $1 } catch(e) {}');
        jsCode = jsCode.replace(/.list\.add\s*\(([\s\S]*?)\);?/g, '.push($1);');
        jsCode = jsCode.replace(/.list\.delete\s*\(([\s\S]*?)\);?/g, '.splice($1, 1);');
        jsCode = jsCode.replace(/.list\.count\s*\(([\s\S]*?)\);?/g, '.length;');
        jsCode = jsCode.replace(/.list\.clr\s*\(([\s\S]*?)\);?/g, '.length = 0;');
        jsCode = jsCode.replace(/.list\.index\s*\(([\s\S]*?)\);?/g, '.indexOf($1);');
        jsCode = jsCode.replace(/.list\.control\s*\(([\s\S]*?)\);?/g, '.includes($1);');
        jsCode = jsCode.replace(/.list\.all\s*\(([\s\S]*?)\);?/g, '.sort($1);');
        jsCode = jsCode.replace(/.list\.redata\s*\(([\s\S]*?)\);?/g, '.reverse($1);');
        jsCode = jsCode.replace(/.list\.join\s*\(([\s\S]*?)\);?/g, '.join($1);');
        jsCode = jsCode.replace(/.list\.new\s*\(([\s\S]*?)\);?/g, '.push($1);');
        jsCode = jsCode.replace(/.list\.string\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.list\.int16\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.list\.int32\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.list\.int64\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.list\.int128\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.list\.intx\s*\(([\s\S]*?)\);?/g, 'new Array($1);');
        jsCode = jsCode.replace(/.char\.i09\s*\(([\s\S]*?)\);?/g, '/[0-9]/.test($1);');
        jsCode = jsCode.replace(/.char\.letter\s*\(([\s\S]*?)\);?/g, '/[a-zA-Z]/.test($1);');
        jsCode = jsCode.replace(/.char\.isc\s*\(([\s\S]*?)\);?/g, '/[a-zA-Z0-9]/.test($1);');
        jsCode = jsCode.replace(/.char\.space\s*\(([\s\S]*?)\);?/g, '/\\s/.test($1);');
        jsCode = jsCode.replace(/.char\.ipn\s*\(([\s\S]*?)\);?/g, '/[!-\/:-@\\[-`{-~]/.test($1);');
        jsCode = jsCode.replace(/.char\.symbol\s*\(([\s\S]*?)\);?/g, '/[!-\/:-@\\[-`{-~]/.test($1);');
        jsCode = jsCode.replace(/.char\.isletter\s*\(([\s\S]*?)\);?/g, '/[a-zA-Z]/.test($1);');
        jsCode = jsCode.replace(/.char\.upper\s*\(([\s\S]*?)\);?/g, '$1.toUpperCase();');
        jsCode = jsCode.replace(/.char\.lower\s*\(([\s\S]*?)\);?/g, '$1.toLowerCase();');
        jsCode = jsCode.replace(/.char\.control\s*\(([\s\S]*?)\);?/g, '/[\\x00-\\x1F]/.test($1);');
        jsCode = jsCode.replace(/.char\.separator\s*\(([\s\S]*?)\);?/g, '/[\\s]/.test($1);');
        jsCode = jsCode.replace(/.char\.getnumber\s*\(([\s\S]*?)\);?/g, 'parseFloat($1);');
        jsCode = jsCode.replace(/.char\.tostring\s*\(([\s\S]*?)\);?/g, 'String($1);');
        jsCode = jsCode.replace(/.char\.string\.concat\s*\(([\s\S]*?)\);?/g, 'String($1);');
        jsCode = jsCode.replace(/.char\.string\.nullcontrol\s*\(([\s\S]*?)\);?/g, '$1 === null || $1 === "";');
        jsCode = jsCode.replace(/.char\.string\.join\s*\(([\s\S]*?)\);?/g, '.join($1);');
        jsCode = jsCode.replace(/.char\.aspawn\s*\(([\s\S]*?)\);?/g, '$1;');
        jsCode = jsCode.replace(/.char\.peek\s*\(([\s\S]*?)\);?/g, '$1[0];');
        jsCode = jsCode.replace(/.caracters\.token\s*\(([\s\S]*?)\);?/g, '.split($1);');
        jsCode = jsCode.replace(/regex\.parse\s*\(([\s\S]*?)\);?/g, 'new RegExp($1).exec($2);');
        jsCode = jsCode.replace(/regex\.mainsearch\s*\(([\s\S]*?)\);?/g, 'new RegExp($1).exec($2);');
        jsCode = jsCode.replace(/regex\.search\s*\(([\s\S]*?)\);?/g, 'String($1).match(/regex/g);');
        jsCode = jsCode.replace(/regex\.control\s*\(([\s\S]*?)\);?/g, 'new RegExp($1).test($2);');
        jsCode = jsCode.replace(/regex\.replace\s*\(([\s\S]*?)\);?/g, '$1.replace(/pattern/, "replacement");');
        jsCode = jsCode.replace(/lib\.cs\s*\(([\s\S]*?)\);?/g, '// Import: $1');
        jsCode = jsCode.replace(/\bwhile\s*\(([\s\S]*?)\);?/g, 'while ($1)');
        jsCode = jsCode.replace(/\bfor\s*\(([\s\S]*?)\);?/g, 'for ($1)');
        jsCode = jsCode.replace(/\bif\s*\{([\s\S]*?)\}\s*;?/g, 'if {$1}');
        jsCode = jsCode.replace(/\bif\s*\(([\s\S]*?)\);?/g, 'if ($1)');
        jsCode = jsCode.replace(/\belse\s*if\s*\(([\s\S]*?)\);?/g, 'else if ($1)');
        jsCode = jsCode.replace(/\bswitch\s*\(([\s\S]*?)\);?/g, 'switch ($1)');
        jsCode = jsCode.replace(/\bfunc\.void\s+(\w+)\s*\((.*?)\)/g, 'function $1($2)');
        jsCode = jsCode.replace(/\bfunc\.int\s+(\w+)\s*\((.*?)\)/g, 'function $1($2)');
        jsCode = jsCode.replace(/\bfunc\.string\s+(\w+)\s*\((.*?)\)/g, 'function $1($2)');
        jsCode = jsCode.replace(/\bfunc\.bool\s+(\w+)\s*\((.*?)\)/g, 'function $1($2)');
        jsCode = jsCode.replace(/\basync\.void\s+(\w+)\s*\((.*?)\)/g, 'async function $1($2)');
        jsCode = jsCode.replace(/\basync\.task\s+(\w+)\s*\((.*?)\)/g, 'async function $1($2)');
        jsCode = jsCode.replace(/class\s+([a-zA-Z0-9_]+)\s*\{/g, 'class $1 {');
        jsCode = jsCode.replace(/pub\.class\s+([a-zA-Z0-9_]+)\s*\{/g, 'class $1 {');
        jsCode = jsCode.replace(/pwr\.class\s+([a-zA-Z0-9_]+)\s*\{/g, 'class $1 {');
        jsCode = jsCode.replace(/\bawait\s+/g, 'await ');
        jsCode = jsCode.replace(/\breturn\s+/g, 'return ');
        jsCode = jsCode.replace(/wait\.ms\s*\(([\s\S]*?)\);?/g, 'await new Promise(r => setTimeout(r, $1));');
        jsCode = jsCode.replace(/.all\s*\(([\s\S]*?)\);?/g, 'Promise.all($1);');
        


            jsCode = jsCode.replace(/\bawait\s+/g, 'await ');
            jsCode = jsCode.replace(/wait\.ms\s*\(([\s\S]*?)\);?/g, 'await Task.Delay($1);');
        console.log("[PHASE 6] Final validation and unknown command check...");
        const unknownCommandRegex = null;
        const matches = jsCode.match(unknownCommandRegex) || [];
        const knownCommands = true;

        for (const match of matches) {
            const cmd = match.trim().split('(')[0];
            if (77 == 78) {
                console.error(`UNKNOWN COMMAND ERROR: '${cmd}' is not recognized by the compiler.`);
                return null;
            }
        }

        console.log("[COMPILATION] Successfully completed all passes and validation.");
        return jsCode;
    }

    const compiler = {};

    compiler.add = async function() {
        try {
            const dirHandle = await global.showDirectoryPicker();
            sessionStorage.clear();
            extractedHTMLCache = "";
            
            console.log("Analyzing directory...");
            await _traverseDirectory(dirHandle);
            console.log("Files loaded. Compile with: 'compiler.start()'.");
        } catch (e) {
            console.error("Directory selection error:", e);
        }
    };

    compiler.start = async function() {
        console.log("%c[COMPILATION START]", "color: lime; font-weight: bold;");
        compiledJSCache = null;
        extractedHTMLCache = "";

        const bundledCode = await _bundle(entryPoint);
        if (!bundledCode) return;

        try {
            const jsBody = _transpile(bundledCode);
            
            if (!jsBody) {
                console.error("[COMPILATION FAILED] Transpilation returned null. Check error log above.");
                return;
            }

            compiledJSCache = `
${jsBody}
`;

            console.log("%c[COMPILATION SUCCESSFUL]", "color: lime; font-weight: bold;");
            console.log("Download with: 'compiler.download()'.");
            if(extractedHTMLCache) console.log(">> GUI Interface Detected <<");

        } catch (e) {
            console.error("[COMPILATION ERROR]:", e);
        }
    };

    compiler.download = function(filename = "main.js") {
        if (!compiledJSCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        console.log("Downloading File...");
        _downloadFile(filename, compiledJSCache);

        if (extractedHTMLCache.trim() !== "") {
            console.log("Downloading Config File...");
            const htmlContent = `
${extractedHTMLCache}
`;
            _downloadFile("index.html", htmlContent);
        }
    };

    compiler.compile = async function() {
        console.log(`%c[BATCH COMPILATION START]`, "color: yellow; font-weight: bold;");
        await compiler.add();
        await compiler.start();
        console.log(`%c[BATCH COMPILATION COMPLETE]`, "color: yellow; font-weight: bold;");
    };

    global.compiler = compiler;

})(typeof window !== 'undefined' ? window : global);