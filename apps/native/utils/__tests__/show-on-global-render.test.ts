// @vitest-environment jsdom
/**
 * The tick and the door as the phone draws them (components/ShowOnGlobalRow.tsx, EventCopyDoor.tsx), at the floor: 320 dp
 * wide with the phone's text at 1.3× (memory product-audience-small-screens), in the light and the dark set, laid out by
 * Yoga as utils/__tests__/bring-listings-sheet-render.test.ts lays out its sheet.
 *
 * The tick: nothing is asked of the global community when the composer opens, only at the tap. Off until tapped, and a
 * phone told it is a stranger there gets the door's words, never a join. The global community itself draws none of it.
 * The door: the words and the way through, to the community's own card; by invite, no button that goes nowhere.
 */
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layOut } from './yoga-dom-layout';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const WIDTH = 320;

vi.mock('react-native', () => {
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, testID, style, accessibilityState, accessibilityHint, disabled, keyboardShouldPersistTaps } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(accessibilityState.checked);
        if (accessibilityState?.busy !== undefined) attrs['aria-busy'] = String(accessibilityState.busy);
        if (accessibilityHint) attrs['data-a11y-hint'] = accessibilityHint;
        if (keyboardShouldPersistTaps) attrs['data-taps'] = keyboardShouldPersistTaps;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
        View: el('div'), Text: el('span'), Pressable: el('div'), ScrollView: el('div'),
        Alert: { alert: (...args: unknown[]) => (globalThis as any).__alerts.push(args) },
    };
});
(globalThis as any).__alerts = [];
const theme = vi.hoisted(() => ({ colors: null as any, scheme: 'light' }));
vi.mock('../../app/ThemeContext', () => ({
    useStyles: (make: (t: unknown) => unknown) => make({ theme: theme.scheme, colors: theme.colors }),
}));
const world = vi.hoisted(() => ({
    identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any,
    kept: 'unknown' as string,
    answer: 'member' as string,
    pushed: [] as string[],
}));
const calls = vi.hoisted(() => ({ ask: vi.fn(), show: vi.fn(), pair: vi.fn(async (): Promise<unknown> => null), stop: vi.fn(), take: vi.fn(), noted: vi.fn(), openChat: vi.fn(), signed: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: world.identity }) }));
vi.mock('expo-router', () => ({ router: { push: (r: string) => world.pushed.push(r) } }));
vi.mock('../node-post', () => ({ anchorUrl: async () => 'https://mullum.example.org' }));
vi.mock('../global-entry', () => ({ readGlobalStanding: async () => world.kept, askGlobalStanding: calls.ask }));
vi.mock('../db', () => ({ deletePost: vi.fn(), reportAbuse: vi.fn(), createConversationApi: calls.openChat, signedRequest: calls.signed }));
vi.mock('../global-requests', () => ({ noteQuestionsOpened: calls.noted }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children, behavior }: { children?: unknown; behavior?: string }) => createElement('div', { 'data-kav': behavior }, children as any),
    KeyboardAwareScrollView: ({ children, keyboardShouldPersistTaps }: { children?: unknown; keyboardShouldPersistTaps?: string }) => createElement('div', { 'data-kav': 'scroll', 'data-taps': keyboardShouldPersistTaps }, children as any),
}));
vi.mock('../../components/PhotoCarousel', () => ({ PhotoCarousel: () => null }));
vi.mock('../../components/PostTagChips', () => ({ PostTagChips: () => null }));
vi.mock('../../components/ReportReasonBox', () => ({ ReportReasonBox: () => null }));
vi.mock('../show-on-global', () => ({ copyResultLine: () => null, pairOf: calls.pair, showOnGlobal: calls.show, stopShowing: calls.stop, stopLaterLine: () => 'It comes down later', takeQuestions: calls.take, questionsLaterLine: () => 'It stops later' }));

import { listingCopyHint, setLanguage } from '@beanpool/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EventCopyDoor } from '../../components/EventCopyDoor';
import { ListingCopyDetail } from '../../components/ListingCopy';
import { ListingCopyLine } from '../../components/ListingCopyLine';
import { ShowOnGlobalHostRow, ShowOnGlobalTick, TakeQuestionsTick, listingForCopy, showEventOnGlobal, showOnGlobalHint, useTakeQuestionsTick } from '../../components/ShowOnGlobalRow';
import { darkColors, lightColors } from '../../constants/colors';
import { deletePost } from '../db';

