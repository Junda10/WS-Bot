---
title: "WSB Ask-User Threshold (Slot-Filling Clarification)"
type: brainstorm
date: 2026-05-20
---

# WSB Ask-User Threshold (Slot-Filling Clarification)

## Problem Statement

当用户在 WhatsApp 提出有歧义的需求（例："帮我查飞机票"），bot 现在直接走 `smartReply` 让 LLM 自由回答，导致答非所问或假设错用户偏好。需要一个机制：bot 自己"不确定"时停下来，用结构化选项反问用户，把需求澄清后才出最终答案。

灵感来自 Claude Code 的 `deep-interview` skill — 用 ambiguity 评分 + 阈值门控决定何时反问、何时回答。但 WhatsApp 场景没有 codebase 可探索，目标只是**了解顾客需求**，所以简化为 **intent + slot-filling** 模型。

## Context

- `wsb/index.js` 现有逻辑：`!` 开头走命令分支；其他消息直接 `smartReply(body, context)` 由 LLM 自由回答
- `wsb/memory.js`：已经有 JSON 文件持久化的模式（`addFact / trackTopic`）— session 存储复用同一套
- `wsb/ai.js`：封装了 OpenRouter LLM 调用，新模块复用
- 服务器现状：磁盘 93% 满（剩 1.4G），不适合上 sqlite；用纯 JSON 文件
- pm2 管理 wsb 进程，热重启 OK

## Chosen Approach

**纯 LLM 动态 slot-filling + JSON session + 无硬性轮数上限的 ambiguity 门控**

每条非命令消息：
1. LLM #1 `classifyIntent` 输出 `{intent, slots_filled, slots_missing, confidence, ready_to_answer}`
2. `ambiguity = 1 - confidence`，若 ≤ 10% 直接走 `smartReply` 出最终答案
3. 否则 LLM #2 `generateOptions` 针对 `slots_missing[0]` 生成 2-4 个具体选项 + 永远追加"其他（请直接说明）"兜底
4. 发送给用户、保存 session、等下一条消息
5. 用户回数字 → 填槽；回 freeform → LLM 解析并填
6. 循环直到 ambiguity ≤ 10% 或触发护栏，最终 `smartReply` 用填好的 slots 回答

## Why This Approach

- **纯 LLM 动态**（vs 预定义 intent 表）：用户决策。新业务/新话题无需改代码。
- **JSON 文件 session**（vs sqlite）：磁盘只剩 1.4G，不适合上新原生依赖；session 数据短命，丢了不致命；与现有 `memory.js` 模式一致。
- **无硬性轮数上限**（vs 3 轮硬截）：用户希望深入了解需求，靠 ambiguity 自然收敛，配 soft warning(10) + hard cap(20) 兜底。
- **永远保留"其他"兜底选项**：避免选项不全把用户逼死。
- **失败回退到原 smartReply**：任何 LLM 调用失败都不阻断现有功能。

## Design

### 数据流

```
消息进来
  ↓
是 ! 命令 → 走原命令分支（不变）
  ↓ 否
查 session(userId) 有进行中对话？
  ↓
  ├─ 有 → 解析用户输入（数字 or freeform）填入对应 slot
  │       → 重新跑 classifyIntent（更新后的 context）
  ↓
  └─ 无 → 直接跑 classifyIntent(body)
  ↓
ambiguity = 1 - confidence
  ↓
≤ 10% OR rounds ≥ 20 ──→ smartReply(完整 context) → 清 session → 发回复
  ↓ 否则
generateOptions(missing_slot)
  ↓
组装消息「问题 + 1./2./3./4.其他」
  ↓
保存/更新 session, rounds++
  ↓
发送，等用户回复
```

### 关键组件

| 文件 | 状态 | 职责 |
|------|------|------|
| `intent.js` | 新建 | 导出 `classifyIntent(text, session)` 和 `generateOptions(intent, missingSlot, slotsFilled)` |
| `session.js` | 新建 | `getSession / setSession / clearSession / pruneExpired`，30 分钟 TTL，持久化到 `data/sessions.json` |
| `ai.js` | 修改 | 新增 `answerWithSlots(intent, slots, userText)`，给最终答案 |
| `index.js` | 修改 | `message` handler 里在 `smartReply` 之前插入分流逻辑 |

### Session 数据结构 (`data/sessions.json`)

```json
{
  "601234567@c.us": {
    "intent": "flight_search",
    "slots": { "airline": "AirAsia" },
    "missing": ["depart_date", "from_to"],
    "lastQuestion": "什么时候出发？",
    "lastOptions": ["今天","明天","这周末","其他"],
    "rounds": 2,
    "startedAt": 1716220800000,
    "expiresAt": 1716222600000
  }
}
```

