# Banat Test Bot

## Runtime

- Node.js 18 or newer (Node 22 recommended).
- Start command: `npm start`
- Health endpoint: `/health`
- Dashboard: `/` or `/dashboard`
- Dashboard API: origin-restricted `/api/dashboard/*` endpoints; owner-only Security management endpoints additionally require the dashboard API key.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `FB_COOKIES` | Facebook cookie/header string for the bot session. |
| `FB_APPSTATE` | Alternative exported cookie/appstate JSON format. Use one session variable, not both. |
| `ECLIPSE_DASHBOARD_ORIGIN` | Allowed dashboard origin(s), comma-separated when more than one is needed. |

Optional:
- `ECLIPSE_DASHBOARD_API_KEY` — long random key required for owner-only Security management endpoints; normal dashboard API access remains origin-restricted.
- `BANAT_DEFAULT_ON=true` enables Banat automatically in threads after incoming messages.
- `BANAT_GLOBAL_SEND_LIMIT=2` limits concurrent outgoing messages.
- `BANAT_THREAD_COOLDOWN_MS=12000` sets a per-thread send cooldown.

Never commit Facebook cookies or dashboard keys. Prefer setting them as private service environment variables. The dashboard can accept a cookie header or JSON appstate export and keeps the normalized session in process memory only. On Render Free, local files and process memory are temporary. Facebook sessions must be re-entered after restart/spin-down, and a client installation identity may need owner reapproval if its local identity file is lost. Do not commit or share session values.


## ECLIPSE licensing and authorized deployments

This repository is the owner-controlled upstream for Test Bot 2.0. Do not publish deployment credentials, Facebook sessions, signing keys, or private license data.

### Owner service (the original Render deployment)

Configure these private Render environment variables on the original Test Bot service:

| Variable | Purpose |
| --- | --- |
| `ECLIPSE_LICENSE_SERVER_MODE=true` | Enables the original deployment as the license authority. |
| `ECLIPSE_LICENSE_PRIVATE_KEY` | Ed25519 private key in PEM format; keep this only on the owner service. |
| `ECLIPSE_DASHBOARD_API_KEY` | Long random key required only for owner-only Security management endpoints. |
| `ECLIPSE_DASHBOARD_ORIGIN` | Comma-separated allowed dashboard origins, including the main ECLIPSE dashboard origin. |
| `ECLIPSE_LICENSE_DATABASE_URL` | Neon PostgreSQL connection string used for the durable owner registry. `DATABASE_URL` is accepted as a fallback. |

The owner registry is stored in Neon PostgreSQL, so the original Test Bot does not need a Render persistent disk. Create a Neon project and database, then copy its pooled connection string into `ECLIPSE_LICENSE_DATABASE_URL` on the original Test Bot Render service. Keep the connection string private. The application creates its tables and stores the owner installation identity, installation approvals/revocations, and security events automatically. Use the pooled connection string with SSL enabled. Render Free local files are temporary and must not be used as the owner registry.

Generate a signing keypair on a trusted local machine (never in a public repository):

```bash
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');console.log('PRIVATE KEY\n'+k.privateKey.export({type:'pkcs8',format:'pem'}));console.log('PUBLIC KEY\n'+k.publicKey.export({type:'spki',format:'pem'}))"
```

Store the private key only in the original service's Render environment. Keep the matching public key for authorized client installations.

### Authorized client deployments

A deployment that runs the protected version must have:

- `ECLIPSE_LICENSE_SERVER_URL`: the original owner's Test Bot service URL.
- `ECLIPSE_LICENSE_PUBLIC_KEY`: the matching Ed25519 public key.
- `ECLIPSE_SECURITY_DATA_DIR` (optional): local directory for its installation identity. On Render Free, the local identity file can be lost after spin-down/redeploy, which creates a new pending installation that must be approved again. This does not erase the owner registry in Neon.
- `ECLIPSE_FORK_REPOSITORY` (optional): the fork's `owner/repository` name so the owner registry can label it.

New installations appear as pending in the owner's Security panel. The owner must approve them before Messenger login starts. Revoked installations stop processing when the next license check is received. Signed leases are short-lived; temporary authority outages are tolerated only while a previously issued lease remains valid.

### Existing forks

Forks that are already running the older version are not remotely changed by this release and may continue running their current code. If an existing fork updates to this protected version, it must be registered and approved by the owner before it can start. Existing forks are not automatically revoked merely because the protection is introduced.

### Important limits

GitHub monitoring detects public GitHub forks of the upstream repository; it cannot reliably discover private copies, downloaded archives, or code redistributed elsewhere. The license check protects deployments that retain this enforcement code and depend on the owner's license authority. Someone who removes or rewrites the check can bypass it, so never include private credentials or signing keys in the repository.

## Banat commands

Send these in the target Messenger group:
- `!banat on`
- `!banat off`
- `!banat toggle`
- `!banat status`
- `!banat help`

## Dashboard behavior

The dashboard displays session connection state, process state, uptime, Node version, memory, and recent dashboard control events. Start/pause buttons only resume or pause message processing; they do not log in, log out, or replace the Facebook session. The event list is in-memory and resets when the process restarts.

The dashboard API's origin check is controlled by `ECLIPSE_DASHBOARD_ORIGIN`. Dashboard-provided Facebook sessions are process-memory-only and are cleared by restarts or Render Free spin-downs.

## Safety and deployment

Keep this branch separate until syntax checks and a real test session are verified. Do not deploy solely because the dashboard page loads. Confirm the dashboard API key, CORS origin, session login, command handling, direct targeting, thread cooldown, and pause/resume behavior before merging.
