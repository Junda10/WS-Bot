---
title: "WSB Tevau PM 与群聊摘要 — Implementation Plan"
type: plan
date: 2026-07-22
workbranch: ""
specs:
  - .unipi/docs/specs/2026-07-22-wsb-tevau-pm-summary-design.md
---

# WSB Tevau PM 与群聊摘要 — Implementation Plan

## Overview

本计划在 `/home/chin/wsb` 的 `main` 分支直接实施模块化 SQLite 单体，为现有 WhatsApp Bot 增加：

- 授权群消息和用户上传 Markdown 的持久化总结；
- 图片、PDF、DOCX、Markdown、纯文字工单资料解析和长期归档；
- `TV1`、`TV2` 形式的 Tevau 工单生命周期、权限和审计；
- AI 直接建立问题，以及 AI 匹配回复后由 Eric 确认；
- 10:00、14:00、20:00 的幂等滚动报告、重试和补报；
- 备份恢复、自动清理、测试以及中文使用说明书。

普通 `.md` 附件即使未执行 `!pm add`，也要解析并纳入手动/定时群聊总结；其正文、解析结果和临时文件遵循普通消息 30 天保留期。通过 `!pm add` 关联的 Markdown 与其他工单附件长期保留。

建议实施依赖：`better-sqlite3`、`luxon`、`pdf-parse`、`mammoth`、`sharp`、`tesseract.js`、`file-type`、`sanitize-filename`。测试统一采用 Node 内置 `node:test`；OpenRouter 使用 mock，不在默认测试中访问网络。

## Tasks

- completed: Task 1 — 固定运行时、依赖与安全配置基线
  - Description: 明确 Node 22+ 基线，加入数据库、时区、附件解析和 OCR 依赖；扩展配置校验与运行目录忽略规则，为后续模块提供可注入配置。
  - Dependencies: None
  - Acceptance Criteria:
    - `package.json` 声明 Node `>=22`，依赖可在生产架构安装，现有启动命令保持有效。
    - `.env.example` 包含授权群 JID、Eric JID、管理员 JID、数据库/附件/临时目录、20 MB 文件上限、30 天消息保留、时区、报告恢复窗口、OCR/视觉策略和备份配置。
    - 缺失或格式错误的安全关键配置会在启动时给出明确错误；不会因 `NaN` 或空 JID 静默运行。
    - `.gitignore` 覆盖 SQLite、`-wal`/`-shm`、附件、临时文件、备份和 OCR 数据。
  - Steps:
    1. 更新 `package.json`、lockfile 和 Node engine，保留 CommonJS 兼容性。
    2. 在 `config.js` 增加集中解析、范围校验和 JID 列表规范化。
    3. 更新 `.env.example`、`.gitignore` 和 README 的运行时要求。
    4. 增加配置单元测试，覆盖有效、缺失和非法值。

- completed: Task 2 — 建立 SQLite 连接、migration 与诊断工具
  - Description: 使用 `better-sqlite3` 创建单例连接、事务边界、PRAGMA、按序 migration 和数据库健康检查。
  - Dependencies: Task 1
  - Acceptance Criteria:
    - 新数据库和已迁移数据库均可重复启动，migration 不重复执行。
    - `foreign_keys=ON`、WAL、`busy_timeout` 和合适的 synchronous 模式已验证。
    - migration 失败会完整回滚并阻止 Bot 进入 ready 状态。
    - `db:migrate`、`db:check` 脚本可分别执行迁移和 `integrity_check`。
  - Steps:
    1. 新建 `db/connection.js`、`db/migrate.js` 与 migration 目录。
    2. 以 `schema_migrations`/`user_version` 跟踪版本并在事务中应用 SQL。
    3. 新建 CLI 脚本和每测试独立的临时数据库 helper。
    4. 测试首次迁移、重复迁移、损坏 migration 和关闭连接。

