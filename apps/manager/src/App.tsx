import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    loadNodeProfiles,
    addNodeProfile,
    removeNodeProfile,
    loadActiveProfileId,
    saveActiveProfileId,
    updateNodeProfile,
    saveNodeProfiles,
    type NodeProfile,
} from './lib/profiles';
import {
    fetchDiagnostics,
    fetchGatewayConfig,
    updateGatewayConfig,
    fetchNodeData,
    fetchNodeLogs,
    freezeNodeUser,
    pruneNodeUser,
    updateNodeUserTier,
    updateNodeUserVoucher,
    updateNodeUserOperator,
    fetchNodeTreasuries,
    createNodeTreasury,
    seedTreasuryOffer,
    loginToNode,
    buildAdminHeaders,
    getTfaSessionToken,
    setTfaSessionToken,
    type DiagnosticsResponse,
    type GatewayConfig,
} from './lib/node-client';

import { FleetSidebar, type TabId, type NodeHealthStatus, type AlertCounts } from './components/layout/FleetSidebar';
import { AddNodeModal } from './components/nodes/AddNodeModal';
import { EditNodeModal } from './components/nodes/EditNodeModal';
import { TotpModal } from './components/nodes/TotpModal';

import { TelemetryModule, type NodeDiagnosticState, type TelemetryHistoryPoint } from './components/modules/TelemetryModule';
import { AnalyticsModule } from './components/modules/AnalyticsModule';
import { OnboardingModule } from './components/modules/OnboardingModule';
import { GatewayModule } from './components/modules/GatewayModule';
import { MembersModule } from './components/modules/MembersModule';
import { TopologyModule } from './components/modules/TopologyModule';
import { InvitesModule } from './components/modules/InvitesModule';
import { LogsModule } from './components/modules/LogsModule';
import { AiServicesModule } from './components/modules/AiServicesModule';

/**
 * Does this error mean "wrong password" rather than "node unreachable"?
 *
 * `fetchDiagnostics` throws `HTTP 401: Unauthorized`; the friendlier per-endpoint
 * messages say the same thing in words. Both are matched, because retrying is futile
 * either way — no amount of waiting turns a rejected password into an accepted one.
 */
function isAuthFailure(message: string): boolean {
    return /\b401\b/.test(message) || /unauthor/i.test(message) || /admin password/i.test(message);
}

/**
 * A short digest of a stored password, used only to tell whether the credential we are
 * blocked on is still the one sitting in the profile.
 *
 * Not a security boundary: the password itself already lives in localStorage, and this
 * never leaves the tab. It exists so the block lifts by itself the moment the value
 * changes — however it changed, whether through the edit modal, an imported profile
 * list, or someone editing localStorage by hand — without keeping a second copy of the
 * secret around to do it.
 *
 * Being 32-bit it can in principle collide, which would leave the poll switched off for
 * one node after a password change. The length prefix narrows it further, the odds are
 * remote, and the cost is one press of Refresh — so a wider hash would buy nothing here.
 * `charCodeAt` over UTF-16 units is fine for the same reason: it only ever has to be
 * consistent with itself, within one tab, for as long as that tab is open.
 */
