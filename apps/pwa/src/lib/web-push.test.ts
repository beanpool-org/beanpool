/**
 * "Tell me when they answer" (DESIGN-web-notifications-fable.md §2.2-§2.4, slice W1): the service worker as it ships
 * (public/sw.js, run in a sandbox with a fake worker scope), and lib/web-push.ts's feature tests, words, notice check and tap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pushCommunityTag, pushNoticeBytes, PUSH_NOTICE_KINDS } from '@beanpool/core';
import {
    pushPlace, grantedLine, cannotLines, noticeInLocation, tellMeWhenTheyAnswer, readWebPushPin, FORGED_NOTICE_LINE, type PushEnv,
    knockScope, tellMeAtHome, stopTellingMeAtHome, stopEveryTellMeAtHome,
} from './web-push';
import { knockLandingFor, takeKnockLanding } from './knock-landing';
import { APP_STORE_URL, PLAY_URL } from './peek';
import { sendSignedAt, signedFetchAt } from './api';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from './node-version-gate';

vi.mock('./api', () => ({ signedFetchAt: vi.fn(), sendSignedAt: vi.fn(async () => {}) }));

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

/** An open tab, as the worker sees it: only one under its scope /app/, loaded since it took over, is controlled. */
interface Tab { url: string; controlled: boolean }

/**
 * public/sw.js in a sandbox: its listeners, and what it asked of the browser. The browser's rules are kept, not mocked
 * away (and e2e/sw-click-check.mjs checks them in Chromium): matchAll gives only controlled tabs unless asked for the
 * others; navigate() fails on a tab the worker doesn't control; a click allows ONE window call, which focus() and
 * openWindow() each spend ("Not allowed to open a window." after a focus).
 */
function loadWorker(scope = 'https://node.example/app/') {
    const listeners: Record<string, (e: any) => void> = {};
    const shown: { title: string; options: any }[] = [];
    const opened: string[] = [];
    const navigated: string[] = [];
    const focused: string[] = [];
    let unregistered = 0;
    let tabs: Tab[] = [];
    let allowance = 0;
    const spend = (what: string) => {
        if (allowance < 1) throw new DOMException(`Not allowed to ${what} a window.`, 'InvalidAccessError');
        allowance--;
    };
    const client = (tab: Tab): any => ({
        url: tab.url,
        focus: async () => { spend('focus'); focused.push(tab.url); return client(tab); },
        navigate: async (url: string) => {
            if (!tab.controlled) throw new TypeError('This service worker is not the client\'s active service worker.');
            navigated.push(url);
            tab.url = url;
            return client(tab);
        },
    });
    const self: any = {
        location: new URL('https://node.example/sw.js'),
        registration: {
            scope,
            showNotification: async (title: string, options: any) => { shown.push({ title, options }); },
            unregister: async () => { unregistered++; return true; },
        },
        clients: {
            matchAll: async (o: { includeUncontrolled?: boolean } = {}) => tabs.filter(t => t.controlled || o.includeUncontrolled).map(client),
            openWindow: async (url: string) => { spend('open'); opened.push(url); return null; },
        },
        skipWaiting: () => {},
        addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    };
    vm.runInNewContext(SW_SOURCE, { self, URL, JSON, encodeURIComponent, Array });
    const fire = async (type: string, event: any) => {
        let waited: Promise<unknown> = Promise.resolve();
        // A click on a notification allows one window call, for the click's own handling only.
        allowance = type === 'notificationclick' ? 1 : 0;
        listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { waited = p; } });
        await waited.catch(() => {});
        allowance = 0;
    };
    return {
        listeners, shown, opened, navigated, focused, fire,
        unregistered: () => unregistered,
        setTabs: (t: Tab[]) => { tabs = t; },
    };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });

const KEY = ed25519.utils.randomSecretKey();
const PUSH_KEY = bytesToHex(ed25519.getPublicKey(KEY));
const ASKER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
function notice(kind = 'join.answered', recipient = ASKER, key = KEY, sentAt = Math.floor(Date.now() / 1000)) {
    const fields = { c: pushCommunityTag(PUSH_KEY), k: kind as any, i: 'ab'.repeat(16), t: sentAt };
    return { bp: 1, ...fields, s: bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), key)) };
}