- completed: Task 3 — 定义完整 schema、索引与基础 repositories
  - Description: 建立 chats、permissions、messages、attachments、issues、issue_events、reply_match_sessions、summary_runs、summary_run_parts 和序列表，并封装仓储接口。
  - Dependencies: Task 2
  - Acceptance Criteria:
    - WhatsApp message ID、报告窗口和确认 token 有数据库唯一约束。
    - 所有时间以 UTC 毫秒存储，状态有 CHECK/服务层约束，外键删除策略不会破坏工单历史。
    - `TVn` 使用事务化 sequence 分配，不通过 `MAX()+1`，删除后不复用。
    - FTS5 可检索标题、描述和已确认回复，未确认候选不会进入索引。
    - repository 测试覆盖 CRUD、事务回滚、重复插入和 FTS 同步。
  - Steps:
    1. 编写初始 schema、索引、FTS 表/触发器及 summary part/outbox 结构。
    2. 实现 message、permission、issue、attachment、summary repositories。
    3. 为 issue-linked message 使用保留 tombstone 或可空引用策略。
    4. 使用临时数据库测试所有约束和关键查询。

- completed: Task 4 — 实现 JID 权限与工单领域服务
  - Description: 实现授权群边界、成员/Eric/管理员角色、状态转换、短编号、等待时长和只追加审计事件。
  - Dependencies: Task 3
  - Acceptance Criteria:
    - 任何下载、AI 调用或数据库修改之前先验证授权群。
    - 群成员可 add/update/resolve；只有 Eric 可确认 Tevau 回复；只有管理员可 archive/delete/restore/move-reply。
    - `WAITING_TEVAU → REPLIED → RESOLVED → ARCHIVED` 的合法和非法转换均有测试。
    - delete 为软删除；每次修改记录操作者 JID、时间、原因和前后值。
    - 至少 5 个并行工单的等待时长和“最久优先”排序正确。
  - Steps:
    1. 新建 permission service、issue state 常量和转换规则。
    2. 实现事务化 create/update/resolve/archive/delete/restore。
    3. 实现首条回复响应时间、多回复事件和纠错移动。
    4. 测试角色、JID alias、并发编号和非法状态转换。

- completed: Task 5 — 建立 WhatsApp Adapter 与持久消息入口
  - Description: 规范化 WhatsApp message/chat/sender/quote/media 数据，先持久化再路由，并用数据库幂等取代只依赖 10 分钟内存去重。
  - Dependencies: Tasks 3, 4
  - Acceptance Criteria:
    - `chatJid`、`senderJid`、serialized message ID、UTC 时间和 quoted ID 规范化正确，不使用显示名授权。
    - 重复投递或重启后重投同一命令只产生一次业务副作用。
    - 现有 legacy commands、smart reply、clarification、cache、broadcast、news/fitness/FX 行为仍可调用。
    - 发送文字、分段消息和归档附件均通过可 mock 的 adapter。
  - Steps:
    1. 新建 `whatsapp/normalize-message.js` 和 `whatsapp/adapter.js`。
    2. 将 `client.on('message')` 改为“规范化 → 授权消息持久化 → 路由”。
    3. 保留 `message-deduper.js` 作为快速过滤，SQLite 唯一键作为最终依据。
    4. 用 fake client 测试引用、媒体、重复事件和发送接口。

- completed: Task 6 — 兼容现有 history 并集中命令路由
  - Description: 让现有 AI 上下文可从持久消息仓储读取，并建立 `!pm`/`!summary` router，同时不一次性重写旧命令。
  - Dependencies: Task 5
  - Acceptance Criteria:
    - `history.js` 现有调用接口和返回形状保持兼容，重启后仍能读取最近上下文。
    - 命令消息也持久化且标记 `is_command`，报告可按规则排除命令噪音。
    - PM/summary 命令只在授权群处理；旧命令继续走原有处理器。
    - parser 正确处理引号、空格、中文、缺参数和恶意超长参数。
  - Steps:
    1. 将 history 改为 message repository 的兼容 adapter。
    2. 新建 command parser/router，先接入 help 和未知命令反馈。
    3. 从 `index.js` 抽出 PM/summary 路由入口，保留旧逻辑适配层。
    4. 添加 parser、路由优先级和旧行为 smoke tests。

- completed: Task 7 — 实现 PM 查询和非 AI 修改指令
  - Description: 完成 help/list/show/find/update/resolve/archive/delete/restore/move-reply 的业务处理、格式化和附件重发入口。
  - Dependencies: Tasks 4, 6
  - Acceptance Criteria:
    - `!pm list open` 完整显示 5+ 等待问题并按等待最久优先。
    - `!pm show TVn`、关键词 FTS 和引用来源查询返回问题、回复、附件、时间线及响应时长。
    - 所有修改命令执行权限检查和事务；失败时不返回虚假成功。
    - 长详情会稳定分段，不超过 WhatsApp 限制。
  - Steps:
    1. 新建 PM command handler 和纯格式化函数。
    2. 接入查询、更新和生命周期命令。
    3. 接入附件重发授权检查，但暂不负责解析。
    4. 测试正常、无权限、已删除、不存在和超长输出场景。

