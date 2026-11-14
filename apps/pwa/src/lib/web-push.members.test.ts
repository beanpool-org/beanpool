/**
 * Members' web push (DESIGN-web-notifications-fable.md §2.2-§2.3, §3 W2 row) on the web app: the worker signs nothing (a
 * rule over public/sw.js as it ships); a member's click goes to their open app tab, or opens one; a click is checked as the
 * phone's checkTap (a forged payload opens nothing); the open keeps or lets go of this browser ('denied' deletes the row);
 * Turn off and sign-out delete it; Settings' row says On, Off or Blocked. An applicant's Tell me, kept after the key joins,
 * is never given again at an open and reads Off (end to end in the client, review of 67cdc710); with a community address
 * set in Settings, the pin is the node the app talks to's, so its genuine notice opens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pushCommunityTag, pushNoticeBytes } from '@beanpool/core';
import {
    checkClickedNotice, keepWebPushAtOpen, tellMeWhenTheyAnswer, turnOffWebPush, webPushOrigin, webPushState, readWebPushPin, letGoOfWebPushAt,
    LET_GO_WAIT_MS, type PushEnv,
} from './web-push';
import { openClickedNotice, useWebPushMember } from './use-web-push-member';
import { getNodeApiUrl, getPushNoticeDetails, sendSignedAt, signedFetchAt } from './api';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from './node-version-gate';
import { WebPushRow } from '../components/WebPushRow';

vi.mock('./api', () => ({ signedFetchAt: vi.fn(), sendSignedAt: vi.fn(), getNodeApiUrl: vi.fn(() => ''), getPushNoticeDetails: vi.fn() }));

const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

const KEY = ed25519.utils.randomSecretKey();
const PUSH_KEY = bytesToHex(ed25519.getPublicKey(KEY));
const MEMBER = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
const ORIGIN = 'https://node.example';
function notice(kind = 'chat.message', recipient = MEMBER, key = KEY, sentAt = Math.floor(Date.now() / 1000)) {
    const fields = { c: pushCommunityTag(PUSH_KEY), k: kind as any, i: 'cd'.repeat(16), t: sentAt };
    return { bp: 1, ...fields, s: bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), key)) };
}
/** A pin as Turn on keeps it (`member`), or as the waiting page's Tell me does (`asker`). */
const pin = (made: 'member' | 'asker' = 'member', origin = ORIGIN) =>
    localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin, publicKey: MEMBER, subId: 'e'.repeat(64), pushKey: PUSH_KEY, vapidKey: 'BAAA', for: made }]));
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

