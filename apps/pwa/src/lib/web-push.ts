/**
 * "Tell me when they answer" on the waiting page (scratch/fable-design/DESIGN-web-notifications-fable.md §2.2-§2.4, slice
 * W1): web push from the community's own server, with its own key, to a browser that asked to join.
 *
 * Asked only at the tap, with the reason first (memory permissions-only-when-asked): nothing here runs on load. The tap
 * registers the one service worker (public/sw.js, scope /app/), asks the browser, subscribes with the community's key
 * (GET /api/web-push/key) and posts the subscription, signed by the key that asked (lib/api.ts signedFetchAt, the one file
 * that signs). The answer's `pushKey` is pinned with the request, so a click can tell a notice the community signed for
 * this key from a forgery ({@link noticeInLocation}).
 *
 * Where push can't work, the tap says so in plain words, found by feature tests, never by the browser's name where a test
 * exists ({@link pushPlace}): an iPhone outside the Home Screen, a browser with no push, a private window, a page reached
 * over http, notifications blocked. The waiting page's own 5-minute check and the 30-day invite carry the yes either way.
 */
import { t, verifyPushNotice, word } from '@beanpool/core';
import { signedFetchAt } from './api';
import type { BeanPoolIdentity } from './identity';
import { APP_STORE_URL, PLAY_URL } from './peek';

export const WEB_PUSH_PATH = '/api/web-push';
export const WEB_PUSH_KEY_PATH = '/api/web-push/key';
export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/app/';
const STORE_KEY = 'beanpool_web_push';

export const TELL_ME_WORDS = {
    title: word('Tell me when they answer'),
    line: word("We'll tell you on this device when {name} answers, even with this page closed. Nothing else."),
    button: word('Tell me'),
    asking: word('Asking your browser…'),
    granted: word("✓ We'll tell you here when {name} answers."),
    whileRunning: word("We'll tell you here while {browser} is running."),
    safari: word("We'll tell you here, even with Safari closed."),
    phone: word("We'll tell you on this phone, even with the browser closed."),
    homeScreen: word('On an iPhone, notifications only work from the Home Screen. Tap Share, then Add to Home Screen, open BeanPool from there and tap Tell me again.'),
    cannot: word("Notifications can't reach this browser. Come back to this page: it checks every few minutes while open, and a yes keeps for 30 days."),
    blocked: word('Your browser blocked them for this site: allow them from the icon by the address.'),
    failed: word("This community couldn't take the request to tell you. Come back to this page: it checks every few minutes while open."),
    /** What a click on a notice the browser can't trust shows, once: the phone's own sentence (apps/native utils/push-notice-check.ts). */
    forged: word("That notification didn't come from your community. Ignore what it said. BeanPool never asks for your 12 words or a password in a notification."),
} as const;

export const FORGED_NOTICE_LINE = TELL_ME_WORDS.forged;

/** Where this browser stands for push, by feature tests in the design's order (§2.4). */
export type PushPlace =
    /** Push works: a computer's Chrome, Edge, Firefox or Brave, which deliver while the browser runs. */
    | { kind: 'ok'; device: 'computer'; browser: string }
    /** Safari on a Mac: Apple's service delivers with Safari closed. */
    | { kind: 'ok'; device: 'safari' }
    /** A phone's browser, or BeanPool opened from an iPhone's Home Screen. */
    | { kind: 'ok'; device: 'phone' }
    /** An iPhone or iPad in Safari, iOS 16.4 or later: only a Home Screen app gets push. */
    | { kind: 'home-screen' }
    /** No push here: an older iPhone, a private window, http, no PushManager. */
    | { kind: 'none'; phone: boolean }
    /** The browser blocked notifications for this site. */
    | { kind: 'blocked'; phone: boolean };

export interface PushEnv {
    userAgent: string;
    maxTouchPoints: number;
    secure: boolean;
    serviceWorker: boolean;
    pushManager: boolean;
    notification: boolean;
    permission: string | null;
    standalone: boolean;
    brave: boolean;
}

