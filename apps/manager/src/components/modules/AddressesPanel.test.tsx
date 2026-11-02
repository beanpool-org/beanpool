import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ADDRESS_SCREEN_WORDS } from '@beanpool/core';
import {
    AddressesPanel, answersText, appsTodayText, canBecomeMain, cleanSubdomain, formatRelativeTime, formatTime, pointsAtText, tunnelStateOf,
} from './AddressesPanel';
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
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ hostname: 'byron.beanpool.org', tunnel: { state: 'connected', connections: 4 } }) } as Response);
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

        // Another BeanPool name DOES have "Make main"
        expect(screen.getByTestId('make-main-btn-pending.beanpool.org')).toBeInTheDocument();
        expect(screen.getByTestId('make-main-btn-mullum.beanpool.org')).toBeInTheDocument();

        // An own address does not while a BeanPool name is main: the server would refuse it
        expect(screen.queryByTestId('make-main-btn-203.0.113.5')).not.toBeInTheDocument();
        expect(screen.queryByTestId('make-main-btn-byron.example.org')).not.toBeInTheDocument();
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
        expect(screen.getByLabelText(/This server's public IP address/i)).toBeInTheDocument();

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
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...mockReport, addresses: mockReport.addresses.map((a) => ({ ...a, reach: { ...a.reach, checkedAt: '2026-11-02T05:40:00.000Z' } })), checking: false }) } as Response);
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
        expect(await screen.findByText(/Addresses checked from outside\./)).toBeInTheDocument();
    });

    it('pointsAtText formats IPv4, IPv6 AAAA, combined, and CNAME records correctly', () => {
        const baseReach = {
            answers: 'own' as const,
            step: 'fine' as const,
            minutes: null,
            nextStep: 'Fine',
            checkedAt: '2026-11-02T05:02:00.000Z',
            ownAt: '2026-11-02T05:02:00.000Z',
        };

        // IPv6 only
        expect(pointsAtText('example.org', {
            ...baseReach,
            dns: { outcome: 'answers', a: [], aaaa: ['2606:4700::6815:5db3'], cname: [] },
        })).toBe('2606:4700::6815:5db3');

        // Combined IPv4 + IPv6
        expect(pointsAtText('example.org', {
            ...baseReach,
            dns: { outcome: 'answers', a: ['104.21.93.179'], aaaa: ['2606:4700::6815:5db3'], cname: [] },
        })).toBe('104.21.93.179, 2606:4700::6815:5db3');

        // CNAME fallback
        expect(pointsAtText('example.org', {
            ...baseReach,
            dns: { outcome: 'answers', a: [], aaaa: [], cname: ['alias.example.com'] },
        })).toBe('alias.example.com');

        // No DNS answer
        expect(pointsAtText('example.org', {
            ...baseReach,
            dns: { outcome: 'no-such-name', a: [], aaaa: [], cname: [] },
        })).toBe('no DNS answer yet');
    });

    it('defensively handles nullish data.addresses on initial load without crashing', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const urlStr = String(url);
            if (urlStr.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ named: false }) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('addresses-add-address-btn')).toBeInTheDocument();
        });
        expect(screen.getByText(/No addresses configured yet\./)).toBeInTheDocument();
    });

    it('handleMakeMain reports approval-pending without false success when claim is pending', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const urlStr = String(url);
            if (urlStr.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockReport) } as Response);
            }
            if (urlStr.includes('/api/local/admin/public-address/claim')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, status: 'pending' }) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('make-main-btn-pending.beanpool.org')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByTestId('make-main-btn-pending.beanpool.org'));

        await waitFor(() => {
            expect(screen.getByText(/Requested pending\.beanpool\.org, awaiting approval by the BeanPool project\./)).toBeInTheDocument();
        });
        expect(screen.queryByText(/pending\.beanpool\.org is now the main address\./)).not.toBeInTheDocument();
    });

    it('Remove/Release button is hidden for lost and main addresses and shown for former or owner non-main addresses', async () => {
        const reportWithLost = {
            ...mockReport,
            addresses: [
                ...mockReport.addresses,
                {
                    address: 'lost.beanpool.org',
                    source: 'registrar' as const,
                    lost: true,
                    former: true,
                    today: 0,
                    busiestDay: 0,
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
        };
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const urlStr = String(url);
            if (urlStr.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(reportWithLost) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
        });

        render(<AddressesPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('byron.beanpool.org')).toBeInTheDocument();
        });

        // Main address must NOT have Remove/Release
        expect(screen.queryByTestId('remove-release-btn-byron.beanpool.org')).not.toBeInTheDocument();

        // Lost address must NOT have Remove/Release
        expect(screen.queryByTestId('remove-release-btn-lost.beanpool.org')).not.toBeInTheDocument();

        // Former BeanPool name (not lost) has Release button
        expect(screen.getByTestId('remove-release-btn-mullum.beanpool.org')).toBeInTheDocument();

        // Configured owner IP has Remove button with accessible label
        const removeIpBtn = screen.getByTestId('remove-release-btn-203.0.113.5');
        expect(removeIpBtn).toBeInTheDocument();
        expect(removeIpBtn).toHaveAttribute('aria-label', 'Remove 203.0.113.5');
    });
});

