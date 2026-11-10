#!/usr/bin/env node
/**
 * The Market grid as a lattice (G2, DESIGN-market-grid-sizes-fable.md §2.2 to §2.4, §3 G2): pictures for review, and
 * the row checks, measured in a real Chromium from the live layout:
 *
 *   node e2e/market-grid-shots.mjs <out-dir> [--miss=self-start|block]
 *
 * Widths: 320, 320 at 1.3x text, 640, and with a 256 px left shim standing in for the app's sidebar (the harness has no
 * App shell; the Tailwind breakpoints are the viewport's, the columns are not) 768, 768 at 1.3x, 1024, 1280 and 1920.
 * Cases: the fixture (e2e/fixtures.mjs), the node's Daily Pulse (shown while there are under two listings), one pin, three
 * pins (the cap: a listing, the event and the poll), from three columns up the poll in the last column of the first row,
 * the events (W3': a group-only event, an online one, a Byron event read across the zone line, one that ends the next day,
 * your Going and your Interested) and a member's copy of an event on the global community. The reader is in Queensland
 * (Australia/Brisbane, UTC+10, no daylight time), so a NSW event in November is an hour ahead of them. Light and dark, a
 * picture of each.
 *
 * Checks, every grid of every case and scheme (a non-zero exit names each miss):
 *   - the column count for the width;
 *   - every cell in a row is the row's height (the grid's own tracks), and every listing / event / Pulse tile fills its cell;
 *   - every listing / event / Pulse tile's text block is core's MARKET_GRID_TEXT_BLOCK_REM (7.0625rem) at the root size, +-1 px;
 *   - a row of only listing / event / Pulse tiles is no taller than its tiles' own photo + text block (+-1 px): one tile height;
 *   - no tile row is cut: a row of the text block wider inside than it is (scrollWidth > clientWidth) is a miss; on an event
 *     tile the date, the time's shown pieces, "🕒 your time" and every pill on the photo are whole too (a title or a place
 *     that ends in its own "…" inside its row is the design); and an event's time row never ends in a dash;
 *   - the poll (Marty, 5 Nov 2026: "yes two wide it is but make sure it filled correctly. we dont want 2 wide with heaps of
 *     space") is two cells wide and one row tall at every column count; its tile is its row partner's height (a tile beside
 *     it, or the grid's tile height when nothing is), within 2 px, and its row no taller than a tile; no blank vertical band
 *     inside it (between its top, the header, the question, each answer row, the note and the footer, and its foot) is taller
 *     than 32 px; no text in it runs out of its box (a box that clips without an ellipsis, or a line past the tile's edge);
 *   - no empty cell that a later one-cell tile could have taken (dense flow back-fills; the feed simply ending is not one);
 *   - the pins are the grid's first items and as many as pinned (newest first and each once are MarketplacePage.pins.test.tsx's
 *     to check, not this script's); on screen no stream tile comes before a pinned
 *     listing or event, and a pinned poll starts no lower than the row after them;
 *   - nothing is wider than the screen.
 *
 * The poll-tiles case (5 Nov 2026): a 4-answer poll beside events, a 2-answer and a 6-answer poll, at 320, 320 x 1.3, 768,
 * 1024 and 1280, in English and German (`--only=poll-tiles`; its pictures are poll-tiles-<width>-<lang>-<scheme>.png).
 *
 * The poll-vote case (Marty and Damo, 6 Nov 2026: voted in the tile only when the whole poll is in front of the member): a
 * two-answer poll, voted in place at every width; a three-answer one, voted in place where three 44 px rows fit (1280), and
 * opening at 320 where they do not; and the 4-answer poll whose answers are cut or hidden, which never is; at 320, 320 x 1.3
 * and 1280 (`--only=poll-vote`). On every poll tile voted in place, in every case: no answer row is
 * cut (its words wider than their box, or the row past the answers' room) and each is a finger's press tall (44 px).
 *
 * The poll-vote-after case (#2926 review): polls on the edge of fitting, voted. A vote is cast in the first tile voted in place
 * among the borderline ones (by the keyboard: the row focused, Enter), answered as the node answers it, and the Market's
 * refresh brings it back voted; a poll voted on its page comes back voted too. Then every poll is voted in place, or opens,
 * exactly as before the vote, its footer's action is the same words, and the keyboard is still on the row it voted with. Then
 * a second poll's vote is refused with the longest refusal the node sends: its words are whole (on as many lines as they
 * take, inside the tile), the rows are still buttons a press tall, and the keyboard is still on the row. Pictures of each poll
 * before, after the vote, and refused (`--only=poll-vote-after`; poll-vote-after-<width>-<scheme>-voted-<n>.png and
 * -refused.png).
 *
 * `--miss=self-start` puts #1092's cell back (`self-start`, no `h-full`), `--miss=block` lets the text block take its own
 * height, `--miss=time-one-line` makes an event's time one shrinking line (the end piece cut instead of dropped whole), and
 * `--miss=dash-first` moves the dash onto the start piece, `--miss=poll-square` puts the 2 x 2 poll back (the band Marty
 * saw), `--miss=poll-own-height` lets the poll take its own height and `--miss=poll-press-short` squashes a tile voted in
 * place back to one-line rows (under 44 px), `--miss=pct-room` drops the room kept for "100% ✓" (the vote then turns a
 * borderline tile off, as the review measured), `--miss=refusal-cut` puts a refusal back on one cut line, and
 * `--miss=focus-drop` disables a row as it is pressed (the keyboard falls to the page): each must make this exit non-zero (a check that cannot fail is
 * not a check). `--only=<case>[,<case>]` runs those cases.
 *
 * Nothing here talks to a node: every /api call is answered from e2e/fixtures.mjs (harness.mjs).
 * Needs Chromium for Playwright once:
 *   pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, window, getComputedStyle */
