// @vitest-environment jsdom
/**
 * The re-key screen's way out of an earlier ask (app/rekey-code.tsx, #1783 reviews C1 and D1, decided 2026-10-12).
 *
 * A member's phone showed a number for a re-key at one community, then they type another community's code. The phone
 * asks the earlier community first, and the screen then:
 * - its node can't be reached: refuses, and offers "Forget the re-key at <host>" behind a warning (Keep it, Forget it),
 *   which deletes the earlier record and its key;
 * - its node still waits for the number: refuses, says what is open and the ways out, and offers no Forget (an admin
 *   there can still type that number, and the account would land on a key no phone holds);
 * - its node bound it: finishes it, as any bound ask is finished, and never offers to forget it.
 *
 * jsdom and react-dom stand in for the phone: react-native's parts are drawn as plain elements, so this says what the
 * screen offers and what each press does, not how a phone lays it out. Storage, signing and the network are fakes; no
 * node is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RekeySlot } from '../rekey-redeem';
import type { BeanPoolIdentity } from '../identity';

type AlertButton = { text?: string; style?: string; onPress?: () => void | Promise<void> };

const fake = vi.hoisted(() => ({
    slot: null as RekeySlot | null,
    phone: null as BeanPoolIdentity | null,
    imported: [] as string[],
    alerts: [] as Array<{ title: string; message?: string; buttons?: AlertButton[] }>,
    params: {} as { link?: string },
}));

vi.mock('react-native', async () => {
    const { createElement: h } = await import('react');
    type P = { children?: ReactNode; testID?: string };
    return {
        Platform: { OS: 'android' },
        StyleSheet: { create: <T,>(s: T) => s, absoluteFillObject: {} },
        View: ({ children, testID }: P) => h('div', { 'data-testid': testID }, children),
        Text: ({ children, testID }: P) => h('span', { 'data-testid': testID }, children),
        Pressable: ({ children, onPress, disabled }: P & { onPress?: () => void; disabled?: boolean }) => h('button', { onClick: onPress, disabled }, children),
        TextInput: ({ value, onChangeText, accessibilityLabel }: { value?: string; onChangeText?: (t: string) => void; accessibilityLabel?: string }) =>
            h('input', { value, 'aria-label': accessibilityLabel, onChange: (e: { target: { value: string } }) => onChangeText?.(e.target.value) }),
        ActivityIndicator: () => h('span', null, '…'),
        Modal: ({ visible, children }: P & { visible?: boolean }) => (visible ? h('section', null, children) : null),
        Alert: { alert: (title: string, message?: string, buttons?: AlertButton[]) => { fake.alerts.push({ title, message, buttons }); } },
    };
});
vi.mock('react-native-safe-area-context', async () => {
    const { createElement: h } = await import('react');
    return { SafeAreaView: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('react-native-keyboard-controller', async () => {
    const { createElement: h } = await import('react');
    return { KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => h('div', null, children) };
});
vi.mock('expo-router', () => ({ router: { back: () => {}, replace: () => {} }, useLocalSearchParams: () => fake.params }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem: async () => {}, getItem: async () => null } }));
vi.mock('../../app/ThemeContext', () => {
    // Any colour or style the screen reads is there: what it is doesn't matter here.
    const any: unknown = new Proxy({}, { get: () => any });
    return { useTheme: () => ({ colors: any, theme: 'light' }), useStyles: () => any };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ setIdentity: () => {} }) }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../identity', () => ({
    loadIdentity: async () => fake.phone,
    draftIdentity: async () => draftKey('9'),
    importIdentity: async (i: BeanPoolIdentity) => { fake.imported.push(i.publicKey); fake.phone = i; },
    getMnemonic: async (i: BeanPoolIdentity) => i.mnemonic,
}));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
vi.mock('../member-statements', () => ({ signReEnrollStatement: async () => ({ signature: 'sig', signedFor: 'x' }) }));
vi.mock('../rekey-slot-store', () => ({
    rekeySlotStore: {
        get: async () => (fake.slot ? JSON.parse(JSON.stringify(fake.slot)) : null),
        set: async (s: RekeySlot) => { fake.slot = JSON.parse(JSON.stringify(s)); },
        clear: async () => { fake.slot = null; },
    },
}));

import RekeyCodeScreen from '../../app/rekey-code';

function draftKey(n: string): BeanPoolIdentity {
    return { publicKey: n.repeat(64), privateKey: 'e'.repeat(64), callsign: '', createdAt: '2026-10-12T00:00:00.000Z', mnemonic: Array.from({ length: 12 }, (_, i) => `w${i}`) };
}

const MULLUM = 'mullum.example.org';
const held = (): RekeySlot => ({
    community: `https://${MULLUM}`, code: 'RK-AB12-CD34', publicKey: draftKey('d').publicKey, madeHere: true, draft: draftKey('d'),
    startedAt: Date.now() - 60_000, shown: true,
});

/** What each host answers: a body, or 'offline'. */
let hosts: Record<string, unknown> = {};
const sent: string[] = [];

