# The busy page for global.beanpool.org

A Cloudflare Worker on the route `global.beanpool.org/*` (BUSY-PAGE; Fable `DESIGN-multicore-node-fable.md` §6, step T5;
Marty's yes on 7 Nov 2026). When the global node is too busy to answer, a visitor's browser shows a short, calm page
instead of a spinner and then Cloudflare's error page, and sends them on to beanpool.org, which is served by Cloudflare
Pages and so stays up whatever global does:

> **The global community is very busy right now.**
> Taking you to beanpool.org, where you can read about BeanPool and get the app.
> [Go now](https://beanpool.org/) · Try global again
> Already using the BeanPool app? It keeps working as usual.

After 5 seconds the page takes the visitor to beanpool.org's front page **in their language** (`https://beanpool.org/<lang>/`,
English at `https://beanpool.org/`). "Go now" goes there at once; the smaller "Try global again" asks global for the same
address again. (BUSY-PAGE-REDIRECT, Marty, 7 Nov 2026: say global is busy and send visitors to beanpool.org, rather than
"come back soon".)

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

- One HTML document under 8 KB: inline styles, **one small inline script** (the redirect), no font, no image, an empty
  `data:` icon (so the browser does not ask the struggling node for `/favicon.ico`), and a `Content-Security-Policy` of
  `default-src 'none'` that lets it load nothing from anywhere. The policy allows that one script by its SHA-256
  (`script-src 'sha256-…'`, worked out for each page by `pageCsp()` in `src/index.js`), so no other script can run.
- **The redirect** is `setTimeout(() => location.replace(target), 5000)`. `replace`, not `assign`, so the Back button does not
  return a visitor to a page that would send them on again. For a browser with scripts off, the same target is a
  `<meta http-equiv="refresh" content="5;url=…">` inside `<noscript>` in the head, so a browser that runs scripts never has
  both. The target is another host (`beanpool.org`, never the route `global.beanpool.org/*`), so it cannot loop back to the
  Worker. The status stays `503`, `Retry-After`, `no-store`: only the page changed.
- **Try global again** links to the address the visitor asked for (the request's own URL, escaped in the attribute, its
  fragment dropped; an address that is not `http(s)` or is over 2,048 characters falls back to `/`), so it reloads that very
  page.
- BeanPool's colours, from the brand library (`packages/beanpool-core/src/brand-colours.ts`): dark by default as
  beanpool.org is, light when the device is set to light. Each colour names its role; the test fails if one drifts or a
  pair of words reads under 4.5:1.
- No fixed widths: the card is the screen's width up to 32 rem and the words wrap, so it holds at 320 px with 130 %
  text. Sizes are in rem, so a phone's larger-text setting scales them.

### Words

`src/words.json` holds the page's five lines (`heading`, `body`, `go`, `retry`, `apps`) in the website's 25 languages, chosen
from the visitor's `Accept-Language` (q-values honoured; `zh-TW`/`zh-HK`/`zh-Hant` → 繁體中文, other `zh` → 简体中文, `tl` →
Filipino; English when none fits). The same pick chooses the redirect's target: `pt-BR` → `https://beanpool.org/pt/`,
`zh-TW` → `/zh-Hant/`, `fr` → `/fr/`, English and anything unknown → `https://beanpool.org/`. Each target is the front page
of that language's folder on the site (`apps/website/<lang>/index.html`), which exists for all 24 others; the test checks
it. Arabic, Persian and Urdu are drawn right to left. English is the source; **every other language is a machine draft and
the page says so** in its own language until a person checks it (then drop that language's `machine` key and the test's
draft rule for it).

These words are outside the words index (they do not go through `t()`): the PR that adds or changes them names
`apps/busy-worker/src/words.json` in its "Words outside the index" line.

## Switches

Two Worker variables, both `"0"` in `wrangler.toml`:

| Variable | Effect |
|---|---|
| `BUSY_FORCE=1` | Every page request gets the busy page without asking the origin (the node is down, or you want it off the front door), and that page takes the visitor to beanpool.org after 5 s. Non-page requests still pass through. |
| `BUSY_OFF=1` | Everything passes straight through, as if the Worker were not there (it still runs, and still counts as a request). |

