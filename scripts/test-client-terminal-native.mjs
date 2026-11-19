import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Opt-in native Windows check: opens real console windows running ONLY private
// fixture clients. No installed CLI, credentials or existing terminal is touched.
if (process.platform !== 'win32') { console.log('SKIP native client terminal: Windows only'); process.exit(0); }
const run = promisify(execFile);
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-terminal-native-')));
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const priorHome = process.env.AURORA_CLIENT_HOME;
const fixtures = [];
const quote = text => "'" + text.replaceAll("'", "''") + "'";
const encoded = text => Buffer.from(text, 'utf16le').toString('base64');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
async function ps(source) { return run(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(source)], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }); }
async function waitFor(check, message) {
  for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await delay(100); }
  throw new Error(message);
}
const report = fixture => { try { return JSON.parse(fs.readFileSync(path.join(fixture.dir, 'ready.json'), 'utf8')); } catch { return undefined; } };
async function check(name, fn) { await fn(); checks++; console.log('PASS', name); }
async function cleanupTerminals() {
  // Decode the launch data and require our exact private fixture path before
  // touching a shell. Never terminate by image name or an unverified PID.
  const expected = Buffer.from(JSON.stringify(fixtures.map(f => f.command)), 'utf8').toString('base64');
  await ps(`$ErrorActionPreference='Stop'
$expected = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')))
foreach ($row in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'")) {
  if ($row.CommandLine -notmatch '-EncodedCommand\\s+([A-Za-z0-9+/=]+)') { continue }
  try {
    $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
    if ($source -notmatch "FromBase64String\\('([A-Za-z0-9+/=]+)'\\)") { continue }
    $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json
    if ($expected -notcontains $data.executable) { continue }
    $process = Get-Process -Id $row.ProcessId -ErrorAction Stop; $null = $process.Handle
    if ($process.Path -ine ${quote(shell)} -or $process.Id -eq $PID -or $process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Fixture shell identity mismatch' }
    $process.Kill(); $process.WaitForExit(5000) | Out-Null
  } catch { if (Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue) { throw } }
}`);
}

