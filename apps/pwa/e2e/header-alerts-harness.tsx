import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HeaderControls, HeaderTitle, SidebarControls, useDotOnlyChip } from '../src/components/HeaderControls';
import { NeedsYouIcons } from '../src/components/NeedsYouIcons';
import { SyncChip } from '../src/components/SyncChip';
import { recordHomeAnswer } from '../src/lib/home-store';
import type { NeedsItem } from '../src/lib/home-cards';
import '../src/index.css';

const ME_PUBKEY = 'test-member-pubkey';

const inviteItem: NeedsItem = {
    kind: 'invite',
    count: 1,
    accent: false,
    label: "You're invited to join Garden Club",
    target: { to: 'invite', id: 'group-garden' },
};
const dealItem: NeedsItem = {
    kind: 'deal',
    count: 1,
    accent: true,
    label: 'A deal is waiting for you',
    target: { to: 'deal', postId: 'post-1', txId: 'tx-1' },
};
const voteItem: NeedsItem = {
    kind: 'vote',
    count: 1,
    accent: true,
    label: 'Vote closes tomorrow',
    target: { to: 'decide' },
};
const msgItem: NeedsItem = {
    kind: 'message',
    count: 1,
    accent: false,
    label: 'Unread message from Ana',
    target: { to: 'chat', conversationId: 'dm-ana' },
};
const grpItem: NeedsItem = {
    kind: 'group',
    count: 3,
    accent: false,
    label: '3 new lines in Choir',
    target: { to: 'chat', conversationId: 'grp-choir' },
};

function Harness() {
    const params = new URLSearchParams(window.location.search);
    const state = params.get('state') || 'none'; // 'none' | 'invite' | 'three' | 'several'
    const tab = params.get('tab') || 'home'; // 'home' | 'map'
    const title = params.get('title') || (tab === 'map' ? null : 'Commons');
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        let items: NeedsItem[] = [];
        if (state === 'invite') {
            items = [inviteItem];
        } else if (state === 'three') {
            items = [dealItem, voteItem, inviteItem];
        } else if (state === 'several') {
            items = [dealItem, voteItem, inviteItem, msgItem, grpItem];
        }
        recordHomeAnswer({
            generatedAt: new Date().toISOString(),
            profile: 'local',
            features: { beans: true, decisions: true, invites: true },
            cards: {
                community: { name: 'Mullumbimby', members: 42 },
                needs: { items },
            },
        } as any, ME_PUBKEY);
    }, [state]);

    const [headerRef, dotOnly] = useDotOnlyChip(title);

    return (
        <div className="min-h-screen bg-nature-50 dark:bg-nature-950 text-text-primary flex">
            {/* Desktop Sidebar (visible on md: / >= 768px) */}
            <aside className="hidden md:flex flex-col w-64 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 shrink-0 h-screen">
                <div className="p-4 flex items-center gap-2 border-b border-nature-200 dark:border-nature-800">
                    <img src="/bean.png" alt="BeanPool Icon" style={{ width: '32px', height: '32px', objectFit: 'contain' }} />
                    <span className="font-extrabold text-[1.2rem] tracking-tight text-rainbow">BeanPool</span>
                </div>
                <nav className="p-3 space-y-1 flex-1">
                    <div className="px-3 py-2 rounded-xl bg-nature-200/50 dark:bg-nature-800/50 font-bold text-sm">
                        {tab === 'map' ? '🗺️ Map' : '🏡 Home'}
                    </div>
                </nav>
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 space-y-2 bg-nature-100/50 dark:bg-nature-900/50">
                    <div className="flex items-center justify-between px-2 py-1">
                        <SyncChip mode="online" ago={null} pulsing={false} />
                        <div className="flex items-center gap-1">
                            <NeedsYouIcons
                                identityPubkey={ME_PUBKEY}
                                activeTab={tab}
                                isHome={tab === 'home'}
                                variant="sidebar"
                            />
                            <SidebarControls showSettings={settingsOpen} setShowSettings={setSettingsOpen} />
                        </div>
                    </div>
                    <button className="w-full flex items-center gap-2.5 p-2 rounded-xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800">
                        <div className="w-8 h-8 rounded-full bg-nature-200 dark:bg-nature-700 flex items-center justify-center font-bold text-xs text-nature-800 dark:text-nature-200 shrink-0">
                            ZA
                        </div>
                        <div className="flex flex-col truncate text-left">
                            <span className="font-bold text-xs truncate">Zara</span>
                            <span className="text-[10px] text-nature-500">View Profile</span>
                        </div>
                    </button>
                </div>
            </aside>

            {/* Main content with Mobile Header (md:hidden) */}
            <div className="flex-1 flex flex-col min-w-0">
                <header
                    ref={headerRef}
                    className="relative shadow-md md:hidden"
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.3rem 0.75rem',
                        borderBottom: (tab === 'map' && !settingsOpen) ? 'none' : '1px solid #111',
                        position: (tab === 'map' && !settingsOpen) ? 'absolute' : 'sticky',
                        top: 0,
                        left: 0,
                        right: 0,
                        zIndex: 100,
                        backgroundImage: "url('/assets/neon-vines-banner.png')",
                        backgroundSize: '150% auto',
                        backgroundPosition: 'center',
                        backgroundColor: '#14281d',
                    }}
                >
                    <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />

                    <div className="relative z-10 shrink-0" style={{ marginTop: '12px' }}>
                        <SyncChip mode="online" ago={null} pulsing={false} stacked dotOnly={dotOnly} />
                    </div>

                    {title !== null ? (
                        <HeaderTitle title={title} />
                    ) : (
                        <div data-testid="header-logo" className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10">
                            <div
                                className="relative flex items-center gap-1.5 pointer-events-auto cursor-pointer"
                                style={{ transform: 'translateX(-12px) translateY(-2px)' }}
                            >
                                <img src="/bean.png" alt="BeanPool Icon" style={{ width: '40px', height: '40px', objectFit: 'contain' }} className="drop-shadow-sm" />
                                <span className="font-extrabold text-[1.6rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">BeanPool</span>
                                <span
                                    className="absolute -right-6 bottom-0.5 text-[10px] font-bold text-amber-500 tracking-wider whitespace-nowrap"
                                    aria-label="Version 1.2.30"
                                >v1.2.30</span>
                            </div>
                        </div>
                    )}

                    <HeaderControls
                        showSettings={settingsOpen}
                        setShowSettings={setSettingsOpen}
                        identityPubkey={ME_PUBKEY}
                        onOpenProfile={() => {}}
                        activeTab={tab}
                    />
                </header>

                <main className="p-4 flex-1">
                    <p className="text-sm text-nature-600 dark:text-nature-400">
                        Tab: {tab} · State: {state} · Title: {title ?? 'Logo'}
                    </p>
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
