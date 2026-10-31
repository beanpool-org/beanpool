/**
 * The place circle on the global node (Lounge L2 with doors S8, engine/place-circles.ts). Over REAL HTTPS through the real
 * signature middleware, with a FIXTURE registry on 127.0.0.1 and pushes caught at fetch: no node, registry or Expo.
 *
 *   1. local profile: the new routes answer 404 feature_off, and a mirror run makes nothing
 *   2. formation: two helpers within 25 km are no circle, the third makes one with all three in it (kind circle, the
 *      place cell stored, hidden from outsiders, the earliest helper its convenor, a watch stores the cell and the flag
 *      and nothing else); a watch with no flag counts for nothing; one far away joins nobody
 *   3. a count below 3 is never said, through the public route and the card, signed or not; each person counts once and
 *      in exactly one tile, so no walk of points can difference anyone out; never "a few"
 *   4. no member's point in any response or push: a sentinel sweep of every read, and each push is generic
 *   5. who is in which circle: a late helper joins the circle near them, a member in two cells is in one circle, a
 *      leaver or a removed member is not put back, two who blocked each other are not seated together, a suspended
 *      member isn't seated, and a place with a listed community gets no circle
 *   6. retire and close: the first community near retires it once and tells its members with no name, a second changes
 *      nothing, a flood retires nothing, its flags go so no run forms it again, and its chat stays open 30 days; then the
 *      group closes, read-only, its row kept
 *   7. "I'm starting one here": members only, one at a time, only its maker takes it back, the others told once in a day
 *   8. a standby holds the flag and the circle; the 10,000-watch run and read each fit in 50 ms
 *
 * Run: SERVER_SUITES_ONLY=test-place-circles TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import http from 'node:http';
import { pushIsGeneric, toldPush } from './push-notice-test-harness.js';
import { localFetch } from './keepalive-test-fetch.js';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let rows: unknown[] = [];
const registry = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        const u = new URL(req.url || '/', 'http://fixture');
        const limit = Number(u.searchParams.get('limit') || 1000);
        const offset = Number(u.searchParams.get('offset') || 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows.slice(offset, offset + limit)));
    });
});
await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
process.env.DIRECTORY_MIRROR_URL = `http://127.0.0.1:${(registry.address() as { port: number }).port}/rest/v1/directory_nodes?select=*`;
process.env.DIRECTORY_MIRROR_KEY = 'sb_publishable_TEST-fixture-key-7c1e';

const realFetch = globalThis.fetch;
const pushed: any[] = [];
let notGeneric = 0;
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        for (const m of JSON.parse(init.body)) {
            if (!pushIsGeneric(m)) notGeneric++;
            pushed.push(toldPush(db, m));
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
    }
    return realFetch(url, init);
};

const { initTls } = await import('./services/tls.js');
const { initStateEngine, seedGenesisMember, setNodeRole } = await import('./state-engine.js');
const { startHttpsServer } = await import('./https-server.js');
const { db } = await import('./db/db.js');
const { putPushTokenRow } = await import('./services/push-token-seal.js');
const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
const { runDirectoryMirror } = await import('./services/directory-mirror.js');
const circles = await import('./engine/place-circles.js' as string).catch(() => null) as any;
const { mergeReplicatedWatches } = await import('./engine/place-watches.js');
const core = await import('@beanpool/core') as any;

let BASE = '';
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 30 * 86_400_000).toISOString(), owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
const pushToken = (id: Id) => `ExponentPushToken[${id.pk.slice(0, 20)}]`;
function phoned(name: string): Id {
    const id = member(name);
    putPushTokenRow(id.pk, pushToken(id), 'android');
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(method: 'GET' | 'POST' | 'DELETE', id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const headers: Record<string, string> = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await localFetch(`${BASE}${urlPath}`, { method, headers, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const help = (id: Id, lat: number, lng: number) => call('POST', id, '/api/global/watches', { lat, lng, wouldHelp: true });
const watchOnly = (id: Id, lat: number, lng: number) => call('POST', id, '/api/global/watches', { lat, lng });
const demand = (id: Id | null, lat: number, lng: number) => call('GET', id, `/api/global/demand?lat=${lat}&lng=${lng}`);
const circleRows = () => db.prepare("SELECT * FROM groups WHERE kind = 'circle' ORDER BY created_at, id").all() as any[];
const seated = (groupId: string) => (db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(groupId) as any[]).map(r => r.member_pubkey as string);
const settle = () => new Promise(r => setTimeout(r, 200));
const mirror = async () => { const r = await runDirectoryMirror(); await settle(); return r; };
const community = (id: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
    node_id: id, community_name: `Community ${id}`, node_url: `https://${id}.beanpool.org`, service_radius: { lat, lng, radiusKm: 5 }, member_count: 4, ...extra,
});
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function main(): Promise<void> {
    console.log('\n=== The place circle (Lounge L2, doors S8) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    setNodeRole('primary');

    console.log('── 1. local profile ──');
    assert((await demand(null, -28.6, 153.5)).status === 404, 'the count is 404 on a local community');
    assert((await call('POST', owner, '/api/global/circles/x/starting', { starting: true })).status === 404, "the starting row is 404 on a local community");

    process.env.NODE_PROFILE = 'global';

    console.log('── 2. formation ──');
    // In Kerala, far from anything; 0.1° is about 11 km here.
    const ana = phoned('Ana'), ben = phoned('Ben'), cai = phoned('Cai'), dot = phoned('Dot');
    assert((await help(ana, 10.52, 76.21)).status === 200, 'a member says they would help');
    const stored = db.prepare('SELECT * FROM place_watches WHERE pubkey = ?').get(ana.pk) as any;
    assert(stored?.lat === 10.5 && stored?.lng === 76.2 && stored?.would_help === 1, 'it stores the 0.1° cell and the flag');
    assert(sameSet(Object.keys(stored ?? {}), ['id', 'pubkey', 'lat', 'lng', 'radius_km', 'created_at', 'last_notified_at', 'updated_at', 'would_help']),
        "a watch's row holds the cell, the flag and what a watch always held, nothing else");
    await help(ben, 10.58, 76.25);
    await watchOnly(dot, 10.5, 76.2);
    const r = await mirror();
    assert((r as any).ok === true && circleRows().length === 0, 'two helpers and a watcher are no circle');
    await help(cai, 10.63, 76.33);
    pushed.length = 0;
    await mirror();
    const made = circleRows();
    assert(made.length === 1, 'the third helper makes one circle');
    const circle = made[0] ?? {};
    assert(sameSet(seated(circle.id), [ana.pk, ben.pk, cai.pk]), 'all three are in it, and the watcher with no flag is not');
    assert(circle.place_cell === '10.5,76.2' && circle.category === 'working_group' && circle.join_policy === 'invite_only', 'it holds its cell, and only those in it can see it');
    const lead = db.prepare("SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?").get(circle.id, ana.pk) as any;
    assert(lead?.role === 'convenor', 'the earliest helper is its convenor');
    const toldCircle = pushed.filter(p => p.kind === 'community.circle');
    assert(sameSet(toldCircle.map(p => p.to), [ana, ben, cai].map(pushToken)), 'each of the three gets one push of the generic kind');
    assert(notGeneric === 0, 'every push is the fixed words and a signed notice');
    await mirror();
    assert(circleRows().length === 1, 'another run makes no second circle');

    console.log('── 3. a count below 3 is never said ──');
    for (const who of [null, ana]) {
        const said = await demand(who, 10.52, 76.21);
        assert(said.status === 200 && said.body.helping === 3 && said.body.waiting === 4, `three helpers and four waiting are said (${who ? 'signed' : 'unsigned'})`);
    }
    const lone = phoned('Lone');
    await help(lone, -41.2, 174.8);
    const edge = member('Edge');
    await watchOnly(edge, -41.3, 174.8);
    for (const [lat, lng] of [[-41.2, 174.8], [-41.3, 174.8], [-41.25, 174.85]] as const) {
        const said = await demand(null, lat, lng);
        assert(said.status === 200 && said.body.waiting === null && said.body.helping === null, `two waiting at ${lat}, ${lng} say nothing at all`);
        const card = await call('GET', null, `/api/global/home?lat=${lat}&lng=${lng}`);
        assert(card.body?.demand?.waiting === null && card.body?.demand?.helping === null, 'and neither does the public card');
    }
    const words = new Set<string>();
    for (const c of [[0, null], [1, null], [2, null]] as const) words.add(String(core.circleDemandLine?.({ waiting: c[0], helping: c[0] })));
    assert(words.size === 1 && words.has('null'), 'the apps say nothing for 0, 1 or 2, not "a few"');
    // A person with three cells in the tile is one person.
    const tri = member('Tri');
    await watchOnly(tri, 59.3, 18.1); await watchOnly(tri, 59.4, 18.1); await watchOnly(tri, 59.3, 18.2);
    assert((await demand(null, 59.3, 18.1)).body.waiting === null, 'one person watching three cells is one person');
    // No walk can single anyone out: every point of a tile reads one number, each person in one tile. The fifth person
    // sits 8 km from the four in the next tile south, where a count "within 25 km of the point" would differ by one.
    const sliding = member('Slide');
    await watchOnly(sliding, 10.4, 76.2);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) seen.add(JSON.stringify((await demand(null, 10.5 + i * 0.05, 76 + j * 0.05)).body));
    assert(seen.size === 1, 'every point in a tile reads the same number, so two reads never subtract to one person');
    const south = await demand(null, 10.45, 76.2);
    assert(south.body.waiting === null, 'the person next door, alone in their tile, is said nowhere');

    console.log('── 4. no point in any response or push ──');
    // Each helper's cell, spelled as a response would: none of them in anything an outsider or a member reads.
    const outsider = phoned('Outsider');
    const cellText = ['10.5,76.2', '76.2', '"lat":10.5', '10.6', '76.3'];
    const sweep = [
        await call('GET', ana, `/api/groups/${circle.id}`),
        await call('GET', ben, '/api/groups'),
        await call('GET', ben, '/api/your-groups'),
        await call('GET', ben, `/api/groups/${circle.id}/members`),
        await call('GET', outsider, '/api/groups'),
        await call('GET', null, `/api/global/home?lat=48.1&lng=11.5`),
        await call('GET', outsider, `/api/global/home?lat=48.1&lng=11.5`),
    ];
    assert(sweep.every(s => !cellText.some(t => s.text.includes(t))), "no read carries a member's cell or the circle's");
    assert(sweep.every(s => !s.text.includes('place_cell') && !s.text.includes('placeCell')), 'no read names the column');
    assert((await call('GET', outsider, `/api/groups/${circle.id}`)).status === 404, 'an outsider reads a circle as no group at all');
    assert((await call('GET', null, `/api/groups/${circle.slug}`)).status !== 200, 'nor by its slug, unsigned');
    assert(!sweep[4].text.includes(circle.id), "it is in no outsider's list");
    assert(sweep[0].body?.kind === 'circle' && sweep[0].body?.circle?.people === 3, 'a member reads its kind and count');
    const pushJson = JSON.stringify(pushed.map(p => p.sent));
    assert(!cellText.some(t => pushJson.includes(t)) && !pushJson.includes('Starting a community'), 'a push as it leaves has no place and no group in it');
    const details = JSON.stringify(pushed.map(p => [p.title, p.body, p.data]));
    assert(!cellText.some(t => details.includes(t)), "its details, read by the member's own app, have no place either");

    console.log('── 5. who is in which circle ──');
    const eve = phoned('Eve');
    await help(eve, 10.6, 76.3);
    pushed.length = 0;
    await mirror();
    assert(circleRows().length === 1 && seated(circle.id).includes(eve.pk), 'a late helper near a circle joins it');
    assert(pushed.filter(p => p.kind === 'community.circle').length === 1, 'and only they are told');
    // Two cells, 800 km apart, three helpers each: the shared member sits in the first.
    const [fay, gus, hal, ian, jo] = [phoned('Fay'), phoned('Gus'), phoned('Hal'), phoned('Ian'), phoned('Jo')];
    await help(fay, 19.1, 72.9); await help(gus, 19.1, 72.9); await help(hal, 19.1, 72.9);
    await help(hal, 13.1, 80.3); await help(ian, 13.1, 80.3); await help(jo, 13.1, 80.3);
    await mirror();
    const halIn = db.prepare(`SELECT COUNT(*) AS n FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.kind = 'circle' AND gm.member_pubkey = ?`).get(hal.pk) as any;
    assert(circleRows().length === 2 && halIn.n === 1, 'a member with flags in two cells is in one circle, and the other cell stays two');
    const kay = phoned('Kay');
    await help(kay, 10.5, 76.9);
    await mirror();
    assert(!seated(circle.id).includes(kay.pk), 'a helper over 25 km from a circle stays out of it');
    // A leaver is not pulled back.
    const leave = await call('DELETE', ben, `/api/groups/${circle.id}/members/${ben.pk}`);
    assert(leave.status === 200, 'a member can leave');
    await mirror();
    assert(!seated(circle.id).includes(ben.pk), 'the next run does not put them back');
    assert((db.prepare('SELECT would_help FROM place_watches WHERE pubkey = ?').get(ben.pk) as any)?.would_help === 0, 'their flag went, their watch stayed');
    // Nor someone a convenor removed.
    const off = await call('DELETE', ana, `/api/groups/${circle.id}/members/${cai.pk}`);
    assert(off.status === 200, 'a convenor can remove someone');
    await help(cai, 10.63, 76.33);
    await mirror();
    assert(!seated(circle.id).includes(cai.pk), 'saying it again does not undo a removal');
    // A block is not undone by being introduced.
    const [lia, max, ned, oli] = [phoned('Lia'), phoned('Max'), phoned('Ned'), phoned('Oli')];
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(ned.pk, lia.pk);
    await help(lia, -3.1, -60); await help(max, -3.1, -60); await help(ned, -3.1, -60);
    await mirror();
    assert(!circleRows().some(c => seated(c.id).includes(lia.pk)), 'two who blocked each other leave it at two, and no circle forms');
    await help(oli, -3.1, -60);
    await mirror();
    const amazon = circleRows().find(c => seated(c.id).includes(lia.pk));
    assert(!!amazon && !seated(amazon.id).includes(ned.pk) && seated(amazon.id).length === 3, 'with a third, it forms without the one who blocked the earlier helper');
    // A suspended member is not seated.
    const [pia, quy, ria] = [phoned('Pia'), phoned('Quy'), phoned('Ria')];
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(pia.pk);
    await help(pia, 6.5, 3.4); await help(quy, 6.5, 3.4); await help(ria, 6.5, 3.4);
    await mirror();
    assert(!circleRows().some(c => seated(c.id).includes(quy.pk)), 'a suspended member does not count toward three');
    // A place with a community has one to join.
    rows = [community('accra', 5.6, -0.2)];
    await mirror();
    const [sam, tao, uma] = [phoned('Sam'), phoned('Tao'), phoned('Uma')];
    await help(sam, 5.6, -0.2); await help(tao, 5.6, -0.2); await help(uma, 5.6, -0.2);
    await mirror();
    assert(!circleRows().some(c => seated(c.id).includes(sam.pk)), 'three helpers beside a listed community make no circle');

    console.log('── 6. retire and close ──');
    // Eve keeps her seat with no watch of her own: an invited neighbour's case. The watches' notice can't reach her.
    db.prepare('DELETE FROM place_watches WHERE pubkey = ?').run(eve.pk);
    const before = seated(circle.id);
    pushed.length = 0;
    rows = [...rows, community('thrissur', 10.52, 76.22)];
    await mirror();
    let row = db.prepare('SELECT * FROM groups WHERE id = ?').get(circle.id) as any;
    assert(!!row?.circle_done_at && row?.circle_community_key === 'thrissur', 'the first community near a circle retires it');
    const firstDone = row?.circle_done_at;
    const hearing = pushed.filter(p => p.kind === 'community.near').map(p => p.to);
    assert(before.length === 2 && before.every(pk => hearing.filter(t => t === pushToken({ pk } as Id)).length === 1),
        'each member hears once, by the generic notice, with a watch or without');
    assert(!JSON.stringify(pushed.map(p => [p.title, p.body, p.sent])).includes('Community thrissur'), 'no notice carries the name');
    const card = await call('GET', ana, `/api/groups/${circle.id}`);
    assert(card.body?.circle?.community?.name === 'Community thrissur' && !!card.body?.circle?.doneAt, 'the card of someone in it names the community');
    assert((await call('GET', ana, '/api/global/home?lat=10.5&lng=76.2')).body?.circle?.community?.url === 'https://thrissur.beanpool.org', 'and the Find card has where their app knocks');
    pushed.length = 0;
    rows = [...rows, community('kochi', 10.5, 76.25)];
    await mirror();
    row = db.prepare('SELECT * FROM groups WHERE id = ?').get(circle.id) as any;
    assert(row?.circle_done_at === firstDone && row?.circle_community_key === 'thrissur' && pushed.filter(p => p.kind === 'community.circle').length === 0, 'a second community changes nothing: it fires once');
    assert((db.prepare('SELECT COUNT(*) AS n FROM place_watches WHERE pubkey = ? AND would_help = 1').get(ana.pk) as any).n === 0, "its members' flags near it are gone");
    assert(circleRows().filter(c => c.place_cell === '10.5,76.2').length === 1, 'no second circle forms where it stood');
    const stillOpen = await call('POST', ana, `/api/groups/${circle.id}/chat/message`, { text: 'still here' });
    assert(stillOpen.status !== 403 && !/finished|closed/i.test(stillOpen.text), 'its chat stays open while its 30 days run');
    // A flood is nobody's news: 26 rows in one run around a circle retire nothing.
    const mumbai = circleRows().find(c => c.place_cell === '19.1,72.9');
    rows = [...rows, ...Array.from({ length: 26 }, (_, i) => community(`flood${i}`, 19.1 + i * 0.001, 72.9))];
    await mirror();
    assert(!(db.prepare('SELECT circle_done_at FROM groups WHERE id = ?').get(mumbai?.id) as any)?.circle_done_at, 'a flood of rows retires no circle');
    // Day 31.
    db.prepare('UPDATE groups SET circle_done_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), circle.id);
    await mirror();
    const closed = db.prepare('SELECT * FROM group_closures WHERE group_id = ?').get(circle.id) as any;
    assert(!!closed, 'thirty days on, the group closes');
    assert(!!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(circle.id), 'its row stays');
    const shut = await call('GET', ana, `/api/groups/${circle.id}`);
    assert(shut.body?.readOnly === true && !!shut.body?.closedAt, 'and reads as closed');
    assert(!(await call('GET', ana, '/api/global/home?lat=10.5&lng=76.2')).body?.circle, 'the Find card lets it go');

    console.log("── 7. I'm starting one here ──");
    const mumbaiId = mumbai?.id as string;
    assert((await call('POST', outsider, `/api/global/circles/${mumbaiId}/starting`, { starting: true })).status === 404, 'an outsider is refused as for no circle');
    pushed.length = 0;
    const said = await call('POST', gus, `/api/global/circles/${mumbaiId}/starting`, { starting: true });
    await settle();
    assert(said.status === 200 && said.body?.circle?.starting === 'you', 'someone in it says so');
    assert(sameSet(pushed.filter(p => p.kind === 'community.circle').map(p => p.to), [fay, hal].map(pushToken)), 'the others hear once, by the generic notice');
    assert((await call('GET', fay, `/api/groups/${mumbaiId}`)).body?.circle?.starting === 'someone', 'the others read that someone is');
    assert((await call('POST', fay, `/api/global/circles/${mumbaiId}/starting`, { starting: true })).status === 409, 'one at a time');
    assert((await call('POST', fay, `/api/global/circles/${mumbaiId}/starting`, { starting: false })).status === 409, 'only they can take it back');
    pushed.length = 0;
    await call('POST', gus, `/api/global/circles/${mumbaiId}/starting`, { starting: false });
    await call('POST', gus, `/api/global/circles/${mumbaiId}/starting`, { starting: true });
    await settle();
    assert(pushed.filter(p => p.kind === 'community.circle').length === 0, 'tapped off and on within a day, nobody is rung again');
    await call('DELETE', gus, `/api/groups/${mumbaiId}/members/${gus.pk}`);
    assert((await call('GET', fay, `/api/groups/${mumbaiId}`)).body?.circle?.starting === null, 'leaving takes it with them');
    assert((await call('POST', ana, `/api/global/circles/${circle.id}/starting`, { starting: true })).status >= 400, 'a finished circle takes no one starting');

    console.log('── 7b. a circle stays a circle ──');
    assert(await patch(fay, `/api/groups/${mumbaiId}`, { description: 'Buy my stuff' }) >= 400, "a convenor can't turn it into another group");
    assert(await patch(fay, `/api/groups/${mumbaiId}`, { joinPolicy: 'open' }) >= 400, 'or open its door to everyone');

    console.log('── 8. a standby, and the cost ──');
    const wid = crypto.randomUUID();
    const merged = mergeReplicatedWatches([{ id: wid, pubkey: tao.pk, lat: 1.1, lng: 2.2, radiusKm: 50, createdAt: new Date().toISOString(), lastNotifiedAt: null, updatedAt: new Date().toISOString(), wouldHelp: true }]);
    assert(merged.written === 1 && (db.prepare('SELECT would_help FROM place_watches WHERE id = ?').get(wid) as any)?.would_help === 1, 'a standby keeps the flag');
    // 10,000 helpers: half in cities, half alone. The run's comparing, and the public read over a full table.
    const helpers = Array.from({ length: 10_000 }, (_, i) => i % 2
        ? { pubkey: `p${i}`, lat: -60 + (i % 1200) * 0.1, lng: -170 + (i % 3000) * 0.1 }
        : { pubkey: `p${i}`, lat: Number((10 + (i % 40) * 0.1).toFixed(1)), lng: Number((70 + (i % 30) * 0.1).toFixed(1)) });
    const startRun = performance.now();
    const clusters = circles?.clusterHelpers?.(helpers) ?? [];
    const runMs = performance.now() - startRun;
    assert(clusters.length > 0 && runMs < 50, `10,000 watches compare in ${runMs.toFixed(1)} ms (under 50)`);
    assert(new Set(clusters.flatMap((c: any) => c.members)).size === clusters.flatMap((c: any) => c.members).length, 'and nobody is in two');
    const insert = db.prepare('INSERT OR IGNORE INTO place_watches (id, pubkey, lat, lng, radius_km, would_help) VALUES (?, ?, ?, ?, 50, 1)');
    db.pragma('foreign_keys = OFF');
    db.transaction(() => { helpers.forEach((h, i) => insert.run(`load-${i}`, ana.pk.slice(0, 54) + String(i).padStart(10, '0'), h.lat, h.lng)); })();
    db.pragma('foreign_keys = ON');
    const startRead = performance.now();
    circles?.waitingNear?.({ lat: 10.5, lng: 70.5 });
    const readMs = performance.now() - startRead;
    assert(!!circles && readMs < 50, `the count reads a 10,000-watch table in ${readMs.toFixed(1)} ms (under 50)`);

    console.log(`\n${passed}/${run} checks passed`);
    process.exit(passed === run ? 0 : 1);
}

async function patch(id: Id, urlPath: string, body: unknown): Promise<number> {
    resetGatewayRateLimit();
    const raw = JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json', 'X-Public-Key': id.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
        'X-Signature': crypto.sign(null, Buffer.from(`PATCH\n${urlPath}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
    };
    return (await localFetch(`${BASE}${urlPath}`, { method: 'PATCH', headers, body: raw })).status;
}

main().catch((e) => { console.error(e); process.exit(1); });
