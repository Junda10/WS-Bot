# PM 真实授权群与 PM2 验收清单

> 状态：**等待用户提供生产身份并执行 live 验收**。本文件不得填写 API key、完整 JID、`.env` 内容、token、附件原文或备份内容；只记录“已核对/通过”、脱敏尾号、时间和负责人。

## 0. 验收边界

- 目标：验证真实 WhatsApp runtime JID、角色权限、完整 PM 流程、Markdown 摘要、附件重发、持久调度、备份以及 PM2 重启恢复。
- 非目标：不在生产群执行破坏性数据库操作，不运行 `npm audit fix`，不删除 `.wwebjs_auth`，不把真实配置复制到文档或工单。
- 失败规则：任一权限越界、重复工单、重复摘要、数据库/preflight 失败都应停止发布，保留现场并按 `docs/pm-recovery.md` 处理。

## 1. 用户必须在服务器本地提供的输入

- [ ] `PM_AUTHORIZED_GROUP_JID`：唯一验收群的实际 `@g.us` JID。
- [ ] `PM_ERIC_JID`：Eric 的实际 `@c.us` 或 `@lid` runtime JID。
- [ ] `PM_ADMIN_JIDS`：至少一个实际管理员 JID；多个以逗号分隔。
- [ ] 可选 `PM_BACKUP_OFFSITE_DIR`：独立于本地备份/附件/临时目录的私有绝对路径或挂载点；没有时明确接受 local-only 警告。
- [ ] 确认 `MY_NUMBER`、`GROUP_ID`、持久数据路径、附件上限、保留期、时区和恢复窗口均为生产值。
- [ ] 生产 `.env` 仅本地编辑且权限私有；未通过聊天、issue、文档、shell history 或验收记录传递秘密。

记录（只写脱敏尾号）：负责人 ______；日期/时区 ______；群尾号 ______；Eric 尾号 ______；管理员人数 ______；offsite 启用/不启用 ______。

## 2. 目标主机离线门禁

在**不启动第二个 Bot 实例**的维护窗口执行：

- [ ] `node --version` 为 22+。
- [ ] `npm ci` 使用当前 commit 的 lockfile 成功。
- [ ] `npm test` 连续两次通过且无网络依赖。
- [ ] 所有项目 JS 通过 `node --check`。
- [ ] `git diff --check` 通过。
- [ ] `npm run db:migrate` 成功且重复执行安全。
- [ ] `npm run db:check` 报告 integrity、foreign keys、PRAGMA 和 current migration 全通过。
- [ ] 最新本地 bundle 已运行 `npm run db:restore-check -- /absolute/bundle` 并通过。
- [ ] `npm run preflight` 输出 `READINESS: READY`；WARN 已解释并接受。
- [ ] `npm audit --omit=dev` 结果已记录和评估；只报告，未 auto-fix。
- [ ] `git status --short` 不包含 `.env`、数据库、WAL/SHM、session、附件、backup、OCR 数据或其他秘密。

记录：commit ______；测试次数/总数 ______；restore bundle 脱敏名称 ______；preflight ______；audit 摘要 ______。

## 3. 内置帮助与文档名称核对

在授权群发送以下命令；每个命令应显示本文档及三份角色指南所用的**相同命令名称**：

- [ ] `!pm help`
- [ ] `!pm help member`
- [ ] `!pm help eric`
- [ ] `!pm help admin`
- [ ] `!summary help`

逐项核对 `!pm help` 的规范命令：

```text
!pm add
!pm list open
!pm show TV1
!pm find <关键词>
!pm update TV1 title="..." description="..." owner="JID" reason="..."
!pm resolve TV1 note="验证说明"
!pm resend-file TV1 <附件编号>
!pm attachment TV1 <附件编号>
!pm retry-file TV1
!pm reply
!pm confirm-reply <token> TV1
!pm confirm-reply TV1
!pm cancel <token>
!pm archive TV1 reason="归档说明"
!pm delete TV1 reason="删除原因"
!pm restore TV1 reason="恢复原因"
!pm move-reply TV1 TV2 reason="纠错原因"
!pm move-reply TV1 TV2 reply=3 reason="多回复时指定回复编号"
!pm show TV1 deleted=true
```

- [ ] 未发现文档使用已删除、拼错或未启用的 PM 子命令。

## 4. 授权与角色边界

使用无敏感内容的验收消息：

- [ ] 非授权群发送 `!pm help`、`!summary 4h` 或带附件 PM 请求，不产生下载、AI 调用或 PM 数据修改。
- [ ] 普通授权群成员可 add/list/show/find/update/resolve/resend/retry，但不能 confirm/archive/delete/restore/move-reply。
- [ ] Eric 可执行 `!pm reply`、`!pm confirm-reply ...`、`!pm cancel ...`，但没有仅管理员权限（除非 JID 也明确列入管理员）。
- [ ] 管理员可 archive/delete/restore/move-reply，但管理员身份本身不能确认 Eric 回复。
- [ ] `@lid`/`@c.us` 使用实际 runtime 值；显示名改变不会改变权限。

