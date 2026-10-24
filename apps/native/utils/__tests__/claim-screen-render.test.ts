// @vitest-environment jsdom
/**
 * "Claim a community" (app/claim-community.tsx) rendered for real at the floor's window (320 x 569 dp, text at 1.3x):
 * react-dom in jsdom, React Native's host components as plain tags carrying their accessibility props, styles and the
 * text field's placeholder, as home-screen-render.test.ts does. The server's claim status and the membership probe are
 * stubbed; the claim link's parsing (utils/claim-link.ts) and the code field's digits (utils/node-claim.ts) are the real
 * ones.
 *
 * Found on 17 Oct, when Marty claimed a test server with his Android phone:
 *   1. the empty code box showed `a1b2-c3d4-e5f6-7890` in grey on the box, which read as a code already filled in, so
 *      the pale Claim button made no sense. The box now shows a pattern and, under it, where the code is;
 *   2. with no server yet (Set up a new community server), the screen had no scanner: only the camera app or
 *      Settings → Link a device read the server's claim QR. Its first step now has Scan the code.
 * And on a phone with no account the claim makes the account (DESIGN-account-without-global-fable.md §2.2, §4): the
 * last block. The claim's key rule (utils/claim-key.ts) is stubbed here, answer by answer: node-claim.test.ts runs it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, accessibilityState, disabled, value, onChangeText, placeholder, placeholderTextColor, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (placeholder !== undefined) attrs.placeholder = placeholder;
        if (placeholderTextColor) attrs['data-placeholder-color'] = placeholderTextColor;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: vi.fn() },
        // Android's back button: the test presses it through the listener the screen registers.
        BackHandler: { addEventListener: vi.fn((_: string, fn: () => boolean) => { back.press = fn; return { remove: vi.fn() }; }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
const nav = vi.hoisted(() => ({
    params: {} as Record<string, string>,
    router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true), canDismiss: vi.fn(() => false), dismissAll: vi.fn() },
}));
const back = vi.hoisted(() => ({ press: null as null | (() => boolean) }));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The camera: allowed unless a test refuses it, and the barcode handler kept so a test can hand it what the camera read.
const camera = vi.hoisted(() => ({ granted: true, onScanned: null as null | ((r: { data: string }) => void) }));
vi.mock('expo-camera', () => ({
    CameraView: (props: { onBarcodeScanned: (r: { data: string }) => void }) => { camera.onScanned = props.onBarcodeScanned; return createElement('div', { 'data-testid': 'camera' }); },
    useCameraPermissions: () => [{ granted: camera.granted }, vi.fn(async () => ({ granted: camera.granted }))],
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => '') }));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
const look = vi.hoisted(() => ({ theme: 'light' as 'light' | 'dark' }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors, darkColors } = await import('../../constants/colors');
    const ctx = () => ({ theme: look.theme, colors: look.theme === 'dark' ? darkColors : lightColors });
    return { useTheme: ctx, useStyles: (factory: (c: ReturnType<typeof ctx>) => unknown) => factory(ctx()) };
});
// One object, as the provider keeps it: the screen asks for membership again whenever it changes.
const who = vi.hoisted(() => ({ identity: { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'marty' } }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => who }));
vi.mock('../../components/useManageNode', () => ({ useManageNode: () => ({ start: vi.fn(), busy: false, dialog: null }) }));
vi.mock('../node-post', () => ({ anchorUrl: vi.fn(async () => null) }));
vi.mock('../community-switch', () => ({ communitySwitched: vi.fn() }));
vi.mock('../membership-probe', () => ({ fetchMembership: vi.fn(async () => new Response(JSON.stringify({ isMember: true }), { status: 200 })) }));
vi.mock('../node-admin', () => ({ requireDeviceUnlock: vi.fn(async () => 'ok'), hasDeviceLock: vi.fn(async () => true), NO_DEVICE_LOCK_MESSAGE: 'no lock' }));
// The server's answer to GET /api/local/claim: no owner yet, named Beans Town.
const CODE_ID = '0a1b2c3d';
const server = vi.hoisted(() => ({ asked: [] as string[], addresses: ['beans.example.org'] as string[] | null }));
vi.mock('../node-claim', async (importOriginal) => {
    const real = await importOriginal<typeof import('../node-claim')>();
    return {
        ...real,
        readClaimStatus: vi.fn(async (origin: string) => {
            server.asked.push(origin);
            return { kind: 'unclaimed', codeId: '0a1b2c3d', salt: '00'.repeat(32), communityName: 'Beans Town' };
        }),
        readNodeHasAddress: vi.fn(async () => true),
        // The node's own addresses, as its info names them (the success screen reads them).
        readNodeAddresses: vi.fn(async () => server.addresses),
    };
});
// The claim's key (utils/claim-key.ts), answer by answer: what the phone holds follows `who` (the phone's account, or
// none), and the node takes the claim unless a test says otherwise. The rule itself is node-claim.test.ts's.
const keys = vi.hoisted(() => ({ state: null as null | Record<string, unknown> }));
vi.mock('../claim-key', () => ({
    claimKeyState: vi.fn(async () => keys.state ?? (who.identity ? { kind: 'account', identity: who.identity } : { kind: 'none' })),
    claimKeyForThisPhone: vi.fn(async (_origin: string, held: unknown) => held
        ?? (who.identity ? { identity: who.identity, createdHere: false } : { identity: { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32), callsign: '' }, createdHere: true })),
    claimWithKey: vi.fn(async (req: { key: { identity: object; createdHere: boolean }; callsign: string }) => ({
        outcome: { kind: 'owner', callsign: null }, identity: { ...req.key.identity, callsign: req.callsign }, madeHere: req.key.createdHere, released: false,
    })),
    checkOwnClaim: vi.fn(async () => ({ outcome: { kind: 'owner', callsign: null }, released: false })),
    finishClaim: vi.fn(async (_o: string, identity: object) => identity),
    releaseClaimKey: vi.fn(async () => false),
}));

import { Alert } from 'react-native';
import ClaimCommunityScreen from '../../app/claim-community';
import { CLAIM_CODE_PLACEHOLDER } from '../claim-link';
import { claimCodeDigits, claimCodeFromDigits, readClaimStatus } from '../node-claim';
import { checkOwnClaim, claimKeyForThisPhone, claimWithKey, finishClaim, releaseClaimKey } from '../claim-key';
import { hasDeviceLock, requireDeviceUnlock } from '../node-admin';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';

const ORIGIN = 'https://beans.example.org';
// The doodle pattern's ground, which the hint sits on (read as text-ink-contrast.test.ts reads it).
const PATTERN = /const PATTERN_GROUND = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \}/
    .exec(readFileSync(join(__dirname, '..', '..', 'app', 'ThemeContext.tsx'), 'utf8'));
const CODE = 'claim-a1b2-c3d4-e5f6-7890';

/** WCAG 2 contrast of two #rrggbb colours, worked here (not a helper of the app's). */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

