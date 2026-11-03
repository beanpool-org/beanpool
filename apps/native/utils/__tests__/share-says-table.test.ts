// @vitest-environment jsdom
/**
 * Render tests for SharePostButtons on phone (native), testing all rows of the share-says specification:
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
        StyleSheet: { create: (s: unknown) => s },
        Alert: { alert: vi.fn() },
        Share: { share: vi.fn() },
        DeviceEventEmitter: { emit: nav.emit },
    };
});

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
    signedRequestWithMethod: vi.fn(),
    signedGet: vi.fn(),
}));

vi.mock('../use-node-profile', () => ({
    useNodeProfile: () => mockState.profile,
}));

vi.mock('../node-admin', () => ({
    cachedNodeRole: vi.fn(async () => ({ role: mockState.role, communityName: 'Test Node' })),
}));

vi.mock('../identity', () => ({
    useIdentity: () => ({ publicKey: 'user-pk' }),
    loadIdentity: async () => ({ publicKey: 'user-pk' }),
}));

vi.mock('../../app/ThemeContext', () => ({
    useStyles: (fn: any) => fn({
        colors: {
            text: { body: '#000', secondary: '#666' },
            border: { strong: '#ccc' },
            surface: { card: '#fff' },
        },
    }),
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
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
    });

    const get = (id: string) => container.querySelector(`[data-testid="${id}"]`);

    it('Row 1: Sharing outside on — keeps both buttons, says members only and 7 days line', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: true, door: 'members' },
        };

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-outside-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('share-outside-note')?.textContent).toBe('Anyone can read this listing for 7 days, then ask to join.');
        expect(get('invite-someone-button')).toBeNull();
    });

    it('Row 2: Sharing outside off, any member may invite — Share with members, members only line, Invite someone button', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'members' },
        };

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        const inviteBtn = get('invite-someone-button');
        expect(inviteBtn).not.toBeNull();
        expect(inviteBtn?.textContent).toBe('Invite someone');
        expect(get('share-outside-button')).toBeNull();

        act(() => {
            (inviteBtn as HTMLElement).click();
        });
        expect(nav.emit).toHaveBeenCalledWith('set_people_view', { view: 'invites' });
        expect(nav.router.push).toHaveBeenCalledWith({ pathname: '/(tabs)/people', params: { view: 'invites' } });
    });

    it('Row 3: Sharing outside off, only admins invite, member not an admin — Share with members, only admins invite line, no button', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        };
        mockState.role = null;

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('invite-someone-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 4: Sharing outside off, only admins invite, member is owner/admin — as second row', async () => {
        mockState.profile = {
            profile: 'local',
            features: { shareOutside: false, door: 'admins' },
        };
        mockState.role = 'admin';

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('invite-someone-button')).not.toBeNull();
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 5: Open door (global) — no line under share buttons', async () => {
        mockState.profile = {
            profile: 'global',
            features: { door: 'open', openJoin: true, invites: false, shareOutside: false },
        };

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('invite-someone-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();
    });

    it('Row 6: Private preview — member sees third row, admin sees second row', async () => {
        // Non-admin member
        mockState.profile = {
            profile: 'local',
            features: { privatePreview: true, door: 'admins', shareOutside: false },
        };
        mockState.role = null;

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-note')?.textContent).toBe('This link opens for members only, and only admins invite here.');
        expect(get('invite-someone-button')).toBeNull();
        expect(get('share-outside-button')).toBeNull();

        act(() => { root.unmount(); });
        root = createRoot(container);

        // Admin member
        mockState.role = 'owner';
        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-note')?.textContent).toBe('This link opens for members only.');
        expect(get('invite-someone-button')).not.toBeNull();
    });

    it('Fallback: settings cannot be read — shows today buttons and no line', async () => {
        mockState.profile = null;

        await act(async () => {
            root.render(createElement(SharePostButtons, { post: samplePost }) as any);
        });

        expect(get('share-members-button')).not.toBeNull();
        expect(get('share-members-note')).toBeNull();
        expect(get('share-outside-note')).toBeNull();
        expect(get('invite-someone-button')).toBeNull();
    });
});