describe('the web app moves to another address (letGoOfWebPushAt, review of 7b3f900e)', () => {
    let unsubscribe: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(signedFetchAt).mockReset();
        vi.mocked(sendSignedAt).mockReset();
        vi.mocked(sendSignedAt).mockResolvedValue(undefined);
        unsubscribe = vi.fn(async () => true);
        const registration = { pushManager: { getSubscription: async () => ({ unsubscribe }) } };
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: vi.fn(async () => registration) }, configurable: true });
    });
    afterEach(() => vi.useRealTimers());

    it("the old community's DELETE goes to the origin it was given, signed, sent and not waited for; the subscription ends, the pin goes", async () => {
        pin('member', 'https://old.example');
        await letGoOfWebPushAt('https://old.example', identity);
        expect(vi.mocked(sendSignedAt).mock.calls).toEqual([['DELETE', 'https://old.example', '/api/web-push', JSON.stringify({ subId: 'e'.repeat(64) }), identity]]);
        expect(signedFetchAt).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(readWebPushPin('https://old.example', MEMBER)).toBeNull();
    });
    it(`a sending that hangs (a version never heard) holds the tap at most ${LET_GO_WAIT_MS} ms`, async () => {
        vi.useFakeTimers();
        vi.mocked(sendSignedAt).mockImplementation(() => new Promise<void>(() => { /* never on its way */ }));
        pin('member', 'https://old.example');
        let done = false;
        const going = letGoOfWebPushAt('https://old.example', identity).then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(LET_GO_WAIT_MS - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await going;
        expect(done).toBe(true);
        expect(readWebPushPin('https://old.example', MEMBER)).toBeNull();
    });
    it('a refusal before sending (a key that cannot sign, a server too old) is never thrown', async () => {
        vi.mocked(sendSignedAt).mockRejectedValue(new Error('refused'));
        pin('member', 'https://old.example');
        await expect(letGoOfWebPushAt('https://old.example', identity)).resolves.toBeUndefined();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
    it('nothing kept for this key at the old community: nothing is sent and the subscription stays', async () => {
        pin('member', 'https://another.example');
        await letGoOfWebPushAt('https://old.example', identity);
        expect(sendSignedAt).not.toHaveBeenCalled();
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(readWebPushPin('https://another.example', MEMBER)).not.toBeNull();
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
    it("a Tell me kept from the waiting page is no Turn on: Off, though the browser allows notifications", () => {
        pin('asker');
        expect(webPushState(ORIGIN, MEMBER, env({}))).toBe('off');
    });
});

describe('at each open, a Tell me kept after joining', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(signedFetchAt).mockReset();
        vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
        const registration = { pushManager: { getSubscription: async () => ({ unsubscribe: vi.fn(async () => true), toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }) }) } };
        Object.defineProperty(navigator, 'serviceWorker', { value: { register: vi.fn(), getRegistration: vi.fn(async () => registration) }, configurable: true });
        (globalThis as any).Notification = { permission: 'granted', requestPermission: vi.fn() };
    });
    it('still allowed: nothing is sent (a post would make the community keep it as the member\'s, every kind)', async () => {
        pin('asker');
        expect(await keepWebPushAtOpen(ORIGIN, identity, 'en', env({}))).toBe('none');
        expect(signedFetchAt).not.toHaveBeenCalled();
        expect(readWebPushPin(ORIGIN, MEMBER)?.for).toBe('asker');
    });
    it("the browser now blocks them: it still goes (DELETE, signed), as a member's does", async () => {
        pin('asker');
        expect(await keepWebPushAtOpen(ORIGIN, identity, 'en', env({ permission: 'denied' }))).toBe('dropped');
        expect(vi.mocked(signedFetchAt).mock.calls.map(c => c[0])).toEqual(['DELETE']);
        expect(readWebPushPin(ORIGIN, MEMBER)).toBeNull();
    });
});

/** The app's own open for a member (App.tsx's useWebPushMember), drawn as App draws it. */
function OpenApp({ go = () => {} }: { go?: (kind: string, data: Record<string, unknown>) => void }) {
    const { forged } = useWebPushMember(identity, true, 'en', go);
    return createElement('div', { 'data-testid': 'open-app', 'data-forged': String(forged) });
}

/**
 * The whole way in the client, with only the browser's push and the network faked: an applicant taps Tell me on the
 * waiting page and allows; the community says yes and they join with the same key; the web app opens for the member
 * (App's useWebPushMember, which runs keepWebPushAtOpen) and Settings draws its row. The node's route turns an asker's
 * row into the member's on any POST from a member (routes/web-push.ts, putMemberSubscription), so the client must send
 * none until Turn on.
 */
