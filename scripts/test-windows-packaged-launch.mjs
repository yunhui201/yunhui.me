import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// No package registration or application activation. Native Windows cases run
// the production PowerShell resolver against private files and fake manifests.
// Activation-branch tests replace COM, process/port probes and the package cmdlet
// with fixture-only stubs. The production C# process inspector is also exercised
// against this test's own PowerShell processes, never against installed clients.
// the real registry probe always uses inspectOnly and never activates an app.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-packaged-launch-')));
const runFile = promisify(execFile);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
const write = (file, value = 'private desktop fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
try {
  const bundle = path.join(root, 'module.cjs');
  await build({ entryPoints: ['src/core/windowsPackagedLaunch.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  if (process.platform !== 'win32') {
    await assert.rejects(() => api.launchWindowsPackagedDesktop('/fixture/ChatGPT.exe', 9222), /Windows/);
    console.log('SKIP native packaged launch: Windows only');
  } else {
    const ordinary = write(path.join(root, 'ordinary', 'ChatGPT.exe'));
    const install = path.join(root, "WindowsApps", "OpenAI.CodexBeta_1.0_fixture '中文 &");
    const selected = write(path.join(install, 'app', 'ChatGPT.exe'));
    const foreign = write(path.join(root, 'foreign', 'app', 'ChatGPT.exe'));
    write(path.join(install, 'AppxManifest.xml'), '<Package />');
    const packageRecord = { Name: 'OpenAI.CodexBeta', PackageFullName: 'OpenAI.CodexBeta_1.0_fixture', PackageFamilyName: 'OpenAI.CodexBeta_fixture', InstallLocation: install };
    const manifest = applications => '<Package><Applications>' + applications + '</Applications></Package>';
    const app = (id = 'DesktopMain', executable = 'app\\ChatGPT.exe') => `<Application Id="${id}" Executable="${executable}" />`;
    const runtime = run => ({ platform: 'win32', run });
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let sequence = 0;
    async function probe(executable = selected, fixture = {}, actualRegistry = false, activationFixture = false) {
      assert(!(actualRegistry && activationFixture), 'Real registry inspection must never activate');
      const activationLog = path.join(root, `activation-${sequence++}.json`);
      const contextLog = path.join(root, `context-${sequence++}.json`);
      const observationLog = path.join(root, `observation-${sequence++}.json`);
      const fixtureData = { packages: [packageRecord], manifests: { [packageRecord.PackageFullName]: manifest(app()) }, ...fixture };
      const request = { executable: fs.realpathSync.native(executable), port: 9333, packagedPath: executable === selected, inspectOnly: !activationFixture };
      const json = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
      let productionSource = api.windowsPackagedLaunchSource;
      if (activationFixture) {
        const replaceOnce = (before, after) => {
          assert.equal(productionSource.split(before).length - 1, 1, 'Fixture must replace exactly one known production expression');
          productionSource = productionSource.replace(before, after);
          assert(!productionSource.includes(before), 'Real activation expression must not survive the test replacement');
        };
        replaceOnce('$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '[bool]$fixtureData.elevated');
        replaceOnce('[YunhuiPackagedDesktop.Native]::Activate($match.aumid, $arguments)', 'Invoke-FixtureActivation -Aumid $match.aumid -Arguments $arguments');
        replaceOnce('[YunhuiPackagedDesktop.Native]::Watch($activatedPid, $executable, $started, $returned)', '(New-FixtureWatch)');
        replaceOnce('[YunhuiPackagedDesktop.Native]::ExistingInstance($executable)', '(Get-FixtureInstance)');
        replaceOnce('[YunhuiPackagedDesktop.Native]::PortState([int]$inputData.port)', '(Get-FixturePortState)');
        replaceOnce('Get-Command -Name Invoke-CommandInDesktopPackage -CommandType Cmdlet -ErrorAction SilentlyContinue', '(Get-FixturePackageCommand)');
        replaceOnce('-ge 2000', '-ge 40');
        replaceOnce('-ge 8000', '-ge 200');
        replaceOnce('-lt 20000', '-lt 600');
        assert(!productionSource.includes('[YunhuiPackagedDesktop.Native]::Activate('));
        assert(!productionSource.includes('& $packageCommand -PackageFamilyName') || productionSource.includes('(Get-FixturePackageCommand)'));
        fixtureData.activationLog = activationLog;
        fixtureData.contextLog = contextLog;
        fixtureData.observationLog = observationLog;
      }
      const source = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json(request)}')) | ConvertFrom-Json\n`
        + (actualRegistry ? '' : `$fixtureData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json(fixtureData)}')) | ConvertFrom-Json
function Get-AppxPackage {
  param([string]$Name)
  if ($fixtureData.registryError) { throw 'private registry error' }
  if ($Name) {
    $script:registrationChecks++
    if ($script:registrationChecks -gt 1 -and $fixtureData.PSObject.Properties.Name -contains 'fallbackPackages') { @($fixtureData.fallbackPackages); return }
  }
  if ($Name -and $fixtureData.PSObject.Properties.Name -contains 'currentPackages') { @($fixtureData.currentPackages) | Where-Object { $_.Name -eq $Name }; return }
  @($fixtureData.packages) | Where-Object { !$Name -or $_.Name -eq $Name }
}
function Get-AppxPackageManifest {
  param([string]$Package)
  if ($fixtureData.manifestError) { throw 'private manifest error' }
  $script:manifestChecks++
  if ($script:manifestChecks -gt 1 -and $fixtureData.currentManifest) { [xml]$fixtureData.currentManifest; return }
  if ($script:manifestChecks -gt 2 -and $fixtureData.fallbackManifest) { [xml]$fixtureData.fallbackManifest; return }
  [xml]$fixtureData.manifests.$Package
}
function Invoke-FixtureActivation {
  param([string]$Aumid, [string]$Arguments)
  if ($fixtureData.activationError) { throw 'private activation error' }
  [IO.File]::WriteAllText($fixtureData.activationLog, (@{ aumid=$Aumid; arguments=$Arguments } | ConvertTo-Json -Compress))
  $script:activated = $true
  [uint32]321
}
function New-FixtureWatch {
  $watch = New-Object PSObject
  $watch | Add-Member -MemberType ScriptMethod -Name State -Value {
    $script:watchChecks++
    if ($fixtureData.reusedPid -and $script:watchChecks -gt 1) { return 'unknown' }
    if ($fixtureData.processState) { return [string]$fixtureData.processState }
    return 'alive'
  }
  $watch | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
  $watch
}
function Get-FixtureInstance {
  $script:instanceChecks++
  if ($script:instanceChecks -gt 1 -and $fixtureData.instanceAppeared) { return 'running' }
  if ($fixtureData.instanceState) { return [string]$fixtureData.instanceState }
  'none'
}
function Get-FixturePortState {
  if (!$script:activated) { if ($fixtureData.portBefore) { return [string]$fixtureData.portBefore }; return 'empty' }
  if ($script:contextStarted) {
    $script:contextPortChecks++
    [IO.File]::WriteAllText($fixtureData.observationLog, (@{ checks=$script:contextPortChecks; elapsed=([DateTime]::UtcNow - $script:contextStarted).TotalMilliseconds } | ConvertTo-Json -Compress))
    if ($fixtureData.contextNeverReady) { return 'empty' }
    if ($fixtureData.contextPort) { return [string]$fixtureData.contextPort }
    if (([DateTime]::UtcNow - $script:contextStarted).TotalMilliseconds -lt 150) { return 'empty' }
    return 'ready'
  }
  if ($fixtureData.portAfter) { return [string]$fixtureData.portAfter }
  if ($script:registrationChecks -gt 1 -and $fixtureData.finalPortState) { return [string]$fixtureData.finalPortState }
  if ($fixtureData.processState -eq 'exited') { return 'empty' }
  'ready'
}
function Get-FixturePackageCommand {
  if ($fixtureData.missingPackageCommand) { return $null }
  Get-Command Invoke-FixturePackageContext -CommandType Function
}
function Invoke-FixturePackageContext {
  [CmdletBinding()]
  param([string]$PackageFamilyName, [string]$AppId, [string]$Command, [string]$Args, [switch]$PreventBreakaway)
  if ($fixtureData.contextError) { throw 'private package context error' }
  $script:contextStarted = [DateTime]::UtcNow
  [IO.File]::WriteAllText($fixtureData.contextLog, (@{
    family=$PackageFamilyName; appId=$AppId; command=$Command; arguments=$Args; preventBreakaway=[bool]$PreventBreakaway;
    cwd=(Get-Location).ProviderPath; codexHome=$env:CODEX_HOME;
    runtimeVariables=@('ELECTRON_RUN_AS_NODE','ELECTRON_NO_ASAR','NODE_OPTIONS','NODE_PATH','ELECTRON_OVERRIDE_DIST_PATH','VSCODE_INSPECTOR_OPTIONS','VSCODE_NODE_OPTIONS') | ForEach-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
  } | ConvertTo-Json -Compress))
}
`) + productionSource;
      const scriptFile = write(path.join(root, `probe-${sequence++}.ps1`), '\ufeff' + source);
      const { stdout } = await runFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
        windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: '--inspect=9999', NODE_PATH: 'private-fixture-modules', ELECTRON_OVERRIDE_DIST_PATH: 'private-dist', VSCODE_INSPECTOR_OPTIONS: 'private-options', VSCODE_NODE_OPTIONS: 'private-options', CODEX_HOME: 'private-user-home' },
      });
      const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      if (activationFixture) {
        result.activation = fs.existsSync(activationLog) ? JSON.parse(fs.readFileSync(activationLog, 'utf8')) : null;
        result.context = fs.existsSync(contextLog) ? JSON.parse(fs.readFileSync(contextLog, 'utf8')) : null;
        result.observation = fs.existsSync(observationLog) ? JSON.parse(fs.readFileSync(observationLog, 'utf8')) : null;
      }
      return result;
    }
    await check('Only a validated executable and numeric loopback port reach the host', async () => {
      let called = 0;
      const host = runtime(async () => { called++; return { kind: 'unpackaged' }; });
      for (const value of ['ChatGPT.exe', 'C:\\Apps\\ChatGPT.exe\nwhoami', process.execPath, path.join(root, 'missing', 'ChatGPT.exe')]) await assert.rejects(() => api.launchWindowsPackagedDesktop(value, 9222, host));
      for (const port of [0, 1023, 65536, '9222', 9222.5, NaN]) await assert.rejects(() => api.launchWindowsPackagedDesktop(ordinary, port, host), /端口/);
      assert.equal(called, 0);
    });
    await check('Ordinary desktop launch may fall through; registered launches preserve their returned PID', async () => {
      assert.deepEqual(await api.launchWindowsPackagedDesktop(ordinary, 9222, runtime(async request => { assert.equal(request.packagedPath, false); return { kind: 'unpackaged' }; })), { packaged: false });
      assert.deepEqual(await api.launchWindowsPackagedDesktop(selected, 9333, runtime(async request => { assert.equal(request.executable, fs.realpathSync.native(selected)); assert.equal(request.port, 9333); assert.equal(request.packagedPath, true); return { kind: 'activated', pid: 123 }; })), { packaged: true, pid: 123 });
      assert.deepEqual(await api.launchWindowsPackagedDesktop(selected, 9333, runtime(async () => ({ kind: 'context-ready', portReady: true }))), { packaged: true });
    });
    await check('Known WindowsApps or manifest-bearing paths can never silently fall through', async () => {
      const manifestExe = write(path.join(root, 'copied-package', 'ChatGPT.exe')); write(path.join(path.dirname(manifestExe), 'AppxManifest.xml'), '<Package />');
      for (const file of [selected, manifestExe]) await assert.rejects(() => api.launchWindowsPackagedDesktop(file, 9222, runtime(async () => ({ kind: 'unpackaged' }))), /注册/);
      for (const reply of [{ kind: 'activated', pid: 0 }, { kind: 'activated', pid: -1 }, { kind: 'context-ready' }, { kind: 'context-ready', portReady: 'true' }, { kind: 'resolved', aumid: 'ignored!App' }, null]) await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, runtime(async () => reply)));
    });
    await check('Registration, elevation and activation failures produce actionable sanitized errors', async () => {
      for (const code of ['target-changed', 'registry-unavailable', 'ambiguous', 'unregistered', 'invalid-identity', 'elevated', 'activation-failed', 'process-uncertain', 'port-occupied', 'instance-running', 'package-context-unavailable', 'package-context-failed', 'package-context-timeout', 'private-unknown-code']) {
        await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, runtime(async () => ({ kind: 'blocked', code }))), error => /[\u4e00-\u9fff]/.test(error.message) && !error.message.includes('private-unknown'));
      }
    });
    await check('Isolated profiles cannot query or activate the real package registry', async () => {
      const host = { ...runtime(async () => { throw Error('must not inspect host'); }), isolatedHome: root };
      assert.deepEqual(await api.launchWindowsPackagedDesktop(ordinary, 9222, host), { packaged: false });
      await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9222, host), /隔离/);
      await assert.rejects(() => api.launchWindowsPackagedDesktop(ordinary, 9222, { ...host, isolatedHome: path.dirname(selected) }), /隔离/);
    });
    await check('Production PowerShell compiles COM interop and resolves the exact manifest Application, including Beta packages', async () => {
      assert.deepEqual(await probe(), { kind: 'resolved', aumid: 'OpenAI.CodexBeta_fixture!DesktopMain' });
      const alternate = manifest(app('Other', 'helper.exe') + app('ChangedId', 'app\\ChatGPT.exe'));
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: alternate } })).aumid, 'OpenAI.CodexBeta_fixture!ChangedId');
    });
    await check('Read-only native registry inspection recognizes an unregistered ordinary installation without activating apps', async () => {
      assert.equal((await probe(ordinary, {}, true)).kind, 'unpackaged');
    });
    await check('Native handles distinguish live, exited, absent and mismatched processes, and native TCP probes detect loopback readiness', async () => {
      const marker = '  $executable = [YunhuiPackagedDesktop.Native]::Canonical([string]$inputData.executable)';
      const segments = api.windowsPackagedLaunchSource.split(marker);
      assert.equal(segments.length, 2);
      const source = '$inputData = @{}\n' + segments[0] + String.raw`
  $self = [Diagnostics.Process]::GetCurrentProcess()
  $image = [YunhuiPackagedDesktop.Native]::Canonical($self.MainModule.FileName)
  $created = $self.StartTime.ToUniversalTime().ToFileTimeUtc()
  $watch = [YunhuiPackagedDesktop.Native]::Watch([uint32]$PID, $image, ($created - 10000000), [DateTime]::UtcNow.ToFileTimeUtc())
  $live = $watch.State(); $watch.Dispose()
  $watch = [YunhuiPackagedDesktop.Native]::Watch([uint32]$PID, ($image + '.different'), 0, [DateTime]::UtcNow.ToFileTimeUtc())
  $wrongImage = $watch.State(); $watch.Dispose()
  $watch = [YunhuiPackagedDesktop.Native]::Watch([uint32]$PID, $image, [DateTime]::UtcNow.ToFileTimeUtc(), [DateTime]::UtcNow.ToFileTimeUtc())
  $oldProcess = $watch.State(); $watch.Dispose()
  $watch = [YunhuiPackagedDesktop.Native]::Watch([uint32]::MaxValue, $image, 0, [DateTime]::UtcNow.ToFileTimeUtc())
  $absent = $watch.State(); $watch.Dispose()
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $self.MainModule.FileName
  $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 700"'
  $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
  $began = [DateTime]::UtcNow.ToFileTimeUtc()
  $child = [Diagnostics.Process]::Start($startInfo)
  $watch = [YunhuiPackagedDesktop.Native]::Watch([uint32]$child.Id, $image, $began, [DateTime]::UtcNow.ToFileTimeUtc())
  try {
    $beforeExit = $watch.State()
    if (!$child.WaitForExit(10000)) { throw 'private child did not complete' }
    $afterExit = $watch.State()
  } finally { $watch.Dispose(); $child.Dispose() }
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  try { $ready = [YunhuiPackagedDesktop.Native]::PortState($port) }
  finally { $listener.Stop() }
  $empty = [YunhuiPackagedDesktop.Native]::PortState($port)
  $running = [YunhuiPackagedDesktop.Native]::ExistingInstance($image)
  $none = [YunhuiPackagedDesktop.Native]::ExistingInstance((Join-Path (Get-Location).ProviderPath 'private-unstarted.exe'))
  Complete @{ live=$live; wrongImage=$wrongImage; oldProcess=$oldProcess; absent=$absent; beforeExit=$beforeExit; afterExit=$afterExit; ready=$ready; empty=$empty; running=$running; none=$none }
} catch { throw }
`;
      const scriptFile = write(path.join(root, 'native-process-probes.ps1'), '\ufeff' + source);
      const { stdout } = await runFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
      assert.deepEqual(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()), { live: 'alive', wrongImage: 'unknown', oldProcess: 'unknown', absent: 'exited', beforeExit: 'alive', afterExit: 'exited', ready: 'ready', empty: 'empty', running: 'running', none: 'none' });
    });
    await check('Native activation control flow submits only the selected AUMID and validated loopback debug flags', async () => {
      const result = await probe(selected, {}, false, true);
      assert.equal(result.kind, 'activated'); assert.equal(result.pid, 321);
      assert.deepEqual(result.activation, { aumid: 'OpenAI.CodexBeta_fixture!DesktopMain', arguments: '--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1' });
      assert.equal(result.context, null);
    });
    await check('Confirmed early exit uses the exact package context and keeps the helper alive until its loopback port is ready', async () => {
      const result = await probe(selected, { processState: 'exited' }, false, true);
      assert.equal(result.kind, 'context-ready'); assert.equal(result.portReady, true); assert.equal(result.pid, undefined);
      assert.deepEqual(result.context, {
        family: packageRecord.PackageFamilyName, appId: 'DesktopMain', command: fs.realpathSync.native(selected),
        arguments: '--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1', preventBreakaway: true,
        cwd: path.dirname(fs.realpathSync.native(selected)), codexHome: 'private-user-home', runtimeVariables: Array(7).fill(null),
      });
      assert(result.observation.checks >= 2); assert(result.observation.elapsed >= 150);
    });
    await check('Live, unreadable and reused PIDs never cause a second activation', async () => {
      const alive = await probe(selected, { portAfter: 'empty' }, false, true);
      assert.equal(alive.kind, 'activated'); assert.equal(alive.context, null);
      for (const fixture of [{ processState: 'unknown', portAfter: 'empty' }, { processState: 'exited', reusedPid: true }]) {
        const result = await probe(selected, fixture, false, true);
        assert.equal(result.code, 'process-uncertain'); assert.equal(result.context, null);
      }
      const handoff = await probe(selected, { processState: 'exited', portAfter: 'ready' }, false, true);
      assert.equal(handoff.kind, 'context-ready'); assert.equal(handoff.pid, undefined); assert.equal(handoff.context, null);
      const existingHandoff = await probe(selected, { processState: 'unknown', portAfter: 'ready' }, false, true);
      assert.equal(existingHandoff.kind, 'context-ready'); assert.equal(existingHandoff.pid, undefined); assert.equal(existingHandoff.context, null);
    });
    await check('Existing matching executables, unreadable paths and occupied or unknown ports prevent fallback', async () => {
      for (const [fixture, expected] of [
        [{ instanceState: 'running' }, 'instance-running'], [{ instanceState: 'unknown' }, 'process-uncertain'],
        [{ instanceAppeared: true }, 'instance-running'], [{ finalPortState: 'ready' }, 'port-occupied'],
        [{ portBefore: 'ready' }, 'port-occupied'], [{ portBefore: 'occupied' }, 'port-occupied'],
        [{ portBefore: 'unknown' }, 'process-uncertain'], [{ portAfter: 'occupied' }, 'port-occupied'],
        [{ portAfter: 'unknown' }, 'process-uncertain'],
      ]) {
        const result = await probe(selected, { processState: 'exited', ...fixture }, false, true);
        assert.equal(result.code, expected); assert.equal(result.context, null);
        if (fixture.portBefore) assert.equal(result.activation, null);
      }
    });
    await check('Missing, failing or non-ready package commands return bounded errors without a duplicate retry', async () => {
      for (const [fixture, expected] of [
        [{ missingPackageCommand: true }, 'package-context-unavailable'],
        [{ contextError: true }, 'package-context-failed'],
        [{ contextNeverReady: true }, 'package-context-timeout'],
        [{ contextPort: 'occupied' }, 'port-occupied'],
      ]) {
        const result = await probe(selected, { processState: 'exited', ...fixture }, false, true);
        assert.equal(result.code, expected);
        if (fixture.missingPackageCommand || fixture.contextError) assert.equal(result.context, null);
        if (fixture.contextNeverReady) assert(result.observation.checks >= 2);
      }
    });
    await check('Registration and manifest bindings are rechecked immediately before the package compatibility command', async () => {
      for (const fixture of [
        { fallbackPackages: [] },
        { fallbackPackages: [{ ...packageRecord, InstallLocation: path.dirname(foreign) }] },
        { fallbackPackages: [{ ...packageRecord, PackageFamilyName: 'Unrelated_fixture' }] },
        { fallbackManifest: manifest(app('ChangedId')) },
        { fallbackManifest: manifest(app('DesktopMain', 'other\\ChatGPT.exe')) },
        { fallbackManifest: manifest(app('DesktopMain') + app('DesktopMain')) },
      ]) {
        const result = await probe(selected, { processState: 'exited', ...fixture }, false, true);
        assert.equal(result.code, 'target-changed'); assert(result.activation); assert.equal(result.context, null);
      }
    });
    await check('Registration changes, elevation and COM failure stop native activation with Chinese guidance', async () => {
      for (const [fixture, expected, text] of [
        [{ currentPackages: [] }, 'target-changed', /已更新/],
        [{ currentPackages: [{ ...packageRecord, InstallLocation: path.dirname(foreign) }] }, 'target-changed', /已更新/],
        [{ elevated: true }, 'elevated', /管理员/],
        [{ activationError: true }, 'activation-failed', /商店包身份/],
      ]) {
        const result = await probe(selected, fixture, false, true);
        assert.equal(result.kind, 'blocked'); assert.equal(result.code, expected); assert.equal(result.activation, null);
        await assert.rejects(() => api.launchWindowsPackagedDesktop(selected, 9333, runtime(async () => result)), error => text.test(error.message) && !error.message.includes('private'));
      }
    });
    await check('Missing or mismatched registration never activates a different package', async () => {
      assert.equal((await probe(selected, { packages: [] })).code, 'unregistered');
      assert.equal((await probe(selected, { packages: [{ ...packageRecord, InstallLocation: path.dirname(path.dirname(foreign)) }] })).code, 'unregistered');
      assert.equal((await probe(selected, { registryError: true })).code, 'registry-unavailable');
      assert.equal((await probe(selected, { manifestError: true })).code, 'registry-unavailable');
    });
    await check('A stale unrelated package cannot block the selected package or an ordinary executable', async () => {
      const stale = { ...packageRecord, Name: 'Unrelated.Stale', PackageFullName: 'Unrelated_1', InstallLocation: path.join(root, 'missing-package') };
      assert.equal((await probe(selected, { packages: [stale, packageRecord] })).kind, 'resolved');
      assert.equal((await probe(ordinary, { packages: [stale] })).kind, 'unpackaged');
    });
    await check('Ambiguous applications and manifest path escapes are rejected', async () => {
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('One') + app('Two')) } })).code, 'ambiguous');
      for (const executable of ['..\\app\\ChatGPT.exe', 'app\\..\\app\\ChatGPT.exe', 'app\\resources\\ChatGPT.exe', 'C:\\Windows\\ChatGPT.exe', 'app\\ChatGPT.exe:stream', 'app\\ChatGPT.exe.']) {
        assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('Bad', executable)) } })).code, 'unregistered');
      }
    });
    await check('A manifest link to a different installation cannot claim the selected application', async () => {
      const linked = path.join(install, 'linked'); fs.symlinkSync(path.dirname(foreign), linked, 'junction');
      assert.equal((await probe(foreign, { manifests: { [packageRecord.PackageFullName]: manifest(app('Outside', 'linked\\ChatGPT.exe')) } })).kind, 'unpackaged');
      assert.equal((await probe(selected, { manifests: { [packageRecord.PackageFullName]: manifest(app('Outside', 'linked\\ChatGPT.exe')) } })).code, 'unregistered');
      fs.unlinkSync(linked);
    });
  }
  console.log(`Windows packaged desktop launch: ${passed} checks passed; no application was activated`);
} finally {
  if (path.dirname(root) === fs.realpathSync.native(os.tmpdir()) && path.basename(root).startsWith('yunhui-packaged-launch-')) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
