/**
 * The web's event page, notifications (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3 slice N5b;
 * the phone's N2b): a Going or an Interested saved may bring one named line under the answer, in the words true for it now
 * (core notifyEventLineWords over core eventNoticesComing), by core's rule for this browser; the reminder box says
 * "⏰ Reminders need notifications on." [Turn on] while a reminder is coming and this browser could tell them but isn't.
 *
 * Tables, each row red without its line:
 * - the named line: answer x when x the event's state x browser (unsupported, default, denied, granted, granted for the site
 *   only) -> the line and its words, or none; the browser's prompt never at the offer;
 * - the rule's state (fresh, kind spent, the day taken, the join's day, a Later yesterday) -> the line or none;
 * - the true line: answer x when x state x browser -> the true line or Remind me as it was;
 * - Tell me and Turn on: the prompt only at the tap; its answer kept as the phone's is.
 * Drawn at 320 px with 130% text, light and dark.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetail } from './EventCard';
import * as api from '../lib/api';
import * as features from '../lib/features';
import { readNotifyAsk } from '../lib/web-push';
import {
    BROWSERS, CAN_OFFER, RECORDS, SAYS_OFF, clearBrowser, expectLineFits, keepRecord, oldPhone, resetScreen, standBrowser, turnedOnHere,
    type BrowserKind, type RecordKind,
} from './notify-lines.test-support';

vi.mock('../lib/features', async () => {
    const actual = await vi.importActual('../lib/features');
    return { ...actual, useCommunityInfo: vi.fn() };
});
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        rsvpEvent: vi.fn(),
        getMarketplacePosts: vi.fn(async () => []),
        getConversations: vi.fn(async () => ({ conversations: [], totalUnread: 0 })),
        getMyEvents: vi.fn(async () => []),
        setEventReminder: vi.fn(async () => ({ success: true })),
        getNotificationPreferences: vi.fn(async () => ({})),
        getNodeApiUrl: () => '',
        myNodeRoleOnce: vi.fn(async () => null),
    };
});
const ME = { publicKey: 'a'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Me', createdAt: '2026-09-27T00:00:00.000Z' };
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, loadIdentity: vi.fn(async () => ({ publicKey: 'a'.repeat(64), privateKey: '00'.repeat(48), callsign: 'Me', createdAt: '2026-09-27T00:00:00.000Z' })) };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WHEN = { 'a week away': 7 * DAY, '23 h away': 23 * HOUR } as const;
type When = keyof typeof WHEN;
const STATES = { on: { status: 'active', eventState: 'scheduled' }, 'cancelled by its host': { status: 'active', eventState: 'cancelled' } } as const;
type State = keyof typeof STATES;

function event(when: When, myRsvp: 'going' | 'interested' | null, state: State = 'on'): any {
    const start = Date.now() + WHEN[when];
    return {
        id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall', description: 'Clearing the back garden', credits: 0,
        priceType: 'fixed', authorPublicKey: 'b'.repeat(64), authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true,
        repeatable: false, lat: -28.55, lng: 153.5, eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
        eventPlaceName: 'The hall', goingCount: 2, interestedCount: 1, myRsvp, ...STATES[state],
    };
}

/** Taps an answer on an event with none; the node takes it and sends the event back as it reads after (its state included). */
async function answer(when: When, a: 'going' | 'interested', state: State = 'on') {
    vi.mocked(api.rsvpEvent).mockResolvedValue({ success: true, post: event(when, a, state) } as any);
    render(<EventDetail post={event(when, null)} identity={ME as any} />);
    fireEvent.click(screen.getByRole('button', { name: a === 'going' ? /Going/ : /Interested/ }));
    await waitFor(() => expect(api.getNotificationPreferences).toHaveBeenCalled());
    // The choice read, and the rule asked: nothing left to wait for.
    await waitFor(() => expect(screen.getByTestId('event-reminder')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
}

function lineWords(when: When, a: 'going' | 'interested', state: State): string | null {
    if (state !== 'on') return null;
    if (when === 'a week away') return a === 'going' ? 'Get a reminder the day before, and hear if it changes.' : 'Get a reminder the day before.';
    return a === 'going' ? 'Hear if it changes.' : null;
}

beforeEach(() => {
    vi.mocked(features.useCommunityInfo).mockReturnValue({ features: { door: 'members' } } as any);
    vi.mocked(api.getMyEvents).mockReset().mockResolvedValue([]);
    vi.mocked(api.getNotificationPreferences).mockReset().mockResolvedValue({} as any);
    vi.mocked(api.rsvpEvent).mockReset();
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    clearBrowser();
    resetScreen();
});

describe('the named line under the answer: answer x when x state x browser', () => {
    for (const browserKind of BROWSERS) {
        for (const when of Object.keys(WHEN) as When[]) {
            for (const state of Object.keys(STATES) as State[]) {
                for (const a of ['going', 'interested'] as const) {
                    const words = lineWords(when, a, state);
                    const shows = CAN_OFFER[browserKind] && !!words;
                    it(`${browserKind}: ${a}, ${when}, ${state} -> ${shows ? `"${words}" [Tell me]` : 'no line'}`, async () => {
                        const ask = standBrowser(browserKind, ME.publicKey);
                        await answer(when, a, state);
                        if (shows) {
                            const line = await screen.findByTestId('notify-line');
                            expect(line).toHaveTextContent(words!);
                            expect(within(line).getByTestId('notify-line-tell-me')).toHaveTextContent('Tell me');
                            // Under the answer, in the answer's block.
                            expect(screen.getByTestId('event-action')).toContainElement(line);
                            expect(readNotifyAsk(ME.publicKey).lines).toEqual([a]);
                        } else {
                            expect(screen.queryByTestId('notify-line')).toBeNull();
                            // Nothing true to say, or nothing to turn on: the kind is left unspent.
                            expect(readNotifyAsk(ME.publicKey).lines).toBeUndefined();
                        }
                        expect(ask).not.toHaveBeenCalled();
                    });
                }
            }
        }
    }
});

describe("the named line by the rule's state (Going, a week away, a browser that can ask)", () => {
    for (const [kind, { offers, pins }] of Object.entries(RECORDS) as [RecordKind, { offers: boolean; pins: string }][]) {
        it(`${kind} -> ${offers ? 'the line' : 'no line'} (pins: ${pins})`, async () => {
            standBrowser('default', ME.publicKey);
            keepRecord(ME.publicKey, kind, 'going');
            await answer('a week away', 'going');
            if (offers) expect(await screen.findByTestId('notify-line')).toBeInTheDocument();
            else expect(screen.queryByTestId('notify-line')).toBeNull();
        });
    }

    it('the Marketplace switch off: the node sends neither reminder nor change, so no line and the kind unspent', async () => {
        standBrowser('default', ME.publicKey);
        vi.mocked(api.getNotificationPreferences).mockResolvedValue({ notify_marketplace: 'false' } as any);
        await answer('a week away', 'going');
        expect(screen.queryByTestId('notify-line')).toBeNull();
        expect(readNotifyAsk(ME.publicKey).lines).toBeUndefined();
    });

    it('Going taken back: the line goes', async () => {
        standBrowser('default', ME.publicKey);
        await answer('a week away', 'going');
        await screen.findByTestId('notify-line');
        vi.mocked(api.rsvpEvent).mockResolvedValue({ success: true } as any);
        fireEvent.click(screen.getByRole('button', { name: /Going/ }));
        await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
    });
});

describe('the true line in the reminder box: answer x when x state x browser', () => {
    for (const browserKind of BROWSERS) {
        for (const when of Object.keys(WHEN) as When[]) {
            for (const state of Object.keys(STATES) as State[]) {
                for (const a of ['going', 'interested'] as const) {
                    // A reminder still to come (the default, the day before): a week away and the event on.
                    const off = SAYS_OFF[browserKind] && when === 'a week away' && state === 'on';
                    it(`${browserKind}: ${a}, ${when}, ${state} -> ${off ? '"⏰ Reminders need notifications on." [Turn on]' : 'Remind me as it was'}`, async () => {
                        standBrowser(browserKind, ME.publicKey);
                        render(<EventDetail post={event(when, a, state)} identity={ME as any} />);
                        await waitFor(() => expect(api.getNotificationPreferences).toHaveBeenCalled());
                        const box = await screen.findByTestId('event-reminder');
                        if (off) {
                            await waitFor(() => expect(within(box).getByTestId('event-reminders-off')).toHaveTextContent('⏰ Reminders need notifications on.'));
                            expect(within(box).getByTestId('event-reminders-turn-on')).toHaveTextContent('Turn on');
                            expect(within(box).queryByTestId('event-reminder-change')).toBeNull();
                        } else {
                            await new Promise((r) => setTimeout(r, 0));
                            expect(within(screen.getByTestId('event-reminder')).queryByTestId('event-reminders-off')).toBeNull();
                            expect(screen.getByTestId('event-reminder')).toHaveTextContent('Remind me:');
                        }
                    });
                }
            }
        }
    }
});

describe('Tell me and Turn on: the prompt only at the tap, its answer kept as the phone keeps it', () => {
    for (const dark of [false, true]) {
        it(`the line at 320 px and 130%${dark ? ', dark' : ''}: wraps, keeps its 44 px target, colours from the tokens`, async () => {
            oldPhone(dark);
            standBrowser('default', ME.publicKey);
            await answer('a week away', 'going');
            expectLineFits(await screen.findByTestId('notify-line'));
            const box = screen.getByTestId('event-reminder');
            expect(within(box).getByTestId('event-reminders-turn-on').className).toMatch(/break-words/);
            expect(box.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
        });
    }

    it("Tell me, and the browser says no: the prompt once, at the tap; the line goes without a word; the browser's no kept apart", async () => {
        const ask = standBrowser('default', ME.publicKey, 'denied');
        await answer('a week away', 'going');
        expect(ask).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByTestId('notify-line-tell-me'));
        await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
        expect(ask).toHaveBeenCalledTimes(1);
        expect(readNotifyAsk(ME.publicKey).phoneNoAt).toEqual(expect.any(Number));
        expect(screen.queryByTestId('notify-line-done')).toBeNull();
    });

    it('Tell me, and the prompt closed with no answer: the line goes; a Later kept, never a no', async () => {
        standBrowser('default', ME.publicKey, 'default');
        await answer('a week away', 'going');
        fireEvent.click(await screen.findByTestId('notify-line-tell-me'));
        await waitFor(() => expect(screen.queryByTestId('notify-line')).toBeNull());
        expect(readNotifyAsk(ME.publicKey)).toMatchObject({ laterAt: expect.any(Number) });
        expect(readNotifyAsk(ME.publicKey).phoneNoAt).toBeUndefined();
    });

    it('Turn on in the reminder box where the browser blocks the site: asks nothing, and says where only the browser can undo it', async () => {
        const ask = standBrowser('denied', ME.publicKey);
        render(<EventDetail post={event('a week away', 'going')} identity={ME as any} />);
        fireEvent.click(await screen.findByTestId('event-reminders-turn-on'));
        expect(await screen.findByTestId('event-reminders-said')).toHaveTextContent('Your browser blocked them for this site: allow them from the icon by the address.');
        expect(ask).not.toHaveBeenCalled();
    });

    it('Turn on in the reminder box: the prompt at the tap; once on here, the box is Remind me again', async () => {
        const ask = standBrowser('default', ME.publicKey, 'default');
        render(<EventDetail post={event('a week away', 'going')} identity={ME as any} />);
        fireEvent.click(await screen.findByTestId('event-reminders-turn-on'));
        await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
        // The browser now allows, and this account is on here (what a Turn on leaves): the page reads it again on return.
        (globalThis as any).Notification.permission = 'granted';
        turnedOnHere(ME.publicKey);
        window.dispatchEvent(new Event('focus'));
        await waitFor(() => expect(screen.getByTestId('event-reminder')).toHaveTextContent('Remind me:'));
    });
});

// Keeps the BrowserKind import used where a row names one.
export type _Kinds = BrowserKind;
