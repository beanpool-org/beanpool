// @vitest-environment jsdom
/**
 * A keeper editing their enterprise's Offer on the phone (Damo, 26 Oct: "Error — Post not found or not owned by you"):
 * app/post/[id].tsx rendered for real. A member who keeps the enterprise that listed it sees Edit, changes the title, adds a
 * photo and saves: the phone sends utils/db.ts updatePost (signed as the member: the node takes it from a keeper since this
 * change, apps/server test-enterprise-post-edit-http, which replays this request over real HTTP), then shows the Offer as
 * saved. A member who keeps nothing sees no Edit.
 *
 * The phone's half was already right; the node refused it. So this test passes on origin/main too: it pins the phone's
 * request and screen, and the server suite is the one that fails there.
 *
 * Its tags, on the same page (DESIGN-owner-seeding-tags-fable.md §4.4, §4.7): sent only when the member changed them, for a
 * keeper as for an author, however the listing moved under the open form. Those tests fail on a page that compares the form
 * with `post` as it stands at Save: the blocking finding of #2663, a phone's Edit wiping real tags, kept alive by a reload.
 *
 * The listing page's harness is post-deal-open-render.test.ts's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(Module as any)._extensions['.png'] = (m: { exports: unknown }) => { m.exports = 1; };
(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const alerts = vi.hoisted(() => ({ said: [] as string[], last: [] as Array<{ text?: string; onPress?: () => unknown }> }));
/** The events the page listens for: sync_data_updated is its reload. */
const emitter = vi.hoisted(() => ({ on: new Map<string, Set<() => void>>() }));
vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', link: 'link' };
    const flat = (style: unknown): Record<string, any> => Object.assign({}, ...[style].flat(4).filter((x) => x && typeof x === 'object'));
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, placeholder, onLayout, value, onChangeText, disabled, source } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (placeholder) attrs.placeholder = placeholder;
        if (source?.uri) attrs['data-src'] = source.uri;
        void flat(props.style);
        return createElement(tag, attrs, children);
    };
    const listener = () => ({ remove() {} });
    const absolute = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        Image: el('img'),
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), TouchableOpacity: el('button'),
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: absolute, absoluteFillObject: absolute, flatten: (s: unknown) => flat(s) },
        Alert: {
            alert: (title: string, body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => {
                alerts.said.push(title);
                if (body) alerts.said.push(body);
                alerts.last = buttons ?? [];
            },
        },
        Linking: { openURL: async () => {} },
        DeviceEventEmitter: {
            addListener: (name: string, cb: () => void) => {
                const set = emitter.on.get(name) ?? new Set();
                emitter.on.set(name, set.add(cb));
                return { remove() { set.delete(cb); } };
            },
            emit(name: string) { for (const cb of [...(emitter.on.get(name) ?? [])]) cb(); },
        },
        BackHandler: { addEventListener: listener },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Keyboard: { addListener: listener, dismiss() {} },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const params = vi.hoisted(() => ({ now: {} as Record<string, string> }));
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, canGoBack: () => true, setParams() {} },
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => cb(), [cb]),
        useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }),
        useLocalSearchParams: () => params.now,
        ErrorBoundary: () => null,
    };
});
const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-image', () => ({ Image: (p: { accessibilityLabel?: string }) => createElement('img', p.accessibilityLabel ? { 'aria-label': p.accessibilityLabel } : null) }));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, WHEN_UNLOCKED: 2, AFTER_FIRST_UNLOCK: 3 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: (len: number) => new Uint8Array(randomBytes(len)), randomUUID: () => 'a-uuid' };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-local-authentication', () => ({ SecurityLevel: { NONE: 0 }, hasHardwareAsync: async () => false, isEnrolledAsync: async () => false, authenticateAsync: async () => ({ success: false }) }));
// The system photo picker, which asks for no permission: every call recorded.
const device = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('expo-image-picker', () => ({
    requestCameraPermissionsAsync: async () => { device.asked.push('camera permission'); return { granted: true }; },
    requestMediaLibraryPermissionsAsync: async () => { device.asked.push('library permission'); return { granted: true }; },
    launchCameraAsync: async () => { device.asked.push('camera'); return { canceled: true }; },
    launchImageLibraryAsync: async () => { device.asked.push('picker'); return { canceled: false, assets: [{ uri: 'file:///hens.jpg' }] }; },
}));
vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => ({ uri: 'file:///hens.small.jpg', width: 800, height: 600, base64: 'SEVOUw==' }),
}));
vi.mock('expo-location', () => ({ getForegroundPermissionsAsync: async () => ({ status: 'denied' }), getLastKnownPositionAsync: async () => null }));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
    KeyboardController: { dismiss: async () => {} },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@react-native-picker/picker', () => ({
    Picker: Object.assign(({ children }: { children?: unknown }) => createElement('select', null, children as any), {
        Item: ({ label }: { label: string }) => createElement('option', null, label),
    }),
}));
vi.mock('../haptics', () => ({ hapticTick: () => {}, hapticSuccess: () => {}, hapticWarning: () => {}, hapticLight: () => {} }));
vi.mock('../../services/pillar-sync', () => ({
    requestSync: async () => {},
    isPillarSyncActive: () => false, syncLandedOnThisCopy: async () => false, PILLAR_SYNC_ENDED: 'pillar_sync_ended',
}));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }),
    };
});
const ME = { publicKey: 'me-key', callsign: 'Damo', privateKey: 'p' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span', { 'data-avatar': 'true' }) }));
vi.mock('../../components/EventDetail', () => ({ EventDetail: () => null }));
vi.mock('../blocklist', () => ({ blockUser: async () => {}, getBlockedUsers: async () => [], BLOCKLIST_UPDATED_EVENT: 'blocklist_updated' }));
vi.mock('../profile-status', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../profile-status')>()),
    getProfileStatus: async () => ({ complete: true, missingName: false, missingAvatar: false }),
}));
const net = vi.hoisted(() => ({ calls: [] as string[], args: new Map<string, unknown[]>(), answer: null as null | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls, (name, args) => { net.args.set(name, args); return net.answer?.(name, args); }));

import { LanguageProvider } from '../../components/LanguageProvider';
import PostDetailScreen from '../../app/post/[id]';

const NODE = 'https://mullum.example';
const ENT = 'eggs-enterprise-key';
const OWN_PHOTO = `${NODE}/api/marketplace/posts/p-eggs/photos/0?k=abc`;
const NEW_PHOTO = 'data:image/jpeg;base64,SEVOUw==';
/** The enterprise's Offer: written by the enterprise, listed by a keeper, with one photo already. */
const EGGS = {
    id: 'p-eggs', type: 'offer', status: 'active', title: 'Dozen eggs', description: 'Laid this week', category: 'food',
    author_pubkey: ENT, author_callsign: 'Mullum Eggs', credits: 6, price_type: 'fixed', photos: JSON.stringify([OWN_PHOTO]), repeatable: 1,
    audience_scope: 'public', created_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
};

/** The node and the phone's copy: getPost answers the listing as it now is, and an edit saved changes it. */
function answers(keeperOf: string[], row: () => Record<string, unknown> = () => ({})) {
    let post: Record<string, unknown> = { ...EGGS };
    const database = { getFirstAsync: async () => null, getAllAsync: async () => [] };
    return (name: string, args: unknown[]) => {
        if (name === 'getPost') return Promise.resolve({ ...post, ...row() });
        if (name === 'updatePost') {
            const u = args[1] as Record<string, unknown>;
            post = { ...post, title: u.title, description: u.description, photos: u.photos };
            return Promise.resolve(undefined);
        }
        if (name === 'pausePost') {
            post = { ...post, status: 'paused' };
            return Promise.resolve(undefined);
        }
        if (name === 'resumePost') {
            post = { ...post, status: 'active' };
            return Promise.resolve(undefined);
        }
        const table: Record<string, unknown> = {
            getDb: database, getMemberRatings: { average: 4.5, count: 3 }, getUnreadCountForPost: 0,
            getBalance: { isBlockedFromTrading: false, keeperOf }, fetchGroupDetails: { group: { viewerRole: null } },
        };
        return name in table ? Promise.resolve(table[name]) : undefined;
    };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    net.calls.length = 0;
    net.args.clear();
    alerts.said.length = 0;
    alerts.last = [];
    device.asked.length = 0;
    store.map.clear();
    store.map.set('beanpool_anchor_url', NODE);
    store.map.set('beanpool_node_profiles', JSON.stringify({ [NODE]: {
        profile: 'local', features: { beans: true, escrow: true, enterprises: true, decisions: true, invites: true, showcase: false }, checkedAt: new Date().toISOString(),
    } }));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(keeperOf: string[], row?: () => Record<string, unknown>) {
    net.answer = answers(keeperOf, row);
    params.now = { id: EGGS.id };
    await act(async () => { root.render(createElement(LanguageProvider as any, { deviceTags: ['en-US'], initial: 'en' }, createElement(PostDetailScreen)) as any); });
    await settle();
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
async function click(el: Element | null, what: string) {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle(4);
}
async function type(label: string, value: string) {
    const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
    expect(input, label).toBeTruthy();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe("a keeper editing their enterprise's Offer", () => {
    it('Edit, a new title and a photo from the gallery, Save: the edit goes as the member, and the saved Offer shows', async () => {
        await open([ENT]);
        expect(host.textContent).toContain('Dozen eggs');
        await click(button('✏️ Edit Post'), 'Edit Post');
        await type('Title', 'Dozen free-range eggs');

        await click(host.querySelector('[aria-label="Add photo"]'), 'Add photo');
        const gallery = alerts.last.find((b) => b.text === 'Gallery');
        expect(gallery, 'Gallery').toBeTruthy();
        await act(async () => { await gallery!.onPress?.(); });
        await settle(4);
        // The system's photo picker: no permission asked for.
        expect(device.asked).toEqual(['picker']);

        await click(button('💾 Save'), 'Save');
        expect(net.calls).toContain('db.updatePost');
        expect(net.args.get('updatePost')).toEqual(['p-eggs', {
            type: 'offer', category: 'food', title: 'Dozen free-range eggs', description: 'Laid this week', credits: 6, price_type: 'fixed',
            repeatable: true, photos: JSON.stringify([OWN_PHOTO, NEW_PHOTO]),
        }]);
        // Saved: out of the form, the Offer as the node now has it.
        expect(alerts.said).not.toContain('Error');
        expect(button('💾 Save')).toBeNull();
        expect(host.textContent).toContain('Dozen free-range eggs');
        expect(button('✏️ Edit Post')).toBeTruthy();
    });

    it("Pause and resume Offer for a keeper: Pause Offer calls pausePost with member's key, and Activate Offer calls resumePost", async () => {
        await open([ENT]);
        expect(host.textContent).toContain('Dozen eggs');
        const pauseBtn = button('⏸️ Pause Offer');
        expect(pauseBtn).toBeTruthy();
        await click(pauseBtn, 'Pause Offer');
        expect(net.calls).toContain('db.pausePost');
        expect(net.args.get('pausePost')).toEqual(['p-eggs']);

        // Now Offer is paused on the screen
        const activateBtn = button('▶️ Activate Offer');
        expect(activateBtn).toBeTruthy();
        await click(activateBtn, 'Activate Offer');
        expect(net.calls).toContain('db.resumePost');
        expect(net.args.get('resumePost')).toEqual(['p-eggs']);
    });

    it('a member who keeps nothing: no Edit and no Pause', async () => {
        await open([]);
        expect(host.textContent).toContain('Dozen eggs');
        expect(button('✏️ Edit Post')).toBeNull();
        expect(button('⏸️ Pause Offer')).toBeNull();
    });
});

describe('its tags on the edit form', () => {
    const LEMON = 'food.fruit.lemon';
    const ORANGE = 'food.fruit.orange';
    /** The phone's copy of the listing has these tags. */
    const row = (tags: string) => () => ({ tags });
    /** What the page was asked to send as the edit. */
    const sent = () => (net.args.get('updatePost') as [string, Record<string, unknown>])[1];
    const reload = async () => {
        await act(async () => { for (const cb of [...(emitter.on.get('sync_data_updated') ?? [])]) cb(); });
        await settle(4);
    };
    const chip = (name: string) => host.querySelector(`[aria-label="Remove ${name}"]`);

    it('an edit that left them alone sends none: the node keeps them', async () => {
        await open([ENT], row(`${LEMON} ${ORANGE}`));
        await click(button('✏️ Edit Post'), 'Edit Post');
        expect(chip('Lemon')).toBeTruthy();
        await type('Title', 'Dozen free-range eggs');
        await click(button('💾 Save'), 'Save');
        expect(net.calls).toContain('db.updatePost');
        expect(sent()).not.toHaveProperty('tags');
    });

    it('a copy from before the tags column: the real ones land after the form opened, show in the picker, and Save still sends none', async () => {
        let tags = '';
        await open([ENT], () => ({ tags }));
        await click(button('✏️ Edit Post'), 'Edit Post');
        expect(chip('Lemon')).toBeNull();

        // The read behind getPost lands: the row has its tags now, and the page reloads on sync_data_updated.
        tags = `${LEMON} ${ORANGE}`;
        await reload();
        expect(chip('Lemon')).toBeTruthy();
        expect(chip('Orange')).toBeTruthy();

        await type('Title', 'Dozen free-range eggs');
        await click(button('💾 Save'), 'Save');
        expect(sent()).not.toHaveProperty('tags');
    });

    it('one taken off before such a reload stays off, and the save names the rest', async () => {
        let tags = LEMON;
        await open([ENT], () => ({ tags }));
        await click(button('✏️ Edit Post'), 'Edit Post');
        await click(chip('Lemon'), 'Remove Lemon');
        tags = `${LEMON} ${ORANGE}`;
        await reload();
        expect(chip('Lemon')).toBeNull();
        await click(button('💾 Save'), 'Save');
        expect(sent().tags).toEqual([ORANGE]);
    });

    it('one taken off goes as the rest; the last taken off goes as the empty list that clears them', async () => {
        await open([ENT], row(LEMON));
        await click(button('✏️ Edit Post'), 'Edit Post');
        await click(chip('Lemon'), 'Remove Lemon');
        await click(button('💾 Save'), 'Save');
        expect(sent().tags).toEqual([]);
    });
});
