import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';

const MAX_IDS = 128, MAX_DATABASES = 40, MAX_FILES = 2000, MAX_FIRST_LINE = 64 * 1024;
// Native provider IDs are case-sensitive; OpenAI and azure are valid custom IDs.
// Keep the retired local Ollama ID and our primary managed provider untouched.
const BUILTIN_PROVIDERS = new Set(['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime', 'gcp', 'ollama-chat', 'yunhui']);
export const validHistoryProviderId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && !BUILTIN_PROVIDERS.has(value);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const activeProfile = (config: any) => typeof config.profile === 'string' && object(config.profiles?.[config.profile]) ? config.profiles[config.profile] : {};
function safeFile(root: string, file: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
      && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).isFile();
  } catch { return false; }
}
/** Best-effort, bounded read-only evidence. No scan failure can prevent configuration. */
export function discoverHistoryProviderIds(configText: string, home: string, sqliteHome = home): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => { if (ids.size < MAX_IDS && validHistoryProviderId(value)) ids.add(value); };
  try {
    const config: any = parse(configText.replace(/^\uFEFF/, '')), profile = activeProfile(config);
    add(config.model_provider); add(profile.model_provider);
    for (const providers of [config.model_providers, profile.model_providers]) if (object(providers)) for (const id of Object.keys(providers)) add(id);
  } catch { /* Optional evidence only. The normal configuration parser owns validation. */ }
  // A short busy timeout lets a live client retain its database lock. Tables
  // and files that cannot be read are independent from all remaining evidence.
  let databases = 0;
  for (const directory of [sqliteHome, path.join(sqliteHome, 'sqlite')]) {
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (databases >= MAX_DATABASES || ids.size >= MAX_IDS) break;
      if (!entry.isFile() || !/\.(sqlite|sqlite3|db)$/i.test(entry.name) || (directory === sqliteHome && !/^(state_\d+|thread_history_\d+)\.sqlite$/.test(entry.name))) continue;
      const file = path.join(directory, entry.name); if (!safeFile(sqliteHome, file)) continue; databases++;
      let db: any;
      try {
        const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout=5');
        for (const table of ['threads', 'local_thread_catalog']) {
          try { for (const row of db.prepare(`SELECT model_provider FROM ${table} LIMIT 50001`).all()) { add(row.model_provider); if (ids.size >= MAX_IDS) break; } } catch { /* Unknown schema, corrupt table or lock: retain other evidence. */ }
        }
      } catch { /* A corrupt/unreadable database must never block saving config. */ }
      finally { try { db?.close(); } catch { /* best effort */ } }
    }
  }
  let visited = 0, directories = 0, entriesVisited = 0;
  const walk = (directory: string, depth = 0) => {
    if (depth > 10 || visited >= MAX_FILES || ids.size >= MAX_IDS || directories++ >= 256 || entriesVisited >= 12000) return;
    let entries: fs.Dirent[]; try { if (fs.lstatSync(directory).isSymbolicLink()) return; entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= MAX_FILES || ids.size >= MAX_IDS || entriesVisited++ >= 12000) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue; visited++;
      if (!safeFile(home, file)) continue;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(MAX_FIRST_LINE), count = fs.readSync(fd, buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, count), newline = bytes.indexOf(10);
        if (newline < 0 && count === MAX_FIRST_LINE) continue;
        const line = new TextDecoder('utf-8', { fatal: true }).decode(newline < 0 ? bytes : bytes.subarray(0, newline));
        const value = JSON.parse(line.replace(/^\uFEFF/, '')); if (value?.type === 'session_meta') add(value.payload?.model_provider);
      } catch { /* Invalid/partial first lines are not guessed or rewritten. */ }
      finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ } }
    }
  };
  walk(path.join(home, 'sessions')); walk(path.join(home, 'archived_sessions'));
  return [...ids].sort();
}

