# PM 管理员与上线指南

## 1. 管理员职责

管理员负责权限配置、归档、软删除/恢复、回复纠错、备份验证、保留策略和受控上线。授权只使用实际 JID，不使用 WhatsApp 显示名。

发送 `!pm help admin` 查看管理员命令；完整帮助为 `!pm help`。

## 2. 管理员命令（与 `!pm help` 一致）

```text
!pm archive TV1 reason="归档说明"
!pm delete TV1 reason="删除原因"
!pm restore TV1 reason="恢复原因"
!pm move-reply TV1 TV2 reason="纠错原因"
!pm move-reply TV1 TV2 reply=3 reason="多回复时指定回复编号"
!pm show TV1 deleted=true
```

- `archive`：只归档已解决工单，原因应可审计。
- `delete`：软删除，不抹除审计和证据。
- `restore`：按领域规则恢复已归档或软删除工单。
- `move-reply`：把误配的已确认回复从来源工单移到目标工单；多回复时用 `reply=<编号>` 明确选择。
- `show ... deleted=true`：仅管理员查看软删除工单。

管理员同时具有群成员能力；群成员命令见 `docs/pm-member-guide.md`。管理员不会自动取得 Eric 的回复确认权限。

## 3. 上线前配置

真实 `.env` 只在服务器本地维护，绝不提交。至少核对：

- Node.js 22+；
- `MY_NUMBER`、`GROUP_ID`；
- `PM_AUTHORIZED_GROUP_JID`（`@g.us`）；
- `PM_ERIC_JID`（`@c.us` 或 `@lid`）；
- `PM_ADMIN_JIDS`（逗号分隔）；
- `DB_PATH`、`PM_ATTACHMENTS_DIR`、`PM_TEMP_DIR`、`PM_BACKUP_DIR`；
- `PM_MAX_FILE_MB`、保留天数、时区、报告恢复窗口；
- `OPENROUTER_API_KEY`（缺失时为确定性降级）；
- 可选 `PM_BACKUP_OFFSITE_DIR`（独立绝对路径/挂载点）。

不要在工单、文档、日志或验收清单中粘贴 key 或完整 JID。

## 4. 离线预检与数据库

以下命令都不会连接 WhatsApp；`preflight` 也不会访问网络：

```bash
node --version
npm ci --omit=dev
npm run db:migrate
npm run db:check
npm run preflight
```

`npm run preflight` 检查 Node、配置和 JID 格式、数据库当前 migration/完整性、私有可写目录、磁盘余量、OCR traineddata、备份与可选异地目录，并只输出脱敏身份。出现 `NOT READY` 时不得重启生产进程。

## 5. 自动摘要与维护窗口

默认报告时区为 `Asia/Kuala_Lumpur`：10:00（昨日 20:00–今日 10:00）、14:00（10:00–14:00）、20:00（14:00–20:00）。SQLite run/part ledger 保证相同窗口只 claim 一次；部分发送失败后仅重试未确认分段。启动时默认检查过去 24 小时，漏一份补原窗口，多份合并为延迟报告。

默认维护任务为每日 02:30：先执行保留清理，再建立验证备份。修改 cron 或时区前要在测试环境运行完整测试。

## 6. 保留、备份与恢复演练

普通消息和普通 Markdown 默认 30 天；工单来源快照、附件、已确认回复和审计历史永久保留。备份必须包含 SQLite 在线快照、工单附件字节和 SHA-256 manifest，默认保留最近 14 个已验证本地 bundle。

检查现有 bundle：

```bash
npm run db:restore-check -- /absolute/path/to/wsb-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx
```

该命令只在私有临时目录恢复校验，不覆盖生产数据库。异地复制失败不会删除已成功的本地 bundle，但必须在运维记录中跟进。

手工恢复时停止写入后，先保留当前数据库、WAL/SHM、附件和 `.wwebjs_auth` 的只读副本；仅使用通过 restore-check 的 bundle。详细步骤见 `docs/pm-recovery.md`。

## 7. PM2 受控发布与回滚

1. 记录当前 commit、PM2 状态和最新良好备份。
2. 在不启动 Bot 的环境完成 `npm test`、migration、`db:check`、`preflight`。
3. 根据 `docs/pm-live-acceptance.md` 在授权群完成值核对。
4. 只重启指定应用：`pm2 restart whatsapp-bot --update-env`。
5. 观察 ready、migration、定时任务注册、启动补报和错误日志；不要连续重复 restart。
6. 验收旧命令、news/fitness schedules、PM 流程和数据重启恢复。

回滚时先阻止新写入并备份现场，再切回记录的良好 commit、安装其 lockfile 依赖并执行该版本兼容的检查。数据库 migration 默认向前；未经恢复演练，不要直接降级数据库文件。需要回退数据时，只能使用上线前已验证 bundle，并按恢复文档操作。
