// @vitest-environment jsdom
/**
 * Scan from a browser, drawn (front doors S9; components/PairInView.tsx): every step's words and buttons, the four digits
 * shown large and read out one by one, whose account it is before Bring it to this phone, and nothing to tap on a
 * refusal but what the step allows. The screen's talk with the relay is app/pair-in.tsx (pair-in.test.ts reads it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import * as ReactAll from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
        if (accessibilityRole === 'header') attrs.role = 'heading';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ActivityIndicator: el('progress'),
        StyleSheet: { create: (s: unknown) => s },
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: vi.fn(), forceRTL: vi.fn() },
        NativeModules: {},
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: unknown) => unknown) => make({ colors: lightColors, theme: 'light' }) };
});

import { PairInView, PAIR_IN_WORDS, type PairInStep } from '../../components/PairInView';
import type { PairInQr } from '../pair-in';

const QR: PairInQr = { sessionId: 'a1'.repeat(16), browserPubHex: 'b2'.repeat(32), nodeUrl: 'https://mullum.example' };
let host: HTMLDivElement;
let root: Root;
const taps = { scan: 0, cont: 0, bring: 0, again: 0, cancel: 0 };

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    for (const k of Object.keys(taps) as Array<keyof typeof taps>) taps[k] = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(step: PairInStep, canRetry = true): void {
    act(() => {
        root.render(createElement(PairInView, {
            step, canRetry,
            onScan: () => { taps.scan++; }, onContinue: () => { taps.cont++; }, onBring: () => { taps.bring++; },
            onAgain: () => { taps.again++; }, onCancel: () => { taps.cancel++; },
        }) as any);
    });
}
const buttons = () => Array.from(host.querySelectorAll('[role="button"]')).map((b) => b.textContent);
const text = () => host.textContent ?? '';

describe('Scan from a browser, every step', () => {
    it('start: what to open in the browser, Scan the code, Cancel', () => {
        draw({ kind: 'start' });
        expect(host.querySelector('[role="heading"]')?.textContent).toBe(PAIR_IN_WORDS.title);
        expect(text()).toContain('Put your account on your phone');
        expect(buttons()).toEqual(['Scan the code', 'Cancel']);
        act(() => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
        expect(taps.scan).toBe(1);
    });

    it('a link from the camera app: names the community, and sends nothing before Continue', () => {
        draw({ kind: 'ask', qr: QR });
        expect(text()).toContain('Bring your account from the browser on mullum.example?');
        expect(buttons()).toEqual(['Continue', 'Cancel']);
        act(() => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
        expect(taps.cont).toBe(1);
    });

    it('the digits: shown large, read out one at a time, with why, and no button but Cancel', () => {
        draw({ kind: 'digits', qr: QR, code: '0427', sending: false });
        expect(text()).toContain('Type these four digits in your browser:');
        const digits = host.querySelector('[aria-label="0 4 2 7"]');
        expect(digits?.textContent).toBe('0427');
        expect(text()).toContain('Nothing is sent until you do.');
        expect(text()).toContain('Waiting for your browser…');
        expect(buttons()).toEqual(['Cancel']);
        draw({ kind: 'digits', qr: QR, code: '0427', sending: true });
        expect(text()).toContain('Your browser is sending your account…');
    });

    it("the confirm: whose account and from which community, before Bring it to this phone", () => {
        draw({ kind: 'confirm', qr: QR, account: { publicKey: 'c'.repeat(64), words: [], callsign: 'Ana' } });
        expect(text()).toContain("This is Ana's account on mullum.example. Bring it to this phone?");
        expect(buttons()).toEqual(['Bring it to this phone', 'Cancel']);
        act(() => { (host.querySelector('[role="button"]') as HTMLElement).click(); });
        expect(taps.bring).toBe(1);
        draw({ kind: 'confirm', qr: QR, account: { publicKey: 'c'.repeat(64), words: [], callsign: '' } });
        expect(text()).toContain('This is your account on mullum.example. Bring it to this phone?');
    });

    it('a refusal: said as an alert; Scan again only where it can help', () => {
        draw({ kind: 'refused', text: PAIR_IN_WORDS.taken });
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(PAIR_IN_WORDS.taken);
        expect(buttons()).toEqual(['Scan again', 'Cancel']);
        draw({ kind: 'refused', text: PAIR_IN_WORDS.hasAccount }, false);
        expect(buttons()).toEqual(['Cancel']);
    });

    it('while restoring: no button at all, so nothing is tapped twice', () => {
        draw({ kind: 'restoring' });
        expect(buttons()).toEqual([]);
        expect(host.querySelector('progress')).not.toBeNull();
    });
});
