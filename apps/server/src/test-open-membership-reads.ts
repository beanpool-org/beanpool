/**
 * Test Suite: where anyone can join in a minute, a member read is not a private one (`openMembership`, the global node;
 * DESIGN-global-member-privacy-fable.md §1, §3, §5 and §7 slice 1, from the privacy review of 2026-10-14, S1 and S3).
 *
 * Boots the real server and reads through the real middleware over HTTPS, signed, as members of different standing:
 *   1. A local community (NODE_PROFILE unset): every read answers as before (whole directory, its delta and its
 *      nearest-first list, the per-reader directory, the whole invite tree, the feed's "joined" lines, an open group's
 *      roster to a member outside it), the nearest-people form has no day budget, and `features` has no
 *      `openMembership`. With OPEN_MEMBERSHIP_BODIES_OUT set, the status and body of every read is written there, so a
 *      run on origin/main and one on this branch can be compared byte for byte.
 *   2. The global node: `features.openMembership` is true; the whole forms of GET /api/members (no parameters, a delta
 *      without keys, a point without a limit) and GET /api/community/members answer 403 `members_on_demand`, If-None-Match
 *      or not, with heavyReadStats() unmoved (nothing read, no room asked for under the cap); `keys=`, `q=` and
 *      `lat&lng&limit=` answer 200 as before; the 101st nearest read in a day is 429 (another member's are not), a search
 *      still answers; the whole invite tree and someone else's branch are 403, the signer's own branch 200; the feed has
 *      no `member_joined` line and keeps the posts; an open group's roster is 403 `join_to_see` to a member outside it and
 *      to an invitee, 200 to its members and convenor; the card keeps its count and convenor, and an invitee's card keeps
 *      who invited them, face and all (amendment 1 item 2); an invite-only group is still 404 to an outsider.
 *   3. The operator's override `nodeProfile.openMembership = false` on the global node: every one of those reads answers
 *      as before, the exhausted nearest budget included, and `features` has no `openMembership`.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-open-membership-reads)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

/** A fixed key per name, so two runs (origin/main and this branch) seed the same members and answer the same bytes. */
function keypair(name: string): Id {
    const seed = crypto.createHash('sha256').update(`open-membership-reads:${name}`).digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubKeyHex: pub, privateKey };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any; headers: Headers };
async function get(p: string, id: Id | null, extra: Record<string, string> = {}): Promise<Answer> {
    const res = await localFetch(`${BASE}${p}`, { headers: { ...(id ? signedHeaders('GET', p, '', id) : {}), ...extra } });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body, headers: res.headers };
}

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const STARTED = Date.now() - 60_000;

