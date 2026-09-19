/* ============================================================
   msg-trans.js — 译文块（共享组件）

   依赖：ui.js（h）、calendar.js（langOf / translateOn，运行时惰性取用）

   来历：2026-09-19 线上私聊先落地（用户原话「如果只是放在同一个气泡
   you are beautiful（你很漂亮）这样我觉得很丑」）。第二轮打通线下时
   把这一块从 page-chat.js 里抽出来 —— **一块 UI 只能有一份实现**，
   线上线下的分叉从「各自实现」开始。

   三种用法：
     · 线上私聊（page-chat）：气泡里的第二层
     · 线下私聊（page-offline）：dialogue 段下面
     · 群线下（page-group-offline）：每个说话人的台词下面
   类名统一是 .msg-trans / .msg-trans-text / .msg-trans-mini，
   样式在 style.css 的「finesse · component: msg-trans」段（一套，三处共用）。

   两条闸门，缺一不可（写在 attach() 里，调用方不用自己判）：
     ① 开关：calendar.translateOn()（面板里的「翻译」开关，默认开）
     ② 语言：他说的话跟 user 不是同一种（calendar.langOf().same）
        —— 中文角色的气泡**永远**不长这一块，哪怕模型手滑写了 [译]。
   ============================================================ */
(function (global) {
  'use strict';

  global.Sleepy = global.Sleepy || {};
  var Sleepy = global.Sleepy;

  function h(tag, cls, text) {
    if (Sleepy.ui && Sleepy.ui.h) return Sleepy.ui.h(tag, cls, text);
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  /* 收起状态**不落盘**：它是「这一眼想不想看」，不是数据。
     key = '<msgId>:<段序号>'，所以同一段消息第二次看仍是你上次的样子。 */
  var collapsed = {};

  function langOf(charId) {
    try {
      return (Sleepy.calendar && Sleepy.calendar.langOf && Sleepy.calendar.langOf(charId)) || null;
    } catch (e) { return null; }
  }

  /* 他说的话跟 user 是不是同一种语言（false/拿不到 = 不显示译文） */
  function needs(charId) {
    var lang = langOf(charId);
    return !!(lang && !lang.same);
  }

  /* 「要不要看译文」的总开关（跟具体跟谁聊没关系） */
  function on() {
    try {
      return !!(Sleepy.calendar && Sleepy.calendar.translateOn && Sleepy.calendar.translateOn());
    } catch (e) { return false; }
  }

  /* 一整块译文。key 是收起状态的存档键；text 是译文原文。
     两件事都不该为空 —— 空的译文调用方就该不渲染（不做空壳）。 */
  function block(key, text) {
    var open = collapsed[key] !== true;
    var wrap = h('div', 'msg-trans' + (open ? ' is-open' : ''));

    /* 展开态：**只有译文本身**。
       用户 2026-09-19：「那个『译 日语 → 中文 ⌃』这行可以去掉嘛」——
       语言对原文就摆在正上方，写出来是废话；箭头也是多余的装饰。
       于是标头整行不要了，点译文本身就能收起。
       它是 button 不是 span：键盘够得着，焦点圈不淡入（见 CSS）。 */
    var body = h('button', 'msg-trans-text');
    body.type = 'button';
    body.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.title = open ? '收起译文' : '看译文';
    body.textContent = text;
    body.addEventListener('click', function (e) {
      /* 别让点击冒到气泡/段落上去（线上那侧会触发多选） */
      e.stopPropagation();
      var nowOpen = !wrap.classList.contains('is-open');
      wrap.classList.toggle('is-open', nowOpen);
      body.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      body.title = nowOpen ? '收起译文' : '看译文';
      collapsed[key] = !nowOpen;
    });

    /* 收起态：只留一个小小的「译」字标 —— 它是回到译文的唯一入口，
       所以不能省，但要小到不占版面。 */
    var mini = h('button', 'msg-trans-mini', '译');
    mini.type = 'button';
    mini.setAttribute('aria-label', '看译文');
    mini.addEventListener('click', function (e) {
      e.stopPropagation();
      collapsed[key] = false;
      wrap.classList.add('is-open');
      body.setAttribute('aria-expanded', 'true');
    });

    wrap.appendChild(body);
    wrap.appendChild(mini);
    return wrap;
  }

  /* 便捷入口：两道闸门都过才把译文块 append 进 parent，返回那个节点或 null。
     parent / key / text 三者必需；charId 决定「这段是谁说的」。 */
  function attach(parent, key, text, charId) {
    if (!parent || !text) return null;
    if (!on() || !needs(charId)) return null;
    var el = block(key, text);
    parent.appendChild(el);
    return el;
  }

  /* 测试/预览用：把收起状态清空 */
  function resetCollapsed() { collapsed = {}; }

  Sleepy.msgTrans = {
    langOf: langOf,
    needs: needs,
    on: on,
    block: block,
    attach: attach,
    resetCollapsed: resetCollapsed
  };
})(typeof window !== 'undefined' ? window : this);
