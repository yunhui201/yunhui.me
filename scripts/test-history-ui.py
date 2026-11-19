"""Real history UI + real repair service/SQLite acceptance in temporary client directories.

The browser uses a test-only stdin RPC worker whose HistoryContext supplies an empty
process list. No production bypass, real client process, network or user profile is used.
Requires Python Playwright with Chromium and the workspace Node dependencies.
"""
import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TARGET = '国内.中转'


def bundle(source, output, platform, loader):
    options = {'stdin': {'contents': source, 'resolveDir': str(ROOT), 'loader': loader},
               'bundle': True, 'platform': platform, 'format': 'cjs' if platform == 'node' else 'iife',
               'outfile': str(output), 'logLevel': 'silent'}
    if platform == 'browser':
        options['define'] = {'process.env.NODE_ENV': '"production"'}
    subprocess.run(['node', '-e', 'require("esbuild").buildSync(' + json.dumps(options) + ')'], cwd=ROOT, check=True)


def main():
    checks, errors = [], []
    with tempfile.TemporaryDirectory(prefix='yunhui-history-ui-') as temporary:
        scratch = Path(temporary).resolve()
        clients, home = scratch / 'clients', scratch / 'clients/.codex'
        home.mkdir(parents=True)
        config_file = home / 'config.toml'
        config = 'model_provider = "openai"\n[model_providers."国内.中转"]\nname = "国内备用"\n[model_providers.aurora]\nname = "云汇"\n'
        config_file.write_text(config, encoding='utf-8', newline='\n')
        original_config = config_file.read_bytes()
        db_file = home / 'state_5.sqlite'
        sessions = {}
        with closing(sqlite3.connect(db_file)) as db:
            db.executescript("""PRAGMA journal_mode=WAL;
CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,rollout_path TEXT,title TEXT,archived INTEGER);
CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT);
INSERT INTO local_thread_catalog_hosts VALUES('desktop','local'),('remote','remote');
CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));""")
            for n, provider, archived, title in [(1, 'old', False, '迁移第一条'), (2, 'old', False, '保留第二条'), (3, 'old', True, '归档第三条'), (4, 'other', False, '其他区域第四条')]:
                uid = f'10000000-0000-4000-8000-{n:012}'
                file = home / ('archived_sessions' if archived else 'sessions') / f'rollout-{uid}.jsonl'
                file.parent.mkdir(parents=True, exist_ok=True)
                records = [json.dumps({'type': 'session_meta', 'payload': {'id': uid, 'model_provider': provider, 'source': 'cli', 'cwd': 'D:/fixture'}}, ensure_ascii=False),
                           ' ' + json.dumps({'type': 'event_msg', 'payload': {'type': 'user_message', 'message': title}}, ensure_ascii=False) + ' ',
                           json.dumps({'type': 'response_item', 'payload': {'type': 'reasoning', 'encrypted_content': 'fixture-encrypted-keep-exactly'}})]
                original = ('\r\n'.join(records) + '\r\n').encode('utf-8')
                file.write_bytes(original)
                db.execute('INSERT INTO threads VALUES(?,?,?,?,?)', (uid, provider, str(file), title, int(archived)))
                for host, region in [('desktop', provider), ('remote', 'remote-original')]:
                    db.execute('INSERT INTO local_thread_catalog VALUES(?,?,?)', (host, uid, region))
                sessions[n] = {'id': uid, 'file': file, 'original': original, 'provider': provider, 'title': title}
            db.commit()

        worker_file, ui_file = scratch / 'worker.cjs', scratch / 'history-ui.js'
        bundle("""import readline from 'node:readline';import path from 'node:path';
import {createHistoryRepairService} from './src/core/historyRepair.ts';
import {scanSessions,readSession} from './src/core/sessions.ts';
const home=path.join(process.env.AURORA_CLIENT_HOME,'.codex');
const service=createHistoryRepairService({home,sqliteHome:home,blockingProcesses:async()=>[]});
(async()=>{for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
try{const {action,payload={}}=JSON.parse(line);let result;
if(action==='sessions.scan')result=scanSessions();else if(action==='sessions.read')result=readSession(payload.path);
else if(action.startsWith('codex.repair.')){const method=action.slice('codex.repair.'.length);if(!['providers','preview','apply','backups','restorePreview','restore'].includes(method))throw Error('Unexpected test RPC');result=await service[method](payload);}
else throw Error('Unexpected test RPC');process.stdout.write(JSON.stringify({result})+'\\n');}
catch(error){process.stdout.write(JSON.stringify({error:String(error.message||error)})+'\\n');}}})();""", worker_file, 'node', 'ts')
        bundle("""import React from 'react';import {createRoot} from 'react-dom/client';
import Sessions from './ui/src/pages/Sessions.tsx';import {ToastHost} from './ui/src/components/ui.tsx';
createRoot(document.getElementById('root')).render(<ToastHost><Sessions state={{}} reload={async()=>{}} go={()=>{}}/></ToastHost>);""", ui_file, 'browser', 'tsx')
        environment = dict(os.environ, AURORA_CLIENT_HOME=str(clients))
        worker = subprocess.Popen(['node', str(worker_file)], cwd=ROOT, env=environment,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))

        def rpc(action, payload=None):
            assert worker.poll() is None, 'Test RPC worker stopped'
            worker.stdin.write(json.dumps({'action': action, 'payload': payload or {}}, ensure_ascii=False) + '\n')
            worker.stdin.flush()
            line = worker.stdout.readline()
            assert line, 'Test RPC worker returned no response'
            response = json.loads(line)
            if 'error' in response:
                raise RuntimeError(response['error'])
            return response['result']

        def native_regions():
            with closing(sqlite3.connect(db_file)) as db:
                return dict(db.execute('SELECT id,model_provider FROM threads')), {(host, uid): provider for host, uid, provider in db.execute('SELECT host_id,thread_id,model_provider FROM local_thread_catalog')}

        def passed(label):
            checks.append(label)
            print('PASS', label, flush=True)

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page(viewport={'width': 1460, 'height': 1100}, locale='zh-CN')
                page.route('**/*', lambda route: route.abort())
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.expose_function('testHistoryRpc', rpc)
                page.set_content('<html data-theme="light"><main id="root" style="padding:24px"></main></html>')
                for style in ['app.css', 'workspace.css']:
                    page.add_style_tag(path=str(ROOT / 'ui/src/styles' / style))
                page.evaluate("window.calls=[];window.aurora={invoke:async(action,payload={})=>{window.calls.push({action,payload});return window.testHistoryRpc(action,payload);}}")
                page.add_script_tag(path=str(ui_file))
                rows = page.locator('.split .list-row[role="button"]')
                expect(rows).to_have_count(4)
                page.get_by_label('历史供应商区域', exact=True).select_option('old')
                expect(rows).to_have_count(3)
                expect(rows.filter(has_text='归档第三条').get_by_text('已归档', exact=True)).to_be_visible()
                page.get_by_role('button', name='批量修复历史 / 区域迁移', exact=True).click()
                dialog = page.get_by_role('dialog', name='历史会话 · 批量修复', exact=True)
                source = dialog.get_by_label('原供应商筛选', exact=True)
                target = dialog.get_by_label('目标供应商标识', exact=True)
                expect(source).to_be_enabled()
                expect(source).to_have_value('old')
                assert source.locator('option').all_text_contents() == ['全部来源区域', 'old · 3 个会话', 'other · 1 个会话']
                assert any(TARGET in name for name in target.locator('option').all_text_contents())
                target.select_option(TARGET)
                passed('Native history provider filter opens the migration modal with its source region and configured target choices')

                def scan():
                    button = dialog.get_by_role('button', name='扫描并预览', exact=True)
                    if not button.count():
                        button = dialog.get_by_role('button', name='重新扫描', exact=True)
                    button.click()
                    expect(dialog.locator('.repair-table')).to_be_visible()
                    expect(dialog.get_by_role('button', name='重新扫描', exact=True)).to_be_enabled()

                scan()
                expect(dialog.locator('.repair-table tbody tr')).to_have_count(3)
                assert dialog.locator('.repair-table tbody tr').all_text_contents()[0].count(TARGET) == 1
                target.select_option('aurora')
                expect(dialog.locator('.repair-table')).to_have_count(0)
                target.select_option(TARGET)
                scan()
                source.select_option('other')
                expect(dialog.locator('.repair-table')).to_have_count(0)
                source.select_option('old')
                passed('Changing source or target discards the previous preview and selection before another migration')

                scan()
                dialog.get_by_role('button', name='清空选择', exact=True).click()
                dialog.get_by_label('修复 迁移第一条', exact=True).check()
                (ROOT / 'docs/images').mkdir(exist_ok=True)
                page.screenshot(path=str(ROOT / 'docs/images/history-migration-v0.6.png'), animations='disabled')
                expect(dialog.get_by_role('button', name='备份并迁移所选 (1)', exact=True)).to_be_disabled()
                dialog.get_by_label('我已保存工作并退出 ChatGPT 桌面版及使用此会话库的命令行客户端。', exact=True).check()
                dialog.get_by_role('button', name='备份并迁移所选 (1)', exact=True).click()
                expect(dialog.locator('.repair-table')).to_have_count(0)
                expect(dialog.get_by_role('button', name='扫描并预览', exact=True)).to_be_enabled()
                native, catalog = native_regions()
                for n, session in sessions.items():
                    expected = TARGET if n == 1 else session['provider']
                    assert native[session['id']] == expected
                    assert catalog[('desktop', session['id'])] == expected
                    assert catalog[('remote', session['id'])] == 'remote-original'
                    data = session['file'].read_bytes()
                    assert json.loads(data.split(b'\r\n')[0])['payload']['model_provider'] == expected
                    assert data.split(b'\r\n', 1)[1] == session['original'].split(b'\r\n', 1)[1]
                    if n != 1:
                        assert data == session['original']
                assert config_file.read_bytes() == original_config
                apply_calls = page.evaluate("window.calls.filter(c=>c.action==='codex.repair.apply')")
                assert len(apply_calls) == 1 and apply_calls[0]['payload']['ids'] == [sessions[1]['id']]
                passed('Selecting one conversation migrates its JSONL, canonical and local SQLite region while preserving other histories, remote catalogs and body bytes')

                dialog.get_by_role('button', name='关闭', exact=True).click()
                page.get_by_label('历史供应商区域', exact=True).select_option(TARGET)
                expect(rows).to_have_count(1)
                expect(rows.first).to_contain_text('迁移第一条')
                page.get_by_role('button', name='批量修复历史 / 区域迁移', exact=True).click()
                expect(source).to_have_value(TARGET)
                dialog.get_by_role('button', name='修复备份与恢复', exact=True).click()
                dialog.get_by_role('button', name='预览恢复', exact=True).click()
                expect(dialog.get_by_text('没有检测到冲突，可以恢复本批次。', exact=True)).to_be_visible()
                dialog.get_by_role('button', name='恢复本批次修改', exact=True).click()
                expect(dialog.get_by_text('已恢复', exact=True)).to_be_visible()
                native, catalog = native_regions()
                for session in sessions.values():
                    assert session['file'].read_bytes() == session['original']
                    assert native[session['id']] == session['provider']
                    assert catalog[('desktop', session['id'])] == session['provider']
                assert config_file.read_bytes() == original_config
                passed('The migrated region is immediately filterable and the backup UI restores exact files plus original SQLite ownership')

                dialog.get_by_role('button', name='返回修复', exact=True).click()
                source.select_option('old')
                target.select_option(TARGET)
                scan()
                dialog.get_by_label('我已保存工作并退出 ChatGPT 桌面版及使用此会话库的命令行客户端。', exact=True).check()
                external = sessions[2]['original'] + b'\r\n'
                sessions[2]['file'].write_bytes(external)
                dialog.get_by_role('button', name='备份并迁移所选 (3)', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('会话文件或索引已发生变化')
                assert len(page.evaluate("window.calls.filter(c=>c.action==='codex.repair.apply')")) == 1
                assert sessions[2]['file'].read_bytes() == external
                assert native_regions()[0][sessions[2]['id']] == 'old'
                passed('A file change after preview is rejected visibly inside the modal before the apply RPC and preserves external content')
                sessions[2]['file'].write_bytes(sessions[2]['original'])

                config_file.write_text('secret = "fixture-not-for-ui" trailing-invalid', encoding='utf-8')
                dialog.get_by_role('button', name='刷新区域', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('不是有效的 TOML')
                expect(dialog.get_by_role('button', name='扫描并预览', exact=True)).to_be_disabled()
                assert 'fixture-not-for-ui' not in dialog.inner_text()
                config_file.write_bytes(original_config)
                dialog.get_by_role('button', name='刷新区域', exact=True).click()
                expect(dialog.get_by_role('alert')).to_have_count(0)
                expect(dialog.get_by_role('button', name='扫描并预览', exact=True)).to_be_enabled()
                passed('Provider discovery failures appear without config secrets, disable writes, and recover after a successful refresh')

                with closing(sqlite3.connect(db_file)) as db:
                    db.executescript("CREATE TRIGGER test_ui_write_fault BEFORE UPDATE OF model_provider ON local_thread_catalog BEGIN SELECT RAISE(FAIL,'fixture sqlite write fault'); END;")
                scan()
                dialog.get_by_role('button', name='清空选择', exact=True).click()
                dialog.get_by_label('修复 迁移第一条', exact=True).check()
                dialog.get_by_label('我已保存工作并退出 ChatGPT 桌面版及使用此会话库的命令行客户端。', exact=True).check()
                dialog.get_by_role('button', name='备份并迁移所选 (1)', exact=True).click()
                expect(dialog.get_by_role('alert')).to_contain_text('批量修复未完成')
                expect(dialog.get_by_role('alert')).to_contain_text('已恢复本次写入')
                expect(dialog).to_be_visible()
                native, catalog = native_regions()
                for session in sessions.values():
                    assert session['file'].read_bytes() == session['original']
                    assert native[session['id']] == session['provider']
                    assert catalog[('desktop', session['id'])] == session['provider']
                passed('An actual SQLite write failure appears in the open modal and rolls back rewritten JSONL plus native/local rows')
                assert not errors, errors
                browser.close()
        finally:
            if worker.poll() is None:
                worker.stdin.close()
                try:
                    worker.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    worker.terminate()
                    worker.wait(timeout=5)
            worker.stdout.close()
            worker.stderr.close()
    print(json.dumps({'ok': True, 'checks': checks, 'browserErrors': errors, 'count': len(checks)}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
