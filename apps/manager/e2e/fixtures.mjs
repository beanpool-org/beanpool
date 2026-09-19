// @ts-check
/**
 * Mock response fixtures for the Playwright phone-screenshot harness.
 *
 * Every `/api/...` request the manager app (apps/manager, single-node mode) can make while
 * showing Settings screens is covered here. Data is deliberately dense and deliberately ugly
 * for a 320px-wide phone: full 64-hex pubkeys, long unbroken names, long URLs, IPv6 addresses,
 * long log lines, long filenames. Everything is static — no Math.random, no `new Date()` — so a
 * run is reproducible byte-for-byte.
 *
 * Shapes were read directly from the consumers, not guessed:
 *   - apps/manager/src/lib/node-client.ts (typed interfaces + normalizeNodeData)
 *   - apps/manager/src/components/modules/*.tsx (raw `fetch` calls that bypass node-client)
 *   - the matching *.test.tsx files (exact mock payloads already used in this repo's own tests)
 *
 * export function mockResponse(method, pathname, searchParams, bodyText) -> { status, json }
 * export const UNKNOWN = new Set<string>()  -- pathnames this module had no explicit case for
 */

// ---------------------------------------------------------------------------
// Deterministic "random-looking" hex, so 64-char pubkeys are distinct but reproducible.
// Not Math.random: a tiny xorshift32 seeded from a string hash (FNV-1a).
// ---------------------------------------------------------------------------
function seededHex(seed, len = 64) {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    let state = (h >>> 0) || 0xdeadbeef;
    let out = '';
    while (out.length < len) {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17; state >>>= 0;
        state ^= state << 5; state >>>= 0;
        out += state.toString(16).padStart(8, '0');
    }
    return out.slice(0, len);
}

function pubkey(name) {
    return seededHex(`pk:${name}`, 64);
}

/** A 120-char base64url-ish unbroken token, for log lines that must not wrap nicely. */
function longToken(seed, len = 120) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let s = seededHex(seed, 256);
    let out = '';
    for (let i = 0; i < len; i++) {
        out += alphabet[parseInt(s[i % s.length], 16) % alphabet.length];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const COMMUNITY_NAME = 'Riverbend & District Community Exchange Cooperative';
const CALLSIGN = 'riverbend';
const NODE_HOSTNAME = 'riverbend-community-exchange.example.org';
const LONG_FEDERATION_URL = `https://${NODE_HOSTNAME}/api/federation/peer/very/long/path`;

const MEMBER_NAMES = [
    'Bartholomew_Featherstonehaugh1', // one long unbroken callsign, ~30 chars
    'maria_santos',
    'declan_oreilly',
    'stevo_frozen',
    'josephine_wren',
    'amara_koroma',
    'liu_wei_zhang',
    'nguyen_thi_hoa',
];

const MEMBERS = [
    {
        publicKey: pubkey(MEMBER_NAMES[0]),
        name: MEMBER_NAMES[0],
        callsign: MEMBER_NAMES[0],
        tier: 'Elder',
        standing: 'Elder',
        status: 'active',
        nodeRole: 'owner',
        canVouch: true,
        canOperate: true,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 4820,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[1]),
        name: 'Maria Santos',
        // Invited by the owner, so the owner's member detail offers Prune Branch.
        invitedBy: pubkey(MEMBER_NAMES[0]),
        callsign: MEMBER_NAMES[1],
        tier: 'Steward',
        standing: 'Steward',
        status: 'active',
        nodeRole: 'admin',
        canVouch: true,
        canOperate: true,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 1930,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[2]),
        name: 'Declan O’Reilly',
        // Invited by the owner, so the owner's member detail offers Prune Branch.
        invitedBy: pubkey(MEMBER_NAMES[0]),
        callsign: MEMBER_NAMES[2],
        tier: 'Resident',
        standing: 'Resident',
        status: 'active',
        nodeRole: 'moderator',
        canVouch: true,
        canOperate: false,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 640,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[3]),
        name: 'Stevo',
        callsign: MEMBER_NAMES[3],
        tier: 'Newcomer',
        standing: 'Newcomer',
        status: 'suspended',
        nodeRole: null,
        canVouch: false,
        canOperate: false,
        creditFrozen: true,
        isFrozen: true,
        earnedCredit: 15,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[4]),
        name: 'Josephine Wren',
        callsign: MEMBER_NAMES[4],
        tier: 'Elder',
        standing: 'Elder',
        status: 'active',
        nodeRole: null,
        canVouch: true,
        canOperate: false,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 3110,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[5]),
        name: 'Amara Koroma',
        callsign: MEMBER_NAMES[5],
        tier: 'Resident',
        standing: 'Resident',
        status: 'active',
        nodeRole: null,
        canVouch: false,
        canOperate: false,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 280,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[6]),
        name: 'Liu Wei Zhang',
        callsign: MEMBER_NAMES[6],
        tier: 'Newcomer',
        standing: 'Newcomer',
        status: 'active',
        nodeRole: null,
        canVouch: false,
        canOperate: false,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 40,
        avatarUrl: null,
    },
    {
        publicKey: pubkey(MEMBER_NAMES[7]),
        name: 'Nguyen Thi Hoa',
        callsign: MEMBER_NAMES[7],
        tier: 'Resident',
        standing: 'Resident',
        status: 'active',
        nodeRole: null,
        canVouch: true,
        canOperate: false,
        creditFrozen: false,
        isFrozen: false,
        earnedCredit: 505,
        avatarUrl: null,
    },
];

const REPORTS = [
    {
        id: 'report-1001',
        targetPubkey: MEMBERS[3].publicKey,
        target_pubkey: MEMBERS[3].publicKey,
        reporterPubkey: MEMBERS[4].publicKey,
        reporter_pubkey: MEMBERS[4].publicKey,
        reason: 'Repeatedly no-showed on three separate firewood trades after confirming pickup times, cost the seller a full afternoon each time',
        severity: 'alert',
        status: 'pending',
        outcome: 'open',
        postId: 'post-2001',
        postTitle: 'Split Ironbark Firewood, 1 Trailer Load',
        title: 'Split Ironbark Firewood, 1 Trailer Load',
        postAuthorCallsign: MEMBER_NAMES[1],
        postRemoved: false,
    },
    {
        id: 'report-1002',
        targetPubkey: MEMBERS[6].publicKey,
        target_pubkey: MEMBERS[6].publicKey,
        reporterPubkey: MEMBERS[1].publicKey,
        reporter_pubkey: MEMBERS[1].publicKey,
        reason: 'Listed the same secondhand generator in both the free and for-sale categories at once',
        severity: 'warning',
        status: 'pending',
        outcome: 'open',
        postId: 'post-2002',
        postTitle: 'Farm Fresh Pastured Eggs, 5 Dozen Weekly Subscription',
        title: 'Farm Fresh Pastured Eggs, 5 Dozen Weekly Subscription',
        postAuthorCallsign: MEMBER_NAMES[5],
        postRemoved: true,
    },
    {
        id: 'report-1003',
        targetPubkey: null,
        target_pubkey: null,
        reporterPubkey: MEMBERS[2].publicKey,
        reporter_pubkey: MEMBERS[2].publicKey,
        targetPulseItemId: 'pulse-item-4482',
        reason: 'Cross-posted the same "urgent free firewood, gate code 4482, ask for Dave" listing to the Pulse feed every day for a week',
        severity: 'Report',
        status: 'pending',
        outcome: 'open',
        postId: null,
        postTitle: null,
        title: null,
        postAuthorCallsign: null,
        postRemoved: null,
        pulseItem: {
            title: 'URGENT free firewood pickup today only, gate code 4482, ask for Dave out back',
            platform: 'facebook',
            url: 'https://www.facebook.com/groups/riverbendcommunityswap/permalink/9284710002983471/',
            removed: false,
        },
    },
];

