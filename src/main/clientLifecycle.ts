import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { getAdapter, type AgentDetection } from '../core/agents/adapters.js';
import { createMacClientLifecycle, MacLifecycleError } from './clientLifecycleMac.js';

export type ClientKind = 'desktop' | 'cli' | 'service';
export interface ClientLifecycleInfo { ok: true; agentId: string; kind: ClientKind; installed: boolean; supported: boolean; message: string }
export interface ClientLifecycleResult { ok: boolean; agentId: string; kind: ClientKind; operation: 'restarted' | 'started' | 'opened-terminal' | 'unsupported' | 'failed'; message: string }
export interface ClientTarget { agentId: string; kind: ClientKind; executable: string; identity: string; aumid?: string; bundlePath?: string; bundleId?: string }
export interface ClientProcess { pid: number; executable: string; started: string; ownerSid: string; sessionId: number; hasWindow: boolean; protected?: boolean }
export interface ClientLifecycleRuntime {
  platform: NodeJS.Platform;
  home(): string;
  detect(agentId: string): AgentDetection;
  resolveTarget(agentId: string, detected: AgentDetection): Promise<ClientTarget | null>;
  validateTarget(target: ClientTarget): boolean;
  listProcesses(target: ClientTarget): Promise<{ processes: ClientProcess[]; uncertain: boolean }>;
  closeProcess(target: ClientTarget, process: ClientProcess): Promise<'requested' | 'gone' | 'blocked' | 'changed'>;
  startDesktop(target: ClientTarget): Promise<void>;
  openTerminal(target: ClientTarget, workingDirectory: string): Promise<void>;
  now(): number;
  delay(milliseconds: number): Promise<void>;
}

