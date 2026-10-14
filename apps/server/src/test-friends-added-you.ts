/**
 * Adding a friend is visible and bounded (PR-B of scratch/global-node/DESIGN-mutual-connections-fable.md §2):
 *   - the person added sees "added you · add back" (GET /api/friends/added-you, their own only), for new adds only;
 *   - a member adds at most 100 people a day (config/writer-limits.ts friendAddsPerDay), refused in words, never dropped,
 *     and adding and removing again frees nothing;
 *   - an add to someone the member blocked (member_blocks) is refused, saying so; an add from someone who blocked them
 *     answers as any add does, and the person who blocked them never sees it, so neither side is told of the block.
 * Every request goes through the real middleware, signed; rows a check only sets up are seeded straight into the tables.
 * Every actor is a plain member (invited by one founder, no role).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const OWN_NAME = 'added-you-community.example';
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
let founder: Id | null = null;
/** A plain member, invited by the founder (who alone holds `owner`). */
function member(prefix: string): Id {
    if (!founder) { founder = keypair('founder'); seedGenesisMember(founder.pk, founder.callsign); }
    const id = keypair(`${prefix}-${String(++memberNo).padStart(3, '0')}`);
    if (!registerMemberInternal(broadcast, id.pk, id.callsign, founder.pk, null)) throw new Error(`could not join ${id.callsign}`);
    return id;
}

