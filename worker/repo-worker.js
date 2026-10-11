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
    })();
  }
  return schemaReady;
}

const ITEM_COLS = 'id,type,title,author,cover,lock,access,condition,summary,visible,version,size,downloads,created_at,updated_at';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Repo-Token',
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
         只回包外信息（不含 items 内容/密文），公共件免门牌。 */
      m = p.match(/^\/item\/([\w-]+)\/meta$/);
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
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,1)')
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

      return j({ ok: false, message: '没有这条路 ' + p }, 404);
    } catch (e) {
      return j({ ok: false, message: String((e && e.message) || e) }, 500);
    }
  }
};
