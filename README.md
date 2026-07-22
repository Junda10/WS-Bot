# WSB WhatsApp Bot

WSB 是一个基于 `whatsapp-web.js` 的 CommonJS WhatsApp Bot。除原有新闻、健身、汇率、网站生成和智能回复外，它还为一个明确授权的群提供 Tevau PM 工单、附件归档、群聊/Markdown 摘要、持久定时报告、保留清理和可验证备份。

PM 数据保存在 SQLite；授权使用 WhatsApp runtime JID，不使用显示名。默认测试完全离线，不连接 WhatsApp、OpenRouter 或外部 OCR。

## 运行要求

- **Node.js 22+**（`package.json` 的最低版本）；
- npm 和与当前架构匹配的原生依赖环境；
- Google Chrome 或 Chromium（WhatsApp Web）；
- 一个可扫码登录的 WhatsApp 账号；
- PM/摘要生产启用时，必须取得授权群、Eric 和管理员的实际 runtime JID；
- 可选：本地 Tesseract `eng`/`chi_sim` traineddata、独立异地文件系统挂载点。

Ubuntu/Debian 可按系统仓库安装 Chromium；macOS 可使用 `brew install --cask chromium`。

## 安装与首次启动

```bash
git clone https://github.com/Junda10/WS-Bot.git
cd WS-Bot
node --version                 # 必须为 v22 或更新
npm ci
cp .env.example .env          # 只在服务器本地编辑，不提交
npm run db:migrate
npm run db:check
npm run preflight
npm start
```

首次启动会在终端显示 QR code。手机进入 **Settings → Linked Devices → Link a Device** 扫码；session 保存在被 Git 忽略的 `.wwebjs_auth/`。数据库 migration 必须成功后 WhatsApp 才会初始化。

生产 `.env` 至少需要：

- `MY_NUMBER`：Bot 账号号码，仅数字；
- `GROUP_ID`：原有新闻广播目标群；
- `PM_AUTHORIZED_GROUP_JID`：唯一可写入 PM/摘要的 `@g.us` 群；
- `PM_ERIC_JID`：可建立、确认和取消回复匹配的 `@c.us` 或 `@lid` 用户；
- `PM_ADMIN_JIDS`：至少一个管理员 JID，多个以逗号分隔；
- `DB_PATH`、`PM_ATTACHMENTS_DIR`、`PM_TEMP_DIR`、`PM_BACKUP_DIR`：建议使用私有、彼此分离的持久路径；
- `OPENROUTER_API_KEY`：AI 功能需要；缺失时 PM/摘要采用确定性降级，不跳过权限或审计；
- 可选 `PM_BACKUP_OFFSITE_DIR`：与本地备份/附件/临时目录分离的**绝对路径**。

完整变量、默认值与安全范围见 [`.env.example`](.env.example)。`config.js` 不保存秘密。任何真实 `.env`、API key、完整 JID、WhatsApp session、数据库和备份都不得提交。

## 配置重点

| 变量 | 用途 | 默认值 |
|---|---|---|
| `DB_PATH` / `DB_BUSY_TIMEOUT_MS` | SQLite 路径与锁等待 | `data/wsb.sqlite3` / `5000` |
| `PM_MAX_FILE_MB` | 单附件硬上限 | `20` |
| `PM_MESSAGE_RETENTION_DAYS` | 普通消息/普通 Markdown 保留 | `30` |
| `PM_TIMEZONE` | PM 报告和维护时区 | `Asia/Kuala_Lumpur` |
| `PM_REPORT_RECOVERY_HOURS` | 启动补报检查窗口 | `24` |
| `PM_MAINTENANCE_CRON` | 清理和备份任务 | `30 2 * * *` |
| `PM_BACKUP_RETENTION_COUNT` | 已验证本地 bundle 数 | `14` |
| `PM_OCR_ENABLED` | 是否启用纯本地 OCR | `false` |
| `PM_VISION_POLICY` | `off`/`ocr-only`/`ocr-first`/`vision-first` | `ocr-first` |

启动时会集中验证 JID、整数、布尔值、时区、cron、资源上限和目录重叠。空值、`NaN` 或格式错误不会静默启用 PM。

## 命令

原有命令包括 `!news`、`!tech`、`!world`、`!car`、`!property`、`!rank`、`!ask`、`!translate`、`!weather`、`!fitness`、`!groups` 和 `!help`；部分管理命令受原有白名单限制。

PM/摘要只在 `PM_AUTHORIZED_GROUP_JID` 处理：

```text
!pm help
!pm help member
!pm help eric
!pm help admin
!summary help
```

内置 `!pm help` 是命令名称的规范来源。四份角色/运维说明已按同一名称核对：

- [群成员指南](docs/pm-member-guide.md)
- [Eric 回复确认速查卡](docs/pm-eric-card.md)
- [管理员与上线指南](docs/pm-admin-guide.md)
- [故障与恢复手册](docs/pm-recovery.md)

## PM、附件与摘要行为

典型闭环为：引用来源执行 `!pm add` → AI 提取或“资料待补充”降级 → Eric 引用 Tevau 回复执行 `!pm reply` → Eric 以一次性 token/引用确认 → 成员验证并 resolve → 管理员 archive。短编号由数据库事务 sequence 分配，重复消息和重复命令由内存快速过滤与 SQLite 幂等共同保护。

支持 Markdown、UTF-8 纯文字、图片、PDF 和 DOCX；拒绝 legacy `.doc`、未知可执行格式、伪造类型、路径穿越和超限资源。图片/扫描 PDF OCR 默认关闭；未解析不等于附件丢失，原文件可保留并显示明确状态。

普通 `.md` 无需建单也会解析并进入手动/定时摘要。默认自动报告窗口（Kuala Lumpur）为：

