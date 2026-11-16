// @vitest-environment jsdom
/**
 * Home's one line after the phone followed its community by itself (components/AddressLine.tsx; addresses S4, design §8),
 * rendered for real at the floor's window (320 x 569 dp, text at 1.3x), light and dark: react-dom in jsdom, React Native's
 * host components as plain tags carrying their accessibility props and styles. utils/address-verify.ts is stubbed here
 * (address-verify.test.ts runs it against stand-in servers): what is checked is that the line shows once, says the
 * design's words with the community's name, wraps rather than being cut, and that Home keeps the verification going.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, testID, numberOfLines, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'),
        StyleSheet: { create: (s: unknown) => s },
        AppState: { currentState: 'active', addEventListener: vi.fn((_: string, f: (s: string) => void) => { appState.on = f; return { remove: () => {} }; }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
vi.mock('expo-router', () => ({
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
const anchor = vi.hoisted(() => ({ value: 'https://coop.example.org' as string | null }));
const appState = vi.hoisted(() => ({ on: null as null | ((s: string) => void) }));
const switched = vi.hoisted(() => ({ listeners: [] as Array<() => void> }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => anchor.value), setItem: vi.fn(), removeItem: vi.fn() } }));
const verify = vi.hoisted(() => ({ line: null as null | { kind: string; from: string; to: string }, rounds: 0 }));
vi.mock('../address-verify', () => ({
    verifyAddressInUse: vi.fn(async () => { verify.rounds++; }),
    takeAddressLine: vi.fn(async () => { const l = verify.line; verify.line = null; return l; }),
}));
vi.mock('../community-switch', () => ({
    onCommunitySwitched: vi.fn((f: () => void) => { switched.listeners.push(f); return () => { switched.listeners = switched.listeners.filter((x) => x !== f); }; }),
}));
const saved = vi.hoisted(() => ({ rows: [] as { url: string; alias?: string }[] }));
vi.mock('../nodes', () => ({ getSavedNodes: vi.fn(async () => saved.rows) }));

import { AddressLine } from '../../components/AddressLine';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';

async function render(colors: AppColors = lightColors): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(AddressLine, { colors }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    await act(async () => {});
    return host;
}
const line = (host: HTMLElement) => host.querySelector('[data-testid="address-line"]') as HTMLElement | null;

beforeEach(() => {
    verify.line = null;
    verify.rounds = 0;
    anchor.value = 'https://coop.example.org';
    switched.listeners = [];
    saved.rows = [{ url: 'https://coop.example.org', alias: 'Riverside Beans and Barter Cooperative' }];
});

describe('Home\'s line after a follow, at 320 dp x 1.3', () => {
    it('shows the design\'s sentence with the community\'s name and the address, once', async () => {
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        const host = await render();
        expect(line(host)?.textContent).toBe('Riverside Beans and Barter Cooperative now lives at coop.example.org. This phone uses it from now on. Nothing else changed.');
        expect(verify.rounds).toBeGreaterThan(0);
        // Home again: the line was taken as it was read, so nothing shows.
        const again = await render();
        expect(line(again)).toBeNull();
    });

    it('the other two moves say what happened, never a card or a button', async () => {
        verify.line = { kind: 'left', from: 'https://riverside.example', to: 'https://coop.example.org' };
        expect(line(await render())?.textContent).toBe('riverside.example no longer answers as Riverside Beans and Barter Cooperative. This phone now uses coop.example.org.');
        verify.line = { kind: 'not-answering', from: 'https://riverside.example', to: 'https://coop.example.org' };
        const host = await render();
        expect(line(host)?.textContent).toBe("riverside.example isn't answering. This phone uses coop.example.org for now.");
        expect(host.querySelector('button')).toBeNull();
    });

    it('a community whose name the phone never kept is named by the address the member knew it by, never by the new one', async () => {
        // Measured on the emulator (two-address walk, 16 Nov): a row saved with no name made the line read
        // "two.walk.example now lives at two.walk.example".
        saved.rows = [{ url: 'https://coop.example.org' }];
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        expect(line(await render())?.textContent).toBe('riverside.example now lives at coop.example.org. This phone uses it from now on. Nothing else changed.');
        saved.rows = [];
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        expect(line(await render())?.textContent).toBe('riverside.example now lives at coop.example.org. This phone uses it from now on. Nothing else changed.');
    });

    it('sits inside Home\'s side gutter (16 dp, as the page title and the offline note), never against the screen\'s edge', async () => {
        // Measured on the emulator at 320 dp x 1.3: the line ran from x 0 to 480 px while every card sat 24 px (16 dp) in.
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        const style = JSON.parse(line(await render())!.getAttribute('data-style')!);
        expect(style.marginHorizontal).toBe(16);
    });

    it('wraps, light and dark: no fixed width or height, no line count, a colour from the tokens', async () => {
        for (const colors of [lightColors, darkColors] as AppColors[]) {
            verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
            const el = line(await render(colors))!;
            const style = JSON.parse(el.getAttribute('data-style')!);
            expect(el.getAttribute('data-lines')).toBeNull();
            expect(style.width).toBeUndefined();
            expect(style.height).toBeUndefined();
            expect(style.color).toBe(colors.text.body);
        }
    });

    it('nothing to say: nothing drawn', async () => {
        expect(line(await render())).toBeNull();
    });

    it('a switch to another community clears the line at once: Home shows only the community in use (PR #3236 review)', async () => {
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        const host = await render();
        expect(line(host)?.textContent).toContain('now lives at coop.example.org');
        // The member switches to another community from the sheet; Home stays mounted.
        anchor.value = 'https://elsewhere.example';
        await act(async () => { switched.listeners.forEach((f) => f()); });
        await act(async () => {});
        expect(line(host)).toBeNull();
    });

    it('back from the background on another community (switched elsewhere meanwhile): the old line goes too', async () => {
        verify.line = { kind: 'not-answering', from: 'https://riverside.example', to: 'https://coop.example.org' };
        const host = await render();
        expect(line(host)).not.toBeNull();
        anchor.value = 'https://elsewhere.example';
        await act(async () => { appState.on?.('background'); appState.on?.('active'); });
        await act(async () => {});
        expect(line(host)).toBeNull();
    });

    it('the phone\'s own follow still shows its line: the switch clears, the look after it shows the new one', async () => {
        const host = await render();
        expect(line(host)).toBeNull();
        anchor.value = 'https://coop.example.org';
        verify.line = { kind: 'followed', from: 'https://riverside.example', to: 'https://coop.example.org' };
        await act(async () => { switched.listeners.forEach((f) => f()); });
        await act(async () => {});
        expect(line(host)?.textContent).toContain('now lives at coop.example.org');
    });
});
