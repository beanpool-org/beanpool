import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddressesPanel } from './AddressesPanel';
import type { NodeProfile } from '../../lib/profiles';

const mockActiveNode: NodeProfile = {
    id: 'local-node',
    name: 'Byron Node',
    url: 'http://localhost:8080',
    adminPassword: 'test-password',
};

const mockReport = {
    primaryAddress: 'byron.beanpool.org',
    named: true,
    addresses: [
        {
            address: 'byron.beanpool.org',
            source: 'public-address' as const,
            today: 14,
            busiestDay: 28,
            reach: {
                answers: 'own' as const,
                dns: { outcome: 'answers' as const, a: ['104.21.93.179'], aaaa: [], cname: ['edge.cloudflare.example.org'] },
                step: 'fine' as const,
                minutes: null,
                nextStep: 'Answers as this server. Nothing to do.',
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: '2026-11-02T05:02:00.000Z',
            },
        },
        {
            address: '203.0.113.5',
            source: 'owner' as const,
            today: 3,
            busiestDay: 5,
            reach: {
                answers: 'tls' as const,
                dns: null,
                step: 'certificate' as const,
                minutes: null,
                nextStep: 'Answers, but not with a certificate phones trust. Check that port 80 is open and this address points at this server.',
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
        {
            address: 'byron.example.org',
            source: 'owner' as const,
            today: 1,
            busiestDay: 2,
            reach: {
                answers: 'silence' as const,
                dns: { outcome: 'no-such-name' as const, a: [], aaaa: [], cname: [] },
                step: 'no-dns-own' as const,
                minutes: null,
                nextStep: "No DNS answer for this name. Add or fix its A record where you run your domain's DNS.",
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
        {
            address: 'pending.beanpool.org',
            source: 'registrar' as const,
            today: 0,
            busiestDay: 0,
            reach: {
                answers: 'silence' as const,
                dns: { outcome: 'no-such-name' as const, a: [], aaaa: [], cname: [] },
                step: 'awaiting-approval' as const,
                minutes: null,
                nextStep: 'Awaiting approval by the BeanPool project. It moves over by itself once approved.',
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
        {
            address: 'stopped.beanpool.org',
            source: 'registrar' as const,
            today: 0,
            busiestDay: 0,
            reach: {
                answers: 'silence' as const,
                dns: { outcome: 'no-such-name' as const, a: [], aaaa: [], cname: [] },
                step: 'stopped' as const,
                minutes: null,
                nextStep: 'Stopped by the address service. Ask the BeanPool project.',
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
        {
            address: 'fresh.beanpool.org',
            source: 'registrar' as const,
            today: 0,
            busiestDay: 0,
            reach: {
                answers: 'silence' as const,
                dns: { outcome: 'no-such-name' as const, a: [], aaaa: [], cname: [] },
                step: 'new-name' as const,
                minutes: 12,
                nextStep: "Made 12 minutes ago. Some networks remember 'no such name' for up to 30 minutes. Try mobile data, or wait.",
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
        {
            address: 'mullum.beanpool.org',
            source: 'registrar' as const,
            former: true,
            today: 2,
            busiestDay: 4,
            reach: {
                answers: 'silence' as const,
                dns: { outcome: 'no-such-name' as const, a: [], aaaa: [], cname: [] },
                step: 'no-longer-ours' as const,
                minutes: null,
                nextStep: "No longer this community's address. Nothing to do.",
                checkedAt: '2026-11-02T05:02:00.000Z',
                ownAt: null,
            },
        },
    ],
    unconfirmed: [],
    heldBack: [],
    oldApps: { today: 0, busiestDay: 0 },
    unboundSignaturesUntil: null,
    unboundSignaturesAccepted: false,
};

describe('AddressesPanel Component (S2)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders the Addresses screen with unified rows and correct headers', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const urlStr = String(url);
            if (urlStr.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            if (urlStr.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tunnel: { state: 'connected', connections: 4 } }) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('byron.beanpool.org')).toBeInTheDocument();
        });

        // Main badge on primary address
        expect(screen.getByTestId('main-badge')).toHaveTextContent('main');

        // Address kinds
        expect(screen.getAllByText('BeanPool name').length).toBeGreaterThan(0);
        expect(screen.getByText("this server's number")).toBeInTheDocument();
        expect(screen.getByText('your own domain')).toBeInTheDocument();

        // Points at
        expect(screen.getAllByText("Cloudflare, then this server's tunnel (connected)").length).toBeGreaterThan(0);
        expect(screen.getAllByText('203.0.113.5').length).toBe(2);

        // Apps today
        expect(screen.getByText(/14 apps today/)).toBeInTheDocument();
        expect(screen.getByText(/1 app today/)).toBeInTheDocument();

        // Signing status
        expect(screen.getAllByText(/✍️ yes/).length).toBeGreaterThan(0);
        expect(screen.getByText(/✍️ yes, not advertised/)).toBeInTheDocument();

        // Next steps for each state
        expect(screen.getByText(/Answers as this server\. Nothing to do\./)).toBeInTheDocument();
        expect(screen.getByText(/Answers, but not with a certificate phones trust\./)).toBeInTheDocument();
        expect(screen.getByText(/Add or fix its A record where you run your domain's DNS\./)).toBeInTheDocument();
        expect(screen.getByText(/Awaiting approval by the BeanPool project\. It moves over by itself once approved\./)).toBeInTheDocument();
        expect(screen.getByText(/Stopped by the address service\. Ask the BeanPool project\./)).toBeInTheDocument();
        expect(screen.getByText(/Made 12 minutes ago\. Some networks remember 'no such name'/)).toBeInTheDocument();
        expect(screen.getByText(/No longer this community's address\. Nothing to do\./)).toBeInTheDocument();
    });

    it('Check from your phone link is present for rows and points to /check', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            if (String(url).includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('check-phone-link-byron.beanpool.org')).toBeInTheDocument();
        });

        const link = screen.getByTestId('check-phone-link-byron.beanpool.org') as HTMLAnchorElement;
        expect(link.href).toBe('https://byron.beanpool.org/check');
    });

    it('Make main button is present on non-main addresses and absent on main address', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            if (String(url).includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('byron.beanpool.org')).toBeInTheDocument();
        });

        // Main address does NOT have "Make main"
        expect(screen.queryByTestId('make-main-btn-byron.beanpool.org')).not.toBeInTheDocument();

        // Non-main address DOES have "Make main"
        expect(screen.getByTestId('make-main-btn-203.0.113.5')).toBeInTheDocument();
        expect(screen.getByTestId('make-main-btn-byron.example.org')).toBeInTheDocument();
    });

    it('Add an address section folds in the three choices and displays recovery reminder on BeanPool name choice', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            if (String(url).includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('addresses-add-address-btn')).toBeInTheDocument();
        });

        // Click "Add an address"
        fireEvent.click(screen.getByTestId('addresses-add-address-btn'));

        // Three choices visible
        expect(screen.getByRole('button', { name: 'a free BeanPool name' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: "this server's number" })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'your own domain' })).toBeInTheDocument();

        // Recovery code reminder is visible on the BeanPool name choice (Item 3)
        const reminder = screen.getByTestId('recovery-code-reminder');
        expect(reminder).toBeInTheDocument();
        expect(reminder).toHaveTextContent(/A \.beanpool\.org name belongs to this server's key\. Make sure you keep a recovery code in Backups/);

        // Subdomain prefix input is present
        expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();

        // Switch to "this server's number"
        fireEvent.click(screen.getByRole('button', { name: "this server's number" }));
        expect(screen.getByLabelText(/Public IPv4 Address/i)).toBeInTheDocument();

        // Switch to "your own domain"
        fireEvent.click(screen.getByRole('button', { name: 'your own domain' }));
        expect(screen.getByLabelText(/Domain Name/i)).toBeInTheDocument();
    });

    it('Check now button calls POST /api/local/admin/app-addresses/check and updates checked time', async () => {
        let checkCalled = false;
        vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
            const urlStr = String(url);
            if (urlStr.includes('/api/local/admin/app-addresses/check')) {
                checkCalled = true;
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...mockReport, checking: false }) } as Response);
            }
            if (urlStr.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('addresses-check-now-btn')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('addresses-check-now-btn'));

        await waitFor(() => {
            expect(checkCalled).toBe(true);
        });
        expect(screen.getByText(/Addresses checked from outside\./)).toBeInTheDocument();
    });
});
