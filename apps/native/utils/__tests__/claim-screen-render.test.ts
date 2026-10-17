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
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
const nav = vi.hoisted(() => ({
    params: {} as Record<string, string>,
    router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true) },
}));
vi.mock('expo-router', () => ({ router: nav.router, useLocalSearchParams: () => nav.params, ErrorBoundary: () => null }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
// The camera: allowed, and the barcode handler kept so a test can hand it what the camera read.
const camera = vi.hoisted(() => ({ onScanned: null as null | ((r: { data: string }) => void) }));
vi.mock('expo-camera', () => ({
    CameraView: (props: { onBarcodeScanned: (r: { data: string }) => void }) => { camera.onScanned = props.onBarcodeScanned; return createElement('div', { 'data-testid': 'camera' }); },
    useCameraPermissions: () => [{ granted: true }, vi.fn(async () => ({ granted: true }))],
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
vi.mock('../node-admin', () => ({ requireDeviceUnlock: vi.fn(async () => 'ok'), NO_DEVICE_LOCK_MESSAGE: 'no lock' }));
// The server's answer to GET /api/local/claim: no owner yet, named Beans Town.
const CODE_ID = '0a1b2c3d';
const server = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('../node-claim', async (importOriginal) => {
    const real = await importOriginal<typeof import('../node-claim')>();
    return {
        ...real,
        readClaimStatus: vi.fn(async (origin: string) => {
            server.asked.push(origin);
            return { kind: 'unclaimed', codeId: '0a1b2c3d', salt: '00'.repeat(32), communityName: 'Beans Town' };
        }),
        readNodeHasAddress: vi.fn(async () => true),
    };
});

import ClaimCommunityScreen from '../../app/claim-community';
import { CLAIM_CODE_PLACEHOLDER } from '../claim-link';
import { claimCodeDigits, claimCodeFromDigits, readClaimStatus } from '../node-claim';
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
    look.theme = 'light';
    server.asked = [];
    camera.onScanned = null;
});

describe('the empty claim code box reads as empty', () => {
    it('shows a pattern, not a code: nothing in it is a hex digit, so it can never read as filled in', async () => {
        nav.params = { node: ORIGIN };
        const host = await render();
        expect(q(host, '[data-role="header"]')?.textContent).toBe('Claim a community');
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
