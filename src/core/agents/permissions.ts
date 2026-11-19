import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ActionDeps } from '../actions.js';
import type { AgentId } from '../store/types.js';
import { getAdapter, detectReset } from './adapters.js';
import { applyPlan, atomicWrite, digest, managedPlanSnapshot, patchToml, readText, UnverifiedOriginalBackupError, type PermissionScope } from './configFiles.js';

export interface PermissionChange { scope: string; field: string; before: string; after: string }
export interface PermissionPreview { ok: true; agentId: string; revision: string; changes: PermissionChange[]; warnings: string[]; alreadyOriginal: boolean; message: string }
class PermissionError extends Error {}
const fields = ['approval_policy', 'sandbox_mode', 'default_permissions'] as const;
const aliases: AgentId[] = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'];
const failure = (message: string) => ({ ok: false as const, message });
function object(text: string): Record<string, any> {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PermissionError('配置必须是有效的 JSON 对象');
  return value;
}
function scalar(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new PermissionError('原权限包含无法安全单独恢复的设置，请检查原始备份');
  return value;
}
const display = (value: string | null) => value === null ? '未设置（由客户端默认值或其他配置决定）' : value;

function prepare(deps: ActionDeps, agentId: string) {
  const adapter = getAdapter(agentId), shared = aliases.includes(agentId as AgentId);
  if (!adapter || !shared && adapter.id !== 'claude-code') throw new PermissionError('此客户端不支持单独恢复执行权限');
  const agentSnapshot = deps.store.readAgentSnapshot(), all = agentSnapshot.states, ids: AgentId[] = shared ? aliases : ['claude-code'];
  const state = all[adapter.id] || (shared ? all['codex-cli'] || all['chatgpt-desktop'] || all['codex-desktop'] : undefined);
  if (!state?.connected || state.pendingReapply || !state.backupPath) throw new PermissionError('没有已应用且可核验的云汇连接备份，无法单独恢复权限');
  const paths = adapter.configPaths(), canonical = shared ? 'codex-cli' : 'claude-code';
  const snapshot = managedPlanSnapshot(canonical, state.backupPath, paths);
  const files = snapshot.files.map(({ original: _, ...file }) => file);
  const target = files.find(file => path.resolve(file.path) === path.resolve(paths[0]));
  const originalText = snapshot.files.find(file => path.resolve(file.path) === path.resolve(paths[0]))?.original;
  if (!target || originalText === undefined) throw new PermissionError('备份没有当前客户端的受管权限配置');
  const current = shared ? parseToml(target.before.replace(/^\uFEFF/, '')) as any : object(target.before);
  const original = originalText === null ? {} : shared ? parseToml(originalText.replace(/^\uFEFF/, '')) as any : object(originalText);
  let scope: PermissionScope | null | undefined = target.permissionScope;
  if (!scope) {
    // Older manifests have no field ownership record. Only an explicit saved
    // full-access choice plus the exact installed policy permits this migration.
    if (state.permissionMode !== 'full-access') throw new PermissionError('没有云汇修改执行权限的可核验记录；现有权限将保留');
    scope = shared ? { kind: 'codex-execution-v1', ...(typeof current.profile === 'string' ? { profile: current.profile } : {}) } : { kind: 'claude-execution-v1' };
  }
  const changes: PermissionChange[] = [], warnings: string[] = [];
  if (shared) {
    if (scope.kind !== 'codex-execution-v1' || scope.profile !== (typeof current.profile === 'string' ? current.profile : undefined)) throw new PermissionError('当前 Codex profile 与受管权限范围不一致，请先核对配置');
    const layers = [{ name: '用户配置', section: '', current, original }];
    if (scope.profile) {
      const active = current.profiles?.[scope.profile];
      if (!active || typeof active !== 'object' || Array.isArray(active)) throw new PermissionError('受管 Codex profile 不存在，未恢复权限');
      layers.push({ name: `Profile：${scope.profile}`, section: `profiles.${JSON.stringify(scope.profile)}`, current: active, original: original.profiles?.[scope.profile] || {} });
    }
    for (const layer of layers) {
      if (layer.current.approval_policy !== 'never' || layer.current.sandbox_mode !== 'danger-full-access' || layer.current.default_permissions !== undefined) throw new PermissionError('执行权限已偏离云汇应用的设置，请先处理冲突；不会覆盖其他程序的修改');
      const values: Record<string, string | null> = {};
      for (const field of fields) {
        values[field] = scalar(layer.original[field]);
        changes.push({ scope: layer.name, field, before: display(scalar(layer.current[field])), after: display(values[field]) });
      }
      target.after = patchToml(target.after, layer.section, values);
      if (layer.original.approval_policy === 'never' || layer.original.sandbox_mode === 'danger-full-access') warnings.push(`${layer.name}在首次接入前已包含免审批或完整访问设置；恢复原值不保证降低权限。`);
      if (layer.original.default_permissions !== undefined) warnings.push(`${layer.name}将恢复原有权限方案，实际执行范围以该方案及客户端策略为准。`);
    }
  } else {
    if (scope.kind !== 'claude-execution-v1' || !current.permissions || current.permissions.defaultMode !== 'bypassPermissions') throw new PermissionError('Claude 执行权限已偏离云汇应用的设置，请先处理冲突');
    const value = scalar(original.permissions?.defaultMode);
    changes.push({ scope: '用户配置', field: 'permissions.defaultMode', before: 'bypassPermissions', after: display(value) });
    if (value === null) delete current.permissions.defaultMode; else current.permissions.defaultMode = value;
    if (original.permissions === undefined && !Object.keys(current.permissions).length) delete current.permissions;
    target.after = JSON.stringify(current, null, 2) + '\n';
    if (value === 'bypassPermissions') warnings.push('首次接入前已启用 bypassPermissions；恢复原值仍会保留高级权限。');
  }
  target.permissionScope = null;
  const alreadyOriginal = changes.every(change => change.before === change.after);
  if (alreadyOriginal) target.after = target.before;
  warnings.push('恢复后请重新启动客户端或打开新终端。项目配置、启动参数和组织策略仍可能影响实际权限。');
  const preview: PermissionPreview = { ok: true, agentId, revision: digest(JSON.stringify([snapshot.revision, agentSnapshot.revision, files])), changes, warnings, alreadyOriginal,
    message: alreadyOriginal ? '原始权限与当前权限相同；确认后将结束云汇的高级权限管理。' : '仅恢复首次接入前的执行权限，保留当前供应商、模型和登录配置。' };
  return { preview, files, canonical, state, ids, adapter, agentSnapshot };
}

