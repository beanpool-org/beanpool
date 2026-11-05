// @vitest-environment jsdom
/**
 * The poll in the phone's Market GRID (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want
 * 2 wide with heaps of space"): a row of its own at a TILE row's height (a tile's box drawn invisible in the row: the card's
 * border, the 4:3 photo at the cell's width, the text block at the phone's font scale), the summary laid over it, one button
 * that opens the poll's page. The answers that fit the measured room, then "+N more"; the card's own ✓, a sealed poll's
 * "You answered ✓", a closed poll's "Closed · 3 votes" and "See results ›". Rendered with react-dom, React Native stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MARKET_CARD_SHELL, gridTextBlockHeight } from '@beanpool/core';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Each View's onLayout, by its testID, so a test can lay out the answers' room. */
const layouts = vi.hoisted(() => new Map<string, (e: unknown) => void>());
/** Each Text's onTextLayout, by its words, so a test can lay out an answer's words at its row's width. */
const textLayouts = vi.hoisted(() => new Map<string, (e: unknown) => void>());
type Props = {
    children?: ReactNode; testID?: string; accessibilityLabel?: string; accessibilityRole?: string; onPress?: () => void; style?: unknown;
    numberOfLines?: number; onLayout?: (e: unknown) => void; onTextLayout?: (e: unknown) => void; disabled?: boolean; accessibilityState?: Record<string, unknown>;
    importantForAccessibility?: string;
};
vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => (typeof s === 'function' ? flat(s({ pressed: false }))
        : Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : (s && typeof s === 'object' ? s as Record<string, unknown> : {}));
    const el = (tag: string) => ({ children, testID, accessibilityLabel, accessibilityRole, onPress, style, numberOfLines, onLayout, onTextLayout, disabled, accessibilityState, importantForAccessibility }: Props) => {
        if (testID && onLayout) layouts.set(testID, onLayout);
        if (onTextLayout) textLayouts.set(String(children), onTextLayout);
        return createElement(tag, {
            'data-testid': testID, 'aria-label': accessibilityLabel, 'data-role': accessibilityRole, onClick: onPress,
            'data-style': JSON.stringify(flat(style)), 'data-lines': numberOfLines, disabled,
            'data-state': accessibilityState ? JSON.stringify(accessibilityState) : undefined,
            // Out of sight and never read out (an answer's words measured unclamped): not what the member sees.
            'data-unseen': importantForAccessibility === 'no' ? 'true' : undefined,
        }, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null, Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s },
        // utils/keyboard-alert.ts asks whether a keyboard is up before it opens the card's Alert: none is, here.
        Keyboard: { isVisible: () => false, dismiss: () => {}, addListener: () => ({ remove() {} }) },
    };
});
const colours = new Proxy({}, { get: () => new Proxy({}, { get: () => '#000' }) });
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: colours, theme: 'light' }),
    useStyles: (make: (t: unknown) => unknown) => make({ colors: colours, theme: 'light' }),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../../components/PinSheet', () => ({ PinSheet: () => null }));
vi.mock('../db', () => ({ votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(), unpinPostOnNode: vi.fn(), getPost: vi.fn() }));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../use-pin-role', () => ({ usePinRole: () => null }));

import { PollGridTile } from '../../components/PollGridTile';
import { Alert } from 'react-native';
import { votePoll } from '../db';

const DAY = 86_400_000;
const four = [
    { id: 'a', text: 'Better matches with what people need', votes: 1, percentage: 100 },
    { id: 'b', text: 'Faster responses when I post an offer', votes: 0, percentage: 0 },
    { id: 'c', text: 'A clearer idea of what beans are worth', votes: 0, percentage: 0 },
    { id: 'd', text: "Not sure yet. I'm still finding my feet", votes: 0, percentage: 0 },
];
const poll = (extra: Record<string, unknown> = {}) => ({
    id: 'poll_grid', type: 'poll', title: 'What would make trading with beans easier for you?', author_pubkey: 'damo', author_callsign: 'Damo (The IT guy)',
    status: 'active', poll_closes_at: new Date(Date.now() + 10 * DAY + 3_600_000).toISOString(), poll_open_vote: 0, totalVotes: 1, pollOptions: four, ...extra,
});

