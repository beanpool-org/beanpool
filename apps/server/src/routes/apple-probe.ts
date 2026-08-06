/**
 * Apple Sign In `sub` parity probe — a temporary diagnostic, gated so it cannot ship.
 *
 * ## What it answers
 *
 * The keyholder model's sign-in keeper (docs/ONBOARDING.md K4) unwraps its fragment with a key
 * derived from the provider's subject claim. That only works if `sub` is the same value
 * everywhere. Apple's `sub` is stable per user *per developer team*, but the native App ID and
 * the web **Services ID** must be grouped under the same primary App ID — and if they are not,
 * the same human gets one `sub` on the phone and a different one in the browser.
 *
 * The consequence is bad and quiet: a fragment stored during signup on the phone simply does not
 * unwrap during a recovery attempted from a laptop, which is one of the most likely recovery
 * stories there is. Nothing detects it until someone actually needs it.
 *
 * So before Phase E is built on that assumption, this probe measures it. Sign in on both
 * surfaces with the same Apple ID, compare the two strings. That is the entire purpose, and this
 * file should be deleted once the answer is written down.
 *
 * ## Why it is gated twice over
 *
 * A debug page that renders a decoded identity token has no business on a live community node.
 * `APPLE_PROBE=1` is required for the probe routes to be **registered at all** — not checked
 * per-request, not hidden behind a flag in the handler, simply absent from the routing table
 * unless deliberately switched on. Default off, so a normal deploy cannot expose it.
 *
 * The domain-association file is deliberately NOT behind that gate. Apple re-verifies domains
 * periodically, and tying that to a debug flag would mean verification silently lapsing months
 * later when the flag is long forgotten. It serves whenever its content is configured, which is
 * safe: the file is a public verification token by design.
 *
 * ## Environment
 *
 *   APPLE_PROBE=1                  register the probe pages (default: off)
 *   APPLE_SERVICES_ID              Services ID / OAuth client_id (default: org.beanpool.web)
 *   APPLE_DOMAIN_ASSOCIATION       verbatim contents of Apple's association file
 *   APPLE_PROBE_REDIRECT_URI       override the callback URL (default: derived from Host)
 */

import Router from '@koa/router';
import type Koa from 'koa';

/** Apple's POST callback is small; anything larger is not from Apple. */
const MAX_CALLBACK_BYTES = 16 * 1024;

const SERVICES_ID = process.env.APPLE_SERVICES_ID || 'org.beanpool.web';

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Read the raw request body.
 *
 * Necessary because the server's body-parser middleware only handles `application/json`
 * (https-server.ts), and Apple posts `application/x-www-form-urlencoded` — so `ctx.requestBody`
 * arrives empty for this callback and the token would appear to be missing.
 */
