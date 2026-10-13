// @vitest-environment jsdom
/**
 * The area step's town search (deciding review of #1766, N3): the event form's AddressSearch, given the area step's own
 * words. There is no map on this step, so nothing it says may mention a map or a pin; the box asks for a town or suburb,
 * not a street address, for a 10 km area; and a match reads "Choose <place>" to a screen reader. The event form's words
 * are unchanged.
 *
 * The real AreaPicker and AddressSearch in jsdom, React Native's host components as plain tags; Nominatim is a stubbed
 * fetch (no request leaves the test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, placeholder, value, onChangeText, onSubmitEditing, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (tag === 'input') {
            attrs.placeholder = placeholder;
            attrs.value = value ?? '';
            attrs.onChange = (e: { target: { value: string } }) => onChangeText?.(e.target.value);
            attrs.onKeyDown = (e: { key: string }) => { if (e.key === 'Enter') onSubmitEditing?.(); };
        }
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'),
        ActivityIndicator: () => createElement('span', null, '…'),
        Keyboard: { dismiss: vi.fn() },
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const { onboardingColors } = await import('../onboarding-colors');
    const ctx = { colors: lightColors, theme: 'light' };
    return { useTheme: () => ctx, useStyles: (f: (t: unknown) => unknown) => f(ctx), useOnboardingColors: () => onboardingColors('light') };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-location', () => ({ Accuracy: { Low: 2 }, getForegroundPermissionsAsync: vi.fn(), requestForegroundPermissionsAsync: vi.fn(), getCurrentPositionAsync: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({})) }));

import { AREA_TOWN_SEARCH_WORDS } from '@beanpool/core';
import { AreaPicker } from '../../components/AreaPicker';
import { AddressSearch } from '../../components/AddressSearch';

const BYRON = { lat: '-28.6474', lon: '153.6120', display_name: 'Byron Bay, Byron Shire Council, New South Wales, Australia', name: 'Byron Bay', type: 'town' };
const MAP_OR_PIN = /\b(map|pin)\b/i;
let nominatim: 'byron' | 'none' | 'down' = 'byron';
let host: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    nominatim = 'byron';
    (globalThis as any).fetch = vi.fn(async () => {
        if (nominatim === 'down') throw new TypeError('Network request failed');
        return { ok: true, status: 200, json: async () => (nominatim === 'byron' ? [BYRON] : []) };
    });
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = null;
    root = null;
});

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function mount(element: unknown) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(element as Parameters<Root['render']>[0]); });
    await settle();
}
async function openAreaSearch() {
    await mount(createElement(AreaPicker, {
        url: 'https://global.example.test', identity: { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64) },
        features: { nearbyListings: { radiusKm: 250, max: 500 } }, onSaved: () => {}, onSkip: () => {},
    }));
    await act(async () => { (document.querySelector('[data-testid="area-type-town"]') as HTMLElement).click(); });
    await settle();
}
async function search(text: string) {
    const input = document.querySelector('input') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await settle();
}
const townBox = () => document.querySelector('[data-testid="area-town-search"]') as HTMLElement;

describe("the area step's town search (review N3)", () => {
    it('asks for a town or suburb, and says nothing about a map or a pin', async () => {
        await openAreaSearch();
        const input = document.querySelector('input') as HTMLInputElement;
        expect(input.placeholder).toBe('Town or suburb');
        expect(input.getAttribute('aria-label')).toBe('Find your town or suburb');
        expect(townBox().textContent).not.toMatch(MAP_OR_PIN);
    });

    it('a match reads "Choose <place>" to a screen reader', async () => {
        await openAreaSearch();
        await search('Byron');
        const match = Array.from(townBox().querySelectorAll('button')).find((b) => b.textContent?.startsWith('Byron Bay'));
        expect(match?.getAttribute('aria-label')).toBe('Choose Byron Bay, Byron Shire Council, New South Wales, Australia');
        expect(townBox().innerHTML).not.toMatch(MAP_OR_PIN);
    });

    it('no matches, or the search down: one line each, neither about a map or a pin', async () => {
        nominatim = 'none';
        await openAreaSearch();
        await search('Nowhere');
        expect(townBox().textContent).toContain(AREA_TOWN_SEARCH_WORDS.noMatches);
        expect(townBox().textContent).not.toMatch(MAP_OR_PIN);
        act(() => root!.unmount()); host!.remove(); root = null;
        nominatim = 'down';
        await openAreaSearch();
        await search('Byron');
        expect(townBox().textContent).toContain(AREA_TOWN_SEARCH_WORDS.unavailable);
        expect(townBox().textContent).not.toMatch(MAP_OR_PIN);
    });

    it("the event form's search keeps its own words", async () => {
        await mount(createElement(AddressSearch, { onPick: () => {}, accent: '#000' }));
        const input = document.querySelector('input') as HTMLInputElement;
        expect(input.placeholder).toBe('Street and town, or a place');
        expect(input.getAttribute('aria-label')).toBe('Find an address');
        await search('Byron');
        const match = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Byron Bay'));
        expect(match?.getAttribute('aria-label')).toBe('Put the pin at Byron Bay, Byron Shire Council, New South Wales, Australia');
    });
});
