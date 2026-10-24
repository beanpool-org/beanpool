import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PulseFeedCard } from '../src/components/PulseFeedCard';
import { EnterpriseCard } from '../src/components/EnterpriseCard';
import { ToolSection, ToolPhoto, ToolInput, ToolRow } from '../src/tools/ui';
import { toolPhotoToken } from '../src/tools/photos';
import { keepToolPhoto } from '../src/tools/store';
import type { Treasury } from '../src/lib/api';
import '../src/index.css';

// SVG 800x600 test tool photo data url
const SVG_800X600 = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect fill="%232b3544" width="800" height="600"/><circle cx="400" cy="300" r="120" fill="%234a5568"/><text fill="white" font-size="44" font-family="sans-serif" font-weight="bold" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">800x600 Tool Photo</text></svg>`;

const pulseItem1 = {
    id: 'p1',
    ownerPubkey: 'owner-1',
    url: 'https://youtube.com/watch?v=1',
    platform: 'youtube' as const,
    category: 'education' as const,
    title: 'Natural Building Workshop & Cob Oven construction',
    thumbnailUrl: null,
    callsign: 'Mud & Timber',
    avatarUrl: null,
    source: 'user' as const,
    isVerified: true,
    publishedAt: '2026-10-23T12:00:00.000Z',
};

const pulseItem2 = {
    id: 'p2',
    ownerPubkey: 'owner-2',
    url: 'https://youtube.com/watch?v=2',
    platform: 'youtube' as const,
    category: 'farming' as const,
    title: 'Autumn Garlic Planting and Soil Prep',
    thumbnailUrl: null,
    callsign: 'Castlemaine Organics',
    avatarUrl: null,
    source: 'user' as const,
    isVerified: true,
    publishedAt: '2026-10-23T14:00:00.000Z',
};

const pulseItem3 = {
    id: 'p3',
    ownerPubkey: 'owner-3',
    url: 'https://youtube.com/watch?v=3',
    platform: 'youtube' as const,
    category: 'community' as const,
    title: 'Local Solar Bulk Buy Update for 2026',
    thumbnailUrl: null,
    callsign: 'Green Power Co-op',
    avatarUrl: null,
    source: 'user' as const,
    isVerified: true,
    publishedAt: '2026-10-23T16:00:00.000Z',
};

const mockTreasury1: Treasury = {
    publicKey: 'pub_farm',
    name: 'Green Farm Collective',
    callsign: 'greenfarm',
    purpose: 'Local organic food growing collective in Mullumbimby',
    balance: 150,
    creditLine: 0,
    earnedSurplus: 45,
    status: 'active',
    lifecycle: 'bounded',
    goalAmount: 500,
    currentAmount: 200,
    deadlineAt: new Date(Date.now() + 86400000 * 5).toISOString(),
    liveOffers: 3,
    keepers: [{ publicKey: 'k1', callsign: 'keeper1' }],
};

const mockTreasury2: Treasury = {
    publicKey: 'pub_bakery',
    name: 'Castlemaine Sourdough Guild',
    callsign: 'castlebread',
    purpose: 'Community brick-oven wood-fired bakery and milling',
    balance: 320,
    creditLine: 50,
    earnedSurplus: 120,
    status: 'active',
    lifecycle: 'ongoing',
    goalAmount: 1000,
    currentAmount: 750,
    liveOffers: 5,
    keepers: [{ publicKey: 'k2', callsign: 'baker' }],
};

const mockTreasury3: Treasury = {
    publicKey: 'pub_solar',
    name: 'Mullum Clean Energy Project',
    callsign: 'mullumsolar',
    purpose: 'Rooftop solar sharing network across the valley',
    balance: 500,
    creditLine: 0,
    earnedSurplus: 80,
    status: 'active',
    lifecycle: 'bounded',
    goalAmount: 2000,
    currentAmount: 1600,
    deadlineAt: new Date(Date.now() + 86400000 * 12).toISOString(),
    liveOffers: 2,
    keepers: [{ publicKey: 'k3', callsign: 'solar1' }],
};

