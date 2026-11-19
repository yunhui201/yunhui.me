import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-member-client-')));
const require = createRequire(import.meta.url);
const bundle = path.join(isolated, 'member-client.cjs');
const originalFetch = globalThis.fetch;
let passed = 0;
await build({
  stdin: { contents: `export * from './src/main/member.ts'; export { AuroraStore } from './src/core/store/index.ts';`, resolveDir: workspace, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'isolated-electron', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'member-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'member-test' }, () => ({ contents: 'export const app = globalThis.__memberElectron.app; export const safeStorage = globalThis.__memberElectron.safeStorage;', loader: 'js' }));
  } }],
});

function freshApi() { delete require.cache[require.resolve(bundle)]; return require(bundle); }
function fixture(label) {
  const directory = path.join(isolated, label); fs.mkdirSync(directory, { recursive: true });
  const encryptionKey = randomBytes(32);
  const control = { secure: true, activeUser: 1, expired: '', expiredHtml: false, offlineConfig: false, ambiguousClaim: false, disabled: false, offlineLogout: false, alterKey: null, requests: [],
    campaign: { giftEnabled: true, giftUsd: 5, currency: 'USD', giftMessage: 'Fixture campaign', giftPolicyRevision: 'policy-five' }, giftRecord: null };
  const currentGift = () => control.giftRecord || { status: control.campaign.giftEnabled ? 'eligible' : 'disabled', amountUsd: control.campaign.giftUsd };
  const safeStorage = {
    isEncryptionAvailable: () => control.secure, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decryptString(value) { const bytes = Buffer.from(value); const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  };
  globalThis.__memberElectron = { app: { getPath: name => { assert.equal(name, 'userData'); return directory; } }, safeStorage };
  const groups = [
    { id: 7, name: 'OpenAI', platform: 'openai', supported: true },
    { id: 8, name: 'Claude', platform: 'anthropic', supported: true },
    { id: 9, name: 'Gemini', platform: 'gemini', supported: true },
    { id: 10, name: 'DeepSeek', platform: 'deepseek', supported: true },
    { id: 11, name: 'Grok', platform: 'grok', supported: true },
    { id: 12, name: 'Unknown', platform: 'future', supported: false },
  ];
  const formats = { openai: 'openai-responses', anthropic: 'anthropic', gemini: 'gemini', deepseek: 'openai-chat', grok: 'openai-chat' };
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://yunhui.me'); assert.equal(parsed.pathname, '/member.php'); assert.equal(options.redirect, 'error');
    const action = parsed.searchParams.get('a'); const body = options.body ? JSON.parse(options.body) : null;
    control.requests.push({ action, body, headers: { ...options.headers }, method: options.method });
    const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (control.expired === action) return control.expiredHtml ? new Response('<html>Unauthorized</html>', { status: 401 }) : respond({ ok: false, code: 'SESSION_EXPIRED', error: '登录已过期' }, 401);
    if (action === 'config') { if (control.offlineConfig) throw new Error('configuration unavailable'); return respond({ ok: true, enabled: !control.disabled, ...control.campaign }); }
    assert.match(options.headers['X-Aurora-Installation'], /^[a-f\d-]{36}$/); assert.match(options.headers['X-Aurora-Installation-Proof'], /^[a-f\d]{64}$/);
    if (['login', 'login2fa', 'bind'].includes(action)) {
      if (body.password === 'two-factor') return respond({ ok: true, requires2fa: true, tempToken: 'challenge-token', emailMasked: 'u***@test.invalid' });
      return respond({ ok: true, sessionToken: String(control.activeUser).repeat(64), accessToken: 'upstream-access-must-stay-private', refreshToken: 'upstream-refresh-must-stay-private', access_token: 'upstream-access-alias-private', refresh_token: 'upstream-refresh-alias-private', canRefresh: action !== 'bind', expiresAt: new Date(Date.now() + 3600000).toISOString(), member: { id: control.activeUser, email: 'u@test.invalid', balance: 0 }, gift: currentGift() });
    }
    assert.equal(options.headers.authorization, 'Bearer ' + String(control.activeUser).repeat(64));
    if (action === 'status') return respond({ ok: true, member: { id: control.activeUser, balance: control.giftRecord?.status === 'claimed' ? control.giftRecord.amountUsd : 0 }, gift: currentGift() });
    if (action === 'groups') return respond({ ok: true, groups });
    if (action === 'claim') {
      if (control.ambiguousClaim) throw new Error('response lost after request');
      if (!control.campaign.giftEnabled && !['pending', 'claimed'].includes(control.giftRecord?.status)) return respond({ ok: false, code: 'GIFT_UNAVAILABLE', message: '新客活动暂未开放' }, 409);
      control.giftRecord = { ...currentGift(), status: 'claimed', eligible: false, code: 'consumed-receipt' };
      return respond({ ok: true, member: { id: control.activeUser, balance: control.giftRecord.amountUsd }, gift: control.giftRecord });
    }
    if (action === 'logout') { if (control.offlineLogout) throw new Error('simulated network failure'); return respond({ ok: true }); }
    if (action === 'create-client-key') {
      const group = groups.find(g => g.id === body.groupId); assert(group);
      let value = { ok: true, memberId: control.activeUser, id: 123, apiKey: `sk-user-${control.activeUser}-group-${group.id}-private`, group, name: '云汇会员', format: formats[group.platform], baseUrl: 'https://api.yunhui.me' + (group.platform === 'gemini' ? '' : '/v1') };
      if (control.alterKey) value = control.alterKey(value);
      return respond(value);
    }
    throw new Error('Unexpected member action: ' + action);
  };
  const api = freshApi(); const store = new api.AuroraStore(path.join(directory, 'data'));
  return { api, store, control, directory, safeStorage, groups };
}
async function test(label, run) { await run(); passed++; console.log(`PASS ${label}`); }
const login = async f => f.api.memberAction(f.store, 'member.login', { email: ' user@test.invalid ', password: 'login-password-private' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert(Date.now() < deadline, message); await pause(5); }
}
const maintenance = f => f.api.startMemberSessionMaintenance({ initialDelayMs: 5, intervalMs: 20 });

