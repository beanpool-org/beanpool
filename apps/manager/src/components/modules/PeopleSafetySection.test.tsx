import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeopleSafetySection } from './PeopleSafetySection';
import type { NodeProfile } from '../../lib/profiles';
import { setKeySessionCsrfToken, setTfaSessionToken } from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-password',
};

const realServerReports: any[] = [
    {
        id: 'rep_1',
        reporter_pubkey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        target_pubkey: '02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        target_post_id: null,
        reason: 'Suspected spam activity',
        created_at: '2026-09-10T00:00:00Z',
        status: 'pending',
        reporter_callsign: 'alice',
        target_callsign: 'bob',
    },
];

const mockMembers: any[] = [
    {
        publicKey: '021234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        callsign: 'alice',
        tier: 'Elder',
        standing: 'Elder',
        canVouch: true,
        nodeRole: 'owner',
    },
    {
        publicKey: '02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        callsign: 'bob',
        tier: 'Resident',
        standing: 'Resident',
        canVouch: false,
        nodeRole: null,
    },
];

describe('PeopleSafetySection Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders real server reports with snake_case target_pubkey without crashing', async () => {
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{
                        reports: realServerReports,
                        members: mockMembers,
                    }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        // Switch to reports tab
        const reportsTab = screen.getByRole('button', { name: /triage & moderation/i });
        await act(async () => {
            fireEvent.click(reportsTab);
        });

        expect(screen.getByText(/Community Report Triage/i)).toBeInTheDocument();
        expect(screen.getByText('Suspected spam activity')).toBeInTheDocument();
        // Target pubkey slice should render without throwing
        expect(screen.getByText(/02abcdef1234/i)).toBeInTheDocument();
    });

    it('renders safely with empty or missing nodeData', async () => {
        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{}}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        expect(screen.getByText('People & Safety')).toBeInTheDocument();
        expect(screen.getByText(/No registered members/i)).toBeInTheDocument();
    });

    it('guards against wrong-typed targetPubkey (numbers, objects, nulls)', async () => {
        const malformedReports: any[] = [
            {
                id: 'mal_1',
                targetPubkey: { nested: 'not-a-string' },
                reporterPubkey: 12345,
                reason: 'Malformed report 1',
                status: 'pending',
            },
            {
                id: 'mal_2',
                target_pubkey: null,
                reporter_pubkey: undefined,
                reason: 'Malformed report 2',
                status: 'pending',
            },
        ];

        await act(async () => {
            render(
                <PeopleSafetySection
                    activeNode={mockProfile}
                    nodeData={{
                        reports: malformedReports,
                        members: [],
                    }}
                    nodeDataLoading={false}
                    onRefresh={vi.fn()}
                    onFreezeUser={vi.fn()}
                    onPruneUser={vi.fn()}
                    onUpdateTier={vi.fn()}
                    onToggleVoucher={vi.fn()}
                    onToggleOperator={vi.fn()}
                    onGrantNodeRole={vi.fn()}
                    onRevokeNodeRole={vi.fn()}
                />
            );
        });

        const reportsTab = screen.getByRole('button', { name: /triage & moderation/i });
        await act(async () => {
            fireEvent.click(reportsTab);
        });

        expect(screen.getByText('Malformed report 1')).toBeInTheDocument();
        expect(screen.getByText('Malformed report 2')).toBeInTheDocument();
    });

    function renderModeration(reports: any[], onRefresh = vi.fn()) {
        render(
            <PeopleSafetySection
                activeNode={mockProfile}
                nodeData={{ reports, members: mockMembers }}
                nodeDataLoading={false}
                onRefresh={onRefresh}
                onFreezeUser={vi.fn()}
                onPruneUser={vi.fn()}
                onUpdateTier={vi.fn()}
                onToggleVoucher={vi.fn()}
                onToggleOperator={vi.fn()}
                initialSubTab="moderation"
            />
        );
        return onRefresh;
    }

    it('shows a Pulse-item report with its title, platform and link, and removes it from the Pulse', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('confirm', vi.fn(() => true));

        const onRefresh = renderModeration([{
            id: 'rep_pulse',
            targetPubkey: mockMembers[1].publicKey,
            reason: 'Hateful clip',
            status: 'pending',
            targetPulseItemId: 'item_abc',
            pulseItem: { title: 'Offensive clip', platform: 'youtube', url: 'https://www.youtube.com/watch?v=abc', removed: false },
        }]);

        const link = screen.getByRole('link', { name: 'Offensive clip' });
        expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc');
        expect(screen.getByText(/Pulse · youtube/)).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Remove from the Pulse' }));
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/api/local/admin/reports/rep_pulse/action');
        expect(JSON.parse(init.body)).toMatchObject({ removePulseItem: true });
        expect(init.body).not.toContain('suspendUser');
        expect(onRefresh).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('dismissing a report tells the node, not just this browser', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        vi.stubGlobal('fetch', fetchMock);

        const onRefresh = renderModeration([
            { id: 'rep_member', targetPubkey: mockMembers[1].publicKey, reason: 'Rude in chat', status: 'pending' },
        ]);

        fireEvent.click(screen.getByRole('button', { name: /Inspect & Action/ }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Dismiss Flag' }));
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/api/local/admin/reports/rep_member/dismiss');
        expect(init.method).toBe('POST');

        await act(async () => {
            vi.advanceTimersByTime(1200);
        });
        expect(onRefresh).toHaveBeenCalled();
        expect(screen.queryByText('USER REPORTED ABUSE')).not.toBeInTheDocument();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('keeps the report open with the error when the node refuses the dismiss', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'Abuse report not found' }) });
        vi.stubGlobal('fetch', fetchMock);

        const onRefresh = renderModeration([
            { id: 'rep_gone', targetPubkey: mockMembers[1].publicKey, reason: 'Rude in chat', status: 'pending' },
        ]);

        fireEvent.click(screen.getByRole('button', { name: /Inspect & Action/ }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Dismiss Flag' }));
        });

        expect(screen.getByRole('alert')).toHaveTextContent('Abuse report not found');
        expect(screen.getByText('USER REPORTED ABUSE')).toBeInTheDocument();
        expect(onRefresh).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('shows a removed Pulse item without a remove button, and no Pulse controls on member reports', async () => {
        renderModeration([
            {
                id: 'rep_done',
                targetPubkey: mockMembers[1].publicKey,
                reason: 'Already handled',
                status: 'actioned',
                outcome: 'actioned',
                targetPulseItemId: 'item_gone',
                pulseItem: { title: null, platform: 'tiktok', url: null, removed: true },
            },
            { id: 'rep_member', targetPubkey: mockMembers[1].publicKey, reason: 'Rude in chat', status: 'pending' },
        ]);

        // In default Open view, rep_member is shown and has no Pulse controls
        expect(screen.queryByTestId('pulse-report-item')).not.toBeInTheDocument();

        // Switch to Actioned filter to see rep_done
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Actioned' }));
        });

        expect(screen.getByText('Removed from the Pulse')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove from the Pulse' })).not.toBeInTheDocument();
        expect(screen.getAllByTestId('pulse-report-item')).toHaveLength(1);
    });

    it('defaults to Open filter and switches between Open, Dismissed, Actioned, and All', async () => {
        renderModeration([
            { id: 'rep_1', targetPubkey: mockMembers[0].publicKey, reason: 'Pending spam', outcome: 'open', status: 'pending' },
            { id: 'rep_2', targetPubkey: mockMembers[1].publicKey, reason: 'Dismissed report', outcome: 'dismissed', status: 'reviewed' },
            { id: 'rep_3', targetPubkey: mockMembers[1].publicKey, reason: 'Actioned report', outcome: 'actioned', status: 'actioned' },
        ]);

        // Defaults to Open: only rep_1 visible
        expect(screen.getByText('Pending spam')).toBeInTheDocument();
        expect(screen.queryByText('Dismissed report')).not.toBeInTheDocument();
        expect(screen.queryByText('Actioned report')).not.toBeInTheDocument();

        // Switch to Dismissed: only rep_2 visible
        fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }));
        expect(screen.queryByText('Pending spam')).not.toBeInTheDocument();
        expect(screen.getByText('Dismissed report')).toBeInTheDocument();
        expect(screen.queryByText('Actioned report')).not.toBeInTheDocument();

        // Switch to Actioned: only rep_3 visible
        fireEvent.click(screen.getByRole('button', { name: 'Actioned' }));
        expect(screen.queryByText('Pending spam')).not.toBeInTheDocument();
        expect(screen.queryByText('Dismissed report')).not.toBeInTheDocument();
        expect(screen.getByText('Actioned report')).toBeInTheDocument();

        // Switch to All: all visible
        fireEvent.click(screen.getByRole('button', { name: 'All' }));
        expect(screen.getByText('Pending spam')).toBeInTheDocument();
        expect(screen.getByText('Dismissed report')).toBeInTheDocument();
        expect(screen.getByText('Actioned report')).toBeInTheDocument();
    });

    it('displays post title, author callsign, and Removed badge when postRemoved is true', async () => {
        renderModeration([
            {
                id: 'rep_post_1',
                targetPubkey: mockMembers[0].publicKey,
                reason: 'Offensive listing',
                outcome: 'open',
                status: 'pending',
                postId: 'post_123',
                postTitle: 'Fresh Organic Apples',
                postAuthorCallsign: 'farmer_bob',
                postRemoved: true,
            },
            {
                id: 'rep_post_2',
                targetPubkey: mockMembers[1].publicKey,
                reason: 'Misleading description',
                outcome: 'open',
                status: 'pending',
                title: 'Handmade Wooden Chair',
                postAuthorCallsign: 'carpenter_alice',
                postRemoved: false,
            },
        ]);

        expect(screen.getByText('Fresh Organic Apples')).toBeInTheDocument();
        expect(screen.getByText('@farmer_bob')).toBeInTheDocument();
        expect(screen.getByText('Removed')).toBeInTheDocument();

        expect(screen.getByText('Handmade Wooden Chair')).toBeInTheDocument();
        expect(screen.getByText('@carpenter_alice')).toBeInTheDocument();
    });

    it('sub-tab count badge counts OPEN reports only and falls as handled', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
        vi.stubGlobal('fetch', fetchMock);

        renderModeration([
            { id: 'rep_open_1', targetPubkey: mockMembers[0].publicKey, reason: 'Report 1', outcome: 'open', status: 'pending' },
            { id: 'rep_open_2', targetPubkey: mockMembers[1].publicKey, reason: 'Report 2', outcome: 'open', status: 'pending' },
            { id: 'rep_dismissed', targetPubkey: mockMembers[1].publicKey, reason: 'Report 3', outcome: 'dismissed', status: 'reviewed' },
        ]);

        // Find moderation tab button and its badge
        const modTab = screen.getByRole('button', { name: /triage & moderation/i });
        // Initially 2 open reports out of 3 total reports
        expect(modTab).toHaveTextContent('2');

        // Dismiss rep_open_1
        const inspectButtons = screen.getAllByRole('button', { name: /Inspect & Action/ });
        fireEvent.click(inspectButtons[0]);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Dismiss Flag' }));
        });

        // After dismissing, badge count falls to 1
        expect(modTab).toHaveTextContent('1');

        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('Freeze Accounts on a report (review round 1, B2)', () => {
        const report = { id: 'rep_freeze', targetPubkey: mockMembers[1].publicKey, reason: 'Scam offers', outcome: 'open', status: 'pending' };

        function renderWithFreeze(onFreezeUser: (pk: string, freeze: boolean) => Promise<void>, onRefresh = vi.fn()) {
            const props = {
                activeNode: mockProfile,
                nodeDataLoading: false,
                onRefresh,
                onFreezeUser,
                onPruneUser: vi.fn(),
                onUpdateTier: vi.fn(),
                onToggleVoucher: vi.fn(),
                onToggleOperator: vi.fn(),
                initialSubTab: 'moderation' as const,
            };
            const utils = render(<PeopleSafetySection {...props} nodeData={{ reports: [report], members: mockMembers }} />);
            return { ...utils, props };
        }

        it('a failed freeze leaves the report open, shows the error and sends nothing to /reports', async () => {
            vi.useFakeTimers();
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            try {
                const onFreezeUser = vi.fn().mockRejectedValue(new Error('HTTP 500: Internal Server Error'));
                renderWithFreeze(onFreezeUser);
                const modTab = screen.getByRole('button', { name: /triage & moderation/i });
                expect(modTab).toHaveTextContent('1');

                fireEvent.click(screen.getByRole('button', { name: /Inspect & Action/ }));
                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: /Freeze Accounts/ }));
                });
                expect(onFreezeUser).toHaveBeenCalledWith(mockMembers[1].publicKey, true);
                expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');

                await act(async () => {
                    vi.advanceTimersByTime(5000);
                });
                // Still in the modal, still open in the list, badge unchanged, no report request.
                expect(screen.getByText('USER REPORTED ABUSE')).toBeInTheDocument();
                expect(modTab).toHaveTextContent('1');
                expect(screen.getByRole('button', { name: /Inspect & Action/ })).toBeInTheDocument();
                expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/reports/'))).toHaveLength(0);
            } finally {
                vi.useRealTimers();
                vi.unstubAllGlobals();
            }
        });

        it('a successful freeze closes the modal but the report stays open until dismissed or actioned', async () => {
            vi.useFakeTimers();
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            try {
                const onFreezeUser = vi.fn().mockResolvedValue(undefined);
                const onRefresh = vi.fn();
                renderWithFreeze(onFreezeUser, onRefresh);
                const modTab = screen.getByRole('button', { name: /triage & moderation/i });

                fireEvent.click(screen.getByRole('button', { name: /Inspect & Action/ }));
                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: /Freeze Accounts/ }));
                });
                await act(async () => {
                    vi.advanceTimersByTime(1200);
                });
                expect(screen.queryByText('USER REPORTED ABUSE')).not.toBeInTheDocument();
                expect(onRefresh).toHaveBeenCalled();
                expect(modTab).toHaveTextContent('1');
                expect(screen.getByRole('button', { name: /Inspect & Action/ })).toBeInTheDocument();
                expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/reports/'))).toHaveLength(0);
            } finally {
                vi.useRealTimers();
                vi.unstubAllGlobals();
            }
        });

        it("after a refresh the server's outcome wins over what this browser marked", async () => {
            vi.useFakeTimers();
            const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
            vi.stubGlobal('fetch', fetchMock);
            try {
                const { rerender, props } = renderWithFreeze(vi.fn());
                const modTab = screen.getByRole('button', { name: /triage & moderation/i });

                fireEvent.click(screen.getByRole('button', { name: /Inspect & Action/ }));
                await act(async () => {
                    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Flag' }));
                });
                await act(async () => {
                    vi.advanceTimersByTime(1200);
                });
                expect(modTab).not.toHaveTextContent('1');
                expect(screen.queryByRole('button', { name: /Inspect & Action/ })).not.toBeInTheDocument();

                // The node's fresh list is the truth, whatever this browser marked.
                await act(async () => {
                    rerender(<PeopleSafetySection {...props} nodeData={{ reports: [{ ...report }], members: mockMembers }} />);
                });
                expect(modTab).toHaveTextContent('1');
                expect(screen.getByRole('button', { name: /Inspect & Action/ })).toBeInTheDocument();

                await act(async () => {
                    rerender(<PeopleSafetySection {...props} nodeData={{ reports: [{ ...report, outcome: 'dismissed', status: 'reviewed' }], members: mockMembers }} />);
                });
                expect(modTab).not.toHaveTextContent('1');
            } finally {
                vi.useRealTimers();
                vi.unstubAllGlobals();
            }
        });
    });
});