function WidePagesApp() {
    const params = new URLSearchParams(window.location.search);
    const page = params.get('page') || 'pulse';
    const [toolReady, setToolReady] = useState(false);
    const photoUri = toolPhotoToken('owner1', 'things', 'ref1');

    useEffect(() => {
        void keepToolPhoto('owner1', 'things', 'ref1', SVG_800X600).then(() => {
            setToolReady(true);
        });
    }, []);

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-oat-100 dark:bg-nature-950 text-nature-950 dark:text-nature-50">
            {/* Desktop Left Sidebar: w-64 on md+, hidden on mobile */}
            <aside className="hidden md:flex flex-col w-64 shrink-0 bg-nature-50 dark:bg-nature-950 border-r border-nature-200 dark:border-nature-800 z-50">
                <div className="p-4 border-b border-nature-200 dark:border-nature-800 font-extrabold text-xl tracking-tight text-nature-900 dark:text-white">
                    🌱 BeanPool
                </div>
                <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
                    <a href="?page=pulse" className={`block px-3 py-2 rounded-xl text-sm font-semibold ${page === 'pulse' ? 'bg-nature-200 dark:bg-nature-800 font-bold' : ''}`}>The Pulse</a>
                    <a href="?page=commons" className={`block px-3 py-2 rounded-xl text-sm font-semibold ${page === 'commons' ? 'bg-nature-200 dark:bg-nature-800 font-bold' : ''}`}>The Commons</a>
                    <a href="?page=tools" className={`block px-3 py-2 rounded-xl text-sm font-semibold ${page === 'tools' ? 'bg-nature-200 dark:bg-nature-800 font-bold' : ''}`}>Tools</a>
                    <a href="?page=channels" className={`block px-3 py-2 rounded-xl text-sm font-semibold ${page === 'channels' ? 'bg-nature-200 dark:bg-nature-800 font-bold' : ''}`}>Channels</a>
                    <a href="?page=chat" className={`block px-3 py-2 rounded-xl text-sm font-semibold ${page === 'chat' ? 'bg-nature-200 dark:bg-nature-800 font-bold' : ''}`}>Chat</a>
                </nav>
            </aside>

            {/* Main Content Viewport */}
            <main className="flex-1 flex flex-col h-full overflow-y-auto" data-testid="main-viewport">
                {(page === 'pulse' || page === 'all') && (
                    <section data-testid="pulse-section" className="max-w-7xl mx-auto p-4 sm:p-6 pb-24 min-h-full w-full">
                        <h1 className="text-xl font-bold mb-4">The Pulse</h1>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4" data-testid="pulse-grid">
                            <PulseFeedCard item={pulseItem1} currentPubkey="me" onMute={() => {}} onDelete={() => {}} onOpenProfile={() => {}} />
                            <PulseFeedCard item={pulseItem2} currentPubkey="me" onMute={() => {}} onDelete={() => {}} onOpenProfile={() => {}} />
                            <PulseFeedCard item={pulseItem3} currentPubkey="me" onMute={() => {}} onDelete={() => {}} onOpenProfile={() => {}} />
                        </div>
                    </section>
                )}

                {(page === 'commons' || page === 'all') && (
                    <section data-testid="commons-section" className="p-4 max-w-lg sm:max-w-2xl lg:max-w-4xl xl:max-w-7xl mx-auto w-full">
                        <h1 className="text-xl font-bold mb-4">The Commons</h1>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4" data-testid="commons-grid">
                            <EnterpriseCard treasury={mockTreasury1} onOpen={() => {}} />
                            <EnterpriseCard treasury={mockTreasury2} onOpen={() => {}} />
                            <EnterpriseCard treasury={mockTreasury3} onOpen={() => {}} />
                        </div>
                    </section>
                )}

                {(page === 'tools' || page === 'all') && (
                    <section data-testid="tools-section" className="max-w-xl mx-auto px-4 py-4 min-w-0 w-full">
                        <h1 className="text-xl font-bold mb-4">Tools</h1>
                        <ToolSection title="Rotary Hammer Drill" testId="tool-detail-section">
                            {toolReady && <ToolPhoto uri={photoUri} label="Rotary hammer drill in carry case" testId="tool-photo" />}
                            <ToolInput label="Description" value="Cordless 18V SDS-plus rotary hammer drill with 2 batteries" onChange={() => {}} max={200} testId="tool-input" />
                            <ToolRow icon="🧰" title="Things in kit" state="5 drill bits + chuck adapter" testId="tool-row" />
                        </ToolSection>
                    </section>
                )}

                {(page === 'channels' || page === 'all') && (
                    <section data-testid="channels-section" className="max-w-2xl mx-auto p-4 sm:p-6 pb-24 min-h-full w-full">
                        <div className="flex items-center justify-between gap-3 mb-6 pb-4 border-b border-nature-200 dark:border-nature-800">
                            <h1 className="text-lg font-bold">Channels &amp; Showcase</h1>
                        </div>
                        <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-6 shadow-sm">
                            <h2 className="text-base font-bold text-nature-900 dark:text-white mb-2">Connect your channel</h2>
                            <p className="text-sm text-nature-600 dark:text-nature-400 mb-4">
                                Share videos or posts from YouTube, Substack, RSS feeds or Bluesky directly with your community.
                            </p>
                            <div className="w-full">
                                <label htmlFor="channel-url" className="block text-xs font-bold text-nature-700 dark:text-nature-300 mb-1">Your link or handle</label>
                                <input
                                    id="channel-url"
                                    data-testid="channel-link-input"
                                    type="text"
                                    className="w-full min-h-[48px] px-4 py-2.5 rounded-xl border border-nature-300 dark:border-nature-700 bg-nature-50 dark:bg-nature-800 text-nature-900 dark:text-white text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                                    placeholder="https://youtube.com/@channel or @handle.bsky.social"
                                    readOnly
                                    value="https://youtube.com/@mullum-permaculture"
                                />
                            </div>
                        </div>
                    </section>
                )}

                {(page === 'chat' || page === 'all') && (
                    <section data-testid="chat-section" className="h-full max-w-4xl lg:max-w-6xl xl:max-w-7xl mx-auto w-full flex flex-col p-4 sm:p-6 min-h-[500px]">
                        <div className="flex items-center justify-between border-b border-nature-200 dark:border-nature-800 pb-3 mb-4">
                            <div>
                                <h1 className="font-bold text-lg text-nature-900 dark:text-white">🌱 Main Group Chat</h1>
                                <p className="text-xs text-nature-500">32 members active</p>
                            </div>
                        </div>
                        <div className="flex-1 space-y-4" data-testid="chat-messages">
                            <div className="flex justify-start">
                                <div className="max-w-[85%] md:max-w-[70%] bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 p-3.5 rounded-2xl shadow-sm text-sm" data-testid="chat-bubble-peer">
                                    <p className="font-bold text-xs text-nature-600 dark:text-nature-400 mb-1">Damo</p>
                                    <p className="leading-relaxed">The broad group chat layout now spans the full desktop width with comfortable message bubble reading caps!</p>
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <div className="max-w-[85%] md:max-w-[70%] bg-emerald-700 text-white p-3.5 rounded-2xl shadow-sm text-sm" data-testid="chat-bubble-mine">
                                    <p className="leading-relaxed">Confirmed. Reading cap is maintained on desktop viewports so long messages do not become single unreadable lines.</p>
                                </div>
                            </div>
                        </div>
                        <div className="mt-4 pt-3 border-t border-nature-200 dark:border-nature-800">
                            <div className="flex gap-2">
                                <input
                                    data-testid="chat-composer-input"
                                    className="flex-1 min-h-[48px] px-4 py-2.5 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-base"
                                    placeholder="Message community..."
                                    readOnly
                                />
                                <button type="button" className="px-5 py-2.5 bg-emerald-700 text-white font-bold rounded-xl text-sm">Send</button>
                            </div>
                        </div>
                    </section>
                )}
            </main>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<WidePagesApp />);
