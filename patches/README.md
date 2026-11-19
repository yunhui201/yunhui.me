# Build dependency patches

`app-builder-lib@26.18.0.patch` changes only the Windows portable launcher's final cleanup. After its application exits, it retries removal of the current launch's `$PLUGINSDIR\app` for at most 10 seconds. It preserves the application exit code, never terminates a process, and does not clean a named or shared temporary directory. This project uses a separate extraction directory for each portable launch.

The patch is pinned by version and integrity in `package.json` and `pnpm-lock.yaml`; `pnpm install --frozen-lockfile` applies it. It does not change the application, macOS packaging, NSIS setup installer, or ZIP target.

Source: <https://github.com/electron-userland/electron-builder>, package `app-builder-lib` 26.18.0, `templates/nsis/portable.nsi`. Upstream is MIT licensed; see [LICENSE.electron-builder.txt](LICENSE.electron-builder.txt). The local patch retains that license.

Verify a built portable launcher with:

```powershell
python scripts/test-portable-startup.py --exe release/win-unpacked/YunHuiAI.exe --launcher release/YunHuiAI-0.6.0-win-x64-portable.exe
```

The test starts two isolated copies, verifies their extraction directories and single-instance behavior, then holds a native Windows read handle without delete sharing while the surviving app exits. It verifies that cleanup waits for that handle to close and removes only the current extraction directory.
