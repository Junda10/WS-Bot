# Tasks 1–17 验收审计

## 1. 范围与结论

本审计把 `.unipi/docs/plans/2026-07-22-wsb-tevau-pm-summary-plan.md` 的 Tasks 1–17 acceptance criteria 映射到已提交实现、离线 `node:test` 和运维检查。审计不把真实 WhatsApp 群、真实 OpenRouter、真实 OCR 数据、PM2 或 off-host 挂载测试伪装为已完成；这些属于 Task 18 live gate，见 `docs/pm-live-acceptance.md`。

**结论：Tasks 1–17 的可离线验收项均有实现与自动测试证据；真实群、生产身份、实际 PM2 restart、真实 schedules 观察和可选 offsite 目的地仍待用户验收。**

规范提交链：

| Task | 主要提交 |
|---|---|
| 1 | `1032592` |
| 2 | `70af9e7` |
| 3 | `0f94423` |
| 4 | `dc441f9`, `ecc125b` |
| 5 | `5970bcf`, `06fe079` |
| 6 | `2dcceb0`, `3ce6722` |
| 7 | `207f6b8` |
| 8 | `ad9369f` |
| 9 | `adb82b2` |
| 10 | `4b71bf4` |
| 11 | `0d53f48` |
| 12 | `74fd10f` |
| 13 | `59b0a71` |
| 14 | `195d1e0` |
| 15 | `bb6a982` |
| 16 | `0fd7a6b` |
| 17 | `a59b61a` |

## 2. Task-by-task acceptance mapping

### Task 1 — 运行时、依赖与安全配置基线：通过（离线）

- `package.json` 声明 Node `>=22`，CommonJS 启动命令保持 `node index.js`；lockfile 包含 SQLite、Luxon、解析、Sharp/Tesseract、安全文件类型依赖。
- `config.js` 集中解析 JID、数字、布尔、时区、cron、路径和资源上限；`index.js` 在初始化 WhatsApp 前执行严格 PM 校验。
- `.env.example` 覆盖授权身份、路径、20 MiB、30 天、时区、恢复、OCR/vision 和 backup/offsite；`.gitignore` 排除数据库 sidecar、附件、临时、备份、OCR、session 和 `.env`。
- 证据：`test/config.test.js`；最终 `node --check`、secret/JID scan 和 `.env` hash/status 复核。

### Task 2 — SQLite、migration 与诊断：通过（离线）

- `db/connection.js`、`db/migrate.js`、顺序 migration 和 CLI 支持新库/重复执行、事务回滚、`schema_migrations`/`user_version`。
- `foreign_keys=ON`、WAL、busy timeout、synchronous NORMAL 与完整性由 `db:check` 验证；migration 失败阻止 WhatsApp 初始化。
- 证据：`test/database.test.js`；Task 18 使用全新临时数据库再次执行 `db:migrate` 与 `db:check`。

### Task 3 — Schema、索引与 repositories：通过（离线）

- schema 包含 chats、permissions、messages、attachments/blob、issues/events、reply sessions/replies、summary runs/parts、sequence、maintenance；唯一约束覆盖 WhatsApp ID、窗口、token 等幂等键。
- 时间按 UTC 毫秒、状态约束/外键策略、事务 sequence、issue FTS 和已确认 reply 同步均由 repository 层实现。
- 证据：`test/repositories.test.js`、`test/database.test.js`，覆盖 CRUD、回滚、重复、FTS 和 reply move。

### Task 4 — JID 权限与工单领域：通过（离线）

- `PermissionService` 在业务入口使用 chat/runtime JID；角色区分 MEMBER、ERIC、ADMIN，管理员不隐式取得 Eric 权限。
- `IssueService` 强制合法状态转换、软删除、不可变事件、操作者/原因/before-after、首次响应和等待排序。
- 证据：`test/domain-services.test.js`、`test/candidate-shortlist.test.js`，包含非法转换、JID alias、并行 sequence、5+ queue 和事务冲突。

### Task 5 — WhatsApp adapter 与持久 ingress：通过（fake client）

