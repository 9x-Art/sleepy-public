/* ============================================================
   page-qunsheng.js — 群声 App（公共论坛 · Batch B）
   页面：qunsheng（杂响首页）/ qunsheng-post（帖子详情）/ qunsheng-compose
        （发帖与身份选择）/ qunsheng-me（我的基础页）/ qunsheng-notices（消息占位）。
   数据全部走 Sleepy.forum 服务入口 + Sleepy.forumGen 生成层，
   本文件不做裸 store 读写、不做权限判断、不拼匿名身份。

   视觉照搬 demo（城市社区报刊感）：报纸米色 #f4f0e7、墨色 #25231f、
   主红 #a63b32、辅蓝 #315d68、宋体大报头、墨框拍纸头像、错位阴影。
   Batch B 范围：首页三条流 + 详情回复树 + 发布 + 我的基础页；
   转发/分享卡（Batch C）、消息通知（Batch D）只留入口与占位。

   上下文：一律 ctx.params.sandboxId > forum.resolveContext 锁定 > 当前房；
   伪造 sandboxId 走错误态。切岛后 selectedForumAccountBySandbox 独立恢复。
   ============================================================ */
(function (global) {
  'use strict';

  var Sleepy = (global.Sleepy = global.Sleepy || {});
  var forum = null;     /* 惰性取：文件求值时 Sleepy.forum 可能还没挂上 */
  var forumGen = null;
  function F() { return forum || (forum = Sleepy.forum); }
  function G() { return forumGen || (forumGen = Sleepy.forumGen); }

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) {
      if (text.nodeType) el.appendChild(text);
      else if (Array.isArray(text)) {
        text.forEach(function (t) {
          if (t === undefined || t === null) return;
          el.appendChild(t && t.nodeType ? t : document.createTextNode(String(t)));
        });
      } else el.textContent = String(text);
    }
    return el;
  }

  /* ------------------------------ 样式 ------------------------------ */
  /* 逐值照搬 demo 的 CSS 变量与关键规则；类名加 .qs- 前缀防撞。 */
  var STYLE_ID = 'qs-forum-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.qs-root{--ink:#25231f;--muted:#756f65;--paper:#f4f0e7;--paper2:#faf7ef;--line:#d8d0c2;--red:#a63b32;--blue:#315d68;--soft:#e9e2d5;',
      'display:flex;flex-direction:column;height:100%;background:var(--paper);color:var(--ink);',
      'font-family:system-ui,-apple-system,"PingFang SC",sans-serif;font-size:14px}',
      '.qs-top{padding:12px 18px 0;border-bottom:1px solid var(--line);background:rgba(244,240,231,.96)}',
      '.qs-utility{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--muted);letter-spacing:.08em}',
      '.qs-world{display:flex;align-items:center;gap:7px;min-width:0}',
      '.qs-world i{width:7px;height:7px;border-radius:50%;background:var(--blue);display:block;box-shadow:0 0 0 3px rgba(49,93,104,.12);flex:0 0 auto}',
      '.qs-world span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qs-search{border:0;background:transparent;color:var(--muted);font-size:12px;padding:6px 0}',
      '.qs-masthead{display:flex;align-items:flex-end;justify-content:space-between;padding:15px 0 12px}',
      '.qs-name h1{margin:0;font-family:"Songti SC","STSong",serif;font-size:34px;line-height:1;font-weight:800;letter-spacing:.04em}',
      '.qs-name p{margin:7px 0 0;font-size:10px;color:var(--muted);letter-spacing:.22em}',
      '.qs-weather{text-align:right}',
      '.qs-weather strong{display:block;font-family:Georgia,serif;font-size:21px;font-weight:500}',
      '.qs-weather span{font-size:10px;color:var(--muted)}',
      '.qs-tabs{display:flex;gap:24px;height:43px;align-items:flex-end}',
      '.qs-tab{position:relative;border:0;background:none;padding:0 0 12px;color:var(--muted);font-size:14px}',
      '.qs-tab.on{color:var(--ink);font-weight:700}',
      '.qs-tab.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:3px;background:var(--red)}',
      '.qs-main{flex:1;overflow-y:auto;padding:16px 16px 20px}',
      '.qs-edition{display:flex;align-items:center;gap:9px;margin-bottom:14px;color:var(--muted);font-size:10px;letter-spacing:.12em}',
      '.qs-edition:before,.qs-edition:after{content:"";height:1px;background:var(--line);flex:1}',
      '.qs-edition .qs-refresh{border:0;background:none;color:var(--blue);font-size:10px;letter-spacing:.12em;font-weight:700;padding:0;cursor:pointer}',
      '.qs-edition .qs-refresh:active{opacity:.55}',
      '.qs-edition .qs-refresh[disabled]{opacity:.45;cursor:default}',
      '.qs-ticker{display:flex;min-height:43px;border:1px solid var(--ink);background:#fffaf0}',
      '.qs-ticker b{padding:11px 10px;background:var(--ink);color:var(--paper);white-space:nowrap;font-size:10px;letter-spacing:.12em}',
      '.qs-ticker span{padding:10px 11px;font-size:12px;line-height:1.7}',
      '.qs-gum{margin:14px 0 18px;padding:14px;border:1px solid var(--ink);background:#fff9e9;box-shadow:4px 4px 0 #d8bd64;cursor:pointer}',
      '.qs-gum-head,.qs-gum-foot{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:10px;letter-spacing:.06em}',
      '.qs-gum-head strong{color:var(--red);letter-spacing:.14em}',
      '.qs-gum h2{margin:9px 0 6px;font:700 20px/1.35 "Songti SC","STSong",serif}',
      '.qs-gum p{margin:0;color:#575149;font-size:13px;line-height:1.65}',
      '.qs-gum-foot{margin-top:11px;padding-top:9px;border-top:1px dashed var(--line)}',
      '.qs-section-title{display:flex;align-items:center;gap:10px;margin:3px 0 0;font-size:10px;font-weight:800;letter-spacing:.16em}',
      '.qs-section-title:after{content:"";height:1px;background:var(--ink);flex:1}',
      '.qs-post{padding:17px 0 15px;border-bottom:1px solid var(--line);cursor:pointer}',
      '.qs-meta{display:flex;align-items:flex-start;gap:10px}',
      '.qs-avatar{width:35px;height:35px;flex:0 0 auto;border:1px solid var(--ink);display:grid;place-items:center;background:#d6e0dc;font-family:Georgia,serif;font-weight:700;transform:rotate(-2deg)}',
      /* v218：char 用自己头像时贴图盖住字母脸（core.setAvatarBg 加 has-img） */
      '.qs-avatar.has-img,.qs-mini.has-img{color:transparent;background-size:cover;background-position:center;}',
      '.qs-who{font-size:13px;font-weight:800}',
      '.qs-sub{margin-top:2px;color:var(--muted);font-size:10px}',
      '.qs-tag{margin-left:auto;border:1px solid var(--line);padding:2px 6px;color:var(--muted);font-size:9px;flex:0 0 auto}',
      '.qs-post h3{margin:11px 0 7px;font:700 18px/1.42 "Songti SC","STSong",serif}',
      '.qs-post .qs-body-p{margin:0;color:#49453e;font-size:13px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.qs-quote{margin-top:10px;padding:8px 10px;border-left:3px solid var(--red);background:rgba(255,255,255,.34);color:#514b42;font-size:12px;line-height:1.65}',
      '.qs-actions{display:flex;gap:19px;margin-top:12px}',
      '.qs-actions button{border:0;background:none;padding:0;color:var(--muted);font-size:11px}',
      '.qs-actions button.on{color:var(--red);font-weight:800}',
      '.qs-more-post{padding:15px 0 2px;cursor:pointer}',
      '.qs-more-post h3{margin:5px 0 6px;font:700 17px/1.4 "Songti SC","STSong",serif}',
      '.qs-more-post small{color:var(--muted)}',
      '.qs-empty{padding:38px 0;text-align:center;color:var(--muted)}',
      '.qs-empty-big{font-size:15px;color:var(--ink);margin-bottom:8px;font-weight:700}',
      '.qs-empty-sub{font-size:12px;line-height:1.9;white-space:pre-wrap}',
      '.qs-nav{display:flex;justify-content:space-around;align-items:center;border-top:1px solid var(--line);background:rgba(247,243,235,.97);padding:9px 18px calc(9px + env(safe-area-inset-bottom))}',
      '.qs-nav button{border:0;background:none;color:var(--muted);font-size:11px;min-width:58px;padding:6px 0}',
      '.qs-nav button.on{color:var(--red);font-weight:700}',
      '.qs-nav .qs-publish{width:44px;height:44px;min-width:44px;border-radius:50%;background:var(--ink);color:var(--paper);font-size:11px;font-weight:800;line-height:1;padding:0}',
      /* ---- 详情页 ---- */
      '.qs-topbar{padding:10px 15px;border-bottom:1px solid var(--line);background:rgba(244,240,231,.96)}',
      '.qs-topline{display:grid;grid-template-columns:52px 1fr 52px;align-items:center}',
      '.qs-topline .qs-iconbtn,.qs-topline .qs-textbtn{border:0;background:none;color:var(--ink);font-size:12px;padding:7px 0}',
      '.qs-topline .qs-iconbtn{text-align:left}',
      '.qs-topline .qs-textbtn{text-align:right;color:var(--muted)}',
      '.qs-crumb{text-align:center}',
      '.qs-crumb b{display:block;font:700 14px "Songti SC","STSong",serif}',
      '.qs-crumb small{display:block;margin-top:2px;color:var(--muted);font-size:9px;letter-spacing:.08em}',
      '.qs-detail{padding:19px 17px 16px;background:var(--paper2);border-bottom:1px solid var(--ink)}',
      '.qs-detail .qs-avatar{width:38px;height:38px}',
      '.qs-detail h1{margin:17px 0 10px;font:800 24px/1.36 "Songti SC","STSong",serif;letter-spacing:.01em}',
      '.qs-detail-body{font-size:14px;line-height:1.85;color:#413d36;white-space:pre-wrap}',
      '.qs-stats{display:flex;gap:13px;margin-top:16px;padding-top:11px;border-top:1px dashed var(--line);color:var(--muted);font-size:10px}',
      '.qs-post-actions{display:grid;grid-template-columns:repeat(4,1fr);margin:0 17px;border-bottom:1px solid var(--line)}',
      '.qs-post-actions button{border:0;background:none;padding:11px 0;color:var(--muted);font-size:11px}',
      '.qs-post-actions button.on{color:var(--red);font-weight:800}',
      '.qs-notice{margin:12px 17px;padding:9px 11px;background:var(--soft);color:var(--muted);font-size:10px;line-height:1.7}',
      '.qs-reply-head{display:flex;justify-content:space-between;align-items:center;margin:16px 17px 4px}',
      '.qs-reply-title{display:flex;align-items:baseline;gap:8px}',
      '.qs-reply-title h2{margin:0;font:800 17px "Songti SC","STSong",serif}',
      '.qs-reply-title span{color:var(--muted);font-size:10px}',
      '.qs-filters{display:flex;gap:12px}',
      '.qs-filters button{border:0;background:none;color:var(--muted);font-size:11px;padding:2px 0}',
      '.qs-filters button.on{color:var(--red);font-weight:800}',
      '.qs-poke{margin:8px 17px;border:1px dashed var(--line);background:transparent;color:var(--muted);font-size:10px;padding:7px 10px}',
      '.qs-comment{padding:15px 17px;border-bottom:1px solid var(--line)}',
      '.qs-cmain{display:flex;gap:9px}',
      '.qs-mini{width:28px;height:28px;flex:0 0 auto;border:1px solid var(--ink);display:grid;place-items:center;font:700 11px Georgia,serif;transform:rotate(-2deg)}',
      '.qs-ccontent{flex:1;min-width:0}',
      '.qs-cwho{font-size:12px;font-weight:700}',
      '.qs-cwho .qs-floor{color:var(--muted);font-weight:400;font-size:9px;margin-left:6px}',
      '.qs-cwho .qs-owner-badge{display:inline-block;margin-left:6px;padding:1px 5px;background:#efe2d3;color:var(--red);font-size:9px;font-weight:800}',
      '.qs-ctext{margin:6px 0 0;font-size:13px;line-height:1.7;color:#413d36}',
      '.qs-cinfo{margin-top:5px;color:var(--muted);font-size:9px}',
      '.qs-cact{display:flex;gap:14px;margin-top:7px}',
      '.qs-cact button{border:0;background:none;padding:0;color:var(--muted);font-size:10px}',
      '.qs-cact button.on{color:var(--red);font-weight:800}',
      '.qs-branch{margin-top:9px;padding:9px 11px;background:rgba(255,255,255,.4);border-left:3px solid var(--line)}',
      '.qs-branch-item{font-size:12px;line-height:1.65;color:#4a453d}',
      '.qs-branch-item b{font-weight:800}',
      '.qs-branch-item .qs-bmeta{color:var(--muted);font-size:9px;margin-left:6px}',
      '.qs-branch-item + .qs-branch-item{margin-top:7px}',
      '.qs-composer{border-top:1px solid var(--line);background:rgba(247,243,235,.97);padding:8px 14px calc(8px + env(safe-area-inset-bottom))}',
      '.qs-target{display:none;align-items:center;gap:8px;font-size:10px;color:var(--blue);padding:4px 0}',
      '.qs-target.show{display:flex}',
      '.qs-target button{border:0;background:none;color:var(--muted);font-size:9px}',
      '.qs-compose-row{display:flex;gap:9px;align-items:flex-end}',
      '.qs-identity-chip{flex:0 0 auto;width:34px;height:34px;border:1px solid var(--ink);display:grid;place-items:center;font:700 11px Georgia,serif;transform:rotate(-2deg)}',
      '.qs-input-wrap{flex:1}',
      '.qs-input-wrap textarea{display:block;width:100%;border:0;outline:0;background:transparent;resize:none;font:13px/1.6 inherit;color:var(--ink);min-height:22px;max-height:76px}',
      '.qs-send{flex:0 0 auto;border:0;background:none;color:var(--red);font-weight:800;font-size:12px;padding:6px 0}',
      '.qs-send:disabled{opacity:.35}',
      /* ---- 发布页 ---- */
      '.qs-identity-card{display:flex;align-items:center;gap:11px;padding:12px;border:1px solid var(--ink);background:var(--paper2);box-shadow:3px 3px 0 #ddd0bb;cursor:pointer}',
      '.qs-identity-copy{min-width:0;flex:1}',
      '.qs-identity-copy small{display:block;color:var(--muted);font-size:8px;letter-spacing:.09em}',
      '.qs-identity-copy b{display:block;margin-top:2px;font-size:13px}',
      '.qs-identity-card:after{content:"更换";color:var(--muted);font-size:9px}',
      '.qs-anon-state{display:none;margin-top:8px;padding:8px 10px;border-left:3px solid var(--red);background:#eee2d8;color:#5e554c;font-size:9px;line-height:1.55}',
      '.qs-anon-state.show{display:block}',
      '.qs-types{display:flex;gap:7px;overflow:auto;margin:17px -16px 0;padding:0 16px 9px}',
      /* v216 同人创作：代笔入口 + 题材输入 */
      '.qs-gw-btn{display:block;width:100%;margin-top:12px;padding:11px 12px;border:1px dashed #c9bfae;border-radius:10px;',
      'background:rgba(255,255,255,.5);color:#4a443c;font-size:12.5px;cursor:pointer;text-align:left}',
      '.qs-gw-box{margin-top:12px;padding:12px 13px;border:1px solid #d8d0c2;border-radius:10px;background:rgba(233,226,213,.5)}',
      '.qs-gw-title{font-size:13px;font-weight:600;color:#25231f}',
      '.qs-gw-box small{display:block;margin-top:5px;font-size:10.5px;line-height:1.6;color:#756f65}',
      '.qs-topic-input{display:block;width:100%;margin-top:9px;border:1px solid #d8d0c2;border-radius:8px;',
      'background:rgba(255,255,255,.7);padding:9px 10px;font:12.5px/1.7 inherit;color:#25231f;resize:none}',
      /* 详情页：分节正文 + 追更 */
      '.qs-fw-chapter{margin:14px 0 0;padding-top:12px;border-top:1px dashed #d8d0c2}',
      '.qs-fw-chapter h3{margin:0 0 8px;font-size:13.5px;font-weight:600;color:#315d68;letter-spacing:.04em}',
      '.qs-fw-p{margin:0 0 11px;font-size:14.5px;line-height:1.95;color:#3b372f;text-align:justify}',
      '.qs-fw-heard{margin:6px 0 0;padding:7px 10px;border-left:2px solid #a63b32;background:rgba(166,59,50,.06);',
      'font-size:10.5px;line-height:1.7;color:#6a5b57}',
      '.qs-more-btn{display:block;width:100%;margin-top:12px;padding:11px;border:1px solid #c9bfae;border-radius:10px;',
      'background:rgba(255,255,255,.55);color:#4a443c;font-size:12.5px;cursor:pointer}',
      '.qs-more-btn[disabled]{opacity:.5;cursor:default}',
      '.qs-type{flex:0 0 auto;border:1px solid var(--line);background:transparent;padding:7px 10px;color:var(--muted);font-size:10px}',
      '.qs-type.on{border-color:var(--ink);background:var(--ink);color:var(--paper)}',
      '.qs-editor{margin-top:7px;border-top:1px solid var(--ink)}',
      '.qs-title-input,.qs-body-input{display:block;width:100%;border:0;outline:0;background:transparent;color:var(--ink)}',
      '.qs-title-input{padding:17px 2px 13px;border-bottom:1px solid var(--line);font:800 21px/1.4 "Songti SC","STSong",serif}',
      '.qs-body-input{min-height:178px;padding:14px 2px;resize:none;font:13px/1.8 inherit}',
      '.qs-title-input::placeholder,.qs-body-input::placeholder{color:#aaa194}',
      '.qs-attachments{display:flex;gap:8px;padding:10px 0;border-top:1px dashed var(--line)}',
      '.qs-attachments button{border:1px solid var(--line);background:#faf6ee;padding:7px 9px;color:var(--muted);font-size:9px}',
      '.qs-meta-row{display:flex;align-items:center;padding:13px 2px;border-bottom:1px solid var(--line);font-size:11px}',
      '.qs-meta-row span{margin-left:auto;color:var(--muted);font-size:9px}',
      '.qs-switch-row{display:flex;align-items:center;gap:10px;padding:13px 2px;border-bottom:1px solid var(--line);font-size:11px;font-weight:700}',
      '.qs-switch-row input{accent-color:#a63b32;width:16px;height:16px}',
      '.qs-switch-row small{display:block;font-weight:400;color:var(--muted);font-size:9px;margin-top:2px}',
      /* 转发面板附言框 */
      '.qs-share-note{display:block;width:100%;min-height:64px;resize:none;border:1px solid var(--line);outline:0;padding:10px;background:#fffaf1;color:var(--ink);font:12px/1.6 inherit;margin-bottom:4px}',
      '.qs-share-note::placeholder{color:#aaa194}',
      /* 帷境来源卡 / 帖内图片 / 摘要条 */
      '.qs-wj-card{margin-top:12px;padding:10px 11px;border:1px dashed #aaa093;background:#eef0ea;cursor:pointer}',
      '.qs-wj-card .qs-wj-k{display:block;color:#315d68;font-size:9px;font-weight:800;letter-spacing:.12em}',
      '.qs-wj-card b{display:block;margin-top:4px;font:700 14px/1.4 "Songti SC","STSong",serif}',
      '.qs-wj-card small{display:block;margin-top:4px;color:var(--muted);font-size:9px;line-height:1.55}',
      '.qs-post-img{width:100%;height:180px;margin-top:10px;background:#e9e2d5 center/cover no-repeat;border:1px solid var(--line)}',
      '.qs-summary{margin-top:12px;padding:11px;border-left:3px solid #315d68;background:#e5e9e4;color:#504d46;font-size:9px;line-height:1.65}',
      '.qs-img-thumb{position:relative;width:74px;height:74px;border:1px solid var(--line);background:#e9e2d5 center/cover no-repeat}',
      '.qs-img-x{position:absolute;top:0;right:0;padding:1px 6px;background:rgba(37,35,31,.72);color:#f4f0e7;font-size:11px;cursor:pointer}',
      /* ---- 我的 ---- */
      '.qs-me-head{padding:20px 17px 14px;border-bottom:1px solid var(--ink);background:var(--paper2);display:flex;align-items:center;gap:12px}',
      '.qs-me-head .qs-avatar{width:46px;height:46px;font-size:16px}',
      '.qs-me-name{font-size:16px;font-weight:800}',
      '.qs-me-bio{margin-top:3px;color:var(--muted);font-size:10px}',
      '.qs-me-stats{display:flex;gap:22px;padding:12px 17px;border-bottom:1px solid var(--line);font-size:10px;color:var(--muted)}',
      '.qs-me-stats b{display:block;font-size:16px;color:var(--ink);font-family:Georgia,serif}',
      '.qs-group-label{margin:16px 0 4px;color:var(--red);font-size:9px;font-weight:800;letter-spacing:.16em}',
      '.qs-identity-option{width:100%;display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line);border-bottom:0;background:#faf6ee;text-align:left;color:var(--ink)}',
      '.qs-identity-option:last-of-type{border-bottom:1px solid var(--line)}',
      '.qs-identity-option.sel{border-color:var(--blue);box-shadow:inset 3px 0 var(--blue)}',
      '.qs-identity-option b{display:block;font-size:11px}',
      '.qs-identity-option small{display:block;margin-top:2px;color:var(--muted);font-size:8px}',
      '.qs-identity-option em{margin-left:auto;color:var(--blue);font-size:8px;font-style:normal}',
      /* ---- 通用 ---- */
      '.qs-sheet{position:absolute;inset:0;z-index:30;display:none;align-items:flex-end;background:rgba(28,25,21,.42)}',
      '.qs-sheet.show{display:flex}',
      '.qs-panel{width:100%;max-height:88vh;overflow:auto;padding:18px 18px calc(19px + env(safe-area-inset-bottom));border-top:2px solid var(--ink);background:var(--paper)}',
      '.qs-panel-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--ink);margin-bottom:6px}',
      '.qs-panel-head h2{margin:0;font:700 20px "Songti SC","STSong",serif}',
      '.qs-panel .qs-close{border:0;background:none;color:var(--muted)}',
      '.qs-choice{width:100%;display:flex;justify-content:space-between;padding:12px 2px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;color:var(--ink);font-size:13px}',
      '.qs-choice span{color:var(--muted);font-size:9px}',
      '.qs-err{margin:30px 22px;padding:22px;border:1px solid var(--line);border-radius:14px;text-align:center}',
      '.qs-err-t{font-size:15px;font-weight:600;margin-bottom:8px}',
      '.qs-err-d{font-size:12px;color:var(--muted);line-height:1.9}',
      /* 关注按钮（2026-10-11 关注补全） */
      '.qs-follow{border:1px solid var(--line);background:none;border-radius:999px;color:var(--ink);',
      'font-size:10px;padding:5px 12px;cursor:pointer;font-family:inherit;flex:0 0 auto;}',
      '.qs-follow.on{background:var(--paper);color:var(--muted);border-style:dashed;}',
      /* 返回条：一级页顶部那行小返回 */
      '.qs-backbar{padding:8px 14px 0;background:rgba(244,240,231,.96)}',
      '.qs-backbtn{border:0;background:none;color:var(--muted);font-size:12px;padding:4px 0}',
      /* 底栏未读点 */
      '.qs-nav button{position:relative}',
      '.qs-badge{position:absolute;top:0;right:14px;min-width:15px;height:15px;padding:0 4px;border-radius:99px;background:#a63b32;color:#f4f0e7;font-size:9px;font-weight:800;line-height:15px;text-align:center}',
      /* 消息中心条目 */
      '.qs-notice-item{display:flex;gap:9px;padding:13px 2px;border-bottom:1px solid var(--line);cursor:pointer}',
      '.qs-notice-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#315d68;margin-top:6px;visibility:hidden}',
      '.qs-notice-item.unread .qs-notice-dot{visibility:visible}',
      '.qs-notice-copy{flex:1;min-width:0}',
      '.qs-notice-copy b{font-size:12px}',
      '.qs-notice-copy p{margin:3px 0 0;color:#49453e;font-size:12px;line-height:1.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.qs-notice-copy small{display:block;margin-top:3px;color:var(--muted);font-size:9px}',
      '.qs-mark-read{border:0;background:none;color:var(--blue);font-size:10px;padding:2px 0}',
      /* 群声各页自带报头（demo 的报刊顶栏），项目默认的玻璃壳头隐藏
         —— 同 page[data-page="island"] 的先例（style.css:5408）。 */
      /* 通底色：三层壳全部刷成报纸底 —— 缝里不透出默认白/蓝底，
         也不会出现「页面内容奶油、边框另一色」的拼色感。 */
      '.page[data-page^="qunsheng"]{background:#f4f0e7;}',
      '.page[data-page^="qunsheng"] .page-inner{background:#f4f0e7;}',
      '.page[data-page^="qunsheng"] .app-body{background:#f4f0e7;}',
      /* ---- 2026-10-08 布局返修（用户反馈第 3 条）----
         ① 滚动归页内：.page 对群声关掉自身整页滚动，.app-body 变有界 flex
            容器，.qs-root 占满 —— 只有 .qs-main 滚，报头和底栏钉在原位。
         ② 边距收掉 page-inner 的左右 22px（报纸版式自己管边距，不再
            「内容挤在中间一条」）；顶部状态栏补偿保留，底部交给 .qs-nav
            自带的 safe-area。
         ③ 板块目录行加大字号行距（原来 11px/9px 太小太窄）。 */
      '.page[data-page^="qunsheng"]{overflow:hidden;}',
      '.page[data-page^="qunsheng"] .page-inner{height:100%;min-height:0;padding:calc(env(safe-area-inset-top) + 32px) 0 0;}',
      '.page[data-page^="qunsheng"] .app-body{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;}',
      '.qs-root{flex:1;min-height:0;width:100%;}',
      '.qs-main{padding:18px 18px 22px;}',
      '.qs-meta-row{padding:14px 2px;font-size:13px;}',
      '.qs-meta-row span{font-size:11px;}',
      '.qs-notice{font-size:11.5px;}',
      /* 论坛身份改名/头像（v218） */
      '.qs-id-row{display:flex;gap:8px;align-items:stretch;}',
      '.qs-id-row .qs-identity-option{flex:1;}',
      '.qs-id-edit{border:1px solid var(--line);background:none;border-radius:8px;font-size:10px;color:var(--muted);padding:0 10px;cursor:pointer;font-family:inherit;}',
      '.qs-id-editor{padding:12px 2px 10px;border-bottom:1px solid var(--line);}',
      '.qs-id-fields{display:flex;gap:8px;}',
      '.qs-id-input{flex:1;border:1px solid var(--line);background:#fff;border-radius:6px;padding:7px 9px;font-size:12px;font-family:inherit;color:#2b2620;}',
      '.qs-id-glyph{flex:0 0 52px;width:52px;text-align:center;}',
      '.qs-id-colors{display:flex;gap:7px;margin-top:10px;}',
      '.qs-id-colors button{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;}',
      '.qs-id-colors button.on{border-color:#2b2620;}',
      '.qs-id-save{margin-top:10px;border:0;border-radius:6px;background:#315d68;color:#f4f0e7;font-size:11px;padding:6px 16px;cursor:pointer;font-family:inherit;}',
      /* ---- 2026-10-10 用户反馈：壳头别再挂「群声」title ——
         群声各页自带报刊报头/顶栏 crumb（板块名就在那），默认玻璃壳头
         （app.js 372 行拿 def.title 填的「群声」）整条藏掉，缝也不占高。
         返回键页内自有 qs-backbar，不依赖壳头的 back-btn。 */
      '.page[data-page^="qunsheng"] .app-head{display:none;}',
      '.page[data-page^="qunsheng"] .page-inner{padding-top:calc(env(safe-area-inset-top) + 10px);}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ------------------------------ 工具 ------------------------------ */

  var KIND_LABEL = { isle: '孤岛', archipelago: '群岛' };

  /* v218：char 的脸 —— 非匿名的 char 身份贴他自己的头像（core.setAvatarBg，
     和聊天/朋友圈同一张「微信头像」）；匿名身份保持字母脸（匿）。
     pa 是 publicAuthorOf / publicAuthorOfComment 的公开投影，非匿名时带
     ownerType / ownerEntityId。贴图是异步的，has-img 类由 setAvatarBg 自己加。 */
  function paintFace(el, pa) {
    if (!el || !pa || pa.anonymous) return;
    if (pa.ownerType === 'char' && pa.ownerEntityId &&
        Sleepy.core && Sleepy.core.setAvatarBg && Sleepy.core.findChar) {
      var rec = Sleepy.core.findChar(pa.ownerEntityId);
      if (rec) Sleepy.core.setAvatarBg(el, rec);
    }
  }

  /* 论坛账号记录（forumAccounts 行）→ 能贴图的投影（作者主页/通知用） */
  function faceOfAccount(acc) {
    return acc ? { anonymous: false, ownerType: acc.ownerType,
      ownerEntityId: acc.ownerEntityId } : null;
  }

  /* 返回条：一级页（首页/板块/消息/我的）也要能回桌面 ——
     项目壳头被我按页藏了，返回键得自己长出来（user 2026-10-07 点名）。 */
  function backBar() {
    var bar = h('div', 'qs-backbar');
    var b = h('button', 'qs-backbtn', '‹ 返回');
    b.addEventListener('click', function () { Sleepy.nav.back(); });
    bar.appendChild(b);
    return bar;
  }

  function fmtTime(iso) {
    var t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    var diff = Date.now() - t.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 172800000) return '昨天';
    return (t.getMonth() + 1) + ' 月 ' + t.getDate() + ' 日';
  }

  function todayLine() {
    var d = new Date();
    var wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return { md: ('0' + (d.getMonth() + 1)).slice(-2) + ' / ' + ('0' + d.getDate()).slice(-2), wk: '星期' + wk };
  }

  function excerpt(s, n) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  var TYPE_LABEL = { normal: '', long: '长文', help: '求助' };

  /* 首页实例状态：tab 切换不换页，就地重渲染 feed。 */
  var homeState = { sandboxId: null, tab: 'mixed' };

  function errorRoot(message) {
    var root = h('div', 'qs-root');
    /* ⚠️ 错误态也必须自带返回键：项目壳头在这一族页是 display:none，
       没有它，任何「进不去/看不到」的空页面都变成一屏死路（退不出去）。 */
    root.appendChild(backBar());
    var box = h('div', 'qs-err');
    box.appendChild(h('div', 'qs-err-t', '进不去这个社区'));
    box.appendChild(h('div', 'qs-err-d', message + '。从分享卡或通知进来时，来源的岛可能已经被拆掉了。'));
    root.appendChild(box);
    return root;
  }

  /* 一样的道理：帖子/板块不在了这类错误盒，也得挂一枚返回键再返回。 */
  function errBox(title, detail) {
    var wrap = h('div', 'qs-root');
    wrap.appendChild(backBar());
    var box = h('div', 'qs-err');
    box.appendChild(h('div', 'qs-err-t', title));
    box.appendChild(h('div', 'qs-err-d', detail));
    wrap.appendChild(box);
    return wrap;
  }

  /* 五底栏（首页 / 板块 / 发布 / 消息 / 我的）。当前页高亮；
     消息位带未读点（按当前论坛身份算，切小号不互曝）。 */
  function bottomNav(active, fx) {
    var nav = h('nav', 'qs-nav');
    var go = function (id) {
      return function () { Sleepy.nav.open(id, { sandboxId: fx.sandboxId }); };
    };
    [['qunsheng', '首页'], ['qunsheng-boards', '板块']].forEach(function (x) {
      var b = h('button', x[0] === active ? 'on' : '', x[1]);
      b.addEventListener('click', go(x[0]));
      nav.appendChild(b);
    });
    var pub = h('button', 'qs-publish', '发布');
    pub.addEventListener('click', function () {
      Sleepy.nav.open('qunsheng-compose', { sandboxId: fx.sandboxId });
    });
    nav.appendChild(pub);
    var me0 = F().getSelectedForumAccount(fx.sandboxId);
    var unread = me0 ? F().unreadCount(fx.sandboxId, me0.id) : 0;
    var msgBtn = h('button', 'qunsheng-notices' === active ? 'on' : '', '消息');
    if (unread > 0) msgBtn.appendChild(h('span', 'qs-badge', unread > 9 ? '9+' : String(unread)));
    msgBtn.addEventListener('click', go('qunsheng-notices'));
    nav.appendChild(msgBtn);
    var meBtn = h('button', 'qunsheng-me' === active ? 'on' : '', '我的');
    meBtn.addEventListener('click', go('qunsheng-me'));
    nav.appendChild(meBtn);
    return nav;
  }

  /* 「@ ta 发帖」：让 char 自己刷论坛、自己决定发不发（forumGen.askCharToPost）。
     结构化动作 post/ignore —— ignore 也是合法结果（允许沉默，不硬凑）。 */
  function openCharPostSheet(fx, ctx) {
    var chars = fx.primaryCharIds.map(function (id) { return Sleepy.core.findChar(id); })
      .filter(Boolean);
    var root = document.createElement('div');
    root.className = 'qs-sheet';
    var panel = h('section', 'qs-panel');
    var phead = h('div', 'qs-panel-head');
    phead.appendChild(h('h2', null, '让谁去发帖'));
    var closeBtn = h('button', 'qs-close', '关闭');
    closeBtn.addEventListener('click', function () { root.remove(); });
    phead.appendChild(closeBtn);
    panel.appendChild(phead);
    panel.appendChild(h('div', 'qs-notice',
      'ta 会按自己的人设决定发不发、发什么 —— 也可能选择不发。'));
    chars.forEach(function (c) {
      var b = h('button', 'qs-identity-option');
      b.appendChild(h('div', 'qs-mini', c.name.charAt(0)));
      b.appendChild(h('b', null, c.name));
      b.addEventListener('click', function () {
        root.remove();
        Sleepy.toast('喊 ' + c.name + ' 去刷论坛了…');
        G().askCharToPost(fx.sandboxId, c.id, function (err, r) {
          if (err) {
            Sleepy.toast(err.stage === 'cooldown' ? err.error
              : '没发出来：' + (err.error || '还没有可用的模型连接'));
            return;
          }
          if (!r.posted) { Sleepy.toast(c.name + ' 刷了刷，暂时没想说什么'); return; }
          Sleepy.toast(c.name + ' 发了一帖《' + (r.post.title || '无标题') + '》');
        });
      });
      panel.appendChild(b);
    });
    root.appendChild(panel);
    root.addEventListener('click', function (e) { if (e.target === root) root.remove(); });
    if (ctx && ctx.body) ctx.body.appendChild(root);
    root.classList.add('show');
  }

  /* ------------------------------ 首页：杂响 ------------------------------ */

  function postCard(post, fx, opts) {
    var board = F().getBoard(post.boardId, fx.sandboxId);
    var pa = F().publicAuthorOf(post, post.authorAccountId, fx.sandboxId);
    var comments = F().listComments(post.id, fx.sandboxId);

    var card = h('article', 'qs-post');
    var meta = h('div', 'qs-meta');
    var av = h('div', 'qs-avatar', pa.avatarChar);
    paintFace(av, pa);
    meta.appendChild(av);
    var whoBox = h('div');
    whoBox.appendChild(h('div', 'qs-who', pa.displayName));
    var subLine = h('div', 'qs-sub',
      (board ? board.name : '社区') + ' · ' + fmtTime(post.createdAt));
    whoBox.appendChild(subLine);
    meta.appendChild(whoBox);
    /* 板块名可点：直接进板块主页（2026-10-08 板块主页轮） */
    if (board) {
      subLine.style.cursor = 'pointer';
      subLine.addEventListener('click', function (e) {
        e.stopPropagation();
        Sleepy.nav.open('qunsheng-board', { sandboxId: fx.sandboxId, boardId: board.id });
      });
    }
    /* 点作者名看 TA 的公开主页（匿名身份没有主页 —— 不串联不同帖的同一个人） */
    if (!pa.anonymous) {
      whoBox.style.cursor = 'pointer';
      whoBox.addEventListener('click', function (e) {
        e.stopPropagation();
        Sleepy.nav.open('qunsheng-author', { sandboxId: fx.sandboxId, accountId: pa.accountId });
      });
    }
    if (pa.anonymous) meta.appendChild(h('span', 'qs-tag', '匿名'));
    else if (TYPE_LABEL[post.postType]) meta.appendChild(h('span', 'qs-tag', TYPE_LABEL[post.postType]));
    /* 关注按钮（2026-10-11 关注补全）：非匿名 + 不是我自己的账号 */
    var meAcc = F().getSelectedForumAccount(fx.sandboxId);
    if (!pa.anonymous && (!meAcc || meAcc.id !== pa.accountId)) {
      var followBtn = h('button', 'qs-follow' + (F().isFollowing(fx.sandboxId, pa.accountId) ? ' on' : ''),
        F().isFollowing(fx.sandboxId, pa.accountId) ? '已关注' : '+ 关注');
      followBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var r = F().toggleFollow(fx.sandboxId, pa.accountId);
        followBtn.textContent = r.on ? '已关注' : '+ 关注';
        followBtn.className = 'qs-follow' + (r.on ? ' on' : '');
        Sleepy.toast(r.on ? '关注了 ' + pa.displayName : '取关了 ' + pa.displayName);
      });
      meta.appendChild(followBtn);
    }
    card.appendChild(meta);

    if (post.title) card.appendChild(h('h3', null, post.title));
    if (post.content) card.appendChild(h('p', 'qs-body-p', excerpt(post.content, 90)));

    if (comments.length) {
      var first = comments[0];
      var fpa = F().publicAuthorOfComment(post, first, fx.sandboxId);
      card.appendChild(h('div', 'qs-quote',
        fpa.displayName + '：' + excerpt(first.content, 60)));
    }

    var actions = h('div', 'qs-actions');
    actions.appendChild(h('button', null, '留声 ' + comments.length));
    actions.appendChild(h('button', null, '转发 ' + F().repostCount(post.id, fx.sandboxId)));
    card.appendChild(actions);

    card.addEventListener('click', function () {
      Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: post.id });
    });
    return card;
  }

  function renderHome(ctx, fx) {
    /* 换岛后 tab 状态不跨岛沿用（follow 空态会把人看糊涂） */
    if (homeState.sandboxId !== fx.sandboxId) {
      homeState.sandboxId = fx.sandboxId;
      homeState.tab = 'mixed';
    }
    var root = h('div', 'qs-root');

    /* ---- 报头 ---- */
    root.appendChild(backBar());
    var top = h('div', 'qs-top');
    var utility = h('div', 'qs-utility');
    var world = h('div', 'qs-world');
    world.appendChild(h('i'));
    world.appendChild(h('span', null, fx.sandboxName + ' · 公共社区'));
    utility.appendChild(world);
    var utilRight = h('div');
    utilRight.style.cssText = 'display:flex;gap:10px;align-items:center';
    var atBtn = h('button', 'qs-search', '@ ta 发帖');
    atBtn.addEventListener('click', function () { openCharPostSheet(fx, ctx); });
    utilRight.appendChild(atBtn);
    utility.appendChild(utilRight);
    top.appendChild(utility);

    var mast = h('div', 'qs-masthead');
    var name = h('div', 'qs-name');
    name.appendChild(h('h1', null, '众声喧哗'));
    name.appendChild(h('p', null, '群声 · 今日社区刊'));
    mast.appendChild(name);
    var dl = todayLine();
    var weather = h('div', 'qs-weather');
    weather.appendChild(h('strong', null, dl.md));
    weather.appendChild(h('span', null, dl.wk));
    mast.appendChild(weather);
    top.appendChild(mast);

    var tabs = h('nav', 'qs-tabs');
    [['mixed', '杂响'], ['follow', '关注'], ['latest', '最新']].forEach(function (x) {
      var b = h('button', 'qs-tab' + (homeState.tab === x[0] ? ' on' : ''), x[1]);
      b.addEventListener('click', function () {
        homeState.tab = x[0];
        rebuild();
      });
      tabs.appendChild(b);
    });
    top.appendChild(tabs);
    root.appendChild(top);

    /* ---- 内容流 ---- */
    var main = h('main', 'qs-main');

    var edition = h('div', 'qs-edition');
    edition.appendChild(h('span', null, '第 ' +
      (F().strHash(fx.sandboxId) % 900 + 100) + ' 期 · ' +
      ('0' + new Date().getHours()).slice(-2) + ':' + ('0' + new Date().getMinutes()).slice(-2) + ' 更新'));
    var refresh = h('button', 'qs-refresh', '催更');
    refresh.addEventListener('click', function () {
      refresh.disabled = true;
      refresh.textContent = '催更中…';      /* 无反馈=「按了没反应」：状态必须写在按钮上 */
      Sleepy.toast('正在喊大家开口…');
      function settle() {
        refresh.disabled = false;
        refresh.textContent = '催更';
      }
      function done(err, r) {
        settle();
        if (err) {
          Sleepy.toast(err.stage === 'cooldown' ? err.error
            : '催更失败：' + (err.error || '还没有可用的模型连接'));
          return;
        }
        renderHome(ctx, fx);
        if (r && r.created && r.created.posts) {
          Sleepy.toast('社区热闹起来了：' + r.created.posts + ' 帖 ' + r.created.comments + ' 条留声');
        } else {
          Sleepy.toast('没有更多新声了');
        }
      }
      /* 种过 → 增量补新帖；没种 → 先完整开张。
         同步异常兜底：不接住的话 settle 永不执行，按钮永久 disabled（2026-10-09 催更卡死修）。 */
      try {
        var seeded = F().getForumMap('forumSettingsBySandbox', fx.sandboxId);
        if (seeded && seeded.seeded) G().genMore(fx.sandboxId, done);
        else G().ensureSeedContent(fx.sandboxId, done);
      } catch (e) {
        done({ stage: 'error', error: String((e && e.message) || e) });
      }
    });
    edition.appendChild(refresh);
    main.appendChild(edition);

    /* 今日风闻：取最新一帖当「风闻」占位（worldEvents 是后续批） */
    var ticker = h('section', 'qs-ticker');
    ticker.appendChild(h('b', null, '今日风闻'));
    var newest = F().getHomeFeed('latest', null, 1, fx.sandboxId).items[0];
    ticker.appendChild(h('span', null, newest
      ? excerpt((newest.title ? newest.title + ' —— ' : '') + newest.content, 46)
      : '社区安静得很，还没有人开口。'));
    main.appendChild(ticker);

    /* 泡泡糖：快捷入口 = 去树洞匿名发一帖（今日话题是后续批） */
    var gum = h('section', 'qs-gum');
    gum.appendChild(h('div', 'qs-gum-head', [
      h('strong', null, '泡泡糖'),
      h('span', null, '匿名，化了就没')
    ]));
    gum.appendChild(h('h2', null, '说一句只有你们这个世界的人才看得懂的话。'));
    gum.appendChild(h('p', null, '不解释，不点名。看懂的人自然会来留声。'));
    gum.appendChild(h('div', 'qs-gum-foot', [
      h('span', null, '使用当前论坛身份参与'),
      h('span', null, '去树洞留一句 →')
    ]));
    gum.addEventListener('click', function () {
      var tree = F().listBoards(fx.sandboxId).filter(function (b) { return b.templateKey === 'treehole'; })[0];
      Sleepy.nav.open('qunsheng-compose', { sandboxId: fx.sandboxId, boardId: tree ? tree.id : '' });
    });
    main.appendChild(gum);

    main.appendChild(h('div', 'qs-section-title', '正在发出杂响'));

    var feed = F().getHomeFeed(homeState.tab, null, 12, fx.sandboxId);
    if (!feed.items.length) {
      var empty = h('div', 'qs-empty');
      empty.appendChild(h('div', 'qs-empty-big',
        homeState.tab === 'follow' ? '还没有关注任何人' : '杂响还没开始'));
      empty.appendChild(h('div', 'qs-empty-sub',
        '发一帖，或者点上面的「催更」\n让这座岛的居民先开口。'));
      main.appendChild(empty);
    } else {
      feed.items.forEach(function (p) { main.appendChild(postCard(p, fx)); });
      if (feed.hasMore) {
        main.appendChild(h('div', 'qs-empty', '（更多留声下一批接入无限滚动）'));
      }
    }
    root.appendChild(main);

    root.appendChild(bottomNav('qunsheng', fx));
    return root;
  }

  /* ------------------------------ 帖子详情 ------------------------------ */

  function renderPost(ctx, fx) {
    var post = F().getPost(ctx.params.postId, fx.sandboxId);
    var root = h('div', 'qs-root');
    if (!post || post.status !== 'active') {
      return errBox('帖子看不到了', '它可能已被作者删除，或来自别的社区。');
    }
    var board = F().getBoard(post.boardId, fx.sandboxId);
    var me = F().getSelectedForumAccount(fx.sandboxId);
    var comments = F().listComments(post.id, fx.sandboxId);

    /* ---- 顶栏 ---- */
    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var back = h('button', 'qs-iconbtn', '‹ 返回');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(back);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, board ? board.name : '社区'));
    crumb.appendChild(h('small', null, '众声喧哗 · 原帖'));
    topline.appendChild(crumb);
    var more = h('button', 'qs-textbtn', '更多');
    more.addEventListener('click', function () { Sleepy.toast('转发与更多操作在下一批接入'); });
    topline.appendChild(more);
    top.appendChild(topline);
    root.appendChild(top);

    /* 滚动层：之前这里把主楼/动作条/回复列表直接平铺在 flex 的 .qs-root 里，
       .qs-root 没有 overflow → 整屏被 .page 的 overflow:hidden 裁掉，往下推不动
       （只有用了 .qs-main 的首页/消息页能滚）。为主楼以下全部进滚动容器，
       底部回复框留在容器外面固定。 */
    var main = h('main', 'qs-main');

    /* ---- 主楼 ---- */
    var pa = F().publicAuthorOf(post, post.authorAccountId, fx.sandboxId);
    var detail = h('article', 'qs-detail');
    var meta = h('div', 'qs-meta');
    var dav = h('div', 'qs-avatar', pa.avatarChar);
    paintFace(dav, pa);
    meta.appendChild(dav);
    var whoBox = h('div');
    whoBox.appendChild(h('div', 'qs-who', pa.displayName));
    whoBox.appendChild(h('div', 'qs-sub', fmtTime(post.createdAt) + ' · ' + fx.sandboxName));
    meta.appendChild(whoBox);
    if (pa.anonymous) meta.appendChild(h('span', 'qs-tag', '单帖匿名'));
    detail.appendChild(meta);
    if (post.title) detail.appendChild(h('h1', null, post.title));

    /* 正文渲染（v216）：带 fanwork 结构的按章节分节 + 每段独立成段；
       普通帖维持原来的整块 pre-wrap（ retain 原有观感）。 */
    function renderBody(target) {
      var fw = post.fanwork;
      if (fw && fw.chapters && fw.chapters.length) {
        fw.chapters.forEach(function (ch, i) {
          var sec = h('section', 'qs-fw-chapter');
          if (fw.chapters.length > 1) {
            sec.appendChild(h('h3', null, '第 ' + (ch.n || (i + 1)) + ' 节 · ' + (ch.title || '无题')));
          }
          (ch.paras || []).forEach(function (t) { sec.appendChild(h('p', 'qs-fw-p', t)); });
          if (ch.heard && ch.heard.length) {
            sec.appendChild(h('div', 'qs-fw-heard', '作者听进去的建议：' + ch.heard.join(' / ')));
          }
          target.appendChild(sec);
        });
      } else {
        target.appendChild(h('div', 'qs-detail-body', post.content));
      }
    }
    renderBody(detail);

    /* 追更：同人连载一次一节（作者在模型侧自己挑要不要采纳读者留言） */
    if (post.fanwork) {
      var moreBtn = h('button', 'qs-more-btn', '✎ 追更下一节');
      moreBtn.addEventListener('click', function () {
        moreBtn.disabled = true;
        moreBtn.textContent = '作者正在写…';
        G().continueFanwork(post.id, function (err, r) {
          moreBtn.disabled = false;
          moreBtn.textContent = '✎ 追更下一节';
          if (err) {
            Sleepy.toast('这次没续出来：' + (err.error || '还没有可用的模型连接'), 'err');
            return;
          }
          Sleepy.toast(r.heard ? ('续了一节（听取了 ' + r.heard + ' 条建议）') : '续了一节');
          rebuild();
        });
      });
      detail.appendChild(moreBtn);
      detail.appendChild(h('small', 'qs-fw-heard',
        '追更时最近的读者留言会交给作者过目 —— 但听不听、听哪几条由作者自己决定，不必每条都照做。'));
    }

    /* 帷境作品来源卡（施工单 §E-1）：只展示公开投影；
       真实性标记必须显眼 —— 读到 ≠ 情节属实（总纲 §十一.4）。 */
    if (post.sourceType === 'wjWork' && post.sourceRef) {
      var wjc = h('div', 'qs-wj-card');
      wjc.appendChild(h('span', 'qs-wj-k', '帷境作品'));
      wjc.appendChild(h('b', null, post.sourceRef.publicTitle || '未命名剧本'));
      var canon = (Sleepy.wj && Sleepy.wj.REALITY_LABEL &&
        Sleepy.wj.REALITY_LABEL[post.sourceRef.canonStatus]) || post.sourceRef.canonStatus || '';
      wjc.appendChild(h('small', null, '真实性：' + canon +
        (post.sourceRef.chapterCount ? ' · ' + post.sourceRef.chapterCount + ' 章' : '') +
        '。作品情节不自动成为任何人的亲历记忆。'));
      wjc.addEventListener('click', function () {
        Sleepy.nav.open('wj-read', { id: post.sourceId });
      });
      detail.appendChild(wjc);
    }

    /* 图片（施工单 §E-2）：本体在图库，mediaId 现取 objectURL；
       取不到（图库清过）就整块不显示，不留破图。 */
    (post.assetRefs || []).forEach(function (mid) {
      var pic = h('div', 'qs-post-img');
      Sleepy.media.url(mid).then(function (u) {
        if (!u) { if (pic.parentNode) pic.parentNode.removeChild(pic); return; }
        pic.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
      });
      detail.appendChild(pic);
    });

    detail.appendChild(h('div', 'qs-stats', [
      '阅读 ' + (F().strHash(post.id) % 2000 + 100),
      '留声 ' + comments.length,
      '收藏 ' + F().countOf('forumCollections', 'post', post.id, fx.sandboxId)
    ]));
    main.appendChild(detail);

    /* ---- 动作条（转发占位 → Batch C）---- */
    var actions = h('div', 'qs-post-actions');
    var liked = F().hasInteract('forumLikes', 'post', post.id, me ? me.id : null);
    var likeBtn = h('button', liked ? 'on' : '', (liked ? '已同感 ' : '有同感 ') +
      F().countOf('forumLikes', 'post', post.id, fx.sandboxId));
    likeBtn.addEventListener('click', function () {
      if (!me) { Sleepy.toast('还没有论坛身份'); return; }
      F().toggleLike('post', post.id, me.id);
      rebuild();
    });
    actions.appendChild(likeBtn);

    var replyBtn = h('button', null, '回复');
    replyBtn.addEventListener('click', function () {
      var input = root.querySelector('.qs-input-wrap textarea');
      if (input && input.focus) input.focus();
    });
    actions.appendChild(replyBtn);

    var repostBtn = h('button', null, '转发');
    repostBtn.addEventListener('click', function () {
      if (!me) { Sleepy.toast('还没有论坛身份'); return; }
      openShareSheet(ctx, post, fx, me);
    });
    actions.appendChild(repostBtn);

    var saved = F().hasInteract('forumCollections', 'post', post.id, me ? me.id : null);
    var saveBtn = h('button', saved ? 'on' : '', saved ? '已收藏' : '收藏');
    saveBtn.addEventListener('click', function () {
      if (!me) { Sleepy.toast('还没有论坛身份'); return; }
      var r = F().toggleCollection('post', post.id, me.id);
      Sleepy.toast(r.on ? '已收藏到默认收藏夹' : '已取消收藏');
      rebuild();
    });
    actions.appendChild(saveBtn);
    main.appendChild(actions);

    main.appendChild(h('div', 'qs-notice',
      pa.anonymous
        ? '匿名只隐藏公开身份。回复区不会展示真实账号，也不会因转发暴露作者。'
        : '公开身份发言。你的回复会以当前论坛身份出现。'));

    /* ---- 回复头：排序 + 只看楼主 + 催一下 ---- */
    var replyHead = h('div', 'qs-reply-head');
    var rt = h('div', 'qs-reply-title');
    rt.appendChild(h('h2', null, '全部留声'));
    rt.appendChild(h('span', null, comments.length + ' 条'));
    replyHead.appendChild(rt);
    var filters = h('div', 'qs-filters');
    var sort = { v: 'hot' };
    var ownerOnly = { v: false };
    [['hot', '热门'], ['latest', '最新']].forEach(function (x) {
      var b = h('button', sort.v === x[0] ? 'on' : '', x[1]);
      b.addEventListener('click', function () {
        sort.v = x[0];
        rebuild();
      });
      filters.appendChild(b);
    });
    var ownerBtn = h('button', 'owner-filter', '只看楼主');
    ownerBtn.addEventListener('click', function () {
      ownerOnly.v = !ownerOnly.v;
      rebuild();
    });
    filters.appendChild(ownerBtn);
    replyHead.appendChild(filters);
    main.appendChild(replyHead);

    var poke = h('button', 'qs-poke', '催一下 —— 让可能看到这帖的人开口');
    poke.addEventListener('click', function () {
      poke.disabled = true;
      poke.textContent = '去喊人了…';
      G().requestReplies(post.id, function (err, r) {
        if (err) {
          Sleepy.toast(err.stage === 'cooldown' ? err.error
            : '没喊动人：' + (err.error || '还没有可用的模型连接'));
        } else {
          Sleepy.toast(r.added ? '来了 ' + r.added + ' 条新留声' : '大家这会儿都没话说');
        }
        rebuild();
      });
    });
    main.appendChild(poke);

    /* ---- 回复列表：根评论 + 局部对话枝 ---- */
    var list = h('section', 'qs-comment-list');
    var roots = comments.filter(function (c) { return !c.parentId; });
    var sorted = roots.slice().sort(function (a, b) {
      if (sort.v === 'hot') {
        var ha = F().countOf('forumLikes', 'comment', a.id, fx.sandboxId);
        var hb = F().countOf('forumLikes', 'comment', b.id, fx.sandboxId);
        if (ha !== hb) return hb - ha;
      }
      return a.createdAt < b.createdAt ? 1 : -1;
    });

    function commentEl(c, floorNo) {
      var cpa = F().publicAuthorOfComment(post, c, fx.sandboxId);
      var children = comments.filter(function (x) { return x.rootCommentId === c.id && x.parentId; });
      var el = h('article', 'qs-comment');
      var cm = h('div', 'qs-cmain');
      var cav = h('div', 'qs-mini', cpa.avatarChar);
      paintFace(cav, cpa);
      cm.appendChild(cav);
      var cc = h('div', 'qs-ccontent');
      var cw = h('div', 'qs-cwho');
      cw.appendChild(document.createTextNode(cpa.displayName));
      if (c.isPostAuthor) cw.appendChild(h('span', 'qs-owner-badge', cpa.anonymous ? '楼主' : '楼主'));
      cw.appendChild(h('span', 'qs-floor', floorNo + ' 楼'));
      cc.appendChild(cw);
      cc.appendChild(h('p', 'qs-ctext', c.content));
      cc.appendChild(h('div', 'qs-cinfo', fmtTime(c.createdAt)));
      var ca = h('div', 'qs-cact');
      var cl = h('button', F().hasInteract('forumLikes', 'comment', c.id, me ? me.id : null) ? 'on' : '',
        '同感 ' + F().countOf('forumLikes', 'comment', c.id, fx.sandboxId));
      cl.addEventListener('click', function () {
        if (!me) { Sleepy.toast('还没有论坛身份'); return; }
        F().toggleLike('comment', c.id, me.id);
        rebuild();
      });
      ca.appendChild(cl);
      var cr = h('button', null, '回复');
      cr.addEventListener('click', function () {
        target.v = cpa.displayName;
        target.parentId = c.id;
        applyTarget();
      });
      ca.appendChild(cr);
      cc.appendChild(ca);
      cm.appendChild(cc);
      el.appendChild(cm);

      if (children.length) {
        var branch = h('div', 'qs-branch');
        children.slice(0, 4).forEach(function (x) {
          var bpa = F().publicAuthorOfComment(post, x, fx.sandboxId);
          var item = h('div', 'qs-branch-item');
          item.appendChild(h('b', null, bpa.displayName));
          item.appendChild(document.createTextNode('：' + x.content));
          item.appendChild(h('span', 'qs-bmeta', fmtTime(x.createdAt)));
          branch.appendChild(item);
        });
        el.appendChild(branch);
      }
      return el;
    }

    var target = { v: '', parentId: null };
    sorted.forEach(function (c, i) {
      if (ownerOnly.v && c.authorAccountId !== post.authorAccountId) return;
      list.appendChild(commentEl(c, i + 1));
    });
    if (!list.children.length) {
      list.appendChild(h('div', 'qs-empty',
        ownerOnly.v ? '楼主暂时没有单独发布更多回复。' : '还没有人留声。点下面的输入框说第一句。'));
    }
    main.appendChild(list);

    root.appendChild(main);

    /* ---- 底部回复框 ---- */
    var composer = h('footer', 'qs-composer');
    var targetRow = h('div', 'qs-target');
    var targetText = h('span');
    var cancelTarget = h('button', null, '取消');
    targetRow.appendChild(targetText);
    targetRow.appendChild(cancelTarget);
    composer.appendChild(targetRow);
    var row = h('div', 'qs-compose-row');
    row.appendChild(h('div', 'qs-identity-chip', me ? me.displayName.charAt(0) : '我'));
    var wrap = h('div', 'qs-input-wrap');
    var input = document.createElement('textarea');
    input.rows = 1;
    input.maxLength = 280;
    input.placeholder = me ? '以「' + me.displayName + '」留下你的声音' : '先去「我的」领一个论坛身份';
    wrap.appendChild(input);
    row.appendChild(wrap);
    var send = h('button', 'qs-send', '发布');
    send.disabled = true;
    row.appendChild(send);
    composer.appendChild(row);
    root.appendChild(composer);

    function applyTarget() {
      targetRow.classList.toggle('show', !!target.v);
      targetText.textContent = target.v ? '回复 ' + target.v : '';
    }
    applyTarget();
    cancelTarget.addEventListener('click', function () {
      target.v = ''; target.parentId = null; applyTarget();
    });
    input.addEventListener('input', function () {
      send.disabled = !input.value.trim();
    });
    send.addEventListener('click', function () {
      var text = input.value.trim();
      if (!text) return;
      if (!me) { Sleepy.toast('还没有论坛身份'); return; }
      var r = F().createComment({
        sandboxId: fx.sandboxId, postId: post.id, accountId: me.id,
        parentCommentId: target.parentId, content: text
      });
      if (!r.ok) { Sleepy.toast(r.message || '发不出去'); return; }
      input.value = '';
      target.v = ''; target.parentId = null;
      /* user 开口后自动进队列：这帖可能引来 char/居民的回应（B 批交付的活人感） */
      G().queueReplies(post.id, 4000);
      rebuild();
      Sleepy.toast('回复已发布');
    });

    return root;
  }

  /* ------------------------------ 发帖与身份选择 ------------------------------ */

  /* v216：代笔开关 + 题材必须活在 render 外面 —— renderCompose 里的 state 是
     每次重建都new一份的局部对象，放在里面的话 rebuild（切换/贴图/切身份）一照面
     就把勾选状态冲回默认。同页里 homeState / ownerOnly 都是这个道理。 */
  var composeGW = { on: false, topic: '' };

  function renderCompose(ctx, fx) {
    var root = h('div', 'qs-root');
    var boards = F().listBoards(fx.sandboxId);
    var owned = F().listOwnedForumAccounts(fx.sandboxId, fx.userEntityId);
    var me = F().getSelectedForumAccount(fx.sandboxId);

    var state = {
      boardId: ctx.params.boardId ||
        (F().getBoard(ctx.params.boardId, fx.sandboxId) ? ctx.params.boardId : '') ||
        (boards[0] ? boards[0].id : ''),
      type: 'normal',
      anonymous: false,
      ghostwrite: composeGW.on,   /* v216：同人创作板块「请人代笔写一篇」（真写正文） */
      accountId: me ? me.id : null,
      workId: null,          /* 帷境作品引用（Batch E） */
      mediaIds: []           /* 图片附件 mediaId（Batch E，首版单图也走数组） */
    };

    /* ---- 顶栏 ---- */
    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var back = h('button', 'qs-iconbtn', '‹ 返回');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(back);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, '发布新帖'));
    crumb.appendChild(h('small', null, fx.sandboxName + ' · 群声'));
    topline.appendChild(crumb);
    var send = h('button', 'qs-textbtn', '发布');
    send.style.color = '#a63b32';
    send.style.fontWeight = '800';
    topline.appendChild(send);
    top.appendChild(topline);
    root.appendChild(top);

    var main = h('main', 'qs-main');

    /* ---- 身份卡 ---- */
    var identity = h('div', 'qs-identity-card');
    function identityNode(acc) {
      var n = h('div', 'qs-identity-card');
      var nav = h('div', 'qs-avatar', acc ? acc.displayName.charAt(0) : '我');
      paintFace(nav, faceOfAccount(acc));
      n.appendChild(nav);
      var copy = h('div', 'qs-identity-copy');
      copy.appendChild(h('small', null, '当前论坛身份 · ' + fx.sandboxName));
      copy.appendChild(h('b', null, acc ? acc.displayName : '还没有论坛身份'));
      n.appendChild(copy);
      return n;
    }
    identity = identityNode(me);
    identity.addEventListener('click', function () {
      var sheet = root.querySelector('.qs-sheet');
      var body = sheet.querySelector('.qs-sheet-body');
      body.innerHTML = '';
      body.appendChild(h('div', 'qs-group-label', '选择论坛身份'));
      owned.forEach(function (a) {
        var opt = h('button', 'qs-identity-option' + (state.accountId === a.id ? ' sel' : ''));
        opt.appendChild(h('div', 'qs-mini', a.displayName.charAt(0)));
        var txt = h('div');
        txt.appendChild(h('b', null, a.displayName));
        txt.appendChild(h('small', null,
          (a.accountType === 'main' ? '主账号' : '小号') + ' · ' + (a.bio || ' ')));
        opt.appendChild(txt);
        if (state.accountId === a.id) opt.appendChild(h('em', null, '当前'));
        opt.addEventListener('click', function () {
          state.accountId = a.id;
          sheet.classList.remove('show');
          rebuild();
        });
        body.appendChild(opt);
      });
      sheet.classList.add('show');
    });
    main.appendChild(identity);
    main.appendChild(h('div', 'qs-anon-state show',
      '发帖与回复默认使用你在这座岛选中的论坛身份。大小号之间互不公开关联。'));

    /* ---- 帖子类型 ---- */
    var types = h('div', 'qs-types');
    [['normal', '普通帖'], ['long', '长文'], ['help', '求助'], ['vote', '投票'], ['work', '帷境作品']]
      .forEach(function (x) {
        var on = state.type === x[0] ||
          (x[0] === 'work' && state.type === 'work' && state.workId);
        var b = h('button', 'qs-type' + (on ? ' on' : ''), x[1]);
        b.addEventListener('click', function () {
          if (x[0] === 'vote') { Sleepy.toast('投票在后续批次接入'); return; }
          if (x[0] === 'work') { openWorkPicker(); return; }
          state.type = x[0];
          rebuild();
        });
        types.appendChild(b);
      });
    main.appendChild(types);

    /* 帷境作品选择（施工单 §E-1）：只列已开帷（非 draft）的作品，
       投影只带公开层 —— 选角表 / 取材 / 手记不进论坛。 */
    function openWorkPicker() {
      var works = (Sleepy.wj && Sleepy.wj.all ? Sleepy.wj.all() : [])
        .filter(function (w) { return w.status !== 'draft'; });
      var sheet = root.querySelector('.qs-sheet');
      var body = sheet.querySelector('.qs-sheet-body');
      body.innerHTML = '';
      body.appendChild(h('div', 'qs-group-label', '选择帷境作品（公开层）'));
      if (!works.length) {
        body.appendChild(h('div', 'qs-empty', '帷境里还没有开过帷的作品。'));
      }
      works.forEach(function (w) {
        var proj = Sleepy.forumShare.wjProjection(w.id);
        if (!proj) return;
        var opt = h('button', 'qs-identity-option' + (state.workId === w.id ? ' sel' : ''));
        var txt = h('div');
        txt.appendChild(h('b', null, proj.publicTitle));
        txt.appendChild(h('small', null,
          (Sleepy.wj.REALITY_LABEL[proj.canonStatus] || proj.canonStatus) +
          ' · ' + proj.chapterCount + ' 章'));
        opt.appendChild(txt);
        if (state.workId === w.id) opt.appendChild(h('em', null, '已选'));
        opt.addEventListener('click', function () {
          state.workId = w.id;
          state.type = 'work';
          sheet.classList.remove('show');
          rebuild();
        });
        body.appendChild(opt);
      });
      sheet.classList.add('show');
    }
    main.appendChild(types);

    /* ---- 编辑器 ---- */
    var editor = h('div', 'qs-editor');
    var titleInput = document.createElement('input');
    titleInput.className = 'qs-title-input';
    titleInput.placeholder = '标题（可以留空）';
    titleInput.maxLength = 60;
    editor.appendChild(titleInput);
    var bodyInput = document.createElement('textarea');
    bodyInput.className = 'qs-body-input';
    bodyInput.placeholder = '正文。说给这座岛听。';
    editor.appendChild(bodyInput);
    var atts = h('div', 'qs-attachments');
    /* 图片（施工单 §E-2）：本体进图库（media.put），帖子只存 mediaId。
       首版最多 3 张；私密相册元数据不复制。 */
    var imgBtn = h('button', null, '+ 图片' + (state.mediaIds.length ? '（' + state.mediaIds.length + '）' : ''));
    imgBtn.addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.style.display = 'none';
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f || !Sleepy.media || !Sleepy.media.put) return;
        Sleepy.media.put(f, { kind: 'image', name: f.name }).then(function (rec) {
          if (rec && rec.id && state.mediaIds.length < 3) {
            state.mediaIds.push(rec.id);
            rebuild();
          }
        })['catch'](function () { Sleepy.toast('图片存不进图库'); });
      });
      document.body.appendChild(inp);
      inp.click();
      setTimeout(function () { if (inp.parentNode) inp.parentNode.removeChild(inp); }, 500);
    });
    atts.appendChild(imgBtn);
    var voteBtn = h('button', null, '+ 投票');
    voteBtn.addEventListener('click', function () { Sleepy.toast('投票在后续批次接入'); });
    atts.appendChild(voteBtn);
    var workBtn = h('button', null, '+ 帷境作品');
    workBtn.addEventListener('click', openWorkPicker);
    atts.appendChild(workBtn);
    var placeBtn = h('button', null, '+ 地点');
    placeBtn.addEventListener('click', function () { Sleepy.toast('地点在后续批次接入'); });
    atts.appendChild(placeBtn);
    editor.appendChild(atts);

    main.appendChild(editor);

    /* ---- v216：同人创作板块「请人代笔写一篇」 ----
       以前 fanwork 只是普通编辑器，写出来的自然是「聊创作」的短帖，
       用户以为这个板块会真的产出一篇同人 —— 现在给一条真会写正文的路：
       一次一整篇，分好自然段，发布后还能在详情页「追更」。 */
    var gwTopic = null;
    if (state.ghostwrite) {
      editor.style.display = 'none';
      var gwBox = h('div', 'qs-gw-box');
      gwBox.appendChild(h('div', 'qs-gw-title', '代笔一篇'));
      gwBox.appendChild(h('small', null,
        '交给岛上写同人的手替你成稿：一次一整篇、分好自然段；写完会以你的论坛身份发在同人创作板块。'));
      gwTopic = document.createElement('textarea');
      gwTopic.className = 'qs-topic-input';
      gwTopic.rows = 3;
      gwTopic.placeholder = '想看什么？（题材 / 谁和谁 / 什么情境 / 甜还是刀；留空就由作者自己选题）';
      gwTopic.value = composeGW.topic || '';
      gwTopic.addEventListener('input', function () { composeGW.topic = gwTopic.value; });
      gwBox.appendChild(gwTopic);
      gwBox.appendChild(h('small', null, '不满意可以不发；发了之后详情页能继续追更。'));
      main.appendChild(gwBox);
    }
    var gwBtn = h('button', 'qs-gw-btn', state.ghostwrite ? '× 还是自己写' : '✎ 请人代笔写一篇');
    gwBtn.addEventListener('click', function () {
      composeGW.on = !composeGW.on;
      rebuild();
    });
    main.appendChild(gwBtn);

    /* 已选图片预览 + 帷境引用条 */
    if (state.mediaIds.length) {
      var prev = h('div', 'qs-attachments');
      state.mediaIds.forEach(function (mid, i) {
        var thumb = h('div', 'qs-img-thumb');
        thumb.dataset.mid = mid;
        Sleepy.media.url(mid).then(function (u) {
          if (u) thumb.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
        });
        var x = h('span', 'qs-img-x', '×');
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          state.mediaIds.splice(i, 1);
          rebuild();
        });
        thumb.appendChild(x);
        prev.appendChild(thumb);
      });
      main.appendChild(prev);
    }
    if (state.type === 'work' && state.workId) {
      var proj0 = Sleepy.forumShare.wjProjection(state.workId);
      if (proj0) {
        main.appendChild(h('div', 'qs-summary',
          '引用帷境作品：《' + proj0.publicTitle + '》· ' +
          (Sleepy.wj.REALITY_LABEL[proj0.canonStatus] || proj0.canonStatus) +
          '。只有公开层会进论坛；选角表与创作手记不会。'));
      }
    }

    /* ---- 板块 ---- */
    var boardRow = h('div', 'qs-meta-row');
    boardRow.appendChild(h('b', null, '发布到'));
    var boardSel = document.createElement('select');
    boardSel.style.cssText = 'margin-left:auto;border:0;background:transparent;color:#315d68;font-size:11px;outline:0';
    boards.forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name;
      if (b.id === state.boardId) opt.selected = true;
      boardSel.appendChild(opt);
    });
    boardRow.appendChild(boardSel);
    main.appendChild(boardRow);

    /* ---- 匿名开关 ---- */
    var anonRow = h('div', 'qs-switch-row');
    var anonChk = document.createElement('input');
    anonChk.type = 'checkbox';
    anonRow.appendChild(anonChk);
    var anonTxt = h('div');
    anonTxt.appendChild(document.createTextNode('单帖匿名'));
    anonTxt.appendChild(h('small', null, '只隐藏这一帖的公开作者信息；系统内部保留账号用于管理与通知。'));
    anonRow.appendChild(anonTxt);
    main.appendChild(anonRow);

    main.appendChild(h('div', 'qs-notice',
      '发布后：树洞以外的帖子也可能被岛上其他人和街坊看到。匿名帖请放心说，公开身份不会泄露。'));

    root.appendChild(main);

    /* ---- 身份选择 sheet ---- */
    var sheet = h('div', 'qs-sheet');
    var panel = h('section', 'qs-panel');
    var phead = h('div', 'qs-panel-head');
    phead.appendChild(h('h2', null, '论坛身份'));
    var closeBtn = h('button', 'qs-close', '关闭');
    closeBtn.addEventListener('click', function () { sheet.classList.remove('show'); });
    phead.appendChild(closeBtn);
    panel.appendChild(phead);
    panel.appendChild(h('div', 'qs-sheet-body'));
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.classList.remove('show'); });
    root.appendChild(sheet);

    /* ---- 发布 ---- */
    send.addEventListener('click', function () {
      var acc = owned.filter(function (a) { return a.id === state.accountId; })[0] || me;
      if (!acc) { Sleepy.toast('先在身份卡里领一个论坛身份'); return; }
      if (state.ghostwrite) { writeGhost(acc); return; }

      /* v216：同人创作代笔 —— 一次调用写一整篇（真的产出正文，不是聊进度） */
      function writeGhost(useAcc) {
        send.disabled = true;
        send.textContent = '写着…';
        G().writeFanwork(fx.sandboxId, {
          accountId: useAcc.id, anonymous: anonChk.checked,
          topic: gwTopic ? gwTopic.value.trim() : ''
        }, function (err, r) {
          send.disabled = false;
          send.textContent = '发布';
          if (err) {
            Sleepy.toast('没写出来：' + (err.error || '还没有可用的模型连接') +
              (err.stage === 'cooldown' ? '' : '，可以再试一次'), 'err');
            return;
          }
          Sleepy.toast('写好了，' + r.paras + ' 段');
          Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: r.post.id });
        });
      }
      var opt = {
        sandboxId: fx.sandboxId,
        boardId: boardSel.value,
        accountId: acc.id,
        anonymous: anonChk.checked,
        postType: state.type,
        title: titleInput.value,
        content: bodyInput.value,
        assetRefs: state.mediaIds.slice()
      };
      if (state.type === 'work' && state.workId) {
        var proj = Sleepy.forumShare.wjProjection(state.workId);
        if (!proj) { Sleepy.toast('这部作品不能进论坛'); return; }
        opt.sourceType = 'wjWork';
        opt.sourceId = proj.sourceWorkId;
        opt.sourceRef = proj;      /* 公开投影：标题/真实性/章节数，无选角无手记 */
      }
      var r = F().createPost(opt);
      if (!r.ok) { Sleepy.toast(r.message || '发不出去'); return; }
      /* 自动队列：几秒后可能有 char / 居民来回应（活人感） */
      G().queueReplies(r.post.id, 4000);
      Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: r.post.id });
    });

    return root;
  }

  /* ------------------------------ 转发面板（Batch C） ------------------------------ */

  /* 转发 = 两类行为不混（总纲 §六）：公开转帖（forumReposts，只存引用）
     与定向分享（私聊 / 群聊，统一 payload 走 Sleepy.forumShare）。
     朋友圈引用是 Batch E，这里留占位。 */
  function openShareSheet(ctx, post, fx, me) {
    var FS = Sleepy.forumShare;
    var targets = FS.listTargets(fx.sandboxId);
    var root = document.createElement('div');
    root.className = 'qs-sheet';
    var panel = h('section', 'qs-panel');
    var phead = h('div', 'qs-panel-head');
    phead.appendChild(h('h2', null, '转发帖子'));
    var closeBtn = h('button', 'qs-close', '关闭');
    closeBtn.addEventListener('click', function () { root.remove(); });
    phead.appendChild(closeBtn);
    panel.appendChild(phead);

    /* 附言 */
    panel.appendChild(h('div', 'qs-group-label', '附上一句话（可留空）'));
    var note = document.createElement('textarea');
    note.className = 'qs-share-note';
    note.maxLength = 140;
    note.placeholder = '写点什么再说…（匿名帖转发后仍是匿名）';
    panel.appendChild(note);

    function sendTo(target) {
      var r;
      if (target.kind === 'chat') {
        r = FS.shareToChat({
          sandboxId: fx.sandboxId, postId: post.id, chatId: target.id,
          senderAccountId: me.id, attachedText: note.value
        });
      } else {
        var member = (Sleepy.groupStore.userAccountsOf(target.id)[0] || {});
        r = FS.shareToGroup({
          sandboxId: fx.sandboxId, postId: post.id, groupId: target.id,
          senderAccountId: me.id, groupMemberAccountId: member.accountId || null,
          attachedText: note.value
        });
      }
      if (!r.ok) {
        Sleepy.toast(
          r.reason === 'deleted' ? '原帖已由作者删除' :
          r.reason === 'blocked' ? '该帖子已被封禁' :
          r.reason === 'no-repost' ? '作者关闭了转发' :
          r.reason === 'no-perm' ? '这个帖子不允许被分享' :
          r.reason === 'bad-target' ? '这个会话不在这座岛上' : '发不出去');
        return;
      }
      root.remove();
      rebuild();
      Sleepy.toast(r.dup ? '已经分享过了，再发了一份' : '已发给「' + target.name + '」');
    }

    /* 公开转帖 */
    panel.appendChild(h('div', 'qs-group-label', '公开转发'));
    var rep = h('button', 'qs-choice');
    rep.appendChild(document.createTextNode('转发到我的主页'));
    rep.appendChild(h('span', null, '进入关注者信息流'));
    rep.addEventListener('click', function () {
      var r = FS.repostToProfile({
        sandboxId: fx.sandboxId, postId: post.id,
        senderAccountId: me.id, attachedText: note.value
      });
      if (!r.ok) {
        Sleepy.toast(
          r.reason === 'deleted' ? '原帖已由作者删除' :
          r.reason === 'no-repost' ? '作者关闭了转发' : '转不了');
        return;
      }
      root.remove();
      Sleepy.toast(r.dup ? '主页上已经转过一回了' : '已转到主页');
    });
    panel.appendChild(rep);

    var moments = h('button', 'qs-choice');
    moments.appendChild(document.createTextNode('分享到朋友圈'));
    moments.appendChild(h('span', null, '公开引用 · 评论不写回'));
    moments.addEventListener('click', function () {
      var r = FS.shareToMoments({
        sandboxId: fx.sandboxId, postId: post.id,
        senderAccountId: me.id, attachedText: note.value
      });
      if (!r.ok) {
        Sleepy.toast(
          r.reason === 'deleted' ? '原帖已由作者删除' :
          r.reason === 'no-repost' ? '作者关闭了转发' : '分享不了');
        return;
      }
      root.remove();
      Sleepy.toast(r.dup ? '朋友圈已经分享过一回了' : '已分享到朋友圈');
    });
    panel.appendChild(moments);

    /* 定向分享 */
    panel.appendChild(h('div', 'qs-group-label', '发给别人（仅这座岛的会话）'));
    if (!targets.chats.length && !targets.groups.length) {
      panel.appendChild(h('div', 'qs-empty', '这座岛还没有可发的会话。'));
    }
    targets.chats.forEach(function (t) {
      var b = h('button', 'qs-choice');
      b.appendChild(document.createTextNode('私聊 · ' + t.name));
      b.appendChild(h('span', null, '发送'));
      b.addEventListener('click', function () { sendTo(t); });
      panel.appendChild(b);
    });
    targets.groups.forEach(function (t) {
      var b = h('button', 'qs-choice');
      b.appendChild(document.createTextNode('群聊 · ' + t.name));
      b.appendChild(h('span', null, '发送'));
      b.addEventListener('click', function () { sendTo(t); });
      panel.appendChild(b);
    });

    panel.appendChild(h('div', 'qs-notice',
      '接收方获得：公开帖子摘要、你的附言与分享行为。匿名作者的账号映射不会随转发泄露。'));

    root.appendChild(panel);
    root.addEventListener('click', function (e) { if (e.target === root) root.remove(); });
    /* 必须挂进 ctx.body：页面实例缓存复用，render 只在参数变化时重跑 ——
       挂在 .page 上会成为旧 DOM 残留（从聊天卡跳回来时面板还开着）；
       body 每次 render 都被清空，跟着它走才干净。 */
    ctx.body.appendChild(root);
    root.classList.add('show');   /* .qs-sheet 默认 display:none，靠 .show 展开 */
  }

  /* ------------------------------ 我的基础页 ------------------------------ */

  function renderMe(ctx, fx) {
    var root = h('div', 'qs-root');
    var me = F().getSelectedForumAccount(fx.sandboxId);
    var owned = F().listOwnedForumAccounts(fx.sandboxId, fx.userEntityId);
    var myPosts = F().scopedForum('forumPosts', fx.sandboxId).filter(function (p) {
      return p.status === 'active' && me && p.authorAccountId === me.id;
    });
    var myComments = F().scopedForum('forumComments', fx.sandboxId).filter(function (c) {
      return c.status === 'active' && me && c.authorAccountId === me.id;
    });
    var mySaved = F().scopedForum('forumCollections', fx.sandboxId).filter(function (c) {
      return me && c.actorAccountId === me.id && c.targetType === 'post';
    });

    root.appendChild(backBar());
    var head = h('div', 'qs-me-head');
    head.appendChild(h('div', 'qs-avatar', me ? avChar(me) : '我'));
    var hb = h('div');
    hb.appendChild(h('div', 'qs-me-name', me ? me.displayName : '还没有论坛身份'));
    hb.appendChild(h('div', 'qs-me-bio', '当前社区 · ' + fx.sandboxName +
      '（' + (KIND_LABEL[fx.sandboxKind] || fx.sandboxKind) + '）'));
    head.appendChild(hb);
    root.appendChild(head);

    var stats = h('div', 'qs-me-stats');
    [[myPosts.length, '帖子'], [myComments.length, '回复'], [mySaved.length, '收藏']].forEach(function (x) {
      var s = h('div');
      s.appendChild(h('b', null, String(x[0])));
      s.appendChild(document.createTextNode(x[1]));
      stats.appendChild(s);
    });
    root.appendChild(stats);

    var main = h('main', 'qs-main');

    main.appendChild(h('div', 'qs-group-label', '论坛身份（仅自己可见）'));
    if (!owned.length) {
      main.appendChild(h('div', 'qs-empty', '还没有身份。返回首页点「催更」初始化社区。'));
    }
    /* v218：身份可改名 / 换头像（forum-core.updateAccountProfile，只认 user 自己的）。
       头像 = 头像字 + 底色；头像字留空回落名字首字。 */
    function avChar(a) {
      return (a && a.avatarGlyph) ? a.avatarGlyph : ((a && a.displayName) || '友').charAt(0);
    }
    var ID_COLORS = ['#d8cec0', '#d6e0dc', '#e2d7c4', '#c9d8c5',
      '#d8c9d4', '#c5cfdd', '#e0d2b4', '#cdb7a8'];
    owned.forEach(function (a) {
      var row = h('div', 'qs-id-row');
      var opt = h('button', 'qs-identity-option' + (me && me.id === a.id ? ' sel' : ''));
      opt.appendChild(h('div', 'qs-mini', avChar(a)));
      var txt = h('div');
      txt.appendChild(h('b', null, a.displayName));
      txt.appendChild(h('small', null, a.accountType === 'main' ? '主账号（默认马甲）' : '小号'));
      opt.appendChild(txt);
      if (me && me.id === a.id) opt.appendChild(h('em', null, '当前'));
      opt.addEventListener('click', function () {
        var r = F().setSelectedForumAccount(fx.sandboxId, a.id);
        if (!r.ok) { Sleepy.toast(r.message); return; }
        rebuild();
      });
      row.appendChild(opt);
      var editBtn = h('button', 'qs-id-edit', '改名/头像');
      editBtn.type = 'button';
      row.appendChild(editBtn);
      main.appendChild(row);

      var ed = null;
      editBtn.addEventListener('click', function () {
        if (ed) { ed.parentNode.removeChild(ed); ed = null; return; }
        ed = h('div', 'qs-id-editor');
        var nameIn = h('input', 'qs-id-input');
        nameIn.maxLength = 12; nameIn.value = a.displayName || ''; nameIn.placeholder = '论坛名字';
        var glyphIn = h('input', 'qs-id-input qs-id-glyph');
        glyphIn.maxLength = 2; glyphIn.value = a.avatarGlyph || ''; glyphIn.placeholder = '字';
        glyphIn.title = '头像上的字，留空用名字第一个字';
        var nameWrap = h('div', 'qs-id-fields');
        nameWrap.appendChild(nameIn); nameWrap.appendChild(glyphIn);
        ed.appendChild(nameWrap);
        var curColor = a.avatarColor || ID_COLORS[0];
        var sw = h('div', 'qs-id-colors');
        ID_COLORS.forEach(function (c) {
          var b = h('button');
          b.type = 'button';
          b.style.background = c;
          if (c === curColor) b.classList.add('on');
          b.addEventListener('click', function () {
            curColor = c;
            [...sw.children].forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          });
          sw.appendChild(b);
        });
        ed.appendChild(sw);
        var save = h('button', 'qs-id-save', '保存');
        save.type = 'button';
        save.addEventListener('click', function () {
          var r = F().updateAccountProfile(a.id, {
            displayName: nameIn.value, avatarColor: curColor, avatarGlyph: glyphIn.value
          });
          if (!r.ok) { Sleepy.toast(r.message || '没存上'); return; }
          Sleepy.toast('改好了', 'ok');
          rebuild();
        });
        ed.appendChild(save);
        main.insertBefore(ed, row.nextSibling);
      });
    });

    main.appendChild(h('div', 'qs-group-label', '我的帖子'));
    if (!myPosts.length) main.appendChild(h('div', 'qs-empty', '还没发过帖。'));
    myPosts.forEach(function (p) {
      main.appendChild(postCard(p, fx));
    });

    main.appendChild(h('div', 'qs-group-label', '公开转帖'));
    var myReposts = F().scopedForum('forumReposts', fx.sandboxId).filter(function (r) {
      return me && r.senderAccountId === me.id;
    }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    if (!myReposts.length) main.appendChild(h('div', 'qs-empty', '还没转过帖。'));
    myReposts.forEach(function (r) {
      var src = F().getPost(r.sourcePostId, fx.sandboxId);
      var row = h('div', 'qs-more-post');
      row.appendChild(h('small', null, fmtTime(r.createdAt)));
      if (src && src.status === 'active') {
        var pa2 = F().publicAuthorOf(src, src.authorAccountId, fx.sandboxId);
        row.appendChild(h('h3', null, src.title || excerpt(src.content, 40)));
        var line = h('small');
        line.textContent = '@' + pa2.displayName +
          (r.attachedText ? ' · ' + excerpt(r.attachedText, 30) : '');
        row.appendChild(line);
        row.addEventListener('click', function () {
          Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: src.id });
        });
      } else {
        row.appendChild(h('h3', null,
          src && src.status === 'blocked' ? '原帖已被封禁' : '原帖已由作者删除'));
        row.appendChild(h('small', null, '只留转发记录，不保留原文。'));
      }
      main.appendChild(row);
    });

    main.appendChild(h('div', 'qs-group-label', '我的回复'));
    if (!myComments.length) main.appendChild(h('div', 'qs-empty', '还没留过声。'));
    myComments.forEach(function (c) {
      var row = h('div', 'qs-more-post');
      row.appendChild(h('small', null, fmtTime(c.createdAt)));
      row.appendChild(h('h3', null, excerpt(c.content, 60)));
      row.addEventListener('click', function () {
        Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: c.postId });
      });
      main.appendChild(row);
    });

    main.appendChild(h('div', 'qs-group-label', '我的收藏'));
    var savedPosts = mySaved.map(function (c) {
      return F().getPost(c.targetId, fx.sandboxId);
    }).filter(function (p) { return p; });
    if (!savedPosts.length) main.appendChild(h('div', 'qs-empty', '还没收藏过帖。'));
    savedPosts.forEach(function (p) {
      var row = h('div', 'qs-more-post');
      row.appendChild(h('small', null,
        (F().getBoard(p.boardId, fx.sandboxId) || {}).name + ' · 收藏'));
      if (p.status === 'active') {
        row.appendChild(h('h3', null, p.title || excerpt(p.content, 40)));
        row.addEventListener('click', function () {
          Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: p.id });
        });
      } else {
        row.appendChild(h('h3', null,
          p.status === 'blocked' ? '原帖已被封禁' : '原帖已由作者删除'));
      }
      main.appendChild(row);
    });

    root.appendChild(main);
    root.appendChild(bottomNav('qunsheng-me', fx));
    return root;
  }

  /* ------------------------------ 板块目录 ------------------------------ */

  function renderBoards(ctx, fx) {
    var root = h('div', 'qs-root');
    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var backB = h('button', 'qs-iconbtn', '‹ 返回');
    backB.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(backB);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, '板块目录'));
    crumb.appendChild(h('small', null, fx.sandboxName + ' · 群声'));
    topline.appendChild(crumb);
    topline.appendChild(h('button', 'qs-textbtn', ''));
    top.appendChild(topline);
    root.appendChild(top);

    var main = h('main', 'qs-main');
    F().listBoards(fx.sandboxId).forEach(function (b) {
      var row = h('div', 'qs-meta-row');
      row.style.cursor = 'pointer';
      row.appendChild(h('b', null, b.name));
      row.appendChild(h('span', null, b.description || ' '));
      row.addEventListener('click', function () {
        /* 点板块进板块主页（版规 / 热议 / 帖流）—— 发帖在主页右上角或底栏「发布」 */
        Sleepy.nav.open('qunsheng-board', { sandboxId: fx.sandboxId, boardId: b.id });
      });
      main.appendChild(row);
    });
    main.appendChild(h('div', 'qs-notice',
      '点板块进去看版规、热议和帖子；要发言就在板块页右上角「发一帖」，或用底栏「发布」选板块。'));
    root.appendChild(main);
    root.appendChild(bottomNav('qunsheng-boards', fx));
    return root;
  }

  /* ------------------------------ 板块主页（2026-10-08 返修轮） ------------------------------
     占位补齐：版规（板块简介）+ 本板块帖流（最新 / 热议两个序）+ 统计条。
     统计只放**真实可算**的三格：今日发帖 / 累计帖子 / 留声 ——
     「在线人数」没有真实数据来源（本地优先 App 没有在线态），不放虚构数字。 */
  var boardState = { sandboxId: null, boardId: null, tab: 'latest' };

  function boardPostsOf(fx, boardId) {
    return F().scopedForum('forumPosts', fx.sandboxId).filter(function (p) {
      return p.status === 'active' && p.boardId === boardId;
    });
  }

  function renderBoard(ctx, fx) {
    var board = F().getBoard(ctx.params.boardId, fx.sandboxId);
    var root = h('div', 'qs-root');
    if (!board || board.status !== 'active') {
      return errBox('这个板块不在了', '它可能已被撤下，或属于别的社区。');
    }
    /* 换岛 / 换板块后 tab 不沿用（热议序切板块沿用会把人看糊涂） */
    if (boardState.sandboxId !== fx.sandboxId || boardState.boardId !== board.id) {
      boardState.sandboxId = fx.sandboxId;
      boardState.boardId = board.id;
      boardState.tab = 'latest';
    }

    /* ---- 顶栏：返回 + 板块名 + 发一帖 ---- */
    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var back = h('button', 'qs-iconbtn', '‹ 返回');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(back);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, board.name));
    crumb.appendChild(h('small', null, fx.sandboxName + ' · 板块'));
    topline.appendChild(crumb);
    var newBtn = h('button', 'qs-textbtn', '发一帖');
    newBtn.addEventListener('click', function () {
      Sleepy.nav.open('qunsheng-compose', { sandboxId: fx.sandboxId, boardId: board.id });
    });
    topline.appendChild(newBtn);
    top.appendChild(topline);
    root.appendChild(top);

    var main = h('main', 'qs-main');

    /* ---- 版规卡（board.description；rules 是后续批的正式版规字段） ---- */
    var intro = h('section', 'qs-ticker');
    intro.style.alignItems = 'flex-start';
    intro.appendChild(h('b', null, '版规'));
    intro.appendChild(h('span', null,
      String(board.description || '').trim() || '这个板块还没写下版规 —— 先来的人说了算。'));
    main.appendChild(intro);

    /* ---- 统计条：真实可算的三格 ---- */
    var posts = boardPostsOf(fx, board.id);
    var d = new Date();
    var todayKey = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var todayCount = posts.filter(function (p) {
      return String(p.createdAt || '').indexOf(todayKey) === 0;
    }).length;
    var commentCount = 0;
    posts.forEach(function (p) {
      commentCount += F().listComments(p.id, fx.sandboxId).length;
    });
    var stats = h('div', 'qs-me-stats');
    [[todayCount, '今日发帖'], [posts.length, '帖子'], [commentCount, '留声']].forEach(function (x) {
      var s = h('div');
      s.appendChild(h('b', null, String(x[0])));
      s.appendChild(document.createTextNode(x[1]));
      stats.appendChild(s);
    });
    main.appendChild(stats);

    /* ---- 序：最新（时间倒序）/ 热议（同感 + 留声加权） ---- */
    var tabs = h('nav', 'qs-tabs');
    tabs.style.height = '38px';
    [['latest', '最新'], ['hot', '热议']].forEach(function (x) {
      var b = h('button', 'qs-tab' + (boardState.tab === x[0] ? ' on' : ''), x[1]);
      b.addEventListener('click', function () {
        boardState.tab = x[0];
        rebuild();
      });
      tabs.appendChild(b);
    });
    main.appendChild(tabs);
    main.appendChild(h('div', 'qs-section-title',
      boardState.tab === 'hot' ? '大家在热议' : '最新一版'));

    var items = posts.slice();
    if (boardState.tab === 'hot') {
      items.sort(function (a, b) {
        var sa = F().countOf('forumLikes', 'post', a.id, fx.sandboxId) +
          F().listComments(a.id, fx.sandboxId).length;
        var sb = F().countOf('forumLikes', 'post', b.id, fx.sandboxId) +
          F().listComments(b.id, fx.sandboxId).length;
        if (sa !== sb) return sb - sa;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
    } else {
      items.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    }

    if (!items.length) {
      var empty = h('div', 'qs-empty');
      empty.appendChild(h('div', 'qs-empty-big', '这个板块还安静着'));
      empty.appendChild(h('div', 'qs-empty-sub',
        '右上角「发一帖」开个头，\n或者回首页点「催更」让居民们来聊聊。'));
      main.appendChild(empty);
    } else {
      items.forEach(function (p) { main.appendChild(postCard(p, fx)); });
    }

    root.appendChild(main);
    root.appendChild(bottomNav('qunsheng-boards', fx));
    return root;
  }

  /* ------------------------------ 消息中心（Batch D） ------------------------------ */

  /* 只聚合论坛内部事件（总纲 §十二）：回复我 / 同感 / 分享回执 / 系统。
     不复制聊天正文；接收维度 = 当前论坛身份（recipientAccountId），
     切小号互不暴露。点「全部已读」readAt 持久。 */
  function renderNotices(ctx, fx) {
    var me = F().getSelectedForumAccount(fx.sandboxId);
    var root = h('div', 'qs-root');
    /* ⚠️ 这里以前先挂 backBar()（‹ 返回桌面）再挂自带「返回」的顶栏 —— 同一个页面
       两个返回按钮，作用重复还把「消息」这个标题压到第二排（user 2026-10-09 点名）。
       按统一口径：一页只留一枚返回键，标题由顶栏的 crumb 承接。 */

    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var backB = h('button', 'qs-iconbtn', '‹ 返回');
    backB.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(backB);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, '消息'));
    crumb.appendChild(h('small', null, '以「' + (me ? me.displayName : '?') + '」的身份收'));
    topline.appendChild(crumb);
    topline.appendChild(h('button', 'qs-textbtn', ''));
    top.appendChild(topline);
    root.appendChild(top);

    var main = h('main', 'qs-main');
    if (!me) {
      main.appendChild(h('div', 'qs-empty', '还没有论坛身份。'));
      root.appendChild(main);
      root.appendChild(bottomNav('qunsheng-notices', fx));
      return root;
    }

    var list = F().listNotifications(fx.sandboxId, me.id);
    var unread = list.filter(function (n) { return !n.readAt; }).length;

    if (unread > 0) {
      var mark = h('button', 'qs-mark-read', '全部已读（' + unread + '）');
      mark.addEventListener('click', function () {
        F().markAllRead(fx.sandboxId, me.id);
        rebuild();
      });
      main.appendChild(mark);
    }

    if (!list.length) {
      var empty = h('div', 'qs-empty');
      empty.appendChild(h('div', 'qs-empty-big', '还没有消息'));
      empty.appendChild(h('div', 'qs-empty-sub',
        '有人回复你、同感你、或打开你分享的帖子时\n会在这里出现，刷新后不丢。'));
      main.appendChild(empty);
    }

    var CAT_LABEL = { reply: '回复了我', like: '同感', receipt: '回执', system: '通知' };
    list.forEach(function (n) {
      var item = h('div', 'qs-notice-item' + (n.readAt ? '' : ' unread'));
      item.appendChild(h('span', 'qs-notice-dot'));
      var copy = h('div', 'qs-notice-copy');
      copy.appendChild(h('b', null,
        n.actorName + ' ' + (CAT_LABEL[n.category] || n.category) +
        (n.actorAnonymous ? '（匿名）' : '')));
      if (n.previewText) copy.appendChild(h('p', null, n.previewText));
      copy.appendChild(h('small', null,
        fmtTime(n.createdAt) + (n.readAt ? '' : ' · 未读')));
      item.appendChild(copy);
      item.addEventListener('click', function () {
        F().markRead(n.id);
        if (n.sourceId) {
          Sleepy.nav.open('qunsheng-post', { sandboxId: fx.sandboxId, postId: n.sourceId });
        } else {
          rebuild();
        }
      });
      main.appendChild(item);
    });

    main.appendChild(h('div', 'qs-notice',
      '原帖删除或权限变化后，对应条目打开只会看到占位说明；分享回执只显示状态，不显示聊天里的回复正文。'));

    root.appendChild(main);
    root.appendChild(bottomNav('qunsheng-notices', fx));
    return root;
  }

  /* ------------------------------ 作者公开主页（极简版） ------------------------------ */

  /* 「连续看同一人的作品」（user 2026-10-07）：作者的全部公开帖子 +
   * 帷境作品帖单列。匿名身份没有主页（不同帖同一个人的匿名不串联）。 */
  function renderAuthor(ctx, fx) {
    var acc = F().getAccount(ctx.params.accountId, fx.sandboxId);
    var root = h('div', 'qs-root');
    if (!acc) {
      return errBox('这位作者不在了', '账号可能已注销或属于别的社区。');
    }
    var top = h('div', 'qs-topbar');
    var topline = h('div', 'qs-topline');
    var back = h('button', 'qs-iconbtn', '‹ 返回');
    back.addEventListener('click', function () { Sleepy.nav.back(); });
    topline.appendChild(back);
    var crumb = h('div', 'qs-crumb');
    crumb.appendChild(h('b', null, acc.displayName));
    crumb.appendChild(h('small', null, '众声喧哗 · 作者主页'));
    topline.appendChild(crumb);
    topline.appendChild(h('button', 'qs-textbtn', ''));
    top.appendChild(topline);
    root.appendChild(top);

    var main = h('main', 'qs-main');

    var head = h('div', 'qs-me-head');
    var aav = h('div', 'qs-avatar', acc.avatarGlyph || acc.displayName.charAt(0));
    paintFace(aav, faceOfAccount(acc));
    head.appendChild(aav);
    var hb = h('div');
    hb.appendChild(h('div', 'qs-me-name', acc.displayName));
    hb.appendChild(h('div', 'qs-me-bio',
      (acc.bio || '这位岛民话不多。') + ' · @' + acc.handle));
    head.appendChild(hb);
    /* 关注按钮（2026-10-11 关注补全）：不能关注自己 */
    var meAcc = F().getSelectedForumAccount(fx.sandboxId);
    if (!meAcc || meAcc.id !== acc.id) {
      var fbtn = h('button', 'qs-follow' + (F().isFollowing(fx.sandboxId, acc.id) ? ' on' : ''),
        F().isFollowing(fx.sandboxId, acc.id) ? '已关注' : '+ 关注');
      fbtn.style.marginLeft = 'auto';
      fbtn.style.flex = '0 0 auto';
      fbtn.addEventListener('click', function () {
        var r = F().toggleFollow(fx.sandboxId, acc.id);
        fbtn.textContent = r.on ? '已关注' : '+ 关注';
        fbtn.className = 'qs-follow' + (r.on ? ' on' : '');
        Sleepy.toast(r.on ? '关注了 ' + acc.displayName : '取关了 ' + acc.displayName);
      });
      head.appendChild(fbtn);
    }
    main.appendChild(head);

    /* 公开统计：访客视角，只数 active 帖（本人私有数据不进这里） */
    var posts = F().scopedForum('forumPosts', fx.sandboxId).filter(function (p) {
      return p.status === 'active' && p.authorAccountId === acc.id;
    });
    var comments = F().scopedForum('forumComments', fx.sandboxId).filter(function (c) {
      return c.status === 'active' && c.authorAccountId === acc.id;
    });
    var works = posts.filter(function (p) { return p.sourceType === 'wjWork'; });

    var stats = h('div', 'qs-me-stats');
    [[posts.length, '帖子'], [comments.length, '留声'], [works.length, '帷境作品']].forEach(function (x) {
      var s = h('div');
      s.appendChild(h('b', null, String(x[0])));
      s.appendChild(document.createTextNode(x[1]));
      stats.appendChild(s);
    });
    main.appendChild(stats);

    if (works.length) {
      main.appendChild(h('div', 'qs-group-label', '帷境作品（真实性标记随帖展示）'));
      works.forEach(function (p) { main.appendChild(postCard(p, fx)); });
    }

    main.appendChild(h('div', 'qs-group-label', '全部帖子'));
    if (!posts.length) {
      main.appendChild(h('div', 'qs-empty', '还没有发过帖。'));
    }
    posts.forEach(function (p) { main.appendChild(postCard(p, fx)); });

    main.appendChild(h('div', 'qs-notice',
      '这里只放公开内容。作者的收藏、草稿与别的身份不会出现。'));
    root.appendChild(main);
    root.appendChild(bottomNav('qunsheng-boards', fx));
    return root;
  }

  /* ------------------------------ 注册 ------------------------------ */

  /* 公共壳：解析上下文（失败即错误态），再进页面渲染。
     render 的返回值 app.js 不消费 —— 必须自己挂进 ctx.body（同 page-guide）。
     页内动作（切 tab / 点同感 / 切身份）后要刷新：rebuild() 用当前页的
     渲染函数重建并替换 body —— 别自己造一个没挂上的新节点（假渲染）。 */
  var current = null;          /* { ctx, fx, fn } —— 页面实例级，不持久化 */
  function rebuild() {
    if (!current) return;
    var node = current.fn(current.ctx, current.fx);
    if (current.ctx && current.ctx.body) {
      current.ctx.body.innerHTML = '';
      current.ctx.body.appendChild(node);
    }
  }
  function page(fn) {
    return {
      title: '群声',
      freshOnOpen: true,
      render: function (ctx) {
        ensureStyle();
        var fx = F().resolveContext(ctx && ctx.params && ctx.params.sandboxId);
        if (fx.ok) {
          /* 首次进岛幂等初始化（马甲/char/NPC 账号 + 八板块，零模型）——
             不挂在「催更」上：不然不点催更就连发帖身份都没有 */
          F().ensureSeed(fx.sandboxId);
          current = { ctx: ctx, fx: fx, fn: fn };
        }
        var node = fx.ok ? fn(ctx, fx) : errorRoot(fx.message);
        if (ctx && ctx.body) {
          ctx.body.innerHTML = '';
          ctx.body.appendChild(node);
        }
        return node;
      }
    };
  }

  Sleepy.register('qunsheng', page(renderHome));
  Sleepy.register('qunsheng-post', page(renderPost));
  Sleepy.register('qunsheng-compose', page(renderCompose));
  Sleepy.register('qunsheng-me', page(renderMe));
  Sleepy.register('qunsheng-boards', page(renderBoards));
  Sleepy.register('qunsheng-board', page(renderBoard));
  Sleepy.register('qunsheng-notices', page(renderNotices));
  Sleepy.register('qunsheng-author', page(renderAuthor));

})(window);
