"""Client lifecycle UI only: mocked IPC, no applications, terminals or network."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-client-restart-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import Agents from './ui/src/pages/Agents.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));
window.renderAgents=()=>root.render(<ToastHost key={window.generation}><Agents state={structuredClone(window.state)} reload={async()=>{window.reloads++;window.renderAgents();}} go={()=>{}}/></ToastHost>);"""
        options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'outfile': str(bundle), 'bundle': True, 'platform': 'browser', 'format': 'iife', 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1250, 'height': 1000})
            page.route('**/*', lambda route: route.abort())
            page.set_default_timeout(4000)
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for stylesheet in ['app.css', 'workspace.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / stylesheet))
            page.evaluate("""()=>{
              window.generation=0;
              window.reset=()=>{window.generation++;window.calls=[];window.reloads=0;window.infoOverride={};window.infoError='';window.operationError='';window.operation='restarted';window.holdInfo=false;window.holdRestart=false;window.pendingInfo=null;window.pendingRestart=null;
                window.state={settings:{},gateway:{running:true},presets:[],providers:[{id:'fixture-provider',name:'已配置的模型服务',baseUrl:'https://fixture.invalid',format:'anthropic',enabled:true,models:[{id:'fixture-model'}],apiKeys:[]}],agents:{'claude-desktop':{id:'claude-desktop',connected:true,providerId:'fixture-provider',model:'fixture-model'}},detected:{'claude-desktop':{installed:true},'codex-cli':{installed:true}},
                  agentCatalog:[{id:'claude-desktop',name:'Claude Desktop',vendor:'Anthropic',description:'通过云汇连接已配置的模型服务。',support:'automatic',category:'desktop',protocol:'anthropic'},
                    {id:'codex-cli',name:'Codex CLI',vendor:'OpenAI',description:'在命令行终端中使用编程助手。',support:'automatic',category:'cli',protocol:'openai-responses'},
                    {id:'deepseek',name:'DeepSeek API',vendor:'DeepSeek',description:'为支持自定义接口的应用提供连接参数。',support:'manual',category:'service',protocol:'openai-chat'}],codexCoexist:{identity:{available:false},models:[],warnings:[]}};
                window.aurora=window.mockApi;window.renderAgents?.();};
              window.mockApi={invoke:async(action,payload={})=>{window.calls.push({action,payload:structuredClone(payload)});
                if(action==='usage.recent')return [];
                if(action==='agent.lifecycle'){
                  if(window.holdInfo)await new Promise(resolve=>window.pendingInfo=resolve);
                  if(window.infoError)throw Error(window.infoError);
                  return {ok:true,agentId:payload.agentId,kind:payload.agentId==='codex-cli'?'cli':'desktop',installed:true,supported:true,message:'可以启动',...window.infoOverride};
                }
                if(action==='agent.restart'){
                  if(window.holdRestart)await new Promise(resolve=>window.pendingRestart=resolve);
                  const cli=payload.agentId==='codex-cli';
                  if(window.operationError)return {ok:false,agentId:payload.agentId,kind:cli?'cli':'desktop',operation:'failed',message:window.operationError};
                  return {ok:true,agentId:payload.agentId,kind:cli?'cli':'desktop',operation:cli?'opened-terminal':window.operation,message:cli?'已在新终端打开。原终端和会话仍保留。':window.operation==='started'?'客户端已启动。':'客户端已重新启动。增强连接需要重新连接。'};
                }
                if(action==='agent.preview')return {ok:true,revision:'fixture-preview',files:[],warnings:[],requiresRestart:true};
                if(action==='agent.connect')return {ok:true,message:'客户端配置已保存，请重新启动后使用。'};
                throw Error('Unexpected mock action '+action);
              }};window.reset();
            }""")
            page.add_script_tag(path=str(bundle))
            page.evaluate('window.renderAgents()')

            def card(name):
                return page.locator('.client-card').filter(has=page.get_by_role('heading', name=name, exact=True))

            def desktop_button():
                return card('Claude Desktop').get_by_role('button', name='重新启动客户端', exact=True)

            def restart_dialog():
                return page.get_by_role('dialog', name='重新启动 Claude Desktop', exact=True)

            def reset():
                page.evaluate('window.reset()')
                expect(desktop_button()).to_be_visible()

            def calls(action):
                return page.evaluate('(action)=>window.calls.filter(call=>call.action===action)', action)

            expect(desktop_button()).to_be_visible()
            expect(card('Codex CLI').get_by_role('button', name='新终端打开', exact=True)).to_be_visible()
            expect(card('DeepSeek API').locator('.client-restart')).to_have_count(0)
            assert page.evaluate("window.calls.every(call=>call.action==='usage.recent')")
            desktop_button().click()
            dialog = restart_dialog()
            expect(dialog).to_contain_text('将强制结束此客户端的进程（包括托盘和后台进程），确认退出后重新打开；未运行时直接启动。')
            expect(dialog).to_contain_text('当前会话会中断，未保存的内容可能丢失，请先保存工作。')
            assert calls('agent.lifecycle') == [{'action': 'agent.lifecycle', 'payload': {'agentId': 'claude-desktop'}}]
            assert not calls('agent.restart')
            dialog.get_by_role('button', name='取消', exact=True).click()
            expect(dialog).not_to_be_visible()
            assert not calls('agent.restart')
            checks.append('Cards expose distinct desktop and CLI actions; checking and canceling never execute a lifecycle mutation')

            reset()
            page.evaluate('window.holdInfo=true')
            desktop_button().click()
            expect(card('Claude Desktop').get_by_role('button', name='正在检查…', exact=True)).to_be_disabled()
            assert len(calls('agent.lifecycle')) == 1
            page.evaluate('window.pendingInfo()')
            expect(restart_dialog()).to_be_visible()
            page.evaluate('window.holdRestart=true')
            restart_dialog().get_by_role('button', name='确认重新启动', exact=True).click()
            expect(restart_dialog().get_by_role('button', name='正在重新启动…', exact=True)).to_be_disabled()
            expect(restart_dialog().get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.keyboard.press('Escape')
            expect(restart_dialog()).to_be_visible()
            assert calls('agent.restart') == [{'action': 'agent.restart', 'payload': {'agentId': 'claude-desktop'}}]
            page.evaluate('window.pendingRestart()')
            expect(restart_dialog()).not_to_be_visible()
            expect(card('Claude Desktop').get_by_role('status')).to_contain_text('客户端已重新启动。增强连接需要重新连接。')
            checks.append('Checking and executing disable duplicate clicks; execution is not dismissed by Escape and passes only the client ID')

            for override in [
                {'installed': False, 'message': '未检测到客户端，请安装后重新检查'},
                {'supported': False, 'message': '此系统暂不支持启动该客户端'},
            ]:
                reset()
                page.evaluate('(value)=>window.infoOverride=value', override)
                desktop_button().click()
                expect(card('Claude Desktop').get_by_role('alert')).to_contain_text(override['message'])
                expect(restart_dialog()).to_have_count(0)
                assert not calls('agent.restart')
                page.evaluate('window.infoOverride={}')
                card('Claude Desktop').get_by_role('button', name='重新检查', exact=True).click()
                expect(restart_dialog()).to_be_visible()
                restart_dialog().get_by_role('button', name='取消', exact=True).click()
            checks.append('Unavailable or unsupported clients show a persistent retry and never execute')

            reset()
            page.evaluate("window.infoError='检测进程失败'")
            desktop_button().click()
            expect(card('Claude Desktop').get_by_role('alert')).to_contain_text('检测进程失败')
            page.evaluate("window.infoError='';window.operationError='客户端进程尚未结束，请检查系统权限后重试'")
            card('Claude Desktop').get_by_role('button', name='重新检查', exact=True).click()
            restart_dialog().get_by_role('button', name='确认重新启动', exact=True).click()
            expect(restart_dialog().get_by_role('alert')).to_contain_text('客户端进程尚未结束')
            assert len(calls('agent.restart')) == 1
            restart_dialog().get_by_role('button', name='取消', exact=True).click()
            expect(card('Claude Desktop').get_by_role('alert')).to_contain_text('客户端进程尚未结束')
            page.evaluate("window.operationError='';window.operation='started'")
            card('Claude Desktop').get_by_role('button', name='重新检查', exact=True).click()
            restart_dialog().get_by_role('button', name='确认重新启动', exact=True).click()
            expect(card('Claude Desktop').get_by_role('status')).to_have_text('客户端已启动。')
            checks.append('Info and execution errors remain visible; an explicit retry reports starting an inactive client truthfully')

            reset()
            cli = card('Codex CLI')
            expect(cli.get_by_role('button', name='重新启动客户端', exact=True)).to_have_count(0)
            cli.get_by_role('button', name='新终端打开', exact=True).click()
            cli_dialog = page.get_by_role('dialog', name='在新终端打开 Codex CLI', exact=True)
            expect(cli_dialog).to_contain_text('原终端和会话会保留')
            expect(cli_dialog).to_contain_text('需要加载新配置时，请先结束旧会话')
            cli_dialog.get_by_role('button', name='新终端打开', exact=True).click()
            expect(cli.get_by_role('status')).to_contain_text('原终端和会话仍保留')
            assert calls('agent.restart') == [{'action': 'agent.restart', 'payload': {'agentId': 'codex-cli'}}]
            checks.append('CLI opens a new terminal with an explicit explanation that existing sessions stay open')

            reset()
            card('Claude Desktop').get_by_role('button', name='更换配置 →', exact=True).click()
            wizard = page.get_by_role('dialog', name='配置 Claude Desktop', exact=True)
            wizard.get_by_role('button', name='下一步：选择模型 →', exact=True).click()
            wizard.get_by_role('button', name='预览配置 →', exact=True).click()
            wizard.get_by_role('button', name='保存配置', exact=True).click()
            expect(wizard.get_by_role('heading', name='配置已保存，重启客户端后生效', exact=True)).to_be_visible()
            wizard.get_by_role('button', name='重新启动客户端', exact=True).click()
            expect(restart_dialog()).to_be_visible()
            expect(wizard.get_by_role('button', name='完成', exact=True)).to_be_disabled()
            restart_dialog().get_by_role('button', name='取消', exact=True).click()
            expect(wizard).to_be_visible()
            expect(wizard.get_by_role('button', name='完成', exact=True)).to_be_enabled()
            wizard.get_by_role('button', name='重新启动客户端', exact=True).click()
            restart_dialog().get_by_role('button', name='确认重新启动', exact=True).click()
            expect(wizard.get_by_role('status')).to_contain_text('客户端已重新启动')
            assert len(calls('agent.connect')) == 1
            assert len(calls('agent.restart')) == 1
            wizard.get_by_role('button', name='完成', exact=True).click()
            checks.append('The configuration success view reuses lifecycle controls without reapplying configuration or closing the wizard during confirmation')

            reset()
            page.evaluate('window.aurora=undefined;window.generation++;window.renderAgents()')
            expect(page.locator('.client-card')).to_have_count(3)
            expect(page.locator('.client-restart')).to_have_count(0)
            assert page.evaluate("window.calls.every(call=>call.action==='usage.recent')")
            checks.append('Browser mode and API services expose no application or terminal launch controls')

            reset()
            artifacts = ROOT / 'tmp'
            artifacts.mkdir(exist_ok=True)
            for theme in ['light', 'dark']:
                page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
                page.locator('.client-grid').screenshot(path=str(artifacts / f'client-restart-{theme}.png'))
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(desktop_button()).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            assert not errors, errors
            browser.close()
            for check in checks:
                print('PASS', check)
            print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors}, ensure_ascii=False))


if __name__ == '__main__':
    main()
