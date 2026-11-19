"""Exercise the real Windows portable launcher with concurrent, isolated startups.

Requires Python Playwright and explicit --exe/--launcher paths. The reference
unpacked build must match dist. Both launches share a disposable Chromium profile
and use a TEMP path containing spaces. Windows Job Objects own every process from
before its first instruction, so cleanup cannot target another running user app.
No client is launched/configured and no supplier, login or model request is used.
Final cleanup is exercised under a real Windows read handle without delete
sharing, which is released only after the launcher has reached cleanup.
"""
import argparse
import ctypes
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('packaged_helpers', ROOT / 'scripts/test-packaged.py')
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)


class StartupInfo(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR),
                ('lpDesktop', wintypes.LPWSTR), ('lpTitle', wintypes.LPWSTR),
                ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD),
                ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD),
                ('dwXCountChars', wintypes.DWORD), ('dwYCountChars', wintypes.DWORD),
                ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD),
                ('lpReserved2', ctypes.POINTER(ctypes.c_ubyte)),
                ('hStdInput', wintypes.HANDLE), ('hStdOutput', wintypes.HANDLE),
                ('hStdError', wintypes.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE),
                ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)]


class BasicLimit(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ['ReadOperationCount', 'WriteOperationCount',
                'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount']]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', BasicLimit), ('IoInfo', IoCounters),
                ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


class JobPids(ctypes.Structure):
    _fields_ = [('assigned', wintypes.DWORD), ('count', wintypes.DWORD), ('pids', ctypes.c_size_t * 256)]


class OwnedJob:
    """Create suspended children, assign them to this job, then let them run."""
    def __init__(self):
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            'SetInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            'QueryInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
            'AssignProcessToJobObject': ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            'CreateProcessW': ([wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                                ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)], wintypes.BOOL),
            'ResumeThread': ([wintypes.HANDLE], wintypes.DWORD),
            'GetExitCodeProcess': ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
            'TerminateProcess': ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            'TerminateJobObject': ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            'WaitForSingleObject': ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            'CloseHandle': ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            method = getattr(self.kernel, name)
            method.argtypes, method.restype = arguments, result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        self.check(self.handle)
        self.processes = []
        limit = ExtendedLimit()
        limit.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        self.check(self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limit), ctypes.sizeof(limit)))

    @staticmethod
    def check(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    def start(self, arguments, cwd, environment, log):
        import msvcrt
        startup, process = StartupInfo(), ProcessInfo()
        startup.cb, startup.dwFlags = ctypes.sizeof(startup), 0x100  # STARTF_USESTDHANDLES
        with open(os.devnull, 'rb') as null:
            handles = [msvcrt.get_osfhandle(null.fileno()), msvcrt.get_osfhandle(log.fileno())]
            previous = [os.get_handle_inheritable(handle) for handle in handles]
            try:
                for handle in handles:
                    os.set_handle_inheritable(handle, True)
                startup.hStdInput, startup.hStdOutput, startup.hStdError = handles[0], handles[1], handles[1]
                command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(value) for value in arguments]))
                block = ctypes.create_unicode_buffer('\0'.join(f'{key}={value}' for key, value in sorted(environment.items(), key=lambda item: item[0].upper())) + '\0\0')
                self.check(self.kernel.CreateProcessW(str(arguments[0]), command, None, None, True,
                           0x08000000 | 0x00000400 | 0x00000004, block, str(cwd),
                           ctypes.byref(startup), ctypes.byref(process)))
            finally:
                for handle, inherited in zip(handles, previous):
                    os.set_handle_inheritable(handle, inherited)
        try:
            self.check(self.kernel.AssignProcessToJobObject(self.handle, process.hProcess))
            if self.kernel.ResumeThread(process.hThread) == 0xFFFFFFFF:
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.kernel.TerminateProcess(process.hProcess, 1)
            self.kernel.WaitForSingleObject(process.hProcess, 5000)
            self.kernel.CloseHandle(process.hProcess)
            raise
        finally:
            self.kernel.CloseHandle(process.hThread)
        self.processes.append(process)
        return process

    def exit_code(self, process):
        if self.kernel.WaitForSingleObject(process.hProcess, 0) == 258:
            return None
        code = wintypes.DWORD()
        self.check(self.kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(code)))
        return code.value

    def pids(self):
        result = JobPids()
        self.check(self.kernel.QueryInformationJobObject(self.handle, 3, ctypes.byref(result), ctypes.sizeof(result), None))
        assert result.count <= 256, 'Unexpected number of isolated child processes'
        return set(result.pids[:result.count])

    def close(self):
        if self.handle:
            # Only processes assigned to this unnamed, private job can be affected.
            self.kernel.TerminateJobObject(self.handle, 1)
            self.kernel.CloseHandle(self.handle)
            self.handle = None
            for process in self.processes:
                self.kernel.WaitForSingleObject(process.hProcess, 5000)
                self.kernel.CloseHandle(process.hProcess)


