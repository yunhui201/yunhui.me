"""Check history sources and unknown providers in Chromium using isolated IPC fixtures.

These cases exercise presentation, filtering and export dispatch. Native Desktop
discovery and Markdown generation have separate core tests; no real history,
client configuration, network request or installed client is accessed here.
"""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CLI_SOURCE = '.claude · 默认目录'
THIRD_PARTY_SOURCE = 'Claude-3p · 第三方网关'
OFFICIAL_SOURCE = 'Claude · 默认目录'
MISSING_NOTE = '仅有会话记录，正文未定位；请在 Claude 桌面版查看原始内容。'
AMBIGUOUS_NOTE = '找到多个可能的会话正文，无法确定对应关系，未读取任意文件。'


def session(uid, title, agent, source, **extra):
    return {
        'id': uid, 'title': title, 'agent': agent,
        'path': f'/fixture/{uid}.jsonl', 'sizeBytes': 1024,
        'messageCount': 2, 'tokens': 0, 'cost': 0,
        'updatedAt': '2026-11-16T10:00:00Z',
        'createdAt': '2026-11-16T09:00:00Z',
        'sourceLabel': source, 'sourceScope': f'fixture:{source}',
        'sourceKind': 'cli', 'contentStatus': 'available', 'canResume': True,
        **extra,
    }