async function render(): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(ClaimCommunityScreen) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}

const q = (host: HTMLElement, sel: string) => host.querySelector(sel) as HTMLElement | null;
const style = (el: Element | null) => JSON.parse(el?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
const button = (host: HTMLElement, words: string) =>
    Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === words) as HTMLButtonElement | undefined;
const codeField = (host: HTMLElement) => q(host, 'input[aria-label="Claim code"]') as HTMLInputElement | null;

async function scan(host: HTMLElement, data: string) {
    await act(async () => { button(host, 'Scan the code')!.click(); });
    expect(q(host, '[data-testid="camera"]')).not.toBeNull();
    await act(async () => { camera.onScanned!({ data }); });
    await act(async () => {});
}

beforeEach(() => {
    document.body.innerHTML = '';
    nav.params = {};
    keys.state = null;
    back.press = null;
    look.theme = 'light';
    server.asked = [];
    server.addresses = ['beans.example.org'];
    camera.onScanned = null;
    camera.granted = true;
    vi.mocked(Alert.alert).mockClear();
});

describe('the empty claim code box reads as empty', () => {
    it('shows a pattern, not a code: nothing in it is a hex digit, so it can never read as filled in', async () => {
        nav.params = { node: ORIGIN };
        const host = await render();
        // Written in capitals by the language's rule (core upperCase), where a textTransform drew them before (words S3k).
        expect(q(host, '[data-role="header"]')?.textContent).toBe('CLAIM A COMMUNITY');
        expect(host.textContent).toContain('Claim Beans Town');

        const field = codeField(host)!;
        expect(field.value).toBe('');
        expect(field.getAttribute('placeholder')).toBe('xxxx-xxxx-xxxx-xxxx');
        expect(CLAIM_CODE_PLACEHOLDER).toBe('xxxx-xxxx-xxxx-xxxx');
        expect(claimCodeDigits(CLAIM_CODE_PLACEHOLDER)).toBe('');
        expect(claimCodeFromDigits(CLAIM_CODE_PLACEHOLDER)).toBeNull();
        // The same shape as the code it stands for: four groups of four after the `claim-` the box shows.
        expect(CLAIM_CODE_PLACEHOLDER.length).toBe(claimCodeDigits(CODE).length);
        // The button is pale while the box is empty: the hint under the box says why.
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('says under the box where the code is, in words that wrap at 320 dp and 1.3x', async () => {
        nav.params = { node: ORIGIN };
        const host = await render();
        const hint = q(host, '[data-testid="claim-code-hint"]');
        expect(hint?.textContent).toBe('The code is on your server: beanpool claim shows it.');
        expect(hint?.getAttribute('data-lines')).toBeNull();
        expect(style(hint)).not.toHaveProperty('width');
        // Right under the code box, before Paste and Scan the code.
        const box = codeField(host)!.parentElement!;
        expect(box.nextElementSibling).toBe(hint);
    });

    it.each([['light', lightColors], ['dark', darkColors]] as Array<['light' | 'dark', AppColors]>)('the placeholder and the hint pass 4.5:1 on the box and the page in %s', async (theme, colors) => {
        look.theme = theme;
        nav.params = { node: ORIGIN };
        const host = await render();
        const field = codeField(host)!;
        const box = style(field.parentElement);
        const placeholder = field.getAttribute('data-placeholder-color')!;
        expect(placeholder).toBe(colors.text.muted);
        expect(box.backgroundColor).toBe(colors.surface.app);
        expect(contrast(placeholder, box.backgroundColor as string)).toBeGreaterThanOrEqual(4.5);

        const hint = style(q(host, '[data-testid="claim-code-hint"]'));
        // Body ink, not the labels' grey: the pattern's strokes run through the hint (emulator, 18 Oct).
        expect(hint.color).toBe(colors.text.body);
        expect(PATTERN, 'PATTERN_GROUND in app/ThemeContext.tsx moved: point this test at it').not.toBeNull();
        for (const ground of [colors.surface.app, colors.surface.card, PATTERN![theme === 'light' ? 1 : 2]]) {
            expect(contrast(hint.color as string, ground)).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('a typed code fills the box and wakes the Claim button', async () => {
        nav.params = { node: ORIGIN };
        const host = await render();
        const field = codeField(host)!;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(field, 'a1b2c3d4e5f67890');
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(codeField(host)!.value).toBe('a1b2-c3d4-e5f6-7890');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBeNull();
    });
});

describe('with no server yet, Scan the code reads the server\'s claim QR', () => {
    it('offers Scan the code before the address, as well as the address box', async () => {
        const host = await render();
        expect(host.textContent).toContain('Scan the QR code your server shows, or type its address.');
        const scanButton = q(host, '[data-testid="claim-scan-server"]');
        expect(scanButton?.textContent).toBe('Scan the code');
        expect(scanButton?.getAttribute('data-role')).toBe('button');
        expect(q(host, 'input[aria-label="Server address"]')).not.toBeNull();
        expect(server.asked).toEqual([]);
    });

    it('the QR beanpool claim prints opens that server\'s claim with the code filled in', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=${CODE_ID}&code=${CODE}`);
        expect(q(host, '[data-testid="camera"]')).toBeNull();
        expect(server.asked).toEqual([ORIGIN]);
        expect(host.textContent).toContain('Claim Beans Town');
        expect(host.textContent).toContain(ORIGIN);
        expect(codeField(host)!.value).toBe('a1b2-c3d4-e5f6-7890');
        expect(host.textContent).not.toContain('made a new code');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBeNull();
    });

    it('a QR made for an older code names the server but leaves the box empty, and says so', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=ffffffff&code=${CODE}`);
        expect(host.textContent).toContain('Claim Beans Town');
        expect(host.textContent).toContain('The server made a new code since this link.');
        expect(codeField(host)!.value).toBe('');
    });

    it('after an older code\'s QR, scanning the server\'s current QR fills the box and the "new code" note goes', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=ffffffff&code=${CODE}`);
        expect(host.textContent).toContain('The server made a new code since this link.');
        expect(codeField(host)!.value).toBe('');
        // The form's own Scan the code, as the note says.
        await scan(host, `beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=${CODE_ID}&code=${CODE}`);
        expect(codeField(host)!.value).toBe('a1b2-c3d4-e5f6-7890');
        expect(host.textContent).not.toContain('made a new code');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBeNull();
    });

    it('scanning the older code\'s QR again from the form leaves the box empty and the note up', async () => {
        const old = `beanpool://claim?node=${encodeURIComponent(ORIGIN)}&id=ffffffff&code=${CODE}`;
        const host = await render();
        await scan(host, old);
        await scan(host, old);
        expect(codeField(host)!.value).toBe('');
        expect(host.textContent).toContain('The server made a new code since this link.');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('a QR with the code but no address keeps the code and asks for the address', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?id=${CODE_ID}&code=${CODE}`);
        expect(server.asked).toEqual([]);
        expect(q(host, '[data-testid="claim-scan-note"]')?.textContent).toBe("The code is filled in. Now type the server's address.");
        const address = q(host, 'input[aria-label="Server address"]') as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(address, 'beans.example.org');
            address.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { button(host, 'Check this server')!.click(); });
        await act(async () => {});
        expect(server.asked).toEqual([ORIGIN]);
        expect(codeField(host)!.value).toBe('a1b2-c3d4-e5f6-7890');
    });

    it('a QR naming an address BeanPool won\'t use opens nothing: it says so, and keeps the code', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?node=${encodeURIComponent('http://203.0.113.7:8080')}&id=${CODE_ID}&code=${CODE}`);
        expect(server.asked).toEqual([]);
        expect(host.textContent).toContain("The QR code named an address BeanPool won't use. Type the server's address instead.");
        expect(q(host, 'input[aria-label="Server address"]')).not.toBeNull();
        expect(q(host, '[data-testid="claim-scan-note"]')?.textContent).toBe("The code is filled in. Now type the server's address.");
    });

    it('a QR with an address and no code leaves the box empty, not holding the code an earlier scan put there', async () => {
        const host = await render();
        await scan(host, `beanpool://claim?id=${CODE_ID}&code=${CODE}`);
        expect(server.asked).toEqual([]);
        // The Settings page's QR: another server's address and the code's id, no code.
        await scan(host, `beanpool://claim?node=${encodeURIComponent('https://other.example.org')}&id=${CODE_ID}`);
        expect(server.asked).toEqual(['https://other.example.org']);
        expect(host.textContent).toContain('https://other.example.org');
        expect(codeField(host)!.value).toBe('');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('after Another address, a scanned address-only QR does not carry the first server\'s code over', async () => {
        vi.mocked(readClaimStatus).mockResolvedValueOnce({ kind: 'busy', retryAfter: null });
        nav.params = { node: ORIGIN, id: CODE_ID, code: CODE };
        const host = await render();
        expect(host.textContent).toContain('The server is busy.');
        await act(async () => { button(host, 'Another address')!.click(); });
        await scan(host, `beanpool://claim?node=${encodeURIComponent('https://other.example.org')}&id=${CODE_ID}`);
        expect(host.textContent).toContain('https://other.example.org');
        expect(codeField(host)!.value).toBe('');
        expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBe('true');
    });

    it.each([
        ['with no server yet, the address', {}, "Allow the camera for BeanPool in your phone settings, or type the server's address."],
        ['on the code step, the code', { node: ORIGIN }, 'Allow the camera for BeanPool in your phone settings, or type the code.'],
    ] as Array<[string, Record<string, string>, string]>)('with the camera refused, the message names what this step has a box for: %s', async (_, params, words) => {
        camera.granted = false;
        nav.params = params;
        const host = await render();
        await act(async () => { button(host, 'Scan the code')!.click(); });
        expect(q(host, '[data-testid="camera"]')).toBeNull();
        expect(vi.mocked(Alert.alert)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Alert.alert)).toHaveBeenCalledWith('Camera is off', words);
    });

    it('anything else keeps the camera looking', async () => {
        const host = await render();
        for (const data of ['https://beans.example.org', 'beanpool://claim', `beanpool://claim?id=${CODE_ID}`, 'beanpool://invite?code=x', 'hello']) {
            if (!q(host, '[data-testid="camera"]')) await act(async () => { button(host, 'Scan the code')!.click(); });
            await act(async () => { camera.onScanned!({ data }); });
            expect(q(host, '[data-testid="camera"]'), data).not.toBeNull();
        }
        expect(server.asked).toEqual([]);
    });
});

/**
 * HTTPS S3 (DESIGN-https-anywhere-fable.md §3, D3): a server claimed at its public number, with no name yet. The last
 * step says what that means for members, in the sentence Settings → Manage says too: never a gate, never a deadline.
 */
describe('claimed at the server\'s number, the owner is told a name follows the community', () => {
    const NUMBER = 'https://203.0.113.5';
    const NUDGE = "Members reach this community by its server's number, 203.0.113.5. If the server or its number changes, each member will have to type the new one. A name follows the community: Settings → Public Address.";

    async function claimAt(origin: string): Promise<HTMLElement> {
        nav.params = { node: origin, code: CODE };
        const host = await render();
        await act(async () => { button(host, 'Claim and become owner')!.click(); });
        await act(async () => {});
        expect(host.textContent).toContain('You own Beans Town');
        return host;
    }

    it('the link\'s https number opens the claim (nodeRefused: false), and the last step says the sentence', async () => {
        server.addresses = ['203.0.113.5'];
        const host = await claimAt(NUMBER);
        expect(server.asked).toEqual([NUMBER]);
        const nudge = q(host, '[data-testid="claim-number-nudge"]');
        expect(nudge?.textContent).toBe(NUDGE);
        // It wraps: nothing in it is fixed-width or cut to a line count.
        expect(style(nudge).width).toBeUndefined();
        expect(nudge?.getAttribute('data-lines')).toBeNull();
        // And the claim goes on as before: no gate.
        expect(button(host, 'Make Beans Town my community')).toBeDefined();
    });

    it('a node that says nothing of its addresses, at its number, gets the sentence too', async () => {
        server.addresses = null;
        const host = await claimAt(NUMBER);
        expect(q(host, '[data-testid="claim-number-nudge"]')?.textContent).toBe(NUDGE);
    });

    it('no sentence once the community has a name, or when claimed at a name', async () => {
        server.addresses = ['203.0.113.5', 'beans.example.org'];
        expect(q(await claimAt(NUMBER), '[data-testid="claim-number-nudge"]')).toBeNull();
        document.body.innerHTML = '';
        server.addresses = ['beans.example.org'];
        expect(q(await claimAt(ORIGIN), '[data-testid="claim-number-nudge"]')).toBeNull();
    });
});

/**
 * The `beanpool claim` QR on a phone with no account (Dax, 23 Oct): the claim makes the account (DESIGN §2.2), with nothing
 * of ours in the way. #2412's "Make my account" sent the member to make one elsewhere first, and with no invite that
 * meant the global community's.
 */
describe('the claim on a phone with no account makes the account', () => {
    const signedIn = who.identity;
    const storage = () => vi.mocked(AsyncStorage);
    beforeEach(() => {
        storage().setItem.mockClear();
        nav.router.replace.mockClear();
        nav.router.back.mockClear();
        nav.router.dismissAll.mockClear();
        for (const f of [claimKeyForThisPhone, claimWithKey, checkOwnClaim, finishClaim, releaseClaimKey, requireDeviceUnlock, hasDeviceLock]) vi.mocked(f).mockClear();
    });
    const withNoAccount = async (run: () => Promise<void>) => {
        (who as { identity: unknown }).identity = null;
        try { await run(); } finally { (who as { identity: unknown }).identity = signedIn; }
    };
    const nameField = (host: HTMLElement) => q(host, 'input[aria-label="Your callsign"]') as HTMLInputElement | null;
    const type = async (field: HTMLInputElement, text: string) => {
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const fromTheQr = async () => {
        nav.params = { node: ORIGIN, id: CODE_ID, code: CODE };
        return render();
    };

    it('draws the code box, Your name here and Claim and become owner, with what the tap will do: no Make my account', async () => {
        await withNoAccount(async () => {
            const host = await fromTheQr();
            expect(host.textContent).toContain('Claim Beans Town');
            expect(host.textContent).toContain(ORIGIN);
            expect(host.textContent).toContain('This community has no owner yet. Its one-time code is on its server.');
            expect(q(host, '[data-testid="claim-makes-account"]')?.textContent)
                .toBe('Claiming makes your BeanPool account on this phone, and makes it the owner of Beans Town.');
            expect(q(host, '[data-testid="claim-only-yours"]')?.textContent).toBe('Only claim a server you installed yourself.');
            expect(codeField(host)!.value).toBe(claimCodeDigits(CODE));
            expect(host.textContent).toContain('Your name here');
            expect(nameField(host)).not.toBeNull();
            expect(q(host, '[data-testid="claim-name-hint"]')?.textContent).toBe('How people in Beans Town will see you. You can change it later.');
            expect(q(host, '[data-testid="claim-make-account"]')).toBeNull();
            expect(host.textContent).not.toContain('Make my account');
            // The name first: two characters at least.
            expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBe('true');
            await type(nameField(host)!, 'Ada');
            expect(button(host, 'Claim and become owner')?.getAttribute('aria-disabled')).toBeNull();
        });
    });

    it('nothing is made by reading the screen: no key, no claim, nothing written', async () => {
        await withNoAccount(async () => {
            await fromTheQr();
            expect(claimKeyForThisPhone).not.toHaveBeenCalled();
            expect(claimWithKey).not.toHaveBeenCalled();
            expect(storage().setItem).not.toHaveBeenCalled();
        });
    });

    it('the tap: the phone\'s unlock first, then the key (made now), the claim under the name typed; Checking the code… then Claiming…', async () => {
        await withNoAccount(async () => {
            const host = await fromTheQr();
            await type(nameField(host)!, ' Ada ');
            let sending: () => void = () => {};
            let answer: (v: unknown) => void = () => {};
            vi.mocked(claimWithKey).mockImplementationOnce((req: any) => new Promise((resolve) => {
                sending = () => req.onSending();
                answer = resolve;
            }) as any);
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            expect(vi.mocked(requireDeviceUnlock).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(claimKeyForThisPhone).mock.invocationCallOrder[0]);
            expect(host.textContent).toContain('Checking the code…');
            expect(button(host, 'Claim and become owner')).toBeUndefined();
            const req = vi.mocked(claimWithKey).mock.calls[0][0];
            expect(req).toMatchObject({ origin: ORIGIN, code: CODE, codeId: CODE_ID, callsign: 'Ada', key: { createdHere: true } });
            await act(async () => { sending(); });
            expect(host.textContent).toContain('Claiming…');
            // No way off the screen while the claim is out: its answer decides.
            await act(async () => { (q(host, '[aria-label="Back"]') as HTMLElement).click(); });
            expect(back.press!()).toBe(true);
            expect(releaseClaimKey).not.toHaveBeenCalled();
            expect(nav.router.back).not.toHaveBeenCalled();
            await act(async () => { answer({ outcome: { kind: 'wrong-code' }, identity: req.key.identity, madeHere: true, released: false }); });
            await act(async () => {});
        });
    });

    it('no screen lock: nothing is made, and the owner\'s words say why; said before the name is typed, too', async () => {
        await withNoAccount(async () => {
            vi.mocked(hasDeviceLock).mockResolvedValueOnce(false);
            const host = await fromTheQr();
            const note = q(host, '[data-testid="claim-no-lock"]');
            expect(note?.textContent).toBe("Set a screen lock firstAn owner's phone needs a screen lock. Set one in your phone's settings, then try again.");
            // Before the name field, which comes after it on the screen.
            expect(note!.compareDocumentPosition(nameField(host)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            await type(nameField(host)!, 'Ada');
            vi.mocked(requireDeviceUnlock).mockResolvedValueOnce('no-device-lock');
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            expect(vi.mocked(Alert.alert)).toHaveBeenCalledWith('Set a screen lock first', "An owner's phone needs a screen lock. Set one in your phone's settings, then try again.");
            expect(claimKeyForThisPhone).not.toHaveBeenCalled();
            expect(claimWithKey).not.toHaveBeenCalled();
        });
    });

    it('in: the claim\'s finish under the name the node kept, then one welcome for the wizard, never this screen under it', async () => {
        await withNoAccount(async () => {
            nav.router.canDismiss.mockReturnValueOnce(true);
            vi.mocked(claimWithKey).mockImplementationOnce(async (req: any) => ({
                outcome: { kind: 'owner', callsign: 'Ada 2' }, identity: { ...req.key.identity, callsign: 'Ada' }, madeHere: true, released: false,
            }));
            const host = await fromTheQr();
            await type(nameField(host)!, 'Ada');
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            expect(finishClaim).toHaveBeenCalledWith(ORIGIN, expect.objectContaining({ callsign: 'Ada' }), 'Beans Town', 'Ada 2');
            expect(nav.router.dismissAll).toHaveBeenCalled();
            expect(nav.router.replace).toHaveBeenCalledWith('/welcome');
            expect(vi.mocked(finishClaim).mock.invocationCallOrder[0]).toBeLessThan(nav.router.replace.mock.invocationCallOrder[0]);
            // The owner's card comes at the wizard's end, after the 12 words: not here.
            expect(host.textContent).not.toContain('You own Beans Town');
        });
    });

    it('no answer: the account stays on the phone, the screen says so, and Check again asks the node', async () => {
        await withNoAccount(async () => {
            vi.mocked(claimWithKey).mockImplementationOnce(async (req: any) => ({ outcome: { kind: 'check-again' }, identity: req.key.identity, madeHere: true, released: false }));
            const host = await fromTheQr();
            await type(nameField(host)!, 'Ada');
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            const card = q(host, '[data-testid="claim-unconfirmed"]');
            expect(card?.textContent).toContain("We couldn't confirm the claim yet. It may have worked.");
            expect(card?.textContent).toContain('Your account is kept on this phone until the server answers.');
            // Now the key is on the phone, the claim's own (claim-key.ts claimKeyState).
            keys.state = { kind: 'claims', key: { identity: { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32), callsign: 'Ada' }, createdHere: true }, joinsOut: 1, callsign: 'Ada' };
            await act(async () => { (q(host, '[aria-label="Back"]') as HTMLElement).click(); });
            await act(async () => {});
            // Back keeps a key the node may hold: releaseClaimKey decides (it says no while a claim is out), and the screen goes.
            expect(releaseClaimKey).toHaveBeenCalledTimes(1);
            expect(nav.router.back).toHaveBeenCalled();
        });
    });

    it('Check again: in → the wizard', async () => {
        await withNoAccount(async () => {
            keys.state = { kind: 'claims', key: { identity: { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32), callsign: 'Ada' }, createdHere: true }, joinsOut: 1, callsign: 'Ada' };
            vi.mocked(claimWithKey).mockImplementationOnce(async (req: any) => ({ outcome: { kind: 'check-again' }, identity: req.key.identity, madeHere: true, released: false }));
            const host = await fromTheQr();
            // The name the claim kept, typed before a restart.
            expect(nameField(host)!.value).toBe('Ada');
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            await act(async () => { (q(host, '[data-testid="claim-check-again"]') as HTMLElement).click(); });
            await act(async () => {});
            expect(checkOwnClaim).toHaveBeenCalledWith(ORIGIN, expect.objectContaining({ createdHere: true }), expect.any(Function));
            expect(finishClaim).toHaveBeenCalled();
            expect(nav.router.replace).toHaveBeenCalledWith('/welcome');
        });
    });

    it('back after a restart while the answer was out, to a server that has an owner now: it asks whose by itself', async () => {
        await withNoAccount(async () => {
            keys.state = { kind: 'claims', key: { identity: { publicKey: 'ee'.repeat(32), privateKey: 'ff'.repeat(32), callsign: 'Ada' }, createdHere: true }, joinsOut: 1, callsign: 'Ada' };
            vi.mocked(readClaimStatus).mockResolvedValueOnce({ kind: 'claimed' });
            // Welcome hands the record back here with the code's id, never the code.
            nav.params = { node: ORIGIN, id: CODE_ID };
            await render();
            await act(async () => {});
            expect(checkOwnClaim).toHaveBeenCalledTimes(1);
            expect(finishClaim).toHaveBeenCalled();
            expect(nav.router.replace).toHaveBeenCalledWith('/welcome');
        });
    });

    it('another phone won the race: Someone already owns Beans Town, nothing was made here, and Back', async () => {
        await withNoAccount(async () => {
            vi.mocked(claimWithKey).mockImplementationOnce(async (req: any) => ({ outcome: { kind: 'already-claimed' }, identity: req.key.identity, madeHere: true, released: true }));
            const host = await fromTheQr();
            await type(nameField(host)!, 'Ada');
            vi.mocked(readClaimStatus).mockResolvedValueOnce({ kind: 'claimed' });
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            expect(q(host, '[data-testid="claim-someone-owns"]')?.textContent).toBe('Someone already owns Beans Town.');
            expect(host.textContent).toContain('Nothing was made on this phone.');
            await act(async () => { button(host, 'Back')!.click(); });
            await act(async () => {});
            expect(nav.router.back).toHaveBeenCalled();
        });
    });

    it('a wrong code: the words, the key kept for another try; Back, or Android\'s back, leaves through the key rule', async () => {
        await withNoAccount(async () => {
            vi.mocked(claimWithKey).mockImplementationOnce(async (req: any) => ({ outcome: { kind: 'wrong-code' }, identity: req.key.identity, madeHere: true, released: false }));
            const host = await fromTheQr();
            await type(nameField(host)!, 'Ada');
            await act(async () => { button(host, 'Claim and become owner')!.click(); });
            await act(async () => {});
            expect(host.textContent).toContain("That code isn't right.");
            expect(button(host, 'Claim and become owner')).toBeDefined();
            await act(async () => { back.press!(); });
            await act(async () => {});
            expect(releaseClaimKey).toHaveBeenCalledWith(ORIGIN, expect.objectContaining({ createdHere: true }));
            expect(nav.router.back).toHaveBeenCalled();
        });
    });

    it('with an account, as before: a member there types no name, its own key claims, and the owner\'s card is here', async () => {
        const host = await fromTheQr();
        expect(nameField(host)).toBeNull();
        expect(q(host, '[data-testid="claim-makes-account"]')).toBeNull();
        await act(async () => { button(host, 'Claim and become owner')!.click(); });
        await act(async () => {});
        expect(vi.mocked(claimWithKey).mock.calls[0][0]).toMatchObject({ key: { createdHere: false, identity: { publicKey: signedIn.publicKey } }, callsign: '' });
        expect(host.textContent).toContain('You own Beans Town');
        expect(finishClaim).not.toHaveBeenCalled();
        // Nothing is ever taken off the phone for an account.
        await act(async () => { (q(host, '[aria-label="Back"]') as HTMLElement).click(); });
        await act(async () => {});
        expect(vi.mocked(releaseClaimKey).mock.calls.every(([, key]) => !(key as { createdHere: boolean }).createdHere)).toBe(true);
    });
});
