import { spawn } from 'node:child_process';
import type { CodingDesktopDetection } from './desktopDetection.js';
import { runningCodingClients, runningCodingClientsSync } from './clientProcesses.js';
import { detectDesktopAsync } from './agents/detectionAsync.js';
import { launchWindowsPackagedDesktop } from './windowsPackagedLaunch.js';
export { detectCodingDesktop, inspectCodingDesktop, resolveMacApplication } from './desktopDetection.js';
export type { CodingDesktopDetection, DesktopDetectionOptions, MacApplication } from './desktopDetection.js';

export function isCodexRunning(exePath?: string): boolean {
  return runningCodingClientsSync(exePath ? [exePath] : []).length > 0;
}
export function validateDebugPort(value: unknown): number {
  const port = Number(value); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('调试端口必须是 1024–65535 的整数'); return port;
}
export async function debugPortOpen(port = 9222): Promise<boolean> {
  validateDebugPort(port);
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200), redirect: 'error' })).ok; } catch { return false; }
}
export interface CodexDesktopInfo extends CodingDesktopDetection {
  running: boolean; debugPortOpen: boolean; versionChanged: boolean; lastVersion?: string; message?: string;
}
export async function desktopInfo(lastVersion?: string, exePath?: string, port = 9222, fresh = false): Promise<CodexDesktopInfo> {
  const detected = await detectDesktopAsync(exePath, fresh);
  const [processes, open] = await Promise.all([runningCodingClients(detected.executable ? [detected.executable] : []), debugPortOpen(port)]);
  const running = processes.length > 0;
  return { ...detected, running, debugPortOpen: open, lastVersion, versionChanged: !!(lastVersion && detected.version && lastVersion !== detected.version),
    message: detected.detectionError || (!detected.installed ? '没有找到 ChatGPT 桌面版，可指定程序路径。' : !detected.supportsCodexConfig ? '尚未从安装资源确认编程桌面能力；连接时将检测实际页面。旧聊天客户端不支持 Codex 配置。' : running && !open ? '客户端正在运行但没有开启调试端口，请完全退出后使用启动并连接。' : undefined) };
}

