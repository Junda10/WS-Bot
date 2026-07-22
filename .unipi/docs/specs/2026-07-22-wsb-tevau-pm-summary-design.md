---
title: "WSB Tevau PM 与群聊摘要"
type: brainstorm
date: 2026-07-22
---

# WSB Tevau PM 与群聊摘要

## Problem Statement

在一个内部 WhatsApp 监督群中，WSB Bot 需要同时承担两项同等重要的职责：

1. 作为群聊摘要员，通过成员指令按需总结，并在每日 10:00、14:00、20:00 主动发送滚动摘要；
2. 作为 Tevau 跟进 PM，确保转交给 Tevau 的问题不会被遗漏，持续记录每个问题、回复、状态和关键时间。

目前 Eric 会把群内文档和问题人工转发给群外的 Tevau，再把 Tevau 回复人工转回内部群。Bot 不负责跨群转发。Bot 必须允许群成员以明确指令建立和更新问题，也要支持“引用消息或附件后由 AI 提取”的低成本录入方式。

成功标准：

- Bot 重启后，群消息、工单、附件和定时汇报记录不丢失；
- 每个问题都有简短稳定编号、状态、问题资料、Tevau 回复及完整时间线；
- `!pm add` 是明确授权，AI 提取后可直接建立工单；
- Tevau 回复由 AI 在多个待回复问题中匹配，但必须由 Eric 确认后才能入库；
- 每次自动报告完整展示所有未闭环问题，能处理至少 5 个并行等待问题；
- 成员可在需要时按编号、关键词或引用消息查看完整问题和附件；
- 普通群消息保留 30 天，工单、审计历史和工单附件长期保留；
- 群成员可新增、更新和解决问题，管理员才能删除、归档、恢复或移动误关联回复。

## Context

项目位于 `/home/chin/wsb`，是一个由 PM2 管理的 Node.js/CommonJS WhatsApp Bot。主要现状如下：

- `/home/chin/wsb/index.js` 包含 WhatsApp 客户端、命令路由、消息处理和定时任务，逻辑较集中；
- `/home/chin/wsb/ai.js` 已通过 OpenRouter 使用 GLM 模型，可复用现有 AI 调用与降级模式；
- `/home/chin/wsb/history.js` 已记录群消息和发言者，但只存于内存，重启即丢失，并受 200 条消息上限影响；
- 已使用 `node-cron` 和 `Asia/Kuala_Lumpur` 时区，且有防止重连后重复注册任务的 guard；
- 当前没有数据库、migration、持久任务队列或 Tevau 工单模型；
- 现有状态主要依赖内存和同步写入的 JSON 文件，不适合事务化工单、时间线和审计；
- 当前只有一个内部监督群，Eric 是与 Tevau 之间的人工信息中转者；
- 需要理解并长期保存的工单资料包括图片、PDF、DOCX 和纯文字。

该需求包含群聊摘要与工单管理两个业务模块，但两者共用同一个群消息源、SQLite、权限、附件和定时报告基础设施，因此作为一个模块化单体设计，而不是两个独立项目。

## Chosen Approach

在现有 WSB 进程内建设模块化 SQLite 单体：WhatsApp 接入层保持轻量，将命令解析、消息持久化、工单、AI 提取与匹配、附件、摘要、调度、权限和审计拆为职责清晰的模块。

继续以一个 PM2 服务部署，SQLite 作为唯一结构化持久层，附件存放在 Git 之外的受控目录。模块接口要允许未来在多群或高负载时把 AI 和定时任务拆到独立 Worker，但首版不引入双进程复杂度。

## Why This Approach

### 选择模块化 SQLite 单体的原因

- 当前只有一个群，SQLite 足以承载消息、工单、事件和汇报记录；
- 单进程部署最贴合现有 WSB 运维方式，交付和排错成本较低；
- SQLite 的事务、索引、外键、FTS 和 migration 能解决 JSON 无法可靠支持的审计、关联和并发更新问题；
- 将新增逻辑拆出 `index.js`，可降低对现有命令和智能回复的回归风险；
- 持久消息和汇报执行记录可确保重启后补报且不重复。

### 未选择的方案

1. **Bot 接入层 + 独立 Worker**：隔离 AI 与 WhatsApp 连接更强，但双进程任务锁、部署监控和 SQLite 并发对当前单群属于过度设计。未来多群或大量附件时可演进。
2. **轻量命令式 MVP + 内存历史**：开发更快，但重启会漏摘要，无法可靠补跑，与“不遗漏问题和汇报”的核心目标冲突。
3. **AI 自动改变所有工单状态**：自动化高但容易错建、错配。最终采用“明确 `!pm add` 直接建单；回复由 AI 匹配后 Eric 确认”的风险分级模式。
4. **完整年月工单号**：可读但日常输入过长。最终采用永不复用的 `TV1`、`TV2`、`TV3` 递增编号，数据库内部另用不可变主键。
5. **公开附件链接**：查询方便但会扩大敏感资料暴露面。附件只在授权群中由 Bot 重新发送。

