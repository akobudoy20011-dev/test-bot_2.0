# Banat Test Bot

## Runtime

- Node.js 18 or newer (Node 22 recommended).
- Start command: `npm start`
- Health endpoint: `/health`
- Dashboard: `/` or `/dashboard`
- Dashboard API: authenticated `/api/dashboard/*` endpoints.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `FB_COOKIES` | Facebook cookie/header string for the bot session. |
| `FB_APPSTATE` | Alternative exported cookie/appstate JSON format. Use one session variable, not both. |
| `ECLIPSE_DASHBOARD_API_KEY` | Required long random secret protecting dashboard API endpoints. |
| `ECLIPSE_DASHBOARD_ORIGIN` | Exact dashboard origin for CORS, or `*` only if you understand the implications. |

Optional:
- `BANAT_DEFAULT_ON=true` enables Banat automatically in threads after incoming messages.
- `BANAT_GLOBAL_SEND_LIMIT=2` limits concurrent outgoing messages.
- `BANAT_THREAD_COOLDOWN_MS=12000` sets a per-thread send cooldown.

Never commit Facebook cookies or dashboard keys. Prefer setting them as private service environment variables. The dashboard does not collect or persist Facebook credentials; session setup and changes remain host-environment tasks.


## Simple setup tutorial (GitHub + Render)

### 1. Make your own copy

1. Open this repository on GitHub.
2. Click **Fork** and create your own copy under your GitHub account.
3. In your fork, open **Settings → Secrets and variables → Actions** only if you plan to use GitHub Actions secrets. For Render setup, add the values in Render's environment settings instead.
4. Do not upload cookies, appstate files, or API keys into the repository.

### 2. Create the Render service

1. Sign in to [Render](https://render.com/).
2. Choose **New + → Web Service** and connect your fork.
3. Select the branch you want to run.
4. Use these settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Create the service. Wait for the first build to finish before testing it.

### 3. Add environment variables in Render

Open your Render service → **Environment** → **Add Environment Variable**. Add:

| Key | Value |
| --- | --- |
| `ECLIPSE_DASHBOARD_API_KEY` | A long, random secret that you create. Keep it private. |
| `ECLIPSE_DASHBOARD_ORIGIN` | Your exact Render service origin, e.g. `https://your-service-name.onrender.com` (no path or trailing slash). |
| `FB_COOKIES` | Your session cookie/header string **or** use `FB_APPSTATE` instead. |
| `FB_APPSTATE` | Optional alternative to `FB_COOKIES`; provide the supported exported cookie/appstate JSON format. Do not set both unless you have verified the code's precedence. |

Optional settings:
- `BANAT_DEFAULT_ON=true` — enable Banat by default where supported.
- `BANAT_GLOBAL_SEND_LIMIT=2` — limit concurrent outgoing messages.
- `BANAT_THREAD_COOLDOWN_MS=12000` — set the per-thread cooldown in milliseconds.

**Important:** Obtain and use only your own Facebook session. Treat cookies/appstate as passwords: anyone who gets them may be able to access your account. Add them only in Render's private environment settings—never in chat, screenshots, GitHub commits, or the dashboard page. The dashboard does not log you in or store/replace your session.

Click **Save Changes**. Render may restart the service to apply the variables.

### 4. Open and use the dashboard

1. Open your Render service URL, such as `https://your-service-name.onrender.com/`.
2. Enter the value you set for `ECLIPSE_DASHBOARD_API_KEY` into the dashboard when prompted.
3. Check that the status loads and the session reports connected. A page loading by itself does **not** prove Messenger login works.
4. Use the pause/resume controls to pause or resume message processing. They do not log in or repair an expired session.
5. In your target Messenger group, try `!banat status`, then `!banat help`. Only enable Banat with `!banat on` after confirming the bot is connected and you understand its behavior.

### 5. If something does not work

- **Build fails:** open Render → **Logs** and read the first build error; confirm the repository has `package.json` and the build command is `npm install`.
- **Dashboard says unauthorized / API key missing:** check that `ECLIPSE_DASHBOARD_API_KEY` is set in Render and enter the exact same value in the dashboard.
- **Dashboard API returns a CORS error:** set `ECLIPSE_DASHBOARD_ORIGIN` to the exact origin shown in your browser address bar (scheme + hostname, without a path), then save and let Render restart.
- **Session is disconnected:** verify your private session environment variable is present and valid. Facebook sessions can expire; update it securely in Render and restart the service. Never paste the value into a support message.
- **Bot does not reply:** check Render runtime logs and test `!banat status` in a group where the bot is present. A connected dashboard alone does not guarantee Messenger can send messages.

Before using it in a real group, test with a small, controlled group and confirm the right thread is targeted. Do not deploy an unverified branch as a production bot.

## Banat commands

Send these in the target Messenger group:
- `!banat on`
- `!banat off`
- `!banat toggle`
- `!banat status`
- `!banat help`

## Dashboard behavior

The dashboard displays session connection state, process state, uptime, Node version, memory, watchdog diagnostics, send failures, and recent dashboard control events. It also provides reaction settings and per-group controls for Banat mode, typing indicators, reply delay, cooldown, and quiet hours (Philippines time). Group settings are stored in a local `bot-settings.json` file; on hosts with ephemeral filesystems, those settings may not survive a redeploy unless `BOT_SETTINGS_PATH` points to durable storage. The watchdog reports stale listener callbacks but does not automatically create a second Messenger session. Start/pause buttons only resume or pause message processing; they do not log in, log out, or replace the Facebook session. The event list is in-memory and resets when the process restarts.

The dashboard API is protected by `ECLIPSE_DASHBOARD_API_KEY`. Enter that key in the dashboard for the current browser tab; it is kept in memory only. If the API key is missing, API endpoints intentionally return 503.

## Safety and deployment

Keep this branch separate until syntax checks and a real test session are verified. Do not deploy solely because the dashboard page loads. Confirm the dashboard API key, CORS origin, session login, command handling, direct targeting, thread cooldown, and pause/resume behavior before merging.
