---
name: migrate-wsb-floaty-server
type: chore
description: Safely migrate WSB, website-server, and Floaty to a new Ubuntu server
created: 2026-07-26
---

# Migrate WSB and Floaty to a New Server

Controlled two-phase migration for:

- `Junda10/WS-Bot` → PM2 app `wsb` (Node.js, WhatsApp/Puppeteer)
- WSB generated-site service → PM2 app `website-server`, plain HTTP port `8080`
- `Junda10/dfs-Bot` → PM2 app `floaty` (Python/Discord/voice)

Never run the old and new WhatsApp/Discord bot instances concurrently.

## Critical Security Blocker

At review time, Floaty's real `.env` is tracked by Git and exists in `Junda10/dfs-Bot` history. Treat its Discord and OpenRouter credentials as exposed.

Before migration:

1. Remove `.env` from Git tracking and add/confirm it in `.gitignore`.
2. Rotate `DISCORD_TOKEN`, `OPENROUTER_API_KEY`, and any other committed credentials.
3. Consider history rewriting if repository exposure requires it; coordinate this because history rewriting is destructive for collaborators.
4. Put only placeholders in `.env.example`.
5. Verify:

```bash
git -C /home/chin/floaty ls-files --error-unmatch .env
```

Expected after remediation: command fails because `.env` is no longer tracked.

Do not proceed with old leaked credentials.

## Current Source Inventory

| Item | Current value |
|---|---|
| OS | Ubuntu 24.04 x86_64 |
| Node.js | 24.18.0 (WSB requires >=22) |
| Python | 3.12.3 |
| PM2 | 7.0.3 |
| Repositories | `Junda10/WS-Bot`, `Junda10/dfs-Bot` |
| WSB path/cwd | `/home/chin/wsb` |
| Floaty script | `/home/chin/floaty/bot.py` |
| Floaty cwd | `/home/chin` |
| Website data | `/home/chin/websites` |
| Website listener | plain HTTP `0.0.0.0:8080` |
| PM2 apps | `wsb`, `website-server`, `floaty` |
| User cron | `0 */12 * * * /home/chin/cleanup-wsb.sh` |
| WhatsApp auth | approximately 744 MB |
| WSB cache | approximately 20 MB; regenerate |
| WSB data | recheck at cutover; source DB currently schema 3 while release requires 12 |
| Floaty virtualenv | approximately 71 MB; rebuild |
| PM2 module | `pm2-logrotate`; configuration must be recreated or intentionally dropped |

### Repository state at creation

- WSB `main` is aligned with `origin/main`; commit the runbook before using “clean tree” gates.
- Floaty has unpushed commit `0780e58`, containing a design document only. It does not affect runtime parity, but decide whether to preserve it.

## Required Runtime Data

### WSB

```text
/home/chin/wsb/.env
/home/chin/wsb/.wwebjs_auth/
/home/chin/wsb/data/                  # DB, WAL/SHM if present, attachments, backups
/home/chin/wsb/reply-cache.json
/home/chin/wsb/user-memory.json
/home/chin/websites/
```

Regenerate instead of copying:

```text
/home/chin/wsb/.wwebjs_cache/
/home/chin/wsb/node_modules/
```

### Floaty

```text
/home/chin/floaty/.env                # only after credential rotation
/home/chin/floaty/favorites.json
/home/chin/floaty/histories.json
/home/chin/floaty/playlist-cache.json
/home/chin/floaty/reply-cache.json
/home/chin/floaty/user-memory.json
/home/chin/floaty/lore.json
/home/chin/logs/                      # current relative Floaty application logs, optional
```

Regenerate instead of copying:

```text
/home/chin/floaty/venv/
/home/chin/floaty/__pycache__/
/home/chin/floaty/.floaty.lock
```

## Preconditions

