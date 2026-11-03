/**
 * Lights-out: the owner's switch for the hall, and the hall's poster page (services/lights-out.ts; design
 * scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.6, §4; slice H1).
 *
 *   GET  /api/local/admin/lights-out    owner or admin          the switch as it stands (Settings' card)
 *   POST /api/local/admin/lights-out    owner, fresh proof      { on: true|false, address?, code? }: Settings' switch.
 *                                                               The fresh proof is admin-auth.ts requireFreshProof: the
 *                                                               phone's Manage within 90 s, or the admin password with a
 *                                                               current authenticator code (2FA off: refused, fails closed).
 *                                                               Never a token, a break-glass code or an admin.
 *   POST /api/node/owner/lights-out     owner, signed           { on: true|false, address? }: the phone's switch. The owner's
 *                                                               own signature on this very request, made in the last 90 s
 *                                                               (the fresh proof: tighter than the 5-minute window), bound
 *                                                               to the community's name (§2.3), once (the nonce).
 *   GET  /hall                          the hall Wi-Fi only     the poster (served by the plain listener, http-server.ts)
 *
 * On a standby every switch answers 403: take over first. The answers carry the switch as it stands
 * (services/lights-out.ts LightsOutStatus), with `standDown` when OFF follows a hall nobody wrote in (§3.6 case 2).
 */

import Router from '@koa/router';
import type Koa from 'koa';
import QRCode from 'qrcode';
import { brandCssVariableMap, timestampOfSignedText, word, WEB_INK_GROUNDS, type Lang } from '@beanpool/core';
import { requireAdminRole, requireFreshProof } from '../admin-auth.js';
import { FRESH_PROOF_WINDOW_MS } from '../admin-key-auth.js';
import { isNodeOwner } from '../engine/node-roles.js';
import { primaryAddress } from '../engine/own-addresses.js';
import { lightsOutStatus, setLightsOut, type LightsOutStatus } from '../services/lights-out.js';
import { readNodeIdentity } from '../services/takeover-envelope.js';
import { wordsIn } from '../member-words.js';
import { cardLanguage, escapeHtml, RTL } from './community-card.js';
import type { RouteDeps } from './types.js';

export const LIGHTS_OUT_ADMIN_PATH = '/api/local/admin/lights-out';
export const LIGHTS_OUT_OWNER_PATH = '/api/node/owner/lights-out';
export const HALL_PATH = '/hall';

const OWNER_ONLY = word('Only an owner can turn lights-out on or off.');

/** `on` must be a boolean: anything else is a 400, never read as off. */
function switchBody(body: unknown): { on: boolean; address: unknown; code: unknown } | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (typeof b.on !== 'boolean') return null;
    return { on: b.on, address: b.address, code: b.code };
}

function answerSwitch(ctx: Koa.Context, on: boolean, address: unknown, by: 'owner-key' | 'password', actor: string | null): void {
    const out = setLightsOut(on, { address, by, actor });
    ctx.set('Cache-Control', 'no-store');
    if (!out.ok) {
        ctx.status = out.status;
        ctx.body = { error: out.error };
        return;
    }
    ctx.body = { success: true, changed: out.changed, epochRaised: out.epochRaised, lightsOut: out.status };
}

export function createLightsOutRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    router.get(LIGHTS_OUT_ADMIN_PATH, async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner', 'admin'], 'Only an owner or an admin can see the lights-out switch.')) return;
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { lightsOut: lightsOutStatus() };
    });

    router.post(LIGHTS_OUT_ADMIN_PATH, async (ctx) => {
        if (!(await checkAdminAuth(ctx as any))) return;
        if (!requireAdminRole(ctx, ['owner'], OWNER_ONLY)) return;
        const body = switchBody((ctx as any).requestBody);
        if (!body) {
            ctx.status = 400;
            ctx.body = { error: 'Send { "on": true } or { "on": false }.' };
            return;
        }
        if (!(await requireFreshProof(ctx, body.code ?? ctx.get('x-fresh-proof'), body.on ? 'turn lights-out on' : 'turn lights-out off'))) return;
        const state = (ctx.state || {}) as Record<string, unknown>;
        const actor = typeof state.actor === 'string' ? state.actor : null;
        answerSwitch(ctx, body.on, body.address, state.isKeySession ? 'owner-key' : 'password', actor);
    });

    router.post(LIGHTS_OUT_OWNER_PATH, async (ctx) => {
        const authSig = (ctx.state as any)?.authSig as { signer?: string; payload?: string } | undefined;
        const signer = authSig?.signer;
        if (!signer) {
            ctx.status = 401;
            ctx.body = { error: word('Sign this request with your member key.') };
            return;
        }
        if (!isNodeOwner(signer)) {
            ctx.status = 403;
            ctx.body = { error: OWNER_ONLY };
            return;
        }
        // The fresh proof for a signed request: the owner's key signed THIS request in the last 90 seconds. The middleware
        // has already held it to the 5-minute window and spent its nonce.
        const signedAt = timestampOfSignedText(String(authSig?.payload ?? ''));
        const now = Date.now();
        if (!Number.isFinite(signedAt) || now - signedAt > FRESH_PROOF_WINDOW_MS || signedAt - now > FRESH_PROOF_WINDOW_MS) {
            ctx.status = 403;
            ctx.body = { error: word('Press Manage on your phone again, then turn lights-out on or off within 90 seconds.'), code: 'step_up_required' };
            return;
        }
        const body = switchBody((ctx as any).requestBody);
        if (!body) {
            ctx.status = 400;
            ctx.body = { error: word('Say whether to turn lights-out on or off.') };
            return;
        }
        answerSwitch(ctx, body.on, body.address, 'owner-key', signer);
    });

    return router;
}

