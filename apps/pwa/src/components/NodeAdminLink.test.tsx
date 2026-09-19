import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { NodeAdminLink } from './NodeAdminLink';
import { request } from '../lib/api';

vi.mock('../lib/api', () => ({
    request: vi.fn(),
    getNodeApiUrl: vi.fn(() => ''),
}));

describe('NodeAdminLink', () => {
    beforeEach(() => vi.clearAllMocks());

    it('asks the node (signed request) and shows Manage to an owner, linking to /settings#from=pwa', async () => {
        vi.mocked(request).mockResolvedValue({ role: 'owner', communityName: 'Mullum' });
        render(<NodeAdminLink />);
        const link = await screen.findByRole('link', { name: /Manage Mullum/ });
        expect(link.getAttribute('href')).toBe('/settings#from=pwa');
        // In the fragment, never the query: Settings reads it there, and no server or log sees it.
        const u = new URL(link.getAttribute('href')!, 'https://test.beanpool.org');
        expect(u.search).toBe('');
        expect(new URLSearchParams(u.hash.slice(1)).get('from')).toBe('pwa');
        expect(request).toHaveBeenCalledWith('GET', '/api/node-admin/me');
    });

    it('points to signing in by phone: open Settings here, scan with the BeanPool app (the web app is not a scanner)', async () => {
        vi.mocked(request).mockResolvedValue({ role: 'owner', communityName: 'Mullum' });
        render(<NodeAdminLink />);
        const link = await screen.findByRole('link', { name: /Manage Mullum/ });
        expect(link.textContent).toMatch(/Open Settings on this computer, then\s+scan its code with the BeanPool app/);
        expect(link.textContent).toMatch(/Sign in on a computer/);
        expect(link.textContent).toMatch(/admin password/);
    });

    it('shows it to an admin', async () => {
        vi.mocked(request).mockResolvedValue({ role: 'admin', communityName: null });
        render(<NodeAdminLink />);
        expect(await screen.findByRole('link', { name: /Manage this community/ })).toBeTruthy();
    });

    it.each([
        ['a plain member', { role: null }],
        ['a moderator', { role: 'moderator' }],
        ['an unexpected value', { role: 'OWNER' }],
    ])('never shows it to %s', async (_label, body) => {
        vi.mocked(request).mockResolvedValue(body);
        const { container } = render(<NodeAdminLink />);
        await waitFor(() => expect(request).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });

    it('fails closed when the node refuses or is an older node without the endpoint', async () => {
        vi.mocked(request).mockRejectedValue(new Error('Request failed: 404'));
        const { container } = render(<NodeAdminLink />);
        await waitFor(() => expect(request).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });
});
