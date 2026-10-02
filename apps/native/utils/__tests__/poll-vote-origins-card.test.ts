// @vitest-environment jsdom
/**
 * The phone's poll card says where the votes came from (FABLE-sec-global-abuse LOW-7): how many came from new or 12-word
 * accounts, and under each answer how many of its own when the node gives the split (@beanpool/core poll-vote-origins),
 * once an anonymous poll has closed: never while it is open, never on an open vote, whatever the node or the cache holds.
 * Every vote still counts and shows; nothing is said where the node says nothing.
 *
 * Rendered with react-dom and React Native stood in for (as words-on-screen-render.test.ts does): what is checked is what
 * the card puts on screen and the styles it gives it, never a frame a phone draws. The 320dp check is a model of the
 * layout, as sso-button-layout.test.ts's: the lines may wrap (no line limit, no fixed size, not squeezed into a row), and
 * their longest word fits the width they get on a 320dp phone at 1.3x text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Props = { children?: ReactNode; style?: unknown; testID?: string; numberOfLines?: number; accessibilityLabel?: string; onPress?: () => void; disabled?: boolean };
/** Each stand-in keeps what the card gave it, for the checks below. */
const seen = vi.hoisted(() => new Map<string, { style: unknown; numberOfLines?: number }>());
const flat = (s: unknown): Record<string, unknown> =>
    Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : s && typeof s === 'object' ? { ...(s as Record<string, unknown>) } : {};
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, style, testID, numberOfLines, accessibilityLabel, onPress, disabled }: Props) => {
        if (testID) seen.set(testID, { style, numberOfLines });
        return createElement(tag, {
            'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, disabled,
            'data-row': flat(style).flexDirection === 'row' ? '1' : undefined,
        }, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null,
        Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s },
    };
});
const colours = new Proxy({}, { get: () => new Proxy({}, { get: () => '#000' }) });
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: colours, theme: 'light' }),
    useStyles: (make: (t: unknown) => unknown) => make({ colors: colours, theme: 'light' }),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../db', () => ({ votePoll: vi.fn(), closePoll: vi.fn() }));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));

import { PollCard } from '../../components/PollCard';
import { votePoll } from '../db';


function poll(extra: Record<string, unknown> = {}, options?: unknown[]) {
    return {
        id: 'poll-1', type: 'poll', title: 'Should the lobby have a weekly swap day?', author_pubkey: 'a'.repeat(64), author_callsign: 'Ann',
        // Closed: its time has passed. The node says where the votes came from only then.
        status: 'completed', poll_closes_at: new Date(Date.now() - 86_400_000).toISOString(), poll_open_vote: 0, totalVotes: 12,
        // As the Market hands it over from the phone's cache (utils/db.ts getPosts).
        pollNewOrWordsVotes: 5,
        pollOptions: options ?? [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 58, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 25, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 2, percentage: 17, newOrWordsVotes: 0 },
        ],
        ...extra,
    };
}

/** The same poll still open, as it reads before its time is up. */
const OPEN = { status: 'active', poll_closes_at: new Date(Date.now() + 7 * 86_400_000).toISOString() };

