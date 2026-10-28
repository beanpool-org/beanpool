/**
 * A post shared outside its community, in the browser (front doors S6): the one-post peek a stranger reads after the
 * node's share page's "See it in your browser" (pages/PeekPage.tsx), the members' and outside shares (components/
 * SharePost.tsx), Settings' Shared outside (components/SharedOutsideSection.tsx) and the address's `?peek=` (lib/peek.ts).
 * The node is the fetch: it answers a ticket's read with the post through guestPost (apps/server routes/peek.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommunityCard } from '@beanpool/core';

const CARD: CommunityCard = {
    name: 'Castlemaine BeanPool', host: 'castlemaine.beanpool.org', members: 9, area: null, joining: 'requests',
    askUrl: 'https://global.beanpool.org/?ask=castlemaine.beanpool.org', globalUrl: 'https://global.beanpool.org',
};
const T = 'AbCdEfGhIjKlMnOpQrSt_-';
const POST_ID = 'p-ladder';
/** The post as the node sends a ticket holder: nobody in it, its area only (guestPost). */
const GUEST_POST = {
    id: POST_ID, type: 'offer', category: 'tools', title: 'Ladder to lend', description: 'A tall ladder.', credits: 5, priceType: 'fixed',
    photos: ['/api/marketplace/posts/p-ladder/photos/0?v=1&k=key'], status: 'active', active: true, createdAt: '2026-10-29T00:00:00Z',
    authorPublicKey: 'hidden', authorCallsign: '', authorAvatarUrl: null, lat: -37.1, lng: 144.2, audienceScope: 'public',
};

const apiMocks = vi.hoisted(() => ({
    getCommunityCard: vi.fn(),
    request: vi.fn(),
    getNodeApiUrl: vi.fn(() => ''),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), ...apiMocks }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ features: { beans: true, shareOutside: true } })), joinInFlight: vi.fn(async () => false) }));

import { PeekPage } from './PeekPage';
import { readPeekParam, takePeekParam, peekAppDoors, getPeekPost } from '../lib/peek';

