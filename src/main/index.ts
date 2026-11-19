import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AuroraStore, DEFAULT_SETTINGS, getStore, setDataDir } from '../core/store/index.js';
import { memberAction, startMemberSessionMaintenance } from './member.js';
import { describeClientLifecycle, restartClient } from './clientLifecycle.js';
import { selectClientDesktop } from './clientDesktopSelection.js';
import { runtimeFor } from '../core/extensions/runtime.js';
import { syncLocalClients } from '../core/localClients.js';
import { getCoexistCatalog, isCodexCoexistConfigured } from '../core/gateway/coexist.js';
import { GatewayServer, resetGateway } from '../core/gateway/server.js';
import { runAction, type ActionDeps } from '../core/actions.js';
import type { UsageRecord } from '../core/store/types.js';
import { onDetectionUpdated } from '../core/agents/detectionAsync.js';

const DEV = process.env.AURORA_DEV === '1' && !app.isPackaged;
const UI_URL = process.env.AURORA_UI_URL || 'http://localhost:5199';
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let gateway: GatewayServer | null = null;
let store: AuroraStore = getStore();
let gatewayError = '';
let quitting = false;
let gatewayChange: Promise<void> | null = null;
let clientScanTimer: ReturnType<typeof setInterval> | undefined;
let stopDetectionUpdates: (() => void) | undefined;
let stopMemberSessionMaintenance: (() => void) | undefined;
let localClientWarnings: string[] = [];
const recent: UsageRecord[] = [];
const uiFile = path.join(__dirname, '..', 'ui', 'index.html');