/** The same reports as the moderation list reads them (GET /api/local/admin/reports): a post, a Pulse item, a member. */
const LISTED_REPORTS = [
    {
        id: 'report-2001', reason: 'Listed the same secondhand generator in both the free and for-sale categories at once, twice this week',
        createdAt: '2026-09-18T09:12:00.000Z', outcome: 'open', reporterCallsign: MEMBER_NAMES[1], targetCallsign: MEMBER_NAMES[6],
        postId: 'post-2003', postTitle: 'Need a hand moving a fridge up two flights of stairs, Saturday morning, Riverbend-Upper-Esplanade',
        postDescription: 'Saturday morning, will feed you afterwards. Contact via https://www.example.org/a-very-long-unbroken-link-that-should-wrap-inside-its-card',
        postAuthorCallsign: MEMBER_NAMES[6], postRemoved: false, pulseItem: null,
    },
    {
        id: 'report-2002', reason: 'Cross-posted the same "urgent free firewood, gate code 4482, ask for Dave" listing to the Pulse feed every day for a week',
        createdAt: '2026-09-18T10:40:00.000Z', outcome: 'open', reporterCallsign: MEMBER_NAMES[2], targetCallsign: MEMBER_NAMES[4], postId: null,
        pulseItem: { title: 'URGENT free firewood pickup today only, gate code 4482, ask for Dave out back', platform: 'facebook', url: 'https://www.facebook.com/groups/riverbendcommunityswap/permalink/9284710002983471/', removed: false },
    },
    {
        id: 'report-2003', reason: 'Repeatedly no-showed on three separate firewood trades after confirming pickup times',
        createdAt: '2026-09-19T07:05:00.000Z', outcome: 'open', reporterCallsign: MEMBER_NAMES[4], targetCallsign: MEMBER_NAMES[3], postId: null, pulseItem: null,
    },
];

const POSTS = [
    { id: 'post-2001', type: 'offer', title: 'Split Ironbark Firewood, 1 Trailer Load', description: 'Seasoned, ready to burn. Farm gate pickup only.', category: 'firewood', price: 45, authorCallsign: MEMBER_NAMES[1], authorPublicKey: MEMBERS[1].publicKey, createdAt: '2026-09-12T04:10:00.000Z' },
    { id: 'post-2002', type: 'offer', title: 'Farm Fresh Pastured Eggs, 5 Dozen Weekly Subscription', description: 'Free range, weekly drop at the Saturday market stall.', category: 'produce', price: 25, authorCallsign: MEMBER_NAMES[5], authorPublicKey: MEMBERS[5].publicKey, createdAt: '2026-09-14T22:41:00.000Z' },
    { id: 'post-2003', type: 'request', title: 'Need a hand moving a fridge up two flights of stairs', description: 'Saturday morning, will feed you afterwards.', category: 'labour', price: 0, authorCallsign: MEMBER_NAMES[6], authorPublicKey: MEMBERS[6].publicKey, createdAt: '2026-09-15T09:02:00.000Z' },
    { id: 'post-2004', type: 'offer', title: 'Tool Library: Petrol Rotary Hoe Available for Loan', description: 'Book through the Tool Library treasury, 3 day max loan.', category: 'tools', price: 8, authorCallsign: MEMBER_NAMES[0], authorPublicKey: MEMBERS[0].publicKey, createdAt: '2026-09-16T01:30:00.000Z' },
    { id: 'post-2005', type: 'offer', title: 'Handwoven Cane Baskets, Made to Order', description: 'Two week turnaround, three sizes.', category: 'crafts', price: 30, authorCallsign: MEMBER_NAMES[7], authorPublicKey: MEMBERS[7].publicKey, createdAt: '2026-09-17T06:15:00.000Z' },
    { id: 'post-2006', type: 'request', title: 'Looking for someone to mind chickens over the long weekend', description: 'Twice daily, feed and eggs provided as thanks.', category: 'other', price: 10, authorCallsign: MEMBER_NAMES[4], authorPublicKey: MEMBERS[4].publicKey, createdAt: '2026-09-18T11:00:00.000Z' },
];

const ENTERPRISES = [
    {
        publicKey: pubkey('treasury-tool-library'),
        name: 'Riverbend Tool Library & Repair Cooperative',
        avatar: '\u{1F6E0}️',
        balance: 615.5,
        creditLine: 800,
        liveOffers: 4,
        workingCapitalCeiling: 1000,
        purpose: 'Community-owned tool lending and small-engine repair, funded by loan fees and demurrage rebates',
        keepers: [MEMBERS[0].publicKey, MEMBERS[2].publicKey],
        lat: -37.0625,
        lng: 144.2086,
        locationAuthSigner: MEMBERS[0].publicKey,
        locationUpdatedAt: '2026-08-01T00:00:00.000Z',
    },
    {
        publicKey: pubkey('treasury-market-garden'),
        name: 'District Market Garden Collective',
        avatar: '\u{1F33E}',
        balance: 1204,
        creditLine: 1500,
        liveOffers: 9,
        workingCapitalCeiling: 2000,
        purpose: 'Shared plots, bulk seed buying and weekly produce boxes for members',
        keepers: [MEMBERS[1].publicKey, MEMBERS[5].publicKey, MEMBERS[7].publicKey],
        lat: -37.0701,
        lng: 144.2154,
        locationAuthSigner: MEMBERS[1].publicKey,
        locationUpdatedAt: '2026-07-22T00:00:00.000Z',
    },
    {
        publicKey: pubkey('treasury-care-roster'),
        name: 'Mutual Aid Care Roster Trust',
        avatar: '\u{1F91D}',
        balance: 88.25,
        creditLine: 300,
        liveOffers: 1,
        workingCapitalCeiling: null,
        purpose: 'Coordinates unpaid care shifts and reimburses out-of-pocket costs only',
        keepers: [MEMBERS[4].publicKey],
        lat: null,
        lng: null,
        locationAuthSigner: null,
        locationUpdatedAt: null,
    },
];