describe('the service worker (public/sw.js)', () => {
    it('shows fixed words only: the title is always BeanPool, the text one short sentence, the tag the kind, no image, action or link', async () => {
        const w = loadWorker();
        const data = { ...notice(), extra: 'https://evil.example' };
        await w.fire('push', pushEvent({
            title: 'Maya sent you 50 Beans', body: PUSH_NOTICE_KINDS['join.answered'].body, data, tab: 'home',
            image: 'https://evil.example/x.png', icon: 'https://evil.example/i.png', actions: [{ action: 'x', title: 'Pay' }], requireInteraction: true,
        }));
        expect(w.shown).toHaveLength(1);
        const { title, options } = w.shown[0];
        expect(title).toBe('BeanPool');
        expect(options.body).toBe('A community answered your request to join.');
        expect(options.tag).toBe('join.answered');
        expect(options.icon).toBe('/icon-192x192.png');
        expect(Object.keys(options).sort()).toEqual(['body', 'data', 'icon', 'tag']);
        // Only the signed fields travel on to the app.
        expect(Object.keys(options.data.notice).sort()).toEqual(['bp', 'c', 'i', 'k', 's', 't']);
    });

    it('shows no text for anything but a short plain sentence, and no tag but its own for a kind that is not one', async () => {
        const w = loadWorker();
        await w.fire('push', pushEvent({ body: 'x'.repeat(201), data: { k: 'Not a kind!' } }));
        await w.fire('push', pushEvent({ body: 'Open\nhttps://evil.example', data: null }));
        await w.fire('push', { data: { json: () => { throw new Error('not JSON'); } } });
        expect(w.shown.map(s => [s.title, s.options.body, s.options.tag])).toEqual([
            ['BeanPool', '', 'beanpool'], ['BeanPool', '', 'beanpool'], ['BeanPool', '', 'beanpool'],
        ]);
    });

    it('a click on join.answered lands on /app?door=ask with the notice in the fragment; anything else on /app', async () => {
        const w = loadWorker();
        const n = notice();
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: n } } });
        expect(w.opened).toEqual([`/app?door=ask#notice=${encodeURIComponent(JSON.stringify(n))}`]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: { ...n, k: 'chat.message' } } } });
        expect(w.opened[1].startsWith('/app#notice=')).toBe(true);
    });

    it("with the waiting page open (never controlled: /app is outside /app/), a click opens /app?door=ask with the notice, focusing nothing first", async () => {
        const w = loadWorker();
        const n = notice();
        w.setTabs([{ url: 'https://node.example/app?door=ask', controlled: false }]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: n } } });
        expect(w.focused).toEqual([]);
        expect(w.navigated).toEqual([]);
        expect(w.opened).toEqual([`/app?door=ask#notice=${encodeURIComponent(JSON.stringify(n))}`]);
    });

    it('a tab this worker controls (under /app/) is taken there and brought forward, with no second tab', async () => {
        const w = loadWorker();
        w.setTabs([{ url: 'https://node.example/app?door=ask', controlled: false }, { url: 'https://node.example/app/', controlled: true }]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: notice() } } });
        expect(w.navigated).toHaveLength(1);
        expect(w.navigated[0].startsWith('https://node.example/app?door=ask#notice=')).toBe(true);
        expect(w.focused).toEqual([w.navigated[0]]);
        expect(w.opened).toEqual([]);
    });

    it('registered anywhere but /app/, it removes itself and shows nothing', async () => {
        const w = loadWorker('https://node.example/');
        await w.fire('activate', {});
        await w.fire('push', pushEvent({ body: 'hello', data: notice() }));
        expect(w.unregistered()).toBe(1);
        expect(w.shown).toEqual([]);
        const right = loadWorker();
        await right.fire('activate', {});
        expect(right.unregistered()).toBe(0);
    });

    it('has no fetch handler, and reads no storage', () => {
        const w = loadWorker();
        expect(Object.keys(w.listeners).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
        expect(SW_SOURCE).not.toMatch(/indexedDB|localStorage|caches\.|importScripts|crypto\.subtle/);
    });
});

