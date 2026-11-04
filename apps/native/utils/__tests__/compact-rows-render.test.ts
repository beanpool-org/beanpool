// @vitest-environment jsdom
/**
 * Slice C1 (DESIGN-card-style-box-fable.md §0 item 2, §2 rows "Compact row, event / poll"; Marty, 4 Nov: "and list view in
 * phone - the events dont change", "one style box for every card"): in the Market's compact view an event and a poll are compact
 * rows like a listing's, from the same box. The poll's row names the member's chosen answer with ✓ (none on a sealed poll, where
 * the node cannot say which), and none of its vote controls is on the row: it is one press that opens the poll's page. The
 * phone's event card, tile and row say ENDED where the web's do.
 *
 * The real PollCard, EventCard and style box (components/market-card-shell.ts), each host's style kept, in both themes. Their
 * height at 320 dp x 1.3 is market-card-height-layout.test.ts's (Yoga); the poll's page is post-listing-states-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MARKET_CARD_SHELL, MARKET_CHIP, POLL_BALLOT_SEALED } from '@beanpool/core';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: any) => children }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));
vi.mock('react-native', () => {
    // A press is a <button>, so "no control but the row" can be counted; every host keeps its flattened style.
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, style, numberOfLines, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (disabled) attrs.disabled = true;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        attrs['data-style'] = JSON.stringify(Object.assign({}, ...[style].flat(6).filter((x: unknown) => x && typeof x === 'object')));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), ActivityIndicator: () => null,
        TextInput: ({ testID }: any) => createElement('input', { 'data-testid': testID }),
        Modal: ({ visible, children }: any) => (visible ? createElement('div', null, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: vi.fn() },
    };
});
vi.mock('expo-image', () => ({ Image: ({ source }: { source?: { uri?: string } }) => createElement('img', { 'data-src': source?.uri }) }));
const go = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('expo-router', () => ({ router: { push: (to: unknown) => { go.pushes.push(to); }, back: vi.fn(), replace: vi.fn() } }));
const scheme = vi.hoisted(() => ({ now: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const m: any = await import('../../constants/colors');
    const pick = () => ({ theme: scheme.now, colors: scheme.now === 'dark' ? m.darkColors : m.lightColors });
    return { useTheme: () => pick(), useStyles: (f: any) => f(pick()) };
});
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../db', () => ({
    votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(async () => false), unpinPostOnNode: vi.fn(), getPost: vi.fn(),
    getPollOtherAnswers: vi.fn(async () => ({ state: 'open', count: 0, removed: 0, canRemove: false, answers: [] })),
    reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(), rsvpEvent: vi.fn(), refreshPostForPhoto: vi.fn(),
}));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me' } }) }));
vi.mock('../photo-refresh', () => ({ refreshListingAfterPhotoError: () => false }));
// An owner here, so the card itself would show its ··· (Pin): the row must still have none.
vi.mock('../use-pin-role', () => ({ usePinRole: () => 'owner' }));

import { PollCard } from '../../components/PollCard';
import { EventCard } from '../../components/EventCard';
import { darkColors, lightColors } from '../../constants/colors';

const ME = 'me';
const DAY = 86_400_000;
const poll = (extra: Record<string, unknown> = {}) => ({
    id: 'poll-1', type: 'poll', status: 'active', title: 'What would make trading on BeanPool easier for you?', author_pubkey: ME,
    author_callsign: 'Ana', poll_closes_at: new Date(Date.now() + 11 * DAY + 3_600_000).toISOString(), poll_open_vote: 1, totalVotes: 4,
    pollOptions: [{ id: 'o1', text: 'Better matches between offers and needs', votes: 3 }, { id: 'o2', text: 'More events', votes: 1 }],
    pinnedAt: new Date(Date.now() - 60_000).toISOString(), pinnedUntil: new Date(Date.now() + 2 * DAY).toISOString(),
    ...extra,
});
const event = (extra: Record<string, unknown> = {}) => ({
    id: 'ev-1', type: 'event', status: 'active', title: 'Byron Bay Farmers Market', author_pubkey: 'host', authorCallsign: 'Byron Markets',
    eventStartAt: new Date(Date.now() + DAY).toISOString(), eventEndAt: new Date(Date.now() + DAY + 4 * 3_600_000).toISOString(),
    eventPlaceName: 'Butler Street Reserve', photos: [], goingCount: 3, interestedCount: 1, myRsvp: 'going', ...extra,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    scheme.now = 'light';
    go.pushes.length = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(el: unknown) {
    await act(async () => { root.render(el as Parameters<Root['render']>[0]); await new Promise((r) => setTimeout(r, 0)); });
}
const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');

describe('a poll in the compact view is a compact row that opens its page', () => {
    it('the row: the question, its quiet status, the chosen answer ✓ as its mark, POLL at the end; one press opens the page', async () => {
        const opened = vi.fn();
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'o1' }), currentPubkey: ME, viewMode: 'compact', pinsOn: true, onOpen: opened }));
        const row = byTestId('poll-row-poll-1')!;
        expect(row, 'the row').not.toBeNull();
        expect(byTestId('poll-card'), 'not the card').toBeNull();
        expect(row.textContent).toContain('What would make trading on BeanPool easier for you?');
        expect(byTestId('poll-status')!.textContent).toBe('Closes in 11d');
        // The mark on its own line: the answer (which gives way), then the ✓ (which never does).
        expect(byTestId('poll-mark')!.textContent).toBe('Better matches between offers and needs ✓');
        const [answer, tick] = Array.from(byTestId('poll-mark')!.children);
        expect([answer.textContent, styleOf(answer).flexShrink, answer.getAttribute('data-lines')]).toEqual(['Better matches between offers and needs', 1, '1']);
        expect([tick.textContent, styleOf(tick).flexShrink, tick.getAttribute('data-lines')]).toEqual([' ✓', 0, '1']);
        expect(byTestId('poll-badge')!.textContent).toBe('🗳️ POLL');
        expect(row.getAttribute('aria-label')).toBe('Poll: What would make trading on BeanPool easier for you?, Closes in 11d, Better matches between offers and needs ✓');
        // The box's compact row, its 32 dp picture, the one chip.
        expect(styleOf(row)).toMatchObject({ flexDirection: 'row', borderRadius: MARKET_CARD_SHELL.radius, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 8 });
        expect(styleOf(byTestId('compact-picture'))).toMatchObject({ width: 32, height: 32, borderRadius: 8 });
        expect(styleOf(byTestId('poll-badge'))).toMatchObject({ paddingHorizontal: MARKET_CHIP.paddingHorizontal, borderRadius: MARKET_CHIP.radius, backgroundColor: lightColors.market.poll.bg });
        await act(async () => { row.click(); });
        expect(opened).toHaveBeenCalledTimes(1);
    });

    it('no vote control is reachable from the row: no answer, no Other, no Close Poll, no ···; the row is the only press', async () => {
        // The member's own open poll, pinned, on a community with pins, read by an owner: the card would show all of them.
        await mount(createElement(PollCard, { post: poll(), currentPubkey: ME, viewMode: 'compact', pinsOn: true, onOpen: () => {} }));
        const presses = Array.from(host.querySelectorAll('button'));
        expect(presses.map(b => b.getAttribute('data-testid')), 'one press, the row').toEqual(['poll-row-poll-1']);
        expect(host.textContent).not.toContain('More events');
        expect(host.textContent).not.toContain('Close Poll');
        expect(host.textContent).not.toContain('···');
        expect(byTestId('poll-menu-btn')).toBeNull();
        expect(byTestId('poll-other-box')).toBeNull();
        // Nobody's answer yet: no mark.
        expect(byTestId('poll-mark')).toBeNull();
        // The same poll as the card (list view) has them, so the row's lack of them is the row, not the poll.
        await mount(createElement(PollCard, { post: poll(), currentPubkey: ME, viewMode: 'list', pinsOn: true }));
        expect(byTestId('poll-card')).not.toBeNull();
        expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent?.includes('More events'))).toBe(true);
        expect(host.textContent).toContain('Close Poll');
    });

    it('a sealed poll (anonymous, with Other) names no answer on the row, even one this phone gave', async () => {
        const sealed = poll({
            poll_open_vote: 0, pollAnswered: true,
            pollOptions: [{ id: 'o1', text: 'Buses', votes: 3 }, { id: 'opt_other_ab', text: 'Other', other: true, votes: 2 }],
        });
        for (const vote of [POLL_BALLOT_SEALED, 'o1']) {
            await mount(createElement(PollCard, { post: { ...sealed, userVotedOptionId: vote }, currentPubkey: ME, viewMode: 'compact', onOpen: () => {} }));
            expect(byTestId('poll-row-poll-1'), vote).not.toBeNull();
            expect(byTestId('poll-mark'), vote).toBeNull();
            expect(host.textContent, vote).not.toContain('✓');
            expect(host.textContent, vote).not.toContain('Buses');
        }
    });

    it('a closed poll says Closed, and the chosen answer of an open vote still shows', async () => {
        await mount(createElement(PollCard, { post: poll({ status: 'completed', userVotedOptionId: 'o2' }), currentPubkey: ME, viewMode: 'compact', onOpen: () => {} }));
        expect(byTestId('poll-status')!.textContent).toBe('Closed');
        expect(byTestId('poll-mark')!.textContent).toBe('More events ✓');
    });

    it('the poll card on the box: the shell, padding 12, the box\'s chips (POLL plum, the status quiet), the question 16/900', async () => {
        for (const now of ['light', 'dark'] as const) {
            scheme.now = now;
            const colors = now === 'dark' ? darkColors : lightColors;
            await mount(createElement(PollCard, { post: poll(), currentPubkey: ME, viewMode: 'list', pinsOn: true }));
            const card = byTestId('poll-card')!;
            expect(styleOf(card), now).toMatchObject({
                borderRadius: MARKET_CARD_SHELL.radius, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card,
                padding: MARKET_CARD_SHELL.textPadding, marginBottom: MARKET_CARD_SHELL.gap.list,
            });
            expect(styleOf(byTestId('poll-badge')), now).toMatchObject({ backgroundColor: colors.market.poll.bg, borderRadius: MARKET_CHIP.radius });
            expect(styleOf(byTestId('poll-status')), now).toMatchObject({ backgroundColor: colors.chip.quiet.bg, borderRadius: MARKET_CHIP.radius });
            expect(styleOf(byTestId('pinned-chip')), now).toMatchObject({ backgroundColor: colors.accent.tint });
            for (const id of ['poll-badge', 'poll-status', 'pinned-chip']) {
                expect(styleOf(byTestId(id)!.firstElementChild), `${now} ${id}`).toMatchObject({ fontSize: MARKET_CHIP.type.size, fontWeight: String(MARKET_CHIP.type.weight) });
            }
            const question = Array.from(card.querySelectorAll('span')).find(s => s.textContent === poll().title)!;
            expect(styleOf(question), now).toMatchObject({ fontSize: 16, fontWeight: '900' });
        }
    });
});

describe('an event in the compact view is a compact row', () => {
    it('the row: 32 dp picture, the title, the when, the place, the mark where a listing\'s price sits, EVENT at the end; it opens the event', async () => {
        await mount(createElement(EventCard, { post: event(), currentPubkey: ME, viewMode: 'compact' }));
        const row = byTestId('event-card-ev-1')!;
        expect(styleOf(row)).toMatchObject({ flexDirection: 'row', borderRadius: MARKET_CARD_SHELL.radius, paddingVertical: 10, paddingHorizontal: 12 });
        expect(styleOf(byTestId('compact-picture'))).toMatchObject({ width: 32, height: 32, borderRadius: 8 });
        expect(row.textContent).toContain('Byron Bay Farmers Market');
        expect(byTestId('event-when')!.textContent).toMatch(/\d/);
        expect(byTestId('event-row-place')!.textContent).toContain('📍 Butler Street Reserve');
        expect(byTestId('event-mark')!.textContent).toBe('Going ✓');
        expect(byTestId('event-type-chip')!.textContent).toBe('EVENT');
        expect(styleOf(byTestId('event-type-chip'))).toMatchObject({ backgroundColor: lightColors.tile.event.tint, borderRadius: MARKET_CHIP.radius });
        // The counts are the page's, and the row is the only press.
        expect(row.textContent).not.toContain('going ·');
        expect(Array.from(host.querySelectorAll('button')).map(b => b.getAttribute('data-testid'))).toEqual(['event-card-ev-1']);
        await act(async () => { row.click(); });
        expect(go.pushes).toEqual(['/post/ev-1']);
    });

    it('pinned: 📌 PINNED opens the row\'s place line; the host reads that they are hosting', async () => {
        await mount(createElement(EventCard, {
            post: event({ author_pubkey: ME, myRsvp: null, pinnedAt: new Date(Date.now() - 60_000).toISOString(), pinnedUntil: new Date(Date.now() + DAY).toISOString() }),
            currentPubkey: ME, viewMode: 'compact',
        }));
        expect(byTestId('pinned-chip')!.textContent).toBe('📌 PINNED · ');
        expect(byTestId('event-row-place')!.textContent).toBe('📌 PINNED · 📍 Butler Street Reserve');
        expect(byTestId('event-mark')!.textContent).toBe("You're hosting this event");
    });
});

describe('ENDED on the phone, where the web says it: the list card, the tile and the compact row', () => {
    const ended = event({ eventStartAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), eventEndAt: new Date(Date.now() - 3_600_000).toISOString(), myRsvp: null, goingCount: 0, interestedCount: 0 });

    it.each([['list'], ['grid'], ['compact']] as const)('%s: an event that is over wears ENDED', async (viewMode) => {
        const props = viewMode === 'grid' ? { post: ended, currentPubkey: ME, viewMode, fontScale: 1.3 } : { post: ended, currentPubkey: ME, viewMode };
        await mount(createElement(EventCard, props as never));
        expect(byTestId('event-state-chip')?.textContent ?? '', viewMode).toContain('ENDED');
        expect(byTestId('event-card-ev-1')!.getAttribute('aria-label'), viewMode).toContain('ENDED');
    });

    it('the list card\'s ENDED is the danger chip, light and dark', async () => {
        for (const now of ['light', 'dark'] as const) {
            scheme.now = now;
            await mount(createElement(EventCard, { post: ended, currentPubkey: ME, viewMode: 'list' }));
            const colors = now === 'dark' ? darkColors : lightColors;
            expect(styleOf(byTestId('event-state-chip')), now).toMatchObject({ backgroundColor: colors.feedback.danger.bg });
        }
    });

    it('a cancelled event that is over is CANCELLED, not ENDED; an event still to come wears neither', async () => {
        await mount(createElement(EventCard, { post: { ...ended, eventState: 'cancelled' }, currentPubkey: ME, viewMode: 'list' }));
        expect(byTestId('event-state-chip')!.textContent).toBe('CANCELLED');
        await mount(createElement(EventCard, { post: event(), currentPubkey: ME, viewMode: 'list' }));
        expect(byTestId('event-state-chip')).toBeNull();
    });
});
