// @vitest-environment jsdom
/**
 * Home's card offering another address when the phone's own stops answering (components/AddressFallbackCard.tsx; DNS
 * robustness S3, scratch/fable-design/DESIGN-dns-robustness-fable.md §3.2), rendered for real at the floor's window
 * (320 x 569 dp, text at 1.3x): react-dom in jsdom, React Native's host components as plain tags carrying their
 * accessibility props and styles, as address-follow-card-render.test.ts does. utils/address-fallback.ts is stubbed here
 * (address-fallback.test.ts runs it for real): what is checked is what the card says, its two targets and what each does,
 * that it asks again while Home stays in view, and that nothing in it is fixed-width or cut to a line count, so two long
 * addresses wrap rather than running off a 320 dp screen, in light and dark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, style } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (disabled) attrs['aria-disabled'] = 'true';
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        Alert: { alert: vi.fn() },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const nav = vi.hoisted(() => ({ router: { replace: vi.fn(), dismissAll: vi.fn(), canDismiss: vi.fn(() => true) } }));
vi.mock('expo-router', () => ({
    router: nav.router,
    // Home in view: the effect runs once, as on a focus, and its cleanup runs when the card goes.
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
const fallback = vi.hoisted(() => ({
    offer: null as null | { from: string; to: string; fromHost: string; host: string },
    result: 'moved' as string,
}));
vi.mock('../address-fallback', () => ({
    addressFallbackOffer: vi.fn(async () => fallback.offer),
    acceptAddressFallback: vi.fn(async () => fallback.result),
    snoozeAddressFallback: vi.fn(async () => undefined),
}));
const switches = vi.hoisted(() => ({ listeners: [] as Array<() => void> }));
vi.mock('../community-switch', () => ({
    onCommunitySwitched: vi.fn((l: () => void) => { switches.listeners.push(l); return () => { switches.listeners = switches.listeners.filter(x => x !== l); }; }),
}));

import { Alert } from 'react-native';
import { AddressFallbackCard, FALLBACK_RECHECK_MS } from '../../components/AddressFallbackCard';
import { acceptAddressFallback, addressFallbackOffer, snoozeAddressFallback } from '../address-fallback';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';

const OFFER = {
    from: 'https://byron-shire-beans-and-barter.beanpool.org', to: 'https://mullumbimby-beans-and-barter.beanpool.org',
    fromHost: 'byron-shire-beans-and-barter.beanpool.org', host: 'mullumbimby-beans-and-barter.beanpool.org',
};

const roots: Root[] = [];
async function render(colors: AppColors = lightColors): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(createElement(AddressFallbackCard, { colors }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}
const card = (host: HTMLElement) => host.querySelector('[data-testid="address-fallback-card"]') as HTMLElement | null;
const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;

beforeEach(() => {
    fallback.offer = OFFER;
    fallback.result = 'moved';
    switches.listeners = [];
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(acceptAddressFallback).mockClear();
    vi.mocked(snoozeAddressFallback).mockClear();
    vi.mocked(addressFallbackOffer).mockClear();
    nav.router.replace.mockClear();
    nav.router.dismissAll.mockClear();
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('the fallback card at 320 dp, text at 1.3x', () => {
    it('nothing at all while the phone\'s address answers or there is nowhere else', async () => {
        fallback.offer = null;
        const host = await render();
        expect(card(host)).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('asks in the design\'s words, both addresses whole, with two 48 dp targets that wrap and stack', async () => {
        const host = await render();
        expect(card(host)!.querySelector('[data-role="header"]')!.textContent).toBe(
            `${OFFER.fromHost} isn't answering. Your community also answers at ${OFFER.host}. Use that for now?`,
        );
        expect(card(host)!.textContent).toContain('BeanPool checked with its server that it is the same community.');
        expect(byId(host, 'address-fallback-use').textContent).toBe('Use that address for now');
        expect(byId(host, 'address-fallback-later').textContent).toBe('Not now');
        for (const id of ['address-fallback-use', 'address-fallback-later']) {
            expect(byId(host, id).getAttribute('data-role')).toBe('button');
            expect(JSON.parse(byId(host, id).getAttribute('data-style')!).minHeight).toBeGreaterThanOrEqual(48);
        }
        for (const node of [card(host)!, ...Array.from(card(host)!.querySelectorAll('*'))]) {
            const style = JSON.parse(node.getAttribute('data-style') ?? '{}');
            expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
            expect(style.height).toBeUndefined();
            expect(style.flexDirection).not.toBe('row');
            expect(node.getAttribute('data-lines')).toBeNull();
        }
    });

    it('"Not now" hides it for that pair (the snooze), moving nothing', async () => {
        const host = await render();
        await act(async () => { byId(host, 'address-fallback-later').click(); });
        expect(snoozeAddressFallback).toHaveBeenCalledWith(OFFER);
        expect(acceptAddressFallback).not.toHaveBeenCalled();
        expect(card(host)).toBeNull();
        expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('"Use that address for now" moves, then goes through Welcome for the community, as the BeanPool sheet\'s switch does', async () => {
        for (const result of ['moved', 'moved-kept-both']) {
            fallback.result = result;
            nav.router.replace.mockClear();
            const host = await render();
            await act(async () => { byId(host, 'address-fallback-use').click(); });
            expect(acceptAddressFallback).toHaveBeenCalledWith(OFFER);
            expect(nav.router.dismissAll).toHaveBeenCalled();
            expect(nav.router.replace).toHaveBeenCalledWith('/welcome');
        }
    });

    it('the other address is no longer the same community: nothing moves, the card goes, and it says why', async () => {
        fallback.result = 'not-same';
        const host = await render();
        await act(async () => { byId(host, 'address-fallback-use').click(); });
        expect(nav.router.replace).not.toHaveBeenCalled();
        expect(card(host)).toBeNull();
        expect(Alert.alert).toHaveBeenCalledWith('This phone stays where it is', `${OFFER.host} now answers as a different community, so this phone keeps the address it has.`);
    });

    it('a check that couldn\'t be made: nothing moves, the card stays, and it says to try again', async () => {
        fallback.result = 'unreachable';
        const host = await render();
        await act(async () => { byId(host, 'address-fallback-use').click(); });
        expect(nav.router.replace).not.toHaveBeenCalled();
        expect(card(host)).not.toBeNull();
        expect(byId(host, 'address-fallback-use').textContent).toBe('Use that address for now');
        expect(Alert.alert).toHaveBeenCalledWith(`Couldn't check ${OFFER.host}`, 'Nothing has changed. Try again in a little while.');
    });

    it('the phone switched meanwhile: the card goes quietly, nothing moved', async () => {
        fallback.result = 'gone';
        const host = await render();
        await act(async () => { byId(host, 'address-fallback-use').click(); });
        expect(card(host)).toBeNull();
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('a switch that fails: nothing more moves, the card stays, and it says so as the BeanPool sheet does', async () => {
        vi.mocked(acceptAddressFallback).mockImplementationOnce(async () => { throw new Error('The database could not be opened.'); });
        const host = await render();
        await act(async () => { byId(host, 'address-fallback-use').click(); });
        expect(nav.router.replace).not.toHaveBeenCalled();
        expect(card(host)).not.toBeNull();
        expect(Alert.alert).toHaveBeenCalledWith("Couldn't switch community", 'The database could not be opened.');
    });

    it('asked again once a minute while Home stays in view, after any switch, and no more once Home is left', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        fallback.offer = null;
        const host = await render();
        expect(addressFallbackOffer).toHaveBeenCalledTimes(1);
        expect(card(host)).toBeNull();
        // The phone's address has failed long enough meanwhile: the next minute's ask brings the card.
        fallback.offer = OFFER;
        await act(async () => { vi.advanceTimersByTime(FALLBACK_RECHECK_MS); });
        await act(async () => {});
        expect(addressFallbackOffer).toHaveBeenCalledTimes(2);
        expect(card(host)).not.toBeNull();
        expect(FALLBACK_RECHECK_MS).toBe(60 * 1000);
        await act(async () => { for (const l of switches.listeners) l(); });
        expect(addressFallbackOffer).toHaveBeenCalledTimes(3);
        for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
        await act(async () => { vi.advanceTimersByTime(5 * FALLBACK_RECHECK_MS); });
        expect(addressFallbackOffer).toHaveBeenCalledTimes(3);
    });

    it('draws from the theme\'s own colours, light and dark', async () => {
        for (const colors of [lightColors, darkColors as unknown as AppColors]) {
            const host = await render(colors);
            const c = card(host)!;
            expect(JSON.parse(c.getAttribute('data-style')!).backgroundColor).toBe(colors.surface.card);
            expect(JSON.parse(c.getAttribute('data-style')!).borderColor).toBe(colors.border.default);
            expect(JSON.parse(c.querySelector('[data-role="header"]')!.getAttribute('data-style')!).color).toBe(colors.text.heading);
            const use = byId(host, 'address-fallback-use');
            expect(JSON.parse(use.getAttribute('data-style')!).backgroundColor).toBe(colors.brand.fill);
            expect(JSON.parse(use.querySelector('span')!.getAttribute('data-style')!).color).toBe(colors.text.inverse);
            expect(JSON.parse(byId(host, 'address-fallback-later').querySelector('span')!.getAttribute('data-style')!).color).toBe(colors.text.secondary);
            host.remove();
        }
        // The two themes differ where the card draws (so the check above can fail): a dark card is not a light one.
        expect(darkColors.surface.card).not.toBe(lightColors.surface.card);
    });

    it('Home shows it right under the follow card, for members and visitors alike', () => {
        const home = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/index.tsx'), 'utf8');
        expect(home).toMatch(/import \{ AddressFallbackCard \} from '\.\.\/\.\.\/components\/AddressFallbackCard';/);
        expect(home).toMatch(/<AddressFollowCard colors=\{colors\} \/>\s*\{\/\*[^*]*\*\/\}\s*<AddressFallbackCard colors=\{colors\} \/>/);
    });
});
