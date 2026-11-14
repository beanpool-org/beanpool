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
import { sendSignedAt, signedFetchAt } from './api';
import { refuseIfNodeTooOld } from './node-version-gate';
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

/** The phone's "Turn on notifications?" words, word for word (apps/native utils/notification-permission.ts), for a member's tap. */
export const NOTIFICATION_CARD_WORDS = {
    title: word('Turn on notifications?'),
    body: word('So you hear when someone answers you, messages you, or asks to join. Nothing else.'),
    turnOn: word('Turn on'),
    notNow: word('Not now'),
} as const;

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
    if (/Chrom(e|ium)\//.test(env.userAgent)) return { kind: 'ok', device: 'computer', browser: 'Chrome' };
    // Every Chromium browser says Safari/ too: Safari itself says Version/ and no Chromium, Edge or Firefox.
    if (/\bVersion\/[\d.]+.*\bSafari\//.test(env.userAgent) && !/Chrom|CriOS|FxiOS|Edg/.test(env.userAgent)) return { kind: 'ok', device: 'safari' };
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

/**
 * What this browser keeps for a key at a community. `for` is the tap that made it: `asker`, Tell me on the waiting page (the
 * yes, nothing else); `member`, a member's Turn on (every kind their phone is told). Only a member's pin is given again at
 * each open and reads On in Settings: a Tell me kept after the key joined never becomes the member's notifications without
 * a tap on Turn on.
 */
export interface WebPushPin { origin: string; publicKey: string; subId: string; pushKey: string | null; vapidKey: string; for: 'asker' | 'member' }

/** Whether this pin is a member's own Turn on (anything else, a Tell me's included, is not). */
export function isMemberPin(pin: WebPushPin | null): boolean {
    return pin?.for === 'member';
}

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
    return subscribeAtTap(origin, identity, lang, env, 'asker');
}

/**
 * The tap on Turn on (a member: the "Turn on notifications?" card, or Settings → Notifications' row; web push W2): the same
 * steps as Tell me, and the node keeps this browser as the member's, told every kind their phone is. Never throws.
 */
export async function turnOnWebPush(origin: string, identity: BeanPoolIdentity, lang: string, env: PushEnv = pushEnv()): Promise<TellMeResult> {
    return subscribeAtTap(origin, identity, lang, env, 'member');
}

async function subscribeAtTap(origin: string, identity: BeanPoolIdentity, lang: string, env: PushEnv, made: WebPushPin['for']): Promise<TellMeResult> {
    const place = pushPlace(env);
    if (place.kind === 'home-screen' || place.kind === 'none') return { ok: false, place, reason: 'cannot' };
    if (place.kind === 'blocked') return { ok: false, place, reason: 'blocked' };
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'denied') return { ok: false, place: { kind: 'blocked', phone: place.device === 'phone' }, reason: 'blocked' };
        if (permission !== 'granted') return { ok: false, place, reason: 'dismissed' };
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
        // The key read goes past api.ts, so it asks the version first, as the signed post after it does (lib/node-version-gate.ts).
        const keySignal = AbortSignal.timeout(TIMEOUT_MS);
        await refuseIfNodeTooOld(origin, keySignal);
        const keyRes = await fetch(`${origin}${WEB_PUSH_KEY_PATH}`, { cache: 'no-store', signal: keySignal });
        const vapidKey = keyRes.ok ? (await keyRes.json())?.vapidKey : null;
        if (typeof vapidKey !== 'string') return { ok: false, place, reason: 'failed' };
        // Not navigator.serviceWorker.ready: that waits for a worker over THIS page, and /app is outside the scope /app/.
        const ready = await activated(registration);
        let subscription = await ready.pushManager.getSubscription();
        // A subscription to another key (the community's key changed) can't be told by this one: it goes first.
        const current = subscription?.options?.applicationServerKey;
        if (subscription && current && base64url(new Uint8Array(current)) !== vapidKey) {
            await subscription.unsubscribe().catch(() => false);
            subscription = null;
        }
        subscription ??= await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64url(vapidKey) as BufferSource });
        return (await postSubscription(origin, identity, subscription, lang, vapidKey, made)) ? { ok: true, place } : { ok: false, place, reason: 'failed' };
    } catch {
        return { ok: false, place, reason: 'failed' };
    }
}

