/**
 * The screens of words sweep W1 (the Market, Talk, the Pulse, events), each on its own, in the language the address
 * names: `?screen=<name>&lang=<xx|en|ru|…>`. The real components and the real compiled stylesheet; every /api call is
 * answered by words-w1-check.mjs, which opens each screen at 320 px with 1.3× text and measures what overflows.
 *
 * No Tailwind classes are written here: this file is outside tailwind.config.js's `content` globs, so a class invented
 * here would not be built. Layout below is inline style, as in harness-main.tsx.
 */
import { createRoot } from 'react-dom/client';
import type { UiLang } from '@beanpool/core';
import { showLanguage } from '../src/lib/language';
import { useTheme } from '../src/lib/useTheme';
import { MarketplacePage } from '../src/pages/MarketplacePage';
import { MessagesPage } from '../src/pages/MessagesPage';
import { ChannelsPage } from '../src/pages/ChannelsPage';
import { PulsePage } from '../src/pages/PulsePage';
import { PulseIntakePage } from '../src/pages/PulseIntakePage';
import { MarketplaceCard } from '../src/components/MarketplaceCard';
import { MyDealsModal } from '../src/components/MyDealsModal';
import { PricingGuideModal } from '../src/components/PricingGuideModal';
import { ReportModal } from '../src/components/ReportModal';
import { ImageLightbox } from '../src/components/ImageLightbox';
import { ActivityWaterfall } from '../src/components/ActivityWaterfall';
import { EventCard, EventDetail } from '../src/components/EventCard';
import { EventChat } from '../src/components/EventChat';
import { EventReminder, EventShareAndCalendar } from '../src/components/EventExtras';
import { PulseFeedCard } from '../src/components/PulseFeedCard';
import { PulsePreviewCard } from '../src/components/PulsePreviewCard';
import { PulseNudges } from '../src/components/PulseNudges';
import { IDENTITY } from './fixtures.mjs';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const SCREEN = params.get('screen') ?? 'cards-grid';
const LANG = (params.get('lang') ?? 'en') as UiLang;
const ME = IDENTITY.publicKey;
const HOUR = 3600 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const none = () => {};

const listing = (over: Record<string, unknown>) => ({
    id: 'c1', type: 'offer', category: 'food', title: 'Sourdough loaf', description: 'Baked this morning, still warm.', credits: 12,
    priceType: 'hourly', authorPublicKey: 'member-kofi', authorCallsign: 'Kofi', active: true, status: 'active',
    repeatable: false, photos: [], createdAt: iso(-2 * HOUR), ...over,
}) as any;
const CARDS = [
    listing({ id: 'c1', repeatable: true, cashAlsoNeeded: true, authorFoundingNeeded: true, audienceScope: 'group', targetGroupName: 'Garden club', authorPublicKey: ME }),
    listing({ id: 'c2', photos: ['/assets/header-bg.png'], repeatable: true, authorFoundingNeeded: true, status: 'pending', priceType: 'weekly' }),
    listing({ id: 'c3', type: 'need', category: 'tools', title: 'Borrow a ladder', description: '', status: 'pending', priceType: 'daily', photos: ['/assets/header-bg.png'] }),
    listing({ id: 'c4', status: 'paused', priceType: 'monthly', credits: 2.5, category: 'mindset' }),
    listing({ id: 'c5', authorCallsign: 'Daily Pulse', title: 'On sharing', description: 'A thought for today' }),
];

