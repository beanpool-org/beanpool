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
type Props = { children?: ReactNode; testID?: string; accessibilityLabel?: string; accessibilityRole?: string; onPress?: () => void; style?: unknown; numberOfLines?: number; onLayout?: (e: unknown) => void };
vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => (Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : (s && typeof s === 'object' ? s as Record<string, unknown> : {}));
    const el = (tag: string) => ({ children, testID, accessibilityLabel, accessibilityRole, onPress, style, numberOfLines, onLayout }: Props) => {
        if (testID && onLayout) layouts.set(testID, onLayout);
        return createElement(tag, {
            'data-testid': testID, 'aria-label': accessibilityLabel, 'data-role': accessibilityRole, onClick: onPress,
            'data-style': JSON.stringify(flat(style)), 'data-lines': numberOfLines,
        }, children);
    };
    return { View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null, Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s } };
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
const answers = () => [...all('poll-grid-answer'), ...all('poll-grid-answer-chosen')].map(a => a.textContent);

beforeEach(() => {
    layouts.clear();
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
        expect(all('poll-grid-answer-chosen').map(a => a.textContent)).toEqual(['Faster responses when I post an offer0% ✓']);
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
