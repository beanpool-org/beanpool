// @vitest-environment jsdom
/**
 * Honest waiting card on the phone's Home (FindCommunityBody.tsx, Lounge L1):
 * - Sent date: "You asked to join {name} on {date}."
 * - Whether it arrived: "Your request arrived."
 * - Measured line from directory push: e.g. "Usually answers within a week"
 * - "Cancel my request": confirmation, real withdrawal, never false success; once it worked the card STAYS for this visit,
 *   its button gone, with "You cancelled your request..." under the sent line (decided 29 Oct 2026).
 * - A request the community no longer holds (`none`): the three lines and "Got it", which forgets the knock and so
 *   lets the pin go; no Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { alertMock, readKnockStatusMock, cancelKnockMock, forgetKnockMock } = vi.hoisted(() => ({
    alertMock: vi.fn(),
    readKnockStatusMock: vi.fn(),
    cancelKnockMock: vi.fn(),
    forgetKnockMock: vi.fn(),
}));

vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (props.accessibilityState?.busy) attrs['aria-busy'] = 'true';
        if (props.accessibilityLiveRegion) attrs['aria-live'] = props.accessibilityLiveRegion;
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

vi.mock('../../utils/knock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/knock')>()),
    readKnockStatus: (...args: unknown[]) => readKnockStatusMock(...args),
    cancelKnock: (...args: unknown[]) => cancelKnockMock(...args),
    forgetKnock: (...args: unknown[]) => forgetKnockMock(...args),
    cardKnockLines: () => [],
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setLanguage } from '@beanpool/core';
import { lightColors } from '../../constants/colors';
import { FindCommunityBody } from '../../components/home/FindCommunityBody';
import type { DirectoryCommunity, GlobalHome } from '../community-directory';
import { KNOCK_MESSAGES, type RememberedKnock } from '../knock';
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

async function render(knocks: RememberedKnock[], onKnocksChange?: (knocks: RememberedKnock[]) => void): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const card = createElement(FindCommunityBody, {
        home,
        knocks,
        identity: ME,
        nodeUrl: null,
        point: { lat: -28.65, lng: 153.6 },
        colors: lightColors,
        onKnocksChange,
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
    forgetKnockMock.mockReset();
    forgetKnockMock.mockResolvedValue(undefined);
    vi.mocked(AsyncStorage.setItem).mockClear();
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

        // The card stays for this visit: the button is gone, and the card says what happened.
        expect(host.querySelector('[data-testid="home-find-waiting-https://byron.example.org"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="home-find-cancel-https://byron.example.org"]')).toBeNull();
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

/** KNOCK_MESSAGES.cancelled: under the sent line of a card whose cancel worked, for the rest of that Home visit. */
const CANCELLED_LINE = 'You cancelled your request. You can ask again after 24 hours.';
/** KNOCK_MESSAGES.none: what the Home card and the community's own card say of a request nothing holds (decided 29 Oct 2026). */
const NONE_LINE = 'This request is no longer open. You can ask again.';

