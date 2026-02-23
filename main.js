const { app, BrowserWindow, Menu, globalShortcut, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// SSL Sertifika hatalarını ve kısıtlamaları tamamen baypas eder
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const isWindows = process.platform === 'win32';
const iconName = isWindows ? 'icon.ico' : 'icon.png';
const iconPath = path.join(__dirname, iconName);

let mainWindow;

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
      nodeIntegration: true,      // Node.js yetkilerini açar
      contextIsolation: false,    // Renderer ve Main arası engeli kaldırır
      sandbox: false,             // Kum havuzunu kapatır
      webSecurity: false,         // CORS ve dış bağlantı engellerini kaldırır
      devTools: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');

  // ÖNEMLİ: Kodundaki tüm dış URL isteklerini engelleyen filtreyi kaldırdım.
  // Artık fetch/install işlemleri özgürce çalışabilir.

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