async function main() {
    console.log('Where anyone can join in a minute, a member read is not a private one...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { heavyReadStats } = await import('./heavy-reads.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    // Absent on origin/main: the suite still runs to the end there, and reports what fails.
    const budget = await import('./nearest-people-budget.js' as string).catch(() => null) as null | { resetNearestPeopleBudget(): void };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    // A few hundred signed reads from one address: the gateway's minute throttle is another suite's.
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    // ── Seed: the same members, groups and feed on every run ──
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury,
                                   area_lat, area_lng, area_updated_at, profile_updated_at)
                               VALUES (@pk, @callsign, 'active', @joined, @invitedBy, 'TEST', 0, @lat, @lng, @areaAt, NULL)`);
    let n = 0;
    const member = (name: string, invitedBy: string, area: { lat: number; lng: number } | null): Id => {
        const id = keypair(name);
        insert.run({ pk: id.pubKeyHex, callsign: name, joined: iso(T0 + 60_000 * n++), invitedBy,
            lat: area?.lat ?? null, lng: area?.lng ?? null, areaAt: area ? iso(T0) : null });
        return id;
    };
    const alice = member('Alice', 'genesis', { lat: -28.6, lng: 153.5 });
    const bob = member('Bob', alice.pubKeyHex, { lat: -28.7, lng: 153.6 });
    const carol = member('Carol', alice.pubKeyHex, { lat: -28.8, lng: 153.6 });
    const dan = member('Dan', bob.pubKeyHex, { lat: -28.6, lng: 153.6 });
    const eve = member('Eve', bob.pubKeyHex, null);
    const feedLine = db.prepare(`INSERT INTO activity_feed (event_type, actor_pubkey, target_pubkey, metadata, created_at) VALUES (?, ?, NULL, ?, ?)`);
    for (const [i, who] of [alice, bob, carol, dan, eve].entries()) {
        feedLine.run('member_joined', who.pubKeyHex, JSON.stringify({ callsign: ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'][i] }), iso(T0 + 60_000 * i));
    }
    feedLine.run('post_created', alice.pubKeyHex, JSON.stringify({ postId: 'p-1', title: 'Spare eggs', type: 'offer' }), iso(T0 + 3_600_000));
    const open = se.createGroup({ name: 'Open Garden', slug: 'open-garden', description: 'Anyone may join', joinPolicy: 'open', createdBy: alice.pubKeyHex });
    se.joinGroup(open.id, bob.pubKeyHex);
    se.inviteGroupMember(open.id, alice.pubKeyHex, eve.pubKeyHex, 'member');
    const quiet = se.createGroup({ name: 'Quiet Circle', slug: 'quiet-circle', description: 'Invite only', joinPolicy: 'invite_only', createdBy: alice.pubKeyHex });
    se.inviteGroupMember(quiet.id, alice.pubKeyHex, carol.pubKeyHex, 'member');
    se.joinGroup(quiet.id, carol.pubKeyHex);
    const groupIds = [open.id, quiet.id];

    const at = 'lat=-28.65&lng=153.55';
    // Every read compared across profiles: [label, path, reader].
    const READS: Array<[string, string, Id]> = [
        ['members whole', '/api/members', dan],
        ['members delta of everyone', '/api/members?updatedAfter=1970-01-01T00:00:00.000Z', dan],
        ['members nearest-first, no limit', `/api/members?${at}`, dan],
        ['members keys=', `/api/members?keys=${alice.pubKeyHex},${bob.pubKeyHex}`, dan],
        ['members q=', '/api/members?q=Ca', dan],
        ['members nearest 3', `/api/members?${at}&limit=3`, dan],
        ['community/members', '/api/community/members', dan],
        ['community/members with a point', `/api/community/members?${at}`, dan],
        ['invite tree whole', '/api/invite/tree', dan],
        ['invite tree, someone else\'s branch', `/api/invite/tree?root=${alice.pubKeyHex}`, dan],
        ['invite tree, own branch', `/api/invite/tree?root=${alice.pubKeyHex}`, alice],
        ['activity feed', '/api/activity/feed', dan],
        ['open group card, outsider', `/api/groups/${open.id}`, dan],
        ['open group card, invitee', `/api/groups/${open.id}`, eve],
        ['open group roster, outsider', `/api/groups/${open.id}/members`, dan],
        ['open group roster, invitee (the invite landing)', `/api/groups/${open.id}/members?status=active`, eve],
        ['open group roster, member', `/api/groups/${open.id}/members`, bob],
        ['open group roster, convenor', `/api/groups/${open.id}/members`, alice],
        ['invite-only group roster, outsider', `/api/groups/${quiet.id}/members`, dan],
        ['invite-only group roster, member', `/api/groups/${quiet.id}/members`, carol],
        ['groups list', '/api/groups', dan],
    ];
    /** The same bytes whatever run made them: the group ids and the times this run wrote are named, not printed. */
    const normalise = (text: string) => {
        let s = text;
        groupIds.forEach((g, i) => { s = s.split(g).join(`<group-${i}>`); });
        s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, (t) => {
            const ms = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + 'Z');
            return Number.isFinite(ms) && ms >= STARTED ? '<this-run>' : t;
        });
        return s;
    };
    const readAll = async () => {
        const out: Record<string, { status: number; body: string }> = {};
        for (const [label, p, who] of READS) {
            const r = await get(p, who);
            out[label] = { status: r.status, body: normalise(r.text) };
        }
        return out;
    };
    const features = async (who: Id) => (await get('/api/community/info', who)).body?.features ?? {};

    // ── 1. A local community: everything as before ──
    console.log('── 1. A local community (NODE_PROFILE unset) ──');
    const local = await readAll();
    if (process.env.OPEN_MEMBERSHIP_BODIES_OUT) {
        fs.writeFileSync(process.env.OPEN_MEMBERSHIP_BODIES_OUT, JSON.stringify(local, null, 1));
        console.log(`  (every local read's status and body written to ${process.env.OPEN_MEMBERSHIP_BODIES_OUT})`);
    }
    assert(!('openMembership' in await features(dan)), 'local: features carry no openMembership');
    const wholeLocal = JSON.parse(local['members whole'].body);
    const SEEDED = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'];
    assert(local['members whole'].status === 200 && Array.isArray(wholeLocal) && SEEDED.every(c => wholeLocal.some((m: any) => m.callsign === c)),
        `local: the whole directory answers 200 with every member (got ${local['members whole'].status}, ${wholeLocal?.map?.((m: any) => m.callsign).join(',')})`);
    for (const label of ['members delta of everyone', 'members nearest-first, no limit', 'community/members', 'community/members with a point', 'invite tree whole', 'invite tree, someone else\'s branch']) {
        assert(local[label].status === 200, `local: ${label} answers 200 as before (got ${local[label].status})`);
    }
    assert(local['activity feed'].status === 200 && JSON.parse(local['activity feed'].body).feed.filter((e: any) => e.eventType === 'member_joined').length === 5,
        'local: the feed has its 5 "joined" lines');
    assert(local['open group roster, outsider'].status === 200 && JSON.parse(local['open group roster, outsider'].body).length === 2,
        `local: an open group's roster answers a member outside it, as before (got ${local['open group roster, outsider'].status})`);
    assert(local['open group roster, invitee (the invite landing)'].status === 200,
        `local: an invitee's landing reads the faces, as before (got ${local['open group roster, invitee (the invite landing)'].status})`);
    let localNearest = 0;
    for (let i = 0; i < 101; i++) if ((await get(`/api/members?${at}&limit=2`, carol)).status === 200) localNearest++;
    assert(localNearest === 101, `local: 101 nearest reads in a day all answer, no budget (${localNearest} of 101)`);

    // ── 2. The global node ──
    console.log('\n── 2. The global node (NODE_PROFILE=global) ──');
    process.env.NODE_PROFILE = 'global';
    budget?.resetNearestPeopleBudget();
    assert((await features(dan)).openMembership === true, 'global: features.openMembership is true');
    const before = heavyReadStats();
    const WHOLE = [
        '/api/members', '/api/members?updatedAfter=1970-01-01T00:00:00.000Z', `/api/members?updatedAfter=${encodeURIComponent(iso(Date.now() - 1000))}`,
        `/api/members?${at}`, '/api/community/members', `/api/community/members?${at}`,
    ];
    for (const p of WHOLE) {
        for (const inm of [{}, { 'If-None-Match': 'W/"members-1"' }]) {
            const r = await get(p, dan, inm);
            assert(r.status === 403 && r.body?.code === 'members_on_demand' && typeof r.body?.error === 'string',
                `global: ${p}${'If-None-Match' in inm ? ' (If-None-Match)' : ''} → 403 members_on_demand (got ${r.status} ${r.text.slice(0, 80)})`);
        }
    }
    const after = heavyReadStats();
    assert(after.admitted === before.admitted && after.refused === before.refused && after.waiting === before.waiting,
        `global: no whole read reached the heavy-read cap: nothing read (admitted ${before.admitted} → ${after.admitted}, refused ${before.refused} → ${after.refused})`);
    const keysRead = await get(`/api/members?keys=${alice.pubKeyHex},${bob.pubKeyHex}`, dan);
    assert(keysRead.status === 200 && keysRead.body.map((m: any) => m.callsign).join() === 'Alice,Bob', `global: keys= answers 200, in the order asked (got ${keysRead.status})`);
    const search = await get('/api/members?q=Ca', dan);
    assert(search.status === 200 && search.body.length === 1 && search.body[0].callsign === 'Carol', `global: q= answers 200 (got ${search.status})`);
    assert(search.text === local['members q='].body,
        'global: the search answers the same bytes as on a local community');
    const near = await get(`/api/members?${at}&limit=3`, dan);
    assert(near.status === 200 && near.body.length === 3 && near.body.every((m: any) => typeof m.distanceKm === 'number'),
        `global: lat&lng&limit=3 answers the 3 nearest (got ${near.status})`);
    // The day budget: Dan has made one nearest read; Carol none since the reset.
    let carolOk = 0;
    for (let i = 0; i < 100; i++) if ((await get(`/api/members?${at}&limit=2`, carol)).status === 200) carolOk++;
    assert(carolOk === 100, `global: 100 nearest reads in a day answer (${carolOk} of 100)`);
    const over = await get(`/api/members?${at}&limit=2`, carol);
    assert(over.status === 429 && over.body?.code === 'nearest_people_day_budget' && Number(over.headers.get('retry-after')) > 0,
        `global: the 101st is 429 nearest_people_day_budget with Retry-After (got ${over.status} ${over.text.slice(0, 120)})`);
    assert(/100 times today/.test(over.body?.error ?? '') && !/Ʀ/.test(over.text), `global: and says so in words ("${over.body?.error}")`);
    assert((await get('/api/members?q=Al', carol)).status === 200, 'global: past the budget, a search by name still answers');
    assert((await get(`/api/members?${at}&limit=2`, dan)).status === 200, 'global: another member\'s nearest reads are their own');
    const badLimit = await get(`/api/members?${at}&limit=0`, dan);
    assert(badLimit.status === 400, `global: a refused limit is still 400, never counted (got ${badLimit.status})`);
    // The invite tree.
    const tree = await get('/api/invite/tree', dan);
    assert(tree.status === 403 && tree.body?.code === 'members_on_demand', `global: the whole invite tree → 403 (got ${tree.status})`);
    const others = await get(`/api/invite/tree?root=${alice.pubKeyHex}`, dan);
    assert(others.status === 403 && others.body?.code === 'members_on_demand', `global: someone else's branch → 403 (got ${others.status})`);
    const own = await get(`/api/invite/tree?root=${alice.pubKeyHex}`, alice);
    const ownNames = JSON.stringify(own.body ?? '');
    assert(own.status === 200 && ownNames.includes('Bob') && ownNames.includes('Carol'), `global: the signer's own branch → 200 with the people they brought in (got ${own.status})`);
    // The feed.
    const feed = await get('/api/activity/feed', dan);
    const types = (feed.body?.feed ?? []).map((e: any) => e.eventType);
    assert(feed.status === 200 && !types.includes('member_joined') && types.includes('post_created'),
        `global: the feed has no "joined" line and keeps the post (got ${feed.status} ${types.join(',')})`);
    assert(!feed.text.includes(eve.pubKeyHex), 'global: and names no newcomer by key');
    // Open-group rosters (S3).
    const outsider = await get(`/api/groups/${open.id}/members`, dan);
    assert(outsider.status === 403 && outsider.body?.code === 'join_to_see' && outsider.body?.error === 'Join the group to see who is here',
        `global: an open group's roster to a member outside it → 403 join_to_see (got ${outsider.status} ${outsider.text.slice(0, 80)})`);
    assert(!outsider.text.includes(bob.pubKeyHex) && !outsider.text.includes('Bob'), 'global: and names nobody in it');
    for (const [who, label] of [[bob, 'a member'], [alice, 'its convenor']] as const) {
        const r = await get(`/api/groups/${open.id}/members`, who);
        assert(r.status === 200 && Array.isArray(r.body) && r.body.some((m: any) => m.callsign === 'Bob'), `global: the roster to ${label} → 200 (got ${r.status})`);
    }
    const card = await get(`/api/groups/${open.id}`, dan);
    assert(card.status === 200 && card.body?.memberCount === 2 && card.body?.convenorCallsign === 'Alice',
        `global: the card keeps its count and its convenor for a member outside it (got ${card.status} ${card.body?.memberCount} ${card.body?.convenorCallsign})`);
    // Amendment 1 item 2: the invite landing reads the faces with ?status=active. Under S3 an invitee loses them, and keeps
    // the card's count and who invited them, face and all (the phone's app/group/[id].tsx draws both from the card).
    const landing = await get(`/api/groups/${open.id}/members?status=active`, eve);
    assert(landing.status === 403 && landing.body?.code === 'join_to_see', `global: an invitee's landing read of the faces → 403 join_to_see (got ${landing.status})`);
    const invitedCard = await get(`/api/groups/${open.id}`, eve);
    assert(invitedCard.status === 200 && invitedCard.body?.viewerStatus === 'invited' && invitedCard.body?.viewerInvitedBy?.callsign === 'Alice'
        && invitedCard.body?.viewerInvitedBy?.pubkey === alice.pubKeyHex && invitedCard.body?.memberCount === 2,
        `global: the invitee's card keeps who invited them and the count (got ${JSON.stringify(invitedCard.body?.viewerInvitedBy)} ${invitedCard.body?.memberCount})`);
    const hidden = await get(`/api/groups/${quiet.id}/members`, dan);
    assert(hidden.status === 404, `global: an invite-only group's roster is still 404 to an outsider (got ${hidden.status})`);
    assert((await get(`/api/groups/${quiet.id}/members`, carol)).status === 200, 'global: and 200 to its member');

    // ── 3. The operator's override on the global node: every read as before ──
    console.log('\n── 3. nodeProfile.openMembership = false on the global node ──');
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.openMembership`, 'false');
    assert(!('openMembership' in await features(dan)), 'override: features carry no openMembership');
    for (const p of WHOLE) {
        const r = await get(p, dan);
        assert(r.status === 200, `override: ${p} answers 200 as before (got ${r.status})`);
    }
    assert((await get('/api/invite/tree', dan)).status === 200, 'override: the whole invite tree answers 200');
    const feedOff = await get('/api/activity/feed', dan);
    assert((feedOff.body?.feed ?? []).filter((e: any) => e.eventType === 'member_joined').length === 5, 'override: the feed has its "joined" lines');
    const feedEtag = feed.headers.get('etag');
    const revalidated = await get('/api/activity/feed', dan, feedEtag ? { 'If-None-Match': feedEtag } : {});
    assert(revalidated.status === 200, `override: the copy made with the switch on is never confirmed with a 304 (got ${revalidated.status})`);
    assert((await get(`/api/groups/${open.id}/members`, dan)).status === 200, 'override: the open group\'s roster answers a member outside it');
    assert((await get(`/api/groups/${open.id}/members?status=active`, eve)).status === 200, 'override: and the invitee\'s landing reads the faces');
    assert((await get(`/api/members?${at}&limit=2`, carol)).status === 200, 'override: the nearest read has no budget (Carol, spent above, reads)');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.openMembership`);
    assert((await features(dan)).openMembership === true, 'override removed: global is open-membership again');
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
