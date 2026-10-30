// @vitest-environment jsdom
/**
 * Re-run Setup's name is this community's own (Profile S2, review of #2617): the real wizard (app/profile-setup.tsx),
 * rendered in jsdom with React Native's host components as plain tags, against a community whose members row holds one
 * name while the phone's `identity.callsign` (the join pre-fill, whatever the member last chose in ANY community) is
 * another. Every request is recorded. The name steps start from the community's row, the photo step previews it, and
 * Done sends and remembers a name only when the member gave one: a name the wizard merely showed is never published, so
 * it cannot clash at join, rename the member here, or travel to the next community.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: { alert: vi.fn() },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Rosa' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity: vi.fn() }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
const PICK = 'bundled://bean-green';
// The picker, as one button that picks: what the wizard does with a pick is the test, not the sheet.
vi.mock('../../components/AvatarPickerSheet', () => ({
    AvatarPickerSheet: ({ onSelectImage }: { onSelectImage: (uri: string) => void }) => createElement('button', { 'data-testid': 'pick-photo', onClick: () => onSelectImage('bundled://bean-green') }, 'pick'),
}));
vi.mock('../../components/OnboardingGuide', () => ({ OnboardingGuide: () => createElement('div', { 'data-testid': 'guide' }) }));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: { beans: true, invites: true }, checkedAt: new Date().toISOString() }) }));
const calls = vi.hoisted(() => ({ updateCallsign: [] as string[], updateMemberProfile: [] as Array<{ pubkey: string; data: Record<string, unknown> }> }));
vi.mock('../identity', () => ({ updateCallsign: vi.fn(async (name: string) => { calls.updateCallsign.push(name); return null; }) }));
// This community's row for the member, as the members sync left it; null: it holds none for the member yet.
const community = vi.hoisted(() => ({ row: null as null | Record<string, unknown> }));
vi.mock('../db', () => ({
    createPost: vi.fn(async () => undefined),
    getMemberProfile: vi.fn(async () => community.row),
    updateMemberProfile: vi.fn(async (pubkey: string, data: Record<string, unknown>) => { calls.updateMemberProfile.push({ pubkey, data }); }),
}));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../callsign-suggest', () => ({ checkCallsignAvailable: vi.fn(async () => 'available'), suggestCallsigns: vi.fn(async () => []) }));
vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json', 'X-Public-Key': 'a'.repeat(64) })),
}));
vi.mock('../../components/AddressSearch', () => ({ AddressSearch: () => null }));
vi.mock('expo-location', () => ({
    Accuracy: { Low: 2 },
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getCurrentPositionAsync: vi.fn(async () => ({ coords: { latitude: 0, longitude: 0 } })),
}));

import ProfileSetupScreen from '../../app/profile-setup';
import { keepPendingProfileChange, pendingProfileChange } from '../pending-profile-sync';

const NODE = 'https://second.example.test';
const KEY = 'a'.repeat(64);

let host: HTMLElement | null = null;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: string | undefined }> = [];
let status = 200;

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', NODE);
    nav.params = { redirect: '/(tabs)' };
    nav.router.replace.mockClear();
    calls.updateCallsign = [];
    calls.updateMemberProfile = [];
    community.row = null;
    requests = [];
    status = 200;
    (globalThis as any).fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
        if (status === 0) throw new Error('offline');
        return { ok: status < 400, status, json: async () => ({ success: true }) };
    });
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ProfileSetupScreen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const text = () => document.body.textContent ?? '';
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLElement | undefined;
async function click(label: string) {
    const b = button(label);
    if (!b) throw new Error(`no button ${label}`);
    await act(async () => { b.click(); });
    await settle();
}
async function pickPhoto() {
    await act(async () => { (document.querySelector('[data-testid="pick-photo"]') as HTMLElement).click(); });
    await settle();
}
const nameBox = () => document.querySelector('input[aria-label="Your callsign"]') as HTMLInputElement | null;
async function typeName(value: string) {
    const input = nameBox()!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The availability check is debounced; Next waits for it.
    await act(async () => { await new Promise(r => setTimeout(r, 450)); });
    await settle();
}
const published = () => requests.filter(r => r.url === `${NODE}/api/profile/update`).map(r => JSON.parse(r.body ?? '{}'));

describe('Re-run Setup starts from this community\'s own name, not the phone-wide one (review of #2617)', () => {
    it('a second community that holds "Rosa 2" for the member opens on the photo, previews "Rosa 2", and Done sends no name', async () => {
        community.row = { public_key: KEY, callsign: 'Rosa 2', avatar_url: null };
        await render();
        // Name fine, no photo: the photo step first, as before.
        expect(text()).toContain('Choose your look');
        expect(text()).toContain('Rosa 2');
        expect(text()).not.toMatch(/Rosa(?! 2)/);

        await pickPhoto();
        await click('Next →');
        await click('Done');

        // The photo goes; the name the wizard only showed does not (it would have 409'd as "Rosa", or renamed them).
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK }]);
        // The phone's pre-fill is not moved by a name the member did not give, and this community's row keeps its own.
        expect(calls.updateCallsign).toEqual([]);
        expect(calls.updateMemberProfile.map(c => c.data.callsign)).toEqual(['Rosa 2']);
        expect(nav.router.replace).toHaveBeenCalledWith('/(tabs)');
    });

    it('the name step is seeded with this community\'s name, and a name the member gives goes, and is remembered as the pre-fill', async () => {
        community.row = { public_key: KEY, callsign: 'Rosa 2', avatar_url: null };
        await render();
        await click('Back');
        expect(nameBox()!.value).toBe('Rosa 2');

        await typeName('Rosa Bean');
        await click('Next →');
        await pickPhoto();
        await click('Next →');
        await click('Done');

        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK, callsign: 'Rosa Bean' }]);
        expect(calls.updateCallsign).toEqual(['Rosa Bean']);
        expect(calls.updateMemberProfile.map(c => c.data.callsign)).toEqual(['Rosa Bean']);
    });

    it('a community that holds no row for the member yet shows the join pre-fill, and still sends no name it did not get from the member', async () => {
        community.row = null;
        await render();
        expect(text()).toContain('Choose your look');
        expect(text()).toContain('Rosa');
        await pickPhoto();
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK }]);
        expect(calls.updateCallsign).toEqual([]);
    });

    it('the name the global door joined with is kept as before: shown, not re-sent, and remembered as the pre-fill', async () => {
        nav.params = { redirect: '/(tabs)', name: 'Rosa Door' };
        community.row = { public_key: KEY, callsign: 'Rosa Door', avatar_url: null };
        await render();
        expect(text()).toContain('Choose your look');
        expect(text()).toContain('Rosa Door');
        await pickPhoto();
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK }]);
        expect(calls.updateCallsign).toEqual(['Rosa Door']);
    });

    it('a name an earlier offline save is still holding for this community goes with the publish, so clearing the waiting change loses nothing', async () => {
        community.row = { public_key: KEY, callsign: 'Rosa 2', avatar_url: null };
        await keepPendingProfileChange(NODE, KEY, { callsign: 'Rosa Parked' });
        await render();
        await pickPhoto();
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK, callsign: 'Rosa Parked' }]);
        expect(await pendingProfileChange(NODE, KEY)).toBeNull();
    });

    it('offline with no name given: only the pick is kept for the retry, the name is not invented into it', async () => {
        community.row = { public_key: KEY, callsign: 'Rosa 2', avatar_url: null };
        status = 0;
        await render();
        await pickPhoto();
        await click('Next →');
        await click('Done');
        expect(await pendingProfileChange(NODE, KEY)).toEqual({ publicKey: KEY, avatar: PICK });
    });
});