try {
  await test('installation and session encrypted, credentials never reach renderer or backup', async () => {
    const f = fixture('encrypted'); const result = await login(f);
    assert(!('sessionToken' in result)); assert(!('accessToken' in result)); assert(!('refreshToken' in result));
    assert(!('access_token' in result)); assert(!('refresh_token' in result)); assert.equal(result.canRefresh, true);
    const req = f.control.requests.find(r => r.action === 'login'); assert.equal(req.body.email, 'user@test.invalid');
    const installation = fs.readFileSync(path.join(f.directory, 'member-installation.enc'));
    const persisted = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    for (const secret of [req.headers['X-Aurora-Installation-Proof'], req.headers['X-Aurora-Installation'], '1'.repeat(64), 'login-password-private']) {
      assert(!installation.includes(Buffer.from(secret))); assert(!persisted.includes(Buffer.from(secret))); assert(!JSON.stringify(f.store.exportAll()).includes(secret)); assert(!JSON.stringify(result).includes(secret));
    }
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.json')));
    assert.equal(f.safeStorage.decryptString(persisted), '1'.repeat(64));
    assert(!fs.readdirSync(f.directory).some(file => file.endsWith('.tmp')));
  });
  await test('restart preserves both installation proof and encrypted member session', async () => {
    const f = fixture('restart'); await login(f); const previous = f.control.requests.at(-1).headers;
    const fresh = freshApi(); const result = await fresh.memberAction(f.store, 'member.status', {});
    assert.equal(result.loggedIn, true); const current = f.control.requests.at(-1).headers;
    assert.equal(current['X-Aurora-Installation'], previous['X-Aurora-Installation']); assert.equal(current['X-Aurora-Installation-Proof'], previous['X-Aurora-Installation-Proof']);
  });
  await test('legacy plaintext installation migrates without changing identity', async () => {
    const f = fixture('legacy'); const old = { id: '12345678-1234-4321-abcd-123456789abc', proof: 'a'.repeat(64) };
    fs.writeFileSync(path.join(f.directory, 'member-installation.json'), JSON.stringify(old)); await login(f);
    assert.equal(f.control.requests.at(-1).headers['X-Aurora-Installation'], old.id); assert.equal(f.control.requests.at(-1).headers['X-Aurora-Installation-Proof'], old.proof);
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.json')));
  });
  await test('missing secure storage allows public status but prevents credential persistence', async () => {
    const f = fixture('unavailable'); f.control.secure = false;
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
    await assert.rejects(() => login(f), /安全存储/); assert.equal(f.control.requests.length, 1);
    assert(!fs.existsSync(path.join(f.directory, 'member-installation.enc')));
  });
  await test('claim authority fields are discarded before fixed server request', async () => {
    const f = fixture('claim'); await login(f);
    const identity = f.control.requests.at(-1).headers;
    const result = await f.api.memberAction(f.store, 'member.claim', {
      userId: 999, memberId: 999, value: 999, amountUsd: 999, giftUsd: 999, currency: 'EUR', giftEnabled: true, giftPolicyRevision: 'forged-policy',
      installationId: 'forged-installation', installationProof: 'forged-proof', sessionToken: 'forged-session', code: 'forged', origin: 'https://attacker.invalid',
      headers: { authorization: 'Bearer forged-session', 'X-Aurora-Installation': 'forged-installation', 'X-Aurora-Installation-Proof': 'forged-proof' },
    });
    const request = f.control.requests.at(-1);
    assert.equal(request.action, 'claim'); assert.equal(request.method, 'POST'); assert.deepEqual(request.body, {});
    assert.equal(request.headers.authorization, 'Bearer ' + '1'.repeat(64));
    for (const key of ['X-Aurora-Installation', 'X-Aurora-Installation-Proof']) assert.equal(request.headers[key], identity[key]);
    assert.equal(result.member.id, 1); assert.equal(result.gift.amountUsd, 5); assert(!JSON.stringify(result).includes('forged'));
  });
  await test('public campaign changes pass through without a fixed amount and authenticated refresh uses the latest policy', async () => {
    const f = fixture('dynamic-campaign');
    const publicStatus = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(publicStatus.loggedIn, false); assert.deepEqual(publicStatus.config, { ok: true, enabled: true, ...f.control.campaign });
    assert.equal(publicStatus.config.giftUsd, 5); assert(!fs.existsSync(path.join(f.directory, 'member-installation.enc')));
    const signedIn = await login(f); assert.equal(signedIn.gift.amountUsd, 5);
    const saved = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    f.control.campaign = { giftEnabled: true, giftUsd: 25.5, currency: 'USD', giftMessage: 'Changed campaign amount', giftPolicyRevision: 'policy-twenty-five-fifty' };
    const updated = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(updated.loggedIn, true); assert.deepEqual(updated.config, { ok: true, enabled: true, ...f.control.campaign });
    assert.equal(updated.gift.amountUsd, 25.5); assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), saved);
    const claimed = await f.api.memberAction(f.store, 'member.claim', {});
    assert.equal(claimed.gift.amountUsd, 25.5); assert.equal(claimed.member.balance, 25.5);
    assert.equal(f.control.requests.filter(request => request.action === 'claim').length, 1);
  });
  await test('closing gifts preserves membership login, groups and supplier setup while the server rejects a new grant', async () => {
    const f = fixture('campaign-closed'); f.control.campaign.giftEnabled = false; f.control.campaign.giftUsd = 20;
    const publicStatus = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(publicStatus.config.enabled, true); assert.equal(publicStatus.config.giftEnabled, false);
    assert((await login(f)).ok);
    const status = await f.api.memberAction(f.store, 'member.status', {});
    assert(status.loggedIn); assert.equal(status.config.giftEnabled, false); assert.equal(status.gift.status, 'disabled');
    assert.deepEqual((await f.api.memberAction(f.store, 'member.groups', {})).groups, f.groups);
    const added = await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    assert(added.ok); assert.equal(f.store.getProvider(added.providerId).format, 'openai-responses');
    const before = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    await assert.rejects(() => f.api.memberAction(f.store, 'member.claim', { giftEnabled: true, amountUsd: 500 }), /新客活动暂未开放/);
    assert.deepEqual(f.control.requests.at(-1).body, {}); assert.equal(f.control.giftRecord, null);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), before);
    assert((await f.api.memberAction(f.store, 'member.status', {})).loggedIn);
  });
  await test('pending and confirmed grants retain the original amount after a new policy closes new claims', async () => {
    const f = fixture('old-grant'); await login(f);
    f.control.giftRecord = { status: 'pending', eligible: false, amountUsd: 10, message: 'Original grant pending' };
    f.control.campaign = { giftEnabled: false, giftUsd: 20, currency: 'USD', giftMessage: 'New grants closed', giftPolicyRevision: 'closed-new-policy' };
    const pending = await f.api.memberAction(f.store, 'member.status', {});
    assert(pending.loggedIn); assert.equal(pending.config.giftEnabled, false); assert.equal(pending.config.giftUsd, 20);
    assert.equal(pending.gift.status, 'pending'); assert.equal(pending.gift.amountUsd, 10);
    const confirmed = await f.api.memberAction(f.store, 'member.claim', { amountUsd: 20, giftPolicyRevision: 'closed-new-policy' });
    assert.equal(confirmed.gift.status, 'claimed'); assert.equal(confirmed.gift.amountUsd, 10); assert.equal(confirmed.member.balance, 10);
    assert.deepEqual(f.control.requests.at(-1).body, {});
    f.control.campaign.giftUsd = 25.5;
    const refreshed = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(refreshed.config.giftUsd, 25.5); assert.equal(refreshed.gift.amountUsd, 10); assert.equal(refreshed.gift.status, 'claimed');
    assert.equal(f.control.requests.filter(request => request.action === 'claim').length, 1);
  });
  await test('review amounts and unknown amounts remain server-owned without a current-policy fallback', async () => {
    const f = fixture('unknown-grant'); await login(f); f.control.campaign.giftUsd = 25.5;
    f.control.giftRecord = { status: 'review', eligible: false, amountUsd: 7.5 };
    const review = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(review.config.giftUsd, 25.5); assert.equal(review.gift.amountUsd, 7.5); assert.equal(review.gift.status, 'review');
    delete f.control.giftRecord.amountUsd;
    const unknown = await f.api.memberAction(f.store, 'member.status', {}); assert.equal(unknown.gift.amountUsd, undefined);
    assert.equal(unknown.config.giftUsd, 25.5);
    f.control.giftRecord = null; delete f.control.campaign.giftUsd;
    const unavailableAmount = await f.api.memberAction(f.store, 'member.status', {});
    assert.equal(unavailableAmount.config.giftUsd, undefined); assert.equal(unavailableAmount.gift.amountUsd, undefined);
    f.control.offlineConfig = true;
    await assert.rejects(() => f.api.memberAction(f.store, 'member.status', {}), /configuration unavailable/);
    assert.equal(f.control.requests.filter(request => request.action === 'claim').length, 0);
    assert(fs.existsSync(path.join(f.directory, 'member-session.enc')));
  });
  await test('each supported group becomes the correct protocol and no key returns to renderer', async () => {
    const f = fixture('protocols'); await login(f);
    const expected = { 7: 'openai-responses', 8: 'anthropic', 9: 'gemini', 10: 'openai-chat', 11: 'openai-chat' };
    for (const [id, format] of Object.entries(expected)) {
      const r = await f.api.memberAction(f.store, 'member.addProvider', { groupId: Number(id) });
      const provider = f.store.listProviders().find(p => p.id === r.providerId); assert.equal(provider.format, format); assert(!JSON.stringify(r).includes('sk-user-'));
    }
    await assert.rejects(() => f.api.memberAction(f.store, 'member.addProvider', { groupId: 12 }), /协议无效/);
    assert.equal(f.store.listProviders().length, 5);
  });
  await test('repeated add deduplicates keys and explicitly re-enables the chosen key', async () => {
    const f = fixture('deduplicate'); await login(f);
    const r = await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    const provider = f.store.listProviders()[0]; provider.apiKeys[0].enabled = false; f.store.saveProvider(provider);
    const again = await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    assert.equal(again.providerId, r.providerId); assert.equal(f.store.listProviders().length, 1); assert.equal(f.store.listProviders()[0].apiKeys.length, 1); assert(f.store.listProviders()[0].apiKeys[0].enabled);
  });
  await test('switching member accounts never combines their provider key pools', async () => {
    const f = fixture('switch'); await login(f); await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    await f.api.memberAction(f.store, 'member.logout', {}); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.activeUser = 2; await login(f); await f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 });
    const providers = f.store.listProviders(); assert.equal(providers.length, 2);
    assert(providers.every(p => p.apiKeys.length === 1)); assert.notEqual(providers[0].presetId, providers[1].presetId);
  });
  await test('expired status and claim clear saved session and permit a fresh login', async () => {
    const f = fixture('expired'); await login(f); f.control.expired = 'status';
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.expired = ''; await login(f); f.control.expired = 'claim';
    const expired = await f.api.memberAction(f.store, 'member.claim', {});
    assert.equal(expired.ok, false); assert.equal(expired.loggedIn, false); assert.equal(expired.authExpired, true); assert.match(expired.message, /登录已过期/);
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
    f.control.expired = ''; await login(f); assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, true);
  });
  await test('non-JSON authentication failure clears encrypted session and exposes logged-out state independently of config availability', async () => {
    const f = fixture('expired-html'); await login(f); f.control.expired = 'claim'; f.control.expiredHtml = true;
    const result = await f.api.memberAction(f.store, 'member.claim', {});
    assert.equal(result.ok, false); assert.equal(result.loggedIn, false); assert.equal(result.authExpired, true);
    assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    f.control.offlineConfig = true;
    await assert.rejects(() => f.api.memberAction(f.store, 'member.status', {}), /configuration unavailable/);
    assert.equal(f.control.requests.filter(r => r.action === 'claim').length, 1);
  });
  await test('group authentication failure is explicit and an ambiguous claim never retries or reconciles automatically', async () => {
    const f = fixture('ambiguous'); await login(f); f.control.expired = 'groups';
    const expired = await f.api.memberAction(f.store, 'member.groups', {});
    assert.equal(expired.authExpired, true); assert.equal(expired.loggedIn, false);
    f.control.expired = ''; await login(f); f.control.ambiguousClaim = true;
    const before = f.control.requests.length;
    await assert.rejects(() => f.api.memberAction(f.store, 'member.claim', {}), /response lost/);
    assert.deepEqual(f.control.requests.slice(before).map(r => r.action), ['claim']);
    assert(fs.existsSync(path.join(f.directory, 'member-session.enc')));
  });
  await test('late status responses cannot clear a newer login or expose the prior account', async () => {
    for (const responseKind of ['html-401', 'json-auth', 'success', 'same-token-success', 'body-auth']) {
      const f = fixture('late-' + responseKind); await login(f);
      const mockFetch = globalThis.fetch;
      let release, entered;
      const started = new Promise(resolve => { entered = resolve; });
      let first = true;
      globalThis.fetch = async (url, options) => {
        if (new URL(url).searchParams.get('a') !== 'status' || !first) return mockFetch(url, options);
        first = false;
        assert.equal(options.headers.authorization, 'Bearer ' + '1'.repeat(64));
        const waiting = new Promise(resolve => { release = resolve; });
        const body = responseKind === 'body-auth'
          ? { status: 200, ok: true, text: async () => { entered(); await waiting; return JSON.stringify({ ok: false, code: 'AUTH_REJECTED', error: 'old session' }); } }
          : null;
        if (body) return body;
        entered(); await waiting;
        if (responseKind === 'html-401') return new Response('<html>expired old session</html>', { status: 401 });
        if (responseKind === 'json-auth') return new Response(JSON.stringify({ ok: false, code: 'AUTH_REJECTED', error: 'old session' }));
        return new Response(JSON.stringify({ ok: true, member: { id: 1, balance: 111 }, gift: { status: 'claimed' } }));
      };
      const oldStatus = f.api.memberAction(f.store, 'member.status', {});
      const rejected = assert.rejects(oldStatus, /登录状态已变化/);
      await started;
      f.control.activeUser = responseKind === 'same-token-success' ? 1 : 2;
      await login(f);
      const encryptedBefore = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
      release(); await rejected;
      assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), encryptedBefore);
      const latest = await f.api.memberAction(f.store, 'member.status', {});
      assert.equal(latest.loggedIn, true); assert.equal(latest.member.id, f.control.activeUser);
      assert.notEqual(latest.member.balance, 111);
    }
  });
  await test('offline logout still clears local credentials and reports remote limitation', async () => {
    const f = fixture('logout'); await login(f); f.control.offlineLogout = true;
    const result = await f.api.memberAction(f.store, 'member.logout', {}); assert(result.ok); assert.match(result.message, /远端会话/);
    assert(!fs.existsSync(path.join(f.directory, 'member-session.enc'))); assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
  });
  await test('server-side renewal keeps the encrypted desktop session stable and does not reveal upstream tokens', async () => {
    const f = fixture('renewal'); await login(f);
    const before = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    const mockFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const response = await mockFetch(url, options);
      if (new URL(url).searchParams.get('a') !== 'status') return response;
      return new Response(JSON.stringify({ ...await response.json(), canRefresh: true, expiresAt: '2027-01-01T00:00:00Z', accessExpiresAt: '2026-12-02T00:00:00Z', access_token: 'renewed-upstream-access-private', refresh_token: 'rotated-upstream-refresh-private' }));
    };
    const results = await Promise.all([f.api.memberAction(f.store, 'member.status', {}), f.api.memberAction(f.store, 'member.status', {})]);
    for (const result of results) { assert(result.loggedIn && result.canRefresh); assert.equal(result.expiresAt, '2027-01-01T00:00:00Z'); assert(!JSON.stringify(result).includes('private')); }
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), before);
    const restarted = freshApi(); assert((await restarted.memberAction(f.store, 'member.status', {})).loggedIn);
    assert(!JSON.stringify(f.store.exportAll()).includes('rotated-upstream'));
  });
  await test('transient renewal failures retain login and never replay a credit request', async () => {
    const f = fixture('renewal-transient'); await login(f);
    const before = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    const mockFetch = globalThis.fetch; const actions = [];
    globalThis.fetch = async (url, options) => {
      const action = new URL(url).searchParams.get('a'); actions.push(action);
      if (['status', 'claim'].includes(action)) return new Response(JSON.stringify({ ok: false, code: 'SESSION_BUSY', error: '会员登录正在续期，请稍后重试' }), { status: 503 });
      return mockFetch(url, options);
    };
    await assert.rejects(() => f.api.memberAction(f.store, 'member.status', {}), /正在续期/);
    await assert.rejects(() => f.api.memberAction(f.store, 'member.claim', {}), /正在续期/);
    assert.equal(actions.filter(action => action === 'claim').length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), before);
    globalThis.fetch = mockFetch; assert((await f.api.memberAction(f.store, 'member.status', {})).loggedIn);
  });
  await test('an unsolicited session token in a status response cannot replace the saved login', async () => {
    const f = fixture('renewal-unexpected'); await login(f);
    const before = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    const mockFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => new URL(url).searchParams.get('a') === 'status'
      ? new Response(JSON.stringify({ ok: true, sessionToken: '2'.repeat(64), member: { id: 2 } })) : mockFetch(url, options);
    await assert.rejects(() => f.api.memberAction(f.store, 'member.status', {}), /意外的登录凭据/);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), before);
  });
  await test('a late renewal response cannot restore a logged-out desktop session', async () => {
    const f = fixture('renewal-logout'); await login(f);
    const mockFetch = globalThis.fetch; let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    globalThis.fetch = async (url, options) => {
      if (new URL(url).searchParams.get('a') !== 'status') return mockFetch(url, options);
      entered(); await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ ok: true, sessionToken: '1'.repeat(64), member: { id: 1 }, canRefresh: true }));
    };
    const pending = f.api.memberAction(f.store, 'member.status', {});
    await started; await f.api.memberAction(f.store, 'member.logout', {}); release();
    assert.equal((await pending).loggedIn, false);
    assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    assert.equal((await f.api.memberAction(f.store, 'member.status', {})).loggedIn, false);
  });
  await test('mismatched supplier URL, protocol and group cannot save a provider', async () => {
    const f = fixture('invalid'); await login(f);
    for (const alter of [v => ({ ...v, baseUrl: 'https://attacker.invalid/v1' }), v => ({ ...v, format: 'anthropic' }), v => ({ ...v, group: { ...v.group, id: 8 } }), v => ({ ...v, memberId: undefined })]) {
      f.control.alterKey = alter; await assert.rejects(() => f.api.memberAction(f.store, 'member.addProvider', { groupId: 7 }), /协议无效/);
    }
    assert.equal(f.store.listProviders().length, 0);
  });
  await test('two-factor challenge and completion use the agreed contract', async () => {
    const f = fixture('two-factor'); const challenge = await f.api.memberAction(f.store, 'member.login', { email: 'u@test.invalid', password: 'two-factor' });
    assert(challenge.requires2fa); assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    await f.api.memberAction(f.store, 'member.login2fa', { tempToken: challenge.tempToken, code: '123456' });
    assert.deepEqual(f.control.requests.at(-1).body, { tempToken: 'challenge-token', totpCode: '123456' });
  });
  await test('maintenance never creates credentials or migrates plaintext identities without an existing encrypted login', async () => {
    for (const mode of ['empty', 'bad-session', 'no-installation', 'legacy-installation', 'bad-installation']) {
      const f = fixture('maintenance-' + mode);
      if (mode !== 'empty') fs.writeFileSync(path.join(f.directory, 'member-session.enc'), f.safeStorage.encryptString(mode === 'bad-session' ? 'invalid-session' : '1'.repeat(64)));
      if (mode === 'legacy-installation') fs.writeFileSync(path.join(f.directory, 'member-installation.json'), JSON.stringify({ id: '12345678-1234-4321-abcd-123456789abc', proof: 'a'.repeat(64) }));
      if (mode === 'bad-installation') fs.writeFileSync(path.join(f.directory, 'member-installation.enc'), Buffer.from('not-encrypted'));
      const before = fs.readdirSync(f.directory).map(file => [file, fs.statSync(path.join(f.directory, file)).isFile() ? fs.readFileSync(path.join(f.directory, file)) : null]);
      const stop = maintenance(f);
      try { await pause(65); assert.equal(f.control.requests.length, 0); }
      finally { stop(); }
      assert.deepEqual(fs.readdirSync(f.directory).map(file => [file, fs.statSync(path.join(f.directory, file)).isFile() ? fs.readFileSync(path.join(f.directory, file)) : null]), before);
    }
  });
  await test('maintenance restores an encrypted login after startup and retries when secure storage becomes available', async () => {
    const f = fixture('maintenance-restore'); await login(f); f.api = freshApi(); f.control.requests.length = 0; f.control.secure = false;
    const saved = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    const stop = maintenance(f);
    try {
      await pause(50); assert.equal(f.control.requests.length, 0);
      f.control.secure = true;
      await until(() => f.control.requests.length >= 2, 'Existing login was not maintained after secure storage recovered');
      assert(f.control.requests.every(request => request.action === 'status' && request.headers.authorization === 'Bearer ' + '1'.repeat(64)));
      assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), saved);
    } finally { stop(); }
  });
  await test('maintenance begins after a later explicit login and stops contacting the service after logout', async () => {
    const f = fixture('maintenance-later-login'); const stop = maintenance(f);
    try {
      await pause(35); assert.equal(f.control.requests.length, 0);
      await login(f); await until(() => f.control.requests.some(request => request.action === 'status'), 'Later login was not maintained');
      await f.api.memberAction(f.store, 'member.logout', {});
      const count = f.control.requests.length; await pause(65); assert.equal(f.control.requests.length, count);
      assert(!fs.existsSync(path.join(f.directory, 'member-session.enc')));
    } finally { stop(); }
  });
  await test('background network, busy and unconfirmed proxy authentication failures preserve login and retry automatically', async () => {
    const f = fixture('maintenance-retry'); await login(f); const saved = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    const mockFetch = globalThis.fetch; let requests = 0, recovered = false;
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(url).searchParams.get('a'), 'status'); requests++;
      if (requests === 1) return new Response(JSON.stringify({ ok: false, code: 'SESSION_BUSY', error: 'renewal temporarily busy' }), { status: 503 });
      if (requests === 2) throw new TypeError('fixture network offline');
      if (requests === 3) return new Response('<html>temporary proxy challenge</html>', { status: 401 });
      const response = await mockFetch(url, options); recovered = true; return response;
    };
    const stop = maintenance(f);
    try {
      await until(() => recovered, 'Maintenance did not recover automatically');
      assert(requests >= 4); assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), saved);
    } finally { stop(); }
  });
  await test('maintenance is single-flight and skips an in-progress explicit login', async () => {
    const f = fixture('maintenance-single-flight'); await login(f);
    const mockFetch = globalThis.fetch; let releaseStatus, releaseLogin, statusCalls = 0, loginStarted = false;
    globalThis.fetch = async (url, options) => {
      const action = new URL(url).searchParams.get('a');
      if (action === 'login') { loginStarted = true; await new Promise(resolve => { releaseLogin = resolve; }); }
      if (action === 'status') { statusCalls++; if (statusCalls === 1) await new Promise(resolve => { releaseStatus = resolve; }); }
      return mockFetch(url, options);
    };
    const pendingLogin = login(f); await until(() => loginStarted, 'Explicit login did not start');
    const stop = maintenance(f);
    try {
      await pause(65); assert.equal(statusCalls, 0);
      releaseLogin(); await pendingLogin;
      await until(() => !!releaseStatus, 'Maintenance did not resume after login');
      await pause(65); assert.equal(statusCalls, 1);
      releaseStatus(); await until(() => statusCalls >= 2, 'Maintenance did not schedule its next completed-request interval');
    } finally { stop(); releaseLogin?.(); releaseStatus?.(); }
  });
  await test('a late maintenance rejection cannot clear a newer member login', async () => {
    const f = fixture('maintenance-stale'); await login(f); const mockFetch = globalThis.fetch;
    let release, entered = false, intercepted = false;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).searchParams.get('a') !== 'status' || intercepted) return mockFetch(url, options);
      intercepted = true; entered = true; await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ ok: false, code: 'SESSION_EXPIRED', error: 'old session' }), { status: 401 });
    };
    const stop = maintenance(f);
    try {
      await until(() => entered, 'Maintenance did not start');
      f.control.activeUser = 2; await login(f); const saved = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
      release(); await pause(60);
      assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), saved);
      assert(f.control.requests.some(request => request.action === 'status' && request.headers.authorization === 'Bearer ' + '2'.repeat(64)));
    } finally { stop(); release?.(); }
  });
  await test('stopping maintenance aborts its request and a late response cannot clear credentials or restart the timer', async () => {
    const f = fixture('maintenance-stop'); await login(f); const saved = fs.readFileSync(path.join(f.directory, 'member-session.enc'));
    let release, signal, requests = 0;
    globalThis.fetch = async (_url, options) => {
      requests++; signal = options.signal; await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ ok: false, code: 'AUTH_REJECTED', error: 'late stopped response' }), { status: 401 });
    };
    const stop = maintenance(f);
    try {
      await until(() => !!release, 'Maintenance did not start'); stop(); stop(); assert(signal.aborted);
      release(); await pause(65); assert.equal(requests, 1);
      assert.deepEqual(fs.readFileSync(path.join(f.directory, 'member-session.enc')), saved);
    } finally { stop(); release?.(); }
  });
  await test('confirmed background session revocation clears credentials and suppresses future maintenance traffic', async () => {
    const f = fixture('maintenance-revoked'); await login(f); f.control.requests.length = 0; f.control.expired = 'status';
    const stop = maintenance(f);
    try {
      await until(() => !fs.existsSync(path.join(f.directory, 'member-session.enc')), 'Confirmed revocation did not clear the session');
      await pause(65); assert.deepEqual(f.control.requests.map(request => request.action), ['status']);
    } finally { stop(); }
  });
  await test('the default maintenance timer is unrefed and cannot keep the application process alive', async () => {
    const code = `globalThis.__memberElectron={app:{getPath:()=>${JSON.stringify(isolated)}},safeStorage:{}};require(${JSON.stringify(bundle)}).startMemberSessionMaintenance();`;
    const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 2500, windowsHide: true });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  });
  console.log(`All ${passed} desktop membership integration tests passed.`);
} finally {
  globalThis.fetch = originalFetch; delete globalThis.__memberElectron;
  assert.equal(path.dirname(isolated), fs.realpathSync(os.tmpdir()));
  assert(path.basename(isolated).startsWith('aurora-member-client-'));
  fs.rmSync(isolated, { recursive: true, force: true });
}