let sent = 0;
async function signed(signer: Id, method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
    // The per-minute gateway limiter is not what is tested here.
    if (++sent % 100 === 0) resetGatewayRateLimit();
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
const add = (owner: Id, friend: Id) => signed(owner, 'POST', '/api/friends/add', { friendPubkey: friend.pk });
const remove = (owner: Id, friend: Id) => signed(owner, 'POST', '/api/friends/remove', { friendPubkey: friend.pk });
const addedYou = (who: Id) => signed(who, 'GET', '/api/friends/added-you');
const block = (owner: Id, target: Id) => signed(owner, 'POST', '/api/blocks', { targetPubkey: target.pk });
const keysOf = (r: { body: any }): string[] => (r.body?.addedYou ?? []).map((x: any) => x.publicKey);
const hasRow = (a: Id, b: Id) => !!db.prepare('SELECT 1 FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?').get(a.pk, b.pk);

async function main() {
    console.log('Running "added you", the add cap and blocked adds...');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // A1 — A adds B: B sees A, with a face and when; A's own list doesn't show B; a third member sees nothing of it.
    {
        resetGatewayRateLimit();
        const a = member('a1-adder'), b = member('a1-added'), c = member('a1-third');
        db.prepare('UPDATE members SET avatar_ref = ? WHERE public_key = ?').run('ref-a1', a.pk);
        const r = await add(a, b);
        assert(r.status === 200 && r.body?.success === true, `A1: A adds B through the signed route (${r.status})`);
        const seen = await addedYou(b);
        const line = seen.body?.addedYou?.[0];
        assert(seen.status === 200 && JSON.stringify(keysOf(seen)) === JSON.stringify([a.pk]) && seen.body?.more === 0,
            `A1: B's People tab says A added them (${seen.status} ${JSON.stringify(keysOf(seen).map(k => k.slice(0, 6)))})`);
        assert(line?.callsign === a.callsign && typeof line?.avatarUrl === 'string' && line.avatarUrl.includes('ref-a1')
            && Number.isFinite(Date.parse(line?.addedAt)), `A1: with A's name, face and when (${line?.callsign})`);
        const own = await addedYou(a), third = await addedYou(c);
        assert(own.status === 200 && keysOf(own).length === 0, `A1: A's own list doesn't show B, whom A added (${keysOf(own).length})`);
        assert(third.status === 200 && keysOf(third).length === 0 && !third.text.includes(a.pk) && !third.text.includes(b.pk),
            `A1: a third member reads only their own, empty (${keysOf(third).length})`);
        const unsigned = await localFetch(`${BASE}/api/friends/added-you`, { headers: { Accept: 'application/json' } });
        const unsignedText = await unsigned.text();
        assert(unsigned.status === 401 && !unsignedText.includes(a.pk), `A1: an unsigned read is refused (${unsigned.status})`);
    }

    // A2 — B adds A back: gone from B's tab (a friendship both ways now), and A never sees B as news.
    {
        resetGatewayRateLimit();
        const a = member('a2-adder'), b = member('a2-added');
        await add(a, b);
        assert(JSON.stringify(keysOf(await addedYou(b))) === JSON.stringify([a.pk]), 'A2: B sees A before adding back');
        const back = await add(b, a);
        assert(back.status === 200 && back.body?.success === true, `A2: B adds A back (${back.status})`);
        assert(keysOf(await addedYou(b)).length === 0, 'A2: then B sees no line for A');
        assert(keysOf(await addedYou(a)).length === 0, 'A2: and A, who added first, sees none for B');
    }

    // A3 — new adds only: a row from before this server first told anyone is never news, a new add is.
    {
        resetGatewayRateLimit();
        const old = member('a3-old'), fresh = member('a3-fresh'), b = member('a3-added');
        db.prepare("DELETE FROM node_config WHERE key = 'friendsAddedYouSince'").run();
        db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?)')
            .run(old.pk, b.pk, new Date(Date.now() - 60_000).toISOString());
        const before = await addedYou(b);
        assert(before.status === 200 && keysOf(before).length === 0, `A3: an add from before the feature is not shown (${keysOf(before).length})`);
        await add(fresh, b);
        const after = await addedYou(b);
        assert(JSON.stringify(keysOf(after)) === JSON.stringify([fresh.pk]), `A3: a new add is (${keysOf(after).length})`);
        // 30 days on, it has gone (the stamp moved back too, and the row from before it taken out, so only the 30 days
        // can hide it).
        db.prepare('DELETE FROM friends WHERE owner_pubkey = ? AND friend_pubkey = ?').run(old.pk, b.pk);
        db.prepare('UPDATE friends SET added_at = ? WHERE owner_pubkey = ? AND friend_pubkey = ?')
            .run(new Date(Date.now() + 1000 - 31 * 24 * 3600 * 1000).toISOString(), fresh.pk, b.pk);
        db.prepare("UPDATE node_config SET value = ? WHERE key = 'friendsAddedYouSince'").run(new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString());
        assert(keysOf(await addedYou(b)).length === 0, 'A3: an add 31 days old is no longer shown');
        // And a read comes with no-store: it is one member's own.
        const res = await localFetch(`${BASE}/api/friends/added-you`, {
            headers: { Accept: 'application/json', ...(await buildBoundRequestHeaders({ method: 'GET', url: `https://${OWN_NAME}/api/friends/added-you`, body: '', publicKeyHex: b.pk, sign: ed25519Signer(b.seed) })) },
        });
        await res.text();
        assert(/no-store/.test(res.headers.get('cache-control') ?? ''), `A3: answered no-store (${res.headers.get('cache-control')})`);
    }

    // A4 — blocks. B blocked A: A's add of B answers as A's add of anyone (engine/member-blocks.ts: the blocked member is
    // never told, and nothing they can read changes), and B's tab never shows A. B's add of A is refused saying B blocked
    // them. An add from before the block leaves B's tab.
    {
        resetGatewayRateLimit();
        const a = member('a4-a'), b = member('a4-b'), c = member('a4-c'), early = member('a4-early');
        await add(early, b);
        assert(JSON.stringify(keysOf(await addedYou(b))) === JSON.stringify([early.pk]), 'A4: B sees an earlier add before blocking');
        const blocked = await block(b, a), blockedEarly = await block(b, early);
        assert(blocked.status === 200 && blockedEarly.status === 200, `A4: B blocks A and the earlier adder (${blocked.status}, ${blockedEarly.status})`);
        assert(keysOf(await addedYou(b)).length === 0, 'A4: an add by someone B blocked leaves B\'s tab');

        const toAnyone = await add(a, c);
        const fromBlocked = await add(a, b);
        // Everything A reads of the answer but whose name and face it is.
        const shape = (r: { status: number; body: any }, who: Id) => JSON.stringify({
            status: r.status, keys: Object.keys(r.body ?? {}).sort(), friendKeys: Object.keys(r.body?.friend ?? {}).sort(),
            success: r.body?.success, isGuardian: r.body?.friend?.isGuardian, isWho: r.body?.friend?.publicKey === who.pk,
        });
        assert(fromBlocked.status === 200 && hasRow(a, b) && shape(fromBlocked, b) === shape(toAnyone, c),
            `A4: A's add of B, who blocked A, answers as A's add of C, with a row (${shape(fromBlocked, b)} | ${shape(toAnyone, c)})`);
        const aFriends = await signed(a, 'GET', `/api/friends/${a.pk}`);
        const aKeys = (aFriends.body ?? []).map((f: any) => f.publicKey);
        assert(aFriends.status === 200 && aKeys.includes(b.pk) && aKeys.includes(c.pk), 'A4: and A\'s own list shows B as it shows C');
        assert(!keysOf(await addedYou(b)).includes(a.pk), 'A4: and B\'s tab never shows A');
        const again = await add(a, b);
        assert(again.status === 200 && !keysOf(await addedYou(b)).includes(a.pk), 'A4: nor after A adds B again');
        const toBlocked = await add(b, a);
        assert(toBlocked.status === 400 && toBlocked.body?.code === 'blocked' && /blocked them/.test(toBlocked.body?.error ?? '') && !hasRow(b, a),
            `A4: B cannot add A, whom B blocked, and is told why (${toBlocked.status} ${toBlocked.body?.error})`);
        assert(keysOf(await addedYou(a)).length === 0, 'A4: and A is told nothing');
    }

    // A5 — 100 adds a day. The 101st is refused with when it lets up, and writes nothing. Adding someone already added
    // still answers; removing one and adding someone new frees nothing.
    {
        resetGatewayRateLimit();
        const c = member('a5-adder');
        const people = Array.from({ length: 102 }, () => member('a5-person'));
        let ok = 0;
        for (const p of people.slice(0, 100)) if ((await add(c, p)).status === 200) ok++;
        assert(ok === 100, `A5: 100 adds in a day go through (${ok})`);
        const over = await add(c, people[100]);
        assert(over.status === 429 && over.body?.code === 'friend_adds_per_day' && /You can add 100 people in any 24 hours/.test(over.body?.error ?? '')
            && Number.isFinite(Date.parse(over.body?.resetsAt)), `A5: the 101st is refused in words, with when (${over.status} ${over.body?.error})`);
        assert(!hasRow(c, people[100]), 'A5: and is not written');
        const again = await add(c, people[0]);
        assert(again.status === 200 && again.body?.success === true, `A5: adding someone already added still answers (${again.status})`);
        const rm = await remove(c, people[1]);
        const afterRemove = await add(c, people[101]);
        assert(rm.status === 200 && afterRemove.status === 429 && !hasRow(c, people[101]),
            `A5: removing one and adding someone new frees nothing (${rm.status}, ${afterRemove.status})`);
        const readd = await add(c, people[1]);
        assert(readd.status === 429 && !hasRow(c, people[1]), `A5: nor does adding back the one removed (${readd.status})`);
        // A day on, there is room again.
        db.prepare("UPDATE friends SET added_at = ? WHERE owner_pubkey = ?").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), c.pk);
        db.prepare("UPDATE tombstones SET deleted_at = ? WHERE table_name = 'friends' AND row_key LIKE ?").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString(), `${c.pk}|%`);
        const nextDay = await add(c, people[100]);
        assert(nextDay.status === 200 && hasRow(c, people[100]), `A5: a day later there is room again (${nextDay.status})`);
    }

    // A6 — at most 20 named, newest first, and how many more.
    {
        resetGatewayRateLimit();
        const d = member('a6-added');
        const adders = Array.from({ length: 25 }, () => member('a6-adder'));
        for (const a of adders) await add(a, d);
        adders.forEach((a, i) => db.prepare('UPDATE friends SET added_at = ? WHERE owner_pubkey = ? AND friend_pubkey = ?')
            .run(new Date(Date.now() - (25 - i) * 1000).toISOString(), a.pk, d.pk));
        const r = await addedYou(d);
        const want = adders.slice().reverse().slice(0, 20).map(a => a.pk);
        assert(r.status === 200 && JSON.stringify(keysOf(r)) === JSON.stringify(want) && r.body?.more === 5,
            `A6: the newest 20 of 25, newest first, and 5 more (${keysOf(r).length}, more ${r.body?.more})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Added-you, add cap and blocked-add checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