- `whatsapp/normalize-message.js` 规范化 chat/sender/message/quote/media；`AuthorizedGroupIngress` 先验证群边界、持久化和 claim，再路由。
- SQLite 唯一键/ingress 状态提供重启幂等，内存 deduper 仅作快速过滤；发送文字、分段和归档附件通过 adapter。
- 证据：`test/whatsapp-adapter.test.js`、`test/message-deduper.js`、`test/pm-e2e.test.js`。
- live 限制：真实 `whatsapp-web.js` delivery/reconnect 留待 Task 18。

### Task 6 — history 兼容与集中路由：通过（离线）

- 授权群 history 使用 durable message repository，保留既有调用形状；命令也持久化并标记，摘要 source 排除命令噪音。
- parser/router 只在授权群处理 `!pm`/`!summary`，限制总长、参数长/数、引号和控制字符；legacy route 保持独立。
- 证据：`test/command-router-history.test.js`、`test/debounced-smart-reply.test.js`，包含旧 route、持久重启上下文和帮助 topic。

### Task 7 — PM 查询与非 AI 修改：通过（离线）

- 内置 handler/formatter 支持 `help/list/show/find/update/resolve/archive/delete/restore/move-reply/resend-file/attachment/retry-file`，权限与事务失败不会输出虚假成功。
- open list 不截断 5 项；show/search/引用、deleted 管理视图、详情时间线、附件编号和稳定 WhatsApp 分段均有覆盖。
- 证据：`test/pm-commands.test.js`、`test/repositories.test.js`；Task 18 增加指南命令集合与 `!pm help` 精确一致测试。

### Task 8 — 附件存储、安全边界与队列：通过（离线）

- allowlist、magic bytes/扩展联合判断、随机/哈希归档、展示名净化、20 MiB 及 parser/image/DOCX/时间上限集中配置。
- staging → atomic archive、blob hash 去重、状态/attempt/retry、并发 1 queue 和 media expiry/disk failure 处理均已实现。
- 证据：`test/attachment-security.test.js`，覆盖伪 MIME、路径穿越、symlink/交换、重复、ZIP bomb、磁盘/下载失败、queue 与 drain。

### Task 9 — Markdown/text/PDF/DOCX 解析：通过（离线）

- 普通 Markdown ingress 自动解析并进入 summary source；结构转纯文本，不执行 HTML、链接、脚本或文档指令。
- UTF-8/NUL、PDF 页/项/字符上限、DOCX ZIP/段落/表格、加密/损坏/超限 terminal status 均处理；issue promotion 改为长期保留。
- 证据：`test/attachment-parsing.test.js`、`test/manual-summary.test.js`，含 hostile Markdown、encoding、损坏和资源限制 fixtures。

### Task 10 — 图片与扫描 PDF OCR：通过（mock/offline）

- Sharp 负责 orientation/像素/格式/灰度标准化；lazy Tesseract worker 复用并串行，初始化/识别/render/关闭均有 timeout 和 terminate 路径。
- PDF 使用文本密度决定受限 OCR 页，不无条件展开；失败可保留部分/原附件，不阻止 PM add。
- 证据：`test/attachment-ocr.test.js`（fake worker/render）；真实 traineddata smoke 为显式可选，不计入默认通过。

### Task 11 — 结构化 AI 合约：通过（mock/offline）

- `extractIssue`、`matchReply`、`summarizeConversation` 统一返回可验证 envelope；字段、长度、confidence、candidate ID 和 attempts 经验证。
- prompt 把消息/附件标为不可信证据；非法响应不写业务记录；model fallback、timeout、输入预算和确定性 shortlist 有测试。
- 证据：`test/ai-structured.test.js`、`test/candidate-shortlist.test.js`；默认 suite 不访问 OpenRouter。

### Task 12 — `!pm add` 直接建单：通过（离线/fake media）

- 引用消息及 Markdown/image/PDF/DOCX 进入 attachment + AI extraction + transaction sequence；不确定时安全建立“资料待补充”。
- command/source 幂等防止重复工单；成功/失败格式显示编号、问题、附件状态、修正/恢复路径。
- 证据：`test/pm-add.test.js`、`test/pm-e2e.test.js`，覆盖无引用、AI 失败、媒体过期、重复和可恢复 partial。

### Task 13 — 回复匹配与 Eric 确认：通过（离线）