const LONG_NAME = 'Mullumbimby and the Brunswick Valley Community Exchange';
const FROM = { host: 'mullum.example.org', postId: 'p1', name: LONG_NAME, url: 'https://mullum.example.org', door: 'ask' as const };

let host: HTMLElement;
let root: Root | null = null;
const realFetch = globalThis.fetch;
const fetched = vi.fn();

async function draw(node: ReactNode): Promise<void> {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
        root = createRoot(host);
        root.render(createElement('div', { 'data-style': JSON.stringify({ width: WIDTH }), 'data-testid': 'floor' }, node as any) as any);
    });
    await settle();
}
/** The row loads what it runs on when it shows: a dynamic import, a few turns. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = async (id: string) => {
    await act(async () => { byId(id)!.click(); });
    await settle();
};

beforeEach(() => {
    theme.colors = lightColors;
    theme.scheme = 'light';
    world.kept = 'unknown';
    world.answer = 'member';
    world.pushed = [];
    (globalThis as any).__alerts.length = 0;
    fetched.mockClear();
    globalThis.fetch = fetched as unknown as typeof fetch;
    calls.ask.mockReset();
    calls.ask.mockImplementation(async () => ({ standing: world.answer, closed: false, answered: true }));
    calls.pair.mockReset();
    calls.pair.mockImplementation(async () => null);
    calls.stop.mockReset();
    calls.take.mockReset();
    calls.noted.mockReset();
    calls.openChat.mockReset();
    calls.signed.mockReset();
    calls.show.mockReset();
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
});

describe('the tick', () => {
    it('opening the composer asks the global community nothing; the tap does', async () => {
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        expect(byId('show-on-global-tick')!.getAttribute('aria-checked')).toBe('false');
        expect(calls.ask).not.toHaveBeenCalled();
        expect(fetched).not.toHaveBeenCalled();
        await press('show-on-global-tick');
        expect(calls.ask).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([true]);
    });

    it('told it is a stranger there: the door\'s words, and never a join by itself', async () => {
        world.answer = 'stranger';
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        expect(changes).toEqual([]);
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-join')!.textContent).toContain('Join the global community to show this there');
        expect(world.pushed).toEqual([]);
    });

    it('no answer: said, and left off', async () => {
        world.answer = 'unknown';
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        expect(changes).toEqual([]);
        expect((globalThis as any).__alerts).toHaveLength(1);
    });

    it('none where the screen rules it out: the global community itself, online, a group, an enterprise', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: false, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-join')).toBeNull();
    });

    it('a tick the form has moved off clears itself: ticked, then Online, a group or another host, it does not go with the event', async () => {
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: false, checked: true, onChange: (next: boolean) => changes.push(next) }));
        expect(changes).toEqual([false]);
    });

    it('an online event says why there is no tick', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: false, online: true, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')).toBeNull();
        expect(byId('show-on-global-online')?.textContent).toBe("Online events can't be shown on the global community yet.");
    });

    /** The tap's question, held until the test answers it: a signed call of up to 6 s, the first time slower than the form. */
    const heldAnswer = () => {
        let answer!: (standing: string) => void;
        const held = new Promise<{ standing: string; closed: boolean; answered: boolean }>((resolve) => {
            answer = (standing) => resolve({ standing, closed: false, answered: true });
        });
        calls.ask.mockImplementation(() => held);
        return answer;
    };

    it('while the tap is asking the row says so and takes no second tap, and the answer frees it', async () => {
        const answer = heldAnswer();
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('false');
        await press('show-on-global-tick');
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('true');
        expect(JSON.parse(byId('show-on-global-tick')!.getAttribute('data-style')!).opacity).toBeLessThan(1);
        await press('show-on-global-tick');
        expect(calls.ask).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([]);

        await act(async () => { answer('member'); });
        await settle();
        expect(changes).toEqual([true]);
        expect(byId('show-on-global-tick')!.getAttribute('aria-busy')).toBe('false');
    });

    it.each([['member', 'ticks'], ['unknown', 'raises an alert']])('an answer of "%s" landing after the form has closed %s nothing: the next event opens off', async (standing) => {
        const answer = heldAnswer();
        const changes: boolean[] = [];
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: (v: boolean) => changes.push(v) }));
        await press('show-on-global-tick');
        // The sheet closed: the row has gone, and the form behind it, which outlives the sheet, still holds its setter.
        await act(async () => { root?.unmount(); });
        root = null;

        await act(async () => { answer(standing); });
        await settle();
        expect(changes).toEqual([]);
        expect((globalThis as any).__alerts).toHaveLength(0);
    });

    it('a screen reader hears what the tick makes public: the label replaces the row\'s words, so the consent line is the hint', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-tick')!.getAttribute('data-a11y-hint')).toBe(showOnGlobalHint());
    });
});

