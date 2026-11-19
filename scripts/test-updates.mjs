import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-update-test-'));
const bundle = path.join(scratch, 'updates.mjs');
await build({ stdin: { contents: "export * from './src/core/cloud.ts'; export * from './src/core/releaseSources.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
const m = await import(pathToFileURL(bundle).href);
const win = { platform: 'win', arch: 'x64' }, version = '0.7.0';
const asset = (name, changes = {}) => ({ name, state: 'uploaded', size: 50_000_000, browser_download_url: `https://github.com/yunhui201/yunhui.me/releases/download/v${version}/${name}`, ...changes });
const setup = `YunHuiAI-${version}-win-x64-setup.exe`, portable = `YunHuiAI-${version}-win-x64-portable.exe`;
const release = (changes = {}) => ({ tag_name: `v${version}`, html_url: `https://github.com/yunhui201/yunhui.me/releases/tag/v${version}`, draft: false, prerelease: false, body: '正式版说明', published_at: '2026-11-15T00:00:00Z', assets: [asset(portable), asset(setup)], ...changes });
const website = (changes = {}) => ({ version, platform: 'win', arch: 'x64', url: `https://yunhui.me/releases/${setup}`, notes: '官网正式版', mandatory: false, hasUpdate: true, ...changes });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
async function expectFallback(github, official = website(), target = win) {
  const calls = [];
  const result = await m.checkUpdate('0.6.0', target, async url => { calls.push(url); if (url === m.GITHUB_RELEASE_API) { if (github instanceof Error) throw github; return github; } return official; });
  assert.equal(calls.length, 2); assert.equal(calls[0], m.GITHUB_RELEASE_API);
  const fallback = new URL(calls[1]); assert.equal(fallback.origin, 'https://yunhui.me'); assert.equal(fallback.searchParams.get('action'), 'update'); assert.equal(fallback.searchParams.get('platform'), target.platform); assert.equal(fallback.searchParams.get('arch'), target.arch); assert.equal(fallback.searchParams.get('current'), '0.6.0');
  assert.equal(result.source, 'website'); assert.equal(result.fallbackUrl, result.url); return result;
}

try {
  await test('GitHub latest is primary and Windows setup wins over portable', async () => {
    const urls = []; const r = await m.checkUpdate('0.6.0', win, async url => { urls.push(url); return release(); });
    assert.deepEqual(urls, [m.GITHUB_RELEASE_API]); assert.equal(r.source, 'github'); assert.equal(r.assetName, setup); assert.equal(r.hasUpdate, true); assert.equal(r.fallbackUrl, ''); assert.equal(r.releaseUrl, release().html_url);
  });
  await test('Windows portable remains available when no setup exists', () => assert.equal(m.githubUpdate(release({ assets: [asset(portable)] }), '0.6.0', win).assetName, portable));
  await test('CPU architecture is matched exactly', () => {
    const arm = `YunHuiAI-${version}-win-arm64-setup.exe`;
    assert.equal(m.githubUpdate(release({ assets: [asset(setup), asset(arm)] }), '0.6.0', { platform: 'win', arch: 'arm64' }).assetName, arm);
    assert.throws(() => m.githubUpdate(release(), '0.6.0', { platform: 'win', arch: 'arm64' }), /当前平台/);
  });
  await test('macOS and Linux select their platform installers', () => {
    const mac = `YunHuiAI-${version}-mac-arm64.dmg`, linux = `YunHuiAI-${version}-linux-x64.AppImage`;
    const data = release({ assets: [asset(setup), asset(mac), asset(linux)] });
    assert.equal(m.githubUpdate(data, '0.6.0', { platform: 'mac', arch: 'arm64' }).assetName, mac);
    assert.equal(m.githubUpdate(data, '0.6.0', { platform: 'linux', arch: 'x64' }).assetName, linux);
  });
  await test('Intel and Apple Silicon prefer matching DMG and accept universal without cross-architecture downloads', () => {
    const intel = `YunHuiAI-${version}-mac-x64.dmg`, apple = `YunHuiAI-${version}-mac-arm64.dmg`, universal = `YunHuiAI-${version}-mac-universal.dmg`;
    for (const [arch, expected, other] of [['x64', intel, apple], ['arm64', apple, intel]]) {
      const target = { platform: 'mac', arch };
      assert.equal(m.githubUpdate(release({ assets: [asset(universal), asset(other), asset(expected)] }), '0.6.0', target).assetName, expected);
      assert.equal(m.githubUpdate(release({ assets: [asset(other), asset(universal)] }), '0.6.0', target).assetName, universal);
      assert.throws(() => m.githubUpdate(release({ assets: [asset(other)] }), '0.6.0', target), /当前平台/);
    }
  });
  await test('macOS website fallback preserves the requested architecture and checks its filename', async () => {
    for (const arch of ['arm64', 'x64']) {
      const mac = website({ platform: 'mac', arch, url: `https://yunhui.me/releases/YunHuiAI-${version}-mac-${arch}.dmg` });
      assert.equal((await expectFallback(new Error('fixture offline'), mac, { platform: 'mac', arch })).url, mac.url);
      assert.throws(() => m.websiteUpdate({ ...mac, url: mac.url.replace(`mac-${arch}`, `mac-${arch === 'arm64' ? 'x64' : 'arm64'}`) }, '0.6.0', { platform: 'mac', arch }), /平台/);
    }
  });
  await test('network errors, missing stable release and rate limits automatically use the website', async () => { for (const error of [new Error('timeout'), new Error('HTTP 404'), new Error('HTTP 403'), new Error('HTTP 429')]) assert.equal((await expectFallback(error)).hasUpdate, true); });
  await test('malformed JSON and invalid response shapes use the website', async () => { for (const value of [new Error('invalid JSON'), '<html>not JSON</html>', null, [], { message: 'API rate limit exceeded' }]) await expectFallback(value); });
  await test('drafts, prereleases and prerelease tags cannot become stable updates', async () => {
    for (const data of [release({ draft: true }), release({ prerelease: true }), release({ draft: undefined }), release({ tag_name: 'v0.8.0-beta.1' })]) await expectFallback(data);
  });
  await test('source archives, debug symbols, unsigned iOS and wrong-version files are ignored', async () => {
    const names = ['Source code.zip', `${setup}.blockmap`, 'YunHuiAI-0.8.0-win-x64-setup.exe', 'YunHuiAI-0.7.0-ios-device-unsigned.zip', 'YunHuiAI-0.7.0-ios-simulator.zip'];
    await expectFallback(release({ assets: names.map(name => asset(name)) }));
  });
  await test('bad or cross-repository asset URLs cannot be offered', async () => {
    for (const url of ['http://github.com/yunhui201/yunhui.me/releases/download/v0.7.0/' + setup, 'javascript:alert(1)', 'https://github.com.evil.test/yunhui201/yunhui.me/releases/download/v0.7.0/' + setup, 'https://github.com/attacker/aurora/releases/download/v0.7.0/' + setup, 'https://user:pass@github.com/yunhui201/yunhui.me/releases/download/v0.7.0/' + setup, 'https://github.com/yunhui201/yunhui.me/releases/download/v0.6.0/' + setup]) await expectFallback(release({ assets: [asset(setup, { browser_download_url: url })] }));
  });
  await test('release URLs and empty or unuploaded assets are validated', async () => {
    await expectFallback(release({ html_url: 'https://github.com/other/repo/releases/tag/v0.7.0' }));
    await expectFallback(release({ assets: [asset(setup, { size: 0 }), asset(portable, { state: 'open' })] }));
  });
  await test('older GitHub versions never cause a downgrade or expose an old download', () => { const r = m.githubUpdate(release(), '0.8.0', win); assert.equal(r.hasUpdate, false); assert.equal(r.url, ''); assert.equal(r.mandatory, false); });
  await test('server hasUpdate and mandatory cannot force an older website build', () => { const r = m.websiteUpdate(website({ hasUpdate: true, mandatory: true }), '0.8.0', win); assert.equal(r.hasUpdate, false); assert.equal(r.url, ''); assert.equal(r.fallbackUrl, ''); assert.equal(r.mandatory, false); });
  await test('current live-source shape: no GitHub stable release and website 0.4.0 cannot downgrade 0.6.0', async () => {
    const data = website({ version: '0.4.0', url: 'https://yunhui.me/releases/YunHuiAI-0.4.0-win-x64-setup.exe', hasUpdate: false });
    const r = await m.checkUpdate('0.6.0', win, async url => { if (url === m.GITHUB_RELEASE_API) throw new Error('HTTP 404'); return data; });
    assert.equal(r.source, 'website'); assert.equal(r.version, '0.4.0'); assert.equal(r.hasUpdate, false); assert.equal(r.url, ''); assert.equal(r.fallbackUrl, '');
  });
  await test('semantic versions compare stable, prerelease, numeric and metadata correctly', () => {
    assert.equal(m.compareReleaseVersions('0.7.0', '0.7.0-rc.9'), 1); assert.equal(m.compareReleaseVersions('0.7.0-rc.10', '0.7.0-rc.9'), 1); assert.equal(m.compareReleaseVersions('0.7.0+abc', 'v0.7.0+xyz'), 0); assert.equal(m.compareReleaseVersions('0.10.0', '0.9.9'), 1);
    for (const value of ['latest', '0.7', '01.7.0', '0.7.0-01', '0.7.0\n', '999999999999999999999.0.0']) assert.throws(() => m.compareReleaseVersions(value, '0.6.0'));
  });
  await test('website rejects wrong platform, wrong filename version and untrusted HTTPS host', () => {
    for (const data of [website({ arch: 'arm64' }), website({ platform: 'ios' }), website({ version: '0.8.0' }), website({ url: `https://evil.test/releases/${setup}` }), website({ url: `http://yunhui.me/releases/${setup}` }), website({ url: 'https://yunhui.me/' }), website({ url: '' })]) assert.throws(() => m.websiteUpdate(data, '0.6.0', win));
  });
  await test('manual official fallback skips GitHub and provides a verified same-version installer', async () => {
    const calls = []; const r = await m.checkUpdate('0.6.0', { ...win, source: 'website', minimumVersion: version }, async url => { calls.push(url); return website(); });
    assert.equal(calls.length, 1); assert.ok(calls[0].startsWith(m.OFFICIAL_UPDATE_URL)); assert.equal(r.source, 'website'); assert.equal(r.url, website().url); assert.equal(r.fallbackUrl, website().url);
  });
  await test('manual fallback allows newer releases but refuses an outdated mirror', async () => {
    await assert.rejects(() => m.checkUpdate('0.6.0', { ...win, source: 'website', minimumVersion: '0.8.0' }, async () => website()), /尚未同步到 0.8.0/);
    const r = await m.checkUpdate('0.6.0', { ...win, source: 'website', minimumVersion: '0.6.5' }, async () => website()); assert.equal(r.version, version);
    await assert.rejects(() => m.checkUpdate('0.8.0', { ...win, source: 'website' }, async () => website()), /低于当前客户端/);
  });
  await test('automatic and manual fallback report an unpublished website without inventing a current release', async () => {
    const unpublished = website({ version: '', url: '', hasUpdate: false });
    for (const target of [win, { ...win, minimumVersion: version }, { ...win, source: 'website' }, { ...win, source: 'website', minimumVersion: version }]) {
      const calls = [];
      await assert.rejects(() => m.checkUpdate('0.6.0', target, async url => { calls.push(url); if (url === m.GITHUB_RELEASE_API) throw new Error('HTTP 404'); return unpublished; }), /官网备用检查未完成：官网尚未发布可用版本/);
      assert.equal(calls.length, target.source === 'website' ? 1 : 2); assert.ok(calls.at(-1).startsWith(m.OFFICIAL_UPDATE_URL));
    }
  });
  await test('only the explicit unpublished shape receives that explanation; malformed metadata stays invalid', () => {
    const unpublished = website({ version: '', url: '', hasUpdate: false });
    for (const patch of [{ version: null }, { version: undefined }, { url: undefined }, { url: null }, { hasUpdate: 'false' }, { hasUpdate: undefined }, { hasUpdate: true }, { platform: 'ios' }, { arch: 'arm64' }, { prerelease: true }, { draft: true }]) {
      assert.throws(() => m.websiteUpdate({ ...unpublished, ...patch }, '0.6.0', win), error => !error.message.includes('官网尚未发布可用版本'));
    }
  });
  await test('a claimed no-update response cannot bypass the requested minimum mirror version', async () => {
    const old = website({ version: '0.6.0', url: 'https://yunhui.me/releases/YunHuiAI-0.6.0-win-x64-setup.exe', hasUpdate: false });
    for (const source of [undefined, 'website']) await assert.rejects(() => m.checkUpdate('0.6.0', { ...win, source, minimumVersion: version }, async url => { if (url === m.GITHUB_RELEASE_API) throw new Error('HTTP 404'); return old; }), /尚未同步到 0.7.0/);
  });
  await test('iOS falls back to a genuine TestFlight installation link', async () => {
    const r = await expectFallback(release({ assets: [asset('YunHuiAI-0.7.0-ios-device-unsigned.zip')] }), website({ platform: 'ios', arch: 'arm64', url: 'https://testflight.apple.com/join/AbCd1234' }), { platform: 'ios', arch: 'arm64' }); assert.equal(r.url, 'https://testflight.apple.com/join/AbCd1234');
  });
  await test('iOS accepts App Store but rejects IPA, simulator and unsigned ZIP downloads', () => {
    const target = { platform: 'ios', arch: 'arm64' };
    assert.equal(m.websiteUpdate(website({ platform: 'ios', arch: 'arm64', url: 'https://apps.apple.com/cn/app/yunhui/id123456789' }), '0.6.0', target).hasUpdate, true);
    for (const url of ['https://yunhui.me/releases/ios.ipa', 'https://yunhui.me/releases/ios-unsigned.zip', 'https://testflight.apple.com.evil.test/join/abc', 'https://apps.apple.com/cn/']) assert.throws(() => m.websiteUpdate(website({ platform: 'ios', arch: 'arm64', url }), '0.6.0', target));
  });
  await test('both sources failing produce an explicit failure without an admin-home fallback', async () => {
    await assert.rejects(() => m.checkUpdate('0.6.0', win, async () => { throw new Error('fixture offline'); }), /官网备用检查未完成/);
    await assert.rejects(() => m.checkUpdate('0.6.0', win, async url => url === m.GITHUB_RELEASE_API ? release({ assets: [] }) : website({ url: '' })), /官网备用检查未完成/);
  });
  await test('invalid version, architecture and source fail before any network access', async () => {
    let requests = 0; const request = async () => { requests++; return release(); };
    await assert.rejects(() => m.checkUpdate('not-a-version', win, request));
    for (const target of [{ platform: 'android', arch: 'arm64' }, { platform: 'ios', arch: 'x64' }, { platform: 'mac', arch: 'ia32' }, { platform: 'win', arch: 'mips' }, { ...win, source: 'evil' }, { ...win, minimumVersion: '0.8.0-beta' }]) await assert.rejects(() => m.checkUpdate('0.6.0', target, request));
    assert.equal(requests, 0);
  });
  console.log(`Updates: ${passed} tests passed`);
} finally {
  const resolved = path.resolve(scratch);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('aurora-update-test-')) fs.rmSync(resolved, { recursive: true, force: true });
}