- deterministic shortlist 后 AI 只在最多 3 个候选中建议；token 绑定 chat、Eric、source、candidate，有过期/取消/一次性消费。
- token 或 Bot suggestion quote 才能确认；确认保存完整回复、首响、审计；重复安全，管理员 move-reply 可纠错。
- 证据：`test/pm-reply.test.js`、`test/domain-services.test.js`、`test/pm-e2e.test.js`，包含 5+ 相似、并行 session、错误角色/候选/引用、重启/replay。

### Task 14 — 时间窗与确定性 PM 报告：通过（离线/fake clock）

- Luxon 计算 Kuala Lumpur 半开窗口并转 UTC；10:00 含昨日统计。
- PM model 始终提供变化、消息数、所有 WAITING_TEVAU/REPLIED 未解决项和稳定排序；AI/空窗口不影响确定性内容。
- 证据：`test/pm-report.test.js`，覆盖跨日、月末、年末、时区、空数据和 5+ queue。

### Task 15 — 手动/AI 群聊与 Markdown 摘要：通过（mock AI）

- 支持 `!summary`、`Nh`、`today`、`yesterday`、`since`，使用配置时区且不推进自动 cursor。
- 聊天/Markdown 来源受限分块，输出讨论/决定/待办/负责人/变化/完整队列/不确定项；AI 失败确定性降级，长消息稳定分段。
- 证据：`test/manual-summary.test.js`、`test/pm-e2e.test.js`，包含 pending/failed Markdown、长/空窗口和 mock AI failure。

### Task 16 — 持久定时调度、分段与补报：通过（fake cron/adapter）

- 10:00/14:00/20:00 使用配置时区和 idempotent registration；DB run/part ledger 唯一 claim 并记录稳定 body/hash/receipt。
- partial failure 只恢复未成功 part；发送后确认前崩溃可 reconcile；startup 24h 漏一份/多份恢复和有限 retry 已覆盖。
- 证据：`test/scheduled-summary.test.js`、`test/pm-e2e.test.js`，包含 reconnect、process restart simulation 和 sealed manifest 不重建。
- live 限制：真实 PM2/WhatsApp transport observation 留待 Task 18。

### Task 17 — 保留、备份与 restore-check：通过（临时文件系统）

- 精确 retention cutoff 清理普通消息/Markdown/临时资源，保留 issue source snapshot、reply/event 和 linked attachment；active lease 不被误删。
- `BackupService` 使用在线 SQLite backup、seal/check、附件 SHA-256 manifest、原子 publication、14 份 verified retention 和可选 filesystem offsite adapter。
- `restore-check` 拒绝 symlink/traversal/未知/缺失/损坏/过期 schema，并在隔离临时目录复核数据库和附件。
- 证据：`test/maintenance.test.js`；Task 18 额外建立小型 fresh-DB bundle 并运行 CLI restore-check。
- live 限制：实际 off-host mount 与生产 bundle 容量/传输仍待用户。

## 3. 横向安全与回归审计

- dedupe regression：`test/message-deduper.js` 已纳入 `node:test`。
- XSS 与 scoped reply cache regression：`test/security-regressions.js` 已纳入 `node:test`。
- fake-client 业务主链：`test/pm-e2e.test.js` 覆盖 Markdown → add → 6-ticket list → AI match → Eric confirm → resolve → archive → summary → attachment resend → partial report restart recovery。
- production preflight：`test/production-preflight.test.js` 覆盖 private paths、current database、disk reserve、OCR missing、old Node、redaction 和 READY/NOT READY。
- secret review：只允许 `.env.example` placeholders、测试专用明显 fake JID/key；真实 `.env` 保持 ignored、unstaged 和 hash 不变。

## 4. Task 18 待用户项

以下项目不能由离线 agent 代替：

1. 在服务器本地提供并核对 `PM_AUTHORIZED_GROUP_JID`、`PM_ERIC_JID`、`PM_ADMIN_JIDS`；
2. 决定是否配置可选 `PM_BACKUP_OFFSITE_DIR`；
3. 在真实授权群执行角色、附件、摘要和 legacy command 验收；
4. 受控执行并观察 PM2 restart、补报、数据持久性及 news/fitness schedules；
5. 对生产上线/回滚点进行人工签收。