- [ ] Floaty credential exposure is remediated and tokens rotated.
- [ ] New host identity and SSH host key are independently verified.
- [ ] New server is Ubuntu 24.04 x86_64 or compatible.
- [ ] Service user/path is `/home/chin`, or hard-coded paths are changed in code first.
- [ ] At least 5 GB free space beyond measured runtime + backup needs.
- [ ] WSB release and desired Floaty code are available on the new host.
- [ ] Actual `PM_AUTHORIZED_GROUP_JID`, `PM_ERIC_JID`, `PM_ADMIN_JIDS` are obtained before downtime.
- [ ] `WEBSITE_PUBLIC_HOST`, firewall/security group, DNS/TLS plan are decided.
- [ ] A 45–60 second WSB graceful shutdown allowance is configured.
- [ ] Old-host PM2 auto-resurrection can be fenced during cutover.
- [ ] Maintenance window and rollback owner are confirmed.

## Phase 1 — Prepare Without Downtime

### 1. Create user and directories

```bash
sudo adduser chin
sudo install -d -o chin -g chin -m 0700 /home/chin
```

Changing the username requires code changes because these are hard-coded:

- `/home/chin/websites` in `website-builder.js`
- `/home/chin/websites/active` and port `8080` in `website-server.js`
- PM2 paths, cleanup script, and runtime configuration

### 2. Install system dependencies

```bash
sudo apt update
sudo apt install -y git rsync curl ca-certificates build-essential \
  python3 python3-venv python3-pip ffmpeg
```

Install Puppeteer/Chromium libraries appropriate for Ubuntu 24.04 and the installed Chrome build.

### 3. Install Node and PM2

Install Node 24.18.0 or supported Node >=22, then:

```bash
node --version
npm --version
npm install -g pm2@7
pm2 --version
```

### 4. Clone code

```bash
sudo -u chin -H bash -lc '
  cd /home/chin
  git clone https://github.com/Junda10/WS-Bot.git wsb
  git clone https://github.com/Junda10/dfs-Bot.git floaty
'
```

If Floaty commit `0780e58` is required, push or transfer it deliberately. It is not needed for current runtime behavior.

### 5. Rebuild dependencies

```bash
sudo -u chin -H bash -lc '
  cd /home/chin/wsb
  npm ci
  npm test

  cd /home/chin/floaty
  python3 -m venv venv
  venv/bin/python -m pip install --upgrade pip
  venv/bin/python -m pip install -r requirements.txt
  venv/bin/python -m pip check
'
```

Capture the old working Python package versions if exact reproducibility matters; Floaty requirements currently use lower bounds.

### 6. Create private runtime directories

```bash
sudo -u chin -H bash -lc '
  install -d -m 0700 /home/chin/wsb/data
  install -d -m 0700 /home/chin/wsb/.wwebjs_auth
  install -d -m 0700 /home/chin/floaty
  install -d -m 0700 /home/chin/websites
  install -d -m 0700 /home/chin/migration-staging
'
```

### 7. Pre-copy WhatsApp auth as a bandwidth seed only

The live `.wwebjs_auth` copy is inconsistent and is **not launch-ready**. It may contain old-host `SingletonLock`, `SingletonSocket`, `SingletonCookie`, and `DevToolsActivePort` files.

First verify `<NEW_HOST>` and run a dry-run:

```bash
ssh-keygen -F <NEW_HOST>
rsync -aH --dry-run --itemize-changes \
  /home/chin/wsb/.wwebjs_auth/ chin@<NEW_HOST>:/home/chin/wsb/.wwebjs_auth/
```

Then pre-copy:

```bash
rsync -aH --info=progress2 \
  /home/chin/wsb/.wwebjs_auth/ chin@<NEW_HOST>:/home/chin/wsb/.wwebjs_auth/
```

Do not use `--numeric-ids` unless source and destination UID/GID are intentionally identical. Do not start WSB on the new server.

### 8. Prepare deterministic PM2 configuration

Create `/home/chin/ecosystem.config.cjs` on the new server:

