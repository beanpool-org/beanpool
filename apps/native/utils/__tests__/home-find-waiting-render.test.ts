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

vi.mock('../../utils/knock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/knock')>()),
    readKnockStatus: (...args: unknown[]) => readKnockStatusMock(...args),
    cancelKnock: (...args: unknown[]) => cancelKnockMock(...args),
    cardKnockLines: () => [],
}));

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

describe('FindCommunityBody tells the truth about what the community now answers (Lounge L1, review of #2573)', () => {
    const byron = 'https://byron.example.org';
    const lismore = 'https://lismore.example.org';
    const other: RememberedKnock = { url: lismore, name: 'Lismore BeanPool', key: 'lismore', sentAt: '2026-10-26T00:00:00.000Z' };
    const arrived = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-waiting-arrived-${url}"]`)?.textContent;
    const cancelButton = (host: HTMLElement, url = byron) => host.querySelector(`[data-testid="home-find-cancel-${url}"]`) as HTMLButtonElement | null;
    const confirmCancel = async (host: HTMLElement, url: string, alertCall: number) => {
        await act(async () => { cancelButton(host, url)!.click(); });
        const destructive = alertMock.mock.calls[alertCall][2].find((b: any) => b.style === 'destructive');
        let pending!: Promise<void>;
        await act(async () => { pending = destructive.onPress(); });
        // Wrapped: an async function handing back a promise would wait for it, and a cancel left out is meant to stay out.
        return { pending };
    };

    it('a community with nothing open (lapsed, cancelled elsewhere) says "No answer came", with no Cancel under it', async () => {
        readKnockStatusMock.mockResolvedValueOnce({ ok: true, value: { status: 'none' } });
        const host = await render([knock]);
        await act(async () => { await Promise.resolve(); });

        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).not.toBeNull();
        expect(arrived(host)).toBe('No answer came. You can ask again.');
        expect(arrived(host)).not.toBe('Your request arrived.');
        expect(cancelButton(host)).toBeNull();
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
        expect(arrived(host)).toBe('No answer came. You can ask again.');
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
        expect(arrived(host)).toBe('No answer came. You can ask again.');
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

        // A finishes first: it goes, B stays busy.
        await act(async () => { finishA({ ok: true }); await pendingA; });
        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).toBeNull();
        expect(cancelButton(host, lismore)!.getAttribute('aria-busy')).toBe('true');
        expect(changes).toEqual([[lismore]]);

        // B finishes with the list as A left it: nothing of A is back, and Home is told neither is open.
        await act(async () => { finishB({ ok: true }); await pendingB; });
        expect(host.querySelector(`[data-testid="home-find-waiting-${byron}"]`)).toBeNull();
        expect(host.querySelector(`[data-testid="home-find-waiting-${lismore}"]`)).toBeNull();
        expect(changes).toEqual([[lismore], []]);
    });
});
