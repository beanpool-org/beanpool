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
import { putPushTokenRow } from './services/push-token-seal.js';
import { checkServerAlerts } from './services/alerts.js';
import { measureKnockAnswers, knockAnswersForDirectory } from './engine/knocks.js';
import { listingFields } from './engine/directory-promise.js';
import { listCommunities, insertDirectoryRowForTesting, clearDirectoryForTesting } from './engine/directory-cache.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { registerVisitor } from './engine/members.js';

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

    // ── 1b. Where an admin lands: People → Invites, which lists the request with Invite and Not now ──
    const NEW_APP = '/api/home?cards=needs&lands=enterprise,group,invite,people';
    const OLD_APP = '/api/home?cards=needs&lands=enterprise,group,invite';
    const needsOf = (r: Res): Array<{ kind: string; count: number; label: string; target: { to: string } }> => r.body?.cards?.needs?.items ?? [];
    const ownerNew = needsOf(await call(owner, 'GET', NEW_APP));
    const knockLine = ownerNew.find(i => i.kind === 'knock');
    assert(knockLine?.target?.to === 'people' && knockLine.count === 1 && knockLine.label === '1 person asked to join',
        `an owner's Home: "1 person asked to join", its own line, landing on People → Invites (${JSON.stringify(ownerNew)})`);
    assert(!ownerNew.some(i => i.kind === 'admin'), "...and not in the admin line, which opens the manager, where nobody can be let in");
    const adminNew = needsOf(await call(admin, 'GET', NEW_APP));
    assert(adminNew.some(i => i.kind === 'knock' && i.target?.to === 'people'), "an admin's Home: the same line");
    const ownerOld = needsOf(await call(owner, 'GET', OLD_APP));
    assert(!ownerOld.some(i => i.kind === 'knock') && ownerOld.some(i => i.kind === 'admin' && /1 person asked to join/.test(i.label)),
        `an app from before the line (no lands=people) gets no target it can't open: the admin line names it, as before (${JSON.stringify(ownerOld)})`);
    assert(!needsOf(await call(memberDefault, 'GET', NEW_APP)).some(i => i.kind === 'knock'),
        "a member's Home has no line for a request only hours old: owners and admins answer first");
    const listedForAdmin = await call(admin, 'GET', '/api/join/knocks');
    assert(listedForAdmin.status === 200 && listedForAdmin.body?.knocks?.length === 1 && listedForAdmin.body.knocks[0].callsign === 'Stranger',
        `the landing's list (GET /api/join/knocks) shows the request to the admin who tapped (${listedForAdmin.status} ${listedForAdmin.body?.total})`);
    // The manager's Home: the count, no names (its Action Required says where they are answered).
    const managerData = async (headers: Record<string, string>) => {
        const res = await fetch(`${BASE}/api/local/admin/data`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    const forOwner = await managerData(ownerSessionHeaders(owner.pk));
    assert(forOwner.status === 200 && forOwner.body?.knockCount === 1, `the manager's data carries the count of open requests (${forOwner.status} ${forOwner.body?.knockCount})`);
    const forNobody = await managerData({});
    assert((forNobody.status === 401 || forNobody.status === 403) && forNobody.body?.knockCount === undefined, `...to the operator only (${forNobody.status})`);

    // ── 1c. A visitor's row is never told: it can't answer (design §5.2, "members who may answer") ──
    const visitor = newId('Visitor');
    registerVisitor(visitor.pk, visitor.name);
    putPushTokenRow(visitor.pk, 'ExponentPushToken[visitor]', 'android');
    const optIn = await call(visitor, 'POST', '/api/members/preferences', { publicKey: visitor.pk, preferences: { notify_knocks: true } });
    assert(optIn.status === 400 && optIn.body?.error === 'Only a member of this community is told when someone asks to join.'
        && db.prepare(`SELECT 1 FROM member_preferences WHERE public_key = ? AND pref_key = 'notify_knocks'`).get(visitor.pk) === undefined,
        `a visitor's row can't turn on requests to join, and nothing is stored (${optIn.status} ${JSON.stringify(optIn.body)})`);
    const optOut = await call(visitor, 'POST', '/api/members/preferences', { publicKey: visitor.pk, preferences: { notify_chat: true, notify_knocks: false } });
    assert(optOut.status === 200, `...turning it off, with its other switches (as the web app saves them), still saves (${optOut.status})`);
    const memberOptsIn = await call(memberDefault, 'POST', '/api/members/preferences', { publicKey: memberDefault.pk, preferences: { notify_knocks: true } });
    assert(memberOptsIn.status === 200, `a member turns it on (${memberOptsIn.status})`);
    await call(memberDefault, 'POST', '/api/members/preferences', { publicKey: memberDefault.pk, preferences: { notify_knocks: false } });
    // A row stored before this rule, and a visitor's row holding admin from before it: neither is in the recipients.
    db.prepare(`INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_knocks', 'true')`).run(visitor.pk);
    const visitorAdmin = newId('VisitorAdmin');
    registerVisitor(visitorAdmin.pk, visitorAdmin.name);
    db.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_at) VALUES (?, 'admin', ?)`).run(visitorAdmin.pk, new Date().toISOString());
    putPushTokenRow(visitorAdmin.pk, 'ExponentPushToken[visitor-admin]', 'android');
    pushedBatches.length = 0;
    const knocker3 = newId('KnockerThree');
    const knock3 = await call(knocker3, 'POST', '/api/join/knock', { callsign: 'KnockerThree', message: 'Hello from three', fromNode: 'https://global.beanpool.org/' });
    await new Promise(r => setTimeout(r, 50));
    const told3 = pushedBatches.map(p => p.to);
    assert(knock3.status === 201 && told3.includes('ExponentPushToken[owner]') && told3.includes('ExponentPushToken[optin]')
        && !told3.includes('ExponentPushToken[visitor]') && !told3.includes('ExponentPushToken[visitor-admin]'),
        `a knock tells the owner and the opted-in member, and neither visitor's row (${told3.join(', ')})`);
    db.prepare(`DELETE FROM join_requests WHERE pubkey = ?`).run(knocker3.pk);

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

    // The guide's 24 hours: no new request from the same key until then, so cancel-and-ask never rings every admin again.
    db.prepare('UPDATE join_requests SET ip_hash = NULL').run(); // this suite's knocks all come from one address
    const KNOCK_BODY = { callsign: 'StrangerTwo', message: 'Asking to join again', fromNode: 'https://global.beanpool.org/' };
    pushedBatches.length = 0;
    const tooSoon = await call(stranger2, 'POST', '/api/join/knock', KNOCK_BODY);
    await new Promise(r => setTimeout(r, 50));
    assert(tooSoon.status === 409 && tooSoon.body?.code === 'knock_cancelled'
        && tooSoon.body?.error === 'You cancelled your request to join less than a day ago. You can ask again 24 hours after you cancelled.',
        `asking again within the day is refused in plain words (${tooSoon.status} ${JSON.stringify(tooSoon.body)})`);
    assert(pushedBatches.length === 0 && getAdminQueue({ forOwner: true }).items.find(i => i.kind === 'knocks') === undefined,
        `...and nobody is told, and nothing is listed (${pushedBatches.length} pushes)`);
    const againCancel = await call(stranger2, 'POST', '/api/join/knock/cancel');
    assert(againCancel.status === 404 && againCancel.body?.code === 'not_found', `nothing open to cancel twice (${againCancel.status})`);
    // A day and a bit later (the cancel moved back 25 hours): asked again, told once.
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.prepare(`UPDATE join_requests SET decided_at = ?, updated_at = ? WHERE pubkey = ? AND status = 'cancelled'`).run(dayAgo, dayAgo, stranger2.pk);
    pushedBatches.length = 0;
    const nextDay = await call(stranger2, 'POST', '/api/join/knock', KNOCK_BODY);
    await new Promise(r => setTimeout(r, 50));
    assert(nextDay.status === 201 && pushedBatches.filter(p => p.to === 'ExponentPushToken[owner]').length === 1,
        `after 24 hours the key may ask again, and the owner is told once (${nextDay.status}, ${pushedBatches.length} pushes)`);
    const cancelAgain = await call(stranger2, 'POST', '/api/join/knock/cancel');
    assert(cancelAgain.status === 200, `...and may cancel that one too (${cancelAgain.status})`);

    // A declined request (the applicant reads it as waiting): Cancel answers the same, and the decline keeps its 30 days.
    const stranger4 = newId('StrangerFour');
    await call(stranger4, 'POST', '/api/join/knock', { ...KNOCK_BODY, callsign: 'StrangerFour' });
    const declinedId = (db.prepare(`SELECT id FROM join_requests WHERE pubkey = ? AND status = 'pending'`).get(stranger4.pk) as { id: string }).id;
    assert((await call(admin, 'POST', `/api/join/knocks/${declinedId}/decline`)).status === 200, 'an admin says Not now');
    const declinedCancel = await call(stranger4, 'POST', '/api/join/knock/cancel');
    assert(declinedCancel.status === 200 && JSON.stringify(declinedCancel.body) === JSON.stringify(cancelAgain.body),
        `cancelling a declined request is answered exactly as cancelling an open one: no word of the decline (${JSON.stringify(declinedCancel.body)})`);
    const declinedRow = db.prepare('SELECT status FROM join_requests WHERE id = ?').get(declinedId) as { status: string };
    pushedBatches.length = 0;
    const declinedAgain = await call(stranger4, 'POST', '/api/join/knock', { ...KNOCK_BODY, callsign: 'StrangerFour' });
    assert(declinedRow.status === 'declined' && declinedAgain.status === 409 && declinedAgain.body?.code === 'knock_open' && pushedBatches.length === 0,
        `...and the decline still holds its block: asking again is "already asked", and nobody is told (${declinedRow.status} ${declinedAgain.status} ${declinedAgain.body?.code})`);
    db.prepare(`DELETE FROM join_requests WHERE pubkey IN (?, ?)`).run(stranger2.pk, stranger4.pk);

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

    // Waiting more than 3 days on a door any member answers: every member's Home has the line, landing where they can.
    const memberLines = needsOf(await call(memberDefault, 'GET', NEW_APP));
    assert(memberLines.some(i => i.kind === 'knock' && i.count === 1 && i.target?.to === 'people'),
        `a member's Home, once a request has waited 3 days: "1 person asked to join", landing on People → Invites (${JSON.stringify(memberLines)})`);
    assert(!needsOf(await call(memberDefault, 'GET', OLD_APP)).some(i => i.target?.to === 'people'),
        "...never to an app that can't open People → Invites from Home");

    // Clean up old knock
    db.prepare(`DELETE FROM join_requests WHERE id = ?`).run(oldKnockId);

    // ── 5. Directory 'answers' line measured from seeded histories (injected time) ──
    db.prepare(`DELETE FROM join_requests`).run();
    assert(measureKnockAnswers(Date.now()) === null, 'measureKnockAnswers returns null with 0 knocks');

    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const t = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const insertHistory = (id: string, createdDaysAgo: number, decidedDaysAgo: number | null, status: 'approved' | 'declined' | 'pending') => {
        db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, decided_at, updated_at, invite_code)
                    VALUES (?, ?, 'K', 'M', ?, ?, ?, ?, ?)`).run(
            id, newId('k').pk, status, t(createdDaysAgo), decidedDaysAgo !== null ? t(decidedDaysAgo) : null, decidedDaysAgo !== null ? t(decidedDaysAgo) : t(createdDaysAgo),
            status === 'approved' ? `INV-${id}` : null,
        );
    };
    const fresh = (n: number) => { for (let i = 0; i < n; i++) insertHistory(`fresh${i}`, 1 / 24, null, 'pending'); };

    // A fresh request has had no chance yet: neither an answer nor a miss (the deciding review's measured cases).
    fresh(3);
    assert(measureKnockAnswers(now) === null, `3 requests an hour old: nothing said, not 'none' (got ${measureKnockAnswers(now)})`);
    insertHistory('p1', 3 / 24, 1 / 24, 'approved');
    insertHistory('p2', 4 / 24, 2 / 24, 'declined');
    insertHistory('p3', 5 / 24, 3 / 24, 'approved');
    assert(measureKnockAnswers(now) === 'week', `3 answered within hours, 3 more an hour old: 'week', not 'slow' (got ${measureKnockAnswers(now)})`);
    // The same requests a week and a day later, still open: now each is a miss.
    assert(measureKnockAnswers(now + 8 * DAY_MS) === 'slow', `...8 days on, the 3 still open count against it: 3 of 6 answered (got ${measureKnockAnswers(now + 8 * DAY_MS)})`);
    assert(measureKnockAnswers(now + 15 * DAY_MS) === 'none', `...15 days on, an open one is older than 14 days: 'none' (got ${measureKnockAnswers(now + 15 * DAY_MS)})`);
    db.prepare(`DELETE FROM join_requests`).run();

    // >= 80% of those judged answered within 7 days, nothing > 14 days old -> 'week'. The one open 3 days isn't judged.
    insertHistory('k1', 20, 18, 'approved'); // took 2 days
    insertHistory('k2', 15, 13, 'approved'); // took 2 days
    insertHistory('k3', 10, 8, 'approved');  // took 2 days
    insertHistory('k4', 8, 6, 'declined');   // took 2 days
    insertHistory('k5', 3, null, 'pending'); // open 3 days: not judged yet
    assert(measureKnockAnswers(now) === 'week', `measureKnockAnswers returns 'week' when 80% answered in <= 7d (got ${measureKnockAnswers(now)})`);

    // >= 50% answered and nothing > 14 days, but < 80% within 7 days -> 'slow': 4 of 6 judged on time.
    insertHistory('k6', 25, 15, 'approved'); // took 10 days
    insertHistory('k7', 22, 12, 'approved'); // took 10 days
    assert(measureKnockAnswers(now) === 'slow', `measureKnockAnswers returns 'slow' when >= 50% answered but < 80% within 7d (got ${measureKnockAnswers(now)})`);

    // Open past the week but not past 14 days: a miss, not yet 'none'.
    insertHistory('k9', 9, null, 'pending');
    assert(measureKnockAnswers(now) === 'slow', `an open one 9 days old is a miss, not 'none' (got ${measureKnockAnswers(now)})`);

    // An open knock older than 14 days -> 'none'.
    insertHistory('k8', 16, null, 'pending'); // open 16 days
    assert(measureKnockAnswers(now) === 'none', `measureKnockAnswers returns 'none' when an open knock is > 14 days old (got ${measureKnockAnswers(now)})`);

    // The directory is told 'none' only after 60 days of it without a break (the operator page's hold); 'slow' meanwhile.
    const NONE_SINCE = (db.prepare(`SELECT value FROM node_config WHERE key = 'knockAnswersNoneSince'`).get() as { value: string } | undefined);
    assert(NONE_SINCE === undefined, 'no hold has started before the push first measures');
    assert(knockAnswersForDirectory(now) === 'slow' && listingFields(now).fields.answers === 'slow',
        `the first 'none': the push says 'slow' ("hasn't answered requests lately", no demotion) (got ${knockAnswersForDirectory(now)})`);
    assert(knockAnswersForDirectory(now + 59 * DAY_MS) === 'slow', `59 days of 'none': still 'slow' (got ${knockAnswersForDirectory(now + 59 * DAY_MS)})`);
    assert(knockAnswersForDirectory(now + 60 * DAY_MS) === 'none', `60 days of 'none': the push says 'none' (got ${knockAnswersForDirectory(now + 60 * DAY_MS)})`);
    // A break (the stale ones answered or gone) ends the hold; the next 'none' starts it again.
    db.prepare(`DELETE FROM join_requests WHERE id IN ('k8', 'k9', 'k5')`).run();
    assert(knockAnswersForDirectory(now + 61 * HOUR_MS) === 'slow'
        && db.prepare(`SELECT 1 FROM node_config WHERE key = 'knockAnswersNoneSince'`).get() === undefined,
        `a measure that isn't 'none' clears the hold (got ${knockAnswersForDirectory(now + 61 * HOUR_MS)})`);
    insertHistory('k10', 20, null, 'pending');
    assert(knockAnswersForDirectory(now + 62 * HOUR_MS) === 'slow', `...and a new 'none' starts it again (got ${knockAnswersForDirectory(now + 62 * HOUR_MS)})`);
    db.prepare(`DELETE FROM node_config WHERE key = 'knockAnswersNoneSince'`).run();

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

    const listRes = listCommunities({ point, limit: 10, offset: 0 });
    const keysInOrder = listRes.communities.map(c => c.key);
    assert(keysInOrder.indexOf('comm_none') > keysInOrder.indexOf('comm_week'), 'community with answers: none sorts after comm_week');
    assert(keysInOrder.indexOf('comm_none') > keysInOrder.indexOf('comm_slow'), 'community with answers: none sorts after comm_slow');

    console.log(`\ntest-knock-notices: ${passed}/${run} checks passed.`);
    process.exit(passed === run ? 0 : 1);
}

void main();