```javascript
module.exports = {
  apps: [
    {
      name: 'wsb',
      script: '/home/chin/wsb/index.js',
      cwd: '/home/chin/wsb',
      interpreter: 'node',
      kill_timeout: 60000,
      autorestart: true,
    },
    {
      name: 'website-server',
      script: '/home/chin/wsb/website-server.js',
      cwd: '/home/chin/wsb',
      interpreter: 'node',
      kill_timeout: 10000,
      autorestart: true,
    },
    {
      name: 'floaty',
      script: '/home/chin/floaty/bot.py',
      cwd: '/home/chin',
      interpreter: '/home/chin/floaty/venv/bin/python',
      kill_timeout: 30000,
      autorestart: true,
    },
  ],
};
```

Preserving Floaty's cwd `/home/chin` preserves current relative log path `/home/chin/logs/dfs-bot.log`.

## Phase 2 — Final Cutover

### 9. Record and snapshot source state

```bash
pm2 list
git -C /home/chin/wsb status --short --branch
git -C /home/chin/floaty status --short --branch
du -sh /home/chin/wsb/.wwebjs_auth /home/chin/wsb/data \
  /home/chin/websites /home/chin/floaty /home/chin/logs 2>/dev/null
```

Expected source DB state is currently schema 3 while current code requires schema 12. Do not migrate or modify the old copy before taking the rollback snapshot.

### 10. Fence old-host resurrection, then stop writers gracefully

Disable cloud/host auto-recovery during cutover. Prevent PM2 resurrection on reboot:

```bash
sudo systemctl disable --now pm2-chin.service
```

Do not disable an unrelated unit without identifying its owner. The old host currently also has `pm2-ubuntu.service`; inspect it separately.

Stop apps and allow WSB up to 60 seconds:

```bash
pm2 stop wsb website-server floaty
sleep 60
pm2 list
```

Require zero live processes (the regex is anchored and does not match itself):

```bash
pgrep -af '^node /home/chin/wsb/index\.js$|^node /home/chin/wsb/website-server\.js$|^/home/chin/floaty/venv/bin/python /home/chin/floaty/bot\.py$' && exit 1 || true
pgrep -af '/home/chin/wsb/.wwebjs_auth.*chrome|chrome.*user-data-dir=/home/chin/wsb/.wwebjs_auth' && exit 1 || true
```

If graceful shutdown logs are absent or processes remain, abort and investigate before copying data.

### 11. Create immutable old-host rollback snapshot