describe('told from another origin: the worker in a community\'s own registration (global yes Y2)', () => {
    const SCOPE = 'https://global.example/app/knock/riverside.example/';

    it('stays, and shows exactly the fixed words it shows at /app/, tagged with that community\'s host', async () => {
        const w = loadWorker(SCOPE);
        await w.fire('activate', {});
        expect(w.unregistered()).toBe(0);
        await w.fire('push', pushEvent({ title: 'Pay now', body: PUSH_NOTICE_KINDS['join.answered'].body, data: notice(), image: 'https://evil.example/x.png' }));
        expect(w.shown.map(x => [x.title, x.options.body, x.options.tag, Object.keys(x.options).sort().join(',')])).toEqual([
            ['BeanPool', 'A community answered your request to join.', 'join.answered:riverside.example', 'body,data,icon,tag'],
        ]);
    });

    it("two asked communities' yeses keep a notification each: every registration of a site shares the tags, so each carries its host", async () => {
        const riverside = loadWorker(SCOPE);
        const hilltop = loadWorker('https://global.example/app/knock/hilltop.example:8443/');
        const own = loadWorker('https://global.example/app/');
        for (const w of [riverside, hilltop, own]) await w.fire('push', pushEvent({ body: PUSH_NOTICE_KINDS['join.answered'].body, data: notice() }));
        const tags = [riverside, hilltop, own].map(w => w.shown[0].options.tag);
        expect(tags).toEqual(['join.answered:riverside.example', 'join.answered:hilltop.example:8443', 'join.answered']);
        expect(new Set(tags).size).toBe(3);
    });

    it("a click opens Home's row for that community, /app?knock=<host>, with the notice in the fragment, in a new tab", async () => {
        const w = loadWorker(SCOPE);
        const n = notice();
        // The member's app is open in a tab, and the waiting page of an A1 request too: neither is taken or focused (the
        // open app checks a notice by its own community's key), and no tab is navigated.
        w.setTabs([{ url: 'https://global.example/app', controlled: false }, { url: 'https://global.example/app/', controlled: true }]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: n } } });
        expect(w.opened).toEqual([`/app?knock=riverside.example#notice=${encodeURIComponent(JSON.stringify(n))}`]);
        expect(w.focused).toEqual([]);
        expect(w.navigated).toEqual([]);
        const port = loadWorker('https://global.example/app/knock/riverside.example:8443/');
        await port.fire('notificationclick', { notification: { close() {}, data: { notice: n } } });
        expect(port.opened[0].startsWith('/app?knock=riverside.example%3A8443#notice=')).toBe(true);
    });

    it('registered at anything that is not one community\'s host under /app/knock/, it removes itself and shows nothing', async () => {
        for (const scope of ['https://global.example/app/knock/', 'https://global.example/app/knock/a/b/', 'https://global.example/app/knock/-bad.example/', 'https://global.example/app/knocks/riverside.example/']) {
            const w = loadWorker(scope);
            await w.fire('activate', {});
            await w.fire('push', pushEvent({ body: 'hello', data: notice() }));
            expect([scope, w.unregistered(), w.shown.length]).toEqual([scope, 1, 0]);
        }
    });
});

describe('the landing of such a click (lib/knock-landing.ts)', () => {
    const RIVERSIDE = 'https://riverside.example';
    const winAt = (search: string, hash = '') => {
        const replaced: string[] = [];
        return {
            win: { location: { search, hash, pathname: '/app' }, history: { state: null, replaceState: (_: unknown, __: string, url: string) => { replaced.push(url); } } } as any,
            replaced,
        };
    };
    const pinFor = (pushKey: string | null) => localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: RIVERSIDE, publicKey: ASKER, subId: 'c'.repeat(64), pushKey, vapidKey: 'v', for: 'asker' }]));
    beforeEach(() => localStorage.clear());

    it('takes ?knock=<host> and the notice out of the address; a host that is no community\'s lands nowhere', () => {
        const n = notice();
        const at = winAt('?knock=riverside.example', `#notice=${encodeURIComponent(JSON.stringify(n))}`);
        expect(takeKnockLanding(at.win)).toEqual({ origin: RIVERSIDE, notice: n });
        expect(at.replaced).toEqual(['/app']);
        expect(takeKnockLanding(winAt('?door=ask').win)).toBeNull();
        for (const bad of ['riverside.example/evil', 'user@riverside.example', 'localhost', 'riverside.example%2Fx', '']) {
            expect([bad, takeKnockLanding(winAt(`?knock=${encodeURIComponent(bad)}`).win)]).toEqual([bad, null]);
        }
    });

    it('the community\'s own yes, for this key, signed by the key pinned at Tell me: the row', () => {
        pinFor(PUSH_KEY);
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice() }, ASKER)).toBe('row');
    });

    it('a forged notice opens nothing: another signer, another key, another kind, garbled, or nothing pinned for that community', () => {
        pinFor(PUSH_KEY);
        const other = ed25519.utils.randomSecretKey();
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice('join.answered', ASKER, other) }, ASKER)).toBe('forged');
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice('join.answered', bytesToHex(ed25519.getPublicKey(other))) }, ASKER)).toBe('forged');
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice('chat.message') }, ASKER)).toBe('forged');
        expect(knockLandingFor({ origin: RIVERSIDE, notice: null }, ASKER)).toBe('forged');
        // Signed by this community's key, but landing for another community this browser asked: that one's pin decides.
        expect(knockLandingFor({ origin: 'https://elsewhere.example', notice: notice() }, ASKER)).toBe('forged');
        localStorage.clear();
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice() }, ASKER)).toBe('forged');
    });

    it('no notice in the address, or one only late: the row, without a word', () => {
        expect(knockLandingFor({ origin: RIVERSIDE, notice: undefined }, ASKER)).toBe('row');
        pinFor(PUSH_KEY);
        const now = Math.floor(Date.now() / 1000);
        expect(knockLandingFor({ origin: RIVERSIDE, notice: notice('join.answered', ASKER, KEY, now - 8 * 86_400) }, ASKER, now)).toBe('row');
    });
});

