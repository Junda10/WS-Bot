# PM 故障与恢复手册

## 1. 处置原则

1. 先保护数据，再恢复服务；不要反复重启。
2. 不在聊天、工单或公开日志中粘贴 API key、完整 JID、`.env` 或备份内容。
3. 记录 UTC 时间、当前 commit、PM2 进程状态和脱敏错误。
4. `npm run preflight`、`db:check`、`db:restore-check` 均为本地检查，不连接 WhatsApp 或网络。
5. 不执行不安全的 `npm audit fix --force`；先评估依赖与运行时影响。

## 2. 快速分流

### Bot 无法启动

```bash
node --version
npm run db:check
npm run preflight
pm2 logs whatsapp-bot --lines 200
```

- Node 必须为 22+。
- 配置错误：核对 `PM_AUTHORIZED_GROUP_JID`、`PM_ERIC_JID`、`PM_ADMIN_JIDS`，不要用显示名。
- migration/完整性错误：停止启动尝试，进入“数据库或附件损坏”。
- Chromium/WhatsApp session 错误：先保留 `.wwebjs_auth`，不要同时删除 session 和恢复数据库。

### PM 命令无权限或不响应

- 确认消息位于唯一授权群。
- 以 runtime JID 核对 `@c.us`/`@lid`，不要以昵称判断。
- 发送 `!pm help`，确认命令拼写与引号。
- 数据库 route 为 `FAILED` 时，原 WhatsApp 消息可安全重投；同一命令的业务幂等键会防止重复工单。

### AI/OpenRouter 故障

OpenRouter 缺 key、超时、429、5xx、模型输出非法时会尝试配置的 fallback 模型；全部失败后：

- `!pm add` 建立“资料待补充”工单，不编造内容；
- `!pm reply` 保留最多 3 个确定性候选，由 Eric 人工确认；
- 摘要仍输出数据库可确定的工单变化、完整队列和消息数量。

检查恢复后可处理新请求；不要为追求 AI 输出直接修改数据库中的历史结果。

### 附件或 OCR 故障

- `!pm show TV1` 查看附件编号、保存/解析状态和错误。
- 可重试状态使用 `!pm retry-file TV1`；已归档文件使用 `!pm resend-file TV1 <附件编号>`。
- 媒体过期时需要群成员重新上传并引用新文件。
- OCR 开启时，每个 `PM_OCR_LANGUAGES` 都必须在 `PM_OCR_LANG_PATH` 有可读的 `.traineddata` 或 `.traineddata.gz`。
- OCR 失败不删除原附件，也不阻止建单；不要把敏感附件上传到外部 OCR 服务。

### 定时摘要缺失或部分发送

- 10:00、14:00、20:00 使用配置时区和半开窗口。
- 每个分段有独立 ledger 和消息 ID；重启后只重发未确认分段。
- 传输成功但数据库确认前崩溃时，系统按隐藏 marker 查找近期 Bot 输出，找到后补记确认，不重复发送。
- 启动补报默认查看过去 24 小时。先观察恢复日志，不要手工重复触发相同窗口。

## 3. 数据库或附件损坏

### 立即动作

1. 停止 PM2 指定进程，避免继续写入。
2. 保存当前 commit 和日志。
3. 对当前数据库、`-wal`、`-shm`、附件目录、备份目录建立权限为私有的现场副本。
4. 不要直接复制正在写入的 SQLite 主文件作为“备份”；正常备份必须使用在线 backup API。

### 选择并校验备份

```bash
npm run db:restore-check -- /absolute/good/bundle --temp-dir /absolute/private/restore-temp
```

restore-check 会拒绝路径穿越、symlink、未知/缺失文件、哈希或大小错误、损坏 SQLite、过期 migration 和缺失工单附件。失败的 bundle 不得用于恢复。

### 手工恢复

1. 确认 Bot 已停止且无 SQLite 写进程。
2. 再次保存故障现场，不覆盖唯一副本。
3. 从通过校验的 bundle 取 `database.sqlite3` 和 manifest 所列附件，恢复到新的私有 staging 路径。
4. 核对文件 owner、目录 `0700`、文件 `0600`。
5. 原子切换数据库与附件；不要混用不同 bundle 的数据库和附件。
6. 运行：

```bash
npm run db:check
npm run preflight
```

7. 仅在全部通过后受控启动 PM2，并检查补报、附件重发和 `!pm show`。

## 4. 磁盘满与备份失败

- 停止产生大型附件/OCR 工作，保留数据库写入余量。
- 不手工删除工单附件、当前 WAL/SHM 或最后一个良好备份。
- 先确认普通临时文件是否已超过保留期，再让维护任务清理。
- 本地新 bundle 必须校验成功后才会裁剪旧 bundle；异地失败不影响本地 bundle。
- `npm run preflight` 会按文件、解析/OCR和备份限制计算所需 reserve；`NOT READY` 时先扩容或调整经过评审的安全限制。

## 5. 恢复后的验收

- `npm run db:check` 和 `npm run preflight` 为 READY；
- `!pm list open` 队列完整；
- 随机检查工单时间线、已确认回复和附件重发；
- Eric token 确认、成员 resolve、管理员 archive 权限正确；
- 普通 Markdown 出现在 `!summary 4h`；
- PM2 再次受控重启后，无重复工单/重复已发送摘要，漏报恢复正常；
- legacy 命令以及 news/fitness schedules 无回归；
- 记录恢复使用的 commit、bundle、时间和结果，不记录秘密。
