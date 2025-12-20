(function(global) {

    let compiledJSCache = null;
    let extractedHTMLCache = ""; 
    const entryPoint = 'main.clg';

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.html')) mimeType = 'text/html';
        
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
                if (entry.name.endsWith('.clg')) {
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
        console.log(`Bundling....'${startFile}'`);
        
        const fileCache = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key.endsWith('.clg')) {
                fileCache[key] = sessionStorage.getItem(key);
            }
        }

        if (!fileCache[startFile]) {
            console.error(`ENTRY FILE NOT FOUND: (${startFile})`);
            return null;
        }

        const processedFiles = new Set();

        async function processFile(filename) {
            if (processedFiles.has(filename)) return "";
            processedFiles.add(filename);

            let content = fileCache[filename];
            if (!content) return "";

            const installRegex = /^\s*#install\s+(.*?);?\s*$/gm;
            const importRegex = /^\s*#import\s+(.*?);?\s*$/gm;
            let bundledDependencies = "";

            const installMatches = [...content.matchAll(installRegex)];
            for (const match of installMatches) {
                try {
                    const res = await fetch(match[1].trim());
                    bundledDependencies += `\n${await res.text()}\n\n`;
                } catch (e) { console.error("Install Error", e); }
            }
            content = content.replace(installRegex, '');

            const importMatches = [...content.matchAll(importRegex)];
            for (const match of importMatches) {
                bundledDependencies += await processFile(match[1].trim()) + "\n\n";
            }
            content = content.replace(importRegex, '');

            return `\n${bundledDependencies}\n${content}\n`;
        }

        return await processFile(startFile);
    }

    function _transpile(constlangCode) {
        console.log("Compiler loading...");
        let jsCode = constlangCode;

        jsCode = jsCode.replace(/\/\/.*/g, '//');
        jsCode = jsCode.replace(/\/\*[\s\S]*?\*\//g, '//');

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
            try { jsCode = jsCode.replace(new RegExp(regexPattern, 'gm'), jsTemplate); } catch (e) {}
        }

        jsCode = jsCode.replace(/naviteapi\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');

        jsCode = jsCode.replace(/oldcommand1\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'string $2 = await fetch("$1").then(r => r.json());');

        jsCode = jsCode.replace(/http\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'string $2 = await fetch("$1").then(r => r.text());');

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
                const jsonId = actionContent.match(/json\.search\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `
                {
                   Console.Error.WriteLine("Constlang error"); 
                    }
                }`;
            } else if (actionContent.includes('html.list=')) {
                const listId = actionContent.match(/html\.list\s*=\s*["']?([a-zA-Z0-9_]+)["']?/)[1];
                output = `
                 Console.Error.WriteLine("Constlang error");
                `;
            }
            return output;
        });
     
        jsCode = jsCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'int $1 = $2;');
        jsCode = jsCode.replace(/^\s*intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'double $1 = $2;');
        jsCode = jsCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'string $1 = $2;');
        jsCode = jsCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'bool $1 = $2;');
        jsCode = jsCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'Console.WriteLine($1);');
        jsCode = jsCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'Console.WriteLine($1);');
        jsCode = jsCode.replace(/get\s*\(([\s\S]*?)\);?/g, 'await client.GetFromJsonAsync($1);');
        jsCode = jsCode.replace(/read\.int32\s*\(([\s\S]*?)\);?/g, 'Convert.ToInt32(Console.ReadLine($));');
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
        jsCode = jsCode.replace(/while \s*\(([\s\S]*?)\);?/g, 'while ($1)');
        jsCode = jsCode.replace(/for \s*\(([\s\S]*?)\);?/g, 'for ($1)');
        jsCode = jsCode.replace(/if \s*\{([\s\S]*?)\};?/g, 'do {$1}');
        jsCode = jsCode.replace(/^\s*static\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const int $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const double $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const string $1 = $2;');
        jsCode = jsCode.replace(/^\s*static\s+ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const bool $1 = $2;');
        jsCode = jsCode.replace(/console\.error\(([\s\S]*?)\);?/g, 'Console.Error.WriteLine($1);');
        jsCode = jsCode.replace(/system\.beep\(([\s\S]*?)\);?/g, 'Console.Beep($1);');
        jsCode = jsCode.replace(/read\.title\(([\s\S]*?)\);?/g, 'Console.Write($1);');
        jsCode = jsCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'File.ReadAllText($1);');
        jsCode = jsCode.replace(/open\.folder\(([\s\S]*?)\);?/g, 'Path.GetFullPath($1);');
        jsCode = jsCode.replace(/.list\.add\(([\s\S]*?)\);?/g, '.Add($1);');
        jsCode = jsCode.replace(/.list\.new\(([\s\S]*?)\);?/g, '.Insert($1);');
        jsCode = jsCode.replace(/.list\.delente\(([\s\S]*?)\);?/g, '.RemoveAt($1);');
        jsCode = jsCode.replace(/.list\.count\(([\s\S]*?)\);?/g, '.Count;');
        jsCode = jsCode.replace(/.list\.index\(([\s\S]*?)\);?/g, '.IndexOf($1);');
        jsCode = jsCode.replace(/.list\.control\(([\s\S]*?)\);?/g, '.Contains($1);');
        jsCode = jsCode.replace(/.list\.clr\(([\s\S]*?)\);?/g, '.Clear($1);');
        jsCode = jsCode.replace(/.list\.all\(([\s\S]*?)\);?/g, '.Sort($1);');
        jsCode = jsCode.replace(/.list\.redata\(([\s\S]*?)\);?/g, '.Reverse($1);');
        jsCode = jsCode.replace(/.list\.join\(([\s\S]*?)\);?/g, '.string.Join($1);');

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
            console.error("Directory selection cancelled or error occurred:", e);
        }
    };

    compiler.start = async function() {
        console.log("%cCompiler Started...", "color: lime; font-weight: bold;");
        compiledJSCache = null;
        extractedHTMLCache = "";

        const bundledCode = await _bundle(entryPoint);
        if (!bundledCode) return;

        try {
            const jsBody = _transpile(bundledCode);
            
            compiledJSCache = `
             ${jsBody}
`;

            console.log("Compilation Successful. Download with: 'compiler.download()'.");
            if(extractedHTMLCache) console.log(">> GUI Interface Detected <<");

        } catch (e) {
            console.error("Compilation Error:", e);
        }
    };

    compiler.download = function(filename = "main.cs") {
        if (!compiledJSCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        console.log("Downloading cs File...");
        _downloadFile(filename, compiledJSCache);

        if (extractedHTMLCache.trim() !== "") {
            console.log("Downloading GUI File...");
            const htmlContent = `
    ${extractedHTMLCache}
`;
            _downloadFile("gui.cs", htmlContent);
        }
    };

    global.compiler = compiler;
    console.log("Start with: 'compiler.add()'");

})(window);

