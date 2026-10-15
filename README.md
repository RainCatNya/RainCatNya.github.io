# Foraine · 无垠星野

RainCat 的个人站 —— 文章、私信、资源与一点点星空设定，都装在这里。

线上地址：**https://foraine.xyz**

---

## 这是什么

一个跑在 Cloudflare 上的全栈个人站，刻意做得很轻：

- **前端零构建** —— HTML / CSS / JS 直接写在 `public/`，改完就是线上，没有打包、没有框架、没有运行时依赖。
- **后端只有一道 esbuild** —— 源码在 `src/`，`node build.mjs` 打包成 `worker.js`，一个文件既是后端 API，又是页面渲染器与定时任务。
- **数据** —— 结构化数据在 Cloudflare D1，文件在阿里云 OSS。

## 功能

| 模块 | 说明 |
| --- | --- |
| 文章 | 标签、草稿、阅读时长、Markdown 扩展（`<secret>` / `<spoiler>` / `<gradient>` 等行内标记）、「叙述」体文章 |
| 评论 | 两级楼中楼 |
| 私信 | QQ 形制：附件、表情、引用、撤回；乐观发送 + `cid` 幂等去重 |
| 站内信 / 关注 | 通知与关注关系 |
| 资源中心 | 上传、检索、分片直传（> 24MB，支持断点续传）、防盗链 |
| 权限 | 权限组（站长 / 管理员 / 成员）+ 每人一份的「属性」开关 |
| 账号 | 邮箱验证、GitHub OAuth、动态令牌（TOTP）、注销宽限 |
| 其它 | 星历（`/aceris`）、终端页（`/terminal`）、站长 D1 控制台、多语言（i18n） |

## 目录

```
public/     前端：页面 + style/ + script/ + lang/（语言包）+ assets/
src/        后端源码：index.js 入口 · common.js 基础层 · handlers/ 按域拆分 · permission.js 权限
worker.js   打包产物（生成物，不要手改）
build.mjs   esbuild 打包脚本
schema.sql  全部建表 / 加列（可重复执行）
tests/      回归测试（markdown 渲染 + 星历历法）
docs/       视觉与组件规范、权限串清单
```

## 本地开发

```powershell
npm install
npx wrangler dev --port 8788   # 起本地站，改了 public/ 刷新即生效
npm test                       # 跑回归测试
node build.mjs                 # 手动打包（dev / deploy 会自动跑，一般不用）
npx wrangler deploy            # 部署到线上
```

> 本地没有 `.dev.vars`，OSS 上传与邮件在本地只能验到失败分支，真实链路在线上。

## 技术栈

Cloudflare Workers（D1 · Cron · Static Assets） · 阿里云 OSS · esbuild · 原生 HTML / CSS / JavaScript

## 贡献者

UX 设计：[RainCat](https://github.com/RainCatNya)
星野缔造（兼芒果批发商）：flflizc

---

> 网站还在慢慢长，欢迎看着它一点点变成真实世界的一部分。
