---
title: "WSB Ask-User Threshold — Implementation Plan"
type: plan
date: 2026-05-20
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-20-ask-user-threshold-design.md
---

# WSB Ask-User Threshold — Implementation Plan

## Overview

实现 wsb 的"疑问澄清"模块：bot 收到非 `!` 命令消息时，先用便宜 LLM 跑 `classifyIntent` 估算 confidence，ambiguity > 10% 就用 `generateOptions` 产出 2-4 个选项 + "其他" 兜底反问用户；session 状态用 JSON 文件持久化 30 分钟 TTL；hard cap 20 轮防失控；任何 LLM 失败都回退到原 `smartReply`。

非 git repo，直接在 `/home/chin/wsb` 工作，pm2 reload 验证。

## Tasks

- completed: Task 1 — Config 扩展
  - Description: 在 `config.js` 加入澄清模块开关和参数
  - Dependencies: None
  - Acceptance Criteria:
    - `config.js` 暴露 `clarificationEnabled`、`ambiguityThreshold`、`maxRounds`、`sessionTtlMs`、`softWarnRound`、`clarifyWhitelist`、`classifyModel`
    - 默认值：`enabled=false`（灰度起步）、`threshold=0.1`、`maxRounds=20`、`ttl=30*60*1000`、`softWarn=10`、`whitelist=[]`
    - 支持通过 `.env` 覆盖（`CLARIFY_ENABLED`、`CLARIFY_WHITELIST`、`CLARIFY_MODEL`）
  - Steps:
    1. 打开 `wsb/config.js`，新增 `clarification` 配置块
    2. 读取对应 env 变量并 fallback 默认值
    3. 在 `.env.example` 或 README 注明新变量（如有）

- completed: Task 2 — Session 存储模块
  - Description: 新建 `wsb/session.js`，管理用户多轮对话状态，JSON 文件持久化
  - Dependencies: Task 1
  - Acceptance Criteria:
    - 导出 `getSession(userId)`、`setSession(userId, data)`、`clearSession(userId)`、`pruneExpired()`
    - 存到 `data/sessions.json`，启动时自动加载
    - `getSession` 返回 null 表示无 session 或已过期（自动清除）
    - 写入有 debounce（避免每条消息都 fsync）—— 用 setImmediate 或 200ms 节流
    - 模块自测：`node -e "const s=require('./session'); s.setSession('u1',{x:1}); console.log(s.getSession('u1'))"` 输出 `{x:1, expiresAt:...}`
  - Steps:
    1. 参考 `wsb/memory.js` 的 JSON 读写模式
    2. 实现 in-memory Map + 持久化 flush
    3. 启动时 `pruneExpired()` 一次
    4. `setSession` 自动写入 `expiresAt = Date.now() + sessionTtlMs`

- completed: Task 3 — Intent 分类与选项生成
  - Description: 新建 `wsb/intent.js`，两个 LLM 调用包装
  - Dependencies: Task 1
  - Acceptance Criteria:
    - 导出 `classifyIntent(text, session)` → `{intent, slots_filled, slots_missing, confidence, ready_to_answer, reasoning}`
    - 导出 `generateOptions(intent, missingSlot, slotsFilled)` → `{question, options: string[]}`（options 最后一项必为 "其他（请直接说明）"）
    - LLM prompt 强约束输出 JSON
    - JSON 解析失败 → 抛错（让调用方决定回退）
    - 使用 `config.classifyModel`（便宜模型），fallback `process.env.OPENROUTER_MODEL`
  - Steps:
    1. 复用 `ai.js` 已有的 OpenRouter axios 调用模式
    2. 写 system prompt：让模型扮演"客服需求分析师"，输出严格 JSON
    3. 写 generateOptions prompt：根据 intent + 已知 slots 给 2-4 个具体选项
    4. 在每个函数 try/catch JSON.parse，失败抛 Error 带原文便于调试