import fs from 'node:fs';
import path from 'node:path';
import { startServer, launch, openMarket, settle } from './harness.mjs';
import { POSTS, postsWithPollAt } from './fixtures.mjs';

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
const miss = (args.find(a => a.startsWith('--miss=')) || '').slice('--miss='.length) || null;
const only = (args.find(a => a.startsWith('--only=')) || '').slice('--only='.length) || null;
if (!out) {
    console.error('usage: node e2e/market-grid-shots.mjs <out-dir> [--miss=self-start|block|time-one-line|dash-first|poll-square|poll-own-height|poll-press-short|pct-room|refusal-cut|focus-drop] [--only=<case>]');
    process.exit(2);
}
const MISSES = {
    // #1092's cell: `self-start` and no `h-full` (with `h-full` a start-aligned cell is still its grid area's height).
    'self-start': 'div.grid.grid-flow-row-dense > * { align-self: start !important; height: auto !important; }',
    block: '[data-testid="grid-text-block"] { height: auto !important; }',
    // The time as one line that gives way: the end piece shrinks into "…" instead of dropping whole.
    'time-one-line': '[data-testid="event-tile-time"] { flex-wrap: nowrap !important; } [data-testid="event-time-piece"] { flex-shrink: 1 !important; min-width: 0 !important; }',
    // The dash on the start piece ("10:26–" / "14:26"): where the end piece drops, the row would end in a dash.
    // The poll as it was from four columns (G2): a 2 x 2 square, so its row partners are half its height.
    'poll-square': '[data-testid="poll-grid-cell"] { grid-row: span 2 / span 2 !important; }',
    // The poll's tile in the flow, at its own height, instead of over a tile's invisible box.
    'poll-own-height': '[data-testid="poll-grid-tile"] { position: static !important; } [data-testid="poll-grid-ghost"] { display: none !important; }',
    // A tile voted in place whose answer rows are one line tall again (22 px), under a finger's 44 px press.
    'poll-press-short': '[data-votable="true"] [data-testid="poll-grid-answer"] { min-height: 0 !important; max-height: 1.375rem !important; }',
    // The percentage's room only what it shows (the vote's ✓ and a new digit then come out of the words' box).
    'pct-room': '[data-testid="poll-grid-pct"]::after { content: none !important; }',
    // A refusal on one line, cut with "…", as it was in the footer.
    'refusal-cut': '[data-testid="poll-grid-error"] { white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }',
    // A row disabled as it is pressed, as `disabled` did while a vote was sent: the keyboard falls to the page.
    'focus-drop': () => {
        document.addEventListener('click', (e) => {
            const row = e.target.closest?.('[data-testid="poll-grid-answer"]');
            if (row && row.tagName === 'BUTTON') setTimeout(() => { row.disabled = true; }, 0);
        }, true);
    },
    'dash-first': () => {
        for (const row of document.querySelectorAll('[data-testid="event-tile-time"]')) {
            const [start, end] = row.querySelectorAll('[data-testid="event-time-piece"]');
            if (start && end && end.textContent.startsWith('–')) {
                start.textContent = `${start.textContent}–`;
                end.textContent = end.textContent.slice(1);
            }
        }
    },
};
if (miss && !MISSES[miss]) {
    console.error(`unknown --miss=${miss}; one of ${Object.keys(MISSES).join(', ')}`);
    process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

/**
 * Paths the harness answers 404 on purpose: the community's info (harness.mjs: absent, as on a node older than the switch,
 * so no example cards) and the reader's node role (the poll card asks it for the owners' panel; a 404 is "not an owner").
 * Any other unanswered path is a miss.
 */
const ANSWERED_404 = new Set(['/api/community/info', '/api/node-admin/me']);

/** core's MARKET_GRID_TEXT_BLOCK_REM (market-card-shell.ts); the web shell's test holds the classes to it. */
const BLOCK_REM = 7.0625;

const WIDTHS = [
    { name: '320', width: 320, columns: 2 },
    { name: '320-x1.3', width: 320, columns: 2, textScale: 1.3 },
    { name: '640', width: 640, columns: 2 },
    { name: '768-shim', width: 768, columns: 3, shim: true },
    { name: '768-shim-x1.3', width: 768, columns: 3, shim: true, textScale: 1.3 },
    { name: '1024-shim', width: 1024, columns: 4, shim: true },
    { name: '1280-shim', width: 1280, columns: 5, shim: true },
    { name: '1920-shim', width: 1920, columns: 5, shim: true },
];

const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
/** The node's own Daily Pulse, drawn as the Pulse tile (its author is "Daily Pulse"). */
const PULSE = {
    id: 'pulse-1', type: 'offer', category: 'community', status: 'active', active: true, price_c: 0, priceType: 'fixed',
    title: 'Daily Pulse: what the village is up to', description: 'Three new offers, a working bee on Saturday and the shed poll.',
    authorPublicKey: 'daily-pulse', authorCallsign: 'Daily Pulse', createdAt: iso(-HOUR / 2), photos: [],
};
const pin = (posts, ids) => posts.map(p => (ids.includes(p.id)
    ? { ...p, pinnedUntil: iso(48 * HOUR), pinnedAt: iso(-HOUR * (ids.indexOf(p.id) + 1)) }
    : p));
/** The reader's zone: Queensland, UTC+10 all year, an hour behind NSW on daylight time (October to April). */
const READER_TZ = 'Australia/Brisbane';
const event = (over) => ({
    type: 'event', category: 'community', status: 'active', active: true, price_c: 0, priceType: 'fixed', repeatable: false,
    photos: [], description: '', authorPublicKey: 'member-eve', authorCallsign: 'Eve', authorEnergyCycled: 6500, createdAt: iso(-3 * HOUR),
    lat: -28.64, lng: 153.61, eventState: 'scheduled', goingCount: 4, interestedCount: 2, myRsvp: null, ...over,
});
/**
 * W3' (DESIGN-grid-event-rows-fable.md): the events the tile must hold at every width, fixed in November 2030 so NSW is on
 * daylight time whenever this runs. Each names what its tile must show: row 4, and how many pieces its time row has.
 */
const EVENTS = [
    // A NSW event read in Queensland: Sat 9 Nov 16:00–21:00 in Byron (UTC+11) is 15:00–20:00 here, so "🕒 your time" leads row 4.
    {
        post: event({ id: 'e-byron', title: 'Byron Bay Twilight Market', eventPlaceName: 'Railway Park', myRsvp: 'interested',
            eventStartAt: '2030-11-09T05:00:00.000Z', eventEndAt: '2030-11-09T10:00:00.000Z',
            eventStartLocal: '2030-11-09T16:00', eventEndLocal: '2030-11-09T21:00', eventTz: 'Australia/Sydney' }),
        rows: ['SAT 9 NOV', '15:00–20:00', /^🕒 your time📍 Railway Park/], pieces: 2,
    },
    // Group-only, in the reader's own zone: the plain span, and the 🔒 pill on the photo.
    {
        post: event({ id: 'e-group', title: 'Seed library sorting bee', eventPlaceName: 'Mullumbimby Community Garden', myRsvp: 'going',
            audienceScope: 'group', targetGroupId: 'g-garden', targetGroupName: 'Byron Gardeners',
            eventStartAt: '2030-11-08T00:26:00.000Z', eventEndAt: '2030-11-08T04:26:00.000Z',
            eventStartLocal: '2030-11-08T10:26', eventEndLocal: '2030-11-08T14:26', eventTz: 'Australia/Brisbane' }),
        rows: ['FRI 8 NOV', '10:26–14:26', /^📍 Mullumbimby Community Garden/], pieces: 2, lock: true,
    },
    // Online, a Sydney host's 20:50 (AEDT): 19:50–21:50 here, the bare span, and "your time" in no row.
    {
        post: event({ id: 'e-online', title: 'Repair café: ask a fixer online', eventOnline: true, lat: undefined, lng: undefined,
            eventStartAt: '2030-11-08T09:50:00.000Z', eventEndAt: '2030-11-08T11:50:00.000Z',
            eventStartLocal: '2030-11-08T20:50', eventEndLocal: '2030-11-08T22:50', eventTz: 'Australia/Sydney' }),
        rows: ['FRI 8 NOV', '19:50–21:50', /^🌐 Online$/], pieces: 2,
    },
    // Ends the next day: the start's date and its time alone.
    {
        post: event({ id: 'e-two-day', title: 'Two-day permaculture course', eventPlaceName: 'Bangalow Showground',
            eventStartAt: '2030-11-08T00:26:00.000Z', eventEndAt: '2030-11-09T02:26:00.000Z',
            eventStartLocal: '2030-11-08T10:26', eventEndLocal: '2030-11-09T12:26', eventTz: 'Australia/Brisbane' }),
        rows: ['FRI 8 NOV', '10:26', /^📍 Bangalow Showground/], pieces: 1,
    },
];
/** A member's copy of an event on the global community: whose it is stands in row 4, where the place would. */
const COPY = {
    post: event({ id: 'e-copy', title: 'Mullumbimby farmers market', eventPlaceName: 'Mullumbimby showground', myRsvp: 'going',
        shownCopy: true, shownFrom: { host: 'mullum.example.org', postId: 'home-1', name: 'Mullumbimby', url: 'https://mullum.example.org', door: 'ask' },
        eventStartAt: '2030-11-07T21:00:00.000Z', eventEndAt: '2030-11-08T01:00:00.000Z' }),
    rows: ['FRI 8 NOV', '7:00–11:00', /^from Mullumbimby$/], pieces: 2, noMark: true,
};
/** The poll Marty saw (5 Nov 2026), and a two-answer and a six-answer one: the grid's tile must fill its box with each. */
const poll = (over) => ({
    type: 'poll', category: 'community', status: 'active', active: true, price_c: 0, priceType: 'fixed', repeatable: false, photos: [],
    description: '', authorPublicKey: 'member-damo', authorCallsign: 'Damo (The IT guy)', authorEnergyCycled: 3000, createdAt: iso(-HOUR),
    pollClosesAt: iso(10 * 24 * HOUR + HOUR), pollVotes: [], pollOpenVote: false, userVotedOptionId: null, ...over,
});
const POLL_4 = poll({
    id: 'p-four', title: 'What would make trading with beans easier for you?', totalVotes: 1, userVotedOptionId: 'f1',
    pollOptions: [
        { id: 'f1', text: 'Better matches with what people need', votes: 1, percentage: 100 },
        { id: 'f2', text: 'Faster responses when I post an offer', votes: 0, percentage: 0 },
        { id: 'f3', text: 'A clearer idea of what beans are worth', votes: 0, percentage: 0 },
        { id: 'f4', text: "Not sure yet. I'm still finding my feet", votes: 0, percentage: 0 },
    ],
});
const POLL_2 = poll({
    id: 'p-two', title: 'Market day: Saturday or Sunday?', totalVotes: 5, createdAt: iso(-1.5 * HOUR),
    pollOptions: [{ id: 't1', text: 'Saturday', votes: 3, percentage: 60 }, { id: 't2', text: 'Sunday', votes: 2, percentage: 40 }],
});
const POLL_6 = poll({
    id: 'p-six', title: 'Which workshop should the hall host next month, now that the roof is fixed?', totalVotes: 12, createdAt: iso(-2.5 * HOUR),
    pollOptions: ['Bread and sourdough', 'Bike repair for beginners', 'Seed saving and swapping', 'Basic carpentry', 'Composting at home', 'Phone and computer help']
        .map((text, i) => ({ id: `s${i}`, text, votes: [4, 3, 2, 2, 1, 0][i], percentage: [33, 25, 17, 17, 8, 0][i] })),
});
/** A short poll, all of it in a 320 px tile: three one-word answers. */
const POLL_SHORT = poll({
    id: 'p-short', title: 'Market day?', totalVotes: 5, createdAt: iso(-0.5 * HOUR),
    pollOptions: [
        { id: 'm1', text: 'Saturday', votes: 3, percentage: 60 },
        { id: 'm2', text: 'Sunday', votes: 2, percentage: 40 },
        { id: 'm3', text: 'Either', votes: 0, percentage: 0 },
    ],
});
/** Two one-word answers under a one-line question: the most a 320 px tile at 1.3x text holds a press tall. */
const POLL_YES = poll({
    id: 'p-yes', title: 'Bring a plate?', totalVotes: 4, createdAt: iso(-0.75 * HOUR),
    pollOptions: [{ id: 'y1', text: 'Yes', votes: 3, percentage: 75 }, { id: 'y2', text: 'No', votes: 1, percentage: 25 }],
});
/**
 * On the edge of fitting (#2926 review): the reviewer's two-answer poll, 35 and 34 characters; 30 characters, which a 320 px tile
 * holds beside "100% ✓"; and 50, which no 320 px tile holds. Each, and the two refused below, as their node answers a vote.
 */
const POLL_HALL = poll({
    id: 'p-hall', title: 'Where should we meet?', totalVotes: 4, createdAt: iso(-0.6 * HOUR),
    pollOptions: [
        { id: 'h1', text: 'Saturday morning at the market hall', votes: 3, percentage: 75 },
        { id: 'h2', text: 'Sunday morning at the bowling club', votes: 1, percentage: 25 },
    ],
});
const POLL_WHOLE = poll({
    id: 'p-whole', title: 'When is the swap?', totalVotes: 4, createdAt: iso(-0.65 * HOUR),
    pollOptions: [{ id: 'w1', text: 'Saturday morning at the market', votes: 3, percentage: 75 }, { id: 'w2', text: 'No', votes: 1, percentage: 25 }],
});
const POLL_LONG = poll({
    id: 'p-long', title: 'Where is the stall?', totalVotes: 4, createdAt: iso(-0.7 * HOUR),
    pollOptions: [{ id: 'l1', text: 'Saturday morning at the market hall, near the gate', votes: 3, percentage: 75 }, { id: 'l2', text: 'No', votes: 1, percentage: 25 }],
});
const POLL_CHAIR = poll({
    id: 'p-chair', title: 'Bring a chair?', totalVotes: 4, createdAt: iso(-0.8 * HOUR),
    pollOptions: [{ id: 'c1', text: 'Yes', votes: 3, percentage: 75 }, { id: 'c2', text: 'No', votes: 1, percentage: 25 }],
});
/** A poll as the node answers a vote on `optionId`: one more vote, on that answer, the percentages anew, the ✓ on it. */
const votedOn = (p, optionId) => {
    const options = p.pollOptions.map(o => ({ ...o, votes: o.votes + (o.id === optionId ? 1 : 0) }));
    const total = p.totalVotes + 1;
    return { ...p, totalVotes: total, userVotedOptionId: optionId, pollOptions: options.map(o => ({ ...o, percentage: Math.round((o.votes / total) * 100) })) };
};
/** The longest refusal a node sends to a vote (apps/server/src/engine/posts.ts votePoll): a sealed poll answered. */
const LONGEST_REFUSAL = 'You have already answered this poll, and nothing links your answer to you, so it cannot be changed.';

/** The brief's widths and languages for the poll's tile. */
const POLL_WIDTHS = ['320', '320-x1.3', '768-shim', '1024-shim', '1280-shim', '1920-shim'];
const POLL_LANGS = ['en', 'de'];

const CASES = [
    { name: 'fixture', posts: POSTS, pins: [] },
    // The Market shows the node's Pulse only while it has fewer than two listings (MarketplacePage): one listing, the
    // event, the poll and the Pulse.
    { name: 'pulse', posts: [PULSE, ...POSTS.filter(p => ['m-1', 'e-1', 'p-1'].includes(p.id))], pins: [], needs: 'pulse' },
    { name: 'one-pin', posts: pin(POSTS, ['m-2']), pins: ['m-2'] },
    // Newest pin first: the listing, then the event, then the poll.
    { name: 'three-pins', posts: pin(POSTS, ['m-2', 'e-1', 'p-1']), pins: ['m-2', 'e-1', 'p-1'] },
    { name: 'poll-last-column', posts: null, pins: [], minColumns: 3 },
    { name: 'events', posts: [...POSTS, ...EVENTS.map(e => e.post)], pins: [], events: EVENTS },
    // The global community's view of a member's copy (its directory row in shownFrom).
    { name: 'global-copy', posts: [...POSTS, COPY.post], pins: [], events: [COPY] },
    // The poll's tile (5 Nov 2026): the 4-answer poll beside the events, then a 2-answer and a 6-answer poll among listings.
    {
        name: 'poll-tiles', pins: [], widths: POLL_WIDTHS, langs: POLL_LANGS, polls: 3,
        posts: [POLL_4, ...EVENTS.map(e => e.post), POLL_2, ...POSTS.filter(p => p.type !== 'poll'), POLL_6],
    },
    // Voted in the tile (6 Nov 2026): the two-answer poll in place at every width; the three-answer one where its three rows
    // can each be 44 px tall (at 320 px the room holds two: measured 6 Nov, it opens there); the 4-answer poll never (its
    // answers are cut or behind "+N more").
    {
        name: 'poll-vote', pins: [], widths: ['320', '320-x1.3', '1280-shim'], polls: 4,
        posts: [POLL_YES, POLL_2, POLL_SHORT, ...POSTS.filter(p => p.type !== 'poll'), POLL_4],
        votable: (spec) => ({
            [POLL_YES.title]: true,
            [POLL_2.title]: (spec.textScale ?? 1) === 1,
            [POLL_SHORT.title]: spec.width >= 768,
            [POLL_4.title]: false,
        }),
    },
    // Voted, and refused (#2926 review). The 34-35 character answers vote in place at 1280; the 50-character one nowhere (cut at
    // 1280 too, measured 6 Nov); at 320 px the 34-35 character ones do not fit beside
    // "100% ✓" (209 px of words in 196 at 1x, measured 6 Nov), so that tile opens, before the vote and after it alike.
    {
        name: 'poll-vote-after', pins: [], widths: ['320', '320-x1.3', '1280-shim'], polls: 5,
        posts: [POLL_HALL, POLL_WHOLE, POLL_LONG, POLL_YES, ...POSTS.filter(p => p.type !== 'poll'), POLL_CHAIR],
        votable: (spec) => ({
            [POLL_HALL.title]: spec.width >= 768,
            [POLL_WHOLE.title]: spec.width >= 768 || (spec.textScale ?? 1) === 1,
            [POLL_LONG.title]: false,
            [POLL_YES.title]: true,
            [POLL_CHAIR.title]: true,
        }),
        vote: {
            // The first of these voted in place here is voted; the others come back voted on their page.
            cast: [[POLL_HALL, 'h1'], [POLL_WHOLE, 'w1'], [POLL_YES, 'y1']],
            elsewhere: [[POLL_LONG, 'l1']],
            refuse: [POLL_CHAIR, 'c1'],
        },
    },
];

/** Everything measured in the page, for every grid on it. */
function measure() {
    const px = (v) => parseFloat(v) || 0;
    const root = px(getComputedStyle(document.documentElement).fontSize);
    const grids = [...document.querySelectorAll('div.grid.grid-flow-row-dense')].map((gridEl) => {
        const cs = getComputedStyle(gridEl);
        const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).map(px);
        const rows = cs.gridTemplateRows.split(' ').filter(Boolean).map(px);
        const colGap = px(cs.columnGap);
        const rowGap = px(cs.rowGap);
        const g = gridEl.getBoundingClientRect();
        // Track starts, from the grid's own tracks.
        const colStarts = cols.map((_, i) => cols.slice(0, i).reduce((a, b) => a + b + colGap, 0));
        const rowStarts = rows.map((_, i) => rows.slice(0, i).reduce((a, b) => a + b + rowGap, 0));
        const nearest = (starts, v) => starts.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(starts[best] - v) ? i : best), 0);
        const cells = [...gridEl.children].map((cell, index) => {
            const r = cell.getBoundingClientRect();
            const top = r.top - g.top;
            const left = r.left - g.left;
            const row = nearest(rowStarts, top);
            const col = nearest(colStarts, left);
            const rowSpan = rowStarts.filter(s => s >= top - 1 && s < top + r.height - 1).length;
            const colSpan = colStarts.filter(s => s >= left - 1 && s < left + r.width - 1).length;
            const tracksHeight = rows.slice(row, row + rowSpan).reduce((a, b) => a + b, 0) + rowGap * (rowSpan - 1);
            // The poll by its tile (PollGridTile) or, on a branch before it, its card: never by its words, which are German too.
            const pollTile = cell.querySelector('[data-testid="poll-grid-tile"]') || cell.querySelector('[data-testid="poll-card"]');
            const kind = cell.querySelector('[data-testid="event-card"]') ? 'event'
                : cell.querySelector('[data-testid="listing-grid-tile"]')
                    ? ((cell.getAttribute('aria-label') || '').startsWith('Daily Pulse') ? 'pulse' : 'listing')
                    : (pollTile ? 'poll' : 'other');
            const tile = pollTile || cell.firstElementChild;
            const t = tile ? tile.getBoundingClientRect() : r;
            const block = cell.querySelector('[data-testid="grid-text-block"]');
            const photo = block ? block.previousElementSibling : null;
            // A row of the text block that is wider inside than it is: something in it runs past its edge and is cut there.
            const rowsCut = block ? [...block.children].map((row, i) => (row.scrollWidth > row.clientWidth
                ? `row ${i + 1} "${row.textContent}" (${row.scrollWidth} > ${row.clientWidth})` : null)).filter(Boolean) : [];
            // An event tile: what must be whole (the date, the time's shown pieces, "🕒 your time", the photo's pills), the
            // time row as it reads (only the pieces on its one visible line), and its four rows.
            let ev = null;
            if (kind === 'event' && block && photo) {
                const notWhole = [];
                const whole = (el, name) => { if (el && el.scrollWidth > el.clientWidth) notWhole.push(`${name} "${el.textContent}" (${el.scrollWidth} > ${el.clientWidth})`); };
                whole(cell.querySelector('[data-testid="event-tile-date"]'), 'the date');
                whole(cell.querySelector('[data-testid="event-your-time"]'), '"your time"');
                const time = cell.querySelector('[data-testid="event-tile-time"]');
                const tr = time.getBoundingClientRect();
                const pieces = [...time.querySelectorAll('[data-testid="event-time-piece"]')];
                const shown = pieces.filter(p => p.getBoundingClientRect().top - tr.top < tr.height / 2);
                for (const p of shown) whole(p, 'a time piece');
                const pr = photo.getBoundingClientRect();
                for (const pill of cell.querySelectorAll('[data-testid="grid-badge-row"] > *')) {
                    whole(pill, 'a pill');
                    const b = pill.getBoundingClientRect();
                    if (b.left < pr.left - 0.5 || b.right > pr.right + 0.5 || b.top < pr.top - 0.5) notWhole.push(`a pill "${pill.textContent}" runs off the photo`);
                }
                ev = {
                    title: cell.querySelector('[data-testid="event-tile-title"]')?.textContent ?? '',
                    rows: [...block.children].map(x => x.textContent),
                    time: shown.map(p => p.textContent).join(''),
                    shownPieces: shown.length, pieces: pieces.length,
                    lock: !!cell.querySelector('[data-testid="event-lock-pill"]'),
                    mark: cell.querySelector('[data-testid="event-mark"]')?.textContent ?? null,
                    notWhole,
                };
            }
            const tcs = tile ? getComputedStyle(tile) : null;
            const natural = block && photo
                ? photo.getBoundingClientRect().height + block.getBoundingClientRect().height + px(tcs.borderTopWidth) + px(tcs.borderBottomWidth)
                : null;
            // The poll: the blank bands between its parts (its content's top, each in-flow part in turn, with the answers' room
            // read row by row, and its content's foot), and any text in it that runs out of its box.
            let poll = null;
            if (kind === 'poll' && tile) {
                const tr = tile.getBoundingClientRect();
                const tcs0 = getComputedStyle(tile);
                const top = tr.top + px(tcs0.borderTopWidth) + px(tcs0.paddingTop);
                const bottom = tr.bottom - px(tcs0.borderBottomWidth) - px(tcs0.paddingBottom);
                const inFlow = (el) => { const cs = getComputedStyle(el); return cs.position !== 'absolute' && cs.display !== 'none' && el.getBoundingClientRect().height > 0; };
                const parts = [];
                for (const child of [...tile.children].filter(inFlow)) {
                    if (child.getAttribute('data-testid') === 'poll-grid-answers') parts.push(...[...child.children].filter(inFlow).map(r => ({ el: r, name: `answer "${r.textContent.slice(0, 24)}"` })));
                    else parts.push({ el: child, name: child.getAttribute('data-testid') || child.tagName.toLowerCase() });
                }
                const boxes = parts.map(x => ({ ...x, r: x.el.getBoundingClientRect() })).sort((a, b) => a.r.top - b.r.top);
                const bands = [];
                let at = top, after = 'the top';
                for (const b of boxes) {
                    if (b.r.top - at > 0.5) bands.push({ px: b.r.top - at, between: `${after} and ${b.name}` });
                    if (b.r.bottom > at) { at = b.r.bottom; after = b.name; }
                }
                if (bottom - at > 0.5) bands.push({ px: bottom - at, between: `${after} and the foot` });
                const overflows = [];
                for (const el of [tile, ...tile.querySelectorAll('*')]) {
                    const cs = getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    if (!r.width || (cs.position === 'absolute' && !el.textContent.trim())) continue;
                    if (r.right > tr.right + 0.5 || r.left < tr.left - 0.5) { overflows.push(`"${el.textContent.slice(0, 30)}" runs past the tile's edge`); continue; }
                    const clips = cs.overflowX !== 'visible';
                    const ellipsis = cs.textOverflow === 'ellipsis';
                    if (el.scrollWidth > el.clientWidth + 1 && !(clips && ellipsis) && cs.display !== '-webkit-box') {
                        overflows.push(`"${el.textContent.slice(0, 30)}" is ${el.scrollWidth}px in a ${el.clientWidth}px box${clips ? ', cut with no "…"' : ''}`);
                    }
                    if (el.getAttribute('data-testid') === 'poll-grid-answers' && el.scrollHeight > el.clientHeight + 1) overflows.push(`the answers need ${el.scrollHeight}px in ${el.clientHeight}px: a row is cut`);
                }
                // Voted in place (PollGridTile's data-votable): each answer row whole, inside the answers' room, a press tall.
                const votable = tile.getAttribute('data-votable') === 'true';
                const pressMisses = [];
                if (votable) {
                    const roomBox = tile.querySelector('[data-testid="poll-grid-answers"]').getBoundingClientRect();
                    for (const rowEl of tile.querySelectorAll('[data-testid="poll-grid-answer"]')) {
                        const rr = rowEl.getBoundingClientRect();
                        const words = rowEl.querySelector('[data-testid="poll-grid-answer-words"]');
                        const name = `answer "${words?.textContent ?? rowEl.textContent}"`;
                        if (rowEl.tagName !== 'BUTTON') pressMisses.push(`${name} is no button`);
                        if (rr.height < 44 - 0.5) pressMisses.push(`${name} is ${rr.height.toFixed(1)}px tall, under a 44 px press`);
                        if (rr.top < roomBox.top - 0.5 || rr.bottom > roomBox.bottom + 0.5) pressMisses.push(`${name} runs out of the answers' room`);
                        if (words && words.scrollWidth > words.clientWidth) pressMisses.push(`${name} is cut (${words.scrollWidth} > ${words.clientWidth})`);
                    }
                }
                poll = {
                    votable, block: tile.getAttribute('data-vote-block') || null, pressMisses,
                    bands, overflows,
                    answers: tile.querySelectorAll('[data-testid="poll-grid-answer"]').length,
                    more: tile.querySelector('[data-testid="poll-grid-more"]')?.textContent ?? null,
                    question: tile.querySelector('h3')?.textContent ?? '',
                    id: tile.getAttribute('data-poll'),
                };
            }
            return {
                index, kind, row, col, rowSpan, colSpan,
                pinned: cell.getAttribute('data-testid') === 'market-pinned-tile',
                label: (cell.getAttribute('aria-label') || ev?.title || poll?.question || tile?.querySelector('h3')?.textContent || cell.textContent).trim().slice(0, 40),
                cellH: r.height, tracksHeight, tileH: t.height,
                blockH: block ? block.getBoundingClientRect().height : null,
                natural, poll, rowsCut, ev,
            };
        });
        return { cols: cols.length, colWidth: cols[0], colGap, rowGap, rows, cells };
    });
    return {
        root,
        grids,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
}

