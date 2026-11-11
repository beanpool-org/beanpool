import React, { useState, useEffect, useRef } from 'react';
import { HelpLink } from '../manual/Manual';
import { SubTabStrip } from '../layout/SubTabStrip';
import { useSectionSubTab } from '../../lib/sections';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse, GatewayConfig, SnapshotItem, SnapshotScheduleConfig, BackupVerificationResult, DiskHealth, StorageCleanPreview, StorageCleanResult } from '../../lib/node-client';
import {
    fetchNodeSnapshots,
    createNodeSnapshot,
    fetchNodeSnapshotSchedule,
    updateNodeSnapshotSchedule,
    verifyNodeBackup,
    resolveNodeApiUrl,
    buildAdminHeaders,
    fetchDiskHealth,
    fetchStorageCleanPreview,
    cleanStorageAndCompressLogs,
} from '../../lib/node-client';
import { restoreDoneWords } from '../../lib/restore-words';
import { NodeIdentityPanel } from './NodeIdentityPanel';
import { EverydayRuleRows } from './EverydayRuleRows';
import { ListingPromisePanel } from './ListingPromisePanel';
import { AddressesPanel } from './AddressesPanel';
import { PeerConnectorsPanel } from './PeerConnectorsPanel';
import { StandbyReplicationPanel } from './StandbyReplicationPanel';
import { ReplicationAccessPanel } from './ReplicationAccessPanel';
import { TakeoverPanel } from './TakeoverPanel';
import { TakeoverLockPanel } from './TakeoverLockPanel';
import type { RolesViewer } from './NodeRolesPanel';
import { OwnerWordsChecksPanel } from './OwnerWordsChecksPanel';
import { ReadyForTheHallCard } from './ReadyForTheHallCard';
import { AutomationTokensPanel } from './AutomationTokensPanel';
import { ConnectedAssistantsPanel } from './ConnectedAssistantsPanel';
import { LightsOutCard } from './LightsOutCard';
import { RestoreLockedBackup, type LockedBackupInfo } from './RestoreLockedBackup';
import { RestorePointsPanel } from './RestorePointsPanel';
import { OffboxBackupsPanel } from './OffboxBackupsPanel';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { proofField, t } from '../../lib/fresh-proof';
import { AlertsPanel } from './AlertsPanel';
import { SectionErrorBoundary } from '../common/SectionErrorBoundary';
import { LogsModule, type LogEntry } from './LogsModule';
import { GatewayModule } from './GatewayModule';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { StrandedEscrowsPanel } from './StrandedEscrowsPanel';
import { isHundredths } from '@beanpool/core';
import { beansFigure } from '../../lib/beans';
import { nodeCredential } from '../../lib/profiles';
import { useInPageConfirm } from '../common/InPageConfirm';