describe('FindCommunityBody tells the truth about what the community now answers (Lounge L1, review of #2573)', () => {
    const byron = 'https://byron.example.org';
    const lismore = 'https://lismore.example.org';
    const other: RememberedKnock = { url: lismore, name: 'Lismore BeanPool', key: 'lismore', sentAt: '2026-10-26T00:00:00.000Z' };
    const arrived = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-waiting-arrived-${url}"]`)?.textContent;
    const cancelButton = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-cancel-${url}"]`) as HTMLButtonElement | null;
    const cancelledLine = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-waiting-cancelled-${url}"]`)?.textContent;
    const confirmCancel = async (host: HTMLElement, url: string, alertCall: number) => {
        await act(async () => { cancelButton(host, url)!.click(); });
        const destructive = alertMock.mock.calls[alertCall][2].find((b: any) => b.style === 'destructive');
        let pending!: Promise<void>;
        await act(async () => { pending = destructive.onPress(); });
        // Wrapped: an async function handing back a promise would wait for it, and a cancel left out is meant to stay out.
        return { pending };
    };

    it('a community with nothing open (lapsed, cancelled elsewhere) says it is no longer open, with no Cancel under it', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).not.toBeNull();
        expect(arrived(host)).toBe(NONE_LINE);
        expect(arrived(host)).not.toBe('Your request arrived.');
        expect(cancelButton(host)).toBeNull();
        expect(host.textContent).not.toContain('No answer came');
    });

    it('a read that could not be made says why in the member\'s language, with no Cancel', async () => {
        const FR = { [KNOCK_MESSAGES.unreachable]: 'Impossible de joindre cette communauté. Vérifiez votre connexion et réessayez.' };
        setLanguage('fr', [FR]);
        readKnockStatusMock.mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(arrived(host)).toBe(FR[KNOCK_MESSAGES.unreachable]);
        expect(cancelButton(host)).toBeNull();
    });

    it('a refusal shows the community\'s own words exactly as sent, with no Cancel', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: false, kind: 'refused', status: 500, code: null, message: 'Back in an hour.' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(arrived(host)).toBe('Back in an hour.');
        expect(cancelButton(host)).toBeNull();
    });

    it('a failed cancel is worded in the member\'s language when the phone wrote it, and as sent when the community did', async () => {
        const FR = { [KNOCK_MESSAGES.unreachable]: 'Impossible de joindre cette communauté. Vérifiez votre connexion et réessayez.' };
        setLanguage('fr', [FR]);
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: KNOCK_MESSAGES.unreachable });
        const host = await render([knock, other]);

        await confirmCancel(host, byron, 0);
        expect(host.querySelector(`[data-testid="home-find-cancel-error-${byron}"]`)?.textContent).toBe(FR[KNOCK_MESSAGES.unreachable]);

        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'Not today.', status: 429, code: 'rate_limited' });
        await confirmCancel(host, lismore, 1);
        expect(host.querySelector(`[data-testid="home-find-cancel-error-${lismore}"]`)?.textContent).toBe('Not today.');
    });

    it('a cancel the community answers "not_found" stops offering Cancel, and the card says what it now answers', async () => {
        // The first read is the card's own; the second is the one the 404 makes, and the community holds nothing.
        readKnockStatusMock
            .mockResolvedValueOnce({ ok: true, value: { status: 'pending' } })
            .mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });
        expect(arrived(host)).toBe('Your request arrived.');

        await confirmCancel(host, byron, 0);

        expect(readKnockStatusMock).toHaveBeenCalledTimes(2);
        expect(cancelButton(host)).toBeNull();
        expect(arrived(host)).toBe(NONE_LINE);
        expect(host.querySelector(`[data-testid="home-find-gotit-${byron}"]`)?.textContent).toBe('Got it');
        expect(host.querySelector(`[data-testid="home-find-cancel-error-${byron}"]`)?.textContent).toBe('There is no open request from you here.');
    });

    it('a cancel that meets a "yes" (404 not_found, then the community says approved) shows the invite, never "No answer came"', async () => {
        readKnockStatusMock
            .mockResolvedValueOnce({ ok: true, value: { status: 'pending' } })
            .mockResolvedValueOnce({ ok: true, value: { status: 'approved', invite: 'ABCD-EFGH', expiresAt: null } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });
        expect(arrived(host)).toBe('Your request arrived.');

        await confirmCancel(host, byron, 0);

        expect(host.querySelector(`[data-testid="home-find-invited-${byron}"]`)).not.toBeNull();
        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).toBeNull();
        expect(cancelButton(host)).toBeNull();
        expect(host.textContent).not.toContain('No answer came');
        expect(host.textContent).not.toContain('no open request');
    });

    it('a cancel that meets a 404 whose re-read cannot be made says why, with no Cancel and never "No answer came"', async () => {
        readKnockStatusMock
            .mockResolvedValueOnce({ ok: true, value: { status: 'pending' } })
            .mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        await confirmCancel(host, byron, 0);

        expect(arrived(host)).toBe(KNOCK_MESSAGES.unreachable);
        expect(cancelButton(host)).toBeNull();
        expect(host.textContent).not.toContain('No answer came');
    });

    it('a cancel that gets a 404 keeps its button busy until the re-read answers, and a second press does nothing', async () => {
        let finishRead: (r: unknown) => void = () => {};
        readKnockStatusMock
            .mockResolvedValueOnce({ ok: true, value: { status: 'pending' } })
            .mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'There is no open request from you here.', status: 404, code: 'not_found' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        const { pending } = await confirmCancel(host, byron, 0);
        expect(cancelButton(host)!.getAttribute('aria-busy')).toBe('true');
        await act(async () => { cancelButton(host)!.click(); });
        expect(alertMock).toHaveBeenCalledTimes(1);

        await act(async () => { finishRead({ ok: true, value: { status: 'none' } }); await pending; });
        expect(arrived(host)).toBe(NONE_LINE);
        expect(cancelButton(host)).toBeNull();
    });

    it('two requests cancelled one after the other: the first does not come back, and each button is its own', async () => {
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        let finishA: (r: { ok: boolean }) => void = () => {};
        let finishB: (r: { ok: boolean }) => void = () => {};
        cancelKnockMock
            .mockReturnValueOnce(new Promise(resolve => { finishA = resolve; }))
            .mockReturnValueOnce(new Promise(resolve => { finishB = resolve; }));
        const changes: string[][] = [];
        const host = await render([knock, other], list => changes.push(list.map(k => k.url)));
        await act(async () => { await Promise.resolve(); });

        const { pending: pendingA } = await confirmCancel(host, byron, 0);
        const { pending: pendingB } = await confirmCancel(host, lismore, 1);

        // B started while A is still out: A's button stays busy and a press on it does nothing; B's is busy too.
        expect(cancelButton(host, byron)!.getAttribute('aria-busy')).toBe('true');
        expect(cancelButton(host, lismore)!.getAttribute('aria-busy')).toBe('true');
        await act(async () => { cancelButton(host, byron)!.click(); });
        expect(alertMock).toHaveBeenCalledTimes(2);
        expect(cancelKnockMock).toHaveBeenCalledTimes(2);

        // A finishes first: its card stays and says so, its button is gone, B stays busy.
        await act(async () => { finishA({ ok: true }); await pendingA; });
        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).not.toBeNull();
        expect(cancelledLine(host, byron)).toBe(CANCELLED_LINE);
        expect(cancelButton(host, byron)).toBeNull();
        expect(cancelledLine(host, lismore)).toBeUndefined();
        expect(cancelButton(host, lismore)!.getAttribute('aria-busy')).toBe('true');

        // B finishes: both say so, neither has a button, and A's line did not go when B's came.
        await act(async () => { finishB({ ok: true }); await pendingB; });
        expect(cancelledLine(host, byron)).toBe(CANCELLED_LINE);
        expect(cancelledLine(host, lismore)).toBe(CANCELLED_LINE);
        expect(cancelButton(host, byron)).toBeNull();
        expect(cancelButton(host, lismore)).toBeNull();
        // Home is not told: the cards stay for this visit, and with them the pin.
        expect(changes).toEqual([]);
    });
});