const HEALTH_FLAGS = [
    { id: 'flag-disk-1', type: 'disk', description: 'Disk usage is above 80% — run Storage Cleanup from Appliance → Diagnostics before the next snapshot.', severity: 'warning' },
];

const DISK_HEALTH = {
    totalBytes: 32212254720,
    freeBytes: 5153960755,
    usedBytes: 27058293965,
    usedPercent: 84,
    warning: true,
    databaseBytes: 812541952,
    mediaBytes: 3921235968,
    logsBytes: 104857600,
    breakdown: {
        database: { dbSizeBytes: 780140544, walSizeBytes: 30408704, shmSizeBytes: 1992704, snapshotsSizeBytes: 2199023616, totalBytes: 3010564568 },
        media: { postPhotosBytes: 3355443200, postPhotosCount: 812, pulseThumbnailsBytes: 565792768, pulseThumbnailsCount: 340, totalBytes: 3921235968 },
        logs: { systemLogsBytes: 78643200, systemLogsCount: 4210, logFilesBytes: 26214400, totalBytes: 104857600 },
    },
};

const SHUTDOWN_STATUS = {
    uncleanShutdown: false,
    ok: true,
    recovered: false,
    checkedAt: '2026-09-19T00:00:00.000Z',
    acknowledged: true,
};

const DIAGNOSTICS = {
    status: 'ok',
    uptimeSeconds: 1382940,
    cpuLoadPercent: 23.4,
    memoryUsageMb: 512,
    totalMemoryMb: 2048,
    dbSizeBytes: DISK_HEALTH.databaseBytes,
    walSizeBytes: 30408704,
    activeWsConnections: 6,
    p2pActivePeers: 2,
    userCount: MEMBERS.length,
    communityName: COMMUNITY_NAME,
    callsign: CALLSIGN,
    shutdownStatus: SHUTDOWN_STATUS,
    diskHealth: DISK_HEALTH,
};

const GATEWAY_CONFIG = {
    corsAllowedOrigins: [
        `https://${NODE_HOSTNAME}`,
        'https://app.example.org',
        LONG_FEDERATION_URL,
    ],
    adminIpAllowlist: [
        '203.0.113.42',
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        '::1',
    ],
    features: {
        marketplace: true,
        messaging: true,
        federation: true,
        invites: true,
        servePwa: true,
    },
    rateLimiting: {
        enabled: true,
        maxRequestsPerMinute: 120,
    },
};

const LOG_LEVELS = ['INFO', 'INFO', 'INFO', 'WARN', 'INFO', 'ERROR', 'INFO', 'WARN', 'INFO', 'INFO', 'ERROR', 'INFO', 'WARN', 'INFO', 'INFO'];
const LOG_MESSAGES = [
    'Node started, listening on 0.0.0.0:8443',
    'P2P mesh: connected to 2 peers, 6 active websocket sessions',
    'Directory push succeeded (12h interval)',
    `Disk usage at 84% — approaching the 80% warning threshold, schedule a cleanup soon`,
    'Snapshot created: snap-2026-09-19T00-00-00Z-riverbend-community-exchange-full.db.gz',
    `Replication pull from primary rejected: token mismatch, auth=token session=${longToken('log-auth-1', 96)}`,
    'Ledger audit completed: drift 0.00, sumBalances=8492.75, baseline=8492.75',
    'Pulse channel fetch slow (4210ms) for feed https://community-radio-riverbend.example.net/rss/local-notices.xml',
    'Admin login succeeded for owner via password',
    'Post moderation: post-2003 flagged by automatic keyword filter, left for manual review',
    `Uncaught exception in federation worker: ECONNRESET reading peer stream token=${longToken('log-err-1', 100)}`,
    'Backup verification passed for live-db (sha256 checksum matched)',
    'CPU load spike to 61% during snapshot compression',
    'Registrar attestation renewed for riverbend-community-exchange.example.org',
    'Onboarding funnel: 3 members completed step 2 (first photo) today',
];
const LOGS = LOG_LEVELS.map((level, i) => ({
    timestamp: `2026-09-19T${String(i).padStart(2, '0')}:00:00.000Z`,
    level,
    message: LOG_MESSAGES[i],
}));

const NODE_ROLES = [
    { member_pubkey: MEMBERS[0].publicKey, role: 'owner', granted_at: '2025-11-02T00:00:00.000Z', granted_by: 'owner:password', callsign: MEMBER_NAMES[0] },
    { member_pubkey: MEMBERS[1].publicKey, role: 'admin', granted_at: '2026-01-15T00:00:00.000Z', granted_by: MEMBERS[0].publicKey, callsign: MEMBER_NAMES[1] },
    { member_pubkey: MEMBERS[2].publicKey, role: 'moderator', granted_at: '2026-03-30T00:00:00.000Z', granted_by: MEMBERS[0].publicKey, callsign: MEMBER_NAMES[2] },
];

const DECISIONS = [
    {
        id: 'dec-keep-1',
        title: 'Keep Stevo’s suspension?',
        description: 'An admin suspended Stevo on 2026-09-17 for repeated no-shows on confirmed trades. Keep the suspension? Reason given: repeated no-shows costing sellers their afternoons',
        effect: 'keep_suspension',
        touches: 'member',
        status: 'open',
        subject: MEMBERS[3].publicKey,
        subjectName: 'Stevo',
        params: { memberName: 'Stevo' },
        opensAt: '2026-09-17T00:00:00.000Z',
        closesAt: '2026-09-24T00:00:00.000Z',
        gracePeriodEndsAt: null,
        tally: { totalVoters: 3, electorate: 8, quorumRequired: 3, quorumMet: true, yesWeight: 2, noWeight: 1, supportRatio: 0.667, thresholdRequired: 0.6 },
    },
    {
        id: 'dec-commons-2',
        title: 'Fund Tool Library rotary hoe replacement from the Commons',
        description: 'The Tool Library requests 180 beans from the Commons pool to replace the petrol rotary hoe damaged in a loan.',
        effect: 'commons_grant',
        touches: 'pool',
        status: 'open',
        subject: ENTERPRISES[0].publicKey,
        subjectName: ENTERPRISES[0].name,
        params: { amount: 180 },
        opensAt: '2026-09-15T00:00:00.000Z',
        closesAt: '2026-09-22T00:00:00.000Z',
        gracePeriodEndsAt: null,
        tally: { totalVoters: 5, electorate: 8, quorumRequired: 3, quorumMet: true, yesWeight: 4, noWeight: 1, supportRatio: 0.8, thresholdRequired: 0.6 },
    },
];

