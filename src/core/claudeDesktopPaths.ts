import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_DESKTOP_PROFILE = '753cb857-baa9-45ce-a04b-000000003425';
export interface ClaudeDesktopPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  environment?: Record<string, string | undefined>;
  isolated?: boolean;
}
export interface ClaudeDesktopConfigCandidate {
  root: string;
  source: 'standard' | 'msix';
  existing: boolean;
  safe: boolean;
}
export interface ClaudeDesktopConfigResolution {
  status: 'resolved' | 'ambiguous' | 'blocked';
  source?: ClaudeDesktopConfigCandidate['source'];
  root?: string;
  candidates: ClaudeDesktopConfigCandidate[];
  reason: string;
}

export function claudeDesktopConfigFiles(root: string): string[] {
  return [path.join(root, 'Claude', 'claude_desktop_config.json'), path.join(root, 'Claude-3p', 'claude_desktop_config.json'),
    path.join(root, 'Claude-3p', 'configLibrary', '_meta.json'), path.join(root, 'Claude-3p', 'configLibrary', `${CLAUDE_DESKTOP_PROFILE}.json`)];
}
function directory(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('配置目录不是普通目录');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function safeDirectories(anchor: string, candidate: string): void {
  const relative = path.relative(anchor, candidate);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('配置目录超出当前用户范围');
  directory(anchor);
  let current = anchor;
  for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); directory(current); }
}

/** Discover existing Store package data locally; no shell, package activation or guessed writes. */
export function resolveClaudeDesktopConfig(options: ClaudeDesktopPathOptions = {}): ClaudeDesktopConfigResolution {
  const isolated = options.isolated ?? !!process.env.AURORA_CLIENT_HOME;
  const userHome = path.resolve(options.home ?? process.env.AURORA_CLIENT_HOME ?? os.homedir());
  const environment = options.environment ?? (isolated ? {} : process.env);
  const platform = options.platform ?? process.platform;
  const configuredBase = platform === 'win32' ? (!isolated && environment.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'))
    : platform === 'darwin' ? path.join(userHome, 'Library', 'Application Support') : (!isolated && environment.XDG_CONFIG_HOME || path.join(userHome, '.config'));
  if (!path.isAbsolute(configuredBase) || /[\u0000-\u001f\u007f]/.test(configuredBase)) return { status: 'blocked', candidates: [], reason: 'Claude 桌面配置根目录不是有效的绝对路径，已停止自动读写' };
  const base = path.resolve(configuredBase);
  const anchor = isolated ? userHome : base;
  const candidates: ClaudeDesktopConfigCandidate[] = [];
  const add = (root: string, source: ClaudeDesktopConfigCandidate['source'], packageExists = false) => {
    const candidate: ClaudeDesktopConfigCandidate = { root, source, existing: packageExists, safe: false }; candidates.push(candidate);
    safeDirectories(anchor, root);
    for (const dir of [path.join(root, 'Claude'), path.join(root, 'Claude-3p'), path.join(root, 'Claude-3p', 'configLibrary'), path.join(root, 'Claude', '.aurora-backups')]) safeDirectories(anchor, dir);
    candidate.existing ||= directory(path.join(root, 'Claude')) || directory(path.join(root, 'Claude-3p'));
    candidate.safe = true;
  };
  try {
    add(base, 'standard');
    if (platform === 'win32') {
      const packages = path.join(base, 'Packages'); safeDirectories(anchor, packages);
      if (directory(packages)) {
        let count = 0, matches = 0;
        const entries = fs.opendirSync(packages);
        try {
          for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
            if (++count > 2048) throw new Error('Windows 应用目录过大，无法完整核对 Claude 安装位置');
            if (!/^Claude_[a-z0-9]{13}$/i.test(entry.name)) continue;
            if (++matches > 16) throw new Error('发现过多 Claude 安装目录，无法确认配置位置');
            add(path.join(packages, entry.name, 'LocalCache', 'Local'), 'msix', true);
          }
        } finally { entries.closeSync(); }
      }
    }
  } catch (error) {
    return { status: 'blocked', candidates, reason: 'Claude 桌面配置目录无法安全核对，已停止自动读写：' + String((error as Error).message) };
  }
  const existing = candidates.filter(candidate => candidate.existing);
  if (existing.length > 1) return { status: 'ambiguous', candidates, reason: '发现多个 Claude 桌面配置位置（普通版或商店版），无法确认客户端实际使用哪一份。请在 Claude 的第三方模型设置中核对配置目录；云汇未自动写入任何位置。' };
  const selected = existing[0] ?? candidates[0];
  return { status: 'resolved', source: selected.source, root: selected.root, candidates,
    reason: selected.source === 'msix' ? '已识别 Claude 商店版的独立配置目录' : '使用 Claude 桌面标准配置目录' };
}

/** Undo remains bound to the original known root even when discovery now selects another install. */
export function claudeDesktopRestorePaths(backup: string | undefined, options: ClaudeDesktopPathOptions = {}): string[] {
  if (!backup || !path.isAbsolute(backup)) throw new Error('没有有效的 Claude 桌面接入备份');
  const resolution = resolveClaudeDesktopConfig(options);
  const candidate = resolution.candidates.find(item => item.safe && path.resolve(path.dirname(backup)) === path.resolve(path.join(item.root, 'Claude', '.aurora-backups')));
  if (!candidate) throw new Error('备份不属于已核对的 Claude 桌面配置目录，已停止恢复');
  return claudeDesktopConfigFiles(candidate.root);
}