/** Gives the node this browser's subscription, signed; pins its answer's notice key, and which tap it was for. Whether the node kept it. */
async function postSubscription(origin: string, identity: BeanPoolIdentity, subscription: PushSubscription, lang: string, vapidKey: string, made: WebPushPin['for']): Promise<boolean> {
    const json = subscription.toJSON();
    const body = JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys }, lang });
    const res = await signedFetchAt('POST', origin, WEB_PUSH_PATH, body, identity);
    const answer = res.ok ? await res.json().catch(() => null) : null;
    if (!answer?.success || typeof answer.subId !== 'string') return false;
    writeWebPushPin({
        origin, publicKey: identity.publicKey, subId: answer.subId, pushKey: typeof answer.pushKey === 'string' ? answer.pushKey : null,
        vapidKey: typeof answer.vapidKey === 'string' ? answer.vapidKey : vapidKey, for: made,
    });
    return true;
}

/** This browser's push subscription at the worker's scope, if a worker was ever registered here; never registers one. */
async function currentSubscription(): Promise<PushSubscription | null> {
    try {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
        const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
        return (await registration?.pushManager?.getSubscription()) ?? null;
    } catch {
        return null;
    }
}

/**
 * Turn off (Settings), and sign-out or delete-everything (before the key goes): the node lets go of this browser, signed
 * while the key is still here, and the browser's own subscription ends, so nothing more can arrive. At most
 * STOP_WAIT_MS: a sign-out never waits long on a slow node (which lets the row go itself once the key is no member).
 * Never throws.
 */
const STOP_WAIT_MS = 5_000;
export async function turnOffWebPush(origin: string, identity: BeanPoolIdentity): Promise<void> {
    const pin = readWebPushPin(origin, identity.publicKey);
    const work = (async () => {
        if (pin) await signedFetchAt('DELETE', origin, WEB_PUSH_PATH, JSON.stringify({ subId: pin.subId }), identity).catch(() => null);
        const subscription = await currentSubscription();
        await subscription?.unsubscribe().catch(() => false);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, STOP_WAIT_MS); })]).catch(() => {});
    clearTimeout(timer);
    forgetWebPushPin(origin, identity.publicKey);
}

/**
 * Settings points the web app at another community's address (Save & Connect, Reset; web push W2 r3): the community it
 * talked to lets go of this browser, and the tap waits on nothing from that community. `origin` is the OLD one, read before
 * the address changed, so the DELETE is signed for that host and sent there. The pin goes at once. The DELETE leaves with
 * keepalive (lib/api.ts sendSignedAt), so the reload that follows doesn't cut it, and its answer is never awaited. The
 * browser's subscription ends too, so the old community can tell this browser nothing more even if the DELETE never gets
 * there. Resolves once both are on their way, or after LET_GO_WAIT_MS (a server version not heard yet, a slow browser);
 * with no pin there, at once and with nothing sent. Never throws.
 */
export const LET_GO_WAIT_MS = 1_000;
export async function letGoOfWebPushAt(origin: string, identity: BeanPoolIdentity): Promise<void> {
    const pin = readWebPushPin(origin, identity.publicKey);
    if (!pin) return;
    forgetWebPushPin(origin, identity.publicKey);
    const work = Promise.allSettled([
        sendSignedAt('DELETE', origin, WEB_PUSH_PATH, JSON.stringify({ subId: pin.subId }), identity),
        currentSubscription().then(subscription => subscription?.unsubscribe()),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, LET_GO_WAIT_MS); })]);
    clearTimeout(timer);
}

/** What Settings → Notifications says for this browser (design §2.3): on, off, or blocked by the browser; or no push here. */
export type WebPushState = 'on' | 'off' | 'blocked' | 'cannot';

export function webPushState(origin: string | null, publicKey: string, env: PushEnv = pushEnv()): WebPushState {
    if (!origin) return 'cannot';
    const place = pushPlace(env);
    if (place.kind === 'blocked') return 'blocked';
    if (place.kind !== 'ok') return 'cannot';
    // A Tell me kept from before the key joined is no Turn on: Off, and Turn on asks for the member's notifications.
    return env.permission === 'granted' && isMemberPin(readWebPushPin(origin, publicKey)) ? 'on' : 'off';
}

/**
 * The community this browser's pushes come from, and its pin is kept under: the node the web app talks to (api.ts
 * `getNodeApiUrl`: the address set in Settings → Sovereign Node Connection, else this page's own), so the node that sends
 * is the one whose key the browser subscribed with and whose notice key a click is checked by. The worker is this page's
 * (public/sw.js): it shows what came and opens this page's /app, which talks to that same node. Null for an address that
 * is no web address: no push, the bell still works.
 */
export function webPushOrigin(nodeApiUrl: string): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const origin = new URL(nodeApiUrl || window.location.origin).origin;
        return /^https?:\/\//.test(origin) ? origin : null;
    } catch {
        return null;
    }
}