let container: HTMLDivElement;
let root: Root;
async function draw(post: unknown): Promise<void> {
    await act(async () => { root.render(createElement(PollCard, { post, currentPubkey: 'me'.padEnd(64, '0'), informal: true }) as any); });
}
const byId = (id: string) => Array.from(container.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const answer = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(text)) as HTMLElement;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    seen.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe('the phone\'s poll card: where the votes came from', () => {
    it('once closed: the count, and each answer\'s own share under it; every vote still shows', async () => {
        await draw(poll());
        expect(byId('poll-vote-origins').map(e => e.textContent)).toEqual(['🌱 5 of 12 votes came from new or 12-word accounts']);
        expect(answer('Yes').querySelector('[data-testid="poll-option-origins"]')?.textContent).toBe('4 of these 7 from new or 12-word accounts');
        expect(answer('No').querySelector('[data-testid="poll-option-origins"]')?.textContent).toBe('1 of these 3 from a new or 12-word account');
        expect(answer('Maybe').querySelector('[data-testid="poll-option-origins"]')).toBeNull();
        expect(answer('Yes').textContent).toContain('(7 votes)');
        expect(container.textContent).toContain('12 total votes cast');
        // A screen reader hears an answer's share with the answer.
        expect(answer('Yes').getAttribute('aria-label')).toBe('Yes, 58 percent, 7 votes, 4 of these 7 from new or 12-word accounts');
    });

    it('the total only, where the node gives no split', async () => {
        await draw(poll({ totalVotes: 5, pollNewOrWordsVotes: 1 }, [
            { id: 'opt_yes', text: 'Yes', votes: 3, percentage: 60 }, { id: 'opt_no', text: 'No', votes: 2, percentage: 40 },
        ]));
        expect(byId('poll-vote-origins').map(e => e.textContent)).toEqual(['🌱 1 of 5 votes came from a new or 12-word account']);
        expect(byId('poll-option-origins')).toHaveLength(0);
    });

    it('nothing where the node says nothing (a local community, a group\'s poll), or none came from them', async () => {
        const { pollNewOrWordsVotes: _n, ...local } = poll({}, [{ id: 'opt_yes', text: 'Yes', votes: 12, percentage: 100 }]);
        await draw(local);
        expect(byId('poll-vote-origins')).toHaveLength(0);
        expect(byId('poll-option-origins')).toHaveLength(0);
        expect(container.textContent).not.toContain('12-word');
        await draw(poll({ pollNewOrWordsVotes: 0 }, [{ id: 'opt_yes', text: 'Yes', votes: 12, percentage: 100, newOrWordsVotes: 0 }]));
        expect(byId('poll-vote-origins')).toHaveLength(0);
    });

    it('while the poll is open, nothing about where the votes came from, whatever the cache holds: no line, no placeholder', async () => {
        for (const extra of [OPEN, { status: 'active', poll_closes_at: null }, { ...OPEN, pollNewOrWordsVotes: undefined, poll_new_or_words_votes: 5 }]) {
            await draw(poll(extra));
            expect(byId('poll-vote-origins')).toHaveLength(0);
            expect(byId('poll-option-origins')).toHaveLength(0);
            expect(container.textContent).not.toMatch(/12-word|new account|came from/);
            expect(answer('Yes').getAttribute('aria-label')).toBe('Yes, 58 percent, 7 votes');
            expect(answer('Yes').textContent).toContain('(7 votes)');
        }
    });

    it('never on an open vote, open or closed: it names its voters, so a count of kinds would say which each is', async () => {
        const voters = [{ voterPubkey: 'v1', voterCallsign: 'Quill', optionId: 'opt_yes', createdAt: new Date().toISOString() }];
        for (const extra of [{ poll_open_vote: 1, pollVotes: voters }, { ...OPEN, pollOpenVote: true, pollVotes: voters }]) {
            await draw(poll(extra));
            expect(byId('poll-vote-origins')).toHaveLength(0);
            expect(byId('poll-option-origins')).toHaveLength(0);
            expect(container.textContent).not.toMatch(/12-word|came from/);
        }
    });

    it('reads the cache column\'s name too (a row read straight from the phone\'s posts table)', async () => {
        const { pollNewOrWordsVotes: _n, ...row } = poll({ poll_new_or_words_votes: 5 });
        await draw(row);
        expect(byId('poll-vote-origins').map(e => e.textContent)).toEqual(['🌱 5 of 12 votes came from new or 12-word accounts']);
    });

    it('a vote on an open poll says nothing about them, even if the answer carried some', async () => {
        vi.mocked(votePoll).mockResolvedValue({ success: true, post: poll({ ...OPEN, totalVotes: 13, pollNewOrWordsVotes: 6, userVotedOptionId: 'opt_maybe' }, [
            { id: 'opt_yes', text: 'Yes', votes: 7, percentage: 54, newOrWordsVotes: 4 },
            { id: 'opt_no', text: 'No', votes: 3, percentage: 23, newOrWordsVotes: 1 },
            { id: 'opt_maybe', text: 'Maybe', votes: 3, percentage: 23, newOrWordsVotes: 1 },
        ]) });
        await draw(poll(OPEN));
        await act(async () => { answer('Maybe').click(); });
        expect(container.textContent).toContain('13 total votes cast');
        expect(byId('poll-vote-origins')).toHaveLength(0);
        expect(byId('poll-option-origins')).toHaveLength(0);
    });

    it('fits a 320dp phone at 1.3x text: the lines wrap, each on its own line, and their longest word fits', async () => {
        await draw(poll());
        const SCREEN = 320, FONT_SCALE = 1.3;
        // app/(tabs)/index.tsx listContent 16 each side; the card's padding 16 and border 1; an answer's border 1.
        const cardInner = SCREEN - 2 * 16 - 2 * 16 - 2 * 1;
        const wordWidth = (w: string, size: number) => [...w].reduce((n, ch) => n + (/\p{Extended_Pictographic}/u.test(ch) ? 1.25 : 0.62) * size * FONT_SCALE, 0);
        const longest = (text: string, size: number) => Math.max(...text.split(/\s+/).map(w => wordWidth(w, size)));
        for (const [id, inner] of [['poll-vote-origins', cardInner], ['poll-option-origins', cardInner - 2 * 1]] as const) {
            const { style, numberOfLines } = seen.get(id)!;
            const s = flat(style);
            expect(numberOfLines, `${id}: no line limit`).toBeUndefined();
            for (const k of ['width', 'height', 'maxHeight', 'maxWidth']) expect(s[k], `${id}: no fixed ${k}`).toBeUndefined();
            const pad = Number(s.paddingHorizontal ?? 0) * 2;
            const size = Number(s.fontSize);
            expect(size).toBeGreaterThanOrEqual(11);
            for (const e of byId(id)) expect(longest(e.textContent ?? '', size)).toBeLessThan(inner - pad);
        }
        // An answer's line is the answer's own child, under its row, not squeezed into the row beside the counts.
        for (const e of byId('poll-option-origins')) {
            expect(e.parentElement?.tagName).toBe('BUTTON');
            expect(e.parentElement?.getAttribute('data-row')).toBeNull();
        }
    });
});