let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? '';
const buttonNamed = (re: RegExp) => Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent ?? '')) ?? null;
async function press(b: Element | null) {
    expect(b).not.toBeNull();
    await act(async () => { (b as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fake.slot = held();
    fake.phone = null;
    fake.imported = [];
    fake.alerts = [];
    // Opened from another community's link: the form holds bellingen's code, and nothing is resumed.
    fake.params = { link: 'https://bellingen.example.org/?rekey=RK-EEEE-FFFF' };
    hosts = { 'bellingen.example.org': { state: 'waiting', match: '31', expiresAt: new Date(Date.now() + 3600e3).toISOString() } };
    sent.length = 0;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
        const u = new URL(url);
        sent.push(`${init?.method ?? 'GET'} ${u.host}${u.pathname}`);
        const a = hosts[u.host];
        if (a === undefined || a === 'offline') throw new TypeError('Network request failed');
        return new Response(JSON.stringify(a), { status: 200 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(RekeyCodeScreen) as Parameters<Root['render']>[0]); });
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
});

describe('the re-key screen, when an earlier ask showed a number (#1783 reviews C1, D1)', () => {
    it('its node can\'t be reached: refused, with Forget behind a warning; Keep it keeps it, Forget it deletes the record and its key', async () => {
        hosts[MULLUM] = 'offline';
        await press(buttonNamed(/^Continue$/));
        expect(text()).toContain(`${MULLUM} isn’t answering`);
        const forget = buttonNamed(/^Forget the re-key at /);
        expect(forget?.textContent).toBe(`Forget the re-key at ${MULLUM}`);
        expect(sent).toEqual([`GET ${MULLUM}/api/member/re-enroll/status`]); // bellingen is never asked

        await press(forget);
        expect(fake.alerts).toHaveLength(1);
        const alert = fake.alerts[0];
        expect(alert.title).toBe(`Forget the re-key at ${MULLUM}?`);
        // The warning says what a later number does, not only an earlier one.
        expect(alert.message).toMatch(/has typed the number this phone showed, or types it later/);
        expect(alert.buttons?.map((b) => [b.text, b.style])).toEqual([['Keep it', 'cancel'], ['Forget it', 'destructive']]);

        expect(alert.buttons?.[0].onPress).toBeUndefined(); // Keep it only closes the warning
        expect(fake.slot?.publicKey).toBe(held().publicKey);

        await act(async () => { await alert.buttons?.[1].onPress?.(); });
        expect(fake.slot).toBeNull();
        expect(buttonNamed(/^Forget the re-key at /)).toBeNull();
        expect(text()).not.toContain('isn’t answering');

        // The next Continue asks bellingen, with a new key, and shows its number.
        await press(buttonNamed(/^Continue$/));
        expect(text()).toContain('31');
        expect(fake.slot).toMatchObject({ community: 'https://bellingen.example.org', code: 'RK-EEEE-FFFF', shown: true });
        expect(fake.slot?.publicKey).not.toBe(held().publicKey);
    });

    it('its node still waits for the number: refused, saying what is open and the ways out, and no Forget', async () => {
        hosts[MULLUM] = { state: 'waiting', match: '47', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
        await press(buttonNamed(/^Continue$/));
        expect(text()).toContain(`The re-key you started at ${MULLUM} with RK-AB12-CD34 is still open`);
        expect(text()).toContain('type that code');
        expect(text()).toContain('press Not theirs');
        expect(text()).toMatch(/lets it go by itself in about 24 hours/);
        expect(buttonNamed(/^Forget/)).toBeNull();
        expect(fake.alerts).toHaveLength(0);
        expect(fake.slot).toMatchObject({ community: `https://${MULLUM}`, publicKey: held().publicKey, shown: true });
    });

    it('its node bound it (the admin typed the number after Not now): finished, its key the phone\'s, never offered to forget', async () => {
        hosts[MULLUM] = { state: 'bound', callsign: 'MiaMember', communityName: 'Mullum', linkSignInAgain: false };
        await press(buttonNamed(/^Continue$/));
        expect(buttonNamed(/^Forget/)).toBeNull();
        expect(text()).not.toContain('still open');
        expect(text()).toContain('You’re in');
        expect(fake.imported).toEqual([held().publicKey]);
        expect(fake.slot).toBeNull();
        expect(sent.every((s) => s.includes(MULLUM))).toBe(true); // bellingen is never asked
    });
});
