# The door's check page

A static page that runs Cloudflare Turnstile for the 12-words door on a busy day (`apps/server/src/services/door-check.ts`
says when and why). It is served at `check.beanpool.org`, on Cloudflare Pages.

It must never be on a node's own origin: that origin holds the member's seed, and its policy allows no third-party script
(`apps/server/src/app-document-csp.ts`). So the web app comes here by a full-page hop, and the phone opens the page in an
embedded browser.

**Going in**, in the URL fragment: `sitekey`, `cdata` (the first 32 hex characters of the joining key), `theme` (`light` or
`dark`), and on the web `return` (a node's origin, which must be in `RETURN_ORIGINS` in `check.js`).

**Coming back**: on the web, a replace to `<return>/app/auth/check#token=…` or `#error=wont_load|failed|closed`. On the
phone, `{ token }`, `{ error }` or `{ ready: true }` through `window.ReactNativeWebView.postMessage`.

The page has no words of its own: the widget speaks the browser's language, and the apps say the rest from their catalogs.
It holds no key. The site key arrives from the node, which reads it from `.env`.

## Publishing

No build. Upload this folder as it is to a Pages project with `check.beanpool.org` as its custom domain, make a Turnstile
widget for that one hostname, and set `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and
`TURNSTILE_PAGE_URL=https://check.beanpool.org/` in the node's `.env`.

A node of your own needs its own copy of this page and its own widget: put your node's origin in `RETURN_ORIGINS`.
