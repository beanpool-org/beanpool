/**
 * App Shell — Main layout with bottom navigation
 *
 * Handles:
 * - Identity gate (first-run → WelcomePage)
 * - Tab routing (Marketplace / Ledger)
 * - Persistent header with SyncStatus + PrivacyBadge
 */

import { useState, useEffect } from 'react';
import { loadIdentity, type BeanPoolIdentity } from './lib/identity';
import { connectToAnchor, onSystemAnnouncement } from './lib/sync';
import { checkMembership, getConversations, getMarketplacePosts, getMyMarketplaceTransactions, getCommunityHealth } from './lib/api';
import { useTheme } from './lib/useTheme';
import pkg from '../package.json';
import { SyncStatus } from './components/SyncStatus';
import { WelcomePage } from './pages/WelcomePage';
import { MarketplacePage } from './pages/MarketplacePage';
import { LedgerPage } from './pages/LedgerPage';
import { SettingsPage } from './pages/SettingsPage';
import { lazy, Suspense } from 'react';
const MapPage = lazy(() => import('./pages/MapPage').then(m => ({ default: m.MapPage })));
import { PeoplePage } from './pages/PeoplePage';
import { MessagesPage } from './pages/MessagesPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { InstallPrompt } from './components/InstallPrompt';
import { PublicProfilePage } from './pages/PublicProfilePage';

function HeaderControls({ showSettings, setShowSettings, identityPubkey, onOpenProfile }: { showSettings: boolean, setShowSettings: (v: boolean) => void, identityPubkey?: string, onOpenProfile: (pk: string) => void }) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.3rem 0.6rem',
            borderRadius: '9999px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-secondary)',
            height: '26px', // Geometric balance with SyncStatus
            width: '72px',
            justifyContent: 'center',
        }}>
            <button
                onClick={() => identityPubkey && onOpenProfile(identityPubkey)}
                aria-label="My profile"
                title="My profile"
                className="text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200 transition-colors flex items-center justify-center p-0"
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>

            <div className="w-[1px] h-[12px] bg-nature-200 dark:bg-nature-700 mx-[1px]" />

            <button
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
                aria-pressed={showSettings}
                title="Settings"
                className={`flex items-center justify-center transition-colors p-0 ${
                    showSettings 
                        ? 'text-accent dark:text-accent' 
                        : 'text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200'
                }`}
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                </svg>
            </button>
        </div>
    );
}

type Tab = 'map' | 'marketplace' | 'messages' | 'people' | 'ledger' | 'projects';

