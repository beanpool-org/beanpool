/**
 * SettingsPage — Identity management + export/import
 *
 * Shows the current identity details and provides
 * tools for transferring identity between devices.
 */

import { useState, useEffect } from 'react';
import { type BeanPoolIdentity, importIdentity, wipeIdentity } from '../lib/identity';

import { getMemberProfile, redeemInvite, type MemberProfile } from '../lib/api';
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
    initialMode?: 'menu' | 'profile' | 'advanced';
}

export function SettingsPage({ identity, onIdentityUpdated, onBack, theme, onToggleTheme, initialMode }: Props) {
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

    const [mode, setMode] = useState<'menu' | 'profile' | 'advanced'>(initialMode || 'menu');

    useEffect(() => {
        if (initialMode) {
            setMode(initialMode);
        }
    }, [initialMode]);

    const [redeemInviteCode, setRedeemInviteCode] = useState('');
    const [redeemLoading, setRedeemLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [profile, setProfile] = useState<MemberProfile | null>(null);
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [wipeConfirmStep, setWipeConfirmStep] = useState(0); // 0=idle, 1=first confirm, 2=wiped

    // Fetch profile (avatar) on mount and when returning from profile editor
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
                // Clear PWA client cache items
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
            <div className="max-w-[420px] w-full mt-4 pb-32">
                {/* Header */}
                <div className="flex items-center mb-6">
                    <div className="w-16" />
                    <h2 className="flex-1 text-center text-xl font-bold text-nature-950 dark:text-white tracking-tight m-0 transition-colors">
                        Settings
                    </h2>
                    <div className="w-16" />
                </div>

                {/* Identity Card */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 mb-4 shadow-soft border border-nature-200 dark:border-nature-800 transition-colors">
                    {/* Avatar */}
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
                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">Callsign</div>
                    <div className="text-xl font-bold text-nature-950 dark:text-white mb-4 transition-colors">{identity.callsign}</div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">Public Key</div>
                    <div className="text-sm font-mono text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-2 rounded-lg border border-terra-100 dark:border-terra-800/50 transition-colors break-all mb-4">{fingerprint}</div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">Community Node</div>
                    <div className="text-sm font-mono text-nature-600 dark:text-nature-400 bg-nature-50 dark:bg-nature-900/30 px-3 py-2 rounded-lg border border-nature-100 dark:border-nature-800/50 transition-colors break-all mb-4">{window.location.origin}</div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-nature-500 dark:text-nature-400 mb-1">App Version</div>
                    <div className="text-sm font-mono text-nature-600 dark:text-nature-400 bg-nature-50 dark:bg-nature-900/30 px-3 py-2 rounded-lg border border-nature-100 dark:border-nature-800/50 transition-colors break-all">v{pkg.version} (Build 61)</div>
                </div>

                {/* Theme Toggle */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl px-6 py-5 mb-6 shadow-soft border border-nature-200 dark:border-nature-800 flex justify-between items-center transition-colors">
                    <span className="text-[15px] font-bold text-nature-900 dark:text-white transition-colors">
                        {theme === 'dark' ? '🌙 Dark Theme' : '☀️ Light Theme'}
                    </span>
                    <button
                        onClick={onToggleTheme}
                        className={`w-14 h-[30px] rounded-full relative cursor-pointer outline-none transition-colors duration-300 ease-in-out border-2 shadow-inner ${
                            theme === 'light' ? 'bg-terra-100 border-terra-200' : 'bg-slate-700 border-slate-600'
                        }`}
                        aria-label="Toggle Theme"
                    >
                        <span className={`block w-[22px] h-[22px] rounded-full bg-white absolute top-[2px] shadow-sm transform transition-transform duration-300 ease-in-out ${
                            theme === 'dark' ? 'translate-x-[26px]' : 'translate-x-[2px] drop-shadow-[0_2px_4px_rgba(226,114,91,0.4)]'
                        }`} />
                    </button>
                </div>

                {/* Modern Markers Toggle */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl px-6 py-5 mb-6 shadow-soft border border-nature-200 dark:border-nature-800 flex justify-between items-center transition-colors">
                    <div>
                        <span className="block text-[15px] font-bold text-nature-900 dark:text-white transition-colors">🗺️ Modern Map Pins</span>
                        <span className="block text-xs text-nature-500 dark:text-nature-400 mt-0.5">Toggle standard vs custom styles</span>
                    </div>
                    <button
                        onClick={handleToggleModernMarkers}
                        className={`w-14 h-[30px] rounded-full relative cursor-pointer outline-none transition-colors duration-300 ease-in-out border-2 shadow-inner ${
                            useModernMarkers ? 'bg-emerald-500 border-emerald-600' : 'bg-nature-200 dark:bg-nature-700 border-nature-300 dark:border-nature-600'
                        }`}
                        aria-label="Toggle Modern Markers"
                    >
                        <span className={`block w-[22px] h-[22px] rounded-full bg-white absolute top-[2px] shadow-sm transform transition-transform duration-300 ease-in-out ${
                            useModernMarkers ? 'translate-x-[26px]' : 'translate-x-[2px]'
                        }`} />
                    </button>
                </div>

                {/* Location Privacy Toggle */}
                <div className="bg-white dark:bg-nature-900 rounded-2xl px-6 py-5 mb-6 shadow-soft border border-nature-200 dark:border-nature-800 flex justify-between items-center transition-colors">
                    <div>
                        <span className="block text-[15px] font-bold text-nature-900 dark:text-white transition-colors">
                            {privacyTier === '3' ? '🔴 Live Location Sharing' : '👻 Ghost Mode (Location Hidden)'}
                        </span>
                        <span className="block text-xs text-nature-500 dark:text-nature-400 mt-0.5">Toggle real-time sharing vs absolute privacy</span>
                    </div>
                    <button
                        onClick={handleTogglePrivacy}
                        className={`w-14 h-[30px] rounded-full relative cursor-pointer outline-none transition-colors duration-300 ease-in-out border-2 shadow-inner ${
                            privacyTier === '3' ? 'bg-red-500 border-red-600' : 'bg-nature-200 dark:bg-nature-700 border-nature-300 dark:border-nature-600'
                        }`}
                        aria-label="Toggle Location Privacy"
                    >
                        <span className={`block w-[22px] h-[22px] rounded-full bg-white absolute top-[2px] shadow-sm transform transition-transform duration-300 ease-in-out ${
                            privacyTier === '3' ? 'translate-x-[26px]' : 'translate-x-[2px]'
                        }`} />
                    </button>
                </div>

                {mode === 'menu' && (
                    <div className="space-y-3">
                        <button
                            onClick={() => setMode('profile')}
                            className="w-full py-4 px-5 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center justify-between group"
                        >
                            <span>👤 Edit Profile</span>
                            <span className="text-nature-400 dark:text-nature-500 group-hover:text-nature-600 dark:group-hover:text-nature-300 transition-colors">→</span>
                        </button>

                        <button
                            onClick={() => { setMode('advanced'); setRedeemInviteCode(''); setError(null); setSuccess(null); }}
                            className="w-full py-4 px-5 rounded-2xl bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold border border-nature-200 dark:border-nature-800 shadow-sm hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors text-left flex items-center justify-between group"
                        >
                            <span>⚙️ Advanced / Subsystem</span>
                            <span className="text-nature-400 dark:text-nature-500 group-hover:text-nature-600 dark:group-hover:text-nature-300 transition-colors">→</span>
                        </button>
                    </div>
                )}

                {/* Security Section */}
                {mode === 'menu' && (
                    <div className="mt-6">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-3 px-1">Security</h3>
                        <div className="space-y-3">
                            {/* Backup Reminder */}
                            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl px-5 py-4 border border-amber-200 dark:border-amber-800 shadow-sm">
                                <div className="flex items-start gap-3">
                                    <span className="text-xl mt-0.5">⚠️</span>
                                    <div>
                                        <div className="font-bold text-amber-900 dark:text-amber-400 text-[13px] mb-1">Backup Your Identity</div>
                                        <p className="text-amber-800 dark:text-amber-300/70 text-[12px] leading-relaxed m-0">
                                            Your identity keys live in this browser only. Make sure to save your private key somewhere safe. If you clear browser data, your identity will be lost forever.
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* View Private Key */}
                            <div className="bg-white dark:bg-nature-900 rounded-2xl px-5 py-4 border border-nature-200 dark:border-nature-800 shadow-sm">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="font-bold text-[15px] text-nature-900 dark:text-white">🔑 Private Key</span>
                                    <button
                                        onClick={() => setShowPrivateKey(!showPrivateKey)}
                                        className="text-xs font-bold text-terra-600 dark:text-terra-400 bg-terra-50 dark:bg-terra-900/30 px-3 py-1.5 rounded-lg border border-terra-200 dark:border-terra-800 cursor-pointer hover:bg-terra-100 dark:hover:bg-terra-900/50 transition-colors"
                                    >
                                        {showPrivateKey ? 'Hide' : 'Reveal'}
                                    </button>
                                </div>
                                {showPrivateKey ? (
                                    <div className="relative">
                                        <div className="text-[10px] font-mono text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg border border-red-200 dark:border-red-800 break-all select-all">
                                            {identity.privateKey}
                                        </div>
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(identity.privateKey);
                                                setCopied(true);
                                                setTimeout(() => setCopied(false), 2000);
                                            }}
                                            className="absolute top-1 right-1 text-[10px] font-bold bg-white dark:bg-nature-800 text-nature-600 dark:text-nature-300 px-2 py-1 rounded border border-nature-200 dark:border-nature-700 cursor-pointer hover:bg-nature-50 transition-colors"
                                        >
                                            {copied ? '✅ Copied' : '📋 Copy'}
                                        </button>
                                        <p className="text-red-500 dark:text-red-400 text-[10px] mt-1.5 font-semibold m-0">
                                            ⚠️ Never share this key. Anyone with it controls your identity.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-nature-500 dark:text-nature-400 font-medium">
                                        Tap "Reveal" to view your private key. Keep it secret.
                                    </div>
                                )}
                            </div>

                            {/* Wipe Identity */}
                            {wipeConfirmStep === 0 && (
                                <button
                                    onClick={() => setWipeConfirmStep(1)}
                                    className="w-full py-4 px-5 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 font-bold border border-red-200 dark:border-red-800 shadow-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-left flex items-center justify-between group cursor-pointer"
                                >
                                    <span>🗑️ Wipe Identity</span>
                                    <span className="text-red-300 dark:text-red-600 group-hover:text-red-500 transition-colors">→</span>
                                </button>
                            )}
                            {wipeConfirmStep === 1 && (
                                <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-5 border-2 border-red-300 dark:border-red-700 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-200">
                                    <h4 className="text-red-800 dark:text-red-400 font-bold text-[15px] mb-2 m-0">⚠️ Are you absolutely sure?</h4>
                                    <p className="text-red-700 dark:text-red-300/70 text-[12px] mb-4 leading-relaxed m-0">
                                        This will permanently delete your identity from this browser. You will lose access to your callsign, balance, and friends unless you have a backup.
                                    </p>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setWipeConfirmStep(0)}
                                            className="flex-1 py-2.5 rounded-xl bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-300 font-bold border border-nature-200 dark:border-nature-700 cursor-pointer hover:bg-nature-50 transition-colors text-sm"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={async () => {
                                                // Delete the key from IndexedDB (the real store) and clear any
                                                // legacy localStorage artifact, so "Wipe Forever" actually wipes.
                                                await wipeIdentity();
                                                localStorage.removeItem('beanpool_identity');
                                                localStorage.removeItem('beanpool_modern_markers');
                                                setWipeConfirmStep(2);
                                                setTimeout(() => window.location.reload(), 1500);
                                            }}
                                            className="flex-1 py-2.5 rounded-xl bg-red-600 text-white font-bold border-none cursor-pointer hover:bg-red-700 transition-colors text-sm shadow-sm"
                                        >
                                            🗑️ Wipe Forever
                                        </button>
                                    </div>
                                </div>
                            )}
                            {wipeConfirmStep === 2 && (
                                <div className="bg-red-100 dark:bg-red-900/30 rounded-2xl p-5 text-center border border-red-200 dark:border-red-800">
                                    <span className="text-3xl">💨</span>
                                    <p className="text-red-800 dark:text-red-400 font-bold text-sm mt-2 mb-0">Identity wiped. Reloading...</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}



                {mode === 'advanced' && (
                    <div className="bg-white dark:bg-nature-900 rounded-2xl p-6 shadow-soft border border-nature-200 dark:border-nature-800 animate-in fade-in slide-in-from-bottom-2 duration-300 transition-colors">
                        <h3 className="text-lg font-bold text-nature-950 dark:text-white mb-3 m-0 transition-colors">⚙️ Advanced Settings</h3>
                        <p className="text-nature-600 dark:text-nature-400 text-sm mb-5 leading-relaxed transition-colors">
                            Manage referral connections and client-side database/state cache sync.
                        </p>

                        {/* Section 1: Redeem Invite */}
                        <div className="mb-6 border-b border-nature-100 dark:border-nature-800/80 pb-6">
                            <h4 className="text-sm font-bold text-nature-800 dark:text-nature-200 mb-2">🎟️ Redeem / Update Invite</h4>
                            <p className="text-xs text-nature-500 dark:text-nature-400 mb-3 leading-relaxed">
                                Associate this client profile with a referral or new parent node to sync marketplace products and permissions.
                            </p>
                            <input
                                type="text"
                                value={redeemInviteCode}
                                onChange={(e) => setRedeemInviteCode(e.target.value)}
                                placeholder="Enter Invite Code (e.g. BEAN-XXXX)"
                                className="w-full py-2.5 px-4 mb-3 rounded-xl border border-nature-200 dark:border-nature-800 bg-oat-50/50 dark:bg-nature-950/50 text-nature-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-terra-300 dark:focus:ring-terra-600 transition-all font-mono text-sm placeholder:font-sans placeholder:text-sm"
                                autoCapitalize="characters"
                                autoCorrect="false"
                            />
                            <button
                                onClick={handleRedeemInvite}
                                disabled={redeemLoading || !redeemInviteCode.trim()}
                                className={`w-full py-2.5 rounded-xl font-bold transition-all shadow-sm text-sm ${
                                    !redeemLoading && redeemInviteCode.trim()
                                        ? 'bg-nature-900 dark:bg-white text-white dark:text-nature-900 hover:bg-nature-800 dark:hover:bg-oat-100 hover:shadow-md'
                                        : 'bg-oat-200 dark:bg-nature-800 text-oat-500 dark:text-nature-500 cursor-not-allowed'
                                }`}
                            >
                                {redeemLoading ? 'Redeeming...' : 'Redeem Code'}
                            </button>
                        </div>

                        {/* Section 2: Reset Node Client Cache */}
                        <div className="mb-6">
                            <h4 className="text-sm font-bold text-nature-800 dark:text-nature-200 mb-2">🔄 Reset Client Cache & Resync</h4>
                            <p className="text-xs text-nature-500 dark:text-nature-400 mb-3 leading-relaxed">
                                Clears the local sessionStorage and offline cursors (invites, map preferences, and privacy tiers) to perform a clean sync from the node.
                            </p>
                            <button
                                onClick={handleForceResync}
                                disabled={loading}
                                className={`w-full py-2.5 rounded-xl font-bold border transition-all text-sm shadow-sm ${
                                    !loading
                                        ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/30'
                                        : 'bg-oat-200 dark:bg-nature-800 text-oat-500 dark:text-nature-500 border-transparent cursor-not-allowed'
                                }`}
                            >
                                {loading ? 'Clearing Cache...' : 'Reset Cache & Resync'}
                            </button>
                        </div>

                        {/* Feedback Messages */}
                        {error && <p className="text-red-500 dark:text-red-400 text-sm mb-4 font-medium px-1 animate-pulse">{error}</p>}
                        {success && <p className="text-emerald-600 dark:text-emerald-400 text-sm mb-4 font-medium px-1">{success}</p>}

                        {/* Back Button */}
                        <button
                            onClick={() => { setMode('menu'); setError(null); setSuccess(null); }}
                            className="w-full py-3 rounded-xl font-semibold bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 text-nature-600 dark:text-nature-400 hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors"
                        >
                            Back to Settings
                        </button>
                    </div>
                )}

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
