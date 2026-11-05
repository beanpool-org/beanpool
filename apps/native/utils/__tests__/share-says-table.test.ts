// @vitest-environment jsdom
/**
 * Render tests for SharePostButtons on phone (native), testing all rows of the share-says specification, through the ONE
 * Share button's sheet (DESIGN-detail-pages-fable.md §2.5, DP2): every row's sentences are the sheet items' lines, read
 * after a tap on 🔗 Share:
 * - Row 1: Sharing outside on
 * - Row 2: Sharing outside off, any member may invite
 * - Row 3: Sharing outside off, only admins invite, member not an admin
 * - Row 4: Sharing outside off, only admins invite, member is owner/admin
 * - Row 5: Open door (global)
 * - Row 6: Private preview (member vs admin)
 * - Fallback: settings cannot be read
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SharePostButtons } from '../../components/SharePost';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
    emit: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
    profile: null as any,
    role: null as any,
    /** What the node said: false = no answer at all. */
    answered: true,
    /** The last role this phone kept for this node: undefined = nothing kept. */
    kept: undefined as any,
    recognition: 'member' as string,
    /** The signed request to the node: the peek link is made through it. */
    signed: vi.fn(),
}));

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'),
        Text: el('span'),
        Pressable: el('button'),
        ScrollView: el('div'),
        Modal:({ visible, children }: { visible: boolean; children?: any }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
        Alert: { alert: vi.fn() },
        Share: { share: vi.fn() },
        DeviceEventEmitter: { emit: nav.emit },
    };
});

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

vi.mock('expo-router', async () => {
    const { useEffect } = await import('react');
    return {
        router: nav.router,
        useFocusEffect: (cb: () => void | (() => void)) => useEffect(() => cb(), [cb]),
    };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://node.example' : null)),
        setItem: vi.fn(async () => {}),
    },
}));

vi.mock('../db', () => ({
    signedRequestWithMethod: mockState.signed,
    signedGet: vi.fn(),
}));

// The real Invite and share button (one invite action) asks who this phone is and whether it is a guest.
vi.mock('../nodes', () => ({
    isGuestNode: vi.fn(async () => false),
}));

vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => mockState.profile,
}));

vi.mock('../node-admin', () => ({
    cachedNodeRoleHeard: vi.fn(async () => (mockState.answered ? { role: mockState.role, communityName: 'Test Node' } : null)),
    askNodeRole: vi.fn(async () => (mockState.answered ? { role: mockState.role, communityName: 'Test Node' } : null)),
    persistNodeRole: vi.fn(async () => {}),
    readPersistedNodeRole: vi.fn(async () => mockState.kept),
}));

vi.mock('../../app/NodeStatusContext', () => ({
    useNodeStatus: () => ({ recognition: mockState.recognition }),
}));

vi.mock('../identity', () => ({
    useIdentity: () => ({ publicKey: 'user-pk' }),
    loadIdentity: async () => ({ publicKey: 'user-pk' }),
}));

const themeColors = {
    text: { body: '#000', secondary: '#666', onBrand: '#fff' },
    border: { strong: '#ccc', default: '#ddd' },
    surface: { card: '#fff' },
    brand: { fill: '#060' },
    feedback: { danger: { fg: '#900' } },
};
vi.mock('../../app/ThemeContext', () => ({
    useStyles: (fn: any) => fn({ colors: themeColors }),
    useTheme: () => ({ colors: themeColors }),
}));

const samplePost = {
    id: 'post-123',
    title: 'Ladder for borrowing',
    type: 'offer',
    category: 'tools',
    description: 'A 6m ladder in good condition',
    credits: 0,
    authorPublicKey: 'author-pk',
    status: 'active',
    active: true,
    audienceScope: 'public',
};

