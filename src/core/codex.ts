import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { applyPlan, patchToml, planned, readText } from './agents/configFiles.js';
import { runningCodingClientsSync } from './clientProcesses.js';
import { defaultAutoCompactTokenLimit } from './modelContext.js';

/**
 * Codex 增强：会话诊断/修复 + 插件·技能·提示词管理。
 *
 * 全部是「读写 Codex 自己的文件」，不做界面注入 —— 官方客户端更新不会让这里失效。
 * 会话列表由 state_5.sqlite 的 threads 表驱动，切换供应商后旧会话消失，
 * 根因就是 threads.model_provider 与 config.toml 里的 model_provider 对不上。
 */

export function codexHome(): string {
  return process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexConfigPath(): string {
  return path.join(codexHome(), 'config.toml');
}

export function readTomlValue(key: string): string | undefined {
  try {
    const txt = readText(codexConfigPath());
    const dot = key.lastIndexOf('.');
    const table = dot < 0 ? '' : key.slice(0, dot), field = dot < 0 ? key : key.slice(dot + 1);
    let section = '', content = '';
    for (const line of txt.split(/\r?\n/)) {
      const header = /^\s*\[+([^\]]+)\]+/.exec(line);
      if (header) section = header[1].trim();
      else if (section === table) content += line + '\n';
    }
    const re = new RegExp(`^\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, 'm');
    const m = re.exec(content);
    if (!m) return undefined;
    return m[1] ?? m[2] ?? m[3];
  } catch {
    return undefined;
  }
}

/** Codex 的时间戳可能是秒、毫秒或字符串，统一成 ISO */
function normTs(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) return normTs(Number(s));
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toISOString();
  }
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

export interface SessionDiagnosis {
  ok: boolean;
  message?: string;
  dbPath: string;
  dbExists: boolean;
  total: number;
  currentProvider?: string;
  /** provider → 会话数 */
  byProvider: Array<{ provider: string; count: number }>;
  /** 与当前配置不一致、因而在侧栏里可能看不到的会话数 */
  mismatch: number;
  /** rollout_path 指向的文件不存在的会话（真正的"丢了"） */
  missingRollouts: number;
  samples: Array<{ id: string; title: string; provider: string; updatedAt: string; missing: boolean }>;
}

interface SqliteDb {
  prepare(sql: string): {
    all(...args: any[]): any[];
    get(...args: any[]): any;
    run(...args: any[]): any;
  };
  close(): void;
}

function openDb(file: string, readOnly = true): SqliteDb | null {
  try {
    // node:sqlite 是实验 API，Electron/Node 22+ 自带，不需要原生模块
    const { DatabaseSync } = require('node:sqlite') as any;
    return new DatabaseSync(file, { readOnly });
  } catch {
    return null;
  }
}

export function diagnoseSessions(): SessionDiagnosis {
  const home = codexHome();
  const dbPath = path.join(home, 'state_5.sqlite');
  const currentProvider = readTomlValue('model_provider');
  const base: SessionDiagnosis = {
    ok: false,
    dbPath,
    dbExists: fs.existsSync(dbPath),
    total: 0,
    currentProvider,
    byProvider: [],
    mismatch: 0,
    missingRollouts: 0,
    samples: [],
  };
  if (!base.dbExists) {
    return { ...base, message: `没有找到 ${dbPath}，说明这台机器上还没用过 Codex 桌面版/CLI` };
  }
  const db = openDb(dbPath, true);
  if (!db) {
    return { ...base, message: '当前运行环境不支持读取 SQLite（需要 Node 22+ 的 node:sqlite），已跳过诊断' };
  }
  try {
    const total = (db.prepare('select count(*) as c from threads').get() as any)?.c ?? 0;
    const byProvider = db
      .prepare('select model_provider as provider, count(*) as count from threads group by 1 order by 2 desc')
      .all() as Array<{ provider: string; count: number }>;
    const rows = db
      .prepare(
        'select id, title, model_provider as provider, rollout_path, updated_at from threads order by updated_at desc limit 400',
      )
      .all() as Array<{ id: string; title: string; provider: string; rollout_path: string; updated_at: string }>;

    let missing = 0;
    const samples = rows.slice(0, 60).map((r) => {
      const miss = !!r.rollout_path && !fs.existsSync(r.rollout_path);
      if (miss) missing++;
      return {
        id: r.id,
        title: r.title || '(无标题)',
        provider: r.provider,
        updatedAt: normTs(r.updated_at),
        missing: miss,
      };
    });
    const mismatch = currentProvider
      ? (db.prepare('select count(*) as c from threads where model_provider <> ?').get(currentProvider) as any)?.c ?? 0
      : 0;
    return { ...base, ok: true, total, byProvider, mismatch, missingRollouts: missing, samples };
  } catch (e: any) {
    return { ...base, message: '读取失败：' + (e?.message ?? e) };
  } finally {
    db.close();
  }
}

export interface RepairResult {
  ok: boolean;
  message: string;
  backup?: string;
  updated?: number;
  target?: string;
}

/** 把 threads.model_provider 统一改成当前配置的 provider（先整库备份） */
export function repairSessions(targetProvider?: string): RepairResult {
  const home = codexHome();
  const dbPath = path.join(home, 'state_5.sqlite');
  const target = targetProvider || readTomlValue('model_provider');
  if (!fs.existsSync(dbPath)) return { ok: false, message: '没有找到 state_5.sqlite' };
  if (!target) return { ok: false, message: 'config.toml 里没有 model_provider，先接入一个供应商再修复' };
  let running: boolean;
  try { running = isRunning(); } catch { return { ok: false, message: '无法确认客户端是否已退出，本次未写入历史数据' }; }
  if (running) {
    return {
      ok: false,
      message: 'Codex 正在运行，数据库被占用。请先完全退出 Codex（桌面版要托盘退出）再点修复。',
    };
  }

  const db = openDb(dbPath, false);
  if (!db) return { ok: false, message: '当前环境不支持写入 SQLite' };
  // VACUUM INTO creates a consistent snapshot including committed WAL content.
  let backup = '';
  try {
    backup = `${dbPath}.yunhui-${Date.now()}.bak`;
    db.prepare('PRAGMA busy_timeout = 1500').run();
    db.prepare('VACUUM INTO ?').run(backup);
  } catch (e: any) {
    db.close();
    return { ok: false, message: '备份失败，已中止：' + (e?.message ?? e) };
  }
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    const before = (db.prepare('select count(*) as c from threads where model_provider <> ?').get(target) as any)?.c ?? 0;
    db.prepare('update threads set model_provider = ? where model_provider <> ?').run(target, target);
    db.prepare('COMMIT').run();
    return {
      ok: true,
      message: before
        ? `已把 ${before} 个会话索引的 provider 改为「${target}」。重启 Codex 后检查侧栏；能否继续会话取决于客户端版本与模型兼容性。`
        : `所有会话已经是「${target}」，不需要修复`,
      updated: before,
      backup,
      target,
    };
  } catch (e: any) {
    try { db.prepare('ROLLBACK').run(); } catch { /* no open transaction */ }
    return { ok: false, message: '写入失败：' + (e?.message ?? e) + '（备份在 ' + backup + '）', backup };
  } finally {
    db.close();
  }
}

function isRunning(): boolean {
  return runningCodingClientsSync().length > 0;
}

/* ------------------------------ 插件 / 技能 / 提示词 ------------------------------ */

export interface CodexAsset {
  id: string;
  kind: 'plugin' | 'skill' | 'prompt' | 'mcp';
  name: string;
  path?: string;
  description?: string;
  enabled: boolean;
  detail?: string;
  mutable?: boolean;
}

function skillEnabled(skillPath: string): boolean {
  try {
    const txt = readText(codexConfigPath());
    const blocks = txt.split(/^\s*\[\[skills\.config\]\]\s*$/m).slice(1);
    let enabled = true;
    for (const block of blocks) {
      const content = block.split(/^\s*\[/m)[0];
      const value = /^\s*path\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m.exec(content)?.[1];
      if (!value) continue;
      const selected = value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1);
      if (path.resolve(selected) === path.resolve(skillPath)) enabled = !/^\s*enabled\s*=\s*false\b/m.test(content);
    }
    return enabled;
  } catch { return true; }
}

export function listCodexAssets(): CodexAsset[] {
  const home = codexHome();
  const out: CodexAsset[] = [];

  const scan = (dir: string, kind: 'plugin' | 'skill') => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const name = e.name;
      const full = path.join(dir, e.name);
      if (kind === 'skill' && !fs.existsSync(path.join(full, 'SKILL.md'))) continue;
      if (kind === 'plugin' && !fs.existsSync(path.join(full, 'manifest.json')) && !fs.existsSync(path.join(full, '.claude-plugin', 'plugin.json'))) continue;
      let desc = '';
      try {
        const readme = e.isDirectory() ? path.join(full, 'SKILL.md') : '';
        const mf = e.isDirectory() ? path.join(full, 'manifest.json') : '';
        if (readme && fs.existsSync(readme)) desc = readText(readme).slice(0, 160).replace(/[#\n]+/g, ' ').trim();
        else if (mf && fs.existsSync(mf)) {
          const j = JSON.parse(readText(mf));
          desc = j.description ?? j.name ?? '';
        }
      } catch {
        /* 没有描述也无所谓 */
      }
      out.push({ id: `${kind}:${name}`, kind, name, path: full, enabled: kind === 'skill' ? skillEnabled(path.join(full, 'SKILL.md')) : true, description: desc, mutable: kind === 'skill' });
    }
  };

  scan(path.join(home, 'plugins'), 'plugin');
  scan(path.join(home, 'skills'), 'skill');

  // 全局提示词
  const agentsPath = path.join(home, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const size = fs.statSync(agentsPath).size;
    out.push({
      id: 'prompt:AGENTS.md',
      kind: 'prompt',
      name: 'AGENTS.md（全局提示词）',
      path: agentsPath,
      enabled: true,
      description: `${size} 字节 · 每次对话都会带上`,
    });
  }

  // MCP 服务器（从 config.toml 里读）
  try {
    const txt = readText(codexConfigPath());
    const re = /^\[mcp_servers\.([^\]]+)\]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) {
      const name = m[1];
      const tail = txt.slice(m.index + m[0].length);
      const next = tail.search(/^\s*\[/m);
      const block = next >= 0 ? tail.slice(0, next) : tail;
      const cmd = /command\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? '';
      out.push({
        id: `mcp:${name}`,
        kind: 'mcp',
        name,
        enabled: !/^\s*enabled\s*=\s*false\b/m.test(block),
        path: codexConfigPath(),
        description: cmd ? `命令：${cmd}` : '已配置的 MCP 服务器',
        mutable: /^[A-Za-z0-9_-]+$/.test(name),
      });
    }
  } catch {
    /* 没配置过 MCP */
  }

  return out;
}

/** Use supported config flags; renaming folders or commenting only TOML headers is not a valid disable operation. */
export function toggleCodexAsset(id: string, enabled: boolean): { ok: boolean; message: string } {
  const asset = listCodexAssets().find(a => a.id === id);
  if (!asset?.mutable) return { ok: false, message: '此资源请使用 Codex 自带的管理入口；未修改本地文件' };
  const file = codexConfigPath();
  try {
    const plan = planned(file, '');
    let txt = plan.before;
    try { parseToml(txt.replace(/^\uFEFF/, '')); } catch { throw new Error('原配置不是有效的 TOML，已停止修改'); }
    if (asset.kind === 'mcp') txt = patchToml(txt, `mcp_servers.${asset.name}`, { enabled });
    else if (asset.kind === 'skill') {
      const selected = path.join(asset.path!, 'SKILL.md');
      if (/"""|'''/.test(txt)) throw new Error('此 TOML 包含多行字符串，请通过 Codex 管理技能');
      const re = /^\s*\[\[skills\.config\]\]\s*\r?\n[\s\S]*?(?=^\s*\[|$(?![\s\S]))/gm;
      let matched = false;
      txt = txt.replace(re, block => {
        const value = /^\s*path\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m.exec(block)?.[1];
        if (!value) return block;
        const existing = value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1);
        if (path.resolve(existing) !== path.resolve(selected)) return block;
        matched = true;
        return /^\s*enabled\s*=/m.test(block) ? block.replace(/^\s*enabled\s*=.*$/m, `enabled = ${enabled}`) : block.trimEnd() + `\nenabled = ${enabled}\n`;
      });
      if (!matched) txt = txt.trimEnd() + `\n\n[[skills.config]]\npath = ${JSON.stringify(selected)}\nenabled = ${enabled}\n`;
    }
    try { parseToml(txt.replace(/^\uFEFF/, '')); } catch { throw new Error('此 TOML 结构无法安全修改，原配置已保留'); }
    plan.after = txt;
    applyPlan('codex-resource-toggle', [plan]);
    return { ok: true, message: `已${enabled ? '启用' : '禁用'} ${asset.name}，重启 Codex 后生效。` };
  } catch (e: any) { return { ok: false, message: String(e?.message ?? e) }; }
}

export function readAgentsMd(): string {
  try {
    return readText(path.join(codexHome(), 'AGENTS.md'));
  } catch {
    return '';
  }
}

export function writeAgentsMd(text: string): { ok: boolean; message: string; backup?: string } {
  const file = path.join(codexHome(), 'AGENTS.md');
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('提示词超过 4 MB，请在原文件中编辑');
    const plan = planned(file, text), backup = applyPlan('codex-global-prompt', [plan]);
    return { ok: true, message: '已保存，下次新会话生效', backup };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

/* ------------------------------ Codex 配置开关 ------------------------------ */

/** 只读写这几个安全的键，不动 [model_providers] 那些关键配置 */
export const CODEX_FLAGS = [
  { key: 'model_reasoning_effort', label: '思考强度', type: 'enum', options: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], hint: '仅选择当前模型实际支持的强度；留空使用默认值' },
  { key: 'model_context_window', label: '上下文窗口', type: 'number', hint: '保存时同时将自动压缩阈值设为窗口的 90%；留空会同时删除窗口与阈值覆盖，恢复客户端原生计算' },
  { key: 'model_auto_compact_token_limit', label: '自动压缩阈值', type: 'number', hint: '达到此 token 数时自动压缩历史，可单独手动修改；下次保存上下文窗口时会重新按窗口的 90% 设置，留空使用原生计算' },
  { key: 'sandbox_workspace_write.network_access', label: '工作区沙箱联网', type: 'bool', hint: '仅适用于 workspace-write 沙箱；组织策略仍然生效' },
] as const;

export function readCodexFlags(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const f of CODEX_FLAGS) out[f.key] = readTomlValue(f.key);
  return out;
}

export function writeCodexFlag(key: string, value: string): { ok: boolean; message: string } {
  const schema = CODEX_FLAGS.find((f) => f.key === key);
  if (!schema) return { ok: false, message: '不支持的配置项' };
  value = value.trim();
  if (value && schema.type === 'enum' && !(schema.options as readonly string[]).includes(value)) return { ok: false, message: '此枚举值不受支持' };
  if (value && schema.type === 'bool' && !['true', 'false'].includes(value)) return { ok: false, message: '开关值必须为 true 或 false' };
  if (value && schema.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) return { ok: false, message: '请输入有效的正整数' };
  const file = codexConfigPath();
  try {
    const plan = planned(file, ''), original = plan.before;
    const dot = key.lastIndexOf('.');
    const table = dot < 0 ? '' : key.slice(0, dot), field = dot < 0 ? key : key.slice(dot + 1);
    const parsed = !value ? null : schema.type === 'number' ? Number(value) : schema.type === 'bool' ? value === 'true' : value;
    const values: Record<string, string | number | boolean | null> = { [field]: parsed };
    if (key === 'model_context_window') values.model_auto_compact_token_limit = defaultAutoCompactTokenLimit(parsed) ?? null;
    const txt = patchToml(original, table, values);
    plan.after = txt;
    applyPlan('codex-setting', [plan]);
    const linked = key === 'model_context_window' ? value ? '，自动压缩阈值已同步为窗口的 90%' : '，窗口与自动压缩阈值已恢复客户端原生计算' : '';
    return { ok: true, message: `${value ? '已保存' : '已恢复默认'}「${schema.label}」${linked}，重启 Codex 生效` };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}