## Design

### 1. Architecture and Components

- **WhatsApp Adapter**：接收和发送消息，提取群 JID、发送者 JID、WhatsApp message ID、引用关系与附件元数据；不承载工单业务规则。
- **Command Router**：集中解析 `!summary` 与 `!pm ...`，执行参数校验和帮助输出，避免继续扩展散落的条件分支。
- **Message Repository**：幂等持久化授权群消息，支持按精确时间窗检索和 30 天清理。
- **Issue Service**：负责工单编号、状态转换、字段更新、回复关联、软删除、恢复和事务。
- **AI Extraction and Matching Service**：从引用消息和已解析附件中提取问题；在全部未闭环工单中匹配 Tevau 回复并解释理由。AI 不绕过权限规则。
- **Attachment Service**：下载、校验、解析、归档和重新发送工单附件，管理临时文件和内容哈希。
- **Summary Service**：生成滚动群聊摘要，并与确定性的工单变化和未闭环队列组合。
- **Scheduler**：注册三个固定任务，建立持久执行记录，处理重试和启动补报。
- **Permission Service**：按 WhatsApp JID 识别群成员、Eric 和管理员，不依赖可修改的显示名。
- **Audit Service**：以只追加事件记录操作者、时间、动作、修改前后值和原因。

SQLite 启用 foreign keys、事务、WAL 和版本化 migration。运行时数据库与附件目录加入 `.gitignore`。工单附件按内部工单主键分目录保存，数据库记录原文件名、MIME、大小、哈希、路径、解析状态和来源消息。

### 2. Data Model

核心表及职责：

- `chats`：授权群和时区配置；
- `participants` / `permissions`：JID、角色和启用状态；
- `messages`：WhatsApp message ID、群、发送者、正文、引用消息、时间和命令标记；
- `message_attachments`：普通消息附件元数据；
- `issues`：内部主键、`TVn` 公开编号、标题、描述、当前状态、创建人、可选负责人、来源消息和时间字段；
- `issue_events`：创建、修改、收到回复、解决、归档、恢复、软删除和回复移动等只追加事件；
- `issue_attachments`：长期工单附件；
- `reply_match_sessions`：AI 候选、来源回复、Eric 确认 token 和过期时间；
- `summary_runs`：计划时间、覆盖窗口、状态、输出、重试次数和发送消息 ID；
- `bot_config`：授权群、Eric JID、管理员 JID、时区、保留期和文件上限。

`messages.whatsapp_message_id` 唯一。`summary_runs` 对 `(chat_id, window_start, window_end, report_type)` 建唯一约束。附件哈希用于去重。工单使用 SQLite FTS 支持标题、描述和回复关键词检索。

### 3. Issue Lifecycle

当前状态：

`WAITING_TEVAU → REPLIED → RESOLVED → ARCHIVED`

- 成员引用消息或文档并发送 `!pm add` 后，AI 直接提取并创建 `TVn`，状态立即为 `WAITING_TEVAU`；
- 不设置单独的 `forward` 步骤，因为 Bot 只在内部群中，无法验证 Eric 何时完成群外转发；
- 等待时间从工单创建时间起算，到首条经 Eric 确认的 Tevau 回复为止；当前不设 SLA，也不自动判定逾期；
- Tevau 可有多条回复，每条都作为事件保存；首条回复使状态进入 `REPLIED`；
- 群成员使用 `resolve` 确认问题真正解决；收到 Tevau 回复不等同于已解决；
- 管理员使用 `archive` 归档；`delete` 是软删除，管理员可以恢复；
- `TVn` 编号单调递增且永不复用，包括已删除工单，避免历史引用歧义。

### 4. Commands and User Experience

#### Add

成员引用问题消息、图片、PDF 或 DOCX：

```text
!pm add
```

该命令即为建立工单的明确授权。Bot 解析资料并直接回复：

```text
✅ 已建立 TV6｜商户登录出现 403
状态：等待 Tevau 回复
记录时间：07-20 09:42
等待时间：刚刚开始
附件：login-error.pdf、screenshot.jpg

AI 提取的问题：
商户账号 A102 登录后台持续返回 403，需 Tevau 检查权限配置。

若内容不准确：
!pm update TV6 description="..."
```

如果 AI 无法可靠生成标题或问题描述，仍建立工单，但明确标记“资料待补充”，不臆造缺失事实。

#### Record a Tevau Reply

Eric 引用转达的 Tevau 回复并发送：

