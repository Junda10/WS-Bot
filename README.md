# 🤖 WhatsApp 新闻机器人 News Bot

A WhatsApp bot that auto-replies "ok" to messages and shares Chinese news about:
- 🌐 Global technology news (全球科技新闻)
- 🚗 Malaysia car news (马来西亚汽车新闻)
- 🏠 Malaysia property news (马来西亚房产新闻)

## Prerequisites

- **Node.js 22+** installed (required by the SQLite and media-processing dependencies)
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

# 2. Verify Node and install dependencies
node --version  # must be v22 or newer
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
| `AUTO_REPLY_ENABLED` / `AUTO_REPLY_MESSAGE` | Auto-reply settings | `false` / `ok` |

### Tevau PM persistence and security

PM features are restricted by WhatsApp JID, never display name. Set all three identity values before startup; an empty or malformed value causes a clear startup configuration error.

| Env var | Purpose | Default |
|---|---|---|
| `PM_AUTHORIZED_GROUP_JID` | Only group allowed to use PM ingestion and summaries (`@g.us`) | required |
| `PM_ERIC_JID` | User allowed to confirm Tevau replies (`@c.us`/`@lid`) | required |
| `PM_ADMIN_JIDS` | Comma-separated administrator JIDs | required |
| `DB_PATH` / `DB_BUSY_TIMEOUT_MS` | SQLite location and lock wait | `data/wsb.sqlite3` / `5000` |
| `PM_ATTACHMENTS_DIR` / `PM_TEMP_DIR` | Archived and temporary media directories | under `data/` |
| `PM_MAX_FILE_MB` | Maximum attachment size | `20` |
| `PM_MESSAGE_RETENTION_DAYS` | Exact UTC ordinary-message/temporary-attachment retention | `30` |
| `PM_REPLY_SESSION_GRACE_MS` / `PM_TEMP_FILE_GRACE_MS` | Grace before terminal sessions/staging remnants are purged | `86400000` |
| `PM_MAINTENANCE_ENABLED` / `PM_MAINTENANCE_CRON` | Daily cleanup + backup schedule | `true` / `30 2 * * *` |
| `PM_TIMEZONE` / `PM_REPORT_RECOVERY_HOURS` | Maintenance/report timezone and startup catch-up window | `Asia/Kuala_Lumpur` / `24` |
| `PM_OCR_ENABLED` / `PM_OCR_LANGUAGES` | Local OCR switch and languages | `false` / `eng+chi_sim` |
| `PM_VISION_POLICY` | `off`, `ocr-only`, `ocr-first`, or `vision-first` | `ocr-first` |
| `PM_BACKUP_DIR` / `PM_BACKUP_RETENTION_COUNT` | Local verified bundle directory and count | `data/backups` / `14` |
| `PM_BACKUP_OFFSITE_DIR` | Optional separate filesystem/off-host mount | unset |

Retention uses the exact cutoff `sent_at < now - days × 24h`; the boundary itself is retained. Ordinary rows and temporary attachment bytes expire, while issue sources, confirmed replies, append-only audit history, immutable evidence snapshots, and every issue-linked attachment are permanent. Active ingress/attachment leases are never cleaned; stale summary leases are reclaimed only by the existing summary recovery flow.

Backups use SQLite's online backup API (including committed WAL data), then run `integrity_check`, `foreign_key_check`, and migration validation before publication. Each atomic private bundle contains `database.sqlite3`, de-duplicated issue attachment bytes, and a size/SHA-256 manifest. A new verified bundle must succeed before pruning to the newest 14. Offsite failure is recorded but does not invalidate or delete the local bundle. The offsite option only writes to a configured filesystem directory and never invokes a shell.

Runtime databases (including WAL/SHM files), attachments, temporary files, backups, and OCR data are ignored by Git. Never commit the real `.env`.

#### Local OCR setup (optional)

OCR is **disabled by default**. Image/scanned-PDF attachments are still archived and end in terminal `NEEDS_OCR` state without a recovery loop. To enable offline OCR:

1. Create `data/tessdata/` (or set `PM_OCR_LANG_PATH`).
2. Install both `eng.traineddata.gz` and `chi_sim.traineddata.gz` there. Do not commit these files.
3. Set `PM_OCR_ENABLED=true`, `PM_OCR_LANGUAGES=eng+chi_sim`, and restart the bot.

The worker uses a read-only local language/cache configuration and has independent initialization, recognition, image-decode, PDF-page-render, termination, and shutdown limits. Missing or bad traineddata is returned as a retryable OCR failure; it cannot use Tesseract's throwing default error handler. Tune density/resource thresholds using the documented `PM_OCR_*` values in `.env.example`. `PM_MAX_IMAGE_PIXELS` defaults to 40 million and cannot exceed 100 million.

The normal suite is network-free and uses fake OCR workers. An optional real smoke requires the local English and Simplified Chinese data above:

```bash
npm run ocr:smoke -- --expect "known substring" ./sample-eng-chi.png
# or set PM_OCR_SMOKE_EXPECT
```

#### Structured PM AI smoke (optional, billable)

The normal test suite never calls OpenRouter. The real smoke makes at most three tiny calls through one low-cost model, prints only redacted contract metadata, and requires both opt-ins:

```bash
OPENROUTER_PM_SMOKE=1 npm run pm-ai:smoke -- --run
# optional model override: OPENROUTER_PM_SMOKE_MODEL=z-ai/glm-4.7-flash
```

It never prints the API key or raw evidence/model output and is not part of `npm test`.

#### Database operations and restore drills

```bash
npm run db:migrate
npm run db:check
npm run db:restore-check -- data/backups/wsb-YYYYMMDDTHHMMSSmmmZ-xxxxxxxx
# optional isolated parent for the temporary restore area:
npm run db:restore-check -- /absolute/bundle --temp-dir /absolute/private-temp
```

`db:restore-check` never opens or overwrites the production database. It stages the selected bundle in a temporary restore area, rejects traversal/symlinks/unknown or missing files, verifies all hashes and sizes, checks SQLite integrity/foreign keys/current migrations, and confirms every live issue attachment represented by the database is present. A failed check must be investigated before using that bundle for a manual restore.

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
