// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ params: { view: 'community' } as Record<string, string>, pushed: [] as unknown[] }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => nav.pushed.push(to), replace: (to: unknown) => nav.pushed.push(to), navigate: () => {}, back: () => {}, canGoBack: () => true },
    useLocalSearchParams: () => nav.params,
    useFocusEffect: (cb: () => void | (() => void)) => { cb(); },
    useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
    ErrorBoundary: () => null,
}));

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));
vi.mock('react-native', async () => (await import('./profile-events-words-harness')).nativeMock(alerts));

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));

vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardAwareScrollView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));

vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});

const { ME_PUBKEY, BOB_PUBKEY, data } = vi.hoisted(() => {
    const ME_PUBKEY = '1'.repeat(64);
    const BOB_PUBKEY = '2'.repeat(64);
    const data = {
        members: [
            { public_key: BOB_PUBKEY, callsign: 'Bob', avatar_url: null, joined_at: '2026-01-01T00:00:00.000Z' },
        ],
        friends: [] as any[],
        conversationsCreated: [] as any[],
        /** While set, the community has not answered the ask for the chat yet. */
        answerGate: null as Promise<void> | null,
        /** While set, the community refuses the chat: utils/db.ts throws the node's words as the error's message. */
        createConvError: null as Error | null,
    };
    return { ME_PUBKEY, BOB_PUBKEY, data };
});

vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: ME_PUBKEY, callsign: 'Alice' } }),
}));

vi.mock('../db', () => ({
    getDb: async () => ({
        getAllAsync: async () => data.members,
    }),
    getFriendsLocal: async () => data.friends,
    addFriendLocal: async () => {},
    removeFriendLocal: async () => {},
    createConversationApi: vi.fn(async (type: string, participants: string[], createdBy: string) => {
        if (data.createConvError) throw data.createConvError;
        data.conversationsCreated.push({ type, participants, createdBy });
        if (data.answerGate) await data.answerGate;
        return { id: 'conv-dm-bob', participants, type };
    }),
}));

vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ makeOfflineTicket: () => {} }));
vi.mock('../membership-probe', () => ({ fetchMembership: () => {} }));
vi.mock('../node-admin', () => ({ askNodeRole: () => {}, persistNodeRole: async () => {}, readPersistedNodeRole: async () => undefined, rememberNodeRole() {} }));
vi.mock('../knock-inbox', () => ({ fetchJoinRequests: () => {} }));
vi.mock('../join-another-community', () => ({ joinAnotherCommunity: () => {}, joinedNudge: () => '', PROTECT_REDIRECT: '/', HOME_REDIRECT: '/' }));
vi.mock('../community-switch', () => ({ communitySwitched: () => () => {} }));
vi.mock('../global-join-existing', () => ({ isGlobalCommunity: () => false }));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'checking' }));
vi.mock('../node-post', () => ({
    signedGet: () => {},
    signedPost: () => {},
    anchorUrl: async () => 'https://example.com',
}));
vi.mock('../../components/WantsToJoin', () => ({ WantsToJoin: () => null }));
vi.mock('../../components/MyJoinRequests', () => ({ MyJoinRequests: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/AddedYouLines', () => ({ AddedYouLines: () => null }));

import PeopleScreen from '../../app/(tabs)/people';
import { LanguageProvider } from '../../components/LanguageProvider';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    nav.pushed.length = 0;
    nav.params = { view: 'community' };
    alerts.said.length = 0;
    data.friends = [];
    data.conversationsCreated.length = 0;
    data.answerGate = null;
    data.createConvError = null;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const settle = async (n = 8) => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe('Phone Community rows message action (S0)', () => {
    it('community row has 💬 button that opens DM with that member', async () => {
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PeopleScreen)) as any);
        });
        await settle();

        // Bob should be in the list
        expect(host.textContent).toContain('Bob');

        // Look for the message button on Bob's row (accessibilityLabel='Message' or text '💬')
        const buttons = Array.from(host.querySelectorAll('button'));
        const msgBtn = buttons.find(b => b.getAttribute('aria-label') === 'Message' || b.textContent === '💬');
        expect(msgBtn, '💬 button on community row should be rendered').toBeTruthy();

        // Tapping 💬 creates DM and navigates to /chat/<id>
        await act(async () => {
            msgBtn!.click();
        });
        await settle();

        expect(data.conversationsCreated.length).toBe(1);
        expect(data.conversationsCreated[0]).toEqual({
            type: 'dm',
            participants: [ME_PUBKEY, BOB_PUBKEY],
            createdBy: ME_PUBKEY,
        });
        expect(nav.pushed).toContain('/chat/conv-dm-bob');
    });

    it('a second tap while the community answers opens nothing more: one ask, one chat, a spinner meanwhile', async () => {
        let answer!: () => void;
        data.answerGate = new Promise<void>((r) => { answer = r; });
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PeopleScreen)) as any);
        });
        await settle();

        const msgBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Message');
        expect(msgBtn).toBeTruthy();
        // Two taps in the same frame, before the screen re-renders.
        await act(async () => {
            msgBtn!.click();
            msgBtn!.click();
        });
        await settle();
        const asking = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Message');
        expect(asking?.querySelector('[data-spinner]')).toBeTruthy();
        expect(asking?.textContent).not.toContain('💬');
        // And a third once it shows the spinner.
        await act(async () => {
            asking!.click();
        });
        await settle();
        expect(data.conversationsCreated.length).toBe(1);

        await act(async () => { answer(); });
        await settle();

        expect(data.conversationsCreated.length).toBe(1);
        expect(nav.pushed).toEqual(['/chat/conv-dm-bob']);
        const after = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Message');
        expect(after?.textContent).toBe('💬');
    });

    // A paused account opens no new conversation (removal by vote S1): the node answers 403 `paused` in its words.
    const PAUSED_OPEN_WORDS = 'Your account here is paused for now, so you can’t start a new conversation. You can still answer the ones you’re in.';
    it.each([
        { way: "a community row's 💬", view: 'community' },
        { way: "a friend's 💬", view: 'friends' },
    ])("$way while the account is paused (403 paused): the node's words, and no chat opens", async ({ view }) => {
        nav.params = { view };
        if (view === 'friends') data.friends = [{ publicKey: BOB_PUBKEY, callsign: 'Bob', avatar_url: null, addedAt: '2026-10-01T00:00:00.000Z' }];
        data.createConvError = new Error(PAUSED_OPEN_WORDS);
        await act(async () => {
            root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PeopleScreen)) as any);
        });
        await settle();

        const msgBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Message');
        expect(msgBtn, `💬 on ${view}`).toBeTruthy();
        await act(async () => {
            msgBtn!.click();
        });
        await settle();

        expect(alerts.said).toContain(PAUSED_OPEN_WORDS);
        expect(alerts.said.some(s => s.includes('Connect to your community'))).toBe(false);
        expect(nav.pushed).toEqual([]);
    });
});
