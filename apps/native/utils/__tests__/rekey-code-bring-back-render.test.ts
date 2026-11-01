// @vitest-environment jsdom
/**
 * A bring-back finished on the re-key screen (app/rekey-code.tsx `onBroughtBack`, vault rethink VR3), on a phone that
 * holds another account. The release opens to the member's SAME key, and saving it goes through the restore gate
 * (utils/restore-account.ts): "Replace this phone's account?" first.
 * - Replace, saved: the app goes on as the member's account, its 12 words with it.
 * - Keep it: nothing changes, and the app stays the phone's account.
 * - Replace, then the save fails (`ReplaceNotSaved`): the account the member agreed to replace is already gone (its key,
 *   saved communities and app storage), so the app must not go on as it, as welcome.tsx's restores don't (review
 *   4423466016).
 *
 * jsdom and react-dom stand in for the phone, as in rekey-code-forget.test.ts. The release, the copy and their keys are
 * real (@beanpool/core), made as the community's server makes them, and so is the restore gate; the phone's key store,
 * its saved communities and the network are fakes. No node is contacted. Test keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { communityCopyForRelease, sealReleaseToDevice, sealSeedToCopyKey } from '@beanpool/core';
import type { RekeySlot } from '../rekey-redeem';
import type { BeanPoolIdentity } from '../identity';

type AlertButton = { text?: string; style?: string; onPress?: () => void | Promise<void> };

const fake = vi.hoisted(() => ({
    slot: null as RekeySlot | null,
    phone: null as BeanPoolIdentity | null,
    /** Every key the phone was asked to save, in order. */
    imported: [] as string[],
    /** The phone's key store refuses to save: the secure-store write a Replace can fail at. */
    importFails: false,
    /** Every identity the screen handed the app (IdentityContext setIdentity), in order. */
    appIdentity: [] as Array<BeanPoolIdentity | null>,
    alerts: [] as Array<{ title: string; message?: string; buttons?: AlertButton[] }>,
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
vi.mock('expo-router', () => ({ router: { back: () => {}, replace: () => {} }, useLocalSearchParams: () => ({}) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })] }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { setItem: async () => {}, getItem: async () => null, removeItem: async () => {} } }));
vi.mock('../../app/ThemeContext', () => {
    // Any colour or style the screen reads is there: what it is doesn't matter here.
    const any: unknown = new Proxy({}, { get: () => any });
    return { useTheme: () => ({ colors: any, theme: 'light' }), useStyles: () => any };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ setIdentity: (i: BeanPoolIdentity | null) => { fake.appIdentity.push(i); } }) }));
vi.mock('../community-switch', () => ({ communitySwitched: () => {} }));
vi.mock('../identity', () => ({
    StoredKeyUnreadableError: class StoredKeyUnreadableError extends Error {},
    loadIdentity: async () => fake.phone,
    draftIdentity: async () => { throw new Error('a phone with an account asks with its own key'); },
    importIdentity: async (i: BeanPoolIdentity) => {
        fake.imported.push(i.publicKey);
        if (fake.importFails) throw new Error('The phone’s key store didn’t save it.');
        fake.phone = i;
    },
    removeStoredIdentity: async () => { fake.phone = null; },
    wipeIdentityScopedStorage: async () => {},
    getMnemonic: async (i: BeanPoolIdentity) => i.mnemonic,
}));
vi.mock('../account-leaves-phone', () => ({
    releaseAccountFromPhone: async () => {},
    communitiesOnThisPhone: async () => [],
    forgetCommunities: async () => {},
}));
vi.mock('../onboarding-state', () => ({ clearPendingOnboarding: async () => {} }));
vi.mock('../nodes', () => ({ addSavedNode: async () => {} }));
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

// Test phrases only (a BIP-39 vector), never a real account's: the apps' derivation, seed = SHA256(SHA256(words)).
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const MEMBER_SEED = sha256(sha256(utf8ToBytes(WORDS.join(' '))));
const MEMBER_KEY = bytesToHex(ed25519.getPublicKey(MEMBER_SEED));

const keyOf = (seed: Uint8Array, callsign: string): BeanPoolIdentity => ({
    publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign, createdAt: '2026-10-30T00:00:00.000Z',
});
/** The account this phone holds: another member's, which a bring-back replaces only if the member says so. */
const PHONE_ACCOUNT = keyOf(new Uint8Array(32).fill(3), 'Robin');