After all writers stop:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "/home/chin/migration-rollback-$stamp"
cp -a /home/chin/wsb/data "/home/chin/migration-rollback-$stamp/wsb-data"
cp -a /home/chin/wsb/.wwebjs_auth "/home/chin/migration-rollback-$stamp/wwebjs-auth"
cp -a /home/chin/floaty/*.json "/home/chin/migration-rollback-$stamp/" 2>/dev/null || true
```

Preserve the entire stopped `data/` tree together—SQLite DB, `-wal`, `-shm`, attachments, and backups. Never mix DB and attachments from different points in time.

Also prepare an old-code rollback directory/worktree at the release believed to be running before the new PM build (deployment records indicate the July 18 release near `06d749d`). Verify this commit rather than assuming `pm2 start wsb` will restore old behavior: restarting `/home/chin/wsb/index.js` loads current disk code and currently fails without PM JIDs.

### 12. Final transfer—dry-run first

For every destructive `--delete`, verify host/path and run dry-run:

```bash
rsync -aH --delete --dry-run --itemize-changes \
  /home/chin/wsb/data/ chin@<NEW_HOST>:/home/chin/wsb/data/
```

Transfer final stopped state:

```bash
rsync -aH --delete /home/chin/wsb/.wwebjs_auth/ \
  chin@<NEW_HOST>:/home/chin/wsb/.wwebjs_auth/
rsync -aH --delete /home/chin/wsb/data/ \
  chin@<NEW_HOST>:/home/chin/wsb/data/
rsync -aH --delete /home/chin/websites/ \
  chin@<NEW_HOST>:/home/chin/websites/
```

Transfer secrets separately with restrictive modes:

```bash
rsync -a --chmod=F600,D700 /home/chin/wsb/.env \
  chin@<NEW_HOST>:/home/chin/migration-staging/wsb.env
rsync -a --chmod=F600,D700 /home/chin/floaty/.env \
  chin@<NEW_HOST>:/home/chin/migration-staging/floaty.env
```

Transfer optional WSB memory/cache files only if present:

```bash
for f in reply-cache.json user-memory.json; do
  [ -f "/home/chin/wsb/$f" ] && rsync -a "/home/chin/wsb/$f" chin@<NEW_HOST>:/home/chin/wsb/
done
```

Transfer Floaty state:

```bash
for f in favorites.json histories.json playlist-cache.json reply-cache.json user-memory.json lore.json; do
  [ -f "/home/chin/floaty/$f" ] && rsync -a "/home/chin/floaty/$f" chin@<NEW_HOST>:/home/chin/floaty/
done
[ -d /home/chin/logs ] && rsync -a /home/chin/logs/ chin@<NEW_HOST>:/home/chin/logs/
```

### 13. Finalize auth and permissions on new host

On the new server:

```bash
install -m 0600 /home/chin/migration-staging/wsb.env /home/chin/wsb/.env
install -m 0600 /home/chin/migration-staging/floaty.env /home/chin/floaty/.env
rm -f /home/chin/migration-staging/wsb.env /home/chin/migration-staging/floaty.env

rm -f /home/chin/wsb/.wwebjs_auth/session/SingletonLock \
      /home/chin/wsb/.wwebjs_auth/session/SingletonSocket \
      /home/chin/wsb/.wwebjs_auth/session/SingletonCookie \
      /home/chin/wsb/.wwebjs_auth/session/DevToolsActivePort

chown -R chin:chin /home/chin/wsb /home/chin/floaty /home/chin/websites /home/chin/logs
chmod 0600 /home/chin/wsb/.env /home/chin/floaty/.env
chmod 0700 /home/chin/wsb/.wwebjs_auth /home/chin/wsb/data
```

### 14. Complete all deployment configuration

Review **every** variable in `/home/chin/wsb/.env.example`, especially:

```text
PM_AUTHORIZED_GROUP_JID=<actual @g.us>
PM_ERIC_JID=<actual @c.us or @lid>
PM_ADMIN_JIDS=<actual comma-separated JIDs>
PM_DATABASE_PATH
PM_ATTACHMENTS_DIR
PM_TEMP_DIR
PM_BACKUP_DIR
PM_BACKUP_OFFSITE_DIR
PM_REPORT_TIMEZONE=Asia/Kuala_Lumpur
PM_MAINTENANCE_TIMEZONE=Asia/Kuala_Lumpur
PM_OCR_ENABLED
```

Website options:

- Direct plain HTTP: `WEBSITE_PUBLIC_HOST=http://<host>:8080`
- Recommended TLS: reverse proxy `https://<domain>` on port 443 to `127.0.0.1:8080`, then restrict public access to port 8080.

`https://<ip>:8080` will not work without a TLS terminator because the service itself is plain HTTP.

### 15. Validate destination before start

WSB:

```bash
sudo -u chin -H bash -lc '
  cd /home/chin/wsb
  npm ci
  npm test
  npm run db:migrate
  npm run db:check
  npm run preflight
'
```

Expected: schema 12, integrity/FK OK, `READINESS: READY`.

Floaty:

```bash
sudo -u chin -H bash -lc '
  cd /home/chin/floaty
  venv/bin/python -m py_compile bot.py
  venv/bin/python -m pip check
'
ffmpeg -version | head -1
```

Abort on any failure.

### 16. Start PM2 exactly once

```bash
sudo -u chin -H bash -lc '
  pm2 start /home/chin/ecosystem.config.cjs
  pm2 save
  pm2 list
'
```

Install one startup service for `chin` using the new Node/PM2 path:

```bash
pm2 startup systemd -u chin --hp /home/chin
```

Run the generated root command, inspect the unit's `ExecStart`, and disable unrelated stale PM2 user units. Reboot-test resurrection before decommissioning the old server.

Reinstall/configure `pm2-logrotate` or explicitly document its removal:

```bash
pm2 install pm2-logrotate
pm2 conf pm2-logrotate
```

### 17. Restore cleanup cron

Copy `/home/chin/cleanup-wsb.sh`, update its Node PATH, then install:

```cron
0 */12 * * * /home/chin/cleanup-wsb.sh
```

```bash
chmod 0755 /home/chin/cleanup-wsb.sh
crontab -l
```

### 18. Live validation

#### WSB

- [ ] WhatsApp reconnects once; if session is invalid, perform one controlled QR login while old WSB remains fenced.
- [ ] `!help` replies once.
- [ ] `!健身 A/B/C` uses the detailed guide.
- [ ] `!汇率`, `!fx`, `!rate` no longer invokes a dedicated FX feature.
- [ ] Authorized `.md` appears in `!summary`.
- [ ] `!pm add` → Eric confirmation → resolve → admin archive passes.
- [ ] 10:00/14:00/20:00 reports use `Asia/Kuala_Lumpur`.
- [ ] `npm run db:check` passes after live writes.
- [ ] A verified local/offsite backup bundle is created.

#### Website

```bash
curl -fsS http://127.0.0.1:8080/ >/dev/null
ss -ltnp | grep ':8080'
```

Verify external URL, firewall/reverse proxy, and DNS.

#### Floaty

- [ ] Bot is online on exactly one host.
- [ ] Text commands, configured news channel/schedule, music search, voice join/playback work.
- [ ] Favorites/history/playlist/reply/memory files are present.
- [ ] `/home/chin/logs/dfs-bot.log` or the intentionally changed log path receives output.

### 19. Observe before decommissioning old host

Keep old services fenced and stopped for at least one full scheduled-report cycle, preferably 24 hours.

```bash
pm2 list
pm2 logs wsb --lines 200
pm2 logs floaty --lines 200
npm --prefix /home/chin/wsb run db:check
```

## Rollback

A simple `pm2 start wsb` on the old host is **not** a valid rollback because disk code is newer than the process that was running and requires missing PM JIDs.

Before cutover, prepare one of:

1. exact old-release worktree + matching dependencies/config + untouched old runtime snapshot; or
2. current release with valid PM JIDs and a tested schema-12 destination snapshot.

If rollback is required:

1. Stop/fence all new writers.
2. Snapshot both old and new runtime states.
3. If new-host writes matter, reverse-transfer the entire consistent set—not individual DB/files.
4. If WhatsApp performed a new QR login, copy back the stopped new auth state or perform another controlled login; old auth may be invalid.
5. Switch resurrection fencing back to old host.
6. Start exactly one old-host WSB/Floaty instance and verify process counts.
7. Preserve failure logs and do not overwrite the immutable pre-migration snapshot.

## Failure Handling

- **Floaty tracked secrets:** stop and rotate before migration.
- **WSB preflight not READY:** do not start; fix PM JIDs/config/paths/disk/OCR first.
- **Source DB schema 3:** expected; preserve source, migrate only destination, verify schema 12.
- **SQLite failure:** stop; restore/copy the complete stopped DB+WAL+attachments set.
- **WhatsApp QR:** keep old WSB fenced, authenticate one new instance.
- **Discord conflict:** verify old Floaty and resurrection service are stopped.
- **Voice failure:** verify FFmpeg, PyNaCl, davey, Discord permissions, outbound network.
- **Website failure:** remember port/path are hard-coded and service is plain HTTP.
- **Wrong rsync target:** never run non-dry `--delete` until host/path are independently verified.

## Post-conditions

- [ ] Floaty credentials were rotated and `.env` is no longer tracked.
- [ ] WSB, website-server, and Floaty run only on the new host.
- [ ] Exactly one correct PM2 startup unit and saved ecosystem exist.
- [ ] Runtime data/secrets are private and excluded from Git.
- [ ] WSB schema 12/integrity/preflight pass.
- [ ] WhatsApp PM, Markdown summaries, attachments, schedules and backups work.
- [ ] Floaty state and Discord voice work.
- [ ] Website host/TLS/firewall are correct.
- [ ] New backup is verified.
- [ ] Old host remains stopped during observation and is securely decommissioned afterward.