const DISPUTES = [
    {
        id: 'tx_escrow_101',
        postId: 'post-2001',
        buyerPubkey: MEMBERS[4].publicKey,
        sellerPubkey: MEMBERS[1].publicKey,
        buyerCallsign: MEMBER_NAMES[4],
        buyerName: 'Josephine Wren',
        sellerCallsign: MEMBER_NAMES[1],
        sellerName: 'Maria Santos',
        credits: 45,
        status: 'pending',
        createdAt: Date.parse('2026-09-09T00:00:00.000Z'),
        daysStuck: 10,
        post: {
            id: 'post-2001',
            title: 'Split Ironbark Firewood, 1 Trailer Load',
            description: 'Seasoned, ready to burn. Farm gate pickup only.',
            authorPubkey: MEMBERS[1].publicKey,
            authorName: 'Maria Santos',
            authorCallsign: MEMBER_NAMES[1],
            priceCredits: 45,
            unitPrice: 45,
            category: 'firewood',
        },
        chatContext: [
            { id: 'msg-1', senderPubkey: MEMBERS[4].publicKey, recipientPubkey: MEMBERS[1].publicKey, senderCallsign: MEMBER_NAMES[4], content: 'Hi, did you drop the wood at the front gate like we agreed on Tuesday?', createdAt: Date.parse('2026-09-10T00:00:00.000Z') },
            { id: 'msg-2', senderPubkey: MEMBERS[1].publicKey, recipientPubkey: MEMBERS[4].publicKey, senderCallsign: MEMBER_NAMES[1], content: 'Yes, dropped it Tuesday afternoon by the cattle grid, been there since', createdAt: Date.parse('2026-09-11T00:00:00.000Z') },
        ],
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
    },
    {
        id: 'tx_escrow_102',
        postId: 'post-2002',
        buyerPubkey: MEMBERS[6].publicKey,
        sellerPubkey: MEMBERS[5].publicKey,
        buyerCallsign: MEMBER_NAMES[6],
        sellerCallsign: MEMBER_NAMES[5],
        credits: 25,
        status: 'pending',
        createdAt: Date.parse('2026-09-04T00:00:00.000Z'),
        daysStuck: 15,
        post: {
            id: 'post-2002',
            title: 'Farm Fresh Pastured Eggs, 5 Dozen Weekly Subscription',
            description: 'Free range, weekly drop at the Saturday market stall.',
            authorPubkey: MEMBERS[5].publicKey,
            priceCredits: 25,
            unitPrice: 5,
            category: 'produce',
        },
        chatContext: [],
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
    },
];

const ANNOUNCEMENTS_LIST = [
    { id: 'ann-1', title: 'Saturday Market Time Change', body: 'The Saturday swap meet now starts at 8am to beat the heat.', severity: 'info', createdAt: '2026-09-10T00:00:00.000Z' },
    { id: 'ann-2', title: 'Node Maintenance Window', body: 'Brief downtime expected Sunday 2am–3am for a database snapshot verification pass.', severity: 'alert', createdAt: '2026-09-16T00:00:00.000Z' },
];

const PULSE_CHANNELS = [
    { id: 'chan-1', title: 'Riverbend Community Radio Local Notices', feedUrl: 'https://community-radio-riverbend.example.net/rss/local-notices.xml', url: 'https://community-radio-riverbend.example.net/rss/local-notices.xml', platform: 'rss', category: 'learn', description: 'Daily local notices and weather', itemCount: 214, enabled: true },
    { id: 'chan-2', title: 'District Council Public Works Updates', feedUrl: 'https://council.example.gov.au/feeds/public-works.rss', url: 'https://council.example.gov.au/feeds/public-works.rss', platform: 'rss', category: 'civic', description: 'Roadworks and public works notices', itemCount: 88, enabled: true },
    { id: 'chan-3', title: 'Regional Farmers Market Bulletin', feedUrl: 'https://farmersmarket.example.org/bulletin/feed', url: 'https://farmersmarket.example.org/bulletin/feed', platform: 'rss', category: 'market', description: 'Weekly market stallholder list', itemCount: 52, enabled: true },
    { id: 'chan-4', title: 'Volunteer Fire Brigade Alerts', feedUrl: 'https://cfa-riverbend.example.org/alerts.xml', url: 'https://cfa-riverbend.example.org/alerts.xml', platform: 'rss', category: 'safety', description: 'Fire danger ratings and burn-off notices', itemCount: 133, enabled: true },
    { id: 'chan-5', title: 'Community Garden Working Bee Schedule', feedUrl: 'https://districtmarketgarden.example.org/feed/working-bees', url: 'https://districtmarketgarden.example.org/feed/working-bees', platform: 'rss', category: 'learn', description: 'Fortnightly working bee announcements', itemCount: 29, enabled: false },
];

const PUBLIC_ADDRESS_STATUS = {
    success: true,
    status: 'live',
    name: CALLSIGN,
    hostname: NODE_HOSTNAME,
    mode: 'tunnel',
    pubkey: pubkey('node-identity'),
    cached: false,
    communityName: COMMUNITY_NAME,
    contact: `admin@${NODE_HOSTNAME}`,
};

const PUBLIC_ADDRESS_LOGS = [
    { timestamp: '2026-09-19T00:00:00.000Z', step: 'probe', message: 'Checking DNS resolution for ' + NODE_HOSTNAME, type: 'info' },
    { timestamp: '2026-09-19T00:00:05.000Z', step: 'tunnel', message: 'Cloudflare tunnel connector established, 4 edge locations', type: 'success' },
    { timestamp: '2026-09-19T00:00:10.000Z', step: 'attest', message: 'Registrar attestation accepted', type: 'success' },
    { timestamp: '2026-09-19T00:05:00.000Z', step: 'probe', message: 'Latency to nearest edge 42ms, within tolerance', type: 'info' },
    { timestamp: '2026-09-19T00:10:00.000Z', step: 'attest', message: 'Attestation retry scheduled after a transient 503 from the registrar', type: 'warning' },
    { timestamp: '2026-09-19T00:10:30.000Z', step: 'attest', message: 'Attestation retry succeeded', type: 'success' },
];

