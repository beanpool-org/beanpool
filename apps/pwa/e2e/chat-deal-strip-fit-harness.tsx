/**
 * The web chat inside App's own layout, for e2e/chat-deal-strip-fit.mjs: App.tsx's root row (`flex h-screen overflow-hidden`),
 * the real MobileHeader (components/AppHeader.tsx), `main` with the bottom nav's padding (`--bottom-nav-offset`), the real
 * MessagesPage in it opened on a one-to-one chat, and a bottom nav of the same box (fixed to the bottom, same padding, same
 * emoji and label sizes). The chat is `h-full` of `main`, so everything pinned above its thread comes out of the thread, and a
 * pinned block that is too tall pushes the composer under the nav. Nothing here talks to a node (the driver answers /api).
 */
import { createRoot } from 'react-dom/client';
import { MessagesPage } from '../src/pages/MessagesPage';
import { MobileHeader } from '../src/components/AppHeader';
import { useTheme } from '../src/lib/useTheme';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

/** The one-to-one chat the driver answers for. */
const DM_ID = 'c0ffee00-0000-4000-8000-0000000000d1';

const me: BeanPoolIdentity = {
    publicKey: 'a1b2c3d4e5f67890123456789012345678901234567890123456789012345678',
    privateKey: 'mock-private-key',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

/** App.tsx's tabs, with the emoji and label sizes its bottom nav gives them. */
const TABS = [['🏠', 'Home'], ['🤝', 'Market'], ['🗺️', 'Map'], ['🌱', 'Commons'], ['💬', 'Chat'], ['👥', 'People'], ['📊', 'Ledger']];

function Harness() {
    useTheme();
    return (
        <div className="flex h-screen overflow-hidden text-text-primary">
            <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                <MobileHeader
                    activeTab="messages"
                    showSettings={false}
                    title="Chat"
                    isGuest={false}
                    identityPubkey={me.publicKey}
                    displayVersion="1.2.82"
                    communityStatus={null}
                    onTitleClick={() => {}}
                    settingsSeen={false}
                    setShowSettings={() => {}}
                    onOpenProfile={() => {}}
                    onNavigate={() => {}}
                />
                <main
                    data-testid="app-main"
                    style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 'var(--bottom-nav-offset)', position: 'relative' }}
                    className="md:pb-0"
                >
                    <MessagesPage identity={me} openConversationId={DM_ID} onConversationOpened={() => {}} onNavigate={() => {}} />
                </main>
                <nav
                    data-testid="mobile-bottom-nav"
                    className="relative bottom-nav-bar flex md:hidden"
                    style={{
                        position: 'fixed', bottom: 0, left: 0, right: 0, background: '#1c2a1c', borderTop: '1px solid #111', zIndex: 100,
                        padding: '0.2rem 4px calc(0.2rem + env(safe-area-inset-bottom, 0px))',
                    }}
                >
                    <div className="relative z-10 w-full flex gap-px sm:gap-1">
                        {TABS.map(([emoji, label]) => (
                            <div key={label} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.1rem', padding: '0.15rem 0', color: '#fefefe' }}>
                                <span style={{ fontSize: '1.5rem' }}>{emoji}</span>
                                <span className="truncate max-w-full text-center" style={{ fontSize: '0.6rem', lineHeight: 1.1 }}>{label}</span>
                            </div>
                        ))}
                    </div>
                </nav>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