try {
  process.env.AURORA_CLIENT_HOME = temporary;
  const compiler = ['Framework64', 'Framework'].map(folder => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe')).find(file => fs.existsSync(file));
  assert(compiler, 'The .NET Framework C# compiler is required');
  const source = path.join(temporary, 'TerminalFixture.cs');
  fs.writeFileSync(source, `using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
class TerminalFixture {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static void Main() {
    string root=AppDomain.CurrentDomain.BaseDirectory;
    IntPtr window=GetConsoleWindow();
    File.WriteAllText(Path.Combine(root,"ready.json"), "{\\"pid\\":"+Process.GetCurrentProcess().Id+",\\"window\\":"+window.ToInt64()+",\\"visible\\":"+IsWindowVisible(window).ToString().ToLowerInvariant()+",\\"inputRedirected\\":"+Console.IsInputRedirected.ToString().ToLowerInvariant()+",\\"outputRedirected\\":"+Console.IsOutputRedirected.ToString().ToLowerInvariant()+"}");
    File.WriteAllText(Path.Combine(root,"cwd.txt"),Environment.CurrentDirectory);
    DateTime deadline=DateTime.UtcNow.AddSeconds(90);
    while(DateTime.UtcNow<deadline && !File.Exists(Path.Combine(root,"stop"))) { File.WriteAllText(Path.Combine(root,"heartbeat"),"alive"); Thread.Sleep(100); }
  }
}`, 'utf8');
  const binary = path.join(temporary, 'fixture.exe');
  await run(compiler, ['/nologo', '/target:exe', '/out:' + binary, source], { windowsHide: true, timeout: 20000 });
  const bundle = path.join(temporary, 'lifecycle.cjs');
  await build({ entryPoints: ['src/main/clientLifecycle.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, shim = false) {
    const dir = path.join(temporary, name); fs.mkdirSync(dir);
    const exe = path.join(dir, 'claude.exe'); fs.copyFileSync(binary, exe);
    const command = path.join(dir, shim ? 'claude.cmd' : 'claude.exe');
    if (shim) fs.writeFileSync(command, '@echo off\r\n"%~dp0claude.exe"\r\n');
    const value = { dir, command }; fixtures.push(value); return value;
  }
  const native = fixture('native client with spaces');
  const shim = fixture("npm 'quoted' & Chinese 中文", true);
  const old = fixture('old-launch-regression');
  {
    const data = Buffer.from(JSON.stringify({ executable: old.command }), 'utf8').toString('base64');
    const source = `$inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n& $inputData.executable`;
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', encoded(source)], { detached: true, stdio: 'ignore', windowsHide: false, cwd: old.dir });
    const exited = await Promise.race([new Promise((resolve, reject) => { child.once('exit', code => resolve(code)); child.once('error', reject); }), delay(5000).then(() => 'timeout')]);
    // This reproduces exit=0 with no invocation on the affected host. Other
    // Windows/Node console hosts may behave differently, so record the evidence
    // without requiring the old defect to occur on every supported machine.
    console.log('LEGACY', JSON.stringify({ exit: exited, fixtureStarted: !!report(old) }));
  }
  for (const fixture of [native, shim]) await check(`A real interactive window executes ${path.extname(fixture.command)} at its literal path`, async () => {
    const lifecycle = api.createClientLifecycle({ ...api.nativeClientLifecycleRuntime, home: () => fixture.dir, detect: () => ({ installed: true, configured: true, command: fixture.command }) });
    const result = await lifecycle.restartClient({ agentId: 'claude-code' });
    assert.equal(result.ok, true, result.message); assert.equal(result.operation, 'opened-terminal');
    const ready = await waitFor(() => report(fixture), 'Private CLI was not launched');
    assert.equal(ready.inputRedirected, false); assert.equal(ready.outputRedirected, false);
    // With Windows Terminal/ConPTY, GetConsoleWindow can refer to a hidden
    // compatibility window. Real CLI execution with interactive handles is the
    // invariant; report the classic HWND visibility without requiring it.
    console.log('TERMINAL', JSON.stringify({ extension: path.extname(fixture.command), window: ready.window, visible: ready.visible }));
    assert.equal(fs.readFileSync(path.join(fixture.dir, 'cwd.txt'), 'utf8'), fixture.dir);
  });
  await check('Opening another CLI leaves the original interactive session running', async () => {
    assert(report(native)?.pid); process.kill(report(native).pid, 0);
    assert(Date.now() - fs.statSync(path.join(native.dir, 'heartbeat')).mtimeMs < 2500);
  });
  await check('Changed targets and invalid working directories fail before opening a terminal', async () => {
    const target = await api.nativeClientLifecycleRuntime.resolveTarget('claude-code', { installed: true, configured: true, command: shim.command });
    await assert.rejects(() => api.nativeClientLifecycleRuntime.openTerminal(target, 'relative-path'), /工作目录无效/);
    await assert.rejects(() => api.nativeClientLifecycleRuntime.openTerminal(target, temporary + '\ncommand'), /工作目录无效/);
    await assert.rejects(() => api.nativeClientLifecycleRuntime.openTerminal(target, path.join(temporary, 'missing')), /工作目录不存在/);
    fs.appendFileSync(shim.command, '@rem changed\r\n');
    await assert.rejects(() => api.nativeClientLifecycleRuntime.openTerminal(target, shim.dir), /程序已变化/);
  });
} finally {
  for (const fixture of fixtures) fs.writeFileSync(path.join(fixture.dir, 'stop'), 'exit');
  await delay(350);
  await cleanupTerminals();
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  if (path.dirname(temporary) === fs.realpathSync.native(os.tmpdir()) && path.basename(temporary).startsWith('yunhui-terminal-native-')) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
console.log(`Native Windows terminal: ${checks} checks passed`);