describe('Tell me, then joining: the member\'s notifications only after Turn on (end to end in the client)', () => {
    const HERE = window.location.origin;
    const vapidKey = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
    let subscription: any;
    let registration: any;
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(getNodeApiUrl).mockReturnValue('');
        vi.mocked(signedFetchAt).mockReset();
        vi.mocked(signedFetchAt).mockImplementation(async () => new Response(JSON.stringify({ success: true, subId: 'c'.repeat(64), pushKey: PUSH_KEY, vapidKey }), { status: 201 }));
        subscription = null;
        const subscribe = vi.fn(async () => (subscription = {
            options: { applicationServerKey: new Uint8Array(65).fill(4).buffer },
            unsubscribe: vi.fn(async () => { subscription = null; return true; }),
            toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'P', auth: 'A' } }),
        }));
        registration = { installing: null, waiting: null, active: {}, pushManager: { getSubscription: async () => subscription, subscribe } };
        Object.defineProperty(navigator, 'serviceWorker', {
            value: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration), addEventListener() {}, removeEventListener() {} },
            configurable: true,
        });
        (globalThis as any).Notification = { permission: 'granted', requestPermission: vi.fn(async () => 'granted') };
        (window as any).PushManager = function PushManager() {};
        Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
        resetNodeVersionGateForTests();
        hearNodeVersionForTests(HERE);
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ vapidKey }), { status: 200 }));
    });
    afterEach(() => {
        cleanup();
        vi.mocked(fetch as any).mockRestore?.();
    });

    const posts = () => vi.mocked(signedFetchAt).mock.calls.filter(c => c[0] === 'POST');

    it('Tell me, join, open: no post at the open, Settings says Off; Turn on posts once, then On, and each open after gives it again', async () => {
        // The waiting page: Tell me, allowed. One post, as the applicant (the node keeps an `asker` row).
        const told = await tellMeWhenTheyAnswer(HERE, identity, 'en', env({}));
        expect(told.ok).toBe(true);
        expect(posts()).toHaveLength(1);
        expect(readWebPushPin(HERE, MEMBER)).not.toBeNull();

        // The same key joins; the web app opens for the member. The open reads this browser's subscription and sends nothing.
        render(createElement(OpenApp));
        await waitFor(() => expect(navigator.serviceWorker.getRegistration).toHaveBeenCalled());
        await act(async () => { await new Promise(r => setTimeout(r, 20)); });
        expect(posts()).toHaveLength(1);
        cleanup();

        // Settings → Notifications: Off, with Turn on.
        render(createElement(WebPushRow, { identity }));
        expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('off');

        // Turn on: the member's own tap, the one post that makes this browser the member's.
        fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
        await waitFor(() => expect(screen.getByTestId('web-push-row').getAttribute('data-state')).toBe('on'));
        expect(posts()).toHaveLength(2);
        cleanup();

        // From now on, each open gives it again, as the phone registers at each start.
        render(createElement(OpenApp));
        await waitFor(() => expect(posts()).toHaveLength(3));
    });
});

/**
 * Settings → Sovereign Node Connection set: the web app talks to another node than the page's. That node is the one the
 * browser subscribes with at Turn on, and the one whose notice key a click is checked by: a genuine notice from it opens,
 * and the forged line is not shown (review of 67cdc710: the pin was the page's, so none was found).
 */
describe('with a community address set in Settings, the pin follows the node the app talks to', () => {
    const OTHER = 'https://other.example';
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(getPushNoticeDetails).mockReset();
        vi.mocked(getPushNoticeDetails).mockResolvedValue({ id: 'cd'.repeat(16), kind: 'chat.message', title: '', body: '', data: { screen: 'chat' } });
        Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistration: vi.fn(async () => null), addEventListener() {}, removeEventListener() {} }, configurable: true });
        (globalThis as any).Notification = { permission: 'granted', requestPermission: vi.fn() };
    });
    afterEach(() => {
        cleanup();
        vi.mocked(getNodeApiUrl).mockReturnValue('');
        window.history.replaceState(null, '', '/');
    });

    it("webPushOrigin: the address the app talks to (as the browser writes an origin), else the page's own; none for no web address", () => {
        expect(webPushOrigin('')).toBe(window.location.origin);
        expect(webPushOrigin('https://Other.Example')).toBe(OTHER);
        expect(webPushOrigin('https://other.example:443')).toBe(OTHER);
        expect(webPushOrigin('not an address')).toBeNull();
    });
    it("a click on that node's genuine notice opens it, and says nothing of a forgery", async () => {
        vi.mocked(getNodeApiUrl).mockReturnValue(OTHER);
        pin('member', OTHER);
        window.history.replaceState(null, '', `/app#notice=${encodeURIComponent(JSON.stringify(notice()))}`);
        const go = vi.fn();
        render(createElement(OpenApp, { go }));
        await waitFor(() => expect(go).toHaveBeenCalledWith('chat.message', { screen: 'chat' }));
        expect(screen.getByTestId('open-app').getAttribute('data-forged')).toBe('false');
    });
});
