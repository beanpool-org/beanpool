import React from 'react';
import { createRoot } from 'react-dom/client';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import { CategoryTile } from '../src/components/CategoryTile';
import { HomePage } from '../src/pages/HomePage';
import type { MarketplacePost } from '../src/lib/marketplace';
import type { BeanPoolIdentity } from '../src/lib/identity';
import '../src/index.css';

const PHOTO_SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="%23f59e0b"/><circle cx="200" cy="200" r="100" fill="%23d97706"/><text x="200" y="215" font-family="sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle">OWN PHOTO</text></svg>';
const BANNER_SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="267" viewBox="0 0 800 267"><rect width="800" height="267" fill="%23059669"/><rect x="20" y="20" width="760" height="227" rx="12" fill="%23047857"/><text x="400" y="145" font-family="sans-serif" font-size="36" font-weight="bold" fill="white" text-anchor="middle">ENTERPRISE BANNER</text></svg>';

const postWithPhoto: MarketplacePost = {
    id: 'post-1',
    authorPublicKey: 'author-alice',
    authorCallsign: 'Alice Baker',
    title: 'Fresh Sourdough Loaf',
    description: 'Freshly baked artisan sourdough bread.',
    category: 'food',
    type: 'offer',
    credits: 6,
    priceType: 'fixed',
    photos: [PHOTO_SVG],
    status: 'active',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

const postWithBanner: MarketplacePost = {
    id: 'post-2',
    authorPublicKey: 'author-bakery',
    authorCallsign: 'Community Bakery',
    authorBannerUrl: BANNER_SVG,
    title: 'Enterprise Sourdough Starter',
    description: 'Heritage starter from the community bakery enterprise.',
    category: 'food',
    type: 'offer',
    credits: 4,
    priceType: 'fixed',
    photos: [],
    status: 'active',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

const postWithTile: MarketplacePost = {
    id: 'post-3',
    authorPublicKey: 'author-bob',
    authorCallsign: 'Bob Handyman',
    title: 'Garden Spade & Rake Hire',
    description: 'Solid tools ready to borrow for your garden beds.',
    category: 'tools',
    type: 'offer',
    credits: 8,
    priceType: 'fixed',
    photos: [],
    status: 'active',
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'user-viewer',
    privateKey: 'mock-private-key',
    callsign: 'Viewer',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const mockHomeData = {
    generatedAt: new Date().toISOString(),
    profile: 'local',
    community: { name: 'Mullumbimby Commons', members: 42, openInvites: 0, publicBoard: false, tradesThisMonth: 12, commonsPot: 150, listings: 3, eventsSoon: 0 },
    cards: {
        market: {
            items: [
                { id: 'h1', type: 'offer' as const, title: 'Fresh Sourdough Loaf', category: 'food', photoUrl: PHOTO_SVG, bannerUrl: BANNER_SVG, distanceKm: 1 },
                { id: 'h2', type: 'offer' as const, title: 'Enterprise Sourdough Starter', category: 'food', photoUrl: null, bannerUrl: BANNER_SVG, distanceKm: 2 },
                { id: 'h3', type: 'offer' as const, title: 'Garden Spade & Rake Hire', category: 'tools', photoUrl: null, bannerUrl: null, distanceKm: 3 },
            ],
            total14d: 3,
            more: false,
        },
    },
    features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true, guestListingsOnly: false },
    switches: { beans: true },
    me: { standing: 'member', tour: { v: 1, state: 'skipped', at: '2026-10-01T00:00:00.000Z' }, joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false },
    layout: { v: 2, cards: [{ id: 'market', type: 'market' }], dismissed: {}, updatedAt: null },
};

function PhoneStandin({ viewMode }: { viewMode: 'grid' | 'list' | 'compact' }) {
    const items = [
        { post: postWithPhoto, media: PHOTO_SVG, badge: 'OWN PHOTO' },
        { post: postWithBanner, media: BANNER_SVG, badge: 'ENTERPRISE BANNER' },
        { post: postWithTile, media: null, badge: 'CATEGORY TILE' },
    ];

    if (viewMode === 'grid') {
        return (
            <div className="p-3 bg-neutral-100 dark:bg-neutral-900 min-h-screen">
                <div className="text-xs font-bold uppercase text-neutral-500 mb-2">Phone Market Grid (320dp stand-in)</div>
                <div className="grid grid-cols-2 gap-2">
                    {items.map(({ post, media }) => (
                        <div key={post.id} className="bg-white dark:bg-neutral-800 rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700 flex flex-col shadow-sm">
                            <div className="relative w-full aspect-square overflow-hidden bg-neutral-100 dark:bg-neutral-900">
                                {media ? (
                                    <img src={media} alt={post.title} className="w-full h-full object-cover" />
                                ) : (
                                    <CategoryTile category={post.category} kind="listing" size="grid" />
                                )}
                                <div className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-full bg-slate-900/85 text-[10px] font-bold text-white">
                                    {post.type.toUpperCase()}
                                </div>
                                <div className="absolute bottom-1.5 right-1.5 px-2 py-0.5 rounded-full bg-slate-900/85 text-[10px] font-bold text-white">
                                    {post.credits} Beans
                                </div>
                            </div>
                            <div className="p-2 flex-1 flex flex-col justify-between">
                                <div className="text-xs font-semibold line-clamp-2 text-neutral-900 dark:text-neutral-100">{post.title}</div>
                                <div className="text-[10px] text-neutral-500 mt-1 truncate">{post.authorCallsign}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (viewMode === 'compact') {
        return (
            <div className="p-3 bg-neutral-100 dark:bg-neutral-900 min-h-screen">
                <div className="text-xs font-bold uppercase text-neutral-500 mb-2">Phone Market Compact (320dp stand-in)</div>
                <div className="flex flex-col gap-2">
                    {items.map(({ post, media }) => (
                        <div key={post.id} className="flex items-center gap-2.5 p-2 bg-white dark:bg-neutral-800 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-sm">
                            <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0">
                                {media ? (
                                    <img src={media} alt={post.title} className="w-full h-full object-cover" />
                                ) : (
                                    <CategoryTile category={post.category} kind="listing" size="thumb" />
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="text-xs font-semibold truncate text-neutral-900 dark:text-neutral-100">{post.title}</div>
                                <div className="text-[10px] text-neutral-500">{post.credits} Beans · {post.authorCallsign}</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // List view (80dp thumb)
    return (
        <div className="p-3 bg-neutral-100 dark:bg-neutral-900 min-h-screen">
            <div className="text-xs font-bold uppercase text-neutral-500 mb-2">Phone Market List (320dp stand-in)</div>
            <div className="flex flex-col gap-2">
                {items.map(({ post, media }) => (
                    <div key={post.id} className="flex bg-white dark:bg-neutral-800 rounded-2xl overflow-hidden border border-neutral-200 dark:border-neutral-700 shadow-sm">
                        <div className="w-20 h-20 shrink-0 overflow-hidden bg-neutral-100 dark:bg-neutral-900">
                            {media ? (
                                <img src={media} alt={post.title} className="w-full h-full object-cover" />
                            ) : (
                                <CategoryTile category={post.category} kind="listing" size="thumb" />
                            )}
                        </div>
                        <div className="p-2.5 flex-1 flex flex-col justify-between min-w-0">
                            <div>
                                <div className="flex items-center justify-between gap-1 mb-0.5">
                                    <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">{post.type.toUpperCase()}</span>
                                    <span className="text-[10px] font-bold text-neutral-900 dark:text-neutral-100">{post.credits} Beans</span>
                                </div>
                                <div className="text-xs font-semibold line-clamp-2 text-neutral-900 dark:text-neutral-100">{post.title}</div>
                            </div>
                            <div className="text-[10px] text-neutral-500 truncate">{post.authorCallsign}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function PhoneHomeMarketStandin() {
    const items = mockHomeData.cards.market.items;
    return (
        <div className="p-3 bg-neutral-100 dark:bg-neutral-900 min-h-screen">
            <div className="text-xs font-bold uppercase text-neutral-500 mb-2">Phone Home Market Rows (320dp stand-in)</div>
            <div className="bg-white dark:bg-neutral-800 rounded-2xl p-3 border border-neutral-200 dark:border-neutral-700 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wider text-neutral-400 mb-3">Market</div>
                <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-700">
                    {items.map((item) => {
                        const media = item.photoUrl || item.bannerUrl;
                        return (
                            <div key={item.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center gap-3">
                                <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 bg-neutral-100 dark:bg-neutral-900">
                                    {media ? (
                                        <img src={media} alt={item.title} className="w-full h-full object-cover" />
                                    ) : (
                                        <CategoryTile category={item.category} kind="listing" size="thumb" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-bold text-neutral-900 dark:text-neutral-100 truncate">{item.title}</div>
                                    <div className="text-[11px] text-neutral-500">{item.distanceKm} km away · {item.category}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function Harness() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'web-market-grid';

    if (view === 'web-market-grid') {
        return (
            <div className="p-3 max-w-sm mx-auto" data-testid="shot-container">
                <div className="text-xs font-bold uppercase text-text-secondary mb-2">Web Market Grid (320px)</div>
                <div className="grid grid-cols-2 gap-2">
                    <MarketplaceCard post={postWithPhoto} viewMode="grid" />
                    <MarketplaceCard post={postWithBanner} viewMode="grid" />
                    <div className="col-span-2">
                        <MarketplaceCard post={postWithTile} viewMode="grid" />
                    </div>
                </div>
            </div>
        );
    }

    if (view === 'web-market-list') {
        return (
            <div className="p-3 max-w-sm mx-auto flex flex-col gap-2" data-testid="shot-container">
                <div className="text-xs font-bold uppercase text-text-secondary mb-2">Web Market List (320px)</div>
                <MarketplaceCard post={postWithPhoto} viewMode="list" />
                <MarketplaceCard post={postWithBanner} viewMode="list" />
                <MarketplaceCard post={postWithTile} viewMode="list" />
            </div>
        );
    }

    if (view === 'web-market-compact') {
        return (
            <div className="p-3 max-w-sm mx-auto flex flex-col gap-2" data-testid="shot-container">
                <div className="text-xs font-bold uppercase text-text-secondary mb-2">Web Market Compact (320px)</div>
                <MarketplaceCard post={postWithPhoto} viewMode="compact" />
                <MarketplaceCard post={postWithBanner} viewMode="compact" />
                <MarketplaceCard post={postWithTile} viewMode="compact" />
            </div>
        );
    }

    if (view === 'web-home-market') {
        return (
            <div className="p-3 max-w-sm mx-auto" data-testid="shot-container">
                <div className="text-xs font-bold uppercase text-text-secondary mb-2">Web Home Market Rows (320px)</div>
                <HomePage identity={mockIdentity} onNavigate={() => {}} />
            </div>
        );
    }

    if (view === 'phone-market-grid') {
        return <div data-testid="shot-container"><PhoneStandin viewMode="grid" /></div>;
    }

    if (view === 'phone-market-list') {
        return <div data-testid="shot-container"><PhoneStandin viewMode="list" /></div>;
    }

    if (view === 'phone-market-compact') {
        return <div data-testid="shot-container"><PhoneStandin viewMode="compact" /></div>;
    }

    if (view === 'phone-home-market') {
        return <div data-testid="shot-container"><PhoneHomeMarketStandin /></div>;
    }

    return <div>Unknown view: {view}</div>;
}

const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
