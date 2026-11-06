# The busy page for global.beanpool.org

A Cloudflare Worker on the route `global.beanpool.org/*` (BUSY-PAGE; Fable `DESIGN-multicore-node-fable.md` §6, step T5;
Marty's yes on 7 Nov 2026). When the global node is too busy to answer, a visitor's browser shows a short, calm page
instead of a spinner and then Cloudflare's error page:

> **The global community is very busy right now**
> Lots of people are arriving at the same time. Please try again in a few minutes.
> [Start your own community](https://beanpool.org/start) · [Find one near you](https://beanpool.org/#find-or-start)
> Already using the BeanPool app? It keeps working as usual.

It is ours alone. It runs on Cloudflare in front of our global node; no self-hosted node needs it, and nothing in the
node knows it exists.

## What it answers, and what it never touches

Only a **browser asking for a page** is ever answered here: a `GET` whose `Accept` names `text/html`, with

- no `Upgrade` or `Sec-WebSocket-Key` (sockets),
- no `Authorization`,
- no signature header (`x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-signed-for`, `x-accept-signer`, or
  any `x-bp-*`),
- no cookie of ours. Cloudflare's own cookies (`cf_*`, `__cf*`, `_cf*`: bot checks, a solved challenge) are no
  session, so a visitor who passed an "Under Attack" challenge still gets the busy page; any other cookie means the
  request goes to the node untouched.

Every other request (the API, signed requests, sockets, scripts, images, `POST`, `HEAD`) is handed to the origin
exactly as it came (the same `Request`, no timeout added) and the origin's answer goes back exactly as it came, errors
included. The members' apps are unaffected.

A page request goes to the origin with **5 s** to send its headers (the timer stops when they arrive, so a slow page
body is never cut off). The visitor gets the busy page when the origin

- answers any **5xx**, Cloudflare's own **520–530** included (tunnel down, origin refused or timed out), or
- cannot be reached at all, or
- sends no headers in 5 s.

The busy page is `503`, `Retry-After: 120`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and
`X-Beanpool-Busy: 1` (how you tell it from the node's own answer). Any other answer (200, a redirect, 304, 404, 429) is
the origin's, unchanged.

### The page

- One HTML document under 8 KB: inline styles, no script, no font, no image, an empty `data:` icon (so the browser does
  not ask the struggling node for `/favicon.ico`), and a `Content-Security-Policy` of `default-src 'none'` that lets it
  load nothing from anywhere.
- BeanPool's colours, from the brand library (`packages/beanpool-core/src/brand-colours.ts`): dark by default as
  beanpool.org is, light when the device is set to light. Each colour names its role; the test fails if one drifts or a
  pair of words reads under 4.5:1.
- No fixed widths: the card is the screen's width up to 32 rem and the words wrap, so it holds at 320 px with 130 %
  text. Sizes are in rem, so a phone's larger-text setting scales them.

### Words

`src/words.json` holds the page's five lines in the website's 25 languages, chosen from the visitor's
`Accept-Language` (q-values honoured; `zh-TW`/`zh-HK`/`zh-Hant` → 繁體中文, other `zh` → 简体中文, `tl` → Filipino; English
when none fits). Arabic, Persian and Urdu are drawn right to left. English is the source; **every other language is a
machine draft and the page says so** in its own language until a person checks it (then drop that language's
`machine` key and the test's draft rule for it). The links go to the same language's pages on beanpool.org, which
exist for all 25.

These words are outside the words index (they do not go through `t()`): the PR that adds or changes them names
`apps/busy-worker/src/words.json` in its "Words outside the index" line.

## Switches

Two Worker variables, both `"0"` in `wrangler.toml`:

| Variable | Effect |
|---|---|
| `BUSY_FORCE=1` | Every page request gets the busy page without asking the origin (the node is down, or you want it off the front door). Non-page requests still pass through. |
| `BUSY_OFF=1` | Everything passes straight through, as if the Worker were not there (it still runs, and still counts as a request). |

`BUSY_OFF` wins when both are set. `1` or `true` turns one on; anything else is off.
`scripts/deploy.sh --force` / `--off` deploy with one on; a plain deploy sets both off. In the dashboard they are under
Workers → `beanpool-busy-page` → Settings → Variables (a change there takes effect in seconds, no deploy).

## Before it goes live: read these

1. **The request cap.** Every request to global (the API and sockets too) invokes this Worker. Cloudflare's Workers Free
   plan allows **100,000 requests a day for the whole account** (the registrar and feedback Workers share it). Check
   the account's plan and global's requests per day in Cloudflare's analytics first. On Free, put it on the route only
   at the trigger and take it off after (`--remove`), and set the route's **request-limit failure mode to "Fail open
   (proceed)"** in the dashboard (Workers Routes → the route): "fail closed" would answer error 1027 to every request,
   the members' apps included, once the cap is reached. A route on `global.beanpool.org/api/*` with Worker **None**
   would keep the API (most of the traffic) from invoking it at all.
2. **The visitor's address.** The node's limiters key on `CF-Connecting-IP` (`apps/server/src/client-ip.ts`). A
   Worker's request to its own zone is expected to keep the visitor's address there; check it at the rehearsal (the
   node's log should still show many addresses, not one Cloudflare address), and remove the Worker at once if not.
3. **The node is unaware.** Nothing here changes the node, its `.env`, or any self-hoster's default.

## The token

`scripts/deploy.sh` reads `CLOUDFLARE_WORKERS_TOKEN` from the environment and hands it to wrangler alone (as
`CLOUDFLARE_API_TOKEN`); it never prints it. A custom token (Cloudflare dashboard → My Profile → API Tokens), the
BeanPool account only:

- Account · **Workers Scripts** · Edit
- Account · **Account Settings** · Read
- Zone · **Workers Routes** · Edit, and Zone · **Zone** · Read, for zone `beanpool.org` only (wrangler finds the zone by
  name to attach the route)

The registrar's deploy token (`apps/registrar/README.md`, Deploy) has these scopes and more (D1); a token of its own for
this Worker is the narrower choice. `CLOUDFLARE_ACCOUNT_ID` defaults to the BeanPool account.

## Deploy

From `apps/busy-worker`, after `pnpm install --frozen-lockfile` at the repo root:

```sh
pnpm test                          # the tests, no network
bash scripts/deploy.sh --dry-run   # bundles it and shows what would upload; no token, contacts nothing
bash scripts/deploy.sh             # live: on the route, both switches off
bash scripts/deploy.sh --force     # live: busy page for every page request
bash scripts/deploy.sh --off       # live: everything passes through
bash scripts/deploy.sh --remove    # deletes the Worker and its route: global is as it was
```

A deploy is the director's at the trigger (T5: origin 5xx or timeouts at Cloudflare), never a lane's.

**Rehearsal (a quiet hour):** deploy with the switches off, then

```sh
curl -sI -H 'accept: text/html' https://global.beanpool.org/ | grep -i -E '^HTTP|x-beanpool-busy'   # the node's 200, no x-beanpool-busy
curl -sI https://global.beanpool.org/api/version | grep -i '^HTTP'                                  # the API, as before
```

and open the web app and the phone app on global: both as before. Then `--force` for a minute: the first `curl`
answers `503` with `x-beanpool-busy: 1` and a browser shows the page (try a phone at 320 px, light and dark); the API
`curl` and the apps are unchanged. Then a plain deploy (or `--remove`), and check point 2 above in the node's log.

## Tests

`pnpm test` (`node --test test/busy-worker.test.js`; reads `@beanpool/core`'s built `dist` for the colour check, which
turbo builds first). They run in CI with every package's `test` (`turbo run test`, the vitest-rest shard). No network:
the origin is a fake, and the real `fetch` fails the test if anything reaches it.
