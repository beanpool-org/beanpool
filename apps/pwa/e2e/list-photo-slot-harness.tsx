/**
 * List photos that are still loading, for e2e/list-photo-slot-check.mjs (review of #2853, findings 1 and 2, and round 3).
 *  - `?view=home`: the real HomePage inside a `main` like App's (`position: relative; overflow-y: auto`), with a 256 px strip
 *    where the app's sidebar stands from 768 px. Its photos never answer, so every tile is loading for the whole run.
 *  - `?view=stack`: the real MapStackList (the map's stacked list) with 40 pins, every photo `loading="lazy"`, in a box the
 *    height of a phone's map.
 *  - `?view=market&photos=<origin>&n=<count>`: `n` real MarketplaceCards in the grid, as the Market page draws a page of
 *    them (eager photos), each photo at `<origin>`: the check's own slow server on this machine.
 * Layout here is inline style: this folder is outside Tailwind's content globs. Nothing here talks to a node.
 */
import { createRoot } from 'react-dom/client';
import { HomePage } from '../src/pages/HomePage';
import { MapStackList } from '../src/components/MapStackList';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import type { MarketplacePost } from '../src/lib/marketplace';
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

const params = new URLSearchParams(location.search);
const POSTS = Array.from({ length: Number(params.get('n') || 50) }, (_, i) => ({
    id: `m${i}`, type: 'offer', category: 'food', title: `Listing ${i}`, description: '', credits: 5, priceType: 'fixed',
    authorPublicKey: 'a'.repeat(64), authorCallsign: 'Rowan', active: true, status: 'active', createdAt: '2026-11-01T00:00:00.000Z',
    photos: [`${params.get('photos') ?? ''}/api/marketplace/posts/m${i}/photos/0?v=1&k=K${i}`],
}) as unknown as MarketplacePost);

function Harness() {
    useTheme();
    if (view === 'market') {
        return (
            <div data-testid="market-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, padding: 12 }}>
                {POSTS.map((post) => <MarketplaceCard key={post.id} post={post} viewMode="grid" />)}
            </div>
        );
    }
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
