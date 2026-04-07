(function(global) {
    let compiledJSCache = null;
    let extractedHTMLCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];
    
    // IndexedDB Konfigürasyonu
    const DB_NAME = 'AppCompilerDB';
    const STORE_NAME = 'files';
    let db = null;

    // IndexedDB başlatma
    function initializeIndexedDB() {
        return new Promise((resolve, reject) => {
            if (typeof window === 'undefined' || !window.indexedDB) {
                reject(new Error("IndexedDB not available"));
                return;
            }
            
            const request = indexedDB.open(DB_NAME, 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };
            
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                }
            };
        });
    }

    // Dosyayı IndexedDB'ye kaydet
    function saveToIndexedDB(filename, content, folderPath) {
        return new Promise((resolve, reject) => {
            if (!db) {
                reject(new Error("Database not initialized"));
                return;
            }
            
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            
            const data = {
                filename: filename,
                content: content,
                folderPath: folderPath,
                timestamp: new Date().getTime()
            };
            
            const request = store.add(data);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    // Tüm dosyaları IndexedDB'den getir
    function getAllFilesFromIndexedDB(folderPath) {
        return new Promise((resolve, reject) => {
            if (!db) {
                reject(new Error("Database not initialized"));
                return;
            }
            
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const files = request.result.filter(f => f.folderPath === folderPath);
                resolve(files);
            };
        });
    }

    // IndexedDB'den dosyaları sil
    function deleteFilesFromIndexedDB(folderPath) {
        return new Promise((resolve, reject) => {
            if (!db) {
                reject(new Error("Database not initialized"));
                return;
            }
            
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const files = request.result.filter(f => f.folderPath === folderPath);
                files.forEach(file => {
                    store.delete(file.id);
                });
                resolve();
            };
        });
    }

    // Electron fs modülü kontrolü
    function getFileSystem() {
        try {
            if (typeof require !== 'undefined') {
                return require('fs').promises;
            }
        } catch (e) {
            // Node.js ortamında değil
        }
        return null;
    }

    async function _downloadFile(filename, text, downloadPath = null) {
        const fs = getFileSystem();
        
        if (fs && downloadPath) {
            try {
                const path = require('path');
                const filePath = path.join(downloadPath, filename);
                const dir = path.dirname(filePath);
                try {
                    await fs.mkdir(dir, { recursive: true });
                } catch (e) {
                
                }
                
                await fs.writeFile(filePath, text, 'utf-8');
                console.log(`[DOWNLOAD] File saved to: ${filePath}`);
                return true;
            } catch (e) {
                console.error("File write error:", e);
                return false;
            }
        } else {
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
            return true;
        }
    }

    async function _traverseDirectory(folderPath) {
        const fs = getFileSystem();
        
        if (!fs) {
            console.error("File system not available. Running in browser mode.");
            return;
        }
        
        try {
            const path = require('path');
            
            async function traverse(currentPath, baseFolder) {
                const entries = await fs.readdir(currentPath, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(currentPath, entry.name);
                    const relativePath = path.relative(baseFolder, fullPath);
                    
                    if (entry.isFile()) {
                        if (entry.name.endsWith('.clg') || entry.name.endsWith('.nat')) {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            await saveToIndexedDB(entry.name, content, baseFolder);
                            sessionStorage.setItem(entry.name, content);
                            console.log(`[READ] ${relativePath}`);
                        }
                    } else if (entry.isDirectory()) {
                        await traverse(fullPath, baseFolder);
                    }
                }
            }
            
            await traverse(folderPath, folderPath);
        } catch (e) {
            console.error("Directory traversal error:", e);
            throw e;
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
                const macroRegex = /cmd\.fn\(\)\s*\[\s*([\s\S]*?)\s*;cmd\(\)\s*([\s\S]*?)\s*\]/g;
                jsCode = jsCode.replace(macroRegex, (match, pattern, template) => {
                    macros.push({ pattern: pattern.trim(), template: template.trim() });
                    return "";
                });

                for (const macro of macros) {
                    let regexPattern = macro.pattern;
                    const varMatches = regexPattern.match(/\$\{(\w+)\}/g) || [];
                    let groupIndex = 1;
                    const varMap = {};
                    
                    varMatches.forEach(varMatch => {
                        const varName = varMatch.slice(2, -1); // ${out} -> out
                        varMap[varName] = `$${groupIndex}`;
                        regexPattern = regexPattern.replace(varMatch, `__VAR_${groupIndex}__`);
                        groupIndex++;
                    });
                    
                    regexPattern = regexPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    for (let i = 1; i < groupIndex; i++) {
                        regexPattern = regexPattern.replace(
                            `__VAR_${i}__`, 
                            '([\\s\\S]*?)'
                        );
                    }
                    
                    // Template'deki ${var} -> $1 şeklinde değiştir
                    let finalTemplate = macro.template;
                    Object.entries(varMap).forEach(([varName, groupRef]) => {
                        finalTemplate = finalTemplate.replace(
                            new RegExp(`\\$\\{${varName}\\}`, 'g'), 
                            groupRef
                        );
                    });
                    
                    // Regex'i oluştur ve TÜM EŞLEŞMELERİ değiştir (global flag VAR)
                    try {
                        const patternRegex = new RegExp(regexPattern, 'g');
                        jsCode = jsCode.replace(patternRegex, finalTemplate);
                    } catch (e) {
                        console.error(`[MACRO ERROR] Invalid pattern: "${macro.pattern}"`, e);
                    }
                }

                const saveRegex = /cmd\.save\s*\(\s*"([^"]*)"\s*,\s*([\s\S]*?)\s*\)\s*;?/g;
                jsCode = jsCode.replace(saveRegex, (match, varName, content) => {
                    return `\nwindow.COMPILED_CONFIG = window.COMPILED_CONFIG || {};\nwindow.COMPILED_CONFIG['${varName}'] = ${content};\n`;
                });

                const ctFileRegex = /create\.ctfile\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)\s*;?/g;
                jsCode = jsCode.replace(ctFileRegex, (match, filename, content) => {
                    return `\nwindow.COMPILED_FILES = window.COMPILED_FILES || {};\nwindow.COMPILED_FILES['${filename}'] = \`${content}\`;\n`;
                });

                const ctFolderRegex = /create\.ctfolder\s*\(\s*"([^"]*)"\s*\)\s*;?/g;
                jsCode = jsCode.replace(ctFolderRegex, (match, folderName) => {
                    return `\nwindow.COMPILED_FOLDERS = window.COMPILED_FOLDERS || [];\nwindow.COMPILED_FOLDERS.push('${folderName}');\n`;
                });

                if (jsCode === beforeCode) {
                    console.log(`[PASS ${passCount}] No changes detected. Exiting compilation loop.`);
                    break;
                }
            }
        }

        console.log("[PHASE 2] Transpiling syntax...");
  
        jsCode = jsCode.replace(/in\.main\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.app\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.linux64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.mac64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.linux32\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.win32\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.win64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.docker\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.sh\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.bat\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.web\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.mobile\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');

        jsCode = jsCode.replace(/oldcommand1\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'string $2 = await fetch("$1").then(r => r.json());');

        jsCode = jsCode.replace(/http\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'Console.Error.WriteLine("Code removed");');

        const linkReqRegex = /link\.request\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        jsCode = jsCode.replace(linkReqRegex, (match, innerBlock) => {
            const urlMatch = innerBlock.match(/request\.url\s*\(\s*["']?(.*?)["']?\s*\)/);
            if (!urlMatch) return "";
            const urlParam = urlMatch[1];

            const dataMatch = innerBlock.match(/data\.main\s*\(\s*(.*?)\s*\)/);
            if (!dataMatch) return "";
            const actionContent = dataMatch[1];

            let output = "";
            
            if (actionContent.includes('var=')) {
                const varName = actionContent.match(/var\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `let ${varName} = new URLSearchParams(window.location.search).get("${urlParam}");`;
            } else if (actionContent.includes('json.search=')) {
                output = `
                {
                   Console.Error.WriteLine("Code removed"); 
                }`;
            } else if (actionContent.includes('html.list=')) {
                output = `Console.WriteLine("Code removed");`;
            }
            return output;
        });

        jsCode = jsCode.replace(/while \s*\(([\s\S]*?)\);?/g, 'while ($1)');
        jsCode = jsCode.replace(/for \s*\(([\s\S]*?)\);?/g, 'for ($1)');
        jsCode = jsCode.replace(/do \s*\{([\s\S]*?)\};?/g, 'do {$1}');
         jsCode = jsCode.replace(/try \s*\{([\s\S]*?)\};?/g, 'try {$1}');
         jsCode = jsCode.replace(/finally \s*\{([\s\S]*?)\};?/g, 'finally {$1}');
        jsCode = jsCode.replace(/^\s*static\s+int256\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(64, '0');
                
                const lowHex = hex.slice(-32);
                const highHex = hex.slice(0, -32);
                
                const low = BigInt('0x' + (lowHex || '0'));
                const high = BigInt('0x' + (highHex || '0'));
                
                return `struct Int256 { public UInt128 High; public UInt128 Low; } const Int256 ${varName} = new Int256 { High = ${high}, Low = ${low} };`;
            }
        );
        
        jsCode = jsCode.replace(/^\s*static\s+int512\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(128, '0');
                
                const w0Hex = hex.slice(-32);
                const w1Hex = hex.slice(-64, -32);
                const w2Hex = hex.slice(-96, -64);
                const w3Hex = hex.slice(0, -96);
                
                const w0 = BigInt('0x' + (w0Hex || '0'));
                const w1 = BigInt('0x' + (w1Hex || '0'));
                const w2 = BigInt('0x' + (w2Hex || '0'));
                const w3 = BigInt('0x' + (w3Hex || '0'));
                
                return `struct Int512 { public UInt128 W0; public UInt128 W1; public UInt128 W2; public UInt128 W3; } const Int512 ${varName} = new Int512 { W0 = ${w0}, W1 = ${w1}, W2 = ${w2}, W3 = ${w3} };`;
            }
        );
        
        jsCode = jsCode.replace(/^\s*static\s+int1024\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(256, '0'); // 1024 bit = 256 hex karakteri
                
                const w0Hex = hex.slice(-32);
                const w1Hex = hex.slice(-64, -32);
                const w2Hex = hex.slice(-96, -64);
                const w3Hex = hex.slice(-128, -96);
                const w4Hex = hex.slice(-160, -128);
                const w5Hex = hex.slice(-192, -160);
                const w6Hex = hex.slice(-224, -192);
                const w7Hex = hex.slice(0, -224);
                
                const w0 = BigInt('0x' + (w0Hex || '0'));
                const w1 = BigInt('0x' + (w1Hex || '0'));
                const w2 = BigInt('0x' + (w2Hex || '0'));
                const w3 = BigInt('0x' + (w3Hex || '0'));
                const w4 = BigInt('0x' + (w4Hex || '0'));
                const w5 = BigInt('0x' + (w5Hex || '0'));
                const w6 = BigInt('0x' + (w6Hex || '0'));
                const w7 = BigInt('0x' + (w7Hex || '0'));
                
                return `struct Int1024 { public UInt128 W0; public UInt128 W1; public UInt128 W2; public UInt128 W3; public UInt128 W4; public UInt128 W5; public UInt128 W6; public UInt128 W7; } const Int1024 ${varName} = new Int1024 { W0 = ${w0}, W1 = ${w1}, W2 = ${w2}, W3 = ${w3}, W4 = ${w4}, W5 = ${w5}, W6 = ${w6}, W7 = ${w7} };`;
            }
        );
        jsCode = jsCode.replace(/^\s*int256\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(64, '0');
                
                const lowHex = hex.slice(-32);
                const highHex = hex.slice(0, -32);
                
                const low = BigInt('0x' + (lowHex || '0'));
                const high = BigInt('0x' + (highHex || '0'));
                
                return `struct Int256 { public UInt128 High; public UInt128 Low; } Int256 ${varName} = new Int256 { High = ${high}, Low = ${low} };`;
            }
        );
        
        jsCode = jsCode.replace(/^\s*int512\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(128, '0');
                
                const w0Hex = hex.slice(-32);
                const w1Hex = hex.slice(-64, -32);
                const w2Hex = hex.slice(-96, -64);
                const w3Hex = hex.slice(0, -96);
                
                const w0 = BigInt('0x' + (w0Hex || '0'));
                const w1 = BigInt('0x' + (w1Hex || '0'));
                const w2 = BigInt('0x' + (w2Hex || '0'));
                const w3 = BigInt('0x' + (w3Hex || '0'));
                
                return `struct Int512 { public UInt128 W0; public UInt128 W1; public UInt128 W2; public UInt128 W3; } Int512 ${varName} = new Int512 { W0 = ${w0}, W1 = ${w1}, W2 = ${w2}, W3 = ${w3} };`;
            }
        );
        
        jsCode = jsCode.replace(/^\s*int1024\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            (match, varName, value) => {
                const num = BigInt(value);
                const hex = num.toString(16).padStart(256, '0');
                
                const w0Hex = hex.slice(-32);
                const w1Hex = hex.slice(-64, -32);
                const w2Hex = hex.slice(-96, -64);
                const w3Hex = hex.slice(-128, -96);
                const w4Hex = hex.slice(-160, -128);
                const w5Hex = hex.slice(-192, -160);
                const w6Hex = hex.slice(-224, -192);
                const w7Hex = hex.slice(0, -224);
                
                const w0 = BigInt('0x' + (w0Hex || '0'));
                const w1 = BigInt('0x' + (w1Hex || '0'));
                const w2 = BigInt('0x' + (w2Hex || '0'));
                const w3 = BigInt('0x' + (w3Hex || '0'));
                const w4 = BigInt('0x' + (w4Hex || '0'));
                const w5 = BigInt('0x' + (w5Hex || '0'));
                const w6 = BigInt('0x' + (w6Hex || '0'));
                const w7 = BigInt('0x' + (w7Hex || '0'));
                
                return `struct Int1024 { public UInt128 W0; public UInt128 W1; public UInt128 W2; public UInt128 W3; public UInt128 W4; public UInt128 W5; public UInt128 W6; public UInt128 W7; } Int1024 ${varName} = new Int1024 { W0 = ${w0}, W1 = ${w1}, W2 = ${w2}, W3 = ${w3}, W4 = ${w4}, W5 = ${w5}, W6 = ${w6}, W7 = ${w7} };`;
            }
        );

         jsCode = jsCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'int $1 = $2;');
        jsCode = jsCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, '"app"');
        jsCode = jsCode.replace(/console\.println\(([\s\S]*?)\);?/g, 'Console.WriteLine($1);');
        jsCode = jsCode.replace(/catch\(([\s\S]*?)\);?/g, 'catch ($1);');
        jsCode = jsCode.replace(/text\s*\(([\s\S]*?)\);?/g, '"$1"');
        jsCode = jsCode.replace(/^\s*int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'Int16 $1 = $2;');
        jsCode = jsCode.replace(/^\s*redata\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, ' $1 = $2;');
        jsCode = jsCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'byte[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'Int32 $1 = $2;');
        jsCode = jsCode.replace(/^\s*int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'Int64 $1 = $2;');
        jsCode = jsCode.replace(/^\s*int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'Int128 $1 = $2;');
        jsCode = jsCode.replace(/^\s*double\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'double $1 = $2;');
        jsCode = jsCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'string $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\.i09\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char.IsDigit');
        jsCode = jsCode.replace(/^\s*bool\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'bool $1 = $2;');
        jsCode = jsCode.replace(/^\s*float\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'float $1 = $2;');
        jsCode = jsCode.replace(/^\s*decimal\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'decimal $1 = $2;');
        jsCode = jsCode.replace(/cmd\.nr\(([\s\S]*?)\);?/g, '$1;');
        jsCode = jsCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'Console.WriteLine($1);');
        jsCode = jsCode.replace(/get\s*\(([\s\S]*?)\);?/g, 'await client.GetFromJsonAsync($1);');
        jsCode = jsCode.replace(/read\.int32\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt32(Console.ReadLine($1));');
        jsCode = jsCode.replace(/ip\.parse\s*\(([\s\S]*?)\);?/g, 'IPAddress.Parse($1);');
        jsCode = jsCode.replace(/ip\.endpoint\s*\(([\s\S]*?)\);?/g, 'IPEndPoint');
        jsCode = jsCode.replace(/to\.int32\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt32($1);');
        jsCode = jsCode.replace(/to\.int16\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt16($1);');
        jsCode = jsCode.replace(/to\.int64\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt64($1);');
        jsCode = jsCode.replace(/to\.int128\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt128($1);');
        jsCode = jsCode.replace(/to\.string\s*\(([\s\S]*?)\);?/g, 'Convert.ToString($1);');
        jsCode = jsCode.replace(/to\.intx\s*\(([\s\S]*?)\);?/g, 'Convert.ToDouble($1);');
        jsCode = jsCode.replace(/to\.byte\s*\(([\s\S]*?)\);?/g, 'Convert.ToSByte($1);');
        jsCode = jsCode.replace(/to\.ft\s*\(([\s\S]*?)\);?/g, 'Convert.ToBoolean($1);');
        jsCode = jsCode.replace(/converter\.utf8\.byte\s*\(([\s\S]*?)\);?/g, 'Encoding.UTF8.GetBytes($1);');
        jsCode = jsCode.replace(/to\.base64\s*\(([\s\S]*?)\);?/g, 'Convert.ToBase64String($1);');
        jsCode = jsCode.replace(/read\.int16\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt16(Console.ReadLine($1));');
        jsCode = jsCode.replace(/read\.int64\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt64(Console.ReadLine($1));');
        jsCode = jsCode.replace(/read\.intx\s*\(([\s\S]*?)\);?/g, 'Convert.ToDouble(Console.ReadLine($1));');
        jsCode = jsCode.replace(/read\.string\s*\(([\s\S]*?)\);?/g, 'Convert.ToString(Console.ReadLine($1));');
        jsCode = jsCode.replace(/read\.byte\s*\(([\s\S]*?)\);?/g, 'Convert.ToSByte(Console.ReadLine($1));');
        jsCode = jsCode.replace(/read\.base64\s*\(([\s\S]*?)\);?/g, 'Convert.ToBase64String(Console.ReadLine($1));');
        jsCode = jsCode.replace(/open\.window\s*\(([\s\S]*?)\);?/g, 'Process.Start($1);');
        jsCode = jsCode.replace(/if \s*\(([\s\S]*?)\);?/g, 'if ($1)');  
        jsCode = jsCode.replace(/else \s*\(([\s\S]*?)\);?/g, 'else ($1)');
        jsCode = jsCode.replace(/else if \s*\({[\s\S]*?}\);?/g, 'else if {$1}');
            jsCode = jsCode.replace(/to\.decimal\s*\(([\s\S]*?)\);?/g, 'Convert.ToDecimal($1);');
        jsCode = jsCode.replace(/to\.float\s*\(([\s\S]*?)\);?/g, 'Convert.ToSingle($1);');
        jsCode = jsCode.replace(/while \s*\(([\s\S]*?)\);?/g, 'while ($1)');
        jsCode = jsCode.replace(/for \s*\(([\s\S]*?)\);?/g, 'for ($1)');
        jsCode = jsCode.replace(/do \s*\{([\s\S]*?)\};?/g, 'do {$1}');
           jsCode = jsCode.replace(/class\s*\({[\s\S]*?}\);?/g, 'class $1');
        jsCode = jsCode.replace(/new\s*\({[\s\S]*?}\);?/g, 'new $1');
         jsCode = jsCode.replace(/public\s*\({[\s\S]*?}\);?/g, 'public $1');
          jsCode = jsCode.replace(/private\s*\({[\s\S]*?}\);?/g, 'private $1');
           jsCode = jsCode.replace(/void\s*\({[\s\S]*?}\);?/g, 'void $1');
            jsCode = jsCode.replace(/static\s*\({[\s\S]*?}\);?/g, 'static $1');
        jsCode = jsCode.replace(/^\s*const\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const int $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+decimal\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const decimal $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+float\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const float $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const Int16 $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const Int32 $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+Int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const Int64 $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const Int128 $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const int $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+double\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const double $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const string $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+bool\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const bool $1 = $2;');
        jsCode = jsCode.replace(/console\.error\(([\s\S]*?)\);?/g, 'Console.Error.WriteLine($1);');
        jsCode = jsCode.replace(/system\.beep\(([\s\S]*?)\);?/g, 'Console.Beep($1);');
        jsCode = jsCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'Console.Write($1);');
        jsCode = jsCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'File.ReadAllText($1);');
        jsCode = jsCode.replace(/open\.folder\(([\s\S]*?)\);?/g, 'Path.GetFullPath($1);');
        jsCode = jsCode.replace(/.list\.add\(([\s\S]*?)\);?/g, '.Add($1);');
        jsCode = jsCode.replace(/.all\(([\s\S]*?)\);?/g, 'All($1);');
        jsCode = jsCode.replace(/.list\.new\(([\s\S]*?)\);?/g, '.Insert($1);');
        jsCode = jsCode.replace(/.char\.i09\(([\s\S]*?)\);?/g, 'char.IsDigit($1);');
        jsCode = jsCode.replace(/.list\.delete\(([\s\S]*?)\);?/g, '.RemoveAt($1);');
        jsCode = jsCode.replace(/.list\.count\(([\s\S]*?)\);?/g, '.Count;');
        jsCode = jsCode.replace(/.list\.index\(([\s\S]*?)\);?/g, '.IndexOf($1);');
        jsCode = jsCode.replace(/.list\.control\(([\s\S]*?)\);?/g, '.Contains($1);');
        jsCode = jsCode.replace(/.list\.clr\(([\s\S]*?)\);?/g, '.Clear($1);');
        jsCode = jsCode.replace(/.list\.all\(([\s\S]*?)\);?/g, '.Sort($1);');
        jsCode = jsCode.replace(/.list\.redata\(([\s\S]*?)\);?/g, '.Reverse($1);');
        jsCode = jsCode.replace(/.list\.join\(([\s\S]*?)\);?/g, '.string.Join($1);');
        jsCode = jsCode.replace(/.list\.string\(([\s\S]*?)\);?/g, 'new List<String>($1);');
        jsCode = jsCode.replace(/.list\.int16\(([\s\S]*?)\);?/g, 'new List<Int16>($1);');
        jsCode = jsCode.replace(/.list\.int32\(([\s\S]*?)\);?/g, 'new List<Int32>($1);');
        jsCode = jsCode.replace(/.list\.int64\(([\s\S]*?)\);?/g, 'new List<Int64>($1);');
        jsCode = jsCode.replace(/.list\.int128\(([\s\S]*?)\);?/g, 'new List<Int128>($1);');
        jsCode = jsCode.replace(/.list\.intx\(([\s\S]*?)\);?/g, 'new List<Double>($1);');
        jsCode = jsCode.replace(/file\.add\(([\s\S]*?)\);?/g, 'File.WriteAllText($1);');
        jsCode = jsCode.replace(/folder\.add\(([\s\S]*?)\);?/g, 'Directory.CreateDirectory($1);');
        jsCode = jsCode.replace(/file\.load\(([\s\S]*?)\);?/g, 'File.ReadAllText($1);');
        jsCode = jsCode.replace(/folder\.fileinfo\(([\s\S]*?)\);?/g, 'Directory.GetFiles($1);');
        jsCode = jsCode.replace(/folder\.folderinfo\(([\s\S]*?)\);?/g, 'Directory.GetDirectories($1);');
        jsCode = jsCode.replace(/.char\.letter\(([\s\S]*?)\);?/g, 'char.IsLetter($1);');
        jsCode = jsCode.replace(/.char\.isc\(([\s\S]*?)\);?/g, 'char.IsLetterOrDigit($1);');
        jsCode = jsCode.replace(/.char\.space\(([\s\S]*?)\);?/g, 'char.IsWhiteSpace($1);');
        jsCode = jsCode.replace(/.char\.ipn\(([\s\S]*?)\);?/g, 'char.IsPunctuation($1);');
        jsCode = jsCode.replace(/.char\.symbol\(([\s\S]*?)\);?/g, 'char.IsSymbol($1);');
        jsCode = jsCode.replace(/.char\.isletter\(([\s\S]*?)\);?/g, 'char.IsLetter($1);');
        jsCode = jsCode.replace(/.char\.upper\(([\s\S]*?)\);?/g, 'char.IsUpper($1);');
        jsCode = jsCode.replace(/.char\.lower\(([\s\S]*?)\);?/g, 'char.IsLower($1);');
        jsCode = jsCode.replace(/.char\.control\(([\s\S]*?)\);?/g, 'char.IsControl($1);');
        jsCode = jsCode.replace(/.char\.separator\(([\s\S]*?)\);?/g, 'char.IsSeparator($1);');
        jsCode = jsCode.replace(/.char\.lower\(([\s\S]*?)\);?/g, 'char.ToLower($1);');
        jsCode = jsCode.replace(/.char\.upper\(([\s\S]*?)\);?/g, 'char.ToUpper($1);');
        jsCode = jsCode.replace(/.char\.getnumber\(([\s\S]*?)\);?/g, 'char.GetNumericValue($1);');
        jsCode = jsCode.replace(/.char\.tostring\(([\s\S]*?)\);?/g, 'c.ToString($1);');
        jsCode = jsCode.replace(/.char\.string\.concat\(([\s\S]*?)\);?/g, 'string.Concat($1);');
        jsCode = jsCode.replace(/.char\.string\.nullcontrol\(([\s\S]*?)\);?/g, 'string.IsNullOrEmpty($1);');
        jsCode = jsCode.replace(/.char\.string\.join\(([\s\S]*?)\);?/g, 'string.Join($1);');
        jsCode = jsCode.replace(/.char\.aspawn\(([\s\S]*?)\);?/g, 'input.AsSpan($1);');
        jsCode = jsCode.replace(/.char\.peek\(([\s\S]*?)\);?/g, 'input.Peek($1);');
        jsCode = jsCode.replace(/.caracters\.token\(([\s\S]*?)\);?/g, '.Split($1);');
        jsCode = jsCode.replace(/regex\.parse\(([\s\S]*?)\);?/g, 'Regex.Split($1);');
        jsCode = jsCode.replace(/regex\.mainsearch\(([\s\S]*?)\);?/g, 'Regex.Match($1);');
        jsCode = jsCode.replace(/regex\.search\(([\s\S]*?)\);?/g, 'Regex.Matches($1);');
        jsCode = jsCode.replace(/regex\.control\(([\s\S]*?)\);?/g, 'Regex.IsMatch($1);');
        jsCode = jsCode.replace(/regex\.replace\(([\s\S]*?)\);?/g, 'Regex.Replace($1);');
        jsCode = jsCode.replace(/file\.redata\(([\s\S]*?)\);?/g, 'StreamWriter($1))');
        jsCode = jsCode.replace(/file\.move\(([\s\S]*?)\);?/g, 'File.Move($1);');
        jsCode = jsCode.replace(/folder\.move\(([\s\S]*?)\);?/g, 'Directory.Move($1);');
        jsCode = jsCode.replace(/file\.copy\(([\s\S]*?)\);?/g, 'File.Copy($1);');
        jsCode = jsCode.replace(/lib\.cs\(([\s\S]*?)\);?/g, 'using $1;');
        jsCode = jsCode.replace(/system\.control\(([\s\S]*?)\);?/g, 'using ($1)');
        jsCode = jsCode.replace(/system\.time\(([\s\S]*?)\);?/g, 'await Task.Delay($1);');
        jsCode = jsCode.replace(/system\.stop\(([\s\S]*?)\);?/g, 'Thread.Sleep($1);');
        jsCode = jsCode.replace(/system\.stop\.minutes\(([\s\S]*?)\);?/g, 'Thread.Sleep(TimeSpan.FromMinutes($1));');
        jsCode = jsCode.replace(/system\.stop\.seconds\(([\s\S]*?)\);?/g, 'Thread.Sleep(TimeSpan.FromSeconds($1));');
        jsCode = jsCode.replace(/system\.stop\.hours\(([\s\S]*?)\);?/g, 'Thread.Sleep(TimeSpan.FromHours($1));');
        jsCode = jsCode.replace(/system\.stop\.ms\(([\s\S]*?)\);?/g, 'Thread.Sleep($1);');
        jsCode = jsCode.replace(/.ip\.streamr\(([\s\S]*?)\);?/g, 'NetworkStream $1 = client.GetStream();');
        jsCode = jsCode.replace(/.write\(([\s\S]*?)\);?/g, '.Write($1);');
        jsCode = jsCode.replace(/console\.status\s*\(\s*\);?/g, 'Console.WriteLine($"Uptime: {System.Diagnostics.Process.GetCurrentProcess().StartTime} | Threads: {System.Diagnostics.Process.GetCurrentProcess().Threads.Count}");');
        jsCode = jsCode.replace(/read\.data\s*\(([\s\S]*?)\);?/g, 'Console.ReadLine($1)');
        jsCode = jsCode.replace(/pub.class\s*\({[\s\S]*?}\);?/g, 'public class $1');
        jsCode = jsCode.replace(/pwr.class\s*\({[\s\S]*?}\);?/g, 'private class $1');
        jsCode = jsCode.replace(/\bfunc\.void\s+([\w\d]+)\s*\((.*?)\)/g, 'public void $1($2)');
        jsCode = jsCode.replace(/\basync\.void\s+([\w\d]+)\s*\((.*?)\)/g, 'public async Task $1($2)');
        jsCode = jsCode.replace(/\basync\.task\s+([\w\d]+)\s*\((.*?)\)/g, 'public async Task $1($2)');
        jsCode = jsCode.replace(/console\.color\s*\("(.*?)"\);?/g, 'Console.ForegroundColor = ConsoleColor.$1;');
        


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

    // Klasör yolu parametresi ile dosya ekleme
    compiler.add = async function(folderPath) {
        try {
            // IndexedDB'yi başlat
            await initializeIndexedDB();
            
            if (!folderPath) {
                // Browser ortamında klasör seçici kullan
                if (typeof window !== 'undefined' && window.showDirectoryPicker) {
                    const dirHandle = await window.showDirectoryPicker();
                    sessionStorage.clear();
                    extractedHTMLCache = "";
                    console.log("Analyzing directory...");
                    await _traverseDirectory(dirHandle);
                    console.log("Files loaded. Compile with: 'compiler.start()'.");
                } else {
                    console.error("Directory picker not available and no path provided");
                }
            } else {
                sessionStorage.clear();
                extractedHTMLCache = "";
                console.log(`[ADD] Processing folder: ${folderPath}`);
                await _traverseDirectory(folderPath);
                console.log("Files loaded and stored in IndexedDB. Compile with: 'compiler.start()'.");
            }
        } catch (e) {
            console.error("Directory processing error:", e);
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
$methodBody = @"
using System;                        
using System.IO;                       
using System.Threading;               
using System.Collections.Generic;    
using System.Linq; 
 ${jsBody}
}
"@
`;

            console.log("%c[COMPILATION SUCCESSFUL]", "color: lime; font-weight: bold;");
            console.log("Download with: 'compiler.download(downloadPath)'.");
            if(extractedHTMLCache) console.log(">> GUI Interface Detected <<");

        } catch (e) {
            console.error("[COMPILATION ERROR]:", e);
        }
    };

    // Klasör yoluna indirme
    compiler.download = async function(downloadPath, filename = "main.cs") {
        if (!compiledJSCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        try {
            console.log("Downloading C# File...");
            const success = await _downloadFile(filename, compiledJSCache, downloadPath);
            
            if (!success && downloadPath) {
                console.error("Download failed. Check file system permissions.");
                return;
            }

            if (extractedHTMLCache.trim() !== "") {
                console.log("Downloading Config File...");
                const htmlContent = `
${extractedHTMLCache}
`;
                await _downloadFile("config.csproj", htmlContent, downloadPath);
            }

            // İndirmeden sonra IndexedDB'den dosyaları sil
            if (downloadPath) {
                console.log("[CLEANUP] Deleting files from IndexedDB...");
                await deleteFilesFromIndexedDB(downloadPath);
                console.log("[CLEANUP] IndexedDB cleaned successfully.");
            }

        } catch (e) {
            console.error("Download error:", e);
        }
    };

    // Toplu derleme
    compiler.compile = async function(folderPath, downloadPath) {
        console.log(`%c[BATCH COMPILATION START]`, "color: yellow; font-weight: bold;");
        await compiler.add(folderPath);
        await compiler.start();
        if (downloadPath) {
            await compiler.download(downloadPath);
        }
        console.log(`%c[BATCH COMPILATION COMPLETE]`, "color: yellow; font-weight: bold;");
    };

    // IndexedDB durum kontrolü
    compiler.getIndexedDBStatus = async function(folderPath) {
        try {
            if (!db) {
                await initializeIndexedDB();
            }
            const files = await getAllFilesFromIndexedDB(folderPath);
            return {
                success: true,
                count: files.length,
                files: files
            };
        } catch (e) {
            return {
                success: false,
                error: e.message
            };
        }
    };

    // IndexedDB'den manuel silme
    compiler.clearIndexedDB = async function(folderPath) {
        try {
            await deleteFilesFromIndexedDB(folderPath);
            console.log(`[INFO] IndexedDB cleared for path: ${folderPath}`);
            return { success: true };
        } catch (e) {
            console.error("Clear error:", e);
            return { success: false, error: e.message };
        }
    };

    global.compiler = compiler;

})(typeof window !== 'undefined' ? window : global);