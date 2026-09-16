import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse, GatewayConfig, SnapshotItem, SnapshotScheduleConfig, BackupVerificationResult, DiskHealth, StorageCleanPreview, StorageCleanResult } from '../../lib/node-client';
import {
    fetchNodeSnapshots,
    createNodeSnapshot,
    deleteNodeSnapshot,
    fetchNodeSnapshotSchedule,
    updateNodeSnapshotSchedule,
    verifyNodeBackup,
    resolveNodeApiUrl,
    buildAdminHeaders,
    getTfaSessionToken,
    setTfaSessionToken,
    fetchDiskHealth,
    fetchStorageCleanPreview,
    cleanStorageAndCompressLogs,
} from '../../lib/node-client';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import { PublicAddressPanel } from './PublicAddressPanel';
import { PeerConnectorsPanel } from './PeerConnectorsPanel';
import { StandbyReplicationPanel } from './StandbyReplicationPanel';
import { ReplicationAccessPanel } from './ReplicationAccessPanel';
import { SectionErrorBoundary } from '../common/SectionErrorBoundary';
import { LogsModule, type LogEntry } from './LogsModule';
import { GatewayModule } from './GatewayModule';

interface ApplianceSectionProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    gateway: GatewayConfig | null;
    gatewayLoading: boolean;
    gatewaySuccess: string | null;
    gatewaySaving: boolean;
    nodeLogs: LogEntry[];
    onChangeGateway: (updated: GatewayConfig) => void;
    onSaveGateway: () => void;
    onRefreshDiag: () => void;
    onRefreshLogs: () => void;
    onDownloadBackup: () => Promise<void>;
    onRunLedgerAudit: () => Promise<void>;
    auditState: { running: boolean; result: { ok: boolean; drift: number; sumBalances?: number; baseline?: number; strandedEscrows?: number } | null };
    initialSubTab?: 'diagnostics' | 'backups' | 'gateway' | 'network' | 'identity' | 'access';
    isStandby?: boolean;
}

