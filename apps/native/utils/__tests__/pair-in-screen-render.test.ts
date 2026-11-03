// @vitest-environment jsdom
/**
 * Scan from a browser, the screen itself (front doors S9; app/pair-in.tsx), rendered in jsdom with the relay as a stubbed
 * fetch: what this phone sends, and when. The drawing is pair-in-render.test.ts; the code's grammar and the seal's
 * checks are pair-in.test.ts; the relay is apps/server test-pairing-to-phone.ts.
 *
 * What is checked (doors-s9-fix1, the Opus review of 278bff9f):
 *  - the phone tells the relay it SAVED the account only once restoreFromWords has finished, and 'not saved' when the
 *    seal doesn't read, the save fails, or the member cancels at the confirm; before the collect it says nothing;
 *  - two taps on Continue before the screen redraws send one offer;
 *  - the four digits go when the session ends by the relay's clock (the offer's endsInMs), even when the network has
 *    dropped and no answer comes.
 * The account's words and key are real (core and utils/crypto); restoreFromWords is stubbed: restore-account tests run it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = ReactAll;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole === 'button') attrs.role = 'button';
        if (accessibilityRole === 'alert') attrs.role = 'alert';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        DeviceEventEmitter: { emit: vi.fn() },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), ActivityIndicator: el('progress'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) }));
const nav = vi.hoisted(() => ({
    params: {} as Record<string, string>,
    router: { replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true) },
}));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useTheme: () => ({ theme: 'light' }), useStyles: (make: (t: unknown) => unknown) => make({ colors: lightColors, theme: 'light' }) };
});
const who = vi.hoisted(() => ({ identity: null as null | Record<string, string>, setIdentity: vi.fn() }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../../components/ScanCodeModal', () => ({ default: () => null }));
const restore = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../restore-account', () => ({
    restoreFromWords: (...a: unknown[]) => restore.fn(...a),
    RestoreStopped: class RestoreStopped extends Error {},
}));
vi.mock('../db', () => ({ fetchNodeCallsign: vi.fn(async () => null) }));

import { createPairingSession, recoveryWordsFromEntropy, sealPairingPayloadToPhone } from '@beanpool/core';
import PairInScreen from '../../app/pair-in';
import { PAIR_IN_WORDS } from '../../components/PairInView';
import { pairInRouteFromSystemPath } from '../pair-in';
import { mnemonicToKeypair } from '../crypto';

const NODE = 'https://mullum.example';
const SECRET = 'ab'.repeat(32);
const WORDS = recoveryWordsFromEntropy(new Uint8Array(16).fill(7));

let host: HTMLDivElement;
let root: Root;
let browser: ReturnType<typeof createPairingSession>;
let calls: Array<{ path: string; body: any }>;
/** What the relay answers the phone's collect; a never-settling promise is a dropped network. */
let collect: (phonePubHex: string) => Promise<unknown> | unknown;
let offerBody: Record<string, unknown>;
let phonePub = '';

function stubRelay() {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = String(input).replace(NODE, '');
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
        if (path === '/api/pair/offer') { phonePub = body.phonePubHex; return json(200, offerBody); }
        if (path === '/api/pair/collect') return json(200, await collect(phonePub));
        return json(200, { success: true });
    }));
}

async function sealedAccount(phonePubHex: string) {
    const { publicKeyHex } = await mnemonicToKeypair(WORDS);
    const sealed = sealPairingPayloadToPhone({ version: 1, publicKey: publicKeyHex, mnemonic: WORDS, callsign: 'Ana' }, browser.privateKeyHex, phonePubHex, browser.sessionId);
    return { status: 'sent', ...sealed };
}

const text = () => host.textContent ?? '';
const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement | undefined;
const of = (path: string) => calls.filter((c) => c.path === path);

