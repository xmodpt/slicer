// STL Mesh Editor – Windows (desktop) app.
//
// The built web app (app/) is served from a small local web server and shown
// in its own window.
// Nothing is installed: the portable .exe unpacks to a temp folder and runs.

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Without a usable graphics card (virtual machines, blocked drivers) fall back
// to software WebGL instead of failing to show the 3D view.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const ROOT = path.join(__dirname, 'app');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

// Files to open (double-clicked .stl files), served once by token.
const openFiles = new Map();
let pendingFiles = [];

function serve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__open/')) {
    const file = openFiles.get(url.pathname.slice(8));
    if (!file) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(file).on('error', () => res.end()).pipe(res);
    return;
  }
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(serve);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

let mainWindow = null;
let pageReady = false;

const stlArgs = (argv) => argv.slice(1).filter((a) => /\.stl$/i.test(a) && fs.existsSync(a));

// Opens an .stl file in the window (once the page has started).
function openPath(file) {
  if (!mainWindow || !pageReady) {
    pendingFiles.push(file);
    return;
  }
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  openFiles.set(token, file);
  mainWindow.webContents.executeJavaScript(`window.openFromUrl('/__open/${token}', ${JSON.stringify(path.basename(file))})`).catch(() => {});
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function createWindow() {
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: `STL Mesh Editor ${app.getVersion()}`,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  mainWindow = win;
  win.maximize();
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.webContents.on('did-finish-load', async () => {
    // Wait until the app has started, then open any files it was given.
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('!!window.__appStarted').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    pageReady = true;
    const files = pendingFiles;
    pendingFiles = [];
    for (const f of files.slice(-1)) openPath(f); // one model at a time
  });
  win.on('closed', () => {
    mainWindow = null;
    pageReady = false;
  });
  // Keep the version in the title (the page sets its own).
  win.on('page-title-updated', (e) => e.preventDefault());

  // The page asks before closing with unsaved changes – show that question.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'The model has changes that were not exported. Close anyway?',
    });
    if (choice === 0) e.preventDefault();
  });

  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About STL Mesh Editor',
          click: () => mainWindow?.webContents.executeJavaScript('window.showAbout && window.showAbout()'),
        },
      ],
    },
  ]),
);

// One window: opening another .stl (double-click) goes to the running app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingFiles = stlArgs(process.argv);
  app.on('second-instance', (_e, argv) => {
    const files = stlArgs(argv);
    if (files.length) openPath(files[files.length - 1]);
    else if (mainWindow) mainWindow.focus();
  });
  // macOS sends files through this event (also before the app is ready).
  app.on('open-file', (e, file) => {
    e.preventDefault();
    openPath(file);
  });
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