const MULLUM = 'https://mullum.example.org';
const CODE = 'BB-AB12-CD34';

/** The ask this phone made with its own key, left waiting: the screen asks about it again when it opens. */
const asked = (): RekeySlot => ({ community: MULLUM, code: CODE, publicKey: PHONE_ACCOUNT.publicKey, madeHere: false, startedAt: Date.now() - 60_000, shown: true });

/** What the community answers the phone's poll with once the admin typed its number, made as engine/bring-back.ts makes it. */
function released() {
    const made = sealSeedToCopyKey(MEMBER_SEED, { words: WORDS });
    return {
        state: 'released', callsign: 'MiaMember', communityName: 'Mullum', memberKey: MEMBER_KEY,
        release: sealReleaseToDevice(communityCopyForRelease(made), PHONE_ACCOUNT.publicKey, { collectionId: CODE, holderType: 'community' }),
    };
}

const sent: string[] = [];
let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? '';
const buttonNamed = (re: RegExp) => Array.from(container.querySelectorAll('button')).find((b) => re.test(b.textContent ?? '')) ?? null;

/** Lets the screen's awaits run (the restore gate is loaded on demand) until `done`, or gives up. */
async function until(done: () => boolean) {
    for (let i = 0; i < 100 && !done(); i++) {
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(done()).toBe(true);
}

/** The screen opens, asks about the waiting ask, opens the release, and asks before it replaces the phone's account. */
async function replaceAsked() {
    await until(() => fake.alerts.length > 0);
    expect(fake.alerts).toHaveLength(1);
    const alert = fake.alerts[0];
    expect(alert.title).toBe('Replace this phone’s account?');
    expect(alert.message).toContain('(Robin)');
    expect(alert.buttons?.map((b) => [b.text, b.style])).toEqual([['Keep it', 'cancel'], ['Replace', 'destructive']]);
    return alert;
}

async function press(button: AlertButton | undefined) {
    expect(button?.onPress).toBeDefined();
    await act(async () => { await button?.onPress?.(); });
}

beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    fake.slot = asked();
    fake.phone = PHONE_ACCOUNT;
    fake.imported = [];
    fake.importFails = false;
    fake.appIdentity = [];
    fake.alerts = [];
    sent.length = 0;
    const answer = released();
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
        const u = new URL(url);
        sent.push(`${init?.method ?? 'GET'} ${u.host}${u.pathname}`);
        return new Response(JSON.stringify(answer), { status: 200 });
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

describe('a bring-back over another account on this phone (vault rethink VR3)', () => {
    it('Replace, saved: the app goes on as the member\'s own key, with their 12 words, and the ask is over', async () => {
        await press((await replaceAsked()).buttons?.[1]);
        await until(() => text().includes('Welcome back'));
        expect(fake.imported).toEqual([MEMBER_KEY]);
        expect(fake.appIdentity).toHaveLength(1);
        expect(fake.appIdentity[0]).toMatchObject({ publicKey: MEMBER_KEY, privateKey: bytesToHex(MEMBER_SEED), callsign: 'MiaMember', mnemonic: WORDS });
        expect(text()).toContain('Your 12 words came back with it.');
        expect(fake.slot).toBeNull();
        expect(sent).toEqual([`GET mullum.example.org/api/member/re-enroll/status`]);
    });

    it('Keep it: nothing is saved, and the app stays the phone\'s account', async () => {
        await press((await replaceAsked()).buttons?.[0]);
        await until(() => text().includes('The account on this phone was kept. Nothing changed.'));
        expect(fake.imported).toEqual([]);
        expect(fake.appIdentity).toEqual([]);
        expect(fake.phone?.publicKey).toBe(PHONE_ACCOUNT.publicKey);
        expect(text()).not.toContain('Welcome back');
    });

    it('Replace, then the save fails: the replaced account is gone, so the app no longer goes on as it (review 4423466016)', async () => {
        fake.importFails = true;
        await press((await replaceAsked()).buttons?.[1]);
        await until(() => text().includes('The phone’s key store didn’t save it.'));
        // The member's key was tried, and the account they agreed to replace went first, its key with it.
        expect(fake.imported).toEqual([MEMBER_KEY]);
        expect(fake.phone).toBeNull();
        // So the app holds no account either: never Robin's, with none of its app storage.
        expect(fake.appIdentity).toEqual([null]);
        expect(text()).not.toContain('Welcome back');
        expect(buttonNamed(/^Try again$/)).not.toBeNull();
    });
});
