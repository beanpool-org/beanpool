/**
 * The web join's last screen, notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §4, §10;
 * slice N5a, the phone's N1j): "Hear from {community}" after the way back, only where the browser can be told; the BROWSER's
 * prompt only at a tap on Turn on notifications; Later goes to Home, records no "no" and is not final; a prompt closed with
 * no answer (browsers say "default" then) is a Later; never a gate; counted with the N1c names.
 *
 * Rows: (browser: web push here and never asked / no web push / already granted for the site / denied) through an invite
 * join -> the screen or nothing. Only the browser's push and the community are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NOTIFY_CHOICE, NOTIFY_SHOWN, oncePerPersonVariant } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { loadIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { readNotifyAsk, readWebPushPin } from '../lib/web-push';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from '../lib/node-version-gate';
import { joinWithInvite, photoNext } from './welcome-join.test-support';

type Call = { path: string; method: string; body: any };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance_c: 0, profile: 'local', features: { openJoin: false } };
const CODE = 'BP-7K3X-9M2W';
const VAPID = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');

let calls: Call[];
let pushPost: () => Response;
function stubNode() {
    calls = [];
    pushPost = () => json(201, { success: true, subId: 'c'.repeat(64), pushKey: 'ab'.repeat(32), vapidKey: VAPID });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = { path: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        if (call.path === '/api/community/info') return json(200, LOCAL);
        if (call.path.startsWith('/api/invite/check')) return json(200, { valid: true, communityName: 'Riverside', inviterCallsign: 'Asha' });
        if (call.path === '/api/invite/redeem') return json(200, { success: true, member: {} });
        if (call.path.endsWith('/api/web-push/key')) return json(200, { vapidKey: VAPID });
        if (call.path.endsWith('/api/web-push') && call.method === 'POST') return pushPost();
        return json(200, {});
    }));
}
const counts = () => calls.filter(c => c.path === '/api/funnel-event').map(c => [c.body.event, c.body.variant]);
const pushPosts = () => calls.filter(c => c.path.endsWith('/api/web-push') && c.method === 'POST');

/** The browser: web push here or not, its permission, and what its prompt answers (a spy: it must not run before the tap). */
function browser(kind: 'push' | 'none' | 'granted' | 'denied', answer: NotificationPermission = 'granted') {
    const requestPermission = vi.fn(async () => answer);
    if (kind === 'none') return requestPermission;
    const subscription = {
        options: { applicationServerKey: new Uint8Array(65).fill(4).buffer },
        unsubscribe: vi.fn(async () => true),
        toJSON: () => ({ endpoint: 'https://push.example/send/x', keys: { p256dh: 'P', auth: 'A' } }),
    };
    const registration = { installing: null, waiting: null, active: {}, pushManager: { getSubscription: async () => null, subscribe: vi.fn(async () => subscription) } };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration), addEventListener() {}, removeEventListener() {} },
        configurable: true,
    });
    (globalThis as any).Notification = { permission: kind === 'push' ? 'default' : kind, requestPermission };
    (window as any).PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    return requestPermission;
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    window.history.replaceState(null, '', '/app');
    resetNodeVersionGateForTests();
    hearNodeVersionForTests(window.location.origin);
    Object.defineProperty(navigator, 'storage', { value: { persist: vi.fn(async () => true), persisted: vi.fn(async () => false) }, configurable: true });
    stubNode();
});
afterEach(async () => {
    // The counts are sent and never waited on: let this test's land in this test's community, not the next one's.
    await new Promise(r => setTimeout(r, 50));
    cleanup();
    vi.unstubAllGlobals();
    delete (globalThis as any).Notification;
    delete (window as any).PushManager;
    delete (navigator as any).serviceWorker;
    localStorage.clear();
});

/** An invite join to its last step's button: the way back's Next. */
async function toWayBackNext(onComplete = vi.fn()) {
    render(<WelcomePage onComplete={onComplete} />);
    await joinWithInvite(CODE, 'Rowan');
    await screen.findByText(/Choose your look/);
    photoNext();
    await screen.findByTestId('backup-next');
    return onComplete;
}
const stepOf = () => screen.getByTestId('step-dots-steps').textContent;

