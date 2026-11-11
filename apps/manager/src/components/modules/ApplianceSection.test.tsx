import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
// The everyday rules card reads the community's shape on mount (its own tests: EverydayRuleRows.test.tsx); this file counts other calls.
vi.mock('./EverydayRuleRows', () => ({ EverydayRuleRows: () => null }));
import { ApplianceSection } from './ApplianceSection';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse, GatewayConfig } from '../../lib/node-client';
import * as nodeClient from '../../lib/node-client';
import { answerInPageConfirm } from '../common/__tests__/in-page-confirm-helpers';

// A real automation token's shape (bp_ + 12 hex + _ + 64 hex): only this travels as a Bearer.
const TOKEN = `bp_${'a'.repeat(12)}_${'b'.repeat(64)}`;
const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    automationToken: TOKEN,
};

const mockDiag: DiagnosticsResponse = {
    status: 'healthy',
    uptimeSeconds: 3600,
    totalMemoryMb: 512,
    callsign: 'mullum-node',
    communityName: 'Mullumbimby Commons',
    cpuLoadPercent: 12,
    memoryUsageMb: 85,
    dbSizeBytes: 1024 * 1024 * 5,
    walSizeBytes: 1024 * 512,
    activeWsConnections: 4,
    p2pActivePeers: 2,
};

const mockGateway: GatewayConfig = {
    features: { servePwa: true },
    corsAllowedOrigins: ['*'],
    rateLimiting: { enabled: true, maxRequestsPerMinute: 60 },
    adminIpAllowlist: [],
};

const mockSnapshots = [
    {
        name: 'snapshot-2026-09-15.db',
        sizeBytes: 1024 * 1024 * 2,
        createdAt: '2026-09-15T04:00:00.000Z',
    },
];

