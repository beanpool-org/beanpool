// @ts-check
/**
 * What the operator manual's pictures show: a layer over fixtures.mjs, used only by manual-shots.mjs.
 *
 * fixtures.mjs is the stress set for phone-width.mjs: it is dense and ugly on purpose (a 1,234,567-Bean community of 1,234
 * debtors, a failing backup with a store's long sentence, alerts, a 100%-of-limit gateway, an address service that is down,
 * names that run to 50 characters). A picture in the manual should show the same server on an ordinary day, as an owner
 * meets it: healthy, audited, backed up, a community of eight with believable sums, and a plain public address.
 *
 * Nothing here edits fixtures.mjs, so the phone-width stress cases stay as they were. Two parts:
 *   - MANUAL_OVERRIDES: for the few answers that must change shape (`openSettings` `overrides`: path -> edit of the reply).
 *   - NAME_SWAPS / manualBody: the stress set's names, swapped in every reply for plain invented ones.
 * Everything is invented: no real member, node or place. The address is a made-up .beanpool.org name.
 */

import { mockResponse } from './fixtures.mjs';

/** The fixture members, as their page (/admin/data/members) answers them. */
function manualMembers() {
    return mockResponse('POST', '/api/local/admin/data/members', new URLSearchParams(), '{}').json.members;
}

export const MANUAL_HOST = 'riverbend.beanpool.org';
/** The address Settings believes it is served from (`openSettings` `publicOrigin`): no 127.0.0.1, no random port. */
export const MANUAL_ORIGIN = `https://${MANUAL_HOST}`;

const COMMUNITY = 'Riverbend Community Exchange';
const VERSION = '1.2.36';

/** [stress-set text, plain text]: applied to the text of every reply, longest first. */
export const NAME_SWAPS = [
    ['Riverbend & District Community Exchange Cooperative', COMMUNITY],
    ['Mullumbimby Community Exchange', COMMUNITY],
    ['mullumbimby-community-exchange.beanpool.example', MANUAL_HOST],
    ['riverbend-community-exchange.example.org', MANUAL_HOST],
    ['byron.beanpool.org', MANUAL_HOST],
    ['mullum.beanpool.org', 'riverbend-old.beanpool.org'],
    ['byron.example.org', 'riverbend-exchange.example.org'],
    ['Bartholomew_Featherstonehaugh1', 'margaret_riverbend_founder'],
    ['Ada_Lovelace_With_A_Long_Name', 'maria_santos'],
];

/** The text of a reply with NAME_SWAPS applied (`openSettings` `rewriteBody`). */
export function manualBody(text) {
    let out = text;
    for (const [from, to] of NAME_SWAPS) out = out.split(from).join(to);
    return out;
}

const DAY = 24 * 60 * 60 * 1000;

/** When each member of fixtures.mjs joined, in the order of its MEMBERS (eight, over about a year). */
const JOINED = ['2025-11-02', '2025-11-09', '2026-01-20', '2026-03-14', '2026-04-02', '2026-05-18', '2026-08-23', '2026-09-05'];
/** How long ago each last opened the app. */
const LAST_SEEN_MS = [3 * 60 * 60 * 1000, 20 * 60 * 60 * 1000, 2.5 * DAY, 9 * DAY, 26 * 60 * 60 * 1000, 4.5 * DAY, 3.5 * DAY, 40 * 60 * 60 * 1000];

/**
 * Edits of the fixture's replies, keyed by API path. Each takes the reply the fixture gave and returns the one to send.
 * @type {Record<string, (json: any) => any>}
 */