- completed: Task 4 — answerWithSlots 入口
  - Description: 在 `wsb/ai.js` 新增最终回答函数
  - Dependencies: Task 3
  - Acceptance Criteria:
    - 导出 `answerWithSlots(intent, slots, userText, memoryContext)` → string
    - 内部组装 prompt：明确告诉模型用户意图、已填槽位、原始问题、长期记忆
    - 使用主模型 `OPENROUTER_MODEL`
    - 失败时返回 null（让上层回退）
  - Steps:
    1. 复用 `smartReply` 的 OpenRouter 调用
    2. Prompt 模板：`用户想 {intent}，已知 {slots}，原话 "{userText}"，请给出简洁回答`
    3. catch 错误 log 并返回 null

- completed: Task 5 — index.js 消息分流
  - Description: 在 `wsb/index.js` 的 `message` handler 插入澄清逻辑
  - Dependencies: Task 2, Task 3, Task 4
  - Acceptance Criteria:
    - `!` 命令分支不变
    - 非命令消息进入新分流：
      - `clarificationEnabled=false` 或 userId 不在白名单 → 走原 `smartReply`（保持回退兼容）
      - 否则：先 `pruneExpired`，查 session，有则解析用户输入（数字 → lastOptions[idx-1]；freeform → 直接当 missing_slot 值）
      - 跑 `classifyIntent`，算 ambiguity
      - 取消关键词（`算了|取消|不用了|cancel`）→ clearSession + 回复"好的，已取消"
      - rounds >= maxRounds OR ambiguity <= threshold → `answerWithSlots` → 清 session
      - 否则 `generateOptions` → 拼装"问题\n1. xxx\n2. xxx\n4. 其他（请直接说明）\n（回复数字或直接描述）" → 发送 + 更新 session
    - 任何 LLM 调用 try/catch，失败统一回退到原 `smartReply`
    - 每轮日志：`[CLARIFY userId=X round=N intent=Y amb=Z%]`
  - Steps:
    1. 抽取澄清逻辑成内部 async 函数 `handleClarification(message, body)`
    2. 在原 `smartReply` 调用前 if 判断是否启用
    3. 包一层 try/catch，catch 内 fallback 到原逻辑
    4. 注意 cache (`getReply/setReply`) 在澄清模式下绕过（多轮对话不能缓存固定回复）

- completed: Task 6 — !nosession 调试命令
  - Description: 新增 `!nosession` 命令清当前用户 session
  - Dependencies: Task 2, Task 5
  - Acceptance Criteria:
    - 在 `index.js` 命令 switch 加 case `!nosession`
    - 调用 `clearSession(userId)`，回复"🗑️ 已清除当前对话状态"
    - `!help` 文案补一行说明
  - Steps:
    1. switch 块加 case
    2. 更新 `!help` 字符串

- awaiting_user: Task 7 — 灰度白名单 + 实测
  - Description: 仅对白名单用户启用，pm2 reload 后扫码实测一个 flight_search 流程
  - Dependencies: Task 5, Task 6
  - Acceptance Criteria:
    - `.env` 加 `CLARIFY_ENABLED=true`、`CLARIFY_WHITELIST=<自己的 jid>`
    - `pm2 reload wsb` 无错
    - 实测："帮我查飞机票" → bot 反问航空公司选项
    - 选 "1. AirAsia" → bot 反问日期
    - 输入日期 → bot 反问起降地
    - 输入起降地 → bot 给最终答复（含 AirAsia 网址）
    - session 在 30 分钟后自动清除
    - 测 "算了" 关键词清 session
    - 非白名单用户走原 smartReply（验证不影响他人）
  - Steps:
    1. 编辑 `.env`
    2. `pm2 reload wsb && pm2 logs wsb --lines 50`
    3. 跑上述测试矩阵
    4. 把日志中 ambiguity 演化记一段贴回这个 plan 的 awaiting_user 注释