/** Every check for one measured page; returns the misses. `votable`: each named poll's question, and whether it must be voted in place. */
function check(m, spec, pins, events = [], votable = null) {
    const misses = [];
    const fail = (msg) => misses.push(msg);
    const block = BLOCK_REM * m.root;
    if (m.overflow > 0) fail(`page is ${m.overflow}px wider than the screen`);
    if (!m.grids.length) fail('no grid drawn');
    m.grids.forEach((g, gi) => {
        const at = m.grids.length > 1 ? `grid ${gi + 1}: ` : '';
        if (g.cols !== spec.columns) fail(`${at}${g.cols} columns (expected ${spec.columns})`);
        // W3': the event tile is on the lattice, as the listing and the Pulse are.
        const lattice = (c) => c.kind === 'listing' || c.kind === 'pulse' || c.kind === 'event';
        for (const c of g.cells) {
            if (Math.abs(c.cellH - c.tracksHeight) > 1) fail(`${at}"${c.label}" cell is ${c.cellH.toFixed(1)}px in a ${c.tracksHeight.toFixed(1)}px row: not the row's height`);
            if (lattice(c)) {
                if (Math.abs(c.tileH - c.cellH) > 1) fail(`${at}"${c.label}" tile is ${c.tileH.toFixed(1)}px in a ${c.cellH.toFixed(1)}px cell: it does not fill it`);
                if (c.blockH === null || Math.abs(c.blockH - block) > 1) fail(`${at}"${c.label}" text block is ${c.blockH?.toFixed(1)}px (expected ${block.toFixed(1)})`);
                for (const x of c.rowsCut) fail(`${at}"${c.label}" ${x}: cut`);
            }
            if (c.kind === 'event') {
                if (!c.ev) { fail(`${at}"${c.label}" event tile has no four-row block`); continue; }
                for (const x of c.ev.notWhole) fail(`${at}"${c.label}" ${x}: cut`);
                if (!c.ev.time) fail(`${at}"${c.label}" time row shows nothing`);
                if (/[–-]\s*$/.test(c.ev.time)) fail(`${at}"${c.label}" time row ends in a dash: "${c.ev.time}"`);
            }
        }
        // One tile height: a row of only lattice tiles (none spanning into it) is its tiles' own height.
        const tile = Math.max(0, ...g.cells.filter(lattice).map(c => c.natural));
        g.rows.forEach((h, r) => {
            const inRow = g.cells.filter(c => r >= c.row && r < c.row + c.rowSpan);
            if (!inRow.length || !inRow.every(c => lattice(c) && c.rowSpan === 1)) return;
            const own = Math.max(...inRow.map(c => c.natural));
            if (h > own + 1) fail(`${at}row ${r + 1} is ${h.toFixed(1)}px for tiles of ${own.toFixed(1)}px`);
            const spread = own - Math.min(...inRow.map(c => c.natural));
            if (spread > 1) fail(`${at}row ${r + 1}: its tiles' own heights differ by ${spread.toFixed(1)}px`);
        });
        // The poll: two cells and one row at every column count, its row partner's height, filled, nothing cut.
        for (const p of g.cells.filter(c => c.kind === 'poll')) {
            const name = `${at}poll "${p.label}"`;
            if (p.colSpan !== 2 || p.rowSpan !== 1) fail(`${name} is ${p.colSpan} x ${p.rowSpan} (expected 2 x 1)`);
            const partner = g.cells.find(c => c !== p && lattice(c) && c.row === p.row && c.rowSpan === 1);
            const want = partner ? partner.tileH : tile;
            if (want && Math.abs(p.tileH - want) > 2) fail(`${name} is ${p.tileH.toFixed(1)}px beside ${partner ? `"${partner.label}"` : "the grid's tiles"} at ${want.toFixed(1)}px`);
            if (tile && p.tracksHeight > tile + 1) fail(`${name}'s row is ${p.tracksHeight.toFixed(1)}px for tiles of ${tile.toFixed(1)}px: the poll made it taller`);
            for (const b of p.poll?.bands ?? []) if (b.px > 32) fail(`${name} has a ${b.px.toFixed(1)}px blank band between ${b.between}`);
            for (const x of p.poll?.overflows ?? []) fail(`${name}: ${x}`);
            for (const x of p.poll?.pressMisses ?? []) fail(`${name} (voted in place): ${x}`);
        }
        // No empty cell a later one-cell tile could have taken.
        const filled = g.rows.map(() => new Array(g.cols).fill(false));
        for (const c of g.cells) for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) if (filled[r]) filled[r][k] = true;
        filled.forEach((cells, r) => {
            const empty = cells.filter(x => !x).length;
            const later = g.cells.some(c => c.row > r && c.rowSpan === 1 && c.colSpan === 1);
            if (empty && later) fail(`${at}row ${r + 1} has ${empty} empty cell(s) and a tile drawn below it`);
        });
    });
    // The case's polls that must, or must not, be voted in place (6 Nov 2026).
    if (votable) {
        const polls = m.grids.flatMap(g => g.cells.filter(c => c.kind === 'poll' && c.poll));
        for (const [question, want] of Object.entries(votable)) {
            const c = polls.find(x => x.poll.question === question);
            if (!c) { fail(`no poll tile for "${question}"`); continue; }
            if (c.poll.votable !== want) fail(`poll "${question}" ${c.poll.votable ? 'is voted in place' : `opens (${c.poll.block})`}; expected it to ${want ? 'be voted in place' : 'open'}`);
        }
    }
    // The case's events, each drawn as a tile with the rows it is here for (so the zone and the copy really were read).
    const tiles = m.grids.flatMap(g => g.cells.filter(c => c.kind === 'event' && c.ev));
    for (const e of events) {
        const c = tiles.find(x => x.ev.title === e.post.title);
        if (!c) { fail(`no event tile for "${e.post.title}"`); continue; }
        const [date, time, , last] = c.ev.rows;
        if (date !== e.rows[0]) fail(`"${e.post.title}" row 1 is "${date}" (expected "${e.rows[0]}")`);
        if (time !== e.rows[1]) fail(`"${e.post.title}" row 2 holds "${time}" (expected "${e.rows[1]}")`);
        if (!e.rows[2].test(last)) fail(`"${e.post.title}" row 4 is "${last}" (expected ${e.rows[2]})`);
        if (c.ev.pieces !== e.pieces) fail(`"${e.post.title}" time row has ${c.ev.pieces} piece(s) (expected ${e.pieces})`);
        if (c.ev.lock !== !!e.lock) fail(`"${e.post.title}" ${c.ev.lock ? 'has' : 'has no'} 🔒 pill`);
        if (!!e.noMark && c.ev.mark) fail(`"${e.post.title}" shows a mark "${c.ev.mark}" on a copy`);
        if (!e.noMark && e.post.myRsvp && !c.ev.mark) fail(`"${e.post.title}" shows no mark for the reader's ${e.post.myRsvp}`);
    }
    // Pins: the first items of the first grid, as many as pinned; no stream tile before a pinned listing or event.
    if (pins.length && m.grids.length) {
        const first = m.grids[0].cells;
        const pinned = m.grids.flatMap(g => g.cells.filter(c => c.pinned));
        if (pinned.length !== pins.length) fail(`${pinned.length} pinned tiles (expected ${pins.length})`);
        if (!first.slice(0, pins.length).every(c => c.pinned)) fail('the pins are not the grid\'s first items');
        const order = [...first].sort((a, b) => a.row - b.row || a.col - b.col);
        const lastPin = Math.max(-1, ...order.map((c, i) => (c.pinned && c.kind !== 'poll' ? i : -1)));
        const firstStream = order.findIndex(c => !c.pinned);
        if (firstStream !== -1 && firstStream < lastPin) fail('a stream tile is drawn before a pinned tile');
        const pinRows = first.filter(c => c.pinned && c.kind !== 'poll').map(c => c.row);
        for (const p of first.filter(c => c.pinned && c.kind === 'poll')) {
            if (pinRows.length && p.row > Math.max(...pinRows) + 1) fail(`the pinned poll starts at row ${p.row + 1}, below the other pins' rows`);
        }
    }
    return misses;
}

