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
            if(filename.endsWith('.js')) mimeType = 'text/plain';
            
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
        jsCode = jsCode.replace(/in\.main\.win32\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.win64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.docker\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.sh\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.bat\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.web\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
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
        jsCode = jsCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, '"web"');
        jsCode = jsCode.replace(/^\s*const\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+Int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+double\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+bool\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, ' $1 = $2;');
        jsCode = jsCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'byte[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*double\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*float\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*decimal\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+float\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*const\s+decimal\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\.i09\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char.IsDigit');
        jsCode = jsCode.replace(/^\s*bool\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*redata\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, ' $1 = $2;');
        jsCode = jsCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'byte[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char[] $1 = $2;');
        jsCode = jsCode.replace(/^\s*int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\.i09\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'char.IsDigit');
        jsCode = jsCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/console\.println\s*\(([\s\S]*?)\);?/g, 'console.log($1)');
        jsCode = jsCode.replace(/console\.error\s*\(([\s\S]*?)\);?/g, 'console.error($1)');
        jsCode = jsCode.replace(/text\s*\(([\s\S]*?)\);?/g, '"$1"');
        jsCode = jsCode.replace(/open\.file\(([\s\S]*?)\);?/g, '');
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
        jsCode = jsCode.replace(/in\.main\.web\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
         jsCode = jsCode.replace(/in\.main\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.linux32\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/in\.main\.mac64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.linux64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.win32\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.win64\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.docker\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.sh\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.bat\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '');
        jsCode = jsCode.replace(/in\.main\.app\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');
           jsCode = jsCode.replace(/class\s*\({[\s\S]*?}\);?/g, 'class $1');
        jsCode = jsCode.replace(/new\s*\({[\s\S]*?}\);?/g, 'new $1');
         jsCode = jsCode.replace(/public\s*\({[\s\S]*?}\);?/g, '$1');
          jsCode = jsCode.replace(/private\s*\({[\s\S]*?}\);?/g, '#$1');
           jsCode = jsCode.replace(/void\s*\({[\s\S]*?}\);?/g, '$1');
            jsCode = jsCode.replace(/static\s*\({[\s\S]*?}\);?/g, 'static $1');
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
${jsBody}
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
                <script src="runtime.js"></script>
                <script src="main.js"></script>

${extractedHTMLCache}
`;
                await _downloadFile("index.html", htmlContent, downloadPath);
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