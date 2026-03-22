/**
 * Electron Main Process
 * Launches the Express server and opens a BrowserWindow.
 *
 * This file is CommonJS (.cjs) because Electron's main process does not
 * support ESM "type": "module" packages out of the box. It dynamically
 * imports the ESM server module via import().
 */

const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const net = require('net');

const DEFAULT_PORT = 8081;

// Keep references so they aren't garbage-collected
let mainWindow = null;
let tray = null;
let serverInstance = null;
let actualPort = DEFAULT_PORT;

// ─── Port helpers ───────────────────────────────────────────────────────────

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(); resolve(true); });
        srv.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(start, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        if (await isPortAvailable(start + i)) return start + i;
    }
    throw new Error(`No available port found (tried ${start}–${start + attempts - 1})`);
}

// ─── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: 'ProxyPool Hub',
        icon: getIconPath(),
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    mainWindow.loadURL(`http://127.0.0.1:${actualPort}`);

    // Open external links in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('close', (e) => {
        // Minimise to tray instead of quitting
        if (tray && !app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
    const iconPath = getIconPath();
    if (!iconPath) return;

    try {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Open ProxyPool Hub', click: () => { if (mainWindow) mainWindow.show(); } },
            { type: 'separator' },
            { label: `Port: ${actualPort}`, enabled: false },
            { type: 'separator' },
            {
                label: 'Quit', click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            },
        ]);
        tray.setToolTip('ProxyPool Hub');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
    } catch {
        // Tray icon is optional — silently ignore if it fails
    }
}

function getIconPath() {
    // Try common icon locations
    const candidates = [
        path.join(__dirname, 'build', 'icon.ico'),
        path.join(__dirname, 'build', 'icon.png'),
        path.join(__dirname, 'public', 'favicon.ico'),
        path.join(__dirname, 'images', 'icon.png'),
    ];
    const fs = require('fs');
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    try {
        // Find an available port
        const preferred = Number(process.env.PORT) || DEFAULT_PORT;
        actualPort = await findAvailablePort(preferred);

        // Dynamically import the ESM server module
        const { createServer } = await import('./src/server.js');
        const expressApp = createServer({ port: actualPort });

        serverInstance = expressApp.listen(actualPort, '127.0.0.1', () => {
            console.log(`ProxyPool Hub running on http://127.0.0.1:${actualPort}`);
        });

        createWindow();
        createTray();
    } catch (err) {
        dialog.showErrorBox('Startup Error', `Failed to start ProxyPool Hub:\n\n${err.message}`);
        app.quit();
    }
});

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
    if (mainWindow === null) createWindow();
    else mainWindow.show();
});

app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverInstance) {
        try { serverInstance.close(); } catch { /* ignore */ }
    }
});

// Quit when all windows are closed (except macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.isQuitting = true;
        app.quit();
    }
});