function credentialDigest(password?: string): string {
    if (!password) return 'none';
    let h = 0x811c9dc5;
    for (let i = 0; i < password.length; i++) {
        h ^= password.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return `${password.length}:${(h >>> 0).toString(36)}`;
}

export function App() {
    const [profiles, setProfiles] = useState<NodeProfile[]>(() => loadNodeProfiles());
    const [activeProfileId, setActiveProfileId] = useState<string>(() => loadActiveProfileId());
    const [activeTab, setActiveTab] = useState<TabId>(() => {
        try {
            return (localStorage.getItem('bp_fleet_active_tab') as TabId) || 'overview';
        } catch {
            return 'overview';
        }
    });

    const activeNode = profiles.find((p) => p.id === activeProfileId) || profiles[0];

    const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const [diagError, setDiagError] = useState<string | null>(null);

    const [fleetDiags, setFleetDiags] = useState<Record<string, NodeDiagnosticState>>({});
    const [fleetNodeData, setFleetNodeData] = useState<Record<string, any>>({});
    const [fleetGateways, setFleetGateways] = useState<Record<string, GatewayConfig>>({});

    const [gateway, setGateway] = useState<GatewayConfig | null>(null);
    const [gatewayLoading, setGatewayLoading] = useState(false);
    const [gatewaySuccess, setGatewaySuccess] = useState<string | null>(null);
    const [gatewaySaving, setGatewaySaving] = useState(false);

    const [nodeData, setNodeData] = useState<any | null>(null);
    const [nodeDataLoading, setNodeDataLoading] = useState(false);
    const [nodeLogs, setNodeLogs] = useState<any[]>([]);

    const [showAddModal, setShowAddModal] = useState(false);
    const [editingNode, setEditingNode] = useState<NodeProfile | null>(null);

    // 2FA / TOTP prompt state — when a node returns totpRequired, this modal pops up
    const [totpPromptNode, setTotpPromptNode] = useState<{ profileId: string; name: string; url: string } | null>(null);
    const [totpError, setTotpError] = useState<string | null>(null);
    // Tracks pending retry after TOTP login completes (resolves the pending promise)
    const pendingTotpResolve = useRef<((token: string) => void) | null>(null);

    /**
     * Show the TOTP prompt modal and wait for the operator to complete 2FA.
     * The modal handles loginToNode internally via handleTotpSubmit.
     * Returns the 2FA session token on success, empty string if cancelled.
     */
    const promptForTotp = (profileId: string, nodeName: string, nodeUrl: string): Promise<string> => {
        // Guard: if a TOTP prompt is already active for another node, reject
        // with a distinct sentinel so the caller can retry on the next poll
        // instead of permanently blocking.
        if (pendingTotpResolve.current) {
            return Promise.reject(new Error('2FA_PROMPT_BUSY'));
        }
        return new Promise((resolve, reject) => {
            setTotpError(null);
            setTotpPromptNode({ profileId, name: nodeName, url: nodeUrl });
            pendingTotpResolve.current = (code: string) => {
                setTotpPromptNode(null);
                pendingTotpResolve.current = null;
                if (code) resolve(code);
                else reject(new Error('2FA_CANCELLED'));
            };
        });
    };

    /**
     * Handle TOTP code submission from the modal.
     * Attempts login and stores the session token on success.
     * On failure, shows the error inline so the operator can retry.
     */
    const handleTotpSubmit = async (code: string) => {
        if (!totpPromptNode) return;
        setTotpError(null);
        try {
            // Find the profile to get the admin password
            const profile = profiles.find(p => p.id === totpPromptNode.profileId);
            if (!profile || !profile.adminPassword) {
                setTotpError('No admin password configured for this node');
                return;
            }
            const loginRes = await loginToNode(totpPromptNode.url, profile.adminPassword, code);
            if (loginRes.tfaSessionToken) {
                setTfaSessionToken(totpPromptNode.profileId, loginRes.tfaSessionToken);
                // Resolve the pending promise with the token so refreshFleetDiagnostics
                // can retry with the session token
                if (pendingTotpResolve.current) {
                    pendingTotpResolve.current(loginRes.tfaSessionToken);
                    pendingTotpResolve.current = null;
                }
            } else {
                setTotpError('Server did not issue a session token');
            }
        } catch (e: any) {
            setTotpError(e.message || 'Verification failed');
        }
    };

    /**
     * Handle TOTP modal cancellation.
     */
    const handleTotpCancel = () => {
        setTotpPromptNode(null);
        setTotpError(null);
        if (pendingTotpResolve.current) {
            pendingTotpResolve.current(''); // empty string = cancelled
            pendingTotpResolve.current = null;
        }
    };

    /**
     * Handle successful diagnostics response: update state, fetch secondary data.
     */
    const diagSuccess = useCallback((p: NodeProfile, data: DiagnosticsResponse) => {
        // Lifted on any success, not just on a credential edit. The password can
        // also start working without this manager touching it — the operator
        // resets it on the node itself to the value already stored here — and
        // without this the digest would still match, so the automatic poll would
        // stay switched off for a node that is answering perfectly well, until
        // somebody thought to open the edit modal and press save.
        delete authBlockedRef.current[p.id];
        setFleetDiags((prev) => ({
            ...prev,
            [p.id]: { diag: data, loading: false, error: null },
        }));

        // Fetch node gateway config for security alerts
        (async () => {
            try {
                const gData = await fetchGatewayConfig(p.url, p.adminPassword, getTfaSessionToken(p.id));
                if (gData) {
                    setFleetGateways((prev) => ({ ...prev, [p.id]: gData }));
                    if (p.id === activeNode?.id && gData) {
                        setGateway((prev) => (prev === null ? gData : prev));
                    }
                }
            } catch {}
        })();

        // Fetch node data to check for active abuse/security flags
        (async () => {
            try {
                const nData = await fetchNodeData(p.url, p.adminPassword, getTfaSessionToken(p.id));
                setFleetNodeData((prev) => ({ ...prev, [p.id]: nData }));

                let savedDismissed = new Set<string>();
                try {
                    const saved = localStorage.getItem('bp_dismissed_flags');
                    if (saved) savedDismissed = new Set(JSON.parse(saved));
                } catch {}

                const flags = (nData?.health?.flags || []).filter(
                    (f: any) => !savedDismissed.has(f.id || f.type || f.description)
                );
                const reports = (nData?.reports || []).filter(
                    (r: any) => !savedDismissed.has(r.id || r.targetPubkey || r.reason)
                );

                const hasAlert = flags.some((f: any) => f.severity === 'critical' || f.severity === 'alert') || reports.length > 0;
                const hasWarning = flags.some((f: any) => f.severity === 'warning');

                const status: NodeHealthStatus = hasAlert ? 'alert' : hasWarning ? 'warning' : 'online';
                setNodeHealthMap((prev) => ({ ...prev, [p.id]: status }));
            } catch {}
        })();

        if (p.id === activeNode?.id) {
            setDiag(data);
            setDiagError(null);
        }
    }, [activeNode]);

    /**
     * Nodes whose stored admin password the node itself rejected — profile id → digest of
     * the credential that was refused.
     *
     * A ref rather than state on purpose. The 5-second poll below is created once per
     * `profiles` change, so a state value read inside it would be the one captured when
     * that effect ran: permanently empty, and the skip would never fire. Nothing renders
     * from this either — the card's "🔒 Auth Required" prompt comes from the error left
     * sitting in `fleetDiags`.
     */
    const authBlockedRef = useRef<Record<string, string>>({});

    const [nodeHealthMap, setNodeHealthMap] = useState<Record<string, NodeHealthStatus>>({});
    const [historyMap, setHistoryMap] = useState<Record<string, TelemetryHistoryPoint[]>>({});

    useEffect(() => {
        if (activeProfileId) {
            saveActiveProfileId(activeProfileId);
        }
    }, [activeProfileId]);

    useEffect(() => {
        try {
            localStorage.setItem('bp_fleet_active_tab', activeTab);
        } catch {}
    }, [activeTab]);

    // Accumulate telemetry history when fleetDiags updates
    useEffect(() => {
        const now = Date.now();
        setHistoryMap((prev) => {
            const next = { ...prev };
            profiles.forEach((p) => {
                const diag = fleetDiags[p.id]?.diag;
                const nodePoints = [...(next[p.id] || [])];

                if (diag) {
                    let reportedCpu = diag.cpuLoadPercent || 0;
                    let reportedMem = diag.memoryUsageMb || 0;
                    let reportedTotalMem = diag.totalMemoryMb || 1024;

                    try {
                        const targetHost = p.url ? new URL(p.url).hostname : '';
                        const sameHostCount = profiles.filter((other) => {
                            try {
                                return other.url && new URL(other.url).hostname === targetHost;
                            } catch {
                                return false;
                            }
                        }).length;

                        if (sameHostCount > 1) {
                            if (reportedCpu >= 90) {
                                reportedCpu = Math.min(95, Math.round(reportedCpu / sameHostCount));
                            }
                            if (reportedMem > 300) {
                                reportedMem = Math.round(reportedMem / sameHostCount);
                                reportedTotalMem = Math.round(reportedTotalMem / sameHostCount);
                            }
                        }
                    } catch {}

                    const point: TelemetryHistoryPoint = {
                        timestamp: now,
                        cpu: reportedCpu,
                        memMb: reportedMem,
                        totalMemMb: reportedTotalMem,
                        ws: diag.activeWsConnections || 0,
                        p2p: diag.p2pActivePeers || 0,
                        walMb: (diag.walSizeBytes || 0) / (1024 * 1024),
                        dbMb: (diag.dbSizeBytes || 0) / (1024 * 1024),
                    };

                    const lastPoint = nodePoints[nodePoints.length - 1];
                    if (!lastPoint || now - lastPoint.timestamp >= 4000) {
                        nodePoints.push(point);
                    }
                }

                next[p.id] = nodePoints.slice(-30);
            });
            return next;
        });
    }, [fleetDiags, profiles]);

    /**
     * Load fleet-wide diagnostics and health flags for all connected nodes.
     *
     * `manual` marks a refresh the operator asked for. Pass it from event handlers with an
     * arrow function rather than handing this straight to an `onClick` — React would supply
     * the click event as `opts`, `opts.manual` would be undefined, and the press would be
     * treated as an automatic poll that skips the very node being retried. The prop types
     * involved are `() => void`, so the compiler will not catch that for you.
     */
    const refreshFleetDiagnostics = async (opts?: { manual?: boolean }) => {
        profiles.forEach(async (p) => {
            // A node that rejected its password five seconds ago will reject it again
            // now, and retrying regardless did real harm. The server tarpits failed admin
            // auth with a delay that grows per failure (https-server.ts), that counter is
            // per-process rather than per-caller, and its 60-second reset never arrived
            // while this loop kept feeding it — so one wrong password in this manager put
            // a five-second delay on every admin request to that node, the operator's own
            // included. It also hid the cause: clearing `error` before each attempt left
            // the card reading "Connecting..." forever instead of showing the "Set
            // Password" prompt that was already written for exactly this situation.
            //
            // Only the automatic poll is held back. Anything the operator asks for by
            // hand still goes through, and re-blocks if it fails again.
            //
            // Also skip if we're already waiting for a TOTP code for this node.
            if (!opts?.manual && (authBlockedRef.current[p.id] === credentialDigest(p.adminPassword) || totpPromptNode?.profileId === p.id)) {
                return;
            }
            setFleetDiags((prev) => ({
                ...prev,
                [p.id]: { ...(prev[p.id] || { diag: null }), loading: true, error: null },
            }));
            try {
                // Use raw fetch instead of fetchDiagnostics so we can inspect
                // the response body for totpRequired errors (which node-client's
                // helper throws away).
                const diagUrl = new URL(p.url);
                if (!diagUrl.pathname.endsWith('/')) diagUrl.pathname += '/';
                diagUrl.pathname += 'api/local/admin/diagnostics';
                const diagHeaders = buildAdminHeaders(p.adminPassword, getTfaSessionToken(p.id));
                const diagRes = await fetch(diagUrl.toString(), { headers: diagHeaders, cache: 'no-store' });

                let totpRetry = false;
                let sessionToken: string | undefined;
                if (diagRes.status === 401) {
                    let body: any = null;
                    try { body = await diagRes.json(); } catch {}
                    if (body?.totpRequired) {
                        // Node requires 2FA and we don't have a valid session token.
                        // If we already have a stored session token, it may have expired —
                        // clear it and try to re-auth.
                        if (getTfaSessionToken(p.id)) {
                            setTfaSessionToken(p.id, undefined);
                        }
                        // Prompt operator for TOTP code (handleTotpSubmit in App.tsx
                        // performs the actual loginToNode call and stores the session
                        // token in the profile). promptForTotp resolves with the token
                        // if successful, or empty string if cancelled.
                        sessionToken = await promptForTotp(p.id, p.name, p.url);
                        if (sessionToken) {
                            totpRetry = true;
                        }
                        if (totpRetry) {
                            // Retry diagnostics with the session token
                            const retryHeaders = buildAdminHeaders(p.adminPassword, sessionToken);
                            const retryRes = await fetch(diagUrl.toString(), { headers: retryHeaders, cache: 'no-store' });
                            if (!retryRes.ok) {
                                throw new Error(`HTTP ${retryRes.status}: ${retryRes.statusText}`);
                            }
                            const data = await retryRes.json();
                            diagSuccess(p, data);
                        } else {
                            // User cancelled the TOTP prompt
                            throw new Error('2FA code required');
                        }
                        return; // handled above, don't fall through to catch
                    }
                }

                if (!diagRes.ok) {
                    throw new Error(`HTTP ${diagRes.status}: ${diagRes.statusText}`);
                }
                const data = await diagRes.json();
                diagSuccess(p, data);
            } catch (e: any) {
                const errMsg = e.message || 'Failed to connect';
                if (!errMsg.includes('429') && errMsg !== '2FA_PROMPT_BUSY') {
                    const authFailed = isAuthFailure(errMsg) || errMsg === '2FA_CANCELLED';
                    if (authFailed && errMsg !== '2FA_CANCELLED') {
                        authBlockedRef.current[p.id] = credentialDigest(p.adminPassword);
                    }
                    setFleetDiags((prev) => ({
                        ...prev,
                        [p.id]: { diag: null, loading: false, error: errMsg },
                    }));
                    // A rejected password is not an outage. Reporting it as `offline` sent
                    // someone hunting a network fault on a node that was up and answering
                    // every request it was asked — the sidebar now says which of the two
                    // it is, and they need different things done about them.
                    setNodeHealthMap((prev) => ({ ...prev, [p.id]: authFailed ? 'auth_required' : 'offline' }));
                    if (p.id === activeNode?.id) {
                        setDiagError(errMsg);
                    }
                }
            }
        });
    };

    // Load active node telemetry
    const loadDiagnostics = async () => {
        if (!activeNode) return;
        setDiagLoading(true);
        setDiagError(null);
        try {
            const data = await fetchDiagnostics(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setDiag(data);
            setFleetDiags((prev) => ({
                ...prev,
                [activeNode.id]: { diag: data, loading: false, error: null },
            }));
        } catch (e: any) {
            const errMsg = e.message || 'Failed to connect to node';
            if (!errMsg.includes('429')) {
                setDiagError(errMsg);
            }
        } finally {
            setDiagLoading(false);
        }
    };

    // Load gateway config
    const loadGateway = async () => {
        if (!activeNode) return;
        setGatewayLoading(true);
        try {
            const data = await fetchGatewayConfig(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setGateway(data);
        } catch (e: any) {
            const errMsg = e.message || '';
            // Only set gateway to null on explicit auth error, NOT on 429 rate limiting
            if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
                setGateway(null);
            }
        } finally {
            setGatewayLoading(false);
        }
    };

    // Load member data
    const loadNodeData = async () => {
        if (!activeNode) return;
        setNodeDataLoading(true);
        try {
            const data = await fetchNodeData(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setNodeData(data);
            setFleetNodeData((prev) => ({ ...prev, [activeNode.id]: data }));

            const flags = data?.health?.flags || [];
            const reports = data?.reports || [];
            const hasAlert = flags.some((f: any) => f.severity === 'critical' || f.severity === 'alert') || reports.length > 0;
            const hasWarning = flags.some((f: any) => f.severity === 'warning');

            const status: NodeHealthStatus = hasAlert ? 'alert' : hasWarning ? 'warning' : 'online';
            setNodeHealthMap((prev) => ({ ...prev, [activeNode.id]: status }));
        } catch (e: any) {
            const errMsg = e.message || '';
            if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
                setNodeData(null);
            }
        } finally {
            setNodeDataLoading(false);
        }
    };

    // Load logs
    const loadLogs = async () => {
        if (!activeNode) return;
        try {
            // fetchNodeLogs already unwraps to the array (`data.logs || []`) and throws on a non-OK
            // response, so there is nothing left to unwrap or guard here. Indexing `.logs` again
            // yields undefined and silently empties the panel.
            const logs = await fetchNodeLogs(activeNode.url, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setNodeLogs(logs);
        } catch (e: any) {
            // Keep existing logs on error
        }
    };

    const refreshAll = () => {
        // Manual: every caller of this is a human action — selecting a node, saving
        // credentials, pressing refresh — so an auth-blocked node gets another attempt.
        refreshFleetDiagnostics({ manual: true });
        loadGateway();
        loadNodeData();
        loadLogs();
    };

    /**
     * Bumped to ask for a refresh that must see freshly-saved state.
     *
     * Calling refreshAll() straight after setProfiles() re-fetched with the profile list
     * from the render that was on screen when the operator hit save — i.e. with the OLD
     * password. Entering the correct one therefore produced one more 401 and a flash of
     * "Auth Required" on the node that had just been fixed, which reads as the fix having
     * failed. Running it from an effect instead means it fires after the state has
     * flushed, so it sees what was actually saved.
     */
    const [refreshToken, setRefreshToken] = useState(0);
    useEffect(() => {
        if (refreshToken > 0) refreshAll();
    }, [refreshToken]);

    useEffect(() => {
        refreshFleetDiagnostics();
        const interval = setInterval(() => {
            refreshFleetDiagnostics();
        }, 5000);
        return () => clearInterval(interval);
    }, [profiles]);

    useEffect(() => {
        setDiag(null);
        setGateway(null);
        setNodeData(null);
        setNodeLogs([]);
        refreshAll();
    }, [activeProfileId]);

    const handleSaveGateway = async () => {
        if (!activeNode || !gateway) return;
        setGatewaySuccess(null);
        setGatewaySaving(true);
        try {
            const updated = await updateGatewayConfig(activeNode.url, gateway, activeNode.adminPassword, getTfaSessionToken(activeNode.id));
            setGateway(updated);
            setFleetGateways((prev) => ({ ...prev, [activeNode.id]: updated }));
            setGatewaySuccess('✅ Gateway configuration updated successfully!');
            setTimeout(() => setGatewaySuccess(null), 3000);
        } catch (e: any) {
            alert('Failed to update gateway: ' + e.message);
        } finally {
            setGatewaySaving(false);
        }
    };

    const handleAddNode = (name: string, url: string, adminPassword?: string) => {
        const created = addNodeProfile({ name, url, adminPassword });
        const updated = loadNodeProfiles();
        setProfiles(updated);
        setActiveProfileId(created.id);
        setShowAddModal(false);
    };

    const handleSaveNodeEdit = (id: string, updates: Partial<NodeProfile>) => {
        // If password is being changed, also clear any stored 2FA session token
        // so the operator re-authenticates with TOTP for the new credential.
        if (updates.adminPassword !== undefined) {
            setTfaSessionToken(id, undefined);
        }
        const updatedProfiles = updateNodeProfile(id, updates);
        setProfiles(updatedProfiles);
        setEditingNode(null);
        // Cleared outright, on top of the digest check: saving the SAME password again is
        // a deliberate "try it once more", and deserves an attempt rather than a silent
        // nothing-changed.
        delete authBlockedRef.current[id];
        setRefreshToken((n) => n + 1);
    };

    const handleRemoveNode = (id: string) => {
        if (profiles.length <= 1) {
            alert('Cannot delete the last node profile.');
            return;
        }
        if (confirm('Are you sure you want to remove this node profile from Fleet Manager?')) {
            removeNodeProfile(id);
            delete authBlockedRef.current[id];
            const remaining = loadNodeProfiles();
            setProfiles(remaining);
            setActiveProfileId(remaining[0].id);
        }
    };

    const handleReorderNodes = (fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= profiles.length || toIndex >= profiles.length) {
            return;
        }
        const updated = [...profiles];
        const [moved] = updated.splice(fromIndex, 1);
        updated.splice(toIndex, 0, moved);
        setProfiles(updated);
        saveNodeProfiles(updated);
    };

    // Aggregate alert and warning counts across all connected nodes in the fleet
    const offlineNodesCount = profiles.filter((p) => nodeHealthMap[p.id] === 'offline').length;
    const telemetryWalWarnings = profiles.filter((p) => {
        const wal = fleetDiags[p.id]?.diag?.walSizeBytes || 0;
        return wal > 10 * 1024 * 1024; // >10MB SQLite WAL file
    }).length;

    let globalDismissed = new Set<string>();
    try {
        const saved = localStorage.getItem('bp_dismissed_flags');
        if (saved) globalDismissed = new Set(JSON.parse(saved));
    } catch {}

    // Node-scoped alerts for active selected node
    const activeNodeData = activeProfileId ? fleetNodeData[activeProfileId] : null;
    const activeMemberCritical = activeNodeData ? (
        ((activeNodeData.health?.flags || []).filter((f: any) => !globalDismissed.has(f.id || f.type || f.description) && (f.severity === 'critical' || f.severity === 'alert')).length) +
        ((activeNodeData.reports || []).filter((r: any) => !globalDismissed.has(r.id || r.targetPubkey || r.reason)).length)
    ) : 0;

    const activeMemberWarning = activeNodeData ? (
        (activeNodeData.health?.flags || []).filter((f: any) => !globalDismissed.has(f.id || f.type || f.description) && f.severity === 'warning').length
    ) : 0;

    const logErrorsCount = nodeLogs.filter((l: any) => (l.level || '').toUpperCase() === 'ERROR').length;
    const logWarningsCount = nodeLogs.filter((l: any) => (l.level || '').toUpperCase() === 'WARN' || (l.level || '').toUpperCase() === 'WARNING').length;

    const activeGatewayData = activeProfileId ? fleetGateways[activeProfileId] || gateway : gateway;
    const activeGatewayCritical = activeGatewayData?.rateLimiting?.enabled === false ? 1 : 0;
    const activeGatewayWarning = activeGatewayData ? (
        ((activeGatewayData.corsAllowedOrigins || []).includes('*') ? 1 : 0) +
        (Object.values(activeGatewayData.features || {}).filter((v) => v === false).length)
    ) : 0;

    // Aggregate analytics peak alerts across all connected nodes
    let analyticsCritical = 0;
    let analyticsWarning = 0;

    profiles.forEach((p) => {
        const points = historyMap[p.id] || [];
        if (points.length > 0) {
            const last = points[points.length - 1];
            const memPct = (last.memMb / (last.totalMemMb || 1024)) * 100;
            const cpu = last.cpu;
            const walMb = last.walMb;

            const isCrit = cpu >= 90 || memPct >= 90 || walMb >= 20;
            const isWarn = !isCrit && (cpu >= 80 || memPct >= 80 || walMb >= 10);

            if (isCrit) analyticsCritical++;
            else if (isWarn) analyticsWarning++;
        }
    });

    const tabAlertCounts: Partial<Record<TabId, AlertCounts>> = {
        overview: { critical: offlineNodesCount, warning: telemetryWalWarnings },
        analytics: { critical: analyticsCritical, warning: analyticsWarning },
        topology: { critical: 0, warning: 0 },
        gateway: { critical: activeGatewayCritical, warning: activeGatewayWarning },
        members: { critical: activeMemberCritical, warning: activeMemberWarning },
        invites: { critical: 0, warning: 0 },
        logs: { critical: logErrorsCount, warning: logWarningsCount },
        ai: { critical: 0, warning: 0 },
    };

    return (
        <div className="min-h-screen bg-nature-950 text-nature-100 flex font-sans antialiased">
            {/* Left Vertical Navigation & Connected Fleet Sidebar */}
            <FleetSidebar
                profiles={profiles}
                activeProfileId={activeProfileId}
                onSelectNode={(id) => setActiveProfileId(id)}
                onOpenAddModal={() => setShowAddModal(true)}
                onEditNode={(node) => setEditingNode(node)}
                onRemoveNode={handleRemoveNode}
                onReorderNodes={handleReorderNodes}
                activeTab={activeTab}
                onSelectTab={(tab) => setActiveTab(tab)}
                nodeHealthMap={nodeHealthMap}
                tabAlertCounts={tabAlertCounts}
            />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-screen">
                {/* Active Target Banner for Control Subsystems */}
                {activeTab !== 'overview' && activeTab !== 'analytics' && (
                    <div className="bg-nature-900/60 border-b border-nature-800 px-6 py-2.5 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2 font-mono">
                            <span className="text-nature-400">Target Control Node:</span>
                            <span className="text-white font-bold">{activeNode?.name}</span>
                            <span className="text-nature-600">|</span>
                            <code className="text-terra-400">{activeNode?.url}</code>
                        </div>
                        <button
                            onClick={() => setEditingNode(activeNode)}
                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-200 font-bold transition-all border border-nature-700 flex items-center gap-1.5 active:scale-95"
                        >
                            <span>⚙️ Configure Credentials</span>
                        </button>
                    </div>
                )}

                {/* Workspace Body */}
                <main className="flex-1 p-6 md:p-8 max-w-7xl w-full mx-auto space-y-6">
                    {activeTab === 'overview' && (
                        <TelemetryModule
                            profiles={profiles}
                            activeProfileId={activeProfileId}
                            fleetDiags={fleetDiags}
                            fleetNodeData={fleetNodeData}
                            onSelectNode={(id: string) => setActiveProfileId(id)}
                            onInspectNodeThreats={(id: string) => {
                                setActiveProfileId(id);
                                setActiveTab('members');
                            }}
                            onEditNode={(node: NodeProfile) => setEditingNode(node)}
                            onRefreshFleet={() => refreshFleetDiagnostics({ manual: true })}
                            onSelectTab={(tab) => setActiveTab(tab)}
                        />
                    )}

                    {activeTab === 'analytics' && (
                        <AnalyticsModule
                            profiles={profiles}
                            activeProfileId={activeProfileId}
                            fleetDiags={fleetDiags}
                            historyMap={historyMap}
                            onSelectNode={(id: string) => setActiveProfileId(id)}
                            onEditNode={(node: NodeProfile) => setEditingNode(node)}
                            onRefreshFleet={() => refreshFleetDiagnostics({ manual: true })}
                        />
                    )}

                    {activeTab === 'gateway' && (
                        <GatewayModule
                            gateway={gateway}
                            gatewayLoading={gatewayLoading}
                            gatewaySuccess={gatewaySuccess}
                            gatewaySaving={gatewaySaving}
                            activeWsConnections={diag?.activeWsConnections || 3}
                            onChangeGateway={(updated) => setGateway(updated)}
                            onSaveGateway={handleSaveGateway}
                            onAuthenticate={(pwd) => {
                                if (activeNode) {
                                    handleSaveNodeEdit(activeNode.id, { adminPassword: pwd });
                                }
                            }}
                        />
                    )}

                    {activeTab === 'members' && (
                        <MembersModule
                            nodeData={nodeData}
                            nodeDataLoading={nodeDataLoading}
                            activeNodeUrl={activeNode?.url}
                            adminPassword={activeNode?.adminPassword}
                            onRefresh={() => loadNodeData()}
                            onFreezeUser={async (pubkey, freeze) => {
                                if (activeNode) {
                                    const headers = buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id));
                                    const url = `${activeNode.url.replace(/\/+$/, '')}/api/local/admin/users/${encodeURIComponent(pubkey)}/freeze`;
                                    await fetch(url, {
                                        method: 'POST',
                                        headers,
                                        body: JSON.stringify({ freeze, password: activeNode.adminPassword }),
                                    });
                                }
                            }}
                            onPruneUser={async (pubkey) => {
                                if (activeNode) {
                                    const headers = buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id));
                                    const url = `${activeNode.url.replace(/\/+$/, '')}/api/local/admin/users/${encodeURIComponent(pubkey)}/prune`;
                                    await fetch(url, {
                                        method: 'POST',
                                        headers,
                                        body: JSON.stringify({ password: activeNode.adminPassword }),
                                    });
                                }
                            }}
                            onUpdateTier={async (pubkey, tier) => {
                                if (activeNode) {
                                    await updateNodeUserTier(activeNode.url, pubkey, tier, activeNode.adminPassword);
                                }
                            }}
                            onToggleVoucher={async (pubkey, canVouch) => {
                                if (activeNode) {
                                    await updateNodeUserVoucher(activeNode.url, pubkey, canVouch, activeNode.adminPassword);
                                }
                            }}
                            onToggleOperator={async (pubkey, granted) => {
                                if (activeNode) {
                                    await updateNodeUserOperator(activeNode.url, pubkey, granted, activeNode.adminPassword);
                                }
                            }}
                        />
                    )}

                    {activeTab === 'topology' && (
                        <TopologyModule
                            activeNode={activeNode}
                            diag={diag}
                            profiles={profiles}
                            onRefresh={() => loadDiagnostics()}
                        />
                    )}

                    {activeTab === 'invites' && <InvitesModule activeNode={activeNode} />}

                    {activeTab === 'onboarding' && (
                        <OnboardingModule
                            profiles={profiles}
                            activeProfileId={activeProfileId}
                            onSelectNode={(id: string) => setActiveProfileId(id)}
                        />
                    )}

                    {activeTab === 'logs' && (
                        <LogsModule logs={nodeLogs} onRefresh={() => loadLogs()} />
                    )}

                    {activeTab === 'ai' && (
                        <AiServicesModule
                            activeNode={activeNode}
                            contextData={{ telemetry: diag, gateway, members: nodeData?.members, logs: nodeLogs }}
                        />
                    )}
                </main>
            </div>

            {/* Add Node Modal */}
            {showAddModal && (
                <AddNodeModal onClose={() => setShowAddModal(false)} onAdd={handleAddNode} />
            )}

            {/* Edit / Configure Node Modal */}
            {editingNode && (
                <EditNodeModal
                    node={editingNode}
                    onClose={() => setEditingNode(null)}
                    onSave={handleSaveNodeEdit}
                />
            )}

            {/* 2FA / TOTP Prompt Modal */}
            {totpPromptNode && (
                <TotpModal
                    nodeName={totpPromptNode.name}
                    error={totpError || undefined}
                    onClose={handleTotpCancel}
                    onSubmit={handleTotpSubmit}
                />
            )}
        </div>
    );
}