/**
 * Each time the web app opens for a member (web push W2), with nothing asked and no worker installed:
 * - turned on here before, and the browser now blocks or forgot the permission, or holds no subscription: the node lets go
 *   of this browser (DELETE) and the pin goes; Settings says Blocked or Off;
 * - turned on here and still allowed: the subscription is given again, signed, as the phone registers at every start, so
 *   the language is current and a community that took over from its main server has this browser again.
 * Only for a browser this account turned on here (a pin); never throws. Answers what it did.
 *
 * A Tell me from the waiting page, kept after the key joined (an `asker` pin), is never given again: that post would make
 * the community's row for it the member's (every kind), which only Turn on asks for. It still goes once the browser blocks
 * or forgets the permission.
 */
export async function keepWebPushAtOpen(origin: string, identity: BeanPoolIdentity, lang: string, env: PushEnv = pushEnv()): Promise<'none' | 'dropped' | 'kept' | 'failed'> {
    const pin = readWebPushPin(origin, identity.publicKey);
    if (!pin) return 'none';
    try {
        const subscription = env.permission === 'granted' ? await currentSubscription() : null;
        if (!subscription) {
            await turnOffWebPush(origin, identity);
            return 'dropped';
        }
        if (!isMemberPin(pin)) return 'none';
        return (await postSubscription(origin, identity, subscription, lang, pin.vapidKey, 'member')) ? 'kept' : 'failed';
    } catch {
        return 'failed';
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

/** The registration once its worker is active (a subscription needs one); at most WORKER_WAIT_MS. */
const WORKER_WAIT_MS = 10_000;
async function activated(registration: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
    const worker = registration.installing ?? registration.waiting;
    if (registration.active || !worker) return registration;
    await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, WORKER_WAIT_MS);
        const check = () => { if (worker.state === 'activated') { clearTimeout(timer); resolve(); } };
        worker.addEventListener('statechange', check);
        check();
    });
    return registration;
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
 * notice in the address, or one this community signed for this key that is only late (older than core's 7-day lifetime,
 * while the push itself lives up to 28 days) or from a clock that runs slow, which the phone's checkTap also lets pass
 * without a word: the page reads the status as it opens either way; `ok`: the community's own; `forged`: anything else,
 * which opens nothing and shows {@link FORGED_NOTICE_LINE} once.
 */
export function noticeInLocation(hash: string, publicKey: string, pushKey: string | null, now?: number): 'none' | 'ok' | 'forged' {
    const data = noticeInHash(hash);
    if (data === undefined) return 'none';
    const check = checkClickedNotice(data, publicKey, pushKey, now);
    if (check.kind === 'ok') return check.notice.kind === 'join.answered' ? 'ok' : 'forged';
    return check.kind;
}

/** The notice in an address's fragment (`#notice=`, public/sw.js), as it came: undefined with none, null when unreadable. */
export function noticeInHash(hash: string): unknown {
    const m = /(?:^#|&)notice=([^&]*)/.exec(hash);
    if (!m) return undefined;
    try {
        return JSON.parse(decodeURIComponent(m[1]));
    } catch {
        return null;
    }
}

/**
 * A click on a member's notice (web push W2), from the address's fragment or the worker's message: the phone's checkTap
 * (apps/native utils/push-notice-check.ts). Signed by the community key pinned when this browser was turned on, for this
 * account: `ok`, and the app reads where it lands from the node (GET /api/notices/push/:id) and goes there only through
 * its fixed table (components/NeedsYouIcons.tsx goToNoticeTarget). Anything else: `forged`, which opens nothing and shows
 * {@link FORGED_NOTICE_LINE} once. A notice this community signed for this key that is only late, or from a slow clock:
 * `none`, nothing opened and no warning, as the phone does. Nothing here trusts the worker, which only passes on what came.
 */
export function checkClickedNotice(data: unknown, publicKey: string, pushKey: string | null, now?: number):
    { kind: 'ok'; notice: { kind: string; id: string } } | { kind: 'none' } | { kind: 'forged' } {
    if (!pushKey || data === null || data === undefined) return { kind: 'forged' };
    const check = verifyPushNotice(data, { recipient: publicKey, pushKey, ...(now === undefined ? {} : { now }) });
    if (check.ok) return { kind: 'ok', notice: { kind: check.kind, id: check.id } };
    // Core checks the signature before the time: these two come only from a notice this community signed for this key.
    return check.reason === 'too-old' || check.reason === 'from-the-future' ? { kind: 'none' } : { kind: 'forged' };
}