- 10:00：昨日 20:00–今日 10:00，并含昨日统计；
- 14:00：10:00–14:00；
- 20:00：14:00–20:00。

run/part ledger 持久记录 claim、稳定分段和发送 receipt。进程在部分发送后重启，只恢复未确认分段；启动会检查配置的补报窗口。

## Migration、健康检查与测试

```bash
npm run db:migrate                     # 可重复执行，仅应用未执行 migration
npm run db:check                       # integrity/FK/PRAGMA/current schema
npm test                               # 全部 node:test，默认无网络
```

对独立数据库检查时不要改生产 `.env`：

```bash
npm run db:migrate -- --db /private/test/wsb.sqlite3
npm run db:check -- --db /private/test/wsb.sqlite3
```

可选真实 smoke 不属于默认测试：

```bash
npm run ocr:smoke -- --expect "known substring" ./sample-eng-chi.png
OPENROUTER_PM_SMOKE=1 npm run pm-ai:smoke -- --run
```

OpenRouter smoke 会产生费用，且必须显式 opt-in；不得在 CI 或普通验收中启用。

## 数据保留

普通消息、普通 Markdown 文件及解析正文按 UTC 精确规则清理：`sent_at < now - days × 24h`；边界时刻保留。以下数据长期保留：工单来源证据快照、issue-linked 附件、已确认回复、只追加审计历史和工单生命周期。

过期确认 session、临时 `.part` 和失败残留另有 grace period。活跃 ingress/附件 lease 不会被清理；summary lease 只由既有恢复流程回收。运行数据库（含 WAL/SHM）、附件、临时文件、备份和 OCR 数据均被 `.gitignore` 排除。

## 备份与恢复

每日维护先清理再使用 SQLite 在线 backup API 建立 bundle，包含：

- `database.sqlite3`（包含已提交 WAL 数据）；
- 去重后的永久工单附件；
- 记录相对路径、大小和 SHA-256 的 `manifest.json`。

发布前后都执行数据库完整性、外键、migration、manifest 和附件校验；只有新 bundle 成功后才按默认 14 份裁剪。可选异地 adapter 只复制到配置的文件系统目录，不执行 shell；异地失败不会删除本地良好 bundle。

```bash
npm run db:restore-check -- /absolute/path/to/wsb-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx
# 可选私有临时父目录
npm run db:restore-check -- /absolute/bundle --temp-dir /absolute/private-temp
```

`db:restore-check` 在隔离临时目录验证，不覆盖生产数据库。恢复前必须停止写入、保留数据库/WAL/SHM/附件和 session 的现场副本，并严格遵循 [恢复手册](docs/pm-recovery.md)。

## 离线生产预检与受控发布

```bash
npm test
npm run db:migrate
npm run db:check
npm run preflight
npm audit --omit=dev       # 仅报告；不要自动 fix
```

`preflight` 不连接 WhatsApp 或网络，检查 Node、配置/JID、当前数据库、私有可写目录、磁盘 reserve、OCR traineddata、备份和可选异地路径；身份和 key 只以脱敏形式显示。`READINESS: NOT READY` 时不得重启生产 Bot。

PM2 建议流程：

```bash
pm2 start index.js --name whatsapp-bot
pm2 save
# 已存在的生产进程受控更新：
pm2 restart whatsapp-bot --update-env
```

重启前记录 commit、PM2 状态和最新通过 restore-check 的 bundle；只重启指定应用，不连续 restart。真实授权群和 PM2 验收使用 [`docs/pm-live-acceptance.md`](docs/pm-live-acceptance.md)。Tasks 1–17 的非 live 验收映射见 [`docs/task1-17-acceptance-audit.md`](docs/task1-17-acceptance-audit.md)。

## 故障降级

- **OpenRouter 缺失/超时/限流/非法输出**：`!pm add` 安全建立“资料待补充”；回复匹配保留确定性候选但不自动确认；摘要仍给出数据库可确定的完整 PM 队列、变化和消息数。
- **OCR 未启用或 traineddata 缺失**：附件保留并标记需要 OCR/解析失败，不上传外部 OCR，不阻止建单。
- **附件下载、磁盘或解析失败**：记录终态和可重试性；可按指南使用 `!pm retry-file`，不制造第二张工单。
- **摘要部分发送失败/重启**：只重试 ledger 中未成功的 part；先观察启动恢复，不手工重复同一窗口。
- **数据库或 manifest 损坏**：阻止 ready/恢复；停止写入并使用已验证 bundle 演练，不能直接复制 live SQLite 主文件充当备份。
- **异地备份失败**：报告失败并保留已验证本地 bundle。
- **WhatsApp session 故障**：先保护 `.wwebjs_auth` 和数据，不要同时删除 session 与回退数据库。

## 安全说明

- 权限只按规范化 runtime JID；显示名不授权。
- 未授权群在下载、AI 调用或 PM 数据修改之前被拒绝。
- Markdown/聊天/附件正文始终是不可信证据，不能覆盖系统、权限或输出规则。
- HTML 输出转义，reply cache 按 scope 隔离，命令参数有长度/重复键限制。
- 不运行 `npm audit fix` 或 `--force` 作为验收步骤；先报告并评估 lockfile、原生模块和运行时影响。

## 主要目录

```text
commands/      PM 与摘要命令路由/格式化
 db/           SQLite connection、migration、repositories、诊断
 services/     PM、附件、AI、保留、备份、preflight
 summaries/    时间窗、手动/定时摘要与持久恢复
 whatsapp/     消息规范化、adapter 与授权 ingress
 scripts/      DB、restore-check、preflight 与显式 smoke CLI
 test/         node:test 离线测试
 docs/         角色、恢复、审计与 live 验收文档
```
