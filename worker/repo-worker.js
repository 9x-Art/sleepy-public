/* ============================================================
   repo-worker.js — 设定仓库 Worker（P0，方案-设定仓库-v1）

   绑定：env.DB = D1（索引/门牌），env.STORE = R2（包体）。
   红线：这里只碰「账目」—— 件的正文明文只存在 R2 的用户内容区，
   Worker 不解析不改动；user 的游玩数据永不经此。

   端点：
     POST /publish          发布（X-Repo-Token = 作者令牌，首次生成并返回）
     GET  /shelf?gate=      货架列表（需有效门牌）
     GET  /item/:id?gate=   下载包体（计数 +1）
     POST /gate             校验门牌 {code} → {name}
     DELETE /item/:id       下架（作者令牌）
     GET  /search?gate=&q=  标题/作者关键词

   部署：wrangler deploy（不走 GitHub HTTPS）。配置见 wrangler.toml。
   ============================================================ */
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
        const gate = url.searchParams.get('gate') || '';
        const g = await env.DB.prepare('SELECT name FROM gates WHERE code = ?').bind(gate).first();
        if (!g) return j({ ok: false, message: '门牌不对' }, 404);
        const rs = await env.DB.prepare(
          'SELECT id,type,title,author,lock,version,size,downloads,created_at FROM items ' +
          'WHERE gate = ? AND status = 1 ORDER BY created_at DESC LIMIT 200').bind(gate).all();
        return j({ ok: true, name: g.name, items: rs.results });
      }

      /* ---- GET /search ---- */
      if (p === '/search' && request.method === 'GET') {
        const gate = url.searchParams.get('gate') || '';
        const q = '%' + (url.searchParams.get('q') || '') + '%';
        const rs = await env.DB.prepare(
          'SELECT id,type,title,author,lock,version,size,downloads,created_at FROM items ' +
          'WHERE gate = ? AND status = 1 AND (title LIKE ? OR author LIKE ?) ' +
          'ORDER BY created_at DESC LIMIT 100').bind(gate, q, q).all();
        return j({ ok: true, items: rs.results });
      }

      /* ---- GET /item/:id 下载 ---- */
      let m = p.match(/^\/item\/([\w-]+)$/);
      if (m && request.method === 'GET') {
        const id = m[1];
        const row = await env.DB.prepare(
          'SELECT body_key, gate, lock FROM items WHERE id = ? AND status = 1').bind(id).first();
        if (!row) return j({ ok: false, message: '这件不在架上' }, 404);
        const gate = url.searchParams.get('gate') || '';
        if (gate !== row.gate) return j({ ok: false, message: '门牌对不上这件' }, 403);
        const obj = await env.STORE.get(row.body_key);
        /* 双兼容：R2 返回带 body 的对象；KV 直接返回字符串 */
        const text = obj && obj.body ? await obj.text() : obj;
        if (!text) return j({ ok: false, message: '包体丢了（服务端）' }, 410);
        await env.DB.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
        return new Response(text, { headers: { 'Content-Type': 'application/json', ...CORS } });
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
        await env.STORE.put(bodyKey, bodyText);
        await env.DB.prepare(
          'INSERT INTO items (id, gate, type, title, author, lock, version, size, downloads, created_at, body_key, author_id, status) ' +
          'VALUES (?,?,?,?,?,?,?,? ,0,?,?,?,1)')
          .bind(id, gate, String(meta.type), String(meta.title).slice(0, 60),
            String(meta.author || '无名作者').slice(0, 30),
            String(meta.lock || 'open'), Number(meta.version) || 1,
            bodyText.length, Date.now(), bodyKey, authorId)
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
