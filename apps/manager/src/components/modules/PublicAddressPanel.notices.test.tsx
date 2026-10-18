import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PublicAddressPanel } from './PublicAddressPanel';
import type { NodeProfile } from '../../lib/profiles';

// Notices from the address service (registrar slice S2): Settings → Public Address shows what the BeanPool project wrote
// to this community's name, read after the status check that brings them (apps/server services/registrar-notices.ts).

const node: NodeProfile = { id: 'local-node', name: 'Kestrel Node', url: 'http://localhost:8080', adminPassword: 'test-password' };
const REPLY = `https://beanpool.org/reply/${'a'.repeat(43)}`;

function mockNotices(notices: unknown, status = 200): string[] {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation((url) => {
        const u = String(url);
        calls.push(u);
        const isNotices = u.includes('/public-address/notices');
        const body = u.includes('/public-address/status')
            ? { success: true, status: 'live', name: 'kestrel', hostname: 'kestrel.beanpool.org', mode: 'tunnel' }
            : isNotices ? { success: true, notices } : { success: true, logs: [] };
        const code = isNotices ? status : 200;
        return Promise.resolve({ ok: code < 400, status: code, json: () => Promise.resolve(body) } as Response);
    });
    return calls;
}

describe('PublicAddressPanel: notices from the address service', () => {
    beforeEach(() => { vi.restoreAllMocks(); });

    it('shows each notice as text, newest first, with its Reply link when it has one', async () => {
        mockNotices([
            { id: 9, at: 1_760_000_000, level: 'action', text: 'Blocked by mistake?\n<b>Tell us</b>', name: 'kestrel', link: REPLY },
            { id: 4, at: 1_759_000_000, level: 'info', text: 'Your name is set up.', name: 'kestrel', link: null },
        ]);
        render(<PublicAddressPanel activeNode={node} />);
        const box = await screen.findByTestId('address-notices');
        expect(box).toHaveTextContent('From your address service');
        const items = screen.getAllByTestId('address-notice');
        expect(items).toHaveLength(2);
        expect(items[0]).toHaveTextContent('Action needed');
        expect(items[0]).toHaveTextContent('<b>Tell us</b>');
        expect(items[0].querySelector('b')).toBeNull();
        expect(items[1]).toHaveTextContent('Information');
        expect(items[1]).toHaveTextContent('Your name is set up.');
        const reply = screen.getAllByRole('link', { name: 'Reply' });
        expect(reply).toHaveLength(1);
        expect(reply[0]).toHaveAttribute('href', REPLY);
        expect(reply[0]).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('tells an admin, who is given no reply link, that only an owner can reply, with nothing to press', async () => {
        mockNotices([
            { id: 9, at: 1_760_000_000, level: 'action', text: 'Blocked by mistake?', name: 'kestrel', link: null, replyOwnerOnly: true },
            { id: 4, at: 1_759_000_000, level: 'info', text: 'Your name is set up.', name: 'kestrel', link: null },
        ]);
        render(<PublicAddressPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'b'.repeat(64), role: 'admin' }} />);
        const items = await screen.findAllByTestId('address-notice');
        expect(items).toHaveLength(2);
        expect(items[0]).toHaveTextContent('only an owner can reply');
        expect(items[1]).not.toHaveTextContent('only an owner can reply');
        expect(screen.queryByRole('link', { name: 'Reply' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
    });

    it('shows nothing when there are none', async () => {
        const calls = mockNotices([]);
        render(<PublicAddressPanel activeNode={node} />);
        await waitFor(() => expect(calls.some((c) => c.includes('/public-address/notices'))).toBe(true));
        await screen.findByText('kestrel.beanpool.org');
        expect(screen.queryByTestId('address-notices')).not.toBeInTheDocument();
    });

    it('shows nothing from an older server, which answers 404', async () => {
        const calls = mockNotices(undefined, 404);
        render(<PublicAddressPanel activeNode={node} />);
        await waitFor(() => expect(calls.some((c) => c.includes('/public-address/notices'))).toBe(true));
        await screen.findByText('kestrel.beanpool.org');
        expect(screen.queryByTestId('address-notices')).not.toBeInTheDocument();
    });
});