const deal = (over: Record<string, unknown>) => ({
    id: 'tx', postId: 'p-bike', postTitle: 'Bike tune-up', buyerPublicKey: ME, buyerCallsign: 'You', sellerPublicKey: 'member-kofi',
    sellerCallsign: 'Kofi', credits: 20, status: 'pending', createdAt: iso(-26 * HOUR), ...over,
}) as any;
const DEAL_POSTS = [
    listing({ id: 'p-couch', type: 'need', title: 'Help moving a couch', authorPublicKey: ME, authorCallsign: 'You', credits: 30, priceType: 'fixed' }),
    listing({ id: 'p-mend', title: 'Mending jackets', authorPublicKey: ME, authorCallsign: 'You', credits: 15, priceType: 'fixed' }),
    listing({ id: 'p-bike', title: 'Bike tune-up', status: 'pending', acceptedBy: ME, credits: 20, priceType: 'fixed' }),
];
const DEALS = [
    deal({ id: 'tx-1' }),
    deal({ id: 'tx-2', postId: 'p-weed', postTitle: 'Weed the veggie patch', buyerPublicKey: 'member-tama', buyerCallsign: 'Tama', sellerPublicKey: ME, sellerCallsign: 'You', credits: 10 }),
    deal({ id: 'tx-3', postId: 'p-mend', postTitle: 'Mending jackets', status: 'completed', buyerPublicKey: 'member-mere', buyerCallsign: 'Mere', sellerPublicKey: ME, sellerCallsign: 'You', credits: 15 }),
    deal({ id: 'tx-4', postId: 'p-bread', postTitle: 'Rye bread', status: 'cancelled', sellerPublicKey: 'member-mere', sellerCallsign: 'Mere', credits: 8 }),
];

const event = (over: Record<string, unknown>) => ({
    id: 'ev-1', type: 'event', category: 'community', title: 'Working bee at the hall', description: 'Bring gloves and a thermos.',
    credits: 0, priceType: 'fixed', authorPublicKey: 'member-hazel', authorCallsign: 'Hazel', createdAt: iso(-HOUR), active: true,
    status: 'active', repeatable: false, photos: [], lat: -28.55, lng: 153.5, eventStartAt: iso(30 * HOUR), eventEndAt: iso(33 * HOUR),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: null, ...over,
}) as any;

const pulseItem = (over: Record<string, unknown>) => ({
    id: 'pi-1', ownerPubkey: ME, url: 'https://youtube.com/watch?v=1', platform: 'youtube', category: 'food',
    title: 'Seed saving at the hall', thumbnailUrl: null, callsign: 'GreenThumb', avatarUrl: 'bundled://leaf',
    source: 'user', isVerified: true, publishedAt: iso(-3 * HOUR), ...over,
}) as any;

function Column({ children, gap = 14 }: { children: React.ReactNode; gap?: number }) {
    return <div style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap, maxWidth: '100%', boxSizing: 'border-box' }}>{children}</div>;
}

