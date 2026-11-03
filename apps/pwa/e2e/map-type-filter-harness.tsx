/**
 * The web map with its filter bar, for e2e/map-type-filter-shots.mjs: the real MapPage and the real MobileHeader
 * (components/AppHeader.tsx, which App.tsx draws over the map) in App's own wrappers (its root row, the side bar from md up
 * and the header over the map), with the real stylesheet. The header is where Marty's "Online" came from: it draws at every
 * width, so the bar has to stand under it. Nothing here talks to a node: Playwright answers every /api request.
 * &dark=1 for the dark scheme.
 */
import { createRoot } from 'react-dom/client';
import { MobileHeader, SidebarStatus } from '../src/components/AppHeader';
import { MapPage } from '../src/pages/MapPage';
import '../src/index.css';

const q = new URLSearchParams(location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');

const ME = 'a'.repeat(64);
const IDENTITY = { publicKey: ME, privateKey: '', callsign: 'You', createdAt: new Date().toISOString() };

function Harness() {
    return (
        <div className="flex h-screen overflow-hidden text-text-primary">
            <aside className="hidden md:flex flex-col w-64 shrink-0 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 z-50">
                <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto" />
                <div className="p-3 border-t border-nature-200 dark:border-nature-800 space-y-2 bg-nature-100/50 dark:bg-nature-900/50">
                    <SidebarStatus isGuest={false} identityPubkey={ME} activeTab="map" onNavigate={() => {}} settingsSeen={false} setShowSettings={() => {}} />
                </div>
            </aside>
            <div className="flex-1 flex flex-col h-full overflow-hidden relative">
                <MobileHeader
                    activeTab="map"
                    showSettings={false}
                    title={null}
                    isGuest={false}
                    identityPubkey={ME}
                    displayVersion="1.2.82"
                    communityStatus={null}
                    onTitleClick={() => {}}
                    settingsSeen={false}
                    setShowSettings={() => {}}
                    onOpenProfile={() => {}}
                    onNavigate={() => {}}
                />
                <main style={{ flex: 1, minHeight: 0, overflowY: 'hidden', position: 'relative' }} className="md:pb-0">
                    <MapPage identity={IDENTITY as never} isMember={true} />
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