const clients: Record<string, { kind: ClientKind; name: string; binaries: string[]; packagePattern?: string }> = {
  'claude-code': { kind: 'cli', name: 'Claude Code', binaries: ['claude'] },
  'codex-cli': { kind: 'cli', name: 'Codex CLI', binaries: ['codex'] },
  'gemini-cli': { kind: 'cli', name: 'Gemini CLI', binaries: ['gemini'] },
  'qwen-code': { kind: 'cli', name: 'Qwen Code', binaries: ['qwen'] },
  'kimi-code': { kind: 'cli', name: 'Kimi Code', binaries: ['kimi'] },
  opencode: { kind: 'cli', name: 'OpenCode', binaries: ['opencode'] },
  zcode: { kind: 'cli', name: 'ZCode', binaries: ['zcode'] },
  'chatgpt-desktop': { kind: 'desktop', name: 'ChatGPT / Codex 桌面版', binaries: ['ChatGPT', 'ChatGPT Beta', 'Codex'], packagePattern: 'OpenAI|ChatGPT|Codex' },
  'claude-desktop': { kind: 'desktop', name: 'Claude 桌面版', binaries: ['Claude'], packagePattern: 'Anthropic|Claude' },
  workbuddy: { kind: 'desktop', name: 'WorkBuddy / CodeBuddy', binaries: ['WorkBuddy', 'CodeBuddy'], packagePattern: 'WorkBuddy|CodeBuddy' },
  antigravity: { kind: 'desktop', name: 'Antigravity', binaries: ['Antigravity'], packagePattern: 'Antigravity' },
  deepseek: { kind: 'service', name: 'DeepSeek API', binaries: [] },
};
class LifecycleError extends Error {}
function selected(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'agentId')) throw new Error('客户端操作参数无效');
  const id = (payload as { agentId?: unknown }).agentId;
  if (typeof id !== 'string' || !Object.hasOwn(clients, id === 'codex-desktop' ? 'chatgpt-desktop' : id)) throw new Error('不支持的客户端标识');
  return id === 'codex-desktop' ? 'chatgpt-desktop' : id;
}
const normalized = (value: string) => path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
function canonical(file: string): string { return fs.realpathSync.native(file); }
function fileIdentity(file: string): string {
  const stats = fs.statSync(file);
  if (!stats.isFile()) throw new LifecycleError('检测到的客户端路径不是可执行文件，请重新安装或检查程序路径');
  return `${normalized(canonical(file))}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}
function powershell(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new LifecycleError('无法确定 Windows 系统目录');
  const executable = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.statSync(executable).isFile()) throw new LifecycleError('Windows PowerShell 不可用');
  return executable;
}
function encoded(source: string): string { return Buffer.from(source, 'utf16le').toString('base64'); }
function input(value: unknown): string { return `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value), 'utf8').toString('base64')}')) | ConvertFrom-Json\n`; }
function script(source: string, data: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded("$ErrorActionPreference='Stop'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" + input(data) + source)],
      { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { reject(new LifecycleError('无法安全读取或操作客户端进程，请手动退出后重试')); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch { reject(new LifecycleError('系统返回的客户端信息不完整，请手动退出后重试')); }
      });
  });
}
function detached(executable: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false, cwd });
    child.once('error', () => reject(new LifecycleError('客户端启动失败，请检查安装是否完整或手动打开')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// A libuv detached process has no interactive console. In particular, Windows
// PowerShell can exit successfully before executing its command when stdio is
// ignored. Let Windows create the console, then require the new shell itself to
// acknowledge usable terminal handles; the helper's spawn event proves neither.
const openTerminalScript = `
$terminal = Start-Process -FilePath $inputData.shell -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', [string]$inputData.command) -WorkingDirectory $inputData.workingDirectory -WindowStyle Normal -PassThru
@{ pid = $terminal.Id } | ConvertTo-Json -Compress
`;
const terminalReadyScript = `
$ErrorActionPreference = 'Stop'
try {
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'Terminal handles are redirected' }
  Set-Location -LiteralPath $inputData.workingDirectory
  if (!(Test-Path -LiteralPath $inputData.executable -PathType Leaf)) { throw 'Client executable is unavailable' }
  $reply = @{ nonce = $inputData.nonce; pid = $PID; ready = $true } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($inputData.reply, $reply, (New-Object Text.UTF8Encoding($false)))
} catch {
  try { [IO.File]::WriteAllText($inputData.reply, (@{ nonce = $inputData.nonce; pid = $PID; ready = $false } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) } catch { }
  Write-Host 'The client was not started. Please open a new terminal and try again.' -ForegroundColor Red
  return
}
& $inputData.executable
`;

async function openWindowsTerminal(target: ClientTarget, workingDirectory: string): Promise<void> {
  if (!path.win32.isAbsolute(workingDirectory) || /[\x00-\x1f\x7f]/.test(workingDirectory)) throw new LifecycleError('终端工作目录无效，请重新检查客户端配置');
  try { if (!fs.statSync(workingDirectory).isDirectory()) throw new Error(); }
  catch { throw new LifecycleError('终端工作目录不存在，请重新检查客户端配置'); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-terminal-'));
  const reply = path.join(directory, 'ready.json'), nonce = randomBytes(24).toString('hex');
  try {
    const source = input({ executable: target.executable, workingDirectory, reply, nonce }) + terminalReadyScript;
    let started: { pid?: number };
    try { started = await script(openTerminalScript, { shell: powershell(), command: encoded(source), workingDirectory }); }
    catch { throw new LifecycleError('Windows 未能打开交互终端，请从开始菜单打开终端后重试'); }
    if (!Number.isInteger(started?.pid) || started.pid! <= 0) throw new LifecycleError('Windows 未确认新终端进程，请检查终端窗口后重试');
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      let response: { nonce?: string; pid?: number; ready?: boolean } | undefined;
      try {
        const stat = fs.lstatSync(reply);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) response = JSON.parse(fs.readFileSync(reply, 'utf8'));
      } catch { /* A write may still be in progress. */ }
      if (response?.nonce === nonce && response.pid === started.pid) {
        if (response.ready === true) return;
        if (response.ready === false) throw new LifecycleError('新终端未能建立交互环境，客户端尚未启动，请手动打开终端后重试');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new LifecycleError('未收到新终端的启动确认，请检查是否有终端窗口或系统拦截提示，再重新尝试');
  } finally {
    // Remove only this launch's acknowledgement; never recurse over temp paths.
    try { fs.unlinkSync(reply); } catch { }
    try { fs.rmdirSync(directory); } catch { }
  }
}

const resolveDesktopScript = `
$candidate = [string]$inputData.candidate
$shortcutAumid = ''
if (!$candidate -or !(Test-Path -LiteralPath $candidate -PathType Leaf)) {
  $queue = New-Object 'Collections.Generic.Queue[string]'; $visited = 0
  foreach ($root in @($inputData.startMenuRoots)) { if (Test-Path -LiteralPath $root -PathType Container) { $queue.Enqueue($root) } }
  while ($queue.Count -gt 0 -and $visited -lt 512) {
    $directory = $queue.Dequeue(); $visited++
    $rootInfo = Get-Item -LiteralPath $directory -ErrorAction SilentlyContinue
    if (!$rootInfo -or ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction SilentlyContinue | Select-Object -First 2048)) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if ($entry.PSIsContainer) { $queue.Enqueue($entry.FullName); continue }
      if ($entry.Extension -ieq '.lnk' -and $inputData.shortcutNames -contains $entry.BaseName) { $candidate = $entry.FullName; break }
    }
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { break }
  }
}
if ($candidate -and [IO.Path]::GetExtension($candidate) -ieq '.lnk' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($candidate)
  if ($shortcut.Arguments) { @{ unsupported = 'shortcut-arguments' } | ConvertTo-Json -Compress; exit }
  $folder = (New-Object -ComObject Shell.Application).Namespace([IO.Path]::GetDirectoryName($candidate))
  if ($folder) { $entry = $folder.ParseName([IO.Path]::GetFileName($candidate)); if ($entry) { $shortcutAumid = [string]$entry.ExtendedProperty('System.AppUserModel.ID') } }
  $candidate = [string]$shortcut.TargetPath
}
$applications = @()
$packages = @()
if (!$inputData.isolated) { $packages = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $inputData.packagePattern }) }
foreach ($package in $packages) {
  try {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
    foreach ($application in @($manifest.Package.Applications.Application)) {
      $relative = [string]$application.Executable
      if (!$relative -or [IO.Path]::IsPathRooted($relative)) { continue }
      $exe = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation $relative))
      if (!$exe.StartsWith($package.InstallLocation.TrimEnd('\\') + '\\', [StringComparison]::OrdinalIgnoreCase)) { continue }
      if ($inputData.names -notcontains [IO.Path]::GetFileName($exe)) { continue }
      if (Test-Path -LiteralPath $exe -PathType Leaf) { $applications += @{ executable = $exe; aumid = ($package.PackageFamilyName + '!' + [string]$application.Id) } }
    }
  } catch { }
}
$matchingApplications = @($applications | Where-Object { ($candidate -and $_.executable -ieq $candidate) -or ($shortcutAumid -and $_.aumid -eq $shortcutAumid) })
if ($matchingApplications.Count -gt 1) { @{ unsupported = 'ambiguous-appx' } | ConvertTo-Json -Compress; exit }
if ($matchingApplications.Count -eq 1) { $matchingApplications[0] | ConvertTo-Json -Compress; exit }
if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf) -and [IO.Path]::GetExtension($candidate) -ieq '.exe' -and $candidate -notmatch '\\\\WindowsApps\\\\') {
  @{ executable = $candidate } | ConvertTo-Json -Compress; exit
}
if ($applications.Count -gt 1) { @{ unsupported = 'ambiguous-appx' } | ConvertTo-Json -Compress; exit }
if ($applications.Count -eq 1) { $applications[0] | ConvertTo-Json -Compress; exit }
foreach ($fallback in @($inputData.fallbacks)) { if (Test-Path -LiteralPath $fallback -PathType Leaf) { @{ executable = $fallback } | ConvertTo-Json -Compress; exit } }
@{ missing = $true } | ConvertTo-Json -Compress
`;
const listProcessesScript = `
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$protectedIds = @{}; $ancestorId = [Diagnostics.Process]::GetCurrentProcess().Id
for ($depth = 0; $depth -lt 64 -and $ancestorId -gt 0 -and !$protectedIds.ContainsKey($ancestorId); $depth++) {
  $protectedIds[$ancestorId] = $true
  $ancestor = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ancestorId) -Property ProcessId,ParentProcessId -ErrorAction Stop
  if (!$ancestor) { break }; $ancestorId = [int]$ancestor.ParentProcessId
}
$items = @(); $uncertain = $false
foreach ($row in @(Get-CimInstance Win32_Process -Filter ('Name=''' + ([IO.Path]::GetFileName($inputData.executable)).Replace("'", "''") + '''') -Property ProcessId,Name,SessionId)) {
  if ($row.SessionId -ne $currentSession) { continue }
  try {
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop
    if ($owner.ReturnValue -ne 0) { $uncertain = $true; continue }
    if ($owner.Sid -ne $currentSid) { continue }
    $process = Get-Process -Id $row.ProcessId -ErrorAction Stop
    $null = $process.Handle
    if (!$process.Path) { $uncertain = $true; continue }
    $items += @{ pid = [int]$row.ProcessId; executable = [string]$process.Path; started = $process.StartTime.ToUniversalTime().Ticks.ToString(); ownerSid = [string]$owner.Sid; sessionId = [int]$process.SessionId; hasWindow = ($process.MainWindowHandle -ne 0); protected = $protectedIds.ContainsKey([int]$row.ProcessId) }
  } catch { if (Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue) { $uncertain = $true } }
}
@{ processes = @($items); uncertain = $uncertain } | ConvertTo-Json -Depth 4 -Compress
`;
const closeProcessScript = `
$expected = $inputData.process
$process = Get-Process -Id ([int]$expected.pid) -ErrorAction SilentlyContinue
if (!$process) { @{ result = 'gone' } | ConvertTo-Json -Compress; exit }
try {
# Retain this process handle through identity checks and termination; never kill by image name or a newly looked-up PID.
$null = $process.Handle
if ($process.HasExited) { @{ result = 'gone' } | ConvertTo-Json -Compress; exit }
$row = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$expected.pid) -Property ProcessId,SessionId -ErrorAction Stop
if (!$row) { @{ result = 'gone' } | ConvertTo-Json -Compress; exit }
$owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -ErrorAction Stop
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$protectedIds = @{}; $ancestorId = [Diagnostics.Process]::GetCurrentProcess().Id
for ($depth = 0; $depth -lt 64 -and $ancestorId -gt 0 -and !$protectedIds.ContainsKey($ancestorId); $depth++) {
  $protectedIds[$ancestorId] = $true
  $ancestor = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ancestorId) -Property ProcessId,ParentProcessId -ErrorAction Stop
  if (!$ancestor) { break }; $ancestorId = [int]$ancestor.ParentProcessId
}
if ($protectedIds.ContainsKey([int]$expected.pid) -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $currentSid -or $owner.Sid -ne $expected.ownerSid -or $process.SessionId -ne $currentSession -or $process.SessionId -ne $expected.sessionId -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $expected.started -or $process.Path -ine $expected.executable) {
  @{ result = 'changed' } | ConvertTo-Json -Compress; exit
}
$process.Kill()
@{ result = 'requested' } | ConvertTo-Json -Compress
} catch {
  $hasExited = $false
  try { $hasExited = $process.HasExited } catch { }
  if ($hasExited) { @{ result = 'gone' } | ConvertTo-Json -Compress }
  else { @{ result = 'blocked' } | ConvertTo-Json -Compress }
}
`;

const macLifecycle = createMacClientLifecycle();
export const nativeClientLifecycleRuntime: ClientLifecycleRuntime = {
  platform: process.platform,
  home: () => os.homedir(),
  detect: agentId => getAdapter(agentId)?.detect() || { installed: false, configured: false },
  async resolveTarget(agentId, detected) {
    const definition = clients[agentId];
    if (process.platform === 'darwin') return macLifecycle.resolveTarget(agentId, definition, detected);
    let executable = detected.command, aumid: string | undefined;
    if (executable && (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || /[\x00-\x1f]/.test(executable))) throw new LifecycleError('未找到可验证的客户端程序路径');
    const detectedFilename = executable ? path.basename(executable).toLowerCase() : '';
    if (executable && path.extname(executable).toLowerCase() === '.exe' && !definition.binaries.some(name => name.toLowerCase() + '.exe' === detectedFilename)) throw new LifecycleError('检测到的启动目标与此客户端不匹配，请检查安装路径');
    if (definition.kind === 'desktop') {
      const isolated = process.env.AURORA_CLIENT_HOME;
      const roots = (isolated ? [path.join(isolated, 'AppData', 'Local')] : [process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]).filter(Boolean) as string[];
      const fallbacks = roots.flatMap(root => definition.binaries.flatMap(name => [path.join(root, name, `${name}.exe`), path.join(root, 'Programs', name, `${name}.exe`)]));
      const menuSuffix = path.join('Microsoft', 'Windows', 'Start Menu', 'Programs');
      const startMenuRoots = isolated ? [path.join(isolated, 'AppData', 'Roaming', menuSuffix), path.join(isolated, 'ProgramData', menuSuffix)]
        : [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), menuSuffix), path.join(process.env.ProgramData || 'C:\\ProgramData', menuSuffix)];
      const found = await script(resolveDesktopScript, { candidate: executable || '', names: definition.binaries.map(name => name + '.exe'), shortcutNames: definition.binaries, packagePattern: definition.packagePattern, fallbacks, startMenuRoots, isolated: !!isolated });
      if (found.unsupported) throw new LifecycleError(found.unsupported === 'ambiguous-appx' ? '检测到多个商店客户端入口，无法确定重启目标，请从开始菜单手动重新打开' : '客户端快捷方式包含额外启动参数，请从客户端或开始菜单手动重新打开');
      if (found.missing) return null;
      executable = found.executable; aumid = found.aumid;
    } else if (!executable) return null;
    if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || /[\x00-\x1f]/.test(executable)) throw new LifecycleError('未找到可验证的客户端程序路径');
    if (definition.kind === 'cli' && !path.extname(executable)) executable = ['.exe', '.cmd', '.bat'].map(extension => executable + extension).find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
    if (!executable) throw new LifecycleError('未找到可直接启动的 Windows 命令，请在终端手动运行客户端');
    const extension = path.extname(executable).toLowerCase(), basename = path.basename(executable).slice(0, -extension.length).toLowerCase();
    if (!definition.binaries.some(name => name.toLowerCase() === basename) || !(definition.kind === 'desktop' ? ['.exe'] : ['.exe', '.cmd', '.bat']).includes(extension)) throw new LifecycleError('检测到的启动目标与此客户端不匹配，请检查安装路径');
    if (aumid && !/^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(aumid)) throw new LifecycleError('商店客户端的启动标识无效，请从开始菜单手动打开');
    const real = canonical(executable);
    const realExtension = path.extname(real).toLowerCase(), realBasename = path.basename(real).slice(0, -realExtension.length).toLowerCase();
    if (!definition.binaries.some(name => name.toLowerCase() === realBasename) || !(definition.kind === 'desktop' ? ['.exe'] : ['.exe', '.cmd', '.bat']).includes(realExtension)) throw new LifecycleError('客户端链接的实际目标与此客户端不匹配，请检查安装路径');
    if (normalized(real) === normalized(canonical(process.execPath))) throw new LifecycleError('此路径是云汇自身程序，不能作为外部客户端重新启动');
    return { agentId, kind: definition.kind, executable: real, identity: fileIdentity(real), ...(aumid ? { aumid } : {}) };
  },
  validateTarget(target) { if (process.platform === 'darwin') return macLifecycle.validateTarget(target); try { return normalized(target.executable) !== normalized(canonical(process.execPath)) && fileIdentity(target.executable) === target.identity; } catch { return false; } },
  async listProcesses(target) {
    if (process.platform === 'darwin') return macLifecycle.listProcesses(target);
    const found = await script(listProcessesScript, { executable: target.executable });
    if (!Array.isArray(found.processes) || typeof found.uncertain !== 'boolean') throw new LifecycleError('无法确认客户端进程身份，请手动退出后重试');
    let uncertain = found.uncertain;
    const processes = found.processes.filter((entry: ClientProcess) => {
      if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.executable !== 'string' || typeof entry.started !== 'string' || !/^\d+$/.test(entry.started) || typeof entry.ownerSid !== 'string' || !Number.isInteger(entry.sessionId) || typeof entry.hasWindow !== 'boolean') { uncertain = true; return false; }
      try { return normalized(canonical(entry.executable)) === normalized(target.executable); } catch { uncertain = true; return false; }
    });
    return { processes, uncertain };
  },
  async closeProcess(target, clientProcess) {
    if (process.platform === 'darwin') return macLifecycle.closeProcess(target, clientProcess);
    if (!this.validateTarget(target) || clientProcess.protected || clientProcess.pid === process.pid || clientProcess.pid === process.ppid) return 'changed';
    try { if (normalized(canonical(clientProcess.executable)) !== normalized(target.executable)) return 'changed'; } catch { return 'changed'; }
    const result = await script(closeProcessScript, { process: clientProcess });
    if (!['requested', 'gone', 'blocked', 'changed'].includes(result.result)) throw new LifecycleError('客户端强制结束请求未被系统确认');
    return result.result;
  },
  async startDesktop(target) {
    if (process.platform === 'darwin') return macLifecycle.startDesktop(target);
    if (target.aumid) await detached(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), ['shell:AppsFolder\\' + target.aumid]);
    else await detached(target.executable, [], path.dirname(target.executable));
  },
  async openTerminal(target, workingDirectory) {
    if (process.platform === 'darwin') return macLifecycle.openTerminal(target, workingDirectory);
    if (target.kind !== 'cli' || !this.validateTarget(target)) throw new LifecycleError('命令行客户端程序已变化，请重新检测后再打开');
    await openWindowsTerminal(target, workingDirectory);
  },
  now: () => Date.now(),
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

