/** Native Electron shell, isolated app/client profiles and a local catalog. No real client restart. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-shell-')));
const data = path.join(scratch, 'data'), clients = path.join(scratch, 'clients'), report = path.join(scratch, 'result.json');
for (const dir of [data, clients]) fs.mkdirSync(dir);
const catalog = fs.readFileSync(path.join(root, 'server/seed-catalog.json'));
const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(catalog); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ launchAtLogin: false, autoStartGateway: false, autoCheckUpdate: false, closeToTray: true, catalogUrl: `http://127.0.0.1:${server.address().port}/catalog` }));
const runner = path.join(scratch, 'shell.cjs');
fs.writeFileSync(runner, `
const { app, BrowserWindow, Menu, nativeImage } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(path.join(scratch, 'electron'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const timeout = setTimeout(() => { console.error('Native shell deadline exceeded'); app.exit(1); }, 50000);
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      for (let i = 0; i < 120; i++) { if (await win.webContents.executeJavaScript('!!document.querySelector(".app")')) break; await delay(200); }
      assert(await win.webContents.executeJavaScript('!!document.querySelector(".app")'), 'Shell failed to render');
      const state = await win.webContents.executeJavaScript('window.aurora.invoke("state.get")');
      assert.equal(state.platform, process.platform); assert.equal(state.providers.length, 0);
      checks.push('Real native Electron IPC renders an empty isolated workspace');
      const ui = await win.webContents.executeJavaScript('({platform:document.querySelector(".app").dataset.platform,controls:document.querySelectorAll(".win-controls").length,shortcut:document.querySelector(".quick-search kbd").textContent,padding:parseFloat(getComputedStyle(document.querySelector(".titlebar")).paddingLeft)})');
      assert.equal(ui.platform, process.platform);
      if (process.platform === 'darwin') {
        assert.equal(ui.controls, 0); assert.equal(ui.shortcut, '⌘ K'); assert(ui.padding >= 86);
        const roles = Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items.map(item => item.role) || []);
        for (const role of ['quit', 'copy', 'paste', 'selectall', 'close', 'togglefullscreen']) assert(roles.includes(role), role);
        const icon = nativeImage.createFromPath(${JSON.stringify(path.join(root, 'dist/ui/trayTemplate.png'))});
        assert(!icon.isEmpty()); assert.equal(icon.getSize().width, 18);
        checks.push('macOS native menu, command shortcuts, traffic-light spacing and template icon');
      } else { assert.equal(ui.controls, 1); assert.equal(ui.shortcut, 'Ctrl K'); checks.push('Windows custom window controls and Ctrl shortcut'); }
      const shortcut = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
      await win.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",'+shortcut+':true,bubbles:true}))');
      await delay(100);
      assert(await win.webContents.executeJavaScript('!!document.querySelector("[role=dialog]")'));
      checks.push('Native renderer opens command search with the platform shortcut');
      win.close(); await delay(100); assert(!win.isDestroyed()); assert(!win.isVisible());
      app.emit('activate'); await delay(200); assert(win.isVisible());
      checks.push('Close-to-tray hides without quitting and activation restores the window');
      if (process.platform === 'darwin') {
        const saved = await win.webContents.executeJavaScript('window.aurora.invoke("settings.save",{closeToTray:false})'); assert(!saved.error);
        win.close(); await delay(200); assert(win.isDestroyed());
        app.emit('activate'); await delay(200); assert.equal(BrowserWindow.getAllWindows().length, 1);
        checks.push('macOS closes the window without quitting and Dock activation recreates it');
      }
      fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({platform:process.platform,arch:process.arch,passed:true,checks}));
      clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require(${JSON.stringify(path.join(root, 'dist/main/main.cjs'))});
`);
let child;
try {
  const env = { ...process.env, AURORA_HOME: data, YUNHUI_HOME: data, AURORA_CLIENT_HOME: clients, YUNHUI_TEST_ISOLATED: '1', AURORA_UI_TEST: '0', APPDATA: path.join(scratch, 'appdata'), LOCALAPPDATA: path.join(scratch, 'localappdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE', 'AURORA_EXTENSION_ASSETS']) delete env[key];
  child = spawn(createRequire(import.meta.url)('electron'), [runner], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exit, 0); assert(fs.existsSync(report));
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert(result.passed); console.log(JSON.stringify(result));
} finally {
  if (child && child.exitCode === null) child.kill();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
