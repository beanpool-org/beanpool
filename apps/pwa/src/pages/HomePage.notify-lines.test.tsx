/**
 * What are you into? on the web's Home, notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md
 * §12.3 slice N5b; the phone's N2b): where the community tells a member when a neighbour asks for something they starred
 * (askedPush), the note promises that only while this browser can tell them (core notifyInterestsPromise, the true line),
 * and a star may bring "Hear when a neighbour asks for one of these." [Tell me] by core's rule.
 *
 * Tables, each row red without its line: (askedPush) x (browser) -> the note with or without its promise; (askedPush) x
 * (browser) x (the rule's state) -> the star's line or none, and the browser's prompt never at the star. 320 px, 130%, light
 * and dark.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDay } from '@beanpool/core';
import { HomePage } from './HomePage';
import * as api from '../lib/api';
import type { HomeRead } from '../lib/api';
import type { HomeAnswer } from '../lib/home-cards';
import { readNotifyAsk } from '../lib/web-push';
import { resetHomeCacheForTest } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { BROWSERS, CAN_OFFER, clearBrowser, expectLineFits, oldPhone, resetScreen, standBrowser, type BrowserKind } from '../components/notify-lines.test-support';

vi.mock('../lib/api');

const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Alice', name: 'Alice' } as any;
const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };
const LAYOUT = { v: 2, cards: [{ id: 'interests', type: 'interests' }, { id: 'market', type: 'market' }], dismissed: {}, updatedAt: null };
const PROMISE = "Tap a few. What you star comes first here and in the Market, and we'll tell you when a neighbour asks for it.";
const NO_PROMISE = 'Tap a few. What you star comes first here and in the Market.';
const NOT_SENT_HERE = 'Tap what you like: those come first on Home and in the Market. Nothing is hidden.';
const STAR_LINE = 'Hear when a neighbour asks for one of these.';

function home(askedPush: boolean): HomeRead {
    const a: HomeAnswer = {
        generatedAt: new Date().toISOString(),
        profile: 'local',
        cards: { market: { items: [], total14d: 0, more: false }, community: { name: 'Riverside' } as any } as any,
        features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false, ...(askedPush ? { askedPush: true } : {}) } as any,
        me: { standing: 'member', tour: TOUR_ENDED, joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false },
        layout: LAYOUT as any,
    };
    return { notModified: false, answer: a, etag: 'W/"1"' };
}

/** The rule's state: a member who met the join's screen and said Later on another day (Home's once card never comes then). */
type Rec = 'met the join, Later yesterday' | 'kind spent' | "Home's once card today" | 'nothing kept (the once card first)';
const RECS: Record<Rec, { star: boolean; pins: string }> = {
    'met the join, Later yesterday': { star: true, pins: 'none' },
    'kind spent': { star: false, pins: 'each kind once' },
    "Home's once card today": { star: false, pins: 'one soft ask a day' },
    'nothing kept (the once card first)': { star: false, pins: "never on one screen with Home's once card: it takes the day" },
};
function keep(rec: Rec) {
    const now = Date.now();
    const r = rec === 'met the join, Later yesterday' ? { joinAt: now - 86_400_000, laterAt: now - 86_400_000 }
        : rec === 'kind spent' ? { joinAt: now - 86_400_000, lines: ['star'] }
            : rec === "Home's once card today" ? { onceAt: now, askDay: localDay(new Date(now)), askKind: 'once' }
                : null;
    if (r) localStorage.setItem(`beanpool_notify_ask:${ME.publicKey}`, JSON.stringify(r));
}

async function land(askedPush: boolean) {
    vi.mocked(api.getHome).mockResolvedValue(home(askedPush));
    render(<HomePage identity={ME} onNavigate={vi.fn()} />);
    return screen.findByTestId('home-card-interests');
}

beforeEach(() => {
    vi.resetAllMocks();
    // Each row lands on a Home of its own: no answer or interests kept from the row before.
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetHomeCacheForTest();
    resetAccountEpochForTest();
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    clearBrowser();
    resetScreen();
});

describe("the note: askedPush x browser -> its promise only where this browser can tell them", () => {
    for (const askedPush of [true, false]) {
        for (const b of BROWSERS) {
            const words = !askedPush ? NOT_SENT_HERE : b === 'granted' ? PROMISE : NO_PROMISE;
            it(`${askedPush ? 'the community sends it' : 'the community does not send it'}, ${b} -> "${words}"`, async () => {
                standBrowser(b, ME.publicKey);
                keep('met the join, Later yesterday');
                await land(askedPush);
                await waitFor(() => expect(screen.getByTestId('home-interests-note')).toHaveTextContent(words));
                if (words !== PROMISE) expect(screen.getByTestId('home-interests-note')).not.toHaveTextContent(/tell you/);
            });
        }
    }
});

describe("a star: askedPush x browser x the rule's state -> the line or none", () => {
    for (const askedPush of [true, false]) {
        for (const b of BROWSERS) {
            for (const [rec, { star, pins }] of Object.entries(RECS) as [Rec, { star: boolean; pins: string }][]) {
                if (!askedPush && rec !== 'met the join, Later yesterday') continue;
                const shows = askedPush && CAN_OFFER[b as BrowserKind] && star;
                it(`${askedPush ? 'sent here' : 'not sent here'}, ${b}, ${rec} -> ${shows ? `"${STAR_LINE}" [Tell me]` : 'no line'} (pins: ${pins})`, async () => {
                    const ask = standBrowser(b, ME.publicKey);
                    keep(rec);
                    const card = await land(askedPush);
                    fireEvent.click(within(card).getByTestId('home-interest-food'));
                    if (shows) {
                        const line = await within(card).findByTestId('notify-line');
                        expect(line).toHaveTextContent(STAR_LINE);
                        expect(readNotifyAsk(ME.publicKey).lines).toContain('star');
                    } else {
                        await new Promise((r) => setTimeout(r, 0));
                        expect(screen.queryByTestId('notify-line')).toBeNull();
                    }
                    expect(ask).not.toHaveBeenCalled();
                });
            }
        }
    }

    for (const dark of [false, true]) {
        it(`at 320 px and 130%${dark ? ', dark' : ''}: the line wraps and keeps its target; a star taken off leaves it; Done takes it away for good`, async () => {
            oldPhone(dark);
            standBrowser('default', ME.publicKey);
            keep('met the join, Later yesterday');
            const card = await land(true);
            fireEvent.click(within(card).getByTestId('home-interest-food'));
            expectLineFits(await within(card).findByTestId('notify-line'));
            // A second star brings no second line (one per place).
            fireEvent.click(within(card).getByTestId('home-interest-arts'));
            expect(within(card).getAllByTestId('notify-line')).toHaveLength(1);
            fireEvent.click(within(card).getByTestId('home-interests-done'));
            await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
        });
    }

    it("Tell me: the browser's prompt once, at the tap; a no keeps it apart and the line goes without a word", async () => {
        const ask = standBrowser('default', ME.publicKey, 'denied');
        keep('met the join, Later yesterday');
        const card = await land(true);
        fireEvent.click(within(card).getByTestId('home-interest-food'));
        fireEvent.click(await within(card).findByTestId('notify-line-tell-me'));
        await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
        expect(ask).toHaveBeenCalledTimes(1);
        expect(readNotifyAsk(ME.publicKey).phoneNoAt).toEqual(expect.any(Number));
        expect(screen.getByTestId('home-interests-note')).toHaveTextContent(NO_PROMISE);
    });
});
