/**
 * Members' web push (DESIGN-web-notifications-fable.md §2.2-§2.3, §3 W2 row) on the web app: the worker signs nothing (a
 * rule over public/sw.js as it ships); a member's click goes to their open app tab, or opens one; a click is checked as the
 * phone's checkTap (a forged payload opens nothing); the open keeps or lets go of this browser ('denied' deletes the row);
 * Turn off and sign-out delete it; Settings' row says On, Off or Blocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pushCommunityTag, pushNoticeBytes } from '@beanpool/core';
import { checkClickedNotice, keepWebPushAtOpen, turnOffWebPush, webPushState, readWebPushPin, type PushEnv } from './web-push';
import { openClickedNotice } from './use-web-push-member';
import { signedFetchAt } from './api';

vi.mock('./api', () => ({ signedFetchAt: vi.fn(), getNodeApiUrl: () => '', getPushNoticeDetails: vi.fn() }));

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

const KEY = ed25519.utils.randomSecretKey();
const PUSH_KEY = bytesToHex(ed25519.getPublicKey(KEY));
const MEMBER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
const ORIGIN = 'https://node.example';
function notice(kind = 'chat.message', recipient = MEMBER, key = KEY, sentAt = Math.floor(Date.now() / 1000)) {
    const fields = { c: pushCommunityTag(PUSH_KEY), k: kind as any, i: 'cd'.repeat(16), t: sentAt };
    return { bp: 1, ...fields, s: bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), key)) };
}
const pin = () => localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: ORIGIN, publicKey: MEMBER, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey: 'BAAA' }]));
const identity = { publicKey: MEMBER, privateKey: '00'.repeat(48) } as any;
const env = (over: Partial<PushEnv>): PushEnv => ({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    maxTouchPoints: 0, secure: true, serviceWorker: true, pushManager: true, notification: true, permission: 'granted', standalone: false, brave: false,
    ...over,
});

describe('the worker signs nothing (public/sw.js)', () => {
    it('no key, signature, request, storage or script loading anywhere in its code', () => {
        const code = SW_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/\bsign\w*\s*\(|\.sign\b|subtle|privateKey|secretKey|ed25519|nacl|signedFetch/i);
        expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
        expect(code).not.toMatch(/indexedDB|localStorage|sessionStorage|caches\.|importScripts|\bimport\s*\(/);
    });
});

/** public/sw.js in a sandbox with the browser's rules: uncontrolled tabs only when asked for; one window call per click. */
function loadWorker() {
    const listeners: Record<string, (e: any) => void> = {};
    const opened: string[] = [];
    const focused: string[] = [];
    const messages: { url: string; data: any }[] = [];
    let tabs: { url: string; controlled: boolean }[] = [];
    let allowance = 0;
    const spend = () => { if (allowance < 1) throw new DOMException('Not allowed', 'InvalidAccessError'); allowance--; };
    const client = (tab: { url: string; controlled: boolean }): any => ({
        url: tab.url,
        focus: async () => { spend(); focused.push(tab.url); return client(tab); },
        navigate: async () => { throw new TypeError('not controlled'); },
        postMessage: (data: any) => { messages.push({ url: tab.url, data }); },
    });
    const self: any = {
        location: new URL('https://node.example/sw.js'),
        registration: { scope: 'https://node.example/app/', showNotification: async () => {}, unregister: async () => true },
        clients: {
            matchAll: async (o: { includeUncontrolled?: boolean } = {}) => tabs.filter(t => t.controlled || o.includeUncontrolled).map(client),
            openWindow: async (url: string) => { spend(); opened.push(url); return null; },
        },
        skipWaiting: () => {},
        addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    };
    vm.runInNewContext(SW_SOURCE, { self, URL, JSON, encodeURIComponent, Array });
    const click = async (n: unknown) => {
        let waited: Promise<unknown> = Promise.resolve();
        allowance = 1;
        listeners.notificationclick({ notification: { close() {}, data: { notice: n } }, waitUntil: (p: Promise<unknown>) => { waited = p; } });
        await waited.catch(() => {});
        allowance = 0;
    };
    return { opened, focused, messages, click, setTabs: (t: typeof tabs) => { tabs = t; } };
}

describe("a click on a member's notice (the worker)", () => {
    it("with the member's app open (/app, not controlled), brings it forward and hands it the notice: no second tab", async () => {
        const w = loadWorker();
        const n = notice();
        w.setTabs([{ url: 'https://node.example/app', controlled: false }]);
        await w.click(n);
        expect(w.focused).toEqual(['https://node.example/app']);
        expect(w.messages).toEqual([{ url: 'https://node.example/app', data: { type: 'beanpool-notice', notice: n } }]);
        expect(w.opened).toEqual([]);
    });
    it('with no app open, or only the waiting page, opens /app with the notice in the fragment', async () => {
        const w = loadWorker();
        const n = notice();
        await w.click(n);
        w.setTabs([{ url: 'https://node.example/app?door=ask', controlled: false }]);
        await w.click(n);
        expect(w.messages).toEqual([]);
        expect(w.opened).toEqual([`/app#notice=${encodeURIComponent(JSON.stringify(n))}`, `/app#notice=${encodeURIComponent(JSON.stringify(n))}`]);
    });
    it("a yes still goes to the waiting page, never to a member's tab", async () => {
        const w = loadWorker();
        w.setTabs([{ url: 'https://node.example/app', controlled: false }]);
        await w.click(notice('join.answered'));
        expect(w.messages).toEqual([]);
        expect(w.opened[0].startsWith('/app?door=ask#notice=')).toBe(true);
    });
});

