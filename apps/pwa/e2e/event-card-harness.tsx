/**
 * The Market grid's event card, rendered on its own so the RSVP row can be photographed at every width the
 * design has to hold: the real component, the real compiled Tailwind, no node and no fixtures beyond the posts
 * below. Served by event-card-shots.mjs; see the header there.
 *
 * The wrapper reproduces the Market grid exactly as MarketplacePage renders it — `max-w-7xl mx-auto px-3 md:px-6`
 * around `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5` — because the bug was
 * a column width, not a card: at 1440px that grid gives each card 235px.
 */
import { createRoot } from 'react-dom/client';
import { AuthorCard } from '../src/components/AuthorCard';
import { EventCard, EventDetail } from '../src/components/EventCard';
import '../src/index.css';

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime();

const base: any = {
    type: 'event', category: 'community', description: 'Clearing the back garden', price_c: 0, priceType: 'fixed',
    authorPublicKey: 'host-pk', authorCallsign: 'Hazel', createdAt: new Date().toISOString(), active: true,
    status: 'active', repeatable: false, lat: -28.55, lng: 153.5,
    eventStartAt: new Date(start).toISOString(), eventEndAt: new Date(start + 3 * HOUR).toISOString(),
    eventPlaceName: 'Bindarrabi Hall', eventState: 'scheduled', goingCount: 7, interestedCount: 3,
};

// The three states of the row, because each one is a different label width: "Interested" is the longest plain
// label, and the ✓ makes whichever button is mine longer still.
const posts: any[] = [
    { ...base, id: 'ev-none', title: 'Working bee at the hall', myRsvp: null },
    { ...base, id: 'ev-going', title: 'Seed swap and morning tea', myRsvp: 'going' },
    { ...base, id: 'ev-interested', title: 'Repair cafe — bring anything broken', myRsvp: 'interested' },
    { ...base, id: 'ev-long', title: 'Working bee at the hall — bring gloves, hats and a long-handled shovel', myRsvp: null },
    { ...base, id: 'ev-updated', title: 'Landcare planting day', myRsvp: 'interested', eventState: 'updated' },
];

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me' };

/**
 * The event's PAGE (EventDetail, slice DW1 of DESIGN-detail-pages-fable.md), at `?detail=<case>`: drawn inside the Market's
 * own page wrapper (MarketplacePage's event branch: `p-4 sm:p-6 max-w-3xl`, the Back to Market line above), so the column is
 * the width a member gets. The Mullum market, as the design measures it: a two-line title, a repeat, a place, a photo, a
 * paragraph. The photo is drawn here on a canvas, 800 × 600 like a member's upload, so no file and no node is needed.
 */
function photo(): string {
    const c = document.createElement('canvas');
    c.width = 800; c.height = 600;
    const g = c.getContext('2d')!;
    const sky = g.createLinearGradient(0, 0, 0, 600);
    sky.addColorStop(0, '#9cc9e8'); sky.addColorStop(0.55, '#e8f1d8'); sky.addColorStop(0.56, '#6f9a52'); sky.addColorStop(1, '#3f6b2e');
    g.fillStyle = sky; g.fillRect(0, 0, 800, 600);
    const stall = ['#d9534f', '#f0ad4e', '#5bc0de', '#f7f7f7', '#8e6bbf'];
    for (let i = 0; i < 6; i++) {
        g.fillStyle = stall[i % stall.length];
        g.beginPath(); g.moveTo(40 + i * 125, 330); g.lineTo(100 + i * 125, 270); g.lineTo(160 + i * 125, 330); g.fill();
        g.fillStyle = '#7a5a3a'; g.fillRect(50 + i * 125, 330, 100, 70);
    }
    return c.toDataURL('image/jpeg', 0.85);
}

const START = new Date(2030, 10, 21, 8, 0).getTime();
const mullum: any = {
    ...base, id: 'ev-mullum', title: 'Mullumbimby Community Market and Farmers Market',
    description: 'The farmers and community market at Summers Park: local food, plants, crafts and music, every third Saturday. Bring a bag and come early for the bread.',
    authorPublicKey: 'host-pk', authorCallsign: 'Damo (The IT guy)', eventPlaceName: 'Summers Park, corner of Main Arm Road',
    eventStartAt: new Date(START).toISOString(), eventEndAt: new Date(START + 6 * HOUR).toISOString(),
    eventRepeat: { freq: 'weekly', interval: 3, byDay: 'SA', time: '08:00', minutes: 360 },
    goingCount: 0, interestedCount: 0, myRsvp: null, photos: [photo()], tags: [],
};
/**
 * The six dates the node sends with the market on a by-id read (`eventNextDates`), every third Saturday: the page draws them
 * behind the rule, "↻ Every 3 weeks on Saturday · Next dates" (`?detail=dates`), and `?detail=dates-open` is the same page
 * after a tap opens the list. The other cases send no dates, as a list read does: the rule alone, in the same slot.
 */
