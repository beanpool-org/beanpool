import { createRoot } from 'react-dom/client';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import type { MarketplacePost } from '../src/lib/marketplace';
import '../src/index.css';

const q = new URLSearchParams(window.location.search);
if (q.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
} else {
    document.documentElement.classList.remove('dark', 'dark-theme');
}

// 16:9 Landscape SVG (400x225)
const LANDSCAPE_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="225" viewBox="0 0 400 225">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="%233b82f6"/>
      <stop offset="100%" stop-color="%231d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="400" height="225" fill="url(%23g1)"/>
  <circle cx="200" cy="75" r="45" fill="%23fbbf24"/>
  <text x="200" y="82" font-size="18" font-family="sans-serif" font-weight="bold" fill="%231e3a8a" text-anchor="middle">LANDSCAPE</text>
  <rect x="50" y="150" width="300" height="50" rx="8" fill="%23ffffff" fill-opacity="0.3"/>
  <text x="200" y="180" font-size="14" font-family="sans-serif" fill="%23ffffff" text-anchor="middle">16:9 Wide Field</text>
</svg>`;

// 3:4 Upright SVG (300x400) with a prominent top element (Jar lid / head) in the top third
const UPRIGHT_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
  <defs>
    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="%23ec4899"/>
      <stop offset="100%" stop-color="%23831843"/>
    </linearGradient>
  </defs>
  <rect width="300" height="400" fill="url(%23g2)"/>
  <!-- Top third element: Jar Lid / Head centered at y=55 -->
  <circle cx="150" cy="55" r="40" fill="%23fef08a" stroke="%23ca8a04" stroke-width="4"/>
  <text x="150" y="60" font-size="13" font-family="sans-serif" font-weight="bold" fill="%23854d0e" text-anchor="middle">JAR LID / HEAD</text>
  <!-- Jar Body / Mid section -->
  <rect x="50" y="120" width="200" height="180" rx="16" fill="%23ffffff" fill-opacity="0.35"/>
  <text x="150" y="210" font-size="16" font-family="sans-serif" font-weight="bold" fill="%23ffffff" text-anchor="middle">ORGANIC HONEY</text>
  <!-- Bottom section -->
  <text x="150" y="360" font-size="13" font-family="sans-serif" fill="%23fbcfe8" text-anchor="middle">Bottom of jar (3:4 upright)</text>
</svg>`;

const at = new Date().toISOString();

const posts: MarketplacePost[] = [
    {
        id: 'p-landscape',
        authorPublicKey: 'author-1',
        authorCallsign: 'Clara Oswald',
        title: 'Fresh sourdough bread baked daily for the whole street',
        description: 'Warm, crispy crust with cultured butter.',
        category: 'food',
        type: 'offer',
        credits: 123456,
        priceType: 'monthly',
        repeatable: true,
        photos: [LANDSCAPE_SVG],
        status: 'active',
        active: true,
        createdAt: at,
        updatedAt: at,
    } as MarketplacePost,
    {
        id: 'p-upright',
        authorPublicKey: 'author-2',
        authorCallsign: 'Bee Keeper Bob',
        title: 'Wildflower raw honeycomb tall jar with comb intact',
        description: 'Freshly harvested honey from local flora.',
        category: 'food',
        type: 'offer',
        credits: 999999,
        priceType: 'monthly',
        repeatable: true,
        photos: [UPRIGHT_SVG],
        status: 'active',
        active: true,
        createdAt: at,
        updatedAt: at,
    } as MarketplacePost,
    {
        id: 'p-nophoto',
        authorPublicKey: 'author-3',
        authorCallsign: 'Tools Library',
        title: 'Heavy duty rotary hammer drill with masonry bits',
        description: 'Available for weekend garden projects.',
        category: 'tools',
        type: 'offer',
        credits: 45,
        priceType: 'hourly',
        repeatable: true,
        photos: [],
        status: 'active',
        active: true,
        createdAt: at,
        updatedAt: at,
    } as MarketplacePost,
];

function Harness() {
    return (
        <div data-testid="shot-container" className="p-3 max-w-[320px] mx-auto min-h-screen bg-nature-50 dark:bg-nature-950">
            <div className="text-[11px] font-bold uppercase tracking-wider text-nature-500 mb-2">
                Market Cards (320dp · 4:3 1.3× text)
            </div>
            <div className="grid grid-cols-2 gap-3">
                {posts.map((p) => (
                    <div key={p.id} data-testid={`card-${p.id}`} className="self-start">
                        <MarketplaceCard post={p} viewMode="grid" />
                    </div>
                ))}
            </div>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
