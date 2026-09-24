import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApplianceSection } from './ApplianceSection';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse, GatewayConfig } from '../../lib/node-client';
import * as nodeClient from '../../lib/node-client';

const mockProfile: NodeProfile = {
    id: 'test-node',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'admin-password',
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
    features: { marketplace: true, messaging: true, federation: true, invites: true, servePwa: true },
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
                currentVersion: '1.4.2',
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
            mockProfile.adminPassword,
            undefined
        );
        expect(screen.getByText(/Database verified, no corruption \(PRAGMA integrity_check: ok\)/i)).toBeInTheDocument();
    });

    it('renders break-glass placeholder card with admin-surface §2.2 explanation in Access tab', async () => {
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
                    initialSubTab="access"
                />
            );
        });

        expect(screen.getByText('Break-Glass Emergency Recovery')).toBeInTheDocument();
        expect(screen.getByText(/The break-glass credential can do exactly one thing: enrol a new admin key/i)).toBeInTheDocument();
        expect(screen.getByText(/Break-glass recovery used to authorise a new admin key for @callsign/i)).toBeInTheDocument();

        const placeholderButton = screen.getByRole('button', { name: /Enrol Device Key via Break-Glass/i });
        expect(placeholderButton).toBeDisabled();
    });

    it('sends password in POST body when checking for updates', async () => {
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
                body: JSON.stringify({ password: mockProfile.adminPassword }),
            })
        );
    });

    it('sends password and callsign in body when saving node identity in identity tab', async () => {
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
            password: mockProfile.adminPassword,
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
                    password: mockProfile.adminPassword,
                    publishLocation: true,
                    publishMembers: true,
                    publishContacts: true,
                    publishHealth: true,
                    directoryPushIntervalHours: 12,
                    serviceRadius: null,
                }),
            })
        );
    });

    it('sends password and peer address in body when adding peer connector', async () => {
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

        const peerInput = screen.getByPlaceholderText(/wss:\/\/peer\.beanpool\.org/i);
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
                    password: mockProfile.adminPassword,
                    address: 'wss://peer.example.org:8443',
                }),
            })
        );
    });

    it('sends raw binary body instead of FormData when restoring database archive', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);

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

        const dummyFile = new File(['fake-tarball-data'], 'backup.tar.gz', { type: 'application/gzip' });
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
                headers: { 'X-Admin-Password': mockProfile.adminPassword },
                body: dummyFile,
            })
        );
    });

    it('a plain restore that came back SHORT of photos says so, instead of a flat success (round 4)', async () => {
        // This path answers 200 directly — no locked-backup hand-off — and used to set
        // 'Database successfully restored!' without reading the body at all. A harvested short backup
        // restored through the fleet manager therefore showed a clean success over a node whose photos
        // would 503. Same `shortfall` helper as RestoreLockedBackup, one more call site.
        vi.spyOn(window, 'confirm').mockReturnValue(true);
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

        expect(await screen.findByText(/Restored, but not complete/)).toBeInTheDocument();
        expect(screen.getByText(/1 of the 412 photo\(s\) or attachment\(s\)/)).toBeInTheDocument();
        expect(screen.queryByText('Database successfully restored! State engine refreshed.')).not.toBeInTheDocument();
    });

    it('a plain restore that came back whole still reports a clean success', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/restore')) {
                return Promise.resolve({
                    ok: true, status: 200,
                    json: () => Promise.resolve({
                        success: true, complete: true,
                        images: { restored: 412, error: null, referenced: 412, missing: 0, missingKeys: [], labelledShort: false },
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

        expect(await screen.findByText('Database successfully restored! State engine refreshed.')).toBeInTheDocument();
    });

    it('a locked backup (.bpsealed) turns the wizard to "open it": the recovery code or an owner\'s phone (slice 6)', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
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
        expect(screen.getByText(/It opens with: @anna, recovery code #1/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: "Open with an owner's phone" })).toBeInTheDocument();
        expect(screen.getByLabelText(/printed recovery code/)).toBeInTheDocument();
    });

    it('correctly maps totpEnabled to enabled when rendering 2FA card in access subtab', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/2fa/status')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, totpEnabled: true }),
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
                    initialSubTab="access"
                />
            );
        });

        // 2FA status badge should display "Enabled"
        expect(screen.getByText('Enabled')).toBeInTheDocument();
        // Disable 2FA button should render
        expect(screen.getByRole('button', { name: /disable 2fa/i })).toBeInTheDocument();
    });

    // The node turns 2FA off only with a code that is right now (an earlier sign-in is not enough), so the card asks
    // for one and sends it, with the 2FA session and the password as every admin call does.
    async function renderAccessWith2faOn(disableResponse: { ok: boolean; status?: number; body: unknown }) {
        const fetchMock = vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/2fa/status')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, totpEnabled: true }) });
            }
            if (url.includes('/api/local/admin/2fa/disable')) {
                return Promise.resolve({
                    ok: disableResponse.ok,
                    status: disableResponse.status ?? (disableResponse.ok ? 200 : 401),
                    json: () => Promise.resolve(disableResponse.body),
                });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ connectors: [] }) });
        });
        vi.stubGlobal('fetch', fetchMock);
        nodeClient.setTfaSessionToken(mockProfile.id, 'tfa-session-abc');
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
                    initialSubTab="access"
                />
            );
        });
        const disableCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/local/admin/2fa/disable'));
        return { disableCalls };
    }

    it('shows 2FA as on when the status call answers 401 asking for a code (no 2FA session yet)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/2fa/status')) {
                return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: '2FA code required', totpRequired: true }) });
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
                    initialSubTab="access"
                />
            );
        });
        expect(screen.getByText('Enabled')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /setup 2fa authenticator/i })).not.toBeInTheDocument();
    });

    it('Disable 2FA asks for a current code and sends nothing without one', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { disableCalls } = await renderAccessWith2faOn({ ok: true, body: { success: true } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /disable 2fa/i }));
        });

        expect(disableCalls()).toHaveLength(0);
        expect(screen.getByText(/Enter a current code from your authenticator app/i)).toBeInTheDocument();
    });

    it('Disable 2FA sends the code with the 2FA session, and shows the node\'s refusal', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { disableCalls } = await renderAccessWith2faOn({ ok: false, status: 401, body: { error: 'Invalid 2FA code', totpRequired: true } });

        await act(async () => {
            fireEvent.change(screen.getByLabelText('Current 2FA or backup code'), { target: { value: ' 123456 ' } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /disable 2fa/i }));
        });

        expect(disableCalls()).toHaveLength(1);
        const [, init] = disableCalls()[0];
        expect(JSON.parse(init.body)).toEqual({ code: '123456' });
        expect(init.headers['X-Admin-2FA-Session']).toBe('tfa-session-abc');
        expect(init.headers['X-Admin-Password']).toBe(mockProfile.adminPassword);
        expect(screen.getByText('2FA was not turned off: Invalid 2FA code')).toBeInTheDocument();
        // Still on: the badge did not change.
        expect(screen.getByText('Enabled')).toBeInTheDocument();
    });

    it('Disable 2FA takes a backup code: no number-only keypad, and the code is sent as typed', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { disableCalls } = await renderAccessWith2faOn({ ok: true, body: { success: true } });
        const input = screen.getByLabelText('Current 2FA or backup code');
        // Backup codes are 8 hex characters (a–f): a phone's numeric keypad could not type them.
        expect(input.getAttribute('inputmode')).not.toBe('numeric');

        await act(async () => {
            fireEvent.change(input, { target: { value: 'a1b2c3d4' } });
        });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /disable 2fa/i }));
        });
        expect(disableCalls()).toHaveLength(1);
        expect(JSON.parse(disableCalls()[0][1].body)).toEqual({ code: 'a1b2c3d4' });
    });

    it('surfaces error cleanly when update check returns HTTP error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/admin/check-update')) {
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    json: () => Promise.resolve({ error: 'Invalid password' }),
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

        expect(screen.getByText(/Update check failed: Invalid password/i)).toBeInTheDocument();
        expect(screen.queryByText(/✓ Up to date/i)).not.toBeInTheDocument();
    });

    it('alerts error and does not reload window when factory reset fails', async () => {
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/reset')) {
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    json: () => Promise.resolve({ error: 'Unauthorized reset attempt' }),
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
                    initialSubTab="access"
                />
            );
        });

        const resetBtn = screen.getByRole('button', { name: /wipe & reset node/i });
        await act(async () => {
            fireEvent.click(resetBtn);
        });

        expect(alertSpy).toHaveBeenCalledWith('Node reset failed: Unauthorized reset attempt');
    });

    it('stores issued 2FA session token upon successful 2FA verification to prevent lockout', async () => {
        const setTokenSpy = vi.spyOn(nodeClient, 'setTfaSessionToken');
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/2fa/setup')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        qrDataUrl: 'data:image/png;base64,mockqr',
                        secret: 'JBSWY3DPEHPK3PXP',
                    }),
                });
            }
            if (url.includes('/api/local/admin/2fa/verify')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        success: true,
                        totpEnabled: true,
                        tfaSessionToken: 'mock-tfa-session-token-12345',
                    }),
                });
            }
            if (url.includes('/api/local/admin/2fa/status')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ success: true, totpEnabled: false }),
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
                    initialSubTab="access"
                />
            );
        });

        // Click setup button to show the verify input
        const setupBtn = screen.getByRole('button', { name: /setup 2fa authenticator/i });
        await act(async () => {
            fireEvent.click(setupBtn);
        });

        // Enter totp code
        const codeInput = screen.getByPlaceholderText('Enter 6-digit code to verify');
        fireEvent.change(codeInput, { target: { value: '123456' } });

        const verifyBtn = screen.getByRole('button', { name: /verify & enable/i });
        await act(async () => {
            fireEvent.click(verifyBtn);
        });

        expect(setTokenSpy).toHaveBeenCalledWith(mockProfile.id, 'mock-tfa-session-token-12345');
        expect(sessionStorage.getItem('bp-2fa-session')).toBe('mock-tfa-session-token-12345');
    });

    it('remounts NodeIdentityPanel when activeNode changes in identity subtab', async () => {
        const otherNode: NodeProfile = {
            id: 'node-2',
            name: 'Second Node',
            url: 'https://node-2.local',
            adminPassword: 'node-2-password',
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

    it('renders Public Address panel when navigating to network subtab', async () => {
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
            mockProfile.adminPassword,
            undefined
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
            mockProfile.adminPassword,
            undefined
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
});

