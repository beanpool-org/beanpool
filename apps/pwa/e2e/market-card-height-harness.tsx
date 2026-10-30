import { createRoot } from 'react-dom/client';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import type { MarketplacePost } from '../src/lib/marketplace';
import '../src/index.css';

/**
 * The Market's cards in a TALL container, for market-card-height-check.mjs: a card is its own height, never the
 * container's (the phone's list card filled the screen, 29 Oct). `?view=list|grid|compact&n=1|10&tall=<px>&dark=1`.
 * `kind=photoless` draws the category tile, `banner` an enterprise's shop banner, `mixed` all three kinds.
 */
const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') document.documentElement.classList.add('dark', 'dark-theme');
else document.documentElement.classList.remove('dark', 'dark-theme');

const view = (q.get('view') ?? 'list') as 'list' | 'grid' | 'compact';
const n = Number(q.get('n') ?? 1);
const kind = q.get('kind') ?? 'photoless';
const tall = Number(q.get('tall') ?? 1400);

const SVG = (fill: string, w: number, h: number) => `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="%23${fill}"/></svg>`;
const at = new Date().toISOString();

function post(i: number): MarketplacePost {
    const k = kind === 'mixed' ? (['photoless', 'photo', 'banner'] as const)[i % 3] : kind;
    return {
        id: `p-${i}`,
        authorPublicKey: `author-${i}`,
        authorCallsign: "Damo's Enterprise",
        title: i === 0 ? 'Fundamentals of Network Security' : `Listing number ${i} with a title long enough to need a second line`,
        description: 'A short course.',
        category: ['tech', 'food', 'tools', 'garden', 'services'][i % 5],
        type: i % 4 === 3 ? 'need' : 'offer',
        credits: 45 + i,
        priceType: 'fixed',
        repeatable: true,
        photos: k === 'photo' ? [SVG('f59e0b', 400, 400)] : [],
        ...(k === 'banner' ? { authorBannerUrl: SVG('059669', 800, 267) } : {}),
        status: 'active',
        active: true,
        createdAt: at,
        updatedAt: at,
    } as MarketplacePost;
}

const posts = Array.from({ length: n }, (_, i) => post(i));

function Cards() {
    // As MarketplacePage lays them out: the grid's own wrapper per tile, and the list and compact rows in a block.
    if (view === 'grid') {
        return (
            <div className="grid grid-cols-2 gap-3.5">
                {posts.map((p) => (
                    <div key={p.id} data-card className="self-start rounded-xl">
                        <MarketplaceCard post={p} viewMode="grid" />
                    </div>
                ))}
            </div>
        );
    }
    return (
        <div className="space-y-6">
            <div className="space-y-2">
                {posts.map((p) => (
                    <div key={p.id} data-card>
                        <MarketplaceCard post={p} viewMode={view} />
                    </div>
                ))}
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    // The page's main column, tall: a flex column of a fixed height whose feed takes the rest, the worst case for a card
    // that reads a percentage height.
    <div data-testid="shot-container" className="max-w-sm mx-auto p-3 flex flex-col" style={{ height: `${tall}px` }}>
        <div className="flex-1 min-h-0" data-feed>
            <Cards />
        </div>
    </div>,
);
