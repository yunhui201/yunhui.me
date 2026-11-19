import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export interface WindowsPackagedLaunchRequest {
  executable: string;
  port: number;
  packagedPath: boolean;
  /** Trusted diagnostic seam. Inspection never activates an application. */
  inspectOnly?: boolean;
}
export type WindowsPackagedLaunchReply =
  | { kind: 'unpackaged' }
  | { kind: 'resolved'; aumid: string }
  | { kind: 'activated'; pid: number }
  | { kind: 'context-ready'; portReady: true }
  | { kind: 'blocked'; code: string };
export interface WindowsPackagedLaunchRuntime {
  platform: NodeJS.Platform;
  isolatedHome?: string;
  /** Main-process test injection only; never populated from renderer payloads. */
  run(request: WindowsPackagedLaunchRequest): Promise<WindowsPackagedLaunchReply>;
}

// Fixed source, also exercised with private registration fixtures in tests. The
// selected executable and port arrive as base64-encoded JSON, never shell code.
export const windowsPackagedLaunchSource = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Complete($value) {
  $json = $value | ConvertTo-Json -Compress
  if ($inputData.resultFile) { [IO.File]::WriteAllText([string]$inputData.resultFile, $json, (New-Object Text.UTF8Encoding($false))) }
  else { $json }
}
function Block([string]$code) { Complete @{ kind = 'blocked'; code = $code }; exit }
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace YunhuiPackagedDesktop {
  [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    [PreserveSig] int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    [PreserveSig] int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr items, out uint processId);
  }
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    struct FileTime { public uint Low; public uint High; public long Value { get { return ((long)High << 32) | Low; } } }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ProcessEntry {
      public uint Size, Usage, Pid; public UIntPtr Heap;
      public uint Module, Threads, ParentPid; public int Priority; public uint Flags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(SafeFileHandle handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(SafeFileHandle handle, uint flags, StringBuilder image, ref uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
    public static string Canonical(string name) {
      using (SafeFileHandle handle = CreateFile(name, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var result = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
        if (length == 0 || length >= result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        string value = result.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
        return value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value.Substring(4) : value;
      }
    }
    static long Created(SafeFileHandle handle) {
      FileTime created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return created.Value;
    }
    static string ImagePath(SafeFileHandle handle) {
      var value = new StringBuilder(32768); uint length = (uint)value.Capacity;
      if (!QueryFullProcessImageName(handle, 0, value, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return Canonical(value.ToString());
    }
    public sealed class ActivationWatch : IDisposable {
      SafeFileHandle handle;
      uint pid;
      long created;
      bool absent, uncertain;
      internal ActivationWatch(uint value, string executable, long started, long returned) {
        pid = value;
        handle = OpenProcess(0x00101000, false, pid); // synchronize + limited query
        if (handle.IsInvalid) { absent = Marshal.GetLastWin32Error() == 87; uncertain = !absent; return; }
        try {
          created = Created(handle);
          // Reject a pre-existing process, a reused PID, or a different binary.
          uncertain = created < started || created > returned || !String.Equals(ImagePath(handle), executable, StringComparison.OrdinalIgnoreCase);
        } catch { uncertain = true; }
      }
      public string State() {
        if (uncertain) return "unknown";
        if (!absent) {
          uint state = WaitForSingleObject(handle, 0);
          if (state == 258) return "alive";
          if (state != 0) return "unknown";
        }
        // Retain the original handle throughout observation; never mistake a
        // newly reused PID for the process returned by ActivateApplication.
        using (SafeFileHandle current = OpenProcess(0x00101000, false, pid)) {
          if (current.IsInvalid) return Marshal.GetLastWin32Error() == 87 ? "exited" : "unknown";
          if (absent) return "unknown";
          try { return Created(current) == created && WaitForSingleObject(current, 0) == 0 ? "exited" : "unknown"; }
          catch { return "unknown"; }
        }
      }
      public void Dispose() { if (handle != null) handle.Dispose(); }
    }
    public static ActivationWatch Watch(uint pid, string executable, long started, long returned) { return new ActivationWatch(pid, executable, started, returned); }
    public static string ExistingInstance(string executable) {
      // Toolhelp provides names without opening unrelated/protected processes.
      // Every matching name then requires a readable canonical executable path.
      using (SafeFileHandle snapshot = CreateToolhelp32Snapshot(2, 0)) {
        if (snapshot.IsInvalid) return "unknown";
        var entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(entry);
        bool found = Process32First(snapshot, ref entry); int count = 0;
        while (found) {
          if (++count > 65536) return "unknown";
          if (String.Equals(entry.Name, Path.GetFileName(executable), StringComparison.OrdinalIgnoreCase)) {
            using (SafeFileHandle process = OpenProcess(0x00101000, false, entry.Pid)) {
              if (process.IsInvalid) { if (Marshal.GetLastWin32Error() != 87) return "unknown"; }
              else {
                uint state = WaitForSingleObject(process, 0);
                if (state == 258) {
                  try { if (String.Equals(ImagePath(process), executable, StringComparison.OrdinalIgnoreCase)) return "running"; }
                  catch { return "unknown"; }
                } else if (state != 0) return "unknown";
              }
            }
          }
          found = Process32Next(snapshot, ref entry);
        }
        return Marshal.GetLastWin32Error() == 18 ? "none" : "unknown";
      }
    }
    public static string PortState(int port) {
      try {
        bool occupied = false;
        foreach (IPEndPoint listener in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()) if (listener.Port == port) { occupied = true; break; }
        if (!occupied) return "empty";
        using (var client = new TcpClient(AddressFamily.InterNetwork)) {
          IAsyncResult attempt = client.BeginConnect(IPAddress.Loopback, port, null, null);
          try {
            if (!attempt.AsyncWaitHandle.WaitOne(100)) return "occupied";
            try { client.EndConnect(attempt); return client.Connected ? "ready" : "occupied"; }
            catch { return "occupied"; }
          } finally { attempt.AsyncWaitHandle.Close(); }
        }
      } catch { return "unknown"; }
    }
    public static uint Activate(string aumid, string arguments) {
      object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
      try {
        uint pid;
        int result = ((IApplicationActivationManager)instance).ActivateApplication(aumid, arguments, 0, out pid);
        Marshal.ThrowExceptionForHR(result);
        if (pid == 0) throw new InvalidOperationException("No activation process");
        return pid;
      } finally { if (Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance); }
    }
  }
}
'@
  function Get-LaunchPortState { [YunhuiPackagedDesktop.Native]::PortState([int]$inputData.port) }
  function Assert-CurrentRegistration {
    $current = @(Get-AppxPackage -Name $match.package.Name -ErrorAction Stop | Where-Object { $_.PackageFullName -ceq $match.package.PackageFullName })
    if ($current.Count -ne 1 -or $current[0].Name -cne $match.package.Name -or $current[0].PackageFamilyName -cne $match.package.PackageFamilyName -or [YunhuiPackagedDesktop.Native]::Canonical([string]$current[0].InstallLocation).TrimEnd('\') -ine $match.root -or [YunhuiPackagedDesktop.Native]::Canonical($executable) -ine $executable) { Block 'target-changed' }
    $currentManifest = Get-AppxPackageManifest -Package $current[0].PackageFullName -ErrorAction Stop
    $currentApps = @($currentManifest.Package.Applications.Application)
    if ($currentApps.Count -gt 64) { Block 'target-changed' }
    $currentApp = @($currentApps | Where-Object { [string]$_.Id -ceq $match.appId })
    if ($currentApp.Count -ne 1 -or [string]$currentApp[0].Executable -ine $match.relative -or [YunhuiPackagedDesktop.Native]::Canonical((Join-Path $match.root ([string]$currentApp[0].Executable))) -ine $executable) { Block 'target-changed' }
  }
  function Assert-EmptyPort {
    $state = Get-LaunchPortState
    if ($state -eq 'unknown') { Block 'process-uncertain' }
    if ($state -ne 'empty') { Block 'port-occupied' }
  }
  function Assert-NoExistingInstance {
    $instance = [YunhuiPackagedDesktop.Native]::ExistingInstance($executable)
    if ($instance -eq 'running') { Block 'instance-running' }
    if ($instance -ne 'none') { Block 'process-uncertain' }
  }
  $executable = [YunhuiPackagedDesktop.Native]::Canonical([string]$inputData.executable)
  if ($executable -ine [string]$inputData.executable) { Block 'target-changed' }
  if ([IO.Path]::GetFileName($executable) -notmatch '^(ChatGPT( Beta)?|Codex)\.exe$') { Block 'invalid-target' }
  if ([int]$inputData.port -lt 1024 -or [int]$inputData.port -gt 65535) { Block 'invalid-port' }
  $packages = @(Get-AppxPackage -ErrorAction Stop | Select-Object -First 2049)
  if ($packages.Count -gt 2048) { Block 'ambiguous' }
  $candidates = @(); $insidePackage = $false
  foreach ($package in $packages) {
    if (![string]$package.InstallLocation) { continue }
    if (![IO.Path]::IsPathRooted([string]$package.InstallLocation)) { continue }
    $registeredRoot = [IO.Path]::GetFullPath([string]$package.InstallLocation).TrimEnd('\')
    $lexicallyRelated = $executable.StartsWith($registeredRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    try { $root = [YunhuiPackagedDesktop.Native]::Canonical($registeredRoot).TrimEnd('\') }
    catch {
      # A stale/unreadable unrelated package must not disable ordinary desktop
      # apps. A selected package still fails closed; aliases that cannot resolve
      # cannot become an activation candidate or bypass packagedPath below.
      if ($lexicallyRelated) { Block 'registry-unavailable' }
      continue
    }
    if (!$executable.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $insidePackage = $true
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
    $applications = @($manifest.Package.Applications.Application)
    if ($applications.Count -gt 64) { Block 'ambiguous' }
    foreach ($application in $applications) {
      $relative = [string]$application.Executable
      $parts = @($relative -split '[\\/]')
      if (!$relative -or [IO.Path]::IsPathRooted($relative) -or $parts.Count -gt 32) { continue }
      $invalid = @($parts | Where-Object { !$_ -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[:\x00-\x1f\x7f]' -or $_ -match '[ .]$' -or $_ -ieq 'resources' })
      if ($invalid.Count -or $parts[-1] -notmatch '^(ChatGPT( Beta)?|Codex)\.exe$') { continue }
      $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
      if (!$file.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
      $actual = [YunhuiPackagedDesktop.Native]::Canonical($file)
      if (!$actual.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $actual -ine $executable) { continue }
      $appId = [string]$application.Id; $family = [string]$package.PackageFamilyName
      if ($appId -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$' -or $family -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$') { Block 'invalid-identity' }
      $candidates += @{ aumid = $family + '!' + $appId; package = $package; root = $root; appId = $appId; relative = $relative }
    }
  }
  if (!$candidates.Count) {
    if ($inputData.packagedPath -or $insidePackage) { Block 'unregistered' }
    Complete @{ kind = 'unpackaged' }; exit
  }
  if ($candidates.Count -ne 1) { Block 'ambiguous' }
  $match = $candidates[0]
  if ($inputData.inspectOnly) { Complete @{ kind = 'resolved'; aumid = $match.aumid }; exit }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Block 'elevated' }
  # Revalidate the registration in the same helper immediately before activation.
  # AUMIDs survive Store updates; an old selected path must not launch a new package.
  Assert-CurrentRegistration
  Assert-EmptyPort
  $arguments = '--remote-debugging-port=' + [int]$inputData.port + ' --remote-debugging-address=127.0.0.1'
  $started = [DateTime]::UtcNow.ToFileTimeUtc()
  try {
    $activatedPid = [YunhuiPackagedDesktop.Native]::Activate($match.aumid, $arguments)
  } catch { Block 'activation-failed' }
  $returned = [DateTime]::UtcNow.ToFileTimeUtc()
  $watch = [YunhuiPackagedDesktop.Native]::Watch($activatedPid, $executable, $started, $returned)
  try {
    $observation = [Diagnostics.Stopwatch]::StartNew()
    $exitSeenAt = $null
    while ($true) {
      $processState = $watch.State()
      $portState = Get-LaunchPortState
      if ($portState -eq 'ready') {
        if ($processState -eq 'alive') { Complete @{ kind = 'activated'; pid = $activatedPid } }
        else { Complete @{ kind = 'context-ready'; portReady = $true } }
        exit
      }
      if ($processState -eq 'unknown') { Block 'process-uncertain' }
      if ($portState -eq 'unknown') { Block 'process-uncertain' }
      if ($portState -ne 'empty') { Block 'port-occupied' }
      if ($processState -eq 'exited') {
        if ($null -eq $exitSeenAt) { $exitSeenAt = $observation.ElapsedMilliseconds }
        if ($observation.ElapsedMilliseconds - $exitSeenAt -ge 2000) { break }
      } else {
        if ($null -ne $exitSeenAt) { Block 'process-uncertain' }
        if ($observation.ElapsedMilliseconds -ge 8000) {
          Complete @{ kind = 'activated'; pid = $activatedPid }; exit
        }
      }
      Start-Sleep -Milliseconds 100
    }
    # Only a successful activation followed by a positively confirmed exit can
    # use the compatibility path. A failed/unknown launch must never be retried.
    $packageCommand = Get-Command -Name Invoke-CommandInDesktopPackage -CommandType Cmdlet -ErrorAction SilentlyContinue
    if (!$packageCommand) { Block 'package-context-unavailable' }
    Assert-NoExistingInstance
    foreach ($variable in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_OVERRIDE_DIST_PATH', 'VSCODE_INSPECTOR_OPTIONS', 'VSCODE_NODE_OPTIONS')) {
      [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
    }
    Set-Location -LiteralPath ([IO.Path]::GetDirectoryName($executable))
    Assert-CurrentRegistration
    Assert-NoExistingInstance
    Assert-EmptyPort
    if ($watch.State() -ne 'exited') { Block 'process-uncertain' }
    try {
      & $packageCommand -PackageFamilyName $match.package.PackageFamilyName -AppId $match.appId -Command $executable -Args $arguments -PreventBreakaway -ErrorAction Stop | Out-Null
    } catch { Block 'package-context-failed' }
    # The debugging package context can end with its caller. Keep this helper
    # alive until loopback startup is observed; main then validates actual CDP.
    $contextWait = [Diagnostics.Stopwatch]::StartNew()
    while ($contextWait.ElapsedMilliseconds -lt 20000) {
      $portState = Get-LaunchPortState
      if ($portState -eq 'ready') { Complete @{ kind = 'context-ready'; portReady = $true }; exit }
      if ($portState -eq 'unknown') { Block 'process-uncertain' }
      if ($portState -ne 'empty') { Block 'port-occupied' }
      Start-Sleep -Milliseconds 100
    }
    Block 'package-context-timeout'
  } finally { if ($watch) { $watch.Dispose() } }
} catch { Block 'registry-unavailable' }
`;

const messages: Record<string, string> = {
  'target-changed': '桌面客户端或商店包在启动前已更新，请重新检测并选择当前安装的程序。',
  'invalid-target': '所选程序不是受支持的 ChatGPT / Codex 桌面主程序，请重新选择。',
  'invalid-port': '调试端口必须是 1024–65535 的整数。',
  'registry-unavailable': '无法核对当前用户的 Windows 商店应用注册信息，未直接运行包内程序。请以安装客户端的 Windows 账号运行云汇后重试。',
  'ambiguous': '所选程序对应多个商店应用入口，无法安全确定启动目标，请重新选择已安装的客户端。',
  'unregistered': '所选程序位于商店应用包中，但没有找到当前用户已注册的对应启动入口。请从开始菜单确认客户端可用，重新安装或重新选择程序后再连接。',
  'invalid-identity': '商店应用清单没有有效的启动标识，请重新安装客户端后再连接。',
  'elevated': '商店版客户端需要普通用户权限启动。请关闭云汇的“以管理员身份运行”，重新打开后再连接。',
  'activation-failed': 'Windows 未能以商店包身份启动客户端。请完全退出客户端，确认开始菜单可以打开，并以普通权限重新连接。',
  'process-uncertain': '无法确认客户端进程或端口状态，已停止重复启动。请完全退出客户端后，以普通用户权限重新连接。',
  'port-occupied': '调试端口已被占用，已停止重复启动。请退出此前的客户端或更换调试端口后重新连接。',
  'instance-running': '所选客户端仍有进程运行，已停止重复启动。请完全退出该客户端后重新连接。',
  'package-context-unavailable': '当前 Windows 缺少商店应用兼容启动命令。请更新 Windows，并确认开始菜单可以打开客户端后重新连接。',
  'package-context-failed': 'Windows 商店应用兼容启动失败。请完全退出客户端，确认开始菜单可以打开，并以普通权限重新连接。',
  'package-context-timeout': '商店客户端已尝试兼容启动，但调试端口尚未就绪。请查看客户端窗口或系统提示后重新连接。',
};

async function nativeRun(request: WindowsPackagedLaunchRequest): Promise<WindowsPackagedLaunchReply> {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot) || /[\x00-\x1f\x7f]/.test(systemRoot)) throw new Error('Windows 系统目录无效，无法启动商店客户端。');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-packaged-host-'));
  const resultFile = path.join(temporaryRoot, 'result.json');
  const scriptFile = path.join(temporaryRoot, 'launch.ps1');
  const data = Buffer.from(JSON.stringify({ ...request, resultFile }), 'utf8').toString('base64');
  const source = `$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n` + windowsPackagedLaunchSource;
  const cleanup = () => {
    // Only our generated result and empty private directory are removable.
    try { fs.unlinkSync(resultFile); } catch { /* The helper may have failed before writing. */ }
    try { fs.unlinkSync(scriptFile); } catch { /* The helper may have failed before writing. */ }
    try { fs.rmdirSync(temporaryRoot); } catch { /* Never recursively remove unexpected contents. */ }
  };
  // A UTF-8 BOM is required for Windows PowerShell 5.1. A private script file
  // avoids Windows' command-line length limit after encoding the native helper.
  try { fs.writeFileSync(scriptFile, '\uFEFF' + source, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch { cleanup(); throw new Error('无法创建商店客户端启动助手，请确认临时目录可写后重试。'); }
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())) delete env[name];
    // A packaged child may retain inherited output handles. Null stdio and an
    // owned result file let helper exit complete independently of that child.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        { windowsHide: true, stdio: 'ignore', shell: false, env });
    } catch { cleanup(); reject(new Error(messages['registry-unavailable'])); return; }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error('Windows 商店应用启动超时，请检查客户端窗口或系统提示后重试；未改用直接启动。'));
    }, 50_000);
    child.once('error', () => {
      clearTimeout(timer); cleanup();
      if (!settled) { settled = true; reject(new Error(messages['registry-unavailable'])); }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      try {
        if (settled) return;
        settled = true;
        if (code !== 0) { reject(new Error(messages['registry-unavailable'])); return; }
        const stat = fs.lstatSync(resultFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error();
        resolve(JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '').trim()));
      } catch { reject(new Error('Windows 返回的商店启动信息不完整，请重新检测客户端后重试。')); }
      finally { cleanup(); }
    });
  });
}

function knownPackagePath(executable: string): boolean {
  if (/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(executable)) return true;
  let current = path.dirname(executable);
  for (let depth = 0; depth < 8; depth++) {
    try { fs.lstatSync(path.join(current, 'AppxManifest.xml')); return true; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw new Error(messages['registry-unavailable']); }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  return false;
}

/** MSIX activation is a distinct operation: errors must never fall through to raw spawn. */
export async function launchWindowsPackagedDesktop(executable: string, port: number, runtime?: WindowsPackagedLaunchRuntime): Promise<{ packaged: boolean; pid?: number }> {
  const host = runtime ?? { platform: process.platform, isolatedHome: process.env.AURORA_CLIENT_HOME, run: nativeRun };
  if (host.platform !== 'win32') throw new Error('商店应用激活仅支持 Windows。');
  if (typeof executable !== 'string' || executable.length > 4096 || !path.win32.isAbsolute(executable) || /[\x00-\x1f\x7f]/.test(executable)
    || !/^(?:ChatGPT(?: Beta)?|Codex)\.exe$/i.test(path.win32.basename(executable))) throw new Error(messages['invalid-target']);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(messages['invalid-port']);
  let selected: string;
  try { selected = fs.realpathSync.native(executable); if (!fs.statSync(selected).isFile()) throw new Error(); }
  catch { throw new Error('桌面程序路径不可用，请重新检测或重新选择客户端。'); }
  if (!/^(?:ChatGPT(?: Beta)?|Codex)\.exe$/i.test(path.win32.basename(selected))) throw new Error(messages['invalid-target']);
  const packagedPath = knownPackagePath(executable) || knownPackagePath(selected);
  if (host.isolatedHome) {
    const relative = path.relative(fs.realpathSync.native(host.isolatedHome), selected);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || packagedPath) throw new Error('隔离运行期间不会查询或激活真实 Windows 商店应用，请使用隔离的普通桌面测试程序。');
    return { packaged: false };
  }
  const reply = await host.run({ executable: selected, port, packagedPath });
  if (reply?.kind === 'activated' && Number.isInteger(reply.pid) && reply.pid > 0 && reply.pid <= 0xffffffff) return { packaged: true, pid: reply.pid };
  if (reply?.kind === 'context-ready' && reply.portReady === true) return { packaged: true };
  if (reply?.kind === 'unpackaged' && !packagedPath) return { packaged: false };
  if (reply?.kind === 'blocked') throw new Error(messages[reply.code] || messages['registry-unavailable']);
  throw new Error(packagedPath ? messages.unregistered : 'Windows 未确认商店客户端启动结果，请重新检测后重试。');
}
