// @vitest-environment jsdom
/**
 * The phone's poll card and composer for a typed Other (@beanpool/core poll-other): what the web's PollCard.other test holds,
 * rendered with react-dom and React Native stood in for. New app, old node: a node that doesn't say it can gets no tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: any) => children }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) })); // the real one needs the keyboard library's native side
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POLL_BALLOT_SEALED, POLL_OTHER_WORDS_MAX } from '@beanpool/core';

type Props = { children?: ReactNode; testID?: string; accessibilityLabel?: string; onPress?: () => void; disabled?: boolean; value?: string; maxLength?: number; onChangeText?: (s: string) => void };
vi.mock('react-native', () => {
    const el = (tag: string) => ({ children, testID, accessibilityLabel, onPress, disabled }: Props) =>
        createElement(tag, { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, disabled }, children);
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: () => null, ScrollView: el('div'), Modal: ({ visible, children }: any) => (visible ? createElement('div', null, children) : null),
        KeyboardAvoidingView: el('div'), Platform: { OS: 'android' },
        TextInput: ({ testID, value, maxLength, onChangeText, placeholder }: any) => createElement('input', { 'data-testid': testID, value: value ?? '', maxLength, placeholder, onChange: (e: any) => onChangeText?.(e.target.value) }),
        Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s },
    };
});
const colours = new Proxy({}, { get: () => new Proxy({}, { get: () => '#000' }) });
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: colours, theme: 'light' }),
    useStyles: (make: (t: unknown) => unknown) => make({ colors: colours, theme: 'light' }),
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => null }));
vi.mock('../../components/showcase/LocalCommunityMark', () => ({ LocalCommunityMark: () => null }));
vi.mock('../db', () => ({
    // The poll form asks when this member may start their next poll (poll-once-a-week): null = now.
    getPollNextStart: async () => null,
    // The poll form asks the signer's role for its 30 and 90 day lengths (poll-length-render.test.ts): a member here.
    isOwnerOrAdminHere: async () => false,
    votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(), createPost: vi.fn(),
    getPollOtherAnswers: vi.fn(), reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(),
}));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => profile.current }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me' } }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('../modal-safe-area', () => ({ pageSheetTopInset: () => 0 }));
const profile = vi.hoisted(() => ({ current: null as null | { features: { pollOther?: boolean } } }));

import { Alert } from 'react-native';
import { PollCard } from '../../components/PollCard';
import { NewPollModal } from '../../components/NewPollModal';
import { closePoll, createPost, getPollOtherAnswers, isOwnerHere, removePollOtherAnswer, reportPollOtherAnswer, votePoll } from '../db';

let host: HTMLDivElement;
let root: Root;
const mount = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (label: RegExp) => Array.from(host.querySelectorAll('button')).find(b => label.test(b.getAttribute('aria-label') ?? b.textContent ?? '')) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement | undefined | null) => { await act(async () => { el!.click(); }); };
const type = async (el: HTMLElement | null, value: string) => {
    await act(async () => {
        const input = el as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const poll = (extra: Record<string, unknown> = {}) => ({
    id: 'poll_1', type: 'poll', title: 'What is missing?', author_pubkey: 'maker', author_callsign: 'Mo', status: 'active',
    poll_closes_at: new Date(Date.now() + 86_400_000).toISOString(), poll_open_vote: 0, totalVotes: 5,
    pollOptions: [{ id: 'opt_1', text: 'Buses', votes: 3, percentage: 60 }, { id: 'opt_other_ab', text: 'Other', other: true, votes: 2, percentage: 40 }], ...extra,
});

beforeEach(() => {
    vi.clearAllMocks();
    profile.current = null;
    vi.mocked(isOwnerHere).mockResolvedValue(false);
    vi.mocked(votePoll).mockResolvedValue({ post: poll({ pollAnswered: true }) } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('the card', () => {
    it('Other asks for a line, says not to put a name, and sends the words with it', async () => {
        await mount(createElement(PollCard, { post: poll(), currentPubkey: 'me' }));
        expect(q('poll-other-box')).toBeNull();
        await click(button(/^Other/));
        expect(votePoll).not.toHaveBeenCalled();
        expect(q('poll-other-no-name')?.textContent).toBe("Don't put your name");
        expect((q('poll-other-words') as HTMLInputElement).maxLength).toBe(POLL_OTHER_WORDS_MAX);
        expect((q('poll-other-send') as HTMLButtonElement).disabled).toBe(true);
        await type(q('poll-other-words'), '  A Sunday bus ');
        await click(q('poll-other-send'));
        expect(votePoll).toHaveBeenCalledWith('poll_1', 'opt_other_ab', 'A Sunday bus');
        expect(q('poll-answered')).not.toBeNull();
    });

    it('a sealed poll says the answer is final; answered, it locks every answer', async () => {
        await mount(createElement(PollCard, { post: poll(), currentPubkey: 'me' }));
        expect(host.textContent).toMatch(/Your answer is final/);
        await mount(createElement(PollCard, { post: poll({ pollAnswered: true }), currentPubkey: 'me' }));
        expect(q('poll-answered')).not.toBeNull();
        expect(button(/^Buses/)?.disabled).toBe(true);
        expect(button(/^Other/)?.disabled).toBe(true);
    });

    it("this phone's own record of its answer locks it too", async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        expect(q('poll-answered')).not.toBeNull();
        expect(button(/your vote/)).toBeDefined();
    });

    it('an answer given elsewhere reads as answered, with none ticked', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: POLL_BALLOT_SEALED }), currentPubkey: 'me' }));
        expect(q('poll-answered')).not.toBeNull();
        expect(button(/your vote/)).toBeUndefined();
    });

    it('an open vote keeps its re-vote', async () => {
        await mount(createElement(PollCard, { post: poll({ poll_open_vote: 1, userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        expect(q('poll-answered')).toBeNull();
        expect(button(/^Other/)?.disabled).toBe(false);
    });

    it('a poll that offers no Other asks the node nothing', async () => {
        await mount(createElement(PollCard, { post: poll({ pollOptions: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }), currentPubkey: 'me' }));
        expect(isOwnerHere).not.toHaveBeenCalled();
        expect(q('poll-other-answers')).toBeNull();
    });

    it('a member has no panel', async () => {
        await mount(createElement(PollCard, { post: poll(), currentPubkey: 'me' }));
        expect(isOwnerHere).toHaveBeenCalled();
        expect(q('poll-other-answers')).toBeNull();
    });

    it('the maker reads the words on opening, and reports a line', async () => {
        vi.mocked(getPollOtherAnswers).mockResolvedValue({ state: 'open', count: 2, removed: 0, canRemove: false, answers: [{ id: 'a1', words: 'A Sunday bus', reported: false }] } as never);
        await mount(createElement(PollCard, { post: poll({ author_pubkey: 'me', status: 'completed' }), currentPubkey: 'me' }));
        expect(getPollOtherAnswers).not.toHaveBeenCalled();
        await click(button(/Read the typed answers/));
        expect(q('poll-other-line')?.textContent).toMatch(/A Sunday bus/);
        expect(button(/^Remove/)).toBeUndefined();
        await click(button(/^Report/));
        expect(reportPollOtherAnswer).toHaveBeenCalledWith('poll_1', 'a1');
    });

    it('held, the panel says when they come', async () => {
        vi.mocked(getPollOtherAnswers).mockResolvedValue({ state: 'held', count: 2, removed: 0, canRemove: false, answers: [] } as never);
        await mount(createElement(PollCard, { post: poll({ author_pubkey: 'me' }), currentPubkey: 'me' }));
        await click(button(/Read the typed answers/));
        expect(q('poll-other-held')?.textContent).toMatch(/once the poll closes/);
    });

    it('an owner gets the panel, and removes a line after confirming', async () => {
        vi.mocked(isOwnerHere).mockResolvedValue(true);
        vi.mocked(getPollOtherAnswers).mockResolvedValue({ state: 'open', count: 2, removed: 0, canRemove: true, answers: [{ id: 'a1', words: 'A Sunday bus', reported: true }] } as never);
        await mount(createElement(PollCard, { post: poll({ status: 'completed' }), currentPubkey: 'me' }));
        await click(button(/Read the typed answers/));
        await click(button(/^Remove/));
        expect(removePollOtherAnswer).not.toHaveBeenCalled();
        const buttons = vi.mocked(Alert.alert).mock.calls[0]![2]!;
        await act(async () => { buttons[1]!.onPress!(); });
        expect(removePollOtherAnswer).toHaveBeenCalledWith('poll_1', 'a1');
        expect(closePoll).not.toHaveBeenCalled();
    });

    it('an owner sees which line was reported, beside Remove', async () => {
        vi.mocked(isOwnerHere).mockResolvedValue(true);
        vi.mocked(getPollOtherAnswers).mockResolvedValue({
            state: 'open', count: 2, removed: 0, canRemove: true,
            answers: [{ id: 'a1', words: 'A Sunday bus', reported: false }, { id: 'a2', words: 'A rude line', reported: true }],
        } as never);
        await mount(createElement(PollCard, { post: poll({ status: 'completed' }), currentPubkey: 'me' }));
        await click(button(/Read the typed answers/));
        const [plainLine, reportedLine] = Array.from(host.querySelectorAll('[data-testid="poll-other-line"]'));
        expect(plainLine!.textContent).not.toMatch(/Reported/);
        expect(reportedLine!.textContent).toMatch(/Reported/);
        expect(reportedLine!.textContent).toMatch(/Remove/);
        expect(button(/^Report$/)).toBeUndefined();
    });

    it('the maker sees a line they reported, and cannot report it twice', async () => {
        vi.mocked(getPollOtherAnswers).mockResolvedValue({ state: 'open', count: 2, removed: 0, canRemove: false, answers: [{ id: 'a1', words: 'A rude line', reported: true }] } as never);
        await mount(createElement(PollCard, { post: poll({ author_pubkey: 'me', status: 'completed' }), currentPubkey: 'me' }));
        await click(button(/Read the typed answers/));
        expect(q('poll-other-line')?.textContent).toMatch(/Reported/);
        expect(button(/^Report$/)).toBeUndefined();
    });
});

describe('the composer', () => {
    const fill = async () => {
        const inputs = Array.from(host.querySelectorAll('input'));
        await type(inputs[0]!, 'What is missing?');
        await type(inputs[2]!, 'Buses'); // [1] is the notes
        await type(inputs[3]!, 'Beans');
    };

    it('a node that does not say it can: no tick, and nothing sent (new app, old node)', async () => {
        await mount(createElement(NewPollModal, { visible: true, onClose: () => {} }));
        expect(q('poll-other')).toBeNull();
    });

    it('off by default: a poll is made with no Other', async () => {
        profile.current = { features: { pollOther: true } };
        await mount(createElement(NewPollModal, { visible: true, onClose: () => {} }));
        expect(q('poll-other')).not.toBeNull();
        await fill();
        await click(button(/^Create poll/));
        expect(createPost).toHaveBeenCalled();
        expect(vi.mocked(createPost).mock.calls[0]?.[0]).not.toHaveProperty('pollOther');
    });

    it('ticked, the poll asks for Other', async () => {
        profile.current = { features: { pollOther: true } };
        await mount(createElement(NewPollModal, { visible: true, onClose: () => {} }));
        await click(q('poll-other'));
        await fill();
        await click(button(/^Create poll/));
        expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ pollOther: true }));
    });
});
