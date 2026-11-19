import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveMacApplication, type MacApplication } from '../core/desktopDetection.js';
import type { AgentDetection } from '../core/agents/adapters.js';
import type { ClientKind, ClientProcess, ClientTarget } from './clientLifecycle.js';

export class MacLifecycleError extends Error {}
export interface MacLifecycleHost {
  home(): string;
  isolatedHome(): string | undefined;
  configurationEnvironment?(): NodeJS.ProcessEnv;
  ownExecutable(): string;
  uid(): number;
  pid(): number;
  terminalPath(): string | undefined;
  resolveApplication(candidate: string): MacApplication | null;
  run(executable: string, args: string[]): Promise<string>;
}
export interface MacClientDefinition { kind: ClientKind; name: string; binaries: string[] }
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
const safePath = (value: string) => path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
const ownRealpath = (file: string) => fs.realpathSync.native(file);
function stamp(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new MacLifecycleError('客户端程序或应用信息文件不完整，请重新安装');
  return [ownRealpath(file), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode].join(':');
}
function identity(target: Pick<ClientTarget, 'executable' | 'bundlePath' | 'bundleId'>): string {
  return JSON.stringify([stamp(target.executable), target.bundlePath && ownRealpath(target.bundlePath), target.bundleId, target.bundlePath && stamp(path.join(target.bundlePath, 'Contents', 'Info.plist'))]);
}
export function quotePosixArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new MacLifecycleError('客户端路径包含不可用字符');
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
const TERMINAL_CONFIG_VARIABLES = new Set(['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME']);
export function macTerminalCommand(executable: string, workingDirectory: string, configuration: Record<string, string | undefined> = {}): string {
  if (!safePath(executable) || !safePath(workingDirectory)) throw new MacLifecycleError('终端启动需要完整的客户端路径和工作目录');
  const variables: string[] = [], unset: string[] = [];
  for (const [key, value] of Object.entries(configuration)) {
    if (!TERMINAL_CONFIG_VARIABLES.has(key) || (value === undefined ? key !== 'CLAUDE_CONFIG_DIR' : !safePath(value))) throw new MacLifecycleError('终端配置目录无效，请检查客户端配置路径');
    if (value === undefined) unset.push(`-u ${quotePosixArgument(key)}`);
    else variables.push(quotePosixArgument(`${key}=${value}`));
  }
  const environment = [...unset, ...variables];
  return `cd -- ${quotePosixArgument(workingDirectory)} && ${environment.length ? `/usr/bin/env ${environment.join(' ')} ` : ''}${quotePosixArgument(executable)}`;
}

export const nativeMacLifecycleHost: MacLifecycleHost = {
  home: () => os.homedir(), isolatedHome: () => process.env.AURORA_CLIENT_HOME,
  configurationEnvironment: () => ({ CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }),
  ownExecutable: () => process.execPath, uid: () => process.getuid?.() ?? -1, pid: () => process.pid,
  terminalPath: () => ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'].find(file => fs.existsSync(file)),
  resolveApplication: candidate => resolveMacApplication(candidate),
  run(executable, args) {
    return new Promise((resolve, reject) => {
      execFile(executable, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        const failure = new Error('macOS native operation failed') as Error & { automationDenied?: boolean };
        failure.automationDenied = /(?:-1743|not authorized to send Apple events)/i.test(stderr || '');
        reject(failure);
      });
    });
  },
};

