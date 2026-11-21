/**
 * Home's once card on the web (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §7, §10; slice N5a, the
 * phone's N1h): a member already in, who never met the join's screen in this browser, meets the same ask once at the top of
 * Home, only where the browser can be told; never on one screen with "Your way back in" (this one first, the way back on
 * the next landing); the browser's prompt only at Turn on; Later puts it away.
 *
 * Rows: (browser: web push here and never asked / no web push / granted and this account on here / granted for the site
 * only / denied) -> the card or nothing, and the way-back card the other way round. Drawn at 320 px with 130% text, light
 * and dark.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import * as api from '../lib/api';
import type { HomeRead } from '../lib/api';
import type { HomeAnswer } from '../lib/home-cards';
import { readNotifyAsk } from '../lib/web-push';

vi.mock('../lib/api');

const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Alice', name: 'Alice' } as any;
const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };
const LAYOUT = { v: 2, cards: [{ id: 'safety', type: 'safety' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: null };

function answer(profile: 'local' | 'global' = 'local'): HomeRead {
    const a: HomeAnswer = {
        generatedAt: new Date().toISOString(),
        profile,
        cards: {
            safety: { words: true, signInLinked: false },
            market: { items: [], total14d: 0, more: false },
            community: { name: 'Riverside' } as any,
        } as any,
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false } as any,
        me: { standing: 'member', tour: TOUR_ENDED, joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false },
        layout: LAYOUT as any,
    };
    return { notModified: false, answer: a, etag: 'W/"1"' };
}

function browser(kind: 'push' | 'none' | 'granted' | 'denied', answerWith: NotificationPermission = 'default') {
    const requestPermission = vi.fn(async () => answerWith);
    if (kind === 'none') return requestPermission;
    Object.defineProperty(navigator, 'serviceWorker', {
        value: { register: vi.fn(async () => { throw new Error('no worker here'); }), getRegistration: vi.fn(async () => undefined), addEventListener() {}, removeEventListener() {} },
        configurable: true,
    });
    (globalThis as any).Notification = { permission: kind === 'push' ? 'default' : kind, requestPermission };
    (window as any).PushManager = function PushManager() {};
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    return requestPermission;
}
/** This account's notifications on in this browser: the member's pin from a Turn on. */
function onHere() {
    localStorage.setItem('beanpool_web_push', JSON.stringify([{ origin: window.location.origin, publicKey: ME.publicKey, subId: 'e'.repeat(64), pushKey: null, vapidKey: 'BAAA', for: 'member' }]));
}

async function land(profile: 'local' | 'global' = 'local') {
    vi.mocked(api.getHome).mockResolvedValue(answer(profile));
    render(<HomePage identity={ME} onNavigate={vi.fn()} />);
    await screen.findByTestId('home-card-market');
}

beforeEach(() => {
    vi.resetAllMocks();
    // An old phone's browser: 320 px wide with text at 130%.
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
    document.documentElement.style.fontSize = '130%';
});
afterEach(() => {
    cleanup();
    delete (globalThis as any).Notification;
    delete (window as any).PushManager;
    delete (navigator as any).serviceWorker;
    document.documentElement.classList.remove('dark');
    document.documentElement.style.fontSize = '';
    localStorage.clear();
});

