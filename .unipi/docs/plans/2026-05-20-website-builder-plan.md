---
title: "WSB Website Builder — Implementation Plan"
type: plan
date: 2026-05-20
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-20-website-builder-design.md
---

# WSB Website Builder — Implementation Plan

## Overview

为 WSB WhatsApp bot 添加网站生成功能：用户通过 `!website <描述>` 命令触发 AI 生成单文件 HTML 网站，部署到 Express 静态服务器（端口 8080），最多 2 个活跃网站，旧的自动清除。

## Tasks

- completed: Task 1 — 目录结构与静态服务器
  - Description: 创建 `/home/chin/websites/active/` 目录，编写 `website-server.js` Express 静态服务器
  - Dependencies: None
  - Acceptance Criteria: `node website-server.js` 启动后监听 8080，访问 `http://localhost:8080/` 显示网站列表页（空列表），手动放一个 HTML 文件后能通过浏览器访问
  - Steps:
    1. 创建 `/home/chin/websites/active/` 目录
    2. 在 `/home/chin/wsb/website-server.js` 中编写 Express 应用：serve `/home/chin/websites/active/` 静态目录，根路径读取子目录列表并返回简单 HTML 列表页
    3. 手动测试：启动服务器，curl localhost:8080 确认返回列表页

- completed: Task 2 — 网站生成模块
  - Description: 编写 `website-builder.js`，包含 AI prompt 构造、HTML 提取、slug 生成、槽位管理（meta.json）
  - Dependencies: Task 1（需要目录结构存在）
  - Acceptance Criteria: 可以独立调用 `buildWebsite(description, sender)` 返回 `{ url, slug }` 或错误，生成的 HTML 写入正确目录，meta.json 正确更新，超过 2 个网站时最旧的被删除
  - Steps:
    1. 创建 `/home/chin/wsb/website-builder.js`
    2. 实现 `generateSlug(description)` — 基于时间戳和简短描述生成 URL-safe slug
    3. 实现 `buildWebsite(description, sender)` 主函数：
       - 构造 system prompt（要求单文件 HTML、内嵌 CSS/JS、使用免费 API、自动刷新、美观移动端友好）
       - 调用 `ai.js` 的 `chat()` 函数，注意需要修改或新增一个支持更高 max_tokens（4096+）的 AI 调用方式
       - 从 AI 响应中提取纯 HTML（去除 markdown 代码块包裹）
       - 简单校验（检查 `<html>` 或 `<!DOCTYPE>`）
    4. 实现 `manageSites()` — 读写 `/home/chin/websites/meta.json`，检查数量，超过 2 个删除最旧目录和元数据
    5. 实现 `listSites()` — 返回当前活跃网站列表
    6. 实现 `deleteSite(slug)` — 手动删除指定网站

- completed: Task 3 — 配置与命令路由集成
  - Description: 在 config.js 添加白名单，在 index.js 集成 `!website`、`!websites`、`!delsite` 命令，更新 `!help`
  - Dependencies: Task 2（需要 website-builder.js 存在）
  - Acceptance Criteria: 白名单用户发 `!website <描述>` 能触发生成流程并收到 URL 回复，非白名单用户收到拒绝消息，`!websites` 列出活跃网站，`!delsite <slug>` 删除指定网站，`!help` 包含新命令说明
  - Steps:
    1. 在 `config.js` 中添加 `websiteWhitelist: ['60xxxxxxxxx@c.us']`
    2. 在 `index.js` 顶部 require `website-builder.js`
    3. 在 `index.js` 的 switch 中添加 `!website` 命令处理（注意这是 `startsWith` 匹配，不是精确匹配）：检查白名单 → 回复"正在生成" → 调用 buildWebsite → 回复 URL 或错误
    4. 添加 `!websites` 命令：调用 listSites，格式化输出
    5. 添加 `!delsite` 命令：解析 slug，调用 deleteSite，回复结果
    6. 更新 `!help` 的输出字符串，加入三个新命令说明

- completed: Task 4 — AI 调用适配
  - Description: 在 ai.js 中新增或修改函数以支持更长输出（max_tokens 4096+），适配网站生成场景
  - Dependencies: None（可与 Task 1 并行）
  - Acceptance Criteria: 新的 AI 调用函数能返回完整的 HTML 页面内容，不被 cleanAIResponse 截断或破坏
  - Steps:
    1. 在 `ai.js` 中新增 `chatRaw(systemPrompt, userMessage, maxTokens)` 函数 — 类似 `chat()` 但跳过 `cleanAIResponse`（因为会破坏 HTML 代码块），支持自定义 max_tokens
    2. 导出 `chatRaw`
    3. 在 `website-builder.js` 中使用 `chatRaw` 而非 `chat`

- completed: Task 5 — pm2 注册与端到端测试
  - Description: 用 pm2 注册 website-server.js，进行端到端测试
  - Dependencies: Task 1, 2, 3, 4
  - Acceptance Criteria: `pm2 list` 显示 website-server 进程运行中，通过 WhatsApp 发 `!website` 能生成网站并可通过 `http://18.141.191.212:8080/<slug>/` 访问
  - Steps:
    1. `pm2 start website-server.js --name website-server`
    2. `pm2 save` 保存进程列表
    3. 重启 wsb 进程：`pm2 restart wsb`
    4. 通过 WhatsApp 发送 `!website 实时飞机票价格网站` 测试
    5. 验证收到 URL 回复
    6. 在浏览器中访问 URL 确认网站正常
    7. 发 `!websites` 确认列表正确
    8. 发第 3 个 `!website` 确认旧网站被清除

## Sequencing

```
Task 1 (静态服务器) ──┐
                      ├──→ Task 2 (生成模块) ──→ Task 3 (集成) ──→ Task 5 (测试)
Task 4 (AI 适配)  ────┘
```

Task 1 和 Task 4 可以并行。Task 2 依赖 Task 1 和 4。Task 3 依赖 Task 2。Task 5 是最终集成测试。

## Risks

- **AI 输出质量不稳定：** 免费模型可能生成不完整或格式错误的 HTML。缓解：简单校验 + 一次重试
- **max_tokens 限制：** 免费模型可能不支持 4096 tokens，需要测试实际限制
- **CORS 问题：** AI 选择的 API 可能不支持前端直调。这是已知限制，暂不处理
- **端口 8080 安全组：** AWS EC2 安全组需要开放 8080 端口入站规则，否则外网无法访问

---

## Reviewer Remarks

REVIEWER-REMARK: Done
- All 5 tasks complete and verified.
- End-to-end test passed: `buildWebsite('世界时钟...')` produced valid HTML at `http://localhost:8080/site-mpdi188h/` in ~24s.
- `website-server` registered in pm2 (id 4), `pm2 save` executed, wsb restarted to load new commands.
- Whitelist enforced on `!website` and `!delsite` commands.
- Slot management verified (MAX_SITES=2, oldest auto-deleted).

Codebase Checks:
- ✓ `node -c index.js` syntax OK
- ✓ `node -e "require('./website-builder')"` loads cleanly
- ✓ `node -e "require('./ai').chatRaw"` exported
- ✓ pm2 list shows wsb + website-server online
- ✓ curl localhost:8080 returns site listing
- ⚠ External access to `http://18.141.191.212:8080/` times out — AWS EC2 security group needs inbound rule for port 8080 (noted as risk in plan, requires user action in AWS console)

Follow-up:
- Open AWS security group port 8080 to test public URL via WhatsApp end-to-end.
