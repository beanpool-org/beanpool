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

    it('more waiting than the first page (20): an answer reads the list again, so the next one comes up and the count is the node\'s', async () => {
        const waiting = Array.from({ length: 22 }, (_, i) => ({ ...SKY, id: `w${i + 1}`, callsign: `Asker ${i + 1}` }));
        let answered = 0;
        const calls = stub((url, init) => {
            if (init?.method === 'POST') { answered++; return json(200, { knock: { status: 'declined' } }); }
            const open = waiting.slice(answered);
            return json(200, { knocks: open.slice(0, 20), total: open.length });
        });
        const onCount = vi.fn();
        render(<WantsToJoin onCount={onCount} />);
        expect(await screen.findByRole('heading', { name: '🚪 Wants to join (22)' })).toBeTruthy();
        expect(screen.queryByTestId('wants-to-join-w21')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Not now, Asker 1' }));
        expect(await screen.findByTestId('wants-to-join-w21')).toBeTruthy();
        expect(screen.queryByTestId('wants-to-join-w1')).toBeNull();
        expect(screen.getByRole('heading', { name: '🚪 Wants to join (21)' })).toBeTruthy();
        expect(onCount).toHaveBeenLastCalledWith(21);
        expect(calls.filter(c => c.method === 'GET')).toHaveLength(2);
    });

    it('everyone waiting is on the page: an answer reads nothing again', async () => {
        const calls = stub((url, init) => init?.method === 'POST'
            ? json(200, { knock: { id: 'k2', status: 'declined' } })
            : json(200, { knocks: [RIVER, SKY], total: 2 }));
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, Sky' }));
        await waitFor(() => expect(screen.queryByTestId('wants-to-join-k2')).toBeNull());
        await new Promise(r => setTimeout(r, 20));
        expect(calls.filter(c => c.method === 'GET')).toHaveLength(1);
        expect(screen.getByTestId('wants-to-join-k1')).toBeTruthy();
    });

    it('the last one answered: the section goes', async () => {
        stub((url, init) => init?.method === 'POST' ? json(200, { knock: { id: 'k2', status: 'declined' } }) : json(200, { knocks: [SKY], total: 1 }));
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, Sky' }));
        await waitFor(() => expect(screen.queryByTestId('wants-to-join')).toBeNull());
    });

    /**
     * Each refusal, and what the node's list then says, as engine/knocks.ts lists (pending, inside 30 days, not a member,
     * key not replaced): the row is gone for five of them, the list is a 403 for admins only, and only a standby still
     * lists it.
     */
    const REFUSALS: Array<[string, number, string, string, 'gone' | 'hidden' | 'kept']> = [
        ['another member got there first', 409, 'answered', 'Another member has already answered this request.', 'gone'],
        ['it lapsed', 409, 'lapsed', 'This request is more than 30 days old and has lapsed. They can ask again.', 'gone'],
        ['they joined meanwhile', 409, 'already_member', 'They have already joined this community.', 'gone'],
        ['their key was replaced', 409, 'key_invalidated', 'This request came from a key that has since been replaced by a new one, so there is nothing to answer.', 'gone'],
        ['it is gone', 404, 'not_found', 'There’s no such request to join.', 'gone'],
        ['only admins answer here', 403, 'admins_only', 'Only an admin of this community can answer requests to join here.', 'hidden'],
        ['a standby copy', 503, 'standby', 'This server is a standby copy of the community, not its main server. Requests to join are answered on the main server.', 'kept'],
    ];
    for (const [why, status, code, words, after] of REFUSALS) {
        it(`a refusal (${why}): the community's own words, still there after the list is read again`, async () => {
            let reads = 0;
            stub((url, init) => {
                if (init?.method === 'POST') return json(status, { error: words, code });
                reads++;
                if (reads === 1) return json(200, { knocks: [RIVER, SKY], total: 2 });
                if (after === 'hidden') return json(403, { error: words, code });
                return json(200, after === 'kept' ? { knocks: [RIVER, SKY], total: 2 } : { knocks: [SKY], total: 1 });
            });
            const onCount = vi.fn();
            render(<WantsToJoin onCount={onCount} />);
            fireEvent.click(await screen.findByRole('button', { name: 'Invite River' }));
            expect(await screen.findByTestId('wants-to-join-note-k1')).toHaveTextContent(words);
            await waitFor(() => expect(reads).toBe(2));
            await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(after === 'kept' ? 2 : after === 'hidden' ? 0 : 1));
            // The re-read has drawn: the sentence outlives the row it was about, and says whose it was.
            const note = screen.getByTestId('wants-to-join-note-k1');
            expect(note).toHaveTextContent(words);
            expect(note).toHaveTextContent('River');
            expect(screen.queryByTestId('wants-to-join-k1') !== null).toBe(after === 'kept');
            expect(screen.queryByTestId('wants-to-join-k2') !== null).toBe(after !== 'hidden');
            expect(screen.queryByTestId('wants-to-join-done')).toBeNull();
        });
    }

    it('the last row refused and gone: the section stays to say why', async () => {
        let reads = 0;
        stub((url, init) => {
            if (init?.method === 'POST') return json(409, { error: 'Another member has already answered this request.', code: 'answered' });
            reads++;
            return json(200, reads === 1 ? { knocks: [RIVER], total: 1 } : { knocks: [], total: 0 });
        });
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, River' }));
        await waitFor(() => expect(reads).toBe(2));
        await waitFor(() => expect(screen.getByRole('heading', { name: '🚪 Wants to join (0)' })).toBeTruthy());
        expect(screen.getByTestId('wants-to-join-note-k1')).toHaveTextContent('Another member has already answered this request.');
        expect(screen.queryByTestId('wants-to-join-k1')).toBeNull();
    });

    it('one line says what the last answer did: a refusal replaces "You invited", and the next answer replaces the refusal', async () => {
        stub((url, init) => {
            if (init?.method === 'POST') {
                return url.includes('/k1/')
                    ? json(200, { knock: { id: 'k1', status: 'approved' }, invite: { code: 'BP-x', expiresAt: null } })
                    : json(409, { error: 'They have already joined this community.', code: 'already_member' });
            }
            return json(200, { knocks: [RIVER, SKY], total: 2 });
        });
        render(<WantsToJoin />);
        fireEvent.click(await screen.findByRole('button', { name: 'Not now, Sky' }));
        expect(await screen.findByTestId('wants-to-join-note-k2')).toHaveTextContent('They have already joined this community.');
        fireEvent.click(await screen.findByRole('button', { name: 'Invite River' }));
        expect(await screen.findByTestId('wants-to-join-done')).toHaveTextContent('You invited River.');
        expect(screen.queryByTestId('wants-to-join-note-k2')).toBeNull();
    });

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

    it('the list can\'t be read on first load: error shown, no endless "Loading…", and no "(0)" heading', async () => {
        stub(() => { throw new TypeError('Failed to fetch'); });
        render(<WantsToJoin />);
        expect(await screen.findByTestId('wants-to-join-error')).toHaveTextContent(WANTS_TO_JOIN_WORDS.unreachable);
        expect(screen.queryByText('Loading…')).toBeNull();
        expect(screen.queryByRole('heading')).toBeNull();
    });

    it('a 5xx/429 does not reveal the section to a member who otherwise wouldn\'t see it', async () => {
        for (const status of [500, 429]) {
            stub(() => json(status, { error: 'Server error', code: 'error' }));
            const onCount = vi.fn();
            const { container } = render(<WantsToJoin canSee={false} onCount={onCount} />);
            await new Promise(r => setTimeout(r, 20));
            expect(container.innerHTML).toBe('');
            expect(screen.queryByTestId('wants-to-join')).toBeNull();
            cleanup();
        }
    });

    it('a 5xx/429 shows the error (no loading, no (0) heading) to a member who may see it', async () => {
        for (const status of [500, 429]) {
            stub(() => json(status, { error: 'Server busy', code: 'busy' }));
            render(<WantsToJoin canSee={true} />);
            expect(await screen.findByTestId('wants-to-join-error')).toHaveTextContent('Server busy');
            expect(screen.queryByText('Loading…')).toBeNull();
            expect(screen.queryByRole('heading')).toBeNull();
            cleanup();
        }
    });
});