/** Main-process-only selective restore; renderer cannot provide paths or policies. */
export function runPermissionAction(deps: ActionDeps, action: string, payload: unknown) {
  if (deps.platform === 'web') return failure('请在电脑桌面端恢复客户端执行权限');
  const restore = action === 'agent.permissions.restore';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('权限恢复参数无效，请重新预览');
  const input = payload as Record<string, unknown>, allowed = restore ? ['agentId', 'revision', 'confirmed'] : ['agentId'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || typeof input.agentId !== 'string'
    || restore && (input.confirmed !== true || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)))
    return failure('请先预览并明确确认恢复原执行权限');
  try {
    const prepared = prepare(deps, input.agentId);
    if (!restore) return prepared.preview;
    if (input.revision !== prepared.preview.revision) return failure('配置、备份或连接记录在预览后已变化，请重新预览');
    const { files, canonical, state, ids, agentSnapshot } = prepared;
    const backup = applyPlan(canonical, files, state.backupPath);
    try {
      deps.store.saveAgentsIfUnchanged(ids.map(id => ({ ...state, id, permissionMode: 'preserve', backupPath: backup })), agentSnapshot);
    } catch {
      let failed = false;
      for (const file of [...files].reverse()) {
        if (file.before === file.after) continue;
        try {
          const current = readText(file.path);
          if (fs.existsSync(file.path) && current === file.before) continue;
          if (!fs.existsSync(file.path) || current !== file.after) { failed = true; continue; }
          atomicWrite(file.path, file.before, { existed: true, content: current });
        } catch { failed = true; }
      }
      detectReset();
      return failure(failed ? '无法保存连接记录，部分配置已被其他程序修改或无法回滚；原始备份保留，请检查配置后重新预览' : '无法保存连接记录，已撤回本次权限恢复；原始备份和供应商连接保留');
    }
    detectReset();
    return { ok: true, agentId: input.agentId, restartRequired: true, message: prepared.preview.alreadyOriginal ? '已保留原有权限并结束云汇的高级权限管理；原权限本身未降低。请重新启动客户端核对。' : '已恢复原执行权限，供应商连接保留。请重新启动客户端或打开新终端。' };
  } catch (error) {
    if (error instanceof PermissionError || error instanceof UnverifiedOriginalBackupError) return failure(error.message);
    // Parsers and storage errors may embed configuration contents or credentials.
    return failure('无法安全核验或写入权限配置；请检查配置、原始备份及外部修改后重新预览。本次未完成权限恢复');
  }
}