const env = (over: Partial<PushEnv>): PushEnv => ({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    maxTouchPoints: 0, secure: true, serviceWorker: true, pushManager: true, notification: true, permission: 'default', standalone: false, brave: false,
    ...over,
});
const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_15 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

describe('where push works, by feature tests (design §2.4)', () => {
    it('a computer: the browser that has to keep running; Safari on a Mac: even closed', () => {
        expect(pushPlace(env({}))).toEqual({ kind: 'ok', device: 'computer', browser: 'Chrome' });
        expect(pushPlace(env({ userAgent: `${env({}).userAgent} Edg/130.0` }))).toEqual({ kind: 'ok', device: 'computer', browser: 'Edge' });
        expect(pushPlace(env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' }))).toEqual({ kind: 'ok', device: 'computer', browser: 'Firefox' });
        expect(pushPlace(env({ brave: true }))).toEqual({ kind: 'ok', device: 'computer', browser: 'Brave' });
        expect(pushPlace(env({ userAgent: MAC_SAFARI }))).toEqual({ kind: 'ok', device: 'safari' });
        // A Chromium that names itself otherwise still says Safari/ in its user agent: never told "even with Safari closed".
        expect(pushPlace(env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0 Safari/537.36' })))
            .toEqual({ kind: 'ok', device: 'computer', browser: 'Chrome' });
        expect(pushPlace(env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SomeBrowser/1.0 Safari/537.36' })))
            .toEqual({ kind: 'ok', device: 'computer', browser: 'your browser' });
        expect(grantedLine(pushPlace(env({})))).toBe("We'll tell you here while Chrome is running.");
        expect(grantedLine(pushPlace(env({ userAgent: MAC_SAFARI })))).toBe("We'll tell you here, even with Safari closed.");
        expect(grantedLine(pushPlace(env({ userAgent: ANDROID })))).toBe("We'll tell you on this phone, even with the browser closed.");
    });

    it('an iPhone in Safari (16.4+): the Home Screen words, with Get the app first; from the Home Screen: the normal flow', () => {
        const safari = pushPlace(env({ userAgent: IPHONE_17, pushManager: false, maxTouchPoints: 5 }));
        expect(safari).toEqual({ kind: 'home-screen' });
        const words = cannotLines(safari);
        expect(words.getApp).toBe(APP_STORE_URL);
        expect(words.lines[0]).toMatch(/^On an iPhone, notifications only work from the Home Screen\./);
        expect(pushPlace(env({ userAgent: IPHONE_17, standalone: true, maxTouchPoints: 5 }))).toEqual({ kind: 'ok', device: 'phone' });
    });

    it('no push here (an older iPhone, http, no PushManager): come back to this page; blocked says where to allow them', () => {
        expect(pushPlace(env({ userAgent: IPHONE_15, pushManager: false }))).toEqual({ kind: 'none', phone: true });
        expect(pushPlace(env({ secure: false }))).toEqual({ kind: 'none', phone: false });
        expect(pushPlace(env({ pushManager: false }))).toEqual({ kind: 'none', phone: false });
        expect(cannotLines(pushPlace(env({ secure: false })))).toEqual({
            lines: ["Notifications can't reach this browser. Come back to this page: it checks every few minutes while open, and a yes keeps for 30 days."], getApp: null,
        });
        const blocked = cannotLines(pushPlace(env({ permission: 'denied' })));
        expect(blocked.lines[0]).toBe('Your browser blocked them for this site: allow them from the icon by the address.');
        expect(blocked.getApp).toBeNull();
    });

    it('on an Android phone that cannot be told, Get the app (Google Play) goes above the words', () => {
        Object.defineProperty(navigator, 'userAgent', { value: ANDROID, configurable: true });
        try {
            expect(cannotLines(pushPlace(env({ userAgent: ANDROID, permission: 'denied' }))).getApp).toBe(PLAY_URL);
        } finally {
            Object.defineProperty(navigator, 'userAgent', { value: env({}).userAgent, configurable: true });
        }
    });
});

describe('a click on a notice (noticeInLocation)', () => {
    const hash = (n: unknown) => `#notice=${encodeURIComponent(JSON.stringify(n))}`;
    it("the community's own, for this key: ok", () => {
        expect(noticeInLocation(hash(notice()), ASKER, PUSH_KEY)).toBe('ok');
    });
    it('a forgery opens nothing: another key, another member, another kind, garbled, or nothing pinned', () => {
        const other = ed25519.utils.randomSecretKey();
        expect(noticeInLocation(hash(notice('join.answered', ASKER, other)), ASKER, PUSH_KEY)).toBe('forged');
        expect(noticeInLocation(hash(notice()), bytesToHex(ed25519.getPublicKey(other)), PUSH_KEY)).toBe('forged');
        expect(noticeInLocation(hash(notice('chat.message')), ASKER, PUSH_KEY)).toBe('forged');
        expect(noticeInLocation('#notice=%7Bnot-json', ASKER, PUSH_KEY)).toBe('forged');
        expect(noticeInLocation(hash(notice()), ASKER, null)).toBe('forged');
        expect(FORGED_NOTICE_LINE).toMatch(/^That notification didn't come from your community\./);
    });
    it('no notice in the address: none', () => {
        expect(noticeInLocation('', ASKER, PUSH_KEY)).toBe('none');
    });
    it("a yes this community signed that is only late, or read on a slow clock, is no forgery: no warning (as the phone's checkTap)", () => {
        const now = Math.floor(Date.now() / 1000);
        const DAY = 24 * 60 * 60;
        // Sent 8 days ago: past core's 7-day lifetime, inside the push's 28-day TTL (a laptop shut for a week, a tray left alone).
        expect(noticeInLocation(hash(notice('join.answered', ASKER, KEY, now - 8 * DAY)), ASKER, PUSH_KEY, now)).toBe('none');
        // Read on a laptop whose clock is 10 minutes slow: the notice looks 10 minutes ahead.
        expect(noticeInLocation(hash(notice('join.answered', ASKER, KEY, now + 10 * 60)), ASKER, PUSH_KEY, now)).toBe('none');
        // Late is no excuse for a forgery: another key, or another member, is still named.
        const other = ed25519.utils.randomSecretKey();
        expect(noticeInLocation(hash(notice('join.answered', ASKER, other, now - 8 * DAY)), ASKER, PUSH_KEY, now)).toBe('forged');
        expect(noticeInLocation(hash(notice('join.answered', bytesToHex(ed25519.getPublicKey(other)), KEY, now + 10 * 60)), ASKER, PUSH_KEY, now)).toBe('forged');
    });
});

describe('the tap (tellMeWhenTheyAnswer)', () => {
    const identity = { publicKey: ASKER, privateKey: '00'.repeat(48) } as any;
    let register: ReturnType<typeof vi.fn>;
    let requestPermission: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        localStorage.clear();
        register = vi.fn();
        requestPermission = vi.fn(async () => 'denied');
        Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
        (globalThis as any).Notification = { permission: 'default', requestPermission };
    });

    it('where push cannot work, nothing is asked and no worker is registered', async () => {
        const r = await tellMeWhenTheyAnswer('https://node.example', identity, 'en', env({ userAgent: IPHONE_17, pushManager: false }));
        expect(r).toEqual({ ok: false, place: { kind: 'home-screen' }, reason: 'cannot' });
        const http = await tellMeWhenTheyAnswer('https://node.example', identity, 'en', env({ secure: false }));
        expect(http.ok).toBe(false);
        expect(requestPermission).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });

    it('the browser says no: blocked, and no worker is registered; nothing is kept', async () => {
        const r = await tellMeWhenTheyAnswer('https://node.example', identity, 'en', env({}));
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ ok: false, place: { kind: 'blocked', phone: false }, reason: 'blocked' });
        expect(register).not.toHaveBeenCalled();
        expect(readWebPushPin('https://node.example', ASKER)).toBeNull();
    });

    it('granted: registers the worker at /app/, waits for it to be active (not for one over this page), subscribes with the community key, posts it signed, keeps the pin', async () => {
        requestPermission.mockImplementation(async () => 'granted');
        const vapidKey = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
        const worker: any = { state: 'installing', listeners: [] as (() => void)[], addEventListener(_: string, fn: () => void) { this.listeners.push(fn); } };
        const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }) }));
        const registration: any = { installing: worker, waiting: null, active: null, pushManager: { getSubscription: async () => null, subscribe } };
        register.mockImplementation(async () => {
            setTimeout(() => { worker.state = 'activated'; worker.listeners.forEach((f: () => void) => f()); }, 10);
            return registration;
        });
        // `ready` never settles for a page outside the worker's scope: the tap must not wait on it.
        Object.defineProperty(navigator, 'serviceWorker', { value: { register, ready: new Promise(() => {}) }, configurable: true });
        // The community runs 1.4.0 (lib/node-version-gate.ts): the key read is all this stub answers.
        resetNodeVersionGateForTests();
        hearNodeVersionForTests('https://node.example');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ vapidKey }), { status: 200 }));
        vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true, subId: 'c'.repeat(64), pushKey: 'd'.repeat(64), vapidKey }), { status: 201 }));
        try {
            const r = await tellMeWhenTheyAnswer('https://node.example', identity, 'fr', env({}));
            expect(r).toEqual({ ok: true, place: { kind: 'ok', device: 'computer', browser: 'Chrome' } });
            expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/app/' });
            expect(fetchSpy).toHaveBeenCalledWith('https://node.example/api/web-push/key', expect.anything());
            expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) });
            const [method, origin, p, body] = vi.mocked(signedFetchAt).mock.calls[0];
            expect([method, origin, p]).toEqual(['POST', 'https://node.example', '/api/web-push']);
            expect(JSON.parse(body)).toEqual({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }, lang: 'fr' });
            // Kept as Tell me's (`asker`): never given again at an open, and never On in Settings (web-push.members.test.ts).
            expect(readWebPushPin('https://node.example', ASKER)).toEqual({ origin: 'https://node.example', publicKey: ASKER, subId: 'c'.repeat(64), pushKey: 'd'.repeat(64), vapidKey, for: 'asker' });
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('nothing in this module registers a worker or asks for permission on its own (only the tap does)', async () => {
        vi.resetModules();
        await import('./web-push');
        expect(register).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
    });
});

