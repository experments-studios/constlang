(function(global) {

    let compiledBatchCache = null;
    let extractedBatchConfigCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.bat')) mimeType = 'text/plain';
        if(filename.endsWith('.cmd')) mimeType = 'text/plain';
        
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
                    bundledDependencies += `REM ${await res.text()}\n\n`;
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
        let batCode = constlangCode;
        let passCount = 0;

        const hasSpecialCommands = _containsSpecialCommand(batCode);
        
        if (hasSpecialCommands) {
            console.log("[PHASE 1-4] Special commands detected. Starting multi-pass compilation loop...");
            
            while (passCount < MAX_COMPILATION_PASSES) {
                passCount++;
                const beforeCode = batCode;
                console.log(`[PASS ${passCount}] Processing...`);

                const macros = [];
                const macroRegex = /cmd\.fn\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
                batCode = batCode.replace(macroRegex, (match, pattern, template) => {
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
                    
                    let batTemplate = macro.template;
                    for (let i = 0; i < varNames.length; i++) {
                        batTemplate = batTemplate.replace(new RegExp(`\\$\\{cmd\\^${varNames[i]}\\}|\\$\\{${varNames[i]}}`, 'g'), `$${i + 1}`);
                    }
                    try { batCode = batCode.replace(new RegExp(regexPattern, 'gm'), batTemplate); } catch (e) {}
                }

                batCode = batCode.replace(/cmd\.save\(\s*([^)]*)\s*\)/g, 'ECHO $1');
                batCode = batCode.replace(/create\.ctfolder\s*\(\s*([a-zA-Z0-9_"'\s]+)\s*\)/g, 'MKDIR $1');
                batCode = batCode.replace(/create\.ctfile\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\{([\s\S]*?)\}/g, 
                    (match, filename, varname, content) => {
                        return `(ECHO ${content.trim()}) > $1`;
                    }
                );

                if (!_containsSpecialCommand(batCode)) {
                    console.log(`[PASS ${passCount}/PHASE 5] Validation complete. No special commands found. Loop exiting.`);
                    break;
                }

                if (batCode === beforeCode) {
                    console.log(`[PASS ${passCount}/PHASE 5] No changes detected in this pass but special commands remain.`);
                    console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                    return null;
                }
            }

            if (passCount >= MAX_COMPILATION_PASSES && _containsSpecialCommand(batCode)) {
                console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                return null;
            }
        } else {
            console.log("[PHASE 1-4] No special commands found in initial code. Skipping loop.");
        }

        if (_containsSpecialCommand(batCode)) {
            console.error(`COMPILATION ERROR: Special commands remain after compilation.`);
            return null;
        }

        batCode = batCode.replace(/\/\/.*/g, '');
        batCode = batCode.replace(/\/\*[\s\S]*?\*\//g, '');

        const configRegex = /config\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        batCode = batCode.replace(configRegex, (match, content) => {
            extractedBatchConfigCache += content.trim() + "\n";
            return "";
        });

        batCode = batCode.replace(/addon\.app\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        console.log("[PHASE 2] Type conversions...");
        batCode = batCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'SET $1=$2');
        batCode = batCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'SET $1=$2');
        batCode = batCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'SET $1=$2');
        console.log("[PHASE 3] Print operations...");
        batCode = batCode.replace(/print\s*\(([\s\S]*?)\);?/g, 'ECHO $1');
        batCode = batCode.replace(/print\.text\s*\(([\s\S]*?)\);?/g, 'ECHO $1');
        batCode = batCode.replace(/print\.ln\s*\(([\s\S]*?)\);?/g, 'ECHO $1');
        batCode = batCode.replace(/print\.error\s*\(([\s\S]*?)\);?/g, '(ECHO $1) 1>&2');
        batCode = batCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'ECHO $1');
        batCode = batCode.replace(/console\.error\(([\s\S]*?)\);?/g, '(ECHO $1) 1>&2');
        batCode = batCode.replace(/error\.log\s*\(([\s\S]*?)\);?/g, 'ECHO $1 >> error.log');
        batCode = batCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'ECHO $1');
        console.log("[PHASE 4] Input operations...");
        batCode = batCode.replace(/input\s*\(([\s\S]*?)\);?/g, 'SET /P INPUT=');
        batCode = batCode.replace(/input\.line\s*\(([\s\S]*?)\);?/g, 'SET /P INPUT=');
        batCode = batCode.replace(/read\.line\s*\(\s*\);?/g, 'SET /P INPUT=');
        batCode = batCode.replace(/read\.data\s*\(([\s\S]*?)\);?/g, 'SET /P INPUT=');
        console.log("[PHASE 5] String operations...");
        batCode = batCode.replace(/string\.tolower\(([\s\S]*?)\);?/g, 'SETLOCAL ENABLEDELAYEDEXPANSION & SET str=$1 & FOR %%a in (a b c d e f g h i j k l m n o p q r s t u v w x y z) DO SET str=!str:%%a=%%a!');
        batCode = batCode.replace(/string\.toupper\(([\s\S]*?)\);?/g, '(ECHO $1^| POWERSHELL -Command "Write-Host $($_.ToUpper())"');
        batCode = batCode.replace(/string\.trim\(([\s\S]*?)\);?/g, 'FOR /F "tokens=*" %%A in ("$1") DO SET RESULT=%%A');
        batCode = batCode.replace(/string\.replace\(([\s\S]*?),([\s\S]*?),([\s\S]*?)\);?/g, 'SET RESULT=$1:$2=$3');
        batCode = batCode.replace(/string\.split\(([\s\S]*?),([\s\S]*?)\);?/g, 'FOR /F "tokens=*" %%A in ("$1") DO SET PART=%%A');
        batCode = batCode.replace(/string\.contains\(([\s\S]*?),([\s\S]*?)\);?/g, 'IF "$1" FIND "$2" NUL (ECHO Found) ELSE (ECHO Not Found)');
        batCode = batCode.replace(/string\.length\(([\s\S]*?)\);?/g, 'SETLOCAL ENABLEDELAYEDEXPANSION & SET STR=$1 & FOR /L %%a in (0,1,8191) DO IF NOT "!STR:~%%a,1!"=="" SET RESULT=%%a');
        console.log("[PHASE 6] Array operations...");
        batCode = batCode.replace(/\.list\.add\(([\s\S]*?)\);?/g, 'SET LIST[]=(!LIST[]!,$1)');
        batCode = batCode.replace(/\.list\.size\s*\(\s*\);?/g, 'ECHO %LIST:,=%^|FIND /C ","');
        batCode = batCode.replace(/\.list\.count\(([\s\S]*?)\);?/g, 'ECHO %LIST:,=%^|FIND /C ","');
        batCode = batCode.replace(/\.list\.clear\s*\(\s*\);?/g, 'SET LIST=');
        console.log("[PHASE 7] File operations...");
        batCode = batCode.replace(/file\.add\(([\s\S]*?)\);?/g, 'TYPE NUL > $1');
        batCode = batCode.replace(/folder\.add\(([\s\S]*?)\);?/g, 'MKDIR $1');
        batCode = batCode.replace(/file\.load\(([\s\S]*?)\);?/g, 'TYPE $1');
        batCode = batCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'START $1');
        batCode = batCode.replace(/open\.folder\(([\s\S]*?)\);?/g, 'START $1');
        batCode = batCode.replace(/file\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'MOVE $1 $2');
        batCode = batCode.replace(/folder\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'MOVE $1 $2');
        batCode = batCode.replace(/file\.copy\(([\s\S]*?),([\s\S]*?)\);?/g, 'COPY $1 $2');
        batCode = batCode.replace(/folder\.fileinfo\(([\s\S]*?)\);?/g, 'DIR $1');
        batCode = batCode.replace(/folder\.folderinfo\(([\s\S]*?)\);?/g, 'DIR $1 /AD');
        console.log("[PHASE 8] System operations...");
        batCode = batCode.replace(/system\.beep\(([\s\S]*?)\);?/g, 'POWERSHELL -Command "[System.Console]::Beep($1, 500)"');
        batCode = batCode.replace(/system\.stop\(([\s\S]*?)\);?/g, 'TIMEOUT /T $1 /NOBREAK');
        batCode = batCode.replace(/system\.stop\.seconds\(([\s\S]*?)\);?/g, 'TIMEOUT /T $1 /NOBREAK');
        batCode = batCode.replace(/system\.stop\.minutes\(([\s\S]*?)\);?/g, 'TIMEOUT /T %($1*60)% /NOBREAK');
        batCode = batCode.replace(/system\.stop\.hours\(([\s\S]*?)\);?/g, 'TIMEOUT /T %($1*3600)% /NOBREAK');
        batCode = batCode.replace(/system\.stop\.ms\(([\s\S]*?)\);?/g, 'POWERSHELL -Command "Start-Sleep -Milliseconds $1"');
        batCode = batCode.replace(/open\.window\s*\(([\s\S]*?)\);?/g, 'START $1');
        batCode = batCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, 'SYSTEMINFO | FINDSTR /C:"OS Name"');
        console.log("[PHASE 9] Loop structures...");
        batCode = batCode.replace(/\bfor\s*\(\s*let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(\d+);\s*\1\s*<\s*(\d+);\s*\1\s*\+\+\s*\)/g, 'FOR /L %%i in ($2,1,$3) DO');
        batCode = batCode.replace(/\bwhile\s*\(([\s\S]*?)\)/g, ':LOOP\nIF $1 (');
        batCode = batCode.replace(/\bdo\s*{([\s\S]*?)}\s*while\s*\(([\s\S]*?)\)/g, ':LOOP\n$1\nIF $2 GOTO LOOP');
        batCode = batCode.replace(/foreach\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, 'FOR %%$1 in ($2) DO');
        console.log("[PHASE 10] Conditional structures...");
        batCode = batCode.replace(/\bif\s*\(/g, 'IF ');
        batCode = batCode.replace(/\}\s*else\s+if\s*\(/g, ') ELSE IF (');
        batCode = batCode.replace(/\}\s*else\s*{/g, ') ELSE (');
        batCode = batCode.replace(/==\s*/g, ' EQU ');
        batCode = batCode.replace(/!=\s*/g, ' NEQ ');
        batCode = batCode.replace(/<\s*/g, ' LSS ');
        batCode = batCode.replace(/>\s*/g, ' GTR ');
        batCode = batCode.replace(/<=/g, ' LEQ ');
        batCode = batCode.replace(/>=/g, ' GEQ ');
        console.log("[PHASE 11] Function declarations...");
        batCode = batCode.replace(/\bfunc\.void\s+([\w\d]+)\s*\((.*?)\)\s*{/g, ':$1\nREM Function: $1($2)');
        batCode = batCode.replace(/\breturn\s+/g, 'GOTO END\n:END\n');
        console.log("[PHASE 12] Static declarations...");
        batCode = batCode.replace(/^\s*static\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'SET $1=$2');
        console.log("[PHASE 13] Adding header...");
        if (!batCode.includes('@ECHO OFF')) {
            batCode = `@ECHO OFF\nREM Auto-generated Batch Script\nSETLOCAL ENABLEDELAYEDEXPANSION\nCLS\n\n${batCode}`;
        }
        console.log("[PHASE 14] Adding footer...");
        batCode += `\n\nEND:\nPAUSE\nEXIT /B 0`;

        console.log("[COMPILATION] Successfully completed all passes and validation.");
        return batCode;
    }

    const compiler = {};

    compiler.add = async function() {
        try {
            const dirHandle = await global.showDirectoryPicker();
            sessionStorage.clear();
            extractedBatchConfigCache = "";
            
            console.log("Analyzing directory...");
            await _traverseDirectory(dirHandle);
            console.log("Files loaded. Compile with: 'compiler.start()'.");
        } catch (e) {
            console.error("Directory selection error:", e);
        }
    };

    compiler.start = async function() {
        console.log("%c[COMPILATION START]", "color: lime; font-weight: bold;");
        compiledBatchCache = null;
        extractedBatchConfigCache = "";

        const bundledCode = await _bundle(entryPoint);
        if (!bundledCode) return;

        try {
            const batBody = _transpile(bundledCode);
            
            if (!batBody) {
                console.error("[COMPILATION FAILED] Transpilation returned null. Check error log above.");
                return;
            }

            compiledBatchCache = `${batBody}`;

            console.log("%c[COMPILATION SUCCESSFUL]", "color: lime; font-weight: bold;");
            console.log("Download with: 'compiler.download()'.");

        } catch (e) {
            console.error("[COMPILATION ERROR]:", e);
        }
    };

    compiler.download = function(filename = "main.bat") {
        if (!compiledBatchCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        console.log("Downloading Batch File...");
        _downloadFile(filename, compiledBatchCache);

        if (extractedBatchConfigCache.trim() !== "") {
            console.log("Downloading Config File...");
            _downloadFile("config.txt", extractedBatchConfigCache);
        }
    };

    compiler.compile = async function() {
        console.log(`%c[BATCH COMPILATION START]`, "color: yellow; font-weight: bold;");
        await compiler.add();
        await compiler.start();
        console.log(`%c[BATCH COMPILATION COMPLETE]`, "color: yellow; font-weight: bold;");
    };

    global.batchCompiler = compiler;

})(typeof window !== 'undefined' ? window : global);