`BUSY_OFF` wins when both are set. `1` or `true` turns one on; anything else is off.

**`BUSY_FORCE` also turns away members who use the web app on global.** In a browser a member's page load is a GET with
`Accept: text/html`, no cookie and no signature (the web app has no service worker and the node sets no cookie), so the Worker
cannot tell it from a visitor's, and the page's "It keeps working as usual" is true only for the phone apps. Since the page
now sends a visitor on to beanpool.org after 5 s, a web-app member is taken off global too, and "Try global again" is how
they come back. So force it only when global is failing anyway. The automatic mode (no switch) shows the page when the origin answers 5xx, errors, or takes
more than 5 s to start answering a page. That last case includes a node that is slow but alive: web-app members then get the
busy page while the phone apps, which wait with no such timeout, still get through.
`scripts/busy-page-deploy.sh --force` / `--off` deploy with one on; a plain deploy sets both off. In the dashboard they are under
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
3. **Web-app members look like visitors.** A page load of the web app on global is a plain GET for HTML (no service worker,
   no cookie), so `BUSY_FORCE` turns web members away too, and the automatic mode does whenever the page takes over 5 s:
   on a slow but working node, web members see the busy page, and are sent on to beanpool.org after 5 s, while phone
   members carry on. The page's "keeps working as usual" is about the phone apps. Accept that, or keep the route off until
   the trigger and take it off as soon as the node recovers.
4. **The node is unaware.** Nothing here changes the node, its `.env`, or any self-hoster's default.
5. **The redirect.** The busy page sends visitors to `beanpool.org` (static files on Cloudflare Pages), so global's load
   does not follow them there, and nothing on the node is asked for. It does mean that while the Worker is on the route,
   visitors who hit a busy node land on the public site after 5 s, in their language: check at the rehearsal that
   `https://beanpool.org/` and a language folder (for example `/fr/`) answer. The page's script runs only while the
   policy's `script-src` hash is its own SHA-256 (the test pins the two together); if they ever differed the browser
   would block the script and the visitor would stay on the page with the "Go now" link.

## The token

`scripts/busy-page-deploy.sh` reads `CLOUDFLARE_WORKERS_TOKEN` from the environment and hands it to wrangler alone (as
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
bash scripts/busy-page-deploy.sh --dry-run   # bundles it and shows what would upload; no token, contacts nothing
bash scripts/busy-page-deploy.sh             # live: on the route, both switches off
bash scripts/busy-page-deploy.sh --force     # live: busy page for every page request
bash scripts/busy-page-deploy.sh --off       # live: everything passes through
bash scripts/busy-page-deploy.sh --remove    # deletes the Worker and its route: global is as it was
```

A deploy is the director's at the trigger (T5: origin 5xx or timeouts at Cloudflare), never a lane's.

**Rehearsal (a quiet hour):** deploy with the switches off, then

```sh
# GET, not curl -I: a HEAD is not a page request and always passes through, so it would prove nothing.
curl -s -o /dev/null -D - -H 'accept: text/html' https://global.beanpool.org/ | grep -i -E '^HTTP|x-beanpool-busy'   # the node's 200, no x-beanpool-busy
curl -s -o /dev/null -D - https://global.beanpool.org/api/version | grep -i '^HTTP'                                  # the API, as before
```

and open the web app and the phone app on global: both as before. Then `--force` for a minute: the first `curl`
answers `503` with `x-beanpool-busy: 1` and a browser shows the page (try a phone at 320 px, light and dark) and, after 5 s,
lands on beanpool.org in the browser's language ("Go now" goes at once; "Try global again" asks global for the same page
again); the API `curl` and the apps are unchanged. Then a plain deploy (or `--remove`), and check point 2 above in the node's log.

## Tests

`pnpm test` (`node --test test/busy-worker.test.js`; reads `@beanpool/core`'s built `dist` for the colour check, which
turbo builds first). They run in CI with every package's `test` (`turbo run test`, the vitest-rest shard). No network:
the origin is a fake, and the real `fetch` fails the test if anything reaches it.
