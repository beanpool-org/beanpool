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
} from './web-push';
import { APP_STORE_URL, PLAY_URL } from './peek';

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

/** public/sw.js in a sandbox: its listeners, and what it asked of the browser. */
function loadWorker(scope = 'https://node.example/app/') {
    const listeners: Record<string, (e: any) => void> = {};
    const shown: { title: string; options: any }[] = [];
    const opened: string[] = [];
    const navigated: string[] = [];
    let unregistered = 0;
    let tabs: any[] = [];
    const self: any = {
        location: new URL('https://node.example/sw.js'),
        registration: {
            scope,
            showNotification: async (title: string, options: any) => { shown.push({ title, options }); },
            unregister: async () => { unregistered++; return true; },
        },
        clients: {
            matchAll: async () => tabs,
            openWindow: async (url: string) => { opened.push(url); return null; },
        },
        skipWaiting: () => {},
        addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    };
    vm.runInNewContext(SW_SOURCE, { self, URL, JSON, encodeURIComponent, Array });
    const fire = async (type: string, event: any) => {
        let waited: Promise<unknown> = Promise.resolve();
        listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { waited = p; } });
        await waited;
    };
    return {
        listeners, shown, opened, navigated, fire,
        unregistered: () => unregistered,
        setTabs: (t: any[]) => { tabs = t; },
    };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });

const KEY = ed25519.utils.randomSecretKey();
const PUSH_KEY = bytesToHex(ed25519.getPublicKey(KEY));
const ASKER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
function notice(kind = 'join.answered', recipient = ASKER, key = KEY) {
    const fields = { c: pushCommunityTag(PUSH_KEY), k: kind as any, i: 'ab'.repeat(16), t: Math.floor(Date.now() / 1000) };
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

    it('a click focuses an open BeanPool tab and takes it there; one it cannot take elsewhere gets a new tab', async () => {
        const w = loadWorker();
        const went: string[] = [];
        w.setTabs([{ url: 'https://other.example/app', focus: async () => {}, navigate: async () => {} },
            { url: 'https://node.example/app?door=ask', focus: async () => {}, navigate: async (u: string) => { went.push(u); } }]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: notice() } } });
        expect(went).toHaveLength(1);
        expect(went[0].startsWith('https://node.example/app?door=ask#notice=')).toBe(true);
        expect(w.opened).toEqual([]);
        w.setTabs([{ url: 'https://node.example/app', focus: async () => {}, navigate: async () => { throw new TypeError('not controlled'); } }]);
        await w.fire('notificationclick', { notification: { close() {}, data: { notice: notice() } } });
        expect(w.opened).toHaveLength(1);
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

    it('nothing in this module registers a worker or asks for permission on its own (only the tap does)', async () => {
        vi.resetModules();
        await import('./web-push');
        expect(register).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
    });
});