/** This browser's own answers to the feature tests. */
export function pushEnv(): PushEnv {
    const nav = navigator as Navigator & { standalone?: boolean; brave?: unknown };
    let standalone = nav.standalone === true;
    try { standalone ||= window.matchMedia('(display-mode: standalone)').matches; } catch { /* no matchMedia: not standalone */ }
    const notification = typeof window !== 'undefined' && 'Notification' in window;
    return {
        userAgent: nav.userAgent ?? '',
        maxTouchPoints: nav.maxTouchPoints ?? 0,
        secure: typeof window !== 'undefined' && window.isSecureContext === true,
        serviceWorker: 'serviceWorker' in nav,
        pushManager: typeof window !== 'undefined' && 'PushManager' in window,
        notification,
        permission: notification ? Notification.permission : null,
        standalone,
        brave: !!nav.brave,
    };
}

function iosVersion(ua: string): number | null {
    const m = /\bOS (\d+)[_.](\d+)/.exec(ua);
    return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}

/** The feature tests (design §2.4): push primitives and a secure page first, then an iPhone outside the Home Screen, then permission. */
export function pushPlace(env: PushEnv = pushEnv()): PushPlace {
    const ios = /\b(iPhone|iPad|iPod)\b/.test(env.userAgent) || (/\bMacintosh\b/.test(env.userAgent) && env.maxTouchPoints > 1);
    const phone = ios || /\bAndroid\b/.test(env.userAgent);
    const primitives = env.serviceWorker && env.pushManager && env.notification && env.secure;
    // Safari on an iPhone exposes no PushManager outside a Home Screen app, so this comes before the primitives' answer.
    if (ios && !env.standalone && (iosVersion(env.userAgent) ?? 0) >= 16.4) return { kind: 'home-screen' };
    if (!primitives) return { kind: 'none', phone };
    if (env.permission === 'denied') return { kind: 'blocked', phone };
    if (phone) return { kind: 'ok', device: 'phone' };
    // Only for the words: which browser has to keep running. Chrome-like browsers say Chrome in their user agent too.
    if (/\bEdg\//.test(env.userAgent)) return { kind: 'ok', device: 'computer', browser: 'Edge' };
    if (/\bFirefox\//.test(env.userAgent)) return { kind: 'ok', device: 'computer', browser: 'Firefox' };
    if (env.brave) return { kind: 'ok', device: 'computer', browser: 'Brave' };
    if (/\bChrom(e|ium)\//.test(env.userAgent)) return { kind: 'ok', device: 'computer', browser: 'Chrome' };
    if (/\bSafari\//.test(env.userAgent)) return { kind: 'ok', device: 'safari' };
    return { kind: 'ok', device: 'computer', browser: t('your browser') };
}

/** The line under ✓ once this browser is subscribed: how long it can be told (design §2.4). */
export function grantedLine(place: PushPlace): string {
    if (place.kind !== 'ok') return '';
    if (place.device === 'phone') return t(TELL_ME_WORDS.phone);
    if (place.device === 'safari') return t(TELL_ME_WORDS.safari);
    return t(TELL_ME_WORDS.whileRunning, { browser: place.browser });
}

/** What the card says where push can't work, and whether the app's store link goes above it (a phone: Decision 3). */
export function cannotLines(place: PushPlace): { lines: string[]; getApp: string | null } {
    const appFor = (ua: string) => (/\bAndroid\b/.test(ua) ? PLAY_URL : APP_STORE_URL);
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    if (place.kind === 'home-screen') return { lines: [t(TELL_ME_WORDS.homeScreen)], getApp: APP_STORE_URL };
    if (place.kind === 'none') return { lines: [t(TELL_ME_WORDS.cannot)], getApp: place.phone ? appFor(ua) : null };
    if (place.kind === 'blocked') return { lines: [t(TELL_ME_WORDS.blocked), t(TELL_ME_WORDS.cannot)], getApp: place.phone ? appFor(ua) : null };
    return { lines: [], getApp: null };
}

// ── What this browser keeps: the subscription's id and the community's notice key, with the request ──────────────

export interface WebPushPin { origin: string; publicKey: string; subId: string; pushKey: string | null; vapidKey: string }

export function readWebPushPin(origin: string, publicKey: string): WebPushPin | null {
    try {
        const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as WebPushPin[];
        return Array.isArray(all) ? all.find(p => p.origin === origin && p.publicKey === publicKey) ?? null : null;
    } catch {
        return null;
    }
}

function writeWebPushPin(pin: WebPushPin): void {
    try {
        const all = (JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as WebPushPin[]).filter(p => !(p.origin === pin.origin && p.publicKey === pin.publicKey));
        localStorage.setItem(STORE_KEY, JSON.stringify([...all, pin].slice(-10)));
    } catch { /* not kept: the card asks again next time */ }
}

export function forgetWebPushPin(origin: string, publicKey: string): void {
    try {
        const all = (JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as WebPushPin[]).filter(p => !(p.origin === origin && p.publicKey === publicKey));
        localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* nothing kept */ }
}

// ── The tap ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TellMeResult =
    | { ok: true; place: PushPlace }
    | { ok: false; place: PushPlace; reason: 'cannot' | 'blocked' | 'dismissed' | 'failed' };

const TIMEOUT_MS = 20_000;

/**
 * The tap on Tell me. Everything that touches the browser's push happens here and only here: the worker's registration,
 * the permission prompt, the subscription. Never throws.
 */
export async function tellMeWhenTheyAnswer(origin: string, identity: BeanPoolIdentity, lang: string, env: PushEnv = pushEnv()): Promise<TellMeResult> {
    const place = pushPlace(env);
    if (place.kind === 'home-screen' || place.kind === 'none') return { ok: false, place, reason: 'cannot' };
    if (place.kind === 'blocked') return { ok: false, place, reason: 'blocked' };
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'denied') return { ok: false, place: { kind: 'blocked', phone: place.device === 'phone' }, reason: 'blocked' };
        if (permission !== 'granted') return { ok: false, place, reason: 'dismissed' };
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
        const keyRes = await fetch(`${origin}${WEB_PUSH_KEY_PATH}`, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
        const vapidKey = keyRes.ok ? (await keyRes.json())?.vapidKey : null;
        if (typeof vapidKey !== 'string') return { ok: false, place, reason: 'failed' };
        const ready = await navigator.serviceWorker.ready.catch(() => registration);
        let subscription = await ready.pushManager.getSubscription();
        // A subscription to another key (the community's key changed) can't be told by this one: it goes first.
        const current = subscription?.options?.applicationServerKey;
        if (subscription && current && base64url(new Uint8Array(current)) !== vapidKey) {
            await subscription.unsubscribe().catch(() => false);
            subscription = null;
        }
        subscription ??= await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(vapidKey) as BufferSource });
        const json = subscription.toJSON();
        const body = JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys }, lang });
        const res = await signedFetchAt('POST', origin, WEB_PUSH_PATH, body, identity);
        const answer = res.ok ? await res.json().catch(() => null) : null;
        if (!answer?.success || typeof answer.subId !== 'string') return { ok: false, place, reason: 'failed' };
        writeWebPushPin({ origin, publicKey: identity.publicKey, subId: answer.subId, pushKey: typeof answer.pushKey === 'string' ? answer.pushKey : null, vapidKey });
        return { ok: true, place };
    } catch {
        return { ok: false, place, reason: 'failed' };
    }
}

