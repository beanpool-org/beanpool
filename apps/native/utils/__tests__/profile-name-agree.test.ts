// @vitest-environment jsdom
/**
 * profile-name-agree tests:
 * 1. My Profile, opened with a stale local row / a different device-wide name, shows and caches the active
 *    community's own record for this key once it answers.
 * 2. It brings identity.callsign in line when they differ.
 * 3. It keeps showing the cached one offline, never the device-wide name when a community record exists.
 * 4. Editing the name writes to the node, the local row, and the device-wide identity.
 * 5. My Profile says in small text which community this name is for ("Your name in <community>").
 * 6. The invite picker shows a short key prefix under each name to disambiguate same-named / similar-named members.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], buttons: [] as Array<{ text?: string; onPress?: () => unknown }> }));

const inputSetters = vi.hoisted(() => new Map<string, (v: string) => void>());

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link', radio: 'radio', alert: 'alert', switch: 'switch', checkbox: 'checkbox' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityHint, accessibilityRole, testID, placeholder, numberOfLines, adjustsFontSizeToFit, minimumFontScale, onLayout, value, onChangeText, disabled, accessibilityState } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) {
            attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value);
            attrs.value = value ?? '';
            if (accessibilityLabel) inputSetters.set(accessibilityLabel, onChangeText);
        }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityHint) attrs['data-hint'] = accessibilityHint;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.disabled !== undefined) attrs['aria-disabled'] = String(accessibilityState.disabled);
        if (placeholder) attrs.placeholder = placeholder;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const FlatList = ({ data, renderItem, keyExtractor }: Record<string, any>) =>
        createElement('div', { 'data-list': 'true' },
            (data ?? []).map((item: any, index: number) =>
                createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : String(index) }, renderItem({ item, index }))
            )
        );
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        TouchableOpacity: el('button'), SafeAreaView: el('div'), ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                for (const b of buttons ?? []) { if (b.text) alerts.said.push(b.text); alerts.buttons.push(b); }
            },
        },
        Share: { share: async () => ({}) },
        Linking: { openURL: async () => {}, openSettings: async () => {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        AccessibilityInfo: { announceForAccessibility: () => {}, isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        FlatList,
        RefreshControl: ({ refreshing, onRefresh }: { refreshing?: boolean; onRefresh?: () => void }) =>
            createElement('button', { 'data-testid': 'refresh-control', onClick: onRefresh }, refreshing ? 'refreshing' : 'pull-to-refresh'),
    };
});

const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push: () => {}, navigate: () => {}, replace: () => {}, back: () => {}, setParams: () => {}, canGoBack: () => true },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useLocalSearchParams: () => params.now,
    };
});

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...store.map.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => store.map.delete(k)); }),
    },
}));

vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, notificationAsync: async () => {}, selectionAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => ({}), openAuthSessionAsync: async () => ({ type: 'cancel' }), maybeCompleteAuthSession: () => ({}) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => createElement('div', { 'data-qr': 'true' }) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children, refreshControl }: { children?: unknown; refreshControl?: unknown }) =>
        createElement('div', null, refreshControl as any, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => ({ success: true }),
}));
vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///data/user/0/app/files/',
    getInfoAsync: async () => ({ exists: true, size: 5000000 }),
    readDirectoryAsync: async () => [],
    deleteAsync: async () => {},
}));
vi.mock('expo-location', () => ({
    getForegroundPermissionsAsync: async () => ({ status: 'granted', canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors, themePreference: 'light', setThemePreference() {}, patternEnabled: false, setPatternEnabled() {} }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});

const { KEY, PRIV, NODE } = vi.hoisted(() => ({
    KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PRIV: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    NODE: 'https://mullum.example',
}));

// The real setIdentity is a useState setter: the SAME function on every render, and calling it re-renders with
// the new identity. A fresh function per render re-ran the profile loader on every render, which hid the
// order-dependent bugs below (the review of #2439 measured each one with this one change).
const identityState = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = {
        identity: {
            publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            privateKey: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
            callsign: 'Marty',
        } as any,
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
        setIdentity: (id: any) => { state.identity = id; listeners.forEach((l) => l()); },
    };
    return state;
});

vi.mock('../../app/IdentityContext', async () => {
    const { useSyncExternalStore } = await import('react');
    return {
        useIdentity: () => ({
            identity: useSyncExternalStore(identityState.subscribe, () => identityState.identity),
            setIdentity: identityState.setIdentity,
        }),
    };
});

vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
vi.mock('../../components/KeeperProtectionPanel', () => ({ KeeperProtectionPanel: () => null }));
vi.mock('../../components/AddWordsForm', () => ({ AddWordsForm: () => null }));
vi.mock('../../components/RecoveryKitButtons', () => ({ RecoveryKitButtons: () => null }));
vi.mock('../../components/SsoEnrolSheet', () => ({ SsoEnrolSheet: () => null }));
vi.mock('../../components/PricingGuideModal', () => ({ PricingGuideModal: () => null }));
vi.mock('../../components/OneWayBackCard', () => ({ OneWayBackCard: () => null }));
vi.mock('../../components/WordsOnScreen', () => ({
    NoScreenCapture: ({ children }: { children?: unknown }) => createElement(Fragment, null, children as any),
    CopyClearsNote: () => null, NoScreenLockNote: () => null,
}));
vi.mock('../../components/NoWordsNotice', () => ({ NoWordsNotice: () => null }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ busy: false, start() {}, dialog: null }) }));
vi.mock('../../components/KnownConsentCard', () => ({ KnownConsentCard: () => null }));
vi.mock('../../components/RecoveryAlertBanner', () => ({ RecoveryAlertBanner: () => null }));
vi.mock('../../components/VaultMoveCard', () => ({ VaultMoveCard: () => null }));
vi.mock('../../components/NodeAdminEntry', () => ({ NodeAdminEntry: () => null }));
vi.mock('../../components/OwnerWordsCard', () => ({ OwnerWordsCard: () => null }));
vi.mock('../../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../../components/useModalKeyboardLift', () => ({ useModalKeyboardLift: () => ({ lift: 0, maxHeight: 600 }) }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: {} }) }));
vi.mock('../node-profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../node-profile')>();
    return {
        ...actual,
        membersByKey: () => false,
        beansOn: () => true,
        nearbyListingsOn: () => false,
    };
});
vi.mock('../members-lookup', () => ({ lookUpMembers: vi.fn(async () => []), searchPath: () => null }));
vi.mock('../community-list-note', () => ({ pickerEmpty: () => ({ title: 'No one here yet', subtitle: '' }) }));
vi.mock('../haptics', () => ({ hapticTick: vi.fn(), hapticSuccess: vi.fn(), hapticWarning: vi.fn() }));

const mockDb = vi.hoisted(() => ({
    currentKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    localProfile: null as any,
    remoteCallsign: null as string | null,
    savedNodes: [{ url: 'https://mullum.example', alias: 'Mullum Commons' }] as any[],
    updatedProfiles: [] as any[],
    updatedIdentities: [] as string[],
    invitablePeople: [] as any[],
}));

vi.mock('../db', () => ({
    getMemberProfile: vi.fn(async (pk: string) => {
        if (pk === mockDb.currentKey) return mockDb.localProfile;
        return null;
    }),
    updateMemberProfile: vi.fn(async (pk: string, data: any) => {
        mockDb.updatedProfiles.push({ pk, ...data });
        if (pk === mockDb.currentKey) {
            mockDb.localProfile = { ...(mockDb.localProfile || { public_key: pk }), ...data };
        }
    }),
    fetchNodeCallsign: vi.fn(async (url: string, pk: string, privKey?: string) => {
        return mockDb.remoteCallsign;
    }),
    getSavedNodes: vi.fn(async () => mockDb.savedNodes),
    getInvitablePeople: vi.fn(async () => mockDb.invitablePeople),
    inviteGroupMemberApi: vi.fn(async () => ({ success: true })),
    signedRequest: async () => ({}),
    signedGet: async () => new Response('{}', { status: 404 }),
    signedRequestWithMethod: async () => ({}),
    resetDmChatMemory: async () => ({ ok: true }),
    getDatabaseStats: async () => ({ members: 10, posts: 10, transactions: 1, messages: 1, integrity: 'ok' }),
    closeDB: async () => {}, initDB: async () => {}, clearDB: async () => {},
    isFriendLocal: async () => true,
    removeFriendOnNode: async () => {},
    redeemInvite: async () => {},
    syncMessages: async () => {},
}));

vi.mock('../identity', () => ({
    loadIdentity: vi.fn(async () => identityState.identity),
    updateCallsign: vi.fn(async (newCallsign: string) => {
        mockDb.updatedIdentities.push(newCallsign);
        identityState.identity = { ...identityState.identity, callsign: newCallsign };
        return identityState.identity;
    }),
    hasMnemonic: () => false,
}));

vi.mock('../node-post', () => ({
    anchorUrl: async () => store.map.get('beanpool_anchor_url') ?? NODE,
    signedPost: async () => new Response(JSON.stringify({}), { status: 200 }),
}));
vi.mock('../blocklist', () => ({ getBlockedUsers: async () => [], unblockUser: async () => {}, clearBlocklist: async () => {}, BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({ 'x-signature': 'sig' }) }));
vi.mock('../membership-probe', () => ({ fetchMembership: async () => ({ ok: true, json: async () => ({ isMember: true }) }) }));
vi.mock('../node-admin', () => ({
    fetchMyNodeRole: async () => ({ role: null, communityName: 'Mullum Commons' }),
    rememberNodeRole: () => {},
    canManageNode: () => false,
}));
vi.mock('../vault', () => ({
    hasVault: () => false,
    vaultCopyKnowledge: async () => 'known',
    vaultStatus: async () => ({ holds: [] }),
    approvedHolds: async () => [],
    forgetEndedApprovals: async () => {},
}));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {}, isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
    performSyncWhenFree: async () => ({ success: true }), forceResyncNotice: () => ({ title: 'Success', message: '' }), syncCursorKeysOf: () => [],
}));
vi.mock('../use-global-entry', () => ({ useGlobalEntry: () => 'none' }));
vi.mock('../use-global-guest-visit', () => ({ useGlobalGuestVisit: () => ({ visiting: false, openGuestVisit: async () => {} }) }));

import SettingsScreen from '../../app/(tabs)/settings';
import { InvitePeopleSheet } from '../../components/InvitePeopleSheet';
import { resolveProfilePublishAvatar } from '../avatar-value';
import { CANONICAL_PROFILE_STORE_KEY } from '../storage-keys';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    alerts.buttons.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_saved_nodes', JSON.stringify([{ url: NODE, alias: 'Mullum Commons' }]));
    identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: 'Marty' };
    params.now = {};
    mockDb.localProfile = null;
    mockDb.remoteCallsign = null;
    mockDb.updatedProfiles.length = 0;
    mockDb.updatedIdentities.length = 0;
    mockDb.invitablePeople = [
        { publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', callsign: 'Marty', avatarUrl: null },
        { publicKey: '89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567', callsign: 'Marty party', avatarUrl: null },
        { publicKey: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', callsign: 'Alice', avatarUrl: null },
    ];
});

const realFetch = globalThis.fetch;

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    globalThis.fetch = realFetch;
});

const settle = async (n = 10) => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

// The node behind fetch: every profile Save it receives, or a transport failure for an offline one.
const mockNode = ({ offline = false } = {}) => {
    const updates: any[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: any) => {
        if (String(url).includes('/api/profile/update')) {
            if (offline) throw new TypeError('Network request failed');
            const body = JSON.parse(init.body);
            updates.push(body);
            if (typeof body.callsign === 'string') mockDb.remoteCallsign = body.callsign;
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { updates };
};

const renderSettings = async () => {
    await act(async () => { root.render(createElement(SettingsScreen) as any); });
    await settle();
};
const press = async (text: string) => {
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
    expect(btn, `a "${text}" button`).toBeDefined();
    await act(async () => { (btn as HTMLElement).click(); });
    await settle();
};
const pull = async () => {
    await act(async () => { (host.querySelector('[data-testid="refresh-control"]') as HTMLElement).click(); });
    await settle();
};
const field = (label: string) => (host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null)?.value;
const type = async (label: string, value: string) => {
    await act(async () => { inputSetters.get(label)?.(value); });
    await settle(2);
};

describe('profile-name-agree: My Profile and Invite picker', () => {
    it('shows and caches the active community record when community answers, bringing identity.callsign in line when unset', async () => {
        // Marty has unset device-wide name "", stale local row "Old Stale Marty"
        identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: '' };
        mockDb.localProfile = { public_key: KEY, callsign: 'Old Stale Marty' };
        mockDb.remoteCallsign = 'Marty party';

        await act(async () => {
            root.render(createElement(SettingsScreen) as any);
        });
        await settle();

        // 1. Must show "Marty party"
        expect(host.textContent).toContain('Marty party');

        // 2. Must cache to local SQLite row
        const cachedUpdate = mockDb.updatedProfiles.find((u) => u.pk === KEY && u.callsign === 'Marty party');
        expect(cachedUpdate).toBeDefined();

        // 3. Must bring identity.callsign in line when unset
        expect(identityState.identity.callsign).toBe('Marty party');

        // 4. Must say which community this name is for
        expect(host.textContent).toContain('Your name in Mullum Commons');
    });

    it('routine profile viewing preserves device-wide identity callsign to protect multi-community isolation', async () => {
        // Marty has device-wide name "Marty", but this community knows him as "Marty party"
        identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: 'Marty' };
        mockDb.localProfile = { public_key: KEY, callsign: 'Old Stale Marty' };
        mockDb.remoteCallsign = 'Marty party';

        await act(async () => {
            root.render(createElement(SettingsScreen) as any);
        });
        await settle();

        // Must show community name "Marty party"
        expect(host.textContent).toContain('Marty party');
        // Must cache community name to local SQLite
        const cachedUpdate = mockDb.updatedProfiles.find((u) => u.pk === KEY && u.callsign === 'Marty party');
        expect(cachedUpdate).toBeDefined();
        // Preserves device-wide identity callsign across communities
        expect(identityState.identity.callsign).toBe('Marty');
    });

    it('keeps showing the cached community record offline, never the device-wide name when a community record exists', async () => {
        // Device-wide name is "Marty", cached community record in SQLite is "Marty party"
        identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: 'Marty' };
        mockDb.localProfile = { public_key: KEY, callsign: 'Marty party' };
        mockDb.remoteCallsign = null; // offline / unreachable

        await act(async () => {
            root.render(createElement(SettingsScreen) as any);
        });
        await settle();

        // Shows cached "Marty party", NOT device-wide "Marty"
        expect(host.textContent).toContain('Marty party');
        expect(mockDb.updatedProfiles.length).toBe(0);
    });

    it('pull-to-refresh asks the active community and updates My Profile', async () => {
        identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: 'Marty' };
        mockDb.localProfile = { public_key: KEY, callsign: 'Old Stale Marty' };
        mockDb.remoteCallsign = 'Old Stale Marty';

        await act(async () => {
            root.render(createElement(SettingsScreen) as any);
        });
        await settle();

        expect(host.textContent).toContain('Old Stale Marty');

        // Community is renamed or updated on web/peer
        mockDb.remoteCallsign = 'Marty party';

        // Trigger pull-to-refresh
        const refreshBtn = host.querySelector('[data-testid="refresh-control"]');
        expect(refreshBtn).toBeDefined();
        await act(async () => {
            (refreshBtn as HTMLElement).click();
        });
        await settle();

        expect(host.textContent).toContain('Marty party');
        expect(identityState.identity.callsign).toBe('Marty');
        expect(mockDb.updatedProfiles.some((u) => u.pk === KEY && u.callsign === 'Marty party')).toBe(true);
    });

    it('editing the name writes to the node, the local row and the device-wide identity', async () => {
        identityState.identity = { publicKey: KEY, privateKey: PRIV, callsign: 'Marty' };
        mockDb.localProfile = { public_key: KEY, callsign: 'Marty' };
        mockDb.remoteCallsign = 'Marty';

        // Mock node profile update
        let nodePayload: any = null;
        globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: any) => {
            const u = String(url);
            if (u.includes('/api/profile/update')) {
                nodePayload = JSON.parse(init.body);
                mockDb.remoteCallsign = nodePayload.callsign;
                return new Response(JSON.stringify({ success: true }), { status: 200 });
            }
            return new Response('{}', { status: 200 });
        }) as typeof fetch;

        await act(async () => {
            root.render(createElement(SettingsScreen) as any);
        });
        await settle();

        // Click Edit profile button
        const editBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('✏️ Edit'));
        expect(editBtn).toBeDefined();
        await act(async () => {
            (editBtn as HTMLElement).click();
        });
        await settle();

        // Find callsign input and type new name
        const callsignInput = host.querySelector('input[aria-label="Callsign"]');
        expect(callsignInput).toBeTruthy();
        expect(inputSetters.has('Callsign')).toBe(true);

        await act(async () => {
            inputSetters.get('Callsign')?.('Marty Renamed');
        });
        await settle();

        // Click Save Profile button
        const saveBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Save Profile'));
        expect(saveBtn).toBeDefined();
        await act(async () => {
            (saveBtn as HTMLElement).click();
        });
        await settle();

        // 1. Wrote to node
        expect(nodePayload?.callsign).toBe('Marty Renamed');

        // 2. Wrote to local row
        const localRow = mockDb.updatedProfiles.find((u) => u.pk === KEY && u.callsign === 'Marty Renamed');
        expect(localRow).toBeDefined();

        // 3. Wrote to device-wide identity
        expect(mockDb.updatedIdentities).toContain('Marty Renamed');
        expect(identityState.identity.callsign).toBe('Marty Renamed');
    });

    // Edit on your own profile (public-profile.tsx) and the home photo step open Settings with section: 'profile', so the
    // editor is open before the loader has read anything. The device-wide name is "Marty" throughout.
    it.each([
        ['the community answers', 'Marty party', 'Marty party', 'Marty party'],
        ['the community cannot be reached (the cached row)', 'Marty party', null, 'Marty party'],
        ['the cached row is stale (renamed on the web)', 'Marty party', 'Marty P', 'Marty P'],
    ])('opened straight into the editor, the name field starts from this community\'s record when %s, and an untouched Save renames no one', async (_case, row, remote, community) => {
        params.now = { section: 'profile' };
        mockDb.localProfile = { public_key: KEY, callsign: row };
        mockDb.remoteCallsign = remote;
        const node = mockNode();

        await renderSettings();
        expect(field('Callsign')).toBe(community);

        await press('Save Profile');
        expect(node.updates).toHaveLength(1);
        // No name, or the one this community already holds: never the device-wide "Marty", never the stale row.
        expect([undefined, community]).toContain(node.updates[0].callsign);
        expect(mockDb.localProfile.callsign).toBe(community);
        expect(identityState.identity.callsign).toBe('Marty');
        expect(mockDb.updatedIdentities).toEqual([]);
    });

    it('an offline rename survives the next answer from the community, so the queued retry publishes the NEW name', async () => {
        mockDb.localProfile = { public_key: KEY, callsign: 'Marty party' };
        // The node holds the old name until the queued retry lands.
        mockDb.remoteCallsign = 'Marty party';
        mockNode({ offline: true });

        await renderSettings();
        await press('✏️ Edit');
        await type('Callsign', 'Marty Renamed');
        await press('Save Profile');

        expect(alerts.said).toContain('Offline Mode');
        expect(store.map.get('pending_profile_sync')).toBe('true');
        // pillar-sync's retry (pushProfileToServer) publishes `profile?.callsign || identity.callsign` from this row.
        expect(mockDb.localProfile.callsign).toBe('Marty Renamed');
        expect(host.textContent).toContain('Marty Renamed');

        // A pull asks the community again, and it still answers the old name.
        await pull();
        expect(mockDb.localProfile.callsign).toBe('Marty Renamed');
        expect(host.textContent).toContain('Marty Renamed');
        expect(host.textContent).not.toContain('Marty party');
        expect(mockDb.updatedProfiles.filter((u) => u.callsign === 'Marty party')).toEqual([]);
    });

    it.each([
        ['no row yet (a community this phone has not synced)', null],
        ['a row with no photo', { public_key: KEY, callsign: 'Old Stale Marty', avatar_url: null }],
    ])('the background write never puts the canonical photo into the row with %s, so a catch-up publish cannot send it over a newer one the node holds', async (_case, row) => {
        const OLDER_PHOTO = 'data:image/png;base64,T0xERVI=';
        store.map.set(CANONICAL_PROFILE_STORE_KEY, JSON.stringify({ avatar: OLDER_PHOTO, bio: 'Canonical bio' }));
        mockDb.localProfile = row;
        mockDb.remoteCallsign = 'Marty party';

        await renderSettings();
        expect(mockDb.localProfile?.callsign).toBe('Marty party');
        expect(mockDb.localProfile.avatar_url ?? null).toBeNull();

        // The post-redeem publish, told by the node that it holds a photo, decides from this row.
        const decision = await resolveProfilePublishAvatar({
            catchUp: { localRow: mockDb.localProfile.avatar_url, canonical: OLDER_PHOTO, nodeHasNoPhoto: false },
        });
        expect(decision.avatar).toBeNull();
    });

    it('a pull inside the profile editor keeps what the member is typing and refreshes only what they have not touched', async () => {
        mockDb.localProfile = { public_key: KEY, callsign: 'Marty party', bio: 'Old bio', contact_value: 'old@x', contact_visibility: 'community' };
        mockDb.remoteCallsign = 'Marty party';
        mockNode();

        await renderSettings();
        await press('✏️ Edit');
        await type('Bio', 'New bio typed');
        await type('Contact details', 'new@x');

        // Renamed on the web meanwhile: the untouched name field follows the community.
        mockDb.remoteCallsign = 'Marty P';
        await pull();
        expect(field('Bio')).toBe('New bio typed');
        expect(field('Contact details')).toBe('new@x');
        expect(field('Callsign')).toBe('Marty P');

        // And a name being typed is kept like the rest.
        await type('Callsign', 'Marty Typed');
        mockDb.remoteCallsign = 'Marty Q';
        await pull();
        expect(field('Callsign')).toBe('Marty Typed');
        expect(field('Bio')).toBe('New bio typed');
        expect(field('Contact details')).toBe('new@x');
    });

    it('shows short key prefix under each name in the invite picker to tell same/similar names apart', async () => {
        await act(async () => {
            root.render(createElement(InvitePeopleSheet, {
                isOpen: true,
                groupId: 'test-group',
                groupName: 'Test Crew',
                existing: new Set<string>(),
                onClose: () => {},
            }) as any);
        });
        await settle();

        // Check that "Marty" and "Marty party" both exist
        expect(host.textContent).toContain('Marty');
        expect(host.textContent).toContain('Marty party');

        // Check that their short key prefixes (slice 0, 8) are displayed under the names
        expect(host.textContent).toContain('01234567');
        expect(host.textContent).toContain('89abcdef');
        expect(host.textContent).toContain('fedcba98');
    });
});