export type BridgeHandler = (route: string, payload: any) => Promise<any>;
export class DesktopCdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private scriptIds: string[] = [];
  private bridge?: BridgeHandler;
  private contexts = new Map<number, { frameId: string; isDefault: boolean }>();
  private mainFrameId = '';
  private mainFrameUrl = '';
  private frameGeneration = 0;
  private binding = `__auroraBridge_${Math.random().toString(36).slice(2)}`;
  connected = true;
  private constructor(private ws: WebSocket, public readonly target: { title: string; url: string }) {
    ws.addEventListener('message', e => { void this.message(String(e.data)); });
    ws.addEventListener('close', () => this.rejectPending());
  }
  private rejectPending(): void {
    this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('桌面连接已断开')); }
    this.pending.clear();
  }
  static async connect(port: number, surface: 'main' | 'avatar' = 'main', timeoutMs = 15_000): Promise<DesktopCdp> {
    validateDebugPort(port);
    const deadline = performance.now() + Math.max(1, timeoutMs);
    const remaining = (limit: number) => {
      const budget = Math.ceil(deadline - performance.now());
      if (budget <= 0) throw new Error('桌面页面连接超时，请等待客户端完成启动后重新连接');
      return Math.min(limit, budget);
    };
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(remaining(3000)), redirect: 'error' });
    if (!response.ok) throw new Error('无法读取桌面调试目标');
    const list: any = await response.json();
    if (!Array.isArray(list)) throw new Error('调试目标返回格式无效');
    const isAvatar = (url: string) => /avatar-overlay|initialRoute=(?:%2F|\/)avatar/i.test(url);
    for (const page of list.filter(t => t.type === 'page' && /^app:\/\/-\//i.test(t.url || '') && (surface === 'avatar' ? isAvatar(t.url) : !isAvatar(t.url)))) {
      if (!page.webSocketDebuggerUrl) continue;
      let target: URL;
      try { target = new URL(page.webSocketDebuggerUrl); } catch { continue; }
      if (target.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || Number(target.port) !== port || target.username || target.password) continue;
      const socketTimeout = remaining(5000);
      const ws = new WebSocket(target.href);
      try {
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 连接超时')); }, socketTimeout); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); ws.close(); reject(new Error('CDP 连接失败')); }, { once: true }); });
      } catch (error) { ws.close(); if (performance.now() >= deadline) throw error; continue; }
      const cdp = new DesktopCdp(ws, { title: page.title || '', url: page.url });
      try {
        const identityResult = await cdp.send('Runtime.evaluate', { expression: '({app:location.href,top:window===top,bridge:!!window.electronBridge})', returnByValue: true }, remaining(5000));
        const identity = identityResult?.result?.value;
        if (identity?.top && identity.bridge && /^app:\/\/-\//i.test(identity.app)) {
          const frame = (await cdp.send('Page.getFrameTree', {}, remaining(5000))).frameTree?.frame;
          if (!frame?.id || !/^app:\/\/-\//i.test(frame.url || '')) { cdp.close(); continue; }
          cdp.mainFrameId = frame.id; cdp.mainFrameUrl = frame.url;
          await cdp.send('Runtime.enable', {}, remaining(5000)); await cdp.send('Page.enable', {}, remaining(5000)); return cdp;
        }
        cdp.close();
      } catch (error) {
        cdp.close();
        // A page can disappear during startup. Still inspect other compatible
        // targets within the same budget instead of repeatedly choosing it.
        if (performance.now() >= deadline) throw error;
      }
    }
    throw new Error('未找到兼容的 ChatGPT/Codex 桌面页面（需要 app://-/ 与 electronBridge），没有注入其他浏览器页面');
  }
  send(method: string, params: any = {}, timeoutMs = method === 'Runtime.evaluate' ? 45_000 : 15_000): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('桌面连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '桌面脚本执行失败');
    return result.result?.value;
  }
  private async message(raw: string): Promise<void> {
    try {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id)!; clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || 'CDP 请求失败')) : p.resolve(msg.result); return; }
      if (msg.method === 'Runtime.executionContextCreated') { const ctx = msg.params?.context; if (ctx?.id) this.contexts.set(ctx.id, { frameId: ctx.auxData?.frameId || '', isDefault: ctx.auxData?.isDefault === true }); return; }
      if (msg.method === 'Runtime.executionContextDestroyed') { this.contexts.delete(msg.params?.executionContextId); return; }
      if (msg.method === 'Runtime.executionContextsCleared') { this.contexts.clear(); this.frameGeneration++; return; }
      if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) { this.mainFrameId = msg.params.frame.id; this.mainFrameUrl = msg.params.frame.url || ''; this.frameGeneration++; return; }
      if (msg.method === 'Page.frameStartedLoading' && msg.params?.frameId === this.mainFrameId) { this.frameGeneration++; return; }
      if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== this.binding || !this.bridge) return;
      if (typeof msg.params.payload !== 'string' || msg.params.payload.length > 37_000_000) return;
      const request = JSON.parse(msg.params.payload);
      if (!request || typeof request.id !== 'string' || request.id.length > 120 || typeof request.route !== 'string' || request.route.length > 128 || (request.route !== '/dictation/transcribe' && msg.params.payload.length > 2_000_000)) return;
      const contextId = msg.params.executionContextId;
      const context = this.contexts.get(contextId);
      if (!context?.isDefault || context.frameId !== this.mainFrameId || !/^app:\/\/-\//i.test(this.mainFrameUrl)) return;
      const generation = this.frameGeneration;
      const identity = await this.send('Runtime.evaluate', { contextId, expression: '({app:location.href,top:window===top,bridge:!!window.electronBridge})', returnByValue: true });
      const verified = identity?.result?.value;
      if (generation !== this.frameGeneration || !this.contexts.has(contextId) || !verified?.top || !verified.bridge || !/^app:\/\/-\//i.test(verified.app || '')) return;
      let reply: any;
      try { reply = { id: request.id, value: await this.bridge(request.route, request.payload || {}) }; }
      catch (e) { reply = { id: request.id, error: (e as Error).message }; }
      await this.send('Runtime.evaluate', { expression: `window.__auroraBridgeResolve?.(${JSON.stringify(reply)})`, contextId: msg.params.executionContextId }).catch(() => {});
    } catch { /* Ignore malformed peer messages. */ }
  }
  async setBridge(handler: BridgeHandler): Promise<string> {
    this.bridge = handler; await this.send('Runtime.addBinding', { name: this.binding });
    return `(() => { if(window!==top||!/^app:\\/\\/-\\//i.test(location.href))return; const pending=new Map(); let seq=0; window.__auroraBridgeResolve=(r)=>{const p=pending.get(r.id);if(!p)return;clearTimeout(p.timer);pending.delete(r.id);r.error?p.reject(new Error(r.error)):p.resolve(r.value)};window.__codexSessionDeleteBridge=(route,payload)=>new Promise((resolve,reject)=>{const id=Date.now()+':'+(++seq);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('云汇桌面桥接超时'))},route==='/plugin-market/list'&&payload?.refresh===true?130000:30000);pending.set(id,{resolve,reject,timer});window[${JSON.stringify(this.binding)}](JSON.stringify({id,route,payload}));}); })();`;
  }
  async updateDocumentSource(source: string): Promise<void> {
    for (const identifier of this.scriptIds.splice(0)) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    const registered = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }); this.scriptIds.push(registered.identifier);
  }
  async replaceScripts(source: string, reload = false): Promise<void> {
    await this.updateDocumentSource(source);
    if (reload) await this.send('Page.reload', { ignoreCache: false }); else await this.evaluate(source);
  }
  async dispose(reload = true): Promise<void> {
    if (this.connected) { for (const identifier of this.scriptIds.splice(0)) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {}); await this.send('Runtime.removeBinding', { name: this.binding }).catch(() => {}); if (reload) await this.send('Page.reload', { ignoreCache: false }).catch(() => {}); } this.close();
  }
  close(): void { this.rejectPending(); this.ws.close(); }
}
export function desktopDebugLaunch(detected: CodingDesktopDetection, port: number, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  validateDebugPort(port);
  if (!detected.installed || !detected.executable) throw new Error('未找到桌面程序，请先指定程序路径');
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  if (platform === 'darwin') {
    if (!detected.bundlePath) throw new Error('macOS 桌面增强需要完整的 .app 应用包');
    if (!detected.supportsCodexConfig) throw new Error('此 macOS 客户端尚未确认支持编程桌面增强；原生聊天版不提供所需的 Electron 调试接口');
    return { command: '/usr/bin/open', args: ['-n', '-a', detected.bundlePath, '--args', ...args] };
  }
  if (platform !== 'win32') throw new Error('桌面增强自动启动目前支持 Windows 和 macOS');
  return { command: detected.executable, args };
}
/** Main-process dependencies for isolated tests; never accepted from renderer/IPC payloads. */
export interface DesktopConnectionRuntime {
  platform: NodeJS.Platform;
  detect: typeof detectDesktopAsync;
  running: (paths: string[]) => Promise<unknown[]>;
  portOpen: (port: number) => Promise<boolean>;
  launchPackaged: (executable: string, port: number) => Promise<{ packaged: boolean; pid?: number }>;
  launchProcess: (command: string, args: string[]) => Promise<void>;
  connect: (port: number, timeoutMs?: number) => Promise<DesktopCdp>;
  delay: (ms: number) => Promise<void>;
  now: () => number;
}
const desktopConnectionRuntime: DesktopConnectionRuntime = {
  platform: process.platform, detect: detectDesktopAsync, running: runningCodingClients,
  portOpen: debugPortOpen, launchPackaged: launchWindowsPackagedDesktop,
  async launchProcess(command, args) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('无法启动桌面客户端，请确认程序仍已安装并重新选择程序'))); });
    child.unref();
  },
  connect: (port, timeoutMs) => DesktopCdp.connect(port, 'main', timeoutMs),
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => performance.now(),
};
export async function openDesktopConnection(options: { port: number; exePath?: string; launch?: boolean }, runtime: Partial<DesktopConnectionRuntime> = {}): Promise<{ cdp: DesktopCdp; launched: boolean }> {
  const rt = { ...desktopConnectionRuntime, ...runtime };
  const port = validateDebugPort(options.port); let launched = false;
  if (!await rt.portOpen(port)) {
    if (!options.launch) throw new Error('调试端口未开启，请完全退出客户端后选择启动并连接');
    const d = await rt.detect(options.exePath, true);
    if (!d.executable) throw new Error(d.detectionError || '未找到桌面程序，请先指定程序路径');
    if ((await rt.running([d.executable])).length) throw new Error('客户端正在运行且未开启调试端口，请完全退出后重试');
    const launch = desktopDebugLaunch(d, port, rt.platform);
    // Store/MSIX applications require their registered package identity. Activation
    // failures must propagate: a raw EXE fallback reproduces APPMODEL_ERROR_NO_PACKAGE.
    const packaged = rt.platform === 'win32' && (await rt.launchPackaged(d.executable, port)).packaged;
    if (!packaged) await rt.launchProcess(launch.command, launch.args);
    launched = true;
    const readyDeadline = rt.now() + 30_000;
    let ready = false;
    while (rt.now() < readyDeadline) {
      if (await rt.portOpen(port)) { ready = true; break; }
      await rt.delay(Math.min(500, Math.max(0, readyDeadline - rt.now())));
    }
    if (!ready) throw new Error('客户端已收到启动请求，但调试端口未开启。请等待启动完成；若仍未连接，请完全退出客户端，再点击“启动并连接”。');
  }
  const connectDeadline = rt.now() + 15_000;
  let last: unknown;
  do {
    try { return { cdp: await rt.connect(port, Math.max(1, Math.ceil(connectDeadline - rt.now()))), launched }; }
    catch (error) { last = error; }
    if (!launched || rt.now() >= connectDeadline) break;
    await rt.delay(Math.min(500, Math.max(0, connectDeadline - rt.now())));
  } while (rt.now() < connectDeadline);
  const detail = last instanceof Error ? last.message : '';
  if (detail && !/fetch failed|network|aborted|timed?\s*out/i.test(detail)) throw last;
  throw new Error('无法连接客户端调试服务，请确认客户端已完成启动，再点击“重新连接”；若客户端已退出，请选择“启动并连接”。');
}
export interface InjectResult { ok: boolean; message: string; launched?: boolean; injected?: number }
export async function launchAndInject(scripts: Array<{ id: string; name: string; code: string; enabled: boolean }>, port = 9222): Promise<InjectResult> {
  let cdp: DesktopCdp | undefined;
  try { const opened = await openDesktopConnection({ port, launch: true }); cdp = opened.cdp; const active = scripts.filter(s => s.enabled && s.code.trim()); for (const s of active) await cdp.evaluate(s.code); return { ok: true, launched: opened.launched, injected: active.length, message: `已执行 ${active.length} 个自定义脚本` }; }
  catch (e) { return { ok: false, message: (e as Error).message }; } finally { cdp?.close(); }
}
export async function injectorStatus(): Promise<{ portOpen: boolean; running: boolean; installed: boolean }> { const info = await desktopInfo(); return { portOpen: info.debugPortOpen, running: info.running, installed: info.installed }; }
export const BUILTIN_INJECT_SCRIPTS: Array<{ id: string; name: string; enabled: boolean; code: string }> = [];
