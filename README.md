# Banat-only Messenger bot

A clean standalone copy of the Banat concept for a separate friend bot.

## Included

- Banat trigger/reply pools
- `!banat on`, `off`, `toggle`, `status`, `help`
- Active-conversation mode
- Reply-to-bot / mention / direct-address targeting while off
- Local anti-repeat memory
- Local shorthand/texting dictionary
- Local typo, keyboard-slip, spacing and case variation
- Local reaction/punctuation variation
- Local human timing and typing lifecycle
- Per-thread send queue
- Global send limiter
- Messenger `1545012` retry/cooldown protection
- Tiny HTTP health endpoint for Render-style hosting

## Deliberately NOT included

- No AI provider
- No Gemini/OpenAI/Anthropic code
- No AI prompts or model calls
- No AI memory/personality system
- No games
- No economy
- No RPG
- No music/YouTube
- No Neon/PostgreSQL/database
- No moderation/admin framework
- No ECLIPSE project modules
- No backups from the main bot

Everything in this repository is local JavaScript. The humanizer does not call an AI service.

## Setup

```bash
npm install
npm start
```

Set `FB_COOKIES` or `FB_APPSTATE` to the JSON cookie/appState array used by `ws3-fca`.

For Render:

- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `FB_COOKIES` or `FB_APPSTATE`

Never commit real Facebook cookies/appState to GitHub. `cookies.json` and `appstate.json` are ignored.

## Banat activation

Inside a thread:

```text
!banat on
!banat off
!banat toggle
!banat status
!banat help
```

`!banat on` activates the thread immediately. The same person who issued the command is eligible for the next response, so there is no separate "first person" exclusion.

When Banat is off, the bot only reacts to explicit replies/mentions/direct `bot` or `banat` addresses.

To make every thread automatically active, set:

```text
BANAT_DEFAULT_ON=true
```

## Humanizer tuning

Optional variables:

- `BANAT_REPLY_DELAY_MS`
- `BANAT_MAX_HUMAN_DELAY_MS`
- `BANAT_TYPO_RATE`
- `BANAT_SHORTHAND_RATE`
- `BANAT_CASE_VARIATION_RATE`
- `BANAT_SPACE_SLIP_RATE`
- `BANAT_HESITATION_RATE`
- `BANAT_MEMORY_SIZE`
- `BANAT_MEMORY_TTL_MS`
- `BANAT_GLOBAL_SEND_LIMIT`
- `BANAT_THREAD_SEND_LIMIT`
- `BANAT_THREAD_COOLDOWN_MS`

No API key is required for the humanizer because it is entirely local.