function Screen() {
    useTheme();
    switch (SCREEN) {
        case 'market': return <MarketplacePage identity={IDENTITY as never} isMember={true} />;
        case 'cards-grid':
        case 'cards-list':
        case 'cards-compact': {
            const viewMode = SCREEN.slice('cards-'.length) as 'grid' | 'list' | 'compact';
            return <Column>{CARDS.map((p) => <MarketplaceCard key={p.id} post={p} viewMode={viewMode} distanceKm={2.4} remoteNode={p.id === 'c2' ? 'mullum' : undefined} isOwnPost={p.authorPublicKey === ME} onPhotoClick={none} />)}</Column>;
        }
        case 'my-deals-pending':
        case 'my-deals-active':
        case 'my-deals-history':
            return <MyDealsModal visible identity={{ publicKey: ME }} onClose={none} posts={DEAL_POSTS} transactions={DEALS} initialTab={SCREEN.slice('my-deals-'.length) as never} onPromptReview={none} onNavigateToPost={none} />;
        case 'pricing': return <PricingGuideModal isOpen onClose={none} onSelectOfferItem={none} reporterPubkey={ME} />;
        case 'report': return <ReportModal isOpen onClose={none} reporterPubkey={ME} targetPubkey="member-kofi" targetName="Kofi" targetPostId="c1" />;
        case 'lightbox': return <ImageLightbox isOpen photos={['/assets/header-bg.png', '/assets/neon-vines-banner.png']} title="Sourdough loaf" subtitle="Kofi" onClose={none} />;
        case 'activity-full': return <ActivityWaterfall isFullView isMember onOpenPost={none} onOpenProfile={none} />;
        case 'activity-strip': return <ActivityWaterfall isFullView={false} isMember onOpenPost={none} onOpenProfile={none} />;
        case 'events-grid':
        case 'events-list':
            return (
                <Column>
                    {[event({ id: 'ev-1' }), event({ id: 'ev-2', myRsvp: 'going' }), event({ id: 'ev-3', myRsvp: 'interested', eventState: 'updated' }), event({ id: 'ev-4', eventState: 'cancelled' })].map((p) => (
                        <EventCard key={p.id} post={p} identity={IDENTITY as never} viewMode={SCREEN === 'events-grid' ? 'grid' : 'list'} distanceKm={2.4} onOpen={none} />
                    ))}
                </Column>
            );
        case 'event-detail':
            return (
                <Column>
                    <EventDetail post={event({ authorPublicKey: ME, authorCallsign: 'You', eventPrivateNote: 'Gate code 1234' })} identity={IDENTITY as never} distanceKm={2.4} onShowOnMap={none} onOpenProfile={none} onEdit={none} onOpenChat={none} onCopyToNewDate={none} />
                    <EventDetail post={event({ id: 'ev-5', myRsvp: 'going' })} identity={IDENTITY as never} distanceKm={2.4} onShowOnMap={none} onOpenProfile={none} onOpenChat={none} />
                    <EventShareAndCalendar post={event({})} />
                    <EventReminder post={event({ myRsvp: 'going' })} identity={IDENTITY as never} myRsvp="going" />
                </Column>
            );
        case 'event-chat': return <EventChat postId="ev-1" identity={IDENTITY as never} onBack={none} onOpenEvent={none} refreshMs={600000} />;
        case 'pulse-cards':
            return (
                <Column>
                    <PulseNudges channels={[{ id: 'ch-yt', platform: 'youtube', url: 'https://youtube.com/@greenthumb', handle: '@greenthumb', category: 'food' }, { id: 'ch-ig', platform: 'instagram', url: 'https://instagram.com/greenthumb', handle: '@greenthumb', category: 'food' }] as never} onShareChannel={none} onAddFromClipboard={none} />
                    <PulseFeedCard item={pulseItem({})} currentPubkey={ME} onMute={none} onDelete={none} onOpenProfile={none} />
                    <PulseFeedCard item={pulseItem({ id: 'pi-2', ownerPubkey: 'council', callsign: 'Shire Council', source: 'official', isOfficial: true, publishedAt: iso(-9 * 24 * HOUR) })} currentPubkey={ME} onOpenProfile={none} />
                    <PulsePreviewCard preview={{ url: 'https://instagram.com/p/abc123/', title: 'Saving tomato seed', thumbnailUrl: null, platform: 'instagram', category: 'food', isDuplicate: true, authorCallsign: 'GreenThumb', isVerified: true } as never} callsign="GreenThumb" isOptedIn onToggleOptIn={none} showReviewToggle />
                </Column>
            );
        case 'messages': return <MessagesPage identity={IDENTITY as never} />;
        case 'messages-dm': return <MessagesPage identity={IDENTITY as never} openConversationId="conv-trade" />;
        case 'channels': return <ChannelsPage identity={IDENTITY as never} onBack={none} onViewFeed={none} onSharePost={none} />;
        case 'pulse': return <PulsePage identity={IDENTITY as never} onOpenProfile={none} />;
        case 'pulse-intake': return <PulseIntakePage identity={IDENTITY as never} initialUrl="https://instagram.com/p/abc123/" onBack={none} onManageChannels={none} onSuccess={none} />;
        default: return <p>Unknown screen {SCREEN}</p>;
    }
}

void showLanguage(LANG).then(() => {
    createRoot(document.getElementById('root')!).render(<Screen />);
    document.documentElement.dataset.harnessReady = 'true';
});