let host: HTMLDivElement;
let root: Root;
const mount = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}');
/** The answers' room is laid out this tall. */
const layOut = async (height: number) => { await act(async () => { layouts.get('poll-grid-answers')!({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height } } }); }); };
/** What the member sees of an element: its words, less what is drawn out of sight. */
const seen = (el: Element) => { const c = el.cloneNode(true) as Element; c.querySelectorAll('[data-unseen]').forEach(x => x.remove()); return c.textContent; };
const answers = () => [...all('poll-grid-answer'), ...all('poll-grid-answer-chosen')].map(seen);

beforeEach(() => {
    layouts.clear();
    textLayouts.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('the phone grid\'s poll row', () => {
    it.each([1, 1.3])('is a tile row tall at %sx text: an invisible tile in its first cell, the summary laid over the whole row', async (fontScale) => {
        await mount(createElement(PollGridTile, { post: poll(), onOpen: vi.fn(), fontScale }));
        const ghost = q('poll-grid-ghost')!;
        // The tile's own box: the card's border round the 4:3 photo at the cell's width and the text block at this scale.
        expect(styleOf(ghost)).toMatchObject({ opacity: 0, borderWidth: MARKET_CARD_SHELL.borderWidth });
        expect(styleOf(ghost.firstElementChild)).toMatchObject({ width: '100%', aspectRatio: 4 / 3 });
        expect(styleOf(q('poll-grid-ghost-text'))).toEqual({ height: gridTextBlockHeight(fontScale) });
        // In a cell of the row (half its width, as each tile's), never read out or pressed.
        expect(styleOf(ghost.parentElement)).toMatchObject({ flex: 1, minWidth: 0 });
        expect(styleOf(q('market-grid-poll-row'))).toMatchObject({ flexDirection: 'row', gap: MARKET_CARD_SHELL.gap.grid });
        // The tile covers the row and adds nothing to its height.
        expect(styleOf(q('market-poll-tile-poll_grid'))).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
    });

    it('is one button that reads out as the poll and opens its page; nothing on it votes', async () => {
        const onOpen = vi.fn();
        await mount(createElement(PollGridTile, { post: poll(), onOpen, fontScale: 1 }));
        const buttons = Array.from(host.querySelectorAll('button'));
        expect(buttons).toHaveLength(1);
        expect(buttons[0].getAttribute('data-role')).toBe('button');
        expect(buttons[0].getAttribute('aria-label')).toBe('Poll: What would make trading with beans easier for you?. 4 answers, 1 vote. Opens to vote');
        await act(async () => { buttons[0].click(); });
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('draws the header, the question (2 lines), every answer with its percentage, and the footer', async () => {
        await mount(createElement(PollGridTile, { post: poll(), onOpen: vi.fn(), fontScale: 1 }));
        expect(q('poll-badge')!.textContent).toBe('🗳️ POLL');
        expect(q('poll-status')!.textContent).toBe('Closes in 10d');
        expect(q('poll-author')!.textContent).toBe('Damo (The IT guy)');
        expect(q('poll-grid-question')!.getAttribute('data-lines')).toBe('2');
        expect(answers()).toEqual([
            'Better matches with what people need100%', 'Faster responses when I post an offer0%',
            'A clearer idea of what beans are worth0%', "Not sure yet. I'm still finding my feet0%",
        ]);
        expect(q('poll-grid-summary')!.textContent).toBe('1 vote · Anonymous');
        expect(q('poll-grid-action-vote')!.textContent).toBe('Tap to vote ›');
        // Each row: one line, grows to 1.6x at most.
        expect(styleOf(all('poll-grid-answer')[0])).toMatchObject({ flex: 1, minHeight: 22, maxHeight: 22 * 1.6 });
    });

    it('shows what fits the laid-out room, then "+N more"; rows and gaps grow with the text', async () => {
        await mount(createElement(PollGridTile, { post: poll(), onOpen: vi.fn(), fontScale: 1.3 }));
        // Rows of 28.6 with 5.2 between at 1.3x: three fit in 100, so two answers and "+2 more".
        await layOut(100);
        expect(answers()).toHaveLength(2);
        expect(q('poll-grid-more')!.textContent).toBe('+2 more');
        await layOut(200);
        expect(answers()).toHaveLength(4);
        expect(q('poll-grid-more')).toBeNull();
    });

    it('a two-answer poll gives its question three lines', async () => {
        await mount(createElement(PollGridTile, { post: poll({ pollOptions: four.slice(0, 2) }), onOpen: vi.fn(), fontScale: 1 }));
        expect(q('poll-grid-question')!.getAttribute('data-lines')).toBe('3');
    });

    it('the ✓ on the member\'s own answer, as the card shows it; none on a sealed poll, which says "You answered ✓"', async () => {
        await mount(createElement(PollGridTile, { post: poll({ userVotedOptionId: 'b' }), onOpen: vi.fn(), fontScale: 1 }));
        expect(all('poll-grid-answer-chosen').map(seen)).toEqual(['Faster responses when I post an offer0% ✓']);
        await mount(createElement(PollGridTile, {
            post: poll({ userVotedOptionId: 'b', pollOptions: [...four, { id: 'o', text: 'Other', other: true, votes: 0, percentage: 0 }] }), onOpen: vi.fn(), fontScale: 1,
        }));
        expect(all('poll-grid-answer-chosen')).toHaveLength(0);
        expect(q('poll-grid-action-answered')!.textContent).toBe('You answered ✓');
    });

    it('a closed poll: Closed, "Closed · 3 votes" and "See results ›", never "Tap to vote"', async () => {
        await mount(createElement(PollGridTile, { post: poll({ status: 'completed', totalVotes: 3 }), onOpen: vi.fn(), fontScale: 1 }));
        expect(q('poll-status')!.textContent).toBe('Closed');
        expect(q('poll-grid-summary')!.textContent).toBe('Closed · 3 votes');
        expect(q('poll-grid-action-results')!.textContent).toBe('See results ›');
        expect(host.textContent).not.toContain('Tap to vote');
    });

    it('an open vote says so; the worldwide community\'s poll carries the card\'s note', async () => {
        await mount(createElement(PollGridTile, { post: poll({ poll_open_vote: 1, totalVotes: 2 }), onOpen: vi.fn(), fontScale: 1, informal: true }));
        expect(q('poll-grid-summary')!.textContent).toBe('2 votes · Open vote');
        expect(q('poll-informal-note')!.textContent).toBe('💬 An informal poll; it decides nothing');
    });
});

/**
 * Voted in the tile when the WHOLE poll is in front of the member (Marty and Damo, 6 Nov 2026: "if there are 2+ more it should
 * jump to the card mandatory so you are presented with all answers. Otherwise the poll will be loaded"); otherwise the tile
 * opens the poll's page, as before.
 */
describe('the phone grid\'s poll tile, voted in place', () => {
    const short = (extra: Record<string, unknown> = {}) => poll({
        id: 'poll_short', title: 'Market day?', totalVotes: 5,
        pollOptions: [
            { id: 's1', text: 'Saturday', votes: 3, percentage: 60 },
            { id: 's2', text: 'Sunday', votes: 2, percentage: 40 },
            { id: 's3', text: 'Either', votes: 0, percentage: 0 },
        ],
        ...extra,
    });
    /**
     * The answers' words laid out unclamped at their row's width on a 320 dp phone: a row holds `fits` characters (about what
     * a 320 dp tile's row holds at 12 dp bold), so longer words take two lines there and are cut with "…" on the tile.
     */
    const layWords = async (fits = 24) => {
        await act(async () => {
            for (const [words, cb] of textLayouts) cb({ nativeEvent: { lines: Array.from({ length: Math.max(1, Math.ceil(words.length / fits)) }, () => ({})) } });
        });
    };
    /** Lays out the room and every answer's words, as the phone does after its first draw. */
    const layAll = async (height: number, fits = 24) => { await layOut(height); await layWords(fits); };
    /** The buttons as a screen reader reads them (the author line is pressed, but read as what it says, not as a button). */
    const buttons = () => Array.from(host.querySelectorAll('[data-role="button"]')) as HTMLElement[];
    const press = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
    const tileOf = (id: string) => q(`market-poll-tile-${id}`)!;
    beforeEach(() => {
        vi.mocked(votePoll).mockReset();
        vi.mocked(Alert.alert).mockReset();
    });

    it('a short poll, all of it in the tile: tapping an answer votes it once by the card\'s own call, and opens nothing', async () => {
        const onOpen = vi.fn();
        const onVoteSuccess = vi.fn();
        vi.mocked(votePoll).mockResolvedValue({ post: short({ userVotedOptionId: 's2', totalVotes: 6, pollOptions: [
            { id: 's1', text: 'Saturday', votes: 3, percentage: 50 }, { id: 's2', text: 'Sunday', votes: 3, percentage: 50 }, { id: 's3', text: 'Either', votes: 0, percentage: 0 },
        ] }) } as any);
        await mount(createElement(PollGridTile, { post: short(), onOpen, fontScale: 1.3, currentPubkey: 'me', onVoteSuccess }));
        // Three rows a finger's press tall at 1.3x, and the gaps (5.2 at 1.3x).
        await layAll(3 * 44 + 2 * 5.2);
        // The tile is no button now: its answers are, each named as the vote it casts, and the footer opens the poll.
        expect(tileOf('poll_short').tagName).toBe('DIV');
        expect(buttons().map(b => b.getAttribute('aria-label'))).toEqual(['Vote: Saturday, 60%', 'Vote: Sunday, 40%', 'Vote: Either, 0%', 'Open poll: Market day?']);
        expect(buttons().slice(0, 3).every(b => b.getAttribute('data-role') === 'button')).toBe(true);
        // Each row a finger's press tall at least.
        for (const b of buttons().slice(0, 3)) expect(styleOf(b).minHeight).toBeGreaterThanOrEqual(44);
        expect(q('poll-grid-action-here')!.textContent).toBe('Tap an answer to vote · Open poll ›');

        await press(buttons()[1]);
        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll_short', 's2');
        expect(onOpen).not.toHaveBeenCalled();
        expect(onVoteSuccess).toHaveBeenCalledTimes(1);
        // The bars and the ✓ follow the node's answer, in place.
        expect(all('poll-grid-answer-chosen').map(seen)).toEqual(['Sunday50% ✓']);
        expect(JSON.parse(all('poll-grid-answer-chosen')[0].getAttribute('data-state')!)).toMatchObject({ selected: true });
    });

    it('the question, the author line and the footer still open the poll', async () => {
        const onOpen = vi.fn();
        await mount(createElement(PollGridTile, { post: short(), onOpen, fontScale: 1, currentPubkey: 'me' }));
        await layAll(200);
        await press(q('poll-grid-question'));
        await press(q('poll-grid-head'));
        await press(q('poll-grid-foot'));
        expect(onOpen).toHaveBeenCalledTimes(3);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('nothing votes before the room and the words are laid out', async () => {
        await mount(createElement(PollGridTile, { post: short(), onOpen: vi.fn(), fontScale: 1, currentPubkey: 'me' }));
        expect(buttons()).toHaveLength(1);
        await layOut(200);
        expect(buttons()).toHaveLength(1);
        await layWords();
        expect(buttons()).toHaveLength(4);
    });

    it('a poll with a "+N more" row never votes: the whole tile opens the page', async () => {
        const onOpen = vi.fn();
        await mount(createElement(PollGridTile, { post: poll(), onOpen, fontScale: 1.3, currentPubkey: 'me' }));
        await layAll(100, 1000);
        expect(q('poll-grid-more')!.textContent).toBe('+2 more');
        expect(buttons()).toHaveLength(1);
        await press(all('poll-grid-answer')[0]);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
        expect(q('poll-grid-action-vote')!.textContent).toBe('Tap to vote ›');
    });

    it('an answer cut at 320 dp never votes: the whole tile opens the page', async () => {
        const onOpen = vi.fn();
        const long = short({ pollOptions: [
            { id: 's1', text: 'Saturday', votes: 3, percentage: 60 }, { id: 's2', text: 'Sunday', votes: 2, percentage: 40 },
            { id: 's3', text: 'Better matches with what people need', votes: 0, percentage: 0 },
        ] });
        await mount(createElement(PollGridTile, { post: long, onOpen, fontScale: 1, currentPubkey: 'me' }));
        await layAll(200);
        expect(buttons()).toHaveLength(1);
        await press(all('poll-grid-answer')[2]);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('rows that cannot each be a finger\'s press tall never vote', async () => {
        await mount(createElement(PollGridTile, { post: short(), onOpen: vi.fn(), fontScale: 1, currentPubkey: 'me' }));
        await layAll(3 * 44 + 2 * 4 - 1);
        expect(buttons()).toHaveLength(1);
    });

    it('a poll with a typed Other, a sealed poll the member answered, a closed poll, and a reader not signed in: each opens the page', async () => {
        const other = { id: 'o', text: 'Other', other: true, votes: 0, percentage: 0 };
        const cases: Array<[Record<string, unknown>, string | null]> = [
            [{ poll_open_vote: 1, pollOptions: [...(short().pollOptions as any[]).slice(0, 2), other] }, 'me'],
            [{ pollAnswered: true, pollOptions: [...(short().pollOptions as any[]).slice(0, 2), other] }, 'me'],
            [{ status: 'completed' }, 'me'],
            [{}, null],
        ];
        for (const [extra, who] of cases) {
            const onOpen = vi.fn();
            await mount(createElement(PollGridTile, { post: short(extra), onOpen, fontScale: 1, currentPubkey: who }));
            await layAll(200);
            expect(buttons()).toHaveLength(1);
            await press(all('poll-grid-answer')[0]);
            expect(onOpen).toHaveBeenCalledTimes(1);
            await act(async () => { root.unmount(); });
            root = createRoot(host);
        }
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('a change of vote asks first, as the card does; Keep my vote sends nothing, Change sends it', async () => {
        await mount(createElement(PollGridTile, { post: short({ userVotedOptionId: 's1' }), onOpen: vi.fn(), fontScale: 1, currentPubkey: 'me' }));
        await layAll(200);
        await press(buttons()[1]);
        expect(Alert.alert).toHaveBeenCalledTimes(1);
        const [title, body, choices] = vi.mocked(Alert.alert).mock.calls[0] as unknown as [string, string, Array<{ text: string; onPress?: () => void }>];
        expect(title).toBe('Change your vote?');
        expect(body).toBe('You voted for “Saturday”. Change it to “Sunday”?');
        expect(choices.map(c => c.text)).toEqual(['Keep my vote', 'Change']);
        // Keep my vote: nothing is sent.
        await act(async () => { choices[0].onPress?.(); });
        expect(votePoll).not.toHaveBeenCalled();
        // Change: the vote goes.
        vi.mocked(votePoll).mockResolvedValue({ post: short({ userVotedOptionId: 's2' }) } as any);
        await act(async () => { choices[1].onPress?.(); });
        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll_short', 's2');
    });
});
