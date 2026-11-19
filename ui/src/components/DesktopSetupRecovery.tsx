import React from 'react';
import type { AgentCatalogItem, AgentDetection } from '../lib/api';
import { Btn, Ico } from './ui';
import ClientDiagnostics from './ClientDiagnostics';
import '../styles/desktop-setup.css';

export default function DesktopSetupRecovery({ agent, detected, platform, busy, operation, canPreview, onDetect, onSelect }: {
  agent: AgentCatalogItem; detected?: AgentDetection; platform: string; busy: boolean;
  operation: 'detect' | 'select' | null; canPreview: boolean; onDetect: () => void; onSelect: () => void;
}) {
  const confirmed = detected?.supportsCodexConfig === true;
  const native = !!window.aurora;
  const configPath = detected?.configPath || agent.configPath || (platform === 'win32' ? '%USERPROFILE%\\.codex\\config.toml' : '~/.codex/config.toml');
  return <section className="desktop-setup-recovery" aria-label="共享编程配置" aria-busy={!!operation}>
    <div className="desktop-setup-heading"><b>共享编程配置</b><span className={`chip ${detected?.configured ? 'ok' : ''}`}>{detected?.configured === true ? '已发现配置' : detected?.configured === false ? '应用时创建' : '预览时检查配置'}</span></div>
    <dl className="desktop-setup-facts">
      <dt>路径</dt><dd className="mono">{configPath}</dd>
    </dl>
    <p className="desktop-setup-note">可预览、备份并写入这份配置，无需先定位客户端程序。直连时写入供应商 URL、Key 和模型 ID；网关模式写入本地入口，由云汇使用对应供应商的 URL 与 Key 转发请求。客户端加载配置后按所选方式发送请求。</p>
    <details className="desktop-setup-program">
      <summary>程序识别（重启与桌面增强）</summary>
      <div className="desktop-setup-program-content">
        <span className={`chip ${confirmed ? 'ok' : ''}`}>{confirmed ? '已识别编程模块' : detected?.detecting ? '正在后台识别' : '编程模块待确认'}</span>
        <dl className="desktop-setup-facts">
          <dt>程序</dt><dd>{detected?.productName || (detected?.installed ? '已找到客户端程序' : '尚未定位程序')}</dd>
          <dt>版本</dt><dd>{detected?.version || '尚未读取到版本'}</dd>
          <dt>位置</dt><dd className="mono">{detected?.command || '可按需选择程序位置'}</dd>
        </dl>
        {detected?.detectionError && <p className="desktop-setup-warning">{detected.detectionError}</p>}
        {!!detected?.evidence?.length && <details className="desktop-setup-evidence"><summary>查看识别依据</summary><ul>{detected.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        <p className="desktop-setup-note">需要一键重启或桌面增强时，可重新检测，或选择实际安装的 {platform === 'darwin' ? '.app 应用包' : '.exe 主程序'}。识别结果来自安装资源；客户端是否已加载配置、请求是否成功，需在实际使用时验证。更换程序位置会断开当前桌面增强连接。</p>
        <div className="desktop-setup-actions">
          <Btn size="sm" disabled={busy || !native || !canPreview} onClick={onDetect}><Ico name="refresh" size={13} />{operation === 'detect' ? '正在重新检测…' : '重新检测并预览'}</Btn>
          <Btn size="sm" disabled={busy || !native || !canPreview} onClick={onSelect}><Ico name="search" size={13} />{operation === 'select' ? '正在选择程序…' : '选择程序并预览'}</Btn>
          <ClientDiagnostics agent={agent} />
        </div>
        {!native && <p className="desktop-setup-note">请在运行云汇的电脑桌面端选择程序路径。</p>}
      </div>
    </details>
  </section>;
}