class CleanupReadLock:
    """Hold only the verified fixture image, allowing reads/writes but not deletion."""
    def __init__(self, executable, temporary):
        executable = executable.resolve()
        assert executable.is_file() and executable.is_relative_to(temporary.resolve())
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                           ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        self.kernel.CreateFileW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.invalid = ctypes.c_void_p(-1).value
        # GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING.
        self.handle = self.kernel.CreateFileW(str(executable), 0x80000000, 3, None, 3, 0x80, None)
        if self.handle == self.invalid:
            self.handle = None
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            # Request DELETE access without deleting anything. The held read handle
            # must deny it with ERROR_SHARING_VIOLATION, not a guessed simulation.
            probe = self.kernel.CreateFileW(str(executable), 0x10000, 7, None, 3, 0x80, None)
            error = ctypes.get_last_error()
            if probe != self.invalid:
                self.kernel.CloseHandle(probe)
            assert probe == self.invalid and error == 32, f'Delete sharing was not blocked: {error}'
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def app_windows(job):
    user = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    ids, windows = job.pids(), []

    @callback_type
    def visit(window, _):
        pid = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if pid.value in ids and user.IsWindowVisible(window):
            name, rect = ctypes.create_unicode_buffer(256), wintypes.RECT()
            user.GetClassNameW(window, name, 256)
            user.GetWindowRect(window, ctypes.byref(rect))
            if name.value.startswith('Chrome_WidgetWin') and rect.right - rect.left >= 300 and rect.bottom - rect.top >= 300:
                windows.append({'hwnd': int(window), 'pid': pid.value})
        return True

    user.EnumWindows(visit, 0)
    return windows


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/catalog':
            content = HELPERS.CatalogHandler.catalog
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.reject()

    def reject(self):
        self.send_response(502)
        self.send_header('Content-Length', '0')
        self.end_headers()

    do_CONNECT = reject
    do_POST = reject


class ExtractionWatcher:
    def __init__(self, directory, executable_name):
        self.directory, self.executable_name = directory, executable_name
        self.lock, self.stop = threading.Lock(), threading.Event()
        self.seen = {}
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            for child in self.directory.iterdir():
                for candidate in [child / 'app', child]:
                    try:
                        executable = candidate / self.executable_name
                        if candidate.is_dir() and (candidate.name == 'app' or executable.is_file()):
                            with self.lock:
                                record = self.seen.setdefault(str(candidate.resolve()), {'firstSeen': time.monotonic(), 'executableSeen': False})
                                record['executableSeen'] |= executable.is_file()
                    except OSError:
                        pass  # A losing portable launcher can remove its directory during enumeration.
            self.stop.wait(.02)

    def records(self):
        with self.lock:
            return {key: dict(value) for key, value in self.seen.items()}