/** A node stub: `app-addresses` answers `report`; `routes` by path substring; a POST is recorded; anything else is empty. */
function stubNode(report: unknown, routes: Record<string, (body: Record<string, unknown>) => [number, unknown]> = {}) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const reads: string[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        const route = Object.keys(routes).find((p) => u.includes(p));
        if (opts?.method === 'POST') {
            const body = JSON.parse(String(opts.body || '{}'));
            posts.push({ path: route ?? u, body });
            return route ? json(...routes[route](body)) : json(404, {});
        }
        reads.push(u);
        if (route) return json(...routes[route]({}));
        if (u.includes('/app-addresses')) return json(200, report);
        return json(200, { logs: [], names: [], notices: [] });
    });
    return { posts, reads };
}

const LIVE = { status: 'live', name: 'byron', hostname: 'byron.beanpool.org', mode: 'tunnel', tunnel: { state: 'connected', connections: 4 } };
const checkedAt = '2026-11-02T05:02:00.000Z';
const later = '2026-11-02T05:40:00.000Z';
const rowsAt = (iso: string) => ({ ...mockReport, addresses: mockReport.addresses.map((a) => ({ ...a, reach: { ...a.reach, checkedAt: iso } })) });
const lostRow = (over: Record<string, unknown> = {}) => ({
    address: 'taken.beanpool.org', source: 'registrar' as const, former: true, lost: true, today: 0, busiestDay: 2, tried: { today: 3, busiestDay: 4 },
    standing: { state: 'lost', registrarSays: 'other', releasedOn: null, acceptedUntil: null, leadsHere: false, lostSince: '2026-09-20T10:00:00Z', why: 'another-key', checkedAt },
    reach: { answers: 'other' as const, dns: null, step: 'no-longer-ours' as const, minutes: null, nextStep: "No longer this community's address. Nothing to do.", checkedAt, ownAt: null },
    ...over,
});

