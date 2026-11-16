/**
 * The web's "Beside my name on the worldwide forum" row (slice F10 apps; components/ForumLabelRow.tsx, lib/forum-label.ts),
 * the real row and its real requests over stand-ins for the two servers it talks to:
 *
 * - the worldwide community this web app talks to: GET and POST /api/forum/label (signed), and its directory
 *   (GET /api/global/communities?q=), the member picking their community by name;
 * - the member's own community, at the address the directory gives for it: GET /api/membership/note, signed by this
 *   browser's key for that host (api.ts signedFetchAt), never by anything of the worldwide community's.
 *
 * What each request carried is checked. A refusal from the member's community is said in its words and nothing is posted.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.now();
const HILLSIDE = '12D3KooWHi11sideKey111111111111111111111111111111';
const ME = 'a'.repeat(64);
const note = { v: 1, community: HILLSIDE, name: 'Hillside', member: ME, issuedAt: NOW, expiresAt: NOW + 30 * 86_400_000, sig: 'b'.repeat(128) };

type Call = { method: string; to: string; body?: unknown };
const net = vi.hoisted(() => ({
    calls: [] as Call[],
    label: null as unknown,
    noteAnswer: { status: 200, body: {} as unknown },
    postAnswer: null as null | ((body: any) => { status: number; body: unknown }),
}));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
vi.mock('../lib/api', () => ({
    signedFetch: vi.fn(async (method: string, path: string, body?: unknown) => {
        net.calls.push({ method, to: `here${path}`, ...(body === undefined ? {} : { body }) });
        if (method === 'GET') return json(200, net.label);
        const out = net.postAnswer!(body);
        return json(out.status, out.body);
    }),
    signedFetchAt: vi.fn(async (method: string, community: string, path: string) => {
        net.calls.push({ method, to: `${community}${path}` });
        return json(net.noteAnswer.status, net.noteAnswer.body);
    }),
    request: vi.fn(async (method: string, path: string) => {
        net.calls.push({ method, to: `here${path}` });
        return { communities: [
            { key: HILLSIDE, name: 'Hillside', url: 'https://hillside.example' },
            { key: 'x', name: 'No address', url: null },
        ] };
    }),
}));
vi.mock('../lib/identity', () => ({ loadIdentity: vi.fn(async () => ({ publicKey: ME, privateKey: 'k'.repeat(64), callsign: 'Ana' })) }));

import { ForumLabelRow } from './ForumLabelRow';

const none = { show: 'none', community: null, lapsesAt: null, label: null, why: null };
const atHillside = { show: 'community', community: { key: HILLSIDE, name: 'Hillside' }, lapsesAt: new Date(NOW + 30 * 86_400_000).toISOString(), label: { kind: 'community', community: 'Hillside' }, why: null };

beforeEach(() => {
    net.calls = [];
    net.label = none;
    net.noteAnswer = { status: 200, body: { note } };
    net.postAnswer = (body) => ({ status: 200, body: body.show === 'community' ? atHillside : { ...none, show: body.show, label: body.show === 'waiting' ? { kind: 'waiting' } : null } });
    try { localStorage.clear(); } catch { /* none */ }
});
afterEach(() => cleanup());

async function drawn() {
    render(<ForumLabelRow myName="Ana" />);
    await screen.findByTestId('settings-forum-label');
}
const checked = () => screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);

describe('the row on the web', () => {
    it('the three choices, Don\'t show chosen; nothing is drawn before the forum answers', async () => {
        await drawn();
        expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Don’t show✓', 'My community…', 'I’m waiting to join one']);
        expect(checked()).toEqual(['Don’t show✓']);
        expect(net.calls).toEqual([{ method: 'GET', to: 'here/api/forum/label' }]);
    });

    it('My community: the directory by name, then the note from that community\'s own address, then the forum', async () => {
        await drawn();
        fireEvent.click(screen.getByTestId('forum-label-community'));
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Hill' } });
        const pick = await screen.findByRole('button', { name: 'Hillside' });
        // A row with no address can't be asked: it is not offered.
        expect(screen.queryByRole('button', { name: 'No address' })).toBeNull();
        await act(async () => { fireEvent.click(pick); });
        await waitFor(() => expect(screen.getByTestId('forum-label-shown').textContent).toBe('Others see: Ana · Hillside'));
        expect(net.calls.slice(1)).toEqual([
            { method: 'GET', to: 'here/api/global/communities?q=Hill&limit=8' },
            { method: 'GET', to: 'https://hillside.example/api/membership/note' },
            { method: 'POST', to: 'here/api/forum/label', body: { show: 'community', note } },
        ]);
        expect(checked()).toEqual(['Hillside✓']);
        // Kept for renewing: this browser's key, the community's key, and where it was asked.
        expect(JSON.parse(localStorage.getItem('beanpool_forum_label_at')!)).toEqual({ member: ME, key: HILLSIDE, address: 'https://hillside.example' });
    });

    it('a community that gives no note: its words, nothing posted, the choice as it was', async () => {
        net.noteAnswer = { status: 409, body: { error: 'Your community isn’t listed publicly, so its name can’t be shown.', code: 'not_listed' } };
        await drawn();
        fireEvent.click(screen.getByTestId('forum-label-community'));
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Hill' } });
        const pick = await screen.findByRole('button', { name: 'Hillside' });
        await act(async () => { fireEvent.click(pick); });
        expect((await screen.findByRole('alert')).textContent).toBe('Your community isn’t listed publicly, so its name can’t be shown.');
        expect(net.calls.some((c) => c.method === 'POST')).toBe(false);
        expect(checked()).toEqual(['Don’t show✓']);
    });

    it('waiting, then Don\'t show: each posted with no note; switching off posts {show:\'none\'} and forgets the address', async () => {
        net.label = atHillside;
        localStorage.setItem('beanpool_forum_label_at', JSON.stringify({ member: ME, key: HILLSIDE, address: 'https://hillside.example' }));
        await drawn();
        expect(checked()).toEqual(['Hillside✓']);
        await act(async () => { fireEvent.click(screen.getByTestId('forum-label-waiting')); });
        await waitFor(() => expect(screen.getByTestId('forum-label-shown').textContent).toBe('Others see: Ana · waiting to join'));
        await act(async () => { fireEvent.click(screen.getByTestId('forum-label-none')); });
        await waitFor(() => expect(checked()).toEqual(['Don’t show✓']));
        expect(screen.queryByTestId('forum-label-shown')).toBeNull();
        expect(net.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ show: 'waiting' }, { show: 'none' }]);
        expect(localStorage.getItem('beanpool_forum_label_at')).toBeNull();
    });

    it('a community no longer listed: chosen still, the design\'s words', async () => {
        net.label = { ...atHillside, community: { key: HILLSIDE, name: null }, label: null, why: 'not_listed' };
        await drawn();
        expect(checked()).toEqual(['My community…✓']);
        expect(screen.getByRole('alert').textContent).toBe('Your community isn’t listed publicly, so its name can’t be shown.');
    });
});
