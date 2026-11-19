"""Desktop extension recovery UI with mocked IPC; never launches clients or writes reports into the repo."""
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix='yunhui-extension-connection-ui-') as temporary:
        bundle = Path(temporary) / 'ui.js'
        source = """import React from 'react';import {createRoot} from 'react-dom/client';
import DesktopExtensions from './ui/src/pages/DesktopExtensions.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
const root=createRoot(document.getElementById('root'));let fixtureGeneration;
// Reset cases own separate transports; navigation-cache behavior has a dedicated suite.
window.renderPage=()=>{if(fixtureGeneration!==window.generation&&window.aurora)window.aurora={...window.aurora};fixtureGeneration=window.generation;root.render(<ToastHost key={window.generation}><DesktopExtensions/></ToastHost>);};"""
        build = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': 'tsx'}, 'bundle': True, 'platform': 'browser', 'format': 'iife', 'outfile': str(bundle), 'define': {'process.env.NODE_ENV': '"production"'}}
        subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(build) + ')'], cwd=ROOT, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1240, 'height': 950})
            page.route('**/*', lambda route: route.abort())
            page.set_default_timeout(4000)
            errors, checks = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
            for name in ['app.css', 'workspace.css', 'extension-connection-recovery.css']:
                page.add_style_tag(path=str(ROOT / 'ui/src/styles' / name))
            page.evaluate("""()=>{
              window.generation=0;
              window.reset=()=>{window.generation++;window.calls=[];window.connectError='无法连接调试端口，请先保存工作并退出客户端';window.selection='cancel';window.selectionPath='C:/Fixture/ChatGPT.exe';window.configureError='';window.hold='';window.release=null;
                window.ext={ok:true,upstream:{repository:'fixture',version:'1',revision:'fixture',license:'AGPL'},
                  client:{installed:true,exePath:'C:/Old/ChatGPT.exe',version:'1',lastVersion:'1',versionChanged:false,running:true,compatible:true,message:'已找到客户端，尚未连接调试接口'},
                  connection:{exePath:'C:/Old/ChatGPT.exe',port:9333,lastVersion:'1'},runtime:{connected:false,applied:[],errors:[]},
                  items:[{id:'bundled:fixture',name:'保留的插件',description:'测试原有插件设置',source:'bundled',installed:true,enabled:true,status:'needs-connection',config:{color:'blue'}}]};
                window.aurora=window.mockApi;window.renderPage?.();};
              window.mockApi={invoke:async(action,payload={})=>{window.calls.push({action,payload:structuredClone(payload)});
                if(window.hold===action)await new Promise(resolve=>window.release=resolve);
                if(action==='extension.list')return structuredClone(window.ext);
                if(action==='extension.connect'){if(window.connectError)return {ok:false,message:window.connectError};window.ext.runtime.connected=true;window.ext.runtime.errors=[];return {ok:true,message:'已连接测试客户端'};}
                if(action==='extension.disconnect'){window.ext.runtime.connected=false;return {ok:true};}
                if(action==='agent.desktop.select'){
                  if(window.selection==='cancel')return {ok:false,canceled:true};
                  if(window.selection==='fail')return {ok:false,message:'无法识别所选程序，请选择完整安装的主程序'};
                  window.ext.connection.exePath=window.selectionPath;delete window.ext.connection.lastVersion;
                  window.ext.client.exePath=window.selectionPath;window.ext.client.installed=true;window.ext.runtime.connected=false;window.ext.runtime.errors=[];
                  return {ok:true,detected:{command:window.selectionPath},message:'已保存程序路径'};
                }
                if(action==='extension.configure'){
                  if(window.configureError)return {ok:false,message:window.configureError};
                  window.ext.connection={...window.ext.connection,exePath:payload.exePath||undefined,port:payload.port};delete window.ext.connection.lastVersion;
                  window.ext.runtime.connected=false;window.ext.runtime.errors=[];return {ok:true,connection:structuredClone(window.ext.connection)};
                }
                throw Error('Unexpected action '+action);
              }};window.reset();
            }""")
            page.add_script_tag(path=str(bundle))
            page.evaluate('window.renderPage()')
            recovery = page.get_by_role('region', name='桌面插件连接处理', exact=True)

            def calls(action):
                return page.evaluate('(action)=>window.calls.filter(call=>call.action===action)', action)

            def reset():
                page.evaluate('window.reset()')
                expect(page.get_by_role('button', name='启动并连接', exact=True)).to_be_visible()

            def fail_connection():
                page.get_by_role('button', name='启动并连接', exact=True).click()
                expect(recovery).to_be_visible()
                expect(recovery.get_by_role('alert')).to_contain_text('无法连接调试端口')

            fail_connection()
            for name in ['选择程序', '重新连接', '恢复默认连接设置']:
                expect(recovery.get_by_role('button', name=name, exact=True)).to_be_enabled()
            expect(recovery).to_contain_text('请保存工作')
            expect(recovery).to_contain_text('.exe')
            expect(recovery).to_contain_text('.app')
            checks.append('Connection failure exposes all three recovery actions and a save-work reminder')

            old_state = page.evaluate('structuredClone(window.ext)')
            list_calls = len(calls('extension.list'))
            recovery.get_by_role('button', name='选择程序', exact=True).click()
            expect(recovery.get_by_role('alert')).to_contain_text('无法连接调试端口')
            assert page.evaluate('window.ext') == old_state
            assert len(calls('extension.list')) == list_calls
            assert calls('agent.desktop.select')[-1]['payload'] == {'agentId': 'chatgpt-desktop'}
            checks.append('Canceling the trusted picker preserves the original error and path without configuration or refresh calls')

            page.evaluate("window.selection='fail'")
            recovery.get_by_role('button', name='选择程序', exact=True).click()
            expect(recovery).to_contain_text('无法识别所选程序')
            expect(recovery).to_contain_text('无法连接调试端口')
            assert page.evaluate('window.ext') == old_state
            recovery.get_by_role('button', name='恢复默认连接设置', exact=True).click()
            page.get_by_role('dialog', name='恢复默认连接设置', exact=True).get_by_role('button', name='取消', exact=True).click()
            expect(recovery).to_contain_text('无法识别所选程序')
            assert not calls('extension.configure')
            page.evaluate("window.selection='success';window.selectionPath='/Applications/ChatGPT.app';window.hold='agent.desktop.select'")
            recovery.get_by_role('button', name='选择程序', exact=True).click()
            for name in ['选择中…', '重新连接', '恢复默认连接设置']:
                expect(recovery.get_by_role('button', name=name, exact=True)).to_be_disabled()
            before = len(calls('agent.desktop.select'))
            recovery.get_by_role('button', name='选择中…', exact=True).evaluate('(button)=>button.click()')
            assert len(calls('agent.desktop.select')) == before
            page.evaluate("window.hold='';window.release()")
            expect(recovery.get_by_role('status')).to_contain_text('程序路径已保存')
            expect(recovery).not_to_contain_text('无法识别所选程序')
            expect(recovery).to_contain_text('无法连接调试端口')
            assert page.evaluate('window.ext.connection.exePath') == '/Applications/ChatGPT.app'
            assert page.evaluate('window.ext.connection.port') == 9333
            assert page.evaluate('window.ext.items') == old_state['items']
            assert len(calls('extension.connect')) == 1
            assert not calls('agent.restart') and not calls('extension.configure')
            checks.append('Picker errors can recover, one picker runs at a time, and selecting an app only updates its shared path')

            page.evaluate("window.ext.client.versionChanged=true;window.ext.client.version='2'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(recovery.get_by_role('button', name='重新连接', exact=True)).to_be_disabled()
            page.get_by_role('checkbox').check()
            page.evaluate("window.hold='extension.connect'")
            recovery.get_by_role('button', name='重新连接', exact=True).click()
            before = len(calls('extension.connect'))
            expect(recovery.get_by_role('button', name='连接中…', exact=True)).to_be_disabled()
            recovery.get_by_role('button', name='连接中…', exact=True).evaluate('(button)=>button.click()')
            assert len(calls('extension.connect')) == before
            assert calls('extension.connect')[-1]['payload'] == {'launch': True, 'acknowledgeVersion': True}
            page.evaluate("window.hold='';window.connectError='调试接口仍不可用';window.release()")
            expect(recovery.get_by_role('alert')).to_have_text('调试接口仍不可用')
            page.evaluate("window.ext.client.version='3'")
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(page.get_by_role('checkbox')).not_to_be_checked()
            expect(recovery.get_by_role('button', name='重新连接', exact=True)).to_be_disabled()
            page.get_by_role('checkbox').check()
            page.evaluate("window.connectError=''")
            recovery.get_by_role('button', name='重新连接', exact=True).click()
            expect(recovery).not_to_be_visible()
            checks.append('Reconnect preserves version acknowledgements, prevents duplicate requests and retains actionable failures until success')

            reset()
            page.evaluate("window.connectError='Windows 未能以商店包身份启动客户端。请完全退出客户端，确认开始菜单可以打开，并以普通权限重新连接。'")
            page.get_by_role('button', name='启动并连接', exact=True).click()
            expect(recovery.get_by_role('alert')).to_contain_text('商店包身份')
            page.evaluate("window.selection='success';window.selectionPath='C:/Program Files/WindowsApps/Fixture/ChatGPT.exe'")
            recovery.get_by_role('button', name='选择程序', exact=True).click()
            expect(recovery.get_by_role('status')).to_contain_text('程序路径已保存')
            expect(recovery.get_by_role('alert')).to_contain_text('商店包身份')
            assert len(calls('extension.connect')) == 1
            recovery.get_by_role('button', name='重新连接', exact=True).click()
            expect(recovery.get_by_role('alert')).to_contain_text('商店包身份')
            assert len(calls('extension.connect')) == 2
            assert calls('extension.connect')[-1]['payload']['launch'] is True
            page.evaluate("window.connectError=''")
            recovery.get_by_role('button', name='重新连接', exact=True).click()
            expect(recovery).not_to_be_visible()
            checks.append('Store activation failures retain actionable guidance until reconnect succeeds; choosing the EXE never launches it')

            reset()
            fail_connection()
            old_items = page.evaluate('structuredClone(window.ext.items)')
            recovery.get_by_role('button', name='恢复默认连接设置', exact=True).click()
            restore = page.get_by_role('dialog', name='恢复默认连接设置', exact=True)
            expect(restore).to_contain_text('自动检测')
            expect(restore).to_contain_text('9222')
            expect(restore).to_contain_text('已安装插件、插件配置、账号和客户端文件都会保留')
            expect(restore).to_contain_text('不会自动退出或重新启动')
            assert not calls('extension.configure')
            restore.get_by_role('button', name='取消', exact=True).click()
            expect(restore).not_to_be_visible()
            assert not calls('extension.configure')
            recovery.get_by_role('button', name='恢复默认连接设置', exact=True).click()
            page.evaluate("window.configureError='连接设置保存失败'")
            restore.get_by_role('button', name='确认恢复', exact=True).click()
            expect(restore.get_by_role('alert')).to_have_text('连接设置保存失败')
            assert page.evaluate('window.ext.connection.exePath') == 'C:/Old/ChatGPT.exe'
            assert page.evaluate('window.ext.connection.port') == 9333
            page.evaluate("window.configureError='';window.hold='extension.configure'")
            restore.get_by_role('button', name='确认恢复', exact=True).click()
            expect(restore.get_by_role('button', name='恢复中…', exact=True)).to_be_disabled()
            expect(restore.get_by_role('button', name='取消', exact=True)).to_be_disabled()
            page.evaluate("window.hold='';window.release()")
            expect(restore).not_to_be_visible()
            expect(recovery.get_by_role('status')).to_contain_text('已恢复自动检测程序')
            assert calls('extension.configure')[-1]['payload'] == {'exePath': '', 'port': 9222}
            assert page.evaluate('window.ext.connection.port') == 9222
            assert page.evaluate('window.ext.connection.exePath===undefined')
            assert page.evaluate('window.ext.items') == old_items
            assert len(calls('extension.connect')) == 1 and not calls('agent.restart')
            checks.append('Restore requires explicit confirmation, survives save failures and resets only path and port without launching a client')

            page.get_by_role('button', name='连接设置', exact=True).click()
            settings = page.get_by_role('dialog', name='连接 ChatGPT 桌面版', exact=True)
            settings.get_by_label('桌面客户端路径', exact=True).fill('C:/Draft/ChatGPT.exe')
            settings.get_by_label('桌面调试端口', exact=True).fill('9444')
            page.evaluate("window.selection='cancel'")
            settings.get_by_role('button', name='选择程序', exact=True).click()
            expect(settings.get_by_label('桌面客户端路径', exact=True)).to_have_value('C:/Draft/ChatGPT.exe')
            expect(settings.get_by_label('桌面调试端口', exact=True)).to_have_value('9444')
            page.evaluate("window.selection='success';window.selectionPath='C:/Fixture/ChatGPT.exe'")
            settings.get_by_role('button', name='选择程序', exact=True).click()
            expect(settings.get_by_label('桌面客户端路径', exact=True)).to_have_value('C:/Fixture/ChatGPT.exe')
            expect(settings.get_by_label('桌面调试端口', exact=True)).to_have_value('9444')
            assert page.evaluate('window.ext.connection.port') == 9222
            settings.get_by_role('button', name='取消', exact=True).click()
            checks.append('Settings picker cancellation keeps unsaved drafts and a successful selection does not silently save a draft port')

            reset()
            page.evaluate("window.ext.runtime.errors=[{id:'runtime',message:'上次增强通道连接失败'}];window.generation++;window.renderPage()")
            expect(recovery).to_contain_text('上次增强通道连接失败')
            reset()
            page.evaluate("window.ext.client.installed=false;window.ext.client.message='客户端程序不存在';window.generation++;window.renderPage()")
            expect(recovery).to_contain_text('客户端程序不存在')
            page.set_viewport_size({'width': 780, 'height': 1000})
            expect(recovery.get_by_role('button', name='恢复默认连接设置', exact=True)).to_be_visible()
            assert recovery.evaluate('(element)=>element.scrollWidth<=element.clientWidth+1')
            checks.append('Saved runtime failures and missing installations expose recovery, with actions fitting a narrow window')

            before = len(page.evaluate('window.calls'))
            page.evaluate('window.aurora=undefined;window.generation++;window.renderPage()')
            expect(page.get_by_text('请在电脑上管理桌面插件', exact=True)).to_be_visible()
            for name in ['选择程序', '重新连接', '恢复默认连接设置', '连接设置']:
                expect(page.get_by_role('button', name=name, exact=True)).to_have_count(0)
            assert len(page.evaluate('window.calls')) == before
            assert not errors, errors
            checks.append('Remote mode exposes no native recovery controls or calls and the renderer stays error-free')
            browser.close()
            report = {'passed': True, 'count': len(checks), 'checks': checks, 'scope': 'Mocked IPC and Chromium only; no desktop processes, real credentials or repo reports changed'}
            (Path(temporary) / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(report, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
