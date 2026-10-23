// @vitest-environment jsdom
/**
 * Link a device from the phone's CAMERA app, on the pairing screen itself (app/pair-device.tsx). Damo, 23 Oct (test
 * community, Android): the camera app "just opens the BeanPool app but nothing happens, no pin code or anything".
 *
 * A link reaches this screen as its `qr` param (app/+native-intent.ts, utils/pair-link.ts). What the screen did with one
 * that came while an earlier code had left something behind, measured on the emulator and rendered here:
 * - the camera's short pause after Cancel (or a refusal's OK) is the camera's own, so the same code still in view isn't
 *   read twice; it dropped a link opened in it, unsaid. A new link is read whatever an earlier code left behind;
 * - a read still finishing (the saved servers being looked up) is overtaken by a newer link: the newest code is shown;
 * - with a sheet open the new link doesn't replace it (the member's thumb may be on Confirm, PR #2025 review N2), but it
 *   was dropped with nothing said (emulator: the first code's sheet stayed, the second was cleared from the route). The
 *   member is now told, in one sentence, to close this one first;
 * - ✕ and Done went back, and after a cold start from the camera app this screen is the only one: back did nothing. They
 *   go to the tabs then, as the claim screen's Back does.
 *
 * Rendered with react-dom and React Native's host components as plain tags (key-words-harness.ts). The screen's own
 * checks are real: the strict grammar and the saved-server rule (pair-device-target.ts), the hex route (pair-link.ts).
 * Nothing here is sent: Confirm is never pressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

const alerts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock('react-native', async () => (await import('./key-words-harness')).nativeMock(alerts));
/** The screen's route params, as a store: a link opened while the screen is up sets `qr` on it (a NAVIGATE to the same route). */
const route = vi.hoisted(() => {
    let params: Record<string, string | undefined> = {};
    const listeners = new Set<() => void>();
    return {
        get: () => params,
        set(next: Record<string, string | undefined>) { params = { ...params, ...next }; listeners.forEach((l) => l()); },
        reset() { params = {}; },
        subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    };
});
const nav = vi.hoisted(() => ({ back: 0, replaced: [] as unknown[], canGoBack: true }));
vi.mock('expo-router', async () => {
    const { useSyncExternalStore } = await import('react');
    const r = { replace: (to: unknown) => { nav.replaced.push(to); }, push() {}, back: () => { nav.back++; }, canGoBack: () => nav.canGoBack, navigate() {} };
    return {
        router: r, useRouter: () => r,
        useLocalSearchParams: () => useSyncExternalStore(route.subscribe, route.get),
        useNavigation: () => ({ setParams: (p: Record<string, string | undefined>) => route.set(p) }),
        ErrorBoundary: () => null,
    };
});
vi.mock('expo-haptics', () => ({ notificationAsync: async () => {}, NotificationFeedbackType: { Success: 's', Error: 'e' } }));
vi.mock('expo-camera', async () => {
    const { createElement: h } = await import('react');
    return {
        useCameraPermissions: () => [{ granted: true, canAskAgain: true }, async () => ({ granted: true })],
        CameraView: () => h('div', { 'data-camera': 'true' }),
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (make: (t: unknown) => unknown) => make(ctx) };
});
vi.mock('../../app/IdentityContext', () => ({
    useIdentity: () => ({ identity: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Sally' }, setIdentity() {}, isLoading: false }),
}));
/** AsyncStorage; `slowNext` holds the next read only (of the community the phone is on) until the test lets it go. */
const store = vi.hoisted(() => ({ map: new Map<string, string>(), slowNext: null as Promise<void> | null }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => { const v = store.map.get(k) ?? null; const hold = store.slowNext; store.slowNext = null; if (hold) await hold; return v; }),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [{ url: 'https://riverbend.example' }] }));
vi.mock('../db', () => ({ getMemberProfile: async () => null }));
vi.mock('../identity', () => ({ getMnemonic: async () => null }));
const unlock = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../node-admin', () => ({ requireDeviceUnlock: async () => { unlock.calls++; return 'failed'; } }));
const sent = vi.hoisted(() => ({ requests: [] as string[] }));

import PairDeviceScreen from '../../app/pair-device';
import { pairRouteFromSystemPath } from '../pair-link';