- blocked: Task 8 — 文档与 memory 收尾
  - Description: 更新 README / spec checklist，存 memory 标记完成
  - Dependencies: Task 7
  - Acceptance Criteria:
    - 更新 spec 的 Implementation Checklist，把已实现项打勾
    - 在 `wsb/README.md`（若有）或 `wsb/.unipi/docs/specs/` 旁加一段澄清模块用法说明
    - `memory_store` 更新 `project_wsb_clarification_design` 为 implemented 状态
  - Steps:
    1. Edit spec checkboxes
    2. 写 README 段落（澄清流程、env 变量、debug 命令）
    3. 存 memory

## Sequencing

```
Task 1 (config)
    ├─→ Task 2 (session.js)
    │       └────┐
    └─→ Task 3 (intent.js)
            ├─→ Task 4 (answerWithSlots)
            │       └────┐
            └────────────┴─→ Task 5 (index.js 分流)
                                    └─→ Task 6 (!nosession)
                                            └─→ Task 7 (灰度实测)
                                                    └─→ Task 8 (文档+memory)
```

并行机会：Task 2 / Task 3 / Task 4 可在 Task 1 完成后并行实现（不同文件）。Task 5 必须等 2+3+4 都好。

## Risks

- **LLM JSON 输出不稳定**：classifyIntent / generateOptions 可能返回非法 JSON。缓解：prompt 强约束 "respond with JSON only" + 解析失败回退到 smartReply（已在设计中）
- **磁盘紧张**：`data/sessions.json` 持续写入。缓解：节流写入 + 文件大小 < 1MB（session 数据短小）；定期 `pruneExpired` 后整体重写而不是 append
- **多轮对话用户体验**：用户可能不耐烦多轮反问。缓解：threshold 设 10% 是相对严格，但允许 freeform "其他" 兜底；灰度阶段观察实际轮数分布，必要时调高 threshold
- **群聊场景**：群里多人同时跟 bot 多轮对话，session 用 userId（跨群保持）vs groupId+userId（按群隔离）需在 Task 5 决定。设计文档建议 userId，可灰度时验证
- **现有 cache 冲突**：`getReply/setReply` 会缓存 LLM 回复。澄清模式下必须绕过，否则同样问题永远走 cache 不进澄清流程。已在 Task 5 注明
- **配额成本**：classifyIntent 每条消息一次 LLM。如果群消息量大，token 消耗可能翻倍。缓解：用便宜模型 + 灰度白名单 + 监控

---

## Reviewer Remarks

REVIEWER-REMARK: Code-Complete (Awaiting Live Test)
- Task 1-6 implemented and `node --check` passes on all modified files
- session.js roundtrip self-test passed (write → read → clear)
- intent.js end-to-end smoke test passed:
  - classifyIntent("帮我查飞机票") → intent=flight_search, confidence=0.42, slots_missing=[origin,destination,depart_date]
  - generateOptions(flight_search, origin) → question + 4 options + "其他" 兜底
- Default `clarification.enabled = false` (gated by `CLARIFY_ENABLED=true` env)
- No pm2 reload performed — bot still running old code until user opts in

Codebase Checks:
- ✓ Node syntax check on config.js, session.js, intent.js, ai.js, index.js
- ✓ session.js JSON persistence verified (data/sessions.json created)
- ✓ Real LLM call against OpenRouter `openai/gpt-oss-120b:free` succeeded
- ⚠ No formal lint/test suite exists in this repo (npm test just requires news-fetcher)
- ⚠ Live WhatsApp end-to-end NOT executed (requires user action: set env + pm2 reload + scan)

Outstanding:
- Task 7: user sets `CLARIFY_ENABLED=true CLARIFY_WHITELIST=<jid>` in .env, runs `pm2 reload wsb`, tests flight_search flow on WhatsApp
- Task 8: blocked on Task 7 sign-off (will update spec checklist + memory after live verification)

Files touched:
- wsb/config.js (modified)
- wsb/session.js (new)
- wsb/intent.js (new)
- wsb/ai.js (modified, +answerWithSlots)
- wsb/index.js (modified, +handleClarification, +!nosession, +!help line)
- wsb/data/sessions.json (auto-created on first session)