describe.each([['light', lightColors], ['dark', darkColors]] as const)('at 320 dp × 1.3, %s', (scheme, colors) => {
    beforeEach(() => {
        theme.colors = colors;
        theme.scheme = scheme;
    });

    it('the tick holds in the width, a target of at least 44 dp', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: true, onChange: () => {} }));
        const layout = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 });
        const box = layout.box(byId('show-on-global-tick')!);
        expect(box.left + box.width).toBeLessThanOrEqual(WIDTH);
        expect(box.height).toBeGreaterThanOrEqual(44);
    });

    it('the door holds in the width, its button at least 48 dp, and it opens the community\'s own card', async () => {
        await draw(createElement(EventCopyDoor, { copy: { from: FROM } }));
        const layout = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 });
        const button = layout.box(byId('event-copy-ask')!);
        expect(button.left + button.width).toBeLessThanOrEqual(WIDTH);
        expect(button.height).toBeGreaterThanOrEqual(48);
        expect(byId('event-copy-door')!.textContent).toContain(`To go, ask to join ${LONG_NAME}`);
        await press('event-copy-ask');
        // With the listing at home the copy stands for, so a request sent from the card lands the member on it (slice G4).
        expect(world.pushed).toEqual([`/community-card?node=${encodeURIComponent(FROM.url)}&listing=${encodeURIComponent(FROM.postId!)}`]);
    });
});

describe('Stop showing, on the host\'s page', () => {
    const EVENT = { id: 'e1', title: 'Street party' };
    const shownRow = () => draw(createElement(ShowOnGlobalHostRow, { event: EVENT, enabled: true }));

    beforeEach(() => {
        calls.pair.mockImplementation(async () => ({ copyId: 'c1' }));
    });

    it('a stop that reached global says nothing, and the row goes back to the offer', async () => {
        calls.stop.mockImplementation(async () => { calls.pair.mockImplementation(async () => null); return true; });
        await shownRow();
        expect(host.textContent).toContain('Stop showing');
        await press('show-on-global-act');
        expect(calls.stop).toHaveBeenCalledTimes(1);
        expect((globalThis as any).__alerts).toEqual([]);
        expect(host.textContent).not.toContain('Stop showing');
    });

    it('a stop that didn\'t reach global is said once, in the words layer, though the row can\'t show it', async () => {
        // takeDown marks the pair leaving, pairOf then skips it, and the row reads as if it had come down.
        calls.stop.mockImplementation(async () => { calls.pair.mockImplementation(async () => null); return false; });
        await shownRow();
        await press('show-on-global-act');
        expect((globalThis as any).__alerts).toEqual([['Also show this on the global community', 'It comes down later']]);
        expect(host.textContent).not.toContain('Stop showing');
    });

    it('resting for a holiday at home, the row says so and doesn\'t call it shown, and Stop showing stays on offer', async () => {
        calls.pair.mockImplementation(async () => ({ copyId: 'c1', resting: true }));
        await shownRow();
        expect(host.textContent).toContain("It comes down while you're on holiday, and goes back up when you're back.");
        expect(host.textContent).not.toContain('Shown on the global community');
        expect(host.textContent).toContain('Stop showing');
        calls.pair.mockImplementation(async () => ({ copyId: 'c1', resting: false }));
        calls.stop.mockImplementation(async () => false);
        await press('show-on-global-act');
        expect(host.textContent).toContain('Shown on the global community');
    });

    it('while it runs the row dims, says so and takes no second tap, and the answer frees it', async () => {
        let finish!: (done: boolean) => void;
        calls.stop.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        await shownRow();
        const action = () => byId('show-on-global-act')!;
        expect(action().getAttribute('aria-busy')).toBe('false');
        expect(JSON.parse(action().getAttribute('data-style')!).opacity).toBeUndefined();
        await press('show-on-global-act');
        expect(action().getAttribute('aria-busy')).toBe('true');
        expect(JSON.parse(action().getAttribute('data-style')!).opacity).toBeLessThan(1);
        await press('show-on-global-act');
        expect(calls.stop).toHaveBeenCalledTimes(1);

        await act(async () => { finish(true); });
        await settle();
        expect(action().getAttribute('aria-busy')).toBe('false');
        expect(JSON.parse(action().getAttribute('data-style')!).opacity).toBeUndefined();
    });

    it('showing from the page dims the same way', async () => {
        calls.pair.mockImplementation(async () => null);
        const answer = (() => {
            let resolve!: (v: unknown) => void;
            calls.ask.mockImplementation(() => new Promise((r) => { resolve = r; }));
            return (standing: string) => resolve({ standing, closed: false, answered: true });
        })();
        await shownRow();
        await press('show-on-global-act');
        expect(JSON.parse(byId('show-on-global-act')!.getAttribute('data-style')!).opacity).toBeLessThan(1);
        await act(async () => { answer('unknown'); });
        await settle();
    });
});

