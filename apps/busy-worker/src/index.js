// The busy page for global.beanpool.org (BUSY-PAGE; Fable DESIGN-multicore-node-fable.md §6, step T5; Marty's yes 7 Nov 2026).
//
// A Cloudflare Worker on the route global.beanpool.org/*. Cloudflare's Free plan has no custom 5xx page, so when the
// global node is too busy to answer, a visitor's browser would wait on a spinner and then show Cloudflare's error page.
// This Worker answers a small page instead: the global community is very busy, and the visitor is taken on to beanpool.org
// (Cloudflare Pages, so it stays up whatever global does) in their language after 5 s, with a "Go now" link, a smaller "Try
// global again" link, and the note that an app already installed keeps working. The redirect is the page's own, so the
// status stays 503 and nothing here changes how a request is decided.
//
// It changes nothing for the members' apps. Only a browser asking for a page is ever answered here: a GET whose Accept
// names text/html, with no Upgrade, no Authorization, no signature header and no cookie of ours. Every other request
// (the API, signed requests, sockets, images and scripts, POSTs, HEAD) is handed to the origin exactly as it came, and the
// origin's answer is returned exactly as it came, even when that answer is an error.
//
// A page request goes to the origin with a 5 s limit on the wait for its headers. A 5xx answer (Cloudflare's own
// 520-530 included: the tunnel down, the origin refusing or timing out), an error, or no headers in 5 s, and the visitor
// gets the busy page (503, Retry-After: 120, no-store). Anything else is the origin's answer, unchanged.
//
// Two switches, as Worker variables (README "Switches"): BUSY_FORCE=1 answers the busy page to every page request without
// asking the origin; BUSY_OFF=1 hands every request to the origin untouched. BUSY_OFF wins when both are set.

import { busyPage } from './busy-page.js';

/** How long a page request waits for the origin's headers before the visitor gets the busy page. */
export const ORIGIN_TIMEOUT_MS = 5000;

/** Seconds a browser (or a crawler) is told to wait before asking again. */
export const RETRY_AFTER_S = 120;

/**
 * The headers a signed request carries (the node's own signature, apps/server/src: x-public-key, x-signature, x-timestamp,
 * x-nonce, x-signed-for; the registrar's x-bp-*). A request carrying any of them is never answered here.
 */
const SIGNATURE_HEADERS = ['x-public-key', 'x-signature', 'x-timestamp', 'x-nonce', 'x-signed-for', 'x-accept-signer'];
const SIGNATURE_PREFIX = 'x-bp-';

/**
 * Cloudflare's own cookies (bot checks, a solved challenge, load balancing, a waiting room). They are no session of ours,
 * and a visitor who passed an "Under Attack" challenge carries cf_clearance: ignoring these keeps the busy page working for
 * them. Any other cookie may be a session, and its request goes to the origin untouched.
 */
const CLOUDFLARE_COOKIE = /^(?:__cf|_cf|cf_)/i;

/** A Worker variable set to "1" (or "true"). */
export function isOn(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** True when a Cookie header holds any cookie that is not one of Cloudflare's own. */
export function hasOwnCookie(cookieHeader) {
    if (!cookieHeader) return false;
    return cookieHeader
        .split(';')
        .map((part) => part.trim().split('=')[0].trim())
        .some((name) => name !== '' && !CLOUDFLARE_COOKIE.test(name));
}

/** True when the request carries a signature header. */
export function isSigned(headers) {
    for (const [name] of headers) {
        const n = name.toLowerCase();
        if (n.startsWith(SIGNATURE_PREFIX) || SIGNATURE_HEADERS.includes(n)) return true;
    }
    return false;
}

/**
 * True only for a browser asking for a page: a GET that accepts text/html and carries nothing of a member's (no Upgrade,
 * no Authorization, no signature header, no cookie of ours). Everything else passes straight through.
 */
export function isPageRequest(request) {
    if (request.method !== 'GET') return false;
    const h = request.headers;
    if (!(h.get('accept') || '').toLowerCase().includes('text/html')) return false;
    if (h.has('upgrade') || h.has('sec-websocket-key')) return false;
    if (h.has('authorization')) return false;
    if (isSigned(h)) return false;
    if (hasOwnCookie(h.get('cookie'))) return false;
    return true;
}

/** True when the origin's answer means it could not serve the page: any 5xx, Cloudflare's 520-530 included. */
export function isOriginFailure(status) {
    return status >= 500 && status <= 599;
}

/** The Content-Security-Policy value allowing exactly one inline script: the one whose text is `script`, by its SHA-256. */
export async function pageCsp(script) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)));
    const hash = btoa(String.fromCharCode(...digest));
    // The page's own <style>, that one script, and its empty data: icon; nothing else loads, from anywhere.
    return `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/** The busy page as a Response: 503, Retry-After, never stored, and a policy that lets it load nothing but its own script. */
export async function busyResponse(request) {
    const { html, lang, script } = busyPage(request.headers.get('accept-language'), request.url);
    return new Response(html, {
        status: 503,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-language': lang,
            'retry-after': String(RETRY_AFTER_S),
            'cache-control': 'no-store',
            'content-security-policy': await pageCsp(script),
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'x-robots-tag': 'noindex',
            'x-beanpool-busy': '1',
        },
    });
}

/**
 * Asks the origin for a page, waiting at most `timeoutMs` for its headers. The timer stops once the headers arrive, so a
 * slow body is never cut off. Resolves to the origin's Response, or null on an error or the time running out.
 */
async function fetchWithin(fetchImpl, request, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, timeoutMs);
    });
    try {
        return await Promise.race([fetchImpl(request, { signal: controller.signal }), timeout]);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The Worker's whole decision. `fetchImpl` is the global fetch in the Worker and a fake in the tests.
 * @param {Request} request
 * @param {Record<string, string>} env
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function handle(request, env = {}, opts = {}) {
    // Called through a wrapper so the Worker's fetch never runs with a stray `this` ("Illegal invocation").
    const fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    const timeoutMs = opts.timeoutMs ?? ORIGIN_TIMEOUT_MS;

    // Off, or not a page request: the origin's answer, untouched (including its errors).
    if (isOn(env.BUSY_OFF) || !isPageRequest(request)) return fetchImpl(request);

    if (isOn(env.BUSY_FORCE)) return busyResponse(request);

    const response = await fetchWithin(fetchImpl, request, timeoutMs);
    if (response === null || isOriginFailure(response.status)) {
        // The origin's error body is never read: release it.
        if (response?.body) response.body.cancel().catch(() => {});
        return busyResponse(request);
    }
    return response;
}

export default {
    async fetch(request, env) {
        return handle(request, env);
    },
};
