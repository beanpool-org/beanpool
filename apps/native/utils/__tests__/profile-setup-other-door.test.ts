// @vitest-environment jsdom
/**
 * How BeanPool works, in profile setup, at another community's open door (slice S2, issue #2563): the real wizard
 * (app/profile-setup.tsx) gives the guide the community's name where the phone is on a community that is not the global
 * one and has Beans off, so its card says "<name> has no Beans", never "the global community". The harness is
 * profile-setup-area.test.ts's (react-dom in jsdom, React Native's host components as plain tags); the guide is a stub
 * that records what it was given (its own words are onboarding-components-words-render.test.ts's). Nothing is asked of any
 * node: the name is the phone's saved one, else the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: any) => children, KeyboardAwareScrollView: ({ children }: any) => children, KeyboardStickyView: ({ children }: any) => children }));
vi.mock('../../components/useKeepCaretVisible', () => ({ useKeepCaretVisible: () => ({ scrollRef: { current: null }, scrollProps: {} }) })); // the real one needs the keyboard library's native side
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, value, onChangeText, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (tag === 'button') attrs['data-style'] = JSON.stringify(Object.assign({}, ...[style].flat(3).filter(Boolean)));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: { alert: vi.fn() },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
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
const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' };
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: IDENTITY, setIdentity: vi.fn() }) }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
    // The edges it pads, so a test can see a screen asked for the status bar's inset.
    SafeAreaView: ({ children, edges }: { children?: unknown; edges?: string[] }) => createElement('div', { 'data-safe-area-edges': (edges ?? ['all']).join(',') }, children as any),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('../../components/AvatarPickerSheet', () => ({ AvatarPickerSheet: () => null }));
const guide = vi.hoisted(() => ({ props: null as null | { beansOn?: boolean; community?: string } }));
vi.mock('../../components/OnboardingGuide', () => ({
    OnboardingGuide: (props: { beansOn?: boolean; community?: string }) => { guide.props = props; return createElement('div', { 'data-testid': 'guide' }); },
}));
vi.mock('../../components/MemberAvatar', () => ({ MemberAvatar: () => createElement('span') }));
const prof = vi.hoisted(() => ({ value: null as any }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => prof.value }));
vi.mock('../identity', () => ({ updateCallsign: vi.fn(async () => null) }));
vi.mock('../db', () => ({ createPost: vi.fn(async () => undefined), getMemberProfile: vi.fn(async () => ({ avatar_url: '/api/avatar/aaa?size=thumb' })), updateMemberProfile: vi.fn(async () => undefined) }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null) }));
vi.mock('../callsign-suggest', () => ({ checkCallsignAvailable: vi.fn(async () => 'available'), suggestCallsigns: vi.fn(async () => []) }));
// The signature is the request-binding suite's business: here it records what was signed, so a test can see that the
// precise position was never in it.
const signed = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string; body: string }> }));
vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async (method: string, url: string, body: string) => {
        signed.calls.push({ method, url, body });
        return { 'Content-Type': 'application/json', 'X-Public-Key': 'a'.repeat(64) };
    }),
}));
const BYRON = { displayName: 'Byron Bay, New South Wales, Australia', shortName: 'Byron Bay', lat: -28.647412, lng: 153.612031, type: 'town' };
vi.mock('../../components/AddressSearch', () => ({
    AddressSearch: ({ onPick }: { onPick: (r: typeof BYRON) => void }) => createElement('button', { 'data-testid': 'pick-byron', onClick: () => onPick(BYRON) }, 'Byron Bay'),
}));
const loc = vi.hoisted(() => ({ status: 'granted', canAsk: true, asked: 0, coords: { latitude: -28.647412, longitude: 153.612031 } }));
vi.mock('expo-location', () => ({
    Accuracy: { Low: 2 },
    getForegroundPermissionsAsync: vi.fn(async () => ({ status: loc.status === 'ask' ? 'undetermined' : loc.status })),
    requestForegroundPermissionsAsync: vi.fn(async () => { loc.asked += 1; return { status: loc.status === 'ask' ? 'denied' : loc.status }; }),
    getCurrentPositionAsync: vi.fn(async () => ({ coords: loc.coords })),
}));

import ProfileSetupScreen from '../../app/profile-setup';

const GLOBAL = 'https://global.beanpool.org';
const HALL = 'https://hall.example.org';
const NO_BEANS = { openJoin: true, beans: false };

let host: HTMLElement | null = null;
let root: Root | null = null;
const fetched: string[] = [];

beforeEach(() => {
    mem.store.clear();
    guide.props = null;
    fetched.length = 0;
    nav.params = { name: 'Sally', redirect: '/(tabs)' };
    (globalThis as any).fetch = vi.fn(async (url: string) => { fetched.push(url); return { ok: false, status: 404, json: async () => ({}) }; });
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
/** The wizard on `anchor` with a community that says `features`, taken to its guide step (name given, so photo then guide). */
async function toGuide(anchor: string, features: unknown) {
    mem.store.set('beanpool_anchor_url', anchor);
    prof.value = { profile: 'global', features, checkedAt: new Date().toISOString() };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ProfileSetupScreen as any) as unknown as Parameters<Root['render']>[0]); });
    await settle();
    const next = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Next →') as HTMLElement;
    await act(async () => { next.click(); });
    await settle();
    expect(document.querySelector('[data-testid="guide"]')).not.toBeNull();
}

describe("profile setup's guide at another community's open door (issue #2563)", () => {
    it('Beans off at a community that is not the global one: the guide is given its name (the host when none is saved)', async () => {
        await toGuide(HALL, NO_BEANS);
        expect(guide.props).toEqual({ beansOn: false, community: 'hall.example.org' });
        // Nothing was asked of any node for it.
        expect(fetched).toEqual([]);
    });

    it("the phone's saved name for the community, when it has one", async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: HALL, alias: 'Mullum Hall' }]));
        await toGuide(HALL, NO_BEANS);
        expect(guide.props).toEqual({ beansOn: false, community: 'Mullum Hall' });
    });

    it("the global community's own guide is unchanged: no name, so its card says what it said", async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: GLOBAL, alias: 'Global community' }]));
        await toGuide(GLOBAL, NO_BEANS);
        expect(guide.props).toEqual({ beansOn: false, community: undefined });
    });

    it('a community with Beans on: no name, the three cards about Beans as before', async () => {
        await toGuide(HALL, { beans: true, invites: true });
        expect(guide.props).toEqual({ beansOn: true, community: undefined });
    });
});