describe('a click, checked as the phone checks a tap (checkClickedNotice, openClickedNotice)', () => {
    beforeEach(() => localStorage.clear());
    it("the community's own, for this member, any kind: ok, and it opens where the node's details say, by the SIGNED kind", async () => {
        expect(checkClickedNotice(notice(), MEMBER, PUSH_KEY)).toEqual({ kind: 'ok', notice: { kind: 'chat.message', id: 'cd'.repeat(16) } });
        pin();
        const go = vi.fn();
        const read = vi.fn(async () => ({ data: { screen: 'chat', conversationId: 'c1' } }));
        expect(await openClickedNotice(notice(), MEMBER, ORIGIN, go, read)).toBe('opened');
        expect(read).toHaveBeenCalledWith('cd'.repeat(16));
        expect(go).toHaveBeenCalledWith('chat.message', { screen: 'chat', conversationId: 'c1' });
    });
    it('a forged payload opens nothing: another key, another member, garbled, a bare object, or nothing pinned here', async () => {
        const other = ed25519.utils.randomSecretKey();
        pin();
        const go = vi.fn();
        const read = vi.fn(async () => ({ data: { screen: 'settings' } }));
        for (const data of [notice('chat.message', MEMBER, other), notice('chat.message', bytesToHex(ed25519.getPublicKey(other))), null, { k: 'chat.message', screen: 'settings' }]) {
            expect(await openClickedNotice(data, MEMBER, ORIGIN, go, read)).toBe('forged');
        }
        localStorage.clear();
        expect(await openClickedNotice(notice(), MEMBER, ORIGIN, go, read)).toBe('forged');
        expect(go).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });
    it("one only late (past 7 days), or from a slow clock, is no forgery: nothing opened, no warning", async () => {
        const now = Math.floor(Date.now() / 1000);
        expect(checkClickedNotice(notice('chat.message', MEMBER, KEY, now - 8 * 86400), MEMBER, PUSH_KEY, now)).toEqual({ kind: 'none' });
    });
    it('details the node no longer has: the kind\'s tab, with nothing from the push', async () => {
        pin();
        const go = vi.fn();
        expect(await openClickedNotice(notice('trade.update'), MEMBER, ORIGIN, go, async () => null)).toBe('opened');
        expect(go).toHaveBeenCalledWith('trade.update', {});
    });
});

describe('at each open (keepWebPushAtOpen), Turn off and sign-out (turnOffWebPush)', () => {
    let register: ReturnType<typeof vi.fn>;
    let requestPermission: ReturnType<typeof vi.fn>;
    let unsubscribe: ReturnType<typeof vi.fn>;
    let subscription: any;
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(signedFetchAt).mockReset();
        vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey: 'BAAA' }), { status: 201 }));
        register = vi.fn();
        requestPermission = vi.fn();
        unsubscribe = vi.fn(async () => true);
        subscription = { unsubscribe, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }) };
        const registration = { pushManager: { getSubscription: async () => subscription } };
        Object.defineProperty(navigator, 'serviceWorker', { value: { register, getRegistration: vi.fn(async () => registration) }, configurable: true });
        (globalThis as any).Notification = { permission: 'granted', requestPermission };
    });

    it("permission now 'denied': the node lets go of this browser (DELETE, signed) and the pin goes; nothing is asked", async () => {
        pin();
        expect(await keepWebPushAtOpen(ORIGIN, identity, 'en', env({ permission: 'denied' }))).toBe('dropped');
        const [method, origin, p, body] = vi.mocked(signedFetchAt).mock.calls[0];
        expect([method, origin, p, JSON.parse(body)]).toEqual(['DELETE', ORIGIN, '/api/web-push', { subId: 'e'.repeat(64) }]);
        expect(readWebPushPin(ORIGIN, MEMBER)).toBeNull();
        expect(requestPermission).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
    });
    it('still allowed: the subscription is given again, signed, in the language of now (as the phone registers at each start)', async () => {
        pin();
        expect(await keepWebPushAtOpen(ORIGIN, identity, 'fr', env({}))).toBe('kept');
        const [method, , p, body] = vi.mocked(signedFetchAt).mock.calls[0];
        expect([method, p, JSON.parse(body).lang]).toEqual(['POST', '/api/web-push', 'fr']);
        expect(register).not.toHaveBeenCalled();
    });
    it('never turned on here: nothing at all (no request, no worker, no prompt)', async () => {
        expect(await keepWebPushAtOpen(ORIGIN, identity, 'en', env({}))).toBe('none');
        expect(signedFetchAt).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        expect(requestPermission).not.toHaveBeenCalled();
    });
    it("Turn off and sign-out: DELETE signed while the key is here, the browser's subscription ends, the pin goes", async () => {
        pin();
        await turnOffWebPush(ORIGIN, identity);
        expect(vi.mocked(signedFetchAt).mock.calls[0].slice(0, 3)).toEqual(['DELETE', ORIGIN, '/api/web-push']);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(readWebPushPin(ORIGIN, MEMBER)).toBeNull();
    });
});

describe("Settings' row (webPushState)", () => {
    beforeEach(() => localStorage.clear());
    it('On once turned on here and allowed; Off before; Blocked by the browser; nothing where push cannot reach', () => {
        expect(webPushState(ORIGIN, MEMBER, env({}))).toBe('off');
        pin();
        expect(webPushState(ORIGIN, MEMBER, env({}))).toBe('on');
        expect(webPushState(ORIGIN, MEMBER, env({ permission: 'default' }))).toBe('off');
        expect(webPushState(ORIGIN, MEMBER, env({ permission: 'denied' }))).toBe('blocked');
        expect(webPushState(ORIGIN, MEMBER, env({ secure: false }))).toBe('cannot');
        expect(webPushState(null, MEMBER, env({}))).toBe('cannot');
    });
});
