/**
 * Settings → Addresses → Spares, several addresses S8 (design scratch/fable-design/DESIGN-several-addresses-fable.md §6, §8;
 * Marty's pick 6): where the community would go if this server were lost, a standby's own address. An owner adds one after
 * the question (it is a door, as an address is) and removes one, through POST /api/local/admin/app-addresses/spares, with
 * the owner's fresh proof; an admin sees the spares and changes nothing.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AddressesPanel } from './AddressesPanel';
import type { AppAddressesReport } from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'riverside-node', name: 'Riverside', url: 'http://localhost:8080', automationToken: 'test-token' };

function reportWith(spares: string[]): AppAddressesReport {
    return {
        primaryAddress: '203.0.113.5',
        named: true,
        addresses: [{ address: '203.0.113.5', source: 'owner', today: 2, busiestDay: 4 }],
        unconfirmed: [],
        heldBack: [],
        unboundSignaturesUntil: null,
        unboundSignaturesAccepted: false,
        list: { main: '203.0.113.5', addresses: ['203.0.113.5'], spares },
        spares,
    };
}

const routeOf = (u: string) => { const p = new URL(u, 'http://x').pathname; return p.slice(p.indexOf('/api/')); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubNode(spares: string[], answer: (body: Record<string, unknown>) => [number, unknown] = () => [200, reportWith(spares)]) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (opts?.method === 'POST') {
            const body = JSON.parse(String(opts.body || '{}'));
            const path = routeOf(u);
            posts.push({ path, body });
            if (path === '/api/local/admin/app-addresses/spares') return json(...answer(body));
            return json(404, { error: 'not here' });
        }
        if (u.includes('/app-addresses')) return json(200, reportWith(spares));
        return json(200, { logs: [], names: [], notices: [] });
    });
    return { posts };
}

describe('Addresses S8: Spares', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('lists the spares with the design\'s words, and none says so', async () => {
        stubNode(['198.51.100.7']);
        render(<AddressesPanel activeNode={node} />);
        const box = await screen.findByTestId('addresses-spares');
        expect(within(box).getByText('Where this community would go if this server were lost. It is published with the addresses.')).toBeTruthy();
        await waitFor(() => expect(within(box).getAllByTestId('addresses-spare-row')).toHaveLength(1));
        expect(within(box).getByText('198.51.100.7')).toBeTruthy();
    });

    it('an owner adds a spare after the question, and the one route is called with the address', async () => {
        const { posts } = stubNode([]);
        render(<AddressesPanel activeNode={node} />);
        const box = await screen.findByTestId('addresses-spares');
        await waitFor(() => expect(within(box).getByText('No spares yet.')).toBeTruthy());
        fireEvent.change(within(box).getByPlaceholderText('e.g. standby.example.org'), { target: { value: '198.51.100.7' } });
        fireEvent.click(within(box).getByRole('button', { name: 'Add a spare' }));
        const ask = await screen.findByRole('alertdialog');
        expect(within(ask).getByText(/Members' phones go to 198\.51\.100\.7 only when none of this community's addresses answers/)).toBeTruthy();
        expect(posts).toEqual([]); // nothing sent before the owner says yes
        fireEvent.click(within(ask).getByRole('button', { name: 'Add it' }));
        await waitFor(() => expect(posts).toEqual([{ path: '/api/local/admin/app-addresses/spares', body: { action: 'add', address: '198.51.100.7' } }]));
        expect(await screen.findByText('198.51.100.7 is a spare now.')).toBeTruthy();
    });

    it('an owner removes a spare; a refusal says the server\'s words, never success', async () => {
        const { posts } = stubNode(['198.51.100.7'], () => [409, { error: 'That address is not one of this community\'s spares.' }]);
        render(<AddressesPanel activeNode={node} />);
        const box = await screen.findByTestId('addresses-spares');
        fireEvent.click(await within(box).findByRole('button', { name: 'Remove 198.51.100.7' }));
        await waitFor(() => expect(posts).toEqual([{ path: '/api/local/admin/app-addresses/spares', body: { action: 'remove', address: '198.51.100.7' } }]));
        expect(await screen.findByText('That address is not one of this community\'s spares.')).toBeTruthy();
        expect(screen.queryByText('198.51.100.7 is no longer a spare.')).toBeNull();
    });

    it('an admin sees the spares and changes nothing: no field, no buttons', async () => {
        stubNode(['198.51.100.7']);
        render(<AddressesPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'ab'.repeat(32), role: 'admin' }} />);
        const box = await screen.findByTestId('addresses-spares');
        await waitFor(() => expect(within(box).getByText('198.51.100.7')).toBeTruthy());
        expect(within(box).queryByRole('button')).toBeNull();
        expect(within(box).queryByRole('textbox')).toBeNull();
    });
});
