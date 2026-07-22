# Eric 回复确认速查卡

## 权限原则

只有配置为 `PM_ERIC_JID` 的实际 WhatsApp JID 可建立、确认或取消回复匹配。管理员身份不会自动取得 Eric 权限，显示名称“Eric”也不能授权。

发送 `!pm help eric` 查看本卡对应命令；完整命令帮助为 `!pm help`。

## 命令（与 `!pm help` 一致）

```text
!pm reply
!pm confirm-reply <token> TV1
!pm confirm-reply TV1
!pm cancel <token>
```

- `!pm reply`：引用 Tevau 的文字回复，要求 AI 在最多 3 个确定性候选中建议匹配。
- `!pm confirm-reply <token> TV1`：使用 Bot 提示中的一次性 token 确认指定工单。
- `!pm confirm-reply TV1`：必须引用对应的 Bot 建议消息，不可引用其他会话。
- `!pm cancel <token>`：取消指定会话；也可引用对应 Bot 建议后发送 `!pm cancel`。

## 标准流程

1. 检查 Tevau 回复确实来自当前授权群，并包含可保存的完整正文。
2. 引用该回复发送 `!pm reply`。
3. 核对 Bot 显示的建议工单、原因、信心和最多 3 个候选。
4. 若建议正确，复制 token 命令，例如 `!pm confirm-reply AbCdEf123456 TV1`；或引用 Bot 建议发送 `!pm confirm-reply TV1`。
5. 确认 Bot 返回“回复已确认”，并提示下一步 `!pm resolve TV1 note="验证说明"`。

## 安全与异常

- AI 高信心也不会自动写入回复；必须由 Eric 确认。
- token 绑定当前群、Eric、来源回复和候选，只能消费一次，并默认 15 分钟过期。
- 同时处理多条回复时，务必使用各自 token 或引用各自 Bot 建议，不能混用。
- OpenRouter 超时、限流、模型输出非法或缺少 key 时，Bot 保留确定性候选，由 Eric 人工选择，不会自动匹配。
- 回复匹配错误且已经确认时，不要删除历史；请管理员使用 `!pm move-reply` 纠正。
- 首次确认会记录响应时间和不可改写的审计事件；重复确认不会产生第二条回复。

## 状态检查

确认后发送 `!pm show TV1`，应看到：

- 状态为“已回复，待解决”；
- Tevau 完整回复；
- 首次响应时间；
- `REPLY_CONFIRMED` 时间线记录。

随后由群成员验证并执行 `!pm resolve TV1 note="..."`，最后由管理员归档。