/**
 * The onboarding funnel, brought into single-node Settings (the fleet manager that used to host it is retired).
 *
 * What these check, beyond "it renders": the request leaves by the SAME path as the other People & Safety screens
 * -- resolveNodeApiUrl + buildAdminHeaders, with the node App.tsx resolved -- under both single-node sign-ins.
 * Nothing new was added to authenticate it, and nothing about the server changed.
 */
describe('People & Safety: Onboarding Funnel', () => {
    // The node App.tsx builds in single-node mode: this page's own origin, so resolveNodeApiUrl leaves the path
    // alone instead of routing it through /proxy/, and a key-session cookie rides along same-origin.
    const singleNode: NodeProfile = {
        id: 'local-node',
        name: 'Local Sovereign Node',
        url: window.location.origin,
        adminPassword: 'break-glass-pass',
        isPrimary: true,
    };

    const FUNNEL = {
        days: 30,
        rows: [
            { day: '2026-09-01', event: 'invite_attempt', variant: null, count: 8 },
            { day: '2026-09-01', event: 'member_created', variant: null, count: 6 },
            { day: '2026-09-02', event: 'invite_failed', variant: 'expired', count: 2 },
        ],
    };

    const renderPeople = (node: NodeProfile) => render(
        <PeopleSafetySection
            activeNode={node}
            // `reports: []` so the moderation loader never fires: the funnel is then the only request made.
            nodeData={{ reports: [], members: mockMembers }}
            nodeDataLoading={false}
            onRefresh={vi.fn()}
            onFreezeUser={vi.fn()}
            onPruneUser={vi.fn()}
            onUpdateTier={vi.fn()}
            onToggleVoucher={vi.fn()}
            onToggleOperator={vi.fn()}
        />
    );

    const funnelCalls = (fetchMock: any) =>
        fetchMock.mock.calls.filter(([u]: [string]) => String(u).includes('onboarding-funnel'));

    beforeEach(() => {
        vi.clearAllMocks();
        setKeySessionCsrfToken(null);
        setTfaSessionToken('local-node', undefined);
    });

    it('offers the funnel as a sub-tab, right after Invites & QR', async () => {
        await act(async () => { renderPeople(singleNode); });

        const order = [...document.querySelectorAll('[data-subtab]')].map(b => b.getAttribute('data-subtab'));
        expect(order).toEqual(['directory', 'invites', 'funnel', 'moderation', 'roles']);
        expect(screen.getByRole('button', { name: /^Onboarding Funnel$/ })).toBeInTheDocument();
    });

    it('reads the funnel with the break-glass password sign-in, through the shared admin headers', async () => {
        setTfaSessionToken('local-node', 'tfa-abc');
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FUNNEL });
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => { renderPeople(singleNode); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Onboarding Funnel$/ })); });

        await waitFor(() => expect(funnelCalls(fetchMock).length).toBe(1));
        const [url, init] = funnelCalls(fetchMock)[0];
        // Same origin as the page, so no /proxy/ hop -- exactly what the members directory and invites do.
        expect(String(url)).toBe(`${window.location.origin}/api/local/admin/onboarding-funnel?days=30`);
        expect(init.headers['X-Admin-Password']).toBe('break-glass-pass');
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-abc');
        expect(init.headers['X-CSRF-Token']).toBeUndefined();

        await waitFor(() => expect(screen.getByText('Entered an invite code')).toBeInTheDocument());
        expect(screen.getByRole('heading', { name: /Onboarding Funnel/ })).toBeInTheDocument();
        expect(screen.getByText('Code had expired')).toBeInTheDocument();
    });

    it('reads the funnel under a key sign-in: no password, the session cookie and its CSRF token instead', async () => {
        setKeySessionCsrfToken('csrf-from-key-session');
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FUNNEL });
        vi.stubGlobal('fetch', fetchMock);

        // An owner or admin signed in from the app: App.tsx leaves adminPassword undefined, and the httpOnly
        // admin_session cookie authenticates the request by itself.
        await act(async () => { renderPeople({ ...singleNode, adminPassword: undefined }); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Onboarding Funnel$/ })); });

        await waitFor(() => expect(funnelCalls(fetchMock).length).toBe(1));
        const [url, init] = funnelCalls(fetchMock)[0];
        expect(String(url)).toBe(`${window.location.origin}/api/local/admin/onboarding-funnel?days=30`);
        expect(init.headers['X-Admin-Password']).toBeUndefined();
        expect(init.headers['X-CSRF-Token']).toBe('csrf-from-key-session');

        await waitFor(() => expect(screen.getByText('Entered an invite code')).toBeInTheDocument());
        setKeySessionCsrfToken(null);
    });

    it('offers no node switcher: there is only ever this node', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FUNNEL });
        vi.stubGlobal('fetch', fetchMock);

        await act(async () => { renderPeople(singleNode); });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Onboarding Funnel$/ })); });

        await waitFor(() => expect(screen.getByText('Entered an invite code')).toBeInTheDocument());
        expect(screen.queryByLabelText(/Choose which node/i)).not.toBeInTheDocument();
    });
});
