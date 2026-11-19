<?php
declare(strict_types=1);
require __DIR__ . '/lib.php';
boot_session();
$logged = is_logged_in();
$csrf = csrf_token();
$cfg = config();
?>
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= htmlspecialchars($cfg['siteName'] ?? '云汇AI 工具箱 云端目录') ?></title>
<style>
:root{
  --bg:#080a10;--panel:rgba(23,27,38,.72);--panel-solid:#141925;--stroke:rgba(255,255,255,.075);
  --stroke-2:rgba(255,255,255,.14);--text:#e8edf7;--muted:#8b96ab;--accent:#6d8cff;--accent2:#a855f7;
  --ok:#34d399;--warn:#fbbf24;--danger:#f87171;--r:14px;--shadow:0 18px 50px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{
  background:
    radial-gradient(900px 520px at 8% -10%,rgba(109,140,255,.20),transparent 60%),
    radial-gradient(760px 460px at 96% 4%,rgba(168,85,247,.15),transparent 62%),
    radial-gradient(900px 700px at 60% 110%,rgba(45,212,191,.09),transparent 60%),
    var(--bg);
  color:var(--text);
  font-family:'PingFang SC','HarmonyOS Sans SC','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',sans-serif;
  font-size:13.5px;line-height:1.6;-webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(140,155,185,.28);border-radius:8px;border:2px solid transparent;background-clip:content-box}

.login-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}
.login{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--stroke);border-radius:20px;
  padding:26px;backdrop-filter:blur(20px);box-shadow:var(--shadow)}
