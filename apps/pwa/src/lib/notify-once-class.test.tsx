/**
 * Home's once card on the web, the whole class (slice N5a fix round; scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md
 * §7: the card shows once, and never where the member already answered). One table:
 *
 *   (the card's answer: a yes / the browser's no / Later / the tab closed with it up)
 *   x (then, in Settings → Notifications: Turn off / Turn on / nothing)
 *   x (a later landing: the same day / the next day / 8 days on)  ->  the card, or not.
 *
 * Driven through the code the app runs: core's rule read through lib/web-push.ts (notifyOnceDueHere), the card's answers
 * (turnOnFromAsk, laterFromAsk), and Settings' own row (components/WebPushRow.tsx), its buttons tapped. Only the browser's
 * push and the community are faked. Each row's `pins` names the line that holds it: take that line away and the row goes
 * red (the PR body has the runs). Settings' Turn off is offered only while this account's notifications are on here, so
 * where the card's answer left them off, "Turn off" taps Turn on there first, as a member would.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebPushRow } from '../components/WebPushRow';
import { signedFetchAt } from './api';
import { hearNodeVersionForTests, resetNodeVersionGateForTests } from './node-version-gate';
import { keepWebPushAtOpen, laterFromAsk, markNotifyAskHere, notifyOnceDueHere, readNotifyAsk, readWebPushPin, turnOnFromAsk } from './web-push';

const ORIGIN = 'https://node.example';
vi.mock('./api', () => ({ signedFetchAt: vi.fn(), sendSignedAt: vi.fn(), getNodeApiUrl: vi.fn(() => 'https://node.example'), getPushNoticeDetails: vi.fn() }));

const ME = { publicKey: 'b'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Rowan' } as any;
const VAPID = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 10:00 local, so the same day's later landing stays on its day.
const T0 = new Date(2026, 10, 23, 10, 0).getTime();

/**
 * The browser: web push here, never asked. Its prompt answers `answers` in turn (then 'granted'), and the browser then says
 * what it answered, as browsers do (a prompt closed with no answer leaves 'default'). `subscribed` false: the browser holds
 * no subscription (forgot it: cleared, expired).
 */
const browser = { permission: 'default' as NotificationPermission, answers: [] as NotificationPermission[], subscribed: true };
function fakeBrowser() {
    browser.permission = 'default';
    browser.answers = [];
    browser.subscribed = true;
    const subscription = {
        options: { applicationServerKey: new Uint8Array(65).fill(4).buffer },
        unsubscribe: vi.fn(async () => { browser.subscribed = false; return true; }),
        toJSON: () => ({ endpoint: 'https://push.example/send/x', keys: { p256dh: 'P', auth: 'A' } }),
    };
    const registration = {
        installing: null, waiting: null, active: {},
        pushManager: { getSubscription: async () => (browser.subscribed ? subscription : null), subscribe: vi.fn(async () => { browser.subscribed = true; return subscription; }) },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration), addEventListener() {}, removeEventListener() {} },
        configurable: true,
    });
    (globalThis as any).Notification = {
        get permission() { return browser.permission; },
        requestPermission: vi.fn(async () => {
            const a = browser.answers.shift() ?? 'granted';
            browser.permission = a;
            return a;
        }),
    };
    (window as any).PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
}

beforeEach(() => {
    // Only Date is faked: the record's dates are the table's days, and the app's own waits run as they do.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    localStorage.clear();
    resetNodeVersionGateForTests();
    hearNodeVersionForTests(ORIGIN);
    fakeBrowser();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/api/web-push/key')
        ? new Response(JSON.stringify({ vapidKey: VAPID }), { status: 200 })
        : new Response('{}', { status: 200 }))));
    vi.mocked(signedFetchAt).mockReset();
    vi.mocked(signedFetchAt).mockImplementation(async (method: string) => (method === 'POST'
        ? new Response(JSON.stringify({ success: true, subId: 'c'.repeat(64), pushKey: 'ab'.repeat(32), vapidKey: VAPID }), { status: 201 })
        : new Response('{}', { status: 200 })));
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as any).Notification;
    delete (window as any).PushManager;
    delete (navigator as any).serviceWorker;
    localStorage.clear();
});

/** Home lands and draws the card (useNotifyOnce marks it shown once Home has drawn it). */
function homeDrawsTheCard(at: number) {
    expect(notifyOnceDueHere(ME.publicKey, undefined, at)).toBe(true);
    markNotifyAskHere(ME.publicKey, { type: 'shown', surface: 'once' }, at);
}

type Answer = 'a yes' | "the browser's no" | 'Later' | 'the tab closed with it up';
async function answerTheCard(a: Answer) {
    if (a === 'a yes') {
        browser.answers = ['granted'];
        expect(await turnOnFromAsk(ME, 'en', 'once')).toBe('ok');
    } else if (a === "the browser's no") {
        browser.answers = ['denied'];
        expect(await turnOnFromAsk(ME, 'en', 'once')).toBe('blocked');
    } else if (a === 'Later') {
        laterFromAsk(ME.publicKey, 'once');
    }
}

/** Settings → Notifications, its row drawn and its buttons tapped as a member would. */
async function settingsRow() {
    render(createElement(WebPushRow, { identity: ME }));
    return screen.getByTestId('web-push-row');
}
async function tap(row: HTMLElement, label: 'Turn on' | 'Turn off', to: string) {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })); });
    await waitFor(() => expect(row.getAttribute('data-state')).toBe(to));
}
type Then = 'Turn off' | 'Turn on' | 'nothing';
async function thenInSettings(then: Then) {
    if (then === 'nothing') return;
    const row = await settingsRow();
    const state = row.getAttribute('data-state');
    if (state === 'blocked') {
        // Blocked by the browser: the row offers neither; only the browser's own settings undo it.
        expect(screen.queryByRole('button', { name: /Turn (on|off)/ })).toBeNull();
    } else if (then === 'Turn on') {
        if (state === 'off') await tap(row, 'Turn on', 'on');
        else expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
    } else {
        if (state === 'off') await tap(row, 'Turn on', 'on');
        await tap(row, 'Turn off', 'off');
    }
    cleanup();
}