function report(m) {
    for (const [gi, g] of m.grids.entries()) {
        console.log(`    grid${m.grids.length > 1 ? ` ${gi + 1}` : ''}: ${g.cols} x ${g.colWidth.toFixed(0)}px, gap ${g.colGap}, rows ${g.rows.map(r => r.toFixed(0)).join('/')}`);
        for (const c of g.cells) {
            const what = c.kind === 'event' && c.ev
                ? ` | ${c.ev.rows.join(' | ')} | time shows "${c.ev.time}" (${c.ev.shownPieces} of ${c.ev.pieces})${c.ev.mark ? ` | mark "${c.ev.mark}"` : ''}${c.ev.lock ? ' | 🔒' : ''}`
                : c.kind === 'poll' && c.poll ? ` ${c.colSpan} x ${c.rowSpan}, ${c.poll.answers} answer row(s)${c.poll.more ? ` + "${c.poll.more}"` : ''}, widest band ${Math.max(0, ...c.poll.bands.map(b => b.px)).toFixed(0)}px, ${c.poll.votable ? 'voted in place' : `opens (${c.poll.block})`}` : '';
            console.log(`      r${c.row + 1}c${c.col + 1} ${c.kind.padEnd(7)} ${c.pinned ? '📌 ' : ''}tile ${c.tileH.toFixed(0)}${c.blockH ? ` block ${c.blockH.toFixed(1)}` : ''}${what}  "${c.label}"`);
        }
    }
}

