# PM 群成员使用指南

## 1. 适用范围与角色

PM 功能只在配置的授权 WhatsApp 群生效，并按实际 JID 授权，不按显示名称授权。

- **群成员（MEMBER）**：建立、查询、更新、解决工单，查看或重发工单附件。
- **Eric（ERIC）**：除群成员能力外，负责把 Tevau 回复匹配并确认到工单。
- **管理员（ADMIN）**：负责归档、软删除、恢复和移动误配回复。

在群内发送 `!pm help member` 可查看群成员命令；完整帮助为 `!pm help`。

## 2. 群成员命令（与 `!pm help` 一致）

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
```

说明：

- `!pm add`：必须引用群内来源消息或文档；一次执行后直接建立 `WAITING_TEVAU` 工单。
- `!pm list open`：列出全部未闭环工单，等待最久者优先，不只显示前五项。
- `!pm show TV1`：查看问题、已确认回复、附件、响应时间和时间线；也可引用来源消息后发送 `!pm show`。
- `!pm find <关键词>`：搜索标题、问题和已确认回复；也可引用来源或回复后发送 `!pm find`。
- `!pm update`：只填写需要修改的字段。含空格参数须使用单引号或双引号，每个 `key=value` 键只能出现一次。
- `!pm resolve`：仅在群内实际验证通过后执行；已解决工单再由管理员归档。
- `!pm resend-file`：按 `!pm show` 中的附件编号重发永久归档文件。
- `!pm attachment`：`!pm resend-file` 的同义别名。
- `!pm retry-file`：重试该工单所有标记为可重试的失败附件；不会另建工单。

## 3. 推荐处理流程

1. 在授权群上传或发送来源资料。
2. **引用该来源**发送 `!pm add`。
3. Bot 回复 `TVn`、标题、提取问题和附件状态。需要修正时使用 `!pm update TVn ...`。
4. 等待 Eric 确认 Tevau 回复；状态变成“已回复，待解决”。
5. 群成员完成验证后发送 `!pm resolve TVn note="..."`。
6. 管理员确认闭环后归档。

重复投递同一条 `!pm add` 不会建立第二张工单。AI 不确定或 OpenRouter 不可用时，系统会建立“资料待补充”工单，不会编造事实。

## 4. 自动 Markdown 与群聊摘要

普通 `.md`/Markdown 文件上传到授权群后，即使没有执行 `!pm add`，也会自动解析并纳入手动及定时摘要。摘要会标明文件名，并把标题、列表、表格、代码块转换为不可信的结构化纯文本；文件内 HTML、链接、脚本或命令不会被执行。

手动摘要命令：

```text
!summary
!summary 4h
!summary today
!summary yesterday
!summary since 2026-07-20 09:00
!summary help
```

`!summary` 不推进自动报告游标。自动报告使用 `Asia/Kuala_Lumpur`（若部署配置未更改）并在以下窗口发送：

- 10:00：前一日 20:00 至当日 10:00，并含昨日统计；
- 14:00：当日 10:00 至 14:00；
- 20:00：当日 14:00 至 20:00。

每份摘要包含讨论重点、明确决定、待办/负责人、工单变化、全部未闭环队列和不确定项。AI 失败时仍输出可由数据库确定的 PM 队列、变化和消息数量。

## 5. 附件限制与 OCR

支持 Markdown、UTF-8 纯文字、图片、PDF、DOCX；不支持旧 `.doc` 和未知/可执行格式。默认单文件上限为 **20 MiB**，部署可通过 `PM_MAX_FILE_MB` 在安全范围内调整。系统还限制 PDF 页数、图片像素、DOCX 解压大小、文本长度和处理时间，并以真实字节类型为准，不信任文件名或 WhatsApp MIME。

- 文本 PDF、DOCX、Markdown 和纯文字会在本地解析。
- 图片和扫描 PDF 只有在本地 OCR 已启用且 traineddata 完整时才识别。
- OCR 未启用时，原文件仍保存，状态会明确显示需要 OCR；不会偷偷访问外部 OCR。
- “已保存，内容未解析”不等于资料丢失。可先用 `!pm show TVn` 查看，再按状态使用 `!pm retry-file TVn`。

## 6. 数据保留与隐私

普通群消息、普通 Markdown 正文和临时附件默认保留 30 天，精确规则为 `sent_at < 当前时间 - 30×24小时`；边界时刻本身保留。工单来源快照、工单附件、已确认回复、审计事件和工单证据长期保留。删除命令是软删除，只有管理员可恢复。

不要在命令、截图或文档中发送 API key、真实 `.env`、备份密钥或其他秘密。JID 权限问题应交管理员核对实际 runtime JID，而不是显示名。
