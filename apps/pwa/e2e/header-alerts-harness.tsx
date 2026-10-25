import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HeaderControls } from '../src/components/HeaderControls';
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
    target: { to: 'deal', postId: 'post-1' },
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
    const state = params.get('state') || 'none'; // 'none' | 'invite' | 'several'
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        let items: NeedsItem[] = [];
        if (state === 'invite') {
            items = [inviteItem];
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

    return (
        <div className="min-h-screen bg-surface-canvas text-text-primary flex flex-col">
            {/* Header bar matching App.tsx */}
            <header className="relative shadow-md" style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.3rem 0.75rem',
                borderBottom: '1px solid #111',
                position: 'sticky',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                backgroundImage: "url('/assets/neon-vines-banner.png')",
                backgroundSize: '150% auto',
                backgroundPosition: 'center',
                backgroundColor: '#1c1917',
            }}>
                <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />

                {/* Left: Logo */}
                <div className="relative z-10 shrink-0 flex items-center gap-1.5 cursor-pointer">
                    <img src="/bean.png" alt="BeanPool Icon" style={{ width: '32px', height: '32px', objectFit: 'contain' }} className="drop-shadow-sm" />
                    <span className="font-extrabold text-[1.2rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">BeanPool</span>
                </div>

                {/* Right: HeaderControls */}
                <HeaderControls
                    showSettings={settingsOpen}
                    setShowSettings={setSettingsOpen}
                    identityPubkey={ME_PUBKEY}
                    onOpenProfile={() => {}}
                    onNavigate={() => {}}
                    activeTab="home"
                />
            </header>

            {/* Simulated content */}
            <main className="p-4 flex-1">
                <div className="max-w-md mx-auto space-y-4">
                    <div className="p-4 rounded-xl bg-surface-card border border-border-secondary shadow-sm">
                        <h2 className="text-lg font-bold">Needs-you Header Alerts Test</h2>
                        <p className="text-sm text-text-secondary mt-1">
                            State: <strong>{state}</strong>
                        </p>
                    </div>
                </div>
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