const CONNECTORS = [
    {
        id: 'conn-1',
        address: '[2001:0db8:85a3:0000:0000:8a2e:0370:7334]:8443',
        trustLevel: 'peer',
        callsign: 'maldon-timebank',
        enabled: true,
        remoteActive: true,
        connected: true,
        mutualTrust: true,
        latencyMs: 84,
        lastVerified: Date.parse('2026-09-18T12:00:00.000Z'),
        remoteTrustLevel: 'peer',
        publicUrl: LONG_FEDERATION_URL,
        name: 'Maldon Timebank Node',
        peerId: pubkey('peer-maldon'),
        url: 'https://maldon-timebank.example.org',
    },
    {
        id: 'conn-2',
        address: '198.51.100.77:8443',
        trustLevel: 'mirror',
        callsign: 'newstead-exchange',
        enabled: true,
        remoteActive: false,
        connected: false,
        mutualTrust: false,
        latencyMs: null,
        lastVerified: Date.parse('2026-09-11T08:30:00.000Z'),
        remoteTrustLevel: 'blocked',
        publicUrl: 'https://newstead-community-exchange.example.org/api/federation/peer',
        name: 'Newstead Community Exchange',
        peerId: pubkey('peer-newstead'),
        url: 'https://newstead-community-exchange.example.org',
    },
];

const REGISTRAR_ALLOCATIONS = [
    {
        name: 'harcourt-orchard-exchange',
        node_pubkey: pubkey('registrar-harcourt'),
        hostname: 'harcourt-orchard-exchange.example.org',
        mode: 'tunnel',
        status: 'pending',
        community_name: 'Harcourt Orchard Exchange Cooperative',
        tunnel_id: 'tun-8891234',
        dns_record_id: 'dns-4471',
        origin: null,
        public_ip: null,
        contact: 'admin@harcourt-orchard-exchange.example.org',
        attest_fails: 0,
        last_attest_at: Date.parse('2026-09-18T00:00:00.000Z'),
        requested_at: Date.parse('2026-09-17T00:00:00.000Z'),
        decided_at: null,
        decided_by: null,
        tier: 'gated',
    },
    {
        name: CALLSIGN,
        node_pubkey: pubkey('node-identity'),
        hostname: NODE_HOSTNAME,
        mode: 'tunnel',
        status: 'live',
        community_name: COMMUNITY_NAME,
        tunnel_id: 'tun-1120044',
        dns_record_id: 'dns-1002',
        origin: null,
        public_ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7335',
        contact: `admin@${NODE_HOSTNAME}`,
        attest_fails: 0,
        last_attest_at: Date.parse('2026-09-19T00:00:00.000Z'),
        requested_at: Date.parse('2026-08-01T00:00:00.000Z'),
        decided_at: Date.parse('2026-08-01T01:00:00.000Z'),
        decided_by: 'registrar-auto',
        tier: 'auto',
    },
    {
        name: 'maldon-timebank',
        node_pubkey: pubkey('peer-maldon'),
        hostname: 'maldon-timebank.example.org',
        mode: 'direct',
        status: 'revoked',
        community_name: 'Maldon Timebank',
        tunnel_id: null,
        dns_record_id: 'dns-0771',
        origin: 'https://maldon-timebank.example.org',
        public_ip: '203.0.113.19',
        contact: 'admin@maldon-timebank.example.org',
        attest_fails: 6,
        last_attest_at: Date.parse('2026-06-01T00:00:00.000Z'),
        requested_at: Date.parse('2026-05-01T00:00:00.000Z'),
        decided_at: Date.parse('2026-06-02T00:00:00.000Z'),
        decided_by: 'owner:password',
        tier: 'blocked',
    },
];

const FUNNEL_ROWS = (() => {
    const events = ['signup_started', 'seed_backed_up', 'avatar_published', 'first_trade'];
    const rows = [];
    for (let d = 0; d < 7; d++) {
        const day = `2026-09-${String(12 + d).padStart(2, '0')}`;
        events.forEach((event, i) => {
            rows.push({ day, event, variant: 'control', count: 12 - d - i * 2 > 0 ? 12 - d - i * 2 : 1 });
        });
    }
    return rows;
})();

const COMMONS_PROJECTS = [
    { id: 'proj-1', title: 'Replace Tool Library rotary hoe', description: 'Petrol rotary hoe damaged during a loan, needs full replacement.', requestedAmount: 180 },
    { id: 'proj-2', title: 'Community Garden irrigation timer upgrade', description: 'Solar-powered drip irrigation controller for the market garden plots.', requestedAmount: 95 },
    { id: 'proj-3', title: 'Printed seed-swap noticeboard signage', description: 'Weatherproof signage for the three seed swap boxes around town.', requestedAmount: 40 },
];

const SNAPSHOTS = [
    { name: 'snap-2026-09-19T00-00-00Z-riverbend-community-exchange-full.db.gz', sizeBytes: 812541952, createdAt: '2026-09-19T00:00:00.000Z' },
    { name: 'snap-2026-09-18T00-00-00Z-riverbend-community-exchange-full.db.gz', sizeBytes: 809238528, createdAt: '2026-09-18T00:00:00.000Z' },
    { name: 'snap-2026-09-17T00-00-00Z-riverbend-community-exchange-full.db.gz', sizeBytes: 805830656, createdAt: '2026-09-17T00:00:00.000Z' },
    { name: 'snap-2026-09-16T00-00-00Z-riverbend-community-exchange-pre-restore.db.gz', sizeBytes: 799512576, createdAt: '2026-09-16T00:00:00.000Z' },
];

const SNAPSHOT_SCHEDULE = { enabled: true, intervalHours: 24, keep: 7 };

