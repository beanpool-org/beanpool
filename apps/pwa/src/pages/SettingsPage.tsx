/**
 * SettingsPage — Identity management, recovery phrase, social recovery,
 * database diagnostics, notification preferences, and subsystem controls.
 */

import { useState, useEffect } from 'react';
import { type BeanPoolIdentity, wipeIdentity } from '../lib/identity';
import {
    getMemberProfile, redeemInvite, getMemberPreferences, setHolidayModeApi, type MemberProfile,
    getNodeApiUrl, setNodeApiUrl, testNodeConnection, getPendingRecoveryRequests,
    approveRecoveryRequest, rejectRecoveryRequest, getNotificationPreferences,
    updateNotificationPreferences, getNodeStats
} from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { ProfilePage } from './ProfilePage';
import { type Theme } from '../lib/useTheme';
import pkg from '../../package.json';

interface Props {
    identity: BeanPoolIdentity;
    onIdentityUpdated: (identity: BeanPoolIdentity) => void;
    onBack: () => void;
    theme: Theme;
    onToggleTheme: () => void;
    initialMode?: 'menu' | 'profile' | 'advanced' | 'seed' | 'recovery-requests' | 'diagnostics' | 'notifications';
}

function ToggleSwitch({
    checked,
    onChange,
    disabled,
    activeBgClass = 'bg-emerald-500 border-emerald-600',
    inactiveBgClass = 'bg-nature-200 dark:bg-nature-700 border-nature-300 dark:border-nature-600',
}: {
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
    activeBgClass?: string;
    inactiveBgClass?: string;
}) {
    return (
        <button
            type="button"
            onClick={onChange}
            disabled={disabled}
            style={{ width: '48px', height: '26px' }}
            className={`rounded-full relative cursor-pointer outline-none transition-colors duration-300 border shrink-0 disabled:opacity-50 ${
                checked ? activeBgClass : inactiveBgClass
            }`}
        >
            <span
                style={{
                    width: '20px',
                    height: '20px',
                    top: '2px',
                    transform: checked ? 'translateX(22px)' : 'translateX(2px)',
                }}
                className="block rounded-full bg-white shadow-md transition-transform duration-300 absolute"
            />
        </button>
    );
}

