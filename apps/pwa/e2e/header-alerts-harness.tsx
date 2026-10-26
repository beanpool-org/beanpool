/**
 * The needs-you icons in App's own header row and side bar, for e2e/header-alerts-shots.mjs: the real MobileHeader and
 * SidebarStatus (components/AppHeader.tsx, which App.tsx draws), the real SyncStatus, the real stylesheet, inside App's
 * own wrappers (its root row, the side bar and its footer). Mounted once: `window.harness.set({ tab, needs, settings })`
 * changes the tab, the needs (as Home's read landing, which the header draws from on any tab) and whether Settings is open
 * in place, as the app does; nothing is loaded again. Nothing here talks to a node.
 * ?chip=ago (default): the chip as "Offline" with "59m ago" under it, its widest · ?chip=plain: "Offline" alone.
 * &dark=1 for the dark scheme.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileHeader, SidebarStatus } from '../src/components/AppHeader';
import { recordHomeAnswer } from '../src/lib/home-store';
import type { NeedsItem } from '../src/lib/home-cards';
import '../src/index.css';

const q = new URLSearchParams(location.search);
// Dark as lib/useTheme.ts makes it: Tailwind's dark: classes and the theme's own colours. (The chip's last sync is set in
// header-alerts-harness.html, before lib/sync.ts reads it.)
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');

const ME = 'a'.repeat(64);
const DEAL: NeedsItem = { kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you', target: { to: 'deal', postId: 'p1', txId: 't1' } };
const VOTE: NeedsItem = { kind: 'vote', count: 1, accent: true, label: 'Vote closes tomorrow', target: { to: 'decide' } };
const INVITE: NeedsItem = { kind: 'invite', count: 1, accent: false, label: "You're invited to join Garden Club", target: { to: 'invite', id: 'g1' } };
const MESSAGE: NeedsItem = { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm-ana' } };
const GROUP: NeedsItem = { kind: 'group', count: 3, accent: false, label: '3 new lines in Choir', target: { to: 'chat', conversationId: 'grp-choir' } };
/** 0, 1, 3 and 5 kinds (5: every kind the web draws; the phone's 🛡️ has no web landing). */
const NEEDS: Record<number, NeedsItem[]> = { 0: [], 1: [INVITE], 3: [DEAL, VOTE, INVITE], 5: [DEAL, VOTE, INVITE, MESSAGE, GROUP] };

/** App.tsx's tab names (TABS, and the Pulse's). */
const TAB_TITLES: Record<string, string> = {
    home: 'Home', marketplace: 'Market', map: 'Map', projects: 'Commons', messages: 'Chat', people: 'People', ledger: 'Ledger', pulse: 'The Pulse',
};

function landed(needs: number) {
    recordHomeAnswer({
        generatedAt: new Date().toISOString(),
        profile: 'local',
        features: { beans: true, decisions: true, invites: true },
        layout: { v: 2, cards: [{ id: 'c1', type: 'community' }], dismissed: {}, updatedAt: null },
        cards: { community: { name: 'Mullumbimby', members: 42 }, needs: { items: NEEDS[needs] ?? [] } },
    } as never, ME);
}

type State = { tab: string; needs: number; settings: boolean };
declare global { interface Window { harness: { set: (s: Partial<State>) => void; state: State } } }

function Harness() {
    const [state, setState] = useState<State>({ tab: 'home', needs: 0, settings: false });
    useEffect(() => {
        window.harness = {
            state,
            set: (s) => {
                if (s.needs !== undefined) landed(s.needs);
                setState(prev => ({ ...prev, ...s }));
            },
        };
    }, [state]);
    // App.tsx's own rule for the header's title: none on the map, which shows the community's logo.
    const title = state.tab !== 'map' || state.settings ? TAB_TITLES[state.tab] ?? '' : null;
    return (
        <div className="flex h-screen overflow-hidden text-text-primary">
            <aside className="hidden md:flex flex-col w-64 shrink-0 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 z-50">
                <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto" />
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 space-y-2 bg-nature-100/50 dark:bg-nature-900/50">
                    <SidebarStatus
                        isGuest={false}
                        identityPubkey={ME}
                        activeTab={state.tab}
                        onNavigate={() => {}}
                        settingsSeen={state.settings}
                        setShowSettings={(v) => setState(prev => ({ ...prev, settings: v }))}
                    />
                </div>
            </aside>
            <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                <MobileHeader
                    activeTab={state.tab}
                    showSettings={state.settings}
                    title={title}
                    isGuest={false}
                    identityPubkey={ME}
                    displayVersion="1.2.82"
                    communityStatus={null}
                    onTitleClick={() => {}}
                    settingsSeen={state.settings}
                    setShowSettings={(v) => setState(prev => ({ ...prev, settings: v }))}
                    onOpenProfile={() => {}}
                    onNavigate={() => {}}
                />
                <main className="flex-1 bg-nature-50 dark:bg-nature-950" />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
