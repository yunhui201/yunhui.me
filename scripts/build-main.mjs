import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.resolve(root, '..');
const builtAt = new Date().toISOString();
let revision = '';
try { revision = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: base, encoding: 'utf8', windowsHide: true }).trim(); } catch { /* Source archives do not require Git. */ }
const buildInfo = { id: builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + (revision ? `-${revision}` : ''),
  builtAt, revision, channel: process.env.YUNHUI_BUILD_CHANNEL === 'local' ? 'local' : 'release' };

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  logLevel: 'info',
  define: { 'process.env.AURORA_BUILD': '"production"', __YUNHUI_BUILD_INFO__: JSON.stringify(buildInfo) },
};

const entries = [
  { in: 'src/main/index.ts', out: 'dist/main/main.cjs', external: ['electron'] },
  { in: 'src/preload/index.ts', out: 'dist/main/preload.cjs', external: ['electron'] },
  { in: 'src/main/gateway-cli.ts', out: 'dist/main/gateway-cli.cjs', external: ['electron'] },
  { in: 'src/core/agents/detectionWorker.ts', out: 'dist/main/detection-worker.cjs', external: ['electron'] },
  { in: 'src/core/readOnlyWorker.ts', out: 'dist/main/read-only-worker.cjs', external: ['electron'] },
];

for (const e of entries) {
  await build({
    ...common,
    entryPoints: [path.resolve(base, e.in)],
    outfile: path.resolve(base, e.out),
    external: e.external,
  });
}

console.log('[yunhui] main bundles built');