describe('the door', () => {
    it('by invite, and with no row: the words, and no button that goes nowhere', async () => {
        await draw(createElement(EventCopyDoor, { copy: { from: { ...FROM, door: 'invite' as const } } }));
        expect(byId('event-copy-door')!.textContent).toContain('It takes new members by invite');
        expect(byId('event-copy-ask')).toBeNull();
        await draw(createElement(EventCopyDoor, { copy: { from: null } }));
        expect(byId('event-copy-ask')).toBeNull();
    });
});

describe('a copy of an Offer or a Need', () => {
    const POST = { id: 'c1', type: 'offer', title: 'Sourdough loaves', description: 'Fresh', author_pubkey: 'hidden', photos: '[]', tags: '', shownCopy: true, shownFrom: FROM, shownPrice: '2000 fixed' };
    const LINE = `20 Beans in ${LONG_NAME} · You can't buy or take this until ${LONG_NAME} welcomes you.`;

    it.each([['light', lightColors], ['dark', darkColors]])('the card\'s line stays inside 320 dp at 1.3× text, %s', async (scheme, colors) => {
        theme.scheme = scheme;
        theme.colors = colors;
        await draw(createElement(ListingCopyLine, { copy: { from: FROM, price: { price_c: 2000, per: 'fixed' } } }));
        const line = byId('listing-copy-line')!;
        expect(line.textContent).toBe(LINE);
        const box = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 }).box(line);
        expect(box.left + box.width).toBeLessThanOrEqual(WIDTH);
        expect(box.height).toBeGreaterThan(0);
    });

    it('the page: the line and the door, and no price card, no author, no Message, no Accept', async () => {
        await draw(createElement(ListingCopyDetail, { post: POST }));
        const page = byId('listing-copy')!;
        expect(byId('event-copy-door')!.textContent).toContain(LINE);
        // The home price in whole hundredths (2000): 20 Beans, never a hundredth read as a Bean ("0.20 Beans" holds LINE too).
        expect(byId('event-copy-door')!.textContent).not.toContain('0.20 Beans');
        expect(byId('event-copy-ask')!.textContent).toContain(`Ask to join ${LONG_NAME}`);
        await press('event-copy-ask');
        expect(world.pushed).toHaveLength(1);
        expect(world.pushed[0]).toContain('community-card');
        expect(page.textContent).not.toMatch(/Accept|Message|I can do this|Ask to borrow|POSTED BY|ASKING PRICE|hidden/);
        expect(byId('listing-copy-report')).not.toBeNull();
    });

    it('a Need\'s page says it can\'t be answered yet, not bought', async () => {
        await draw(createElement(ListingCopyDetail, { post: { ...POST, type: 'need' } }));
        expect(byId('event-copy-door')!.textContent).toContain(`20 Beans in ${LONG_NAME} · You can't answer this until ${LONG_NAME} welcomes you.`);
        expect(byId('event-copy-door')!.textContent).not.toContain('buy or take');
    });

    it('the report box stays above the keyboard, and with the keyboard up the first tap on Send lands: the same as EventDetail', async () => {
        await draw(createElement(ListingCopyDetail, { post: POST }));
        const kav = host.querySelector('[data-kav]')!;
        expect(kav).not.toBeNull();
        // The scroll view itself (the library's KeyboardAwareScrollView) scrolls the words box above the keyboard.
        expect(kav.getAttribute('data-kav')).toBe('scroll');
        expect(kav.contains(byId('listing-copy-report'))).toBe(true);
        expect(kav.getAttribute('data-taps')).toBe('handled');
    });

    it('by invite: the line, the door\'s words, and no button that goes nowhere', async () => {
        await draw(createElement(ListingCopyDetail, { post: { ...POST, shownFrom: { ...FROM, door: 'invite' } } }));
        expect(byId('event-copy-ask')).toBeNull();
        expect(byId('listing-copy-from')!.textContent).toContain(`from ${LONG_NAME}`);
    });

    it('its own author reads it as theirs: what they can do is take it down, and nothing offers them a door', async () => {
        await draw(createElement(ListingCopyDetail, { post: { ...POST, author_pubkey: world.identity.publicKey } }));
        expect(byId('listing-copy-own')).not.toBeNull();
        expect(byId('event-copy-door')).toBeNull();
        expect(byId('listing-copy-report')).toBeNull();
    });

    it('a double tap on Stop showing asks once', async () => {
        const remove = vi.mocked(deletePost);
        remove.mockReset();
        remove.mockImplementation(() => new Promise(() => {}) as any);
        await draw(createElement(ListingCopyDetail, { post: { ...POST, author_pubkey: world.identity.publicKey } }));
        await press('listing-copy-remove');
        await press('listing-copy-remove');
        expect(remove).toHaveBeenCalledTimes(1);
        remove.mockReset();
    });

    it('the tick says what goes of a listing, not of an event', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {}, listing: true }));
        expect(byId('show-on-global-tick')!.textContent).toContain(listingCopyHint());
        expect(byId('show-on-global-tick')!.textContent).not.toContain('Not your name');
        expect(byId('show-on-global-tick')!.textContent).not.toContain('your note');
    });

    it('a Need\'s tick says it is answered, on the composer and on its page; an Offer\'s is as it was (the control)', async () => {
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {}, listing: true, need: true }));
        expect(byId('show-on-global-tick')!.textContent).toContain('To answer it, they ask to join.');
        expect(byId('show-on-global-tick')!.textContent).not.toContain('buy or take');
        calls.pair.mockImplementation(async () => null);
        await draw(createElement(ShowOnGlobalHostRow, { event: { id: 'h', title: 'T', type: 'need', status: 'active' }, enabled: true, listing: true }));
        expect(byId('show-on-global-host')!.textContent).toContain('To answer it, they ask to join.');
        await draw(createElement(ShowOnGlobalHostRow, { event: { id: 'h', title: 'T', type: 'offer', status: 'active' }, enabled: true, listing: true }));
        expect(byId('show-on-global-host')!.textContent).toContain('To buy or take it, they ask to join.');
    });

    it('a member not yet on global hears of the listing\'s page on an Offer or Need, and of the event\'s on an event', async () => {
        world.kept = 'stranger';
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {}, listing: true }));
        expect(byId('show-on-global-join')!.textContent).toContain("You can show it from the listing's page once you have.");
        expect(byId('show-on-global-join')!.textContent).not.toContain('event');
        await draw(createElement(ShowOnGlobalTick, { enabled: true, checked: false, onChange: () => {} }));
        expect(byId('show-on-global-join')!.textContent).toContain("You can show it from the event's page once you have.");
    });

    describe('off the board here, the host\'s page offers nothing', () => {
        const row = (status: string) => draw(createElement(ShowOnGlobalHostRow, { event: { id: 'h', title: 'T', type: 'offer', status }, enabled: true, listing: true }));

        it.each(['paused', 'pending'])('%s: no offer, and nothing to tap', async (status) => {
            calls.pair.mockImplementation(async () => null);
            await row(status);
            expect(byId('show-on-global-host')).toBeNull();
            expect(byId('show-on-global-act')).toBeNull();
        });

        it.each(['paused', 'pending'])('%s with a copy resting: it says so, and Stop showing stays', async (status) => {
            calls.pair.mockImplementation(async () => ({ copyId: 'c1', resting: true }));
            await row(status);
            expect(host.textContent).toContain("It comes down while this is off the board here, and goes back up when it's on again.");
            expect(host.textContent).toContain('Stop showing');
        });

        it('on the board, the offer (the control)', async () => {
            calls.pair.mockImplementation(async () => null);
            await row('active');
            expect(byId('show-on-global-act')!.textContent).toContain('Also show this on the global community');
        });

        it('an event isn\'t held to a listing\'s status (the control)', async () => {
            calls.pair.mockImplementation(async () => null);
            await draw(createElement(ShowOnGlobalHostRow, { event: { id: 'e', title: 'T', status: 'pending' }, enabled: true }));
            expect(byId('show-on-global-act')).not.toBeNull();
        });
    });

    it('the row the phone holds reads as show-on-global reads a listing', () => {
        expect(listingForCopy({ id: 'h', type: 'need', category: 'food', title: 'T', description: 'D', price_c: 500, price_type: 'hourly', author_pubkey: 'k', lat: 1, lng: 2, tags: 'food.eggs', free_tags: '', status: 'paused' }, ['/p/0']))
            .toMatchObject({ id: 'h', type: 'need', price_c: 500, priceType: 'hourly', authorPublicKey: 'k', audienceScope: 'public', lat: 1, lng: 2, photos: ['/p/0'], tags: ['food.eggs'], status: 'paused' });
    });
});