describe('the tap on Home\'s row (tellMeAtHome, global yes Y2)', () => {
    const identity = { publicKey: ASKER, privateKey: '00'.repeat(48) } as any;
    const RIVERSIDE = 'https://riverside.example';

    it('a registration of its own at /app/knock/<host>/, that community\'s key, the subscription given to that community signed by the key that asked, its pin kept under that community', async () => {
        localStorage.clear();
        const requestPermission = vi.fn(async () => 'granted');
        (globalThis as any).Notification = { permission: 'default', requestPermission };
        const vapidKey = Buffer.from(new Uint8Array(65).fill(7)).toString('base64url');
        const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/y', keys: { p256dh: 'P', auth: 'A' } }) }));
        const registration: any = { installing: null, waiting: null, active: {}, pushManager: { getSubscription: async () => null, subscribe } };
        const register = vi.fn(async () => registration);
        Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
        resetNodeVersionGateForTests();
        hearNodeVersionForTests(RIVERSIDE);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ vapidKey }), { status: 200 }));
        vi.mocked(signedFetchAt).mockClear();
        vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey }), { status: 201 }));
        try {
            const r = await tellMeAtHome(RIVERSIDE, identity, 'en', env({}));
            expect(r.ok).toBe(true);
            expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/app/knock/riverside.example/' });
            expect(fetchSpy).toHaveBeenCalledWith('https://riverside.example/api/web-push/key', expect.anything());
            const [method, origin, p] = vi.mocked(signedFetchAt).mock.calls[0];
            expect([method, origin, p]).toEqual(['POST', RIVERSIDE, '/api/web-push']);
            expect(readWebPushPin(RIVERSIDE, ASKER)).toEqual({ origin: RIVERSIDE, publicKey: ASKER, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey, for: 'asker' });
            // The click's notice from that community now lands on its row; the member's own pin (none here) is never read.
            expect(knockLandingFor({ origin: RIVERSIDE, notice: notice() }, ASKER)).toBe('row');
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('no community\'s https address: nothing asked, nothing registered', async () => {
        const register = vi.fn();
        const requestPermission = vi.fn();
        Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
        (globalThis as any).Notification = { permission: 'default', requestPermission };
        expect(knockScope('http://riverside.example')).toBeNull();
        expect(knockScope('https://riverside.example/path')).toBeNull();
        expect(knockScope('https://riverside.example:8443')).toBe('/app/knock/riverside.example:8443/');
        const r = await tellMeAtHome('http://riverside.example', identity, 'en', env({}));
        expect(r.ok).toBe(false);
        expect(register).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
    });

    it('letting go: that community is told (signed DELETE), the pin goes, and only that community\'s registration ends, never the member\'s own at /app/', async () => {
        localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: RIVERSIDE, publicKey: ASKER, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey: 'v', for: 'asker' }]));
        const unsubscribe = vi.fn(async () => true);
        const own = { scope: 'https://global.example/app/', unregister: vi.fn(async () => true), pushManager: { getSubscription: async () => ({ unsubscribe }) } };
        const theirs = { scope: 'https://global.example/app/knock/riverside.example/', unregister: vi.fn(async () => true), pushManager: { getSubscription: async () => ({ unsubscribe }) } };
        let held: any[] = [own, theirs];
        // The browser answers the registration whose scope covers the address best.
        const getRegistration = vi.fn(async (scope: string) => held.filter(r => scope.startsWith(new URL(r.scope).pathname)).sort((a, b) => b.scope.length - a.scope.length)[0]);
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration }, configurable: true });
        vi.mocked(sendSignedAt).mockClear();
        await stopTellingMeAtHome(RIVERSIDE, identity);
        expect(vi.mocked(sendSignedAt).mock.calls.map(c => [c[0], c[1], c[2], c[3]])).toEqual([['DELETE', RIVERSIDE, '/api/web-push', JSON.stringify({ subId: 'e'.repeat(64) })]]);
        expect(readWebPushPin(RIVERSIDE, ASKER)).toBeNull();
        expect(theirs.unregister).toHaveBeenCalledTimes(1);
        expect(own.unregister).not.toHaveBeenCalled();
        // With that community's registration already gone, the browser would answer the member's own: it is left alone.
        held = [own];
        await stopTellingMeAtHome(RIVERSIDE, identity);
        expect(own.unregister).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    /** A tap whose key read the community refuses, after the registration was made: what the browser held after it. */
    async function tapRefusedAfterRegistering(pinned: boolean) {
        localStorage.clear();
        if (pinned) localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: RIVERSIDE, publicKey: ASKER, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey: 'v', for: 'asker' }]));
        (globalThis as any).Notification = { permission: 'default', requestPermission: vi.fn(async () => 'granted') };
        const own = { scope: 'https://global.example/app/', unregister: vi.fn(async () => true), pushManager: { getSubscription: async () => null } };
        const theirs = { scope: 'https://global.example/app/knock/riverside.example/', installing: null, waiting: null, active: {}, unregister: vi.fn(async () => true), pushManager: { getSubscription: async () => null, subscribe: vi.fn() } };
        const held: any[] = [own];
        const register = vi.fn(async () => { held.push(theirs); return theirs; });
        const getRegistration = vi.fn(async (scope: string) => held.filter(r => scope.startsWith(new URL(r.scope).pathname)).sort((a, b) => b.scope.length - a.scope.length)[0]);
        Object.defineProperty(navigator, 'serviceWorker', { value: { register, getRegistration }, configurable: true });
        resetNodeVersionGateForTests();
        hearNodeVersionForTests(RIVERSIDE);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 503 }));
        vi.mocked(signedFetchAt).mockClear();
        try {
            const r = await tellMeAtHome(RIVERSIDE, identity, 'en', env({}));
            expect(r).toMatchObject({ ok: false, reason: 'failed' });
            expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/app/knock/riverside.example/' });
            expect(signedFetchAt).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
        return { own, theirs };
    }

    it('a tap that fails after the registration was made (the key read refused) ends that registration: no orphan Home could never find', async () => {
        const { own, theirs } = await tapRefusedAfterRegistering(false);
        expect(theirs.unregister).toHaveBeenCalledTimes(1);
        expect(own.unregister).not.toHaveBeenCalled();
        expect(readWebPushPin(RIVERSIDE, ASKER)).toBeNull();
    });

    it('a failed tap where an earlier Tell me is still kept leaves that registration for Home\'s let-go', async () => {
        const { own, theirs } = await tapRefusedAfterRegistering(true);
        expect(theirs.unregister).not.toHaveBeenCalled();
        expect(own.unregister).not.toHaveBeenCalled();
        expect(readWebPushPin(RIVERSIDE, ASKER)?.subId).toBe('e'.repeat(64));
    });
});

