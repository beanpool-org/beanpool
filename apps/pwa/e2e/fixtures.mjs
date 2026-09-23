/**
 * The feed the Market grid harness draws. Nothing here talks to a node: every /api call the page makes is
 * answered from this file (see harness.mjs).
 *
 * The listings are chosen to stress tile height: a photo and no photo, a one-word description, an empty one and a
 * very long one, and one of your own. The poll has four answers, one of them long enough to have been the
 * "It's Am…" in Marty's screenshot. The event is there because it was already the short card in that row.
 */

const ME = 'harness-me-pubkey';
const HOUR = 60 * 60 * 1000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

const listing = (over) => ({
    type: 'offer',
    category: 'tools',
    credits: 12,
    priceType: 'fixed',
    status: 'active',
    active: true,
    repeatable: false,
    authorPublicKey: 'member-ada',
    authorCallsign: 'Ada',
    authorEnergyCycled: 40,
    createdAt: iso(-3 * HOUR),
    photos: [],
    ...over,
});

export const POSTS = [
    listing({
        id: 'm-1', title: 'Chainsaw, sharpened', category: 'tools', credits: 8, priceType: 'daily',
        description: 'Husqvarna 435. Chaps and a spare chain come with it. Tell me what you are felling and I will '
            + 'say whether this is the right saw — it is not the one for a big camphor laurel, and I would rather lend '
            + 'you the right tool than watch you fight the wrong one all afternoon.',
        photos: ['/assets/header-bg.png'], authorCallsign: 'Ada', authorEnergyCycled: 320,
    }),
    listing({
        id: 'm-2', title: 'Sourdough starter', category: 'food', credits: 1, description: 'Ten years old.',
        authorPublicKey: 'member-bo', authorCallsign: 'Bo', authorEnergyCycled: 15, createdAt: iso(-5 * HOUR),
    }),
    listing({
        id: 'm-3', type: 'need', title: 'Help moving a piano', category: 'labour', credits: 40, priceType: 'fixed',
        description: 'Upright, ground floor to ground floor, four of us needed for an hour on Saturday morning.',
        authorPublicKey: 'member-cy', authorCallsign: 'Cy', authorEnergyCycled: 90, createdAt: iso(-7 * HOUR),
    }),
    {
        id: 'p-1', type: 'poll', category: 'community', status: 'active', active: true, credits: 0,
        priceType: 'fixed', repeatable: false, photos: [],
        title: 'Where should the new tool shed go?',
        description: 'The working bee is on the 12th either way. This decides where we pour the slab.',
        authorPublicKey: 'member-dee', authorCallsign: 'Dee', authorEnergyCycled: 210, createdAt: iso(-2 * HOUR),
        pollOptions: [
            { id: 'o1', text: "It's Amazing by the north gate, nearest the road", votes: 9, percentage: 45 },
            { id: 'o2', text: 'Behind the south barn, out of the wind', votes: 6, percentage: 30 },
            { id: 'o3', text: 'Beside the packing shed', votes: 4, percentage: 20 },
            { id: 'o4', text: 'Somewhere else — I will say at the meeting', votes: 1, percentage: 5 },
        ],
        totalVotes: 20, userVotedOptionId: 'o2',
        pollClosesAt: iso(72 * HOUR),
        pollVotes: [
            { voterPubkey: 'member-bo', voterCallsign: 'Bo', optionId: 'o1', createdAt: iso(-HOUR) },
            { voterPubkey: 'member-cy', voterCallsign: 'Cy', optionId: 'o2', createdAt: iso(-HOUR) },
        ],
    },
    {
        id: 'e-1', type: 'event', category: 'community', status: 'active', active: true, credits: 0,
        priceType: 'fixed', repeatable: false, photos: [],
        title: 'Working bee at the packing shed',
        description: 'Bring gloves and a thermos.',
        authorPublicKey: 'member-eve', authorCallsign: 'Eve', authorEnergyCycled: 65, createdAt: iso(-4 * HOUR),
        lat: -28.55, lng: 153.5, eventStartAt: iso(30 * HOUR), eventPlaceName: 'Packing shed',
        eventState: 'scheduled', goingCount: 7, interestedCount: 3, myRsvp: null,
    },
    listing({
        id: 'm-4', title: 'Bike repair, gears and brakes', category: 'services', credits: 15, priceType: 'hourly',
        description: 'Derailleurs, cables, bleeding hydraulics. Bring the bike to me.',
        photos: ['/assets/neon-vines-banner.png'], authorPublicKey: ME, authorCallsign: 'You',
        authorEnergyCycled: 500, createdAt: iso(-9 * HOUR),
    }),
    listing({
        id: 'm-5', title: 'Two crates of lemons', category: 'food', credits: 3,
        description: '', authorPublicKey: 'member-fen', authorCallsign: 'Fen', authorEnergyCycled: 5,
        createdAt: iso(-11 * HOUR),
    }),
    listing({
        id: 'm-6', type: 'need', title: 'Ladder, 3m', category: 'tools', credits: 4,
        description: 'For a weekend. Happy to collect and to bring it back cleaner than I found it, which is the '
            + 'least anyone can do with a borrowed ladder.',
        photos: ['/assets/header-bg.png'], authorPublicKey: 'member-gil', authorCallsign: 'Gil',
        authorEnergyCycled: 120, createdAt: iso(-13 * HOUR),
    }),
];

