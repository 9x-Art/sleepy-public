/* ============================================================
   repo-worker.js — 设定仓库 Worker（v2，2026-10-11 御膳房）

   绑定：env.DB = D1（索引/门牌），env.STORE = R2（包体）。
   红线：这里只碰「账目」—— 件的正文明文只存在 R2 的用户内容区，
   Worker 不解析不改动；user 的游玩数据永不经此。

   端点：
     POST /publish             发布（X-Repo-Token = 作者令牌，首次生成并返回）
     GET  /shelf?gate=         货架列表（需有效门牌）
     GET  /public-shelf        公共铺面（免门牌：visible=1 的件；type/q/sort）
     GET  /item/:id?gate=      下载包体（计数 +1；visible=1 免门牌）
     GET  /item/:id/meta       作品详情元数据（包外信息，不含包体内容）
     POST /gate                校验门牌 {code} → {name}
     DELETE /item/:id          下架（作者令牌）
     GET  /search?gate=&q=     标题/作者关键词

   v2 新列：summary（作者的话）、access（open|sealed|gated）、
   condition（none|repo|like|comment）、visible（1=上公共铺面）、updated_at。
   老库自动补列（ALTER 幂等，报重复列就吞掉）。

   部署：wrangler deploy（不走 GitHub HTTPS）。配置见 wrangler.toml。
   ============================================================ */
let schemaReady = null;
async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const cols = [
        'ALTER TABLE items ADD COLUMN summary TEXT',
        'ALTER TABLE items ADD COLUMN access TEXT',
        'ALTER TABLE items ADD COLUMN condition TEXT',
        'ALTER TABLE items ADD COLUMN visible INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE items ADD COLUMN updated_at INTEGER',
        'ALTER TABLE items ADD COLUMN likes INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE items ADD COLUMN cover TEXT',
      ];
      for (const sql of cols) {
        try { await env.DB.prepare(sql).run(); } catch (e) { /* 列已存在 */ }
      }
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS comments (' +
        'id TEXT PRIMARY KEY, item_id TEXT NOT NULL, device TEXT, ' +
        'name TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT \'comment\', ' +
        'created_at INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 1)').run();
      await env.DB.prepare(
        'CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id, status)').run();
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS condition_met (' +
        'item_id TEXT NOT NULL, device TEXT NOT NULL, kind TEXT NOT NULL, ' +
        'created_at INTEGER NOT NULL, PRIMARY KEY(item_id, device))').run();

      /* ---- 账密系统（方案-账密系统-v2，2026-10-21，对齐发售路线 三/十节）----
         激活码即账号：codes 发码页记账（一个 QQ 只能领一次，qq 唯一索引）；
         users 只存 PBKDF2 哈希永不存明文；devices UNIQUE(user_id, install_id)
         = 「同设备重复登录不新增名额」；sessions 按 device 挂，踢设备即作废。 */
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS codes (' +
        'code TEXT PRIMARY KEY, qq TEXT NOT NULL, issued_at INTEGER NOT NULL, ' +
        'used_by TEXT, status INTEGER NOT NULL DEFAULT 1)').run();
      await env.DB.prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_codes_qq ON codes(qq)').run();
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS users (' +
        'id TEXT PRIMARY KEY, qq TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, ' +
        'created_at INTEGER NOT NULL, status INTEGER NOT NULL DEFAULT 1)').run();
      await env.DB.prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_qq ON users(qq)').run();
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS devices (' +
        'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, install_id TEXT NOT NULL, ua TEXT, ' +
        'created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ' +
        'status INTEGER NOT NULL DEFAULT 1)').run();
      await env.DB.prepare(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_pair ON devices(user_id, install_id)').run();
      await env.DB.prepare(
        'CREATE TABLE IF NOT EXISTS sessions (' +
        'token TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT, ' +
        'created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ' +
        'status INTEGER NOT NULL DEFAULT 1)').run();
    })();
  }
  return schemaReady;
}

/* ---- 账密工具（全部 WebCrypto 原生，零依赖）----
   PBKDF2-SHA256 10 万迭代：发售路线写的是 argon2/bcrypt，Workers 没有
   原生实现；PBKDF2 是同级的可审计替代，配 KV 限速补位（方案卡已注明）。 */
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(s) {
  return new Uint8Array(String(s || '').match(/../g).map((h) => parseInt(h, 16)));
}
function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}
async function passHash(pass, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}
const QQ_RE = /^\d{5,12}$/;

/* KV 防爆破计数：key 命中超过 max 即拒（TTL 内自愈）。
   KV 最终一致 —— 极限并发下可能少记一两次，对撞库是减速带不是闸门，
   闸门是「5 次锁」这个量级本身。 */
async function rateHit(env, key, max) {
  try {
    const raw = await env.STORE.get(key);
    const prev = Number(typeof raw === 'string' ? raw : ((raw && raw.body != null) ? raw.body : 0)) || 0;
    await env.STORE.put(key, String(prev + 1), { expirationTtl: 900 });
    return prev + 1 <= max;
  } catch (e) { return true; }   /* KV 出问题不拦正常人 */
}
function ipOf(request) {
  /* 反代透传（2026-10-31 维稳）：Pages 同源反代的子请求里，CF 会把
     CF-Connecting-IP 重写成 CF 内部出口（实测 2a06:98c0:3600::103）——
     不透传的话全体用户挤同一个限流桶，几个人一起进门就互撞 429。
     反代把真实客户端 IP 放在 X-Forwarded-Client-IP；
     **只在直连方本身是 CF 内部出口时才认这个头** —— 外部直连
     workers.dev 的人伪造不了（他们的 CF-Connecting-IP 是真实公网 IP）。 */
  const direct = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 40);
  if (direct.indexOf('2a06:98c0:') === 0) {
    const fwd = (request.headers.get('X-Forwarded-Client-IP') || '').trim();
    if (fwd) return fwd.slice(0, 40);
  }
  return direct;
}

/* ---- 机房 ASN 闸（2026-10-31）：把烧请求配额的机器人挡在门外 ----
   正常用户全走 Pages 同源反代；直连 workers.dev 打敏感口的实测只剩
   机房 IP 在扫 /issue/claim 与 /account/*（KV 限流桶里看到一堆托管段
   IP，Worker 配额一天烧掉 50%）。反代子请求的 CF-Connecting-IP 是 CF
   内部出口（ipOf 已识别），所以规则很简单：**非反代 + 机房 ASN =
   机器人 → 403 快速挡回**，不查库不写 KV，把请求配额还给真人。
   代价：挂商用 VPN 走 workers.dev 兜底的直连用户会被误挡 —— 他们本
   来就该走 pages.dev（主位 base），可接受。
   request.cf 缺位（本地 dev / 非直连环境）一律放行 —— fail open，
   闸门只挡「确认是机房」的，不拦存疑的。 */