describe('sign-out and delete-everything let go of every Home Tell me (stopEveryTellMeAtHome, review of #3167)', () => {
    const identity = { publicKey: ASKER, privateKey: '00'.repeat(48) } as any;
    const OWN = 'https://global.example';
    const RIVERSIDE = 'https://riverside.example';
    const HILLTOP = 'https://hilltop.example:8443';
    const reg = (scope: string) => {
        const unsubscribe = vi.fn(async () => true);
        return { scope, unsubscribe, unregister: vi.fn(async () => true), pushManager: { getSubscription: async () => ({ unsubscribe }) } };
    };
    const pin = (origin: string, publicKey: string, subId: string, made: 'asker' | 'member' = 'asker') => ({ origin, publicKey, subId, pushKey: PUSH_KEY, vapidKey: 'v', for: made });

    it("each asked community is told (signed DELETE) while the key is here, every asked community's registration ends (an orphan's too), the member's own stays for Turn off", async () => {
        const OTHER = 'f'.repeat(64);
        localStorage.setItem('beanpool_web_push', JSON.stringify([
            pin(OWN, ASKER, '1'.repeat(64), 'member'), pin(RIVERSIDE, ASKER, '2'.repeat(64)), pin(HILLTOP, ASKER, '3'.repeat(64)), pin(RIVERSIDE, OTHER, '4'.repeat(64)),
        ]));
        const own = reg('https://global.example/app/');
        const riverside = reg('https://global.example/app/knock/riverside.example/');
        const hilltop = reg('https://global.example/app/knock/hilltop.example:8443/');
        // A failed Tell me's registration, with no pin: only this sweep can find it.
        const orphan = reg('https://global.example/app/knock/lakeside.example/');
        const elsewhere = reg('https://global.example/app/knocks/x.example/');
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistrations: vi.fn(async () => [own, riverside, hilltop, orphan, elsewhere]) }, configurable: true });
        vi.mocked(sendSignedAt).mockClear();
        await stopEveryTellMeAtHome(identity, OWN);
        expect(vi.mocked(sendSignedAt).mock.calls.map(c => [c[0], c[1], c[2], c[3], c[4]])).toEqual([
            ['DELETE', RIVERSIDE, '/api/web-push', JSON.stringify({ subId: '2'.repeat(64) }), identity],
            ['DELETE', HILLTOP, '/api/web-push', JSON.stringify({ subId: '3'.repeat(64) }), identity],
        ]);
        for (const r of [riverside, hilltop, orphan]) {
            expect(r.unsubscribe).toHaveBeenCalledTimes(1);
            expect(r.unregister).toHaveBeenCalledTimes(1);
        }
        for (const r of [own, elsewhere]) expect(r.unregister).not.toHaveBeenCalled();
        expect(readWebPushPin(RIVERSIDE, ASKER)).toBeNull();
        expect(readWebPushPin(HILLTOP, ASKER)).toBeNull();
        // The member's own pin is turnOffWebPush's to let go (Settings runs both), and another key's is not this key's to sign for.
        expect(readWebPushPin(OWN, ASKER)?.subId).toBe('1'.repeat(64));
        expect(readWebPushPin(RIVERSIDE, OTHER)?.subId).toBe('4'.repeat(64));
    });

    it('a community that never answers holds sign-out at most 5 seconds, and nothing thrown; with no worker API, the DELETEs still go', async () => {
        localStorage.setItem('beanpool_web_push', JSON.stringify([pin(RIVERSIDE, ASKER, '2'.repeat(64))]));
        Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
        vi.mocked(sendSignedAt).mockClear();
        vi.mocked(sendSignedAt).mockImplementationOnce(() => new Promise<void>(() => { /* a version never heard */ }));
        vi.useFakeTimers();
        try {
            let done = false;
            const p = stopEveryTellMeAtHome(identity, OWN).then(() => { done = true; });
            await vi.advanceTimersByTimeAsync(4_900);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(200);
            await p;
            expect(done).toBe(true);
        } finally {
            vi.useRealTimers();
        }
        expect(vi.mocked(sendSignedAt).mock.calls.map(c => c[1])).toEqual([RIVERSIDE]);
        expect(readWebPushPin(RIVERSIDE, ASKER)).toBeNull();
    });
});