// Arguments enter JXA as JSON data. All executable paths and selectors below are fixed system APIs.
const processScript = `
ObjC.import('AppKit'); ObjC.import('Foundation');
function stringValue(value) { try { return value ? String(ObjC.unwrap(value)) : ''; } catch (_) { return ''; } }
function urlPath(value) { try { return value ? stringValue(value.URLByResolvingSymlinksInPath.path) : ''; } catch (_) { return ''; } }
function filePath(value) { try { return value ? urlPath($.NSURL.fileURLWithPath(value)) : ''; } catch (_) { return ''; } }
function processInfo(pid) {
  var task = $.NSTask.alloc.init, output = $.NSPipe.pipe;
  task.launchPath = '/bin/ps'; task.arguments = $(['-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'lstart=']);
  task.standardOutput = output; task.standardError = $.NSPipe.pipe;
  task.launch;
  var bytes = output.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (Number(task.terminationStatus) !== 0) return null;
  var line = stringValue($.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding));
  var parsed = /^\\s*(\\d+)\\s+(\\d+)\\s+(.+?)\\s*$/.exec(line);
  return parsed ? { uid: Number(parsed[1]), parent: Number(parsed[2]), started: parsed[3] } : null;
}
function protectedIds(pid) {
  var ids = {};
  for (var depth = 0; depth < 64 && pid > 0 && !ids[pid]; depth++) {
    ids[pid] = true; var information = processInfo(pid); if (!information) break; pid = information.parent;
  }
  return ids;
}
function applicationIdentity(application) {
  var launched = application.launchDate;
  return { pid: Number(application.processIdentifier), executable: urlPath(application.executableURL), bundlePath: urlPath(application.bundleURL), bundleId: stringValue(application.bundleIdentifier), launched: launched ? String(Number(launched.timeIntervalSince1970)) : '' };
}
function sameApplication(actual, target) { return actual.executable === target.executable && actual.bundlePath === target.bundlePath && actual.bundleId === target.bundleId; }
function run(argv) {
  var data = JSON.parse(argv[0]), requestedTarget = data.target;
  // Foundation and POSIX realpath can choose different spellings for /private/var.
  // Resolve both sides with Foundation, retaining the caller's paths only after a full match.
  var target = { executable: filePath(requestedTarget.executable), bundlePath: filePath(requestedTarget.bundlePath), bundleId: requestedTarget.bundleId };
  if (!target.executable || !target.bundlePath) return JSON.stringify(data.mode === 'close' ? { result: 'changed' } : { processes: [], uncertain: true });
  var protectedProcesses = protectedIds(data.ownerPid);
  if (data.mode === 'close') {
    var expected = data.process;
    var application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(expected.pid);
    if (!application || application.isTerminated) return JSON.stringify({ result: 'gone' });
    var actual = applicationIdentity(application), information = processInfo(actual.pid);
    if (!sameApplication(actual, target) || !actual.launched || !information || information.uid !== data.ownerUid || expected.ownerSid !== 'uid:' + information.uid || expected.started !== actual.launched + '|' + information.started || protectedProcesses[actual.pid]) return JSON.stringify({ result: 'changed' });
    // Force only this revalidated application instance. A tray-only application
    // or an application refusing normal quit must still release its old config.
    return JSON.stringify({ result: application.forceTerminate ? 'requested' : 'blocked' });
  }
  var applications = $.NSWorkspace.sharedWorkspace.runningApplications, processes = [], uncertain = false;
  for (var index = 0; index < Number(applications.count); index++) {
    var application = applications.objectAtIndex(index);
    if (application.isTerminated) continue;
    var actual = applicationIdentity(application);
    if (actual.executable !== target.executable && actual.bundlePath !== target.bundlePath) {
      if (actual.bundleId === target.bundleId && (!actual.executable || !actual.bundlePath)) uncertain = true;
      continue;
    }
    if (!sameApplication(actual, target) || !actual.launched) { uncertain = true; continue; }
    var information = processInfo(actual.pid);
    if (!information) { uncertain = true; continue; }
    if (information.uid !== data.ownerUid) continue;
    processes.push({ pid: actual.pid, executable: requestedTarget.executable, bundlePath: requestedTarget.bundlePath, bundleId: actual.bundleId,
      started: actual.launched + '|' + information.started, ownerSid: 'uid:' + information.uid, sessionId: 0, hasWindow: false, protected: !!protectedProcesses[actual.pid] });
  }
  return JSON.stringify({ processes: processes, uncertain: uncertain });
}
`;
const terminalScript = `
function run(argv) {
  var data = JSON.parse(argv[0]);
  var terminal = Application(data.terminal);
  terminal.activate();
  terminal.doScript(data.command);
  return JSON.stringify({ submitted: true });
}
`;