def invoke(page, action, payload=None, timeout=15000):
    # Playwright evaluate itself has no timeout. A main-process stall must produce
    # a test failure so the finally block can clean the owned job and write logs.
    return page.evaluate("""async ({action, payload, timeout}) => {
        let timer;
        try {
            return await Promise.race([
                window.aurora.invoke(action, payload || {}),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`IPC ${action} timed out after ${timeout} ms`)), timeout);
                })
            ]);
        } finally { clearTimeout(timer); }
    }""", {'action': action, 'payload': payload, 'timeout': timeout})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True, help='Reference win-unpacked/YunHuiAI.exe')
    parser.add_argument('--launcher', type=Path, required=True, help='Actual NSIS portable EXE')
    parser.add_argument('--version', default=json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'])
    parser.add_argument('--report-dir', type=Path, default=ROOT / 'tmp/portable-startup-artifacts')
    parser.add_argument('--timeout', type=float, default=150, help='Concurrent extraction/startup deadline in seconds')
    args = parser.parse_args()
    assert sys.platform == 'win32', 'This acceptance test requires native Windows'
    executable, launcher = args.exe.resolve(), args.launcher.resolve()
    assert executable.is_file() and launcher.is_file(), 'Finish packaging both supplied artifacts first'
    asar = executable.parent / 'resources/app.asar'
    package = json.loads(HELPERS.read_asar(asar, 'package.json'))
    assert package['version'] == args.version, f'Unexpected package version: {package["version"]}'
    main_bytes = HELPERS.read_asar(asar, 'dist/main/main.cjs')
    assert main_bytes == (ROOT / 'dist/main/main.cjs').read_bytes(), 'The package differs from the current main build'
    assert b'YUNHUI_TEST_ISOLATED' in main_bytes, 'Refusing a package without the login-item isolation guard'
    assert HELPERS.read_asar(asar, 'dist/ui/index.html') == (ROOT / 'dist/ui/index.html').read_bytes(), 'The package differs from the current UI build'
    asar_hash = HELPERS.sha256(asar)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix='run-', dir=args.report_dir.resolve()))
    data, clients, chromium = profile / 'data', profile / 'clients', profile / 'Shared Chromium Profile'
    temporary = profile / 'Windows Temp With Spaces'
    for directory in [data, clients / '.claude', clients / '.codex', chromium, temporary, profile / 'appdata', profile / 'localappdata']:
        directory.mkdir(parents=True, exist_ok=True)
    client_files = {
        clients / '.claude/settings.json': b'{"permissions":{"allow":["Read"]},"env":{"FIXTURE":"unchanged"}}\n',
        clients / '.codex/config.toml': b'model = "fixture-model"\n',
    }
    for file, content in client_files.items():
        file.write_bytes(content)
    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    proxy = f'http://127.0.0.1:{server.server_port}'
    (data / 'settings.json').write_text(json.dumps({
        'theme': 'light', 'gatewayHost': '127.0.0.1', 'gatewayPort': HELPERS.free_port(),
        'autoStartGateway': False, 'autoCheckUpdate': False, 'autoSyncModels': False,
        'closeToTray': False, 'launchAtLogin': False,
        'proxy': proxy, 'catalogUrl': proxy + '/catalog',
    }), encoding='utf-8')
    keep = {'systemroot', 'windir', 'path', 'pathext', 'comspec', 'programfiles', 'programfiles(x86)',
            'programdata', 'commonprogramfiles', 'commonprogramfiles(x86)', 'processor_architecture',
            'number_of_processors', 'os'}
    environment = {key: value for key, value in os.environ.items() if key.lower() in keep}
    environment.update(TEMP=str(temporary), TMP=str(temporary), AURORA_HOME=str(data), YUNHUI_HOME=str(data),
                       AURORA_CLIENT_HOME=str(clients), YUNHUI_TEST_ISOLATED='1', USERPROFILE=str(clients), HOME=str(clients),
                       CODEX_HOME=str(clients / '.codex'), APPDATA=str(profile / 'appdata'), LOCALAPPDATA=str(profile / 'localappdata'),
                       HTTP_PROXY=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy, NO_PROXY='127.0.0.1,localhost')
    job, watcher, logs, cleanup_lock = None, ExtractionWatcher(temporary, executable.name), [], None
    report = {'passed': False, 'version': args.version, 'launcher': str(launcher),
              'launcherSha256': HELPERS.sha256(launcher), 'referenceAsarSha256': asar_hash,
              'profile': str(profile), 'temporaryPathContainsSpaces': True, 'checks': []}
    errors, processes = [], []
    ports = [HELPERS.free_port(), HELPERS.free_port()]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        job = OwnedJob()
        watcher.thread.start()
        started = time.monotonic()
        for index, port in enumerate(ports):
            log = (profile / f'launcher-{index + 1}.log').open('wb')
            logs.append(log)
            processes.append(job.start([launcher, f'--remote-debugging-port={port}',
                             f'--user-data-dir={chromium}', f'--proxy-server={proxy}',
                             '--proxy-bypass-list=localhost;127.0.0.1'], profile, environment, log))
        report['launchGapSeconds'] = round(time.monotonic() - started, 3)
        report['launcherPids'] = [process.dwProcessId for process in processes]
        debug_port = None
        deadline = started + args.timeout
        while time.monotonic() < deadline:
            for port in ports:
                try:
                    with opener.open(f'http://127.0.0.1:{port}/json/version', timeout=.3) as response:
                        metadata = json.load(response)
                    if metadata.get('webSocketDebuggerUrl'):
                        debug_port = port
                        break
                except (OSError, urllib.error.URLError):
                    pass
            if debug_port is not None:
                break
            codes = [job.exit_code(process) for process in processes]
            assert any(code is None for code in codes), f'Both portable wrappers exited before the UI started: {codes}'
            time.sleep(.1)
        assert debug_port is not None, 'Portable startup timed out; inspect launcher logs and observed extraction directories'
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            context = browser.contexts[0]
            page = context.pages[0] if context.pages else context.wait_for_event('page', timeout=30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True).wait_for(timeout=30000)
            report['firstVisibleSeconds'] = round(time.monotonic() - started, 3)
            state = invoke(page, 'state.get')
            assert state['version'] == args.version and Path(state['dataDir']).resolve() == data.resolve(), state
            assert state['providers'] == [] and state['gateway']['running'] is False, state
            packaged = invoke(page, 'app.isDev')
            runtime_asar = Path(packaged['root']).resolve()
            runtime_dir = runtime_asar.parent.parent
            assert packaged['dev'] is False and runtime_dir.is_relative_to(temporary), packaged
            assert HELPERS.sha256(runtime_asar) == asar_hash, 'The portable runtime differs from the reference package'
            report['runtimeDirectory'] = str(runtime_dir)
            report['checks'].append('Real portable app launches from a TEMP path containing spaces and renders the verified ASAR')

            while time.monotonic() < deadline:
                codes = [job.exit_code(process) for process in processes]
                if sum(code is None for code in codes) == 1:
                    break
                assert any(code is None for code in codes), f'Both wrappers unexpectedly exited: {codes}'
                page.wait_for_timeout(100)
            codes = [job.exit_code(process) for process in processes]
            assert codes.count(None) == 1 and codes.count(0) == 1, f'Second instance must exit cleanly while one remains alive: {codes}'
            report['exitCodesAfterSecondInstance'] = codes
            seen = watcher.records()
            assert len(seen) == 2, f'Concurrent launches must have two distinct extraction directories: {seen}'
            assert all(record['executableSeen'] for record in seen.values()), f'Both extracted executables must be observed: {seen}'
            assert str(runtime_dir) in seen, 'Live runtime is missing from extraction observations'
            other = next(Path(directory) for directory in seen if Path(directory) != runtime_dir)
            assert not other.exists(), f'Exited launcher left its extraction directory: {other}'
            assert runtime_dir.is_dir() and HELPERS.sha256(runtime_asar) == asar_hash, 'Exiting the duplicate damaged the live runtime'
            report['checks'].append('Concurrent launchers use distinct extraction directories; duplicate exits with code 0 and removes only its own files')

            visible = app_windows(job)
            assert len(visible) == 1, f'Expected one visible isolated app window after concurrent launches: {visible}'
            assert len(context.pages) == 1, 'The single instance contains duplicate renderer windows'
            report['visibleWindows'] = visible
            page.get_by_role('button', name='系统设置', exact=True).click()
            expect(page.get_by_role('heading', name='系统设置', exact=True)).to_be_visible()
            page.locator('nav').get_by_role('button', name='客户端接入', exact=True).click()
            expect(page.get_by_role('heading', name='连接你的 AI 客户端.', exact=True)).to_be_visible()
            assert invoke(page, 'state.get')['version'] == args.version
            assert app_windows(job) == visible, 'Navigation replaced the surviving native window'
            assert all(file.read_bytes() == before for file, before in client_files.items()), 'Startup modified a client fixture'
            assert not errors, errors
            page.screenshot(path=str(profile / 'single-instance.png'))
            report['checks'].append('Exactly one native window remains; navigation and IPC work after duplicate cleanup; client fixtures stay unchanged')
            surviving = next(process for process in processes if job.exit_code(process) is None)
            cleanup_lock = CleanupReadLock(runtime_dir / executable.name, temporary)
            report['cleanupLock'] = {'nativeReadHandle': True, 'deleteSharingDenied': True}
            quit_started = time.monotonic()
            try:
                invoke(page, 'app.quit')
            except PlaywrightError as error:
                if not ('closed' in str(error).lower() or 'destroyed' in str(error).lower()):
                    raise
            # Seeing app.asar disappear proves RMDir has run while the executable
            # remains locked. Do not release on a guessed startup/exit delay.
            cleanup_deadline = time.monotonic() + 8
            while runtime_asar.exists() and time.monotonic() < cleanup_deadline:
                assert job.exit_code(surviving) is None, 'Launcher exited before cleanup could retry the locked executable'
                time.sleep(.05)
            assert not runtime_asar.exists(), 'Launcher did not reach cleanup within 8 seconds'
            assert (runtime_dir / executable.name).is_file(), 'The native locked executable disappeared'
            assert job.exit_code(surviving) is None, 'Launcher did not wait for the real Windows file lock'
            cleanup_observed = time.monotonic()
            # Keep the lock across multiple 250 ms retry intervals; this controlled
            # hold tests retry behavior rather than synchronizing on a fixed sleep.
            while time.monotonic() - cleanup_observed < .75:
                assert job.exit_code(surviving) is None, 'Launcher abandoned cleanup while the file was locked'
                time.sleep(.05)
            report['cleanupLock'].update(cleanupObservedMs=round((cleanup_observed - quit_started) * 1000),
                                         heldDuringCleanupMs=round((time.monotonic() - cleanup_observed) * 1000))
            cleanup_lock.close()
            cleanup_released = time.monotonic()
            quit_deadline = time.monotonic() + 20
            while any(job.exit_code(process) is None for process in processes) and time.monotonic() < quit_deadline:
                time.sleep(.1)
            final_codes = [job.exit_code(process) for process in processes]
            report['finalExitCodes'] = final_codes
            assert final_codes == [0, 0], f'Portable launchers did not quit cleanly: {final_codes}'
            cleanup_deadline = time.monotonic() + 5
            while runtime_dir.exists() and time.monotonic() < cleanup_deadline:
                time.sleep(.05)
            report['cleanupLock']['cleanupAfterReleaseMs'] = round((time.monotonic() - cleanup_released) * 1000)
            if runtime_dir.exists():
                report['cleanupRemainingFiles'] = sorted(str(file.relative_to(runtime_dir)) for file in runtime_dir.rglob('*') if file.is_file())
            assert not runtime_dir.exists(), 'The final launcher did not clean its own extracted runtime'
            report['checks'].append('A real Windows file lock blocks deletion; the portable launcher retries and cleans its private directory after release')
            report['checks'].append('Application Quit returns both launcher exit codes 0 and removes the final extracted runtime')
            report['passed'] = True
    except BaseException as error:
        report['error'] = f'{type(error).__name__}: {error}'
        report['traceback'] = traceback.format_exc()
        raise
    finally:
        if cleanup_lock:
            cleanup_lock.close()
        watcher.stop.set()
        if watcher.thread.is_alive():
            watcher.thread.join(timeout=5)
        report['extractionDirectories'] = watcher.records()
        report['rendererErrors'] = errors
        if job:
            job.close()
        server.shutdown()
        server.server_close()
        for log in logs:
            log.close()
        report_path = profile / 'report.json'
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'passed': report['passed'], 'report': str(report_path), 'checks': report['checks'],
                          **({'error': report['error']} if 'error' in report else {})}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
