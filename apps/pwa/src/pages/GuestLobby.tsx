/**
 * The global node's lobby in a web browser (design G9a §7, "PWA lobby (G9b)"; G11 screen 0 and §2.7): a visitor with
 * no key looks at the Market and the Map before joining. App shows it in place of the welcome page when the node says
 * visitors see its listings (`features.guestListingsOnly`) and nothing is part way through a join in this browser.
 *
 * - The same header as a member's, with **Join** where Settings sits, and two tabs, Market and Map.
 * - The Market and the Map with no identity: the node's guest view of each listing (no name, face, tier or exact
 *   place), and nothing to write with. The Market's list starts with a Join card, with "Already have BeanPool?".
 * - Join opens screen 1 of the browser join over the lobby ("Have you used BeanPool before?"), "Already have
 *   BeanPool?" its ways back; ← Back returns to the listings. Once joined, App draws the member's app.
 * - It asks for nothing new: the guest list read, the socket's doorbells (unsigned, so nothing else), and
 *   `/api/community/info`, which App read once to decide on the lobby and hands down.
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import type { CommunityInfo } from '../lib/api';
import { connectToAnchor, reconnectToAnchor } from '../lib/sync';
import { browserCanHoldKey } from '../lib/web-join';
import { beansOn } from '../lib/visitor-lobby';
import { MarketplacePage } from './MarketplacePage';
import { WelcomePage } from './WelcomePage';
import { TOO_OLD } from '../components/WebJoin';

const MapPage = lazy(() => import('./MapPage').then(m => ({ default: m.MapPage })));

type LobbyTab = 'marketplace' | 'map';

const TABS: { id: LobbyTab; label: string; emoji: string }[] = [
    { id: 'marketplace', label: 'Market', emoji: '🤝' },
    { id: 'map', label: 'Map', emoji: '🗺️' },
];

interface Props {
    /** `/api/community/info`, as App read it to choose the lobby. */
    info: CommunityInfo;
    /** Joined, or an account brought back: App draws the member's app. */
    onComplete: (identity: BeanPoolIdentity) => void;
    /** `/?post=<id>`, a shared listing: opened in the lobby's Market. */
    linkedPostId?: string | null;
    onLinkedPostTaken?: () => void;
}

