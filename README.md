# 🤖 WhatsApp 新闻机器人 News Bot

A WhatsApp bot that auto-replies "ok" to messages and shares Chinese news about:
- 🌐 Global technology news (全球科技新闻)
- 🚗 Malaysia car news (马来西亚汽车新闻)
- 🏠 Malaysia property news (马来西亚房产新闻)

## Prerequisites

- **Node.js 18+** installed
- **Google Chrome** or **Chromium** installed (for WhatsApp Web automation)
- A **WhatsApp account** on your phone

### Install Chromium (if not installed)

```bash
# Ubuntu/Debian
sudo apt-get install -y chromium-browser

# macOS
brew install --cask chromium
```

## Setup

```bash
# 1. Clone
git clone https://github.com/Junda10/WS-Bot.git
cd WS-Bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# then edit .env and fill in OPENROUTER_API_KEY, MY_NUMBER, GROUP_ID, WEBSITE_WHITELIST

# 4. Start the bot
node index.js
```

All runtime config (phone number, group ID, schedule, clarification module flags) is read
from `.env`. See `.env.example` for the full list of supported variables. `config.js` itself
holds no secrets and is safe to commit.

## First Run - QR Code Login

1. Run `node index.js`
2. A QR code will appear in the terminal
3. Open WhatsApp on your phone
4. Go to **Settings → Linked Devices → Link a Device**
5. Scan the QR code
6. The bot is now connected!

Session is saved locally — you won't need to scan again unless you log out.

## Commands

Send these commands to the bot (from any chat):

| Command | Description |
|---------|-------------|
| `!tech` | 🌐 Fetch global tech news in Chinese |
| `!car` | 🚗 Fetch Malaysia car news in Chinese |
| `!property` | 🏠 Fetch Malaysia property news in Chinese |
| `!news` | 📰 Fetch all news categories |
| `!help` | ❓ Show help menu |

Any other message from non-group chats will receive an auto-reply of "ok".

## Configuration

All configuration is driven by `.env` (see `.env.example`). `config.js` is just a thin reader.

| Env var | Purpose | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key for LLM calls | (required) |
| `OPENROUTER_MODEL` | Optional preferred OpenRouter model id (tried before the built-in GLM/Z.AI fallback chain) | unset |
| `MY_NUMBER` | Your own WhatsApp number | (required) |
| `GROUP_ID` | Target group for morning broadcast | (required) |
| `WEBSITE_WHITELIST` | JIDs allowed to call `!website` | empty |
| `SCHEDULE_HOUR` / `SCHEDULE_MINUTE` | Daily news time | 8:00 |
| `AUTO_REPLY_ENABLED` / `AUTO_REPLY_MESSAGE` | Auto-reply settings | `true` / `ok` |

### Clarification (ask-user threshold) module

When `CLARIFY_ENABLED=true` and the sender is in `CLARIFY_WHITELIST`, ambiguous user questions
trigger a multi-round slot-filling flow: the bot estimates intent confidence via a cheap LLM
call and asks structured 1./2./3./Other options until the answer is concrete enough
(`ambiguity ≤ CLARIFY_THRESHOLD`, default 10%). Sessions persist in `data/sessions.json` with a
30 min TTL. Users can reply `算了 / 取消 / cancel` to abort, or send `!nosession` to wipe their
current state. Any LLM failure falls back to the regular `smartReply` flow.

Design + plan: see `.unipi/docs/specs/2026-05-20-ask-user-threshold-design.md` and
`.unipi/docs/plans/2026-05-20-ask-user-threshold-plan.md`.

To find chat IDs, send `!groups` to the bot.

## Running in Background

```bash
# Using pm2 (recommended)
npm install -g pm2
pm2 start index.js --name whatsapp-bot
pm2 save
pm2 startup  # auto-start on reboot

# Or using nohup
nohup node index.js > bot.log 2>&1 &
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not showing | Make sure Chromium is installed |
| `no-sandbox` error | Run with `--no-sandbox` (already configured) |
| Session expired | Delete `.wwebjs_auth/` folder and re-scan |
| News not loading | Check internet connection; Google News RSS may be rate-limited |

## File Structure

```
whatsapp-bot/
├── index.js          # Main bot (auto-reply + command handler)
├── news-fetcher.js   # News RSS fetcher and formatter
├── config.js         # Bot configuration
├── package.json      # Dependencies
└── README.md         # This file
```