const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    apiMocks.getCommunityCard.mockResolvedValue(CARD);
    fetchMock = vi.fn(async (url: string) => {
        if (url.includes(`/api/marketplace/posts/${POST_ID}?peek=${T}`)) return new Response(JSON.stringify({ post: GUEST_POST }), { status: 200 });
        return new Response(JSON.stringify({ error: 'members only', code: 'members_only' }), { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('the one-post peek in the browser', () => {
    it('reads the post unsigned with the ticket, and shows it under "A member of … shared this with you"', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        render(<PeekPage postId={POST_ID} ticket={T} onWelcome={() => {}} />);
        await screen.findByTestId('peek-page');
        const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/marketplace/posts/'))!;
        expect(url).toBe(`/api/marketplace/posts/${POST_ID}?peek=${T}`);
        expect((init as RequestInit).credentials).toBe('omit');
        expect(((init as RequestInit).headers as Record<string, string> | undefined)?.['X-Signature']).toBeUndefined();
        await waitFor(() => expect(screen.getByTestId('peek-shared').textContent).toBe('A member of Castlemaine BeanPool shared this with you'));
        expect(screen.getByText('Ladder to lend')).toBeTruthy();
        expect(screen.getByTestId('peek-names-note').textContent).toBe('Names and faces appear when you join Castlemaine BeanPool.');
    });

    it('its doors: the community\'s card (Ask to join, Already a member, Look around), I have an invite; no phone doors on a computer', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        const onWelcome = vi.fn();
        render(<PeekPage postId={POST_ID} ticket={T} onWelcome={onWelcome} />);
        await screen.findByTestId('peek-page');
        await screen.findByTestId('community-card');
        expect(screen.getByTestId('community-card-ask').getAttribute('href')).toBe(CARD.askUrl);
        expect(screen.queryByTestId('peek-open-app')).toBeNull();
        expect(screen.queryByTestId('peek-get-app')).toBeNull();
        fireEvent.click(screen.getByTestId('peek-invite'));
        expect(onWelcome).toHaveBeenCalledWith('invite');
        fireEvent.click(screen.getByTestId('community-card-signin'));
        expect(onWelcome).toHaveBeenCalledWith('signin');
    });

    it('on an Android phone: Open in the BeanPool app (falling back to Google Play with the peek in the referrer) and Get the app', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
        render(<PeekPage postId={POST_ID} ticket={T} onWelcome={() => {}} />);
        await screen.findByTestId('peek-page');
        const app = screen.getByTestId('peek-open-app').getAttribute('href')!;
        expect(app.startsWith('intent://peek?')).toBe(true);
        expect(app).toContain(`post=${POST_ID}&peek=${T}`);
        expect(app).toContain('scheme=beanpool;package=org.beanpool.pillar;');
        const store = screen.getByTestId('peek-get-app').getAttribute('href')!;
        expect(new URL(store).searchParams.get('referrer')).toBe(`peek=${T}&post=${POST_ID}&server=${window.location.origin}`);
    });

    it('a link that opens nothing says so, with the same doors, and shows nothing of a post', async () => {
        render(<PeekPage postId="p-other" ticket={T} onWelcome={() => {}} />);
        await screen.findByTestId('peek-stopped');
        expect(screen.getByText('This link has stopped working. Ask the member who sent it for a new one.')).toBeTruthy();
        expect(screen.queryByText('Ladder to lend')).toBeNull();
        expect(screen.getByTestId('peek-invite')).toBeTruthy();
    });

    it('a post the node answers for another id is not shown', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ post: { ...GUEST_POST, id: 'p-elsewhere' } }), { status: 200 }));
        expect(await getPeekPost(POST_ID, T)).toBe('stopped');
    });

    it('only the node\'s refusal is "stopped"; no connection, a 429 or a 5xx is "unreachable", as on the phone', async () => {
        for (const status of [401, 403, 404]) {
            fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'members only', code: 'members_only' }), { status }));
            expect(await getPeekPost(POST_ID, T)).toBe('stopped');
        }
        for (const status of [429, 500, 502, 503]) {
            fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status }));
            expect(await getPeekPost(POST_ID, T)).toBe('unreachable');
        }
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        expect(await getPeekPost(POST_ID, T)).toBe('unreachable');
    });

    it('a community that couldn\'t be reached is never called a stopped link: it says so, with Try again and the doors', async () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        render(<PeekPage postId={POST_ID} ticket={T} onWelcome={() => {}} />);
        await screen.findByTestId('peek-unreachable');
        expect(screen.getByText("Can't reach that community right now. Check your connection and try again.")).toBeTruthy();
        expect(screen.queryByText('This link has stopped working. Ask the member who sent it for a new one.')).toBeNull();
        expect(screen.getByTestId('peek-invite')).toBeTruthy();
        fireEvent.click(screen.getByTestId('peek-retry'));
        await screen.findByTestId('peek-page');
        expect(screen.getByText('Ladder to lend')).toBeTruthy();
    });

    it('a 429 or a server error is the same: not a stopped link', async () => {
        for (const status of [429, 503]) {
            fetchMock.mockResolvedValueOnce(new Response('', { status }));
            const { unmount } = render(<PeekPage postId={POST_ID} ticket={T} onWelcome={() => {}} />);
            await screen.findByTestId('peek-unreachable');
            expect(screen.queryByTestId('peek-stopped')).toBeNull();
            unmount();
        }
    });
});