def main():
    checks, errors = [], []
    sessions = [
        session('claude-unknown', 'Claude 未记录供应商', 'Claude Code', CLI_SOURCE,
                model='claude-sonnet-fixture'),
        session('claude-explicit', 'Claude 明确记录供应商', 'Claude Code', CLI_SOURCE,
                modelProvider='recorded-private-gateway', model='claude-sonnet-fixture'),
        session('codex-explicit', 'Codex 原始区域', 'Codex', '.codex · 活跃会话',
                modelProvider='original-region'),
        session('desktop-metadata', '第三方桌面会话记录', 'Claude Desktop', THIRD_PARTY_SOURCE,
                sourceKind='desktop', contentStatus='metadata-only', contentNote=MISSING_NOTE,
                canResume=False, messageCount=0),
        session('desktop-available', '官方桌面可读会话', 'Claude Desktop', OFFICIAL_SOURCE,
                sourceKind='desktop', canResume=False),
        session('desktop-ambiguous', '第三方桌面正文冲突', 'Claude Desktop', THIRD_PARTY_SOURCE,
                sourceKind='desktop', contentStatus='ambiguous', contentNote=AMBIGUOUS_NOTE,
                canResume=False, messageCount=0),
        session('cli-disabled', 'CLI 明确不可恢复', 'Claude Code', '.claude · 自定义目录',
                canResume=False),
    ]
    # An older snapshot may not expose canResume. Desktop must still never use
    # Claude Code's resume command merely because the explicit flag is absent.
    sessions[4].pop('canResume')
    messages = {
        item['path']: [] if item['contentStatus'] != 'available' else [
            {'role': 'user', 'text': f"{item['title']}：原始提问"},
            {'role': 'assistant', 'text': f"{item['title']}：原始回答"},
        ] for item in sessions
    }
    fixture = {'sessions': sessions, 'messages': messages}

    def passed(label):
        checks.append(label)
        print('PASS', label, flush=True)

    with tempfile.TemporaryDirectory(prefix='yunhui-session-sources-ui-') as temporary:
        scratch = Path(temporary).resolve()
        bundle = scratch / 'sessions-ui.js'
        options = {
            'stdin': {'contents': """import React from 'react';import {createRoot} from 'react-dom/client';
import Sessions from './ui/src/pages/Sessions.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
createRoot(document.getElementById('root')).render(<ToastHost><Sessions state={{}} reload={async()=>{}} go={()=>{}}/></ToastHost>);""",
                      'resolveDir': str(ROOT), 'loader': 'tsx'},
            'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife',
            'define': {'process.env.NODE_ENV': '"production"'}, 'logLevel': 'silent',
        }
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'],
                       cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={'width': 1550, 'height': 1100}, locale='zh-CN')
                page.route('**/*', lambda route: route.abort())
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
                for style in ['app.css', 'workspace.css']:
                    page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
                page.evaluate(r"""fixture => {
window.historyFixture=fixture;window.calls=[];window.unexpected=[];
window.aurora={invoke:async(action,payload={})=>{
  window.calls.push({action,payload:structuredClone(payload)});
  if(action==='sessions.scan')return structuredClone(window.historyFixture.sessions);
  if(action==='sessions.read')return structuredClone(window.historyFixture.messages[payload.path]||[]);
  if(action==='sessions.export'){
    const s=payload.summary;
    const body=(window.historyFixture.messages[s.path]||[]).map(m=>m.text).join('\n\n');
    return {ok:true,markdown:'# '+s.title+'\n\n来源：'+s.sourceLabel+'\n\n'+(s.contentNote||body)+'\n'};
  }
  if(action==='sessions.resume')return {command:'claude --resume '+payload.summary.id};
  window.unexpected.push(action);throw Error('Unexpected action '+action);
}};
}""", fixture)
                page.add_script_tag(path=str(bundle))
                rows = page.locator('.split .list-row[role="button"]')
                detail = page.locator('.split > .card').nth(1)
                source = page.get_by_label('历史会话来源', exact=True)
                provider = page.get_by_label('历史供应商区域', exact=True)
                search = page.get_by_label('搜索历史会话', exact=True)

                def row(title):
                    return rows.filter(has=page.get_by_text(title, exact=True))

                expect(rows).to_have_count(len(sessions))
                expect(row('Claude 未记录供应商').get_by_text(CLI_SOURCE, exact=True)).to_be_visible()
                expect(row('Claude 未记录供应商').get_by_text('供应商未记录', exact=True)).to_be_visible()
                expect(row('第三方桌面会话记录').get_by_text(THIRD_PARTY_SOURCE, exact=True)).to_be_visible()
                expect(row('第三方桌面会话记录').get_by_text('供应商未记录', exact=True)).to_be_visible()
                expect(row('Claude 明确记录供应商').get_by_text('recorded-private-gateway', exact=True)).to_be_visible()
                expect(row('Claude 明确记录供应商').get_by_text('供应商未记录', exact=True)).to_have_count(0)
                expect(row('Codex 原始区域').get_by_text('original-region', exact=True)).to_be_visible()
                values = provider.locator('option').evaluate_all('(options)=>options.map(o=>o.value).filter(Boolean)')
                assert set(values) == {'original-region', 'recorded-private-gateway'}, values
                passed('Source badges remain distinct from actual providers; missing Claude provenance is not fabricated')

                row('Claude 未记录供应商').click()
                expect(detail.get_by_text('原始历史未记录供应商', exact=False)).to_be_visible()
                expect(detail).to_contain_text('当前配置')
                expect(detail.locator('.chat-msg')).to_have_count(2)
                expect(detail.get_by_role('button', name='复制恢复命令', exact=True)).to_be_enabled()
                passed('Unknown provider detail explains historical uncertainty while normal CLI content remains readable')

                source.select_option(THIRD_PARTY_SOURCE)
                expect(rows).to_have_count(2)
                expect(row('第三方桌面会话记录')).to_be_visible()
                expect(row('第三方桌面正文冲突')).to_be_visible()
                expect(row('官方桌面可读会话')).to_have_count(0)
                source.select_option(CLI_SOURCE)
                expect(rows).to_have_count(2)
                provider.select_option('recorded-private-gateway')
                expect(rows).to_have_count(1)
                expect(row('Claude 明确记录供应商')).to_be_visible()
                provider.select_option('original-region')
                expect(rows).to_have_count(0)
                source.select_option('')
                expect(rows).to_have_count(1)
                expect(row('Codex 原始区域')).to_be_visible()
                provider.select_option('')
                search.fill('Claude-3p')
                expect(rows).to_have_count(2)
                search.fill('')
                expect(rows).to_have_count(len(sessions))
                passed('Source, provider and search filters combine without treating a source directory as a supplier')

                row('第三方桌面会话记录').click()
                expect(detail.get_by_text(MISSING_NOTE, exact=True)).to_be_visible()
                expect(detail.get_by_role('button', name='复制恢复命令', exact=True)).to_be_disabled()
                expect(detail.locator('.chat-msg')).to_have_count(0)
                expect(detail).to_contain_text('仅有会话记录，正文未定位')
                with page.expect_download() as download_info:
                    detail.get_by_role('button', name='导出', exact=True).click()
                destination = scratch / 'metadata.md'
                download_info.value.save_as(destination)
                markdown = destination.read_text(encoding='utf-8')
                assert MISSING_NOTE in markdown and THIRD_PARTY_SOURCE in markdown, markdown
                assert '原始回答' not in markdown
                exported = page.evaluate("window.calls.filter(c=>c.action==='sessions.export').at(-1).payload.summary")
                assert exported['id'] == 'desktop-metadata' and exported['contentStatus'] == 'metadata-only'
                passed('Metadata-only Desktop history explains missing content, disables resume and exports the selected record')

                row('第三方桌面正文冲突').click()
                expect(detail.get_by_text(AMBIGUOUS_NOTE, exact=True)).to_be_visible()
                expect(detail.get_by_role('button', name='复制恢复命令', exact=True)).to_be_disabled()
                expect(detail.locator('.chat-msg')).to_have_count(0)
                row('官方桌面可读会话').click()
                expect(detail.locator('.chat-msg')).to_have_count(2)
                expect(detail.get_by_role('button', name='复制恢复命令', exact=True)).to_be_disabled()
                with page.expect_download() as download_info:
                    detail.get_by_role('button', name='导出', exact=True).click()
                destination = scratch / 'desktop-readable.md'
                download_info.value.save_as(destination)
                markdown = destination.read_text(encoding='utf-8')
                assert '官方桌面可读会话：原始回答' in markdown and OFFICIAL_SOURCE in markdown
                assert MISSING_NOTE not in markdown and AMBIGUOUS_NOTE not in markdown
                row('CLI 明确不可恢复').click()
                expect(detail.get_by_role('button', name='复制恢复命令', exact=True)).to_be_disabled()
                assert page.evaluate("window.calls.filter(c=>c.action==='sessions.resume').length") == 0
                passed('Ambiguous content is explained and every Desktop or explicitly non-resumable record blocks CLI resume')

                assert not errors, errors
                assert not page.evaluate('window.unexpected'), page.evaluate('window.unexpected')
                assert page.evaluate('window.historyFixture') == fixture, 'History fixtures were mutated by browsing'
                passed('Browsing and exporting preserve input records and produce no page errors or unexpected IPC')
            finally:
                browser.close()
    print(json.dumps({'passed': len(checks), 'pageErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
