(function(global) {
        
        let compiledJSCache = null;
        const entryPoint = 'main.clg';

        function _downloadFile(filename, text) {
            const element = document.createElement('a');
            element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
            element.setAttribute('download', filename);
            element.style.display = 'none';
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
        }

        async function _bundle(startFile) {
            console.log(`Bundling....'${startFile}'`);
            
            const fileCache = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key.endsWith('.clg')) {
                    fileCache[key] = sessionStorage.getItem(key);
                }
            }

            if (!fileCache[startFile]) {
                console.error(`NO FILE;(${startFile})`);
                return null;
            }

            const processedFiles = new Set();
            let finalCode = "";

            async function processFile(filename) {
                if (processedFiles.has(filename)) {
                    return ""; 
                }
                processedFiles.add(filename);

                let content = fileCache[filename];
                if (!content) {
                    console.error(`NO FILE;${filename} `);
                    return "";
                }

                const installRegex = /^\s*#install\s+(.*?);?\s*$/gm;
                const importRegex = /^\s*#import\s+(.*?);?\s*$/gm;

                let bundledDependencies = "";

                const installMatches = [...content.matchAll(installRegex)];
                for (const match of installMatches) {
                    const url = match[1].trim();
                    try {
                        console.log(`downloading: ${url}`);
                        const response = await fetch(url);
                        if (!response.ok) throw new Error(`HTTP ${response.status} - ${response.statusText}`);
                        const remoteCode = await response.text();
                        bundledDependencies += `\n${remoteCode}\n\n`;
                    } catch (e) {
                        console.error(`#install ERROR: #install ${url} `, e.message);
                    }
                }
                content = content.replace(installRegex, ''); 

                const importMatches = [...content.matchAll(importRegex)];
                for (const match of importMatches) {
                    const localFile = match[1].trim();
                    bundledDependencies += await processFile(localFile) + "\n\n";
                }
                content = content.replace(importRegex, ''); 

                return `\n${bundledDependencies}\n${content}\n`;
            }

            finalCode = await processFile(startFile);
            console.log("....");
            return finalCode;
        }

        function _transpile(constlangCode) {
            console.log(".....");
            let jsCode = constlangCode;
            
            const macros = [];
            const macroRegex = /new\.command\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
            
            jsCode = jsCode.replace(macroRegex, (match, pattern, template) => {
                macros.push({ 
                    pattern: pattern.trim(), 
                    template: template.trim() 
                });
                return ""; 
            });

            if (macros.length > 0) {
                console.log(`${macros.length} ....`);
            }

            for (const macro of macros) {
                const varRegex = /\$\{cmd\^(.*?)\}/g;
                const varNames = [];
                let regexPattern = macro.pattern;

                regexPattern = regexPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                regexPattern = regexPattern.replace(/\\\$\\\{cmd\\\^(.*?)\\\}/g, (match, varName) => {
                    varNames.push(varName);
                    return '([\\s\\S]*?)'; 
                });
                
                let jsTemplate = macro.template;
                for (let i = 0; i < varNames.length; i++) {
                    jsTemplate = jsTemplate.replace(new RegExp(`\\$\\{cmd\\^${varNames[i]}\\}|\\$\\{${varNames[i]}}`, 'g'), `$${i + 1}`);
                }

                try {
                    jsCode = jsCode.replace(new RegExp(regexPattern, 'gm'), jsTemplate);
                } catch (e) {
                    console.error(`Macro ERROR: ${macro.pattern} -> ${e.message}`);
                }
            }

            jsCode = jsCode.replace(/addon\(\)\s*\{([\s\S]*?)\}/g, '$1');

            jsCode = jsCode.replace(/^set\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');

            jsCode = jsCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'console.log($1);');
            
            jsCode = jsCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'alert($1);');

            console.log("......");
            return jsCode;
        }

        const compiler = {};

        compiler.add = async function() {
            try {
                const handles = await global.showOpenFilePicker({ 
                    multiple: true,
                    types: [{
                        description: 'ConstLang Files',
                        accept: { 'text/plain': ['.clg'] },
                    }],
                });
                
                sessionStorage.clear(); 
                let fileCount = 0;
                
                for (const handle of handles) {
                    const file = await handle.getFile();
                    if (file.name.endsWith('.clg')) {
                        const content = await file.text();
                        sessionStorage.setItem(file.name, content);
                        console.log(`ADD FILE: ${file.name} (${file.size} bytes)`);
                        fileCount++;
                    }
                }
                console.log(`${fileCount} FILE`);
                console.log(`Start Compiler compiler.start()`);
            } catch (e) {
                if (e.name === "AbortError") {
                    console.warn("Compiler ERROR");
                } else {
                    console.error("ERROR:", e.message);
                }
            }
        };

        compiler.start = async function() {
            console.log("CONSTLANG Compiler starting", "color: #007bff; font-size: 1.2em;");
            compiledJSCache = null; 
            
            const bundledConstLang = await _bundle(entryPoint);

            if (!bundledConstLang) {
                console.error("Compiler Error");
                return;
            }

            try {
                compiledJSCache = _transpile(bundledConstLang);
                console.log("Compiler startend");
                console.log(compiledJSCache.split('\n').slice(0, 20).join('\n') + "\n...");
                console.log("-------------------------------------------");
                console.log("download output; compiler.download()");
            } catch (e) {
                console.error("Compiler Error", e);
                console.warn("ConstLang Code:");
                console.log(bundledConstLang);
            }
        };

        compiler.download = function() {
            if (!compiledJSCache) {
                console.error("to start the compiler; compiler.start()");
                return;
            }
            console.log("downloading file output....");
            _downloadFile("output.js", compiledJSCache);
        };
        
        global.compiler = compiler;
        console.log("");

    })(window);