/** Each poll tile on the page: voted in place or not (and why), its footer's action, its id. */
function pollStates() {
    return [...document.querySelectorAll('[data-testid="poll-grid-tile"]')].map(t => ({
        id: t.getAttribute('data-poll'),
        votable: t.getAttribute('data-votable') === 'true',
        block: t.getAttribute('data-vote-block') || null,
        action: t.querySelector('[data-testid="poll-grid-action"]')?.textContent ?? null,
        cut: [...t.querySelectorAll('[data-testid="poll-grid-answer-words"]')].filter(w => w.scrollWidth > w.clientWidth).map(w => `"${w.textContent}" ${w.scrollWidth} > ${w.clientWidth}`),
    }));
}

/** Where the keyboard is: the poll and the row's name, or the element it fell to. */
function focusAt() {
    const a = document.activeElement;
    return { poll: a?.closest?.('[data-testid="poll-grid-tile"]')?.getAttribute('data-poll') ?? null, label: a?.getAttribute?.('aria-label') ?? null, tag: a?.tagName ?? null };
}

/** A refused tile: its refusal whole and inside the tile, its rows buttons a press tall inside the answers' room, what gave way. */
function refusedState(id) {
    const t = document.querySelector(`[data-testid="poll-grid-tile"][data-poll="${id}"]`);
    if (!t) return { misses: [`no tile for ${id}`] };
    const misses = [];
    const e = t.querySelector('[data-testid="poll-grid-error"]');
    const tr = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const inner = { top: tr.top + parseFloat(cs.paddingTop) - 0.5, bottom: tr.bottom - parseFloat(cs.paddingBottom) + 0.5 };
    if (!e) misses.push('no refusal shown');
    else {
        if (e.getAttribute('role') !== 'alert') misses.push('the refusal is not role="alert"');
        if (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1) misses.push(`the refusal is cut (${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight})`);
        const r = e.getBoundingClientRect();
        if (r.top < inner.top || r.bottom > inner.bottom) misses.push(`the refusal runs out of the tile (${r.top.toFixed(1)}-${r.bottom.toFixed(1)} in ${inner.top.toFixed(1)}-${inner.bottom.toFixed(1)})`);
    }
    const room = t.querySelector('[data-testid="poll-grid-answers"]').getBoundingClientRect();
    for (const row of t.querySelectorAll('[data-testid="poll-grid-answer"]')) {
        const r = row.getBoundingClientRect();
        const name = `answer "${row.querySelector('[data-testid="poll-grid-answer-words"]')?.textContent}"`;
        if (row.tagName !== 'BUTTON' || row.disabled) misses.push(`${name} is no button to press`);
        if (r.height < 44 - 0.5) misses.push(`${name} is ${r.height.toFixed(1)}px tall, under a 44 px press`);
        if (r.top < room.top - 0.5 || r.bottom > room.bottom + 0.5) misses.push(`${name} runs out of the answers' room`);
    }
    if (t.getAttribute('data-votable') !== 'true') misses.push(`the tile stopped voting (${t.getAttribute('data-vote-block')})`);
    const gaveWay = ['poll-grid-head', 'poll-grid-question', 'poll-grid-foot'].filter(x => !t.querySelector(`[data-testid="${x}"]`));
    return { misses, gaveWay, lines: e ? Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) : 0 };
}

