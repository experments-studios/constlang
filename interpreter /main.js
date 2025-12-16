(function(global) {

    let extractedHTMLCache = ""; 

    async function _bundle(startFile, fileCache) {
        
        const processedFiles = new Set();
        
        async function processFile(filename) {
            if (processedFiles.has(filename)) return "";
            processedFiles.add(filename);

            let content = fileCache[filename];
            if (!content) return ""; 

            const installRegex = /^\s*#install\s+(.*?);?\s*$/gm;
            const importRegex = /^\s*#import\s+(.*?);?\s*$/gm;
            let currentFileDependencies = "";

            const installMatches = [...content.matchAll(installRegex)];
            for (const match of installMatches) {
                try {
                    const res = await fetch(match[1].trim());
                    currentFileDependencies += `\n${await res.text()}\n\n`;
                } catch (e) { console.error(`[INSTALL Error] ${match[1].trim()}:`, e); }
            }
            content = content.replace(installRegex, '');

            content = content.replace(importRegex, '');
            
            return `\n${currentFileDependencies}\n${content}\n`;
        }

        return await processFile(startFile);
    }

    function _transpile(constlangCode) {
        console.log("Transpiling code to JavaScript...");
        extractedHTMLCache = ""; 

        let jsCode = constlangCode;
        jsCode = jsCode.replace(/^\uFEFF/gm, ""); 
        
        jsCode = jsCode.replace(/\/\/.*/g, '');
        jsCode = jsCode.replace(/\/\*[\s\S]*?\*\//g, '');

        const guiRegex = /gui\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        jsCode = jsCode.replace(guiRegex, (match, htmlContent) => {
            extractedHTMLCache += htmlContent.trim() + "\n";
            return "";
        });

        const macros = [];
        const macroRegex = /new\.command\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
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
            
            try { 
                jsCode = jsCode.replace(new RegExp(regexPattern, 'gm'), jsTemplate); 
            } catch (e) {
                console.warn(`Macro application error (${macro.pattern}):`, e.message);
            }
        }

        jsCode = jsCode.replace(/webapi\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');

        jsCode = jsCode.replace(/get\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'let $2 = await fetch("$1").then(r => r.json());');

        jsCode = jsCode.replace(/http\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'let $2 = await fetch("$1").then(r => r.text());');

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
                const varMatch = actionContent.match(/var\s*=\s*["']?([a-zA-Z0-9_]+)["']?/);
                const varName = varMatch ? varMatch[1] : `__link_var_${Date.now()}`;
                output = `let ${varName} = new URLSearchParams(window.location.search).get("${urlParam}");`;
            } else if (actionContent.includes('json.search=')) {
                const jsonId = actionContent.match(/json\.search\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `
                {
                    let _sKey = new URLSearchParams(window.location.search).get("${urlParam}");
                    if(_sKey && typeof ${jsonId} !== 'undefined' && Array.isArray(${jsonId})) {
                        let _found = ${jsonId}.filter(item => JSON.stringify(item).includes(_sKey));
                        ${jsonId} = _found; 
                    }
                }`;
            } else if (actionContent.includes('html.list=')) {
                const listId = actionContent.match(/html\.list\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `
                {
                    let _sKey = new URLSearchParams(window.location.search).get("${urlParam}");
                    if(_sKey) {
                        let _ul = document.getElementById("${listId}");
                        if(_ul) {
                            Array.from(_ul.children).forEach(li => {
                                if(!li.innerText.includes(_sKey)) li.style.display = 'none';
                            });
                        }
                    }
                }`;
            }
            return output;
        });

        jsCode = jsCode.replace(/while\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/g, 'while ($1) {$2}');
        
        jsCode = jsCode.replace(/for\s*\(([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^)]+?)\)\s*\{([\s\S]*?)\}/g, 
            'for (let $1 = $2; $1 < $3; $1++) {$4}');

        jsCode = jsCode.replace(/addon\(\)\s*\{([\s\S]*?)\}/g, '$1');
        jsCode = jsCode.replace(/^set\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'console.log($1);');
        jsCode = jsCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'alert($1);');
        jsCode = jsCode.replace(/console\.input\s*\(([\s\S]*?)\);?/g, 'prompt($1)');

        jsCode = jsCode.trim();
        
        return jsCode;
    }

    async function startRuntime() {
        const urlParams = new URLSearchParams(window.location.search);
        const runtimeFile = urlParams.get('runtime');

        if (runtimeFile) {
            console.log(`%cConstLang JIT Runtime started: ${runtimeFile}`, "color: yellow; font-weight: bold;");
            let clgContent = null;
            try {
                const response = await fetch(runtimeFile);
                if (!response.ok) {
                    throw new Error(`File not found or failed to load (HTTP ${response.status}): ${runtimeFile}`);
                }
                clgContent = await response.text();
            } catch (e) {
                console.error(`CLG File Load Error: ${e.message}`);
                document.body.innerHTML = `<h1>Error: CLG file failed to load.</h1><p>File: <code>${runtimeFile}</code></p><p>Detail: ${e.message}</p>`;
                return;
            }

            try {
                const fileCache = {};
                fileCache[runtimeFile] = clgContent;
                
                const bundledCode = await _bundle(runtimeFile, fileCache); 
                const jsBody = _transpile(bundledCode); 

                const executableJS = `
(async function() {
    try {
        ${jsBody}
    } catch(err) {
        console.error("Runtime Error (JS Code):", err);
    }
})();`;

                if (extractedHTMLCache.trim() !== "") {
                    document.body.innerHTML = extractedHTMLCache; 
                } else if (!document.body.innerHTML.trim()) {
                    document.body.innerHTML = "<h1>ConstLang Code Executing...</h1><p>GUI block not found.</p>";
                }

                eval(executableJS); 
                
            } catch (e) {
                console.error("Transpilation/Runtime Error:", e);
                document.body.innerHTML = `<h1>Error: </h1>`;
            }
            
        } else {
            document.body.innerHTML = '';
        }
    }

    startRuntime();

})(window);