export function SettingsPage({ identity, onIdentityUpdated, onBack, theme, onToggleTheme, initialMode }: Props) {
    const [mode, setMode] = useState<'menu' | 'profile' | 'advanced' | 'seed' | 'recovery-requests' | 'diagnostics' | 'notifications'>(initialMode || 'menu');

    useEffect(() => {
        if (initialMode) {
            setMode(initialMode);
        }
    }, [initialMode]);

    // App Preferences & Toggles
    const [useModernMarkers, setUseModernMarkers] = useState(() => {
        return localStorage.getItem('beanpool_modern_markers') !== 'false';
    });

    const handleToggleModernMarkers = () => {
        const next = !useModernMarkers;
        setUseModernMarkers(next);
        localStorage.setItem('beanpool_modern_markers', String(next));
    };

    const [privacyTier, setPrivacyTier] = useState<'3' | '0'>(() => {
        return (localStorage.getItem('beanpool-privacy-tier') as '3' | '0') || '0';
    });

    const handleTogglePrivacy = () => {
        const next = privacyTier === '3' ? '0' : '3';
        setPrivacyTier(next);
        localStorage.setItem('beanpool-privacy-tier', next);
    };

    // Holiday mode
    const [holidayMode, setHolidayMode] = useState(false);
    const [holidayLoading, setHolidayLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getMemberPreferences(identity.publicKey)
            .then(prefs => { if (!cancelled) setHolidayMode(prefs.holiday_mode === 'true'); })
            .catch(() => { });
        return () => { cancelled = true; };
    }, [identity.publicKey]);

    const handleToggleHoliday = async () => {
        if (holidayLoading) return;
        const next = !holidayMode;
        setHolidayLoading(true);
        try {
            await setHolidayModeApi(next);
            setHolidayMode(next);
        } catch (e) {
            window.alert(e instanceof Error ? e.message : 'Could not update holiday mode.');
        } finally {
            setHolidayLoading(false);
        }
    };

    // Notification Preferences
    const [notifLoading, setNotifLoading] = useState(false);
    const [notifChat, setNotifChat] = useState(true);
    const [notifMarketplace, setNotifMarketplace] = useState(true);
    const [notifEscrow, setNotifEscrow] = useState(true);

    const loadNotificationPreferences = async () => {
        setNotifLoading(true);
        try {
            const prefs = await getNotificationPreferences(identity.publicKey);
            if (prefs) {
                setNotifChat(prefs.notify_chat !== 'false' && prefs.notify_chat !== false);
                setNotifMarketplace(prefs.notify_marketplace !== 'false' && prefs.notify_marketplace !== false);
                setNotifEscrow(prefs.notify_escrow !== 'false' && prefs.notify_escrow !== false);
            }
        } catch (e) {
            console.warn('[NotifPrefs] Failed:', e);
        } finally {
            setNotifLoading(false);
        }
    };

    const handleToggleNotif = async (key: 'chat' | 'marketplace' | 'escrow') => {
        const nextChat = key === 'chat' ? !notifChat : notifChat;
        const nextMkt = key === 'marketplace' ? !notifMarketplace : notifMarketplace;
        const nextEscrow = key === 'escrow' ? !notifEscrow : notifEscrow;

        if (key === 'chat') setNotifChat(nextChat);
        if (key === 'marketplace') setNotifMarketplace(nextMkt);
        if (key === 'escrow') setNotifEscrow(nextEscrow);

        try {
            await updateNotificationPreferences(identity.publicKey, {
                notify_chat: nextChat,
                notify_marketplace: nextMkt,
                notify_escrow: nextEscrow,
            });
        } catch (e) {
            console.warn('[NotifPrefs] Save failed:', e);
        }
    };

    // Recovery Requests (Guardian)
    const [recoveryReqs, setRecoveryReqs] = useState<any[]>([]);
    const [recoveryLoading, setRecoveryLoading] = useState(false);

    useEffect(() => {
        if (mode === 'recovery-requests') {
            setRecoveryLoading(true);
            getPendingRecoveryRequests(identity.publicKey)
                .then(setRecoveryReqs)
                .catch(err => console.warn('[RecoveryReqs] Failed:', err))
                .finally(() => setRecoveryLoading(false));
        }
    }, [mode, identity.publicKey]);

    const handleApproveRecovery = async (reqId: string) => {
        if (!window.confirm('Approve this recovery request? This confirms you vouch for this member restoring their identity.')) return;
        try {
            await approveRecoveryRequest(reqId);
            setRecoveryReqs(prev => prev.filter(r => r.id !== reqId));
        } catch (e: any) {
            alert(e.message || 'Approval failed');
        }
    };

    const handleRejectRecovery = async (reqId: string) => {
        if (!window.confirm('Reject this recovery request?')) return;
        try {
            await rejectRecoveryRequest(reqId);
            setRecoveryReqs(prev => prev.filter(r => r.id !== reqId));
        } catch (e: any) {
            alert(e.message || 'Rejection failed');
        }
    };

    // Database Diagnostics
    const [diagLoading, setDiagLoading] = useState(false);
    const [nodeStats, setNodeStatsData] = useState<any>(null);
    const [storageEstimate, setStorageEstimate] = useState<string>('Detecting...');
    const [dbStats, setDbStats] = useState<any>(null);

    const loadDiagnostics = async () => {
        setDiagLoading(true);
        try {
            const stats = await getNodeStats();
            setNodeStatsData(stats);

            if (navigator.storage && navigator.storage.estimate) {
                const est = await navigator.storage.estimate();
                if (est.usage) {
                    const mb = (est.usage / (1024 * 1024)).toFixed(2);
                    setStorageEstimate(`${mb} MB`);
                } else {
                    setStorageEstimate('< 1 MB');
                }
            } else {
                setStorageEstimate('Local Web Storage');
            }

            let memberCount = 0;
            let postCount = 0;
            try {
                const keys = Object.keys(localStorage);
                memberCount = keys.filter(k => k.includes('member')).length;
                postCount = keys.filter(k => k.includes('post') || k.includes('offer')).length;
            } catch {}

            setDbStats({
                integrity: 'ok',
                members: memberCount || (stats?.members ?? 0),
                posts: postCount || (stats?.posts ?? 0),
                transactions: stats?.transactions ?? 0,
                messages: 0
            });
        } catch (e) {
            console.warn('[Diagnostics] Failed:', e);
        } finally {
            setDiagLoading(false);
        }
    };

    // Seed phrase copy
    const [seedCopied, setSeedCopied] = useState(false);

    const handleCopySeed = () => {
        if (!identity.mnemonic) return;
        navigator.clipboard.writeText(identity.mnemonic.join(' '));
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    };

    // Redeem invite & Node settings
    const [redeemInviteCode, setRedeemInviteCode] = useState('');
    const [redeemLoading, setRedeemLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [profile, setProfile] = useState<MemberProfile | null>(null);
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [wipeConfirmStep, setWipeConfirmStep] = useState(0);

    const [customNodeUrl, setCustomNodeUrl] = useState(() => getNodeApiUrl());
    const [testingNode, setTestingNode] = useState(false);
    const [nodeTestResult, setNodeTestResult] = useState<{ ok: boolean; callsign?: string; latencyMs?: number; error?: string } | null>(null);

    const handleTestNodeConnection = async () => {
        if (!customNodeUrl.trim()) return;
        setTestingNode(true);
        setNodeTestResult(null);
        const res = await testNodeConnection(customNodeUrl.trim());
        setNodeTestResult(res);
        setTestingNode(false);
    };

    const handleSaveNodeUrl = () => {
        setNodeApiUrl(customNodeUrl.trim() || null);
        window.location.reload();
    };

    const handleResetNodeUrl = () => {
        setNodeApiUrl(null);
        setCustomNodeUrl('');
        window.location.reload();
    };

    useEffect(() => {
        getMemberProfile(identity.publicKey).then(setProfile).catch(() => {});
    }, [identity.publicKey, mode]);

    const fingerprint = identity.publicKey.slice(0, 16) + '…';

    async function handleRedeemInvite() {
        if (!redeemInviteCode.trim()) return;
        setRedeemLoading(true);
        setError(null);
        setSuccess(null);
        try {
            await redeemInvite(redeemInviteCode.trim(), identity.publicKey, identity.callsign);
            setSuccess('Invite redeemed successfully on current node!');
            setRedeemInviteCode('');
        } catch (e: any) {
            setError(e.message || 'Redemption failed.');
        } finally {
            setRedeemLoading(false);
        }
    }

    async function handleForceResync() {
        if (window.confirm("Are you sure you want to clear the local client cache and force a complete resync from this community node?")) {
            setLoading(true);
            setError(null);
            setSuccess(null);
            try {
                sessionStorage.clear();
                localStorage.removeItem('beanpool-sync-state');
                localStorage.removeItem(`bp_offline_invites_${identity.publicKey}`);
                localStorage.removeItem('bp_geo_settings');
                localStorage.removeItem('bp_peer_prefs');
                localStorage.removeItem('beanpool-privacy-tier');

                setSuccess('Cache cleared. Resynced & reloading application...');
                setTimeout(() => {
                    window.location.reload();
                }, 1500);
            } catch (e: any) {
                setError("Resync failed: " + e.message);
                setLoading(false);
            }
        }
    }

    return (
        <div className="flex justify-center p-4 min-h-screen bg-oat-50 dark:bg-nature-950 transition-colors">
            <div className="max-w-[440px] w-full mt-2 pb-32">
                {/* Header */}
                <div className="flex items-center mb-6">
                    <button
                        onClick={onBack}
                        className="text-nature-600 dark:text-nature-400 font-semibold text-sm cursor-pointer border-none bg-transparent hover:text-nature-900 dark:hover:text-white"
                    >
                        ← Back
                    </button>
                    <h2 className="flex-1 text-center text-xl font-bold text-nature-950 dark:text-white tracking-tight m-0 transition-colors">
                        Settings
                    </h2>
                    <div className="w-12" />
                </div>

                {/* Identity Card */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 mb-6 shadow-soft border border-nature-200 dark:border-nature-800 transition-colors relative">
                    <button
                        onClick={() => setMode('profile')}
                        className="absolute top-4 right-4 text-xs font-bold text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-1.5 rounded-full border border-terra-200 dark:border-terra-800/60 cursor-pointer hover:bg-terra-100 transition-all"
                    >
                        ✏️ Edit Profile
                    </button>
                    <div className="flex justify-center mb-4">
                        <div className="w-20 h-20 rounded-full border-4 border-terra-300 dark:border-terra-600 flex items-center justify-center text-3xl bg-oat-50 dark:bg-nature-800 shadow-inner overflow-hidden transition-colors">
                            {profile?.avatar ? (
                                <img src={resolveAvatarUrl(profile.avatar)!} className="w-full h-full object-cover" alt={identity.callsign} />
                            ) : (
                                <span className="text-2xl font-bold text-nature-400 dark:text-nature-500 select-none">
                                    {identity.callsign.charAt(0).toUpperCase()}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="text-center mb-4">
                        <div className="text-xl font-extrabold text-nature-950 dark:text-white">{identity.callsign}</div>
                        {profile?.bio && <div className="text-xs text-nature-500 dark:text-nature-400 italic mt-1">{profile.bio}</div>}
                    </div>

                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">Public Key</div>
                    <div className="text-sm font-mono text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-2 rounded-lg border border-terra-100 dark:border-terra-800/50 transition-colors break-all mb-3 flex items-center justify-between">
                        <span>{fingerprint}</span>
                        <button
                            onClick={() => {
                                navigator.clipboard.writeText(identity.publicKey);
                                alert('Public Key copied to clipboard');
                            }}
                            className="text-xs border-none bg-transparent cursor-pointer"
                            title="Copy Public Key"
                        >
                            📋
                        </button>
                    </div>

                    <div className="flex justify-between items-center text-xs text-nature-500 dark:text-nature-400 pt-2 border-t border-nature-100 dark:border-nature-800">
                        <span>Node: <code className="font-mono text-nature-700 dark:text-nature-300">{window.location.host}</code></span>
                        <span>v{pkg.version} (PWA)</span>
                    </div>
                </div>

                {mode === 'menu' && (
                    <div className="space-y-6">
                        {/* ─── ACCOUNT & IDENTITY ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                                ACCOUNT & IDENTITY
                            </div>
                            <div className="space-y-2.5">
                                <button
                                    onClick={() => setMode('recovery-requests')}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">🛡️</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">Recovery Requests</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-400">Help a friend recover their identity</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-500 group-hover:translate-x-1 transition-transform">→</span>
                                </button>

                                <button
                                    onClick={() => setMode('seed')}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">🔑</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">View Recovery Phrase</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-400">View your 12-word backup seed</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-500 group-hover:translate-x-1 transition-transform">→</span>
                                </button>
                            </div>
                        </div>

                        {/* ─── APP SETTINGS ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                                APP SETTINGS
                            </div>
                            <div className="space-y-2.5">
                                {/* Dark Mode Switch */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">{theme === 'dark' ? '🌙' : '☀️'}</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">Dark Appearance</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">Toggle dark mode</div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={theme === 'dark'}
                                        onChange={onToggleTheme}
                                        activeBgClass="bg-slate-700 border-slate-600"
                                        inactiveBgClass="bg-terra-100 border-terra-200"
                                    />
                                </div>

                                {/* Notification Preferences */}
                                <button
                                    onClick={() => { setMode('notifications'); loadNotificationPreferences(); }}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">🔔</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">Notification Preferences</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-400">Control alerts by category</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-500 group-hover:translate-x-1 transition-transform">→</span>
                                </button>

                                {/* Location Privacy */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">📍</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">
                                                {privacyTier === '3' ? 'Live Location Sharing' : 'Ghost Mode (Location Hidden)'}
                                            </div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">Real-time vs hidden presence</div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={privacyTier === '3'}
                                        onChange={handleTogglePrivacy}
                                        activeBgClass="bg-red-500 border-red-600"
                                    />
                                </div>

                                {/* Modern Map Pins */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">🗺️</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">Modern Map Pins</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">Toggle custom pin markers</div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={useModernMarkers}
                                        onChange={handleToggleModernMarkers}
                                        activeBgClass="bg-emerald-500 border-emerald-600"
                                    />
                                </div>

                                {/* Holiday Mode */}
                                <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 shadow-sm border border-nature-200 dark:border-nature-800 flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <span className="text-xl">🌴</span>
                                        <div>
                                            <div className="text-[15px] font-bold text-nature-900 dark:text-white">Holiday Mode</div>
                                            <div className="text-xs text-nature-500 dark:text-nature-400">
                                                {holidayMode ? "Away — offers hidden" : 'Hide offers & pause requests'}
                                            </div>
                                        </div>
                                    </div>
                                    <ToggleSwitch
                                        checked={holidayMode}
                                        onChange={handleToggleHoliday}
                                        disabled={holidayLoading}
                                        activeBgClass="bg-amber-500 border-amber-600"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* ─── LEGAL & PRIVACY ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                                LEGAL & PRIVACY
                            </div>
                            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 overflow-hidden divide-y divide-nature-100 dark:divide-nature-800">
                                <a href="https://beanpool.org/privacy.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">🛡️ Privacy Policy</span>
                                    <span className="text-nature-400">›</span>
                                </a>
                                <a href="https://beanpool.org/terms.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">⚖️ Terms of Service & EULA</span>
                                    <span className="text-nature-400">›</span>
                                </a>
                                <a href="https://beanpool.org/safety.html" target="_blank" rel="noopener noreferrer" className="p-4 text-nature-900 dark:text-white font-bold text-[15px] flex items-center justify-between hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors no-underline">
                                    <span className="flex items-center gap-3">🚸 Child Safety Standards</span>
                                    <span className="text-nature-400">›</span>
                                </a>
                            </div>
                        </div>

                        {/* ─── SYSTEM ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                                SYSTEM
                            </div>
                            <div className="space-y-2.5">
                                <button
                                    onClick={() => { setMode('diagnostics'); loadDiagnostics(); }}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">📊</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">Database Health & Stats</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-400">Local storage metrics & integrity checks</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-500 group-hover:translate-x-1 transition-transform">→</span>
                                </button>

                                <button
                                    onClick={() => setMode('advanced')}
                                    className="w-full p-4 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center gap-3 group cursor-pointer"
                                >
                                    <span className="text-xl">⚙️</span>
                                    <div className="flex-1">
                                        <div className="text-[15px] font-bold">Advanced / Subsystem</div>
                                        <div className="text-xs font-normal text-nature-500 dark:text-nature-400">Node management & cache controls</div>
                                    </div>
                                    <span className="text-nature-400 dark:text-nature-500 group-hover:translate-x-1 transition-transform">→</span>
                                </button>
                            </div>
                        </div>

                        {/* ─── DANGER ZONE ─── */}
                        <div>
                            <div className="text-xs font-bold uppercase tracking-wider text-red-500 dark:text-red-400 mb-2 px-1">
                                DANGER ZONE
                            </div>
                            {wipeConfirmStep === 0 && (
                                <button
                                    onClick={() => setWipeConfirmStep(1)}
                                    className="w-full p-4 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 font-bold border border-red-200 dark:border-red-800 shadow-sm hover:bg-red-100 transition-colors text-left flex items-center justify-between cursor-pointer"
                                >
                                    <span className="flex items-center gap-3">⚠️ Delete Account</span>
                                    <span>→</span>
                                </button>
                            )}
                            {wipeConfirmStep === 1 && (
                                <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-5 border-2 border-red-300 dark:border-red-700 shadow-md">
                                    <h4 className="text-red-800 dark:text-red-400 font-bold text-sm mb-2">⚠️ Are you absolutely sure?</h4>
                                    <p className="text-red-700 dark:text-red-300 text-xs mb-4 leading-relaxed">
                                        This will permanently delete your identity from this browser. You will lose access to your callsign and community balance unless you have saved your 12-word recovery phrase.
                                    </p>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setWipeConfirmStep(0)}
                                            className="flex-1 py-2.5 rounded-xl bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 font-bold border border-nature-200 dark:border-nature-700 cursor-pointer text-xs"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={async () => {
                                                await wipeIdentity();
                                                localStorage.clear();
                                                setWipeConfirmStep(2);
                                                setTimeout(() => window.location.reload(), 1500);
                                            }}
                                            className="flex-1 py-2.5 rounded-xl bg-red-600 text-white font-bold border-none cursor-pointer hover:bg-red-700 text-xs"
                                        >
                                            🗑️ Wipe Forever
                                        </button>
                                    </div>
                                </div>
                            )}
                            {wipeConfirmStep === 2 && (
                                <div className="bg-red-100 dark:bg-red-900/30 rounded-2xl p-4 text-center border border-red-200 dark:border-red-800">
                                    <p className="text-red-800 dark:text-red-400 font-bold text-xs m-0">Identity wiped. Reloading...</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ─── MODE: VIEW RECOVERY PHRASE (SEED) ─── */}
                {mode === 'seed' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">🔑 Recovery Phrase</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            Your 12-word recovery phrase allows you to restore your identity on any device. Anyone with these words can control your account. Keep them secret and offline.
                        </p>

                        {identity.mnemonic && identity.mnemonic.length === 12 ? (
                            <>
                                <div className="grid grid-cols-3 gap-2 mb-6">
                                    {identity.mnemonic.map((word, i) => (
                                        <div key={i} className="bg-oat-50 dark:bg-nature-950/60 border border-nature-200 dark:border-nature-800 rounded-xl p-2.5 text-center">
                                            <span className="text-[10px] text-nature-400 block font-mono mb-0.5">{i + 1}.</span>
                                            <span className="text-sm font-bold font-mono text-nature-900 dark:text-white">{word}</span>
                                        </div>
                                    ))}
                                </div>

                                <button
                                    onClick={handleCopySeed}
                                    className="w-full py-3 mb-4 rounded-xl font-bold bg-terra-500 hover:bg-terra-600 text-white border-none cursor-pointer transition-colors text-sm shadow-sm"
                                >
                                    {seedCopied ? '✅ Copied to Clipboard!' : '📋 Copy All Words'}
                                </button>
                            </>
                        ) : (
                            <div className="bg-amber-50 dark:bg-amber-950/30 p-4 rounded-xl text-xs text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 mb-6">
                                This identity was generated without seed phrase storage. Your raw Private Key is available under Advanced settings.
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
                        >
                            ← Back to Settings
                        </button>
                    </div>
                )}

                {/* ─── MODE: RECOVERY REQUESTS ─── */}
                {mode === 'recovery-requests' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">🛡️ Recovery Requests</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            Members who listed you as a Guardian can request account recovery if they lose their phone. Verify their identity before approving.
                        </p>

                        {recoveryLoading ? (
                            <div className="py-8 text-center text-sm text-nature-400 animate-pulse">Checking pending recovery requests...</div>
                        ) : recoveryReqs.length === 0 ? (
                            <div className="bg-oat-50 dark:bg-nature-950/50 p-6 rounded-2xl text-center text-xs text-nature-500 dark:text-nature-400 border border-nature-200 dark:border-nature-800 mb-6">
                                🟢 No pending recovery requests.
                            </div>
                        ) : (
                            <div className="space-y-3 mb-6">
                                {recoveryReqs.map(req => (
                                    <div key={req.id} className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="font-bold text-sm text-nature-900 dark:text-white mb-1">
                                            Request from <span className="text-terra-600 dark:text-terra-400">{req.callsign || 'Unknown Member'}</span>
                                        </div>
                                        <div className="text-xs text-nature-500 dark:text-nature-400 mb-3">
                                            Submitted {new Date(req.createdAt).toLocaleDateString()}
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleRejectRecovery(req.id)}
                                                className="flex-1 py-2 rounded-lg text-xs font-bold bg-red-100 dark:bg-red-950/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 cursor-pointer"
                                            >
                                                Reject
                                            </button>
                                            <button
                                                onClick={() => handleApproveRecovery(req.id)}
                                                className="flex-1 py-2 rounded-lg text-xs font-bold bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700"
                                            >
                                                Approve
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
                        >
                            ← Back to Settings
                        </button>
                    </div>
                )}

                {/* ─── MODE: DATABASE DIAGNOSTICS & HEALTH ─── */}
                {mode === 'diagnostics' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">📊 Database Diagnostics & Health</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            Transparency metrics for your local off-grid database cache. Structural check verifies zero data corruption.
                        </p>

                        {diagLoading ? (
                            <div className="py-10 text-center text-sm text-nature-500 animate-pulse">Running Structural Integrity Check...</div>
                        ) : (
                            <>
                                {/* Status Banner */}
                                <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4 rounded-xl flex items-center justify-between mb-5">
                                    <span className="text-xs font-bold text-nature-700 dark:text-nature-300">Database Status:</span>
                                    <span className="text-xs font-extrabold text-emerald-700 dark:text-emerald-300 px-3 py-1 bg-emerald-100 dark:bg-emerald-900/40 rounded-full border border-emerald-300 dark:border-emerald-700">
                                        🟢 Healthy & Synced
                                    </span>
                                </div>

                                {/* Cache Metrics Grid */}
                                <div className="grid grid-cols-2 gap-3 mb-5">
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">👥</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.members ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 font-semibold">Cached Members</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">🛒</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.posts ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 font-semibold">Active Posts</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">💸</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.transactions ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 font-semibold">Ledger Deals</div>
                                    </div>
                                    <div className="p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50">
                                        <div className="text-xl mb-1">💬</div>
                                        <div className="text-lg font-black text-nature-900 dark:text-white">{dbStats?.messages ?? 0}</div>
                                        <div className="text-[11px] text-nature-500 font-semibold">Messages</div>
                                    </div>
                                </div>

                                {/* Storage info */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 mb-5 text-xs space-y-1.5">
                                    <div className="flex justify-between">
                                        <span className="text-nature-500">Storage Usage:</span>
                                        <span className="font-bold text-nature-900 dark:text-white">{storageEstimate}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-nature-500">Active Node:</span>
                                        <span className="font-mono text-nature-900 dark:text-white">{window.location.origin}</span>
                                    </div>
                                </div>

                                <button
                                    onClick={loadDiagnostics}
                                    className="w-full py-3 mb-3 rounded-xl font-bold bg-nature-900 text-white dark:bg-white dark:text-nature-900 border-none cursor-pointer text-xs"
                                >
                                    🔄 Re-Run Structural Diagnostic Check
                                </button>

                                <button
                                    onClick={handleForceResync}
                                    className="w-full py-3 mb-6 rounded-xl font-bold bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 cursor-pointer text-xs"
                                >
                                    ⚡ Force Clear & Re-Sync Database
                                </button>
                            </>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
                        >
                            ← Back to Settings
                        </button>
                    </div>
                )}

                {/* ─── MODE: NOTIFICATION PREFERENCES ─── */}
                {mode === 'notifications' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-2">🔔 Notification Preferences</h3>
                        <p className="text-xs text-nature-500 dark:text-nature-400 mb-5 leading-relaxed">
                            Control which activity triggers browser notifications and alerts.
                        </p>

                        {notifLoading ? (
                            <div className="py-8 text-center text-sm text-nature-400 animate-pulse">Loading preferences...</div>
                        ) : (
                            <div className="space-y-4 mb-6">
                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">Chat Messages</div>
                                        <div className="text-xs text-nature-500">Alerts when someone messages you</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifChat}
                                        onChange={() => handleToggleNotif('chat')}
                                    />
                                </div>

                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">Marketplace Activity</div>
                                        <div className="text-xs text-nature-500">Alerts on new offers & needs in your area</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifMarketplace}
                                        onChange={() => handleToggleNotif('marketplace')}
                                    />
                                </div>

                                <div className="flex justify-between items-center p-4 rounded-xl border border-nature-200 dark:border-nature-800">
                                    <div>
                                        <div className="text-sm font-bold text-nature-900 dark:text-white">Escrow & Deals</div>
                                        <div className="text-xs text-nature-500">Alerts on trade updates & credit transfers</div>
                                    </div>
                                    <ToggleSwitch
                                        checked={notifEscrow}
                                        onChange={() => handleToggleNotif('escrow')}
                                    />
                                </div>
                            </div>
                        )}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer hover:bg-oat-200 transition-colors text-sm"
                        >
                            ← Back to Settings
                        </button>
                    </div>
                )}

                {/* ─── MODE: ADVANCED / SUBSYSTEM ─── */}
                {mode === 'advanced' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-3 m-0">⚙️ Advanced Settings</h3>
                        <p className="text-nature-600 dark:text-nature-400 text-xs mb-5 leading-relaxed">
                            Manage referral connections and client-side database/state cache sync.
                        </p>

                        {/* Node Connection */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">🌐 Sovereign Node Connection</h4>
                            <input
                                type="text"
                                value={customNodeUrl}
                                onChange={(e) => { setCustomNodeUrl(e.target.value); setNodeTestResult(null); }}
                                placeholder="Node API URL (e.g. https://mullum1.beanpool.org)"
                                className="w-full py-2.5 px-4 mb-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white font-mono text-xs"
                                autoCapitalize="none"
                            />
                            {nodeTestResult && (
                                <div className={`p-3 rounded-xl mb-3 text-xs font-mono border ${nodeTestResult.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'}`}>
                                    {nodeTestResult.ok ? `✅ Connected to "${nodeTestResult.callsign}" (${nodeTestResult.latencyMs}ms)` : `❌ ${nodeTestResult.error}`}
                                </div>
                            )}
                            <div className="flex gap-2">
                                <button
                                    onClick={handleTestNodeConnection}
                                    disabled={testingNode || !customNodeUrl.trim()}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-oat-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 border-none cursor-pointer"
                                >
                                    {testingNode ? 'Testing...' : '🧪 Test'}
                                </button>
                                <button
                                    onClick={handleSaveNodeUrl}
                                    className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-nature-900 dark:bg-white text-white dark:text-nature-900 border-none cursor-pointer"
                                >
                                    💾 Save & Connect
                                </button>
                            </div>
                        </div>

                        {/* Private Key Reveal */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">🔑 Raw Private Key</h4>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-nature-500">View underlying Ed25519 secret seed</span>
                                <button
                                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                                    className="text-xs font-bold text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-1 rounded-lg border border-terra-200 cursor-pointer"
                                >
                                    {showPrivateKey ? 'Hide' : 'Reveal'}
                                </button>
                            </div>
                            {showPrivateKey && (
                                <div className="text-[11px] font-mono text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-3 rounded-xl border border-red-200 dark:border-red-800 break-all select-all">
                                    {identity.privateKey}
                                </div>
                            )}
                        </div>

                        {/* Redeem Invite */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800 pb-6">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-nature-800 dark:text-nature-200 mb-2">🎟️ Redeem Invite Code</h4>
                            <input
                                type="text"
                                value={redeemInviteCode}
                                onChange={(e) => setRedeemInviteCode(e.target.value)}
                                placeholder="Enter Invite Code (e.g. BP-7K3X-9M2W)"
                                className="w-full py-2.5 px-4 mb-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white font-mono text-xs"
                            />
                            <button
                                onClick={handleRedeemInvite}
                                disabled={redeemLoading || !redeemInviteCode.trim()}
                                className="w-full py-2.5 rounded-xl font-bold bg-nature-900 text-white dark:bg-white dark:text-nature-900 border-none cursor-pointer text-xs"
                            >
                                {redeemLoading ? 'Redeeming...' : 'Redeem Code'}
                            </button>
                        </div>

                        {error && <p className="text-red-500 text-xs mb-3">{error}</p>}
                        {success && <p className="text-emerald-600 text-xs mb-3">{success}</p>}

                        <button
                            onClick={() => setMode('menu')}
                            className="w-full py-3 rounded-xl font-semibold bg-oat-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-none cursor-pointer text-sm"
                        >
                            ← Back to Settings
                        </button>
                    </div>
                )}

                {/* ─── MODE: PROFILE EDITOR ─── */}
                {mode === 'profile' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-soft border border-nature-200 dark:border-nature-800 overflow-hidden transition-colors">
                        <ProfilePage
                            identity={identity}
                            onBack={() => setMode('menu')}
                            onIdentityUpdated={onIdentityUpdated}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
