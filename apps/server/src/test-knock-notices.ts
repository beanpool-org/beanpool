/**
 * Front doors S1: knock notices and answers (design §5, §7).
 *
 * Checks:
 *   1. Knock notice push: a knock creates an admin-queue 'knocks' item (count 1),
 *      and sends one push (community.knock) to each owner and admin.
 *      The push title is "BeanPool", body is "Someone asked to join your community."
 *      and payload contains no name, id, or public key of the knocker.
 *   2. Preference check: a normal member with default preferences gets no push.
 *      A normal member who opted in (notify_knocks = true) on a members door gets a push.
 *   3. Decline sends no notice: declineKnock produces no push to anyone,
 *      and the admin queue count clears.
 *   4. Cancel my request: the knocker cancels with POST /api/join/knock/cancel;
 *      the request is marked cancelled, queue count clears, and status reads none.
 *   5. 7-day owner alert: an open knock waiting 7 days raises the 'knock.waiting' alert
 *      and pushes an owner.alert to owners.
 *   6. Directory 'answers' line:
 *      - < 3 knocks: null
 *      - >= 80% answered within 7 days and nothing older than 14 days: 'week'
 *      - >= 50% answered and nothing older than 14 days, but < 80% within 7 days: 'slow'
 *      - open knock > 14 days or < 50% answered: 'none'
 *      - directory cache orders 'none' after those that answer within the same distance band.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-knock-notices.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { startP2P } from './p2p.js';
import { getAdminQueue } from './engine/admin-queue.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { putPushTokenRow, pushTokenId } from './services/push-token-seal.js';
import { checkServerAlerts } from './services/alerts.js';
import { measureKnockAnswers } from './engine/knocks.js';
import { listCommunities, insertDirectoryRowForTesting, clearDirectoryForTesting } from './engine/directory-cache.js';

let PORT = 0;
let BASE = '';
const DAY_MS = 24 * 60 * 60 * 1000;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }

async function call(id: Id | null, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signedPath = path.split('?')[0];
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${signedPath}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}

async function main() {
    console.log('Front doors S1: knock notices and answers...\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');

    await initTls();
    initStateEngine();
    await startP2P(0, 0);
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;

    // Intercept Expo pushes
    const pushedBatches: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host.endsWith('.expo.dev') || host === 'expo.dev') {
            const batch = JSON.parse(init?.body ?? '[]');
            pushedBatches.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        return realFetch(input, init);
    };

    // 1. Setup roles and members
    const owner = newId('Owner');
    seedGenesisMember(owner.pk, owner.name);

    const admin = newId('Admin');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, ?, ?)`).run(admin.pk, admin.name, new Date().toISOString(), owner.pk, 'genesis');
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_at) VALUES (?, 'admin', ?)`).run(admin.pk, new Date().toISOString());

    const memberDefault = newId('MemberDefault');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, ?, ?)`).run(memberDefault.pk, memberDefault.name, new Date().toISOString(), owner.pk, 'genesis');

    const memberOptIn = newId('MemberOptIn');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, ?, ?)`).run(memberOptIn.pk, memberOptIn.name, new Date().toISOString(), owner.pk, 'genesis');
    db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_knocks', 'true')`).run(memberOptIn.pk);

    // Register push tokens for each
    putPushTokenRow(owner.pk, 'ExponentPushToken[owner]', 'android');
    putPushTokenRow(admin.pk, 'ExponentPushToken[admin]', 'android');
    putPushTokenRow(memberDefault.pk, 'ExponentPushToken[default]', 'android');
    putPushTokenRow(memberOptIn.pk, 'ExponentPushToken[optin]', 'android');

    // ── 1. A stranger knocks ──
    const stranger = newId('Stranger');
    pushedBatches.length = 0;

    const knockRes = await call(stranger, 'POST', '/api/join/knock', {
        callsign: 'Stranger',
        message: 'Hello, please let me join!',
        fromNode: 'https://global.beanpool.org/',
    });
    assert(knockRes.status === 201, `knock submitted -> 201 (got ${knockRes.status})`);
    await new Promise(r => setTimeout(r, 50));

    // Admin queue check
    const qOwner = getAdminQueue({ forOwner: true });
    const knockQueueItem = qOwner.items.find(i => i.kind === 'knocks');
    assert(knockQueueItem !== undefined && knockQueueItem.count === 1, 'admin queue contains knocks kind with count 1');

    // Push check
    const pushedTokens = pushedBatches.map(p => p.to);
    assert(pushedTokens.includes('ExponentPushToken[owner]'), 'owner received push for knock');
    assert(pushedTokens.includes('ExponentPushToken[admin]'), 'admin received push for knock');
    assert(!pushedTokens.includes('ExponentPushToken[default]'), 'member with default preferences did not receive push');
    assert(pushedTokens.includes('ExponentPushToken[optin]'), 'opted-in member received push');

    // Privacy check on push payload: no name, id, or knocker key
    const ownerPush = pushedBatches.find(p => p.to === 'ExponentPushToken[owner]');
    assert(ownerPush?.title === 'BeanPool', 'push title is BeanPool');
    assert(ownerPush?.body === 'Someone asked to join your community.', 'push body is generic sentence');
    const pushDataStr = JSON.stringify(ownerPush?.data ?? {});
    assert(!pushDataStr.includes(stranger.name), 'push data has no knocker name');
    assert(!pushDataStr.includes(stranger.pk), 'push data has no knocker public key');

    // ── 2. Decline sends no notice ──
    const openKnocks = db.prepare(`SELECT id FROM join_requests WHERE pubkey = ? AND status = 'pending'`).all(stranger.pk) as { id: string }[];
    assert(openKnocks.length === 1, 'one open knock in database');
    const knockId = openKnocks[0].id;

    pushedBatches.length = 0;
    const declineRes = await call(admin, 'POST', `/api/join/knocks/${knockId}/decline`);
    assert(declineRes.status === 200, `decline -> 200 (got ${declineRes.status})`);
    assert(pushedBatches.length === 0, 'decline produced NO pushes (silent)');

    const qAfterDecline = getAdminQueue({ forOwner: true });
    assert(qAfterDecline.items.find(i => i.kind === 'knocks') === undefined, 'knocks removed from admin queue after decline');

    // ── 3. Cancel my request ──
    const stranger2 = newId('StrangerTwo');
    await call(stranger2, 'POST', '/api/join/knock', {
        callsign: 'StrangerTwo',
        message: 'Asking to join again',
        fromNode: 'https://global.beanpool.org/',
    });
    assert(getAdminQueue({ forOwner: true }).items.find(i => i.kind === 'knocks')?.count === 1, 'queue has 1 knock for stranger2');

    const cancelRes = await call(stranger2, 'POST', '/api/join/knock/cancel');
    assert(cancelRes.status === 200, `cancel my request -> 200 (got ${cancelRes.status})`);
    assert(cancelRes.body?.knock?.status === 'cancelled', 'cancelled status returned');

    const statusRes = await call(stranger2, 'GET', '/api/join/knock/status');
    assert(statusRes.body?.status === 'none', 'status after cancel is none');
    assert(getAdminQueue({ forOwner: true }).items.find(i => i.kind === 'knocks') === undefined, 'queue has 0 knocks after cancel');

    // ── 4. 7-day owner alert ──
    pushedBatches.length = 0;
    const oldKnockId = crypto.randomUUID();
    const sevenDaysAgo = new Date(Date.now() - 7.5 * DAY_MS).toISOString();
    db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, updated_at)
                VALUES (?, ?, 'OldKnocker', 'Waiting 7 days', 'pending', ?, ?)`).run(oldKnockId, newId('Old').pk, sevenDaysAgo, sevenDaysAgo);

    const alertEvents = await checkServerAlerts();
    await new Promise(r => setTimeout(r, 50));
    const knockAlert = alertEvents.find(e => e.key === 'knock.waiting');
    assert(knockAlert !== undefined, 'knock.waiting alert raised when request waited 7 days');
    assert(knockAlert?.detail === 'A request to join has waited 7 days.', `alert detail is expected sentence (got "${knockAlert?.detail}")`);

    const ownerAlertPush = pushedBatches.find(p => p.to === 'ExponentPushToken[owner]');
    assert(ownerAlertPush !== undefined, 'owner received push for 7-day alert');

    // Clean up old knock
    db.prepare(`DELETE FROM join_requests WHERE id = ?`).run(oldKnockId);

    // ── 5. Directory 'answers' line measured from seeded histories ──
    // Clear join_requests for clean test
    db.prepare(`DELETE FROM join_requests`).run();

    // Case A: < 3 knocks -> null
    assert(measureKnockAnswers(Date.now()) === null, 'measureKnockAnswers returns null with 0 knocks');

    const now = Date.now();
    const t = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();

    // Helper to insert knock history
    const insertHistory = (id: string, createdDaysAgo: number, decidedDaysAgo: number | null, status: 'approved' | 'declined' | 'pending') => {
        db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, decided_at, updated_at, invite_code)
                    VALUES (?, ?, 'K', 'M', ?, ?, ?, ?, ?)`).run(
            id, newId('k').pk, status, t(createdDaysAgo), decidedDaysAgo !== null ? t(decidedDaysAgo) : null, decidedDaysAgo !== null ? t(decidedDaysAgo) : t(createdDaysAgo),
            status === 'approved' ? `INV-${id}` : null,
        );
    };

    // Case B: >= 80% answered within 7 days, nothing > 14 days old -> 'week'
    // 5 knocks: 4 answered in 2 days, 1 pending 3 days old (answered within 7 days: 4/5 = 80%, oldest open: 3 days)
    insertHistory('k1', 20, 18, 'approved'); // took 2 days
    insertHistory('k2', 15, 13, 'approved'); // took 2 days
    insertHistory('k3', 10, 8, 'approved');  // took 2 days
    insertHistory('k4', 8, 6, 'declined');   // took 2 days
    insertHistory('k5', 3, null, 'pending'); // open 3 days
    assert(measureKnockAnswers(now) === 'week', `measureKnockAnswers returns 'week' when 80% answered in <= 7d (got ${measureKnockAnswers(now)})`);

    // Case C: >= 50% answered and nothing > 14 days, but < 80% answered within 7 days -> 'slow'
    // Add 2 more that took 10 days to answer: 4/7 answered in <= 7d (57%), all answered in <= 14d
    insertHistory('k6', 25, 15, 'approved'); // took 10 days
    insertHistory('k7', 22, 12, 'approved'); // took 10 days
    assert(measureKnockAnswers(now) === 'slow', `measureKnockAnswers returns 'slow' when >= 50% answered but < 80% within 7d (got ${measureKnockAnswers(now)})`);

    // Case D: open knock older than 14 days -> 'none'
    insertHistory('k8', 16, null, 'pending'); // open 16 days
    assert(measureKnockAnswers(now) === 'none', `measureKnockAnswers returns 'none' when an open knock is > 14 days old (got ${measureKnockAnswers(now)})`);

    // ── 6. Directory cache ordering ──
    clearDirectoryForTesting();
    const point = { lat: -28.5, lng: 153.5 };
    insertDirectoryRowForTesting({
        key: 'comm_slow',
        name: 'Slow Community',
        url: 'https://slow.example.org',
        lat: -28.51,
        lng: 153.51,
        radiusKm: 10,
        memberCount: 20,
        contactEmail: null,
        contactPhone: null,
        registryUpdatedAt: new Date().toISOString(),
        promise: { v: 1, owners: 2, backups: true, reports: true, notice: true },
        acceptingKnocks: true,
        answers: 'slow',
        closingOn: null,
    });
    insertDirectoryRowForTesting({
        key: 'comm_none',
        name: 'None Community',
        url: 'https://none.example.org',
        lat: -28.51,
        lng: 153.51,
        radiusKm: 10,
        memberCount: 20,
        contactEmail: null,
        contactPhone: null,
        registryUpdatedAt: new Date().toISOString(),
        promise: { v: 1, owners: 2, backups: true, reports: true, notice: true },
        acceptingKnocks: true,
        answers: 'none',
        closingOn: null,
    });
    insertDirectoryRowForTesting({
        key: 'comm_week',
        name: 'Week Community',
        url: 'https://week.example.org',
        lat: -28.51,
        lng: 153.51,
        radiusKm: 10,
        memberCount: 20,
        contactEmail: null,
        contactPhone: null,
        registryUpdatedAt: new Date().toISOString(),
        promise: { v: 1, owners: 2, backups: true, reports: true, notice: true },
        acceptingKnocks: true,
        answers: 'week',
        closingOn: null,
    });

    const listRes = listCommunities({ point });
    const keysInOrder = listRes.communities.map(c => c.key);
    assert(keysInOrder.indexOf('comm_none') > keysInOrder.indexOf('comm_week'), 'community with answers: none sorts after comm_week');
    assert(keysInOrder.indexOf('comm_none') > keysInOrder.indexOf('comm_slow'), 'community with answers: none sorts after comm_slow');

    console.log(`\ntest-knock-notices: ${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

void main();