describe('Addresses: every owner control is on the screen (#2738)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('below the list: the address service, tunnel controls, token, notices with their reply link, spare names, certificates and the log', async () => {
        const { reads } = stubNode(mockReport, {
            '/public-address/status': () => [200, { ...LIVE, tunnelToken: 'tok-1' }],
            '/public-address/notices': () => [200, { notices: [{ id: 1, at: 1790000000, level: 'action', text: 'Please confirm this name.', name: 'byron', link: 'https://registrar.example/reply/abc' }] }],
            '/public-address/extra-names': () => [200, { names: [{ name: 'install-name', hostname: 'install-name.beanpool.org', state: 'pending', releasable: true, fromInstall: true }] }],
            '/public-address/logs': () => [200, { logs: [{ timestamp: '10:00:00', step: '1/4', message: 'Tunnel started', type: 'info' }] }],
            '/tls/status': () => [200, { ca: "Let's Encrypt", testCa: false, orders: true, identifiers: [{
                identifier: '203.0.113.5', kind: 'ip', challenge: 'http-01', source: 'owner', ownerAdded: true, retryOnly: true, communityAddress: false,
                certificate: null, nextRenewalAt: null, lastAttemptAt: null, lastSuccessAt: null, failures: 1, lastError: 'port 80 is not reachable from the internet',
            }] }],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        expect(await screen.findByRole('button', { name: /Restart tunnel/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Take offline/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /New tunnel key/ })).toBeInTheDocument();
        expect(await screen.findByTestId('address-notice')).toHaveTextContent('Please confirm this name.');
        expect(screen.getByRole('link', { name: 'Reply' })).toHaveAttribute('href', 'https://registrar.example/reply/abc');
        expect(await screen.findByTestId('extra-name')).toHaveTextContent('install-name.beanpool.org');
        expect(within(screen.getByTestId('extra-name')).getByRole('button', { name: 'Release' })).toBeInTheDocument();
        expect(await screen.findByTestId('own-address-error')).toHaveTextContent('port 80 is not reachable from the internet');
        expect(screen.getByRole('button', { name: 'Try again now' })).toBeInTheDocument();
        expect(await screen.findByText('Tunnel started')).toBeInTheDocument();
        expect(screen.getByLabelText('Tunnel Token')).toBeInTheDocument();
        // One read of the address service for the whole screen: the panel's, which the list takes its tunnel from.
        await screen.findByText("Cloudflare, then this server's tunnel (connected)");
        expect(reads.filter((u) => u.includes('/public-address/status'))).toHaveLength(1);
    });

    it('an owner on their own domain alone gets every step: nothing needs a BeanPool name', async () => {
        stubNode({ ...mockReport, primaryAddress: 'beans.example.org', addresses: [{ address: 'beans.example.org', source: 'public-address', today: 2, busiestDay: 3, reach: mockReport.addresses[2].reach }] }, {
            '/public-address/status': () => [200, { status: 'live', hostname: 'beans.example.org', mode: 'own' }],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const row = await screen.findByTestId('address-row-beans.example.org');
        expect(row).toHaveTextContent("Add or fix its A record where you run your domain's DNS.");
        expect(within(row).getByText('your own domain')).toBeInTheDocument();
        // No tunnel is claimed for a name with none, and Take offline stays off (the server refuses it for an own address).
        expect(screen.queryByText(/this server's tunnel/)).toBeNull();
        expect(await screen.findByRole('button', { name: /Restart tunnel/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Take offline/ })).toBeNull();
    });

    it('a change above reads the panels below again, and one below reads the list above again', async () => {
        const { reads } = stubNode(mockReport, {
            '/public-address/status': () => [200, LIVE],
            '/public-address/claim': () => [200, { success: true, status: 'live', hostname: 'pending.beanpool.org' }],
            '/public-address/offline': () => [200, { success: true, status: 'none' }],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const makeMain = await screen.findByTestId('make-main-btn-mullum.beanpool.org');
        await screen.findByRole('button', { name: /Take offline/ });
        const statusReads = () => reads.filter((u) => u.includes('/public-address/status')).length;
        const listReads = () => reads.filter((u) => /\/app-addresses(\?|$)/.test(u)).length;
        const [statusBefore, listBefore] = [statusReads(), listReads()];
        fireEvent.click(makeMain);
        await waitFor(() => expect(statusReads()).toBeGreaterThan(statusBefore));
        const listAfterClaim = listReads();
        expect(listAfterClaim).toBeGreaterThan(listBefore);
        fireEvent.click(await screen.findByRole('button', { name: /Take offline/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Take Offline' }));
        await waitFor(() => expect(listReads()).toBeGreaterThan(listAfterClaim));
    });
});

describe('Addresses: confirming an address stays behind its guard (#2738, director)', () => {
    beforeEach(() => vi.restoreAllMocks());

    const held = (reason: string, over: Record<string, unknown> = {}) => ({ address: 'held.example.net', today: 9, busiestDay: 9, ownerOrAdmin: false, reason, ...over });

    it('a held-back host cannot be confirmed until its box is ticked, whatever the app count says', async () => {
        const { posts } = stubNode({ ...mockReport, heldBack: [held('not-this-page')] }, {
            '/app-addresses/confirm': () => [200, mockReport],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const yes = await screen.findByRole('button', { name: 'Yes, held.example.net is its address' });
        expect(screen.getByTestId('app-address-tick-note')).toHaveTextContent("a member's app can be made to use any address");
        expect(yes).toBeDisabled();
        fireEvent.click(yes);
        expect(posts).toHaveLength(0);
        fireEvent.click(screen.getByRole('checkbox', { name: "This is this community's address" }));
        expect(yes).toBeEnabled();
        fireEvent.click(yes);
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].body).toMatchObject({ address: 'held.example.net' });
    });

    it("another community's name: the red notice, and no way to confirm it", async () => {
        stubNode({ ...mockReport, heldBack: [held('another-community', { address: 'other.beanpool.org' })] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const card = await screen.findByTestId('app-address-held');
        expect(card).toHaveTextContent("If someone asked you to confirm it, don't.");
        expect(within(card).queryByRole('button')).toBeNull();
        expect(within(card).queryByRole('checkbox')).toBeNull();
    });

    it('a host the directory lists: the red notice, and only its tick unlocks it', async () => {
        stubNode({ ...mockReport, heldBack: [held('directory', { directory: { name: 'Riverbend Commons' } })] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const card = await screen.findByTestId('app-address-held');
        expect(card).toHaveTextContent('The BeanPool directory lists held.example.net as the address of Riverbend Commons.');
        expect(within(card).getByRole('button', { name: /Yes, held\.example\.net/ })).toBeDisabled();
        fireEvent.click(within(card).getByRole('checkbox', { name: 'Riverbend Commons is this community' }));
        expect(within(card).getByRole('button', { name: /Yes, held\.example\.net/ })).toBeEnabled();
    });

    it('an older server that offers every address: none is one tap on this screen, and app counts are not shown as evidence beside a button', async () => {
        const { posts } = stubNode({ ...mockReport, unconfirmed: [{ address: 'forged.example.net', today: 40, busiestDay: 40 }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const yes = await screen.findByRole('button', { name: 'Yes, forged.example.net is its address' });
        expect(yes).toBeDisabled();
        fireEvent.click(yes);
        expect(posts).toHaveLength(0);
        expect(screen.queryByTestId('unconfirmed-offers')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    });

    it('a node with no named address is warned that it refuses addresses it does not know', async () => {
        stubNode({ ...mockReport, addresses: [], named: false, unboundSignaturesAccepted: true, unboundSignaturesUntil: '2026-12-15' });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        expect(await screen.findByTestId('app-addresses-none')).toHaveTextContent("After that it refuses addresses it doesn't know");
    });

    it('a double tap on Yes sends one confirm', async () => {
        let answer: (r: [number, unknown]) => void = () => {};
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
        const posts: string[] = [];
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
            const u = String(url);
            if (opts?.method === 'POST') {
                posts.push(u);
                const [, body] = await new Promise<[number, unknown]>((r) => { answer = r; });
                return json(body);
            }
            return u.includes('/app-addresses') ? json({ ...mockReport, heldBack: [held('not-this-page')] }) : json({ logs: [] });
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const yes = await screen.findByRole('button', { name: 'Yes, held.example.net is its address' });
        fireEvent.click(screen.getByRole('checkbox', { name: "This is this community's address" }));
        fireEvent.click(yes);
        fireEvent.click(yes);
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(yes).toBeDisabled();
        answer([200, mockReport]);
    });
});

describe('Addresses: what a row says (#2738)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('a lost name with members still on it: standing first, then the reach sentence, and never "Nothing to do"', async () => {
        stubNode({ ...mockReport, addresses: [mockReport.addresses[0], lostRow()] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const row = await screen.findByTestId('address-row-taken.beanpool.org');
        const standing = within(row).getByTestId('app-address-standing');
        const step = within(row).getByTestId('next-step-text');
        expect(standing).toHaveTextContent('another community holds taken.beanpool.org');
        expect(standing).toHaveTextContent('3 apps tried it today.');
        expect(standing).toHaveTextContent('Ask them to add this community again');
        expect(standing.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(step).toHaveTextContent("No longer this community's address.");
        expect(row.textContent).not.toMatch(/Nothing to do/);
    });

    it('a name still answering here while its hold runs out: the date first, and no "Nothing to do"', async () => {
        const row = lostRow({
            address: 'resting.beanpool.org', lost: false, tried: undefined,
            standing: { state: 'at-risk', registrarSays: 'released', releasedOn: '2026-09-20T00:00:00Z', acceptedUntil: '2026-12-20T00:00:00Z', leadsHere: true, lostSince: null, why: null, checkedAt },
            reach: { ...mockReport.addresses[0].reach },
        });
        stubNode({ ...mockReport, addresses: [mockReport.addresses[0], row] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const el = await screen.findByTestId('address-row-resting.beanpool.org');
        expect(within(el).getByTestId('app-address-standing')).toHaveTextContent(/held for this community until .+2026/);
        expect(within(el).getByTestId('next-step-text')).toHaveTextContent('Answers as this server.');
        expect(el.textContent).not.toMatch(/Nothing to do/);
    });

    it('a name with no standing still reads the full sentence, and a step this manager does not know reads as the node said it', async () => {
        const unknown = { ...mockReport.addresses[1], address: 'odd.example.org', reach: { ...mockReport.addresses[1].reach, step: 'some-new-step' as 'fine', nextStep: 'What a newer node says.' } };
        stubNode({ ...mockReport, addresses: [mockReport.addresses[0], unknown] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        expect(within(await screen.findByTestId('address-row-byron.beanpool.org')).getByTestId('next-step-text')).toHaveTextContent('Answers as this server. Nothing to do.');
        expect(within(screen.getByTestId('address-row-odd.example.org')).getByTestId('next-step-text')).toHaveTextContent('What a newer node says.');
    });

    it('apps and times go through the words layer', () => {
        expect(appsTodayText(1)).toBe('1 app today');
        expect(appsTodayText(14)).toBe('14 apps today');
        const now = Date.parse(checkedAt);
        expect(formatRelativeTime(checkedAt, now + 5_000)).toBe('just now');
        expect(formatRelativeTime(checkedAt, now + 3 * 60_000)).toBe('3 minutes ago');
        expect(formatRelativeTime(checkedAt, now + 2 * 3_600_000)).toBe('2 hours ago');
        expect(formatRelativeTime(null)).toBe('');
        expect(answersText({ ...mockReport.addresses[0].reach, checkedAt: new Date(Date.now() - 3 * 60_000).toISOString() })).toBe('answered as this server 3 minutes ago');
    });

    it('the row words a catalog carries are read from the core words, not typed in the panel', () => {
        for (const w of [ADDRESS_SCREEN_WORDS.badgeFormer, ADDRESS_SCREEN_WORDS.badgeLost, ADDRESS_SCREEN_WORDS.release, ADDRESS_SCREEN_WORDS.remove]) expect(typeof w).toBe('string');
        expect(ADDRESS_SCREEN_WORDS.badgeFormer).toBe('Former');
        expect(ADDRESS_SCREEN_WORDS.badgeLost).toBe('Lost');
    });

    it('stacks label above value at phone width, so an unbreakable word stays inside the card', async () => {
        stubNode(mockReport);
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const row = await screen.findByTestId('address-row-byron.beanpool.org');
        for (const id of ['address-points-at', 'address-answers']) {
            const line = within(row).getByTestId(id);
            expect(line.className).toMatch(/(^| )flex-col( |$)/);
            expect(line.className).toMatch(/sm:flex-row/);
            expect(line.children[0].className).not.toMatch(/(^| )shrink-0( |$)/);
            expect(line.children[1].className).toMatch(/min-w-0/);
            expect(line.children[1].className).toMatch(/\[overflow-wrap:anywhere\]/);
        }
    });

    it('the tunnel state is only said of the name it serves, and nothing is said before the node has answered', async () => {
        expect(tunnelStateOf('byron.beanpool.org', null)).toBeUndefined();
        expect(tunnelStateOf('byron.beanpool.org', LIVE)).toBe('connected');
        expect(tunnelStateOf('old.beanpool.org', LIVE)).toBeUndefined();
        expect(tunnelStateOf('old.beanpool.org', { ...LIVE, tunnel: { ...LIVE.tunnel, others: [{ host: 'old.beanpool.org', state: 'retrying' }] } })).toBe('retrying');
        stubNode(mockReport, { '/public-address/status': () => [200, LIVE] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        await screen.findByText("Cloudflare, then this server's tunnel (connected)");
        // The stopped and former names are not the tunnel's: DNS says what they point at.
        expect(screen.getByTestId('address-row-stopped.beanpool.org')).not.toHaveTextContent('(connected)');
        expect(screen.getByTestId('address-row-mullum.beanpool.org')).not.toHaveTextContent('(connected)');
        expect(pointsAtText('example.org', null)).toBe('not checked yet');
    });

    it('Check from your phone is a plain link, and is offered only where a phone could reach this server', async () => {
        const home = { ...mockReport.addresses[1], address: 'nas.lan', reach: { ...mockReport.addresses[1].reach, answers: null, step: 'home-network' as const } };
        const homeFromHere = { ...mockReport.addresses[1], address: 'split.example.org', reach: { ...mockReport.addresses[1].reach, answers: null, step: 'home-network-from-here' as const } };
        stubNode({ ...mockReport, addresses: [mockReport.addresses[0], lostRow(), home, homeFromHere] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const link = await screen.findByTestId('check-phone-link-byron.beanpool.org');
        expect(link).not.toHaveAttribute('role');
        expect(within(screen.getByTestId('address-row-byron.beanpool.org')).getByRole('link', { name: /Check from your phone/ })).toBe(link);
        expect(screen.queryByTestId('check-phone-link-taken.beanpool.org')).toBeNull();
        expect(screen.queryByTestId('check-phone-link-nas.lan')).toBeNull();
        // Its next step sends the owner to this link, so it stays.
        expect(screen.getByTestId('check-phone-link-split.example.org')).toBeInTheDocument();
    });
});

describe('Addresses: Check now says only what came back (#2738)', () => {
    beforeEach(() => vi.restoreAllMocks());

    const pressCheck = async (answer: unknown) => {
        stubNode(mockReport, { '/app-addresses/check': () => [200, answer] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        await screen.findByTestId('address-row-byron.beanpool.org');
        fireEvent.click(screen.getByTestId('addresses-check-now-btn'));
        return screen.findByTestId('addresses-action-message');
    };

    it('a round still running: says so, and never that it checked', async () => {
        const msg = await pressCheck({ ...mockReport, checking: true });
        expect(msg).toHaveTextContent('Still checking, press again in a moment.');
        expect(screen.queryByText(/Addresses checked from outside/)).toBeNull();
        expect(screen.getByTestId('addresses-last-checked')).toHaveTextContent(formatTime(checkedAt));
    });

    it('the old report, returned inside the 30-second gap: says when that check was, never a new one', async () => {
        const msg = await pressCheck({ ...mockReport, checking: false });
        expect(msg).toHaveTextContent(`Already checked at ${formatTime(checkedAt)}.`);
        expect(screen.queryByText(/Addresses checked from outside/)).toBeNull();
    });

    it("a new round: reports it, with the rows' own time and never this browser's clock", async () => {
        vi.setSystemTime?.(new Date('2031-01-01T00:00:00Z'));
        const msg = await pressCheck({ ...rowsAt(later), checking: false });
        expect(msg).toHaveTextContent('Addresses checked from outside.');
        expect(screen.getByTestId('addresses-last-checked')).toHaveTextContent(`Checked from this server at ${formatTime(later)}`);
        vi.useRealTimers();
    });

    it('a server that checks nothing (a standby): no success, and no time', async () => {
        const bare = { ...mockReport, addresses: mockReport.addresses.map(({ reach: _reach, ...a }) => a) };
        stubNode(bare, { '/app-addresses/check': () => [200, { ...bare, checking: false }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        await screen.findByTestId('address-row-byron.beanpool.org');
        fireEvent.click(screen.getByTestId('addresses-check-now-btn'));
        expect(await screen.findByTestId('addresses-action-message')).toHaveTextContent('Nothing could be checked from this server yet.');
        expect(screen.queryByTestId('addresses-last-checked')).toBeNull();
    });
});

describe('Addresses: Make main and Add an address (#2738)', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('Make main on a name sends the name alone, so the claim keeps what the server holds', async () => {
        const { posts } = stubNode(mockReport, { '/public-address/claim': () => [200, { success: true, status: 'live' }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-mullum.beanpool.org'));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].body).toEqual({ password: 'test-password', name: 'mullum', mode: 'tunnel' });
        expect(await screen.findByText('mullum.beanpool.org is now the main address.')).toBeInTheDocument();
    });

    it('Make main never says main for an answer that is not live', async () => {
        stubNode(mockReport, { '/public-address/claim': () => [200, { success: true, status: 'paused' }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-mullum.beanpool.org'));
        expect(await screen.findByText('mullum.beanpool.org is not the main address: the address service says paused.')).toBeInTheDocument();
        expect(screen.queryByText(/is now the main address/)).toBeNull();
    });

    it('offers Make main only where the server can do it', async () => {
        expect(canBecomeMain('other.beanpool.org', 'byron.beanpool.org')).toBe(true);
        expect(canBecomeMain('203.0.113.5', 'byron.beanpool.org')).toBe(false);
        expect(canBecomeMain('beans.example.org', 'byron.beanpool.org')).toBe(false);
        expect(canBecomeMain('203.0.113.5', 'beans.example.org')).toBe(false);
        expect(canBecomeMain('beans.example.org', '203.0.113.5')).toBe(true);
        expect(canBecomeMain('coop.example.net', 'beans.example.org')).toBe(true);
        expect(canBecomeMain('203.0.113.9', '203.0.113.5')).toBe(true);
        expect(canBecomeMain('203.0.113.5', null)).toBe(true);
    });

    it('a double tap on Make main or Remove sends one request, and every row waits while it runs', async () => {
        const posts: string[] = [];
        let finish: () => void = () => {};
        const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
        vi.spyOn(global, 'fetch').mockImplementation(async (url, opts) => {
            const u = String(url);
            if (opts?.method === 'POST') {
                posts.push(u);
                await new Promise<void>((r) => { finish = r; });
                return json({ success: true, status: 'live' });
            }
            return u.includes('/app-addresses') ? json(mockReport) : json({ logs: [] });
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const makeMain = await screen.findByTestId('make-main-btn-mullum.beanpool.org');
        fireEvent.click(makeMain);
        fireEvent.click(makeMain);
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(makeMain).toBeDisabled();
        expect(screen.getByTestId('remove-release-btn-203.0.113.5')).toBeDisabled();
        fireEvent.click(screen.getByTestId('remove-release-btn-203.0.113.5'));
        await new Promise((r) => setTimeout(r, 10));
        expect(posts).toHaveLength(1);
        finish();
        await waitFor(() => expect(makeMain).toBeEnabled());
    });

    it('Release says the name goes back to the pool, and whether it still works', async () => {
        const { posts } = stubNode(mockReport);
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('remove-release-btn-mullum.beanpool.org'));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Release an address that still works');
        expect(dialog).toHaveTextContent('Phones still using this address lose the community.');
        expect(dialog).toHaveTextContent("Your community's address stays byron.beanpool.org.");
        expect(dialog).toHaveTextContent("Another community can claim mullum.beanpool.org once the address service's hold ends.");
        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }));
        await new Promise((r) => setTimeout(r, 10));
        expect(posts).toHaveLength(0);
    });

    it('Release of a name nobody uses says so, and still that another community can have it', async () => {
        const unused = { ...mockReport.addresses[6], address: 'quiet.beanpool.org', today: 0, busiestDay: 0 };
        stubNode({ ...mockReport, addresses: [mockReport.addresses[0], unused] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('remove-release-btn-quiet.beanpool.org'));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Release a name this community does not use');
        expect(dialog).not.toHaveTextContent('Phones still using');
        expect(dialog).toHaveTextContent("Another community can claim quiet.beanpool.org once the address service's hold ends.");
    });

    it('the own address that is the main one can still be removed; a main BeanPool name cannot', async () => {
        const own = { ...mockReport.addresses[1], address: 'proxy.example.org' };
        stubNode({ ...mockReport, primaryAddress: 'proxy.example.org', addresses: [own] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('remove-release-btn-proxy.example.org'));
        expect(await screen.findByRole('alertdialog')).toHaveTextContent("It is this community's address.");
    });

    it('a result is brought into view, and a failure is an alert', async () => {
        const scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        stubNode(mockReport, { '/public-address/claim': () => [500, { error: 'The address service failed.' }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('make-main-btn-mullum.beanpool.org'));
        expect(await screen.findByRole('alert')).toHaveTextContent('The address service failed.');
        expect(scroll).toHaveBeenCalled();
        delete (Element.prototype as Partial<Element>).scrollIntoView;
    });

    it('Add an address carries everything the claim form had (moved from PublicAddressPanel)', async () => {
        stubNode(mockReport, { '/public-address/status': () => [200, { status: 'none' }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('addresses-add-address-btn'));
        // Claim form fields
        expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Community \/ Pool Name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Reachability Mode/i)).toBeInTheDocument();
        // Settings offers a tunnel only: a direct name needs the server's public IPv4 address, which it can't know (SEC-REG-01).
        expect(screen.getByLabelText(/Reachability Mode/i)).toHaveTextContent('Tunnel');
        expect(screen.queryByRole('option', { name: /Direct/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/Direct/)).not.toBeInTheDocument();
        expect(screen.getByText('https://cairns.beanpool.org')).toBeInTheDocument();
        expect(screen.getByLabelText(/Operator Contact/i)).toBeInTheDocument();
    });

    it('the address service has no record of the kept name: the claim form stays (moved from PublicAddressPanel)', async () => {
        stubNode(mockReport, { '/public-address/status': () => [200, { success: true, status: 'none', kept: { hostname: 'cairns.beanpool.org', mode: 'tunnel' } }] });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        expect(await screen.findByTestId('public-address-kept')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('addresses-add-address-btn'));
        expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();
    });

    it('submits a new public address claim with sanitized subdomain and mode (moved from PublicAddressPanel)', async () => {
        const { posts } = stubNode(mockReport, {
            '/public-address/status': () => [200, { status: 'none' }],
            '/public-address/claim': () => [200, { success: true, status: 'live', hostname: 'byron.beanpool.org', tunnelToken: 'new-token-123' }],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('addresses-add-address-btn'));
        const subdomainInput = screen.getByLabelText(/Subdomain Prefix/i);
        fireEvent.change(subdomainInput, { target: { value: 'Byron-Bay' } });
        // Preview updates automatically
        expect(screen.getByText('https://byron-bay.beanpool.org')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Go public · Claim Web Address/i }));
        await waitFor(() => {
            expect(posts).toHaveLength(1);
            expect(posts[0].body.name).toBe('byron-bay');
            expect(posts[0].body.mode).toBe('tunnel');
            expect(posts[0].body.password).toBe('test-password');
        });
    });

    it('a name pasted whole or typed wrong is cleaned, or refused before anything is sent', async () => {
        expect(cleanSubdomain('https://Byron-Bay.beanpool.org/settings')).toBe('byron-bay');
        expect(cleanSubdomain(' My Name ')).toBe('myname');
        const { posts } = stubNode(mockReport);
        render(<AddressesPanel activeNode={mockActiveNode} />);
        fireEvent.click(await screen.findByTestId('addresses-add-address-btn'));
        fireEvent.change(screen.getByLabelText(/Subdomain Prefix/i), { target: { value: 'ab' } });
        fireEvent.submit(screen.getByTestId('claim-form'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Invalid name');
        expect(posts).toHaveLength(0);
    });

    it('the form shows what the server holds, and a claim from it keeps or changes that', async () => {
        const { posts } = stubNode(mockReport, {
            '/public-address/status': () => [200, { ...LIVE, contact: 'held@example.org', community_name: 'Byron Shire' }],
            '/public-address/claim': () => [200, { success: true, status: 'pending' }],
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        await screen.findByRole('button', { name: /Take offline/ });
        fireEvent.click(screen.getByTestId('addresses-add-address-btn'));
        expect(screen.getByLabelText(/Operator Contact/i)).toHaveValue('held@example.org');
        expect(screen.getByLabelText(/Community \/ Pool Name/i)).toHaveValue('Byron Shire');
        fireEvent.change(screen.getByLabelText(/Subdomain Prefix/i), { target: { value: 'newbyron' } });
        fireEvent.click(screen.getByRole('button', { name: /Go public/ }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].body).toMatchObject({ name: 'newbyron', contact: 'held@example.org', communityName: 'Byron Shire' });
        // Pending is not live: no success words.
        expect(await screen.findByTestId('addresses-action-message')).toHaveTextContent('Claimed: awaiting registrar approval');
    });

    it('the ✕ in Add an address has a name and a 44 px target; choices and the toggle say their state', async () => {
        stubNode(mockReport);
        render(<AddressesPanel activeNode={mockActiveNode} />);
        const toggle = await screen.findByTestId('addresses-add-address-btn');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const close = screen.getByRole('button', { name: 'Close Add an address' });
        expect(close.className).toMatch(/min-h-\[44px\]/);
        expect(close.className).toMatch(/min-w-\[44px\]/);
        expect(screen.getByRole('button', { name: 'a free BeanPool name' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: "this server's number" })).toHaveAttribute('aria-pressed', 'false');
        for (const b of screen.getByTestId('add-address-section').querySelectorAll('button')) expect(b.className).toMatch(/min-h-\[44px\]/);
    });

    it('an admin is not told to press a button they do not have; a first read says it is reading; a failed one offers Try again', async () => {
        stubNode({ ...mockReport, addresses: [] });
        const admin = { kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' } as const;
        const { unmount } = render(<AddressesPanel activeNode={mockActiveNode} viewer={admin} />);
        expect(await screen.findByText('No addresses configured yet.')).toBeInTheDocument();
        unmount();
        let healed = false;
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
            if (String(url).includes('/app-addresses')) return healed ? json(200, mockReport) : json(500, { error: 'nope' });
            return json(200, { logs: [] });
        });
        render(<AddressesPanel activeNode={mockActiveNode} />);
        expect(screen.getByTestId('addresses-loading')).toHaveTextContent('Reading addresses…');
        const retry = await screen.findByTestId('addresses-retry');
        healed = true;
        fireEvent.click(retry);
        expect(await screen.findByTestId('address-row-byron.beanpool.org')).toBeInTheDocument();
    });
});
