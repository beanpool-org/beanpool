// @vitest-environment jsdom
/**
 * The poll's own page shows every answer whole on the phone, as on the web (Marty, 5 Nov 2026: the Market grid's poll is a
 * read-only tile that opens this page to vote). The Market's list keeps its two lines. Seen on the API 26 emulator at 320 dp
 * x 1.3 before this: the page cut "Better matches with what people need" to "Better matches with what people …" beside its ✓.
 * Rendered with react-dom, React Native stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Props = { children?: ReactNode; testID?: string; accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; numberOfLines?: number };
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, testID, accessibilityLabel, onPress, disabled, numberOfLines }: Props) =>
        createElement(tag, { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, disabled, 'data-lines': numberOfLines }, children);
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null, ScrollView: el('div'),
        Platform: { OS: 'android' }, Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s },
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
vi.mock('../db', () => ({
    votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(async () => false), unpinPostOnNode: vi.fn(), getPost: vi.fn(),
    getPollOtherAnswers: vi.fn(), reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(),
}));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../use-pin-role', () => ({ usePinRole: () => null }));

import { PollCard } from '../../components/PollCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LONG = 'Better matches with what people need, and a clearer idea of what each of them is worth to the people around me';
const poll = {
    id: 'poll_page', type: 'poll', title: 'What would make trading with beans easier for you?', author_pubkey: 'damo', author_callsign: 'Damo',
    status: 'active', poll_closes_at: new Date(Date.now() + 10 * 86_400_000).toISOString(), poll_open_vote: 0, totalVotes: 1,
    userVotedOptionId: 'a',
    pollOptions: [{ id: 'a', text: LONG, votes: 1, percentage: 100 }, { id: 'b', text: 'Faster responses when I post an offer', votes: 0, percentage: 0 }],
};

let host: HTMLDivElement;
let root: Root;
const mount = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const answerTexts = () => Array.from(host.querySelectorAll('[data-testid="poll-option-text"]')) as HTMLElement[];

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('the poll\'s answers on the phone', () => {
    it('are whole on the poll\'s own page (no view mode), where the grid\'s tile sends members to vote', async () => {
        await mount(createElement(PollCard, { post: poll, currentPubkey: 'me' }));
        const texts = answerTexts();
        expect(texts.map(t => t.textContent)).toEqual([LONG, 'Faster responses when I post an offer']);
        for (const t of texts) expect(t.getAttribute('data-lines')).toBeNull();
    });

    it('keep their two lines in the Market\'s list', async () => {
        await mount(createElement(PollCard, { post: poll, currentPubkey: 'me', viewMode: 'list' }));
        const texts = answerTexts();
        expect(texts).toHaveLength(2);
        for (const t of texts) expect(t.getAttribute('data-lines')).toBe('2');
    });
});
