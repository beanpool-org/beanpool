import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublicAddressPanel, ownCertificateLine } from './PublicAddressPanel';
import type { NodeProfile } from '../../lib/profiles';

const mockActiveNode: NodeProfile = {
    id: 'local-node',
    name: 'Mullumbimby Node',
    url: 'http://localhost:8080',
    adminPassword: 'test-password',
};

describe('PublicAddressPanel Component', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('an admin, who is not shown the tunnel token, is told only an owner can see it', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const body = String(url).includes('/api/local/admin/public-address/status')
                ? { success: true, status: 'live', name: 'cairns', hostname: 'cairns.beanpool.org', mode: 'tunnel', tunnelTokenOwnerOnly: true }
                : { success: true, logs: [] };
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText('cairns.beanpool.org')).toBeInTheDocument();
        });
        expect(screen.getByTestId('public-address-token-owner-only')).toHaveTextContent('Only an owner can see the tunnel token.');
        expect(screen.queryByLabelText(/Tunnel Token/i)).not.toBeInTheDocument();
    });

    it('renders with a real payload (status live, tunnel token, and live logs)', async () => {
        const realPayload = {
            success: true,
            status: 'live',
            name: 'cairns',
            hostname: 'cairns.beanpool.org',
            mode: 'tunnel',
            tunnelToken: 'cf-tunnel-token-secret-xyz-12345',
            cached: false,
        };

        const realLogs = {
            success: true,
            logs: [
                { timestamp: '12:00:01', step: '1/4', message: 'Requesting tunnel allocation', type: 'info' },
                { timestamp: '12:00:02', step: '2/4', message: 'Writing tunnel token', type: 'info' },
                { timestamp: '12:00:03', step: '3/4', message: 'Sidecar restarted', type: 'success' },
                { timestamp: '12:00:04', step: '4/4', message: 'Probe: Confirmed LIVE!', type: 'success' },
            ],
        };

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(realPayload),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/logs')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(realLogs),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        // Live badge and hostname
        await waitFor(() => {
            expect(screen.getByText('Live')).toBeInTheDocument();
            expect(screen.getByText('cairns.beanpool.org')).toBeInTheDocument();
        });

        // Mode badge
        expect(screen.getByText('(🛡️ tunnel)')).toBeInTheDocument();

        // Tunnel Token input
        const tokenInput = screen.getByLabelText(/Tunnel Token/i) as HTMLInputElement;
        expect(tokenInput).toBeInTheDocument();
        expect(tokenInput.type).toBe('password');
        expect(tokenInput.value).toBe('cf-tunnel-token-secret-xyz-12345');

        // Reveal token eye button
        const revealBtn = screen.getByRole('button', { name: /👁️ Reveal/i });
        fireEvent.click(revealBtn);
        expect(tokenInput.type).toBe('text');
        expect(screen.getByRole('button', { name: /🙈 Hide/i })).toBeInTheDocument();

        // Logs terminal
        expect(screen.getByText(/Confirmed LIVE!/i)).toBeInTheDocument();
        expect(screen.getByText('Step 4/4')).toBeInTheDocument();

        // Operational buttons
        expect(screen.getByRole('button', { name: /Restart tunnel/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Take offline/i })).toBeInTheDocument();
    });

    it('renders with an empty payload without crashing and shows the claim form', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ status: 'none' }),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/logs')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ logs: [] }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText(/No public address currently assigned/i)).toBeInTheDocument();
        });

        // Claim form fields
        expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Community \/ Pool Name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/Reachability Mode/i)).toBeInTheDocument();
        // Settings offers a tunnel only: a direct name needs the server's public IPv4 address, which it can't know (SEC-REG-01).
        expect(screen.getByLabelText(/Reachability Mode/i)).toHaveTextContent('Tunnel');
        expect(screen.queryByRole('option', { name: /Direct/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/Direct/)).not.toBeInTheDocument();
        expect(screen.getByText('https://cairns.beanpool.org')).toBeInTheDocument();
    });

    it('says the address service has no record, and names the address this server keeps', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true, status: 'none', kept: { hostname: 'cairns.beanpool.org', mode: 'tunnel' } }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText(/The address service has no record of this community's name/i)).toBeInTheDocument();
        });
        expect(screen.getByTestId('public-address-kept')).toHaveTextContent(/This server keeps cairns\.beanpool\.org, and members' apps that use it are still accepted/);
        expect(screen.queryByText(/No public address currently assigned/i)).not.toBeInTheDocument();
        // Nothing to release at the address service, and the claim form stays.
        expect(screen.queryByRole('button', { name: /Take offline/i })).not.toBeInTheDocument();
        expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();
    });

    it('renders safely with wrong-typed fields without crashing', async () => {
        const malformedPayload = {
            status: 9999, // Should be string
            name: { complex: true }, // Should be string
            hostname: false, // Should be string
            mode: 42, // Should be string
            tunnelToken: 1234567, // Should be string
            logs: 'not-an-array', // Should be array
        };

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(malformedPayload),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/logs')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(malformedPayload),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('public-address-panel')).toBeInTheDocument();
        });

        // Does not throw and terminal exists
        expect(screen.getByTestId('propagation-monitor-terminal')).toBeInTheDocument();
    });

    it('submits a new public address claim with sanitized subdomain and mode', async () => {
        let postBody: any = null;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/claim') && opts?.method === 'POST') {
                postBody = JSON.parse(String(opts?.body));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        success: true,
                        status: 'live',
                        hostname: 'byron.beanpool.org',
                        tunnelToken: 'new-token-123',
                    }),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ status: 'none' }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByLabelText(/Subdomain Prefix/i)).toBeInTheDocument();
        });

        const subdomainInput = screen.getByLabelText(/Subdomain Prefix/i);
        fireEvent.change(subdomainInput, { target: { value: 'Byron-Bay' } });

        // Preview updates automatically
        expect(screen.getByText('https://byron-bay.beanpool.org')).toBeInTheDocument();

        const submitBtn = screen.getByRole('button', { name: /Go public · Claim Web Address/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(postBody).not.toBeNull();
            expect(postBody.name).toBe('byron-bay');
            expect(postBody.mode).toBe('tunnel');
            expect(postBody.password).toBe('test-password');
        });
    });

    it('requires confirmation step before restarting the tunnel inside the server', async () => {
        let restartCalled = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/restart-tunnel') && opts?.method === 'POST') {
                restartCalled = true;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true }),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'live',
                        hostname: 'cairns.beanpool.org',
                        mode: 'tunnel',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Restart tunnel/i })).toBeInTheDocument();
        });

        // Click Restart tunnel
        fireEvent.click(screen.getByRole('button', { name: /Restart tunnel/i }));

        // Confirmation modal appears
        expect(screen.getByText('Restart the tunnel')).toBeInTheDocument();
        expect(screen.getByText(/Restart the Cloudflare tunnel inside this server\?/i)).toBeInTheDocument();
        expect(restartCalled).toBe(false);

        // Click Confirm inside modal
        const confirmBtn = screen.getByRole('button', { name: 'Restart now' });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
            expect(restartCalled).toBe(true);
        });
        expect(screen.queryByText(/sidecar/i)).not.toBeInTheDocument();
    });

    const statusOnly = (payload: Record<string, unknown>) =>
        vi.spyOn(global, 'fetch').mockImplementation((url) => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(String(url).includes('/public-address/status') ? payload : { logs: [] }),
        } as Response));

    it('shows the tunnel inside the server as it really is: connected, or retrying and why', async () => {
        statusOnly({
            status: 'live', hostname: 'cairns.beanpool.org', mode: 'tunnel',
            tunnel: { state: 'connected', since: '2026-09-28T10:00:00Z', connections: 4, reason: null, version: '2026.9.3' },
        });
        const { unmount } = render(<PublicAddressPanel activeNode={mockActiveNode} />);
        await waitFor(() => {
            expect(screen.getByTestId('public-address-tunnel')).toHaveTextContent('Tunnel: connected (4)');
        });
        unmount();

        vi.restoreAllMocks();
        statusOnly({
            status: 'live', hostname: 'cairns.beanpool.org', mode: 'tunnel',
            tunnel: { state: 'retrying', since: '2026-09-28T10:02:00Z', connections: 0, reason: 'Unauthorized: Tunnel not found' },
        });
        render(<PublicAddressPanel activeNode={mockActiveNode} />);
        await waitFor(() => {
            expect(screen.getByTestId('public-address-tunnel')).toHaveTextContent(/Tunnel: retrying: Unauthorized: Tunnel not found since/);
        });
        expect(screen.queryByTestId('docker-socket-warning')).not.toBeInTheDocument();
    });

    it('warns when docker-compose.yml still mounts Docker\'s control socket', async () => {
        statusOnly({ status: 'none', dockerSocket: true, tunnel: { state: 'off', connections: 0, reason: null } });
        render(<PublicAddressPanel activeNode={mockActiveNode} />);
        await waitFor(() => {
            expect(screen.getByTestId('docker-socket-warning')).toHaveTextContent(/still mounts Docker's control socket/);
        });
        expect(screen.getByTestId('docker-socket-warning')).toHaveTextContent(/controls the whole machine/);
    });

    it('requires confirmation step before taking the node offline', async () => {
        let offlineCalled = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/offline') && opts?.method === 'POST') {
                offlineCalled = true;
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ success: true, status: 'none' }),
                } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'live',
                        hostname: 'cairns.beanpool.org',
                        mode: 'tunnel',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Take offline/i })).toBeInTheDocument();
        });

        // Click Take offline
        fireEvent.click(screen.getByRole('button', { name: /Take offline/i }));

        // Confirmation modal appears
        expect(screen.getByRole('heading', { name: 'Take Node Offline' })).toBeInTheDocument();
        expect(screen.getByText(/Release public address/i)).toBeInTheDocument();
        expect(offlineCalled).toBe(false);

        // Confirm take offline
        const confirmBtn = screen.getByRole('button', { name: 'Take Offline' });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
            expect(offlineCalled).toBe(true);
        });
    });

    it('copies tunnel token to clipboard', async () => {
        const writeTextMock = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, {
            clipboard: {
                writeText: writeTextMock,
            },
        });

        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'live',
                        hostname: 'cairns.beanpool.org',
                        mode: 'tunnel',
                        tunnelToken: 'secret-token-to-copy',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /📋 Copy/i })).toBeInTheDocument();
        });

        fireEvent.click(screen.getByRole('button', { name: /📋 Copy/i }));

        await waitFor(() => {
            expect(writeTextMock).toHaveBeenCalledWith('secret-token-to-copy');
            expect(screen.getByText('✓ Copied')).toBeInTheDocument();
        });
    });

    it('has security attributes on tunnel token input to prevent password manager autofill', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'live',
                        hostname: 'cairns.beanpool.org',
                        mode: 'tunnel',
                        tunnelToken: 'cf-tunnel-token-secret-xyz-12345',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByLabelText(/Tunnel Token/i)).toBeInTheDocument();
        });

        const tokenInput = screen.getByLabelText(/Tunnel Token/i) as HTMLInputElement;
        expect(tokenInput.getAttribute('autocomplete')).toBe('off');
        expect(tokenInput.getAttribute('data-lpignore')).toBe('true');
        expect(tokenInput.getAttribute('data-1p-ignore')).toBe('true');
        expect(tokenInput.getAttribute('spellcheck')).toBe('false');
    });

    it('dismisses confirmation modal on Escape key press and backdrop click', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'live',
                        hostname: 'cairns.beanpool.org',
                        mode: 'tunnel',
                        tunnelToken: 'token-abc',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Restart tunnel/i })).toBeInTheDocument();
        });

        // Open modal
        fireEvent.click(screen.getByRole('button', { name: /Restart tunnel/i }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Dismiss via Escape key
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        // Open modal again
        fireEvent.click(screen.getByRole('button', { name: /Restart tunnel/i }));
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();

        // Dismiss via backdrop click
        fireEvent.click(dialog);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('applies flex-wrap and break-all to pending domain status to prevent mobile overflow', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        status: 'pending',
                        name: 'long-community-subdomain-overflow-test',
                    }),
                } as Response);
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByText(/Awaiting registrar approval for/i)).toBeInTheDocument();
        });

        const pendingContainer = screen.getByText(/Awaiting registrar approval for/i).closest('div');
        expect(pendingContainer?.className).toContain('flex-wrap');

        const domainSpan = pendingContainer?.querySelector('.break-all');
        expect(domainSpan).not.toBeNull();
        expect(domainSpan?.textContent).toBe('long-community-subdomain-overflow-test.beanpool.org');
    });

    // M3 of the 2026-10-01 registrar review: the registrar pauses a name another server answers at, and this server
    // takes it back by itself. Until then a paused status read as "Couldn't reach the registrar".
    it('a name the address service paused says so, why, and that this server takes it back by itself', async () => {
        const pausedPayload = (reason: string) => ({ success: true, status: 'paused', name: 'cairns', hostname: 'cairns.beanpool.org', mode: 'tunnel', reason, since: 1790000000 });
        vi.spyOn(global, 'fetch').mockImplementation((url) => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(String(url).includes('/public-address/status') ? pausedPayload('content-swap') : { logs: [] }),
        } as Response));
        const { unmount } = render(<PublicAddressPanel activeNode={mockActiveNode} />);
        const card = await screen.findByTestId('public-address-paused');
        expect(card.textContent).toContain('Paused');
        expect(card.textContent).toContain('cairns.beanpool.org');
        expect(card.textContent).toMatch(/something that is not a BeanPool server answered at this address/);
        expect(card.textContent).toMatch(/asks for it back by itself/);
        expect(card.textContent).toMatch(/nobody else can claim it/);
        expect(screen.queryByText(/Couldn.t reach the registrar/i)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /New tunnel key/i })).not.toBeInTheDocument();
        unmount();

        vi.restoreAllMocks();
        vi.spyOn(global, 'fetch').mockImplementation((url) => Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(String(url).includes('/public-address/status') ? pausedPayload('admin') : { logs: [] }),
        } as Response));
        render(<PublicAddressPanel activeNode={mockActiveNode} />);
        const admin = await screen.findByTestId('public-address-paused');
        expect(admin.textContent).toMatch(/the BeanPool project paused it/);
        expect(admin.textContent).toMatch(/until the BeanPool project lifts the pause/);
        expect(admin.textContent).not.toMatch(/asks for it back by itself/);
    });

    // #2143 item 1: the node answers 200 whether or not the address service could be reached, and says so in one line.
    describe('the address service out of reach', () => {
        const LINE = "The BeanPool name service can't be reached right now.";
        const serve = (status: Record<string, unknown>) => {
            const asked: string[] = [];
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                asked.push(String(url));
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(String(url).includes('/public-address/status') ? status : { logs: [] }),
                } as Response);
            });
            return () => asked.filter((u) => u.includes('/public-address/status')).length;
        };

        it('a stored name: shown as the node keeps it, with one calm line and nothing in red, asked once', async () => {
            const statusReads = serve({ success: true, status: 'live', name: 'cairns', hostname: 'cairns.beanpool.org', mode: 'tunnel', cached: true, nameServiceNote: LINE });
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByText('cairns.beanpool.org')).toBeInTheDocument();
            const note = screen.getByTestId('public-address-name-service');
            expect(note).toHaveTextContent(LINE);
            expect(note.className).not.toMatch(/red/);
            expect(note).not.toHaveAttribute('role', 'alert');
            expect(screen.queryByText(/Couldn.t (reach|refresh)/i)).not.toBeInTheDocument();
            expect(statusReads()).toBe(1);
        });

        it('no address and nothing to ask: "No public address", and no line about the name service', async () => {
            serve({ success: true, status: 'none' });
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByText(/No public address currently assigned/)).toBeInTheDocument();
            expect(screen.queryByTestId('public-address-name-service')).not.toBeInTheDocument();
            expect(screen.queryByText(/Couldn.t reach the registrar/i)).not.toBeInTheDocument();
        });

        it('an own address: this server\'s own, its certificate, and no Take offline (the server refuses it for one)', async () => {
            serve({ success: true, status: 'live', hostname: '203.0.113.5', mode: 'ip', tls: { certificate: null, nextRenewalAt: null, lastError: 'the CA could not reach port 80' } });
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByText("(this server's own address)")).toBeInTheDocument();
            expect(screen.getByText('203.0.113.5')).toBeInTheDocument();
            expect(screen.getByTestId('public-address-own-certificate')).toHaveTextContent('No certificate yet. The last try failed: the CA could not reach port 80');
            expect(screen.queryByText('(🌐 direct)')).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /Take offline/i })).not.toBeInTheDocument();
        });

        // PR #2158 review 4307110322: the server's own fault after the address service answered is 200 with what it holds
        // and `error`; until then only a live name showed it.
        it('the server failing to act on an answer: its error shown with no address, and with an own address', async () => {
            serve({ success: true, status: 'none', error: 'database or disk is full' });
            const { unmount } = render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByText(/No public address currently assigned/)).toBeInTheDocument();
            expect(screen.getByTestId('public-address-server-error')).toHaveTextContent("This server couldn't act on the address service's answer — database or disk is full");
            unmount();

            vi.restoreAllMocks();
            serve({ success: true, status: 'live', hostname: '203.0.113.5', mode: 'ip', error: 'database or disk is full' });
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByText("(this server's own address)")).toBeInTheDocument();
            expect(screen.getByTestId('public-address-server-error')).toHaveTextContent('database or disk is full');
            expect(screen.queryByText(/Couldn.t (reach|refresh)/i)).not.toBeInTheDocument();
        });

        it('an own address with a certificate says until when it is valid', () => {
            expect(ownCertificateLine({ certificate: { issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-12-30T00:00:00.000Z' } })).toMatch(/^Certificate valid until .*2026/);
            expect(ownCertificateLine({ certificate: null })).toBe('No certificate yet: the server is asking for one.');
            expect(ownCertificateLine(null)).toBeNull();
        });
    });

    it('New tunnel key: confirmed first, then the node rotates the name onto a fresh tunnel; offered only for a live tunnel name', async () => {
        let rotateCalls = 0;
        let mode = 'tunnel';
        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/rotate') && opts?.method === 'POST') {
                rotateCalls++;
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, status: 'live' }) } as Response);
            }
            if (strUrl.includes('/api/local/admin/public-address/status')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ status: 'live', hostname: 'cairns.beanpool.org', mode }) } as Response);
            }
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ logs: [] }) } as Response);
        });

        const { unmount } = render(<PublicAddressPanel activeNode={mockActiveNode} />);
        const button = await screen.findByRole('button', { name: /New tunnel key/i });
        fireEvent.click(button);
        expect(screen.getByText('Give the tunnel a new key')).toBeInTheDocument();
        // Honest about its limit: it does not lock out a copied data folder or backup.
        expect(screen.getByText(/does NOT protect you from a copy of this server’s data folder or a backup/)).toBeInTheDocument();
        expect(screen.queryByText(/nobody can use a copy/)).not.toBeInTheDocument();
        expect(screen.getByText(/the old key stops working at once/i)).toBeInTheDocument();
        expect(rotateCalls).toBe(0);
        fireEvent.click(screen.getByRole('button', { name: 'New key now' }));
        await waitFor(() => expect(rotateCalls).toBe(1));
        expect(await screen.findByText(/New tunnel key: the old one no longer works/i)).toBeInTheDocument();
        unmount();

        // A direct name runs no tunnel: no key to replace.
        mode = 'direct';
        render(<PublicAddressPanel activeNode={mockActiveNode} />);
        await screen.findByText('Live');
        expect(screen.queryByRole('button', { name: /New tunnel key/i })).not.toBeInTheDocument();
    });

    it('sets role="log", aria-live="polite", and aria-atomic="false" on propagation monitor terminal', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(() => {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ status: 'none', logs: [] }),
            } as Response);
        });

        render(<PublicAddressPanel activeNode={mockActiveNode} />);

        await waitFor(() => {
            expect(screen.getByTestId('propagation-monitor-terminal')).toBeInTheDocument();
        });

        const terminal = screen.getByTestId('propagation-monitor-terminal');
        expect(terminal.getAttribute('role')).toBe('log');
        expect(terminal.getAttribute('aria-live')).toBe('polite');
        expect(terminal.getAttribute('aria-atomic')).toBe('false');
    });
    describe('a name the key holds besides the address', () => {
        const mockNames = (names: () => unknown, extraStatus = 200) => {
            const calls: { url: string; body: any }[] = [];
            vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
                const u = String(url);
                calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
                let status = 200;
                let body: unknown = { success: true, logs: [] };
                if (u.includes('/public-address/status')) body = { success: true, status: 'live', name: 'owner-pick', hostname: 'owner-pick.beanpool.org', mode: 'tunnel' };
                else if (u.includes('/public-address/extra-names')) { status = extraStatus; body = extraStatus === 200 ? { success: true, names: names() } : { error: 'Only an owner of this node can change its public address' }; }
                else if (u.includes('/public-address/release-name')) body = { success: true, name: 'install-race', status: 'released' };
                return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) } as Response);
            });
            return calls;
        };

        it('shows an owner one line for the install\'s late name, and Release releases it by name', async () => {
            let held = [{ name: 'install-race', hostname: 'install-race.beanpool.org', state: 'live', releasable: true, fromInstall: true }];
            const calls = mockNames(() => held);
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            const line = await screen.findByTestId('extra-name');
            expect(line).toHaveTextContent('This community also holds install-race.beanpool.org from the install; it is not used. Release it?');
            held = [];
            fireEvent.click(screen.getByRole('button', { name: 'Release' }));
            // It asks first, as Take offline does, and says the address stays (#1583 review r4176052081).
            const dialog = await screen.findByRole('dialog');
            expect(dialog).toHaveTextContent("Release install-race.beanpool.org? Your community's address stays owner-pick.beanpool.org.");
            expect(calls.some((c) => c.url.includes('/public-address/release-name'))).toBe(false);
            fireEvent.click(screen.getByRole('button', { name: 'Release it' }));
            await waitFor(() => expect(screen.queryByTestId('extra-name')).not.toBeInTheDocument());
            const rel = calls.filter((c) => c.url.includes('/public-address/release-name'));
            expect(rel).toHaveLength(1);
            expect(rel[0].body?.name).toBe('install-race');
            expect(calls.some((c) => c.url.includes('/public-address/offline'))).toBe(false);
            expect(screen.getByText(/install-race\.beanpool\.org released\. This community's address is unchanged\./)).toBeInTheDocument();
        });

        it('Cancel releases nothing; the line\'s text keeps a readable width, the button wraps under it', async () => {
            const calls = mockNames(() => [{ name: 'install-race', hostname: 'install-race.beanpool.org', state: 'live', releasable: true, fromInstall: true }]);
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            const line = await screen.findByTestId('extra-name');
            expect(line.querySelector('span')?.className).toMatch(/basis-\[12rem\]/);
            fireEvent.click(screen.getByRole('button', { name: 'Release' }));
            await screen.findByRole('dialog');
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
            expect(calls.some((c) => c.url.includes('/public-address/release-name'))).toBe(false);
            expect(screen.getByTestId('extra-name')).toBeInTheDocument();
        });

        it('an older address service that cannot release by name: the line only, no button', async () => {
            mockNames(() => [{ name: 'install-race', hostname: 'install-race.beanpool.org', state: null, releasable: false, fromInstall: true }]);
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            const line = await screen.findByTestId('extra-name');
            expect(line).toHaveTextContent('This community also holds install-race.beanpool.org from the install; it is not used.');
            expect(line).not.toHaveTextContent('Release it?');
            expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
        });

        describe.each(['dark', 'light'])('a live name the community moved off, in %s', (theme) => {
            const moved = { name: 'oldvale', hostname: 'oldvale.beanpool.org', state: 'live', releasable: true, fromInstall: false };
            beforeEach(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); });
            afterEach(() => { document.documentElement.classList.remove('dark'); });

            it('says phones still using it lose the community, and never that it is not used', async () => {
                const calls = mockNames(() => [moved]);
                render(<PublicAddressPanel activeNode={mockActiveNode} />);
                const line = await screen.findByTestId('extra-name');
                expect(line).toHaveTextContent('This community also holds oldvale.beanpool.org. It still works: phones still using this address lose the community if you release it.');
                expect(line).not.toHaveTextContent('not used');
                expect(line).not.toHaveTextContent('from the install');
                fireEvent.click(screen.getByRole('button', { name: 'Release' }));
                const dialog = await screen.findByRole('dialog');
                expect(dialog).toHaveTextContent('Release an address that still works');
                expect(dialog).toHaveTextContent("Release oldvale.beanpool.org? Phones still using this address lose the community. Your community's address stays owner-pick.beanpool.org.");
                expect(dialog).not.toHaveTextContent('does not use');
                expect(calls.some((c) => c.url.includes('/public-address/release-name'))).toBe(false);
                fireEvent.click(screen.getByRole('button', { name: 'Release it' }));
                await waitFor(() => expect(calls.filter((c) => c.url.includes('/public-address/release-name')).map((c) => c.body?.name)).toEqual(['oldvale']));
            });
        });

        it('a name that only waited, never live here, stays not used', async () => {
            mockNames(() => [{ name: 'waited', hostname: 'waited.beanpool.org', state: 'pending', releasable: true, fromInstall: false }]);
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            const line = await screen.findByTestId('extra-name');
            expect(line).toHaveTextContent('This community also holds waited.beanpool.org; it is not used. Release it?');
            expect(line).not.toHaveTextContent('phones');
            fireEvent.click(screen.getByRole('button', { name: 'Release' }));
            const dialog = await screen.findByRole('dialog');
            expect(dialog).toHaveTextContent('Release a name this community does not use');
            expect(dialog).not.toHaveTextContent('phones');
        });

        it('an admin (refused the list) is shown nothing', async () => {
            const calls = mockNames(() => [], 403);
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            await waitFor(() => expect(calls.some((c) => c.url.includes('/public-address/extra-names'))).toBe(true));
            await screen.findByText('owner-pick.beanpool.org');
            expect(screen.queryByTestId('extra-name')).not.toBeInTheDocument();
        });
    });

    // A name the community moved off keeps its own tunnel after Take offline, so this server stays public there.
    describe.each(['dark', 'light'])('Take offline with an old name still answering, in %s', (theme) => {
        const OLD = 'oldvale.beanpool.org';
        const others = [{ host: OLD, state: 'connected', connections: 4 }];
        const moved = { success: true, status: 'live', name: 'byron', hostname: 'byron.beanpool.org', mode: 'tunnel', tunnel: { state: 'connected', connections: 4, others } };
        const waiting = { success: true, status: 'pending', name: 'byron', mode: 'tunnel', reason: 'awaiting-approval', tunnel: { state: 'off', connections: 0, others } };
        const none = (over: Record<string, unknown> = {}) => ({ success: true, status: 'none', tunnel: { state: 'off', connections: 0 }, ...over });
        const noneButOld = none({ tunnel: { state: 'off', connections: 0, others } });

        beforeEach(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); });
        afterEach(() => { document.documentElement.classList.remove('dark'); });

        /** The node, before and after Take offline: `answer` is what the route says. */
        const mockNode = (before: unknown, after: unknown, answer: unknown) => {
            let done = false;
            vi.spyOn(global, 'fetch').mockImplementation((url) => {
                const u = String(url);
                if (u.includes('/public-address/offline')) done = true;
                const body = u.includes('/public-address/offline') ? answer
                    : u.includes('/public-address/status') ? (done ? after : before)
                        : { success: true, logs: [] };
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
            });
        };
        const openDialog = async () => {
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            fireEvent.click(await screen.findByRole('button', { name: /Take offline/i }));
            return screen.findByRole('dialog');
        };

        it('the dialog names what keeps answering and how to end it, and never says the node goes offline', async () => {
            mockNode(moved, noneButOld, { success: true, status: 'none', stillAnswering: [OLD] });
            const dialog = await openDialog();
            expect(screen.getByRole('heading', { name: 'Take this address offline' })).toBeInTheDocument();
            expect(dialog).toHaveTextContent(`Release public address "byron.beanpool.org"? Its tunnel and DNS record will be torn down, but the node stays on the public internet: this server still answers at ${OLD}. To end that, claim ${OLD} back, then use Take offline.`);
            expect(dialog).not.toHaveTextContent('take the node offline');
            expect(dialog).not.toHaveTextContent('Take Node Offline');
        });

        it('a gated name still waiting: the same words, for the name that waits', async () => {
            mockNode(waiting, noneButOld, { success: true, status: 'none', stillAnswering: [OLD] });
            const dialog = await openDialog();
            expect(dialog).toHaveTextContent(`Release public address "byron"? Its tunnel and DNS record will be torn down, but the node stays on the public internet: this server still answers at ${OLD}.`);
            expect(dialog).not.toHaveTextContent('take the node offline');
        });

        it('the toast never says the node is offline, and the panel\'s line says where it still answers', async () => {
            mockNode(moved, noneButOld, { success: true, status: 'none', stillAnswering: [OLD] });
            await openDialog();
            fireEvent.click(screen.getByRole('button', { name: 'Take Offline' }));
            const toast = await screen.findByText(`✓ Public address released. This server still answers at ${OLD}.`);
            expect(toast.closest('[role="status"]')?.className).toMatch(/bg-amber-950/);
            expect(screen.queryByText(/Node is offline/)).not.toBeInTheDocument();
            const line = await screen.findByTestId('public-address-still-answers');
            expect(line).toHaveTextContent(`This server still answers at ${OLD}. To end that, claim ${OLD} back, then use Take offline.`);
            expect(line.className).toMatch(/text-bp-chip-warn-ink/);
            expect(line.className).toMatch(/break-words/);
        });

        it('two old names are both named', async () => {
            mockNode(none({ tunnel: { state: 'off', others: [{ host: OLD }, { host: 'older.beanpool.org' }] } }), none(), {});
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            expect(await screen.findByTestId('public-address-still-answers')).toHaveTextContent(`This server still answers at ${OLD}, older.beanpool.org.`);
        });

        it('beside a name the server keeps with no record of it, the line still shows', async () => {
            mockNode(none({ kept: { hostname: 'kept.beanpool.org' }, tunnel: { state: 'off', others } }), none(), {});
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            await screen.findByTestId('public-address-kept');
            expect(screen.getByTestId('public-address-still-answers')).toHaveTextContent(`This server still answers at ${OLD}.`);
        });

        it('only the stored name to take offline: the words are the usual ones, and it is offline', async () => {
            const alone = { ...moved, tunnel: { state: 'connected', connections: 4 } };
            mockNode(alone, none(), { success: true, status: 'none', stillAnswering: [] });
            const dialog = await openDialog();
            expect(screen.getByRole('heading', { name: 'Take Node Offline' })).toBeInTheDocument();
            expect(dialog).toHaveTextContent('Release public address "byron.beanpool.org" and take the node offline from the public internet? The Cloudflare tunnel and DNS record will be torn down.');
            fireEvent.click(screen.getByRole('button', { name: 'Take Offline' }));
            const toast = await screen.findByText('✓ Public address released. Node is offline.');
            expect(toast.closest('[role="status"]')?.className).toMatch(/bg-emerald-950/);
            await screen.findByText(/No public address currently assigned/);
            expect(screen.queryByTestId('public-address-still-answers')).not.toBeInTheDocument();
        });

        it('with the new name live, the old one has its own row above, not this line', async () => {
            mockNode(moved, moved, {});
            render(<PublicAddressPanel activeNode={mockActiveNode} />);
            await screen.findByText('byron.beanpool.org');
            expect(screen.queryByTestId('public-address-still-answers')).not.toBeInTheDocument();
        });
    });
});

