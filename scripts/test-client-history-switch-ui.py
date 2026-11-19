"""History-safe client setup UI using isolated IPC fixtures; no native clients or user files."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = """() => {
 window.generation=0;
 window.resetFixture=(agentId='chatgpt-desktop')=>{
   window.generation++;window.calls=[];window.pending=[];window.holdApply=false;window.applyFailure=null;window.previewFailure=null;window.previewWarnings=[];
   window.historyPlan={status:'pending',total:12,repairable:8,unchanged:4,blocked:0,preserved:0,skipped:0,skippedReasons:[],filesToBackUp:12,indexDatabasesToBackUp:2,blockedReasons:[],backupRequired:true,requiresClientExit:true,message:'配置保存后尝试处理历史。',warnings:[]};
   window.historyResult={status:'completed',backedUp:12,indexBackedUp:2,preserved:0,skipped:0,skippedReasons:[],repaired:8,unchanged:4,backupId:'fixture-backup',backupPath:'C:/Fixture/history-backup',message:'历史备份和迁移均已完成。'};
   const claude=agentId==='claude-code';const cli=agentId!=='chatgpt-desktop';
   window.state={settings:{},platform:'win32',agents:{},presets:[],providers:[{id:'supplier',name:'历史测试供应商',baseUrl:'https://fixture.invalid/v1',format:claude?'anthropic':'openai-responses',enabled:true,models:[{id:'first-model',contextWindow:272000},{id:'selected-model',contextWindow:128000}],apiKeys:[]}],detected:{[agentId]:{installed:true,configured:true,supportsCodexConfig:true,command:'C:/Fixture/ChatGPT.exe',configPath:'C:/Fixture/.codex/config.toml',evidence:[]}},agentCatalog:[{id:agentId,name:claude?'Claude Code':cli?'Codex CLI':'ChatGPT 桌面版',category:cli?'cli':'desktop',vendor:claude?'Anthropic':'OpenAI',description:'隔离客户端',protocol:claude?'anthropic':'openai-responses',support:'automatic',supportNote:'隔离的自动配置向导'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
 };
 window.resetFixture();
 window.aurora={invoke:async(action,payload={})=>{
   window.calls.push({action,payload:structuredClone(payload)});
   if(action==='agent.preview')return window.previewFailure?structuredClone(window.previewFailure):{ok:true,revision:'fixture-history-revision-'+window.calls.length,files:[{path:'C:/Fixture/.codex/config.toml',before:'original fixture',after:'reviewed fixture'}],warnings:structuredClone(window.previewWarnings),requiresRestart:true,...(window.historyPlan?{history:structuredClone(window.historyPlan)}:{})};
   if(action==='agent.connect'){
     if(window.holdApply)await new Promise(resolve=>window.pending.push(resolve));
     return window.applyFailure?structuredClone(window.applyFailure):{ok:true,message:'配置已保存，重启客户端后生效',path:'C:/Fixture/.codex/config.toml',...(window.historyResult?{history:structuredClone(window.historyResult)}:{})};
   }
   if(action==='agent.lifecycle')return {ok:true,agentId:payload.agentId,kind:'desktop',installed:true,supported:true};
   if(action==='agent.restart')return {ok:true,agentId:payload.agentId,kind:'desktop',operation:'restarted',message:'隔离客户端已重新启动'};
   throw Error('Unexpected isolated RPC '+action);
 }};
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshots', type=Path, help='Optional local evidence directory')
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    checks, errors, network = [], [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-history-switch-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderAgents=()=>root.render(<ToastHost key={window.generation}><Agents state={structuredClone(window.state)} reload={async()=>window.renderAgents()} go={()=>{}}/></ToastHost>);
window.renderAgents();"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle),
                   'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1380, 'height': 1050})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('**/*', lambda route: (network.append(route.request.url), route.abort()))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            page.add_style_tag(path=str(bundle.with_suffix('.css')))
            for style in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
            page.evaluate(FIXTURE)
            page.add_script_tag(path=str(bundle))

            def passed(label):
                checks.append(label)
                print('PASS', label, flush=True)

            def count(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).length', action)

            def last_payload(action):
                return page.evaluate('action=>window.calls.filter(call=>call.action===action).at(-1).payload', action)

            def open_preview(agent='chatgpt-desktop', setup=None):
                page.evaluate('agent=>window.resetFixture(agent)', agent)
                if setup:
                    page.evaluate(setup)
                page.evaluate('window.renderAgents()')
                page.get_by_role('button', name='开始配置 →', exact=True).click()
                name = page.evaluate('window.state.agentCatalog[0].name')
                dialog = page.get_by_role('dialog', name='配置 ' + name, exact=True)
                dialog.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
                dialog.get_by_role('combobox', name='选择模型', exact=True).select_option('selected-model')
                dialog.get_by_role('combobox', name='接入方式', exact=True).select_option('direct')
                dialog.get_by_role('combobox', name='客户端执行权限', exact=True).select_option('full-access')
                dialog.get_by_role('button', name='预览配置 →', exact=True).click()
                expect(dialog.get_by_text('reviewed fixture', exact=True)).to_be_visible()
                return dialog

            def result_details(dialog):
                details = dialog.locator('details[aria-label="历史会话处理结果"]')
                expect(details).not_to_have_attribute('open', '')
                details.locator(':scope > summary').click()
                return details

            dialog = open_preview()
            summary = dialog.locator('details[aria-label="历史会话辅助处理"]')
            expect(summary).not_to_have_attribute('open', '')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            expect(dialog.get_by_text('共 12 个会话记录', exact=False)).not_to_be_visible()
            expect(dialog).not_to_contain_text('应用前请先保存工作')
            assert count('agent.connect') == count('agent.restart') == 0
            summary.locator(':scope > summary').click()
            expect(summary).to_contain_text('先保存并备份客户端配置，再尝试备份和整理历史')
            expect(summary).to_contain_text('共 12 个会话记录 · 8 个可修复 · 4 个无需修改')
            summary.locator(':scope > summary').click()
            passed('Configuration is the primary action; history planning stays collapsed and has no client-exit prerequisite')

            page.evaluate('window.holdApply=true')
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('button', name='正在保存配置…', exact=True)).to_be_disabled()
            expect(dialog.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(dialog).to_be_visible()
            request = last_payload('agent.connect')
            assert request['providerId'] == 'supplier' and request['model'] == 'selected-model'
            assert request['mode'] == 'direct' and request['permissionMode'] == 'full-access'
            assert count('agent.connect') == 1
            page.evaluate('window.pending.shift()()')
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            outcome = result_details(dialog)
            expect(outcome).to_contain_text('已备份 12 个会话文件和 2 个索引数据库')
            expect(outcome).to_contain_text('已修复 8 个会话，4 个无需修改')
            outcome.get_by_text('查看历史备份位置', exact=True).click()
            expect(outcome).to_contain_text('C:/Fixture/history-backup')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('Saving uses the reviewed selection once, locks duplicate actions and reports completed history only when the backend confirms completion')

            dialog.get_by_role('button', name='重新启动客户端', exact=True).click()
            confirmation = page.get_by_role('dialog', name='重新启动 ChatGPT 桌面版', exact=True)
            expect(confirmation).to_be_visible()
            assert count('agent.restart') == 0
            confirmation.get_by_role('button', name='确认重新启动', exact=True).click()
            expect(confirmation).to_have_count(0)
            expect(dialog.get_by_text('隔离客户端已重新启动', exact=True)).to_be_visible()
            assert count('agent.restart') == 1
            passed('Saving leaves the explicit restart action available without terminating a client automatically')

            page.set_viewport_size({'width': 800, 'height': 850})
            page.evaluate("document.documentElement.dataset.theme='dark'")
            dialog = open_preview(setup="""window.historyPlan={status:'deferred',message:'客户端正在运行，历史稍后处理。'};window.historyResult={status:'deferred',code:'CLIENT_HISTORY_BUSY',message:'客户端正在运行，历史暂未备份或修改；配置已保存。',backedUp:0,indexBackedUp:0,repaired:0}""")
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'running-client-save-enabled.png'))
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            expect(dialog.get_by_role('button', name='已退出，重新应用', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('alert')).to_have_count(0)
            outcome = result_details(dialog)
            expect(outcome).to_contain_text('历史稍后处理 · 配置已保存')
            expect(outcome).to_contain_text('历史暂未备份或修改')
            expect(outcome).not_to_contain_text('已备份 0')
            expect(outcome).not_to_contain_text('已修复')
            expect(dialog).not_to_contain_text('无需再手动修复')
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'running-client-config-saved.png'))
            passed('A running client defers history while configuration succeeds and never asks the user to exit before saving')

            for status in ['deferred', 'failed']:
                dialog = open_preview(setup=f"""window.historyPlan={{status:'deferred',message:'历史目录暂时无法读取，仍可保存配置。'}};window.historyResult={{status:'{status}',message:'历史备份空间不足，本次历史未处理，配置已保存。',backedUp:41,indexBackedUp:8,repaired:10,backupPath:'C:/Fixture/incomplete-history-record'}}""")
                dialog.get_by_role('button', name='保存配置', exact=True).click()
                expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
                expect(dialog.get_by_role('alert')).to_have_count(0)
                outcome = result_details(dialog)
                expect(outcome).to_contain_text('历史备份空间不足')
                expect(outcome).not_to_contain_text('已备份')
                expect(outcome).not_to_contain_text('已修复')
                outcome.get_by_text('查看历史处理记录位置', exact=True).click()
                expect(outcome).to_contain_text('C:/Fixture/incomplete-history-record')
                assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('Deferred or failed history stays separate from successful configuration and cannot turn partial counters into claims of complete backup')

            dialog = open_preview()
            page.evaluate("window.applyFailure={ok:false,message:'客户端配置写入失败，请检查配置目录权限。'}")
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('客户端配置写入失败，请检查配置目录权限')
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_have_count(0)
            expect(dialog.get_by_role('combobox', name='选择模型', exact=True)).to_have_value('selected-model')
            expect(dialog.get_by_role('button', name='预览配置 →', exact=True)).to_be_enabled()
            page.evaluate('window.applyFailure=null')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            assert count('agent.connect') == 2 and count('agent.restart') == 0
            passed('An actual configuration write failure remains an error, retains the selection and requires a fresh preview before retry')

            dialog = open_preview()
            dialog.get_by_role('button', name='上一步', exact=True).click()
            page.evaluate("window.previewFailure={ok:false,message:'无法读取客户端配置文件。'}")
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('alert')).to_contain_text('无法读取客户端配置文件')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_have_count(0)
            page.evaluate('window.previewFailure=null')
            dialog.get_by_role('button', name='预览配置 →', exact=True).click()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            assert count('agent.connect') == 0
            passed('A real configuration preview failure offers a fresh preview without misreporting configuration success')

            dialog = open_preview(agent='codex-cli', setup="""window.historyResult={status:'deferred',message:'旧终端仍在运行，历史稍后处理。'}""")
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            expect(dialog.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            expect(dialog.get_by_role('heading', name='打开新终端，加载新配置', exact=True)).to_be_visible()
            assert count('agent.connect') == 1 and count('agent.restart') == count('agent.lifecycle') == 0
            passed('Codex CLI saves configuration despite an existing terminal and never terminates or relaunches that terminal')

            dialog = open_preview(setup="""window.historyPlan={status:'pending',total:120,repairable:10,unchanged:0,preserved:79,skipped:31,skippedReasons:['会话记录不是完整有效的 JSON，保留原始字节'],filesToBackUp:41,indexDatabasesToBackUp:8,warnings:Array(12).fill('较长历史说明：索引保持原样。')};window.historyResult={status:'completed',backedUp:41,indexBackedUp:8,repaired:10,unchanged:0,preserved:79,skipped:31,skippedReasons:['会话记录不是完整有效的 JSON，保留原始字节'],backupPath:'C:/Fixture/skipped-history-backup'}""")
            summary = dialog.locator('details[aria-label="历史会话辅助处理"]')
            expect(summary).not_to_have_attribute('open', '')
            expect(dialog.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).not_to_be_visible()
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            assert dialog.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            if args.screenshots:
                page.screenshot(path=str(args.screenshots / 'mixed-history-config-first.png'))
            summary.locator(':scope > summary').click()
            expect(summary).to_contain_text('共 120 个会话记录 · 10 个可修复 · 0 个无需修改 · 79 条索引原样保留 · 31 个备份后跳过修复')
            summary.locator(':scope > summary').click()
            dialog.get_by_role('button', name='保存配置', exact=True).click()
            outcome = result_details(dialog)
            expect(outcome).to_contain_text('已备份 41 个会话文件和 8 个索引数据库')
            expect(outcome).to_contain_text('已修复 10 个会话，0 个无需修改')
            expect(outcome).to_contain_text('79 条未找到原文件的会话索引已随数据库备份并原样保留')
            expect(outcome).to_contain_text('31 个会话未修复，已完整备份并原样保留')
            outcome.get_by_text('查看未修复原因', exact=True).click()
            expect(outcome.get_by_text('会话记录不是完整有效的 JSON，保留原始字节', exact=True)).to_be_visible()
            assert count('agent.connect') == 1 and count('agent.restart') == 0
            passed('Mixed completed history reports actual files, repaired, preserved and skipped counts behind an optional details panel')

            for total, preserved, skipped, files, reasons in [(107,107,0,0,[]),(3,0,3,3,['原始内容无法解析']),(0,0,0,0,['索引结构未知'])]:
                setup = {'status':'completed','backedUp':files,'indexBackedUp':1,'repaired':0,'unchanged':0,'preserved':preserved,'skipped':skipped,'skippedReasons':reasons}
                dialog = open_preview(setup='window.historyResult='+json.dumps(setup,ensure_ascii=False))
                dialog.get_by_role('button', name='保存配置', exact=True).click()
                outcome = result_details(dialog)
                expect(outcome).to_contain_text(f'已备份 {files} 个会话文件和 1 个索引数据库')
                expect(outcome).to_contain_text('已修复 0 个会话，0 个无需修改')
                expect(dialog).not_to_contain_text('无需再手动修复')
                assert count('agent.connect') == 1
            passed('Index-only, all-skipped and unknown-schema completion never invent repaired conversations or require successful history to save configuration')

            page.set_viewport_size({'width': 860, 'height': 620})
            dialog = open_preview(setup="window.historyPlan={status:'deferred',message:'历史暂时无法读取。'}")
            save = dialog.get_by_role('button', name='保存配置', exact=True)
            save.scroll_into_view_if_needed()
            expect(save).to_be_in_viewport()
            expect(save).to_be_enabled()
            expect(dialog.get_by_role('alert')).to_have_count(0)
            assert dialog.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            passed('A small viewport keeps configuration saving accessible while deferred-history details remain collapsed')

            dialog = open_preview(setup='window.historyPlan=null;window.historyResult=null')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            expect(dialog.locator('details[aria-label="历史会话辅助处理"]')).to_have_count(0)
            dialog = open_preview(agent='claude-code')
            expect(dialog.get_by_role('button', name='保存配置', exact=True)).to_be_enabled()
            expect(dialog.locator('details[aria-label="历史会话辅助处理"]')).to_have_count(0)
            passed('Empty history and other clients use the same clear Save Configuration action without Codex history prerequisites')

            assert not errors, errors
            assert not network, network
            browser.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