const NEXT_DATES = [0, 21, 42, 63, 84, 105].map((days) => {
    const at = new Date(START + days * 24 * HOUR);
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    return { date, startLocal: `${date}T08:00`, startAt: at.toISOString(), cancelled: false };
});
const DETAIL: Record<string, any> = {
    member: mullum,
    dates: { ...mullum, eventNextDates: NEXT_DATES },
    'dates-open': { ...mullum, eventNextDates: NEXT_DATES },
    going: { ...mullum, myRsvp: 'going', goingCount: 3, interestedCount: 1, eventPrivateNote: 'Stall holders park behind the hall; the gate code is 4471.' },
    host: {
        ...mullum, authorPublicKey: 'me-pk', authorCallsign: 'Me', goingCount: 3, interestedCount: 1,
        eventRsvps: [
            { memberPubkey: 'a', memberCallsign: 'Ari', status: 'going', updatedAt: '' },
            { memberPubkey: 'b', memberCallsign: 'Bo', status: 'going', updatedAt: '' },
            { memberPubkey: 'c', memberCallsign: 'Cy', status: 'interested', updatedAt: '' },
        ],
    },
    copy: {
        ...mullum, authorPublicKey: 'hidden', authorCallsign: '', shownCopy: true,
        shownFrom: { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' },
    },
    'no-photo': { ...mullum, photos: [], eventState: 'updated', pinnedAt: new Date().toISOString(), pinnedUntil: new Date(Date.now() + 3 * 24 * HOUR).toISOString() },
};
const detailCase = new URLSearchParams(window.location.search).get('detail');

/**
 * `?detail=posted-by`: the listing page's "Posted by", which draws the same AuthorCard the event's "Hosted by" does (DW1 puts
 * that box on the style box, so the listing's changes too). The listing's own markup around it (MarketplacePage.tsx), with a
 * bio, a contact line and View shop, so the box is measured as the listing fills it.
 */
const postedBy = (
    <div data-testid="event-detail" className="w-full min-w-0 flex flex-col">
        <AuthorCard
            label="Posted by"
            pubkey="host-pk"
            callsign="The Mullumbimby Community Gardens and Seed Library"
            ratings={{ average: 4.8, count: 6, asProvider: { average: 5, count: 3 }, asReceiver: { average: 4.5, count: 3 } }}
            onOpen={() => {}}
            className="mb-4"
            details={<>
                <p className="text-sm text-nature-600 dark:text-nature-400 leading-snug mb-0">Seeds, seedlings and a library of how-to books.</p>
                <p className="text-xs text-nature-700 dark:text-nature-300 mt-2 font-medium bg-oat-50 dark:bg-nature-900 px-2 py-1 rounded-lg inline-block max-w-full [overflow-wrap:anywhere] border border-nature-100 dark:border-nature-800">
                    📧 seeds@example.org
                </p>
            </>}
        >
            <div className="mt-2 pt-2 border-t border-nature-100 dark:border-nature-800">
                <button type="button" className="flex items-center gap-2 min-h-[48px] text-sm font-semibold text-bp-ink-brand hover:underline bg-transparent border-0 p-0 cursor-pointer">
                    <span aria-hidden="true">🏪</span><span>View shop</span>
                </button>
            </div>
        </AuthorCard>
    </div>
);

createRoot(document.getElementById('root')!).render(detailCase === 'posted-by' ? (
    <div className="p-4 sm:p-6 w-full max-w-3xl mx-auto pb-24">{postedBy}</div>
) : detailCase ? (
    <div className="p-4 sm:p-6 w-full max-w-3xl mx-auto pb-24">
        <button className="mb-4 min-h-[48px] flex items-center gap-2 text-nature-500 font-bold">
            <span className="text-xl leading-none">←</span> Back to Market
        </button>
        <EventDetail
            post={DETAIL[detailCase]}
            identity={identity}
            distanceKm={2.4}
            onShowOnMap={() => {}}
            onOpenChat={() => {}}
            onEdit={() => {}}
            onCopyToNewDate={() => {}}
            onOpenProfile={() => {}}
            onOpenTag={() => {}}
        />
    </div>
) : (
    <div className="px-3 md:px-6 pt-4 pb-8 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
            {posts.map((post) => (
                <div key={post.id} className="h-full">
                    {/* rsvpOnCard: the Market's card no longer carries the row (the event's page and the map preview do), and
                        this script measures the row's wrapping, so it asks for it. */}
                    <EventCard post={post} identity={identity} viewMode="grid" distanceKm={2.4} rsvpOnCard />
                </div>
            ))}
        </div>
    </div>
));