describe('the address', () => {
    it('reads ?post= and ?peek= and takes only the ticket out of the address bar', () => {
        const replaceState = vi.fn();
        const win = { location: { pathname: '/app', search: `?post=${POST_ID}&peek=${T}&door=x`, hash: '' }, history: { state: null, replaceState } } as any;
        expect(readPeekParam(win)).toEqual({ postId: POST_ID, ticket: T });
        expect(takePeekParam(win)).toEqual({ postId: POST_ID, ticket: T });
        expect(replaceState).toHaveBeenCalledWith(null, '', `/app?post=${POST_ID}&door=x`);
        expect(readPeekParam({ location: { pathname: '/app', search: `?post=${POST_ID}&peek=bad` } } as any)).toBeNull();
    });

    it('the phone doors per device', () => {
        expect(peekAppDoors(POST_ID, T, 'https://castlemaine.beanpool.org', DESKTOP)).toBeNull();
        expect(peekAppDoors(POST_ID, T, 'https://castlemaine.beanpool.org', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')?.app)
            .toBe(`beanpool://peek?node=${encodeURIComponent('https://castlemaine.beanpool.org')}&post=${POST_ID}&peek=${T}`);
    });
});

describe('sharing outside, and the member\'s list', () => {
    it('Share outside the community: the node makes the link, which is copied where there is no share sheet; a refusal is said', async () => {
        const { ShareOutsideButton } = await import('../components/SharePost');
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: DESKTOP, share: undefined });
        apiMocks.request.mockImplementation(async (method: string, path: string) => {
            if (method === 'GET' && path === '/api/community/info') return { features: { shareOutside: true } };
            if (method === 'POST' && path === '/api/peek') return { ticket: T, postId: POST_ID, expiresAt: '2026-11-05T00:00:00Z' };
            throw new Error('unexpected');
        });
        render(<ShareOutsideButton post={GUEST_POST as any} />);
        fireEvent.click(await screen.findByTestId('share-outside-button'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?post=${POST_ID}&peek=${T}`));
        expect(screen.getByTestId('share-outside-note').textContent).toBe('Link copied.');

        apiMocks.request.mockImplementation(async (method: string) => {
            if (method === 'GET') return { features: { shareOutside: true } };
            throw new Error('This community has turned sharing outside off.');
        });
        writeText.mockClear();
        fireEvent.click(screen.getByTestId('share-outside-button'));
        await waitFor(() => expect(screen.getByTestId('share-outside-note').textContent).toBe('This community has turned sharing outside off.'));
        expect(writeText).not.toHaveBeenCalled();
    });

    it('a hand-over that fails keeps the link the node made: shown to copy by hand, and Try again copies that one, never a second', async () => {
        const { ShareOutsideButton } = await import('../components/SharePost');
        const writeText = vi.fn(async (): Promise<void> => { throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); });
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: DESKTOP, share: undefined });
        apiMocks.request.mockImplementation(async (method: string, path: string) => {
            if (method === 'GET' && path === '/api/community/info') return { features: { shareOutside: true } };
            if (method === 'POST' && path === '/api/peek') return { ticket: T, postId: POST_ID, expiresAt: '2026-11-05T00:00:00Z' };
            throw new Error('unexpected');
        });
        const link = `${window.location.origin}/?post=${POST_ID}&peek=${T}`;
        render(<ShareOutsideButton post={GUEST_POST as any} />);
        fireEvent.click(await screen.findByTestId('share-outside-button'));
        await waitFor(() => expect(screen.getByTestId('share-outside-note').textContent).toBe('Could not copy the link.'));
        const field = screen.getByTestId('share-outside-link') as HTMLInputElement;
        expect(field.value).toBe(link);
        expect(field.readOnly).toBe(true);

        writeText.mockImplementation(async () => {});
        fireEvent.click(screen.getByTestId('share-outside-retry'));
        await waitFor(() => expect(screen.getByTestId('share-outside-note').textContent).toBe('Link copied.'));
        expect(writeText).toHaveBeenLastCalledWith(link);
        expect(apiMocks.request.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/peek')).toHaveLength(1);
        expect(screen.queryByTestId('share-outside-link')).toBeNull();
    });

    it('a share sheet refused once the tap has waited on the node (Safari): the next tap hands the kept link over inside itself', async () => {
        const { ShareOutsideButton } = await import('../components/SharePost');
        const share = vi.fn(async (): Promise<void> => { throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); });
        const writeText = vi.fn(async (): Promise<void> => { throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }); });
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: DESKTOP, share });
        apiMocks.request.mockImplementation(async (method: string, path: string) => {
            if (method === 'GET' && path === '/api/community/info') return { features: { shareOutside: true } };
            if (method === 'POST' && path === '/api/peek') return { ticket: T, postId: POST_ID, expiresAt: '2026-11-05T00:00:00Z' };
            throw new Error('unexpected');
        });
        render(<ShareOutsideButton post={GUEST_POST as any} />);
        fireEvent.click(await screen.findByTestId('share-outside-button'));
        await screen.findByTestId('share-outside-link');
        expect(share).toHaveBeenCalledTimes(1);

        share.mockImplementation(async () => {});
        fireEvent.click(screen.getByTestId('share-outside-button'));
        // Called during the click itself, before anything is awaited: the browser still counts it as the member's tap.
        expect(share).toHaveBeenCalledTimes(2);
        expect(share).toHaveBeenLastCalledWith({ title: GUEST_POST.title, text: GUEST_POST.title, url: `${window.location.origin}/?post=${POST_ID}&peek=${T}` });
        await waitFor(() => expect(screen.queryByTestId('share-outside-link')).toBeNull());
        expect(apiMocks.request.mock.calls.filter(([m, p]) => m === 'POST' && p === '/api/peek')).toHaveLength(1);
    });

    it('is not offered for a group\'s post, a paused one, or where the community says nothing of it', async () => {
        const { shareableOutside } = await import('../components/SharePost');
        expect(shareableOutside({ audienceScope: 'public', status: 'active', active: true })).toBe(true);
        expect(shareableOutside({ audienceScope: 'group', status: 'active', active: true })).toBe(false);
        expect(shareableOutside({ audienceScope: 'direct', status: 'active', active: true })).toBe(false);
        expect(shareableOutside({ audienceScope: 'public', status: 'paused', active: true })).toBe(false);
        expect(shareableOutside({ audienceScope: undefined, status: 'pending', active: true })).toBe(true);
    });

    it('is not offered for an event that has ended or was cancelled: it stays active until the scrub, and the node refuses it', async () => {
        const { shareableOutside } = await import('../components/SharePost');
        const now = Date.parse('2026-10-29T00:00:00Z');
        const event = { type: 'event' as const, audienceScope: 'public' as const, status: 'active' as const, active: true };
        expect(shareableOutside({ ...event, eventEndAt: '2026-11-01T00:00:00Z' }, now)).toBe(true);
        expect(shareableOutside({ ...event, eventEndAt: '2026-10-28T00:00:00Z' }, now)).toBe(false);
        expect(shareableOutside({ ...event, eventEndAt: '2026-11-01T00:00:00Z', eventState: 'cancelled' }, now)).toBe(false);
        expect(shareableOutside({ ...event }, now)).toBe(true);
        expect(shareableOutside({ type: 'offer', audienceScope: 'public', status: 'active', active: true, eventEndAt: '2026-10-28T00:00:00Z' }, now)).toBe(true);
    });

    it('Settings → Shared outside lists the open links and Stop sharing stops one', async () => {
        const { SharedOutsideSection } = await import('../components/SharedOutsideSection');
        const shares = [{ id: 'r1', postId: POST_ID, title: 'Ladder to lend', createdAt: '2026-10-29T00:00:00Z', expiresAt: '2026-11-05T00:00:00Z' }];
        apiMocks.request.mockImplementation(async (method: string, path: string) => {
            if (path === '/api/community/info') return { features: { shareOutside: true } };
            if (path === '/api/peek/mine') return { shares };
            if (path === '/api/peek/stop') return { stopped: true };
            throw new Error('unexpected');
        });
        render(<SharedOutsideSection />);
        fireEvent.click(await screen.findByTestId('settings-shared-outside-row'));
        expect((await screen.findByTestId('shared-outside-item')).textContent).toContain('Ladder to lend');
        await act(async () => { fireEvent.click(screen.getByTestId('shared-outside-stop')); });
        expect(apiMocks.request).toHaveBeenCalledWith('POST', '/api/peek/stop', { id: 'r1' });
        await waitFor(() => expect(screen.queryByTestId('shared-outside-item')).toBeNull());
        expect(screen.getByText('This link stops working now.')).toBeTruthy();
    });
});
