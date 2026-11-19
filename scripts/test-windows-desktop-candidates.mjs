import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-win-candidates-')));
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'private fixture'); };
let checks = 0, sequence = 0;
const check = (label, fn) => { fn(); checks++; console.log('PASS ' + label); };
try {
  const output = path.join(scratch, 'candidates.cjs');
  await build({ entryPoints: ['src/core/windowsDesktopCandidates.ts'], outfile: output, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  const { windowsDesktopCandidates } = createRequire(import.meta.url)(output);
  const fixture = () => { const home = path.join(scratch, `home-${++sequence}`); fs.mkdirSync(home); return { home, environment: { LOCALAPPDATA: path.join(home, 'Local') }, readHost: () => [] }; };
  check('Standard installations retain exact main executable candidates without CLI/runtime directories', () => {
    const f = fixture(), paths = windowsDesktopCandidates(f), root = f.environment.LOCALAPPDATA;
    assert(paths.includes(path.join(root, 'OpenAI', 'Codex', 'app', 'Codex.exe')));
    assert(paths.includes(path.join(root, 'Programs', 'ChatGPT Beta', 'ChatGPT.exe')));
    assert(!paths.some(file => /[\\/](?:bin|runtimes|\.vscode)[\\/]/.test(file)));
    assert.equal(paths.length, new Set(paths.map(file => file.toLowerCase())).size);
  });
  check('Store manifest executable paths support a nonstandard nested layout without guessing filenames', () => {
    const f = fixture(), root = path.join(f.home, 'Store', 'OpenAI.ChatGPT-Desktop');
    f.readHost = source => source === 'appx' ? [{ name: 'OpenAI.ChatGPT-Desktop', root, executables: ['client\\desktop\\ChatGPT.exe', 'support\\helper.exe'] }] : [];
    const paths = windowsDesktopCandidates(f); assert(paths.includes(path.join(root, 'client', 'desktop', 'ChatGPT.exe'))); assert(!paths.some(file => file.endsWith('helper.exe'))); assert(!paths.includes(path.join(root, 'ChatGPT.exe')));
  });
  check('Only relevant package identities and contained executable paths become candidates', () => {
    const f = fixture(), root = path.join(f.home, 'Store', 'ChatGPT');
    f.readHost = source => source === 'appx' ? [
      { name: 'Unrelated.OpenAI', root, executables: ['ChatGPT.exe'] },
      { name: 'OpenAI.ChatGPT', root, executables: ['..\\outside\\ChatGPT.exe', 'C:\\outside\\ChatGPT.exe', '\\outside\\ChatGPT.exe', 'app\\cmd.exe', 'app\\ChatGPT.exe\n'] },
      { name: 'ChatGPT', root, executables: ['verified\\ChatGPT.exe'] },
    ] : [];
    const paths = windowsDesktopCandidates(f).filter(file => file.startsWith(path.join(f.home, 'Store'))); assert.deepEqual(paths, [path.join(root, 'verified', 'ChatGPT.exe')]);
  });
  check('Appx discovery failure still permits verified registry and shortcut locations', () => {
    const f = fixture(), installed = path.join(f.home, 'Custom installation'), linked = path.join(f.home, 'Other installation', 'Codex.exe'), calls = [];
    f.readHost = source => { calls.push(source); if (source === 'appx') throw new Error('Appx unavailable'); return source === 'uninstall' ? [{ name: 'ChatGPT', root: installed }] : [{ name: 'Codex', target: linked }]; };
    const paths = windowsDesktopCandidates(f); assert.deepEqual(calls, ['appx', 'uninstall', 'shortcuts']); assert(paths.includes(path.join(installed, 'ChatGPT.exe'))); assert(paths.includes(linked));
  });
  check('Registered application targets are considered before old version-directory leftovers', () => {
    const f = fixture(), old = path.join(f.environment.LOCALAPPDATA, 'Programs', 'ChatGPT', 'app-1.0.0', 'ChatGPT.exe'), current = path.join(f.home, 'Store', 'app', 'ChatGPT.exe');
    write(old); f.readHost = source => source === 'appx' ? [{ name: 'OpenAI.ChatGPT', root: path.join(f.home, 'Store'), executables: ['app\\ChatGPT.exe'] }] : [];
    const paths = windowsDesktopCandidates(f); assert(paths.indexOf(current) >= 0); assert(paths.indexOf(current) < paths.indexOf(old));
  });
  check('Registry metadata never evaluates arguments and unrelated products are excluded', () => {
    const f = fixture(), executable = path.join(f.home, 'Custom folder', 'ChatGPT.exe');
    f.readHost = source => source === 'uninstall' ? [{ name: 'ChatGPT Desktop', icon: `"${executable}",0` }, { name: 'Other editor', root: path.join(f.home, 'unrelated') }, { name: 'Codex', icon: `${executable} --launch` }] : [];
    const paths = windowsDesktopCandidates(f); assert.equal(paths.filter(file => file === executable).length, 1); assert(!paths.some(file => file.includes('unrelated') || file.includes('--launch')));
  });
  check('Versioned installation directories are shallow, bounded, and limited to recognized app versions', () => {
    const f = fixture(), root = path.join(f.environment.LOCALAPPDATA, 'Programs', 'ChatGPT');
    write(path.join(root, 'app-1.2.3', 'ChatGPT.exe')); write(path.join(root, 'app-1.3.0-beta.1', 'ChatGPT.exe')); write(path.join(root, 'app-arbitrary', 'ChatGPT.exe')); write(path.join(root, 'bin', 'app-1.0.0', 'Codex.exe'));
    const paths = windowsDesktopCandidates(f); assert(paths.includes(path.join(root, 'app-1.2.3', 'ChatGPT.exe'))); assert(paths.includes(path.join(root, 'app-1.3.0-beta.1', 'ChatGPT.exe'))); assert(!paths.some(file => file.includes('app-arbitrary') || file.includes(path.join('bin', 'app-1.0.0'))));
    for (let index = 0; index < 30; index++) fs.mkdirSync(path.join(root, `app-2.0.${index}`));
    assert(windowsDesktopCandidates(f).filter(file => /[\\/]app-/.test(file)).length <= 16 * 3);
  });
  check('Linked version directories cannot import candidate paths from outside the installation', () => {
    const f = fixture(), root = path.join(f.environment.LOCALAPPDATA, 'Programs', 'ChatGPT'), outside = path.join(f.home, 'outside'); fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'app-1.2.3'), process.platform === 'win32' ? 'junction' : 'dir');
    assert(!windowsDesktopCandidates(f).some(file => file.includes('app-1.2.3')));
  });
  check('An isolated profile never reads host metadata or ambient installation roots', () => {
    const f = fixture(); f.isolated = true; f.environment = { LOCALAPPDATA: path.join(scratch, 'foreign'), ProgramFiles: path.join(scratch, 'foreign-programs') }; f.readHost = () => { throw new Error('Host must not be inspected'); };
    const paths = windowsDesktopCandidates(f); assert(paths.length); assert(paths.every(file => file.startsWith(f.home + path.sep))); assert(!paths.some(file => file.includes('foreign')));
  });
  check('Malformed source records and individual source errors leave standard candidates available', () => {
    const f = fixture(); f.readHost = source => { if (source !== 'appx') throw new Error('Unavailable'); return [null, 7, { name: 'ChatGPT', root: 'relative', executables: ['ChatGPT.exe'] }, { name: 'Codex', root: f.home, executables: 'Codex.exe' }]; };
    const paths = windowsDesktopCandidates(f); assert(paths.includes(path.join(f.environment.LOCALAPPDATA, 'Programs', 'ChatGPT', 'ChatGPT.exe'))); assert(!paths.includes(path.join(f.home, 'Codex.exe')));
  });
  console.log(`Windows desktop candidate discovery: ${checks} checks passed (isolated metadata/filesystem fixtures; no client launched)`);
} finally {
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-win-candidates-')); fs.rmSync(scratch, { recursive: true, force: true });
}
