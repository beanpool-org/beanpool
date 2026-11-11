import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplicationAccessPanel } from './ReplicationAccessPanel';
import type { NodeProfile } from '../../lib/profiles';

// A real automation token's shape (bp_ + 12 hex + _ + 64 hex): only this travels as a Bearer.
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;

describe('ReplicationAccessPanel Component (Bucket 2 Item 4)', () => {
    const mockNode: NodeProfile = {
        id: 'node-primary-1',
        name: 'Primary Node',
        url: 'https://primary.example.com',
        automationToken: TOKEN,
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('renders with a real payload, supports generating token with confirmation, reveal & copy, and clear, with no token-only switch', async () => {
        const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes('/api/local/admin/replication-access')) {
                return {
                    ok: true,
                    json: async () => ({
                        hasToken: true,
                        totalPulls: 14,
                        lastPullAt: '2026-09-15T12:00:00.000Z',
                        lastPullIp: '192.168.1.100',
                        lastPullAuth: 'token',
                        totalRejected: 1,
                        lastRejectedAt: '2026-09-15T11:00:00.000Z',
                        recent: [
                            { at: '2026-09-15T12:00:00.000Z', ip: '192.168.1.100', auth: 'token' },
                            { at: '2026-09-15T11:00:00.000Z', ip: '10.0.0.99', auth: 'rejected', reason: 'bad token' },
                        ],
                    }),
                };
            }
            if (url.includes('/api/local/admin/replication-token/generate')) {
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        token: 'rep_tok_abc123xyz789_secret',
                    }),
                };
            }
            if (url.includes('/api/local/admin/replication-token/clear')) {
                return {
                    ok: true,
                    json: async () => ({ success: true }),
                };
            }
            return { ok: true, json: async () => ({}) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, {
            clipboard: {
                writeText: clipboardWriteText,
            },
        });

        const handleRefreshDiag = vi.fn();

        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
                onRefreshDiag={handleRefreshDiag}
            />
        );

        // Header & Scope
        expect(screen.getByText('Replication Access')).toBeInTheDocument();
        expect(screen.getByText('primary')).toBeInTheDocument();

        // Check initial token status
        await waitFor(() => {
            const tokenState = document.getElementById('rep-token-state');
            expect(tokenState?.textContent).toBe('set');
        });

        // A standby copies with the token and nothing else: no switch, no admin-password notice.
        expect(document.getElementById('rep-token-only')).toBeNull();
        expect(document.getElementById('rep-token-only-notice')).toBeNull();
        expect(screen.queryByText(/Require token/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/admin password/i)).not.toBeInTheDocument();
        // The read goes out as a Bearer token and carries no admin password.
        const readCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/api/local/admin/replication-access'))!;
        expect(readCall[1].headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        expect(readCall[1].headers['X-Admin-Password']).toBeUndefined();
        expect(JSON.parse(readCall[1].body)).toEqual({});

        // Check pull activity numbers
        const totalPulls = document.getElementById('rep-total-pulls');
        expect(totalPulls?.textContent).toBe('14');

        const lastPull = document.getElementById('rep-last-pull');
        expect(lastPull?.textContent).toContain('192.168.1.100');
        expect(lastPull?.textContent).toContain('token');

        const rejected = document.getElementById('rep-rejected');
        expect(rejected?.textContent).toContain('1');

        // Recent events
        expect(screen.getByText(/Recent Events \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText(/bad token/i)).toBeInTheDocument();

        // 1. Generate / Rotate Token with confirmation modal
        const genBtn = screen.getByRole('button', { name: /Generate \/ rotate token/i });
        await userEvent.click(genBtn);

        // Confirmation modal opens
        expect(screen.getByText(/Generate \/ Rotate Replication Token\?/i)).toBeInTheDocument();
        const confirmGenBtn = screen.getByRole('button', { name: /Generate Token/i });
        await userEvent.click(confirmGenBtn);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/replication-token/generate'),
                expect.any(Object)
            );
            // Reveal box appears
            expect(screen.getByText(/Copy this token now — it is shown only once/i)).toBeInTheDocument();
            const tokenVal = document.getElementById('rep-token-value');
            expect(tokenVal?.textContent).toBe('rep_tok_abc123xyz789_secret');
        });

        // Test clipboard copy
        const copyBtn = screen.getByRole('button', { name: /Copy/i });
        await userEvent.click(copyBtn);
        expect(clipboardWriteText).toHaveBeenCalledWith('rep_tok_abc123xyz789_secret');

        // 2. There is no token-only mode to toggle: no route for it is ever called.
        expect(fetchMock).not.toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/replication-token/mode'),
            expect.anything()
        );

        // 3. Clear token with confirmation modal
        const clearBtn = screen.getByRole('button', { name: /Remove Token/i });
        await userEvent.click(clearBtn);

        expect(screen.getByText(/Remove Replication Token\?/i)).toBeInTheDocument();
        const confirmClearBtn = document.getElementById('confirm-clear-token-btn')!;
        await userEvent.click(confirmClearBtn);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/replication-token/clear'),
                expect.any(Object)
            );
            // With no token nothing can copy.
            const tokenState = document.getElementById('rep-token-state');
            expect(tokenState?.textContent).toBe('not set · nothing can copy until you make a token');
        });
    });

    it('renders safely with an empty payload', async () => {
        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
                initialData={{}}
            />
        );

        expect(screen.getByText('Replication Access')).toBeInTheDocument();
        const tokenState = document.getElementById('rep-token-state');
        expect(tokenState?.textContent).toBe('not set · nothing can copy until you make a token');

        const totalPulls = document.getElementById('rep-total-pulls');
        expect(totalPulls?.textContent).toBe('0');

        const lastPull = document.getElementById('rep-last-pull');
        expect(lastPull?.textContent).toBe('never');

        const rejected = document.getElementById('rep-rejected');
        expect(rejected?.textContent).toBe('0');

        expect(document.getElementById('rep-token-only')).toBeNull();
    });

    it('renders safely with wrong-typed fields and malformed data', async () => {
        const malformedData: any = {
            hasToken: 'yes-is-token',
            totalPulls: 'invalid-pull-count',
            lastPullAt: 12345678,
            lastPullIp: 9999,
            lastPullAuth: {},
            totalRejected: { count: 'lots' },
            lastRejectedAt: ['not', 'a', 'date'],
            recent: 'not-an-array',
        };

        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
                initialData={malformedData}
            />
        );

        expect(screen.getByText('Replication Access')).toBeInTheDocument();

        // Doesn't crash and renders fallback values
        const totalPulls = document.getElementById('rep-total-pulls');
        expect(totalPulls?.textContent).toBe('0');

        const tokenState = document.getElementById('rep-token-state');
        expect(tokenState).toBeInTheDocument();

        const rejected = document.getElementById('rep-rejected');
        expect(rejected?.textContent).toBe('0');
    });

    it('shows status message when clipboard copy rejects', async () => {
        const clipboardWriteText = vi.fn().mockRejectedValue(new Error('Permission denied'));
        Object.assign(navigator, {
            clipboard: {
                writeText: clipboardWriteText,
            },
        });

        vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('/api/local/admin/replication-token/generate')) {
                return {
                    ok: true,
                    json: async () => ({ success: true, token: 'rep_fail_token' }),
                };
            }
            return { ok: true, json: async () => ({ hasToken: true }) };
        }));

        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
            />
        );

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Generate \/ rotate token/i })).toBeInTheDocument();
        });

        const genBtn = screen.getByRole('button', { name: /Generate \/ rotate token/i });
        await userEvent.click(genBtn);

        const confirmGenBtn = screen.getByRole('button', { name: /Generate Token/i });
        await userEvent.click(confirmGenBtn);

        await waitFor(() => {
            expect(screen.getByText(/Copy this token now/i)).toBeInTheDocument();
        });

        const copyBtn = screen.getByRole('button', { name: /Copy/i });
        await userEvent.click(copyBtn);

        await waitFor(() => {
            expect(screen.getByText(/Failed to copy to clipboard/i)).toBeInTheDocument();
        });

        // Dismiss reveal button has aria-label and closes reveal box
        const dismissBtn = screen.getByRole('button', { name: /Dismiss revealed token/i });
        expect(dismissBtn).toBeInTheDocument();
        await userEvent.click(dismissBtn);
        expect(screen.queryByText(/Copy this token now/i)).not.toBeInTheDocument();
    });

    it('allows closing confirmation modals via Escape key and close buttons', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ hasToken: true }),
        }));

        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
            />
        );

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /Generate \/ rotate token/i })).toBeInTheDocument();
        });

        // 1. Generate modal with Escape
        const genBtn = screen.getByRole('button', { name: /Generate \/ rotate token/i });
        await userEvent.click(genBtn);
        expect(screen.getByText(/Generate \/ Rotate Replication Token\?/i)).toBeInTheDocument();

        await userEvent.keyboard('{Escape}');
        expect(screen.queryByText(/Generate \/ Rotate Replication Token\?/i)).not.toBeInTheDocument();

        // 2. Generate modal with Close button
        await userEvent.click(genBtn);
        expect(screen.getByText(/Generate \/ Rotate Replication Token\?/i)).toBeInTheDocument();
        const closeGenBtn = screen.getByRole('button', { name: /Close generate confirmation/i });
        await userEvent.click(closeGenBtn);
        expect(screen.queryByText(/Generate \/ Rotate Replication Token\?/i)).not.toBeInTheDocument();

        // 3. Clear modal with Escape
        const clearBtn = screen.getByRole('button', { name: /Remove Token/i });
        await userEvent.click(clearBtn);
        expect(screen.getByText(/Remove Replication Token\?/i)).toBeInTheDocument();

        await userEvent.keyboard('{Escape}');
        expect(screen.queryByText(/Remove Replication Token\?/i)).not.toBeInTheDocument();

        // 4. Clear modal with Close button
        await userEvent.click(clearBtn);
        expect(screen.getByText(/Remove Replication Token\?/i)).toBeInTheDocument();
        const closeClearBtn = screen.getByRole('button', { name: /Close clear confirmation/i });
        await userEvent.click(closeClearBtn);
        expect(screen.queryByText(/Remove Replication Token\?/i)).not.toBeInTheDocument();
    });

    it('shows loading indicator while fetching replication access data', async () => {
        let resolveFetch: (val: any) => void = () => {};
        const pendingPromise = new Promise((resolve) => {
            resolveFetch = resolve;
        });

        vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingPromise));

        render(<ReplicationAccessPanel activeNode={mockNode} />);

        // Loading indicator should be present while request is pending
        expect(screen.getByText('Loading replication access settings...')).toBeInTheDocument();

        // Resolve fetch
        resolveFetch({
            ok: true,
            json: async () => ({ hasToken: true, totalPulls: 5 }),
        });

        await waitFor(() => {
            expect(screen.queryByText('Loading replication access settings...')).not.toBeInTheDocument();
            expect(screen.getByText('Replication token:')).toBeInTheDocument();
        });
    });

    it('a fresh install (no token) says nothing can copy, with no notice and no switch', () => {
        render(
            <ReplicationAccessPanel
                activeNode={mockNode}
                initialData={{ hasToken: false, totalPulls: 0 }}
            />
        );
        const tokenState = document.getElementById('rep-token-state');
        expect(tokenState?.textContent).toBe('not set · nothing can copy until you make a token');
        expect(tokenState?.textContent).not.toMatch(/admin password/);
        expect(document.getElementById('rep-token-only-notice')).toBeNull();
        expect(document.getElementById('rep-token-only')).toBeNull();
    });

    it('draws no token-only notice and no switch, whatever the last pull used or an old server still sends', () => {
        const { rerender } = render(
            <ReplicationAccessPanel
                activeNode={mockNode}
                initialData={{ hasToken: true, lastPullAuth: 'admin-pw', tokenOnly: false }}
            />
        );
        expect(document.getElementById('rep-token-state')?.textContent).toBe('set');
        expect(document.getElementById('rep-token-only-notice')).toBeNull();
        expect(document.getElementById('rep-token-only')).toBeNull();
        expect(screen.queryByText(/Require token/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/tick/i)).not.toBeInTheDocument();

        rerender(
            <ReplicationAccessPanel
                key="token-pulls"
                activeNode={mockNode}
                initialData={{ hasToken: true, lastPullAuth: 'token' }}
            />
        );
        expect(document.getElementById('rep-token-state')?.textContent).toBe('set');
        expect(document.getElementById('rep-token-only-notice')).toBeNull();
    });
});
