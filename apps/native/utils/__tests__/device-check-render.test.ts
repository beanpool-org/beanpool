// @vitest-environment jsdom
/**
 * The device check (app/apple-probe.tsx → components/DeviceCheck.tsx; temporary, the TestFlight probe branch only, never
 * merged), rendered for real on an iPhone in a release build: both sections are drawn, and Copy results holds every field
 * the screen draws, with its raw value, and the lines to fill in.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const INVITE = 'https://riverside.example.org/?invite=INV-TEST-0001&post=a-listing-with-a-long-id';
const phone = vi.hoisted(() => ({ copied: [] as string[], iosStatus: 0 }));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, disabled, testID } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => { if (!disabled) onPress(); };
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'ios', Version: '18.7', select: (o: Record<string, unknown>) => o.ios ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TouchableOpacity: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        NativeModules: {},
    };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any) }));
vi.mock('expo-router', () => ({ router: { canGoBack: () => true, back() {}, replace() {} }, Stack: { Screen: () => null }, ErrorBoundary: () => null }));
vi.mock('expo-clipboard', () => ({
    isPasteButtonAvailable: true,
    hasStringAsync: async () => true,
    hasUrlAsync: async () => false,
    getStringAsync: async () => INVITE,
    getUrlAsync: async () => null,
    setStringAsync: async (text: string) => { phone.copied.push(text); return true; },
    ClipboardPasteButton: (props: Record<string, any>) => createElement('button', { 'data-testid': 'apple-paste', onClick: () => { props.onPress({ type: 'text', text: INVITE }); props.onPress({ type: 'text', text: null }); } }),
}));
vi.mock('expo-notifications', () => {
    const says = () => ({ status: phone.iosStatus === 2 ? 'granted' : 'undetermined', granted: phone.iosStatus === 2, canAskAgain: true, expires: 'never', ios: { status: phone.iosStatus } });
    const mod = {
        getPermissionsAsync: async () => says(),
        requestPermissionsAsync: async (ask: { ios: { allowProvisional?: boolean } }) => { phone.iosStatus = ask.ios.allowProvisional ? 3 : 2; return says(); },
    };
    return { default: mod, ...mod };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const theme = { theme: 'light', colors: lightColors };
    return { useTheme: () => theme, useStyles: (make: (t: unknown) => unknown) => make(theme) };
});
// What the development build's Sign in with Apple probe, in the same route file, loads.
vi.mock('expo-apple-authentication', () => ({}));
vi.mock('expo-crypto', () => ({}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null, isLoading: false }) }));
vi.mock('../node-post', () => ({ anchorUrl: async () => null, signedPost: async () => ({}) }));
vi.mock('../sso-signin', () => ({ SsoSignInError: class extends Error {}, fetchSsoNonce: async () => ({}) }));

import AppleProbeScreen from '../../app/apple-probe';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const tap = async (id: string) => { await act(async () => { byId(id).click(); }); await settle(); };

const ROWS = {
    'device-check-a': ['phone', 'has-text', 'has-link', 'text', 'link', 'apple-button'],
    'device-check-b': ['opened', 'now', 'quiet', 'full'],
};

it('draws both sections, and Copy results holds every field with its raw value', async () => {
    await act(async () => { root.render(createElement(AppleProbeScreen) as any); });
    await settle();
    for (const id of ['device-check-read', 'apple-paste', 'device-check-ask-quietly', 'device-check-ask-fully']) await tap(id);

    expect(byId('device-check-a').textContent).toContain('A. Invite paste');
    expect(byId('device-check-a').textContent).toContain('Copy an invite link from the test community in Safari, then come back here');
    expect(byId('device-check-b').textContent).toContain('B. Quiet notifications');
    expect(byId('device-check-b').textContent).toContain('Only works on a phone where BeanPool has never asked about notifications (a fresh install). If it already asked, these buttons show the old answer.');

    await tap('device-check-copy');
    expect(phone.copied).toHaveLength(1);
    const [results] = phone.copied;
    // Every row the screen draws, each in its section, whole: its name, its plain words and its raw value.
    for (const [section, ids] of Object.entries(ROWS)) {
        const drawn = Array.from(byId(section).querySelectorAll('div[data-testid^="device-check-"]')).map((e) => e.getAttribute('data-testid'));
        expect(drawn).toEqual(ids.map((id) => `device-check-${id}`));
        for (const id of ids) {
            const [label, said, raw] = Array.from(byId(`device-check-${id}`).querySelectorAll('span')).map((e) => e.textContent);
            expect(raw, `${id} has a raw value`).toBeTruthy();
            expect(results).toContain(`${label}: ${said} [${raw}]`);
        }
    }
    const first60 = `length ${INVITE.length}, first 60: ${JSON.stringify(INVITE.slice(0, 60))}`;
    for (const raw of [
        'ios 18.7, isPasteButtonAvailable: true', 'hasStringAsync: true', 'hasUrlAsync: false', `getStringAsync: ${first60}`, 'getUrlAsync: null', `type: text, ${first60}; then type: text, text: null`,
        'ios.status: 0 (NOT_DETERMINED), canAskAgain: true', 'status: undetermined, ios.status: 3 (PROVISIONAL)', 'status: granted, ios.status: 2 (AUTHORIZED)',
    ]) expect(results).toContain(raw);
    for (const note of [
        'Did a pop-up appear when you tapped Read what is copied? Note yes or no: ____',
        "Did a pop-up appear when you tapped Apple's button? Note yes or no: ____",
        "Did Apple's button show, how big is its icon, and what does VoiceOver say? Note it: ____",
        'Did the phone show its own question? Note yes or no: ____',
    ]) {
        expect(results).toContain(note);
        expect(host.textContent).toContain(note.replace(': ____', ''));
    }
});
