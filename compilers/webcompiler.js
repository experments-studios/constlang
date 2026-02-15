(function(global) {

    let compiledJSCache = null;
    let extractedHTMLCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];
    const TypeChecker = {
        variables: new Map(),
        errors: [],
        validTypes: ['int', 'intx', "Bool", 'string', 'ft'],
        typeAliases: {
            'string': 'string',
            'ft': 'bool'
        },
        
        reset() {
            this.variables.clear();
            this.errors = [];
        },
        
        normalizeType(type) {
            return this.typeAliases[type] || type;
        },
        
        addVariable(name, type, line) {
            type = this.normalizeType(type);
            
            if (!this.validTypes.includes(type) && !Object.keys(this.typeAliases).includes(type)) {
                this.errors.push(`ERROR [Line: ${line}]: type "${type}"`);
                return;
            }
            
            if (this.variables.has(name)) {
                this.errors.push(`error [line ${line}]: "${name}" `);
                return;
            }
            
            this.variables.set(name, type);
        },
        
        checkAssignment(name, valueType, line) {
            valueType = this.normalizeType(valueType);
            
            if (!this.variables.has(name)) {
                this.errors.push(`error [line ${line}]: "${name}" none`);
                return;
            }
            
            const varType = this.variables.get(name);
            if (varType !== valueType && valueType !== 'unknown') {
                this.errors.push(`Xəta [Sətir ${line}]: "${name}" tipi "${varType}", lakin "${valueType}" təyin edilir`);
            }
        },
        
        inferType(value) {
            value = value.trim();
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
                return 'string';
            }
            if (value === 'true' || value === 'false') {
                return 'ft';
            }
            if (/^[\d\s\+\-\*\/\(\)\.]+$/.test(value)) {
                return value.includes('.') ? 'intx' : 'int';
            }
            
            if (this.variables.has(value)) {
                return this.variables.get(value);
            }
            
            return 'unknown';
        },
        
        check(code) {
            this.reset();
            const lines = code.split('\n');
            
            lines.forEach((line, idx) => {
                const lineNum = idx + 1;
                line = line.trim();
                const varDecl = /^(int|intx|string|ft)\s+([a-zA-Z_]\w*)\s*=\s*(.+?);?$/.exec(line);
                if (varDecl) {
                    const varType = varDecl[1];
                    const varName = varDecl[2];
                    const value = varDecl[3];
                    
                    this.addVariable(varName, varType, lineNum);
                    
                    const valueType = this.inferType(value);
                    if (valueType !== 'unknown') {
                        this.checkAssignment(varName, valueType, lineNum);
                    }
                    return;
                }

                const varDeclOnly = /^(var|let|const)\s+(\w+)\s*:\s*(int|intx|double|string|mətn|bool|ft)\s*;?$/.exec(line);
                if (varDeclOnly) {
                    const varName = varDeclOnly[2];
                    const varType = varDeclOnly[3];
                    this.addVariable(varName, varType, lineNum);
                    return;
                }

                const assignment = /^(\w+)\s*=\s*(.+?);?$/.exec(line);
                if (assignment) {
                    const varName = assignment[1];
                    const value = assignment[2];
                    const valueType = this.inferType(value);
                    this.checkAssignment(varName, valueType, lineNum);
                }
            });
            
            if (this.errors.length > 0) {
                console.error('\n%c[type error]:', 'color: red; font-weight: bold;');
                this.errors.forEach(err => console.error(`  ${err}`));
                return false;
            }
            
            console.log('%c[Type ✓ ', 'color: lime; font-weight: bold;');
            return true;
        }
    };

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.html')) mimeType = 'text/html';
        if(filename.endsWith('.js')) mimeType = 'text/javascript';
        
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

        const imports = new Set();
        const visited = new Set();

        function findImports(filename) {
            if (visited.has(filename)) return;
            visited.add(filename);

            const content = fileCache[filename];
            if (!content) {
                console.warn(`File not found: ${filename}`);
                return;
            }

            const lines = content.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('#import')) {
                    const match = trimmed.match(/#import\s+["']([^"']+)["']/);
                    if (match) {
                        const importedFile = match[1];
                        if (!importedFile.endsWith('.clg') && !importedFile.endsWith('.nat')) {
                            console.warn(`Unsupported import: ${importedFile}`);
                            return;
                        }
                        imports.add(importedFile);
                        findImports(importedFile);
                    }
                }
            });
        }

        findImports(startFile);

        let bundled = fileCache[startFile] || "";

        imports.forEach(imp => {
            if (fileCache[imp]) {
                bundled = fileCache[imp] + "\n\n" + bundled;
            }
        });

        console.log("[PHASE 2] Imports collected:", Array.from(imports));
        return bundled;
    }

    function _extractHTML(code) {
        console.log("[PHASE 3] Extracting HTML blocks...");
        const htmlBlockPattern = /<!web\s+([\s\S]*?)!>/g;
        let match;
        let extractedHTML = "";

        while ((match = htmlBlockPattern.exec(code)) !== null) {
            extractedHTML += match[1].trim() + "\n";
        }

        if(extractedHTML) {
            extractedHTMLCache = extractedHTML;
            console.log("[HTML] Found HTML blocks...");
        } else {
            console.log("[HTML] No HTML blocks found.");
        }

        return code.replace(htmlBlockPattern, '');
    }

    function _transpile(code) {
        console.log("[PHASE 4] Type checking...");
        if (!TypeChecker.check(code)) {
            console.error("[COMPILATION ABORTED] Type errors detected!");
            return null;
        }

        console.log("[PHASE 5] Transpiling to JS...");
        let jsCode = _extractHTML(code);

        for (let pass = 0; pass < MAX_COMPILATION_PASSES; pass++) {
            jsCode = jsCode.replace(/#import\s+["']([^"']+)["']/g, '// imported: $1');
        }

        jsCode = jsCode.replace(/cin\.take\.int\s*\((.*?)\);?/g, (match, p1) => {
            return `parseInt(prompt(${p1}))`;
        });

        jsCode = jsCode.replace(/cin\.take\.string\s*\((.*?)\);?/g, (match, p1) => {
            return `prompt(${p1})`;
        });

        jsCode = jsCode.replace(/cin\.prompt\.bool\s*\((.*?)\);?/g, (match, p1) => {
            return `confirm(${p1})`;
        });

        jsCode = jsCode.replace(/cout\.show\s*\((.*?)\);?/g, (match, p1) => {
            return `console.log(${p1});`;
        });

        jsCode = jsCode.replace(/cout\.window\s*\((.*?)\);?/g, (match, p1) => {
            return `alert(${p1});`;
        });

        jsCode = jsCode.replace(/web\.html\.get\s*\(["']([^"']+)["']\);?/g, (match, elementId) => {
            return `document.getElementById("${elementId}")`;
        });

        jsCode = jsCode.replace(/web\.html\.getElement\s*\(["']([^"']+)["']\);?/g, (match, selector) => {
            return `document.querySelector("${selector}")`;
        });

        jsCode = jsCode.replace(/web\.html\.getAllElements\s*\(["']([^"']+)["']\);?/g, (match, selector) => {
            return `document.querySelectorAll("${selector}")`;
        });

        jsCode = jsCode.replace(/web\.html\.content\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, content) => {
            return `${element}.innerHTML = "${content}";`;
        });

        jsCode = jsCode.replace(/web\.html\.value\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, value) => {
            return `${element}.value = "${value}";`;
        });

        jsCode = jsCode.replace(/web\.html\.style\s*\(([^,]+),\s*["']([^"']+)["'],\s*["']([^"']+)["']\);?/g, 
            (match, element, property, value) => {
                return `${element}.style.${property} = "${value}";`;
        });

        jsCode = jsCode.replace(/web\.html\.addClass\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, className) => {
            return `${element}.classList.add("${className}");`;
        });

        jsCode = jsCode.replace(/web\.html\.removeClass\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, className) => {
            return `${element}.classList.remove("${className}");`;
        });

        jsCode = jsCode.replace(/web\.html\.toggleClass\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, className) => {
            return `${element}.classList.toggle("${className}");`;
        });

        jsCode = jsCode.replace(/web\.html\.attribute\s*\(([^,]+),\s*["']([^"']+)["'],\s*["']([^"']+)["']\);?/g, 
            (match, element, attr, value) => {
                return `${element}.setAttribute("${attr}", "${value}");`;
        });

        jsCode = jsCode.replace(/web\.html\.removeAttribute\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, attr) => {
            return `${element}.removeAttribute("${attr}");`;
        });

        jsCode = jsCode.replace(/web\.html\.create\s*\(["']([^"']+)["']\);?/g, (match, tagName) => {
            return `document.createElement("${tagName}")`;
        });

        jsCode = jsCode.replace(/web\.html\.append\s*\(([^,]+),\s*([^)]+)\);?/g, (match, parent, child) => {
            return `${parent}.appendChild(${child});`;
        });

        jsCode = jsCode.replace(/web\.html\.remove\s*\(([^)]+)\);?/g, (match, element) => {
            return `${element}.remove();`;
        });

        jsCode = jsCode.replace(/web\.html\.text\s*\(([^,]+),\s*["']([^"']+)["']\);?/g, (match, element, text) => {
            return `${element}.textContent = "${text}";`;
        });

        jsCode = jsCode.replace(/web\.html\.listener\s*\(([^,]+),\s*["']([^"']+)["'],\s*([^)]+)\);?/g, 
            (match, element, event, handler) => {
                return `${element}.addEventListener("${event}", ${handler});`;
        });

        jsCode = jsCode.replace(/web\.html\.removeListener\s*\(([^,]+),\s*["']([^"']+)["'],\s*([^)]+)\);?/g, 
            (match, element, event, handler) => {
                return `${element}.removeEventListener("${event}", ${handler});`;
        });

        jsCode = jsCode.replace(/web\.url\.get\s*\(\s*["']([^"']+)["']\s*,\s*action\s*=\s*({[\s\S]*?})\s*\);?/g, (match, urlParam, actionContent) => {
            actionContent = actionContent.trim();

            let output = "";
            if (actionContent.includes('var=')) {
                const varName = actionContent.match(/var\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `let ${varName} = new URLSearchParams(window.location.search).get("${urlParam}");`;
            } else if (actionContent.includes('json.search=')) {
                output = `// JSON search`;
            } else if (actionContent.includes('html.list=')) {
                output = `// HTML list`;
            }
            return output;
        });
          jsCode = jsCode.replace(/^\s*static\s+int256\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'const $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*static\s+int512\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'const $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*static\s+int1024\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'const $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*int256\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'let $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*int512\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'let $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*int1024\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 'let $1 = BigInt($2);');
        jsCode = jsCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*char\.i09\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*redata\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'let $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 = $2;');
        jsCode = jsCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'console.log($1);');
        jsCode = jsCode.replace(/console\.error\(([\s\S]*?)\);?/g, 'console.error($1);');
        jsCode = jsCode.replace(/console\.status\s*\(\s*\);?/g, 'console.log(new Date());');
        jsCode = jsCode.replace(/console\.color\s*\("(.*?)"\);?/g, '// Color: $1');
        jsCode = jsCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'alert($1);');
        jsCode = jsCode.replace(/system\.beep\(([\s\S]*?)\);?/g, '// Beep sound');
        jsCode = jsCode.replace(/file\.add\(([\s\S]*?)\);?/g, '// Write file: $1');
        jsCode = jsCode.replace(/file\.load\(([\s\S]*?)\);?/g, 'await fetch($1).then(r => r.text());');
        jsCode = jsCode.replace(/file\.move\(([\s\S]*?)\);?/g, '// Move file: $1');
        jsCode = jsCode.replace(/file\.copy\(([\s\S]*?)\);?/g, '// Copy file: $1');
        jsCode = jsCode.replace(/file\.redata\(([\s\S]*?)\);?/g, '// Stream: $1');
        jsCode = jsCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'await fetch($1).then(r => r.text());');
        jsCode = jsCode.replace(/open\.folder\(([\s\S]*?)\);?/g, '// Open folder: $1');
        jsCode = jsCode.replace(/open\.window\(([\s\S]*?)\);?/g, 'window.open($1);');
        jsCode = jsCode.replace(/folder\.add\(([\s\S]*?)\);?/g, '// Create folder: $1');
        jsCode = jsCode.replace(/folder\.move\(([\s\S]*?)\);?/g, '// Move folder: $1');
        jsCode = jsCode.replace(/folder\.fileinfo\(([\s\S]*?)\);?/g, '// List files: $1');
        jsCode = jsCode.replace(/folder\.folderinfo\(([\s\S]*?)\);?/g, '// List folders: $1');
        jsCode = jsCode.replace(/read\.int32\s*\(([\s\S]*?)\);?/g, 'parseInt(prompt($1));');
        jsCode = jsCode.replace(/read\.int16\s*\(([\s\S]*?)\);?/g, 'parseInt(prompt($1));');
        jsCode = jsCode.replace(/read\.int64\s*\(([\s\S]*?)\);?/g, 'parseInt(prompt($1));');
        jsCode = jsCode.replace(/read\.intx\s*\(([\s\S]*?)\);?/g, 'parseFloat(prompt($1));');
        jsCode = jsCode.replace(/read\.string\s*\(([\s\S]*?)\);?/g, 'prompt($1);');
        jsCode = jsCode.replace(/read\.byte\s*\(([\s\S]*?)\);?/g, 'parseInt(prompt($1));');
        jsCode = jsCode.replace(/read\.base64\s*\(([\s\S]*?)\);?/g, 'btoa(prompt($1));');
        jsCode = jsCode.replace(/read\.data\s*\(([\s\S]*?)\);?/g, 'prompt($1);');
        jsCode = jsCode.replace(/read\.title\(([\s\S]*?)\);?/g, 'prompt($1);');
        jsCode = jsCode.replace(/to\.int32\s*\(([\s\S]*?)\);?/g, 'parseInt($1);');
        jsCode = jsCode.replace(/to\.int16\s*\(([\s\S]*?)\);?/g, 'parseInt($1);');
        jsCode = jsCode.replace(/to\.int64\s*\(([\s\S]*?)\);?/g, 'parseInt($1);');
        jsCode = jsCode.replace(/to\.int128\s*\(([\s\S]*?)\);?/g, 'parseInt($1);');
        jsCode = jsCode.replace(/to\.string\s*\(([\s\S]*?)\);?/g, 'String($1);');
        jsCode = jsCode.replace(/to\.intx\s*\(([\s\S]*?)\);?/g, 'parseFloat($1);');
        jsCode = jsCode.replace(/to\.byte\s*\(([\s\S]*?)\);?/g, 'parseInt($1);');
        jsCode = jsCode.replace(/to\.ft\s*\(([\s\S]*?)\);?/g, 'Boolean($1);');
        jsCode = jsCode.replace(/to\.base64\s*\(([\s\S]*?)\);?/g, 'btoa($1);');
        jsCode = jsCode.replace(/converter\.utf8\.byte\s*\(([\s\S]*?)\);?/g, 'new TextEncoder().encode($1);');
        jsCode = jsCode.replace(/get\s*\(([\s\S]*?)\);?/g, 'await fetch($1).then(r => r.json());');
        jsCode = jsCode.replace(/oldcommand1\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'let $2 = await fetch("$1").then(r => r.json());');
        jsCode = jsCode.replace(/http\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            '// HTTP removed');
        jsCode = jsCode.replace(/ip\.parse\s*\(([\s\S]*?)\);?/g, '// IP parse: $1');
        jsCode = jsCode.replace(/ip\.endpoint\s*\(([\s\S]*?)\);?/g, '// IP endpoint: $1');
        jsCode = jsCode.replace(/.ip\.streamr\s*\(([\s\S]*?)\);?/g, '// Network stream: $1');
        jsCode = jsCode.replace(/\.write\(([\s\S]*?)\);?/g, '.write($1);');
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
                output = `// JSON search`;
            } else if (actionContent.includes('html.list=')) {
                output = `// HTML list`;
            }
            return output;
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

        console.log("[PHASE 6] Final validation...");
        console.log("[COMPILATION] Successfully completed!");
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
                console.error("[COMPILATION FAILED]");
                return;
            }

            compiledJSCache = jsBody;

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

        console.log("Downloading JavaScript File...");
        _downloadFile(filename, compiledJSCache);

        if (extractedHTMLCache.trim() !== "") {
            console.log("Downloading HTML File...");
            const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>CLG Application</title>
</head>
<body>
${extractedHTMLCache}
    <script src="${filename}"><\/script>
</body>
</html>
`;
            _downloadFile("index.html", htmlContent);
        }
    };

    compiler.compile = async function() {
        console.log(`%c[JS COMPILATION START]`, "color: yellow; font-weight: bold;");
        await compiler.add();
        await compiler.start();
        console.log(`%c[JS COMPILATION COMPLETE]`, "color: yellow; font-weight: bold;");
    };

    global.compiler = compiler;

})(typeof window !== 'undefined' ? window : global);