describe('the card of a request the community no longer holds, and the card after a Cancel that worked (decided 29 Oct 2026, PR #2573)', () => {
    const byron = 'https://byron.example.org';
    const lismore = 'https://lismore.example.org';
    const other: RememberedKnock = { url: lismore, name: 'Lismore BeanPool', key: 'lismore', sentAt: '2026-10-26T00:00:00.000Z' };
    const card = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-waiting-${url}"]`) as HTMLElement | null;
    const gotIt = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-gotit-${url}"]`) as HTMLButtonElement | null;
    const confirmCancel = async (host: HTMLElement, url: string, alertCall: number) => {
        await act(async () => { (host.querySelector(`[data-testid="home-find-cancel-${url}"]`) as HTMLButtonElement).click(); });
        const destructive = alertMock.mock.calls[alertCall][2].find((b: any) => b.style === 'destructive');
        await act(async () => { await destructive.onPress(); });
    };

    it('the none card is three lines and Got it: when it was asked, that it is no longer open, that the member can ask again; no Cancel, no measured line', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(card(host)!.textContent).toBe('You asked to join Byron Shire BeanPool on 25 Oct 2026.' + NONE_LINE + 'Got it');
        expect(gotIt(host)!.tagName).toBe('BUTTON');
        expect(host.querySelector(`[data-testid="home-find-cancel-${byron}"]`)).toBeNull();
        expect(host.querySelector(`[data-testid="home-find-waiting-answers-${byron}"]`)).toBeNull();
        expect(host.textContent).not.toContain('No answer came');
    });

    it('Got it forgets the knock, and the card goes; Home is told the list without it, so the pin can go', async () => {
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'none' } });
        const changes: string[][] = [];
        const host = await render([knock, other], list => changes.push(list.map(k => k.url)));
        await act(async () => { await Promise.resolve(); });

        await act(async () => { gotIt(host, byron)!.click(); });

        expect(forgetKnockMock).toHaveBeenCalledTimes(1);
        expect(forgetKnockMock).toHaveBeenCalledWith(ME.publicKey, byron);
        expect(card(host, byron)).toBeNull();
        expect(card(host, lismore)).not.toBeNull();
        expect(changes).toEqual([[lismore]]);

        await act(async () => { gotIt(host, lismore)!.click(); });
        expect(forgetKnockMock).toHaveBeenLastCalledWith(ME.publicKey, lismore);
        expect(card(host, lismore)).toBeNull();
        expect(changes).toEqual([[lismore], []]);
        expect(cancelKnockMock).not.toHaveBeenCalled();
    });

    it('a request that waits, or whose answer could not be read, has no Got it', async () => {
        readKnockStatusMock
            .mockResolvedValueOnce({ ok: true, value: { status: 'pending' } })
            .mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable });
        const host = await render([knock, other]);
        await act(async () => { await Promise.resolve(); });

        expect(host.querySelectorAll('[data-testid^="home-find-gotit-"]')).toHaveLength(0);
    });

    it('the none card is worded in the member\'s language', async () => {
        setLanguage('fr', [{ [KNOCK_MESSAGES.none]: 'Cette demande n\'est plus ouverte. Vous pouvez la renouveler.', 'Got it': 'Compris' }]);
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(host.querySelector(`[data-testid="home-find-waiting-arrived-${byron}"]`)?.textContent).toBe('Cette demande n\'est plus ouverte. Vous pouvez la renouveler.');
        expect(gotIt(host)!.textContent).toBe('Compris');
    });

    it('a Cancel that worked keeps the card for this visit: no button, the cancelled line under the sent line, announced politely, nothing stored, Home not told', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: true });
        const changes: string[][] = [];
        const host = await render([knock], list => changes.push(list.map(k => k.url)));
        await act(async () => { await Promise.resolve(); });
        expect(host.querySelector(`[data-testid="home-find-waiting-arrived-${byron}"]`)?.textContent).toBe('Your request arrived.');

        await confirmCancel(host, byron, 0);

        const cardEl = card(host)!;
        expect(cardEl).not.toBeNull();
        expect(host.querySelector(`[data-testid="home-find-cancel-${byron}"]`)).toBeNull();
        const children = Array.from(cardEl.children);
        expect(children[0].getAttribute('data-testid')).toBe(`home-find-waiting-sent-${byron}`);
        expect(children[1].getAttribute('data-testid')).toBe(`home-find-waiting-cancelled-${byron}`);
        expect(children[1].textContent).toBe('You cancelled your request. You can ask again after 24 hours.');
        expect(children[1].getAttribute('aria-live')).toBe('polite');
        // No "arrived" line over it, no measured line, no Got it: it is a withdrawn request, not a closed one.
        expect(host.querySelector(`[data-testid="home-find-waiting-arrived-${byron}"]`)).toBeNull();
        expect(host.querySelector(`[data-testid="home-find-waiting-answers-${byron}"]`)).toBeNull();
        expect(gotIt(host)).toBeNull();
        // This visit only: nothing written by the card, Home's list unchanged (so the pin holds while the card shows).
        expect(forgetKnockMock).not.toHaveBeenCalled();
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
        expect(changes).toEqual([]);
    });

    it('a Cancel that failed still shows the error and the button, and no cancelled line', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'Network offline' });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        await confirmCancel(host, byron, 0);

        expect(host.querySelector(`[data-testid="home-find-waiting-cancelled-${byron}"]`)).toBeNull();
        expect(host.querySelector(`[data-testid="home-find-cancel-${byron}"]`)).not.toBeNull();
        expect(host.querySelector(`[data-testid="home-find-cancel-error-${byron}"]`)?.textContent).toBe('Network offline');
    });

    it('the cancelled line is worded in the member\'s language', async () => {
        setLanguage('fr', [{ [KNOCK_MESSAGES.cancelled]: 'Vous avez annulé votre demande. Vous pourrez la renouveler dans 24 heures.' }]);
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: true });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        await confirmCancel(host, byron, 0);

        expect(host.querySelector(`[data-testid="home-find-waiting-cancelled-${byron}"]`)?.textContent).toBe('Vous avez annulé votre demande. Vous pourrez la renouveler dans 24 heures.');
    });
});