- completed: Task 8 — 建立附件存储、安全边界与处理队列
  - Description: 安全下载引用附件，检测真实类型、限制资源、原子存储、哈希去重，并让 CPU 密集解析脱离 message handler 串行执行。
  - Dependencies: Tasks 1, 3, 5
  - Acceptance Criteria:
    - 支持的 allowlist 明确包含 `.md`/Markdown、纯文字、图片、PDF、DOCX；拒绝 legacy `.doc` 和未知可执行格式。
    - 不信任 WhatsApp MIME/文件名；使用 magic bytes/扩展规则、随机或哈希存储名和 sanitized 展示名。
    - 20 MB、页数、像素、解压大小、文本长度和处理时间有限制。
    - 重复、超限、下载失败、磁盘失败和媒体过期有明确状态与 `retry-file` 路径。
    - 附件处理并发默认 1，不阻塞 WhatsApp 事件循环。
  - Steps:
    1. 新建 storage、type detection、hash 和 processing queue。
    2. 实现 temporary → atomic issue archive 的文件生命周期。
    3. 记录 processing attempts、失败原因和可重试状态。
    4. 测试伪造 MIME、路径穿越、重复文件、ZIP bomb 限制和磁盘错误。

- completed: Task 9 — 实现 Markdown、纯文字、PDF 与 DOCX 解析
  - Description: 将 Markdown/UTF-8 文本、PDF 和 DOCX 转换为受限的可总结文本；普通群内 Markdown 自动进入摘要上下文。
  - Dependencies: Task 8
  - Acceptance Criteria:
    - 普通上传 `.md` 无需 `!pm add` 即可解析，其标题、列表、表格和代码块内容会纳入手动/定时摘要。
    - Markdown 保留结构化纯文本但不执行 HTML、链接、脚本或文档内指令；无效编码/NUL 有安全处理。
    - 文本 PDF 和 DOCX 段落/表格可提取；加密、损坏或超限文件显示“已保存，内容未解析”。
    - 普通 Markdown 的文件/解析正文按 30 天清理；工单附件及解析结果长期保留。
  - Steps:
    1. 实现 UTF-8 text/Markdown adapter 和不可信内容边界。
    2. 用 `pdf-parse` 实现文本 PDF 提取及页数/字符限制。
    3. 用 `mammoth` 实现 DOCX 原始文本和表格内容提取，不输出未净化 HTML。
    4. 将普通 Markdown extracted text 接入 message repository 和 summary source query。
    5. 添加 Markdown、PDF、DOCX、编码、损坏和提示注入 fixtures/tests。

- completed: Task 10 — 实现图片与扫描 PDF OCR
  - Description: 使用 Sharp 预处理图片、复用 Tesseract worker，并对低文本密度 PDF 页执行受限 OCR。
  - Dependencies: Tasks 8, 9
  - Acceptance Criteria:
    - 图片 EXIF 旋转、尺寸限制、灰度/归一化正确；英语和简体中文小样可提取文字。
    - 扫描 PDF 只对需要的受限页做 OCR，不把整个 PDF 无条件展开。
    - OCR worker 复用、并发为 1、可超时终止，进程关闭时不泄漏 worker。
    - OCR 失败允许部分结果并保留原附件，不阻止工单建立。
  - Steps:
    1. 实现 image preprocessor 和 lazy OCR worker lifecycle。
    2. 实现 PDF text-density 判断、页面渲染和逐页 OCR 限制。
    3. 接入 attachment extraction 接口及 parse status。
    4. 添加小型中英文图片/扫描 PDF smoke test；默认测试 mock 大型 OCR。