export const MANUAL_OVERRIDES = {
    // Healthy: no standby or backup warning, no server alerts, three live connections (the gateway card's request graph is
    // made from this count: six put its peak at 100% of the limit and fill the top of Gateway & Peers with a warning).
    '/api/local/admin/diagnostics': (d) => ({
        ...d,
        version: VERSION,
        activeWsConnections: 3,
        p2pActivePeers: 2,
        offboxBackups: { problems: [] },
        serverAlerts: { count: 0, items: [] },
    }),
    '/api/admin/check-update': (d) => ({ ...d, currentVersion: VERSION }),

    // The off-server backups arriving: two destinations, both fine, the last one made last night. (The third in the stress
    // set is a .env destination with its settings missing.)
    '/api/local/admin/offbox-backups/status': (s) => ({
        ...s,
        destinations: s.destinations.slice(0, 2).map((dest) => ({
            ...dest, health: 'ok', failures: 0, lastError: null, lastPruneError: null,
            lastSuccessAt: dest.lastAttemptAt, lastPruneAt: dest.lastPruneAt ?? dest.lastAttemptAt,
        })),
        message: 'Locked backups go off the box every 24 hours to 2 destinations, each kept 30 days. Backups are locked to recovery code #2 and 1 owner.',
    }),

    // One owner, as Owners & admins shows (the stress set locks the keys to two, one of them a second owner that screen does not
    // list): the take-over lock's owners and the words that count them, worded as services/takeover-envelope.ts does for one.
    '/api/local/admin/takeover/status': (s) => ({
        ...s,
        message: "This server's take-over keys are locked to 1 owner and recovery code #2; any one of them can open them.",
        recipients: { ...s.recipients, owners: s.recipients.owners.slice(0, 1) },
    }),
    '/api/local/admin/backup-status': (s) => ({
        ...s,
        backupLock: { ...s.backupLock, message: 'Backups are locked to recovery code #2 and 1 owner.' },
    }),

    // The lights-out card at the top of Addresses: off, as on every server until its owners turn it on. (The stress set has no
    // answer for it, and Addresses then prints "HTTP 200" above the card.)
    '/api/local/admin/lights-out': () => ({
        lightsOut: { on: false, since: null, address: null, recordAsOf: null, home: null, epoch: 0, hallWrites: false, standDown: null, standby: false },
    }),

    // The members (their page, /admin/data/members): when each joined and when each was last seen (the detail card says
    // "N/A" and "Unknown" without them).
    '/api/local/admin/data/members': (d) => ({
        ...d,
        members: d.members.map((m, i) => ({
            ...m,
            joinedAt: `${JOINED[i % JOINED.length]}T09:00:00.000Z`,
            lastActiveAt: new Date(Date.now() - LAST_SEEN_MS[i % LAST_SEEN_MS.length]).toISOString(),
        })),
    }),
    // The author of each reported post, which the node sends with it (Triage says "Target: Unknown" without it). The summary
    // carries no member, so the key is the fixture members' own.
    '/api/local/admin/data': (d) => {
        const keyOf = new Map(manualMembers().map((m) => [m.callsign, m.publicKey]));
        return {
            ...d,
            reports: d.reports.map((r) => (r.postId && !r.postAuthorPubkey && keyOf.has(r.postAuthorCallsign)
                ? { ...r, postAuthorPubkey: keyOf.get(r.postAuthorCallsign) }
                : r)),
        };
    },

    // Invites & QR, Community health: the sums of a community of eight, not of a million.
    '/api/local/admin/community-health': (h) => ({
        ...h,
        totals: {
            ...h.totals,
            beansInCirculation: 3120, sumOfCredit: 3120, sumOfDebt: 280, membersInDebit: 2, commonsPot: 240, tradesThisMonth: 31,
            newMembers: {
                beans: true, anyTrades: true, minGroup: 5,
                last90Days: { joined: 8, firstListing: 6, firstTrade: 5, daysToFirstListing: 3, daysFromListingToTrade: 4 },
                allTime: { joined: 8, firstListing: 7, firstTrade: 6, daysToFirstListing: 4, daysFromListingToTrade: 6 },
            },
        },
    }),

    // The Onboarding Funnel of a community of eight that takes members by invite: a few joins, no open door. (The stress set
    // has 32 people joining in 30 days, and the open door's every refusal.) Event names as engine/funnel.ts writes them.
    '/api/local/admin/onboarding-funnel': (f) => ({
        ...f,
        openDoor: false,
        rows: [
            { day: '2026-09-14', event: 'invite_attempt', variant: null, count: 3 },
            { day: '2026-09-16', event: 'invite_attempt', variant: null, count: 2 },
            { day: '2026-09-14', event: 'member_created', variant: null, count: 2 },
            { day: '2026-09-16', event: 'member_created', variant: null, count: 1 },
            { day: '2026-09-14', event: 'cohort_photo', variant: null, count: 2 },
            { day: '2026-09-16', event: 'cohort_photo', variant: null, count: 1 },
            { day: '2026-09-16', event: 'cohort_posted', variant: null, count: 2 },
            { day: '2026-09-14', event: 'invite_failed', variant: 'expired', count: 1 },
            { day: '2026-09-16', event: 'invite_reentry', variant: null, count: 1 },
            { day: '2026-09-15', event: 'protection_shown', variant: 'once', count: 3 },
            { day: '2026-09-15', event: 'protection_choice', variant: 'once:words', count: 2 },
            { day: '2026-09-17', event: 'protection_choice', variant: 'once:skip', count: 1 },
            { day: '2026-09-17', event: 'guide_complete', variant: 'once', count: 2 },
        ],
    }),

    // Proposals: "N of 3 votes needed" is what the screen says for N voters; both of the stress set's decisions already have
    // their three (the second shows 5 of 3), so the picture uses three voters for each.
    '/api/local/admin/decisions': (d) => ({
        ...d,
        decisions: d.decisions.map((dec) => {
            const yesWeight = Math.min(dec.tally.yesWeight, 3);
            const noWeight = Math.min(dec.tally.noWeight, 3 - yesWeight);
            return { ...dec, tally: { ...dec.tally, totalVoters: 3, yesWeight, noWeight, supportRatio: Number((yesWeight / ((yesWeight + noWeight) || 1)).toFixed(3)) } };
        }),
    }),

    // The web addresses another site may call from: the community's own, one other. (The stress set adds a 90-character path.)
    '/api/local/admin/gateway': (g) => ({
        ...g,
        corsAllowedOrigins: [`https://${MANUAL_HOST}`, 'https://app.example.org'],
        adminIpAllowlist: [],
    }),

    // Public Address: the name is live and the address service answered (the stress set says it could not, with its one long
    // line), no second name held from the install, and the one notice a new name gets (the stress set has two with the
    // longest words the service can send).
    '/api/local/admin/public-address/status': (s) => ({ ...s, cached: false, nameServiceNote: undefined }),
    '/api/local/admin/public-address/extra-names': () => ({ success: true, names: [] }),
    '/api/local/admin/public-address/notices': () => ({
        success: true,
        notices: [{ id: 7, at: 1_761_900_000, level: 'info', name: 'riverbend', link: null, text: 'Your name is set up. Thank you for running a node.' }],
    }),
};

