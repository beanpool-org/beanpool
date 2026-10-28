// @vitest-environment jsdom
/**
 * Honest waiting card on the phone's Home (FindCommunityBody.tsx, Lounge L1):
 * - Sent date: "You asked to join {name} on {date}."
 * - Whether it arrived: "Your request arrived."
 * - Measured line from directory push: e.g. "Usually answers within a week"
 * - "Cancel my request": confirmation, real withdrawal, never false success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { alertMock, readKnockStatusMock, cancelKnockMock } = vi.hoisted(() => ({
    alertMock: vi.fn(),
    readKnockStatusMock: vi.fn(),
    cancelKnockMock: vi.fn(),
}));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (props.accessibilityState?.busy) attrs['aria-busy'] = 'true';
        if (props.accessibilityState?.disabled || disabled) attrs['aria-disabled'] = 'true';
        if (testID) attrs['data-testid'] = testID;
        return createElement(tag, attrs, typeof children === 'function' ? children({ pressed: false }) : children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFillObject: {} },
        Alert: { alert: alertMock },
    };
});
vi.mock('expo-router', () => ({ router: { push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), back: vi.fn() } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() } }));

vi.mock('../../utils/knock', () => ({
    readKnockStatus: (...args: unknown[]) => readKnockStatusMock(...args),
    cancelKnock: (...args: unknown[]) => cancelKnockMock(...args),
    cardKnockLines: () => [],
}));

import { setLanguage } from '@beanpool/core';
import { lightColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import type { DirectoryCommunity, GlobalHome } from '../community-directory';
import type { RememberedKnock } from '../knock';
import type { BeanPoolIdentity } from '../identity';

const ME: BeanPoolIdentity = {
    publicKey: 'a'.repeat(64),
    privateKey: '00'.repeat(32),
    callsign: 'Ana',
    createdAt: '2026-01-01T00:00:00.000Z',
} as BeanPoolIdentity;

const comm: DirectoryCommunity = {
    key: 'byron', name: 'Byron Shire BeanPool', url: 'https://byron.example.org',
    lat: -28.6, lng: 153.6, radiusKm: 20, memberCount: 40,
    contactEmail: null, contactPhone: null, distanceKm: 12,
    answers: 'week',
};

const home: GlobalHome = {
    point: 'request', communities: [comm], communityCount: 38,
    nearbyPosts: null, watches: [], directoryFetchedAt: '2026-10-28T08:00:00.000Z',
};

const knock: RememberedKnock = {
    url: 'https://byron.example.org',
    name: 'Byron Shire BeanPool',
    key: 'byron',
    sentAt: '2026-10-25T00:00:00.000Z',
};

async function render(knocks: RememberedKnock[]): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const card = createElement(FindCommunityBody, {
        home,
        knocks,
        identity: ME,
        nodeUrl: null,
        point: { lat: -28.65, lng: 153.6 },
        colors: lightColors,
    });
    await act(async () => {
        createRoot(host).render(card as unknown as Parameters<Root['render']>[0]);
    });
    return host;
}

beforeEach(() => {
    document.body.innerHTML = '';
    alertMock.mockReset();
    readKnockStatusMock.mockReset();
    cancelKnockMock.mockReset();
});
afterEach(() => setLanguage('en'));

describe('FindCommunityBody honest waiting card (Lounge L1)', () => {
    it('renders sent date, arrived status, and measured line for a waiting knock', async () => {
        readKnockStatusMock.mockResolvedValueOnce({
            ok: true,
            value: { status: 'pending' },
        });

        const host = await render([knock]);

        // Sent date line
        const sentEl = host.querySelector('[data-testid="home-find-waiting-sent-https://byron.example.org"]');
        expect(sentEl?.textContent).toBe('You asked to join Byron Shire BeanPool on 25 Oct 2026.');

        // Arrived line
        await act(async () => { await Promise.resolve(); });
        const arrivedEl = host.querySelector('[data-testid="home-find-waiting-arrived-https://byron.example.org"]');
        expect(arrivedEl?.textContent).toBe('Your request arrived.');

        // Measured line
        const answersEl = host.querySelector('[data-testid="home-find-waiting-answers-https://byron.example.org"]');
        expect(answersEl?.textContent).toBe('Usually answers within a week');

        // Cancel button
        const cancelBtn = host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]');
        expect(cancelBtn?.textContent).toBe('Cancel my request');
    });

    it('cancels knock upon confirmation with Alert', async () => {
        readKnockStatusMock.mockResolvedValueOnce({
            ok: true,
            value: { status: 'pending' },
        });
        cancelKnockMock.mockResolvedValueOnce({ ok: true });

        const host = await render([knock]);

        const cancelBtn = host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]');
        expect(cancelBtn).not.toBeNull();

        await act(async () => {
            (cancelBtn as HTMLButtonElement).click();
        });

        expect(alertMock).toHaveBeenCalledTimes(1);
        const [title, message, buttons] = alertMock.mock.calls[0];
        expect(title).toBe('Cancel my request');
        expect(message).toBe('Cancel your request to join Byron Shire BeanPool? You can ask again after 24 hours.');

        const destructiveBtn = buttons.find((b: any) => b.style === 'destructive');
        expect(destructiveBtn).toBeDefined();

        await act(async () => {
            await destructiveBtn.onPress();
        });

        expect(cancelKnockMock).toHaveBeenCalledWith('https://byron.example.org', ME);

        // Knock block removed
        expect(host.querySelector('[data-testid="home-find-waiting-https://byron.example.org"]')).toBeNull();
    });

    it('shows error note when cancellation fails (never false success)', async () => {
        readKnockStatusMock.mockResolvedValueOnce({
            ok: true,
            value: { status: 'pending' },
        });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'Network offline' });

        const host = await render([knock]);

        const cancelBtn = host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]');
        await act(async () => {
            (cancelBtn as HTMLButtonElement).click();
        });

        const destructiveBtn = alertMock.mock.calls[0][2].find((b: any) => b.style === 'destructive');
        await act(async () => {
            await destructiveBtn.onPress();
        });

        expect(host.querySelector('[data-testid="home-find-cancel-error-https://byron.example.org"]')?.textContent).toBe('Network offline');
        expect(host.querySelector('[data-testid="home-find-waiting-https://byron.example.org"]')).not.toBeNull();
    });

    it('a failed cancel says so under the knock it was for, not under another waiting beside it', async () => {
        const other: RememberedKnock = { url: 'https://lismore.example.org', name: 'Lismore BeanPool', key: 'lismore', sentAt: '2026-10-26T00:00:00.000Z' };
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'Network offline' });

        const host = await render([knock, other]);

        await act(async () => {
            (host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]') as HTMLButtonElement).click();
        });
        const destructiveBtn = alertMock.mock.calls[0][2].find((b: any) => b.style === 'destructive');
        await act(async () => {
            await destructiveBtn.onPress();
        });

        const failed = host.querySelector('[data-testid="home-find-waiting-https://byron.example.org"]')!;
        expect(failed.querySelector('[data-testid="home-find-cancel-error-https://byron.example.org"]')?.textContent).toBe('Network offline');
        const untouched = host.querySelector('[data-testid="home-find-waiting-https://lismore.example.org"]')!;
        expect(untouched).not.toBeNull();
        expect(untouched.querySelector('[data-testid^="home-find-cancel-error"]')).toBeNull();
        expect(host.querySelectorAll('[data-testid^="home-find-cancel-error"]')).toHaveLength(1);
    });

    it('while the cancel is out the button says so to a screen reader too, is busy and disabled, and a second press does nothing', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
        let finish: (r: { ok: boolean; message?: string }) => void = () => {};
        cancelKnockMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));

        const host = await render([knock]);
        const button = () => host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]') as HTMLButtonElement;
        expect(button().getAttribute('aria-label')).toBe('Cancel my request');
        expect(button().getAttribute('aria-busy')).toBeNull();

        await act(async () => { button().click(); });
        const destructiveBtn = alertMock.mock.calls[0][2].find((b: any) => b.style === 'destructive');
        let pending!: Promise<void>;
        await act(async () => { pending = destructiveBtn.onPress(); });

        expect(button().textContent).toBe('Cancelling…');
        expect(button().getAttribute('aria-label')).toBe('Cancelling…');
        expect(button().getAttribute('aria-busy')).toBe('true');
        expect(button().getAttribute('aria-disabled')).toBe('true');
        await act(async () => { button().click(); });
        expect(alertMock).toHaveBeenCalledTimes(1);
        expect(cancelKnockMock).toHaveBeenCalledTimes(1);

        // It failed: the button is itself again, and says why.
        await act(async () => { finish({ ok: false, message: 'Network offline' }); await pending; });
        expect(button().textContent).toBe('Cancel my request');
        expect(button().getAttribute('aria-label')).toBe('Cancel my request');
        expect(button().getAttribute('aria-busy')).toBeNull();
    });
});