// Settings migration belongs to startup/save; diagnostic getters must not write it back.
function gatewayUrl() { const s = { ...DEFAULT_SETTINGS(), ...store.settings.read() }; const host = s.gatewayHost === '0.0.0.0' || s.gatewayHost === '::' ? '127.0.0.1' : s.gatewayHost; return `http://${host.includes(':') ? `[${host}]` : host}:${s.gatewayPort}`; }
function status() { return { ...(gateway?.getStatus() || { running: false, host: '127.0.0.1', port: store.settings.read().gatewayPort ?? DEFAULT_SETTINGS().gatewayPort, requests: 0, errors: 0 }), ...(gatewayError ? { lastError: gatewayError } : {}) }; }
function refreshLocalClients(force = false) {
  localClientWarnings = [];
  try {
    syncLocalClients(store, { force, gatewayUrl: gatewayUrl() });
  } catch { localClientWarnings.push('自动读取本地配置未完成，请检查数据目录的空间和写入权限。当前显示上次扫描结果，可在“我的供应商”重试。'); }
  try {
    if (isCodexCoexistConfigured(store)) {
      const catalog = getCoexistCatalog(store).nativeCatalog;
      if (JSON.stringify(catalog) !== JSON.stringify(store.readExtra('codex-model-catalog.json', null))) store.writeExtra('codex-model-catalog.json', catalog);
    }
  } catch { localClientWarnings.push('共存模型目录更新未完成，请检查数据目录的空间和写入权限；上次目录仍保留。'); }
  try { refreshTray(); } catch { /* Existing window can still display the actionable scan warning. */ }
  if (win && !win.isDestroyed()) win.webContents.send('aurora:gateway', status());
}
function deps(): ActionDeps { return { store, dataDir: store.dir, gatewayStatus: status, gatewayUrl, restartGateway: ensureGateway, resetCooldowns: () => gateway?.router.resetCooldowns(), platform: process.platform, version: app.getVersion(), localClientWarnings }; }
async function ensureGateway(): Promise<void> {
  const pending = gatewayChange || Promise.resolve();
  const change = pending.catch(() => {}).then(async () => {
    const settings = store.getSettings();
    if (gateway) await gateway.stop();
    resetGateway(); gatewayError = '';
    gateway = new GatewayServer({ store, uiDir: path.join(__dirname, '..', 'ui'),
      actions: async (action, payload) => {
        const result = await runAction({ ...deps(), platform: 'web' }, action, payload);
        return result === null ? { error: '此操作需要在桌面端完成' } : result;
      },
      onRequest: record => { recent.unshift(record); if (recent.length > 500) recent.pop(); if (win && !win.isDestroyed()) win.webContents.send('aurora:usage', record); },
      onStatus: state => { if (win && !win.isDestroyed()) win.webContents.send('aurora:gateway', state); },
    });
    try { await gateway.start(settings.gatewayHost, settings.gatewayPort); }
    catch (e: any) { gatewayError = e.code === 'EADDRINUSE' ? `端口 ${settings.gatewayPort} 已被占用，请在系统设置中更换端口。` : String(e.message || e); throw new Error(gatewayError); }
    finally { refreshTray(); if (win && !win.isDestroyed()) win.webContents.send('aurora:gateway', status()); }
  });
  gatewayChange = change;
  try { await change; } finally { if (gatewayChange === change) gatewayChange = null; }
}
function allowedExternal(raw: string) { const u = new URL(raw); if (!['https:', 'http:', 'ms-windows-store:'].includes(u.protocol) || u.username || u.password) throw new Error('不支持的外部链接'); return u.href; }
function trustedFrame(raw?: string) {
  if (!raw) return false;
  try { const u = new URL(raw); const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); return DEV ? u.origin === new URL(UI_URL).origin : u.protocol === 'file:' && normalize(fileURLToPath(u)) === normalize(uiFile); } catch { return false; }
}
function createWindow() {
  const theme = store.getSettings().theme;
  const backgroundColor = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors) ? '#131720' : '#f7f8fc';
  win = new BrowserWindow({ width: 1380, height: 930, minWidth: 900, minHeight: 640, backgroundColor, show: false, frame: process.platform === 'darwin',
    title: '云汇 AI · yunhui.me', titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden', ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 20 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: process.env.AURORA_UI_TEST === '1' && !app.isPackaged, backgroundThrottling: false },
  });
  if (DEV) void win.loadURL(UI_URL);
  else void win.loadFile(uiFile, { hash: process.env.AURORA_PAGE || 'agents' });
  win.webContents.setWindowOpenHandler(({ url }) => { try { void shell.openExternal(allowedExternal(url)); } catch {} return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!trustedFrame(url)) { event.preventDefault(); try { void shell.openExternal(allowedExternal(url)); } catch {} } });
  win.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  win.once('ready-to-show', () => {
    if (process.env.AURORA_UI_TEST !== '1' || app.isPackaged) win?.show();
    if (!app.isPackaged && process.env.AURORA_SHOT) setTimeout(async () => { try { fs.writeFileSync(process.env.AURORA_SHOT!, (await win!.webContents.capturePage()).toPNG()); } catch {} app.quit(); }, Number(process.env.AURORA_SHOT_DELAY || 3500));
  });
  win.on('close', event => { if (store.getSettings().closeToTray && !quitting) { event.preventDefault(); win?.hide(); } else if (!quitting && process.platform !== 'darwin') app.quit(); });
  win.on('closed', () => { win = null; });
  win.on('focus', () => refreshLocalClients());
}
function showWindow() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
function createTray() {
  const mac = process.platform === 'darwin';
  const iconRoot = DEV ? path.join(app.getAppPath(), 'ui', 'public') : path.join(__dirname, '..', 'ui');
  const icon = nativeImage.createFromPath(path.join(iconRoot, mac ? 'trayTemplate.png' : 'tray.png')).resize({ width: mac ? 18 : 20, height: mac ? 18 : 20 });
  if (mac) icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip('云汇 AI · yunhui.me'); tray.on('double-click', showWindow); refreshTray();
}
function createApplicationMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '云汇 AI', submenu: [{ role: 'about', label: '关于云汇 AI' }, { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' }, { role: 'hide', label: '隐藏云汇 AI' }, { role: 'hideOthers', label: '隐藏其他应用' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出云汇 AI' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '切换全屏' }] },
    { role: 'windowMenu', label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'close', label: '关闭窗口' }, { type: 'separator' }, { label: '打开云汇 AI', click: showWindow }, { role: 'front', label: '全部前置' }] },
  ]));
}
function refreshTray() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '打开云汇 AI', click: showWindow },
    { label: status().running ? '网关运行中' : '启动网关', enabled: !status().running, click: () => { void ensureGateway().catch(() => showWindow()); } },
    { type: 'separator' },
    ...store.listProviders().filter(p => p.enabled).slice(0, 12).map(p => ({ label: p.name, submenu: [
      { label: '在 Claude Code 中使用', click: () => { void trayConnect('claude-code', p.id, p.models[0]?.id || ''); } },
      { label: '在 Codex 中使用', click: () => { void trayConnect('codex-cli', p.id, p.models[0]?.id || ''); } },
    ] })),
    { type: 'separator' }, { label: '退出', click: () => app.quit() },
  ]));
}
async function trayConnect(agentId: string, providerId: string, model: string) {
  try {
    const states = store.listAgents();
    const previous = states[agentId] || (agentId === 'codex-cli' ? states['chatgpt-desktop'] || states['codex-desktop'] : undefined);
    const retained = previous?.connected || previous?.pendingReapply ? previous : undefined;
    const authMode = retained?.authMode || 'api';
    const permissionMode = retained?.permissionMode || 'preserve', skipOnboarding = retained?.skipOnboarding === true;
    const result = await runAction(deps(), 'agent.connect', { agentId, providerId, model, mode: 'gateway', authMode, permissionMode, skipOnboarding });
    if (!result?.ok) throw new Error(result?.message || '接入失败');
  }
  catch (e: any) { dialog.showErrorBox('客户端配置失败', e.message); }
}
function applyLoginItem(enable: boolean) {
  // Isolated acceptance profiles must not change the real Windows/macOS login item.
  if (process.env.YUNHUI_TEST_ISOLATED === '1' && process.env.AURORA_CLIENT_HOME && (process.env.AURORA_HOME || process.env.YUNHUI_HOME)) return;
  try { app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: false }); } catch {}
}
async function handleAction(action: string, payload: any) {
  if (action.startsWith('member.')) return memberAction(store, action, payload);
  const shared = await runAction(deps(), action, payload);
  if (shared !== null) {
    if (action === 'settings.save') applyLoginItem(store.getSettings().launchAtLogin);
    if (['settings.save', 'provider.save', 'provider.delete', 'agent.connect', 'agent.disconnect'].includes(action)) refreshTray();
    if (['localClients.scan', 'localClients.restore'].includes(action) && shared.ok) refreshLocalClients();
    return shared;
  }
  switch (action) {
    case 'agent.desktop.select': return selectClientDesktop(store, payload, {
      platform: process.platform, ownExecutable: process.execPath,
      choose: options => win && !win.isDestroyed() ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options), disconnect: () => runtimeFor(store).disconnect(),
    });
    case 'agent.lifecycle': return describeClientLifecycle(payload);
    case 'agent.restart': {
      const reconnect = ['chatgpt-desktop', 'codex-desktop'].includes(payload?.agentId) && !!runtimeFor(store).cdp?.connected;
      const result = await restartClient(payload);
      if (result.ok && reconnect) result.message += ' 如使用桌面增强，请在增强页面重新连接。';
      return result;
    }
    case 'gateway.start': await ensureGateway(); return status();
    case 'gateway.stop': await gateway?.stop(); refreshTray(); return status();
    case 'app.openExternal': await shell.openExternal(allowedExternal(String(payload.url))); return { ok: true };
    case 'app.openPath': { const error = await shell.openPath(String(payload.path)); return { ok: !error, message: error }; }
    case 'app.openDataDir': { const error = await shell.openPath(store.dir); return { ok: !error, message: error }; }
    case 'app.chooseImage': { const selected = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] }); return { ok: !selected.canceled, path: selected.filePaths[0] || '' }; }
    case 'app.isDev': return { dev: !app.isPackaged, root: app.getAppPath() };
    case 'app.gitUpdate': return gitUpdate();
    case 'app.export': {
      const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('documents'), `yunhui.me-backup-${Date.now()}.json`), filters: [{ name: '云汇 AI 配置备份（含密钥，请妥善保管）', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.writeFileSync(r.filePath, JSON.stringify(store.exportAll(), null, 2), { encoding: 'utf8', mode: 0o600 }); return { ok: true, path: r.filePath };
    }
    case 'app.import': {
      const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '云汇 AI 配置备份', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      if (fs.statSync(r.filePaths[0]).size > 16 * 1024 * 1024) throw new Error('配置备份过大');
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const confirm = await dialog.showMessageBox({ type: 'question', buttons: ['取消', '导入并替换'], defaultId: 0, cancelId: 0, message: '用备份中的配置替换当前配置？', detail: '当前配置会先备份到本地数据目录。' });
      if (confirm.response !== 1) return { ok: false };
      fs.writeFileSync(path.join(store.dir, `before-import-${Date.now()}.json`), JSON.stringify(store.exportAll(), null, 2), { mode: 0o600 });
      store.importAll(data); refreshLocalClients(true); await ensureGateway(); applyLoginItem(store.getSettings().launchAtLogin); return { ok: true, path: r.filePaths[0] };
    }
    case 'app.chooseDataDir': { const r = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (r.canceled || !r.filePaths[0]) return { ok: false }; setDataDir(r.filePaths[0]); store = getStore(); refreshLocalClients(true); await ensureGateway(); return { ok: true, dir: store.dir }; }
    case 'app.quit': app.quit(); return { ok: true };
    case 'window.minimize': win?.minimize(); return { ok: true };
    case 'window.maximize': if (win?.isMaximized()) win.unmaximize(); else win?.maximize(); return { ok: true };
    case 'window.close': win?.close(); return { ok: true };
    default: return { error: `未知操作：${action}` };
  }
}
async function gitUpdate() {
  const root = app.getAppPath();
  if (app.isPackaged || !fs.existsSync(path.join(root, '.git'))) return { ok: false, message: '当前为安装版或非 Git 工作目录，请下载新版安装包更新。' };
  try {
    for (const [cmd, args] of [['git', ['pull', '--ff-only']], ['pnpm', ['install', '--frozen-lockfile']], ['pnpm', ['run', 'build']]] as [string, string[]][]) {
      await new Promise<void>((resolve, reject) => { const p = spawn(cmd, args, { cwd: root, shell: process.platform === 'win32', windowsHide: true }); let output = ''; p.stdout.on('data', d => { output = (output + d).slice(-3000); }); p.stderr.on('data', d => { output = (output + d).slice(-3000); }); p.on('error', reject); p.on('close', code => code === 0 ? resolve() : reject(new Error(output || `退出码 ${code}`))); });
    }
    return { ok: true, message: '已更新并构建，请重启云汇 AI。' };
  } catch (e: any) { return { ok: false, message: e.message }; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    stopDetectionUpdates = onDetectionUpdated(() => {
      if (win && !win.isDestroyed()) win.webContents.send('aurora:gateway', status());
    });
    ipcMain.handle('aurora:invoke', async (event, req) => {
      if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame || !trustedFrame(event.senderFrame?.url)) return { error: '未经授权的界面请求' };
      try { if (!req || typeof req.action !== 'string') throw new Error('无效操作'); return await handleAction(req.action, req.payload || {}); } catch (e: any) { return { error: String(e.message || e) }; }
    });
    ipcMain.handle('aurora:recent', event => event.sender === win?.webContents && trustedFrame(event.senderFrame?.url) ? recent.slice(0, 100) : []);
    refreshLocalClients(true);
    createApplicationMenu(); createWindow(); createTray(); if (store.getSettings().autoStartGateway) await ensureGateway().catch(() => {}); applyLoginItem(store.getSettings().launchAtLogin);
    stopMemberSessionMaintenance = startMemberSessionMaintenance();
    clientScanTimer = setInterval(() => refreshLocalClients(), 30_000);
    clientScanTimer.unref();
    app.on('activate', showWindow);
  }).catch(e => { dialog.showErrorBox('云汇 AI 启动失败', e.message); app.quit(); });
}
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!store.getSettings().closeToTray && process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { stopDetectionUpdates?.(); stopMemberSessionMaintenance?.(); if (clientScanTimer) clearInterval(clientScanTimer); void gateway?.stop(); tray?.destroy(); });