/**
 * The same feed with the poll moved to `index`. The poll is the only thing in the grid wider than one column, so
 * where it falls is what decides whether the row it lands in can hold it: with the poll at `columns - 1` it wants
 * the last column of the first row, has only one column left, and a plain auto-placed grid would push it down and
 * leave that cell empty. Used by market-grid-shots.mjs to photograph exactly that case at every column count.
 */
export function postsWithPollAt(index) {
    const rest = POSTS.filter(p => p.type !== 'poll');
    const poll = POSTS.find(p => p.type === 'poll');
    if (!poll) throw new Error('fixtures: no poll in POSTS');
    if (index > rest.length) throw new Error(`fixtures: cannot put the poll at ${index} of ${rest.length + 1} posts`);
    return [...rest.slice(0, index), poll, ...rest.slice(index)];
}

export const IDENTITY = {
    publicKey: ME,
    privateKey: '',
    callsign: 'You',
    createdAt: iso(-90 * 24 * HOUR),
};

/**
 * Every /api path the page asks for, answered from `posts` — the list above unless a caller hands over another
 * order of it (see postsWithPollAt). Anything not named here is answered 404,
 * which the page already treats as "this node is older than that route" and hides quietly.
 */
export function mockResponse(pathname, search, posts = POSTS) {
    if (pathname === '/api/marketplace/posts') {
        const params = new URLSearchParams(search);
        const id = params.get('id');
        if (id) return posts.filter(p => p.id === id);
        const type = params.get('type');
        const types = (params.get('types') || 'offer,need').split(',');
        return posts.filter(p => (type ? p.type === type : types.includes(p.type)));
    }
    if (pathname === '/api/activity/feed') return { feed: [] };
    if (pathname === '/api/community/members') return [];
    if (pathname === '/api/groups') return [];
    if (pathname === '/api/events/mine') return [];
    if (pathname === '/api/treasuries') return { treasuries: [] };
    if (pathname === '/api/enterprises/statuses') return { enterprises: [] };
    if (pathname === '/api/federation/commission/capacity') return { links: [] };
    if (pathname === '/api/node/config') return { readAuthRequired: false };
    if (pathname === '/api/node/info') return { callsign: 'Harness', peerNodes: [] };
    if (pathname.startsWith('/api/ratings/')) {
        // Four stars on everyone, so the trust line is drawn rather than absent — it is part of a tile's height.
        return { ratings: [], average: 4.4, count: 6, asProvider: { average: 4.4, count: 6 }, asReceiver: { average: 4.4, count: 6 } };
    }
    if (pathname.startsWith('/api/ledger/balance')) return { balance: 240, isBlockedFromTrading: false };
    return undefined;
}
