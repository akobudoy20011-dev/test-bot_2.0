# Banat Test Bot

A deliberately limited, standalone Messenger Banat edition. It excludes RPG/game systems, economy, music, PM mode, and the full private Banat reply library.

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

## Banat commands

Send these in the target Messenger group:
- `!banat on`
- `!banat off`
- `!banat toggle`
- `!banat status`
- `!banat help`

## Dashboard behavior

The dashboard displays session connection state, process state, uptime, Node version, memory, and recent dashboard control events. Start/pause buttons only resume or pause message processing; they do not log in, log out, or replace the Facebook session. The event list is in-memory and resets when the process restarts.

The dashboard API is protected by `ECLIPSE_DASHBOARD_API_KEY`. Enter that key in the dashboard for the current browser tab; it is kept in memory only. If the API key is missing, API endpoints intentionally return 503.

## Safety and deployment

Keep this branch separate until syntax checks and a real test session are verified. Do not deploy solely because the dashboard page loads. Confirm the dashboard API key, CORS origin, session login, command handling, direct targeting, thread cooldown, and pause/resume behavior before merging.