describe('the card\'s per-request state belongs to the request, not to the community (review of #2573, comment 4407475831)', () => {
    const byron = 'https://byron.example.org';
    const askedAgain: RememberedKnock = { ...knock, sentAt: '2026-10-27T00:00:00.000Z' };
    const CANCELLED = 'You cancelled your request. You can ask again after 24 hours.';
    const NONE = 'This request is no longer open. You can ask again.';

    /** The card as Home keeps it mounted: `show` hands it a new list, as Home does when it reads the phone's memory again. */
    async function mount(first: RememberedKnock[]) {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const show = async (knocks: RememberedKnock[]) => {
            const card = createElement(FindCommunityBody, {
                home, knocks, identity: ME, nodeUrl: null, point: { lat: -28.65, lng: 153.6 }, colors: lightColors,
            });
            await act(async () => { root.render(card as unknown as Parameters<Root['render']>[0]); });
        };
        await show(first);
        await act(async () => { await Promise.resolve(); });
        return { host, show };
    }
    const sent = (host: HTMLElement) => host.querySelector(`[data-testid="home-find-waiting-sent-${byron}"]`)?.textContent;
    const arrived = (host: HTMLElement) => host.querySelector(`[data-testid="home-find-waiting-arrived-${byron}"]`)?.textContent;
    const cancelledLine = (host: HTMLElement) => host.querySelector(`[data-testid="home-find-waiting-cancelled-${byron}"]`)?.textContent;
    const cancelButton = (host: HTMLElement) => host.querySelector(`[data-testid="home-find-cancel-${byron}"]`) as HTMLButtonElement | null;
    const gotIt = (host: HTMLElement) => host.querySelector(`[data-testid="home-find-gotit-${byron}"]`) as HTMLButtonElement | null;
    const confirmCancel = async (host: HTMLElement, alertCall: number) => {
        await act(async () => { cancelButton(host)!.click(); });
        const destructive = alertMock.mock.calls[alertCall][2].find((b: any) => b.style === 'destructive');
        await act(async () => { await destructive.onPress(); });
    };

    it('a Cancel that worked is not carried onto a later request to the same community: the new request arrived, and can be cancelled', async () => {
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: true });
        const { host, show } = await mount([knock]);
        await confirmCancel(host, 0);
        expect(cancelledLine(host)).toBe(CANCELLED);
        expect(cancelButton(host)).toBeNull();

        // 24 hours on the member asked again; the app was still alive, and Home hands the card the new request.
        await show([askedAgain]);
        await act(async () => { await Promise.resolve(); });

        expect(sent(host)).toBe('You asked to join Byron Shire BeanPool on 27 Oct 2026.');
        expect(cancelledLine(host)).toBeUndefined();
        expect(arrived(host)).toBe('Your request arrived.');
        expect(cancelButton(host)).not.toBeNull();
        expect(host.textContent).not.toContain(CANCELLED);
        // The new request's own status was read, not the old request's answer reused.
        expect(readKnockStatusMock).toHaveBeenCalledTimes(2);
    });

    it('the same request handed over again (a new list, the same sentAt) keeps its cancelled line for the visit', async () => {
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: true });
        const { host, show } = await mount([knock]);
        await confirmCancel(host, 0);

        await show([{ ...knock }]);
        await act(async () => { await Promise.resolve(); });

        expect(cancelledLine(host)).toBe(CANCELLED);
        expect(cancelButton(host)).toBeNull();
        expect(readKnockStatusMock).toHaveBeenCalledTimes(1);
    });

    it('Got it on a closed request, then the same community asked again: the new request says Checking…, with no Got it, until its own read answers', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        const { host, show } = await mount([knock]);
        expect(arrived(host)).toBe(NONE);
        await act(async () => { gotIt(host)!.click(); });
        expect(forgetKnockMock).toHaveBeenCalledTimes(1);
        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).toBeNull();

        let finishRead: (r: unknown) => void = () => {};
        readKnockStatusMock.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
        await show([askedAgain]);

        // While the read is out nothing says the new request is closed, and nothing can forget it.
        expect(sent(host)).toBe('You asked to join Byron Shire BeanPool on 27 Oct 2026.');
        expect(arrived(host)).toBe('Checking…');
        expect(host.textContent).not.toContain(NONE);
        expect(gotIt(host)).toBeNull();
        expect(forgetKnockMock).toHaveBeenCalledTimes(1);

        await act(async () => { finishRead({ ok: true, value: { status: 'pending' } }); });
        expect(arrived(host)).toBe('Your request arrived.');
        expect(cancelButton(host)).not.toBeNull();
        expect(gotIt(host)).toBeNull();
    });

    it('a failed Cancel\'s error does not outlive its request: the next request to that community starts without it', async () => {
        readKnockStatusMock.mockResolvedValue({ ok: true, value: { status: 'pending' } });
        cancelKnockMock.mockResolvedValueOnce({ ok: false, message: 'Network offline' });
        const { host, show } = await mount([knock]);
        await confirmCancel(host, 0);
        expect(host.querySelector(`[data-testid="home-find-cancel-error-${byron}"]`)?.textContent).toBe('Network offline');

        await show([askedAgain]);
        await act(async () => { await Promise.resolve(); });

        expect(host.querySelector(`[data-testid="home-find-cancel-error-${byron}"]`)).toBeNull();
        expect(cancelButton(host)).not.toBeNull();
    });
});