/** A host can be injected by trusted tests; callers still supply only a known client identifier. */
export function createMacClientLifecycle(host: MacLifecycleHost = nativeMacLifecycleHost) {
  const ownExecutable = () => { try { return ownRealpath(host.ownExecutable()); } catch { return host.ownExecutable(); } };
  const assertOwner = () => { if (!Number.isInteger(host.uid()) || host.uid() < 0 || !Number.isInteger(host.pid()) || host.pid() <= 0) throw new MacLifecycleError('无法确认当前 macOS 用户身份'); };
  async function jxa(mode: 'list' | 'close' | 'terminal', target?: ClientTarget, process?: ClientProcess, terminal?: string, command?: string): Promise<any> {
    assertOwner();
    try {
      const raw = await host.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', mode === 'terminal' ? terminalScript : processScript, JSON.stringify({ mode, target, process, ownerUid: host.uid(), ownerPid: host.pid(), terminal, command })]);
      return JSON.parse(raw.trim());
    } catch (error) {
      if (mode === 'terminal') throw new MacLifecycleError((error as { automationDenied?: boolean })?.automationDenied ? 'macOS 未允许控制 Terminal，请在“系统设置 → 隐私与安全性 → 自动化”中允许此应用控制终端，或自行打开新终端' : '无法在 Terminal 中打开新窗口，请检查自动化权限或自行打开新终端');
      throw new MacLifecycleError('无法核对或强制结束 macOS 客户端，请检查系统权限后重试');
    }
  }
  async function resolveTarget(agentId: string, definition: MacClientDefinition, detected: AgentDetection): Promise<ClientTarget | null> {
    const isolated = host.isolatedHome();
    if (detected.command && !safePath(detected.command)) throw new MacLifecycleError('检测到的客户端路径无效');
    if (detected.command && isolated) {
      let real: string; try { real = ownRealpath(detected.command); } catch { return null; }
      if (!inside(ownRealpath(isolated), real)) throw new MacLifecycleError('检测到的客户端路径超出当前隔离目录');
    }
    if (definition.kind === 'cli') {
      if (!detected.command) return null;
      if (!definition.binaries.includes(path.basename(detected.command))) throw new MacLifecycleError('检测到的命令与此客户端不匹配');
      try {
        const executable = ownRealpath(detected.command);
        fs.accessSync(executable, fs.constants.X_OK);
        if (executable === ownExecutable()) throw new MacLifecycleError('不能把云汇自身作为命令行客户端启动');
        const target = { agentId, kind: definition.kind, executable, identity: '' };
        target.identity = identity(target); return target;
      } catch (error) { throw error instanceof MacLifecycleError ? error : new MacLifecycleError('命令行客户端不存在或没有执行权限，请重新安装'); }
    }
    if (definition.kind !== 'desktop') return null;
    const roots = isolated ? [path.join(isolated, 'Applications')] : ['/Applications', path.join(host.home(), 'Applications')];
    const candidates = detected.command ? [detected.command] : definition.binaries.flatMap(name => roots.map(root => path.join(root, name + '.app')));
    for (const candidate of candidates) {
      let application: MacApplication | null;
      try { application = host.resolveApplication(candidate); }
      catch { throw new MacLifecycleError('无法验证客户端应用包，请检查 Info.plist、主程序与执行权限，或重新安装'); }
      if (!application) continue;
      const bundleName = path.basename(application.bundlePath).replace(/\.app$/i, '');
      if (!definition.binaries.some(name => name.toLowerCase() === bundleName.toLowerCase())) throw new MacLifecycleError('检测到的应用包与此客户端不匹配，请选择正确的客户端');
      if (!application.bundleId || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(application.bundleId)) throw new MacLifecycleError('应用包缺少有效的 CFBundleIdentifier，不能安全重启');
      if (application.executable === ownExecutable()) throw new MacLifecycleError('此应用包是云汇自身，不能作为外部客户端重新启动');
      if (isolated && !inside(ownRealpath(isolated), application.bundlePath)) throw new MacLifecycleError('客户端应用包指向隔离目录之外，已停止操作');
      const target: ClientTarget = { agentId, kind: definition.kind, executable: application.executable, bundlePath: application.bundlePath, bundleId: application.bundleId, identity: '' };
      target.identity = identity(target); return target;
    }
    return null;
  }
  function validateTarget(target: ClientTarget): boolean {
    try { fs.accessSync(target.executable, fs.constants.X_OK); return target.executable !== ownExecutable() && identity(target) === target.identity; } catch { return false; }
  }
  async function listProcesses(target: ClientTarget): Promise<{ processes: ClientProcess[]; uncertain: boolean }> {
    if (!target.bundlePath || !target.bundleId) throw new MacLifecycleError('缺少客户端应用包身份');
    const result = await jxa('list', target);
    if (!Array.isArray(result?.processes) || typeof result.uncertain !== 'boolean') throw new MacLifecycleError('macOS 返回的应用进程信息不完整');
    let uncertain = result.uncertain;
    const processes = result.processes.filter((entry: ClientProcess & { bundlePath?: string; bundleId?: string }) => {
      if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.started !== 'string' || !/^\d+(?:\.\d+)?\|.{1,100}$/.test(entry.started) || entry.ownerSid !== 'uid:' + host.uid() || entry.bundlePath !== target.bundlePath || entry.bundleId !== target.bundleId || entry.executable !== target.executable || entry.sessionId !== 0 || typeof entry.protected !== 'boolean') { uncertain = true; return false; }
      return true;
    });
    return { processes, uncertain };
  }
  async function closeProcess(target: ClientTarget, process: ClientProcess): Promise<'requested' | 'gone' | 'blocked' | 'changed'> {
    if (!validateTarget(target) || process.ownerSid !== 'uid:' + host.uid() || process.executable !== target.executable || process.protected || process.pid === host.pid()) return 'changed';
    const result = await jxa('close', target, process);
    if (!['requested', 'gone', 'blocked', 'changed'].includes(result?.result)) throw new MacLifecycleError('macOS 未确认客户端强制结束请求');
    return result.result;
  }
  async function startDesktop(target: ClientTarget): Promise<void> {
    if (!target.bundlePath || !validateTarget(target)) throw new MacLifecycleError('客户端应用包已变化，请重新检测');
    try { await host.run('/usr/bin/open', ['-n', '-a', target.bundlePath]); }
    catch { throw new MacLifecycleError('macOS 未能启动客户端，请在 Finder 中检查应用包或系统安全提示'); }
  }
  async function openTerminal(target: ClientTarget, workingDirectory: string): Promise<void> {
    if (!validateTarget(target)) throw new MacLifecycleError('命令行客户端程序已变化，请重新检测');
    const terminal = host.terminalPath();
    if (!terminal) throw new MacLifecycleError('未找到 macOS 系统 Terminal，请自行打开终端');
    const isolated = host.isolatedHome(), environment = host.configurationEnvironment?.() || {}, configuration: Record<string, string | undefined> = {};
    // Terminal.app can already have a different environment from the app that
    // wrote the configuration. Bind only native directory overrides supported
    // by the adapters; never put API credentials or unrelated variables in shell history.
    if (target.agentId === 'codex-cli') configuration.CODEX_HOME = isolated ? path.join(isolated, '.codex') : environment.CODEX_HOME || path.join(host.home(), '.codex');
    if (target.agentId === 'claude-code') {
      const nativeHome = isolated || host.home(), selected = !isolated && environment.CLAUDE_CONFIG_DIR;
      // Setting CLAUDE_CONFIG_DIR changes the native global-file layout. The
      // adapter treats the default directory as ~/.claude.json, so unset a
      // stale Terminal override there and bind HOME only for the child process.
      configuration.HOME = nativeHome;
      configuration.CLAUDE_CONFIG_DIR = selected && path.resolve(selected) !== path.resolve(path.join(nativeHome, '.claude')) ? selected : undefined;
    }
    const result = await jxa('terminal', undefined, undefined, terminal, macTerminalCommand(target.executable, workingDirectory, configuration));
    if (result?.submitted !== true) throw new MacLifecycleError('Terminal 未确认新的启动命令，请检查新终端窗口');
  }
  return { resolveTarget, validateTarget, listProcesses, closeProcess, startDesktop, openTerminal };
}
