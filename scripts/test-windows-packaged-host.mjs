/** Native helper transport only. The entire activation script is replaced in a
 * private esbuild copy; no package registry or real client can be accessed.
 * The one private child runs hidden, inherits standard handles, and self-exits
 * within ten seconds or when its private stop flag is written. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

if (process.platform !== 'win32') {
  console.log('SKIP Windows packaged helper transport: Windows only');
  process.exit(0);
}
const repository = path.resolve(import.meta.dirname, '..');
const originalTemp = fs.realpathSync.native(os.tmpdir());
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(originalTemp, 'yunhui-packaged-host-test-')));
const privateTemp = path.join(scratch, "临时 'quoted' & scripts");
fs.mkdirSync(privateTemp);
const controlledEnvironment = ['TEMP', 'TMP', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH'];
const priorEnvironment = new Map(controlledEnvironment.map(name => [name, process.env[name]]));
const originalCodexHome = process.env.CODEX_HOME;
const childDirectories = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0, sequence = 0;
const check = async (label, run) => { await run(); passed++; console.log('PASS ' + label); };
const fixtureSource = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$scriptBytes = [IO.File]::ReadAllBytes($PSCommandPath)
$metadata = @{
  scriptFile = $PSCommandPath
  resultFile = [string]$inputData.resultFile
  scriptBytes = $scriptBytes.Length
  scriptBom = ($scriptBytes[0] -eq 239 -and $scriptBytes[1] -eq 187 -and $scriptBytes[2] -eq 191)
  unicodePreserved = ('中文结果' -eq [string]$inputData.unicodeValue)
  executablePreserved = ([string]$inputData.executable -eq [string]$inputData.expectedExecutable)
  scrubbedEnvironment = (!$env:ELECTRON_RUN_AS_NODE -and !$env:ELECTRON_NO_ASAR -and !$env:NODE_OPTIONS -and !$env:NODE_PATH)
  codexHomePreserved = ([Environment]::GetEnvironmentVariable('CODEX_HOME') -ceq $inputData.expectedCodexHome)
}
[IO.File]::WriteAllText([string]$inputData.metadataFile, ($metadata | ConvertTo-Json -Compress), $utf8)
switch ([string]$inputData.mode) {
  'nonzero' {
    [IO.File]::WriteAllText([string]$inputData.resultFile, '{"kind":"activated","pid":4242}', $utf8)
    exit 7
  }
  'missing' { exit 0 }
  'malformed' { [IO.File]::WriteAllText([string]$inputData.resultFile, '{not-json', $utf8); exit 0 }
  'oversized' { [IO.File]::WriteAllText([string]$inputData.resultFile, ('x' * 8193), $utf8); exit 0 }
  'child' {
    $childData = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$inputData.childDirectory))
    $childSource = @'
$ErrorActionPreference = 'Stop'
$root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PRIVATE_CHILD_DIRECTORY__'))
$stop = [IO.Path]::Combine($root, 'stop')
try {
  [IO.File]::WriteAllText([IO.Path]::Combine($root, 'ready'), [string]$PID)
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt 10000 -and !(Test-Path -LiteralPath $stop)) { Start-Sleep -Milliseconds 50 }
} finally { [IO.File]::WriteAllText([IO.Path]::Combine($root, 'finished'), 'finished') }
'@
    $childSource = $childSource.Replace('__PRIVATE_CHILD_DIRECTORY__', $childData)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardInput = $false
    $start.RedirectStandardOutput = $false
    $start.RedirectStandardError = $false
    $childFile = [IO.Path]::Combine([string]$inputData.childDirectory, 'private-child.ps1')
    [IO.File]::WriteAllText($childFile, $childSource, (New-Object Text.UTF8Encoding($true)))
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $childFile + '"'
    $child = [Diagnostics.Process]::Start($start)
    try {
      $deadline = [DateTime]::UtcNow.AddSeconds(5)
      while (!(Test-Path -LiteralPath ([IO.Path]::Combine([string]$inputData.childDirectory, 'ready')))) {
        if ($child.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Private child did not become ready' }
        Start-Sleep -Milliseconds 25
      }
    } finally { $child.Dispose() }
  }
}
# Use a BOM in the result too, exercising the native reader's UTF-8 handling.
[IO.File]::WriteAllText([string]$inputData.resultFile, '{"kind":"activated","pid":4242}', (New-Object Text.UTF8Encoding($true)))
exit 0
` + '\n# ' + 'private-transport-padding '.repeat(2000) + '\n';

try {
  const moduleFile = path.join(repository, 'src/core/windowsPackagedLaunch.ts');
  const originalSource = fs.readFileSync(moduleFile, 'utf8');
  const startMarker = 'export const windowsPackagedLaunchSource = String.raw`';
  const endPattern = /`;\r?\n\r?\nconst messages:/g;
  assert.equal(originalSource.split(startMarker).length - 1, 1, 'Activation-source boundary must be unique');
  const ends = [...originalSource.matchAll(endPattern)];
  assert.equal(ends.length, 1, 'Activation-source closing boundary must be unique');
  const start = originalSource.indexOf(startMarker), end = ends[0].index + 2;
  assert(end > start);
  const substituted = originalSource.slice(0, start) + 'export const windowsPackagedLaunchSource = '
    + JSON.stringify(fixtureSource) + ';' + originalSource.slice(end) + '\nexport { nativeRun as runFixture };\n';
  const forbidden = /IApplicationActivationManager|\.ActivateApplication\(|::Activate\(|Invoke-CommandInDesktopPackage|Get-AppxPackage/;
  assert(!forbidden.test(substituted), 'No real registry/activation source may survive substitution');
  const bundle = path.join(scratch, 'host-fixture.cjs');
  let replaced = 0;
  await build({ entryPoints: [moduleFile], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'private-helper-only', setup(builder) {
      builder.onLoad({ filter: /windowsPackagedLaunch\.ts$/ }, args => {
        assert.equal(path.resolve(args.path), moduleFile); replaced++;
        return { contents: substituted, loader: 'ts', resolveDir: path.dirname(moduleFile) };
      });
    } }] });
  assert.equal(replaced, 1);
  assert(!forbidden.test(fs.readFileSync(bundle, 'utf8')), 'Bundle must contain only the harmless helper fixture');
  const api = createRequire(import.meta.url)(bundle);
  assert.equal(api.windowsPackagedLaunchSource, fixtureSource);
  assert(fixtureSource.length > 32767, 'Private fixture must exceed Windows command-line capacity');
  for (const name of controlledEnvironment) process.env[name] = name === 'TEMP' || name === 'TMP' ? privateTemp : 'private-test-value';
  assert.equal(os.tmpdir(), privateTemp);

  async function invoke(mode) {
    const caseDirectory = path.join(scratch, `case-${sequence++}-${mode}`);
    fs.mkdirSync(caseDirectory);
    const metadataFile = path.join(caseDirectory, 'metadata.json');
    const childDirectory = path.join(caseDirectory, 'child');
    fs.mkdirSync(childDirectory);
    if (mode === 'child') childDirectories.push(childDirectory);
    const selected = path.join(caseDirectory, "应用 'literal' &", 'ChatGPT.exe');
    const started = performance.now();
    let reply, error;
    try {
      reply = await api.runFixture({ executable: selected, port: 9333, packagedPath: false, mode,
        metadataFile, childDirectory, unicodeValue: '中文结果', expectedExecutable: selected,
        expectedCodexHome: originalCodexHome ?? null });
    } catch (caught) { error = caught; }
    const elapsedMs = performance.now() - started;
    assert(fs.existsSync(metadataFile), 'Private PowerShell fixture must run before verifying its result');
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    assert.equal(path.dirname(metadata.scriptFile), path.dirname(metadata.resultFile));
    const helperDirectory = path.dirname(metadata.scriptFile);
    assert.equal(path.dirname(helperDirectory), privateTemp);
    assert(path.basename(helperDirectory).startsWith('yunhui-packaged-host-'));
    assert.equal(path.basename(metadata.resultFile), 'result.json');
    assert.equal(path.basename(metadata.scriptFile), 'launch.ps1');
    assert(!fs.existsSync(helperDirectory), 'Helper script, result and private directory must be removed on settlement');
    assert.deepEqual(fs.readdirSync(privateTemp), [], 'No helper transport files may be left behind');
    return { reply, error, elapsedMs, metadata, childDirectory };
  }

  let successful;
  await check('Long private UTF-8 BOM script and quoted Chinese paths execute through a result file and clean up', async () => {
    successful = await invoke('success');
    assert.ifError(successful.error);
    assert.deepEqual(successful.reply, { kind: 'activated', pid: 4242 });
    assert(successful.metadata.scriptBytes > 32767);
    assert.equal(successful.metadata.scriptBom, true);
    assert.equal(successful.metadata.unicodePreserved, true);
    assert.equal(successful.metadata.executablePreserved, true);
  });
  await check('Helper removes Electron/Node overrides and preserves the existing CODEX_HOME value', async () => {
    assert.equal(successful.metadata.scrubbedEnvironment, true);
    assert.equal(successful.metadata.codexHomePreserved, true);
    assert.equal(process.env.CODEX_HOME, originalCodexHome);
  });
  for (const mode of ['nonzero', 'missing', 'malformed', 'oversized']) {
    await check(`Helper ${mode} result fails with a Chinese error and removes its private files`, async () => {
      const result = await invoke(mode);
      assert(result.error instanceof Error);
      assert(/[\u3400-\u9fff]/.test(result.error.message), result.error.message);
      assert.equal(result.reply, undefined);
    });
  }
  await check('Helper exit settles while its hidden child still owns inherited standard handles', async () => {
    const result = await invoke('child');
    try {
      assert.ifError(result.error);
      assert.deepEqual(result.reply, { kind: 'activated', pid: 4242 });
      assert(fs.existsSync(path.join(result.childDirectory, 'ready')));
      assert(!fs.existsSync(path.join(result.childDirectory, 'finished')), 'Helper must not wait for child stdio EOF');
      assert(result.elapsedMs < 7000, `Helper unexpectedly waited ${Math.round(result.elapsedMs)} ms`);
    } finally {
      fs.writeFileSync(path.join(result.childDirectory, 'stop'), 'stop');
      const deadline = performance.now() + 3000;
      while (!fs.existsSync(path.join(result.childDirectory, 'finished')) && performance.now() < deadline) await delay(50);
      if (fs.existsSync(path.join(result.childDirectory, 'ready'))) {
        assert(fs.existsSync(path.join(result.childDirectory, 'finished')), 'Private child must acknowledge its own clean exit');
      }
    }
  });
} finally {
  for (const directory of childDirectories) fs.writeFileSync(path.join(directory, 'stop'), 'stop');
  const cleanupDeadline = performance.now() + 11000;
  while (childDirectories.some(directory => fs.existsSync(path.join(directory, 'ready')) && !fs.existsSync(path.join(directory, 'finished')))
    && performance.now() < cleanupDeadline) await delay(100);
  for (const [name, value] of priorEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  assert.equal(process.env.CODEX_HOME, originalCodexHome);
  const resolved = fs.realpathSync.native(scratch);
  assert.equal(path.dirname(resolved), originalTemp);
  assert(path.basename(resolved).startsWith('yunhui-packaged-host-test-'));
  assert(childDirectories.every(directory => !fs.existsSync(path.join(directory, 'ready')) || fs.existsSync(path.join(directory, 'finished'))),
    'Never remove a fixture directory while its private child is still active');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`Windows packaged helper transport: ${passed} checks passed`);
