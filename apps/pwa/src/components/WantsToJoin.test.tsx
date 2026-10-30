/**
 * Front doors S2 (design §5.8): People → Invites → "Wants to join" on the web, as the phone's knocks screen
 * (apps/native/components/WantsToJoin.tsx): the list, Invite, Not now, and each refusal in the community's own words. The
 * node is a stubbed fetch behind the real lib/api.ts calls (GET /api/join/knocks, POST …/:id/approve and …/:id/decline).
 * Fails before S2: the web app had no such section (web-app.md: "the web app doesn't list them").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../lib/identity', async (orig) => ({ ...(await orig<typeof import('../lib/identity')>()), loadIdentity: vi.fn(async () => null) }));

import { WantsToJoin, WANTS_TO_JOIN_WORDS } from './WantsToJoin';

const TODAY = new Date().toISOString();
const RIVER = { id: 'k1', pubkey: 'b'.repeat(64), callsign: 'River', message: 'I grow tomatoes by the river.', avatar: null, fromNode: 'global.beanpool.org', createdAt: TODAY };
const SKY = { id: 'k2', pubkey: 'c'.repeat(64), callsign: 'Sky', message: 'New in town, I fix bikes.', avatar: null, fromNode: null, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(route: Route) {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET' });
        return route(url, init);
    }));
    return calls;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Wants to join on the web', () => {
    it('lists who asks, with what they wrote, when and from where, and tells People the count', async () => {
        const calls = stub(() => json(200, { knocks: [RIVER, SKY], total: 2 }));
        const onCount = vi.fn();
        render(<WantsToJoin onCount={onCount} />);
        expect(await screen.findByRole('heading', { name: '🚪 Wants to join (2)' })).toBeTruthy();
        expect(screen.getByText(WANTS_TO_JOIN_WORDS.help)).toBeTruthy();
        const river = screen.getByTestId('wants-to-join-k1');
        expect(within(river).getByText('River')).toBeTruthy();
        expect(within(river).getByText('I grow tomatoes by the river.')).toBeTruthy();
        expect(within(river).getByText('Asked today · from global.beanpool.org')).toBeTruthy();
        expect(within(screen.getByTestId('wants-to-join-k2')).getByText('Asked 3 days ago')).toBeTruthy();
        expect(within(river).getByRole('button', { name: 'Invite River' }).textContent).toBe('Invite');
        expect(within(river).getByRole('button', { name: 'Not now, River' }).textContent).toBe('Not now');
        expect(onCount).toHaveBeenLastCalledWith(2);
        expect(calls[0]).toEqual({ url: '/api/join/knocks?limit=20&offset=0', method: 'GET' });
    });

    it('Invite: the node makes the invite, the row goes, and the member is told the app finds it by itself', async () => {
        const calls = stub((url, init) => init?.method === 'POST'
            ? json(200, { knock: { id: 'k1', status: 'approved' }, invite: { code: 'BP-x', expiresAt: null } })
            : json(200, { knocks: [RIVER, SKY], total: 2 }));
        const onCount = vi.fn();
        render(<WantsToJoin onCount={onCount} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Invite River' }));
        expect(await screen.findByTestId('wants-to-join-done')).toHaveTextContent('You invited River. Their app will find the invite by itself.');
        expect(screen.queryByTestId('wants-to-join-k1')).toBeNull();
        expect(screen.getByTestId('wants-to-join-k2')).toBeTruthy();
        expect(screen.getByRole('heading', { name: '🚪 Wants to join (1)' })).toBeTruthy();
        expect(onCount).toHaveBeenLastCalledWith(1);
        expect(calls.filter(c => c.method === 'POST')).toEqual([{ url: '/api/join/knocks/k1/approve', method: 'POST' }]);
    });

    it('Not now: the row goes, and nothing is said about them (a no is never a message)', async () => {
        const calls = stub((url, init) => init?.method === 'POST'
            ? json(200, { knock: { id: 'k2', status: 'declined' } })
            : json(200, { knocks: [RIVER, SKY], total: 2 }));
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, Sky' }));
        await waitFor(() => expect(screen.queryByTestId('wants-to-join-k2')).toBeNull());
        expect(screen.queryByTestId('wants-to-join-done')).toBeNull();
        expect(calls.filter(c => c.method === 'POST')).toEqual([{ url: '/api/join/knocks/k2/decline', method: 'POST' }]);
    });

    it('the last one answered: the section goes', async () => {
        stub((url, init) => init?.method === 'POST' ? json(200, { knock: { id: 'k2', status: 'declined' } }) : json(200, { knocks: [SKY], total: 1 }));
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, Sky' }));
        await waitFor(() => expect(screen.queryByTestId('wants-to-join')).toBeNull());
    });

    const REFUSALS: Array<[string, number, string, string]> = [
        ['another member got there first', 409, 'answered', 'Another member has already answered this request.'],
        ['it lapsed', 409, 'lapsed', 'This request is more than 30 days old and has lapsed. They can ask again.'],
        ['they joined meanwhile', 409, 'already_member', 'They have already joined this community.'],
        ['their key was replaced', 409, 'key_invalidated', 'This request came from a key that has since been replaced by a new one, so there is nothing to answer.'],
        ['it is gone', 404, 'not_found', 'There’s no such request to join.'],
        ['only admins answer here', 403, 'admins_only', 'Only an admin of this community can answer requests to join here.'],
        ['a standby copy', 503, 'standby', 'This server is a standby copy of the community, not its main server. Requests to join are answered on the main server.'],
    ];
    for (const [why, status, code, words] of REFUSALS) {
        it(`a refusal (${why}): the community's own words under the row, then the list read again`, async () => {
            let reads = 0;
            stub((url, init) => {
                if (init?.method === 'POST') return json(status, { error: words, code });
                reads++;
                return json(200, { knocks: [RIVER], total: 1 });
            });
            render(<WantsToJoin />);
            fireEvent.click(await screen.findByRole('button', { name: 'Invite River' }));
            expect(await screen.findByTestId('wants-to-join-note-k1')).toHaveTextContent(words);
            await waitFor(() => expect(reads).toBe(2));
            expect(screen.queryByTestId('wants-to-join-done')).toBeNull();
        });
    }

    it('an answer that couldn\'t reach the community says so in the app\'s words', async () => {
        stub((url, init) => {
            if (init?.method === 'POST') throw new TypeError('Failed to fetch');
            return json(200, { knocks: [RIVER], total: 1 });
        });
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, River' }));
        expect(await screen.findByTestId('wants-to-join-note-k1')).toHaveTextContent(WANTS_TO_JOIN_WORDS.unreachable);
    });

    it('no section where the community takes no requests (404) or this member can\'t answer them (403)', async () => {
        for (const status of [404, 403]) {
            stub(() => json(status, { error: 'no', code: 'x' }));
            const onCount = vi.fn();
            const { container } = render(<WantsToJoin onCount={onCount} />);
            await waitFor(() => { expect(onCount).toHaveBeenCalledWith(0); expect(container.innerHTML).toBe(''); });
            cleanup();
        }
    });

    it('nobody waiting: no section', async () => {
        stub(() => json(200, { knocks: [], total: 0 }));
        const onCount = vi.fn();
        const { container } = render(<WantsToJoin onCount={onCount} />);
        await waitFor(() => { expect(onCount).toHaveBeenCalledWith(0); expect(container.innerHTML).toBe(''); });
    });

    it('the list can\'t be read: said, never an empty list', async () => {
        stub(() => { throw new TypeError('Failed to fetch'); });
        render(<WantsToJoin />);
        expect(await screen.findByTestId('wants-to-join-error')).toHaveTextContent(WANTS_TO_JOIN_WORDS.unreachable);
    });
});