interface ApplianceSectionProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    gateway: GatewayConfig | null;
    gatewayLoading: boolean;
    gatewaySuccess: string | null;
    gatewaySaving: boolean;
    nodeLogs: LogEntry[];
    onChangeGateway: (updated: GatewayConfig) => void;
    onSaveGateway: (code?: string) => void | Promise<void>;
    onRefreshDiag: () => void;
    onRefreshLogs: () => void;
    onDownloadBackup: () => Promise<void>;
    onRunLedgerAudit: () => Promise<void>;
    auditState: { running: boolean; result: { ok: boolean; drift: number | null; sumBalances?: number | null; baseline?: number; strandedEscrows?: number } | null };
    initialSubTab?: 'diagnostics' | 'backups' | 'gateway' | 'network' | 'identity' | 'access';
    /** Told when the owner picks a sub-tab, so Back and the phone top bar follow it. */
    onSubTabChange?: (sub: 'diagnostics' | 'backups' | 'gateway' | 'network' | 'identity' | 'access') => void;
    isStandby?: boolean;
    /** Who is signed in: decides whether the recovery-code buttons show (owners only). */
    rolesViewer?: RolesViewer;
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
    onSubTabChange,
    isStandby: propIsStandby,
    rolesViewer = { kind: 'token' },
}: ApplianceSectionProps) {
    // Removing or replacing data, keys or roles is confirmed in the page, never with window.confirm() (owner-delete S4b).
    const [ask, confirmation] = useInPageConfirm();
    const [subTab, setSubTab] = useSectionSubTab<'diagnostics' | 'backups' | 'gateway' | 'network' | 'identity' | 'access'>(initialSubTab, onSubTabChange);
    const [backupRole, setBackupRole] = useState<'primary' | 'backup' | null>(null);

    useEffect(() => {
        let active = true;
        async function fetchBackupRole() {
            try {
                const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/backup-status');
                const res = await fetch(url, {
                    method: 'POST',
                    headers: buildAdminHeaders(nodeCredential(activeNode)),
                    body: JSON.stringify({}),
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
    }, [activeNode.id, activeNode.url, nodeCredential(activeNode)]);

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
    const [restoreCommand, setRestoreCommand] = useState<string | null>(null);
    // A locked backup (.bpsealed): who can open it, from its public header; the wizard then asks for one of them.
    const [lockedRestore, setLockedRestore] = useState<{ file: File; backup: LockedBackupInfo; canUseCode: boolean; canUsePhone: boolean } | null>(null);

    // Backup Schedule state
    const [scheduleConfig, setScheduleConfig] = useState<SnapshotScheduleConfig | null>(null);
    // False until the node has said its schedule: the form is hidden until then, so made-up values are never shown or saved.
    const [scheduleKnown, setScheduleKnown] = useState(false);
    // True once a read of the schedule has failed; until then an unknown schedule is still being read.
    const [scheduleReadFailed, setScheduleReadFailed] = useState(false);
    const [savingSchedule, setSavingSchedule] = useState(false);
    const [scheduleStatusMsg, setScheduleStatusMsg] = useState<string | null>(null);

    // Verification state
    const [verifying, setVerifying] = useState(false);
    const [verifyTarget, setVerifyTarget] = useState<string | null>(null);
    const [verifyResult, setVerifyResult] = useState<BackupVerificationResult | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);

    // Break-glass code, shown once: held in this component's state only, never stored, gone on Done.
    const [breakGlassShown, setBreakGlassShown] = useState<string | null>(null);
    const [breakGlassMessage, setBreakGlassMessage] = useState('');
    const isOwnerViewer = rolesViewer.kind === 'token' || rolesViewer.role === 'owner';

    // Update check state
    const [updateInfo, setUpdateInfo] = useState<string | null>(null);
    const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [checkedVersion, setCheckedVersion] = useState<string | null>(null);
    const nodeVersion = checkedVersion || diag?.version;

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
                nodeCredential(activeNode)
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
                nodeCredential(activeNode)
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
                nodeCredential(activeNode)
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
                nodeCredential(activeNode)
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
                nodeCredential(activeNode)
            );
            nodeScheduleRef.current = cfg;
            setScheduleConfig(cfg);
            setScheduleKnown(true);
            setScheduleReadFailed(false);
        } catch (e: unknown) {
            setScheduleKnown(false);
            setScheduleConfig(null);
            setScheduleReadFailed(true);
            setScheduleStatusMsg(`Couldn't read this node's backup schedule, so it is shown as unknown: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    useEffect(() => {
        setScheduleKnown(false);
        setScheduleConfig(null);
        setScheduleReadFailed(false);
        setCheckedVersion(null);
        setUpdateInfo(null);
        setUpdateAvailable(false);
        loadSnapshots();
        loadScheduleConfig();
        loadDiskHealth();
    }, [activeNode?.id, activeNode?.url]);

    const handleCreateSnapshot = async () => {
        setCreatingSnapshot(true);
        try {
            await createNodeSnapshot(
                activeNode.url,
                nodeCredential(activeNode)
            );
            await loadSnapshots();
        } catch (e: unknown) {
            alert(e instanceof Error ? e.message : 'Failed to create snapshot');
        } finally {
            setCreatingSnapshot(false);
        }
    };


    // Keeping fewer snapshots, or turning them off, asks an owner's fresh proof (server snapshotsLessened decides which).
    const scheduleProof = useFreshProof();
    /** The schedule the node has (last read or saved): Cancel in the box puts it back in the form (opus-2028 N5). */
    const nodeScheduleRef = useRef<SnapshotScheduleConfig | null>(null);
    const cancelSchedule = () => {
        if (nodeScheduleRef.current) setScheduleConfig(nodeScheduleRef.current);
        setScheduleStatusMsg(t("Not saved. The form shows the node's schedule again."));
    };

    /** Sends this schedule; after the node asked the proof, the same schedule again with the code. */
    const sendSchedule = async (config: SnapshotScheduleConfig, code?: string) => {
        setSavingSchedule(true);
        setScheduleStatusMsg(null);
        try {
            const updated = await updateNodeSnapshotSchedule(
                activeNode.url,
                config,
                nodeCredential(activeNode),
                code
            );
            scheduleProof.close();
            nodeScheduleRef.current = updated;
            setScheduleConfig(updated);
            setScheduleKnown(true);
            setScheduleStatusMsg('Backup schedule updated successfully.');
        } catch (e: unknown) {
            if (scheduleProof.checkError(e, (c) => sendSchedule(config, c), code)) return;
            setScheduleStatusMsg(e instanceof Error ? e.message : 'Failed to update schedule');
        } finally {
            setSavingSchedule(false);
        }
    };

    const handleSaveSchedule = (e: React.FormEvent) => {
        e.preventDefault();
        if (!scheduleKnown || !scheduleConfig) return;
        void sendSchedule(scheduleConfig);
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
                nodeCredential(activeNode)
            );
            setVerifyResult(res);
        } catch (e: unknown) {
            setVerifyError(e instanceof Error ? e.message : 'Verification failed');
        } finally {
            setVerifying(false);
        }
    };

    // The first upload carries no code: the server reads the file's public header and changes nothing (sealed only; a plain
    // archive is refused before a byte of it is read, naming the shell command). A locked file turns the wizard into the
    // confirmation (RestoreLockedBackup): the file's community and signer beside this server's, then the code or a phone.
    // No window confirm(): the proof is the confirmation (design case 18 §3.4).
    const handleRestoreSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!restoreFile) return;

        setRestoring(true);
        setRestoreStatus(null);
        setRestoreCommand(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/restore');
            const headers = buildAdminHeaders(nodeCredential(activeNode));
            delete headers['Content-Type'];

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: restoreFile,
            });

            const body = await res.json().catch(() => ({}));
            if (res.ok) {
                setRestoreStatus(restoreDoneWords(body));
                setRestoreFile(null);
                onRefreshDiag();
            } else {
                if (res.status === 400 && body.backup && (body.needsRecoveryCode || body.ownerPhoneCanOpen)) {
                    setLockedRestore({ file: restoreFile, backup: body.backup, canUseCode: !!body.needsRecoveryCode, canUsePhone: !!body.ownerPhoneCanOpen });
                    return;
                }
                // A plain archive, another community's file on a lived-in server, a signer this server does not pin: the
                // server's own words, and the command it names for the server's shell.
                setRestoreStatus(typeof body.error === 'string' ? body.error : `Restore failed: the server answered HTTP ${res.status}.`);
                if (typeof body.command === 'string') setRestoreCommand(body.command);
            }
        } catch (e: unknown) {
            setRestoreStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setRestoring(false);
        }
    };

    const handleCheckUpdate = async () => {
        setCheckingUpdate(true);
        setUpdateInfo(null);
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/admin/check-update');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode)),
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setUpdateAvailable(false);
                setUpdateInfo(`Update check failed: ${err.error || `HTTP ${res.status}`}`);
                return;
            }
            const data = await res.json();
            if (data.currentVersion) {
                setCheckedVersion(data.currentVersion);
            }
            if (data.updateAvailable) {
                setUpdateAvailable(true);
                const latestStr = data.latestVersion ? `: v${String(data.latestVersion).replace(/^v/, '')}` : '';
                const currentStr = data.currentVersion ? ` (current: v${String(data.currentVersion).replace(/^v/, '')})` : '';
                setUpdateInfo(`Update Available${latestStr}${currentStr}`);
            } else {
                setUpdateAvailable(false);
                const currentStr = data.currentVersion ? ` (current release: v${String(data.currentVersion).replace(/^v/, '')})` : '';
                setUpdateInfo(`Up to date${currentStr}`);
            }
        } catch (e: unknown) {
            setUpdateAvailable(false);
            setUpdateInfo(`Unable to check for updates: ${e instanceof Error ? e.message : 'Network error'}`);
        } finally {
            setCheckingUpdate(false);
        }
    };

    // Making a break-glass code asks an owner's fresh proof each time (server admin.ts break-glass/issue, C7).
    const breakGlassProof = useFreshProof();

    // A break-glass code is made for the signed-in owner's own key, from their phone's Manage hand-off.
    const handleIssueBreakGlass = async () => {
        setBreakGlassMessage('');
        await sendBreakGlassIssue();
    };

    /** Sends this request; after the node asked the proof, the same one again with the code. */
    const sendBreakGlassIssue = async (code?: string) => {
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/auth/break-glass/issue');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(nodeCredential(activeNode)),
                body: JSON.stringify({ ...proofField(code) }),
            });
            if (await breakGlassProof.check(res, (c) => sendBreakGlassIssue(c), code)) return;
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.breakGlassCode) {
                setBreakGlassShown(data.breakGlassCode);
            } else {
                setBreakGlassMessage(`No code was made: ${data.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setBreakGlassMessage(e instanceof Error ? e.message : String(e));
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
            {confirmation}
            {/* Header & Subtabs */}
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-nature-800 pb-4">
                <div>
                    <h2 className="text-xl font-black text-white m-0 tracking-tight flex items-center gap-2.5">
                        <span>⚙️</span>
                        <span>Appliance &amp; Data</span>
                        <HelpLink screen={`appliance/${subTab}`} />
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        Backups &amp; restore wizard, logs, ledger conservation, network, identity, and access
                    </p>
                </div>

                <SubTabStrip wrap={true}>
                    <button
                        onClick={() => setSubTab('diagnostics')}
                        data-subtab="diagnostics"
                        aria-current={subTab === 'diagnostics' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'diagnostics'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Diagnostics &amp; Logs
                    </button>
                    <button
                        onClick={() => setSubTab('backups')}
                        data-subtab="backups"
                        aria-current={subTab === 'backups' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'backups'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Backups &amp; Restore
                    </button>
                    <button
                        onClick={() => setSubTab('gateway')}
                        data-subtab="gateway"
                        aria-current={subTab === 'gateway' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'gateway'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Gateway &amp; Peers
                    </button>
                    <button
                        onClick={() => setSubTab('network')}
                        data-subtab="network"
                        aria-current={subTab === 'network' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'network'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Addresses
                    </button>
                    <button
                        onClick={() => setSubTab('identity')}
                        data-subtab="identity"
                        aria-current={subTab === 'identity' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'identity'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Node Identity
                    </button>
                    <button
                        onClick={() => setSubTab('access')}
                        data-subtab="access"
                        aria-current={subTab === 'access' ? 'page' : undefined}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all shrink-0 whitespace-nowrap min-h-[48px] lg:min-h-0 lg:shrink lg:whitespace-normal ${
                            subTab === 'access'
                                ? 'bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/40 shadow-sm'
                                : 'text-nature-400 hover:text-white border border-transparent'
                        }`}
                    >
                        Access &amp; Security
                    </button>
                </SubTabStrip>
            </div>

            {/* Read-only Version / Update-Available / Last-Backup Card (per admin-surface §4.3). On a phone, only on
                Diagnostics & Logs: there it is a screen tall and would push every other sub-tab's content off it. */}
            <div className={`p-5 rounded-2xl bg-nature-900/90 border border-nature-800 shadow-xl ${subTab === 'diagnostics' ? '' : 'hidden lg:block'}`}>
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 flex-1">
                        {/* Node Version */}
                        <div className="p-3.5 rounded-xl bg-nature-950 border border-nature-800">
                            <span className="text-[10px] uppercase font-bold text-nature-400 tracking-wider">Node Version</span>
                            <div className="text-lg font-black text-white font-mono mt-0.5 flex items-center gap-2">
                                <span>{nodeVersion ? (nodeVersion.startsWith('v') ? nodeVersion : `v${nodeVersion}`) : ''}</span>
                                {nodeVersion ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-bp-chip-need-tint text-bp-chip-need-ink border border-terra-500/30">
                                        Release
                                    </span>
                                ) : null}
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
                                className="px-3.5 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all flex items-center justify-center gap-1.5 shadow-sm shrink-0"
                            >
                                <span>🧹</span>
                                <span>Clean Orphaned Media &amp; Compress Logs</span>
                            </button>
                        </div>

                        {/* 80% Warning Banner */}
                        {effectiveDiskHealth && (effectiveDiskHealth.warning || effectiveDiskHealth.usedPercent >= 80) && (
                            <div
                                role="alert"
                                className="p-4 rounded-xl bg-amber-950/70 border border-amber-500/50 text-amber-200 text-xs flex items-start gap-3"
                            >
                                <span className="text-base leading-none" aria-hidden="true">⚠️</span>
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
                                                <span className="w-2 h-2 rounded-full bg-terra-500"></span>
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
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
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
                                className="px-3.5 py-1.5 rounded-lg bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50"
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
                                    {/* The audit's figures are whole hundredths (engine audit.ts runConservationCheck): said in Beans. */}
                                    <div className="font-mono text-white mt-0.5 font-bold">{isHundredths(auditState.result.drift) ? `${beansFigure(auditState.result.drift)} beans` : 'not a number'}</div>
                                </div>
                                <div>
                                    <span className="text-nature-400 font-medium">Total Balances</span>
                                    <div className="font-mono text-white mt-0.5 font-bold">{auditState.result.sumBalances === undefined ? '0 beans' : isHundredths(auditState.result.sumBalances) ? `${beansFigure(auditState.result.sumBalances)} beans` : 'not a number'}</div>
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

                        {auditState.result && (
                            <SectionErrorBoundary sectionName="Stranded escrows" resetKey={activeNode.id}>
                                <StrandedEscrowsPanel
                                    activeNode={activeNode}
                                    refreshKey={auditState.result}
                                    canWriteOff={rolesViewer.kind === 'token' || rolesViewer.role === 'owner'}
                                    isStandby={isStandby}
                                    onWrittenOff={onRunLedgerAudit}
                                />
                            </SectionErrorBoundary>
                        )}
                    </div>

                    {/* Real-time Logs Streamer */}
                    <LogsModule logs={nodeLogs} onRefresh={onRefreshLogs} />
                </div>
            )}

            {/* Subtab: Backups & Restore */}
            {subTab === 'backups' && (
                <div className="space-y-6">
                    {/* Lights-out H4: the checklist for keeping the community going from a laptop in the hall (owners and admins; a standby has its own panels). */}
                    <SectionErrorBoundary sectionName="Ready for the hall" resetKey={activeNode.id}>
                        <ReadyForTheHallCard activeNode={activeNode} diag={diag} viewer={rolesViewer} isStandby={isStandby} />
                    </SectionErrorBoundary>

                    <SectionErrorBoundary sectionName="Who can unlock this community" resetKey={activeNode.id}>
                        <TakeoverLockPanel activeNode={activeNode} viewer={rolesViewer} communityName={diag?.communityName || undefined} />
                    </SectionErrorBoundary>

                    {/* Owners' "12 words checked" (sealed-keys.md §7). Shown under "Who can unlock this community" (#979). */}
                    <SectionErrorBoundary sectionName="Owners' 12 words" resetKey={activeNode.id}>
                        <OwnerWordsChecksPanel activeNode={activeNode} />
                    </SectionErrorBoundary>
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
                                <span>Restore from a locked backup</span>
                            </h3>
                            <p className="text-xs text-nature-400 m-0">
                                Restore this server from a locked backup (.bpsealed), opened with the recovery code or an owner's phone. It replaces the
                                community's database with the backup's; a restore point is taken first, so you can roll back. An older unlocked
                                (.tar.gz) backup restores on the server itself: <code className="font-mono">beanpool restore --unlocked FILE</code>.
                            </p>

                            {restoreStatus && (
                                <div role="status" data-testid="restore-status" className="p-3 rounded-xl bg-nature-950 border border-terra-500/50 text-xs text-bp-ink-terra space-y-2" style={{ overflowWrap: 'anywhere' }}>
                                    <p className="m-0">{restoreStatus}</p>
                                    {restoreCommand && (
                                        <p className="m-0">On the server: <code className="font-mono text-white">{restoreCommand}</code></p>
                                    )}
                                </div>
                            )}

                            {lockedRestore ? (
                                <RestoreLockedBackup
                                    activeNode={activeNode}
                                    file={lockedRestore.file}
                                    backup={lockedRestore.backup}
                                    canUseCode={lockedRestore.canUseCode}
                                    canUsePhone={lockedRestore.canUsePhone}
                                    onDone={(message) => { setLockedRestore(null); setRestoreFile(null); setRestoreStatus(message); }}
                                    onCancel={() => setLockedRestore(null)}
                                />
                            ) : (
                            <form
                                onSubmit={handleRestoreSubmit}
                                className="space-y-3"
                            >
                                <input
                                    type="file"
                                    accept=".bpsealed"
                                    aria-label="Locked backup file (.bpsealed)"
                                    onChange={(e) => { setRestoreFile(e.target.files?.[0] || null); setRestoreStatus(null); setRestoreCommand(null); }}
                                    className="block w-full text-xs text-nature-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-nature-800 file:text-white hover:file:bg-nature-700"
                                />
                                <button
                                    type="submit"
                                    disabled={!restoreFile || restoring}
                                    className="w-full py-2.5 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on border border-bp-danger-fill transition-all disabled:opacity-50"
                                >
                                    {restoring ? 'Reading the backup…' : 'Restore from Backup'}
                                </button>
                            </form>
                            )}
                        </div>
                    </div>

                    {/* Restore points (design case 18 §3.3): read-only list and Roll back, owners only (draws nothing for an admin) */}
                    <SectionErrorBoundary sectionName="Restore points" resetKey={activeNode.id}>
                        <RestorePointsPanel key={activeNode.id} activeNode={activeNode} viewer={rolesViewer} />
                    </SectionErrorBoundary>

                    {/* Automated Backup Schedule Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>⏱️</span>
                                    <span>Automated Backup Schedule</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Autonomous on-disk point-in-time snapshots using crash-consistent SQLite VACUUM INTO. Taken on the main server only; none is kept past 14 days.
                                </p>
                            </div>
                            <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                scheduleKnown && scheduleConfig?.enabled
                                    ? 'bg-bp-chip-ok-tint text-bp-chip-ok-ink border border-emerald-500/30'
                                    : 'bg-nature-800 text-nature-400'
                            }`}>
                                {!scheduleKnown || !scheduleConfig ? 'Unknown' : scheduleConfig.enabled ? `Active (${scheduleConfig.intervalHours}h)` : 'Disabled'}
                            </span>
                        </div>

                        {scheduleStatusMsg && (
                            <div className="p-3 rounded-xl bg-nature-950 border border-nature-800 text-xs text-emerald-300">
                                {scheduleStatusMsg}
                            </div>
                        )}

                        {!scheduleKnown || !scheduleConfig ? (
                            <p className="text-xs text-nature-400 m-0">
                                {scheduleReadFailed
                                    ? "The node's schedule could not be read, so it can't be changed from here right now."
                                    : "Reading the node's schedule…"}
                            </p>
                        ) : (
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
                                            className="rounded border-nature-700 text-bp-ink-terra focus:ring-0"
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
                                        </select>
                                        <button
                                            type="submit"
                                            disabled={savingSchedule}
                                            className="px-4 py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50 shrink-0"
                                        >
                                            {savingSchedule ? 'Saving...' : 'Save'}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        )}
                        {scheduleKnown && scheduleConfig && (
                            <FreshProofBox proof={scheduleProof} testId="schedule-proof" onCancel={cancelSchedule} />
                        )}
                    </div>

                    {/* Database Integrity Verification Card */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
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
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
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
                                className="px-3.5 py-1.5 rounded-lg bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50"
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
                                        className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 text-xs"
                                    >
                                        <div className="min-w-0">
                                            <div className="font-bold text-white font-mono break-words">{s.name}</div>
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
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Backups off the server (the owners' card: the node answers anyone else 403) */}
                    <SectionErrorBoundary sectionName="Backups off the server" resetKey={activeNode.id}>
                        <OffboxBackupsPanel activeNode={activeNode} />
                    </SectionErrorBoundary>

                    {/* This server's alerts (the owners' card: the node answers anyone else 403) */}
                    <SectionErrorBoundary sectionName="Alerts" resetKey={activeNode.id}>
                        <AlertsPanel activeNode={activeNode} />
                    </SectionErrorBoundary>

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

                    {/* Take over as the main server (a standby), or how a take-over went (the server it made main). */}
                    <SectionErrorBoundary sectionName="Take over" resetKey={activeNode.id}>
                        <TakeoverPanel activeNode={activeNode} isStandby={isStandby} />
                    </SectionErrorBoundary>
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

                    <EverydayRuleRows
                        key={`connections-${activeNode.id}`}
                        activeNode={activeNode}
                        viewer={rolesViewer}
                        group="connections"
                        title="Connections to other communities"
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

            {/* Subtab: Addresses */}
            {subTab === 'network' && (
                <div className="space-y-6">
                    {/* Lights-out (LightsOutCard): the owner's switch for the hall, first, where an owner in the hall looks. */}
                    <SectionErrorBoundary sectionName="Lights-out" resetKey={activeNode.id}>
                        <LightsOutCard key={activeNode.id} activeNode={activeNode} viewer={rolesViewer} />
                    </SectionErrorBoundary>
                    <SectionErrorBoundary sectionName="Addresses" resetKey={activeNode.id}>
                        <AddressesPanel
                            key={activeNode.id}
                            activeNode={activeNode}
                            onRefreshDiag={onRefreshDiag}
                            viewer={rolesViewer}
                        />
                    </SectionErrorBoundary>
                </div>
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
                    <div className="mt-6">
                        <EverydayRuleRows
                            key={`found-${activeNode.id}`}
                            activeNode={activeNode}
                            viewer={rolesViewer}
                            group="found"
                            title="Being found"
                            intro="What the public directory and the map show, and what visitors see."
                        />
                    </div>
                    {/* The listing promise (Mothership A3): its four lines and the closing day, under Directory Publishing. */}
                    <ListingPromisePanel key={`promise-${activeNode.id}`} activeNode={activeNode} viewer={rolesViewer} />
                </SectionErrorBoundary>
            )}

            {/* Subtab: Access & Security */}
            {subTab === 'access' && (
                <div className="space-y-6 max-w-2xl">
                    {/* Break-Glass Emergency Recovery Card (per admin-surface §2.2) */}
                    <div className="p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
                        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <div className="min-w-0">
                                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>🚨</span>
                                    <span>Break-Glass Emergency Recovery</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Attributable recovery mechanism when member keys or paired devices are lost
                                </p>
                            </div>
                        </div>

                        {/* What the server does with a code (admin-auth.ts: the two enrol routes only; admin-key-auth.ts enrolAdminOwnerKey: every member is told, the log records it). */}
                        <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-3 text-xs">
                            <p className="text-nature-300 m-0 leading-relaxed" data-testid="break-glass-what">
                                {t('A break-glass code does one thing, it enrols a new key, and it opens nothing else in Settings.')}
                            </p>
                            <p className="text-nature-400 m-0 leading-relaxed" data-testid="break-glass-audit">
                                {t("When one is used, every member gets a notice that a new admin key was authorised and for whom, and the node's log records it.")}
                            </p>
                        </div>

                        <div className="p-4 rounded-xl bg-nature-950/60 border border-nature-800/80 space-y-3">
                            <span className="text-xs font-semibold text-nature-300">Your break-glass code</span>
                            {breakGlassShown ? (
                                <div className="space-y-2">
                                    <p className="text-[11px] text-nature-300 m-0">
                                        Write this down and keep it offline. It is shown once; any earlier code no longer works.
                                    </p>
                                    <p className="font-mono text-base text-white break-all select-all m-0" data-testid="break-glass-code">{breakGlassShown}</p>
                                    <button
                                        type="button"
                                        onClick={() => setBreakGlassShown(null)}
                                        className="min-h-[48px] w-full py-2.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700"
                                    >
                                        I have kept it safe
                                    </button>
                                </div>
                            ) : rolesViewer.kind === 'key' && rolesViewer.role === 'owner' ? (
                                <div className="space-y-2">
                                    <p className="text-[11px] text-nature-400 m-0">
                                        Makes a new code for your own key. Any code you had before stops working.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={handleIssueBreakGlass}
                                        className="min-h-[48px] w-full py-2.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on"
                                    >
                                        Make a break-glass code
                                    </button>
                                </div>
                            ) : (
                                <p className="text-[11px] text-nature-400 m-0">
                                    {isOwnerViewer
                                        ? "An owner makes a break-glass code from their own phone: Settings, Community admin, Break-glass code in the BeanPool app."
                                        : 'Only an owner has a break-glass code.'}
                                </p>
                            )}
                            <FreshProofBox proof={breakGlassProof} testId="break-glass-proof" />
                            {breakGlassMessage && <p className="text-[11px] text-amber-300 m-0" role="alert">{breakGlassMessage}</p>}
                        </div>
                    </div>

                    {/* Automation tokens: owners only (the panel draws nothing for anyone else) */}
                    <SectionErrorBoundary sectionName="Automation tokens" resetKey={activeNode.id}>
                        <AutomationTokensPanel key={activeNode.id} activeNode={activeNode} viewer={rolesViewer} />
                    </SectionErrorBoundary>

                    {/* Connected assistants (admin MCP S3): owners and admins, each their own; owners see every one */}
                    <SectionErrorBoundary sectionName="Connected assistants" resetKey={activeNode.id}>
                        <ConnectedAssistantsPanel key={activeNode.id} activeNode={activeNode} viewer={rolesViewer} />
                    </SectionErrorBoundary>
                </div>
            )}

            {/* One-Click Clean Storage & Compress Logs Modal */}
            {showCleanModal && (
                <ModalBackdrop
                    onClose={() => setShowCleanModal(false)}
                    dismissable={!cleaningStorage}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="clean-storage-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-nature-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 text-white">
                        <div className="flex items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                            <h3 id="clean-storage-title" className="text-base font-bold m-0 flex items-center gap-2 min-w-0 flex-1">
                                <span>🧹</span>
                                <span>Clean Orphaned Media &amp; Compress Logs</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => setShowCleanModal(false)}
                                disabled={cleaningStorage}
                                aria-label="Close storage cleanup modal"
                                className="shrink-0 w-11 h-11 flex items-center justify-center rounded-lg text-nature-400 hover:text-white text-lg font-bold disabled:opacity-40 disabled:pointer-events-none transition-colors"
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
                                    {/* Never "complete" while the node says orphans remain: it stops after a few seconds. */}
                                    <span>{(cleanResult.remainingImageObjectsCount ?? 0) > 0 ? 'Cleanup started: more to remove' : 'Cleanup Complete!'}</span>
                                </div>
                                <p className="m-0">
                                    Successfully reclaimed <strong>{formatBytes(cleanResult.totalReclaimedBytes)}</strong> of disk space:
                                </p>
                                <ul className="list-disc list-inside space-y-1 text-emerald-300">
                                    <li>Removed {cleanResult.removedPhotosCount} orphaned post photos ({formatBytes(cleanResult.removedPhotosBytes)})</li>
                                    {cleanResult.removedImageObjectsCount !== undefined && (
                                        <li>Removed {cleanResult.removedImageObjectsCount} unreferenced stored photos and attachments ({formatBytes(cleanResult.removedImageObjectsBytes ?? 0)})</li>
                                    )}
                                    <li>Removed {cleanResult.removedThumbnailsCount} orphaned cached thumbnails ({formatBytes(cleanResult.removedThumbnailsBytes)})</li>
                                    <li>Compressed and pruned {cleanResult.compressedLogsCount} old log events ({formatBytes(cleanResult.compressedLogsBytes)})</li>
                                </ul>
                                {(cleanResult.remainingImageObjectsCount ?? 0) > 0 && (
                                    <p className="m-0">
                                        <strong>{cleanResult.remainingImageObjectsCount} more</strong> unreferenced stored photos and attachments
                                        remain ({formatBytes(cleanResult.remainingImageObjectsBytes ?? 0)}). The node keeps removing them in the
                                        background, a batch at a time.
                                    </p>
                                )}
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

                                    {cleanPreview.orphanedImageObjects && (
                                        <div className="flex items-center justify-between pb-2 border-b border-nature-800/80">
                                            <div>
                                                <span className="font-bold text-white block">Unreferenced Stored Images</span>
                                                <span className="text-[11px] text-nature-400">Photos and attachments in the image store that nothing points at</span>
                                            </div>
                                            <div className="text-right">
                                                <span className="font-bold text-white font-mono">{cleanPreview.orphanedImageObjects.count} objects</span>
                                                <span className="text-[11px] text-nature-400 block font-mono">{formatBytes(cleanPreview.orphanedImageObjects.totalBytes)}</span>
                                            </div>
                                        </div>
                                    )}

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
                                        <span className="text-bp-ink-terra font-mono">{formatBytes(cleanPreview.totalReclaimableBytes)}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-3 border-t border-nature-800">
                            <button
                                type="button"
                                onClick={() => setShowCleanModal(false)}
                                disabled={cleaningStorage}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-nature-300 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                            >
                                {cleanResult ? 'Close' : 'Cancel'}
                            </button>
                            {!cleanResult && (
                                <button
                                    type="button"
                                    onClick={handleExecuteClean}
                                    disabled={loadingPreview || cleaningStorage || !cleanPreview}
                                    className="px-4 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50 flex items-center gap-1.5"
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
                </ModalBackdrop>
            )}
        </div>
    );
}
