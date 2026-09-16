import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublicAddressPanel } from './PublicAddressPanel';
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
        expect(screen.getByRole('button', { name: /Reset Tunnel/i })).toBeInTheDocument();
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
        expect(screen.getByText('https://cairns.beanpool.org')).toBeInTheDocument();
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

    it('requires confirmation step before restarting the tunnel sidecar', async () => {
        let restartCalled = false;

        vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/public-address/restart-sidecar') && opts?.method === 'POST') {
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
            expect(screen.getByRole('button', { name: /Reset Tunnel/i })).toBeInTheDocument();
        });

        // Click Reset Tunnel
        fireEvent.click(screen.getByRole('button', { name: /Reset Tunnel/i }));

        // Confirmation modal appears
        expect(screen.getByText('Restart Tunnel Sidecar')).toBeInTheDocument();
        expect(screen.getByText(/Are you sure you want to force-restart the Cloudflare tunnel sidecar process/i)).toBeInTheDocument();
        expect(restartCalled).toBe(false);

        // Click Confirm inside modal
        const confirmBtn = screen.getByRole('button', { name: 'Restart Sidecar' });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
            expect(restartCalled).toBe(true);
        });
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
            expect(screen.getByRole('button', { name: /Reset Tunnel/i })).toBeInTheDocument();
        });

        // Open modal
        fireEvent.click(screen.getByRole('button', { name: /Reset Tunnel/i }));
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Dismiss via Escape key
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        // Open modal again
        fireEvent.click(screen.getByRole('button', { name: /Reset Tunnel/i }));
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
});