const DC_ASN = {
  16509: 1, 14618: 1, 396982: 1,   /* AWS */
  15169: 1,                        /* Google */
  8075: 1,                         /* Microsoft/Azure */
  14061: 1,                        /* DigitalOcean */
  16276: 1,                        /* OVH */
  24940: 1,                        /* Hetzner */
  9009: 1,                         /* M247（商用 VPN 常用出口） */
  20473: 1,                        /* Vultr/Choopa */
  63949: 1,                        /* Linode/Akamai */
  51167: 1,                        /* Contabo */
  60781: 1,                        /* Leaseweb */
  62240: 1,                        /* Clouvider */
  53667: 1, 204601: 1,             /* 云国际段常见扫源 */
};
function botGate(request) {
  const direct = request.headers.get('CF-Connecting-IP') || '';
  if (direct.indexOf('2a06:98c0:') === 0) return false;   /* 反代来的真人，放行 */
  const cf = request.cf;
  if (!cf || cf.asn === undefined || cf.asn === null) return false;  /* 缺位不拦 */
  return !!DC_ASN[cf.asn];
}

/* ---- 管理钥匙（2026-10-31）：/admin/* 一律 X-Admin-Key = env.ADMIN_KEY ----
   secret 部署后执行一次：wrangler secret put ADMIN_KEY。
   没配 = 管理口全关（fail closed）。管理页从 pages.dev/admin（走反代）
   进，VPN/iOA 出口就算是机房段也不影响 —— admin 不挂 ASN 闸。 */
function adminOk(request, env) {
  const k = request.headers.get('X-Admin-Key') || '';
  return !!env.ADMIN_KEY && k === env.ADMIN_KEY;
}

/* 会话鉴权：token 走 X-Repo-Token 同一个头（CORS 白名单不用加列）。
   空闲过期（2026-10-22 收口）：last_seen 超 30 天的会话一律视为失效 ——
   以前 token 永不过期，泄露一枚就等于永久账号；现在空闲即死，
   活跃用户无感（每次 /me 都会刷 last_seen）。 */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
async function sessionOf(request, env) {
  const token = request.headers.get('X-Repo-Token') || '';
  if (!token) return null;
  return await env.DB.prepare(
    'SELECT s.token, s.device_id, u.id AS uid, u.qq FROM sessions s ' +
    'JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token = ? AND s.status = 1 AND u.status = 1 AND s.last_seen > ?')
    .bind(token, Date.now() - SESSION_IDLE_MS).first();
}

const ITEM_COLS = 'id,type,title,author,cover,lock,access,condition,summary,visible,version,size,downloads,created_at,updated_at';

/* 发码页（发售路线 §十：与 App 内激活分两处；QQ 号属个人信息，告知写在此处）。
   一屏一件事：填 QQ → 当场出码（只显示一次）→ 去 App 里激活设密码。 */