const LANDINGS = [['the same day', 2 * HOUR], ['the next day', DAY], ['8 days on', 8 * DAY]] as const;

type Row = { answer: Answer; then: Then; card: [boolean, boolean, boolean]; pins: string };
const ROWS: Row[] = [
    // A yes: on here, and the card closed for good, so a Turn off in Settings later never brings it back.
    { answer: 'a yes', then: 'Turn off', card: [false, false, false], pins: "a yes on the card closes it (core notifyOutcomeEvent/closesOnce) and Settings' Turn off is kept (turnOffFromSettings)" },
    { answer: 'a yes', then: 'Turn on', card: [false, false, false], pins: 'on here (core notifyBrowserPhone: granted)' },
    { answer: 'a yes', then: 'nothing', card: [false, false, false], pins: 'on here (core notifyBrowserPhone: granted)' },
    // The browser's no: it blocks the site; Settings can't turn on or off.
    { answer: "the browser's no", then: 'Turn off', card: [false, false, false], pins: "the browser's no (denied; phoneNoAt)" },
    { answer: "the browser's no", then: 'Turn on', card: [false, false, false], pins: "the browser's no (denied; phoneNoAt)" },
    { answer: "the browser's no", then: 'nothing', card: [false, false, false], pins: "the browser's no (denied; phoneNoAt)" },
    // Later: the card put away for good.
    { answer: 'Later', then: 'Turn off', card: [false, false, false], pins: 'Later closes the card (onceClosedAt)' },
    { answer: 'Later', then: 'Turn on', card: [false, false, false], pins: 'Later closes the card (onceClosedAt); then on here' },
    { answer: 'Later', then: 'nothing', card: [false, false, false], pins: 'Later closes the card (onceClosedAt)' },
    // Never answered: the card stays up to 7 days, unless the member chose in Settings.
    { answer: 'the tab closed with it up', then: 'Turn off', card: [false, false, false], pins: "Settings' Turn off is the member's choice (turnOffFromSettings, core 'off')" },
    { answer: 'the tab closed with it up', then: 'Turn on', card: [false, false, false], pins: 'on here (core notifyBrowserPhone: granted)' },
    { answer: 'the tab closed with it up', then: 'nothing', card: [true, true, false], pins: 'unanswered: each landing for 7 days (onceOpen), then folded away' },
];

describe("Home's once card: (the card's answer) x (then in Settings) x (a later landing) -> the card or not", () => {
    for (const row of ROWS) {
        it(`${row.answer} · then ${row.then} in Settings → ${LANDINGS.map(([d], i) => `${d}: ${row.card[i] ? 'the card' : 'no card'}`).join(', ')} [${row.pins}]`, async () => {
            homeDrawsTheCard(T0);
            await answerTheCard(row.answer);
            await thenInSettings(row.then);
            const got = LANDINGS.map(([, after]) => notifyOnceDueHere(ME.publicKey, undefined, T0 + after));
            expect(got).toEqual(row.card);
        });
    }
});

describe('each line on its own', () => {
    it("a yes alone closes the card: switched off later by no choice of the member's (the browser forgot the subscription at an open), still no card [a yes closes it: closesOnce]", async () => {
        homeDrawsTheCard(T0);
        await answerTheCard('a yes');
        browser.subscribed = false;
        expect(await keepWebPushAtOpen(ORIGIN, ME, 'en')).toBe('dropped');
        expect(readWebPushPin(ORIGIN, ME.publicKey)).toBeNull();
        // The browser still allows the site and this account is off here: it reads as able to ask.
        expect(browser.permission).toBe('granted');
        expect(LANDINGS.map(([, after]) => notifyOnceDueHere(ME.publicKey, undefined, T0 + after))).toEqual([false, false, false]);
        expect(readNotifyAsk(ME.publicKey)).toMatchObject({ state: 'granted', onceClosedAt: T0 });
    });

    it("Settings' Turn off before the card was ever drawn (a member who turned on in Settings first): never the card [core: onceClosedAt alone closes it]", async () => {
        await thenInSettings('Turn off');
        expect(readNotifyAsk(ME.publicKey).onceAt).toBeUndefined();
        expect(LANDINGS.map(([, after]) => notifyOnceDueHere(ME.publicKey, undefined, T0 + after))).toEqual([false, false, false]);
    });

    it("an open that drops this browser is no choice: a card never drawn still comes [only Settings' tap keeps 'off']", async () => {
        const row = await settingsRow();
        await tap(row, 'Turn on', 'on');
        cleanup();
        browser.subscribed = false;
        expect(await keepWebPushAtOpen(ORIGIN, ME, 'en')).toBe('dropped');
        expect(readNotifyAsk(ME.publicKey).onceClosedAt).toBeUndefined();
        expect(notifyOnceDueHere(ME.publicKey, undefined, T0 + DAY)).toBe(true);
    });

    it("the browser's no, then the site unblocked in the browser's own settings ('default' again): still no card [phoneNoAt; closesOnce]", async () => {
        homeDrawsTheCard(T0);
        await answerTheCard("the browser's no");
        browser.permission = 'default';
        expect(LANDINGS.map(([, after]) => notifyOnceDueHere(ME.publicKey, undefined, T0 + after))).toEqual([false, false, false]);
    });
});