```text
!pm reply
```

AI 对全部未闭环工单进行匹配，回复最可能的工单、理由和信心：

```text
🔎 我认为这条回复属于 TV3

TV3：商户登录出现 403
Tevau 回复：权限配置已修复，请重新登录。
匹配理由：回复提到“权限配置”和“重新登录”，与 TV3 最相关。
匹配信心：高

Eric 请确认：
!pm confirm-reply TV3

如匹配错误：
!pm confirm-reply TV5
或 !pm cancel
```

即使匹配信心高，也必须由配置中的 Eric JID 确认。确认 token 绑定来源消息和 Eric，且只能消费一次。确认后保存回复、响应时间并主动发送工单更新。

#### Update and Lifecycle Commands

```text
!pm update TV6 description="..."
!pm update TV6 owner=@member
!pm resolve TV6 note="商户已验证恢复"
!pm archive TV6
!pm delete TV6 reason="重复建立"
!pm restore TV6
!pm move-reply TV3 TV5
```

群成员可 add、update、reply 和 resolve。archive、delete、restore、move-reply 仅管理员可执行。所有变更写入审计时间线。

#### Detail and Search

```text
!pm show TV6
!pm find 登录失败
!pm list open
```

也可引用工单来源消息后发送 `!pm show`。详情包含问题、状态、负责人、来源、附件、所有 Tevau 回复、完整时间线、等待/响应时长和最近修改者。查询附件时由 Bot 在授权群重新发送，不提供公开 URL。

详情查询是辅助能力；主要状态信息由定时报告和回复确认后的主动更新提供。

#### Manual Summary

```text
!summary
!summary 4h
!summary today
!summary yesterday
!summary since 2026-07-20 09:00
```

不带参数时覆盖上一次成功自动报告结束后至当前。手动总结不推进或改变自动报告记录。空窗口明确回复“该时段无新消息”。

#### Help and Documentation

```text
!pm help
!pm help eric
!pm help admin
```

实现必须同时交付群成员说明书、Eric 快速操作卡、管理员手册和故障恢复说明。说明书示例与测试用例共用同一套命令。

### 5. Scheduled Reports

时区固定使用现有 `Asia/Kuala_Lumpur` 配置：

- 10:00：昨日 20:00 至今日 10:00；
- 14:00：今日 10:00 至今日 14:00；
- 20:00：今日 14:00 至今日 20:00。

每份报告固定包含：

1. 本窗口群聊重点；
2. 已作决定；
3. 待办事项与负责人；
4. 本窗口新增、收到回复、解决和归档的工单；
5. 全部等待 Tevau 回复的问题，按等待最久优先；
6. 已收到回复但尚未解决的问题；
7. AI 无法确认或需要人工补充的信息。

10:00 报告额外附“昨日工单统计”：昨日新增数、收到回复数、解决数和昨日结束时未闭环数。群聊语义摘要仍严格使用滚动窗口，避免重复。

至少 5 个并行等待问题必须逐项显示编号、标题、等待时长、创建人和附件数。报告过长时按“摘要 / 等待队列 / 其他状态”拆分，并标记消息序号。

### 6. Message and Report Data Flow

1. WhatsApp Adapter 接收授权群消息；
2. 先按 message ID 幂等写入 SQLite，再执行命令或普通消息处理；
3. Scheduler 到点后建立唯一 `summary_run`；
4. Summary Service 按固定起止时间读取消息和工单事件；
5. 长对话分块提炼后再合并，并保留来源消息 ID；
6. AI 摘要与数据库生成的工单队列组合；
7. WhatsApp 成功发送全部分段后，才将 run 标记为成功。

手动摘要建立独立 run 类型，不占用自动窗口唯一键。任何重试都复用同一 run，防止重复发送。

### 7. Attachment Processing and Retention

支持图片、PDF、DOCX 和纯文字：

- 图片交给支持视觉的模型；
- PDF 优先提取文字，扫描 PDF 再进行 OCR；
- DOCX 提取段落和表格文字；
- 默认单文件上限建议为 20 MB，并允许配置；
- 加密、损坏、超大或无法解析的文件仍可归档，但显示“附件已保存，内容未解析”；
- 只有经 `!pm add` 纳入工单的附件长期保存；
- 普通消息正文和附件元数据保留 30 天后清理；
- 临时下载和过期匹配会话文件自动清理。

AI 只接收完成当前任务所需的消息窗口、附件内容或候选工单，不发送无关的长期历史。附件文本中的提示视为不可信数据，不得覆盖系统规则或执行指令。

### 8. Error Handling and Recovery