async function until(check: () => boolean, ms = 6_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out; screen: ${text()}`);
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    }
}

beforeEach(async () => {
    browser = createPairingSession();
    const link = `beanpool://pair-in?session=${browser.sessionId}&pub=${browser.publicKeyHex}&node=${encodeURIComponent(NODE)}`;
    nav.params = { qr: pairInRouteFromSystemPath(link)!.slice('/pair-in?qr='.length) };
    who.identity = null;
    who.setIdentity.mockReset();
    nav.router.replace.mockReset();
    restore.fn.mockReset();
    offerBody = { success: true, confirmCode: '4821', phoneSecret: SECRET, expiresAt: Date.now() + 120_000, endsInMs: 120_000 };
    collect = () => ({ status: 'confirming' });
    stubRelay();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(PairInScreen) as unknown as Parameters<Root['render']>[0]); });
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
});

async function toConfirm(): Promise<void> {
    collect = (pub) => sealedAccount(pub);
    await act(async () => { button('Continue')!.click(); });
    await until(() => !!button('Bring it to this phone'));
}

describe('Scan from a browser: what the phone tells the relay', () => {
    it('two taps on Continue before the screen redraws send one offer', async () => {
        const go = button('Continue')!;
        await act(async () => { go.click(); go.click(); });
        await until(() => text().includes('4821'));
        expect(of('/api/pair/offer')).toHaveLength(1);
        expect(text()).not.toContain(PAIR_IN_WORDS.taken);
    });

    it("the digits go when the session ends by the relay's clock, even with no answer from a dropped network", async () => {
        offerBody = { ...offerBody, endsInMs: 1_200 };
        collect = () => new Promise(() => {});
        await act(async () => { button('Continue')!.click(); });
        await until(() => text().includes('4821'));
        await until(() => text().includes(PAIR_IN_WORDS.expired), 4_000);
        expect(text()).not.toContain('4821');
        expect(of('/api/pair/saved')).toHaveLength(0);
    });

    it("'saved' only once restoreFromWords has finished, never before the member's tap", async () => {
        await toConfirm();
        expect(of('/api/pair/saved')).toHaveLength(0);
        let finish: (v: unknown) => void = () => {};
        restore.fn.mockImplementation(() => new Promise((r) => { finish = r; }));
        await act(async () => { button('Bring it to this phone')!.click(); });
        expect(of('/api/pair/saved')).toHaveLength(0);
        await act(async () => { finish({ publicKey: 'x', privateKey: 'y', callsign: 'Ana' }); });
        await until(() => of('/api/pair/saved').length === 1);
        expect(of('/api/pair/saved')[0].body).toEqual({ sessionId: browser.sessionId, phoneSecret: SECRET, saved: true });
        expect(who.setIdentity).toHaveBeenCalledTimes(1);
        expect(nav.router.replace).toHaveBeenCalledWith('/');
        // Leaving the screen afterwards says nothing more (no 'not saved' after the save).
        await act(async () => { root.unmount(); root = createRoot(host); });
        expect(of('/api/pair/saved')).toHaveLength(1);
    });

    it("a save that fails: 'not saved', and the phone says nothing was saved", async () => {
        await toConfirm();
        restore.fn.mockRejectedValue(new Error('disk full'));
        await act(async () => { button('Bring it to this phone')!.click(); });
        await until(() => of('/api/pair/saved').length === 1);
        expect(of('/api/pair/saved')[0].body).toEqual({ sessionId: browser.sessionId, phoneSecret: SECRET, saved: false });
        await until(() => text().includes(PAIR_IN_WORDS.badAccount));
        expect(who.setIdentity).not.toHaveBeenCalled();
    });

    it("a seal that doesn't read: 'not saved'", async () => {
        collect = () => ({ status: 'sent', nonceHex: '00'.repeat(24), ciphertextHex: 'ab'.repeat(64) });
        await act(async () => { button('Continue')!.click(); });
        await until(() => of('/api/pair/saved').length === 1);
        expect(of('/api/pair/saved')[0].body.saved).toBe(false);
        expect(text()).toContain(PAIR_IN_WORDS.badAccount);
        expect(restore.fn).not.toHaveBeenCalled();
    });

    it("Cancel at the confirm: 'not saved', then the session is cancelled", async () => {
        await toConfirm();
        await act(async () => { button('Cancel')!.click(); });
        await until(() => of('/api/pair/saved').length === 1);
        expect(of('/api/pair/saved')[0].body.saved).toBe(false);
        expect(of('/api/pair/cancel')).toHaveLength(1);
        expect(restore.fn).not.toHaveBeenCalled();
    });
});
