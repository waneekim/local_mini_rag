// ARK desktop shell: runs the existing Fastify server in-process and wraps the
// web UI in a tray-resident window. No browser, no terminal:
//   - system tray icon (click = show/hide, menu = open/quit)
//   - global hotkey (default Ctrl/Cmd+Shift+Space) toggles the chat window
//   - closing the window hides it to the tray; the server keeps running
//   - drag & drop files/folders works inside the window (existing web UI)
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, shell } = require("electron");
const path = require("node:path");

const HOTKEY = process.env.ARK_HOTKEY || "CommandOrControl+Shift+Space";
const PORT = Number(process.env.ARK_PORT || 8787);

// 22x22 tray icon (blue dot), embedded so no asset file is needed.
const TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAj0lEQVR42sWV0QnAIAxEu4NzuE9+3cMBMo+DuFJKQEoRjVp77cGBoDzkTOJx/CVi8cQSiCUW69rvABWQiUU61r2wAnTEkgxgbT3rZqB5AXq/vbPA6QH0urmVqWw6tMDdCGpZkbRKago6AffDGEYaxlEK/y1w/AQMiwLzeLBygzYIrKWhQwg2NqGDHv417eoEG2KjsiZm3jUAAAAASUVORK5CYII=";

let win = null;
let tray = null;
let server = null;
let serverUrl = "";
let quitting = false;

// Single instance: a second launch just reveals the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(boot).catch((error) => {
    console.error(error);
    app.quit();
  });
}

async function boot() {
  serverUrl = await startServer();
  createTray();
  createWindow();
  if (!globalShortcut.register(HOTKEY, toggleWindow)) {
    console.warn(`전역 단축키 등록 실패: ${HOTKEY} (다른 프로그램이 사용 중)`);
  }
}

// Boot the same Fastify app `npm start` runs, but bound to localhost with its
// data under the OS per-user app-data directory (safe for packaged installs).
async function startServer() {
  const { createApp } = await import("../src/app.js");
  server = await createApp({ dataDir: path.join(app.getPath("userData"), "data") });
  try {
    return await server.listen({ host: "127.0.0.1", port: PORT });
  } catch {
    return server.listen({ host: "127.0.0.1", port: 0 }); // port busy → any free port
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 420,
    minHeight: 560,
    show: true,
    autoHideMenuBar: true,
    title: "ARK",
    icon: nativeImage.createFromDataURL(TRAY_ICON)
  });
  win.loadURL(serverUrl);
  // Close = hide to tray (the app and server keep running).
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // External links (LM Studio, GitHub, …) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(serverUrl)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
  tray.setToolTip(`ARK — ${serverUrl} (${HOTKEY.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl")})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "ARK 열기 / 숨기기", click: toggleWindow },
      { label: `브라우저로 열기 (${serverUrl})`, click: () => shell.openExternal(serverUrl) },
      { type: "separator" },
      { label: "종료", click: () => quitApp() }
    ])
  );
  tray.on("click", toggleWindow); // Windows: single click toggles the window
}

function showWindow() {
  if (!win) return createWindow();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function quitApp() {
  quitting = true;
  app.quit();
}

app.on("window-all-closed", () => {
  // Stay resident in the tray on every platform; quit only via the tray menu.
});

app.on("activate", showWindow); // macOS dock click

app.on("will-quit", async (event) => {
  globalShortcut.unregisterAll();
  if (server) {
    event.preventDefault();
    const closing = server;
    server = null;
    await closing.close().catch(() => {});
    app.quit();
  }
});
