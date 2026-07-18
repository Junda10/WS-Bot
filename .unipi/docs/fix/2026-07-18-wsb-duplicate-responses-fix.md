---
title: "WSB 重复回复与重复定时发送 — Quick Fix"
type: quick-fix
date: 2026-07-18
---

# WSB 重复回复与重复定时发送 — Quick Fix

## Bug
WSB 在一次消息或一次定时触发中可能发送重复 response。生产日志已确认晨间新闻、健身提醒和汇率任务出现双重或三重执行。

## Root Cause
- 每次 WhatsApp `ready` 事件都会重新注册一套 cron，重连后同一进程累积多个相同任务。
- 断线处理在未先销毁旧 Puppeteer page 的情况下对同一 Client 再次 `initialize()`，可能累积 whatsapp-web.js 页面事件监听器。
- 消息入口没有按 WhatsApp message ID 做幂等检查，因此任何重送或重复事件都会再次执行命令和回复。

## Fix
- 增加 cron 注册守卫，后续重复 `ready` 只更新状态并跳过任务注册。
- 重新初始化前先 `client.destroy()`，清理旧页面与注入监听器。
- 新增有 TTL 和容量上限的 message-ID deduper，在所有命令和回复逻辑之前拒绝重复事件。

### Files Modified
- `index.js` — 幂等 cron、重连清理和消息 ID 去重接入。
- `message-deduper.js` — 10 分钟、最多 5000 条的内存去重器。
- `test/message-deduper.js` — 首次处理、重复拒绝、容量淘汰和 TTL 测试。
- `package.json` — 将去重测试加入 `npm test`。

## Verification
- `npm test`
- `node --check index.js`
- `node --check message-deduper.js`
- `git diff --check`
- PM2 与进程检查确认当前只有一个 `wsb` fork process。

## Notes
修复提交不会自动部署或重启 PM2。当前进程内已经累积的重复 cron 只有在之后明确重启 WSB 时才会清除；按工作流边界，本次没有执行部署或重启。