/** The request is forgotten in this browser: the community lets go of the browser too, signed while the key is still here. */
export async function stopTellingMe(origin: string, identity: BeanPoolIdentity): Promise<void> {
    const pin = readWebPushPin(origin, identity.publicKey);
    if (!pin) return;
    try {
        await signedFetchAt('DELETE', origin, WEB_PUSH_PATH, JSON.stringify({ subId: pin.subId }), identity);
    } catch { /* the community lets it go when the request closes */ }
    forgetWebPushPin(origin, identity.publicKey);
}

function base64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, c => c.charCodeAt(0));
}

// ── A click on a notice ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The notice a click brought (public/sw.js puts it in the address's fragment, `#notice=`), checked as the phone's checkTap
 * checks one: signed by the community key pinned at the tap, for this key, recent, and a `join.answered`. `none`: no
 * notice in the address; `ok`: the community's own; `forged`: anything else, which opens nothing and shows
 * {@link FORGED_NOTICE_LINE} once.
 */
export function noticeInLocation(hash: string, publicKey: string, pushKey: string | null, now?: number): 'none' | 'ok' | 'forged' {
    const m = /(?:^#|&)notice=([^&]*)/.exec(hash);
    if (!m) return 'none';
    let data: unknown;
    try {
        data = JSON.parse(decodeURIComponent(m[1]));
    } catch {
        return 'forged';
    }
    if (!pushKey) return 'forged';
    const check = verifyPushNotice(data, { recipient: publicKey, pushKey, ...(now === undefined ? {} : { now }) });
    return check.ok && check.kind === 'join.answered' ? 'ok' : 'forged';
}