describe("Home's once card, by browser (a member already in)", () => {
    for (const dark of [false, true]) {
        it(`web push here, never asked${dark ? ' (dark)' : ''}: the card first, with the community's name and both buttons; no way-back card this landing; nothing asked`, async () => {
            if (dark) document.documentElement.classList.add('dark');
            const ask = browser('push');
            await land();
            const card = screen.getByTestId('notify-once-card');
            expect(card).toHaveTextContent('Notifications');
            expect(screen.getByTestId('notify-ask-title')).toHaveTextContent('Hear from Riverside');
            expect(screen.getByTestId('notify-ask-arrives')).toHaveTextContent("When a neighbour writes, someone answers you, or an event you're going to changes. Never ads.");
            expect(screen.getByTestId('notify-ask-confirm')).toHaveTextContent('Your browser will ask you to confirm.');
            // Two full-size targets, Later under Turn on; words wrap rather than run off at 320 px and 130%.
            const turnOn = screen.getByTestId('notify-ask-turn-on');
            const later = screen.getByTestId('notify-ask-later');
            expect(turnOn.className).toMatch(/min-h-\[52px\]/);
            expect(later.className).toMatch(/min-h-\[48px\]/);
            expect(turnOn.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            for (const el of [turnOn, later, screen.getByTestId('notify-ask-title'), screen.getByTestId('notify-ask-arrives')]) expect(el.className).toMatch(/break-words/);
            // Colours from the tokens only.
            expect(card.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|text-(red|green|blue|gray)-\d/i);
            expect(screen.queryByTestId('home-card-safety')).toBeNull();
            expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
            expect(ask).not.toHaveBeenCalled();
            await waitFor(() => expect(readNotifyAsk(ME.publicKey)).toMatchObject({ askKind: 'once', onceAt: expect.any(Number) }));
        });
    }

    for (const [name, kind, pinned] of [
        ['no web push here', 'none', false],
        ["granted, and this account's notifications on here", 'granted', true],
        ['the browser blocks this site', 'denied', false],
    ] as const) {
        it(`${name}: no card, and "Your way back in" has its landing`, async () => {
            if (pinned) onHere();
            browser(kind);
            await land();
            expect(screen.queryByTestId('notify-once-card')).toBeNull();
            expect(await screen.findByTestId('one-way-back-landing')).toBeInTheDocument();
            expect(readNotifyAsk(ME.publicKey).onceAt).toBeUndefined();
        });
    }

    it('granted for the site only (a Tell me kept): the card, with no line promising a prompt', async () => {
        browser('granted');
        await land();
        expect(screen.getByTestId('notify-once-card')).toBeInTheDocument();
        expect(screen.queryByTestId('notify-ask-confirm')).toBeNull();
    });

    it("the global community: Hear from your community, with the global community's line", async () => {
        browser('push');
        await land('global');
        expect(screen.getByTestId('notify-ask-title')).toHaveTextContent('Hear from your community');
        expect(screen.getByTestId('notify-ask-arrives')).toHaveTextContent('When someone writes to you, or a community answers your request to join. Never ads.');
    });

    it('a member who met the join here: no card', async () => {
        localStorage.setItem(`beanpool_notify_ask:${ME.publicKey}`, JSON.stringify({ joinAt: Date.now() - 3 * 86_400_000, laterAt: Date.now() - 3 * 86_400_000 }));
        browser('push');
        await land();
        expect(screen.queryByTestId('notify-once-card')).toBeNull();
    });
});

describe("the once card's answers", () => {
    it('Later: the card goes, recorded and dated, no prompt; the way-back card waits for the next landing; then no card again', async () => {
        const ask = browser('push');
        await land();
        fireEvent.click(screen.getByTestId('notify-ask-later'));
        expect(screen.queryByTestId('notify-once-card')).toBeNull();
        expect(screen.queryByTestId('one-way-back-landing')).toBeNull();
        expect(ask).not.toHaveBeenCalled();
        expect(readNotifyAsk(ME.publicKey)).toMatchObject({ laterAt: expect.any(Number), onceClosedAt: expect.any(Number) });
        expect(readNotifyAsk(ME.publicKey).phoneNoAt).toBeUndefined();
        cleanup();
        await land();
        expect(screen.queryByTestId('notify-once-card')).toBeNull();
        expect(await screen.findByTestId('one-way-back-landing')).toBeInTheDocument();
    });

    it("Turn on: the browser's prompt only at the tap; blocked there: the card goes and the no is kept apart", async () => {
        const ask = browser('push', 'denied');
        await land();
        expect(ask).not.toHaveBeenCalled();
        await act(async () => { fireEvent.click(screen.getByTestId('notify-ask-turn-on')); });
        expect(ask).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByTestId('notify-once-card')).toBeNull());
        expect(readNotifyAsk(ME.publicKey).phoneNoAt).toEqual(expect.any(Number));
    });

    it('Turn on with the prompt closed unanswered: a Later, never a no; the card goes', async () => {
        browser('push', 'default');
        await land();
        await act(async () => { fireEvent.click(screen.getByTestId('notify-ask-turn-on')); });
        await waitFor(() => expect(screen.queryByTestId('notify-once-card')).toBeNull());
        const r = readNotifyAsk(ME.publicKey);
        expect(r.laterAt).toEqual(expect.any(Number));
        expect(r.phoneNoAt).toBeUndefined();
    });

    it("allowed, but the subscription isn't taken: the card stays and says so", async () => {
        browser('push', 'granted');
        await land();
        await act(async () => { fireEvent.click(screen.getByTestId('notify-ask-turn-on')); });
        expect(await screen.findByTestId('notify-ask-failed')).toBeInTheDocument();
        expect(screen.getByTestId('notify-once-card')).toBeInTheDocument();
    });
});