const ISSUE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sleepy · 领取激活码</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#FAF6EF;color:#2B2B2B;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;}
  .card{width:min(360px,calc(100vw - 40px));background:#fff;border:1px solid #E8E0D2;
    border-radius:14px;padding:28px 24px;box-sizing:border-box;}
  h1{font-size:18px;margin:0 0 6px;}
  .sub{font-size:12.5px;color:#8B8578;line-height:1.6;margin:0 0 18px;}
  label{display:block;font-size:12.5px;color:#8B8578;margin-bottom:6px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;
    border:1px solid #D8D0C0;border-radius:9px;outline:none;background:#fff;color:#2B2B2B;}
  input:focus{border-color:#B08A5E;}
  button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:9px;
    background:#B08A5E;color:#fff;font-size:14.5px;cursor:pointer;}
  button:disabled{opacity:.5;}
  .code{display:none;margin-top:18px;padding:14px;border:1px dashed #B08A5E;border-radius:10px;
    text-align:center;font-size:20px;letter-spacing:2px;font-weight:600;color:#8A6A42;}
  .note{font-size:12px;color:#A39B8B;line-height:1.6;margin-top:14px;}
  .err{font-size:12.5px;color:#B4544A;margin-top:10px;display:none;}
</style>
</head>
<body>
<div class="card">
  <h1>领取激活码</h1>
  <p class="sub">在这里登记 QQ 号，当场生成激活码；然后打开 Sleepy，用激活码 + 这个 QQ 号完成激活并设置密码。</p>
  <label for="qq">QQ 号（5–12 位数字）</label>
  <input id="qq" inputmode="numeric" maxlength="12" placeholder="例如 123456789">
  <label for="key" style="margin-top:12px;">领取口令</label>
  <input id="key" placeholder="随群内说明一起给你的口令">
  <button id="go">领取激活码</button>
  <div class="err" id="err"></div>
  <div class="code" id="code"></div>
  <p class="note">说明：一个 QQ 号只能领一次。QQ 号仅用于登录账号识别，见 App 内「隐私政策」；需要删除时可在 App「我的授权」里注销。激活码只显示这一次，请当场复制保存。</p>
</div>
<script>
  var go = document.getElementById('go');
  go.addEventListener('click', function () {
    var qq = document.getElementById('qq').value.trim();
    var key = document.getElementById('key').value.trim();
    var err = document.getElementById('err');
    err.style.display = 'none';
    go.disabled = true; go.textContent = '生成中…';
    fetch('/issue/claim', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qq: qq, key: key }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          var el = document.getElementById('code');
          el.textContent = res.code; el.style.display = 'block';
          go.textContent = '已生成 · 记好上面的码';
        } else {
          err.textContent = res.message || '没领成，再试一次';
          err.style.display = 'block';
          go.disabled = false; go.textContent = '领取激活码';
        }
      })
      .catch(function () {
        err.textContent = '网络没通，再试一次'; err.style.display = 'block';
        go.disabled = false; go.textContent = '领取激活码';
      });
  });
</script>
</body>
</html>`;

/* 管理页（2026-10-31）：从 pages.dev/admin 进，X-Admin-Key 鉴权。
   三件事：看真实注册数据 / 帮人注册 / 帮人重置密码。钥匙存 localStorage，
   页面本身不含任何敏感信息（没钥匙啥也干不了，fail closed）。 */
const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sleepy · 管理台</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;
    background:#FAF6EF;color:#2B2B2B;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;padding:32px 0;box-sizing:border-box;}
  .card{width:min(420px,calc(100vw - 40px));background:#fff;border:1px solid #E8E0D2;
    border-radius:14px;padding:28px 24px;box-sizing:border-box;margin-bottom:16px;}
  h1{font-size:18px;margin:0 0 6px;}
  h2{font-size:15px;margin:22px 0 10px;}
  .sub{font-size:12.5px;color:#8B8578;line-height:1.6;margin:0 0 18px;}
  label{display:block;font-size:12.5px;color:#8B8578;margin:12px 0 6px;}
  input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;
    border:1px solid #D8D0C0;border-radius:9px;outline:none;background:#fff;color:#2B2B2B;}
  input:focus{border-color:#B08A5E;}
  button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:9px;
    background:#B08A5E;color:#fff;font-size:14.5px;cursor:pointer;}
  button:disabled{opacity:.5;}
  .out{font-size:12.5px;line-height:1.7;margin-top:12px;color:#2B2B2B;
    white-space:pre-wrap;word-break:break-all;display:none;
    background:#FAF6EF;border-radius:9px;padding:12px;}
  .err{color:#B4544A;}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}
  td,th{padding:4px 6px;border-bottom:1px solid #EFE9DC;text-align:left;}
  th{color:#8B8578;font-weight:500;}
</style>
</head>
<body>
<div style="width:100%;display:flex;flex-direction:column;align-items:center;">
<div class="card">
  <h1>Sleepy · 管理台</h1>
  <p class="sub">管理钥匙只在部署时由你自己设置（wrangler secret put ADMIN_KEY），页面不保存到服务器。</p>
  <label for="key">管理钥匙</label>
  <input id="key" type="password" placeholder="ADMIN_KEY">
  <button id="stats">查看真实注册数据</button>
  <div class="out" id="outStats"></div>
</div>
<div class="card">
  <h2>帮人注册</h2>
  <p class="sub">不走发码页，直接建号（激活码账目不动）。</p>
  <label for="regQq">QQ 号（5–12 位数字）</label>
  <input id="regQq" inputmode="numeric" maxlength="12">
  <label for="regPass">初始密码（≥6 位）</label>
  <input id="regPass" type="password">
  <button id="reg">建号</button>
  <div class="out" id="outReg"></div>
</div>
<div class="card">
  <h2>帮人重置密码</h2>
  <p class="sub">重置后该账号所有设备全部登出，要用新密码重新登录。</p>
  <label for="rstQq">QQ 号</label>
  <input id="rstQq" inputmode="numeric" maxlength="12">
  <label for="rstPass">新密码（≥6 位）</label>
  <input id="rstPass" type="password">
  <button id="rst">重置</button>
  <div class="out" id="outRst"></div>
</div>
</div>
<script>
  var keyEl = document.getElementById('key');
  keyEl.value = localStorage.getItem('sleepy.adminKey') || '';
  function key() { var k = keyEl.value.trim(); localStorage.setItem('sleepy.adminKey', k); return k; }
  function show(id, ok, text) {
    var el = document.getElementById(id);
    el.textContent = text; el.style.display = 'block';
    el.className = 'out' + (ok ? '' : ' err');
  }
  function post(path, body, outId, doneMsg) {
    var btns = document.querySelectorAll('button');
    btns.forEach(function (b) { b.disabled = true; });
    fetch(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key() },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btns.forEach(function (b) { b.disabled = false; });
        if (!res.ok) { show(outId, false, res.message || '失败了'); return; }
        show(outId, true, typeof doneMsg === 'function' ? doneMsg(res) : doneMsg);
      })
      .catch(function (e) { btns.forEach(function (b) { b.disabled = false; }); show(outId, false, '网络没通：' + e); });
  }
  document.getElementById('stats').addEventListener('click', function () {
    post('/admin/stats', {}, 'outStats', function (res) {
      var lines = '活跃用户 ' + res.users + '（累计 ' + res.usersAll + '，注销 ' + (res.usersAll - res.users) + '）'
        + '\\n活跃设备 ' + res.devices + ' · 活跃会话 ' + res.sessions
        + '\\n发码 ' + res.codes + ' / 已用 ' + res.codesUsed;
      var rows = (res.recent || []).map(function (u, i) {
        var d = new Date(u.created_at);
        return (i + 1) + '. ' + u.qq + ' · ' + d.toLocaleString();
      }).join('\\n');
      return rows ? lines + '\\n\\n最近注册：\\n' + rows : lines;
    });
  });
  document.getElementById('reg').addEventListener('click', function () {
    post('/admin/register', { qq: document.getElementById('regQq').value.trim(), pass: document.getElementById('regPass').value },
      'outReg', '建号成功，把 QQ 号和密码发给对方，让对方直接登录');
  });
  document.getElementById('rst').addEventListener('click', function () {
    post('/admin/reset', { qq: document.getElementById('rstQq').value.trim(), newPass: document.getElementById('rstPass').value },
      'outRst', '重置成功，告诉对方用新密码登录（所有设备已登出）');
  });
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Repo-Token,X-Admin-Key',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const j = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS },
    });

    try {
      /* ---- POST /gate 校验门牌 ---- */
      if (p === '/gate' && request.method === 'POST') {
        const { code } = await request.json();
        const row = await env.DB.prepare(
          'SELECT name FROM gates WHERE code = ?').bind(String(code || '')).first();
        if (!row) return j({ ok: false, message: '门牌不对，或者这个货架还没开张' }, 404);
        return j({ ok: true, name: row.name });
      }

      /* ---- GET /shelf 货架列表 ---- */
      if (p === '/shelf' && request.method === 'GET') {
        await ensureSchema(env);
        const gate = url.searchParams.get('gate') || '';
        const g = await env.DB.prepare('SELECT name FROM gates WHERE code = ?').bind(gate).first();
        if (!g) return j({ ok: false, message: '门牌不对' }, 404);
        const rs = await env.DB.prepare(
          'SELECT ' + ITEM_COLS + ' FROM items ' +
          'WHERE gate = ? AND status = 1 ORDER BY created_at DESC LIMIT 200').bind(gate).all();
        return j({ ok: true, name: g.name, items: rs.results });
      }

      /* ---- GET /public-shelf 公共铺面（免门牌；v2 新增）----
         sort=latest（默认，created_at 倒序）| hot（downloads 倒序） */
      if (p === '/public-shelf' && request.method === 'GET') {
        await ensureSchema(env);
        const type = url.searchParams.get('type') || '';
        const q = '%' + (url.searchParams.get('q') || '') + '%';
        const sort = url.searchParams.get('sort') === 'hot' ? 'downloads DESC, created_at DESC' : 'created_at DESC';
        const conds = ['visible = 1', 'status = 1', '(title LIKE ? OR author LIKE ?)'];
        const binds = [q, q];
        if (type) { conds.push('type = ?'); binds.push(type); }
        const rs = await env.DB.prepare(
          'SELECT ' + ITEM_COLS + ' FROM items WHERE ' + conds.join(' AND ') +
          ' ORDER BY ' + sort + ' LIMIT 200').bind(...binds).all();
        return j({ ok: true, items: rs.results });
      }

      /* ---- GET /search ---- */
      if (p === '/search' && request.method === 'GET') {
        await ensureSchema(env);
        const gate = url.searchParams.get('gate') || '';
        const q = '%' + (url.searchParams.get('q') || '') + '%';
        const rs = await env.DB.prepare(
          'SELECT ' + ITEM_COLS + ' FROM items ' +
          'WHERE gate = ? AND status = 1 AND (title LIKE ? OR author LIKE ?) ' +
          'ORDER BY created_at DESC LIMIT 100').bind(gate, q, q).all();
        return j({ ok: true, items: rs.results });
      }

      /* ---- GET /item/:id/meta 作品详情元数据（v2 新增）----
         只回包外信息（不含 items 内容/密文），公共件免门牌。
         ⚠️ m 必须在这里**声明一次**：ES module 恒严格模式，未声明赋值直接
         ReferenceError —— 2026-10-12 实测这一行漏了 let，从本行起到文件尾
         的所有路由（publish/like/comments/condition/inbox/unpublish/meta/
         download）全部 500 'm is not defined'，一次 DB 调用都没走到。
         后面 6 处 `m = p.match(...)` 同作用域复用这个声明。 */
      let m = p.match(/^\/item\/([\w-]+)\/meta$/);
      if (m && request.method === 'GET') {
        await ensureSchema(env);
        const row = await env.DB.prepare(
          'SELECT ' + ITEM_COLS + ', gate, status FROM items WHERE id = ?').bind(m[1]).first();
        if (!row || row.status !== 1) return j({ ok: false, message: '这件不在架上' }, 404);
        if (!row.visible) {
          const gate = url.searchParams.get('gate') || '';
          if (gate !== row.gate) return j({ ok: false, message: '门牌对不上这件' }, 403);
        }
        delete row.status; delete row.gate;
        return j({ ok: true, meta: row });
      }

      /* ---- GET /item/:id 下载 ---- */
      m = p.match(/^\/item\/([\w-]+)$/);
      if (m && request.method === 'GET') {
        await ensureSchema(env);
        const id = m[1];
        const row = await env.DB.prepare(
          'SELECT body_key, gate, lock, visible FROM items WHERE id = ? AND status = 1').bind(id).first();
        if (!row) return j({ ok: false, message: '这件不在架上' }, 404);
        if (!row.visible) {
          const gate = url.searchParams.get('gate') || '';
          if (gate !== row.gate) return j({ ok: false, message: '门牌对不上这件' }, 403);
        }
        const obj = await env.STORE.get(row.body_key);
        /* 双兼容：R2 返回带 body 的对象；KV 直接返回字符串 */
        const text = obj && obj.body ? await obj.text() : obj;
        if (!text) return j({ ok: false, message: '包体丢了（服务端）' }, 410);
        await env.DB.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
        return new Response(text, { headers: { 'Content-Type': 'application/json', ...CORS } });
      }

      /* ---- POST /item/:id/like 点赞（设备去重交前端；v2.1 新增） ---- */
      m = p.match(/^\/item\/([\w-]+)\/like$/);
      if (m && request.method === 'POST') {
        await ensureSchema(env);
        const row = await env.DB.prepare(
          'SELECT id, status FROM items WHERE id = ?').bind(m[1]).first();
        if (!row || row.status !== 1) return j({ ok: false, message: '这件不在架上' }, 404);
        const rs = await env.DB.prepare(
          'UPDATE items SET likes = likes + 1 WHERE id = ?').bind(m[1]).run();
        return j({ ok: true });
      }

      /* ---- GET /item/:id/comments 席间列表（v2.1 新增）---- */
      m = p.match(/^\/item\/([\w-]+)\/comments$/);
      if (m && request.method === 'GET') {
        await ensureSchema(env);
        const rs = await env.DB.prepare(
          'SELECT id,name,body,kind,created_at FROM comments ' +
          'WHERE item_id = ? AND status = 1 ORDER BY created_at DESC LIMIT 200').bind(m[1]).all();
        return j({ ok: true, comments: rs.results });
      }

      /* ---- POST /item/:id/comments 席间发言（v2.1 新增）----
         {name, body, kind: 'comment'|'repo', device}；condition 类发言落 condition_met。 */
      m = p.match(/^\/item\/([\w-]+)\/comments$/);
      if (m && request.method === 'POST') {
        await ensureSchema(env);
        const body = await request.json();
        const text = String(body.body || '').trim();
        if (!text) return j({ ok: false, message: '总得写点什么' }, 400);
        if (text.length > 2000) return j({ ok: false, message: '太长了，拆两条说' }, 400);
        const kind = body.kind === 'repo' ? 'repo' : 'comment';
        const device = String(body.device || '');
        const row = await env.DB.prepare(
          'SELECT id, condition, status FROM items WHERE id = ?').bind(m[1]).first();
        if (!row || row.status !== 1) return j({ ok: false, message: '这件不在架上' }, 404);
        const cid = 'cm-' + crypto.randomUUID().slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO comments (id, item_id, device, name, body, kind, created_at, status) ' +
          'VALUES (?,?,?,?,?,?,?,1)')
          .bind(cid, m[1], device, String(body.name || '无名食客').slice(0, 30),
            text, kind, Date.now()).run();
        /* 领取条件：作者要求的动作完成了就记账（repo/like/comment） */
        if (device && row.condition && row.condition !== 'none') {
          const need = row.condition === 'repo' ? 'repo' : row.condition;
          if (kind === need || (row.condition === 'like')) {
            /* like 不走 comments；repo/comment 都算「席间完成」 */
            if (row.condition !== 'like' && kind === need) {
              await env.DB.prepare(
                'INSERT OR IGNORE INTO condition_met (item_id, device, kind, created_at) VALUES (?,?,?,?)')
                .bind(m[1], device, kind, Date.now()).run();
            }
          }
        }
        return j({ ok: true, id: cid });
      }

      /* ---- GET /item/:id/condition?device= 领取条件是否已满足（v2.1 新增）---- */
      m = p.match(/^\/item\/([\w-]+)\/condition$/);
      if (m && request.method === 'GET') {
        await ensureSchema(env);
        const device = url.searchParams.get('device') || '';
        const row = await env.DB.prepare(
          'SELECT condition, likes, status FROM items WHERE id = ?').bind(m[1]).first();
        if (!row || row.status !== 1) return j({ ok: false, message: '这件不在架上' }, 404);
        if (!row.condition || row.condition === 'none') return j({ ok: true, met: true, condition: 'none' });
        if (row.condition === 'like') {
          /* 点赞没有账号体系 —— 本地记「我赞过」即可，服务端只报要求 */
          return j({ ok: true, met: false, condition: 'like' });
        }
        const hit = device ? await env.DB.prepare(
          'SELECT kind FROM condition_met WHERE item_id = ? AND device = ?').bind(m[1], device).first() : null;
        return j({ ok: true, met: !!hit, condition: row.condition });
      }

      /* ---- GET /inbox 作者席间消息（v2.1 新增；X-Repo-Token）----
         我名下件收到的评论/尝后感 + 点赞合计。 */
      if (p === '/inbox' && request.method === 'GET') {
        await ensureSchema(env);
        const token = request.headers.get('X-Repo-Token') || '';
        const a = token ? await env.DB.prepare('SELECT id FROM authors WHERE token = ?').bind(token).first() : null;
        if (!a) return j({ ok: false, message: '作者令牌失效' }, 401);
        const rs = await env.DB.prepare(
          'SELECT c.id, c.item_id, c.name, c.body, c.kind, c.created_at, i.title ' +
          'FROM comments c JOIN items i ON i.id = c.item_id ' +
          'WHERE i.author_id = ? AND c.status = 1 AND i.status = 1 ' +
          'ORDER BY c.created_at DESC LIMIT 100').bind(a.id).all();
        const lk = await env.DB.prepare(
          'SELECT COALESCE(SUM(likes),0) AS total FROM items WHERE author_id = ? AND status = 1').bind(a.id).all();
        return j({ ok: true, comments: rs.results, likesTotal: (lk.results[0] || {}).total || 0 });
      }

      /* ---- POST /publish 发布 ---- */
      if (p === '/publish' && request.method === 'POST') {
        const bodyText = await request.text();
        if (bodyText.length > 5 * 1024 * 1024) return j({ ok: false, message: '超过单件 5MB 上限，拆件上架' }, 413);
        const meta = JSON.parse(bodyText);   /* manifest：items[].data 是包内容 */
        if (!meta || !meta.title || !meta.type || !Array.isArray(meta.items)) {
          return j({ ok: false, message: 'manifest 不完整' }, 400);
        }
        let token = request.headers.get('X-Repo-Token') || '';
        let authorId = null;
        if (token) {
          const a = await env.DB.prepare('SELECT id FROM authors WHERE token = ?').bind(token).first();
          authorId = a ? a.id : null;
          if (!authorId) return j({ ok: false, message: '作者令牌失效' }, 401);
        } else {
          authorId = crypto.randomUUID();
          token = crypto.randomUUID();
          await env.DB.prepare('INSERT INTO authors (id, token, created_at) VALUES (?,?,?)')
            .bind(authorId, token, Date.now()).run();
        }
        const gate = String(meta.gate || '').trim();
        const g = await env.DB.prepare('SELECT name FROM gates WHERE code = ?').bind(gate).first();
        if (!g) return j({ ok: false, message: '门牌不对，发布要先挂在一个有效货架下' }, 403);
        const id = 'rp-' + crypto.randomUUID().slice(0, 12);
        const bodyKey = 'b/' + id + '.json';
        await ensureSchema(env);
        await env.STORE.put(bodyKey, bodyText);
        await env.DB.prepare(
          'INSERT INTO items (id, gate, type, title, author, cover, lock, access, condition, summary, visible, version, size, downloads, created_at, updated_at, body_key, author_id, status) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,1)')
          .bind(id, gate, String(meta.type), String(meta.title).slice(0, 60),
            String(meta.author || '无名作者').slice(0, 30),
            String(meta.cover || '').slice(0, 1000),
            String(meta.lock || 'open'),
            String(meta.access || 'open'),
            String(meta.condition || 'none'),
            String(meta.summary || '').slice(0, 4000),
            meta.visible ? 1 : 0,
            Number(meta.version) || 1,
            bodyText.length, Date.now(), Date.now(), bodyKey, authorId)
          .run();
        return j({ ok: true, id: id, authorToken: token });
      }

      /* ---- DELETE /item/:id 下架 ---- */
      m = p.match(/^\/item\/([\w-]+)$/);
      if (m && request.method === 'DELETE') {
        const token = request.headers.get('X-Repo-Token') || '';
        const a = await env.DB.prepare('SELECT id FROM authors WHERE token = ?').bind(token).first();
        if (!a) return j({ ok: false, message: '作者令牌失效' }, 401);
        const row = await env.DB.prepare(
          'SELECT body_key FROM items WHERE id = ? AND author_id = ?').bind(m[1], a.id).first();
        if (!row) return j({ ok: false, message: '找不到你名下的这件' }, 404);
        await env.DB.prepare('UPDATE items SET status = 0 WHERE id = ?').bind(m[1]).run();
        await env.STORE.delete(row.body_key);
        return j({ ok: true });
      }

      /* ==================== 账密系统（方案-账密系统-v2）==================== */

      /* ---- GET /issue 发码页（独立小页，与 App 内激活分两处——发售路线合规分层）---- */
      if (p === '/issue' && request.method === 'GET') {
        return new Response(ISSUE_PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
        });
      }

      /* ---- POST /issue/claim {qq, key} 领码：一个 QQ 号只能领一次（qq 唯一索引）----
         营业口令闸（2026-10-22 收口：以前知道域名就能任意 QQ 白领码）：
         env.ISSUE_KEY 是部署 secret（wrangler secret put ISSUE_KEY）；
         没配 = 发码页歇业（fail closed），配了 = 口令对上才出码。 */
      if (p === '/issue/claim' && request.method === 'POST') {
        if (botGate(request)) return j({ ok: false, message: '请求被拒绝' }, 403);
        await ensureSchema(env);
        const b = await request.json();
        if (!env.ISSUE_KEY) return j({ ok: false, message: '发码页还没配营业口令，暂时歇业' }, 503);
        if (String(b.key || '') !== env.ISSUE_KEY) {
          return j({ ok: false, message: '营业口令不对 —— 口令随发货说明一起给你' }, 403);
        }
        const q = String(b.qq || '').trim();
        if (!QQ_RE.test(q)) return j({ ok: false, message: 'QQ 号要是 5–12 位数字' }, 400);
        /* 已领过的先挡回去、不进限流（2026-10-31 维稳）：忘了码回来看的人
           每次都吃 429 等于把人锁在门外；口令闸在上面已经拦过一轮。 */
        const dup = await env.DB.prepare('SELECT code FROM codes WHERE qq = ?').bind(q).first();
        if (dup) return j({ ok: false, message: '这个 QQ 号已经领过激活码了（一个号只能领一次）' }, 409);
        /* 50 次 / 15 分钟 / IP：只挡脚本刷码，正常手滑重试烧不完 */
        if (!(await rateHit(env, 'rl:issue:' + ipOf(request), 50))) {
          return j({ ok: false, message: '领得太频繁了，歇会儿再来' }, 429);
        }
        const code = 'SLP-' + randHex(6).toUpperCase();
        try {
          await env.DB.prepare(
            'INSERT INTO codes (code, qq, issued_at, status) VALUES (?,?,?,1)')
            .bind(code, q, Date.now()).run();
        } catch (e) {
          return j({ ok: false, message: '这个 QQ 号已经领过激活码了（一个号只能领一次）' }, 409);
        }
        return j({ ok: true, code: code });
      }

      /* ---- POST /account/activate {code, qq, pass, installId, ua} ----
         码有效且未用 + qq 与发码时一致 → 建 users + devices + session。
         一码一人，用过即废 —— **公用码（codes.status = 2）除外**。

         公用码要的是「凭证共用、身份各归各」：它跳过 c.qq 归属校验、
         也不写 used_by，谁拿它都能领号；但 users.qq 的唯一索引一步不让，
         所以每个人领到的仍是**自己独占的一行 user**。
         ⚠️ 别图省事改成「大家共用一个 user」：那会同时踩两个坑 ——
           ① 3 台设备名额被所有人挤占，第 4 个人起就被 403 挡在门外；
           ② revoke / password / forget 只按 session.uid 鉴权，同一个 uid
              下陌生人之间能互相解绑设备、把共享密码改掉让所有人进不来，
              forget 更是直接注销整串设备。**共享 uid ≠ 共享进门凭证。**
         插一行公用码：
           INSERT INTO codes (code, qq, issued_at, status)
           VALUES ('内测码字面值', 'beta-public', <now>, 2);
         （codes.qq 有唯一索引，占位值挑一个不会撞的，公用码最多一行。） */
      if (p === '/account/activate' && request.method === 'POST') {
        if (botGate(request)) return j({ ok: false, message: '请求被拒绝' }, 403);
        await ensureSchema(env);
        const b = await request.json();
        const code = String(b.code || '').trim().toUpperCase();
        const qq = String(b.qq || '').trim();
        const pass = String(b.pass || '');
        const installId = String(b.installId || '').slice(0, 80);
        if (!code || !QQ_RE.test(qq)) return j({ ok: false, message: '激活码和 QQ 号都要填对' }, 400);
        if (pass.length < 6) return j({ ok: false, message: '密码至少 6 位' }, 400);
        if (!installId) return j({ ok: false, message: '缺设备标识' }, 400);

        /* 先认码（2026-10-31 维稳：限流拆成两个桶，正常重试不再吃计数）：
           ① 错码桶 —— 穷举激活码的人在这里撞墙（20 次 / 15 分钟 / IP）；
           ② 总桶 —— 只对「校验全过、真要建号」的请求计数（60 次 / 15 分钟 / IP），
              同一个出口 IP（学校 / 公司 WiFi）一群人正常激活不再互撞；
              它只挡建号刷量，挡不住核对信息时的手滑重试。 */
        const c = await env.DB.prepare(
          'SELECT qq, used_by, status FROM codes WHERE code = ?').bind(code).first();
        const isShared = !!c && c.status === 2;
        if (!c || (c.status !== 1 && !isShared)) {
          if (!(await rateHit(env, 'rl:act-bad:' + ipOf(request), 20))) {
            return j({ ok: false, message: '操作太频繁了，歇会儿再来' }, 429);
          }
          return j({ ok: false, message: '激活码不对' }, 404);
        }
        if (!isShared && c.used_by) {
          /* 2026-10-31 文案修准：激活成功后手抖再交一次表单的人，看到的
             不该是吓人的「码被用过了」而是「你已经激活过，去登录」；
             码确实是别人的（qq 对不上）才报「被用过」。 */
          const owner = await env.DB.prepare(
            'SELECT qq FROM users WHERE id = ?').bind(c.used_by).first();
          if (owner && owner.qq === qq) {
            return j({ ok: false, message: '你已经激活过啦，用刚设的密码直接登录就行' }, 409);
          }
          return j({ ok: false, message: '这个激活码已经被用过了（一码一人）' }, 409);
        }
        if (!isShared && c.qq !== qq) return j({ ok: false, message: '这个码是发给另一个 QQ 号的，去发码页核对' }, 403);
        if (await env.DB.prepare('SELECT id FROM users WHERE qq = ?').bind(qq).first()) {
          return j({ ok: false, message: '这个 QQ 号已经激活过，直接登录就行' }, 409);
        }
        if (!(await rateHit(env, 'rl:act:' + ipOf(request), 60))) {
          return j({ ok: false, message: '操作太频繁了，歇会儿再来' }, 429);
        }
        const uid = 'u-' + crypto.randomUUID().slice(0, 16);
        const salt = randHex(16);
        const hash = await passHash(pass, salt);
        await env.DB.prepare(
          'INSERT INTO users (id, qq, salt, hash, created_at, status) VALUES (?,?,?,?,?,1)')
          .bind(uid, qq, salt, hash, Date.now()).run();
        /* 公用码不被「一码一人」消耗掉 —— 它本来就是给一批人反复领的。
           关门办法：把那行 codes.status 置 0（已经进门的人不受影响，
           他们的 user 行和 session 都还在）。 */
        if (!isShared) {
          await env.DB.prepare('UPDATE codes SET used_by = ? WHERE code = ?').bind(uid, code).run();
        }
        const devId = 'd-' + crypto.randomUUID().slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO devices (id, user_id, install_id, ua, created_at, last_seen, status) VALUES (?,?,?,?,?,?,1)')
          .bind(devId, uid, installId, String(b.ua || '').slice(0, 120), Date.now(), Date.now()).run();
        const token = crypto.randomUUID() + '.' + randHex(8);
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, device_id, created_at, last_seen, status) VALUES (?,?,?,?,?,1)')
          .bind(token, uid, devId, Date.now(), Date.now()).run();
        return j({ ok: true, token: token, qq: qq });
      }

      /* ---- POST /account/login {qq, pass, installId, ua} ----
         同设备（installId 已登记）重复登录不新增名额；3 台满且本机不在列
         → 403 带设备清单，前端接「踢/解绑」UI（发售路线：防误封是 1 星评论重灾区）。 */
      if (p === '/account/login' && request.method === 'POST') {
        if (botGate(request)) return j({ ok: false, message: '请求被拒绝' }, 403);
        await ensureSchema(env);
        const b = await request.json();
        const qq = String(b.qq || '').trim();
        const pass = String(b.pass || '');
        const installId = String(b.installId || '').slice(0, 80);
        if (!QQ_RE.test(qq) || !pass || !installId) {
          return j({ ok: false, message: 'QQ 号、密码、设备标识都要有' }, 400);
        }
        /* 防撞库只计**失败**次数（成功登录不该消耗额度，否则正常用户 15 分钟
           登 N 次就被自己锁死——2026-10-21 冒烟设计时抓出）。
           10 次 / 15 分钟（2026-10-31 维稳放宽）：忘密码的人试错空间更大，
           对撞库仍是减速带不是闸门。 */
        const exceeded = async () => !(await rateHit(env, 'rl:login:' + ipOf(request) + ':' + qq, 10));
        const u = await env.DB.prepare(
          'SELECT id, salt, hash, status FROM users WHERE qq = ?').bind(qq).first();
        if (!u || u.status !== 1 || (await passHash(pass, u.salt)) !== u.hash) {
          if (await exceeded()) return j({ ok: false, message: '试错太多次了，锁定 15 分钟' }, 429);
          return j({ ok: false, message: 'QQ 号或密码不对' }, 401);
        }
        let dev = await env.DB.prepare(
          'SELECT id FROM devices WHERE user_id = ? AND install_id = ?').bind(u.id, installId).first();
        if (dev) {
          await env.DB.prepare('UPDATE devices SET last_seen = ?, status = 1 WHERE id = ?')
            .bind(Date.now(), dev.id).run();
        } else {
          const cnt = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND status = 1').bind(u.id).first();
          if ((cnt.n || 0) >= 3) {
            const list = await env.DB.prepare(
              'SELECT id, ua, last_seen FROM devices WHERE user_id = ? AND status = 1 ORDER BY last_seen DESC')
              .bind(u.id).all();
            return j({ ok: false, message: '设备满 3 台了，先去解绑一台', devices: list.results }, 403);
          }
          dev = { id: 'd-' + crypto.randomUUID().slice(0, 16) };
          await env.DB.prepare(
            'INSERT INTO devices (id, user_id, install_id, ua, created_at, last_seen, status) VALUES (?,?,?,?,?,?,1)')
            .bind(dev.id, u.id, installId, String(b.ua || '').slice(0, 120), Date.now(), Date.now()).run();
        }
        const token = crypto.randomUUID() + '.' + randHex(8);
        await env.DB.prepare(
          'INSERT INTO sessions (token, user_id, device_id, created_at, last_seen, status) VALUES (?,?,?,?,?,1)')
          .bind(token, u.id, dev.id, Date.now(), Date.now()).run();
        return j({ ok: true, token: token, qq: qq });
      }

      /* ---- POST /account/logout 登出（作废当前会话；设备行保留）---- */
      if (p === '/account/logout' && request.method === 'POST') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (s) {
          await env.DB.prepare('UPDATE sessions SET status = 0 WHERE token = ?').bind(s.token).run();
        }
        return j({ ok: true });   /* 没登录也回 ok —— 退出不该被网络卡住 */
      }

      /* ---- GET /account/me（登录态）---- */
      if (p === '/account/me' && request.method === 'GET') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (!s) return j({ ok: false, message: '没登录或会话失效' }, 401);
        await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
          .bind(Date.now(), s.token).run();
        const devs = await env.DB.prepare(
          'SELECT id, ua, install_id, created_at, last_seen FROM devices WHERE user_id = ? AND status = 1 ORDER BY last_seen DESC')
          .bind(s.uid).all();
        return j({ ok: true, qq: s.qq, devices: devs.results, now: Date.now() });
      }

      /* ---- GET /account/devices（登录态）---- */
      if (p === '/account/devices' && request.method === 'GET') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (!s) return j({ ok: false, message: '没登录或会话失效' }, 401);
        const devs = await env.DB.prepare(
          'SELECT id, ua, created_at, last_seen FROM devices WHERE user_id = ? AND status = 1 ORDER BY last_seen DESC')
          .bind(s.uid).all();
        return j({ ok: true, devices: devs.results });
      }

      /* ---- POST /account/devices/:id/revoke 自助解绑/踢（登录态）----
         解绑 = 设备行 status 0 + 该设备全部会话作废（被踢端下次校验即失效）。 */
      m = p.match(/^\/account\/devices\/([\w-]+)\/revoke$/);
      if (m && request.method === 'POST') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (!s) return j({ ok: false, message: '没登录或会话失效' }, 401);
        const row = await env.DB.prepare(
          'SELECT id FROM devices WHERE id = ? AND user_id = ? AND status = 1').bind(m[1], s.uid).first();
        if (!row) return j({ ok: false, message: '找不到这台设备' }, 404);
        await env.DB.prepare('UPDATE devices SET status = 0 WHERE id = ?').bind(row.id).run();
        await env.DB.prepare('UPDATE sessions SET status = 0 WHERE device_id = ?').bind(row.id).run();
        return j({ ok: true });
      }

      /* ---- POST /account/password {oldPass, newPass} 登录态内改密 ---- */
      if (p === '/account/password' && request.method === 'POST') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (!s) return j({ ok: false, message: '没登录或会话失效' }, 401);
        const b = await request.json();
        const u = await env.DB.prepare(
          'SELECT salt, hash FROM users WHERE id = ?').bind(s.uid).first();
        if ((await passHash(String(b.oldPass || ''), u.salt)) !== u.hash) {
          return j({ ok: false, message: '老密码不对' }, 401);
        }
        if (String(b.newPass || '').length < 6) return j({ ok: false, message: '新密码至少 6 位' }, 400);
        const salt = randHex(16);
        const hash = await passHash(String(b.newPass), salt);
        await env.DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?')
          .bind(salt, hash, s.uid).run();
        return j({ ok: true });
      }

      /* ---- POST /account/forget {pass} 注销（QQ 号删除出口，iOS 审核硬要求）----
         老密码确认后：全部设备/会话作废，qq 字段脱敏（哈希与码的账目保留）。
         密码彻底丢了 → 人工（Q 群）核身处理，起步期量小最省事（用户 2026-10-21 定）。 */
      if (p === '/account/forget' && request.method === 'POST') {
        await ensureSchema(env);
        const s = await sessionOf(request, env);
        if (!s) return j({ ok: false, message: '没登录或会话失效' }, 401);
        const b = await request.json();
        const u = await env.DB.prepare(
          'SELECT salt, hash FROM users WHERE id = ?').bind(s.uid).first();
        if ((await passHash(String(b.pass || ''), u.salt)) !== u.hash) {
          return j({ ok: false, message: '密码不对，确认不了注销' }, 401);
        }
        await env.DB.prepare('UPDATE devices SET status = 0 WHERE user_id = ?').bind(s.uid).run();
        await env.DB.prepare('UPDATE sessions SET status = 0 WHERE user_id = ?').bind(s.uid).run();
        await env.DB.prepare('UPDATE users SET status = 0, qq = ? WHERE id = ?')
          .bind('deleted:' + s.uid, s.uid).run();
        return j({ ok: true });
      }

      /* ==================== 管理台（2026-10-31，X-Admin-Key）==================== */

      /* ---- GET /admin 管理页 ---- */
      if (p === '/admin' && request.method === 'GET') {
        return new Response(ADMIN_PAGE, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
        });
      }

      /* ---- POST /admin/stats 真实注册数据 ---- */
      if (p === '/admin/stats' && request.method === 'POST') {
        await ensureSchema(env);
        if (!adminOk(request, env)) return j({ ok: false, message: '管理钥匙不对' }, 401);
        const uAll = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        const uAct = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE status = 1').first();
        const dv = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE status = 1').first();
        const ss = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE status = 1').first();
        const cd = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes').first();
        const cdu = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE used_by IS NOT NULL').first();
        const recent = await env.DB.prepare(
          'SELECT qq, created_at FROM users WHERE status = 1 ORDER BY created_at DESC LIMIT 30').all();
        return j({
          ok: true,
          users: (uAct && uAct.n) || 0, usersAll: (uAll && uAll.n) || 0,
          devices: (dv && dv.n) || 0, sessions: (ss && ss.n) || 0,
          codes: (cd && cd.n) || 0, codesUsed: (cdu && cdu.n) || 0,
          recent: recent.results || [],
        });
      }

      /* ---- POST /admin/register {qq, pass} 帮人注册：直接建号，不走发码页 ----
         激活码账目不动（没消耗码）；用户后续可正常登录、绑设备、改密。 */
      if (p === '/admin/register' && request.method === 'POST') {
        await ensureSchema(env);
        if (!adminOk(request, env)) return j({ ok: false, message: '管理钥匙不对' }, 401);
        const b = await request.json();
        const qq = String(b.qq || '').trim();
        const pass = String(b.pass || '');
        if (!QQ_RE.test(qq)) return j({ ok: false, message: 'QQ 号要是 5–12 位数字' }, 400);
        if (pass.length < 6) return j({ ok: false, message: '密码至少 6 位' }, 400);
        if (await env.DB.prepare('SELECT id FROM users WHERE qq = ?').bind(qq).first()) {
          return j({ ok: false, message: '这个 QQ 号已经有账号了，直接登录就行' }, 409);
        }
        const uid = 'u-' + crypto.randomUUID().slice(0, 16);
        const salt = randHex(16);
        const hash = await passHash(pass, salt);
        await env.DB.prepare(
          'INSERT INTO users (id, qq, salt, hash, created_at, status) VALUES (?,?,?,?,?,1)')
          .bind(uid, qq, salt, hash, Date.now()).run();
        return j({ ok: true, uid: uid });
      }

      /* ---- POST /admin/reset {qq, newPass} 帮人重置密码 ----
         新盐新哈希覆盖；该用户全部会话作废（所有设备登出，防旧凭证残留）。
         设备绑定保留 —— 对方换设备登录时名额照常算。 */
      if (p === '/admin/reset' && request.method === 'POST') {
        await ensureSchema(env);
        if (!adminOk(request, env)) return j({ ok: false, message: '管理钥匙不对' }, 401);
        const b = await request.json();
        const qq = String(b.qq || '').trim();
        const newPass = String(b.newPass || '');
        if (!QQ_RE.test(qq)) return j({ ok: false, message: 'QQ 号要是 5–12 位数字' }, 400);
        if (newPass.length < 6) return j({ ok: false, message: '新密码至少 6 位' }, 400);
        const u = await env.DB.prepare(
          'SELECT id FROM users WHERE qq = ? AND status = 1').bind(qq).first();
        if (!u) return j({ ok: false, message: '找不到这个 QQ 号的账号（或已注销）' }, 404);
        const salt = randHex(16);
        const hash = await passHash(newPass, salt);
        await env.DB.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?')
          .bind(salt, hash, u.id).run();
        await env.DB.prepare('UPDATE sessions SET status = 0 WHERE user_id = ?').bind(u.id).run();
        return j({ ok: true });
      }

      return j({ ok: false, message: '没有这条路 ' + p }, 404);
    } catch (e) {
      return j({ ok: false, message: String((e && e.message) || e) }, 500);
    }
  }
};
