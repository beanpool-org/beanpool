# beanpool-feedback

Cloudflare Worker behind **"Suggest a change to BeanPool"** in the member app, the web app (PWA) and
the node Settings app. Every BeanPool install, including self-hosted nodes run by people we never talk to,
sends suggestions here, to the project, so they are all heard in one place. A weekly agent digest
(`scripts/feedback-digest.sh`) sorts them and brings Marty a one-screen summary.

Nothing sent here is published. Spam never goes anywhere public: the digest only *lists* candidates to
file as GitHub Discussions, and a person decides.

## Endpoints

| Route | Who | What |
|---|---|---|
| `POST /api/feedback` | anyone, no account | Store a suggestion. Rate-limited. CORS open (no credentials). |
| `GET /api/feedback/admin/items?status=new&limit=200` | `Authorization: Bearer $FEEDBACK_ADMIN_TOKEN` | List items with that status, oldest first (limit ≤ 500), plus `total`. |
| `POST /api/feedback/admin/items/:id` | same bearer | `{ "status": "new"\|"spam"\|"triaged"\|"filed", "github_url"?, "note"? }` |

Nothing else is readable. Admin routes send no CORS headers.

### Submission body

```json
{
  "text": "10–2000 characters after trim (counted as characters, not bytes)",
  "kind": "idea | problem | other",
  "source": "member-app | web | settings-app",
  "appVersion": "1.2.37",
  "platform": "android | ios | web",
  "lang": "es-AR",
  "community": "optional, ≤ 80 — only if the member chose to say",
  "website": ""
}
```

`website` is a honeypot: none of our forms send it, so only scripts posting straight to the API fill it. If it is filled, the Worker answers `201 {ok:true}` and stores
and counts nothing. Bodies over 16 KB are refused (`413`) before they are parsed. A malformed `appVersion`,
`platform` or `lang` is dropped, never a reason to lose the suggestion.

Responses: `201 {ok:true}` · `400 {ok:false,error}` with a human-readable reason · `429` with a friendly
message and `Retry-After` · `413`. The apps keep the member's text on any failure.

## What is stored

In `feedback_items`, one row per suggestion: the text, kind, source, app version, platform, language,
the community name **only if the member typed one** (the field starts empty), the time received, and a
triage status (`new` → `spam` / `triaged` / `filed`), plus an optional GitHub link and triage note.

## What is not stored

- **No IP address**, no user agent, no member key or identity, no node address, no cookies.
- The Worker does not log requests (`[observability] enabled = false`, and the code never logs).
- Rate limiting uses `SHA-256(daily salt ‖ sender)`, where sender is the IPv4 address or the IPv6 /64 network, plus one global daily cap (`RATE_GLOBAL_PER_DAY`, default 2000). The salt is 32 random bytes, kept only in D1, never
  logged, and replaced at the first request of each UTC day. The old salt and all old counters are
  deleted then and again by the daily cron. The counters never point at a feedback row.

Limits (vars in `wrangler.toml`): **5 per hour and 20 per UTC day per sender**. A community behind one
shared connection (carrier-grade NAT, a village wifi) shares one allowance, so raise `RATE_PER_HOUR` /
`RATE_PER_DAY` if real members start hitting it. The hourly window restarts at UTC midnight when the
salt rotates.

## Privacy statement (for the app copy and the website)

> Suggestions go to the BeanPool project team, not to your community. We keep what you write, the kind of
> suggestion, your app version, platform and language, and your community's name only if you choose to
> give it. We do not keep your IP address, your device details or anything that identifies your
> account. To stop floods of spam we count how many suggestions come from each connection, using a
> scrambled code that changes every day and is deleted after it. Suggestions are read by the project
> team with help from an AI assistant that sorts, translates and groups them; nothing is published
> automatically. Please don't include personal details.

Limits of that promise, stated honestly: Cloudflare, which runs this Worker, sees the connection like
any website host does. On the day a suggestion is sent, someone with access to the database *and* a
guess at your IP could test the guess against that day's counters. After the day ends they cannot.

## Deploy (the director does this, with Marty's go)

```bash
cd apps/feedback

# 1. D1 database
npx wrangler d1 create beanpool-feedback          # paste database_id into wrangler.toml (replace the placeholder)
npx wrangler d1 execute beanpool-feedback --remote --file schema.sql

# 2. Admin token: generate once, keep it in the keychain for the digest, give it to the Worker
security add-generic-password -a "$USER" -s beanpool-feedback-admin -w "$(openssl rand -hex 32)"
security find-generic-password -s beanpool-feedback-admin -w | npx wrangler secret put FEEDBACK_ADMIN_TOKEN

# 3. Uncomment the [[routes]] block in wrangler.toml, then
npx wrangler deploy

# 4. Smoke test (expect 201, then 400 for the short one)
curl -si https://beanpool.org/api/feedback -H 'content-type: application/json' \
  -d '{"text":"Smoke test from the deploy runbook — please mark spam","kind":"other","source":"web"}'
curl -si https://beanpool.org/api/feedback -H 'content-type: application/json' -d '{"text":"short","source":"web"}'
```

The route pattern is `beanpool.org/api/feedback*` (no slash before `*`) so it matches the public
endpoint itself as well as `/api/feedback/admin/…`. It coexists with the Pages site and the registrar
Worker, since Worker routes win only for matching paths.

## Weekly digest

`scripts/feedback-digest.sh` reads the admin token from the macOS keychain, fetches `status=new`, runs
a headless Claude with `scripts/feedback-digest-prompt.md` (drop spam, translate, cluster, count
communities), writes `.claude/queue-board/feedback-digest.md`, then marks each fetched item `spam` or
`triaged`. Filing on GitHub stays manual. A launchd example for Monday 8am is in
`scripts/launchd/com.marty.beanpool-feedback-digest.plist.example` (not installed).

## Tests

```bash
pnpm --filter @beanpool/feedback test     # node --test, real SQLite (node:sqlite) behind a D1-shaped shim
```