/** Runtime injection is for trusted main-process code and isolated tests, never IPC payloads. */
export function createClientLifecycle(runtime: ClientLifecycleRuntime) {
  const flights = new Map<string, Promise<ClientLifecycleResult>>();
  async function describeClientLifecycle(payload: unknown): Promise<ClientLifecycleInfo> {
    const agentId = selected(payload), definition = clients[agentId], base = { ok: true as const, agentId, kind: definition.kind };
    if (definition.kind === 'service') return { ...base, installed: false, supported: false, message: '这是模型 API 服务，无需重新启动本机程序' };
    if (!['win32', 'darwin'].includes(runtime.platform)) return { ...base, installed: runtime.detect(agentId).installed, supported: false, message: '此系统暂不支持自动重启，请保存工作后手动退出并打开客户端' };
    const detected = runtime.detect(agentId);
    try {
      const target = await runtime.resolveTarget(agentId, detected);
      return { ...base, installed: !!target, supported: !!target, message: !target ? `未检测到 ${definition.name}，请先完成安装并重新检测` : definition.kind === 'cli' ? '在新的终端窗口打开客户端；原终端会话保留，请自行结束旧会话后加载新配置' : '强制结束客户端进程后重新打开，包含托盘和后台运行的客户端；未运行时直接启动。当前会话会中断，未保存内容可能丢失，请先保存工作' };
    } catch (error) { return { ...base, installed: detected.installed, supported: false, message: error instanceof LifecycleError || error instanceof MacLifecycleError ? error.message : '无法确认客户端安装位置，请重新检测或手动打开' }; }
  }
  async function restartClient(payload: unknown): Promise<ClientLifecycleResult> {
    const agentId = selected(payload), definition = clients[agentId], existing = flights.get(agentId);
    if (existing) return existing;
    const run = (async (): Promise<ClientLifecycleResult> => {
      const result = (ok: boolean, operation: ClientLifecycleResult['operation'], message: string): ClientLifecycleResult => ({ ok, agentId, kind: definition.kind, operation, message });
      if (!['win32', 'darwin'].includes(runtime.platform) || definition.kind === 'service') return result(false, 'unsupported', definition.kind === 'service' ? '模型 API 服务无需重启本机程序' : '此系统暂不支持自动重启，请手动退出并打开客户端');
      try {
        const target = await runtime.resolveTarget(agentId, runtime.detect(agentId));
        if (!target) return result(false, 'failed', `未检测到 ${definition.name}，请先完成安装并重新检测`);
        if (!runtime.validateTarget(target)) return result(false, 'failed', '客户端程序已变化，请重新检测后再操作');
        if (definition.kind === 'cli') {
          await runtime.openTerminal(target, runtime.home());
          return result(true, 'opened-terminal', '已打开新终端并提交客户端启动命令，请在新窗口查看启动结果。原终端会话仍保留；要加载新配置，请自行结束旧会话后使用新窗口');
        }
        const initial = await runtime.listProcesses(target);
        if (initial.uncertain) return result(false, 'failed', '无法完整确认客户端进程身份，请手动退出客户端后重试');
        if (initial.processes.some(process => process.protected || process.pid === globalThis.process.pid || process.pid === globalThis.process.ppid)) return result(false, 'failed', '目标包含云汇自身或启动云汇的进程，已停止操作，请在客户端中手动处理');
        if (initial.processes.length) {
          const deadline = runtime.now() + 10000, requested = new Set<string>();
          let remaining = initial;
          while (true) {
            if (remaining.uncertain) return result(false, 'failed', '无法确认客户端是否完全退出，请手动检查后重试');
            if (!remaining.processes.length) break;
            if (remaining.processes.some(process => process.protected || process.pid === globalThis.process.pid || process.pid === globalThis.process.ppid)) return result(false, 'failed', '目标包含云汇自身或启动云汇的进程，已停止操作，请在客户端中手动处理');
            if (runtime.now() >= deadline) return result(false, 'failed', '客户端进程尚未完全结束，已停止重新打开，请检查系统权限或后台自动启动程序后重试');
            for (const process of remaining.processes) {
              const identity = `${process.pid}:${process.started}`;
              if (requested.has(identity)) continue;
              if (!runtime.validateTarget(target)) return result(false, 'failed', '客户端程序在退出期间已变化，请重新检测后再打开');
              const outcome = await runtime.closeProcess(target, process);
              if (outcome === 'changed') return result(false, 'failed', '客户端进程已变化，为避免影响其他程序已停止操作，请重试');
              if (outcome === 'blocked') return result(false, 'failed', '系统未允许结束客户端进程，请检查客户端是否以管理员身份运行，或手动结束后重试');
              requested.add(identity);
            }
            await runtime.delay(300);
            remaining = await runtime.listProcesses(target);
          }
        }
        if (!runtime.validateTarget(target)) return result(false, 'failed', '客户端程序在退出期间已变化，请重新检测后再打开');
        const beforeStart = await runtime.listProcesses(target);
        if (beforeStart.uncertain || beforeStart.processes.length) return result(false, 'failed', '客户端进程状态已变化，请确认完全退出后重试');
        if (!runtime.validateTarget(target)) return result(false, 'failed', '客户端启动目标已变化，请重新检测后再操作');
        await runtime.startDesktop(target);
        const deadline = runtime.now() + 10000;
        while (true) {
          const started = await runtime.listProcesses(target);
          if (started.uncertain) return result(false, 'failed', '已发出启动请求，但无法确认客户端进程，请检查客户端窗口');
          if (started.processes.length) return result(true, initial.processes.length ? 'restarted' : 'started', initial.processes.length ? '客户端进程已结束并重新启动' : '客户端已启动');
          if (runtime.now() >= deadline) return result(false, 'failed', `已发出启动请求，但未检测到客户端运行，请从${runtime.platform === 'darwin' ? 'Finder' : '开始菜单'}手动打开并检查安装`);
          await runtime.delay(300);
        }
      } catch (error) { return result(false, 'failed', error instanceof LifecycleError || error instanceof MacLifecycleError ? error.message : '客户端操作未完成，请检查安装或手动退出后重新打开'); }
    })();
    flights.set(agentId, run);
    try { return await run; } finally { if (flights.get(agentId) === run) flights.delete(agentId); }
  }
  return { describeClientLifecycle, restartClient };
}
const native = createClientLifecycle(nativeClientLifecycleRuntime);
export const describeClientLifecycle = native.describeClientLifecycle;
export const restartClient = native.restartClient;
