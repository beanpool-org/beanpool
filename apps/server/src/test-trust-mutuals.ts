/**
 * "Connections in common" on a member's trust profile (POST /api/trust/profile) count only friendships both ways on
 * both sides: F is named for viewer V and target T only when V→F, F→V, F→T and T→F all exist.
 *
 * A friend row is one-way and needs nobody's consent, so the old two-join query (V's list ∩ T's list) was:
 *   - an oracle: a member who added everyone read T's list by name, 12 at a time (the 94-request finding, 30/30);
 *   - a forgery: a new member who added everyone looked "In your circle" (green) to every viewer with a friend.
 * See docs/trust-profile-and-trade-safety.md §2. Every read and every attacker write here goes through the real
 * middleware with a signed request; the rows a test only sets up are seeded straight into the table.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const OWN_NAME = 'mutuals-community.example';
process.env.BEANPOOL_ADDRESSES = OWN_NAME;

import crypto from 'node:crypto';
import { buildBoundRequestHeaders, ed25519Signer } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, broadcast } from './state-engine.js';
import { registerMemberInternal } from './engine/members.js';
import { startHttpsServer } from './https-server.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { localFetch } from './keepalive-test-fetch.js';
import { db } from './db/db.js';

let BASE = '';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

interface Id { pk: string; seed: Uint8Array; callsign: string }
function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const seed = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), seed, callsign };
}
let memberNo = 0;
/** The one founder, who holds `owner` (seedGenesisMember grants it) and only invites: no check reads as them. */
let founder: Id | null = null;
/** A plain member of this node (invited by the founder: no owner or admin role), joined just now with no trades, so
 *  with no connection in common the band is red. The trade-safety band is mostly read by plain members, so every
 *  viewer, friend, target and attacker here is one (#1911 review finding 1: a rule kept only for owners passed). */
function join(id: Id): Id {
    if (!founder) { founder = keypair('founder'); seedGenesisMember(founder.pk, founder.callsign); }
    if (!registerMemberInternal(broadcast, id.pk, id.callsign, founder.pk, null)) throw new Error(`could not join ${id.callsign}`);
    return id;
}
function member(prefix: string): Id {
    return join(keypair(`${prefix}-${String(++memberNo).padStart(3, '0')}`));
}

/** Set-up rows, seeded straight into the table: `a` has added `b`. */
const insertFriend = () => db.prepare('INSERT OR IGNORE INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)');
function oneWay(a: Id, b: Id): void { insertFriend().run(a.pk, b.pk); }
function bothWays(a: Id, b: Id): void { oneWay(a, b); oneWay(b, a); }

let requests = 0;
async function signed(signer: Id, method: string, path: string, body: unknown): Promise<{ status: number; body: any; text: string }> {
    requests++;
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, await buildBoundRequestHeaders({
        method, url: `https://${OWN_NAME}${path}`, body: bodyString, publicKeyHex: signer.pk, sign: ed25519Signer(signer.seed),
    }));
    const res = await localFetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : bodyString });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}
async function add(owner: Id, friend: Id): Promise<boolean> {
    const r = await signed(owner, 'POST', '/api/friends/add', { friendPubkey: friend.pk });
    return r.status === 200 && r.body?.success === true;
}
async function remove(owner: Id, friendPk: string): Promise<boolean> {
    const r = await signed(owner, 'POST', '/api/friends/remove', { friendPubkey: friendPk });
    return r.status === 200 && r.body?.success === true;
}
async function profile(viewer: Id, target: Id): Promise<{ status: number; body: any; text: string }> {
    return signed(viewer, 'POST', '/api/trust/profile', { targetPubkey: target.pk });
}
const names = (p: any): string[] => (p?.mutualConnections ?? []).map((m: any) => m.callsign);
const keys = (p: any): string[] => (p?.mutualConnections ?? []).map((m: any) => m.publicKey);