const HISTORY_TARGET_MARKER = '# yunhui-history-target:v1\n';
interface ManagedBlock { id: string; start: number; end: number; text: string; body: string; target: boolean }
/** Locate real comment lines, excluding marker-looking text inside TOML strings. */
function commentOffsets(text: string): Set<number> {
  const offsets = new Set<number>(); let quote = '', multiline = false, lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') { i++; continue; }
      if (multiline ? text.slice(i, i + 3) === quote.repeat(3) : char === quote) {
        if (multiline) { i += 2; while (text[i + 1] === quote) i++; }
        quote = ''; multiline = false;
      }
      if (char === '\n') lineStart = true; else if (!/\s/.test(char)) lineStart = false;
      continue;
    }
    if (char === '#') { if (lineStart) offsets.add(i); const end = text.indexOf('\n', i); if (end < 0) break; i = end; lineStart = true; continue; }
    if (char === '"' || char === "'") { quote = char; multiline = text.slice(i, i + 3) === char.repeat(3); if (multiline) i += 2; }
    if (char === '\n') lineStart = true; else if (!/\s/.test(char)) lineStart = false;
  }
  return offsets;
}
function managedBlocks(text: string, current: any): ManagedBlock[] {
  const result: ManagedBlock[] = [], comments = commentOffsets(text), pattern = /^# yunhui-history-provider:v1:([A-Za-z0-9_-]+):([a-f0-9]{64})\r?\n([\s\S]*?)^# yunhui-history-provider:end:\1\r?\n?/gm;
  for (const match of text.matchAll(pattern)) {
    try {
      if (!comments.has(match.index!)) continue;
      const id = Buffer.from(match[1], 'base64url').toString('utf8'); if (!validHistoryProviderId(id) || hash(match[3]) !== match[2]) continue;
      const parsed: any = parse(match[3]), provider = parsed.model_providers?.[id];
      if (!object(provider) || JSON.stringify(current.model_providers?.[id]) !== JSON.stringify(provider)) continue;
      result.push({ id, start: match.index!, end: match.index! + match[0].length, text: match[0], body: match[3], target: match[3].startsWith(HISTORY_TARGET_MARKER) });
    } catch { /* A manually edited alias becomes ordinary user configuration. */ }
  }
  return result;
}
/** Only a purpose-marked, unchanged managed table can receive automatic history. */
export function getManagedHistoryTarget(text: string): string | undefined {
  try {
    const current: any = parse(text.replace(/^\uFEFF/, '')), profile = activeProfile(current);
    return managedBlocks(text, current).find(block => block.target && !Object.hasOwn(profile.model_providers || {}, block.id))?.id;
  } catch { return undefined; }
}
/** Keep working aliases on optional failure, but never advertise an old binding as the newly chosen history target. */
export function clearManagedHistoryTarget(text: string): string {
  try {
    const current: any = parse(text.replace(/^\uFEFF/, ''));
    let result = text;
    for (const block of managedBlocks(text, current).filter(block => block.target).sort((a, b) => b.start - a.start)) {
      const body = block.body.slice(HISTORY_TARGET_MARKER.length), encoded = Buffer.from(block.id, 'utf8').toString('base64url');
      const replacement = `# yunhui-history-provider:v1:${encoded}:${hash(body)}\n${body}# yunhui-history-provider:end:${encoded}\n`;
      result = result.slice(0, block.start) + replacement + result.slice(block.end);
    }
    return result;
  } catch { return text; }
}
/** Remove only intact owned blocks before editing other TOML tables; this keeps
 * newly inserted root/profile keys from being mistaken for owned alias bytes. */
export function detachManagedHistoryProviders(text: string): { text: string; ids: string[]; blocks: string[] } {
  try {
    const current: any = parse(text.replace(/^\uFEFF/, '')), profile = activeProfile(current);
    const blocks = managedBlocks(text, current).filter(block => !Object.hasOwn(profile.model_providers || {}, block.id));
    let clean = text; for (const block of [...blocks].sort((a, b) => b.start - a.start)) clean = clean.slice(0, block.start) + clean.slice(block.end);
    parse(clean.replace(/^\uFEFF/, '')); return { text: clean, ids: blocks.map(block => block.id), blocks: blocks.map(block => block.text) };
  } catch { return { text, ids: [], blocks: [] }; }
}
/** Missing exact provider IDs remain resolvable even when native history repair is deferred. */
export function withHistoryProviderAliases(text: string, ids: readonly string[], transport: Record<string, string | number | boolean>, automaticTarget = false): string {
  try {
    const current: any = parse(text), profile = activeProfile(current), managed = managedBlocks(text, current), changes: ManagedBlock[] = [], additions: string[] = [];
    let targetId: string | undefined;
    if (automaticTarget) {
      targetId = managed.find(block => block.target && !Object.hasOwn(profile.model_providers || {}, block.id))?.id;
      for (let suffix = 1; !targetId && suffix <= 256; suffix++) {
        const candidate = 'yunhui-history' + (suffix === 1 ? '' : '-' + suffix);
        if (!Object.hasOwn(profile.model_providers || {}, candidate) && (!Object.hasOwn(current.model_providers || {}, candidate) || managed.some(block => block.id === candidate))) targetId = candidate;
      }
      if (!targetId) return clearManagedHistoryTarget(text);
    }
    const candidates = [...new Set([...(targetId ? [targetId] : []), ...managed.map(block => block.id), ...ids.filter(validHistoryProviderId)])].slice(0, MAX_IDS + (targetId ? 1 : 0));
    for (const id of candidates) {
      if (Object.hasOwn(profile.model_providers || {}, id)) continue;
      const block = managed.find(entry => entry.id === id);
      if (!block && Object.hasOwn(current.model_providers || {}, id)) continue;
      const encoded = Buffer.from(id, 'utf8').toString('base64url'), body = (id === targetId ? HISTORY_TARGET_MARKER : '') + stringify({ model_providers: { [id]: transport } }).trimEnd() + '\n';
      const replacement = `# yunhui-history-provider:v1:${encoded}:${hash(body)}\n${body}# yunhui-history-provider:end:${encoded}\n`;
      if (block) changes.push({ ...block, text: replacement }); else additions.push(replacement);
    }
    let result = text;
    for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.text + result.slice(change.end);
    if (additions.length) result = result.trimEnd() + '\n\n' + additions.join('\n');
    parse(result); return result;
  } catch { return automaticTarget ? clearManagedHistoryTarget(text) : text; }
}
