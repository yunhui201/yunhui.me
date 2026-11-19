import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { classifyUsage, planLegacyUsageCleanup, applyLegacyUsageCleanup, localDay, sha256 } from './legacy-demo-usage.mjs';

// The offline cleanup deliberately rejects symlinked ancestors. macOS exposes
// its temp directory through /var; Windows runners may expose an 8.3 alias.
// Use the native canonical path expected by the cleanup safety checks.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-legacy-usage-test-')));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
let checks = 0, sequence = 0;
const pairs = [['prov_claude', 'Claude 官方', 'claude-sonnet-4-5'], ['prov_deepseek', 'DeepSeek 深度求索', 'deepseek-chat'], ['prov_relay', '某某中转站', 'gpt-5.1-codex'], ['prov_kimi', 'Kimi 月之暗面', 'kimi-k2-turbo-preview']];
function seeded(day = '2020-01-03', count = 8) {
  const start = new Date(`${day}T12:12:34.567`).getTime();
  return Array.from({ length: count }, (_, i) => {
    const [providerId, providerName, model] = pairs[i % pairs.length], input = 2043 + i * 1234, output = 304 + i * 120;
    return { ts: new Date(start + i * 600000).toISOString(), agent: ['Claude Code', 'Codex', 'Gemini CLI'][i % 3], providerId, providerName, model, requestModel: model, protocol: 'openai-chat', stream: true, status: i === 3 ? 502 : 200,
      inputTokens: input, outputTokens: output, cacheRead: Math.floor(input * 0.4), cacheWrite: 0, cost: (input / 1e6) * (model.includes('claude') ? 3 : 0.6) + (output / 1e6) * (model.includes('claude') ? 15 : 2), latencyMs: 901 + i * 300, firstByteMs: 201 + i * 70, attempts: 1, requestId: `req_${(1000000000000 + i).toString(36)}` };
  });
}
const bytes = (rows, eol = '\n') => Buffer.from(rows.map(row => JSON.stringify(row)).join(eol) + eol);
const fixture = (files = { '2020-01-03.jsonl': bytes(seeded()) }) => {
  const dir = path.join(root, `data-${++sequence}`); fs.mkdirSync(path.join(dir, 'usage'), { recursive: true });
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'usage', name), value);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"neverRead":"credential-fixture"}'); return dir;
};
const check = async (label, run) => { await run(); checks++; console.log(`PASS ${label}`); };
const helper = fs.readFileSync(path.join(import.meta.dirname, 'clean-legacy-demo-usage.ps1'), 'utf8');
function invokeHelper(plan, source = helper) {
  const file = path.join(root, `plan-${++sequence}.json`), script = path.join(root, `helper-${sequence}.ps1`);
  fs.writeFileSync(file, JSON.stringify(plan)); fs.writeFileSync(script, source);
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PlanPath', file], { encoding: 'utf8', windowsHide: true });
  let report; try { report = JSON.parse(result.stdout.trim()); } catch { assert.fail(`Invalid helper report: ${result.stderr || result.stdout}`); }
  return { ...result, report };
}