describe('the door on a copy (slice GD)', () => {
    const KEY = 'ef'.repeat(32);
    const LABEL = 'Take questions about this on the global community';
    const OPEN = { id: 'c1', type: 'offer', title: 'Sourdough loaves', description: 'Fresh', author_pubkey: KEY, author_callsign: 'Robin Sellerton of the Valley', photos: '[]', tags: '', shownCopy: true, shownFrom: FROM, shownPrice: '2000 fixed', takesQuestions: true };
    const SHUT = { ...OPEN, author_pubkey: 'hidden', author_callsign: '', takesQuestions: undefined };
    const EVENT = { id: 'home-1', title: 'Loaves', authorPublicKey: world.identity.publicKey };

    describe('the tick', () => {
        it.each([['light', lightColors], ['dark', darkColors]])('holds in 320 dp at 1.3× text, %s, a target of at least 44 dp', async (scheme, colors) => {
            theme.scheme = scheme;
            theme.colors = colors;
            await draw(createElement(TakeQuestionsTick, { checked: false, onChange: () => {} }));
            const tick = byId('take-questions-tick')!;
            expect(tick.textContent).toContain(LABEL);
            const box = layOut(byId('floor')!, { width: WIDTH, height: 568 }, { fontScale: 1.3 }).box(tick);
            expect(box.left + box.width).toBeLessThanOrEqual(WIDTH);
            expect(box.height).toBeGreaterThanOrEqual(44);
        });

        it('a screen reader hears what it makes public', async () => {
            await draw(createElement(TakeQuestionsTick, { checked: false, onChange: () => {} }));
            expect(byId('take-questions-tick')!.getAttribute('data-a11y-hint')).toContain('will see your name');
        });

        it('the host\'s page draws none on a listing that isn\'t shown, none on an event, and it asks nobody', async () => {
            await draw(createElement(ShowOnGlobalHostRow, { event: EVENT as any, enabled: true, listing: true }));
            expect(byId('take-questions-tick')).toBeNull();
            calls.pair.mockImplementation(async () => ({ copyId: 'c1' }));
            await draw(createElement(ShowOnGlobalHostRow, { event: EVENT as any, enabled: true }));
            expect(byId('take-questions-tick')).toBeNull();
            expect(fetched).not.toHaveBeenCalled();
        });

        it('shown, the page offers it off; the tap opens it, and marks this phone as having asked', async () => {
            calls.pair.mockImplementation(async () => ({ copyId: 'c1' }));
            calls.take.mockImplementation(async () => { calls.pair.mockImplementation(async () => ({ copyId: 'c1', questions: true })); return 'shown'; });
            await draw(createElement(ShowOnGlobalHostRow, { event: EVENT as any, enabled: true, listing: true }));
            expect(byId('take-questions-tick')!.getAttribute('aria-checked')).toBe('false');
            await press('take-questions-tick');
            expect(calls.take).toHaveBeenCalledWith('home-1', true, world.identity);
            expect(calls.noted).toHaveBeenCalledWith(world.identity.publicKey);
            expect(byId('take-questions-tick')!.getAttribute('aria-checked')).toBe('true');
        });

        it('an Off that didn\'t land is said once, in words, and the tick still says what the member asked for', async () => {
            calls.pair.mockImplementation(async () => ({ copyId: 'c1', questions: true }));
            calls.take.mockImplementation(async () => { calls.pair.mockImplementation(async () => ({ copyId: 'c1', questions: false, questionsOwed: true })); return 'later'; });
            await draw(createElement(ShowOnGlobalHostRow, { event: EVENT as any, enabled: true, listing: true }));
            await press('take-questions-tick');
            expect(calls.take).toHaveBeenCalledWith('home-1', false, world.identity);
            expect(calls.noted).not.toHaveBeenCalled();
            expect((globalThis as any).__alerts).toEqual([[LABEL, 'It stops later']]);
            expect(byId('take-questions-tick')!.getAttribute('aria-checked')).toBe('false');
        });

        it('a refusal says global\'s own words', async () => {
            calls.pair.mockImplementation(async () => ({ copyId: 'c1' }));
            calls.take.mockImplementation(async () => ({ refused: 'Not while muted.' }));
            await draw(createElement(ShowOnGlobalHostRow, { event: EVENT as any, enabled: true, listing: true }));
            await press('take-questions-tick');
            expect((globalThis as any).__alerts).toEqual([[LABEL, 'Not while muted.']]);
        });

        it('the composer\'s tick goes with the listing, and a plain one sends none and marks nothing', async () => {
            calls.show.mockImplementation(async () => 'shown');
            await showEventOnGlobal({ id: 'home-1' } as any, world.identity);
            expect(calls.show.mock.calls[0][4]).toBe(false);
            expect(calls.noted).not.toHaveBeenCalled();
            await showEventOnGlobal({ id: 'home-1' } as any, world.identity, true);
            expect(calls.show.mock.calls[1][4]).toBe(true);
            expect(calls.noted).toHaveBeenCalledWith(world.identity.publicKey);
        });
    });

    describe('the copy\'s page', () => {
        it('door off: no name, no way to write, as before', async () => {
            await draw(createElement(ListingCopyDetail, { post: SHUT }));
            expect(byId('listing-copy-ask')).toBeNull();
            expect(host.textContent).not.toContain('Robin');
        });

        it('a stale row that says it takes questions and names nobody draws no door', async () => {
            await draw(createElement(ListingCopyDetail, { post: { ...SHUT, takesQuestions: true } }));
            expect(byId('listing-copy-ask')).toBeNull();
        });

        it.each([['light', lightColors], ['dark', darkColors]])('door on: the name and one way to write, in 320 dp at 1.3× text, %s', async (scheme, colors) => {
            theme.scheme = scheme;
            theme.colors = colors;
            await draw(createElement(ListingCopyDetail, { post: OPEN }));
            const ask = byId('listing-copy-ask')!;
            expect(ask.textContent).toContain('Robin Sellerton of the Valley takes questions about this');
            const laid = layOut(byId('floor')!, { width: WIDTH, height: 900 }, { fontScale: 1.3 });
            expect(laid.box(ask).left + laid.box(ask).width).toBeLessThanOrEqual(WIDTH);
            expect(laid.box(byId('listing-copy-ask-button')!).height).toBeGreaterThanOrEqual(44);
        });

        it('door on, still no deal: the price stays words and the door stays the community\'s', async () => {
            await draw(createElement(ListingCopyDetail, { post: OPEN }));
            expect(byId('event-copy-door')).not.toBeNull();
            expect(host.textContent).not.toMatch(/Accept|Request|Pay/);
        });

        it('the button opens a chat with the key on the row, for no post: a request is a chat with nothing of a deal', async () => {
            calls.openChat.mockImplementation(async () => ({ id: 'conv-1' }));
            await draw(createElement(ListingCopyDetail, { post: OPEN }));
            await press('listing-copy-ask-button');
            expect(calls.openChat).toHaveBeenCalledWith('dm', [KEY, world.identity.publicKey], world.identity.publicKey);
            expect(world.pushed).toEqual(['/chat/conv-1']);
        });

        it('the chat refused because reports cleared their message requests (R1): said in the member\'s language, dated, not in the node\'s English', async () => {
            const LIMITED = "People you wrote to reported your message requests, so they were cleared and you can't send new ones until 2026-11-08. You can still answer people who wrote to you, and post.";
            const es = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../packages/beanpool-core/words/es.json'), 'utf8'));
            calls.openChat.mockImplementation(async () => { throw Object.assign(new Error(LIMITED), { code: 'dm_requests_limited' }); });
            await draw(createElement(ListingCopyDetail, { post: OPEN }));
            setLanguage('es', [es]);
            try {
                await press('listing-copy-ask-button');
                expect((globalThis as any).__alerts.at(-1)?.[1]).toBe('Personas a las que escribiste denunciaron tus solicitudes de mensaje, así que se borraron y no puedes enviar nuevas hasta el 2026-11-08. Todavía puedes responder a quienes te escribieron y publicar.');
            } finally { setLanguage('en'); }
        });

        it('its author has no ask, and can stop from here: a new phone holds no pair to untick', async () => {
            await draw(createElement(ListingCopyDetail, { post: { ...OPEN, author_pubkey: world.identity.publicKey } }));
            expect(byId('listing-copy-ask')).toBeNull();
            await press('listing-copy-stop-questions');
            expect(calls.signed).toHaveBeenCalledWith('/api/marketplace/posts/takes-questions', { id: 'c1', on: false });
            expect(byId('listing-copy-stop-questions')).toBeNull();
        });

        it('a shut copy offers its author nothing to stop', async () => {
            await draw(createElement(ListingCopyDetail, { post: { ...SHUT, author_pubkey: world.identity.publicKey } }));
            expect(byId('listing-copy-stop-questions')).toBeNull();
        });
    });
});