- completed: Task 11 — 扩展 AI 结构化接口与安全合约
  - Description: 在 `ai.js` 增加问题提取、回复匹配和分块摘要 API，返回可验证结果，而不是让业务逻辑解析任意自由文本。
  - Dependencies: Tasks 1, 9, 10
  - Acceptance Criteria:
    - `extractIssue`、`matchReply`、`summarizeConversation` 返回 `{ok,value,model,attempts,error}` 等明确结果。
    - JSON/字段类型、长度、置信度和候选 ID 均经过验证；非法结果不会改数据库。
    - 聊天与附件内容被明确标记为不可信证据，Markdown 内 prompt injection 无法覆盖系统规则。
    - OpenRouter fallback、超时和成本/文本上限有测试，默认测试不访问网络。
  - Steps:
    1. 抽出低层 structured chat 与 schema validator。
    2. 定义 issue extraction、reply matching、summary contracts 和 prompts。
    3. 先用 FTS/元数据缩小 open issues，再把紧凑候选交给 AI。
    4. 使用 mock/nock 测试有效、畸形、缺字段、超时和对抗响应。

- completed: Task 12 — 完成 `!pm add` 直接建单流程
  - Description: 解析被引用消息及附件，调用 AI，事务化创建 `TVn` 和审计事件，并在信息不足时安全降级。
  - Dependencies: Tasks 4, 6, 8, 11
  - Acceptance Criteria:
    - 引用聊天、Markdown、图片、PDF、DOCX 均可通过一次 `!pm add` 建立工单，无额外草稿确认。
    - 附件在建单时长期归档；AI 不确定时建立“资料待补充”工单而不编造事实。
    - 重复处理同一 `!pm add` 不产生第二张工单。
    - 成功回复显示 `TVn`、标题、提取问题、附件状态和修正指令；失败回复说明可恢复操作。
  - Steps:
    1. 解析 command message 与 quoted source 的稳定关联。
    2. 调用附件 pipeline 和 AI extraction，并限制输入大小。
    3. 在一个业务事务中分配编号、创建 issue/event/attachment links。
    4. 添加各附件类型、无引用、AI 失败、媒体过期和重复命令测试。

- completed: Task 13 — 完成 AI 回复匹配与 Eric 确认
  - Description: 实现 `!pm reply`、候选缩小、AI 匹配、一次性确认会话、取消/过期和管理员纠错。
  - Dependencies: Tasks 4, 6, 11, 12
  - Acceptance Criteria:
    - 5+ 相似未闭环工单时，Bot 返回建议工单、理由、信心和最多 3 个候选。
    - 只有配置的 Eric JID 可确认；确认必须引用匹配提示或携带短 session token，避免并行回复混淆。
    - token 绑定来源回复、Eric 和候选，只能消费一次且会过期。
    - 确认后保存完整回复、首响时间和事件；重复确认无副作用；管理员可 move-reply 修正。
  - Steps:
    1. 建立 deterministic shortlist 和 AI candidate mapping。
    2. 生成短 session token，持久化 quoted response 和过期时间。
    3. 实现 confirm/cancel/expiry 及主动工单更新消息。
    4. 测试并行 session、错误候选、非 Eric、重启、重复确认和回复移动。

- completed: Task 14 — 实现报告时间窗与确定性 PM 报告数据
  - Description: 使用 Luxon 计算 Kuala Lumpur 固定窗口，并从数据库生成不依赖 AI 的工单变化、昨日统计和完整未闭环队列。
  - Dependencies: Tasks 3, 4
  - Acceptance Criteria:
    - 10:00 为前一日 20:00–当日 10:00，14:00 为 10:00–14:00，20:00 为 14:00–20:00；存储边界转成 UTC。
    - 10:00 额外产生昨日新增/回复/解决/未闭环统计。
    - 所有等待问题和 REPLIED 未解决问题都显示，5+ 工单不截断，排序稳定。
    - 空窗口和 AI 失败时仍能输出可信 PM 队列、变化和消息数量。
  - Steps:
    1. 新建纯函数 `summaries/window.js` 并注入 clock。
    2. 实现 event queries、等待时长和 yesterday stats。
    3. 建立 deterministic report model 与格式化函数。
    4. 测试跨日、月末、年末、时区和空数据。

