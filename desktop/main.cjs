// STL Mesh Editor – Windows (desktop) app.
//
// The built web app (app/) is served from a small local web server, together
// with the optional AI endpoint (server/ai.js), and shown in its own window.
// Nothing is installed: the portable .exe unpacks to a temp folder and runs.

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

// The Anthropic API key for "Ask AI" (optional): ANTHROPIC_API_KEY in the
// environment, or a .env file next to the .exe (or in the app's data folder)
// with a line ANTHROPIC_API_KEY=sk-ant-...
function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, path.dirname(process.execPath), app.getPath('userData')].filter(Boolean);
  for (const dir of dirs) {
    try {
      const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
      const m = text.match(/^\s*ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s]+)/m);
      if (m) return m[1];
    } catch {}
  }
  return undefined;
}

function serve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/ai/')) {
    import(pathToFileURL(path.join(__dirname, 'server', 'ai.js')).href)
      .then(({ aiMiddleware }) => aiMiddleware(apiKey)(req, res, () => {
        res.statusCode = 404;
        res.end();
      }))
      .catch((err) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'AI support failed to load: ' + err.message }));
      });
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
        {
          label: 'Ask AI setup…',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Ask AI',
              message: 'To use "Ask AI", put a file named .env next to the .exe containing:',
              detail: 'ANTHROPIC_API_KEY=sk-ant-...\n\nThen restart the app. Everything else works without it.',
            }),
        },
      ],
    },
  ]),
);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
