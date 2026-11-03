// @vitest-environment jsdom
/**
 * Joining offers the last photo, and never applies it (Profile S3, scratch/fable-design/DESIGN-per-community-profile-fable.md §4).
 *
 * The real wizard that follows a join (app/profile-setup.tsx), rendered in jsdom with React Native's host components as plain
 * tags (styles kept as a data attribute so the 320 dp checks can read them), on a community that holds no photo for the member
 * while the phone keeps a photo they used in ANOTHER community. Every request is recorded. The tickbox starts off; with it off
 * nothing of that photo is shown here or sent here; ticked, it is the member's pick and goes like any pick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: any) => children, KeyboardAvoidingView: ({ children }: any) => children, KeyboardStickyView: ({ children }: any) => children })); // the real one needs the keyboard library's native side
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flat = (style: unknown): Record<string, unknown> =>
    (Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean).reduce((all: Record<string, unknown>, s: any) => ({ ...all, ...s }), {});

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', checkbox: 'checkbox' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, accessibilityState, disabled, value, onChangeText, style } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState && 'checked' in accessibilityState) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (style) attrs['data-style'] = JSON.stringify(flat(style));
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), SafeAreaView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        KeyboardAvoidingView: el('div'), Alert: { alert: vi.fn() },
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', null, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
        // The floor of the audience's phones: 320 dp wide, the system font at 130 % (Marty).
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
const scheme = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    return {
        useTheme: () => ({ colors: scheme.theme === 'dark' ? darkColors : lightColors, theme: scheme.theme }),
        useStyles: (f: (t: unknown) => unknown) => f({ colors: scheme.theme === 'dark' ? darkColors : lightColors, theme: scheme.theme }),
        useOnboardingColors: () => onboardingColors(scheme.theme),
    };
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
// Shows which picture it is given, so the preview and the offer's thumbnail can be told apart.
vi.mock('../../components/MemberAvatar', () => ({
    MemberAvatar: ({ avatarUrl, size }: { avatarUrl?: string | null; size?: number }) => createElement('span', { 'data-avatar': avatarUrl ?? '', 'data-size': String(size ?? '') }),
}));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => ({ profile: 'local', features: { beans: true, invites: true }, checkedAt: new Date().toISOString() }) }));
vi.mock('../identity', () => ({ updateCallsign: vi.fn(async () => null) }));
// This community's row for the member, as the members sync left it; null: it holds none for the member yet.
const community = vi.hoisted(() => ({ row: null as null | Record<string, unknown> }));
const calls = vi.hoisted(() => ({ updateMemberProfile: [] as Array<{ pubkey: string; data: Record<string, unknown> }> }));
vi.mock('../db', () => ({
    createPost: vi.fn(async () => undefined),
    getMemberProfile: vi.fn(async () => community.row),
    updateMemberProfile: vi.fn(async (pubkey: string, data: Record<string, unknown>) => { calls.updateMemberProfile.push({ pubkey, data }); }),
}));
// The photo the phone keeps from the community the member used last (the offer's source), and nothing else of it.
const last = vi.hoisted(() => ({ value: null as null | { avatar: string; from: string | null } }));
vi.mock('../canonical-profile', () => ({ getCanonicalAvatar: vi.fn(async () => null), getLastPhoto: vi.fn(async () => last.value) }));
// The phone's saved communities: where the offer reads the name of the community the photo came from.
const saved = vi.hoisted(() => ({ nodes: [] as Array<{ url: string; alias?: string }> }));
vi.mock('../nodes', () => ({ getSavedNodes: vi.fn(async () => saved.nodes) }));
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
import { lightColors, palette } from '../../constants/colors';
import { onboardingColors } from '../onboarding-colors';

const HERE = 'https://second.example.test';
const FIRST = 'https://first.example.test';
const KEY = 'a'.repeat(64);
const LAST_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

let host: HTMLElement | null = null;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: string | undefined }> = [];

beforeEach(() => {
    mem.store.clear();
    mem.store.set('beanpool_anchor_url', HERE);
    nav.params = { redirect: '/(tabs)' };
    nav.router.replace.mockClear();
    calls.updateMemberProfile = [];
    community.row = { public_key: KEY, callsign: 'Rosa', avatar_url: null };
    last.value = { avatar: LAST_PHOTO, from: FIRST };
    saved.nodes = [{ url: FIRST, alias: 'First Beans' }, { url: HERE, alias: 'Second Beans' }];
    scheme.theme = 'light';
    requests = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
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
const offerBox = () => document.querySelector('[data-testid="last-photo-offer"]') as HTMLElement | null;
async function tick() {
    await act(async () => { offerBox()!.click(); });
    await settle();
}
async function pickPhoto() {
    await act(async () => { (document.querySelector('[data-testid="pick-photo"]') as HTMLElement).click(); });
    await settle();
}
const published = () => requests.filter(r => r.url === `${HERE}/api/profile/update`).map(r => JSON.parse(r.body ?? '{}'));
const previewPhoto = () => (document.querySelector('[data-size="96"]') as HTMLElement | null)?.getAttribute('data-avatar') ?? null;
const styleOf = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, any>;

describe('joining offers the last photo as a tickbox that starts off', () => {
    it('shows the offer on the photo step, off, naming the community the photo came from, and previews nothing of it', async () => {
        await render();
        expect(text()).toContain('Choose your look');
        const box = offerBox()!;
        expect(box).not.toBeNull();
        expect(box.getAttribute('role')).toBe('checkbox');
        expect(box.getAttribute('aria-checked')).toBe('false');
        expect(box.getAttribute('aria-label')).toBe('Use the photo from First Beans?');
        expect(box.textContent).toContain('Use the photo from First Beans?');
        // The photo is shown only as the thing on offer (the small picture inside the offer), never as this community's.
        expect(previewPhoto()).toBe('');
        expect(box.querySelector('[data-size="40"]')!.getAttribute('data-avatar')).toBe(LAST_PHOTO);
        // Nothing is chosen yet, so the step cannot go on: the box did not tick itself.
        expect(button('Next →')!.getAttribute('aria-disabled')).toBe('true');
        expect(requests).toEqual([]);
        // Ticking it is the member's own act, and is what lets the step go on.
        await tick();
        expect(button('Next →')!.getAttribute('aria-disabled')).toBeNull();
    });

    it('names the community by its host when the phone keeps no name for it, and plainly when it does not know where the photo came from', async () => {
        saved.nodes = [];
        await render();
        expect(offerBox()!.getAttribute('aria-label')).toBe('Use the photo from first.example.test?');
        act(() => root!.unmount()); host!.remove(); root = null; host = null;
        last.value = { avatar: LAST_PHOTO, from: null };
        await render();
        expect(offerBox()!.getAttribute('aria-label')).toBe('Use the photo you chose last?');
    });

    it('with the box OFF, Done sends no avatar for the last photo, whatever the phone keeps (the node is told "unchanged")', async () => {
        // A community that already holds a photo for the member shows no offer, so nothing offered can be sent; and a join
        // that is only here to set a name sends the name alone.
        community.row = { public_key: KEY, callsign: 'Rosa', avatar_url: '/api/avatar/' + KEY + '?size=thumb&v=1&k=2' };
        await render();
        expect(offerBox()).toBeNull();
        // This community holds a photo for the member, so the wizard opens at the name; Next waits for the debounced name check.
        await act(async () => { await new Promise(r => setTimeout(r, 450)); });
        await settle();
        await click('Next →');
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY }]);
        expect(JSON.stringify(published())).not.toContain(LAST_PHOTO);
    });

    it('with the box OFF and another photo picked, only the picked photo goes', async () => {
        await render();
        await click('Choose Photo or Avatar');
        await pickPhoto();
        expect(offerBox()!.getAttribute('aria-checked')).toBe('false');
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK }]);
        expect(calls.updateMemberProfile.map(c => c.data.avatar_url)).toEqual([PICK]);
        expect(JSON.stringify(requests)).not.toContain(LAST_PHOTO);
    });

    it('ticked, the offered photo is the member\'s pick: previewed, allowed through Next, and sent by Done like any pick', async () => {
        await render();
        await tick();
        expect(offerBox()!.getAttribute('aria-checked')).toBe('true');
        expect(previewPhoto()).toBe(LAST_PHOTO);
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: LAST_PHOTO }]);
        expect(calls.updateMemberProfile.map(c => c.data.avatar_url)).toEqual([LAST_PHOTO]);
        expect(nav.router.replace).toHaveBeenCalledWith('/(tabs)');
    });

    it('ticked and then un-ticked, nothing of it is left to send', async () => {
        await render();
        await tick();
        await tick();
        expect(offerBox()!.getAttribute('aria-checked')).toBe('false');
        expect(previewPhoto()).toBe('');
        expect(button('Choose Photo or Avatar')).toBeDefined();
        expect(JSON.stringify(requests)).not.toContain(LAST_PHOTO);
    });

    it('ticked and then another photo picked, the box un-ticks and the other photo is what goes', async () => {
        await render();
        await tick();
        await click('Change Photo or Avatar');
        await pickPhoto();
        expect(offerBox()!.getAttribute('aria-checked')).toBe('false');
        await click('Next →');
        await click('Done');
        expect(published()).toEqual([{ publicKey: KEY, avatar: PICK }]);
    });

    it('offers nothing when the member has used no photo, or when the last photo was set in this very community', async () => {
        last.value = null;
        await render();
        expect(offerBox()).toBeNull();
        act(() => root!.unmount()); host!.remove(); root = null; host = null;
        last.value = { avatar: LAST_PHOTO, from: HERE };
        await render();
        expect(offerBox()).toBeNull();
    });

    it('offers nothing when the phone cannot read what it kept: an offer is a courtesy, never a gate', async () => {
        const mod = await import('../canonical-profile');
        (mod.getLastPhoto as any).mockRejectedValueOnce(new Error('storage unavailable'));
        await render();
        expect(offerBox()).toBeNull();
        expect(text()).toContain('Choose your look');
    });
});

describe('the tickbox at 320 dp with the system font at 130 %, in light and in dark', () => {
    const ratio = (a: string, b: string) => {
        const lum = (hex: string) => {
            const h = hex.replace('#', '');
            const [r, g, b2] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
            return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
        };
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };

    for (const theme of ['light', 'dark'] as const) {
        it(`${theme}: the words wrap beside a box and a picture that keep their size, the row is a full touch target, and every colour is a token`, async () => {
            scheme.theme = theme;
            // The longest name a community has: it must wrap inside the card, not push the box off the edge.
            saved.nodes = [{ url: FIRST, alias: 'The Mullumbimby Neighbours Bean Exchange' }];
            await render();
            const row = offerBox()!;
            const { colors } = onboardingColors(theme);

            const rowStyle = styleOf(row);
            expect(rowStyle.flexDirection).toBe('row');
            expect(rowStyle.minHeight).toBeGreaterThanOrEqual(48);
            expect(rowStyle.backgroundColor).toBe(colors.surface.subtle);
            expect(rowStyle.borderColor).toBe(colors.border.strong);

            const spans = Array.from(row.querySelectorAll('span'));
            const label = spans.find(s => s.textContent?.startsWith('Use the photo from'))!;
            const labelStyle = styleOf(label);
            // flex: 1 + flexShrink: 1 is how a React Native Text wraps instead of overflowing its row.
            expect(labelStyle.flex).toBe(1);
            expect(labelStyle.flexShrink).toBe(1);
            expect(labelStyle.color).toBe(colors.text.body);
            expect(label.textContent).toContain('The Mullumbimby Neighbours Bean Exchange');

            const divs = Array.from(row.querySelectorAll('div'));
            const box = divs.find(d => styleOf(d).width === 24)!;
            const boxStyle = styleOf(box);
            expect(boxStyle.height).toBe(24);
            expect(boxStyle.flexShrink).toBe(0);
            expect(boxStyle.borderColor).toBe(colors.text.secondary);
            const thumb = divs.find(d => d !== box && styleOf(d).flexShrink === 0)!;
            expect(thumb).toBeDefined();

            // 320 - 2 x 20 (screen padding) - 2 x 20 (card padding) - 2 x 12 (row padding) = 216 dp for box + gap + picture + gap
            // + words: the fixed parts (24 + 12 + 40 + 12 = 88) leave the words 128 dp, which they wrap inside.
            const fixed = 24 + boxStyle.marginRight + 40 + styleOf(thumb).marginRight;
            expect(fixed).toBe(88);
            expect(320 - 80 - 24 - fixed).toBeGreaterThanOrEqual(120);

            // The unticked outline reads against the row (3:1 for a UI part) and the words against it (4.5:1), from the tokens.
            expect(ratio(colors.text.secondary, colors.surface.subtle)).toBeGreaterThanOrEqual(3);
            expect(ratio(colors.text.body, colors.surface.subtle)).toBeGreaterThanOrEqual(4.5);

            // Ticked: the blue fill, and the tick in the inverse ink on it (4.5:1 in both schemes).
            await tick();
            const ticked = Array.from(offerBox()!.querySelectorAll('div')).find(d => styleOf(d).width === 24)!;
            expect(styleOf(ticked).backgroundColor).toBe(palette.blue600);
            // The fill alone reads 2.9:1 on the dark row, so dark outlines it in the lighter blue; light's fill already reads.
            const outline = theme === 'dark' ? palette.blue400 : palette.blue600;
            expect(styleOf(ticked).borderColor).toBe(outline);
            const tickMark = Array.from(ticked.querySelectorAll('span')).find(s => s.textContent === '✓')!;
            expect(styleOf(tickMark).color).toBe(colors.text.inverse);
            expect(ratio(colors.text.inverse, palette.blue600)).toBeGreaterThanOrEqual(4.5);
            expect(ratio(outline, colors.surface.subtle)).toBeGreaterThanOrEqual(3);
        });
    }

    it('light draws the classic light tokens', () => {
        expect(onboardingColors('light').colors).toBe(lightColors);
    });
});