- completed: Task 15 — 实现手动及 AI 群聊/Markdown 摘要
  - Description: 对聊天文字和普通 Markdown extracted text 分块总结，组合确定性 PM 部分并稳定拆分 WhatsApp 消息。
  - Dependencies: Tasks 9, 11, 14
  - Acceptance Criteria:
    - `!summary`、`4h`、`today`、`yesterday`、`since` 参数按时区正确解析，且不推进自动报告游标。
    - 普通群上传 Markdown 内容在所属时间窗纳入摘要，并标注文件名来源；未解析完成时报告明确提示。
    - 输出包含讨论重点、决定、待办/负责人、工单变化、所有未闭环问题和不确定项。
    - 超长聊天分块后有稳定合并结果；空窗口、AI 失败和 5+ 工单均有确定性降级。
    - 分段消息满足 WhatsApp 长度并保持 `1/N` 顺序。
  - Steps:
    1. 实现手动时间参数 parser 和 source query。
    2. 将聊天、发言者和 Markdown 来源转换为受限 chunk。
    3. 调用 AI summary contract 并与 PM report model 合并。
    4. 实现 deterministic message splitter 和格式化。
    5. 测试 Markdown 来源、空窗口、长窗口、失败降级和不改自动游标。

- completed: Task 16 — 实现持久定时调度、分段发送与启动补报
  - Description: 保留 `node-cron`，将 cron 降为触发器，以 SQLite run/part ledger 负责 claim、重试、防重复和恢复。
  - Dependencies: Tasks 5, 14, 15
  - Acceptance Criteria:
    - 10:00、14:00、20:00 使用配置时区和 `noOverlap` 注册，重连不会重复注册。
    - `(chat,type,start,end)` 只 claim 一次；每个分段独立记录 WhatsApp message ID。
    - 中途崩溃只重发未成功 part，不重复已成功 part。
    - 启动检查过去 24 小时：漏一份补原窗口，漏多份合并成明确标记的延迟报告。
    - AI/发送失败执行有限退避重试；全部 part 成功后 run 才完成。
  - Steps:
    1. 新建 scheduler registration、summary runner 和 recovery service。
    2. 实现 run claim、stable parts、part send acknowledgement 和 retry 状态。
    3. 在 DB migration 完成且 WhatsApp ready 后注册任务并执行 recovery。
    4. 测试重复 cron、PM2/WhatsApp 重连、partial send、重启和 missed windows。

- completed: Task 17 — 实现保留清理、备份与恢复校验
  - Description: 清理 30 天普通消息/Markdown 和临时资源，同时保护工单证据；使用在线 SQLite backup 和附件 manifest 建立可验证备份。
  - Dependencies: Tasks 3, 8, 13, 16
  - Acceptance Criteria:
    - 超过 30 天的普通消息、普通 Markdown 文件和 extracted text 被清理，issue-linked 来源以 tombstone/长期记录保留。
    - 过期 reply sessions、临时文件和失败处理残留可安全回收。
    - `db.backup()` 快照通过 `integrity_check`；附件 manifest 包含相对路径、大小和 SHA-256。
    - 默认保留 14 个本地快照；可配置异地上传接口，失败不会删除最后一个良好备份。
    - restore-check 可在临时目录验证数据库和附件 manifest。
  - Steps:
    1. 实现 retention queries 和 issue-linked 保护规则。
    2. 实现 temp/session cleanup，并通过 scheduler 调用。
    3. 实现在线 snapshot、integrity check、manifest 和 retention。
    4. 建立可选 off-host adapter 与 restore-check CLI。
    5. 测试边界日期、关联保留、损坏文件、上传失败和恢复。