describe('SharePostButtons — share-says table rows (phone)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockState.role = null;
        mockState.profile = null;
        mockState.answered = true;
        mockState.kept = undefined;
        mockState.recognition = 'member';
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
    });

    const get = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    /** Draw the post's Share and open its sheet: the ways and their sentences are read in the sheet. */
    const render = async (post: any = samplePost) => {
        await act(async () => { root.render(createElement(SharePostButtons, { post }) as any); });
        await settle();
        // Before the tap: one Share button on the page, and none of the ways or their sentences.
        expect(container.querySelectorAll('[data-testid="share-open-button"]')).toHaveLength(1);
        expect(get('share-sheet')).toBeNull();
        expect(get('share-members-button')).toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('share-outside-line')).toBeNull();
        await act(async () => { (get('share-open-button') as HTMLElement).click(); });
        await settle();
        expect(get('share-sheet')).not.toBeNull();
    };

    it('Row 1: Sharing outside on — keeps both buttons, says members only and 7 days line', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: true, door: 'members', knocks: true },
        };

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-outside-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('share-outside-line')?.textContent).toBe('Anyone with the link can read this listing for 7 days, without names or faces, then ask to join. You can stop it any time.');
        // One flow: Invite and share is the only invite action, here too (the member may invite).
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(container.querySelectorAll('[data-testid="invite-and-share-button"]')).toHaveLength(1);
        expect(get('invite-someone-button')).toBeNull();
    });

    it('Row 2: Sharing outside off, any member may invite — Share with members, members only line, ONE invite action (Invite and share)', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'members' },
        };

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        const inviteBtn = get('invite-and-share-button');
        expect(inviteBtn).not.toBeNull();
        // The way's name, its sentence under it in the same item.
        expect(inviteBtn?.firstElementChild?.textContent).toBe('Invite and share');
        // Exactly one invite action: the old Invite someone button never shows beside it.
        expect(container.querySelectorAll('[data-testid="invite-and-share-button"]')).toHaveLength(1);
        expect(get('invite-someone-button')).toBeNull();
        expect(container.textContent).not.toContain('Invite someone');
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 3: Sharing outside off, only admins invite, member not an admin — Share with members, only admins invite line, no button', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        };
        mockState.role = null;

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull(); // the seam for Ask an admin (#2775)
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 4: Sharing outside off, only admins invite, member is owner/admin — as second row', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        };
        mockState.role = 'admin';

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 5: Open door (global) — no line under share buttons', async () => {
        mockState.profile = {
            profile: 'global',
            features: { door: 'open', openJoin: true, invites: false, shareOutside: false },
        };

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 6: Private preview — member sees third row, admin sees second row', async () => {
        // Non-admin member
        mockState.profile = {
            profile: 'local',
            features: { privatePreview: true, door: 'admins', shareOutside: false },
        };
        mockState.role = null;

        await render();

        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();

        act(() => { root.unmount(); });
        root = createRoot(container);

        // Admin member
        mockState.role = 'owner';
        await render();

        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(get('invite-someone-button')).toBeNull();
    });

    it('Fallback: settings cannot be read — shows today buttons and no line', async () => {
        mockState.profile = null;

        await render();

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('share-outside-line')).toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
    });

    it('Row 1 with joining paused: the outside line never promises to ask to join', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: true, door: 'members', knocks: false } };
        await render();
        expect(get('share-outside-line')?.textContent).toBe('Anyone with the link can read this listing for 7 days, without names or faces. You can stop it any time.');
    });

    it('Share outside carries ONE note before the tap: the 7 days, no names or faces, you can stop it (not two notes)', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: true, door: 'members', knocks: true } };
        await render();
        expect(get('share-outside-line')?.textContent).toContain('without names or faces');
        expect(get('share-outside-line')?.textContent).toContain('You can stop it any time.');
        expect(get('share-outside-line')?.textContent).toContain('7 days');
        expect(get('share-outside-privacy')).toBeNull();
    });

    it('an event row says "event", never "listing"', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: true, door: 'members', knocks: true } };
        await render({ ...samplePost, type: 'event', eventEndAt: new Date(Date.now() + 86400000).toISOString() });
        expect(get('share-outside-line')?.textContent).toBe('Anyone with the link can read this event for 7 days, without names or faces, then ask to join. You can stop it any time.');
    });

    it('only admins invite, no answer from the node and nothing kept: no line and no button (not "only admins invite")', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'admins' } };
        mockState.answered = false;
        await render();
        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
    });

    it('only admins invite, no answer from the node: the role kept on the phone is used, so an owner offline keeps the button', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'admins' } };
        mockState.answered = false;
        mockState.kept = 'owner';
        await render();
        expect(get('invite-and-share-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
    });

    it('only admins invite, no answer and the kept role is "none": says only admins invite', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'admins' } };
        mockState.answered = false;
        mockState.kept = null;
        await render();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
    });

    it('a guest here (or one the node has not recognised yet) is not offered Invite and share', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'members' } };
        mockState.recognition = 'stranger';
        await render();
        expect(get('share-members-button')).not.toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
        act(() => { root.unmount(); });
        root = createRoot(container);
        mockState.recognition = 'unknown';
        await render();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
    });

    it('invites off with a members door: no invite action and no members line', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'members', invites: false } };
        await render();
        expect(get('share-members-button')).not.toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('invite-and-share-button')).toBeNull();
        expect(get('share-members-note')).toBeNull();
    });

    /** The ways the sheet offers, in order (Cancel sits outside them). */
    const ways = () => Array.from(container.querySelectorAll('[data-testid="share-sheet-ways"] > button'))
        .map((b) => b.getAttribute('data-testid'));

    it('sharing outside off and invites off: the sheet has one way, Share with members (a sheet of one is the same door)', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'members', invites: false } };
        await render();
        expect(ways()).toEqual(['share-members-button']);
    });

    it('every way in its order: members, outside, Invite and share; each sentence under its own name', async () => {
        mockState.profile = { profile: 'local', features: { shareOutside: true, door: 'members', knocks: true } };
        await render();
        expect(ways()).toEqual(['share-members-button', 'share-outside-button', 'invite-and-share-button']);
        expect(get('share-members-button')?.contains(get('share-members-note'))).toBe(true);
        expect(get('share-outside-button')?.contains(get('share-outside-line'))).toBe(true);
        expect(get('invite-and-share-button')?.contains(get('invite-and-share-line'))).toBe(true);
        expect(get('invite-and-share-line')?.textContent).toBe('One invite, for one person: a code works once.');
    });

    it('the sheet is not the share: no link is made until Share outside is tapped, and then no second question', async () => {
        const { Alert, Share } = await import('react-native');
        mockState.signed.mockImplementation(async (_m: string, path: string) =>
            path === '/api/peek' ? { ticket: 'AbCdEfGhIjKlMnOpQrSt_-', postId: samplePost.id, expiresAt: '2999-01-01T00:00:00Z' } : {});
        mockState.profile = { profile: 'local', features: { shareOutside: true, door: 'members', knocks: true } };
        await render();
        expect(mockState.signed.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/peek')).toHaveLength(0);
        expect(Share.share).not.toHaveBeenCalled();

        await act(async () => { (get('share-outside-button') as HTMLElement).click(); });
        await settle();
        expect(mockState.signed.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/peek')).toHaveLength(1);
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(Share.share).toHaveBeenCalledWith({
            message: `${samplePost.title}\nhttps://node.example/?post=${samplePost.id}&peek=AbCdEfGhIjKlMnOpQrSt_-`, title: samplePost.title,
        });
        // Handed over: the sheet has closed.
        expect(get('share-sheet')).toBeNull();
    });

    it('Share with members hands the members\' link over from the sheet, then closes it', async () => {
        const { Share } = await import('react-native');
        mockState.profile = { profile: 'local', features: { shareOutside: false, door: 'members' } };
        await render();
        await act(async () => { (get('share-members-button') as HTMLElement).click(); });
        await settle();
        expect(Share.share).toHaveBeenCalledWith({ message: `${samplePost.title}\nhttps://node.example/?post=${samplePost.id}`, title: samplePost.title });
        expect(get('share-sheet')).toBeNull();
    });
});
