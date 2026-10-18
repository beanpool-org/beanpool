// @vitest-environment jsdom
/**
 * Home's card offering to follow the community to where it lives now (components/AddressFollowCard.tsx; HTTPS S3,
 * DESIGN-https-anywhere-fable.md §3, D4), rendered for real at the floor's window (320 x 569 dp, text at 1.3x): react-dom
 * in jsdom, React Native's host components as plain tags carrying their accessibility props and styles, as
 * no-area-line-render.test.ts does. utils/address-follow.ts is stubbed here (address-follow.test.ts runs it for real):
 * what is checked is what the card says, its two targets and what each does, and that nothing in it is fixed-width or cut
 * to a line count, so the address wraps rather than running off a 320 dp screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
    // Home in view: the effect runs once, as on a focus.
    useFocusEffect: (effect: () => void | (() => void)) => { useEffect(() => effect(), [effect]); },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));
const follow = vi.hoisted(() => ({
    offer: null as null | { from: string; to: string; host: string },
    result: 'moved' as string,
}));
vi.mock('../address-follow', () => ({
    addressFollowOffer: vi.fn(async () => follow.offer),
    acceptAddressFollow: vi.fn(async () => follow.result),
    snoozeAddressFollow: vi.fn(async () => undefined),
}));
const switches = vi.hoisted(() => ({ listeners: [] as Array<() => void> }));
vi.mock('../community-switch', () => ({
    onCommunitySwitched: vi.fn((l: () => void) => { switches.listeners.push(l); return () => { switches.listeners = switches.listeners.filter(x => x !== l); }; }),
}));

import { Alert } from 'react-native';
import { AddressFollowCard } from '../../components/AddressFollowCard';
import { acceptAddressFollow, addressFollowOffer, snoozeAddressFollow } from '../address-follow';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';

const OFFER = { from: 'https://203.0.113.5', to: 'https://beans-and-barter-cooperative.example.org', host: 'beans-and-barter-cooperative.example.org' };

async function render(colors: AppColors = lightColors): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => { createRoot(host).render(createElement(AddressFollowCard, { colors }) as unknown as Parameters<Root['render']>[0]); });
    await act(async () => {});
    return host;
}
const card = (host: HTMLElement) => host.querySelector('[data-testid="address-follow-card"]') as HTMLElement | null;
const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;

beforeEach(() => {
    follow.offer = OFFER;
    follow.result = 'moved';
    switches.listeners = [];
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(acceptAddressFollow).mockClear();
    vi.mocked(snoozeAddressFollow).mockClear();
    vi.mocked(addressFollowOffer).mockClear();
    nav.router.replace.mockClear();
    nav.router.dismissAll.mockClear();
});

describe('the follow card at 320 dp, text at 1.3x', () => {
    it('nothing at all while there is nothing to follow', async () => {
        follow.offer = null;
        const host = await render();
        expect(card(host)).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('asks in the design\'s words, the whole address shown, with two 48 dp targets that wrap and stack', async () => {
        const host = await render();
        expect(card(host)!.textContent).toContain('This community is also at beans-and-barter-cooperative.example.org. Use that address from now on?');
        expect(card(host)!.textContent).toContain('BeanPool checked with its server that it is the same community.');
        expect(byId(host, 'address-follow-use').textContent).toBe('Use the new address');
        expect(byId(host, 'address-follow-later').textContent).toBe('Not now');
        for (const id of ['address-follow-use', 'address-follow-later']) {
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
        expect(card(host)!.querySelector('[data-role="header"]')!.textContent).toContain(OFFER.host);
    });

    it('"Not now" hides it and asks again in 7 days (the snooze), moving nothing', async () => {
        const host = await render();
        await act(async () => { byId(host, 'address-follow-later').click(); });
        expect(snoozeAddressFollow).toHaveBeenCalledWith(OFFER);
        expect(acceptAddressFollow).not.toHaveBeenCalled();
        expect(card(host)).toBeNull();
        expect(nav.router.replace).not.toHaveBeenCalled();
    });

    it('"Use the new address" moves, then goes through Welcome for the community, as the BeanPool sheet\'s switch does', async () => {
        const host = await render();
        await act(async () => { byId(host, 'address-follow-use').click(); });
        expect(acceptAddressFollow).toHaveBeenCalledWith(OFFER);
        expect(nav.router.dismissAll).toHaveBeenCalled();
        expect(nav.router.replace).toHaveBeenCalledWith('/welcome');
    });

    it('a new address that is no longer the same community: nothing moves, the card goes, and it says why', async () => {
        follow.result = 'not-same';
        const host = await render();
        await act(async () => { byId(host, 'address-follow-use').click(); });
        expect(nav.router.replace).not.toHaveBeenCalled();
        expect(card(host)).toBeNull();
        expect(Alert.alert).toHaveBeenCalledWith('This phone stays where it is', `${OFFER.host} now answers as a different community, so this phone keeps the address it has.`);
    });

    it('a check that couldn\'t be made: nothing moves, the card stays, and it says to try again', async () => {
        follow.result = 'unreachable';
        const host = await render();
        await act(async () => { byId(host, 'address-follow-use').click(); });
        expect(nav.router.replace).not.toHaveBeenCalled();
        expect(card(host)).not.toBeNull();
        expect(Alert.alert).toHaveBeenCalledWith(`Couldn't check ${OFFER.host}`, 'Nothing has changed. Try again in a little while.');
    });

    it('asked again after any switch of community', async () => {
        await render();
        expect(addressFollowOffer).toHaveBeenCalledTimes(1);
        follow.offer = null;
        await act(async () => { for (const l of switches.listeners) l(); });
        expect(addressFollowOffer).toHaveBeenCalledTimes(2);
    });

    it('draws from the theme\'s own colours, light and dark', async () => {
        for (const colors of [lightColors, darkColors as unknown as AppColors]) {
            const host = await render(colors);
            const style = JSON.parse(card(host)!.getAttribute('data-style')!);
            expect(style.backgroundColor).toBe(colors.surface.card);
            expect(JSON.parse(card(host)!.querySelector('[data-role="header"]')!.getAttribute('data-style')!).color).toBe(colors.text.heading);
            host.remove();
        }
    });
});