describe('a listing from the phone\'s own row', () => {
    const ROW = { id: 'home-1', type: 'offer', title: 'Loaves', author_pubkey: 'ab'.repeat(32), tags: '', lat: -28.6, lng: 153.5, status: 'active' };
    const PATH = '/api/marketplace/posts/home-1/photos/0?v=abc';

    it('hands a copy the node\'s own path, whatever address the page put in front for the carousel', async () => {
        const home = listingForCopy(ROW, [`https://mullum.beanpool.org${PATH}`, `http://localhost:8080${PATH}`]);
        expect(home.photos).toEqual([PATH, PATH]);
        const { photosOf } = await import('@beanpool/core');
        const fetchPhoto = vi.fn(async () => ({ photo: 'data:image/png;base64,iVBORw0KGgo=' }));
        const { photos, missed } = await photosOf(home, 'https://mullum.beanpool.org', { fetchPhoto });
        expect(fetchPhoto).toHaveBeenCalledWith(`https://mullum.beanpool.org${PATH}`);
        expect({ sent: photos.length, missed }).toEqual({ sent: 2, missed: 0 });
    });

    it('leaves what is already a path, and a phone\'s own file, as they are', () => {
        expect(listingForCopy(ROW, [PATH, 'file:///data/a.jpg']).photos).toEqual([PATH, 'file:///data/a.jpg']);
    });
});

describe('the door\'s tick in a form', () => {
    let flip: (on: boolean) => void = () => {};
    let seen: boolean[] = [];
    let show: (on: boolean) => void = () => {};
    function Form() {
        const [shown, setShown] = useState(true);
        const [on, setOn] = useTakeQuestionsTick(shown);
        show = setShown;
        flip = setOn;
        seen.push(on);
        return null;
    }
    const last = () => seen[seen.length - 1];

    it('starts off, and is never found ticked on the next listing: a post made, or the form moved away, clears it', async () => {
        seen = [];
        await draw(createElement(Form));
        expect(last()).toBe(false);
        await act(async () => { flip(true); });
        expect(last()).toBe(true);
        // The same mounted form, as a post made leaves it: only the hook can take the tick off.
        await act(async () => { show(false); });
        expect(last()).toBe(false);
        await act(async () => { show(true); });
        expect(last()).toBe(false);
    });
});