// ── GET /hall: the poster (§2.6) ──────────────────────────────────────────────────────────────────────────────────

/** The hall page's words (design §2.6, §2.8, §2.9). H0 carries the poster's printed copy; these are the page's own. */
export const HALL_WORDS = {
    title: word('BeanPool in the hall'),
    noInternet: word('No internet. This laptop is your community for now.'),
    recordAsOf: word('The record is as of {when}. Trades made since then on the old server are not here.'),
    noRecordDate: word('The record is the one this laptop holds.'),
    line1: word('Turn on airplane mode, then turn Wi-Fi back on.'),
    line2: word('Join the hall Wi-Fi. If your phone asks to stay connected, say yes.'),
    line3: word('Open the BeanPool app and scan this code.'),
    line4: word('No scanner? In the app, enter this address: {address}'),
    readable: word('On the hall Wi-Fi, what you post and your balance can be read by others on the Wi-Fi. Your messages stay private.'),
    openApp: word('Open in the BeanPool app'),
    checkLaptop: word('This laptop\'s key ends in {key}. Compare it with the poster.'),
    closed: word('The hall is closed. Use {home}.'),
    closedNoHome: word('The hall is closed.'),
};

/** The hall door link the phone app opens (H2): beanpool://hall?at=<number:port>&for=<the community's name>&id=<key end>. */
export function hallDoorLink(address: string | null, forName: string | null, keyEnd: string | null): string | null {
    if (!address || !forName) return null;
    const at = address.replace(/^http:\/\//, '');
    const q = new URLSearchParams({ at, for: forName });
    if (keyEnd) q.set('id', keyEnd);
    return `beanpool://hall?${q.toString()}`;
}

/**
 * The slot the APK on the node (H3) fills: "Get the Android app" linking to /android, on the hall Wi-Fi only. Empty until
 * that slice sets it (setHallAndroidLink); H1 builds no APK serving.
 */
let hallAndroidLink: ((lang: Lang | null) => string) | null = null;
export function setHallAndroidLink(render: ((lang: Lang | null) => string) | null): void { hallAndroidLink = render; }

function shortKey(): string | null {
    try {
        const id = readNodeIdentity();
        return id?.peerId ? id.peerId.slice(-6) : null;
    } catch {
        return null;
    }
}

function whenIn(lang: Lang | null, iso: string): string {
    try {
        return new Date(iso).toLocaleString(lang ?? 'en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso;
    }
}

/** The page's colours from the central tokens (as the share page, peek.ts): the web app's grounds and the brand roles. */
function hallPageColours(): string {
    const GROUNDS = {
        light: { page: WEB_INK_GROUNDS.light[1], card: WEB_INK_GROUNDS.light[0] },
        dark: { page: WEB_INK_GROUNDS.dark[0], card: WEB_INK_GROUNDS.dark[1] },
    } as const;
    const roles = ['--bp-commit-fill', '--bp-commit-on', '--bp-ink-info', '--bp-chip-warn-tint', '--bp-chip-warn-ink', '--bp-chip-accent-border'];
    const vars = (theme: 'light' | 'dark') => {
        const map = brandCssVariableMap(theme);
        const { page, card } = GROUNDS[theme];
        const ink = theme === 'light' ? GROUNDS.dark.page : GROUNDS.light.card;
        return [`--page:${page}`, `--card:${card}`, `--ink:${ink}`, ...roles.map((r) => `${r}:${map[r]}`)].join(';');
    };
    return `:root{${vars('light')};color-scheme:light dark}\n@media (prefers-color-scheme:dark){:root{${vars('dark')}}}`;
}

/** The page's HTML. Light and dark from the system's own setting; readable at 320 px and 130% text. */
export async function renderHallPage(status: LightsOutStatus, lang: Lang | null): Promise<string> {
    const w = wordsIn(lang);
    const e = escapeHtml;
    const l = lang ?? 'en';
    const head = (title: string) => `<!DOCTYPE html>
<html lang="${e(l)}"${RTL.has(l) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)}</title>
<style>
${hallPageColours()}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font-family: system-ui, sans-serif; font-size: 1rem; line-height: 1.45; }
main { max-width: 34rem; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.5rem; margin: 0.5rem 0 1rem; }
.notice { background: var(--bp-chip-warn-tint); color: var(--bp-chip-warn-ink); border-radius: 10px; padding: 12px 14px; margin-bottom: 1rem; }
.address { font-size: 2rem; font-weight: 700; word-break: break-all; margin: 0.25rem 0 1rem; }
ol { padding-inline-start: 1.4rem; margin: 0 0 1rem; }
li { margin-bottom: 0.5rem; }
.qr { display: block; width: min(100%, 260px); height: auto; margin: 0 auto 1rem; background: #fff; padding: 8px; border-radius: 8px; }
a.door { display: block; text-align: center; background: var(--bp-commit-fill); color: var(--bp-commit-on); text-decoration: none; font-weight: 600; padding: 12px 16px; border-radius: 10px; margin: 0 0 1rem; }
.small { color: var(--bp-ink-info); font-size: 0.9rem; }
.card { background: var(--card); border: 1px solid var(--bp-chip-accent-border); border-radius: 12px; padding: 14px; margin-bottom: 1rem; }
</style>
</head>
<body><main>`;
    if (!status.on) {
        const home = status.home ? status.home.replace(/^https:\/\//, '') : null;
        return `${head(w.t(HALL_WORDS.title))}
<h1>${e(w.t(HALL_WORDS.title))}</h1>
<p class="card" data-hall="closed">${e(home ? w.t(HALL_WORDS.closed, { home }) : w.t(HALL_WORDS.closedNoHome))}</p>
</main></body></html>`;
    }
    const forName = primaryAddress();
    const key = shortKey();
    const door = hallDoorLink(status.address, forName, key);
    const qr = door ? await QRCode.toDataURL(door, { width: 260, margin: 1 }) : null;
    const shown = status.address ? status.address.replace(/^http:\/\//, '') : null;
    const android = hallAndroidLink ? hallAndroidLink(lang) : '';
    return `${head(w.t(HALL_WORDS.title))}
<h1>${e(w.t(HALL_WORDS.title))}</h1>
<div class="notice" data-hall="record"><p style="margin:0">${e(w.t(HALL_WORDS.noInternet))}</p>
<p style="margin:0.25rem 0 0">${e(status.recordAsOf ? w.t(HALL_WORDS.recordAsOf, { when: whenIn(lang, status.recordAsOf) }) : w.t(HALL_WORDS.noRecordDate))}</p></div>
${shown ? `<p class="address" data-hall="address">${e(shown)}</p>` : ''}
<ol data-hall="lines">
<li>${e(w.t(HALL_WORDS.line1))}</li>
<li>${e(w.t(HALL_WORDS.line2))}</li>
<li>${e(w.t(HALL_WORDS.line3))}</li>
${shown ? `<li>${e(w.t(HALL_WORDS.line4, { address: shown }))}</li>` : ''}
</ol>
${qr ? `<img class="qr" src="${qr}" alt="${e(w.t(HALL_WORDS.line3))}" width="260" height="260">` : ''}
${door ? `<a class="door" data-hall="door" href="${e(door)}">${e(w.t(HALL_WORDS.openApp))}</a>` : ''}
<!-- hall-android-slot: the APK on the node (H3) fills this, on the hall Wi-Fi only -->${android}
<p class="small" data-hall="readable">${e(w.t(HALL_WORDS.readable))}</p>
${key ? `<p class="small" data-hall="key">${e(w.t(HALL_WORDS.checkLaptop, { key }))}</p>` : ''}
</main></body></html>`;
}

/** The plain listener's GET /hall (http-server.ts): the poster, to the hall Wi-Fi only (the caller checks), never cached. */
export async function serveHallPage(ctx: Koa.Context): Promise<void> {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('X-Robots-Tag', 'noindex');
    ctx.type = 'html';
    ctx.body = await renderHallPage(lightsOutStatus(), cardLanguage(ctx));
}
