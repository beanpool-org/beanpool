// @vitest-environment jsdom
/**
 * Poll vote change confirmation tests (Marty, 5 Nov 2026):
 * When a member who has already voted taps a different option or sends an Other answer,
 * it asks first with Alert.alert ("Change your vote?", "You voted for “{current}”. Change it to “{new}”?").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: any) => children }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) }));
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POLL_OTHER_WORDS_MAX } from '@beanpool/core';

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
    getPollNextStart: async () => null,
    votePoll: vi.fn(), closePoll: vi.fn(), isOwnerHere: vi.fn(), createPost: vi.fn(),
    getPollOtherAnswers: vi.fn(), reportPollOtherAnswer: vi.fn(), removePollOtherAnswer: vi.fn(),
}));
vi.mock('../node-profile', () => ({ INFORMAL_POLL_NOTE: 'An informal poll; it decides nothing' }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => null }));
vi.mock('../member-area', () => ({ nearbyListingsOn: () => false, useMyArea: () => null }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: { publicKey: 'me' } }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('../modal-safe-area', () => ({ pageSheetTopInset: () => 0 }));

import { Alert } from 'react-native';
import { PollCard } from '../../components/PollCard';
import { isOwnerHere, votePoll } from '../db';

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
    id: 'poll_1',
    type: 'poll',
    title: 'What is missing?',
    author_pubkey: 'maker',
    author_callsign: 'Mo',
    status: 'active',
    poll_closes_at: new Date(Date.now() + 86_400_000).toISOString(),
    poll_open_vote: 1,
    totalVotes: 5,
    pollOptions: [
        { id: 'opt_1', text: 'Buses', votes: 3, percentage: 60 },
        { id: 'opt_2', text: 'Trains', votes: 2, percentage: 40 },
        { id: 'opt_other_ab', text: 'Other', other: true, votes: 0, percentage: 0 },
    ],
    ...extra,
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOwnerHere).mockResolvedValue(false);
    vi.mocked(votePoll).mockResolvedValue({ post: poll({ pollAnswered: true }) } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('PollCard vote change confirmation (phone)', () => {
    it('(a) voted A, press B -> dialog shows, votePoll NOT called', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        await click(button(/^Trains/));

        expect(Alert.alert).toHaveBeenCalledTimes(1);
        const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0];
        expect(title).toBe('Change your vote?');
        expect(body).toBe('You voted for “Buses”. Change it to “Trains”?');
        expect(buttons).toHaveLength(2);
        expect(buttons?.[0]?.text).toBe('Keep my vote');
        expect(buttons?.[0]?.style).toBe('cancel');
        expect(buttons?.[1]?.text).toBe('Change');

        expect(votePoll).not.toHaveBeenCalled();
    });

    it('(b) confirm -> votePoll(post, B) called once', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        await click(button(/^Trains/));

        expect(votePoll).not.toHaveBeenCalled();
        const buttons = vi.mocked(Alert.alert).mock.calls[0][2];
        const changeBtn = buttons?.find(b => b.text === 'Change');
        expect(changeBtn).toBeDefined();

        await act(async () => {
            changeBtn?.onPress?.();
        });

        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll_1', 'opt_2');
    });

    it('(c) Keep my vote -> not called, A still shown voted', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        await click(button(/^Trains/));

        expect(votePoll).not.toHaveBeenCalled();
        const buttons = vi.mocked(Alert.alert).mock.calls[0][2];
        const keepBtn = buttons?.find(b => b.text === 'Keep my vote');
        expect(keepBtn).toBeDefined();

        await act(async () => {
            keepBtn?.onPress?.();
        });

        expect(votePoll).not.toHaveBeenCalled();
        const busesBtn = button(/^Buses/);
        expect(busesBtn?.textContent).toContain('✓');
    });

    it('(d) first vote -> no dialog, called at once', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: null }), currentPubkey: 'me' }));
        await click(button(/^Trains/));

        expect(Alert.alert).not.toHaveBeenCalled();
        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll_1', 'opt_2');
    });

    it('(e) sealed poll answered -> still disabled, no dialog', async () => {
        await mount(createElement(PollCard, {
            post: poll({ poll_open_vote: 0, pollAnswered: true, userVotedOptionId: 'opt_1' }),
            currentPubkey: 'me',
        }));
        const trainsBtn = button(/^Trains/);
        expect(trainsBtn?.disabled).toBe(true);

        await click(trainsBtn);
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(votePoll).not.toHaveBeenCalled();
    });

    it('(f) Other answer while voted on another option -> asks', async () => {
        await mount(createElement(PollCard, { post: poll({ userVotedOptionId: 'opt_1' }), currentPubkey: 'me' }));
        await click(button(/^Other/));
        expect(q('poll-other-box')).not.toBeNull();

        await type(q('poll-other-words'), 'A Sunday bus');
        await click(q('poll-other-send'));

        expect(Alert.alert).toHaveBeenCalledTimes(1);
        const [title, body, buttons] = vi.mocked(Alert.alert).mock.calls[0];
        expect(title).toBe('Change your vote?');
        expect(body).toBe('You voted for “Buses”. Change it to “Other”?');
        expect(votePoll).not.toHaveBeenCalled();

        const changeBtn = buttons?.find(b => b.text === 'Change');
        expect(changeBtn).toBeDefined();

        await act(async () => {
            changeBtn?.onPress?.();
        });

        expect(votePoll).toHaveBeenCalledTimes(1);
        expect(votePoll).toHaveBeenCalledWith('poll_1', 'opt_other_ab', 'A Sunday bus');
    });
});
