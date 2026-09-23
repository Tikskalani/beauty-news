# Daily Beauty News — live

Beauty-industry deal intelligence that runs on its own: every 5 minutes a GitHub Actions job sweeps
the trade press, the newswires and a Google News search for every house on the watchlist, classifies
what it finds (M&A, funding, earnings, partnerships), merges the same deal reported by many outlets
into one event, and pushes each **new** deal straight to your phone. The dashboard is a static page on
GitHub Pages that reads the live record, so it is current from any device.

Nothing here depends on a laptop being on or a Claude session being open.

```
GitHub Actions (every 5 min)            phone
  scripts/poll.mjs ── new deal ──► Twilio SMS / ntfy ──► your phone
        │
        └─ writes feed.json ──► "data" branch ──► dashboard (GitHub Pages, reads it live)
```

## One-time setup

1. **Alert channel.** Either or both:
   - **Text message (Twilio):** set four repository secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
     `TWILIO_FROM` (your Twilio number, e.g. `+18325551234`), `SMS_TO` (your mobile, same format;
     comma-separate several). US carriers only deliver business texts from a registered sender: complete
     Twilio's **toll-free verification** (toll-free number) or **A2P 10DLC** registration (local number).
   - **ntfy push:** install **ntfy**, subscribe to a private topic on `ntfy.sh`, set secret `NTFY_TOPIC`.
   Then *Actions → test-alert → Run workflow* sends one test through every configured channel.
2. **Repo:** push this folder to a **public** GitHub repo (public = unlimited Actions minutes and free
   Pages; no secrets are stored in the code). Then in the repo:
   - *Settings → Secrets and variables → Actions:* the secrets from step 1.
   - *Settings → Pages → Source:* **GitHub Actions**.
   - *Actions* tab: enable workflows, open **pages** → *Run workflow*, then **poll** → *Run workflow*.
3. Dashboard: `https://<your-username>.github.io/<repo-name>/`. On a phone, *Share → Add to Home Screen*.

The first poll seeds the record from `seed/history.json` and sends nothing. From the second run on,
every new deal is pushed once.

### Optional
| Setting | Where | Effect |
|---|---|---|
| `HEALTHCHECK_URL` | secret | Pings a free [healthchecks.io](https://healthchecks.io) check each run. If runs stop (GitHub outage, disabled workflow), healthchecks.io alerts you — connect its ntfy integration to get that on the phone too. |
| `NOTIFY_PRESS` = `1` | variable | Also push a low-priority digest of non-deal trade-press stories. |
| `NTFY_SERVER` | variable | Self-hosted ntfy server instead of ntfy.sh. |

## What gets pushed
- One push per new deal event, as soon as it's classified. **MAJOR** (max priority) when a watchlist
  house does M&A or funding, or a disclosed value is ≥ $1B.
- More than 5 new deals in one sweep → one digest instead of a burst.
- The same deal from other outlets is merged into the first event ("+N more" on the dashboard), never
  re-sent. Nothing older than 12 hours is ever pushed.
- A source failing for ~2 hours straight → one "source health" push, and one when it recovers.

## Latency, honestly
Sources are polled every 5 minutes, but GitHub starts scheduled jobs late when its runners are busy,
typically 0–15 minutes, occasionally more. Trade outlets and Google News also take minutes to publish
and index a story. Expect most deals on your phone within ~5–20 minutes of publication.

## Change what's tracked
- Houses: `config/watchlist.json` (`match` = whole-word patterns, accents stripped).
- Sources: `config/sources.json` (RSS feeds, plus Google News queries for sites without a usable feed).
- Classification rules: top of `scripts/poll.mjs` (`RE`, `SECTORS`, `GEOS`).

Local dry run (prints pushes instead of sending): `DATA_DIR=.local-data node scripts/poll.mjs`

*Signal only, not investment advice. Verify against primary filings before acting.*