### classifyIntent 输出契约

```ts
{
  intent: string,              // "flight_search" | "hotel_search" | "general_chat" | ...
  slots_filled: Record<string, string>,
  slots_missing: string[],     // 按重要性排序
  confidence: number,          // 0..1
  ready_to_answer: boolean,    // confidence >= 0.9
  reasoning: string            // 一句话解释
}
```

### 护栏

| 护栏 | 行为 |
|------|------|
| Soft warning（rounds = 10） | 仅日志记录，不打扰用户 |
| Hard cap（rounds = 20） | 强制走 smartReply，附带 "信息可能不完整" 提示 |
| Session TTL 30 分钟 | 过期自动清除，下条消息当新对话 |
| 用户说"算了/取消/不用了" | 立即清 session，回复 "好的，已取消" |
| Intent 切换（LLM 检测） | 清旧 session，按新意图重开 |
| LLM 调用失败 | catch → 回退到原 `smartReply`，不阻断 |
| 用户回"1"但 lastOptions 为空 | 当 freeform 处理 |

### 模型选择

- `classifyIntent`：便宜快模型（haiku / deepseek-chat / gemini-flash），跑频繁
- `generateOptions`：同上
- `answerWithSlots`：现有 `OPENROUTER_MODEL` 主模型

### 与现有 memory.js 的关系

- `memory.js` 存的是**跨会话长期偏好**（用户喜欢什么）
- `session.js` 存的是**当前对话短期状态**（这一轮在问什么）
- 最终 `answerWithSlots` 可以同时拿 `getFactsSummary(userId)` + slots 作为 context

## Implementation Checklist

- [x] 创建 `wsb/session.js`：getSession/setSession/clearSession/pruneExpired + JSON 持久化 — Task 2
- [x] 创建 `wsb/intent.js`：classifyIntent + generateOptions，两个 LLM 调用，定义 prompt 和输出 JSON schema — Task 3
- [x] 修改 `wsb/ai.js`：新增 `answerWithSlots(intent, slots, userText, memoryContext)` — Task 4
- [x] 修改 `wsb/index.js` 的 `message` handler — Task 5
  - [x] `!` 命令分支前先 pruneExpired — Task 5
  - [x] 非命令消息：先查 session，有就解析数字/freeform 更新 slots — Task 5
  - [x] 跑 classifyIntent → 算 ambiguity → 分流 — Task 5
  - [x] 拦截"取消"关键词清 session — Task 5
  - [x] 走 smartReply / answerWithSlots 后清 session — Task 5
  - [x] try/catch 整段，失败回退到原 smartReply — Task 5
- [ ] 加 `data/sessions.json` 到 `.gitignore` 检查（已忽略 `data/` 就跳过）— 灰度阶段顺手
- [x] 配置：在 `config.js` 加 `clarificationEnabled`、`ambiguityThreshold=0.1`、`maxRounds=20`、`sessionTtlMs=1800000` — Task 1
- [x] 加 `!nosession` 命令手动清当前用户 session（调试用）— Task 6
- [x] 灰度：先用 env `CLARIFY_WHITELIST` 仅对白名单用户启用，验证后全量 — Task 7
- [x] 日志：每轮打印 `[CLARIFY userId round=N intent=X amb=Y%]` 方便调试 — Task 5
- [x] pm2 reload 测试，扫码后实测一个 flight_search 流程 — Task 7

## Open Questions

- LLM 输出 JSON 不稳定时怎么处理？建议在 prompt 强约束 + JSON 解析失败时直接回退到 smartReply（不阻断）
- "其他（请直接说明）" 用户回 freeform 后，要不要再问下一个 slot 还是直接尝试回答？建议：继续走 classifyIntent 让 ambiguity 自己判定
- 群聊场景下 session 用 `groupId+userId` 还是只 `userId`？建议 `userId`，跨群保持上下文
- ambiguity 评分模型用哪个具体的便宜模型？plan 阶段决定，初版可以先复用 `OPENROUTER_MODEL`

## Out of Scope

- 预定义 intent 表（方案 C）— 已被否决
- sqlite session 存储 — 磁盘紧张暂不上
- 多维度 ambiguity（Goal/Constraints/Criteria）— deep-interview 原味太复杂，WhatsApp 场景单一 confidence 足够
- Challenge agents（Contrarian/Simplifier/Ontologist）— 不适用
- 真正去查机票/订票 — 这是澄清模块，最终答案仍由 smartReply 给（可能只是推荐网址）
