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
});