describe('the web join with web push here, never asked: the screen, last, after the way back', () => {
    it('draws "Hear from Riverside" with the inviter, step 4 of 4; the browser is asked nothing until the tap', async () => {
        const ask = browser('push');
        const onComplete = await toWayBackNext();
        expect(stepOf()).toBe('Step 3 of 4');
        fireEvent.click(screen.getByTestId('backup-next'));
        expect(await screen.findByTestId('notify-ask-title')).toHaveTextContent('Hear from Riverside');
        expect(stepOf()).toBe('Step 4 of 4');
        expect(screen.getByTestId('notify-ask-arrives')).toHaveTextContent("When Asha writes, someone answers you, or an event you're going to changes. Never ads.");
        expect(screen.getByText('BeanPool never emails or texts you.', { exact: false })).toBeInTheDocument();
        expect(screen.getByTestId('notify-ask-confirm')).toHaveTextContent('Your browser will ask you to confirm.');
        expect(ask).not.toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();
        const me = (await loadIdentity())!;
        expect(readNotifyAsk(me.publicKey)).toMatchObject({ askKind: 'join' });
        await waitFor(() => expect(counts()).toContainEqual([NOTIFY_SHOWN, oncePerPersonVariant()]));
    });

    it('Later: Home, no prompt, a dated Later and never a no, counted later', async () => {
        const ask = browser('push');
        const onComplete = await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        fireEvent.click(await screen.findByTestId('notify-ask-later'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(ask).not.toHaveBeenCalled();
        const record = readNotifyAsk((await loadIdentity())!.publicKey);
        expect(record.laterAt).toEqual(expect.any(Number));
        expect(record.phoneNoAt).toBeUndefined();
        await waitFor(() => expect(counts()).toContainEqual([NOTIFY_CHOICE, oncePerPersonVariant('later')]));
    });

    it('Turn on, and the browser allows: the prompt once, at the tap; this account subscribed here; Home; counted on', async () => {
        const ask = browser('push', 'granted');
        const onComplete = await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        fireEvent.click(await screen.findByTestId('notify-ask-turn-on'));
        expect(ask).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        const me = (await loadIdentity())!;
        expect(pushPosts()).toHaveLength(1);
        expect(readWebPushPin(window.location.origin, me.publicKey)).toMatchObject({ for: 'member' });
        expect(readNotifyAsk(me.publicKey)).toMatchObject({ state: 'granted' });
        await waitFor(() => expect(counts()).toContainEqual([NOTIFY_CHOICE, oncePerPersonVariant('on')]));
    });

    it("the prompt closed with no answer ('default'): Home, recorded as a Later, never a no; counted later", async () => {
        browser('push', 'default');
        const onComplete = await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        fireEvent.click(await screen.findByTestId('notify-ask-turn-on'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        const record = readNotifyAsk((await loadIdentity())!.publicKey);
        expect(record.laterAt).toEqual(expect.any(Number));
        expect(record.phoneNoAt).toBeUndefined();
        expect(pushPosts()).toHaveLength(0);
        await waitFor(() => expect(counts()).toContainEqual([NOTIFY_CHOICE, oncePerPersonVariant('later')]));
    });

    it("the browser blocks them: Home without a word, the browser's no recorded apart, counted no", async () => {
        browser('push', 'denied');
        const onComplete = await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        fireEvent.click(await screen.findByTestId('notify-ask-turn-on'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(readNotifyAsk((await loadIdentity())!.publicKey).phoneNoAt).toEqual(expect.any(Number));
        await waitFor(() => expect(counts()).toContainEqual([NOTIFY_CHOICE, oncePerPersonVariant('no')]));
    });

    it("the community doesn't take the subscription: said on the screen, both buttons still there, Later still goes Home", async () => {
        browser('push', 'granted');
        const onComplete = await toWayBackNext();
        pushPost = () => json(500, { error: 'no' });
        fireEvent.click(screen.getByTestId('backup-next'));
        fireEvent.click(await screen.findByTestId('notify-ask-turn-on'));
        expect(await screen.findByTestId('notify-ask-failed')).toHaveTextContent("This community couldn't take the request. Try again in a moment.");
        expect(onComplete).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('notify-ask-later'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('‹ goes back to the way back, whose Next brings the screen again', async () => {
        browser('push');
        await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        await screen.findByTestId('notify-step');
        fireEvent.click(screen.getByTestId('step-dots-back'));
        fireEvent.click(await screen.findByTestId('backup-next'));
        expect(await screen.findByTestId('notify-step')).toBeInTheDocument();
    });
});

describe('the web join where the browser is not asked: no screen, Home as before', () => {
    for (const [name, kind] of [
        ['no web push here (an iPhone in Safari outside the Home Screen, a private window, http)', 'none'],
        ['the browser blocks this site', 'denied'],
    ] as const) {
        it(`${name}: three dots, and the way back's Next goes Home; nothing asked, nothing counted`, async () => {
            const ask = browser(kind);
            const onComplete = await toWayBackNext();
            expect(stepOf()).toBe('Step 3 of 3');
            fireEvent.click(screen.getByTestId('backup-next'));
            await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
            expect(screen.queryByTestId('notify-step')).toBeNull();
            expect(ask).not.toHaveBeenCalled();
            expect(counts().map(c => c[0])).not.toContain(NOTIFY_SHOWN);
        });
    }

    it('already granted for the site (a Tell me kept): the screen, with no line promising a prompt; Turn on subscribes this account', async () => {
        const ask = browser('granted', 'granted');
        const onComplete = await toWayBackNext();
        fireEvent.click(screen.getByTestId('backup-next'));
        await screen.findByTestId('notify-step');
        expect(screen.queryByTestId('notify-ask-confirm')).toBeNull();
        fireEvent.click(screen.getByTestId('notify-ask-turn-on'));
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(ask).toHaveBeenCalledTimes(1);
        expect(pushPosts()).toHaveLength(1);
    });
});