- **Bot 离线错过报告**：启动时检查过去 24 小时。漏一份则补发原窗口；漏多份则合并为一份标记清楚时间范围的延迟补报；
- **AI 失败**：有限重试后发送确定性的工单队列、状态变化和消息数量，并标记群聊语义摘要暂不可用；
- **WhatsApp 发送失败**：run 保持 pending 并重试，未发送成功不得标记完成；
- **SQLite 失败**：事务回滚，Bot 不发送虚假的成功确认；短暂锁冲突有限重试；
- **附件失败**：工单仍可建立，列出失败文件，并支持 `!pm retry-file TV6`；
- **AI 回复错配**：Eric 确认前不写入；确认后由管理员用 `move-reply` 修正；
- **重复事件**：message ID、summary window、确认 token 和附件哈希分别实现幂等；
- **误操作**：软删除和可恢复归档，审计事件只追加；
- **备份**：每日生成 SQLite 一致性快照和附件清单，默认保留 14 天；异地目的地通过部署配置提供。

日志不得输出完整群聊正文、完整手机号或附件内容。所有 PM 功能仅在授权群启用，权限绑定 JID。

### 9. Testing Strategy

- **单元测试**：命令解析、角色权限、状态转换、等待时长、`TVn` 编号、报告时间边界；
- **数据库测试**：migration、外键、事务回滚、软删除、恢复、FTS、30 天清理；
- **幂等测试**：重复消息、重复 cron、重复确认、WhatsApp 重连；
- **附件测试**：图片、文本 PDF、扫描 PDF、DOCX、损坏/加密/超大文件；
- **AI 合约测试**：结构化提取、缺字段、提示注入、多个相似待办的匹配候选；
- **场景测试**：至少 5 个并行等待问题、乱序回复、Eric 更正候选、管理员移动误关联回复；
- **重启恢复测试**：消息和工单不丢失、等待时间连续、漏报补发且不重复；
- **报告测试**：空窗口、超长群聊、跨日、时区、AI 降级、分段发送；
- **验收测试**：测试群走通 add → AI 直接建立 → AI 匹配回复 → Eric 确认 → resolve → archive。

## Implementation Checklist

- [ ] 建立 SQLite 连接层、migration 框架、WAL/外键配置和一致性备份机制
- [ ] 定义并迁移消息、附件、权限、工单、事件、回复匹配会话和汇报执行表
- [ ] 从 `index.js` 抽离统一 Command Router 与 WhatsApp Adapter 接口
- [ ] 实现授权群消息的幂等持久化、精确时间窗查询和 30 天清理
- [ ] 实现按 JID 的群成员、Eric、管理员权限模型和管理配置
- [ ] 实现 `TVn` 编号及工单 add/update/resolve/archive/delete/restore 状态与审计事务
- [ ] 实现图片、PDF/OCR、DOCX 的下载、解析、哈希、长期归档、重试和安全限制
- [ ] 实现 `!pm add` 的引用消息/附件 AI 提取与直接建单流程
- [ ] 实现面向多个未闭环工单的 AI 回复匹配、Eric 一次性确认和管理员纠错流程
- [ ] 实现工单详情、FTS 搜索、开放队列和授权群内附件重发
- [ ] 实现手动 `!summary` 的时间参数解析、分块摘要和工单状态组合
- [ ] 实现 10:00、14:00、20:00 持久化定时报告、幂等发送、重试和启动补报
- [ ] 实现 AI/WhatsApp/SQLite/附件失败时的明确降级输出和运行日志脱敏
- [ ] 补齐单元、数据库、幂等、附件、AI 合约、重启恢复和 5+ 并行工单场景测试
- [ ] 编写群成员说明书、Eric 快速操作卡、管理员手册、故障恢复说明及 `!pm help`
- [ ] 在测试群完成端到端验收并验证现有 WSB 命令和定时任务无回归

## Open Questions

以下属于部署配置，不改变已选架构：

- 授权监督群、Eric 和管理员的实际 WhatsApp JID；
- 附件单文件上限是否采用建议的 20 MB；
- SQLite 快照和附件的异地备份目的地及凭证管理方式；
- 扫描 PDF OCR 和图片视觉识别最终使用的模型/本地工具及成本上限；
- 群成员说明书最终采用中文，还是同时提供中英双语版本。

## Out of Scope

- Bot 自动在内部群与 Tevau 群之间转发消息；
- Tevau API、Webhook 或外部项目管理平台集成；
- 多群自助配置和跨群工单同步；
- 正式 SLA、节假日/工作时间计算和自动升级告警；
- Web 管理后台或公开附件下载页面；
- 对全部普通群聊附件进行长期下载和归档；
- 让 AI 在没有 `!pm add` 或 Eric 确认的情况下自主建立回复关联；
- 把现有所有 JSON 状态一次性迁移到 SQLite；该项可另行规划。