.logo{width:26px;height:26px;border-radius:8px;display:inline-block;vertical-align:-6px;margin-right:8px;
  background:conic-gradient(from 210deg,#6d8cff,#a855f7,#22d3ee,#6d8cff);box-shadow:0 0 18px rgba(109,140,255,.55)}
h1{font-size:19px;margin:0 0 6px}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 18px}

input,select,textarea{
  width:100%;height:36px;padding:0 12px;border-radius:10px;border:1px solid var(--stroke);
  background:rgba(10,13,20,.6);color:var(--text);font-family:inherit;font-size:13px;outline:none;transition:.15s
}
textarea{height:auto;min-height:90px;padding:10px 12px;resize:vertical;line-height:1.6;font-family:ui-monospace,Consolas,monospace;font-size:12px}
input:focus,select:focus,textarea:focus{border-color:rgba(109,140,255,.6);box-shadow:0 0 0 3px rgba(109,140,255,.15)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:10px;
  border:1px solid var(--stroke-2);background:rgba(255,255,255,.05);color:var(--text);font-size:12.5px;font-family:inherit;cursor:pointer;transition:.15s;white-space:nowrap}
.btn:hover{background:rgba(255,255,255,.1)}
.btn.primary{background:linear-gradient(135deg,#6d8cff,#8b5cf6);border-color:transparent;box-shadow:0 8px 22px rgba(109,140,255,.3)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.danger{color:#ffc2c2;border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.1)}
.btn.sm{height:27px;padding:0 9px;font-size:11.5px;border-radius:8px}
.btn:disabled{opacity:.45;cursor:not-allowed}

.shell{display:flex;min-height:100vh}
.side{width:200px;flex:none;border-right:1px solid var(--stroke);padding:18px 12px;display:flex;flex-direction:column;gap:4px}
.side .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:13.5px;padding:0 8px 16px}
.nav{padding:8px 10px;border-radius:10px;color:var(--muted);cursor:pointer;border:1px solid transparent;font-size:13px}
.nav:hover{background:rgba(255,255,255,.05);color:var(--text)}
.nav.on{background:linear-gradient(96deg,rgba(109,140,255,.22),rgba(168,85,247,.12));border-color:rgba(109,140,255,.35);color:#fff}
.main{flex:1;min-width:0;padding:20px 24px 48px;overflow:auto}
.head{display:flex;align-items:flex-end;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.head h1{font-size:20px;margin:0}
.head p{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.head .sp{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}

.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
@media(max-width:900px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.side{display:none}}
.card{background:var(--panel);border:1px solid var(--stroke);border-radius:var(--r);padding:14px 16px;backdrop-filter:blur(18px);box-shadow:var(--shadow)}
.card .k{font-size:11.5px;color:var(--muted)}
.card .v{font-size:23px;font-weight:650;letter-spacing:.4px;font-variant-numeric:tabular-nums}

.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.toolbar .grow{flex:1}
.search{max-width:260px}

.panel{background:var(--panel);border:1px solid var(--stroke);border-radius:var(--r);overflow:hidden;backdrop-filter:blur(18px);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:11px;letter-spacing:.04em;padding:10px 12px;border-bottom:1px solid var(--stroke);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--stroke);vertical-align:middle}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:rgba(255,255,255,.03)}
.chk{width:16px;height:16px;accent-color:#6d8cff}
.pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;
  background:rgba(255,255,255,.07);border:1px solid var(--stroke);color:var(--muted);white-space:nowrap}
.pill.ok{color:#9df5cf;background:rgba(52,211,153,.13);border-color:rgba(52,211,153,.3)}
.pill.off{color:#c2c9d6;background:rgba(255,255,255,.05)}
.pill.cn{color:#ffd9a3;background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.28)}
.pill.gl{color:#c3ceff;background:rgba(109,140,255,.14);border-color:rgba(109,140,255,.3)}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--muted)}
.ico{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:rgba(255,255,255,.06);border:1px solid var(--stroke);font-size:15px}

.drawer{position:fixed;top:0;right:0;bottom:0;width:min(620px,100vw);background:var(--panel-solid);border-left:1px solid var(--stroke-2);
  box-shadow:-24px 0 60px rgba(0,0,0,.5);padding:20px;overflow:auto;transform:translateX(100%);transition:transform .22s cubic-bezier(.2,.9,.3,1);z-index:40}
.drawer.open{transform:none}
.drawer h3{margin:0 0 4px;font-size:16px}
.drawer .sub{margin-bottom:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.field{margin-bottom:12px}
.field label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:5px}
.field .hint{font-size:11px;color:var(--muted);margin-top:4px}
.mrow{display:grid;grid-template-columns:1fr 92px 76px 76px 30px;gap:6px;align-items:center;margin-bottom:6px}
.mhead{display:grid;grid-template-columns:1fr 92px 76px 76px 30px;gap:6px;font-size:11px;color:var(--muted);margin-bottom:6px}
.foot{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;position:sticky;bottom:-20px;background:linear-gradient(transparent,var(--panel-solid) 30%);padding:12px 0}
.toast{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:8px;z-index:90}
.toast div{padding:10px 14px;border-radius:12px;background:var(--panel-solid);border:1px solid var(--stroke-2);box-shadow:var(--shadow);font-size:12.5px;animation:pop .18s ease}
.toast .ok{border-color:rgba(52,211,153,.4)}.toast .bad{border-color:rgba(248,113,113,.45)}
@keyframes pop{from{opacity:0;transform:translateY(6px)}}
.mask{position:fixed;inset:0;background:rgba(4,6,12,.6);backdrop-filter:blur(4px);z-index:35;display:none}
.mask.on{display:block}
.hide{display:none!important}
.empty{padding:44px;text-align:center;color:var(--muted)}
.urlbox{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
.urlbox code{background:rgba(109,140,255,.12);border:1px solid rgba(109,140,255,.28);padding:6px 10px;border-radius:8px;font-size:12px;color:#c3ceff}
.chart{display:flex;align-items:flex-end;gap:4px;height:150px;justify-content:flex-start}
.chart .b{flex:1;max-width:42px;min-width:4px;border-radius:3px 3px 2px 2px;background:linear-gradient(180deg,#6d8cff,rgba(109,140,255,.25));position:relative;transition:filter .15s}
.chart .b:hover{filter:brightness(1.3)}
.chart .b span{position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);font-size:10px;color:#c3ceff;background:#141925;border:1px solid rgba(255,255,255,.14);padding:2px 6px;border-radius:6px;white-space:nowrap;opacity:0;pointer-events:none}
.chart .b:hover span{opacity:1}
.barline{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px}
.barline .lbl{width:78px;color:var(--muted);flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.barline .track{flex:1;height:7px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden}
.barline .track i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#6d8cff,#a855f7)}
.barline .num{width:52px;text-align:right;color:var(--text);font-variant-numeric:tabular-nums}
</style>
</head>
<body>

<?php if (!$logged): ?>
<div class="login-wrap">
  <div class="login">
    <h1><span class="logo"></span>云汇AI · 云端目录</h1>
    <p class="sub">管理供应商目录，客户端从远端一键拉取。</p>
    <div class="field"><label>管理密码</label><input id="pwd" type="password" placeholder="请输入密码" autofocus></div>
    <button class="btn primary" style="width:100%;height:40px" id="loginBtn">登录</button>
  </div>
</div>
<script>
const CSRF = <?= json_encode($csrf) ?>;
async function post(a, body){
  const r = await fetch('api.php?a='+encodeURIComponent(a), {
    method:'POST', credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF':CSRF},
    body: JSON.stringify(body||{})
  });
  return r.json();
}
document.getElementById('loginBtn').onclick = async function(){
  const btn=this; btn.disabled=true; btn.textContent='登录中…';
  try{
    const j = await post('login', {password: document.getElementById('pwd').value});
    if(j.error){ alert(j.error); btn.disabled=false; btn.textContent='登录'; return; }
    location.reload();
  }catch(e){ alert('网络错误'); btn.disabled=false; btn.textContent='登录'; }
};
document.getElementById('pwd').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('loginBtn').click(); });
</script>
<?php else: ?>

<div class="shell">
  <div class="side">
    <div class="brand"><span class="logo"></span>云汇AI 云端</div>
    <div class="nav on" data-tab="catalog">供应商目录</div>
    <div class="nav" data-tab="stats">访问统计</div>
    <div class="nav" data-tab="update">版本更新</div>
    <a class="nav" href="member_admin.php">会员与赠金</a>
    <a class="nav" href="catalog_sync_admin.php">模型自动同步</a>
    <div class="nav" data-tab="settings">设置</div>
    <div style="flex:1"></div>
    <div class="nav" id="logout" style="color:#ff9b9b">退出登录</div>
  </div>

  <div class="main">
    <!-- 目录 -->
    <section id="tab-catalog">
      <div class="head">
        <div><h1>供应商目录</h1><p>客户端拉取的就是这里的内容。改完保存，客户端点「刷新」即可拿到。</p></div>
        <div class="sp">
          <button class="btn" id="btnImport">批量导入</button>
          <button class="btn" id="btnExport">导出 JSON</button>
          <button class="btn primary" id="btnNew">+ 新建供应商</button>
        </div>
      </div>

      <div class="urlbox">
        <span style="color:var(--muted);font-size:12px">客户端拉取地址</span>
        <code id="pubUrl">—</code>
        <button class="btn sm" id="btnCopy">复制</button>
      </div>

      <div class="cards" id="statCards"></div>

      <div class="toolbar">
        <input class="search" id="q" placeholder="搜索名称 / 厂商 / 模型">
        <select id="fRegionFilter" style="width:140px">
          <option value="">全部地区</option>
          <option value="cn">国内</option>
          <option value="global">海外</option>
          <option value="relay">中转</option>
          <option value="local">本地</option>
          <option value="subscription">订阅</option>
        </select>
        <div class="grow"></div>
        <span id="selInfo" style="color:var(--muted);font-size:12px"></span>
        <button class="btn sm" data-bulk="on" disabled>批量启用</button>
        <button class="btn sm" data-bulk="off" disabled>批量停用</button>
        <button class="btn sm danger" data-bulk="del" disabled>批量删除</button>
      </div>

      <div class="panel">
        <table>
          <thead><tr>
            <th style="width:34px"><input class="chk" type="checkbox" id="chkAll"></th>
            <th style="width:44px"></th>
            <th>名称</th><th>厂商</th><th>协议</th><th>模型</th><th>地区</th><th>状态</th><th style="width:120px">操作</th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div id="empty" class="empty hide">还没有供应商，点右上角「新建供应商」或「批量导入」。</div>
      </div>
    </section>

    <!-- 访问统计 -->
    <section id="tab-stats" class="hide">
      <div class="head">
        <div><h1>访问统计</h1><p>谁在拉目录、装的是哪个版本、最近一次什么时候连的。只记 IP 与 UA，不含任何 Key。</p></div>
        <div class="sp">
          <button class="btn" id="btnStatRefresh">刷新</button>
          <button class="btn danger" id="btnStatReset">清空</button>
        </div>
      </div>
      <div class="cards" id="statCards2"></div>

      <div class="grid2" style="grid-template-columns:1.4fr 1fr">
        <div class="panel" style="padding:16px">
          <div style="font-weight:600;margin-bottom:12px">最近 30 天目录拉取</div>
          <div class="chart" id="chart"></div>
          <div style="font-size:11px;color:var(--muted);margin-top:8px" id="chartHint">—</div>
        </div>
        <div class="panel" style="padding:16px">
          <div style="font-weight:600;margin-bottom:12px">客户端版本分布</div>
          <div id="verList"></div>
          <div style="font-weight:600;margin:16px 0 10px">平台</div>
          <div id="platList"></div>
        </div>
      </div>

      <div class="panel" style="margin-top:14px;overflow:hidden">
        <div style="padding:12px 14px;border-bottom:1px solid var(--stroke);display:flex;align-items:center;gap:10px">
          <b>客户端明细</b>
          <span style="color:var(--muted);font-size:12px" id="ipCount">—</span>
          <div style="flex:1"></div>
          <input class="search" id="statQ" placeholder="搜索 IP / 版本 / UA" style="max-width:240px;height:30px">
        </div>
        <table>
          <thead><tr><th style="width:150px">IP</th><th style="width:90px">版本</th><th style="width:70px">平台</th><th style="width:70px">次数</th><th style="width:150px">最后活跃</th><th>UA</th></tr></thead>
          <tbody id="clientRows"></tbody>
        </table>
        <div id="statEmpty" class="empty hide">还没有客户端来拉过目录。装一个客户端，它会自动上报。</div>
      </div>
    </section>

    <!-- 更新 -->
    <section id="tab-update" class="hide">
      <div class="head"><div><h1>版本更新</h1><p>客户端启动时会请求这里；填好版本号和下载地址即可自动更新。</p></div></div>
      <div class="panel" style="padding:18px;max-width:760px">
        <div class="grid2">
          <div class="field"><label>最新版本号</label><input id="uVersion" placeholder="填写实际发布的版本号"></div>
          <div class="field"><label>强制更新</label>
            <select id="uMandatory"><option value="0">否（可跳过）</option><option value="1">是（必须更新）</option></select>
          </div>
        </div>
        <div class="field"><label>更新说明</label><textarea id="uNotes" placeholder="本次更新内容…"></textarea></div>
        <div class="grid2">
          <div class="field"><label>Windows x64 下载地址</label><input id="uWin" placeholder="填写已上传的 Windows x64 安装包完整地址"></div>
          <div class="field"><label>macOS Apple Silicon（arm64）下载地址</label><input id="uMac" placeholder="填写已上传的 macOS arm64 安装包完整地址"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>macOS Intel（x64）下载地址</label><input id="uMacX64" placeholder="填写已上传的 macOS x64 安装包完整地址"></div>
          <div class="field"><label>Linux x64 下载地址</label><input id="uLinux" placeholder="填写已上传的 Linux x64 安装包完整地址"></div>
        </div>
        <div class="foot" style="position:static;background:none"><button class="btn primary" id="btnSaveUpdate">保存</button></div>
        <p class="sub" style="margin-top:10px">把安装包上传到 <code>/www/wwwroot/yunhui.me/releases/</code>，再用上面的地址引用即可。</p>
      </div>
    </section>

    <!-- 设置 -->
    <section id="tab-settings" class="hide">
      <div class="head"><div><h1>设置</h1><p>站点名称与管理员密码。</p></div></div>
      <div class="panel" style="padding:18px;max-width:560px">
        <div class="field"><label>站点名称</label><input id="sName"></div>
        <div class="field"><label>新密码（留空则不修改）</label><input id="sPwd" type="password" placeholder="至少 8 位"></div>
        <div class="foot" style="position:static;background:none"><button class="btn primary" id="btnSaveSettings">保存</button></div>
      </div>
      <div class="panel" style="padding:18px;max-width:560px;margin-top:14px">
        <div style="font-weight:600;margin-bottom:6px">统计</div>
        <div class="mono" id="statsBox">—</div>
        <button class="btn sm" id="btnResetStats" style="margin-top:10px">清零</button>
      </div>
    </section>
  </div>
</div>

<div class="mask" id="mask"></div>
<div class="drawer" id="drawer">
  <h3 id="dTitle">新建供应商</h3>
  <p class="sub" id="dSub">填好基础信息，模型可以后面再加。</p>
  <div class="grid2">
    <div class="field"><label>名称</label><input id="fName" placeholder="DeepSeek 官方"></div>
    <div class="field"><label>厂商</label><input id="fVendor" placeholder="深度求索"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>上游协议</label>
      <select id="fFormat">
        <option value="openai-chat">OpenAI Chat</option>
        <option value="openai-responses">OpenAI Responses</option>
        <option value="anthropic">Anthropic</option>
        <option value="gemini">Gemini</option>
      </select>
    </div>
    <div class="field"><label>地区</label>
      <select id="fRegion">
        <option value="cn">国内</option><option value="global">海外</option>
        <option value="relay">中转</option><option value="local">本地</option><option value="subscription">订阅</option>
      </select>
    </div>
  </div>
  <div class="field"><label>Base URL</label><input id="fBase" class="mono" placeholder="https://api.deepseek.com"></div>
  <div class="grid2">
    <div class="field"><label>图标（emoji）</label><input id="fIcon" placeholder="🐳"></div>
    <div class="field"><label>品牌色</label><input id="fColor" placeholder="#4d6bfe"></div>
  </div>
  <div class="grid2">
    <div class="field"><label>标签（逗号分隔）</label><input id="fTags" placeholder="国内,便宜,工具调用"></div>
    <div class="field"><label>排序（小的在前）</label><input id="fSort" type="number" value="100"></div>
  </div>
  <div class="field"><label>官网 / 拿 Key 的地址</label><input id="fDocs" class="mono" placeholder="https://platform.deepseek.com"></div>
  <div class="field"><label>说明</label><input id="fNote" placeholder="填写已核实的服务说明，可留空"></div>

  <div class="field">
    <label>模型列表</label>
    <div class="mhead"><span>模型 ID</span><span>上下文</span><span>输入价</span><span>输出价</span><span></span></div>
    <div id="models"></div>
    <button class="btn sm" id="btnAddModel" style="margin-top:6px">+ 添加模型</button>
    <div class="hint">价格单位：美元 / 百万 token。上下文填 128000 这种数字。</div>
  </div>

  <div class="foot">
    <button class="btn" id="btnCancel">取消</button>
    <button class="btn primary" id="btnSave">保存</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const CSRF = <?= json_encode($csrf) ?>;
let state = { catalog: {providers: []}, update: {}, stats: {}, publicUrl: '' };
let selected = new Set();
let editing = null;

function toast(msg, kind){
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = kind || '';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(()=>el.remove(), 3200);
}
async function api(action, body, method){
  const r = await fetch('api.php?a='+encodeURIComponent(action), {
    method: method || 'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF':CSRF},
    body: method === 'GET' ? undefined : JSON.stringify(body||{})
  });
  const j = await r.json();
  if (j.needLogin) { location.reload(); throw new Error('需要登录'); }
  if (j.error) toast(j.error, 'bad');
  return j;
}

/* ---------- 渲染 ---------- */
function render(){
  const ps = state.catalog.providers || [];
  const enabled = ps.filter(p=>p.enabled).length;
  const models = ps.reduce((a,p)=>a+(p.models||[]).length,0);
  document.getElementById('statCards').innerHTML = `
    <div class="card"><div class="k">供应商</div><div class="v">${ps.length}</div></div>
    <div class="card"><div class="k">已启用</div><div class="v">${enabled}</div></div>
    <div class="card"><div class="k">模型条目</div><div class="v">${models}</div></div>
    <div class="card"><div class="k">目录版本</div><div class="v">v${state.catalog.version||0}</div></div>`;
  document.getElementById('pubUrl').textContent = state.publicUrl + '/pub.php?action=catalog';
  document.getElementById('statsBox').textContent =
    '目录版本 v' + (state.catalog.version||0) + ' · 更新于 ' + (state.catalog.updatedAt||'-') +
    '\n客户端上报次数：' + ((state.stats && state.stats.pings) || 0);

  const q = (document.getElementById('q').value||'').toLowerCase();
  const reg = document.getElementById('fRegionFilter').value;
  const list = ps.filter(p=>{
    if(reg && p.region !== reg) return false;
    if(!q) return true;
    return (p.name||'').toLowerCase().includes(q) || (p.vendor||'').toLowerCase().includes(q)
      || (p.models||[]).some(m=>(m.id||'').toLowerCase().includes(q));
  });
  const rows = document.getElementById('rows');
  rows.innerHTML = list.map(p=>{
    const regionMap={cn:'国内',global:'海外',relay:'中转',local:'本地',subscription:'订阅'};
    return `<tr data-key="${p.key}">
      <td><input class="chk" type="checkbox" data-sel="${p.key}" ${selected.has(p.key)?'checked':''}></td>
      <td><div class="ico" style="color:${p.color||'#6d8cff'}">${p.icon||'◆'}</div></td>
      <td><div style="font-weight:600">${esc(p.name)}</div><div class="mono">${esc(p.baseUrl||'')}</div></td>
      <td>${esc(p.vendor||'')}</td>
      <td><span class="pill">${fmtProto(p.format)}</span></td>
      <td>${(p.models||[]).length}</td>
      <td><span class="pill ${p.region==='cn'?'cn':'gl'}">${regionMap[p.region]||p.region||'-'}</span></td>
      <td><span class="pill ${p.enabled?'ok':'off'}">${p.enabled?'启用':'停用'}</span></td>
      <td>
        <button class="btn sm" data-act="edit" data-key="${p.key}">编辑</button>
        <button class="btn sm" data-act="toggle" data-key="${p.key}">${p.enabled?'停用':'启用'}</button>
        <button class="btn sm danger" data-act="del" data-key="${p.key}">删</button>
      </td></tr>`;
  }).join('');
  document.getElementById('empty').classList.toggle('hide', list.length>0);
  document.getElementById('selInfo').textContent = selected.size ? `已选 ${selected.size} 项` : '';
  document.querySelectorAll('[data-bulk]').forEach(b=>b.disabled = selected.size===0);
  document.getElementById('chkAll').checked = list.length>0 && list.every(p=>selected.has(p.key));
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtProto(f){ return {'openai-chat':'Chat','openai-responses':'Responses','anthropic':'Anthropic','gemini':'Gemini'}[f]||f; }

/* ---------- 事件 ---------- */
document.getElementById('q').addEventListener('input', render);
document.getElementById('fRegionFilter').addEventListener('change', render);
document.getElementById('chkAll').addEventListener('change', function(){
  document.querySelectorAll('[data-sel]').forEach(c=>{
    if(this.checked) selected.add(c.dataset.sel); else selected.delete(c.dataset.sel);
  });
  render();
});
document.getElementById('rows').addEventListener('click', async function(e){
  const chk = e.target.closest('[data-sel]');
  if(chk){ chk.checked ? selected.add(chk.dataset.sel) : selected.delete(chk.dataset.sel); render(); return; }
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const key = btn.dataset.key;
  const p = (state.catalog.providers||[]).find(x=>x.key===key);
  if(btn.dataset.act==='edit') return openEdit(p);
  if(btn.dataset.act==='toggle'){
    const j = await api('provider.toggle', {keys:[key], enabled: !p.enabled});
    if(j.ok){ await reload(); toast(p.enabled?'已停用':'已启用','ok'); }
    return;
  }
  if(btn.dataset.act==='del'){
    if(!confirm('删除「'+(p.name||'')+'」？')) return;
    const j = await api('provider.delete', {keys:[key]});
    if(j.ok){ await reload(); toast('已删除','ok'); }
  }
});
document.querySelectorAll('[data-bulk]').forEach(b=>{
  b.onclick = async ()=>{
    const keys = [...selected];
    if(!keys.length) return;
    const act = b.dataset.bulk;
    if(act==='del'){
      if(!confirm(`删除选中的 ${keys.length} 个供应商？`)) return;
      const j = await api('provider.delete', {keys});
      if(j.ok){ selected.clear(); await reload(); toast(`已删除 ${j.deleted} 个`,'ok'); }
    } else {
      const j = await api('provider.toggle', {keys, enabled: act==='on'});
      if(j.ok){ await reload(); toast('已更新','ok'); }
    }
  };
});
document.getElementById('btnCopy').onclick = ()=>{
  navigator.clipboard.writeText(document.getElementById('pubUrl').textContent);
  toast('已复制','ok');
};
document.getElementById('btnExport').onclick = ()=>{
  const blob = new Blob([JSON.stringify(state.catalog, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'yunhui-catalog-' + Date.now() + '.json';
  a.click();
};
document.getElementById('btnImport').onclick = async ()=>{
  const txt = prompt('粘贴 JSON（可以是 {"providers":[...]} 或直接数组）');
  if(!txt) return;
  let data;
  try { data = JSON.parse(txt); } catch(e) { return alert('JSON 格式不对'); }
  const list = Array.isArray(data) ? data : (data.providers || []);
  const j = await api('provider.bulkAdd', {providers: list});
  if(j.ok){ await reload(); toast(`新增 ${j.added}，更新 ${j.updated}`,'ok'); }
};

/* ---------- 编辑器 ---------- */
function openEdit(p){
  editing = p ? JSON.parse(JSON.stringify(p)) : {
    name:'', vendor:'', format:'openai-chat', baseUrl:'', region:'relay', color:'#6d8cff',
    icon:'◆', docs:'', note:'', tags:[], sort:100, enabled:true, models:[]
  };
  document.getElementById('dTitle').textContent = p ? '编辑供应商' : '新建供应商';
  document.getElementById('dSub').textContent = p ? ('key: ' + p.key) : '填好基础信息，模型可以后面再加。';
  fName.value = editing.name||''; fVendor.value = editing.vendor||'';
  fFormat.value = editing.format||'openai-chat'; fRegion.value = editing.region||'relay';
  fBase.value = editing.baseUrl||''; fIcon.value = editing.icon||''; fColor.value = editing.color||'';
  fTags.value = (editing.tags||[]).join(','); fSort.value = editing.sort||100;
  fDocs.value = editing.docs||''; fNote.value = editing.note||'';
  renderModels();
  document.getElementById('drawer').classList.add('open');
  document.getElementById('mask').classList.add('on');
}
function closeEdit(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('mask').classList.remove('on');
  editing = null;
}
function renderModels(){
  const box = document.getElementById('models');
  box.innerHTML = (editing.models||[]).map((m,i)=>`
    <div class="mrow">
      <input value="${esc(m.id)}" data-m="${i}" data-k="id" placeholder="填写供应商实际模型 ID">
      <input value="${m.contextWindow||''}" data-m="${i}" data-k="contextWindow" type="number" placeholder="待确认">
      <input value="${m.inputPrice??''}" data-m="${i}" data-k="inputPrice" type="number" step="0.01" placeholder="待确认">
      <input value="${m.outputPrice??''}" data-m="${i}" data-k="outputPrice" type="number" step="0.01" placeholder="待确认">
      <button class="btn sm danger" data-del="${i}">×</button>
    </div>`).join('');
  box.querySelectorAll('[data-m]').forEach(inp=>{
    inp.oninput = ()=>{
      const i = +inp.dataset.m, k = inp.dataset.k;
      const v = inp.value;
      if(k==='id') editing.models[i][k]=v; else if(v==='') delete editing.models[i][k]; else editing.models[i][k]=Number(v);
    };
  });
  box.querySelectorAll('[data-del]').forEach(b=>{
    b.onclick = ()=>{ editing.models.splice(+b.dataset.del,1); renderModels(); };
  });
}
document.getElementById('btnAddModel').onclick = ()=>{
  editing.models = editing.models || [];
  editing.models.push({id:'',capabilities:{}});
  renderModels();
};
document.getElementById('btnCancel').onclick = closeEdit;
document.getElementById('mask').onclick = closeEdit;
document.getElementById('btnSave').onclick = async ()=>{
  if(!fName.value.trim()) return alert('名称必填');
  const body = {
    ...editing,
    name:fName.value.trim(), vendor:fVendor.value.trim(), format:fFormat.value, region:fRegion.value,
    baseUrl:fBase.value.trim(), icon:fIcon.value.trim()||'◆', color:fColor.value.trim()||'#6d8cff',
    tags:fTags.value.split(',').map(s=>s.trim()).filter(Boolean), sort:Number(fSort.value||100),
    docs:fDocs.value.trim(), note:fNote.value.trim()
  };
  const j = await api('provider.save', body);
  if(j.ok){ closeEdit(); await reload(); toast('已保存','ok'); } else toast(j.error||'保存失败','bad');
};
document.getElementById('btnNew').onclick = ()=> openEdit(null);

/* ---------- 更新 & 设置 ---------- */
document.getElementById('btnSaveUpdate').onclick = async ()=>{
  const files = { ...(state.update.files || {}) };
  for (const [platform, input] of [['win-x64', uWin], ['mac-arm64', uMac], ['mac-x64', uMacX64], ['linux-x64', uLinux]]) {
    const url = input.value.trim();
    if (url) files[platform] = url; else delete files[platform];
  }
  const j = await api('update.save', {
    version:uVersion.value.trim(), notes:uNotes.value.trim(),
    mandatory: uMandatory.value === '1', files
  });
  if(j.ok){ state.update = j.update; toast('已保存','ok'); } else toast(j.error||'失败','bad');
};
document.getElementById('btnSaveSettings').onclick = async ()=>{
  const j = await api('settings.save', {siteName:sName.value.trim(), password:sPwd.value});
  if(j.ok){ toast('已保存','ok'); sPwd.value=''; } else toast(j.error||'失败','bad');
};
document.getElementById('btnResetStats').onclick = async ()=>{
  if(!confirm('清零统计？')) return;
  await api('stats.reset', {});
  await reload(); toast('已清零','ok');
};
document.getElementById('logout').onclick = async ()=>{ await api('logout', {}); location.reload(); };

document.querySelectorAll('.nav[data-tab]').forEach(n=>{
  n.onclick = ()=>{
    document.querySelectorAll('.nav[data-tab]').forEach(x=>x.classList.remove('on'));
    n.classList.add('on');
    ['catalog','stats','update','settings'].forEach(t=>{
      document.getElementById('tab-'+t).classList.toggle('hide', t !== n.dataset.tab);
    });
  };
});

/* ---------- 加载 ---------- */
async function reload(){
  const j = await api('catalog.get', {}, 'GET');
  if(!j.ok) { toast(j.error||'加载失败','bad'); return; }
  state = j;
  render();
  const u = j.update || {};
  uVersion.value = u.version || '';
  uNotes.value = u.notes || '';
  uMandatory.value = u.mandatory ? '1' : '0';
  uWin.value = (u.files||{})['win-x64'] || '';
  uMac.value = (u.files||{})['mac-arm64'] || '';
  uMacX64.value = (u.files||{})['mac-x64'] || '';
  uLinux.value = (u.files||{})['linux-x64'] || '';
  sName.value = j.siteName || '';
}

/* ---------- 访问统计 ---------- */
let statData = null;

async function loadStats(){
  const j = await api('analytics.get', {}, 'GET');
  if(!j.ok){ toast(j.error||'统计加载失败','bad'); return; }
  statData = j.analytics;
  renderStats();
}

function renderStats(){
  if(!statData) return;
  const a = statData;
  const t = a.totals || {};
  document.getElementById('statCards2').innerHTML = `
    <div class="card"><div class="k">今日拉取目录</div><div class="v">${a.today.catalog}</div></div>
    <div class="card"><div class="k">今日更新检查</div><div class="v">${a.today.update}</div></div>
    <div class="card"><div class="k">今日独立 IP</div><div class="v">${a.today.ips}</div></div>
    <div class="card"><div class="k">累计拉取</div><div class="v">${t.catalog||0}</div></div>`;

  const series = a.series || [];
  const max = Math.max(1, ...series.map(s=>s.catalog));
  document.getElementById('chart').innerHTML = series.map(s=>`
    <div class="b" style="height:${Math.max(3, (s.catalog/max)*100)}%">
      <span>${s.day.slice(5)} · ${s.catalog} 次 · ${s.ips} IP</span>
    </div>`).join('');
  document.getElementById('chartHint').textContent = series.length
    ? `共 ${series.length} 天 · 峰值 ${max} 次/天 · 保留 ${a.retentionDays} 天`
    : '暂无数据';

  const vers = Object.entries(a.versions || {});
  const vmax = Math.max(1, ...vers.map(v=>v[1]));
  document.getElementById('verList').innerHTML = vers.length
    ? vers.map(([v,n])=>`<div class="barline"><span class="lbl">${esc(v)}</span><span class="track"><i style="width:${(n/vmax)*100}%"></i></span><span class="num">${n}</span></div>`).join('')
    : '<div class="mono">暂无数据</div>';

  const plats = Object.entries(a.platforms || {});
  const pmax = Math.max(1, ...plats.map(p=>p[1]));
  document.getElementById('platList').innerHTML = plats.length
    ? plats.map(([p,n])=>`<div class="barline"><span class="lbl">${esc(p)}</span><span class="track"><i style="width:${(n/pmax)*100}%"></i></span><span class="num">${n}</span></div>`).join('')
    : '<div class="mono">暂无数据</div>';

  renderClients();
}

function renderClients(){
  if(!statData) return;
  const q = (document.getElementById('statQ').value||'').toLowerCase();
  const list = (statData.clients||[]).filter(c=>{
    if(!q) return true;
    return (c.ip+' '+c.version+' '+c.ua).toLowerCase().includes(q);
  });
  document.getElementById('ipCount').textContent = `${statData.ipTotal} 个客户端 · 显示 ${list.length}`;
  document.getElementById('clientRows').innerHTML = list.slice(0,300).map(c=>`
    <tr>
      <td class="mono">${esc(c.ip)}</td>
      <td>${c.version? `<span class="pill gl">${esc(c.version)}</span>` : '<span class="mono">—</span>'}</td>
      <td>${c.platform? `<span class="pill">${esc(c.platform)}</span>` : '<span class="mono">—</span>'}</td>
      <td>${c.count}</td>
      <td class="mono">${fmtTime(c.last)}</td>
      <td class="mono ellipsis" title="${esc(c.ua)}">${esc(c.ua)}</td>
    </tr>`).join('');
  document.getElementById('statEmpty').classList.toggle('hide', list.length>0);
}

function fmtTime(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

document.getElementById('btnStatRefresh').onclick = loadStats;
document.getElementById('statQ').addEventListener('input', renderClients);
document.getElementById('btnStatReset').onclick = async ()=>{
  if(!confirm('清空全部访问统计？')) return;
  await api('analytics.reset', {});
  await loadStats();
  toast('已清空','ok');
};
document.querySelector('[data-tab="stats"]').addEventListener('click', loadStats);
reload();
</script>
<?php endif; ?>
<footer style="text-align:center;padding:20px;color:#7b8595;font-size:12px"><a href="https://github.com/yunhui201/yunhui.me/tree/main" target="_blank" rel="noopener noreferrer">yunhui.me · 项目源码</a> · <a href="https://github.com/yunhui201/yunhui.me/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPL-3.0 许可</a></footer>
</body>
</html>







