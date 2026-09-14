# 小手机 sleepy

本地优先的角色扮演小手机。**零依赖静态前端** —— 直接双击 `index.html` 就能跑，
不需要构建、不需要装任何包。

## 开发

```bash
pnpm dev        # 起本地服务器并自动打开浏览器（http://127.0.0.1:5173）
pnpm serve      # 同上，但不自动开浏览器
pnpm check      # 体检：JS 语法 + CSS 结构 + index.html 加载检查
```

没有 `node_modules` 是正常的，这个项目就没有依赖。
`pnpm dev` 背后是 `serve.js`（Node 自带的 `http` 模块，60 行），不是 vite。

> **换地址后数据是空的**：`file://` 和 `http://127.0.0.1:5173` 是两个不同的
> 存储空间，localStorage 不互通。之前双击打开的存档不会出现在本地服务器里，
> 需要重新配一次 API。反过来也一样。

## 目录

| 文件 | 作用 |
|---|---|
| `store.js` | 存储层。localStorage 读写、默认值、订阅通知、导入导出 |
| `ui.js` | 组件层。`h()` / 表单字段 / 列表行 / 弹层等公共零件 |
| `app.js` | 壳子。页面栈、跳转、历史记录、导航栏 |
| `api.js` | 模型接入。候选轮询、SSE 流式解析、超时与中断 |
| `page-*.js` | 各个页面，一个文件一页（或一页组） |
| `style.css` | 全部样式，配色走 `:root` 变量 |
| `serve.js` | 开发服务器（仅开发用，不进产品） |
| `docs/` | 施工卡、半成品草稿 |
| `scripts/check.js` | `pnpm check` 的实现 |

**加载顺序即依赖顺序**，不要调换（见 `index.html` 注释）。
新增 `page-*.js` 后**一定要去 `index.html` 的 script 列表里加一行** ——
漏加载不会报任何错，但那个页面永远不生效。`pnpm check` 会帮你查这个。
