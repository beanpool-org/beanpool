/**
 * The real mobile header with its bell (components/AppHeader.tsx MobileHeader, components/NeedsYouIcons.tsx), for
 * e2e/bell-read-shots.mjs: the sheet and a notice read in full are drawn by the app's own code. Nothing here talks to a node
 * (the driver answers /api), and no key is needed (an unsigned request is still answered by the driver).
 */
import { createRoot } from 'react-dom/client';
import { MobileHeader } from '../src/components/AppHeader';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const PUBLIC_KEY = 'a'.repeat(64);

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
                    identityPubkey={PUBLIC_KEY}
                    displayVersion="1.2.82"
                    communityStatus={null}
                    onTitleClick={() => {}}
                    settingsSeen={false}
                    setShowSettings={() => {}}
                    onOpenProfile={() => {}}
                    onNavigate={(tab: string, ctxId?: string) => {
                        (window as unknown as { __navigated?: unknown[] }).__navigated = [...((window as unknown as { __navigated?: unknown[] }).__navigated ?? []), [tab, ctxId]];
                    }}
                />
                <main style={{ flex: 1, minHeight: 0 }} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