## 5. 完整 PM 闭环与 5+ 队列

所有验收工单使用明显的“LIVE-ACCEPTANCE”无敏感标记，完成后按审计要求 resolve/archive：

- [ ] 建立至少 6 张等待工单，执行 `!pm list open`；全部显示且等待最久优先，没有只截前 5 张。
- [ ] 引用一条文字来源发送 `!pm add`；Bot 直接返回唯一 `TVn`，重复投递同一命令不产生第二张。
- [ ] 引用 Markdown/图片/PDF/DOCX 各执行一次 `!pm add`；附件保存/解析状态明确，AI 不确定时不编造。
- [ ] 用 `!pm update TVn ...` 修正标题/描述，并在 `!pm show TVn` 看到 revision 和审计时间线。
- [ ] Eric 引用一条 Tevau 测试回复发送 `!pm reply`；看到最多 3 个候选、理由、信心和一次性 token。
- [ ] 非 Eric 确认失败；Eric 用 `!pm confirm-reply <token> TVn` 成功；重复确认无第二条回复。
- [ ] 另一个 session 使用“引用 Bot 建议 + `!pm confirm-reply TVn`”成功，且并行 session 不串线。
- [ ] 成员执行 `!pm resolve TVn note="验证说明"`，管理员执行 `!pm archive TVn reason="验收归档"`。
- [ ] 管理员软删除/恢复一张专用验收工单；`!pm show TVn deleted=true` 仅管理员可见。
- [ ] 用专用双工单验证 `!pm move-reply TV1 TV2 ...` 后，两边时间线和当前回复归属正确。

记录（只写测试工单范围）：TV____ 至 TV____；异常 ______。

## 6. Markdown、附件与摘要

- [ ] 上传一个不建单的普通 `.md`，内容包含标题、列表、表格和代码块；等待解析完成。
- [ ] `!summary 4h` 显示该文件名/内容来源、讨论重点、决定、待办、全部未闭环 PM 队列和不确定项。
- [ ] `!summary today`、`!summary yesterday` 和 `!summary since 2026-07-20 09:00` 参数行为与部署时区一致；手动摘要不推进自动 cursor。
- [ ] `!pm show TVn` 显示附件编号；`!pm resend-file TVn <附件编号>` 和别名 `!pm attachment TVn <附件编号>` 只在授权群重发正确文件。
- [ ] 对可重试测试失败执行 `!pm retry-file TVn`，不新建工单。
- [ ] OCR 未启用时状态明确；若生产启用 OCR，本地 traineddata 检查和一份无敏感小样通过。

## 7. 原有 WSB 功能与 schedules 无回归

只使用不会泄露数据或大量广播的测试输入：

- [ ] `!help`、`!groups` 的既有行为正常。
- [ ] `!tech`、`!car`、`!property`、`!news` 至少各做一次受控 smoke；外部新闻故障只按原有错误路径处理。
- [ ] 经许可测试 `!ask`、`!translate`、`!weather`、`!fitness`；白名单管理命令不扩大权限。
- [ ] 日报 news schedule 仍按 `SCHEDULE_TZ` 注册一次。
- [ ] fitness schedule 仍按配置时间/目标注册一次。
- [ ] PM 报告的 10:00、14:00、20:00 schedule 使用 `PM_TIMEZONE` 且只注册一次。

## 8. PM2 重启、补报与持久性

- [ ] 重启前记录 `git rev-parse HEAD`、`pm2 status`、当前 open 队列和最新良好 bundle。
- [ ] 只执行 `pm2 restart whatsapp-bot --update-env` 一次。
- [ ] 日志显示 migration ready、WhatsApp ready、附件 ingress recovery、summary recovery 和 schedules 注册；无第二实例。
- [ ] 重启后 `!pm show`、已确认回复、附件重发、审计时间线和 open 队列仍在。
- [ ] 重投重启前命令不产生重复业务副作用。
- [ ] 构造/等待一个受控 partial summary 后重启，只恢复未确认 part；已发送 part 不重复。
- [ ] 过去 24 小时无漏报时不补；漏一份补原窗口；漏多份时明确标记合并延迟报告。
- [ ] 再次 ready/reconnect 不重复注册 PM、news、fitness schedules。

## 9. 备份、观察与签收

- [ ] 上线后维护任务产生一个新本地 verified bundle；bundle 权限私有。
- [ ] 新 bundle 通过 `npm run db:restore-check -- /absolute/bundle`。
- [ ] 配置 offsite 时，目标存在完整原子 bundle；失败时本地 bundle 仍保留且告警可见。
- [ ] 观察至少一个完整 PM 报告窗口或约定的维护时段，无重复发送、未处理 promise、持续重试或磁盘异常。
- [ ] 记录脱敏结果，不记录 token、完整 JID、来源附件或消息正文。

最终结论：通过 / 不通过 ______

负责人 ______  日期/时区 ______  commit ______  回滚点 ______  follow-up ______