async function main() {
    console.log('Running trust profile "connections in common" checks...');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // T1 — the oracle replayed. T has 30 friends among 60 members: 20 friends both ways with T, 10 that only T added.
    // None of them chose A. A adds all 60, reads T's profile, removes whoever is named, and goes again: 10 rounds.
    // On the old query each round named up to 12 of T's list and all 30 were read in 3 rounds (94 requests in the finding).
    {
        resetGatewayRateLimit();
        const target = member('t1-target');
        const attacker = member('t1-attacker');
        const crowd = Array.from({ length: 60 }, () => member('t1-crowd'));
        const targetFriends = crowd.slice(0, 30);
        for (const f of targetFriends.slice(0, 20)) bothWays(target, f);
        for (const f of targetFriends.slice(20)) oneWay(target, f);

        let added = 0;
        for (const f of crowd) if (await add(attacker, f)) added++;
        assert(added === 60, `T1: A added all 60 members through the signed route (${added})`);

        const everNamed = new Set<string>();
        let roundsClean = 0, roundsServed = 0;
        for (let round = 0; round < 10; round++) {
            const p = await profile(attacker, target);
            if (p.status === 200) roundsServed++;
            const named = keys(p.body);
            if (named.length === 0 && p.body?.mutualCount === 0) roundsClean++;
            for (const k of named) { everNamed.add(k); await remove(attacker, k); }
        }
        const ofTargets = targetFriends.filter(f => everNamed.has(f.pk)).length;
        console.log(`  T1: A made ${requests} requests; names of T's 30 friends read: ${ofTargets}/30`);
        assert(roundsServed === 10, `T1: every one of the 10 reads was served (${roundsServed}/10)`);
        assert(roundsClean === 10, `T1: every round says mutualCount 0 and names nobody (${roundsClean}/10 clean)`);
        assert(everNamed.size === 0, `T1: no name is ever returned, so none of T's list is read (${ofTargets}/30 of T's friends named)`);
    }

    // T2 — A↔F and F↔T: F is named with a face, the count is 1 and the band is green on that one connection.
    {
        resetGatewayRateLimit();
        const a = member('t2-viewer'), f = member('t2-friend'), t = member('t2-target');
        db.prepare('UPDATE members SET avatar_ref = ? WHERE public_key = ?').run('ref-t2-friend', f.pk);
        bothWays(a, f); bothWays(f, t);
        const p = await profile(a, t);
        const m = p.body?.mutualConnections ?? [];
        assert(p.status === 200 && m.length === 1 && m[0].publicKey === f.pk && m[0].callsign === f.callsign,
            `T2: F is the one connection in common, by key and callsign (${JSON.stringify(m.map((x: any) => x.callsign))})`);
        assert(typeof m[0]?.avatarUrl === 'string' && m[0].avatarUrl.includes(f.pk) && m[0].avatarUrl.includes('ref-t2-friend'),
            `T2: with F's face (${m[0]?.avatarUrl})`);
        assert(p.body?.mutualCount === 1, `T2: mutualCount 1 (${p.body?.mutualCount})`);
        assert(p.body?.risk?.band === 'green', `T2: the band is green (${p.body?.risk?.band})`);
        assert((p.body?.risk?.reasons ?? []).some((r: string) => r.startsWith('You share 1 connection')),
            `T2: the reason says "You share 1 connection" (${JSON.stringify(p.body?.risk?.reasons)})`);

        // 13 such friends: exactly 12 named, in callsign order. Callsigns run against key order so a dropped ORDER shows.
        resetGatewayRateLimit();
        const v = member('t2b-viewer'), t2 = member('t2b-target');
        const refs = Array.from({ length: 13 }, () => keypair('')).sort((x, y) => (x.pk < y.pk ? -1 : 1));
        refs.forEach((r, i) => { r.callsign = `t2b-ref-${String(13 - i).padStart(2, '0')}`; join(r); });
        for (const r of refs) { bothWays(v, r); bothWays(r, t2); }
        const q = await profile(v, t2);
        const want = refs.map(r => r.callsign).sort().slice(0, 12);
        assert(q.status === 200 && JSON.stringify(names(q.body)) === JSON.stringify(want),
            `T2: of 13, exactly the first 12 by callsign are named, in order (${names(q.body).join(',')})`);
        assert(q.body?.mutualCount === 12, `T2: mutualCount 12 (${q.body?.mutualCount})`);
    }

    // T3 — any one of the four rows missing: nobody is named, and a new member with no trades stays red.
    {
        resetGatewayRateLimit();
        const cases: [string, (v: Id, f: Id, t: Id) => void][] = [
            ['V→F missing', (v, f, t) => { oneWay(f, v); bothWays(f, t); }],
            ['F→V missing', (v, f, t) => { oneWay(v, f); bothWays(f, t); }],
            ['F→T missing', (v, f, t) => { bothWays(v, f); oneWay(t, f); }],
            ['T→F missing', (v, f, t) => { bothWays(v, f); oneWay(f, t); }],
        ];
        for (const [label, seed] of cases) {
            const v = member('t3-viewer'), f = member('t3-friend'), t = member('t3-target');
            seed(v, f, t);
            const p = await profile(v, t);
            assert(p.status === 200 && keys(p.body).length === 0 && p.body?.mutualCount === 0,
                `T3 ${label}: nobody named, mutualCount 0 (${names(p.body).join(',') || 'none'}, ${p.body?.mutualCount})`);
            assert(p.body?.risk?.band === 'red', `T3 ${label}: a new member with no trades is red, never green (${p.body?.risk?.band})`);
        }
    }

    // T4 — forgery: a brand-new member adds every member one-way. A viewer with 5 real two-way friends sees no
    // connection in common and a red band (the old query said green "In your circle" from T's adds alone).
    {
        resetGatewayRateLimit();
        const viewer = member('t4-viewer');
        const friends = Array.from({ length: 5 }, () => member('t4-friend'));
        for (const f of friends) bothWays(viewer, f);
        const scammer = member('t4-scammer');
        const everyone = db.prepare('SELECT public_key FROM members WHERE public_key != ?').all(scammer.pk) as { public_key: string }[];
        // Through the signed route the day's 100 adds go through and the rest are refused (test-friends-added-you holds the
        // cap); the rest are seeded as the days after would add them, so the scammer has added every member.
        let adds = 0, refused = 0, sent = 0;
        for (const { public_key } of everyone) {
            if (sent > 0 && sent % 100 === 0) resetGatewayRateLimit(); // the per-minute limiter is not what is tested here
            sent++;
            const r = await signed(scammer, 'POST', '/api/friends/add', { friendPubkey: public_key });
            if (r.status === 200 && r.body?.success === true) adds++;
            else if (r.status === 429) { refused++; oneWay(scammer, { pk: public_key, seed: new Uint8Array(), callsign: '' }); }
        }
        assert(everyone.length > 100 && adds === 100 && refused === everyone.length - 100,
            `T4: the new member added 100 of ${everyone.length} members through the signed route, the rest refused (${adds}, ${refused})`);
        const scammerRows = (db.prepare('SELECT COUNT(*) AS n FROM friends WHERE owner_pubkey = ?').get(scammer.pk) as { n: number }).n;
        assert(scammerRows === everyone.length, `T4: and over the following days has added all of them (${scammerRows})`);
        const p = await profile(viewer, scammer);
        assert(p.status === 200 && keys(p.body).length === 0 && p.body?.mutualCount === 0,
            `T4: the viewer with 5 two-way friends sees no connection in common (${names(p.body).join(',') || 'none'}, ${p.body?.mutualCount})`);
        assert(p.body?.risk?.band === 'red', `T4: the band is red, not "In your circle" (${p.body?.risk?.band} ${p.body?.risk?.headline})`);
    }

    // T5 — sybils: A↔S1..S20, each Si has added T one-way. T's profile for A names none; for a third member who has
    // added every Si it names none either.
    {
        resetGatewayRateLimit();
        const a = member('t5-viewer'), t = member('t5-target'), c = member('t5-third');
        const sybils = Array.from({ length: 20 }, () => member('t5-sybil'));
        for (const s of sybils) { bothWays(a, s); oneWay(s, t); oneWay(c, s); }
        const p = await profile(a, t);
        assert(p.status === 200 && keys(p.body).length === 0 && p.body?.mutualCount === 0,
            `T5: 20 sybils friends both ways with A, each adding T: none named for A (${names(p.body).length})`);
        const q = await profile(c, t);
        const sybilKeys = new Set(sybils.map(s => s.pk));
        assert(q.status === 200 && !keys(q.body).some(k => sybilKeys.has(k)) && q.body?.mutualCount === 0,
            `T5: none named for a third member (${names(q.body).length})`);
    }

    // T6 — F↔A, F↔T1, F→T2 one-way: A sees F on T1 only. A one-way row of F's is never surfaced.
    {
        resetGatewayRateLimit();
        const a = member('t6-viewer'), f = member('t6-friend'), t1 = member('t6-target1'), t2 = member('t6-target2');
        bothWays(f, a); bothWays(f, t1); oneWay(f, t2);
        const p1 = await profile(a, t1), p2 = await profile(a, t2);
        assert(JSON.stringify(keys(p1.body)) === JSON.stringify([f.pk]), `T6: F is named on T1's profile (${names(p1.body).join(',')})`);
        assert(p2.status === 200 && keys(p2.body).length === 0, `T6: F is not named on T2's, whom F only added (${names(p2.body).join(',') || 'none'})`);
    }

    // T7 — A↔T names neither A nor T, even with a self row on each side (a row that can reach the table from a copy);
    // and a member's own profile names nobody.
    {
        resetGatewayRateLimit();
        const a = member('t7-viewer'), t = member('t7-target');
        bothWays(a, t); oneWay(a, a); oneWay(t, t);
        const p = await profile(a, t);
        assert(p.status === 200 && keys(p.body).length === 0 && p.body?.mutualCount === 0,
            `T7: friends both ways name neither the viewer nor the target (${names(p.body).join(',') || 'none'})`);
        const self = await profile(a, a);
        assert(self.status === 200 && keys(self.body).length === 0 && self.body?.mutualCount === 0,
            `T7: a member's own profile names nobody (${names(self.body).join(',') || 'none'})`);
    }

    // T8 — the route's guard is unchanged: a key that is no member here is refused, naming nobody (test-guest-view and
    // test-privacy-defaults hold the rest of it).
    {
        resetGatewayRateLimit();
        const a = member('t8-viewer'), f = member('t8-friend'), t = member('t8-target');
        bothWays(a, f); bothWays(f, t);
        const outsider = keypair('t8-outsider');
        const r = await profile(outsider, t);
        assert(r.status === 403 && !r.text.includes(f.callsign) && !r.text.includes(f.pk),
            `T8: a non-member signer is refused and named nobody (${r.status} ${r.text.slice(0, 80)})`);
        const ok = await profile(a, t);
        assert(ok.status === 200 && JSON.stringify(keys(ok.body)) === JSON.stringify([f.pk]), `T8: a member still reads it (${ok.status})`);
    }

    // T9 — two viewers of one target get their own answers, in either order: V1↔F↔T names F for V1; V2, who knows none
    // of them, gets nobody. A list kept per target and handed to the next viewer fails here (review finding 2, R2).
    {
        resetGatewayRateLimit();
        const v1 = member('t9-viewer1'), v2 = member('t9-viewer2'), f = member('t9-friend'), t = member('t9-target');
        bothWays(v1, f); bothWays(f, t);
        for (const order of [[v1, v2], [v2, v1]] as const) {
            const seen = new Map<string, any>();
            for (const v of order) seen.set(v.pk, (await profile(v, t)).body);
            const label = order[0] === v1 ? 'V1 then V2' : 'V2 then V1';
            assert(JSON.stringify(keys(seen.get(v1.pk))) === JSON.stringify([f.pk]) && seen.get(v1.pk)?.mutualCount === 1,
                `T9 ${label}: V1 sees F (${names(seen.get(v1.pk)).join(',') || 'none'})`);
            assert(keys(seen.get(v2.pk)).length === 0 && seen.get(v2.pk)?.mutualCount === 0 && seen.get(v2.pk)?.risk?.band === 'red',
                `T9 ${label}: V2 sees nobody, red (${names(seen.get(v2.pk)).join(',') || 'none'}, ${seen.get(v2.pk)?.risk?.band})`);
        }
    }

    // T10 — "show me as a connection in common", on by default: F turns it off with their own signed request and is
    // named to nobody, nor counted (V's band goes red); turned back on, F is named again. Only F reads the setting.
    {
        resetGatewayRateLimit();
        const v = member('t10-viewer'), f = member('t10-friend'), t = member('t10-target');
        bothWays(v, f); bothWays(f, t);
        const pref = (who: Id, on: boolean) => signed(who, 'POST', '/api/members/preferences', { publicKey: who.pk, preferences: { show_as_connection_in_common: on } });
        const readPrefs = (reader: Id, of: Id) => signed(reader, 'GET', `/api/members/preferences?publicKey=${of.pk}`, undefined);
        const before = await readPrefs(f, f);
        assert(before.status === 200 && before.body?.show_as_connection_in_common === 'true', `T10: on by default (${before.body?.show_as_connection_in_common})`);
        assert(JSON.stringify(keys((await profile(v, t)).body)) === JSON.stringify([f.pk]), 'T10: F is named while it is on');
        const off = await pref(f, false);
        assert(off.status === 200 && off.body?.success === true, `T10: F turns it off (${off.status} ${off.text.slice(0, 80)})`);
        const p = await profile(v, t);
        assert(p.status === 200 && keys(p.body).length === 0 && p.body?.mutualCount === 0 && p.body?.risk?.band === 'red',
            `T10: then F is named to nobody and not counted: red (${names(p.body).join(',') || 'none'}, ${p.body?.risk?.band})`);
        const own = await readPrefs(f, f), other = await readPrefs(v, f);
        assert(own.body?.show_as_connection_in_common === 'false', `T10: F reads it back off (${own.body?.show_as_connection_in_common})`);
        assert(!other.text.includes('show_as_connection_in_common'), `T10: another member never reads it (${other.status})`);
        const bad = await signed(f, 'POST', '/api/members/preferences', { publicKey: f.pk, preferences: { show_as_connection_in_common: 'no' } });
        assert(bad.status === 400, `T10: only true or false is taken (${bad.status})`);
        const on = await pref(f, true);
        assert(on.status === 200 && JSON.stringify(keys((await profile(v, t)).body)) === JSON.stringify([f.pk]), 'T10: turned back on, F is named again');
    }

    // Every actor above was a plain member: only the founder holds a role.
    const roled = (db.prepare('SELECT member_pubkey FROM node_roles').all() as { member_pubkey: string }[]).map(r => r.member_pubkey);
    assert(roled.length === 1 && roled[0] === founder?.pk, `every viewer, friend and target was a plain member: only the founder has a role (${roled.length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Trust profile connections-in-common checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
