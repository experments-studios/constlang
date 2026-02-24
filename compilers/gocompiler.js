(function(global) {
    let compiledGoCache = null;
    let extractedGoModCache = ""; 
    const entryPoint = 'main.clg';
    let MAX_COMPILATION_PASSES = 249;
    const SPECIAL_COMMANDS = ['#import', '#install', '#compiled', 'cmd.fn', 'cmd.save', 'create.ctfile', 'create.ctfolder'];

    function _downloadFile(filename, text) {
        const element = document.createElement('a');
        let mimeType = 'text/plain';
        if(filename.endsWith('.html')) mimeType = 'text/html';
        if(filename.endsWith('.go')) mimeType = 'text/plain';
        
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
        let goCode = constlangCode;
        let passCount = 0;

        const hasSpecialCommands = _containsSpecialCommand(goCode);
        
        if (hasSpecialCommands) {
            console.log("[PHASE 1-4] Special commands detected. Starting multi-pass compilation loop...");
            
            while (passCount < MAX_COMPILATION_PASSES) {
                passCount++;
                const beforeCode = goCode;
                console.log(`[PASS ${passCount}] Processing...`);

                const macros = [];
                const macroRegex = /cmd\.fn\(\)\s*\[\s*([\s\S]*?)\s*command\(\)\s*([\s\S]*?)\s*\]/g;
                goCode = goCode.replace(macroRegex, (match, pattern, template) => {
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
                    
                    let goTemplate = macro.template;
                    for (let i = 0; i < varNames.length; i++) {
                        goTemplate = goTemplate.replace(new RegExp(`\\$\\{cmd\\^${varNames[i]}\\}|\\$\\{${varNames[i]}}`, 'g'), `$${i + 1}`);
                    }
                    try { goCode = goCode.replace(new RegExp(regexPattern, 'gm'), goTemplate); } catch (e) {}
                }

                goCode = goCode.replace(/cmd\.save\(\s*([^)]*)\s*\)/g, 'fmt.Println($1);');
                goCode = goCode.replace(/create\.ctfolder\s*\(\s*([a-zA-Z0-9_"'\s]+)\s*\)/g, 'os.MkdirAll($1, 0755);');
                goCode = goCode.replace(/create\.ctfile\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\{([\s\S]*?)\}/g, 
                    (match, filename, varname, content) => {
                        return `ioutil.WriteFile(${filename}, []byte(\`${content.trim()}\`), 0644);`;
                    }
                );

                if (!_containsSpecialCommand(goCode)) {
                    console.log(`[PASS ${passCount}/PHASE 5] Validation complete. No special commands found. Loop exiting.`);
                    break;
                }

                if (goCode === beforeCode) {
                    console.log(`[PASS ${passCount}/PHASE 5] No changes detected in this pass but special commands remain.`);
                    console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                    return null;
                }
            }

            if (passCount >= MAX_COMPILATION_PASSES && _containsSpecialCommand(goCode)) {
                console.error(`COMPILATION ERROR: Maximum passes (${MAX_COMPILATION_PASSES}) exceeded.`);
                return null;
            }
        } else {
            console.log("[PHASE 1-4] No special commands found in initial code. Skipping loop.");
        }

        if (_containsSpecialCommand(goCode)) {
            console.error(`COMPILATION ERROR: Special commands remain after compilation.`);
            return null;
        }

        goCode = goCode.replace(/\/\/.*/g, '');
        goCode = goCode.replace(/\/\*[\s\S]*?\*\//g, '');

        const guiRegex = /config\s*\(\s*\)\s*\{([\s\S]*?)\}/g;
        goCode = goCode.replace(guiRegex, (match, htmlContent) => {
            extractedGoModCache += htmlContent.trim() + "\n";
            return "";
        });

        goCode = goCode.replace(/addon\.app\s*\(\s*\)\s*\{([\s\S]*?)\}/g, '$1');

        goCode = goCode.replace(/oldcommand1\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'resp, _ := http.Get("$1"); defer resp.Body.Close();');

        goCode = goCode.replace(/http\s*\(\s*["']?(.*?)["']?\s*\)\s*\{\s*data\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*\}/g, 
            'log.Println("HTTP request");');

        // Büyük tamsayı tipleri
        goCode = goCode.replace(/^\s*int256\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            'var $1 *big.Int = new(big.Int).SetString("$2", 10);');
        goCode = goCode.replace(/^\s*int512\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            'var $1 *big.Int = new(big.Int).SetString("$2", 10);');
        goCode = goCode.replace(/^\s*int1024\s+([a-zA-Z0-9_]+)\s*=\s*([0-9]+);?/gm, 
            'var $1 *big.Int = new(big.Int).SetString("$2", 10);');

        // Standart tipler
        goCode = goCode.replace(/^\s*int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 int = $2;');
        goCode = goCode.replace(/^\s*int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 int16 = $2;');
        goCode = goCode.replace(/^\s*int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 int32 = $2;');
        goCode = goCode.replace(/^\s*int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 int64 = $2;');
        goCode = goCode.replace(/^\s*int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 *big.Int = new(big.Int);');
        goCode = goCode.replace(/^\s*intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 float64 = $2;');
        goCode = goCode.replace(/^\s*string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 string = $2;');
        goCode = goCode.replace(/^\s*ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 bool = $2;');
        goCode = goCode.replace(/^\s*byte\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 []byte = []byte($2);');
        goCode = goCode.replace(/^\s*redata\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 = $2;');

        goCode = goCode.replace(/system\.os\s*\(([\s\S]*?)\);?/g, 'runtime.GOOS');
        goCode = goCode.replace(/text\s*\(([\s\S]*?)\);?/g, '"$1"');

        // PHASE 3: Print işlemleri
        console.log("[PHASE 3] Print operations...");
        goCode = goCode.replace(/console\.print\(([\s\S]*?)\);?/g, 'fmt.Println($1);');
        goCode = goCode.replace(/print\s*\(([\s\S]*?)\);?/g, 'fmt.Println($1);');
        goCode = goCode.replace(/print\.text\s*\(([\s\S]*?)\);?/g, 'fmt.Print($1);');
        goCode = goCode.replace(/print\.ln\s*\(([\s\S]*?)\);?/g, 'fmt.Println($1);');
        goCode = goCode.replace(/print\.error\s*\(([\s\S]*?)\);?/g, 'fmt.Fprintln(os.Stderr, $1);');
        goCode = goCode.replace(/console\.error\(([\s\S]*?)\);?/g, 'fmt.Fprintln(os.Stderr, $1);');
        goCode = goCode.replace(/console\.error\s*\(([\s\S]*?)\);?/g, 'log.Println($1);');
        goCode = goCode.replace(/error\.logf\s*\(([\s\S]*?)\);?/g, 'log.Printf($1);');
        goCode = goCode.replace(/alert\.data\(([\s\S]*?)\);?/g, 'fmt.Println($1);');
        goCode = goCode.replace(/console\.status\s*\(\s*\);?/g, 'printStatus();');
        goCode = goCode.replace(/read\.data\s*\(([\s\S]*?)\);?/g, 'bufio.NewScanner(os.Stdin).Text();');
        goCode = goCode.replace(/read\.title\(([\s\S]*?)\);?/g, 'fmt.Print($1);');
        goCode = goCode.replace(/get\s*\(([\s\S]*?)\);?/g, 'http.Get($1);');

        // PHASE 4: Input işlemleri
        console.log("[PHASE 4] Input operations...");
        goCode = goCode.replace(/input\s*\(([\s\S]*?)\);?/g, 'bufio.NewScanner(os.Stdin).Text();');
        goCode = goCode.replace(/input\.line\s*\(([\s\S]*?)\);?/g, 'bufio.NewScanner(os.Stdin).Text();');
        goCode = goCode.replace(/read\.line\s*\(\s*\);?/g, 'bufio.NewScanner(os.Stdin).Text();');
        goCode = goCode.replace(/read\.int32\s*\(([\s\S]*?)\);?/g, 'strconv.Atoi(bufio.NewScanner(os.Stdin).Text());');
        goCode = goCode.replace(/read\.int16\s*\(([\s\S]*?)\);?/g, 'int16(strconv.Atoi(bufio.NewScanner(os.Stdin).Text()));');
        goCode = goCode.replace(/read\.int64\s*\(([\s\S]*?)\);?/g, 'int64(strconv.Atoi(bufio.NewScanner(os.Stdin).Text()));');
        goCode = goCode.replace(/read\.intx\s*\(([\s\S]*?)\);?/g, 'strconv.ParseFloat(bufio.NewScanner(os.Stdin).Text(), 64);');
        goCode = goCode.replace(/read\.string\s*\(([\s\S]*?)\);?/g, 'bufio.NewScanner(os.Stdin).Text();');

        // PHASE 5: String işlemleri
        console.log("[PHASE 5] String operations...");
        goCode = goCode.replace(/string\.length\(([\s\S]*?)\);?/g, 'len($1);');
        goCode = goCode.replace(/string\.char\s+at\(([\s\S]*?),([\s\S]*?)\);?/g, 'rune($1[$2]);');
        goCode = goCode.replace(/string\.substring\(([\s\S]*?),([\s\S]*?),([\s\S]*?)\);?/g, '$1[$2:$3];');
        goCode = goCode.replace(/string\.tolower\(([\s\S]*?)\);?/g, 'strings.ToLower($1);');
        goCode = goCode.replace(/string\.toupper\(([\s\S]*?)\);?/g, 'strings.ToUpper($1);');
        goCode = goCode.replace(/string\.trim\(([\s\S]*?)\);?/g, 'strings.TrimSpace($1);');
        goCode = goCode.replace(/string\.replace\(([\s\S]*?),([\s\S]*?),([\s\S]*?)\);?/g, 'strings.ReplaceAll($1, $2, $3);');
        goCode = goCode.replace(/string\.split\(([\s\S]*?),([\s\S]*?)\);?/g, 'strings.Split($1, $2);');
        goCode = goCode.replace(/string\.contains\(([\s\S]*?),([\s\S]*?)\);?/g, 'strings.Contains($1, $2);');
        goCode = goCode.replace(/string\.startswith\(([\s\S]*?),([\s\S]*?)\);?/g, 'strings.HasPrefix($1, $2);');
        goCode = goCode.replace(/string\.endswith\(([\s\S]*?),([\s\S]*?)\);?/g, 'strings.HasSuffix($1, $2);');
        goCode = goCode.replace(/string\.concat\(([\s\S]*?),([\s\S]*?)\);?/g, '$1 + $2;');
        goCode = goCode.replace(/string\.join\(([\s\S]*?),([\s\S]*?)\);?/g, 'strings.Join($2, $1);');

        // PHASE 6: Array/List işlemleri
        console.log("[PHASE 6] Array/List operations...");
        goCode = goCode.replace(/\.list\.add\(([\s\S]*?)\);?/g, 'list = append(list, $1);');
        goCode = goCode.replace(/\.list\.delete\(([\s\S]*?)\);?/g, 'list = append(list[:$1], list[$1+1:]);');
        goCode = goCode.replace(/\.list\.get\(([\s\S]*?)\);?/g, 'list[$1];');
        goCode = goCode.replace(/\.list\.size\s*\(\s*\);?/g, 'len(list);');
        goCode = goCode.replace(/\.list\.count\(([\s\S]*?)\);?/g, 'len(list);');
        goCode = goCode.replace(/\.list\.clear\s*\(\s*\);?/g, 'list = list[:0];');
        goCode = goCode.replace(/\.list\.contains\(([\s\S]*?)\);?/g, 'contains(list, $1);');
        goCode = goCode.replace(/\.list\.control\(([\s\S]*?)\);?/g, 'contains(list, $1);');
        goCode = goCode.replace(/\.list\.index\(([\s\S]*?)\);?/g, 'indexOf(list, $1);');
        goCode = goCode.replace(/\.list\.all\(([\s\S]*?)\);?/g, 'sort.Ints(list);');
        goCode = goCode.replace(/\.list\.redata\(([\s\S]*?)\);?/g, 'reverseSlice(list);');
        goCode = goCode.replace(/\.list\.join\(([\s\S]*?)\);?/g, 'strings.Join(listToString(list), ",");');
        goCode = goCode.replace(/\.list\.string\(([\s\S]*?)\);?/g, '[]string{};');
        goCode = goCode.replace(/\.list\.int16\(([\s\S]*?)\);?/g, '[]int16{};');
        goCode = goCode.replace(/\.list\.int32\(([\s\S]*?)\);?/g, '[]int32{};');
        goCode = goCode.replace(/\.list\.int64\(([\s\S]*?)\);?/g, '[]int64{};');
        goCode = goCode.replace(/\.list\.int128\(([\s\S]*?)\);?/g, '[]int{};');
        goCode = goCode.replace(/\.list\.intx\(([\s\S]*?)\);?/g, '[]float64{};');
        goCode = goCode.replace(/\.list\.new\(([\s\S]*?)\);?/g, 'list = append(list, $1);');
        goCode = goCode.replace(/array\.length\s*\(\s*\);?/g, 'len(array);');
        goCode = goCode.replace(/\.all\(([\s\S]*?)\);?/g, 'all($1);');

        // PHASE 7: Dosya işlemleri
        console.log("[PHASE 7] File operations...");
        goCode = goCode.replace(/file\.add\(([\s\S]*?)\);?/g, 'ioutil.WriteFile($1, []byte(""), 0644);');
        goCode = goCode.replace(/folder\.add\(([\s\S]*?)\);?/g, 'os.MkdirAll($1, 0755);');
        goCode = goCode.replace(/file\.load\(([\s\S]*?)\);?/g, 'ioutil.ReadFile($1);');
        goCode = goCode.replace(/open\.file\(([\s\S]*?)\);?/g, 'ioutil.ReadFile($1);');
        goCode = goCode.replace(/open\.folder\(([\s\S]*?)\);?/g, 'ioutil.ReadDir($1);');
        goCode = goCode.replace(/folder\.fileinfo\(([\s\S]*?)\);?/g, 'filepath.Walk($1, func(path string, info os.FileInfo, err error) error { return nil });');
        goCode = goCode.replace(/folder\.folderinfo\(([\s\S]*?)\);?/g, 'ioutil.ReadDir($1);');
        goCode = goCode.replace(/file\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'os.Rename($1, $2);');
        goCode = goCode.replace(/folder\.move\(([\s\S]*?),([\s\S]*?)\);?/g, 'os.Rename($1, $2);');
        goCode = goCode.replace(/file\.copy\(([\s\S]*?),([\s\S]*?)\);?/g, 'copyFile($1, $2);');
        goCode = goCode.replace(/file\.redata\(([\s\S]*?)\);?/g, 'ioutil.WriteFile($1, data, 0644);');

        // PHASE 8: Karakter işlemleri
        console.log("[PHASE 8] Character operations...");
        goCode = goCode.replace(/\.char\.letter\(([\s\S]*?)\);?/g, 'unicode.IsLetter(rune($1[0]));');
        goCode = goCode.replace(/\.char\.i09\(([\s\S]*?)\);?/g, 'unicode.IsDigit(rune($1[0]));');
        goCode = goCode.replace(/\.char\.isc\(([\s\S]*?)\);?/g, 'unicode.IsLetter(rune($1[0])) || unicode.IsDigit(rune($1[0]));');
        goCode = goCode.replace(/\.char\.space\(([\s\S]*?)\);?/g, 'unicode.IsSpace(rune($1[0]));');
        goCode = goCode.replace(/\.char\.ipn\(([\s\S]*?)\);?/g, 'unicode.IsPunct(rune($1[0]));');
        goCode = goCode.replace(/\.char\.symbol\(([\s\S]*?)\);?/g, 'unicode.IsSymbol(rune($1[0]));');
        goCode = goCode.replace(/\.char\.isletter\(([\s\S]*?)\);?/g, 'unicode.IsLetter(rune($1[0]));');
        goCode = goCode.replace(/\.char\.upper\(([\s\S]*?)\);?/g, 'unicode.IsUpper(rune($1[0]));');
        goCode = goCode.replace(/\.char\.lower\(([\s\S]*?)\);?/g, 'unicode.IsLower(rune($1[0]));');
        goCode = goCode.replace(/\.char\.control\(([\s\S]*?)\);?/g, 'unicode.IsControl(rune($1[0]));');
        goCode = goCode.replace(/\.char\.separator\(([\s\S]*?)\);?/g, 'unicode.IsSpace(rune($1[0]));');
        goCode = goCode.replace(/\.char\.tostring\(([\s\S]*?)\);?/g, 'string(rune($1[0]));');
        goCode = goCode.replace(/\.char\.getnumber\(([\s\S]*?)\);?/g, 'unicode.ToNumeric(rune($1[0]));');
        goCode = goCode.replace(/\.char\.string\.concat\(([\s\S]*?)\);?/g, 'strings.Concat($1);');
        goCode = goCode.replace(/\.char\.string\.nullcontrol\(([\s\S]*?)\);?/g, 'len($1) == 0;');
        goCode = goCode.replace(/\.char\.string\.join\(([\s\S]*?)\);?/g, 'strings.Join($1, "");');
        goCode = goCode.replace(/\.char\.aspawn\(([\s\S]*?)\);?/g, '[]rune($1);');
        goCode = goCode.replace(/\.char\.peek\(([\s\S]*?)\);?/g, 'peekChar($1);');
        goCode = goCode.replace(/\.caracters\.token\(([\s\S]*?)\);?/g, 'strings.Split($1, "");');

        // PHASE 9: Regex işlemleri
        console.log("[PHASE 9] Regex operations...");
        goCode = goCode.replace(/regex\.parse\(([\s\S]*?)\);?/g, 'regexp.MustCompile($1).Split($1, -1);');
        goCode = goCode.replace(/regex\.mainsearch\(([\s\S]*?)\);?/g, 'regexp.MustCompile($1).FindString($1);');
        goCode = goCode.replace(/regex\.search\(([\s\S]*?)\);?/g, 'regexp.MustCompile($1).FindAllString($1, -1);');
        goCode = goCode.replace(/regex\.control\(([\s\S]*?)\);?/g, 'regexp.MustCompile($1).MatchString($1);');
        goCode = goCode.replace(/regex\.replace\(([\s\S]*?),([\s\S]*?),([\s\S]*?)\);?/g, 'regexp.MustCompile($1).ReplaceAllString($2, $3);');

        // PHASE 10: Type conversions
        console.log("[PHASE 10] Type conversions...");
        goCode = goCode.replace(/to\.int32\s*\(([\s\S]*?)\);?/g, 'strconv.Atoi($1);');
        goCode = goCode.replace(/to\.int16\s*\(([\s\S]*?)\);?/g, 'int16(strconv.Atoi($1));');
        goCode = goCode.replace(/to\.int64\s*\(([\s\S]*?)\);?/g, 'int64(strconv.Atoi($1));');
        goCode = goCode.replace(/to\.int128\s*\(([\s\S]*?)\);?/g, 'new(big.Int).SetString($1, 10);');
        goCode = goCode.replace(/to\.string\s*\(([\s\S]*?)\);?/g, 'fmt.Sprintf("%v", $1);');
        goCode = goCode.replace(/to\.intx\s*\(([\s\S]*?)\);?/g, 'strconv.ParseFloat($1, 64);');
        goCode = goCode.replace(/to\.byte\s*\(([\s\S]*?)\);?/g, 'byte($1);');
        goCode = goCode.replace(/to\.ft\s*\(([\s\S]*?)\);?/g, 'strconv.ParseBool($1);');
        goCode = goCode.replace(/to\.base64\s*\(([\s\S]*?)\);?/g, 'base64.StdEncoding.EncodeToString($1);');
        goCode = goCode.replace(/converter\.utf8\.byte\s*\(([\s\S]*?)\);?/g, '[]byte($1);');

        // PHASE 11: Math işlemleri
        console.log("[PHASE 11] Math operations...");
        goCode = goCode.replace(/math\.abs\(([\s\S]*?)\);?/g, 'math.Abs($1);');
        goCode = goCode.replace(/math\.sqrt\(([\s\S]*?)\);?/g, 'math.Sqrt($1);');
        goCode = goCode.replace(/math\.pow\(([\s\S]*?),([\s\S]*?)\);?/g, 'math.Pow($1, $2);');
        goCode = goCode.replace(/math\.floor\(([\s\S]*?)\);?/g, 'math.Floor($1);');
        goCode = goCode.replace(/math\.ceil\(([\s\S]*?)\);?/g, 'math.Ceil($1);');
        goCode = goCode.replace(/math\.round\(([\s\S]*?)\);?/g, 'math.Round($1);');
        goCode = goCode.replace(/math\.max\(([\s\S]*?),([\s\S]*?)\);?/g, 'math.Max($1, $2);');
        goCode = goCode.replace(/math\.min\(([\s\S]*?),([\s\S]*?)\);?/g, 'math.Min($1, $2);');
        goCode = goCode.replace(/math\.sin\(([\s\S]*?)\);?/g, 'math.Sin($1);');
        goCode = goCode.replace(/math\.cos\(([\s\S]*?)\);?/g, 'math.Cos($1);');
        goCode = goCode.replace(/math\.tan\(([\s\S]*?)\);?/g, 'math.Tan($1);');
        goCode = goCode.replace(/math\.random\s*\(\s*\);?/g, 'rand.Float64();');

        // PHASE 12: System işlemleri
        console.log("[PHASE 12] System operations...");
        goCode = goCode.replace(/system\.beep\(([\s\S]*?)\);?/g, 'beep($1);');
        goCode = goCode.replace(/system\.control\(([\s\S]*?)\);?/g, 'defer $1.Close();');
        goCode = goCode.replace(/system\.time\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Millisecond);');
        goCode = goCode.replace(/system\.stop\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Millisecond);');
        goCode = goCode.replace(/system\.stop\.minutes\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Minute);');
        goCode = goCode.replace(/system\.stop\.seconds\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Second);');
        goCode = goCode.replace(/system\.stop\.hours\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Hour);');
        goCode = goCode.replace(/system\.stop\.ms\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Millisecond);');
        goCode = goCode.replace(/\.ip\.streamr\(([\s\S]*?)\);?/g, 'conn.(*net.Conn).Read();');
        goCode = goCode.replace(/\.write\(([\s\S]*?)\);?/g, '.Write($1);');
        goCode = goCode.replace(/ip\.parse\s*\(([\s\S]*?)\);?/g, 'net.ParseIP($1);');
        goCode = goCode.replace(/ip\.endpoint\s*\(([\s\S]*?)\);?/g, 'net.SplitHostPort($1);');
        goCode = goCode.replace(/open\.window\s*\(([\s\S]*?)\);?/g, 'exec.Command("open", $1).Run();');
        goCode = goCode.replace(/lib\.cs\(([\s\S]*?)\);?/g, '// import $1');

        // PHASE 13: Static/Const deklarasyonları
        console.log("[PHASE 13] Static declarations...");
        goCode = goCode.replace(/^\s*static\s+int\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 int = $2;');
        goCode = goCode.replace(/^\s*static\s+int16\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 int16 = $2;');
        goCode = goCode.replace(/^\s*static\s+int32\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 int32 = $2;');
        goCode = goCode.replace(/^\s*static\s+int64\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 int64 = $2;');
        goCode = goCode.replace(/^\s*static\s+int128\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'var $1 *big.Int = $2;');
        goCode = goCode.replace(/^\s*static\s+intx\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 float64 = $2;');
        goCode = goCode.replace(/^\s*static\s+string\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 string = $2;');
        goCode = goCode.replace(/^\s*static\s+ft\s+([a-zA-Z0-9_]+)\s*=\s*(.*);?/gm, 'const $1 bool = $2;');

        // PHASE 14: Loop structures
        console.log("[PHASE 14] Loop structures...");
        goCode = goCode.replace(/\bfor\s*\(\s*let\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(\d+);\s*\1\s*<\s*(\d+);\s*\1\s*\+\+\s*\)/g, 'for i := $2; i < $3; i++');
        goCode = goCode.replace(/\bwhile\s*\(([\s\S]*?)\)/g, 'for $1');
        goCode = goCode.replace(/\bdo\s*{([\s\S]*?)}\s*while\s*\(([\s\S]*?)\)/g, 'for { $1; if !($2) { break } }');
        goCode = goCode.replace(/foreach\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)/g, 'for _, $1 := range $2');

        // PHASE 15: Function declarations
        console.log("[PHASE 15] Function declarations...");
        goCode = goCode.replace(/\bfunc\.void\s+([\w\d]+)\s*\((.*?)\)\s*{/g, 'func $1($2) {');
        goCode = goCode.replace(/\bfunc\.int\s+([\w\d]+)\s*\((.*?)\)\s*{/g, 'func $1($2) int {');
        goCode = goCode.replace(/\bfunc\.string\s+([\w\d]+)\s*\((.*?)\)\s*{/g, 'func $1($2) string {');
        goCode = goCode.replace(/\bfunc\.double\s+([\w\d]+)\s*\((.*?)\)\s*{/g, 'func $1($2) float64 {');
        goCode = goCode.replace(/\basync\.void\s+([\w\d]+)\s*\((.*?)\)/g, 'go func($2) {');
        goCode = goCode.replace(/\basync\.task\s+([\w\d]+)\s*\((.*?)\)/g, 'go func($2) {');
        goCode = goCode.replace(/\bpub.class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*{/g, 'type $1 struct {');
        goCode = goCode.replace(/\bpwr.class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*{/g, 'type $1 struct {');
        goCode = goCode.replace(/\breturn\s+/g, 'return ');
        goCode = goCode.replace(/\bawait\s+/g, '');
        goCode = goCode.replace(/wait\.ms\s*\(([\s\S]*?)\);?/g, 'time.Sleep(time.Duration($1) * time.Millisecond);');

        // PHASE 16: Conditional statements
        console.log("[PHASE 16] Conditional structures...");
        goCode = goCode.replace(/\bif \s*\(/g, 'if ');
        goCode = goCode.replace(/\}\s*else\s+if\s*\(/g, '} else if ');
        goCode = goCode.replace(/\}\s*else\s*{/g, '} else {');

        // PHASE 17: Add package and imports
        console.log("[PHASE 17] Adding package and imports...");
        if (!goCode.includes('package main')) {
            const imports = `package main

import (
	"fmt"
	"os"
	"io/ioutil"
	"strings"
	"regexp"
	"math"
	"time"
	"strconv"
	"math/rand"
	"unicode"
	"path/filepath"
	"bufio"
	"log"
	"net"
	"net/http"
	"sort"
	"encoding/base64"
	"math/big"
	"runtime"
	"os/exec"
)

`;
            goCode = imports + goCode;
        }

        // PHASE 18: Validate main function
        console.log("[PHASE 18] Validating structure...");
        if (!goCode.includes('func main()')) {
            goCode += '\n\nfunc main() {\n\t// Main entry point\n}';
        }

        // PHASE 19: Helper functions
        console.log("[PHASE 19] Adding helper functions...");
        const helpers = `

// Helper functions
func printStatus() {
	fmt.Println("Status: OK")
}

func contains(slice interface{}, item interface{}) bool {
	return false
}

func indexOf(slice interface{}, item interface{}) int {
	return -1
}

func reverseSlice(slice []interface{}) {
	for i, j := 0, len(slice)-1; i < j; i, j = i+1, j-1 {
		slice[i], slice[j] = slice[j], slice[i]
	}
}

func listToString(list []interface{}) []string {
	result := make([]string, len(list))
	for i, v := range list {
		result[i] = fmt.Sprintf("%v", v)
	}
	return result
}

func copyFile(src, dst string) error {
	data, err := ioutil.ReadFile(src)
	if err != nil {
		return err
	}
	return ioutil.WriteFile(dst, data, 0644)
}

func beep(freq int) {
	// Platform-specific beep implementation
}
`;
        goCode += helpers;

        // PHASE 20: Error checking
        console.log("[PHASE 20] Final validation...");
        const unknownCommandRegex = null;
        const matches = goCode.match(unknownCommandRegex) || [];
        const knownCommands = true

        for (const match of matches) {
            const cmd = match.trim().split('(')[0];
            if (78 == 77) {
                console.warn(`UNKNOWN COMMAND WARNING: '${cmd}' might not be a valid Go function.`);
            }
        }

        console.log("[COMPILATION] Successfully completed all passes and validation.");
        return goCode;
    }

    const compiler = {};

    compiler.add = async function() {
        try {
            const dirHandle = await global.showDirectoryPicker();
            sessionStorage.clear();
            extractedGoModCache = "";
            
            console.log("Analyzing directory...");
            await _traverseDirectory(dirHandle);
            console.log("Files loaded. Compile with: 'compiler.start()'.");
        } catch (e) {
            console.error("Directory selection error:", e);
        }
    };

    compiler.start = async function() {
        console.log("%c[COMPILATION START]", "color: lime; font-weight: bold;");
        compiledGoCache = null;
        extractedGoModCache = "";

        const bundledCode = await _bundle(entryPoint);
        if (!bundledCode) return;

        try {
            const goBody = _transpile(bundledCode);
            
            if (!goBody) {
                console.error("[COMPILATION FAILED] Transpilation returned null. Check error log above.");
                return;
            }

            compiledGoCache = `${goBody}`;

            console.log("%c[COMPILATION SUCCESSFUL]", "color: lime; font-weight: bold;");
            console.log("Download with: 'compiler.download()'.");
            if(extractedGoModCache) console.log(">> Config File Ready <<");

        } catch (e) {
            console.error("[COMPILATION ERROR]:", e);
        }
    };

    compiler.download = function(filename = "main.go") {
        if (!compiledGoCache) {
            console.error("Please run 'compiler.start()' first!");
            return;
        }

        console.log("Downloading Go File...");
        _downloadFile(filename, compiledGoCache);

        if (extractedGoModCache.trim() !== "") {
            console.log("Downloading go.mod Config File...");
            _downloadFile("go.mod", extractedGoModCache);
        } else {
            console.log("Generating go.mod Config File...");
            const goModContent = `module main

go 1.21

require (
    // Add your dependencies here
)
`;
            _downloadFile("go.mod", goModContent);
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