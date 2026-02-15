const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
let isRunning = false;

global.system = {
    run: {
        bat: function(code) {
            if (isRunning) return; 
            if (os.platform() !== 'win32') return console.log("Hata: Windows değil.");

            isRunning = true;
            const tempPath = path.join(os.tmpdir(), 'constlang_run.bat');
            const finalScript = `@echo off\n${code}\n\npause`;
            
            fs.writeFileSync(tempPath, finalScript);
            exec(`start /wait cmd /C "${tempPath}"`, () => {
                isRunning = false; 
            });
            setTimeout(() => { isRunning = false; }, 2000);
        },

        sh: function(code) {
            if (isRunning) return;
            if (os.platform() !== 'linux') return;

            isRunning = true;
            const tempPath = path.join(os.tmpdir(), 'constlang_run.sh');
            const finalScript = `#!/bin/bash\n${code}\nread -p ""`;
            
            fs.writeFileSync(tempPath, finalScript);
            exec(`chmod +x "${tempPath}"`);
            
            exec(`x-terminal-emulator -e "/bin/bash ${tempPath}"`, () => {
                isRunning = false;
            });
            setTimeout(() => { isRunning = false; }, 2000);
        },

        command: function(code) {
            if (isRunning) return;
            if (os.platform() !== 'darwin') return;

            isRunning = true;
            const tempPath = path.join(os.tmpdir(), 'constlang_run.command');
            const finalScript = `#!/bin/zsh\n${code}\nread -p ""`;
            
            fs.writeFileSync(tempPath, finalScript);
            exec(`chmod +x "${tempPath}"`);
            
            exec(`open -a Terminal "${tempPath}"`, () => {
                isRunning = false;
            });
            setTimeout(() => { isRunning = false; }, 1000);
        }
    }
};