const REPLICATION_ACCESS = {
    hasToken: true,
    tokenOnly: false,
    totalPulls: 342,
    lastPullAt: '2026-09-19T00:00:00.000Z',
    lastPullIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7336',
    lastPullAuth: 'token',
    totalRejected: 3,
    lastRejectedAt: '2026-09-15T11:00:00.000Z',
    lastRejectedIp: '198.51.100.201',
    recent: [
        { at: '2026-09-19T00:00:00.000Z', ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7336', auth: 'token' },
        { at: '2026-09-18T00:00:00.000Z', ip: '2001:0db8:85a3:0000:0000:8a2e:0370:7336', auth: 'token' },
        { at: '2026-09-15T11:00:00.000Z', ip: '198.51.100.201', auth: 'rejected', reason: 'bad token' },
    ],
};

const REPLICATION_TOKEN_STATUS = { hasToken: true, tokenOnly: false, createdAt: '2026-08-01T00:00:00.000Z' };

const BACKUP_STATUS = {
    role: 'backup',
    primaryUrl: 'https://primary-riverbend.example.org',
    intervalMs: 30000,
    lastSuccess: '2026-09-19T00:00:00.000Z',
    failStreak: 0,
    isSynced: true,
};

const REPLICATION_CONFIG = { primaryUrl: 'https://primary-riverbend.example.org', hasPassword: true, hasToken: true };

// ---------------------------------------------------------------------------
// UNKNOWN — pathnames the harness asked about that this module has no explicit case for.
// ---------------------------------------------------------------------------
export const UNKNOWN = new Set();

/**
 * @param {string} method
 * @param {string} pathname
 * @param {URLSearchParams} searchParams
 * @param {string} bodyText
 * @returns {{status: number, json: any}}
 */
export function mockResponse(method, pathname, searchParams, bodyText) {
    const ok = (json) => ({ status: 200, json });
    const m = (method || 'GET').toUpperCase();

    // ---- diagnostics & health ----
    if (pathname === '/api/local/admin/diagnostics') return ok(DIAGNOSTICS);
    if (pathname === '/api/local/admin/shutdown-status/acknowledge') return ok({ success: true, shutdownStatus: { ...SHUTDOWN_STATUS, acknowledged: true } });
    if (pathname === '/api/local/admin/storage/disk-health') return ok({ success: true, diskHealth: DISK_HEALTH });
    if (pathname === '/api/local/admin/storage/clean-preview') {
        return ok({
            success: true,
            preview: {
                orphanedPostPhotos: { count: 41, totalBytes: 88342528 },
                orphanedThumbnails: { count: 120, totalBytes: 15728640 },
                compressibleLogs: { count: 4210, totalBytes: 78643200, oldestTimestamp: '2026-06-01T00:00:00.000Z', newestTimestamp: '2026-09-19T00:00:00.000Z' },
                totalReclaimableBytes: 182714368,
            },
        });
    }
    if (pathname === '/api/local/admin/storage/clean') {
        return ok({
            success: true,
            removedPhotosCount: 41,
            removedPhotosBytes: 88342528,
            removedThumbnailsCount: 120,
            removedThumbnailsBytes: 15728640,
            compressedLogsCount: 4210,
            compressedLogsBytes: 60000000,
            totalReclaimedBytes: 164056928,
        });
    }

    // ---- admin/data (members, reports, posts, health, enterprises) ----
    if (pathname === '/api/local/admin/data') {
        return ok({
            health: { healthScore: 78, flags: HEALTH_FLAGS },
            reports: REPORTS,
            members: MEMBERS,
            profiles: [],
            posts: POSTS,
            reportCount: REPORTS.length,
            escrowDisputesCount: DISPUTES.length,
            memberStats: { active: 7, suspended: 1, newcomers: 2, residents: 3, stewards: 1, elders: 2 },
            tradeVolume: 8492.75,
            circulation: 12500,
            commonsBalance: 240,
            enterprises: ENTERPRISES,
        });
    }
    if (pathname === '/api/local/admin/logs') return ok({ logs: LOGS });
    if (pathname === '/api/local/admin/onboarding-funnel') return ok({ days: Number(searchParams.get('days')) || 30, rows: FUNNEL_ROWS });
    if (pathname === '/api/local/admin/ledger-audit') return ok({ success: true, ok: true, drift: 0, sumBalances: 8492.75, baseline: 8492.75, strandedEscrows: 0 });

    // ---- gateway ----
    if (pathname === '/api/local/admin/gateway') return ok(GATEWAY_CONFIG);

    // ---- node roles ----
    if (pathname === '/api/local/admin/node-roles') return ok({ roles: NODE_ROLES });
    if (/^\/api\/local\/admin\/node-roles\/[^/]+\/[^/]+$/.test(pathname)) return ok({ success: true });

    // ---- treasuries / enterprises ----
    if (pathname === '/api/treasuries') return ok({ treasuries: ENTERPRISES });
    if (pathname === '/api/local/admin/treasury') return ok({ success: true, publicKey: pubkey('treasury-new') });
    if (/^\/api\/local\/admin\/treasury\/[^/]+\/operators$/.test(pathname)) {
        const idx = pathname.includes(ENTERPRISES[1].publicKey) ? 1 : 0;
        return ok({ keepers: ENTERPRISES[idx].keepers });
    }
    if (/^\/api\/local\/admin\/treasury\/[^/]+\/operators\/[^/]+$/.test(pathname)) return ok({ keepers: ENTERPRISES[0].keepers });
    if (/^\/api\/local\/admin\/treasury\/[^/]+\/location$/.test(pathname)) return ok({ success: true, lat: -37.0625, lng: 144.2086, locationAuthSigner: MEMBERS[0].publicKey, locationUpdatedAt: '2026-08-01T00:00:00.000Z' });
    if (/^\/api\/local\/admin\/treasury\/[^/]+\/offer$/.test(pathname)) return ok({ success: true, post: { id: 'post-new', title: 'New offer' } });

    // ---- decisions ----
    if (pathname === '/api/local/admin/decisions') return ok({ decisions: DECISIONS });
    if (/^\/api\/local\/admin\/decisions\/[^/]+\/halt$/.test(pathname)) return ok({ success: true });

    // ---- disputes ----
    if (pathname === '/api/local/admin/disputes') {
        const minDays = Number(searchParams.get('minDays')) || 7;
        const status = searchParams.get('status') || 'all';
        const limit = Number(searchParams.get('limit')) || 50;
        const offset = Number(searchParams.get('offset')) || 0;
        const isResolved = (d) => Boolean(d.resolution || d.disputeResolution);
        const filtered = DISPUTES.filter((d) => {
            if (status === 'pending') return d.status === 'pending';
            if (status === 'resolved') return isResolved(d);
            return d.status === 'pending' || isResolved(d);
        });
        const paged = filtered.slice(offset, offset + limit);
        const counts = {
            pending: DISPUTES.filter((d) => d.status === 'pending').length,
            resolved: DISPUTES.filter(isResolved).length,
            all: DISPUTES.filter((d) => d.status === 'pending' || isResolved(d)).length,
        };
        return ok({
            disputes: paged,
            total: filtered.length,
            counts,
            count: paged.length,
            minDays,
            limit,
            offset,
        });
    }
    if (/^\/api\/local\/admin\/disputes\/[^/]+\/resolve$/.test(pathname)) {
        return ok({ success: true, transactionId: 'tx-resolved-1', resolution: 'release_to_seller', authSigner: MEMBERS[0].publicKey, transaction: { ...DISPUTES[0], status: 'completed' } });
    }

    // ---- reports ----
    if (pathname === '/api/local/admin/reports') {
        const status = searchParams.get('status') || 'open';
        const limit = Number(searchParams.get('limit')) || 50;
        const offset = Number(searchParams.get('offset')) || 0;
        const getOutcome = (r) => r.outcome || (r.status === 'reviewed' ? 'dismissed' : r.status === 'actioned' ? 'actioned' : 'open');
        // Both sets: the long-words ones (#978's moderator screen) first, then the ones the node summary carries.
        const all = LISTED_REPORTS.concat(REPORTS);
        const filtered = all.filter((r) => {
            if (status === 'all') return true;
            return getOutcome(r) === status;
        });
        const openCount = all.filter((r) => getOutcome(r) === 'open').length;
        const paged = filtered.slice(offset, offset + limit);
        return ok({
            success: true,
            reports: paged,
            total: filtered.length,
            pendingCount: openCount,
            limit,
            offset,
        });
    }

    // ---- announcements & pulse ----
    if (pathname === '/api/local/admin/announcements') return m === 'GET' ? ok({ announcements: ANNOUNCEMENTS_LIST }) : ok({ success: true });
    if (pathname === '/api/local/admin/pulse/channels') return m === 'GET' ? ok({ channels: PULSE_CHANNELS }) : ok({ success: true });
    if (pathname === '/api/local/admin/pulse/channels/remove') return ok({ success: true });

    // ---- public address ----
    if (pathname === '/api/local/admin/public-address/status') return ok(PUBLIC_ADDRESS_STATUS);
    if (pathname === '/api/local/admin/public-address/logs') return ok({ logs: PUBLIC_ADDRESS_LOGS });
    if (pathname === '/api/local/admin/public-address/claim') return ok({ success: true, status: 'pending' });
    if (pathname === '/api/local/admin/public-address/restart-sidecar') return ok({ success: true });
    if (pathname === '/api/local/admin/public-address/offline') return ok({ success: true });

    // ---- connectors ----
    if (pathname === '/api/local/connectors') return m === 'GET' ? ok({ connectors: CONNECTORS }) : ok({ success: true });
    if (pathname === '/api/local/connectors/connect') return ok({ success: true });
    if (pathname === '/api/local/connectors/disconnect') return ok({ success: true });
    if (pathname === '/api/local/connectors/remove') return ok({ success: true });

    // ---- replication access / token / config ----
    if (pathname === '/api/local/admin/replication-access') return ok(REPLICATION_ACCESS);
    if (pathname === '/api/local/admin/replication-token/status') return ok(REPLICATION_TOKEN_STATUS);
    if (pathname === '/api/local/admin/replication-token/generate') return ok({ success: true, token: `rep_tok_${longToken('rep-token', 32)}` });
    if (pathname === '/api/local/admin/replication-token/mode') return ok({ success: true, tokenOnly: true });
    if (pathname === '/api/local/admin/replication-token/clear') return ok({ success: true });
    if (pathname === '/api/local/admin/replication-config/get') return ok(REPLICATION_CONFIG);
    if (pathname === '/api/local/admin/replication-config/save') return ok({ success: true });
    if (pathname === '/api/local/admin/replication-resync') return ok({ success: true });
    if (pathname === '/api/local/admin/backup-status') return ok(BACKUP_STATUS);
    if (pathname === '/api/local/admin/backup-config') return ok({ success: true });
    if (pathname === '/api/local/admin/backup/verify') return ok({ success: true, ok: true, verifiedAt: '2026-09-19T00:00:00.000Z', result: [] });
    if (pathname === '/api/local/admin/backup') return ok({});
    if (pathname === '/api/local/admin/restore') return ok({ success: true });

    // ---- snapshots ----
    if (pathname === '/api/local/admin/snapshots/list') return ok({ snapshots: SNAPSHOTS });
    if (pathname === '/api/local/admin/snapshots/create') return ok({ snapshot: { name: 'snap-2026-09-19T12-00-00Z-riverbend-community-exchange-full.db.gz', sizeBytes: 813000000, createdAt: '2026-09-19T12:00:00.000Z' } });
    if (pathname === '/api/local/admin/snapshots/delete') return ok({ success: true });
    if (pathname === '/api/local/admin/snapshots/config') return ok({ config: SNAPSHOT_SCHEDULE });
    if (pathname === '/api/local/admin/snapshots/download') return ok({});

    // ---- 2FA ----
    if (pathname === '/api/local/admin/2fa/status') return ok({ totpEnabled: true, enabled: true });
    if (pathname === '/api/local/admin/2fa/setup') return ok({ qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', secret: 'JBSWY3DPEHPK3PXP' });
    if (pathname === '/api/local/admin/2fa/verify') return ok({ success: true, tfaSessionToken: `tfa_${longToken('tfa-session', 32)}` });
    if (pathname === '/api/local/admin/2fa/disable') return ok({ success: true });

    // ---- identity / node config ----
    if (pathname === '/api/local/community-info') {
        return ok({ communityName: COMMUNITY_NAME, contactEmail: `admin@${NODE_HOSTNAME}`, contactPhone: '+61 3 5472 1234', callsign: CALLSIGN });
    }
    if (pathname === '/api/node/config' || pathname === '/api/local/admin/node/config') {
        return ok({
            serviceRadius: { radiusKm: 15, lat: -37.0625, lng: 144.2086 },
            publishLocation: true,
            publishMembers: true,
            publishContacts: true,
            publishHealth: true,
            directoryPushIntervalHours: 12,
            lastDirectoryPush: '2026-09-19T00:00:00.000Z',
        });
    }
    if (pathname === '/api/local/update-identity') return ok({ success: true });
    if (pathname === '/api/local/admin/directory/push') return ok({ success: true, lastDirectoryPush: '2026-09-19T00:00:00.000Z' });
    if (pathname === '/api/directory/info') return ok({ communityName: COMMUNITY_NAME, callsign: CALLSIGN });

    // ---- registrar ----
    if (pathname === '/api/local/admin/registrar/pending') return ok({ allocations: REGISTRAR_ALLOCATIONS });
    if (/^\/api\/local\/admin\/registrar\/[^/]+\/approve$/.test(pathname)) return ok({ status: 'ok', name: 'harcourt-orchard-exchange' });
    if (/^\/api\/local\/admin\/registrar\/[^/]+\/revoke$/.test(pathname)) return ok({ status: 'ok', name: 'harcourt-orchard-exchange' });

    // ---- commons ----
    if (pathname === '/api/local/admin/commons/projects') return ok({ projects: COMMONS_PROJECTS });
    if (pathname === '/api/local/admin/commons/reject') return ok({ success: true });

    // ---- auth / session (this app runs the password-login path, never the key handoff) ----
    if (pathname === '/api/local/admin/auth/session') return ok({ authenticated: false });
    if (pathname === '/api/local/admin/auth/exchange') return ok({ authenticated: false });
    if (pathname === '/api/local/admin/auth/logout') return ok({ success: true });
    // Sign in with your phone: a pairing that just keeps waiting (the page answers each poll at most once a second).
    if (pathname === '/api/local/admin/auth/pairing') return ok({ pairingId: 'ab'.repeat(32), shortCode: 'K7F3QX', expiresAt: Date.now() + 120000, ttlMs: 120000 });
    if (/^\/api\/local\/admin\/auth\/pairing\/[0-9a-f]{64}\/wait$/.test(pathname)) return ok({ status: 'waiting', expiresAt: Date.now() + 120000 });
    if (pathname === '/api/local/admin/csrf-token') return ok({ csrfToken: `csrf_${longToken('csrf', 24)}` });
    if (pathname === '/api/local/verify-password' || pathname === '/api/verify-password') return ok({ success: true });
    if (pathname === '/api/local/change-password') return ok({ success: true });
    if (pathname === '/api/local/reset') return ok({ success: true });
    if (pathname === '/api/admin/login') return ok({ success: true });
    if (pathname === '/api/admin/check-update') return ok({ updateAvailable: false, currentVersion: '1.4.2' });
    if (pathname === '/api/admin/seed-invite') return ok({ success: true, code: 'BEANPOOL-INVITE-4471', type: 'standard' });

    // ---- posts / users / members mutation endpoints (settings screens trigger, don't render lists from these) ----
    if (/^\/api\/local\/admin\/posts\/[^/]+\/delete$/.test(pathname)) return ok({ success: true });
    if (pathname === '/api/local/admin/posts/bulk-delete') return ok({ success: true });
    if (/^\/api\/local\/admin\/reports\/([^/]+)\/(action|dismiss)$/.test(pathname)) {
        const match = pathname.match(/^\/api\/local\/admin\/reports\/([^/]+)\/(action|dismiss)$/);
        const reportId = match?.[1];
        const actionType = match?.[2];
        const r = LISTED_REPORTS.concat(REPORTS).find((x) => String(x.id) === String(reportId));
        if (r) {
            r.status = actionType === 'dismiss' ? 'reviewed' : 'actioned';
            r.outcome = actionType === 'dismiss' ? 'dismissed' : 'actioned';
        }
        return ok({ success: true });
    }
    if (/^\/api\/local\/admin\/branches\/[^/]+\/prune$/.test(pathname)) return ok({ success: true });
    if (/^\/api\/local\/admin\/users\/[^/]+\/freeze$/.test(pathname)) return ok({ success: true, frozen: true });
    if (/^\/api\/local\/admin\/users\/[^/]+\/prune$/.test(pathname)) return ok({ success: true });
    if (/^\/api\/local\/admin\/users\/[^/]+\/tier$/.test(pathname)) return ok({ success: true, tier: 'Resident' });
    if (/^\/api\/local\/admin\/users\/[^/]+\/voucher$/.test(pathname)) return ok({ success: true, granted: true });
    if (/^\/api\/local\/admin\/users\/[^/]+\/operator$/.test(pathname)) return ok({ success: true });
    if (/^\/api\/local\/admin\/users\/[^/]+\/suspend$/.test(pathname)) return ok({ success: true, decision: { id: 'dec-suspend-1', closesAt: '2026-09-26T00:00:00.000Z' } });
    if (/^\/api\/local\/admin\/users\/[^/]+\/status$/.test(pathname)) return ok({ success: true });

    // ---- member wizards (rekey / offboard) ----
    if (/^\/api\/local\/admin\/members\/[^/]+\/rekey\/status$/.test(pathname)) {
        return ok({
            isInvalidated: false,
            invalidatedInfo: null,
            pendingRequest: null,
            history: [
                { id: 1, old_pubkey: pubkey('old-key-1'), new_pubkey: pubkey('new-key-1'), reenrollment_code: 'RK-4471-8892', operator_pubkey: MEMBERS[0].publicKey, performed_at: '2026-05-01T00:00:00.000Z', completed_at: '2026-05-01T00:10:00.000Z', details: 'Lost phone, reissued via 12-word backup' },
            ],
        });
    }
    if (/^\/api\/local\/admin\/members\/[^/]+\/rekey\/issue-code$/.test(pathname)) {
        return ok({ success: true, code: 'RK-9931-2201', oldPubkey: MEMBERS[3].publicKey, callsign: MEMBER_NAMES[3], expiresAt: '2026-09-20T00:00:00.000Z', operator: MEMBERS[0].publicKey });
    }
    if (/^\/api\/local\/admin\/members\/[^/]+\/rekey\/complete$/.test(pathname)) {
        return ok({ success: true, oldPubkey: MEMBERS[3].publicKey, newPubkey: pubkey('rekeyed-stevo'), callsign: MEMBER_NAMES[3] });
    }
    if (/^\/api\/local\/admin\/members\/[^/]+\/offboard\/preview$/.test(pathname)) {
        return ok({
            member: { publicKey: MEMBERS[3].publicKey, callsign: MEMBER_NAMES[3], status: 'suspended', joinedAt: '2025-12-01T00:00:00.000Z' },
            balance: 15,
            commonsBalance: 240,
            costToCommunity: 0,
            projectedCommonsBalance: 255,
            pendingEscrowsCount: 0,
            isSoleOwner: false,
            activeMembers: MEMBERS.filter((mm) => mm.status === 'active').map((mm) => ({ publicKey: mm.publicKey, callsign: mm.callsign })),
        });
    }
    if (/^\/api\/local\/admin\/members\/[^/]+\/offboard$/.test(pathname)) {
        return ok({ success: true, memberPubkey: MEMBERS[3].publicKey, callsign: MEMBER_NAMES[3], resolution: 'donate_to_commons', balanceSettled: 15 });
    }

    // ---- AI services (external providers / local generate endpoint; not populated for the phone pass) ----
    if (pathname === '/api/generate' || pathname === '/api/v1/chat/completions') {
        return ok({ id: 'chatcmpl-mock', choices: [{ message: { role: 'assistant', content: 'Mock AI response for screenshot harness.' } }] });
    }

    // ---- manager (fleet) harvester endpoints — not used in single-node mode, but harmless to answer ----
    if (pathname === '/api/manager/backups/status') return ok({ nodes: [], harvestState: {} });
    if (pathname === '/api/manager/backups/history') return ok({ history: [] });
    if (pathname === '/api/manager/backups/trigger') return ok({ success: true });
    if (pathname.startsWith('/api/manager/backups/download-')) return ok({});

    // ---- avatars (image responses; not JSON, but shouldn't be reported as unknown) ----
    if (pathname.startsWith('/api/avatar')) return ok({});
    if (pathname === '/api/community/health') return ok({ healthy: true, memberCount: MEMBERS.length });

    // ---- fallback ----
    UNKNOWN.add(pathname);
    return ok({});
}
