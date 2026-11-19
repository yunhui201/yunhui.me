"""Local acceptance against built Electron/IPC/RPC and loopback-only billing fixtures."""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import hashlib, json, os, socket, subprocess, tempfile, threading, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
(ROOT/'tmp').mkdir(exist_ok=True)
PROFILE = Path(tempfile.mkdtemp(prefix='balance-electron-', dir=ROOT/'tmp'))
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
calls=[]
class Upstream(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_GET(self):
        calls.append(self.path)
        if self.path=='/catalog': data=json.loads((ROOT/'server/seed-catalog.json').read_text(encoding='utf-8'))
        elif self.path=='/v1/usage':
            assert self.headers.get('Authorization')=='Bearer isolated-query-key'
            data={'mode':'unrestricted','balance':0,'unit':'USD','isValid':True}
        elif self.path=='/custom': data={'wallet':{'balance':18.25}}
        else: self.send_error(404);return
        body=json.dumps(data).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
server=ThreadingHTTPServer(('127.0.0.1',0),Upstream)
threading.Thread(target=server.serve_forever,daemon=True).start()
data=PROFILE/'data';data.mkdir();clients=PROFILE/'clients';clients.mkdir()
gateway,debug=port(),port()
(data/'settings.json').write_text(json.dumps({'theme':'light','gatewayHost':'127.0.0.1','gatewayPort':gateway,'autoCheckUpdate':False,'closeToTray':False,'catalogUrl':f'http://127.0.0.1:{server.server_port}/catalog'}),encoding='utf-8')
environment=dict(os.environ,YUNHUI_TEST_ISOLATED='1',AURORA_HOME=str(data),YUNHUI_HOME=str(data),AURORA_CLIENT_HOME=str(clients),AURORA_UI_TEST='1',AURORA_PAGE='providers',APPDATA=str(PROFILE/'appdata'),LOCALAPPDATA=str(PROFILE/'localappdata'))
for key in ['ELECTRON_RUN_AS_NODE','AURORA_DEV','AURORA_UI_URL','AURORA_SHOT']:environment.pop(key,None)
log=(PROFILE/'electron.log').open('w',encoding='utf-8');process=None
try:
    process=subprocess.Popen([str(ROOT/'node_modules/electron/dist/electron.exe'),str(ROOT),f'--remote-debugging-port={debug}',f'--user-data-dir={PROFILE/"chromium"}'],env=environment,stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    deadline=time.monotonic()+25
    while time.monotonic()<deadline:
        assert process.poll() is None,'Isolated Electron exited'
        try:urllib.request.urlopen(f'http://127.0.0.1:{debug}/json/version',timeout=.5).close();break
        except (OSError,urllib.error.URLError):time.sleep(.2)
    else:raise AssertionError('Isolated Electron startup timeout')
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(f'http://127.0.0.1:{debug}')
        page=browser.contexts[0].pages[0];errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        page.get_by_role('heading',name='我的供应商',exact=True).wait_for(timeout=20000)
        state=page.evaluate("async()=>{const s=await window.aurora.invoke('state.get');return {dataDir:s.dataDir,count:s.providers.length}}")
        assert Path(state['dataDir'])==data and state['count']==0
        provider=page.evaluate("""async base=>window.aurora.invoke('provider.save',{name:'余额链路验证',baseUrl:base,format:'openai-chat',apiKeys:[{id:'isolated-key',label:'验证密钥',key:'isolated-query-key',enabled:true,weight:1}],models:[],enabled:true,balanceQuery:{adapter:'sub2api'}})""",f'http://127.0.0.1:{server.server_port}')
        assert provider.get('id') and not provider.get('error')
        before=hashlib.sha256((data/'providers.json').read_bytes()).hexdigest()
        page.reload();page.get_by_label('余额链路验证 余额与额度',exact=True).wait_for(timeout=15000)
        region=page.get_by_label('余额链路验证 余额与额度',exact=True)
        expect(region.locator('.balance-amount')).to_have_text('0.00');expect(region.get_by_text('USD',exact=True)).to_be_visible()
        region.get_by_role('button',name='刷新余额',exact=True).click()
        expect(region.get_by_text('缓存',exact=True)).to_be_visible()
        assert calls.count('/v1/usage')==1
        assert hashlib.sha256((data/'providers.json').read_bytes()).hexdigest()==before
        summary=page.evaluate("()=>window.aurora.invoke('usage.summary',{days:14})")
        assert summary['totals']['calls']==0 and summary['totals']['cost']==0
        token=json.loads((data/'settings.json').read_text(encoding='utf-8'))['gatewayToken']
        def rpc(action,payload={},authenticated=True):
            request=urllib.request.Request(f'http://127.0.0.1:{gateway}/api/rpc',data=json.dumps({'action':action,'payload':payload}).encode(),headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if authenticated else {})})
            return json.load(urllib.request.urlopen(request,timeout=15))
        result=rpc('provider.balance',{'providerId':provider['id']})['result']
        assert result['items'][0]['entries'][0]['remaining']==0
        assert 'isolated-query-key' not in json.dumps(result)
        assert rpc('provider.balance',{'providerId':provider['id'],'url':'https://untrusted.invalid'})['error']
        try:rpc('provider.balance',{'providerId':provider['id']},False);raise AssertionError('Missing token accepted')
        except urllib.error.HTTPError as error:assert error.code==401
        custom=page.evaluate("""async ({id,url})=>window.aurora.invoke('provider.save',{id,balanceQuery:{adapter:'custom',auth:'none',url,balancePath:'wallet.balance',currency:'CNY',scope:'account'}})""",{'id':provider['id'],'url':f'http://127.0.0.1:{server.server_port}/custom'})
        assert not custom.get('error')
        page.reload();region=page.get_by_label('余额链路验证 余额与额度',exact=True)
        expect(region.locator('.balance-amount')).to_have_text('18.25');expect(region.get_by_text('CNY',exact=True)).to_be_visible()
        assert not errors,errors
        page.screenshot(path=str(PROFILE/'balance-ui.png'))
        report={'passed':True,'checks':['isolated native preload and provider action','actual local HTTP zero balance renders as zero','manual refresh uses shared cache','queries do not modify provider or local billed usage','authenticated gateway returns normalized balance without credentials','RPC target override and missing token rejected','saved custom query invalidates former wallet and renders new currency'],'profile':str(PROFILE),'upstreamRequests':len(calls)}
        (ROOT/'tmp/balance-electron-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
        browser.close()
finally:
    if process and process.poll() is None:process.terminate();process.wait(timeout=10)
    log.close();server.shutdown();server.server_close()
