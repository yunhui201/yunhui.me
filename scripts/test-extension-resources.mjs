/** Resource staging only: no app build, app launch, network or real user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareExtensionResources, releaseResourceManifest, resourcePolicy } from './prepare-extension-resources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-resource-policy-')));
const project = path.join(scratch, 'project'), source = path.join(project, 'third_party/codexplusplus');
const target = path.join(project, 'dist/extensions'), manifestPath = path.join(source, 'FILES.sha256.json');
const hash = data => createHash('sha256').update(data).digest('hex');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS', name); };
const links = new Set();
const link = (from, to) => { fs.symlinkSync(to, from, 'junction'); links.add(from); };
const unlink = file => { fs.unlinkSync(file); links.delete(file); };
const assertSafeCleanup = directory => {
  assert(path.resolve(directory).startsWith(scratch + path.sep), 'Cleanup escaped temporary root');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!fs.lstatSync(file).isSymbolicLink(), `Unexpected temporary link: ${file}`);
    if (entry.isDirectory()) assertSafeCleanup(file);
  }
};

try {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.cpSync(path.join(root, 'third_party/codexplusplus'), source, { recursive: true });
  const sourceManifestBytes = fs.readFileSync(manifestPath);
  const sourceManifest = JSON.parse(sourceManifestBytes), expected = releaseResourceManifest(sourceManifest);
  let result;
  check('Every reviewed runtime/provenance asset survives unchanged; source tests remain in the repository copy', () => {
    result = prepareExtensionResources({ projectRoot: project });
    assert.equal(result.resourceFiles, sourceManifest.length - resourcePolicy.excluded.length);
    assert.equal(result.excludedFiles, resourcePolicy.excluded.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'FILES.sha256.json'))), expected);
    for (const record of expected) {
      const data = fs.readFileSync(path.join(target, record.path));
      assert.equal(data.length, record.bytes, record.path);
      assert.equal(hash(data), record.sha256, record.path);
    }
    for (const file of resourcePolicy.excluded) {
      assert(fs.existsSync(path.join(source, file)), file);
      assert(!fs.existsSync(path.join(target, file)), file);
    }
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM.json', 'materialized/extensions/agent-pet/WHALE-PROVENANCE.md']) assert(fs.existsSync(path.join(target, file)), file);
    const upstream = JSON.parse(fs.readFileSync(path.join(target, 'UPSTREAM.json')));
    for (const id of upstream.packages) {
      const dir = path.join(target, 'materialized/extensions', id);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'codexpp.json')));
      for (const renderer of manifest.renderer) assert(fs.statSync(path.join(dir, renderer)).isFile(), `${id}: ${renderer}`);
    }
    assert.deepEqual(fs.readFileSync(manifestPath), sourceManifestBytes);
  });
  check('Replacing an old output removes stale fixtures and leaves unrelated dist files intact', () => {
    fs.writeFileSync(path.join(target, 'stale-fixture.test.cjs'), 'fixture');
    fs.writeFileSync(path.join(project, 'dist', 'unrelated.txt'), 'keep');
    prepareExtensionResources({ projectRoot: project });
    assert(!fs.existsSync(path.join(target, 'stale-fixture.test.cjs')));
    assert.equal(fs.readFileSync(path.join(project, 'dist', 'unrelated.txt'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(path.join(project, 'dist')).sort(), ['extensions', 'unrelated.txt']);
  });
  const oldManifest = fs.readFileSync(path.join(target, 'FILES.sha256.json'));
  const intact = () => assert.deepEqual(fs.readFileSync(path.join(target, 'FILES.sha256.json')), oldManifest);
  check('Bad hashes in both included and excluded source files fail before output mutation', () => {
    for (const relative of ['assets/inject/native-fast-unlock.js', resourcePolicy.excluded[0], 'source/native_fast.rs']) {
      const file = path.join(source, relative), original = fs.readFileSync(file);
      fs.writeFileSync(file, Buffer.concat([original, Buffer.from('\ninvalid fixture')]));
      try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /integrity mismatch/); intact(); }
      finally { fs.writeFileSync(file, original); }
    }
  });
  check('Missing or unlisted inputs and unsafe manifest paths fail without clearing the old output', () => {
    const extra = path.join(source, 'unlisted-fixture.txt');
    fs.writeFileSync(extra, 'fixture');
    try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /unlisted or missing/); intact(); }
    finally { fs.unlinkSync(extra); }
    const item = path.join(source, expected[0].path), original = fs.readFileSync(item);
    fs.unlinkSync(item);
    try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /unlisted or missing/); intact(); }
    finally { fs.writeFileSync(item, original); }
    for (const unsafe of ['../outside.txt', 'C:/outside.txt', '/outside.txt', 'assets\\outside.txt']) {
      const manifest = structuredClone(sourceManifest); manifest[0].path = unsafe;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /[Uu]nsafe|[Ii]nvalid/); intact(); }
      finally { fs.writeFileSync(manifestPath, sourceManifestBytes); }
    }
  });
  check('An arbitrary output override cannot write or delete outside project dist/extensions', () => {
    const outside = path.join(scratch, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    for (const output of [outside, project, path.join(project, 'dist'), path.join(project, 'dist', 'extensions-other')]) {
      assert.throws(() => prepareExtensionResources({ projectRoot: project, output }), /Output must/);
      intact();
    }
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });
  check('Junctions at project, dist, output, inside output and inside source are rejected without following them', () => {
    const outside = path.join(scratch, 'outside'), projectLink = path.join(scratch, 'project-link');
    link(projectLink, project);
    try { assert.throws(() => prepareExtensionResources({ projectRoot: projectLink }), /linked/); }
    finally { unlink(projectLink); }
    for (const directory of [path.join(project, 'dist'), target]) {
      const saved = `${directory}-saved`; fs.renameSync(directory, saved); link(directory, outside);
      try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /linked/); }
      finally { unlink(directory); fs.renameSync(saved, directory); }
      intact();
    }
    for (const parent of [target, source]) {
      const nested = path.join(parent, 'linked-fixture'); link(nested, outside);
      try { assert.throws(() => prepareExtensionResources({ projectRoot: project }), /linked/); intact(); }
      finally { unlink(nested); }
    }
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });
  check('Packaged Python verification accepts the same subset and rejects corruption, omitted runtime assets and test reintroduction', () => {
    const code = `import importlib.util, pathlib, sys\nspec=importlib.util.spec_from_file_location('packaged',sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nroot=pathlib.Path(sys.argv[2])\nmanifest=module.verify_packaged_resources(root)\nassert len(manifest)==int(sys.argv[3])\ndef rejected():\n    try: module.verify_packaged_resources(root)\n    except (AssertionError,FileNotFoundError): return\n    raise AssertionError('Invalid packaged resources accepted')\nextra=root/'fixture.test.cjs'\nextra.write_text('fixture')\nrejected()\nextra.unlink()\nfile=root/manifest[0]['path']\noriginal=file.read_bytes()\nfile.write_bytes(original+b'invalid')\nrejected()\nfile.unlink()\nrejected()\nfile.write_bytes(original)\nmodule.verify_packaged_resources(root)\n`;
    execFileSync('python', ['-B', '-c', code, path.join(root, 'scripts/test-packaged.py'), target, String(expected.length)], { stdio: 'pipe', windowsHide: true });
    intact();
  });
  console.log(JSON.stringify({ passed: true, checks, sourceFiles: result.sourceFiles, resourceFiles: result.resourceFiles,
    excludedFiles: result.excludedFiles, excludedBytes: result.excludedBytes, scope: 'temporary resource staging only' }));
} finally {
  for (const file of links) fs.unlinkSync(file);
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()), 'Unexpected temporary root');
  for (const entry of fs.readdirSync(scratch, { withFileTypes: true })) {
    const file = path.join(scratch, entry.name);
    assert(!fs.lstatSync(file).isSymbolicLink(), 'Refusing linked temporary cleanup');
    if (entry.isDirectory()) assertSafeCleanup(file);
  }
  fs.rmSync(scratch, { recursive: true });
}