describe('ApplianceSection Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        vi.spyOn(nodeClient, 'fetchNodeSnapshots').mockResolvedValue(mockSnapshots);
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockResolvedValue({
            enabled: true,
            intervalHours: 24,
            keep: 7,
        });
        vi.spyOn(nodeClient, 'updateNodeSnapshotSchedule').mockResolvedValue({
            enabled: true,
            intervalHours: 12,
            keep: 14,
        });
        vi.spyOn(nodeClient, 'verifyNodeBackup').mockResolvedValue({
            success: true,
            ok: true,
            verifiedAt: '2026-09-16T05:00:00.000Z',
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                updateAvailable: false,
                currentVersion: '1.2.28',
                connectors: [],
                enabled: false,
            }),
        }));
    });

    it('renders read-only version, update status, and last backup card per admin-surface §4.3', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                />
            );
        });

        expect(screen.getByText(/Appliance & Data/i)).toBeInTheDocument();
        expect(screen.getByText('Node Version')).toBeInTheDocument();
        expect(screen.getByText('Update Status')).toBeInTheDocument();
        expect(screen.getByText('Last Successful Backup')).toBeInTheDocument();
        expect(screen.getByText(/Container restart & image swaps restricted to SSH/i)).toBeInTheDocument();
        // Verify no container restart or deploy buttons exist
        expect(screen.queryByRole('button', { name: /restart container/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /deploy update/i })).not.toBeInTheDocument();
    });

    // The ledger audit's figures are whole hundredths of a Bean (engine audit.ts runConservationCheck): said in Beans.
    it('says the ledger audit\'s drift and total in Beans to the cent, and a figure that is not one as "not a number"', async () => {
        vi.spyOn(nodeClient, 'fetchStrandedEscrows').mockResolvedValue({ success: true } as nodeClient.StrandedEscrowsResponse);
        const props = {
            activeNode: mockProfile, diag: mockDiag, gateway: mockGateway, gatewayLoading: false, gatewaySuccess: null, gatewaySaving: false,
            nodeLogs: [], onChangeGateway: vi.fn(), onSaveGateway: vi.fn(), onRefreshDiag: vi.fn(), onRefreshLogs: vi.fn(),
            onDownloadBackup: vi.fn(), onRunLedgerAudit: vi.fn(),
        };
        let view!: ReturnType<typeof render>;
        await act(async () => {
            view = render(<ApplianceSection {...props} auditState={{ running: false, result: { ok: false, drift: -982, sumBalances: 4925, baseline: 5907, strandedEscrows: 0 } }} />);
        });
        expect(screen.getByText('−9.82 beans')).toBeInTheDocument();
        expect(screen.getByText('49.25 beans')).toBeInTheDocument();
        view.unmount();
        await act(async () => {
            render(<ApplianceSection {...props} auditState={{ running: false, result: { ok: false, drift: null, sumBalances: 12.5, strandedEscrows: 0 } }} />);
        });
        expect(screen.getAllByText('not a number')).toHaveLength(2);
    });

    it('shows the node\'s real backup schedule, and "Unknown" when it can\'t be read, never a made-up default', async () => {
        const renderBackups = () => render(
            <ApplianceSection
                activeNode={mockProfile}
                diag={mockDiag}
                gateway={mockGateway}
                gatewayLoading={false}
                gatewaySuccess={null}
                gatewaySaving={false}
                nodeLogs={[]}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
                onRefreshDiag={vi.fn()}
                onRefreshLogs={vi.fn()}
                onDownloadBackup={vi.fn()}
                onRunLedgerAudit={vi.fn()}
                auditState={{ running: false, result: null }}
                initialSubTab="backups"
            />
        );
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockResolvedValue({ enabled: true, intervalHours: 6, keep: 3 });
        let view!: ReturnType<typeof render>;
        await act(async () => { view = renderBackups(); });
        expect(await screen.findByText('Active (6h)')).toBeInTheDocument();
        view.unmount();

        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockRejectedValue(new Error('HTTP 403: Forbidden'));
        await act(async () => { renderBackups(); });
        expect(await screen.findByText('Unknown')).toBeInTheDocument();
        expect(screen.queryByText(/^Active \(/)).not.toBeInTheDocument();
        expect(screen.getByText(/Couldn't read this node's backup schedule/)).toBeInTheDocument();
    });

    it('when schedule is unknown: no editable form and no save request; when known: shows real values and saving sends exactly what is shown', async () => {
        const renderBackups = () => render(
            <ApplianceSection
                activeNode={mockProfile}
                diag={mockDiag}
                gateway={mockGateway}
                gatewayLoading={false}
                gatewaySuccess={null}
                gatewaySaving={false}
                nodeLogs={[]}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
                onRefreshDiag={vi.fn()}
                onRefreshLogs={vi.fn()}
                onDownloadBackup={vi.fn()}
                onRunLedgerAudit={vi.fn()}
                auditState={{ running: false, result: null }}
                initialSubTab="backups"
            />
        );

        // 1. Unknown schedule: schedule could not be read
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockRejectedValue(new Error('HTTP 403: Forbidden'));
        let view!: ReturnType<typeof render>;
        await act(async () => { view = renderBackups(); });

        expect(await screen.findByText('Unknown')).toBeInTheDocument();
        expect(screen.getByText("The node's schedule could not be read, so it can't be changed from here right now.")).toBeInTheDocument();
        // No editable form controls and no save request
        expect(screen.queryByRole('checkbox', { name: /enable automated snapshots/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
        expect(nodeClient.updateNodeSnapshotSchedule).not.toHaveBeenCalled();
        view.unmount();

        // 2. Known schedule: node returns real values
        const realSchedule = { enabled: false, intervalHours: 12, keep: 3 };
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockResolvedValue(realSchedule);
        await act(async () => { view = renderBackups(); });

        expect(await screen.findByText('Disabled')).toBeInTheDocument();
        const checkbox = screen.getByRole('checkbox', { name: /enable automated snapshots/i }) as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        expect(screen.getByDisplayValue('Every 12 hours')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Keep last 3 snapshots')).toBeInTheDocument();

        // Saving sends exactly what is shown
        const saveButton = screen.getByRole('button', { name: /^save$/i });
        await act(async () => {
            fireEvent.click(saveButton);
        });

        expect(nodeClient.updateNodeSnapshotSchedule).toHaveBeenCalledTimes(1);
        expect(nodeClient.updateNodeSnapshotSchedule).toHaveBeenCalledWith(
            mockProfile.url,
            realSchedule,
            mockProfile.automationToken,
            // The fresh-proof code: none typed.
            undefined
        );
        view.unmount();
    });

    it('while the schedule is still being read it says so, never "could not be read"', async () => {
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockReturnValue(new Promise(() => {}));
        let view!: ReturnType<typeof render>;
        await act(async () => {
            view = render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });
        expect(await screen.findByText("Reading the node's schedule…")).toBeInTheDocument();
        expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
        view.unmount();
    });

    it('backup schedule holds at 320px with 130% text in unknown and known states', async () => {
        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockRejectedValue(new Error('HTTP 403'));
        let view!: ReturnType<typeof render>;
        await act(async () => {
            view = render(
                <div style={{ width: 320, fontSize: '130%' }}>
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="backups"
                    />
                </div>
            );
        });
        expect(await screen.findByText("The node's schedule could not be read, so it can't be changed from here right now.")).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
        view.unmount();

        vi.spyOn(nodeClient, 'fetchNodeSnapshotSchedule').mockResolvedValue({ enabled: true, intervalHours: 24, keep: 7 });
        await act(async () => {
            view = render(
                <div style={{ width: 320, fontSize: '130%' }}>
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="backups"
                    />
                </div>
            );
        });
        expect(await screen.findByRole('button', { name: /^save$/i })).toBeInTheDocument();
        view.unmount();
    });

    it('manages automated backup schedule and verifies database integrity', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });

        expect(screen.getByText('Automated Backup Schedule')).toBeInTheDocument();
        expect(screen.getByText('Database Integrity Verification')).toBeInTheDocument();

        // Run live integrity check
        const verifyButton = screen.getByRole('button', { name: /verify live database/i });
        await act(async () => {
            fireEvent.click(verifyButton);
        });

        expect(nodeClient.verifyNodeBackup).toHaveBeenCalledWith(
            mockProfile.url,
            undefined,
            mockProfile.automationToken
        );
        expect(screen.getByText(/Database verified, no corruption \(PRAGMA integrity_check: ok\)/i)).toBeInTheDocument();
    });

    const renderAccess = (rolesViewer: React.ComponentProps<typeof ApplianceSection>['rolesViewer']) => render(
        <ApplianceSection
            activeNode={mockProfile}
            diag={mockDiag}
            gateway={mockGateway}
            gatewayLoading={false}
            gatewaySuccess={null}
            gatewaySaving={false}
            nodeLogs={[]}
            onChangeGateway={vi.fn()}
            onSaveGateway={vi.fn()}
            onRefreshDiag={vi.fn()}
            onRefreshLogs={vi.fn()}
            onDownloadBackup={vi.fn()}
            onRunLedgerAudit={vi.fn()}
            auditState={{ running: false, result: null }}
            initialSubTab="access"
            rolesViewer={rolesViewer}
        />
    );
    /** fetch answering `route` with `answer`; every other call an empty 200. */
    const fakeFetch = (route: string, answer: unknown) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes(route)) return new Response(JSON.stringify(answer), { status: 200 });
        return new Response('{}', { status: 200 });
    });

    it('an owner key makes a break-glass code from the Access tab, shown once', async () => {
        const fetchSpy = fakeFetch('/api/local/admin/auth/break-glass/issue', { success: true, breakGlassCode: 'bg-a1b2-c3d4-e5f6-7890', memberPubkey: 'o'.repeat(64) });
        await act(async () => { renderAccess({ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }); });
        expect(screen.getByText('Break-Glass Emergency Recovery')).toBeInTheDocument();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Make a break-glass code/i })); });
        const call = fetchSpy.mock.calls.find(c => String(c[0]).includes('/api/local/admin/auth/break-glass/issue'));
        expect(call).toBeTruthy();
        expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({});
        expect(screen.getByTestId('break-glass-code')).toHaveTextContent('bg-a1b2-c3d4-e5f6-7890');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /I have kept it safe/i })); });
        expect(screen.queryByText('bg-a1b2-c3d4-e5f6-7890')).not.toBeInTheDocument();
    });

    it('the Access tab carries the Automation tokens card for an owner and not for an admin', async () => {
        fakeFetch('/api/local/admin/automation-tokens', { tokens: [], scopes: ['read', 'backups', 'admin'] });
        let view: ReturnType<typeof renderAccess>;
        await act(async () => { view = renderAccess({ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }); });
        expect(screen.getByText('Automation tokens')).toBeInTheDocument();
        view!.unmount();
        await act(async () => { renderAccess({ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }); });
        expect(screen.queryByText('Automation tokens')).not.toBeInTheDocument();
    });

    it('a token viewer is told an owner makes a break-glass code from their own phone: no button, no owner-key field, no request', async () => {
        const fetchSpy = fakeFetch('/api/local/admin/auth/break-glass/issue', { success: true, breakGlassCode: 'bg-0000-1111-2222-3333' });
        await act(async () => { renderAccess({ kind: 'token' }); });
        expect(screen.getByText('An owner makes a break-glass code from their own phone: Settings, Community admin, Break-glass code in the BeanPool app.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Make a break-glass code/i })).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/Owner's member key/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Only an owner has a break-glass code/i)).not.toBeInTheDocument();
        expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('/api/local/admin/auth/break-glass/issue'))).toBe(false);
    });

    it('an admin sees no break-glass button and no 2FA card; an admin is told only an owner has a code', async () => {
        fakeFetch('/never', {});
        await act(async () => { renderAccess({ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }); });
        expect(screen.getByText(/Only an owner has a break-glass code/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Make a break-glass code/i })).not.toBeInTheDocument();
        expect(screen.queryByText('Two-Factor Authentication (2FA)')).not.toBeInTheDocument();
    });

    it('sends no password when checking for updates: an empty body, and the token as a Bearer', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="diagnostics"
                />
            );
        });

        const checkUpdateBtn = screen.getByRole('button', { name: /check release updates/i });
        await act(async () => {
            fireEvent.click(checkUpdateBtn);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/admin/check-update'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({}),
                headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
            })
        );
        const checkCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/api/admin/check-update'));
        expect(checkCall[1].headers['X-Admin-Password']).toBeUndefined();
    });

    it('sends the callsign, and no password, in body when saving node identity in identity tab', async () => {
        // The contacts come from the admin route; this node has none stored, so the empty boxes are what it has. The node
        // config read answers its directory settings, as a node does: a Save sends back only the settings it read.
        const generic = global.fetch as any;
        const nodeConfig = {
            publishLocation: true, publishMembers: true, publishContactEmail: false, publishContactPhone: false,
            publishHealth: true, directoryPushIntervalHours: 12, lastDirectoryPush: null, serviceRadius: null,
        };
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: unknown) => (String(url).includes('/api/local/admin/diagnostics')
            ? Promise.resolve({ ok: true, json: () => Promise.resolve({ ...mockDiag, contactEmail: null, contactPhone: null }) })
            : String(url).includes('/api/node/config') && !String(url).includes('/admin/')
            ? Promise.resolve({ ok: true, json: () => Promise.resolve(nodeConfig) })
            : generic(url, init))));
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="identity"
                />
            );
        });
        await waitFor(() => expect(document.getElementById('contact-email')).not.toBeDisabled());

        const saveIdentityBtn = screen.getByRole('button', { name: /save identity/i });
        await act(async () => {
            fireEvent.click(saveIdentityBtn);
        });

        const updateCall = (global.fetch as any).mock.calls.find((call: any[]) =>
            call[0].includes('/api/local/update-identity')
        );
        expect(updateCall).toBeDefined();
        const payload = JSON.parse(updateCall[1].body);
        expect(payload).toEqual({
            callsign: mockDiag.callsign,
            communityName: mockDiag.communityName,
            contactEmail: '',
            contactPhone: '',
        });
        expect('lat' in payload).toBe(false);
        expect('lng' in payload).toBe(false);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/node/config'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    directoryPushIntervalHours: 12,
                    serviceRadius: null,
                    // The card's town or area (front doors S15), saved with the area: none typed clears it.
                    areaName: null,
                }),
            })
        );
    });

    it('sends the peer address, and no password, in body when adding peer connector', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="gateway"
                />
            );
        });

        const peerInput = screen.getByLabelText(/Peer Address/i);
        fireEvent.change(peerInput, { target: { value: 'wss://peer.example.org:8443' } });

        const connectBtn = screen.getByRole('button', { name: /add peer/i });
        await act(async () => {
            fireEvent.click(connectBtn);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/connectors/connect'),
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    address: 'wss://peer.example.org:8443',
                }),
            })
        );
    });

    it('sends raw binary body instead of FormData when restoring, with no window confirm(): the first upload only reads the header', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });

        const dummyFile = new File(['fake-sealed-data'], 'beanpool-backup.bpsealed');
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).toBeInTheDocument();

        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [dummyFile] } });
        });

        const restoreSubmitBtn = screen.getByRole('button', { name: /restore from backup/i });
        await act(async () => {
            fireEvent.click(restoreSubmitBtn);
        });

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/local/admin/restore'),
            expect.objectContaining({
                method: 'POST',
                // The token as a Bearer and nothing else (no admin password, and no Content-Type: the file is the body).
                headers: { Authorization: `Bearer ${TOKEN}` },
                body: dummyFile,
            })
        );
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('sealed backups only: the file picker asks for .bpsealed, and a plain archive gets the server\'s words and its shell command', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/restore')) {
                return Promise.resolve({
                    ok: false, status: 400,
                    json: () => Promise.resolve({
                        error: 'Backups that are not locked no longer restore from Settings: make a recovery code so every backup is '
                            + 'locked. An old unlocked file restores on the server itself with `beanpool restore --unlocked FILE`. Nothing was changed.',
                        notLocked: true, command: 'beanpool restore --unlocked FILE',
                    }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
        }));
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });
        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput.accept).toBe('.bpsealed');
        expect(screen.getByText(/Restore this server from a locked backup \(\.bpsealed\)/)).toBeInTheDocument();
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [new File(['tar'], 'backup.tar.gz', { type: 'application/gzip' })] } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /restore from backup/i }));
        });
        const status = await screen.findByTestId('restore-status');
        expect(status.textContent).toContain('Backups that are not locked no longer restore from Settings');
        expect(status.textContent).toContain('On the server: beanpool restore --unlocked FILE');
        expect(screen.queryByTestId('restore-locked-backup')).toBeNull();
    });

    it('a restore that came back SHORT of photos says so, instead of a flat success (round 4)', async () => {
        // This path answers 200 directly — no locked-backup hand-off — and used to set
        // 'Database successfully restored!' without reading the body at all. A harvested short backup
        // restored through the fleet manager therefore showed a clean success over a node whose photos
        // would 503. Same `shortfall` helper as RestoreLockedBackup, one more call site.
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/restore')) {
                return Promise.resolve({
                    ok: true, status: 200,
                    json: () => Promise.resolve({
                        success: true,
                        complete: false,
                        images: { restored: 411, error: null, referenced: 412, missing: 1, missingKeys: ['attachments/m-9.bin'], labelledShort: true },
                        warning: 'The backup was SHORT: 1 of the 412 photo(s) or attachment(s) this database '
                            + 'references were already gone from the node when the backup was taken, and are not '
                            + 'coming back. Everything else came back.',
                    }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
        }));

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [new File(['tar'], 'backup.tar.gz', { type: 'application/gzip' })] } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /restore from backup/i }));
        });

        const status = await screen.findByTestId('restore-status');
        expect(status.textContent).toMatch(/1 of the 412 photo\(s\) or attachment\(s\)/);
        expect(status.textContent).toContain('The server restarts now; sign in again.');
    });

    it('a restore that came back whole says so, with the restore point it kept and the restart (design case 18 §3.4)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/restore')) {
                return Promise.resolve({
                    ok: true, status: 200,
                    json: () => Promise.resolve({
                        success: true, complete: true,
                        images: { restored: 412, error: null, referenced: 412, missing: 0, missingKeys: [], labelledShort: false },
                        restorePointNote: 'Restore point 2026-10-16T02-30-00.123Z-before-restore is kept until at least 2026-10-23.',
                        restartNote: 'The server restarts now; sign in again.',
                    }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
        }));

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [new File(['tar'], 'backup.tar.gz', { type: 'application/gzip' })] } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /restore from backup/i }));
        });

        expect(await screen.findByText('Backup restored. Restore point 2026-10-16T02-30-00.123Z-before-restore is kept until at least 2026-10-23. The server restarts now; sign in again.')).toBeInTheDocument();
    });

    it('a locked backup (.bpsealed) turns the wizard to "open it": the recovery code or an owner\'s phone (slice 6)', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/restore')) {
                return Promise.resolve({
                    ok: false, status: 400,
                    json: () => Promise.resolve({
                        error: "This backup is locked. To open it, type recovery code #1, or open it with an owner's phone.",
                        needsRecoveryCode: true, ownerPhoneCanOpen: true,
                        backup: { envelopeId: 'e'.repeat(32), createdAt: '2026-09-19T10:00:00.000Z', opensWith: '@anna, recovery code #1' },
                    }),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
        }));

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                />
            );
        });

        const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput.accept).toContain('.bpsealed');
        await act(async () => {
            fireEvent.change(fileInput, { target: { files: [new File(['sealed'], 'beanpool-backup.bpsealed')] } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /restore from backup/i }));
        });

        expect(await screen.findByTestId('restore-locked-backup')).toBeInTheDocument();
        expect(screen.getByText('Restore this backup?')).toBeInTheDocument();
        expect(screen.getByText('@anna, recovery code #1')).toBeInTheDocument();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: "Open with an owner's phone" })).toBeInTheDocument();
        expect(screen.getByLabelText(/printed recovery code/)).toBeInTheDocument();
    });

    // A node has no admin password and no server 2FA: Access & Security draws neither card, at 320px with 130% text.
    it('Access & Security draws no password card, no 2FA card and no retire card, and never asks the node about 2FA', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
        await act(async () => {
            render(
                <div style={{ width: 320, fontSize: '130%' }}>
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="access"
                        rolesViewer={{ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }}
                    />
                </div>
            );
        });
        // The rest of the tab is still there.
        expect(await screen.findByText('Break-Glass Emergency Recovery')).toBeInTheDocument();
        expect(screen.getByText('Automation tokens')).toBeInTheDocument();
        // The old one-line "no server 2FA" notice went with the cards it stood in for.
        expect(screen.queryByTestId('no-server-2fa')).not.toBeInTheDocument();
        expect(screen.queryByText('Two-Factor Authentication (2FA)')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /setup 2fa authenticator/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /disable 2fa/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /show new backup codes/i })).not.toBeInTheDocument();
        expect(screen.queryByText('Change Admin Password')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /update password/i })).not.toBeInTheDocument();
        expect(screen.queryByText(/Retire the admin password/i)).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Type RETIRE to confirm')).not.toBeInTheDocument();
        const urls = fetchSpy.mock.calls.map(c => String(c[0]));
        expect(urls.filter(u => /\/2fa\/|change-password|retire-password|password-retirement/.test(u))).toEqual([]);
    });

    // The Break-Glass card says what the server does with a code (admin-auth.ts: the enrol routes only; admin-key-auth.ts
    // enrolAdminOwnerKey: every member is told, the node's log keeps it), in plain words, with no spec badge or quoted spec.
    it('the Break-Glass card says in plain words what a code does and what is recorded when one is used, and carries no spec badge', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
        await act(async () => {
            render(
                <div style={{ width: 320, fontSize: '130%' }}>
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="access"
                        rolesViewer={{ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }}
                    />
                </div>
            );
        });
        expect(await screen.findByText('Break-Glass Emergency Recovery')).toBeInTheDocument();
        expect(screen.getByTestId('break-glass-what')).toHaveTextContent('A break-glass code does one thing, it enrols a new key, and it opens nothing else in Settings.');
        expect(screen.getByTestId('break-glass-audit')).toHaveTextContent("When one is used, every member gets a notice that a new admin key was authorised and for whom, and the node's log records it.");
        // The spec badge and the quoted specification paragraph are gone.
        expect(screen.queryByText(/Phase 3/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Specification/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/Audit Trail Safeguard/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/exactly one thing/i)).not.toBeInTheDocument();
        expect(document.querySelector('blockquote')).toBeNull();
        // The button to make a code is still there for an owner's own key.
        expect(screen.getByRole('button', { name: 'Make a break-glass code' })).toBeInTheDocument();
    });

    it('surfaces error cleanly when update check returns HTTP error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/admin/check-update')) {
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    json: () => Promise.resolve({ error: "Wrong or missing token for this node — check it under the node's settings." }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ connectors: [] }),
            });
        }));

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                />
            );
        });

        const checkBtn = screen.getByRole('button', { name: /check release updates/i });
        await act(async () => {
            fireEvent.click(checkBtn);
        });

        expect(screen.getByText(/Update check failed: Wrong or missing token for this node/i)).toBeInTheDocument();
        expect(screen.queryByText(/✓ Up to date/i)).not.toBeInTheDocument();
    });

    it('has no way to wipe the node or delete a snapshot: the server removed both routes (owner-delete S1, design case 18 A1/A3)', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm');
        const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) }));
        vi.stubGlobal('fetch', fetchSpy);
        vi.spyOn(nodeClient, 'fetchNodeSnapshots').mockResolvedValue([{ name: 'snapshot-2026-10-16.db', sizeBytes: 2048, createdAt: '2026-10-16T01:00:00Z' }]);

        for (const tab of ['access', 'backups'] as const) {
            let view!: ReturnType<typeof render>;
            await act(async () => {
                view = render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab={tab}
                    />
                );
            });
            expect(screen.queryByText(/Danger Zone/i)).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /wipe|reset node|factory reset/i })).not.toBeInTheDocument();
            if (tab === 'backups') {
                expect(await screen.findByText('snapshot-2026-10-16.db')).toBeInTheDocument();
                expect(screen.getByRole('button', { name: /^verify$/i })).toBeInTheDocument();
                expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
            }
            view.unmount();
        }
        const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
        expect(urls.filter((u) => /\/api\/local\/reset|snapshots\/delete/.test(u))).toEqual([]);
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('remounts NodeIdentityPanel when activeNode changes in identity subtab', async () => {
        const otherNode: NodeProfile = {
            id: 'node-2',
            name: 'Second Node',
            url: 'https://node-2.local',
            automationToken: 'node-2-password',
        };

        const { rerender } = render(
            <ApplianceSection
                activeNode={mockProfile}
                diag={mockDiag}
                gateway={mockGateway}
                gatewayLoading={false}
                gatewaySuccess={null}
                gatewaySaving={false}
                nodeLogs={[]}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
                onRefreshDiag={vi.fn()}
                onRefreshLogs={vi.fn()}
                onDownloadBackup={vi.fn()}
                onRunLedgerAudit={vi.fn()}
                auditState={{ running: false, result: null }}
                initialSubTab="identity"
            />
        );

        expect(screen.getByRole('heading', { level: 3, name: /Node Identity/i })).toBeInTheDocument();

        // Rerender with second node profile
        await act(async () => {
            rerender(
                <ApplianceSection
                    activeNode={otherNode}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="identity"
                />
            );
        });

        expect(screen.getByRole('heading', { level: 3, name: /Node Identity/i })).toBeInTheDocument();
    });

    it('renders Addresses panel when navigating to network subtab', async () => {
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            const strUrl = String(url);
            if (strUrl.includes('/api/local/admin/app-addresses')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({ primaryAddress: 'test.beanpool.org', addresses: [] }),
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
                json: () => Promise.resolve({}),
            } as Response);
        });

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="network"
                />
            );
        });

        expect(screen.getByTestId('addresses-panel')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: /Addresses/i })).toBeInTheDocument();
        // Under the list: what it doesn't replace, as it was.
        expect(screen.getByTestId('public-address-panel')).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 3, name: /Public Address & DNS Tunnel/i })).toBeInTheDocument();
    });

    it('renders ReplicationAccessPanel and hides StandbyReplicationPanel on primary nodes', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                    isStandby={false}
                />
            );
        });

        expect(screen.getByRole('heading', { name: /Replication Access/i })).toBeInTheDocument();
        expect(screen.queryByText('Live Backup Server & Hot-Standby Replication')).not.toBeInTheDocument();
    });

    it('renders StandbyReplicationPanel and hides ReplicationAccessPanel on standby replicas', async () => {
        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="backups"
                    isStandby={true}
                />
            );
        });

        expect(screen.getByText('Live Backup Server & Hot-Standby Replication')).toBeInTheDocument();
        expect(screen.queryByText('Replication Access & Read-Only Snapshots')).not.toBeInTheDocument();
    });

    it('renders disk health breakdown and 80% warning banner when disk capacity is high', async () => {
        const mockDiskHealthDiag: DiagnosticsResponse = {
            ...mockDiag,
            diskHealth: {
                totalBytes: 64 * 1024 * 1024 * 1024,
                freeBytes: 10 * 1024 * 1024 * 1024,
                usedBytes: 54 * 1024 * 1024 * 1024,
                usedPercent: 84,
                warning: true,
                databaseBytes: 15 * 1024 * 1024,
                mediaBytes: 40 * 1024 * 1024 * 1024,
                logsBytes: 200 * 1024 * 1024,
                breakdown: {
                    database: {
                        dbSizeBytes: 10 * 1024 * 1024,
                        walSizeBytes: 2 * 1024 * 1024,
                        shmSizeBytes: 0,
                        snapshotsSizeBytes: 3 * 1024 * 1024,
                        totalBytes: 15 * 1024 * 1024,
                    },
                    media: {
                        postPhotosBytes: 38 * 1024 * 1024 * 1024,
                        postPhotosCount: 142,
                        pulseThumbnailsBytes: 2 * 1024 * 1024 * 1024,
                        pulseThumbnailsCount: 56,
                        totalBytes: 40 * 1024 * 1024 * 1024,
                    },
                    logs: {
                        systemLogsBytes: 150 * 1024 * 1024,
                        systemLogsCount: 4200,
                        logFilesBytes: 50 * 1024 * 1024,
                        totalBytes: 200 * 1024 * 1024,
                    },
                },
            },
        };

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiskHealthDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="diagnostics"
                />
            );
        });

        // Disk Health card header
        expect(screen.getByText('Disk Health & Storage Breakdown')).toBeInTheDocument();
        // 80% Warning Banner
        expect(screen.getByText(/High Disk Usage Warning:/i)).toBeInTheDocument();
        expect(screen.getByText(/Disk utilization is at 84% \(exceeds 80% safety threshold\)/i)).toBeInTheDocument();
        // Breakdown sections
        expect(screen.getByText('Database')).toBeInTheDocument();
        expect(screen.getByText('Media')).toBeInTheDocument();
        expect(screen.getByText('Logs')).toBeInTheDocument();
        expect(screen.getByText(/Post photos \(142\):/i)).toBeInTheDocument();
        expect(screen.getByText(/Thumbnails \(56\):/i)).toBeInTheDocument();
        expect(screen.getByText(/System events \(4200\):/i)).toBeInTheDocument();
    });

    it('opens clean preview modal and executes cleanup with details', async () => {
        vi.spyOn(nodeClient, 'fetchStorageCleanPreview').mockResolvedValue({
            success: true,
            preview: {
                orphanedPostPhotos: { count: 3, totalBytes: 15 * 1024 * 1024 },
                orphanedThumbnails: { count: 7, totalBytes: 2 * 1024 * 1024 },
                compressibleLogs: { count: 850, totalBytes: 25 * 1024 * 1024 },
                totalReclaimableBytes: 42 * 1024 * 1024,
            },
        });

        vi.spyOn(nodeClient, 'cleanStorageAndCompressLogs').mockResolvedValue({
            success: true,
            removedPhotosCount: 3,
            removedPhotosBytes: 15 * 1024 * 1024,
            removedThumbnailsCount: 7,
            removedThumbnailsBytes: 2 * 1024 * 1024,
            compressedLogsCount: 850,
            compressedLogsBytes: 25 * 1024 * 1024,
            totalReclaimedBytes: 42 * 1024 * 1024,
        });

        const onRefreshDiagMock = vi.fn();

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={onRefreshDiagMock}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="diagnostics"
                />
            );
        });

        // Click Clean button to open preview modal
        const cleanBtn = screen.getByRole('button', { name: /Clean Orphaned Media & Compress Logs/i });
        await act(async () => {
            fireEvent.click(cleanBtn);
        });

        expect(nodeClient.fetchStorageCleanPreview).toHaveBeenCalledWith(
            mockProfile.url,
            mockProfile.automationToken
        );

        // Preview should show item counts and sizes
        expect(screen.getByText('3 items')).toBeInTheDocument();
        expect(screen.getByText('7 items')).toBeInTheDocument();
        expect(screen.getByText('850 rows')).toBeInTheDocument();
        expect(screen.getByText('42.0 MB')).toBeInTheDocument();

        // Confirm & Clean Now
        const confirmBtn = screen.getByRole('button', { name: /Confirm & Clean Now/i });
        await act(async () => {
            fireEvent.click(confirmBtn);
        });

        expect(nodeClient.cleanStorageAndCompressLogs).toHaveBeenCalledWith(
            mockProfile.url,
            mockProfile.automationToken
        );
        expect(screen.getByText(/Cleanup Complete!/i)).toBeInTheDocument();
        expect(screen.getByText(/Successfully reclaimed/i)).toBeInTheDocument();
        expect(onRefreshDiagMock).toHaveBeenCalled();
    });

    it('a Clean that stopped with stored images left says how many remain, never "complete"', async () => {
        vi.spyOn(nodeClient, 'fetchStorageCleanPreview').mockResolvedValue({
            success: true,
            preview: {
                orphanedPostPhotos: { count: 0, totalBytes: 0 },
                orphanedImageObjects: { count: 1200, totalBytes: 60 * 1024 * 1024 },
                orphanedThumbnails: { count: 0, totalBytes: 0 },
                compressibleLogs: { count: 0, totalBytes: 0 },
                totalReclaimableBytes: 60 * 1024 * 1024,
            },
        });
        vi.spyOn(nodeClient, 'cleanStorageAndCompressLogs').mockResolvedValue({
            success: true,
            removedPhotosCount: 0,
            removedPhotosBytes: 0,
            removedImageObjectsCount: 205,
            removedImageObjectsBytes: 10 * 1024 * 1024,
            remainingImageObjectsCount: 995,
            remainingImageObjectsBytes: 50 * 1024 * 1024,
            removedThumbnailsCount: 0,
            removedThumbnailsBytes: 0,
            compressedLogsCount: 0,
            compressedLogsBytes: 0,
            totalReclaimedBytes: 10 * 1024 * 1024,
        });

        await act(async () => {
            render(
                <ApplianceSection
                    activeNode={mockProfile}
                    diag={mockDiag}
                    gateway={mockGateway}
                    gatewayLoading={false}
                    gatewaySuccess={null}
                    gatewaySaving={false}
                    nodeLogs={[]}
                    onChangeGateway={vi.fn()}
                    onSaveGateway={vi.fn()}
                    onRefreshDiag={vi.fn()}
                    onRefreshLogs={vi.fn()}
                    onDownloadBackup={vi.fn()}
                    onRunLedgerAudit={vi.fn()}
                    auditState={{ running: false, result: null }}
                    initialSubTab="diagnostics"
                />
            );
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Clean Orphaned Media & Compress Logs/i }));
        });
        expect(screen.getByText('1200 objects')).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Confirm & Clean Now/i }));
        });

        expect(screen.queryByText(/Cleanup Complete!/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Cleanup started: more to remove/i)).toBeInTheDocument();
        expect(screen.getByText(/Removed 205 unreferenced stored photos and attachments/i)).toBeInTheDocument();
        expect(screen.getByText('995 more')).toBeInTheDocument();
        expect(screen.getByText(/keeps removing them in the/i)).toBeInTheDocument();
    });

    describe('Node version and check-update resolution', () => {
        it('shows the real version from diagnostics and never a hardcoded fallback', async () => {
            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={{ ...mockDiag, version: '1.2.28' }}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });
            expect(screen.getByText('v1.2.28')).toBeInTheDocument();
            expect(screen.queryByText(/1\.4\.2/)).not.toBeInTheDocument();
        });

        it('shows nothing rather than a number when diag has no version', async () => {
            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={{ ...mockDiag, version: undefined }}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });
            expect(screen.queryByText(/v\d+\.\d+\.\d+/)).not.toBeInTheDocument();
            expect(screen.queryByText(/1\.4\.2/)).not.toBeInTheDocument();
        });

        it('updates with real version from check-update, and omits number when none is answered', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: false, currentVersion: '1.2.28' }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getByText(/Up to date \(current release: v1\.2\.28\)/i)).toBeInTheDocument();
            expect(screen.getByText('v1.2.28')).toBeInTheDocument();
            expect(screen.queryByText(/1\.4\.2/)).not.toBeInTheDocument();
        });

        it('shows Up to date without number when check-update gives no currentVersion', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: false }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getAllByText('Up to date').length).toBeGreaterThanOrEqual(1);
            expect(screen.queryByText(/current release/i)).not.toBeInTheDocument();
            expect(screen.queryByText(/1\.4\.2/)).not.toBeInTheDocument();
        });

        it('prioritizes checkedVersion over diag.version when check-update returns a newer version', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: false, currentVersion: '1.2.29' }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={{ ...mockDiag, version: '1.2.28' }}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            expect(screen.getByText('v1.2.28')).toBeInTheDocument();

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getByText('v1.2.29')).toBeInTheDocument();
            expect(screen.queryByText('v1.2.28')).not.toBeInTheDocument();
        });

        it('resets checkedVersion and update state when activeNode changes', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: false, currentVersion: '1.2.29' }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            let rerenderFn: any;
            await act(async () => {
                const { rerender } = render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={{ ...mockDiag, version: '1.2.28' }}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
                rerenderFn = rerender;
            });

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getByText('v1.2.29')).toBeInTheDocument();
            expect(screen.getByText(/current release: v1\.2\.29/i)).toBeInTheDocument();

            const mockProfile2 = { ...mockProfile, id: 'node-secondary-99', url: 'http://node2.local:3000' };
            await act(async () => {
                rerenderFn(
                    <ApplianceSection
                        activeNode={mockProfile2}
                        diag={{ ...mockDiag, version: '1.2.25' }}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            expect(screen.getByText('v1.2.25')).toBeInTheDocument();
            expect(screen.queryByText('v1.2.29')).not.toBeInTheDocument();
            expect(screen.queryByText(/current release: v1\.2\.29/i)).not.toBeInTheDocument();
        });

        it('formats update available message cleanly without orphaned prefix when latestVersion is omitted', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: true, currentVersion: '1.2.28' }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getByText('Update Available (current: v1.2.28)')).toBeInTheDocument();
            expect(screen.queryByText(/Update Available: v/)).not.toBeInTheDocument();
        });

        it('formats update available message with latest and current versions when both provided', async () => {
            vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
                if (url.includes('/api/admin/check-update')) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ updateAvailable: true, latestVersion: '1.3.0', currentVersion: '1.2.28' }),
                    });
                }
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
            }));

            await act(async () => {
                render(
                    <ApplianceSection
                        activeNode={mockProfile}
                        diag={mockDiag}
                        gateway={mockGateway}
                        gatewayLoading={false}
                        gatewaySuccess={null}
                        gatewaySaving={false}
                        nodeLogs={[]}
                        onChangeGateway={vi.fn()}
                        onSaveGateway={vi.fn()}
                        onRefreshDiag={vi.fn()}
                        onRefreshLogs={vi.fn()}
                        onDownloadBackup={vi.fn()}
                        onRunLedgerAudit={vi.fn()}
                        auditState={{ running: false, result: null }}
                        initialSubTab="diagnostics"
                    />
                );
            });

            const checkBtn = screen.getByRole('button', { name: /check release updates/i });
            await act(async () => {
                fireEvent.click(checkBtn);
            });

            expect(screen.getByText('Update Available: v1.3.0 (current: v1.2.28)')).toBeInTheDocument();
        });
    });
});