/** The poll-vote-after steps on an open page (its feed `posts`, which the Market reads again after a vote); returns the misses. */
async function voteSteps(page, kase, posts, name) {
    const misses = [];
    const shoot = async (id, suffix) => {
        const cell = page.locator(`[data-testid="poll-grid-cell"]:has([data-poll="${id}"])`);
        if (await cell.count()) await cell.first().screenshot({ path: path.join(out, `${name}-${suffix}.png`), animations: 'disabled' });
    };
    const before = await page.evaluate(pollStates);
    const castOn = kase.vote.cast.find(([p]) => before.find(s => s.id === p.id)?.votable);
    const answerRow = (id, optionId) => {
        const p = posts.find(x => x.id === id);
        const text = p.pollOptions.find(o => o.id === optionId).text;
        return page.locator(`[data-poll="${id}"] [data-testid="poll-grid-answer"]`, { has: page.locator('[data-testid="poll-grid-answer-words"]', { hasText: text }) }).first();
    };
    let refusing = false;
    await page.route('**/api/marketplace/posts/*/vote', async (route) => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
        if (refusing) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: LONGEST_REFUSAL }) });
        const { optionId } = JSON.parse(route.request().postData() || '{}');
        const at = posts.findIndex(p => p.id === id);
        if (at < 0) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Poll not found' }) });
        // The node's answer, and the Market's list read again after it: the poll voted, and the others voted on their page.
        posts[at] = votedOn(posts[at], optionId);
        for (const [p, o] of kase.vote.elsewhere) { const i = posts.findIndex(x => x.id === p.id); if (i >= 0) posts[i] = votedOn(p, o); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, post: posts[at] }) });
    });
    if (castOn) {
        const [p, optionId] = castOn;
        await shoot(p.id, 'voted-before');
        const row = answerRow(p.id, optionId);
        const want = await row.getAttribute('aria-label');
        await row.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction((id) => document.querySelector(`[data-poll="${id}"] [data-testid="poll-grid-chosen"]`), p.id, { timeout: 10_000 }).catch(() => {});
        await settle(page);
        const after = await page.evaluate(pollStates);
        for (const b of before) {
            const a = after.find(x => x.id === b.id);
            if (!a) { misses.push(`poll ${b.id} is gone after the vote`); continue; }
            if (a.votable !== b.votable) misses.push(`poll ${b.id} ${b.votable ? 'was voted in place' : `opened (${b.block})`} before the vote and ${a.votable ? 'is voted in place' : `opens (${a.block}${a.cut.length ? `: ${a.cut.join(', ')}` : ''})`} after it`);
            if (a.action !== b.action) misses.push(`poll ${b.id}'s footer says "${a.action}" after the vote ("${b.action}" before)`);
        }
        if (!(await page.locator(`[data-poll="${p.id}"] [data-testid="poll-grid-chosen"]`).count())) misses.push(`the vote on ${p.id} drew no ✓`);
        const f = await page.evaluate(focusAt);
        const answer = p.pollOptions.find(o => o.id === optionId).text;
        if (f.poll !== p.id || !(f.label ?? '').startsWith(`Vote: ${answer},`)) misses.push(`the keyboard is on ${f.tag} "${f.label}" after the vote (expected the row "${want}")`);
        await shoot(p.id, 'voted-after');
        console.log(`    voted "${answer}" in ${p.id}: ${after.map(a => `${a.id} ${a.votable ? 'in place' : `opens (${a.block})`}`).join(', ')}; keyboard on "${f.label}"`);
    } else {
        misses.push('no borderline poll is voted in place here, so no vote was cast');
    }
    // A refused vote, on a poll voted in place at every width.
    const [rp, rOption] = kase.vote.refuse;
    refusing = true;
    const rRow = answerRow(rp.id, rOption);
    await rRow.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-poll="${rp.id}"] [data-testid="poll-grid-error"]`, { timeout: 10_000 }).catch(() => {});
    await settle(page);
    const r = await page.evaluate(refusedState, rp.id);
    for (const x of r.misses) misses.push(`refused in ${rp.id}: ${x}`);
    const f = await page.evaluate(focusAt);
    if (f.poll !== rp.id || !(f.label ?? '').startsWith('Vote: ')) misses.push(`the keyboard is on ${f.tag} "${f.label}" after the refusal (expected the row it pressed)`);
    console.log(`    refused in ${rp.id}: ${r.lines} line(s), gave way: ${r.gaveWay?.join(', ') || 'nothing'}; keyboard on "${f.label}"`);
    await shoot(rp.id, 'refused');
    return misses;
}

const problems = [];
const { origin, close } = await startServer();
const browser = await launch();
try {
    for (const kase of CASES) {
        if (only && !only.split(',').includes(kase.name)) continue;
        for (const spec of WIDTHS) {
            if (kase.minColumns && spec.columns < kase.minColumns) continue;
            if (kase.widths && !kase.widths.includes(spec.name)) continue;
            const feed = kase.posts ?? postsWithPollAt(spec.columns - 1);
            for (const lang of kase.langs ?? [null]) for (const dark of [false, true]) {
                const name = `${kase.name}-${spec.name}${lang ? `-${lang}` : ''}-${dark ? 'dark' : 'light'}`;
                const posts = [...feed];
                const { context, page, unrouted } = await openMarket(browser, origin, {
                    width: spec.width, height: 1200, dark, textScale: spec.textScale ?? 1, posts, timezoneId: READER_TZ, lang,
                });
                if (spec.shim) await page.addStyleTag({ content: '#root { padding-left: 256px; }' });
                if (miss && typeof MISSES[miss] === 'string') await page.addStyleTag({ content: MISSES[miss] });
                if (miss && typeof MISSES[miss] === 'function') await page.evaluate(MISSES[miss]);
                if (spec.shim || miss) await settle(page);
                const file = path.join(out, `${name}.png`);
                const first = page.locator('div.grid.grid-flow-row-dense').first();
                await first.locator('..').screenshot({ path: file, animations: 'disabled' });
                const unexpected = [...new Set(unrouted)].filter(p => !ANSWERED_404.has(p));
                if (unexpected.length) problems.push(`${name}: unanswered API paths ${unexpected.join(', ')}`);
                const m = await page.evaluate(measure);
                const misses = check(m, spec, kase.pins, kase.events, kase.votable ? kase.votable(spec) : null);
                if (kase.needs && !m.grids.some(g => g.cells.some(c => c.kind === kase.needs))) misses.push(`no ${kase.needs} tile drawn`);
                const polls = m.grids.flatMap(g => g.cells.filter(c => c.kind === 'poll')).length;
                if (kase.polls && polls !== kase.polls) misses.push(`${polls} poll tile(s) drawn (expected ${kase.polls})`);
                // Each poll's own row, whole, for review: the cell and the row partner beside it (the grid's picture is
                // framed from its parent, and a tall grid's first rows can fall outside it).
                if (kase.polls) {
                    const cells = page.locator('div.grid.grid-flow-row-dense > *:has([data-testid="poll-grid-tile"], [data-testid="poll-card"])');
                    for (let i = 0; i < await cells.count(); i++) {
                        const box = await cells.nth(i).boundingBox();
                        const gridBox = await cells.nth(i).locator('..').boundingBox();
                        if (!box || !gridBox) continue;
                        await page.screenshot({
                            path: path.join(out, `${name}-poll-${i + 1}.png`), animations: 'disabled', fullPage: true,
                            clip: { x: gridBox.x, y: box.y + (await page.evaluate(() => window.scrollY)) - 8, width: gridBox.width, height: box.height + 16 },
                        });
                    }
                }
                if (kase.vote) misses.push(...await voteSteps(page, kase, posts, name));
                console.log(`${misses.length ? '✗' : '✓'} ${name} (root ${m.root}px, block ${(BLOCK_REM * m.root).toFixed(1)}px)  ${file}`);
                if (!dark) report(m);
                for (const x of misses) {
                    console.log(`    ✗ ${x}`);
                    problems.push(`${name}: ${x}`);
                }
                await context.close();
            }
        }
    }
} finally {
    await browser.close();
    await close();
}

if (problems.length) {
    console.error(`\n${problems.length} miss(es)${miss ? ` (with --miss=${miss})` : ''}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}
console.log('\nMarket grid: every width, case and scheme checked; the lattice holds.');
