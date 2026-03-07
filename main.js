const { app, BrowserWindow, Menu, globalShortcut, session, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const isWindows = process.platform === 'win32';
const iconName = isWindows ? 'icon.ico' : 'icon.png';
const iconPath = path.join(__dirname, iconName);

let mainWindow;

// Argümanları yakala
const getArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2);

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

function handleArgs(argv) {
  const currentArgs = getArgs(argv);
  const filePath = currentArgs.find(arg => arg.endsWith('.csdf'));

  if (filePath && fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      mainWindow.webContents.send('run-csdf-script', content);
    } catch (err) {
      console.error("Dosya okuma hatası:", err);
    }
  } else if (currentArgs.length > 0) {
    mainWindow.webContents.send('run-cli-command', currentArgs.join(' '));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    show: true, 
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      devTools: true
    }
  });

  // Güvenlik ve İzinler
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');

  mainWindow.webContents.once('dom-ready', () => {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    handleArgs(process.argv);
  });

  globalShortcut.register('F12', () => {
    mainWindow.webContents.toggleDevTools();
  });
}

// --- GÜVENLİK HATASINI ÖNLEYEN DİALOG HANDLER ---
ipcMain.handle('dialog:openDirectory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Klasör Seç',
    properties: ['openDirectory', 'createDirectory']
  });
  
  if (canceled) return null;
  return filePaths[0]; 
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});