export function GuestLobby({ info, onComplete, linkedPostId = null, onLinkedPostTaken }: Props) {
    const [tab, setTab] = useState<LobbyTab>('marketplace');
    const [marketClickCount, setMarketClickCount] = useState(0);
    const [openPostId, setOpenPostId] = useState<string | null>(null);
    // The browser join over the lobby: where it opens ('guard' from Join, 'restore' from "Already have BeanPool?";
    // unset for its own first screen, which says when this browser can't hold a key).
    const [join, setJoin] = useState<{ start?: 'guard' | 'restore' } | null>(null);
    // Every way in ends with this browser holding a key (G11-d's check): Join waits for the answer, and a browser that
    // can't hold one is told so instead of being offered a Join that can't finish.
    const [canHoldKey, setCanHoldKey] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        browserCanHoldKey().then((ok) => { if (!cancelled) setCanHoldKey(ok); });
        return () => { cancelled = true; };
    }, []);

    // The doorbell socket: with no key it gets only `{ type }` doorbells, and each has the lists read again.
    useEffect(() => { connectToAnchor(); }, []);

    useEffect(() => {
        if (!linkedPostId) return;
        setTab('marketplace');
        setOpenPostId(linkedPostId);
        onLinkedPostTaken?.();
    }, [linkedPostId, onLinkedPostTaken]);

    const doorOpen = info.profile === 'global' && info.features?.openJoin === true;
    const beans = beansOn(info);

    function openJoin(start: 'guard' | 'restore') {
        setJoin({ start: start === 'guard' && canHoldKey === false ? undefined : start });
    }

    function joined(identity: BeanPoolIdentity) {
        // The socket was opened with no key: opened again, signed by the member's, it carries the member's feed.
        reconnectToAnchor();
        onComplete(identity);
    }

    function navigate(to: string, contextId?: string) {
        if (to === 'marketplace') {
            setTab('marketplace');
            if (contextId) setOpenPostId(contextId);
        } else if (to === 'map') {
            setTab('map');
        }
        // Nothing else is open to a visitor.
    }

    function selectTab(id: LobbyTab) {
        if (id === 'marketplace') setMarketClickCount((c) => c + 1);
        setTab(id);
    }

    const joinCard = (
        <section data-testid="lobby-join-card"
            className="mb-3 px-4 py-3 rounded-2xl border border-blue-200 dark:border-blue-900 bg-blue-50/90 dark:bg-blue-950/60 text-center">
            <h2 className="m-0 mb-1 text-lg font-extrabold text-nature-950 dark:text-white">Join BeanPool</h2>
            <p className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200 leading-snug">
                {doorOpen
                    ? 'Post what you can offer and what you need, and talk with the people here. It takes a name and one sign-in. No invite needed.'
                    : 'This community takes new members with an invite from one of them.'}
            </p>
            {canHoldKey === false ? (
                <p role="alert" data-testid="lobby-too-old" className="m-0 mb-2 text-sm font-semibold text-nature-900 dark:text-white">{TOO_OLD}</p>
            ) : (
                <button type="button" data-testid="lobby-join" disabled={canHoldKey === null} onClick={() => openJoin('guard')}
                    className="w-full min-h-[48px] rounded-xl border-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold text-base cursor-pointer">
                    Join
                </button>
            )}
            <button type="button" data-testid="lobby-have-account" onClick={() => openJoin('restore')}
                className="mt-1 min-h-[44px] px-2 bg-transparent border-0 text-sm font-semibold text-nature-600 dark:text-nature-300 underline cursor-pointer">
                Already have BeanPool?
            </button>
        </section>
    );

    const headerJoin = (className: string) => (
        <button type="button" data-testid="header-join" onClick={() => openJoin('guard')} disabled={canHoldKey === null}
            className={`border-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold cursor-pointer ${className}`}>
            Join
        </button>
    );

    // The tab's own name: at 320 px with 1.3x text "Marketplace" runs under the Join button.
    const title = tab === 'marketplace' ? 'Market' : 'Map';

    return (
        <div className="flex h-screen overflow-hidden text-text-primary" data-testid="guest-lobby">
            {/* Desktop left sidebar, as a member's: the two tabs, and Join where Settings sits. */}
            <aside className="hidden md:flex flex-col w-64 shrink-0 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 z-50">
                <div className="p-4 border-b border-nature-200 dark:border-nature-800 flex items-center gap-2">
                    <img src="/bean.png" alt="BeanPool Icon" className="w-9 h-9 object-contain drop-shadow-sm" />
                    <span className="font-extrabold text-xl tracking-tight text-rainbow">BeanPool</span>
                </div>
                <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
                    {TABS.map((t) => (
                        <button key={t.id} type="button" onClick={() => selectTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
                            className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-bold text-sm transition-all duration-200 cursor-pointer ${
                                tab === t.id
                                    ? 'bg-nature-200 dark:bg-nature-800 text-nature-900 dark:text-white shadow-sm'
                                    : 'text-nature-600 dark:text-nature-400 hover:bg-nature-100 dark:hover:bg-nature-900 hover:text-nature-900 dark:hover:text-nature-200'
                            }`}>
                            <span className="text-xl" aria-hidden="true">{t.emoji}</span>
                            <span>{t.label}</span>
                        </button>
                    ))}
                </nav>
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 bg-nature-100/50 dark:bg-nature-900/50">
                    {headerJoin('w-full min-h-[44px] rounded-xl text-sm')}
                </div>
            </aside>

            <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                {/* The mobile header, as a member's: the page's name in the middle, Join where Settings sits. */}
                <header className="relative shadow-md md:hidden" style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.3rem 0.75rem',
                    minHeight: '46px',
                    borderBottom: tab === 'map' ? 'none' : '1px solid rgba(255,255,255,0.1)',
                    position: tab === 'map' ? 'absolute' : 'sticky',
                    top: 0,
                    left: 0,
                    right: 0,
                    zIndex: 100,
                    backgroundImage: "url('/assets/neon-vines-banner.png')",
                    backgroundSize: '150% auto',
                    backgroundPosition: 'center',
                }}>
                    <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />
                    <img src="/bean.png" alt="" aria-hidden="true" className="relative z-10 w-8 h-8 object-contain drop-shadow-sm" />
                    <h1 className="absolute left-1/2 -translate-x-1/2 z-10 m-0 font-extrabold text-[1.4rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] whitespace-nowrap overflow-hidden text-ellipsis"
                        style={{ maxWidth: 'calc(100% - 190px)' }}>
                        {title}
                    </h1>
                    {headerJoin('relative z-10 min-h-[36px] px-4 rounded-full text-sm shadow-md')}
                </header>

                <main style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: tab === 'map' ? 'hidden' : 'auto',
                    paddingBottom: tab === 'map' ? '0' : 'var(--bottom-nav-offset)',
                    position: 'relative',
                }} className="md:pb-0">
                    {tab === 'marketplace' && (
                        <MarketplacePage
                            identity={null}
                            isMember={false}
                            visitor={{ joinCard, onJoin: () => openJoin('guard'), beans }}
                            marketClickCount={marketClickCount}
                            openPostId={openPostId}
                            onPostOpened={() => setOpenPostId(null)}
                            onNavigate={navigate}
                        />
                    )}
                    {tab === 'map' && (
                        <Suspense fallback={<div className="flex-1 flex items-center justify-center">Loading map...</div>}>
                            <MapPage identity={null} isMember={false} visitor onNavigate={navigate} covered={!!join} />
                        </Suspense>
                    )}
                </main>

                {/* Bottom nav, mobile only: the lobby's two tabs. */}
                <nav className="relative bottom-nav-bar flex md:hidden" data-testid="lobby-bottom-nav" style={{
                    position: 'fixed',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    backgroundImage: "url('/assets/neon-vines-banner.png')",
                    backgroundSize: '150% auto',
                    backgroundPosition: 'center',
                    borderTop: '1px solid #111',
                    zIndex: 100,
                    padding: '0.2rem 4px calc(0.2rem + env(safe-area-inset-bottom, 0px))',
                }}>
                    <div className="absolute inset-0 bg-black/30 pointer-events-none" />
                    <div className="relative z-10 w-full flex gap-1">
                        {TABS.map((t) => {
                            const isActive = tab === t.id;
                            return (
                                <button key={t.id} type="button" onClick={() => selectTab(t.id)} aria-current={isActive ? 'page' : undefined}
                                    style={{ flex: '1 1 0', minWidth: 0, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                                    <div style={{
                                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                        gap: '0.1rem', padding: '0.15rem 0', borderRadius: '10px', background: 'rgba(0,0,0,0.45)',
                                        border: '1px solid rgba(255,255,255,0.05)', boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                                        color: isActive ? undefined : '#fefefe',
                                    }}>
                                        <span className="text-dark-aura" style={{ fontSize: '1.5rem' }} aria-hidden="true">{t.emoji}</span>
                                        <span className={`${isActive ? 'text-rainbow text-dark-aura font-extrabold' : 'text-dark-aura font-semibold'} truncate max-w-full text-center`}
                                            style={{ fontSize: '0.75rem', lineHeight: 1.1 }}>
                                            {t.label}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </nav>
            </div>

            {/* The browser join, over the lobby: screen 1 from Join, the ways back from "Already have BeanPool?". */}
            {join && (
                <div data-testid="lobby-join-overlay" className="fixed inset-0 overflow-y-auto" style={{ zIndex: 300, background: 'var(--bg-primary)' }}>
                    <WelcomePage onComplete={joined} start={join.start} onBack={() => setJoin(null)} initialInfo={info} />
                </div>
            )}
        </div>
    );
}
