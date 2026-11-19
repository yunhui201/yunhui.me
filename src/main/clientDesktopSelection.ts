import fs from 'node:fs';
import path from 'node:path';
import type { AuroraStore } from '../core/store/index.js';
import { inspectCodingDesktop, type CodingDesktopDetection } from '../core/desktopDetection.js';
import { configureDesktopPath, detectReset, getAdapter, type AgentDetection } from '../core/agents/adapters.js';
import { loadState, saveState } from '../core/extensions/catalog.js';
import { extensionOperation } from '../core/extensions/operations.js';

export interface DesktopSelectionRuntime {
  platform: NodeJS.Platform;
  ownExecutable: string;
  choose(options: { title: string; properties: Array<'openFile'>; filters: Array<{ name: string; extensions: string[] }> }): Promise<{ canceled: boolean; filePaths: string[] }>;
  inspect?(candidate: string): CodingDesktopDetection;
  disconnect(): Promise<void>;
}
export interface DesktopSelectionResult { ok: boolean; canceled?: boolean; detected?: AgentDetection; message?: string }

/** Only the native file picker supplies paths. This operation never launches the selected program. */
export async function selectClientDesktop(store: AuroraStore, payload: unknown, runtime: DesktopSelectionRuntime): Promise<DesktopSelectionResult> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'agentId') || !['chatgpt-desktop', 'codex-desktop'].includes((payload as any).agentId))
    return { ok: false, message: '请选择 ChatGPT 桌面版；程序路径只能通过本机文件选择框指定。' };
  if (!['win32', 'darwin'].includes(runtime.platform)) return { ok: false, message: '选择桌面程序目前支持 Windows 和 macOS。' };
  return extensionOperation(store, async () => {
    const picked = await runtime.choose({ title: runtime.platform === 'darwin' ? '选择 ChatGPT / Codex 的 .app 应用包' : '选择 ChatGPT / Codex 桌面主程序',
      properties: ['openFile'], filters: [{ name: runtime.platform === 'darwin' ? '应用程序' : '桌面程序', extensions: [runtime.platform === 'darwin' ? 'app' : 'exe'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    const selected = picked.filePaths[0];
    if (!path.isAbsolute(selected) || /[\u0000-\u001f]/.test(selected)) return { ok: false, message: '请选择有效的本机程序路径。' };
    if (runtime.platform === 'darwin' ? !/\.app$/i.test(selected) : !/\.exe$/i.test(selected)) return { ok: false, message: runtime.platform === 'darwin' ? '请选择完整的 .app 应用包，不要选择内部辅助程序。' : '请选择桌面客户端的 .exe 主程序。' };
    let inspected: CodingDesktopDetection;
    try {
      inspected = (runtime.inspect || inspectCodingDesktop)(selected);
      const identity = (file: string) => { const real = fs.realpathSync(file); return runtime.platform === 'win32' ? real.toLowerCase() : real; };
      if (inspected.executable && identity(inspected.executable) === identity(runtime.ownExecutable))
        return { ok: false, message: '选中的是云汇自身，请选择独立的 ChatGPT / Codex 桌面程序。' };
    } catch { return { ok: false, message: '无法读取所选程序的安装资源，请选择安装完整的桌面主程序。' }; }
    if (!inspected.installed || !inspected.exePath) return { ok: false, message: '所选路径不是可识别的桌面安装，请选择完整客户端的主程序。' };
    const state = loadState(store);
    const nextPath = inspected.exePath;
    if (state.connection.exePath !== nextPath) {
      try {
        await runtime.disconnect();
        saveState(store, { ...state, connection: { ...state.connection, exePath: nextPath, lastVersion: undefined } });
      } catch { return { ok: false, message: '程序路径未能保存，请检查云汇数据目录权限后重试。客户端配置未改动；桌面增强连接可能已断开，可重新连接。' }; }
    }
    configureDesktopPath(nextPath); detectReset();
    const detected: AgentDetection = { installed: inspected.installed, configured: false, command: inspected.executable,
      version: inspected.version, productName: inspected.productName, supportsCodexConfig: inspected.supportsCodexConfig,
      evidence: inspected.evidence, detectionError: inspected.detectionError };
    try { const files = getAdapter('chatgpt-desktop')!.configPaths(); detected.configPath = files[0]; detected.configured = files.some(file => fs.existsSync(file)); } catch { /* Resource identity is still available for the wizard. */ }
    return { ok: true, detected, message: inspected.supportsCodexConfig ? '已选择并识别桌面程序，请预览后再应用配置。' : '程序路径已保存，但尚未确认编程配置能力；未应用客户端配置。' };
  });
}