try {
  await check('All exact seed fields, formulas and the six-to-nineteen record cadence are required', () => {
    assert.equal(classifyUsage(bytes(seeded()), '2020-01-03').removed, 8);
    for (const count of [1, 5, 20]) assert.equal(classifyUsage(bytes(seeded('2020-01-03', count)), '2020-01-03').removed, 0);
    const changed = [
      { cost: 0.01 }, { cost: seeded()[0].cost + Number.EPSILON }, { cacheRead: 0 }, { requestId: 'chatcmpl-abcdefghijklmnopqrstuvwx' }, { providerName: 'Customer Kimi' }, { model: 'kimi-new-model' },
      { inputTokens: 62000 }, { outputTokens: 4300 }, { latencyMs: 9900 }, { firstByteMs: 2000 }, { attempts: 2 }, { estimated: false }, { costKnown: true }, { status: 201 }, { stream: false }, { protocol: 'anthropic' }, { requestModel: 'alias' },
    ];
    for (const patch of changed) { const rows = seeded('2020-01-03', 6); rows[2] = { ...rows[2], ...patch }; assert.equal(classifyUsage(bytes(rows), '2020-01-03').removed, 0, JSON.stringify(patch)); }
    const wrongTime = seeded('2020-01-03', 6); wrongTime[2].ts = new Date(Date.parse(wrongTime[2].ts) + 1).toISOString(); assert.equal(classifyUsage(bytes(wrongTime), '2020-01-03').removed, 0);
    const duplicate = seeded('2020-01-03', 6); duplicate[1].requestId = duplicate[0].requestId; assert.equal(classifyUsage(bytes(duplicate), '2020-01-03').removed, 0);
    assert.equal(classifyUsage(bytes(seeded()), '2020-01-04').removed, 0);
  });
  await check('A seed group crossing midnight belongs to the filename date of its first timestamp', () => {
    const rows = seeded('2020-01-03', 8), start = new Date('2020-01-03T23:40:34.567').getTime(); rows.forEach((row, i) => { row.ts = new Date(start + i * 600000).toISOString(); });
    assert.equal(classifyUsage(bytes(rows), '2020-01-03').removed, 8);
  });
  await check('Mixed real records with the same provider and model retain every original byte', () => {
    const rows = seeded(), before = Buffer.from(' { "requestId": "chatcmpl-real", "providerId": "prov_kimi", "model": "kimi-k2-turbo-preview" }\r\n\r\n');
    const middle = Buffer.from(' {"ts":"2020-01-03T15:00:00Z","providerId":"prov_relay","cost":7.42}\r\n'), tail = Buffer.from('{"unfinished":"保留原始字节');
    const all = Buffer.concat([before, bytes(rows.slice(0, 4), '\r\n'), middle, bytes(rows.slice(4)), tail]);
    const result = classifyUsage(all, '2020-01-03'); assert.equal(result.removed, 8); assert(result.after.equals(Buffer.concat([before, middle, tail]))); assert.equal(result.errors, 1);
  });
  await check('Preview scans only direct date logs and leaves all files unchanged', () => {
    const dir = fixture(); fs.mkdirSync(path.join(dir, 'usage', 'backups')); fs.writeFileSync(path.join(dir, 'usage', 'backups', '2020-01-04.jsonl'), bytes(seeded('2020-01-04'))); fs.writeFileSync(path.join(dir, 'usage', 'notes.jsonl'), bytes(seeded()));
    const original = fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')), plan = planLegacyUsageCleanup(dir);
    assert.equal(plan.files.length, 1); assert.equal(plan.files[0].removed, 8); assert(original.equals(fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl'))));
    const cli = spawnSync(process.execPath, [path.join(import.meta.dirname, 'clean-legacy-demo-usage.mjs'), '--data-dir', dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).status, 'dry-run'); assert(!cli.stdout.includes('credential-fixture'));
  });
  if (process.platform === 'win32') {
  await check('Apply backs up only usage and removes matching groups while preserving real bytes', () => {
    const kept = Buffer.from(' {"real":true,"providerId":"prov_kimi"}\r\n\n{"partial":'), original = Buffer.concat([bytes(seeded()), kept]);
    const dir = fixture({ '2020-01-03.jsonl': original }), backupDir = path.join(root, `backup-${++sequence}`), plan = planLegacyUsageCleanup(dir), result = applyLegacyUsageCleanup(plan, { backupDir });
    assert.equal(result.status, 'cleaned'); assert.equal(result.removed, 8); assert(fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')).equals(kept));
    assert(fs.readFileSync(path.join(backupDir, '2020-01-03.jsonl')).equals(original)); assert.deepEqual(fs.readdirSync(backupDir).sort(), ['2020-01-03.jsonl', 'manifest.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')); assert.equal(manifest.files[0].beforeSha256, sha256(original)); assert.equal(manifest.files[0].afterSha256, sha256(kept));
    assert.equal(applyLegacyUsageCleanup(planLegacyUsageCleanup(dir)).status, 'unchanged');
  });
  await check('A pure demo log is safely truncated to zero bytes and repeated cleanup is a no-op', () => {
    const original = bytes(seeded()), dir = fixture(), backupDir = path.join(root, `empty-backup-${++sequence}`), file = path.join(dir, 'usage', '2020-01-03.jsonl');
    const result = applyLegacyUsageCleanup(planLegacyUsageCleanup(dir), { backupDir });
    assert.equal(result.status, 'cleaned'); assert.equal(fs.statSync(file).size, 0); assert(fs.readFileSync(path.join(backupDir, '2020-01-03.jsonl')).equals(original));
    const repeated = applyLegacyUsageCleanup(planLegacyUsageCleanup(dir), { backupDir: path.join(root, 'must-not-create') }); assert.equal(repeated.status, 'unchanged'); assert.equal(fs.existsSync(path.join(root, 'must-not-create')), false);
  });
  await check('Today and future matched logs are previewable but cannot be changed', () => {
    for (const offset of [0, 86400000]) {
      const day = localDay(new Date(Date.now() + offset)), original = bytes(seeded(day)), dir = fixture({ [`${day}.jsonl`]: original });
      const plan = planLegacyUsageCleanup(dir); assert.equal(plan.files[0].removed, 8); assert.throws(() => applyLegacyUsageCleanup(plan), /today or future/);
      const direct = invokeHelper({ ...plan, backupDir: path.join(root, `future-backup-${++sequence}`) }); assert.notEqual(direct.status, 0); assert.match(direct.report.message, /today or future/); assert(fs.readFileSync(path.join(dir, 'usage', `${day}.jsonl`)).equals(original));
    }
  });
  await check('A post-preview append to any target aborts the entire transaction before changing earlier files', () => {
    const dir = fixture({ '2020-01-03.jsonl': bytes(seeded()), '2020-01-04.jsonl': bytes(seeded('2020-01-04')) }), plan = planLegacyUsageCleanup(dir), backupDir = path.join(root, `late-backup-${++sequence}`);
    const first = fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')), secondFile = path.join(dir, 'usage', '2020-01-04.jsonl'); fs.appendFileSync(secondFile, '{"real":"late append"}\n'); const second = fs.readFileSync(secondFile);
    assert.throws(() => applyLegacyUsageCleanup(plan, { backupDir }), /changed after preview/); assert(fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')).equals(first)); assert(fs.readFileSync(secondFile).equals(second)); assert.equal(fs.existsSync(backupDir), false);
  });
  await check('An existing writer prevents acquisition of all targets and leaves the data unchanged', async () => {
    const dir = fixture(), file = path.join(dir, 'usage', '2020-01-03.jsonl'), original = fs.readFileSync(file), holder = path.join(root, 'hold-writer.ps1');
    fs.writeFileSync(holder, 'param([string]$TargetFile)\n$ErrorActionPreference="Stop"\n$s=[IO.File]::Open($TargetFile,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)\ntry{[Console]::WriteLine("READY");[Console]::Out.Flush();$null=[Console]::ReadLine()}finally{$s.Dispose()}');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', holder, '-TargetFile', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stderr.on('data', value => { errors += value; });
    const ready = new Promise((resolve, reject) => { child.stdout.on('data', value => { output += value; if (output.includes('READY')) resolve(); }); child.once('error', reject); child.once('exit', code => { if (!output.includes('READY')) reject(new Error(`Writer did not start: ${code} ${errors}`)); }); });
    try { await ready; const plan = planLegacyUsageCleanup(dir); assert.throws(() => applyLegacyUsageCleanup(plan, { backupDir: path.join(root, `writer-backup-${++sequence}`) })); assert(fs.readFileSync(file).equals(original)); }
    finally { if (child.exitCode === null) { const closed = once(child, 'exit'); child.stdin.end('\n'); await closed; } }
  });
  await check('Held cleanup handles reject concurrent append/delete and a write fault rolls every target back', () => {
    const originals = { '2020-01-03.jsonl': bytes(seeded()), '2020-01-04.jsonl': bytes(seeded('2020-01-04')) }, dir = fixture(originals), plan = planLegacyUsageCleanup(dir), backupDir = path.join(root, `rollback-backup-${++sequence}`);
    const readerScript = path.join(root, 'read-held-usage.cjs');
    fs.writeFileSync(readerScript, 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[2])).digest("hex"));');
    const fault = helper.replace('Write-Locked $item.stream $item.after', `
    if ($modified.Count -eq 1) {
      $readerHash = & '${process.execPath.replace(/'/g, "''")}' '${readerScript.replace(/'/g, "''")}' $item.file
      if ($LASTEXITCODE -ne 0 -or $readerHash -ne $item.entry.beforeSha256) { throw 'Node fs.readFileSync could not read through the held cleanup lock' }
      $appendRefused=$false; try { [IO.File]::AppendAllText($item.file, 'concurrent append') } catch { $appendRefused=$true }
      $deleteRefused=$false; try { [IO.File]::Delete($item.file) } catch { $deleteRefused=$true }
      if (-not $appendRefused -or -not $deleteRefused) { throw 'Fixture lock failed to exclude another writer/delete' }
    }
    Write-Locked $item.stream $item.after
    if ($modified.Count -eq 2) { throw 'Injected write failure after both targets changed' }`);
    const result = invokeHelper({ ...plan, backupDir }, fault); assert.notEqual(result.status, 0); assert.match(result.report.message, /Injected write failure/); assert.equal(result.report.restored, 2); assert.deepEqual(result.report.restoreFailures, []);
    for (const [name, original] of Object.entries(originals)) { assert(fs.readFileSync(path.join(dir, 'usage', name)).equals(original)); assert(fs.readFileSync(path.join(backupDir, name)).equals(original)); }
  });
  await check('Backups inside data or existing destinations are refused without changing usage', () => {
    const dir = fixture(), plan = planLegacyUsageCleanup(dir), original = fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl'));
    for (const backupDir of [path.join(dir, 'backup'), path.join(dir, 'usage', 'backup'), root]) assert.throws(() => applyLegacyUsageCleanup(plan, { backupDir }), error => {
      assert.match(error.message, /outside|already exists/); assert.equal(error.report.status, 'refused'); assert.equal(error.report.backupDir, backupDir); assert.equal(error.report.restored, 0); assert.deepEqual(error.report.restoreFailures, []); return true;
    });
    assert(fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')).equals(original));
  });
  await check('A failed backup prevents all source writes', () => {
    const dir = fixture(), plan = planLegacyUsageCleanup(dir), original = fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl'));
    const fault = helper.replace('foreach ($item in $locked) { Write-NewFile', "throw 'Injected backup failure'\n  foreach ($item in $locked) { Write-NewFile");
    const result = invokeHelper({ ...plan, backupDir: path.join(root, `failed-backup-${++sequence}`) }, fault); assert.notEqual(result.status, 0); assert.match(result.report.message, /Injected backup failure/); assert.equal(result.report.restored, 0); assert(fs.readFileSync(path.join(dir, 'usage', '2020-01-03.jsonl')).equals(original));
  });
  } else {
    console.log('SKIP Windows FileShare apply/rollback checks; classifier and dry-run checks completed');
    assert.throws(() => applyLegacyUsageCleanup(planLegacyUsageCleanup(fixture())), /requires Windows/);
  }
  console.log(`Legacy demo usage: ${checks} checks passed`);
} finally {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  assert(path.basename(resolved).startsWith('yunhui-legacy-usage-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
