// @vitest-environment jsdom
/**
 * "Ask an admin to invite someone" in the share sheet (phone), on a listing. Where only admins invite and the member is no
 * admin, the sheet shows the line and ONE more button, which opens the ask form People → Invites uses
 * (components/InviteAsks.tsx AskSheet). Nothing else changes; where the node does not take asks, an admin, a guest or a role
 * not known: no button. SharePost really renders InviteAsks.tsx over a fake node (utils/node-post); the rules are
 * apps/server test-invite-asks.ts. The event row's own test is in event-calendar-ics-render.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    profile: null as any,
    role: null as any,
    answered: true,
    kept: undefined as any,
    recognition: 'member' as string,
    calls: [] as Array<{ path: string; body?: unknown }>,
    post: { ok: true, json: async () => ({}) } as any,
}));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, onChangeText, value, maxLength, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value; attrs.maxLength = maxLength; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (disabled) attrs.disabled = true;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => null,
        Modal: ({ visible, children }: { visible: boolean; children?: any }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        Share: { share: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return { router: { push: vi.fn() }, useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]) };
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('react-native-keyboard-controller', () => ({ useKeyboardState: () => 0 }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://node.example' : null)),
        setItem: vi.fn(async () => {}),
    },
}));
vi.mock('../db', () => ({ signedRequestWithMethod: vi.fn(), signedGet: vi.fn(), askCanVouch: vi.fn(async () => false) }));
vi.mock('../nodes', () => ({ isGuestNode: vi.fn(async () => false) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => mockState.profile }));
vi.mock('../node-admin', () => ({
    cachedNodeRoleHeard: vi.fn(async () => (mockState.answered ? { role: mockState.role, communityName: 'Test Node' } : null)),
    askNodeRole: vi.fn(async () => (mockState.answered ? { role: mockState.role, communityName: 'Test Node' } : null)),
    persistNodeRole: vi.fn(async () => {}),
    readPersistedNodeRole: vi.fn(async () => mockState.kept),
}));
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recognition: mockState.recognition }) }));
vi.mock('../identity', () => ({
    useIdentity: () => ({ publicKey: 'user-pk' }),
    loadIdentity: async () => ({ publicKey: 'user-pk', privateKey: 'aa', callsign: 'Mel' }),
}));
// The node, at the boundary: what the ask form posts.
vi.mock('../node-post', () => ({
    signedGet: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    signedPost: vi.fn(async (_url: string, path: string, body: unknown) => { mockState.calls.push({ path, body }); return mockState.post; }),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

import { SharePostButtons } from '../../components/SharePost';

const POST = {
    id: 'post-123', title: 'Ladder for borrowing', type: 'offer', category: 'tools', description: 'A 6m ladder',
    credits: 0, authorPublicKey: 'author-pk', status: 'active', active: true, audienceScope: 'public',
};
const CLOSED = { shareOutside: false, door: 'admins', inviteAsks: true };

describe('Ask an admin to invite someone, in the share sheet (phone)', () => {
    let container: HTMLDivElement;
    let root: Root;
    const get = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
    const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); await flush(); };
    // The form is loaded on the tap (a dynamic import of InviteAsks), so wait for it rather than count ticks.
    const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };
    const type = async (el: HTMLElement | null, text: string) => {
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(el, text);
            el!.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    // The ways are in the one Share button's sheet (DP2): draw the post's Share, then open it.
    const render = async () => {
        await act(async () => { root.render(createElement(SharePostButtons, { post: POST }) as any); });
        await flush(); await flush();
        await click(get('share-open-button'));
        expect(get('share-sheet')).not.toBeNull();
    };

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockState.profile = null; mockState.role = null; mockState.answered = true; mockState.kept = undefined;
        mockState.recognition = 'member'; mockState.calls.length = 0; mockState.post = { ok: true, json: async () => ({}) };
    });
    afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

    it('only admins invite, a member who is no admin: the line, the Ask, no Invite and share — and the Ask opens the one ask form', async () => {
        mockState.profile = { profile: 'local', features: CLOSED };
        await render();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('share-ask-admin-button')?.textContent).toBe('Ask an admin to invite someone');
        expect(get('invite-and-share-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();
        expect(get('invite-ask-sheet')).toBeNull();

        await click(get('share-ask-admin-button'));
        await until(() => !!get('invite-ask-sheet'));
        // The Share sheet has gone; the same sheet People → Invites opens: two lines, and Send waits for both.
        expect(get('share-sheet')).toBeNull();
        expect(get('invite-ask-sheet')).not.toBeNull();
        expect(container.querySelectorAll('input').length).toBe(2);
        expect((get('invite-ask-send') as HTMLButtonElement).disabled).toBe(true);
        await type(get('invite-ask-first-name'), ' Sam ');
        await type(get('invite-ask-how-known'), ' the bakery ');
        await click(get('invite-ask-send'));
        expect(mockState.calls).toEqual([{ path: '/api/invite/asks', body: { firstName: 'Sam', howKnown: 'the bakery' } }]);
        expect(get('invite-ask-sheet')).toBeNull();
        expect(get('share-ask-admin-note')?.textContent).toBe('Waiting for an admin');
    });

    it('a refusal stays in the sheet, in the node\'s words, and nothing is claimed as sent', async () => {
        mockState.profile = { profile: 'local', features: CLOSED };
        mockState.post = { ok: false, json: async () => ({ error: 'You have 3 asks waiting. Take one back, or wait for an answer.' }) };
        await render();
        await click(get('share-ask-admin-button'));
        await until(() => !!get('invite-ask-sheet'));
        await type(get('invite-ask-first-name'), 'Sam');
        await type(get('invite-ask-how-known'), 'the bakery');
        await click(get('invite-ask-send'));
        expect(get('invite-ask-sheet')?.textContent).toContain('You have 3 asks waiting.');
        expect(get('share-ask-admin-note')).toBeNull();
    });

    it('an owner or admin sees Invite and share and no Ask', async () => {
        mockState.profile = { profile: 'local', features: CLOSED };
        mockState.role = 'admin';
        await render();
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(get('share-ask-admin-button')).toBeNull();
    });

    it('asks off (the node does not take them): the line as before, and no button', async () => {
        mockState.profile = { profile: 'local', features: { ...CLOSED, inviteAsks: false } };
        await render();
        expect(get('share-members-note')?.textContent).toContain('only admins invite here');
        expect(get('share-ask-admin-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
    });

    it('a role not known (no answer, nothing kept): no line and no button', async () => {
        mockState.profile = { profile: 'local', features: CLOSED };
        mockState.answered = false;
        await render();
        expect(get('share-members-note')).toBeNull();
        expect(get('share-ask-admin-button')).toBeNull();
    });

    it('a guest, or a phone the node has not recognised, is offered none', async () => {
        mockState.profile = { profile: 'local', features: CLOSED };
        mockState.recognition = 'guest';
        await render();
        expect(get('share-ask-admin-button')).toBeNull();
    });

    it('any member may invite (a members door): Invite and share, no Ask', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'members', inviteAsks: true } };
        await render();
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(get('share-ask-admin-button')).toBeNull();
    });

    it('with sharing outside on the Ask shows too and Share outside stays; its note reads as one', async () => {
        mockState.profile = { profile: 'local', features: { ...CLOSED, shareOutside: true, knocks: true } };
        await render();
        expect(get('share-ask-admin-button')).not.toBeNull();
        expect(get('share-outside-button')).not.toBeNull();
        expect(get('share-outside-line')?.textContent).toBe('Anyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.');
        expect(get('share-outside-privacy')).toBeNull();
    });
});