- awaiting_user: Task 18 — 统一测试、说明书与受控上线
  - Description: 将现有测试统一到 `node:test`，补齐端到端 fake-client 场景，编写中文说明书并在真实授权群受控验收。
  - Plan Note: 非 live 实现、文档、离线验收与受控 preflight 已完成；继续上线前必须由用户在服务器本地提供并核对 `PM_AUTHORIZED_GROUP_JID`、`PM_ERIC_JID`、`PM_ADMIN_JIDS`，决定是否提供可选 `PM_BACKUP_OFFSITE_DIR`，并完成仍待处理的真实授权群与 PM2 restart/schedule/data-recovery acceptance（不得把真实 JID 或秘密提交到仓库）。
  - Dependencies: Tasks 1–17
  - Acceptance Criteria:
    - `npm test` 单一命令在无网络条件下稳定通过，并保留现有 dedupe、XSS 和 cache regression coverage。
    - 覆盖 add → AI 匹配 → Eric 确认 → resolve → archive、5+ 并行问题、Markdown 总结、重启补报和附件重发。
    - `docs/pm-member-guide.md`、`docs/pm-eric-card.md`、`docs/pm-admin-guide.md`、`docs/pm-recovery.md` 与 `!pm help` 命令一致。
    - README 说明 Node、配置、migration、备份、数据保留及故障降级。
    - 真实授权群完成验收，现有 WSB 命令及 news/fitness/FX schedules 无回归，PM2 重启后数据和任务恢复。
  - Steps:
    1. 将已有 assert scripts 迁移或接入 Node test runner。
    2. 建立 fake WhatsApp、fake clock、mock AI 和临时数据库端到端 harness。
    3. 补齐安全、恢复、并行工单和 Markdown 自动摘要场景。
    4. 编写四份中文说明书和内置 help。
    5. 配置实际授权群、Eric/管理员 JID、附件上限和备份目的地。
    6. 在测试/授权群执行验收清单、备份当前版本并受控重启上线。

## Sequencing

主依赖链：

```text
Task 1
  → Task 2 → Task 3 → Task 4
                     ├→ Task 5 → Task 6 → Task 7
                     ├→ Task 8 → Task 9 → Task 10
                     │                     └→ Task 11 → Task 12 → Task 13
                     └→ Task 14 ────────────────→ Task 15 → Task 16
Task 3 + Task 8 + Task 13 + Task 16 → Task 17
Tasks 1–17 → Task 18
```

建议按以下里程碑执行并在每个里程碑运行当时已有的全部测试：

1. **基础持久层（Tasks 1–4）**：运行时、配置、数据库、权限和领域规则；
2. **平台接入（Tasks 5–7）**：持久消息、兼容旧逻辑、基础 PM 指令；
3. **附件与 AI（Tasks 8–13）**：Markdown/PDF/DOCX/OCR、直接建单、Eric 回复确认；
4. **摘要与可靠调度（Tasks 14–16）**：滚动窗口、Markdown 总结、分段幂等发送和补报；
5. **运维与上线（Tasks 17–18）**：保留、备份、完整回归、说明书和真实群验收。

虽然用户选择直接在 `main` 工作，但每个任务仍应独立提交；任何里程碑测试失败时停止后续任务，不部署部分完成状态。

## Risks

- **变更面很大**：`index.js` 同时承载大量旧功能。采用 adapter 和 compatibility layer 渐进迁移，不在同一任务重写全部旧命令。
- **Node/native module 兼容**：`better-sqlite3`、Sharp 和 OCR 依赖原生/平台能力；安装前确认 Node 22+、CPU 架构、构建工具和预编译包。
- **磁盘与内存压力**：WhatsApp media 为 base64，OCR、Chromium、WAL、附件和备份会增加资源使用。上线前检查容量，严格限制 20 MB、PDF 页数、像素及 OCR 并发，并设置清理告警。
- **Markdown prompt injection**：所有 `.md` 正文只作为不可信证据，禁止文档内容覆盖系统/权限规则；自动摘要不得执行 Markdown 内脚本、链接或指令。
- **普通 Markdown 时序**：报告生成时附件可能仍在解析。报告要显示 pending/failed 状态，不能静默漏掉文件。
- **AI 错配**：即使高信心也必须由 Eric 确认；并行回复会话必须用引用或短 token 区分。
- **部分分段重复**：run 级 success 不足以防止崩溃后重复，必须持久化每个 part 的发送状态和 message ID。
- **身份变化**：WhatsApp 可能返回 `@lid` 或 `@c.us`；使用实际 runtime JID 并提供受控 alias，不使用显示名。
- **附件安全**：DOCX ZIP bomb、PDF/OCR DoS、伪造 MIME 和恶意文件必须在 AI/解析前受限。
- **备份不完整**：只复制 live SQLite 文件或只备份数据库都会丢 WAL/附件；必须使用在线 backup 并校验附件 manifest。
- **main 分支风险**：直接实施在 main，必须任务级提交、每阶段回归、上线前备份和明确回滚点。
- **外部配置待提供**：真实群、Eric/管理员 JID 和异地备份目的地在 Task 18 上线前必须配置；代码和测试使用注入值，不应硬编码。