export function App() {
    const [identity, setIdentity] = useState<BeanPoolIdentity | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Tab>('marketplace');
    const [peopleSubView, setPeopleSubView] = useState<'friends' | 'community' | 'invites' | 'guardians'>('friends');
    const [showSettings, setShowSettings] = useState(false);
    const [settingsInitialMode, setSettingsInitialMode] = useState<'menu' | 'profile'>('menu');
    const [openConversationId, setOpenConversationId] = useState<string | null>(null);
    const [openMarketPostId, setOpenMarketPostId] = useState<string | null>(null);
    const [openNewPost, setOpenNewPost] = useState(false);
    const [openProfilePubkey, setOpenProfilePubkey] = useState<string | null>(null);
    const [theme, toggleTheme] = useTheme();
    const [sysAnnouncement, setSysAnnouncement] = useState<{ title: string, body: string, severity: string } | null>(null);
    const [totalUnread, setTotalUnread] = useState(0);
    const [pendingDealsCount, setPendingDealsCount] = useState(0);
    const [marketClickCount, setMarketClickCount] = useState(0);
    const [isGuest, setIsGuest] = useState(false);
    const [showCommunityStatus, setShowCommunityStatus] = useState(false);
    const [communityHealth, setCommunityHealth] = useState<{ memberCount?: number; postCount?: number; callsign?: string; online?: boolean } | null>(null);

    function navigateToTab(tab: string, contextId?: string) {
        if (tab === 'map-post') {
            setActiveTab('map');
            setOpenNewPost(true);
            return;
        }
        setActiveTab(tab as Tab);
        if (tab === 'messages' && contextId) setOpenConversationId(contextId);
        if (tab === 'marketplace' && contextId) setOpenMarketPostId(contextId);
    }

    // Load existing identity on mount
    useEffect(() => {
        loadIdentity()
            .then(setIdentity)
            .finally(() => setLoading(false));
    }, []);

    // Connect to BeanPool Node once identity is loaded
    useEffect(() => {
        let unsub = () => { };
        if (identity) {
            connectToAnchor();
            unsub = onSystemAnnouncement((a) => {
                setSysAnnouncement({ title: a.title, body: a.body, severity: a.severity });
            });
            // Ensure existing users are registered with the node
            import('./lib/api').then(({ registerMember }) =>
                registerMember(identity.publicKey, identity.callsign).catch(() => { })
            );
            // Check membership status for guest/member UI
            checkMembership(identity.publicKey)
                .then(r => setIsGuest(!r.isMember))
                .catch(() => {});
        }
        return unsub;
    }, [identity]);

    // Poll unread message count and active deals
    useEffect(() => {
        if (!identity) return;
        const pollUnread = async () => {
            try {
                const result = await getConversations(identity.publicKey);
                setTotalUnread(result.totalUnread || 0);

                // Poll marketplace for active deals + inbound requests
                const [posts, txs] = await Promise.all([
                    getMarketplacePosts(),
                    getMyMarketplaceTransactions(identity.publicKey)
                ]);
                
                const activeDeals = posts.filter(p => 
                    p.status === 'pending' && 
                    (p.authorPublicKey === identity.publicKey || p.acceptedBy === identity.publicKey)
                ).length;
                
                const pendingRequests = txs.filter(t => 
                    t.buyerPublicKey === identity.publicKey && t.status === 'requested'
                ).length;

                setPendingDealsCount(activeDeals + pendingRequests);
            } catch { /* offline */ }
        };
        pollUnread();
        const interval = setInterval(pollUnread, 10000);
        return () => clearInterval(interval);
    }, [identity]);

    if (loading) {
        return (
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '100vh',
                color: '#888',
                fontSize: '1.1rem',
            }}>
                Loading...
            </div>
        );
    }

    // First-run gate
    if (!identity) {
        return <WelcomePage onComplete={setIdentity} />;
    }

    const TABS: { id: Tab; label: string; emoji: string }[] = [
        { id: 'marketplace', label: 'Market', emoji: '🤝' },
        { id: 'map', label: 'Map', emoji: '🗺️' },
        { id: 'projects', label: 'Projects', emoji: '🌱' },
        { id: 'messages', label: 'Chat', emoji: '💬' },
        { id: 'people', label: 'People', emoji: '👥' },
        { id: 'ledger', label: 'Ledger', emoji: '📊' },
    ];

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            overflow: 'hidden',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
        }}>
            {/* Header with Premium Dynamic AI Banner */}
            <header className="relative shadow-md" style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.3rem 0.75rem',
                borderBottom: (activeTab === 'map' && !showSettings) ? 'none' : '1px solid rgba(255,255,255,0.1)',
                position: (activeTab === 'map' && !showSettings) ? 'absolute' : 'sticky',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                backgroundImage: "url('/assets/neon-vines-banner.png')",
                backgroundSize: '150% auto',
                backgroundPosition: 'center',
            }}>
                {/* Subtle dark overlay to ensure text/buttons pop against the complex glowing mesh */}
                <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />

                <div className="relative z-10" style={{ marginTop: '12px' }}>
                    <SyncStatus />
                </div>

                {/* Dynamic Page Title or Map Banner (Absolutely Centered) */}
                <div className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10">
                    {activeTab !== 'map' || showSettings ? (
                        <span 
                            className="font-extrabold text-[1.4rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] pointer-events-auto text-center cursor-pointer" 
                            style={{ marginTop: '8px' }}
                            onClick={() => {
                                if (!communityHealth) {
                                    getCommunityHealth()
                                        .then(h => { setCommunityHealth({ ...h, online: true }); setShowCommunityStatus(true); })
                                        .catch(() => { setCommunityHealth({ online: false }); setShowCommunityStatus(true); });
                                } else {
                                    setShowCommunityStatus(!showCommunityStatus);
                                }
                            }}
                        >
                            {TABS.find(t => t.id === activeTab)?.label === 'Market' ? 'Marketplace' : TABS.find(t => t.id === activeTab)?.label}
                        </span>
                    ) : (
                        <div 
                            className="relative flex items-center gap-1.5 pointer-events-auto cursor-pointer" 
                            style={{ transform: 'translateX(-12px) translateY(-2px)' }}
                            onClick={() => {
                                if (!communityHealth) {
                                    getCommunityHealth()
                                        .then(h => { setCommunityHealth({ ...h, online: true }); setShowCommunityStatus(true); })
                                        .catch(() => { setCommunityHealth({ online: false }); setShowCommunityStatus(true); });
                                } else {
                                    setShowCommunityStatus(!showCommunityStatus);
                                }
                            }}
                        >
                            <img src="/bean.png" alt="BeanPool Icon" style={{ width: '40px', height: '40px', objectFit: 'contain' }} className="drop-shadow-sm" />
                            <span className="font-extrabold text-[1.6rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">BeanPool</span>
                            <span className="absolute -right-6 bottom-0.5 text-[10px] font-bold text-amber-500 tracking-wider">v{pkg.version}</span>
                        </div>
                    )}

                    {/* Community Status Popover */}
                    {showCommunityStatus && communityHealth && (
                        <div 
                            className="absolute top-full mt-2 bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700 rounded-xl shadow-xl p-4 min-w-[220px] z-50 pointer-events-auto"
                            onClick={e => e.stopPropagation()}
                        >
                            <div className="flex items-center gap-2 mb-3">
                                <span className={`w-2.5 h-2.5 rounded-full ${communityHealth.online ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'}`} />
                                <span className="font-bold text-sm text-nature-900 dark:text-white">
                                    {communityHealth.online ? 'Online' : 'Offline'}
                                </span>
                            </div>
                            <div className="space-y-1.5 text-[12px]">
                                <div className="flex justify-between">
                                    <span className="text-nature-500 dark:text-nature-400">Node</span>
                                    <span className="font-semibold text-nature-800 dark:text-nature-200">{window.location.hostname}</span>
                                </div>
                                {communityHealth.memberCount !== undefined && (
                                    <div className="flex justify-between">
                                        <span className="text-nature-500 dark:text-nature-400">Members</span>
                                        <span className="font-semibold text-nature-800 dark:text-nature-200">{communityHealth.memberCount}</span>
                                    </div>
                                )}
                                {communityHealth.postCount !== undefined && (
                                    <div className="flex justify-between">
                                        <span className="text-nature-500 dark:text-nature-400">Posts</span>
                                        <span className="font-semibold text-nature-800 dark:text-nature-200">{communityHealth.postCount}</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-nature-500 dark:text-nature-400">Status</span>
                                    <span className={`font-bold ${isGuest ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                        {isGuest ? '👤 Guest' : '✅ Member'}
                                    </span>
                                </div>
                            </div>
                            <button 
                                onClick={() => setShowCommunityStatus(false)}
                                className="mt-3 w-full text-center text-[11px] font-semibold text-nature-400 hover:text-nature-600 dark:hover:text-nature-300 cursor-pointer bg-transparent border-none"
                            >
                                Dismiss
                            </button>
                        </div>
                    )}
                </div>

                <div className="relative z-10" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '12px' }}>
                    <button
                        onClick={() => { setActiveTab('people'); setPeopleSubView('invites'); setShowSettings(false); }}
                        className={`flex items-center justify-center gap-1 px-3 border rounded-full shadow-sm cursor-pointer transition-transform hover:scale-105 ${
                            isGuest 
                                ? 'bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700' 
                                : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-700'
                        }`}
                        style={{ height: '26px' }}
                    >
                        {isGuest ? (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                            </svg>
                        ) : (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
                            </svg>
                        )}
                        <span className={`font-semibold text-[11px] tracking-wide uppercase ${
                            isGuest 
                                ? 'text-amber-600 dark:text-amber-400' 
                                : 'text-nature-900 dark:text-white'
                        }`}>
                            {isGuest ? 'Join' : 'Invite'}
                        </span>
                    </button>
                    <HeaderControls showSettings={showSettings} setShowSettings={(v) => { setSettingsInitialMode('menu'); setShowSettings(v); }} identityPubkey={identity?.publicKey} onOpenProfile={(pk) => setOpenProfilePubkey(pk)} />
                </div>
            </header>

            {/* Content */}
            <main style={{
                flex: 1,
                minHeight: 0,
                overflowY: (activeTab === 'map' && !showSettings) ? 'hidden' : 'auto',
                paddingBottom: (activeTab === 'map' && !showSettings) ? '0' : '4rem',
                position: 'relative',
            }}>
                {showSettings && (
                    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60, overflowY: 'auto' }}>
                        <SettingsPage
                            identity={identity}
                            onIdentityUpdated={(updated) => { setIdentity(updated); setShowSettings(false); }}
                            onBack={() => setShowSettings(false)}
                            theme={theme}
                            onToggleTheme={toggleTheme}
                            initialMode={settingsInitialMode}
                        />
                    </div>
                )}

                {/* Tab content — always mounted when not in settings (preserves scroll/state) */}
                {!showSettings && (
                    <>
                        {activeTab === 'map' && <Suspense fallback={<div className="flex-1 flex items-center justify-center">Loading map...</div>}><MapPage identity={identity} openNewPost={openNewPost} onOpenNewPostHandled={() => setOpenNewPost(false)} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} /></Suspense>}
                        {activeTab === 'marketplace' && <MarketplacePage identity={identity} marketClickCount={marketClickCount} openPostId={openMarketPostId} onPostOpened={() => setOpenMarketPostId(null)} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)} />}
                        {activeTab === 'messages' && <MessagesPage identity={identity} openConversationId={openConversationId} onConversationOpened={() => setOpenConversationId(null)} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} />}
                        {activeTab === 'people' && <PeoplePage identity={identity} initialView={peopleSubView} onNavigate={(tab, ctxId) => navigateToTab(tab, ctxId)} onOpenProfile={(pubkey) => setOpenProfilePubkey(pubkey)} />}
                        {activeTab === 'ledger' && <LedgerPage identity={identity} onNavigate={navigateToTab} />}
                        {activeTab === 'projects' && <ProjectsPage identity={identity} />}
                    </>
                )}

                {/* Public Profile Overlay — layers on top of preserved tab content */}
                {openProfilePubkey && (
                    <PublicProfilePage
                        identity={identity}
                        pubkey={openProfilePubkey}
                        onBack={() => setOpenProfilePubkey(null)}
                        onMessage={(pubkey) => {
                            setOpenProfilePubkey(null);
                            navigateToTab('messages', pubkey);
                        }}
                        onNavigatePost={(postId) => {
                            setOpenProfilePubkey(null);
                            navigateToTab('marketplace', postId);
                        }}
                        onEditProfile={() => {
                            setOpenProfilePubkey(null);
                            setSettingsInitialMode('profile');
                            setShowSettings(true);
                        }}
                        onNavigateTab={(tab, subView) => {
                            setOpenProfilePubkey(null);
                            if (tab === 'people' && subView) {
                                setPeopleSubView(subView as any);
                            }
                            setActiveTab(tab as any);
                            setShowSettings(false);
                        }}
                    />
                )}
            </main>

            {/* Bottom nav — hidden when profile overlay is active */}
            <nav className="relative" style={{
                display: openProfilePubkey ? 'none' : 'flex',
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundImage: "url('/assets/neon-vines-banner.png')",
                backgroundSize: '150% auto',
                backgroundPosition: 'center',
                borderTop: '1px solid #111',
                zIndex: 100,
                padding: '0.2rem 4px',
            }}>
                <div className="absolute inset-0 bg-black/30 pointer-events-none" />
                <div className="relative z-10 w-full flex gap-1">
                {TABS.map((tab) => {
                    const isActive = activeTab === tab.id && !showSettings;
                    return (
                    <button
                        key={tab.id}
                        onClick={() => {
                            if (tab.id === 'marketplace') {
                                setMarketClickCount(c => c + 1);
                            }
                            if (tab.id === 'people' && activeTab !== 'people') {
                                setPeopleSubView('friends');
                            }
                            setActiveTab(tab.id);
                            setShowSettings(false);
                            setOpenProfilePubkey(null);
                        }}
                        style={{
                            flex: 1,
                            padding: 0,
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                        }}
                    >
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            margin: '0 auto',
                            gap: '0.1rem',
                            padding: '0.15rem 0.5rem',
                            borderRadius: '10px',
                            background: 'rgba(0,0,0,0.45)',
                            border: '1px solid rgba(255,255,255,0.05)',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                            color: isActive ? undefined : '#fefefe',
                            transition: 'all 0.2s',
                        }}>
                            <span className="text-dark-aura" style={{ fontSize: '1.5rem', position: 'relative' }}>
                                {tab.emoji}
                                {tab.id === 'messages' && totalUnread > 0 && (
                                    <span style={{
                                        position: 'absolute',
                                        top: '-6px',
                                        right: '-10px',
                                        background: 'var(--danger)',
                                        color: '#fff',
                                        fontSize: '0.6rem',
                                        fontWeight: 700,
                                        minWidth: '16px',
                                        height: '16px',
                                        borderRadius: '8px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        padding: '0 3px',
                                        lineHeight: 1,
                                        boxShadow: '0 0 6px var(--danger)',
                                        textShadow: 'none', // Reset shadow for badge readability
                                    }}>
                                        {totalUnread > 99 ? '99+' : totalUnread}
                                    </span>
                                )}
                                {tab.id === 'marketplace' && pendingDealsCount > 0 && (
                                    <span style={{
                                        position: 'absolute',
                                        top: '-6px',
                                        right: '-10px',
                                        background: 'var(--danger)',
                                        color: '#fff',
                                        fontSize: '0.6rem',
                                        fontWeight: 700,
                                        minWidth: '16px',
                                        height: '16px',
                                        borderRadius: '8px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        padding: '0 3px',
                                        lineHeight: 1,
                                        boxShadow: '0 0 6px var(--danger)',
                                        textShadow: 'none',
                                    }}>
                                        {pendingDealsCount}
                                    </span>
                                )}
                            </span>
                            <span className={isActive ? 'text-rainbow text-dark-aura' : 'text-dark-aura'} style={{ fontSize: '0.65rem', fontWeight: isActive ? 800 : 600 }}>
                                {tab.label}
                            </span>
                        </div>
                    </button>
                    );
                })}
                </div>
            </nav>

            {/* System Announcement Modal */}
            {sysAnnouncement && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.8)', zIndex: 9999,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '1rem', backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)'
                }}>
                    <div style={{
                        background: 'var(--bg-primary)',
                        border: `2px solid ${sysAnnouncement.severity === 'critical' ? '#ef4444' : sysAnnouncement.severity === 'warning' ? '#f59e0b' : '#3b82f6'}`,
                        borderRadius: '12px', padding: '1.5rem',
                        maxWidth: '400px', width: '100%',
                        boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                        textAlign: 'center'
                    }}>
                        <h2 style={{
                            margin: '0 0 1rem', fontSize: '1.5rem',
                            color: sysAnnouncement.severity === 'critical' ? '#ef4444' : sysAnnouncement.severity === 'warning' ? '#f59e0b' : '#3b82f6'
                        }}>
                            {sysAnnouncement.severity === 'critical' ? '🚨 ' : sysAnnouncement.severity === 'warning' ? '⚠️ ' : 'ℹ️ '}
                            {sysAnnouncement.title}
                        </h2>
                        <p style={{ margin: '0 0 1.5rem', lineHeight: 1.5, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
                            {sysAnnouncement.body}
                        </p>
                        <button
                            onClick={() => setSysAnnouncement(null)}
                            style={{
                                width: '100%', padding: '0.8rem',
                                background: sysAnnouncement.severity === 'critical' ? '#ef4444' : sysAnnouncement.severity === 'warning' ? '#f59e0b' : '#3b82f6',
                                color: '#fff', border: 'none', borderRadius: '8px',
                                fontSize: '1.1rem', fontWeight: 600, cursor: 'pointer'
                            }}
                        >
                            Acknowledge
                        </button>
                    </div>
                </div>
            )}

            {/* PWA Install Banner */}
            <InstallPrompt />
        </div>
    );
}