/**
 * Home with the owner's off-server backup warning, as the node words it (services/offbox-backups.ts), for its own picture.
 * Used as `withManual(BACKUPS_NEED_ATTENTION)`: it edits what MANUAL_OVERRIDES made.
 */
export const BACKUPS_NEED_ATTENTION = {
    '/api/local/admin/diagnostics': (d) => ({
        ...d,
        offboxBackups: {
            problems: [
                'Off-box backup to "Backblaze B2 (Frankfurt)" failed 3 times in a row: bucket "riverbend-sealed-backups" at '
                    + 's3.eu-central-003.backblazeb2.com: PUT beanpool/a1b2c3d4e5f60718/beanpool-backup-2026-11-08T02-00-00.bpsealed '
                    + 'failed after 3 tries: HTTP 503 SlowDown. Last one that arrived: 2026-11-07 02:00 UTC. Next try: 2026-11-09 03:00 UTC.',
            ],
        },
    }),
};

/**
 * `MANUAL_OVERRIDES` with `extra` on top. Where both edit the same path the manual's edit runs first, then the extra one on
 * what it made.
 * @param {Record<string, (json: any) => any>} [extra]
 */
export function withManual(extra = {}) {
    const out = { ...MANUAL_OVERRIDES };
    for (const [path, edit] of Object.entries(extra)) {
        const base = MANUAL_OVERRIDES[path];
        out[path] = base ? (json) => edit(base(json)) : edit;
    }
    return out;
}
