/**
 * List photos that are still loading, for e2e/list-photo-slot-check.mjs (review of #2853, findings 1 and 2).
 *  - `?view=home`: the real HomePage inside a `main` like App's (`position: relative; overflow-y: auto`), with a 256 px strip
 *    where the app's sidebar stands from 768 px. Its photos never answer, so every tile is loading for the whole run.
 *  - `?view=stack`: the real MapStackList (the map's stacked list) with 40 pins, every photo `loading="lazy"`, in a box the
 *    height of a phone's map.
 * Layout here is inline style: this folder is outside Tailwind's content globs. Nothing here talks to a node.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { MapStackList } from '../src/components/MapStackList';
import { useTheme } from '../src/lib/useTheme';
import '../src/index.css';

const IDENTITY = { publicKey: 'a'.repeat(64), privateKey: '', callsign: 'Ana', createdAt: '2026-01-01T00:00:00.000Z' };
const view = new URLSearchParams(location.search).get('view');

const PINS = Array.from({ length: 40 }, (_, i) => ({
    key: `p${i}`,
    title: `Listing ${i + 1}`,
    type: 'Offer',
    when: null,
    photo: `/api/marketplace/posts/p${i}/photos/0?v=1&k=K${i}`,
    emoji: '🍎',
    eventStartMs: null,
    createdMs: 0,
    open: () => {},
}));

function Harness() {
    useTheme();
    if (view === 'stack') {
        return (
            <div data-testid="stack-box" style={{ position: 'relative', height: '100vh', overflow: 'hidden' }}>
                <MapStackList pins={PINS} covered={false} takeFocus={false} onClose={() => {}} />
            </div>
        );
    }
    return (
        <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
            {window.innerWidth >= 768 && <div style={{ width: 256, flex: 'none' }} />}
            <main data-testid="app-main" style={{ flex: '1 1 0', minWidth: 0, overflowY: 'auto', position: 'relative' }}>
                <HomePage identity={IDENTITY as never} onNavigate={() => {}} />
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
