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
import { EventCard } from '../src/components/EventCard';
import '../src/index.css';

const HOUR = 60 * 60 * 1000;
const start = new Date(2030, 8, 28, 9, 0).getTime();

const base: any = {
    type: 'event', category: 'community', description: 'Clearing the back garden', credits: 0, priceType: 'fixed',
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

createRoot(document.getElementById('root')!).render(
    <div className="px-3 md:px-6 pt-4 pb-8 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3.5">
            {posts.map((post) => (
                <div key={post.id} className="h-full">
                    <EventCard post={post} identity={identity} viewMode="grid" distanceKm={2.4} />
                </div>
            ))}
        </div>
    </div>,
);
