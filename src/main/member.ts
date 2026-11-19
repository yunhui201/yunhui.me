import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuroraStore } from '../core/store/index.js';

const endpoint = 'https://yunhui.me/member.php';
let sessionToken = '';
let sessionRevision = 0;
let restored = false;
let busy = false;
let maintenanceRunning = false;
let stopMaintenance: (() => void) | undefined;
let installationIdentity: { id: string; proof: string } | undefined;
class MemberSessionExpired extends Error {
  constructor() { super('登录已过期，请重新登录。'); }
}
class MemberSessionChanged extends Error {
  constructor() { super('会员登录状态已变化，请重新读取当前账号信息。'); }
}

function installation(allowCreate = true) {
  // Maintenance can use only an existing encrypted installation identity. It
  // must never generate an identity or migrate legacy files in the background.
  const file = path.join(app.getPath('userData'), 'member-installation.enc');
  if (!allowCreate && !fs.existsSync(file)) throw new Error('会员安装凭据尚未就绪');
  if (installationIdentity) return installationIdentity;
  if (!protectedStorage()) throw new Error('系统安全存储暂不可用，无法安全绑定会员安装凭据。');
  const legacy = path.join(app.getPath('userData'), 'member-installation.json');
  const validate = (saved: any): { id: string; proof: string } => {
    if (!/^[a-f\d-]{36}$/.test(saved?.id) || !/^[a-f\d]{64}$/.test(saved?.proof)) throw new Error('会员安装凭据损坏，请恢复本机备份。');
    return { id: saved.id, proof: saved.proof };
  };
  if (fs.existsSync(file)) {
    try { installationIdentity = validate(JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))); return installationIdentity; }
    catch { throw new Error('无法解密会员安装凭据，请使用原系统账户或恢复本机备份。'); }
  }
  // The ID and proof have the same lifetime. A lost proof must never strand a reused hardware ID.
  const record = fs.existsSync(legacy) ? validate(JSON.parse(fs.readFileSync(legacy, 'utf8'))) : { id: randomUUID(), proof: randomBytes(32).toString('hex') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(record)), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  installationIdentity = record;
  return record;
}
function protectedStorage() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
function sessionFile() { return path.join(app.getPath('userData'), 'member-session.enc'); }
function restoreSession() {
  if (restored) return;
  try {
    if (!protectedStorage()) return;
    restored = true;
    const saved = safeStorage.decryptString(fs.readFileSync(sessionFile()));
    sessionToken = /^[a-f\d]{64}$/.test(saved) ? saved : '';
  } catch { sessionToken = ''; }
}
function saveSession(token: string) {
  sessionRevision++;
  sessionToken = token;
  if (token && protectedStorage()) {
    const temporary = `${sessionFile()}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, safeStorage.encryptString(token), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, sessionFile());
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  else if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
}
type BackgroundRequest = { signal: AbortSignal; active: () => boolean };
async function request(action: string, payload: any = {}, background?: BackgroundRequest) {
  restoreSession();
  const sentToken = sessionToken, sentRevision = sessionRevision;
  const authenticated = ['status', 'groups', 'claim', 'create-client-key'].includes(action);
  const assertCurrentSession = () => {
    if (background && (background.signal.aborted || !background.active())) throw new MemberSessionChanged();
    if (authenticated && (sentToken !== sessionToken || sentRevision !== sessionRevision)) throw new MemberSessionChanged();
  };
  const device = action === 'config' ? null : installation(!background);
  const timeout = AbortSignal.timeout(['claim', 'create-client-key'].includes(action) ? 120000 : authenticated ? 90000 : 35000);
  const response = await fetch(`${endpoint}?a=${encodeURIComponent(action)}`, {
    // The server may rotate upstream credentials and verify identity before an
    // authenticated operation. No client-side replay of key/credit writes occurs.
    method: action === 'config' || action === 'status' ? 'GET' : 'POST', redirect: 'error', signal: background ? AbortSignal.any([timeout, background.signal]) : timeout,
    headers: { 'content-type': 'application/json', ...(device ? { 'X-Aurora-Installation': device.id, 'X-Aurora-Installation-Proof': device.proof } : {}), ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}) },
    ...(['config', 'status'].includes(action) ? {} : { body: JSON.stringify(payload) }),
  });
  assertCurrentSession();
  // A proxy may return an HTML 401; expiration must not depend on JSON parsing.
  if (response.status === 401 && authenticated && !background) {
    saveSession('');
    throw new MemberSessionExpired();
  }
  const body = await response.text();
  assertCurrentSession();
  if (body.length > 1024 * 1024) throw new Error('会员服务响应异常');
  let data: any;
  try { data = JSON.parse(body); } catch { throw new Error(`会员服务暂不可用（HTTP ${response.status}）`); }
  if (!response.ok || data.ok === false || data.error) {
    if (authenticated && ['SESSION_EXPIRED', 'AUTH_REJECTED'].includes(data.code)) { saveSession(''); throw new MemberSessionExpired(); }
    throw new Error(typeof data.error === 'string' ? data.error : data.message || `会员服务暂不可用（HTTP ${response.status}）`);
  }
  if (data.sessionToken) {
    if (!['login', 'login2fa', 'bind'].includes(action)) throw new Error('会员服务返回了意外的登录凭据，请重试');
    if (typeof data.sessionToken !== 'string' || !/^[a-f\d]{64}$/.test(data.sessionToken)) throw new Error('会员服务返回的登录凭据无效');
    saveSession(data.sessionToken);
  }
  // The renderer never receives the membership session token.
  const { sessionToken: _token, accessToken: _access, refreshToken: _refresh,
    session_token: _legacyToken, access_token: _legacyAccess, refresh_token: _legacyRefresh, ...publicData } = data;
  return publicData;
}

/** Keep an existing login alive without opening the membership page or issuing writes. */
export function startMemberSessionMaintenance(options: { initialDelayMs?: number; intervalMs?: number } = {}): () => void {
  stopMaintenance?.();
  const interval = Math.max(1, options.intervalMs ?? 15 * 60_000);
  const initialDelay = Math.max(0, options.initialDelayMs ?? 5_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
    if (stopMaintenance === stop) stopMaintenance = undefined;
  };
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref();
  };
  const tick = async () => {
    try {
      if (stopped || busy || maintenanceRunning) return;
      restoreSession();
      if (!sessionToken || !protectedStorage()) return;
      // Do not manufacture a session from cached or plaintext state. A deleted,
      // corrupted or unavailable encrypted credential simply disables this tick.
      if (safeStorage.decryptString(fs.readFileSync(sessionFile())) !== sessionToken) return;
      installation(false);
      maintenanceRunning = true;
      controller = new AbortController();
      try {
        await request('status', {}, { signal: controller.signal, active: () => !stopped });
      } finally { maintenanceRunning = false; controller = undefined; }
    } catch {
      // Network, proxy, server-busy and malformed responses retain credentials.
      // Only explicit, current-session authentication errors clear them in request().
    } finally { schedule(interval); }
  };
  stopMaintenance = stop;
  schedule(initialDelay);
  return stop;
}

export async function memberAction(store: AuroraStore, action: string, payload: any): Promise<any> {
  restoreSession();
  if (action === 'member.status') {
    const config = await request('config');
    if (!sessionToken || config.enabled === false) return { ok: true, loggedIn: false, config };
    const expectedToken = sessionToken, expectedRevision = sessionRevision;
    try {
      const result = await request('status');
      if (expectedToken !== sessionToken || expectedRevision !== sessionRevision) throw new MemberSessionChanged();
      return { ok: true, loggedIn: true, config, ...result };
    }
    catch (error: any) { if (!sessionToken) return { ok: true, loggedIn: false, config, message: '登录已过期，请重新登录。' }; throw error; }
  }
  if (busy) throw new Error('会员操作正在处理，请稍候');
  busy = true;
  try {
    if (action === 'member.login') return await request('login', { email: String(payload.email || '').trim(), password: String(payload.password || ''), turnstile_token: payload.turnstileToken });
    if (action === 'member.login2fa') return await request('login2fa', { tempToken: payload.tempToken, totpCode: payload.code });
    if (action === 'member.bind') return await request('bind', { accessToken: String(payload.accessToken || '') });
    if (action === 'member.groups') return await request('groups');
    if (action === 'member.claim') return await request('claim');
    if (action === 'member.logout') {
      let revoked = true;
      try { if (sessionToken) await request('logout'); } catch { revoked = false; } finally { saveSession(''); }
      return { ok: true, ...(revoked ? {} : { message: '本机已退出登录；服务器暂不可用，远端会话将在到期后失效。' }) };
    }
    if (action === 'member.addProvider') {
      const result = await request('create-client-key', { groupId: payload.groupId });
      const key = result.apiKey || result.key;
      if (typeof key !== 'string' || !key) throw new Error('会员服务没有返回客户端 API Key');
      const baseUrl = new URL(result.baseUrl);
      const formats: Record<string, string> = { openai: 'openai-responses', anthropic: 'anthropic', gemini: 'gemini', deepseek: 'openai-chat', grok: 'openai-chat' };
      if (baseUrl.origin !== 'https://api.yunhui.me' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
        || !formats[result.group?.platform] || formats[result.group.platform] !== result.format || !Number.isSafeInteger(result.memberId) || result.memberId < 1
        || !Number.isSafeInteger(result.group?.id) || result.group.id < 1
        || (payload.groupId !== undefined && result.group.id !== payload.groupId)) throw new Error('会员供应商地址、分组或协议无效');
      // Different members must never share a provider's key rotation pool.
      const presetId = `yunhui-member-${result.memberId}-group-${result.group.id}`;
      const previous = store.listProviders().find(p => p.presetId === presetId);
      const apiKeys = (previous?.apiKeys || []).map(k => k.key === key ? { ...k, enabled: true } : { ...k });
      if (!apiKeys.some(k => k.key === key)) apiKeys.push({ id: randomUUID(), label: '会员客户端密钥', key, enabled: true, weight: 1 });
      const provider = store.saveProvider({ ...previous, name: `云汇 · ${result.group?.name || '会员服务'}`, presetId, format: result.format, baseUrl: result.baseUrl, models: previous?.models || [], enabled: true, apiKeys });
      return { ok: true, providerId: provider.id, message: '云汇供应商已添加。选择你的客户端即可继续配置。' };
    }
    throw new Error('未知会员操作');
  } catch (error) {
    // Electron's generic error boundary only retains a message. Return explicit
    // public session state so the renderer cannot keep a stale logged-in view.
    if (error instanceof MemberSessionExpired) return { ok: false, loggedIn: false, authExpired: true, code: 'SESSION_EXPIRED', message: error.message };
    throw error;
  } finally { busy = false; }
}