/** The web page's QR (apps/pwa WelcomePage) for a server, as the router hands it to the screen: the link as hex. */
function linkTo(node: string, session = 'a1'.repeat(16)): string {
    const link = `beanpool://pair?session=${session}&pub=${'b2'.repeat(32)}&node=${encodeURIComponent(node)}`;
    const to = pairRouteFromSystemPath(link);
    const qr = /^\/pair-device\?qr=([0-9a-f]+)$/.exec(to ?? '')?.[1];
    if (!qr) throw new Error(`no route for ${link}`);
    return qr;
}
const MULLUM = linkTo('https://mullum.example');
const RIVERBEND = linkTo('https://riverbend.example', 'c3'.repeat(16));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    alerts.said.length = 0;
    route.reset();
    nav.back = 0;
    nav.replaced.length = 0;
    nav.canGoBack = true;
    store.map.clear();
    store.map.set('beanpool_anchor_url', 'https://mullum.example');
    store.slowNext = null;
    unlock.calls = 0;
    sent.requests.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { sent.requests.push(String(url)); throw new Error('no network in this test'); }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function open(params: Record<string, string> = {}) {
    route.set(params);
    // react-dom's types carry their own copy of @types/react; the element is the same.
    await act(async () => { root.render(createElement(PairDeviceScreen as any) as Parameters<Root['render']>[0]); });
    await settle();
}
/** A link opened from the camera app while this screen is up. */
async function linkArrives(qr: string) {
    await act(async () => { route.set({ qr }); });
    await settle();
}
const sheet = () => host.querySelector('[data-modal]');
/** The server the open sheet would send to: its Target Host row. */
const sheetHost = () => {
    const rows = Array.from(sheet()?.querySelectorAll('span') ?? []);
    const label = rows.findIndex((s) => s.textContent === 'Target Host');
    return label >= 0 ? rows[label + 1]?.textContent ?? null : null;
};
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text) ?? null;
const press = async (el: Element | null, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const ms = (n: number) => act(async () => { await new Promise((r) => setTimeout(r, n)); });

describe('a link from the camera app reaches the sheet', () => {
    it('opened with a link: the sheet for that code, from a link, and the link is cleared from the route', async () => {
        await open({ qr: MULLUM });
        expect(sheetHost()).toBe('mullum.example');
        expect(sheet()?.textContent).toContain('This opened from a link.');
        expect(route.get().qr).toBeUndefined();
        expect(sent.requests).toEqual([]);
    });

    it('a new link right after Cancel (inside the camera\'s short pause) opens its sheet, not nothing', async () => {
        await open({ qr: MULLUM });
        await press(button('Cancel'), 'Cancel');
        expect(sheet()).toBeNull();
        // The camera waits 500 ms after a Cancel, so the code still in view isn't read again at once; a link is no camera.
        await linkArrives(RIVERBEND);
        expect(sheetHost()).toBe('riverbend.example');
        expect(alerts.said).toEqual([]);
    });

    it('the newest link wins over a read still finishing', async () => {
        await open();
        let release!: () => void;
        store.slowNext = new Promise<void>((r) => { release = r; });
        await linkArrives(MULLUM);
        expect(sheet()).toBeNull(); // still reading which servers this phone uses
        await linkArrives(RIVERBEND);
        expect(sheetHost()).toBe('riverbend.example');
        // The older read finishes after: it never puts its code's sheet over the newer one's.
        await act(async () => { release(); });
        await settle();
        expect(sheetHost()).toBe('riverbend.example');
    });
});

describe('a new link while a sheet is open', () => {
    it('does not replace the open sheet (review N2), and the member is told to close it first: never dropped unsaid', async () => {
        await open({ qr: MULLUM });
        expect(sheetHost()).toBe('mullum.example');
        await linkArrives(RIVERBEND);
        expect(sheetHost()).toBe('mullum.example');
        expect(alerts.said).toEqual([
            'A new code was opened while this one is still on the screen, so the new one was not read. Close this one first, then open the new code again.',
        ]);
        // Cleared, so the same link opened again after the member closes this one is read.
        expect(route.get().qr).toBeUndefined();
        await press(button('Cancel'), 'Cancel');
        await ms(600);
        await linkArrives(RIVERBEND);
        expect(sheetHost()).toBe('riverbend.example');
        expect(sent.requests).toEqual([]);
        expect(unlock.calls).toBe(0);
    });
});

describe('leaving the screen after a cold start from the camera app, where it is the only screen', () => {
    it('✕ goes to the tabs when there is nothing to go back to, and back when there is', async () => {
        nav.canGoBack = false;
        await open();
        await press(host.querySelector('[aria-label="Close camera scanner"]'), '✕');
        expect(nav.replaced).toEqual(['/(tabs)']);
        expect(nav.back).toBe(0);

        nav.canGoBack = true;
        nav.replaced.length = 0;
        await press(host.querySelector('[aria-label="Close camera scanner"]'), '✕');
        expect(nav.back).toBe(1);
        expect(nav.replaced).toEqual([]);
    });

    it('Done under the digits and the ✕ before camera access leave the same way (read from the source: the digits need a send)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../app/pair-device.tsx'), 'utf8');
        expect(src.match(/onPress=\{leave\}/g)).toHaveLength(3);
        expect(src).toMatch(/<Pressable style=\{styles\.cancelBtn\} onPress=\{leave\} accessibilityRole="button">\s*<Text style=\{styles\.cancelBtnText\}>\{t\('Done'\)\}<\/Text>/);
        expect(src).toMatch(/onPress=\{leave\}\s*accessibilityRole="button"\s*accessibilityLabel=\{t\('Go back'\)\}/);
        expect(src).not.toContain('onPress={() => router.back()}');
    });
});
