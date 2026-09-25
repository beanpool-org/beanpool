/**
 * Sign in with Apple's return to the web app (design G11 §3.2, §3.6 change 2).
 *
 *   POST /app/auth/apple   application/x-www-form-urlencoded: state, id_token | error, code, user
 *   → 303 See Other, Location: /app/auth/apple#state=<state>&id_token=<token>   (or #state=<state>&error=<error>)
 *
 * A browser signing in with Apple leaves the page for appleid.apple.com with `response_mode=form_post`, and Apple's
 * page sends the answer back as a form the browser POSTs here. This route turns that POST into a GET of the web app's
 * return page with the answer in the fragment, so the page reads it exactly as it reads Google's, and the token never
 * sits in a request line, a server log or a Referer: a fragment is never sent to a server, and the 303 is
 * `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
 *
 * Nothing here verifies anything. The token is checked where it is spent (POST /api/join, sso.ts), against the nonce
 * the node issued to the joiner's key; the page refuses a `state` it did not send. This route only moves the answer
 * from a POST body to the page, so it stays that small:
 *   - it forwards `state`, and `error` if Apple sent one, else `id_token`, each only when it is in the character set
 *     it can have (a nonce, a JWT, an OAuth error code), and `error=invalid_response` in place of anything else;
 *   - it drops `code` (exchanging it needs a client secret, which no node has) and `user` (the door asks no scope,
 *     so no name or email);
 *   - it renders no HTML and logs nothing from the body.
 *
 * Not under /api/, so the signature middleware lets it through (https-server.ts): Apple's page makes the browser
 * send it, and nothing on that page can sign. The server's body parser reads JSON only, so the form is read here,
 * capped at 16 KB like apple-probe.ts's (Apple's answer is a few KB).
 *
 * Open only where the door is: 404 unless the profile's `openJoin` is on (routes/open-join.ts), read per request.
 */

import Router from '@koa/router';
import type Koa from 'koa';
import { getProfileSwitches } from '../config/node-profile.js';

export const APPLE_RETURN_PATH = '/app/auth/apple';

/** Apple's form is a few KB; anything larger is not from Apple. */
const MAX_RETURN_BYTES = 16 * 1024;

/** The node's nonce, which the web app sends as `state`: base64url, 43 characters. */
const STATE = /^[A-Za-z0-9_-]{1,128}$/;
/** A JWT: three base64url segments. */
const ID_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** An OAuth error code, e.g. `user_cancelled_authorize`. */
const ERROR = /^[A-Za-z0-9_.-]{1,64}$/;

class ReturnTooLargeError extends Error {}

/** The request body as text, refused past the cap. Paused rather than destroyed, so the 413 still reaches the browser. */
function readForm(req: Koa.Context['req']): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let refused = false;
        req.on('data', (chunk: Buffer) => {
            if (refused) return;
            total += chunk.length;
            if (total > MAX_RETURN_BYTES) {
                refused = true;
                req.pause();
                reject(new ReturnTooLargeError());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** The fragment the web app's return page reads: `state`, then `error` or `id_token`. */
export function appleReturnFragment(form: URLSearchParams): string {
    const fields: string[] = [];
    const state = form.get('state');
    if (state !== null && STATE.test(state)) fields.push(`state=${encodeURIComponent(state)}`);
    const error = form.get('error');
    const idToken = form.get('id_token');
    if (error !== null) {
        fields.push(`error=${encodeURIComponent(ERROR.test(error) ? error : 'invalid_response')}`);
    } else if (idToken !== null && ID_TOKEN.test(idToken)) {
        fields.push(`id_token=${encodeURIComponent(idToken)}`);
    } else {
        fields.push('error=invalid_response');
    }
    return fields.join('&');
}

export function createAppleReturnRoutes(): Router {
    const router = new Router();

    router.post(APPLE_RETURN_PATH, async (ctx) => {
        if (!getProfileSwitches().openJoin) {
            ctx.status = 404;
            return;
        }
        if (!ctx.is('application/x-www-form-urlencoded')) {
            ctx.status = 415;
            ctx.body = 'Expected a form.';
            return;
        }
        const declared = Number(ctx.get('content-length'));
        if (Number.isFinite(declared) && declared > MAX_RETURN_BYTES) {
            ctx.status = 413;
            ctx.body = 'Too large.';
            return;
        }
        let raw: string;
        try {
            raw = await readForm(ctx.req);
        } catch (e) {
            if (!(e instanceof ReturnTooLargeError)) throw e;
            ctx.status = 413;
            ctx.body = 'Too large.';
            return;
        }

        ctx.status = 303;
        ctx.set('Location', `${APPLE_RETURN_PATH}#${appleReturnFragment(new URLSearchParams(raw))}`);
        ctx.set('Cache-Control', 'no-store');
        ctx.set('Referrer-Policy', 'no-referrer');
    });

    return router;
}
