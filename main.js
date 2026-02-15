const { app, BrowserWindow, Menu, globalShortcut, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
const iconName = isWindows ? 'icon.ico' : 'icon.png';
const iconPath = path.join(__dirname, iconName);

let mainWindow;

// Tekil örnek kilidi (Aynı anda iki tane uygulama açılmasını engeller)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      handleArgs(commandLine);
    }
  });

  app.whenReady().then(createWindow);
}

function handleArgs(args) {
  const filePath = args.find(arg => arg.endsWith('.csdf'));
  if (filePath && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Renderer hazır olana kadar bekleyip gönder
      mainWindow.webContents.send('run-csdf-script', content);
    } catch (err) {
      console.error("Dosya okunamadı:", err);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    frame: true,
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith('file://') || url.startsWith('devtools://')) {
      callback({ cancel: false });
    } else {
      callback({ cancel: true });
    }
  });

  mainWindow.webContents.once('dom-ready', () => {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    handleArgs(process.argv);
  });

  globalShortcut.register('F12', () => {
    mainWindow.webContents.toggleDevTools();
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});