function readRawBody(req: Koa.Context['req']): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_CALLBACK_BYTES) {
                reject(new Error('callback body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * Decode a JWT's payload **without verifying it**.
 *
 * Correct for a probe and wrong for anything else: we are reading a claim to compare it against
 * another, not trusting it to authorise something. The real `/api/recovery/sso-verify` must
 * verify the signature against Apple's JWKS and check `aud` — see Phase E.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:44rem;
      margin:0 auto;padding:2rem 1.25rem;background:#faf9f6;color:#1c1b19}
 h1{font-size:1.4rem;margin:0 0 .25rem} .sub{color:#66625a;margin:0 0 1.5rem;font-size:.9rem}
 .banner{background:#fbeee9;border-left:4px solid #a8442f;padding:.75rem 1rem;border-radius:4px;
      margin-bottom:1.5rem;font-size:.9rem}
 code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
 pre{background:#fff;border:1px solid #e3ded3;border-radius:6px;padding:1rem;overflow-x:auto}
 .sub-value{background:#fff;border:2px solid #2f6b46;border-radius:6px;padding:1rem;
      font-family:ui-monospace,Menlo,monospace;font-size:1rem;word-break:break-all;margin:.5rem 0 1.5rem}
 .label{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#66625a;margin-bottom:.35rem}
</style></head><body>
<div class="banner"><strong>Diagnostic page.</strong> Only present because <code>APPLE_PROBE=1</code>
is set on this node. It decodes an identity token without verifying it, and must not be left enabled.</div>
${body}
</body></html>`;
}

export function createAppleProbeRoutes(): Router {
    const router = new Router();

    // Served whenever configured, independent of the probe gate — Apple re-verifies domains on
    // its own schedule, and a verification that depends on a debug flag is one that lapses later.
    const association = process.env.APPLE_DOMAIN_ASSOCIATION;
    if (association) {
        router.get('/.well-known/apple-developer-domain-association.txt', async (ctx: Koa.Context) => {
            ctx.type = 'text/plain; charset=utf-8';
            ctx.body = association;
        });
    }

    if (process.env.APPLE_PROBE !== '1') {
        // Not registered at all. The point of returning an empty router rather than checking a
        // flag inside each handler: there is no reachable path to switch on by accident.
        return router;
    }

    router.get('/apple-probe', async (ctx: Koa.Context) => {
        const redirectUri = process.env.APPLE_PROBE_REDIRECT_URI
            || `${ctx.request.protocol}://${ctx.request.host}/apple-probe`;

        ctx.type = 'html';
        ctx.body = page('Apple sub parity probe', `
<h1>Apple Sign In — <code>sub</code> parity probe</h1>
<p class="sub">Sign in here, then sign in on the phone with the <strong>same Apple ID</strong>, and
compare the two values. Identical means the Services ID is grouped correctly and Phase E can
derive keys from <code>sub</code>. Different means it cannot.</p>

<div class="label">Services ID (client_id)</div>
<pre>${escapeHtml(SERVICES_ID)}</pre>
<div class="label">Redirect URI — must be registered on the Services ID</div>
<pre>${escapeHtml(redirectUri)}</pre>

<div id="appleid-signin" data-color="black" data-border="true" data-type="sign in"
     style="width:220px;height:44px"></div>
<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"></script>
<script>
  AppleID.auth.init({
    clientId: ${JSON.stringify(SERVICES_ID)},
    scope: 'name email',
    redirectURI: ${JSON.stringify(redirectUri)},
    usePopup: false
  });
</script>`);
    });

    router.post('/apple-probe', async (ctx: Koa.Context) => {
        let raw = '';
        try {
            raw = await readRawBody(ctx.req);
        } catch {
            ctx.status = 413;
            ctx.body = 'callback body too large';
            return;
        }

        const form = new URLSearchParams(raw);
        const idToken = form.get('id_token');
        const err = form.get('error');

        if (err) {
            ctx.type = 'html';
            ctx.body = page('Apple probe — error', `<h1>Apple returned an error</h1>
<pre>${escapeHtml(err)}</pre>`);
            return;
        }
        if (!idToken) {
            ctx.type = 'html';
            ctx.body = page('Apple probe — no token', `<h1>No <code>id_token</code> in the callback</h1>
<p class="sub">Fields Apple sent: <code>${escapeHtml([...form.keys()].join(', ') || '(none)')}</code></p>`);
            return;
        }

        const claims = decodeJwtPayload(idToken);
        if (!claims) {
            ctx.type = 'html';
            ctx.body = page('Apple probe — undecodable', `<h1>Could not decode the token</h1>`);
            return;
        }

        // Deliberately not logged. The sub is the thing under test; putting it in node logs
        // spreads an identifier further than a throwaway diagnostic needs to.
        ctx.type = 'html';
        ctx.body = page('Apple probe — web sub', `
<h1>Web <code>sub</code></h1>
<p class="sub">Compare this against the value the phone shows.</p>
<div class="sub-value">${escapeHtml(String(claims.sub ?? '(absent)'))}</div>
<div class="label">Audience (should be the Services ID)</div>
<pre>${escapeHtml(String(claims.aud ?? '(absent)'))}</pre>
<div class="label">All claims</div>
<pre>${escapeHtml(JSON.stringify(claims, null, 2))}</pre>`);
    });

    return router;
}
