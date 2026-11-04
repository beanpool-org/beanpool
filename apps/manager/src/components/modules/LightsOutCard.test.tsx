import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LightsOutCard, hallHref } from './LightsOutCard';
import type { NodeProfile } from '../../lib/profiles';

const node: NodeProfile = { id: 'hall-node', name: 'Hall', url: 'http://localhost:8080', adminPassword: '' };
const OWNER_KEY = { kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' } as const;
const ADMIN_KEY = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' } as const;

const off = (over: Record<string, unknown> = {}) => ({
    on: false, since: null, address: null, recordAsOf: null, home: 'https://byron.beanpool.org', epoch: 0, hallWrites: false, standDown: null, standby: false, ...over,
});

type Call = { url: string; init?: RequestInit };
function fakeNode(view: Record<string, unknown>, post?: { status: number; body: unknown }[]) {
    const calls: Call[] = [];
    const answers = [...(post ?? [])];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/api/local/admin/lights-out') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ lightsOut: view }), { status: 200 });
        if (url.endsWith('/api/local/admin/lights-out')) {
            const a = answers.shift() ?? { status: 200, body: { success: true, lightsOut: off({ on: true, since: '2026-11-04T09:00:00.000Z', address: 'http://192.168.8.1:8080' }) } };
            return new Response(JSON.stringify(a.body), { status: a.status });
        }
        return new Response('{}', { status: 200 });
    });
    return calls;
}

describe('LightsOutCard', () => {
    beforeEach(() => { vi.restoreAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('an owner turns it on with the hall address; the answer shows it on', async () => {
        const calls = fakeNode(off());
        render(<LightsOutCard activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByText('Lights-out is off.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText(/address on the hall Wi-Fi/), { target: { value: 'http://192.168.8.1:8080' } });
        fireEvent.click(screen.getByTestId('lights-out-switch'));
        expect(await screen.findByText('Lights-out is on.')).toBeInTheDocument();
        const post = calls.find((c) => c.init?.method === 'POST');
        expect(JSON.parse(String(post?.init?.body))).toEqual({ on: true, address: 'http://192.168.8.1:8080' });
        // The poster opens at the laptop's hall address, not relative to wherever Settings was opened (review 1cb42147).
        expect(screen.getByRole('link', { name: 'Show the poster' })).toHaveAttribute('href', 'http://192.168.8.1:8080/hall');
    });

    it('asks the fresh proof when the server does, and re-sends with the code', async () => {
        const calls = fakeNode(off(), [{ status: 401, body: { error: 'Invalid 2FA code', totpRequired: true } }]);
        render(<LightsOutCard activeNode={node} viewer={{ kind: 'password' }} />);
        fireEvent.click(await screen.findByTestId('lights-out-switch'));
        const field = await screen.findByLabelText('Current code');
        fireEvent.change(field, { target: { value: '123456' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(2));
        const second = calls.filter((c) => c.init?.method === 'POST')[1];
        expect(JSON.parse(String(second.init?.body)).code).toBe('123456');
    });

    it('an admin sees the switch as it stands and is told only an owner can change it', async () => {
        fakeNode(off({ on: true, since: '2026-11-04T09:00:00.000Z', recordAsOf: '2026-11-03T14:02:00.000Z' }));
        render(<LightsOutCard activeNode={node} viewer={ADMIN_KEY} />);
        expect(await screen.findByText('Lights-out is on.')).toBeInTheDocument();
        expect(screen.getByText('Only an owner can turn lights-out on or off.')).toBeInTheDocument();
        expect(screen.queryByTestId('lights-out-switch')).toBeNull();
        expect(screen.getByTestId('lights-out-record').textContent).toMatch(/^The record is as of .+\. Trades made since then on the old server are not here\.$/);
    });

    it('shows the stand-down steps after a hall nobody wrote in', async () => {
        fakeNode(off({ since: '2026-11-04T09:00:00.000Z', standDown: { offered: true, steps: ['Nobody wrote anything.', 'beanpool pair'] } }));
        render(<LightsOutCard activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByTestId('lights-out-stand-down')).toBeInTheDocument();
        expect(screen.getByText('Stand down: go back to being the standby')).toBeInTheDocument();
    });

    it('a standby is told to take over first; no switch', async () => {
        fakeNode(off({ standby: true }));
        render(<LightsOutCard activeNode={node} viewer={OWNER_KEY} />);
        expect(await screen.findByText(/This server is a standby/)).toBeInTheDocument();
        expect(screen.queryByTestId('lights-out-switch')).toBeNull();
    });

    it('a node without lights-out (404) draws nothing', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 404 }));
        const { container } = render(<LightsOutCard activeNode={node} viewer={OWNER_KEY} />);
        await waitFor(() => expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0));
        expect(container.innerHTML).toBe('');
    });
});

describe('hallHref', () => {
    it('uses the hall address when it is http(s), and a plain /hall otherwise', () => {
        expect(hallHref('http://192.168.8.1:8080')).toBe('http://192.168.8.1:8080/hall');
        expect(hallHref('http://192.168.8.1:8080/')).toBe('http://192.168.8.1:8080/hall');
        expect(hallHref(null)).toBe('/hall');
        expect(hallHref('')).toBe('/hall');
        expect(hallHref('javascript:alert(1)')).toBe('/hall');
        expect(hallHref('not a url')).toBe('/hall');
    });
});