export function ApplianceSection({
    activeNode,
    diag,
    gateway,
    gatewayLoading,
    gatewaySuccess,
    gatewaySaving,
    nodeLogs,
    onChangeGateway,
    onSaveGateway,
    onRefreshDiag,
    onRefreshLogs,
    onDownloadBackup,
    onRunLedgerAudit,
    auditState,
    initialSubTab = 'diagnostics',
    isStandby: propIsStandby,
}: ApplianceSectionProps) {
    const [subTab, setSubTab] = useState<'diagnostics' | 'backups' | 'gateway' | 'network' | 'identity' | 'access'>(initialSubTab);
    const [backupRole, setBackupRole] = useState<'primary' | 'backup' | null>(null);

    useEffect(() => {
        let active = true;
        async function fetchBackupRole() {
            try {
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/backup-status');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                    body: JSON.stringify({ password: activeNode.adminPassword }),
                }).catch(() => null);
                if (res && res.ok) {
                    const data = await res.json().catch(() => ({}));
                    if (active && data.role) {
                        setBackupRole(data.role.toLowerCase() === 'backup' ? 'backup' : 'primary');
                    }
                }
            } catch {
                // Ignore background fetch error
            }
        }
        fetchBackupRole();
        return () => { active = false; };
    }, [activeNode.id, activeNode.url, activeNode.adminPassword]);

    const isStandby = propIsStandby !== undefined
        ? propIsStandby
        : (backupRole ? backupRole === 'backup' : activeNode.isPrimary === false);

    // Snapshots & Backups state
    const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
    const [loadingSnapshots, setLoadingSnapshots] = useState(false);
    const [creatingSnapshot, setCreatingSnapshot] = useState(false);
    const [restoreFile, setRestoreFile] = useState<File | null>(null);
    const [restoring, setRestoring] = useState(false);
    const [restoreStatus, setRestoreStatus] = useState<string | null>(null);

    // Backup Schedule state
    const [scheduleConfig, setScheduleConfig] = useState<SnapshotScheduleConfig>({
        enabled: true,
        intervalHours: 24,
        keep: 7,
    });
    const [savingSchedule, setSavingSchedule] = useState(false);
    const [scheduleStatusMsg, setScheduleStatusMsg] = useState<string | null>(null);

    // Verification state
    const [verifying, setVerifying] = useState(false);
    const [verifyTarget, setVerifyTarget] = useState<string | null>(null);
    const [verifyResult, setVerifyResult] = useState<BackupVerificationResult | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);

    // Access & Password change state
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pwdStatus, setPwdStatus] = useState<{ text: string; isError: boolean } | null>(null);
    const [changingPwd, setChangingPwd] = useState(false);

    // 2FA state
    const [tfaStatus, setTfaStatus] = useState<{ enabled: boolean; qrDataUrl?: string; secret?: string } | null>(null);
    const [totpVerifyCode, setTotpVerifyCode] = useState('');
    const [tfaMessage, setTfaMessage] = useState<string | null>(null);

    // Update check state
    const [updateInfo, setUpdateInfo] = useState<string | null>(null);
    const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
    const [checkingUpdate, setCheckingUpdate] = useState(false);

    // Disk Health & Clean Storage state
    const [diskHealth, setDiskHealth] = useState<DiskHealth | null>(diag?.diskHealth || null);
    const [showCleanModal, setShowCleanModal] = useState(false);
    const [cleanPreview, setCleanPreview] = useState<StorageCleanPreview | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [cleaningStorage, setCleaningStorage] = useState(false);
    const [cleanResult, setCleanResult] = useState<StorageCleanResult | null>(null);
    const [cleanError, setCleanError] = useState<string | null>(null);

    useEffect(() => {
        if (diag?.diskHealth) {
            setDiskHealth(diag.diskHealth);
        }
    }, [diag?.diskHealth]);

    const formatBytes = (bytes?: number): string => {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    };

    const loadDiskHealth = async () => {
        try {
            const res = await fetchDiskHealth(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            if (res?.diskHealth) {
                setDiskHealth(res.diskHealth);
            }
        } catch {}
    };

    const handleOpenCleanModal = async () => {
        setShowCleanModal(true);
        setLoadingPreview(true);
        setCleanPreview(null);
        setCleanResult(null);
        setCleanError(null);
        try {
            const res = await fetchStorageCleanPreview(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setCleanPreview(res.preview);
        } catch (e: unknown) {
            setCleanError(e instanceof Error ? e.message : 'Failed to load storage clean preview');
        } finally {
            setLoadingPreview(false);
        }
    };

    const handleExecuteClean = async () => {
        setCleaningStorage(true);
        setCleanError(null);
        try {
            const res = await cleanStorageAndCompressLogs(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setCleanResult(res);
            onRefreshDiag();
            await loadDiskHealth();
        } catch (e: unknown) {
            setCleanError(e instanceof Error ? e.message : 'Failed to clean storage');
        } finally {
            setCleaningStorage(false);
        }
    };

    const loadSnapshots = async () => {
        setLoadingSnapshots(true);
        try {
            const list = await fetchNodeSnapshots(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setSnapshots(Array.isArray(list) ? list : []);
        } catch {
            setSnapshots([]);
        } finally {
            setLoadingSnapshots(false);
        }
    };

    const loadScheduleConfig = async () => {
        try {
            const cfg = await fetchNodeSnapshotSchedule(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            if (cfg) setScheduleConfig(cfg);
        } catch {
            // Keep default
        }
    };

    const load2faStatus = async () => {
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/status');
            const res = await fetch(url, {
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json();
                setTfaStatus({
                    ...data,
                    enabled: Boolean(data.totpEnabled ?? data.enabled),
                });
            }
        } catch {}
    };

    useEffect(() => {
        loadSnapshots();
        loadScheduleConfig();
        load2faStatus();
        loadDiskHealth();
    }, [activeNode?.id, activeNode?.url]);

    const handleCreateSnapshot = async () => {
        setCreatingSnapshot(true);
        try {
            await createNodeSnapshot(
                activeNode.url,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            await loadSnapshots();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to create snapshot');
        } finally {
            setCreatingSnapshot(false);
        }
    };

    const handleDeleteSnapshot = async (name: string) => {
        if (!confirm(`Delete snapshot "${name}"?`)) return;
        try {
            await deleteNodeSnapshot(
                activeNode.url,
                name,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            await loadSnapshots();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to delete snapshot');
        }
    };

    const handleSaveSchedule = async (e: React.FormEvent) => {
        e.preventDefault();
        setSavingSchedule(true);
        setScheduleStatusMsg(null);
        try {
            const updated = await updateNodeSnapshotSchedule(
                activeNode.url,
                scheduleConfig,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setScheduleConfig(updated);
            setScheduleStatusMsg('Backup schedule updated successfully.');
        } catch (e: unknown) {
            setScheduleStatusMsg(e instanceof Error ? e.message : 'Failed to update schedule');
        } finally {
            setSavingSchedule(false);
        }
    };

    const handleVerifyDatabase = async (snapshotName?: string) => {
        setVerifying(true);
        setVerifyTarget(snapshotName || 'live-db');
        setVerifyResult(null);
        setVerifyError(null);
        try {
            const res = await verifyNodeBackup(
                activeNode.url,
                snapshotName,
                activeNode.adminPassword,
                getTfaSessionToken(activeNode.id)
            );
            setVerifyResult(res);
        } catch (e: unknown) {
            setVerifyError(e instanceof Error ? e.message : 'Verification failed');
        } finally {
            setVerifying(false);
        }
    };

    const handleRestoreSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!restoreFile) return;
        if (!confirm('Warning: Restoring will overwrite the active node database and restart the state engine. Continue?')) return;

        setRestoring(true);
        setRestoreStatus(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore');
            const headers = buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            delete headers['Content-Type'];

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: restoreFile,
            });

            if (res.ok) {
                setRestoreStatus('Database successfully restored! State engine refreshed.');
                setRestoreFile(null);
                onRefreshDiag();
            } else {
                const err = await res.json().catch(() => ({}));
                setRestoreStatus(`Restore failed: ${err.error || 'Server rejected backup file'}`);
            }
        } catch (e: unknown) {
            setRestoreStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setRestoring(false);
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (newPassword !== confirmPassword) {
            setPwdStatus({ text: 'New passwords do not match', isError: true });
            return;
        }
        if (newPassword.length < 8) {
            setPwdStatus({ text: 'Password must be at least 8 characters', isError: true });
            return;
        }
        setChangingPwd(true);
        setPwdStatus(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/change-password');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    currentPassword: currentPassword || activeNode.adminPassword,
                    newPassword,
                }),
            });
            if (res.ok) {
                setPwdStatus({ text: 'Password updated successfully! Please re-login with the new password.', isError: false });
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                sessionStorage.setItem('bp-admin-token', newPassword);
            } else {
                const err = await res.json().catch(() => ({}));
                setPwdStatus({ text: err.error || 'Failed to change password', isError: true });
            }
        } catch (e: unknown) {
            setPwdStatus({ text: e instanceof Error ? e.message : String(e), isError: true });
        } finally {
            setChangingPwd(false);
        }
    };

    const handleCheckUpdate = async () => {
        setCheckingUpdate(true);
        setUpdateInfo(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/admin/check-update');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ password: activeNode.adminPassword }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setUpdateAvailable(false);
                setUpdateInfo(`Update check failed: ${err.error || `HTTP ${res.status}`}`);
                return;
            }
            const data = await res.json();
            if (data.updateAvailable) {
                setUpdateAvailable(true);
                setUpdateInfo(`Update Available: v${data.latestVersion} (current: v${data.currentVersion || '1.4.2'})`);
            } else {
                setUpdateAvailable(false);
                setUpdateInfo(`Up to date (current release: v${data.currentVersion || '1.4.2'})`);
            }
        } catch (e: unknown) {
            setUpdateAvailable(false);
            setUpdateInfo(`Unable to check for updates: ${e instanceof Error ? e.message : 'Network error'}`);
        } finally {
            setCheckingUpdate(false);
        }
    };

    const handleSetup2FA = async () => {
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/setup');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                const data = await res.json();
                setTfaStatus({ enabled: false, qrDataUrl: data.qrDataUrl, secret: data.secret });
                setTfaMessage('Scan the QR code in your Authenticator app and enter the 6-digit code below:');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    const handleVerify2FA = async () => {
        if (!totpVerifyCode.trim()) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/verify');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ totpCode: totpVerifyCode.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                setTfaMessage('2FA successfully enabled!');
                setTotpVerifyCode('');
                const token = data.tfaSessionToken || data.sessionToken;
                if (token) {
                    setTfaSessionToken(activeNode.id, token);
                    sessionStorage.setItem('bp_tfa_session_local-node', token);
                    sessionStorage.setItem('bp-2fa-session', token);
                }
                await load2faStatus();
            } else {
                alert(data.error || 'Invalid 2FA code. Please try again.');
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    const handleDisable2FA = async () => {
        if (!confirm('Disable 2FA protection for this node admin account?')) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/2fa/disable');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
            });
            if (res.ok) {
                setTfaMessage('2FA disabled.');
                setTfaSessionToken(activeNode.id, undefined);
                sessionStorage.removeItem('bp_tfa_session_local-node');
                sessionStorage.removeItem('bp-2fa-session');
                await load2faStatus();
            }
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    const handleResetNode = async () => {
        if (!confirm('CRITICAL DANGER: Are you sure you want to reset this node? All identity and local configs will be erased.')) return;
        if (!confirm('Confirming second time: This cannot be undone. Proceed?')) return;
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/reset');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(`Node reset failed: ${err.error || `HTTP ${res.status}`}`);
                return;
            }
            alert('Node has been reset. Refreshing page.');
            window.location.reload();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : String(e));
        }
    };

    // Calculate latest backup time
    const latestSnapshot = snapshots.length > 0 ? snapshots[0] : null;
    const lastBackupDisplay = latestSnapshot?.createdAt
        ? new Date(latestSnapshot.createdAt).toLocaleString()
        : 'No backup recorded';

    const effectiveDiskHealth = diskHealth || diag?.diskHealth || null;

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Header & Subtabs */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>⚙️</span>
                        <span>Appliance &amp; Data</span>
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Backups &amp; restore wizard, logs, ledger conservation, network, identity, and access
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 bg-nature-950 p-1.5 rounded-xl border border-nature-800 self-start sm:self-auto">
                    <button
                        onClick={() => setSubTab('diagnostics')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'diagnostics'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Diagnostics &amp; Logs
                    </button>
                    <button
                        onClick={() => setSubTab('backups')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'backups'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Backups &amp; Restore
                    </button>
                    <button
                        onClick={() => setSubTab('gateway')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'gateway'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Gateway &amp; Peers
                    </button>
                    <button
                        onClick={() => setSubTab('network')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'network'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Public Address
                    </button>
                    <button
                        onClick={() => setSubTab('identity')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'identity'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Node Identity
                    </button>
                    <button
                        onClick={() => setSubTab('access')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                            subTab === 'access'
                                ? 'bg-terra-500/20 text-terra-300 border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Access &amp; Security
                    </button>
                </div>
            </div>

            {/* Read-only Version / Update-Available / Last-Backup Card (per admin-surface §4.3) */}
            <div className="p-5 rounded-2xl bg-nature-900/90 border border-nature-800 shadow-xl">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
                        {/* Node Version */}
                        <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400 tracking-wider">Node Version</span>
                            <div className="text-lg font-black text-white font-mono mt-0.5 flex items-center gap-2">
                                <span>{diag?.callsign ? 'v1.4.2' : 'v1.4.2'}</span>
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-terra-500/20 text-terra-300 border border-terra-500/30">
                                    Release
                                </span>
                            </div>
                            <span className="text-[10px] text-nature-400">Standalone sovereign node</span>
                        </div>

                        {/* Release / Update Status */}
                        <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400 tracking-wider">Update Status</span>
                            <div className="text-sm font-bold mt-0.5">
                                {updateAvailable ? (
                                    <span className="text-amber-400 flex items-center gap-1">
                                        <span>⚠️</span>
                                        <span>Update Available</span>
                                    </span>
                                ) : (
                                    <span className="text-emerald-400 flex items-center gap-1">
                                        <span>✓</span>
                                        <span>Up to date</span>
                                    </span>
                                )}
                            </div>
                            <div className="text-[10px] text-nature-400 truncate mt-0.5">
                                {updateInfo || 'Checked against sovereign release'}
                            </div>
                        </div>

                        {/* Last Successful Backup */}
                        <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400 tracking-wider">Last Successful Backup</span>
                            <div className="text-sm font-bold text-white font-mono mt-0.5 truncate">
                                {lastBackupDisplay}
                            </div>
                            <span className="text-[10px] text-nature-400">
                                {snapshots.length > 0 ? `${snapshots.length} snapshot(s) archived` : 'No snapshots'}
                            </span>
                        </div>
                    </div>

                    <div className="flex flex-col sm:flex-row lg:flex-col items-start lg:items-end justify-between gap-2 border-t lg:border-t-0 lg:border-l border-nature-800/80 pt-3 lg:pt-0 lg:pl-4">
                        <button
                            type="button"
                            onClick={handleCheckUpdate}
                            disabled={checkingUpdate}
                            className="px-3.5 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all disabled:opacity-50 shrink-0"
                        >
                            {checkingUpdate ? 'Checking...' : 'Check Release Updates'}
                        </button>
                        <p className="text-[10px] text-nature-400 m-0 max-w-xs text-left lg:text-right">
                            Container restart &amp; image swaps restricted to SSH per sovereign security policy.
                        </p>
                    </div>
                </div>
            </div>

            {/* Subtab: Diagnostics & Logs */}
            {subTab === 'diagnostics' && (
                <div className="space-y-6">
                    {/* Live Hardware & Engine Metrics */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="p-4 rounded-xl bg-nature-900/80 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400">CPU Load</span>
                            <div className="text-xl font-bold text-white font-mono mt-0.5">
                                {diag?.cpuLoadPercent ?? 0}%
                            </div>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-900/80 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400">Memory</span>
                            <div className="text-xl font-bold text-white font-mono mt-0.5">
                                {diag?.memoryUsageMb ?? 0} MB
                            </div>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-900/80 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400">Database Size</span>
                            <div className="text-xl font-bold text-white font-mono mt-0.5">
                                {Math.round(((diag?.dbSizeBytes || 0) + (diag?.walSizeBytes || 0)) / (1024 * 1024) * 10) / 10} MB
                            </div>
                        </div>
                        <div className="p-4 rounded-xl bg-nature-900/80 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400">WS Connections</span>
                            <div className="text-xl font-bold text-white font-mono mt-0.5">
                                {diag?.activeWsConnections ?? 0}
                            </div>
                        </div>
                    </div>

                    {/* Disk Health & Storage Breakdown Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-nature-800 pb-4">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>💾</span>
                                    <span>Disk Health &amp; Storage Breakdown</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Storage utilization broken down into database, media, and system logs with automated 80% safety warning.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleOpenCleanModal}
                                className="px-3.5 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all flex items-center justify-center gap-1.5 shadow-sm shrink-0"
                            >
                                <span>🧹</span>
                                <span>Clean Orphaned Media &amp; Compress Logs</span>
                            </button>
                        </div>

                        {/* 80% Warning Banner */}
                        {effectiveDiskHealth && (effectiveDiskHealth.warning || effectiveDiskHealth.usedPercent >= 80) && (
                            <div className="p-4 rounded-xl bg-amber-950/70 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-3">
                                <span className="text-base leading-none">⚠️</span>
                                <div>
                                    <span className="font-bold">High Disk Usage Warning:</span>
                                    <span className="ml-1 text-amber-300">
                                        Disk utilization is at {effectiveDiskHealth.usedPercent}% (exceeds 80% safety threshold). Clean orphaned media and compress old logs to prevent SD card runaway and SQLite write locks.
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Overall Disk Meter */}
                        {effectiveDiskHealth ? (
                            <div className="space-y-3">
                                <div className="flex items-center justify-between text-xs">
                                    <span className="text-nature-300 font-medium">Capacity Used</span>
                                    <span className="font-mono text-white font-bold">
                                        {formatBytes(effectiveDiskHealth.usedBytes)} of {formatBytes(effectiveDiskHealth.totalBytes)} ({effectiveDiskHealth.usedPercent}%)
                                        <span className="text-nature-400 font-normal ml-2">({formatBytes(effectiveDiskHealth.freeBytes)} free)</span>
                                    </span>
                                </div>
                                <div className="w-full h-3 bg-nature-950 rounded-full overflow-hidden flex border border-nature-800">
                                    <div
                                        style={{ width: `${Math.min(100, Math.max(0, effectiveDiskHealth.usedPercent))}%` }}
                                        className={`h-full transition-all duration-500 ${
                                            effectiveDiskHealth.usedPercent >= 80
                                                ? 'bg-amber-500'
                                                : 'bg-gradient-to-r from-emerald-500 to-terra-500'
                                        }`}
                                    />
                                </div>

                                {/* 3-Way Breakdown: Database vs Media vs Logs */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 pt-2">
                                    {/* Database Breakdown */}
                                    <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-nature-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                                                <span>Database</span>
                                            </span>
                                            <span className="text-xs font-mono font-bold text-white">
                                                {formatBytes(effectiveDiskHealth.breakdown?.database?.totalBytes ?? effectiveDiskHealth.databaseBytes)}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-nature-400 space-y-0.5">
                                            <div className="flex justify-between">
                                                <span>SQLite state:</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.database?.dbSizeBytes)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>WAL journal:</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.database?.walSizeBytes)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>Snapshots:</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.database?.snapshotsSizeBytes)}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Media Breakdown */}
                                    <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-nature-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-terra-400"></span>
                                                <span>Media</span>
                                            </span>
                                            <span className="text-xs font-mono font-bold text-white">
                                                {formatBytes(effectiveDiskHealth.breakdown?.media?.totalBytes ?? effectiveDiskHealth.mediaBytes)}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-nature-400 space-y-0.5">
                                            <div className="flex justify-between">
                                                <span>Post photos ({effectiveDiskHealth.breakdown?.media?.postPhotosCount ?? 0}):</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.media?.postPhotosBytes)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>Thumbnails ({effectiveDiskHealth.breakdown?.media?.pulseThumbnailsCount ?? 0}):</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.media?.pulseThumbnailsBytes)}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Logs Breakdown */}
                                    <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-nature-300 flex items-center gap-1.5">
                                                <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                                                <span>Logs</span>
                                            </span>
                                            <span className="text-xs font-mono font-bold text-white">
                                                {formatBytes(effectiveDiskHealth.breakdown?.logs?.totalBytes ?? effectiveDiskHealth.logsBytes)}
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-nature-400 space-y-0.5">
                                            <div className="flex justify-between">
                                                <span>System events ({effectiveDiskHealth.breakdown?.logs?.systemLogsCount ?? 0}):</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.logs?.systemLogsBytes)}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span>Log files on disk:</span>
                                                <span className="font-mono text-nature-300">{formatBytes(effectiveDiskHealth.breakdown?.logs?.logFilesBytes)}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="text-xs text-nature-400 italic">
                                Connecting to node storage metrics...
                            </div>
                        )}
                    </div>

                    {/* Ledger Conservation Audit Panel */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>⚖️</span>
                                    <span>Ledger Conservation Audit</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Absolute invariant verification: SUM(member balances) + Commons Pool = 0
                                </p>
                            </div>
                            <button
                                onClick={onRunLedgerAudit}
                                disabled={auditState.running}
                                className="px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                {auditState.running ? 'Auditing...' : 'Run Audit Now'}
                            </button>
                        </div>

                        {auditState.result ? (
                            <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                <div>
                                    <span className="text-nature-400 font-medium">Status</span>
                                    <div className={`font-bold mt-0.5 ${auditState.result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                                        {auditState.result.ok ? '✓ Balanced (0 Drift)' : '⚠️ Drift Detected'}
                                    </div>
                                </div>
                                <div>
                                    <span className="text-nature-400 font-medium">Drift</span>
                                    <div className="font-mono text-white mt-0.5 font-bold">{auditState.result.drift} beans</div>
                                </div>
                                <div>
                                    <span className="text-nature-400 font-medium">Total Balances</span>
                                    <div className="font-mono text-white mt-0.5 font-bold">{auditState.result.sumBalances ?? 0} beans</div>
                                </div>
                                <div>
                                    <span className="text-nature-400 font-medium">Stranded Escrows</span>
                                    <div className="font-mono text-white mt-0.5 font-bold">{auditState.result.strandedEscrows ?? 0}</div>
                                </div>
                            </div>
                        ) : (
                            <div className="text-xs text-nature-400 italic">
                                Run on-demand audit to verify zero-sum integrity across all member and enterprise accounts.
                            </div>
                        )}
                    </div>

                    {/* Real-time Logs Streamer */}
                    <LogsModule logs={nodeLogs} onRefresh={onRefreshLogs} />
                </div>
            )}

            {/* Subtab: Backups & Restore */}
            {subTab === 'backups' && (
                <div className="space-y-6">
                    {/* Database Download and Restore Wizard */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Download Database Backup */}
                        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                <span>💾</span>
                                <span>Download Sovereign Database</span>
                            </h3>
                            <p className="text-xs text-nature-400 m-0">
                                Download a complete snapshot copy of the node's SQLite database containing all balances, trades, profiles, and post history.
                            </p>
                            <button
                                onClick={onDownloadBackup}
                                className="w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all flex items-center justify-center gap-2"
                            >
                                <span>⬇️</span>
                                <span>Download Database Snapshot (.sqlite)</span>
                            </button>
                        </div>

                        {/* Restore Wizard */}
                        <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                            <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                <span>🔄</span>
                                <span>Restore Database Wizard</span>
                            </h3>
                            <p className="text-xs text-nature-400 m-0">
                                Restore this node from a previously exported backup archive (.tar.gz). Overwrites existing database tables.
                            </p>

                            {restoreStatus && (
                                <div className="p-3 rounded-xl bg-nature-950 border border-terra-500/50 text-xs text-terra-300 font-mono">
                                    {restoreStatus}
                                </div>
                            )}

                            <form
                                onSubmit={handleRestoreSubmit}
                                className="space-y-3"
                            >
                                <input
                                    type="file"
                                    accept=".sqlite,.db,.tar.gz"
                                    onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
                                    className="block w-full text-xs text-nature-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-nature-800 file:text-white hover:file:bg-nature-700"
                                />
                                <button
                                    type="submit"
                                    disabled={!restoreFile || restoring}
                                    className="w-full py-2.5 rounded-xl bg-red-900/80 hover:bg-red-800 text-xs font-bold text-white border border-red-700 transition-all disabled:opacity-50"
                                >
                                    {restoring ? 'Restoring Database...' : 'Restore from Backup'}
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Automated Backup Schedule Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>⏱️</span>
                                    <span>Automated Backup Schedule</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Autonomous on-disk point-in-time snapshots using crash-consistent SQLite VACUUM INTO
                                </p>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                scheduleConfig.enabled
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : 'bg-nature-800 text-nature-400'
                            }`}>
                                {scheduleConfig.enabled ? `Active (${scheduleConfig.intervalHours}h)` : 'Disabled'}
                            </span>
                        </div>

                        {scheduleStatusMsg && (
                            <div className="p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs text-emerald-300">
                                {scheduleStatusMsg}
                            </div>
                        )}

                        <form onSubmit={handleSaveSchedule} className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Automated Schedule
                                </label>
                                <label className="flex items-center gap-2 bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2.5 cursor-pointer text-xs text-white">
                                    <input
                                        type="checkbox"
                                        checked={scheduleConfig.enabled}
                                        onChange={(e) => setScheduleConfig({ ...scheduleConfig, enabled: e.target.checked })}
                                        className="rounded border-nature-700 text-terra-500 focus:ring-0"
                                    />
                                    <span>Enable automated snapshots</span>
                                </label>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Cadence Interval
                                </label>
                                <select
                                    value={scheduleConfig.intervalHours}
                                    onChange={(e) => setScheduleConfig({ ...scheduleConfig, intervalHours: Number(e.target.value) })}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white"
                                >
                                    <option value={6}>Every 6 hours</option>
                                    <option value={12}>Every 12 hours</option>
                                    <option value={24}>Every 24 hours (Daily)</option>
                                    <option value={48}>Every 48 hours (Every 2 days)</option>
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">
                                    Retention Limit
                                </label>
                                <div className="flex gap-2">
                                    <select
                                        value={scheduleConfig.keep}
                                        onChange={(e) => setScheduleConfig({ ...scheduleConfig, keep: Number(e.target.value) })}
                                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2.5 text-xs text-white"
                                    >
                                        <option value={3}>Keep last 3 snapshots</option>
                                        <option value={7}>Keep last 7 snapshots (1 week)</option>
                                        <option value={14}>Keep last 14 snapshots (2 weeks)</option>
                                        <option value={30}>Keep last 30 snapshots (1 month)</option>
                                    </select>
                                    <button
                                        type="submit"
                                        disabled={savingSchedule}
                                        className="px-4 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50 shrink-0"
                                    >
                                        {savingSchedule ? 'Saving...' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>

                    {/* Database Integrity Verification Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>🔍</span>
                                    <span>Database Integrity Verification</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Run SQLite PRAGMA integrity_check to verify database health and detect corruption
                                </p>
                            </div>
                            <button
                                onClick={() => handleVerifyDatabase()}
                                disabled={verifying}
                                className="px-3.5 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all disabled:opacity-50"
                            >
                                {verifying && verifyTarget === 'live-db' ? 'Verifying...' : 'Verify Live Database'}
                            </button>
                        </div>

                        {verifyResult && (
                            <div className={`p-4 rounded-xl border text-xs space-y-1.5 ${
                                verifyResult.ok
                                    ? 'bg-emerald-950/40 border-emerald-800/80 text-emerald-200'
                                    : 'bg-red-950/50 border-red-800 text-red-200'
                            }`}>
                                <div className="font-bold flex items-center gap-1.5">
                                    <span>{verifyResult.ok ? '✓' : '⚠️'}</span>
                                    <span>
                                        {verifyResult.ok
                                            ? 'Database verified, no corruption (PRAGMA integrity_check: ok)'
                                            : 'Integrity check failed: database corruption detected'}
                                    </span>
                                </div>
                                <p className="text-[11px] text-nature-300 m-0">
                                    Verified at {new Date(verifyResult.verifiedAt).toLocaleString()} across all tables and index trees. Community balances and ledger state are intact.
                                </p>
                            </div>
                        )}

                        {verifyError && (
                            <div className="p-3 rounded-xl bg-red-950/50 border border-red-800 text-xs text-red-300">
                                {verifyError}
                            </div>
                        )}
                    </div>

                    {/* Snapshots Management */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>📸</span>
                                    <span>Point-in-Time Snapshots ({snapshots.length})</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Local point-in-time state snapshots created on this node
                                </p>
                            </div>
                            <button
                                onClick={handleCreateSnapshot}
                                disabled={creatingSnapshot}
                                className="px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                {creatingSnapshot ? 'Creating...' : '+ Create Snapshot'}
                            </button>
                        </div>

                        {loadingSnapshots ? (
                            <div className="py-6 text-center text-xs text-nature-400">Loading snapshots...</div>
                        ) : (Array.isArray(snapshots) ? snapshots : []).length === 0 ? (
                            <div className="py-6 text-center text-xs text-nature-400">No snapshots created yet.</div>
                        ) : (
                            <div className="space-y-2">
                                {(Array.isArray(snapshots) ? snapshots : []).map((s) => (
                                    <div
                                        key={s.name}
                                        className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 flex items-center justify-between gap-3 text-xs"
                                    >
                                        <div>
                                            <div className="font-bold text-white font-mono">{s.name}</div>
                                            <div className="text-[10px] text-nature-400 mt-0.5">
                                                {s.createdAt ? new Date(s.createdAt).toLocaleString() : 'Recent snapshot'} · {Math.round((s.sizeBytes || 0) / 1024)} KB
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => handleVerifyDatabase(s.name)}
                                                disabled={verifying}
                                                className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs text-nature-300 font-bold border border-nature-700 transition-all"
                                            >
                                                {verifying && verifyTarget === s.name ? 'Verifying...' : 'Verify'}
                                            </button>
                                            <button
                                                onClick={() => handleDeleteSnapshot(s.name)}
                                                className="px-2.5 py-1 rounded bg-nature-800 hover:bg-nature-700 text-xs text-red-400 font-bold border border-nature-700"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Standby Live Backup / Replication Configuration (Standby) vs Replication Access (Primary) */}
                    {isStandby ? (
                        <SectionErrorBoundary sectionName="Standby Live Backup" resetKey={activeNode.id}>
                            <StandbyReplicationPanel
                                activeNode={activeNode}
                                onRefreshDiag={onRefreshDiag}
                            />
                        </SectionErrorBoundary>
                    ) : (
                        <SectionErrorBoundary sectionName="Replication Access" resetKey={activeNode.id}>
                            <ReplicationAccessPanel
                                activeNode={activeNode}
                                onRefreshDiag={onRefreshDiag}
                            />
                        </SectionErrorBoundary>
                    )}
                </div>
            )}

            {/* Subtab: Gateway & Peers */}
            {subTab === 'gateway' && (
                <div className="space-y-6">
                    {/* Gateway Security Module */}
                    <GatewayModule
                        gateway={gateway}
                        gatewayLoading={gatewayLoading}
                        gatewaySuccess={gatewaySuccess}
                        gatewaySaving={gatewaySaving}
                        activeWsConnections={diag?.activeWsConnections ?? 3}
                        onChangeGateway={onChangeGateway}
                        onSaveGateway={onSaveGateway}
                    />

                    {/* Connected Peers & Connectors */}
                    <SectionErrorBoundary sectionName="Peer Connectors" resetKey={activeNode.id}>
                        <PeerConnectorsPanel
                            key={activeNode.id}
                            activeNode={activeNode}
                            activeWsConnections={diag?.activeWsConnections}
                            p2pActivePeers={diag?.p2pActivePeers}
                        />
                    </SectionErrorBoundary>
                </div>
            )}

            {/* Subtab: Public Address & Tunnel */}
            {subTab === 'network' && (
                <SectionErrorBoundary sectionName="Public Address" resetKey={activeNode.id}>
                    <PublicAddressPanel
                        key={activeNode.id}
                        activeNode={activeNode}
                        onRefreshDiag={onRefreshDiag}
                    />
                </SectionErrorBoundary>
            )}

            {/* Subtab: Node Identity */}
            {subTab === 'identity' && (
                <SectionErrorBoundary sectionName="Node Identity" resetKey={activeNode.id}>
                    <NodeIdentityPanel
                        key={activeNode.id}
                        activeNode={activeNode}
                        diag={diag}
                        onRefreshDiag={onRefreshDiag}
                    />
                </SectionErrorBoundary>
            )}

            {/* Subtab: Access & Security */}
            {subTab === 'access' && (
                <div className="space-y-6 max-w-2xl">
                    {/* Password Change Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                            <span>🔑</span>
                            <span>Change Admin Password</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0">
                            Rotate the shared node administrator password
                        </p>

                        {pwdStatus && (
                            <div className={`p-3 rounded-xl border text-xs font-semibold ${
                                pwdStatus.isError ? 'bg-red-950/60 border-red-800 text-red-200' : 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                            }`}>
                                {pwdStatus.text}
                            </div>
                        )}

                        <form onSubmit={handleChangePassword} className="space-y-3">
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Current Password</label>
                                <input
                                    type="password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    placeholder="Enter current password"
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">New Password</label>
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    placeholder="Minimum 8 characters"
                                    required
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-nature-300 mb-1">Confirm New Password</label>
                                <input
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    placeholder="Confirm new password"
                                    required
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={changingPwd}
                                className="px-5 py-2.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                {changingPwd ? 'Updating...' : 'Update Password'}
                            </button>
                        </form>
                    </div>

                    {/* 2FA / TOTP Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>🛡️</span>
                                    <span>Two-Factor Authentication (2FA)</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Require a 6-digit TOTP code on operator login
                                </p>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                tfaStatus?.enabled ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-nature-800 text-nature-400'
                            }`}>
                                {tfaStatus?.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                        </div>

                        {tfaMessage && (
                            <div className="p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs text-white">
                                {tfaMessage}
                            </div>
                        )}

                        {tfaStatus?.qrDataUrl && !tfaStatus.enabled && (
                            <div className="space-y-3 p-4 rounded-xl bg-nature-950 border border-nature-800">
                                <img src={tfaStatus.qrDataUrl} alt="2FA QR Code" className="w-44 h-44 mx-auto rounded-lg" />
                                {tfaStatus.secret && (
                                    <div className="text-center font-mono text-xs text-terra-400 font-bold">
                                        Secret: {tfaStatus.secret}
                                    </div>
                                )}
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={totpVerifyCode}
                                        onChange={(e) => setTotpVerifyCode(e.target.value)}
                                        placeholder="Enter 6-digit code to verify"
                                        className="flex-1 bg-nature-900 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono text-center"
                                    />
                                    <button
                                        type="button"
                                        onClick={handleVerify2FA}
                                        className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white"
                                    >
                                        Verify &amp; Enable
                                    </button>
                                </div>
                            </div>
                        )}

                        {!tfaStatus?.enabled && !tfaStatus?.qrDataUrl && (
                            <button
                                type="button"
                                onClick={handleSetup2FA}
                                className="px-5 py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
                            >
                                Setup 2FA Authenticator
                            </button>
                        )}

                        {tfaStatus?.enabled && (
                            <button
                                type="button"
                                onClick={handleDisable2FA}
                                className="px-5 py-2.5 rounded-xl bg-red-900/80 hover:bg-red-800 text-xs font-bold text-white border border-red-700 transition-all"
                            >
                                Disable 2FA
                            </button>
                        )}
                    </div>

                    {/* Break-Glass Emergency Recovery Card (per admin-surface §2.2) */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <div>
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>🚨</span>
                                    <span>Break-Glass Emergency Recovery</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Attributable recovery mechanism when member keys or paired devices are lost
                                </p>
                            </div>
                            <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                Phase 3 Specification
                            </span>
                        </div>

                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-3 text-xs">
                            <blockquote className="border-l-2 border-terra-500 pl-3 my-0 text-nature-300 italic">
                                &ldquo;The break-glass credential can do exactly one thing: enrol a new admin key. It cannot
                                dismiss a report, change a setting, touch a balance, or moderate anything. It authorises a
                                new device key and the session ends. The admin then signs in with that key, and everything
                                from that point is attributable.&rdquo;
                            </blockquote>

                            <p className="text-nature-400 m-0 leading-relaxed">
                                <strong className="text-white">Audit Trail Safeguard:</strong> Using break-glass is rate-limited
                                and automatically writes a loud, permanent public entry to the system audit feed:
                                <br />
                                <span className="font-mono text-terra-400 text-[11px] block mt-1">
                                    &ldquo;Break-glass recovery used to authorise a new admin key for @callsign.&rdquo;
                                </span>
                            </p>
                        </div>

                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-nature-300">Enrol New Admin Key</span>
                                <span className="text-[10px] px-2 py-0.5 rounded bg-nature-800 text-nature-400 font-mono">
                                    Non-functional placeholder
                                </span>
                            </div>
                            <p className="text-[11px] text-nature-400 m-0">
                                Key-based cryptographic admin auth enrolment ships in Phase 3. Today, password authentication
                                acts as interim owner action per admin-surface §2.5.
                            </p>
                            <button
                                type="button"
                                disabled
                                className="w-full py-2.5 rounded-xl bg-nature-800 text-xs font-bold text-nature-500 border border-nature-700/50 cursor-not-allowed"
                            >
                                Enrol Device Key via Break-Glass (Unavailable in Phase 2)
                            </button>
                        </div>
                    </div>

                    {/* Factory Reset Danger Zone */}
                    <div className="p-6 rounded-2xl bg-red-950/20 border border-red-900/40 shadow-xl space-y-3">
                        <h3 className="text-base font-bold text-red-400 m-0 flex items-center gap-2">
                            <span>⚠️</span>
                            <span>Danger Zone: Factory Reset Node</span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0">
                            Wipes identity and local state. Does not delete blockchain ledger files.
                        </p>
                        <button
                            type="button"
                            onClick={handleResetNode}
                            className="px-5 py-2.5 rounded-xl bg-red-800 hover:bg-red-700 text-xs font-bold text-white transition-all shadow-md"
                        >
                            Wipe &amp; Reset Node
                        </button>
                    </div>
                </div>
            )}

            {/* One-Click Clean Storage & Compress Logs Modal */}
            {showCleanModal && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="clean-storage-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="bg-nature-900 border border-nature-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 text-white">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <h3 id="clean-storage-title" className="text-base font-bold m-0 flex items-center gap-2">
                                <span>🧹</span>
                                <span>Clean Orphaned Media &amp; Compress Logs</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => setShowCleanModal(false)}
                                className="text-nature-400 hover:text-white text-lg font-bold"
                            >
                                ✕
                            </button>
                        </div>

                        {loadingPreview && (
                            <div className="py-8 text-center text-xs text-nature-400 flex flex-col items-center gap-2">
                                <span className="animate-spin text-xl">⏳</span>
                                <span>Scanning storage for orphaned photos, thumbnails, and pruneable logs...</span>
                            </div>
                        )}

                        {cleanError && (
                            <div className="p-3 rounded-xl bg-red-950/70 border border-red-500/50 text-red-200 text-xs font-mono">
                                {cleanError}
                            </div>
                        )}

                        {cleanResult && (
                            <div className="p-4 rounded-xl bg-emerald-950/60 border border-emerald-500/50 text-emerald-200 text-xs space-y-2">
                                <div className="font-bold text-sm flex items-center gap-1.5 text-emerald-300">
                                    <span>✓</span>
                                    <span>Cleanup Complete!</span>
                                </div>
                                <p className="m-0">
                                    Successfully reclaimed <strong>{formatBytes(cleanResult.totalReclaimedBytes)}</strong> of disk space:
                                </p>
                                <ul className="list-disc list-inside space-y-1 text-emerald-300">
                                    <li>Removed {cleanResult.removedPhotosCount} orphaned post photos ({formatBytes(cleanResult.removedPhotosBytes)})</li>
                                    <li>Removed {cleanResult.removedThumbnailsCount} orphaned cached thumbnails ({formatBytes(cleanResult.removedThumbnailsBytes)})</li>
                                    <li>Compressed and pruned {cleanResult.compressedLogsCount} old log events ({formatBytes(cleanResult.compressedLogsBytes)})</li>
                                </ul>
                            </div>
                        )}

                        {!loadingPreview && cleanPreview && !cleanResult && (
                            <div className="space-y-4">
                                <p className="text-xs text-nature-300 m-0">
                                    Review items identified for deletion and log compression. Valid active data will NOT be touched.
                                </p>

                                <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-3 text-xs">
                                    <div className="flex items-center justify-between pb-2 border-b border-nature-800/80">
                                        <div>
                                            <span className="font-bold text-white block">Orphaned Post Photos</span>
                                            <span className="text-[11px] text-nature-400">Photos from deleted marketplace and community posts</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="font-bold text-white font-mono">{cleanPreview.orphanedPostPhotos.count} items</span>
                                            <span className="text-[11px] text-nature-400 block font-mono">{formatBytes(cleanPreview.orphanedPostPhotos.totalBytes)}</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between pb-2 border-b border-nature-800/80">
                                        <div>
                                            <span className="font-bold text-white block">Orphaned Pulse Thumbnails</span>
                                            <span className="text-[11px] text-nature-400">Cached image thumbnails for removed news and pulse items</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="font-bold text-white font-mono">{cleanPreview.orphanedThumbnails.count} items</span>
                                            <span className="text-[11px] text-nature-400 block font-mono">{formatBytes(cleanPreview.orphanedThumbnails.totalBytes)}</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between pb-2 border-b border-nature-800/80">
                                        <div>
                                            <span className="font-bold text-white block">Compressible System Logs</span>
                                            <span className="text-[11px] text-nature-400">Archived to gzip beyond the latest 500 active events</span>
                                        </div>
                                        <div className="text-right">
                                            <span className="font-bold text-white font-mono">{cleanPreview.compressibleLogs.count} rows</span>
                                            <span className="text-[11px] text-nature-400 block font-mono">{formatBytes(cleanPreview.compressibleLogs.totalBytes)}</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between pt-1 font-bold text-sm">
                                        <span className="text-white">Estimated Space Reclaimed:</span>
                                        <span className="text-terra-400 font-mono">{formatBytes(cleanPreview.totalReclaimableBytes)}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-3 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setShowCleanModal(false)}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-nature-300"
                            >
                                {cleanResult ? 'Close' : 'Cancel'}
                            </button>
                            {!cleanResult && (
                                <button
                                    type="button"
                                    onClick={handleExecuteClean}
                                    disabled={loadingPreview || cleaningStorage || !cleanPreview}
                                    className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white disabled:opacity-50 flex items-center gap-1.5"
                                >
                                    {cleaningStorage ? (
                                        <>
                                            <span className="animate-spin">⏳</span>
                                            <span>Cleaning &amp; Compressing...</span>
                                        </>
                                    ) : (
                                        <>
                                            <span>🧹</span>
                                            <span>Confirm &amp; Clean Now</span>
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
