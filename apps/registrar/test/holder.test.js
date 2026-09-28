// "Who holds this name?" (POST /api/registrar/holder) and the admin's release that holds a name 30 days for its key
// unless the admin frees it now (decision D-C, Marty 2026-09-28). Design: scratch/registrar/DESIGN-lost-name-audience-opus.md
// §5 and §8 (L2). A node whose name may have changed hands asks /holder; it drops a name only when this answer names
// another key AND that key answers at the name (L3, the node's side), so every answer here must say exactly what the
// registrar's own ownership rules (holdsName, isOwnRow, policyTier) say, and asking must change nothing.
//
// The same world as ownership-states.test.js (test/harness.js): the Worker against an in-memory SQLite loaded with the
// migrations, and a fake Cloudflare. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker, { attestSweep } from '../src/index.js';
import { nowS, toHex, world, liveName, makeKey, routing } from './harness.js';

const DAY = 86400;
const COOLOFF = 30 * DAY;

// Every table, row by row: what a read-only request must leave exactly as it found it.
const everything = (w) => Object.fromEntries(
    w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map(({ name }) => [name, w.sqlite.prepare(`SELECT * FROM "${name}"`).all().map((r) => ({ ...r }))]));

// A request signed by `key` over (method, signedPath, ts, text), sent to `sentPath` with `text` as its body.
async function signedRaw(key, { method = 'POST', signedPath = '/api/registrar/holder', sentPath = signedPath, text, ts = nowS(), pubHex = key.pubHex }) {
    const message = `beanpool-registrar-request/v1\n${method}\n${signedPath}\n${ts}\n${text}`;
    const signature = toHex(await crypto.subtle.sign('Ed25519', key.keyPair.privateKey, new TextEncoder().encode(message)));
    return new Request(`https://beanpool.org${sentPath}`, {
        method, body: text || undefined,
        headers: { 'content-type': 'application/json', 'x-bp-pubkey': pubHex, 'x-bp-timestamp': String(ts), 'x-bp-signature': signature },
    });
}
const send = async (w, req) => { const res = await worker.fetch(req, w.env); return { status: res.status, body: await res.json() }; };

// ── /holder ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('holder: another key\'s live, paused, blocked or pending row is `other`, with that key; the asker\'s own is `you`', async () => {
    const w = await world();
    try {
        const [owner, asker, gated] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'riverside', owner);
        const { requested_at: since } = await w.row('riverside');
        const theirs = (state) => ({ name: 'riverside', held: 'other', holder_key: owner.pubHex, state, since });
        const mine = (state) => ({ name: 'riverside', held: 'you', state, since });

        const r = await w.holder(asker, { name: 'riverside' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body, theirs('live'));
        assert.deepEqual((await w.holder(owner, { name: 'riverside' })).body, mine('live'), 'the owner hears its own name, and no key');

        // Paused, for every reason a pause has: the name is still its key's.
        assert.equal((await w.admin('riverside', 'pause')).body.status, 'paused');
        for (const reason of ['admin', 'impostor', 'unverified', 'incident-2026-09-24']) {
            await w.backdate('riverside', { pause_reason: reason });
            assert.deepEqual((await w.holder(asker, { name: 'riverside' })).body, theirs('paused'), reason);
            assert.deepEqual((await w.holder(owner, { name: 'riverside' })).body, mine('paused'), reason);
        }
        await w.backdate('riverside', { pause_reason: 'admin' });

        // Blocked: held, never free.
        assert.equal((await w.admin('riverside', 'block')).body.status, 'blocked');
        assert.deepEqual((await w.holder(asker, { name: 'riverside' })).body, theirs('blocked'));
        assert.deepEqual((await w.holder(owner, { name: 'riverside' })).body, mine('blocked'));

        // Pending: a gated claim waiting for the admin already keeps the name from other keys (their claim is 409).
        assert.equal((await w.claim(gated, { name: 'sydney' })).body.status, 'pending');
        const pending = await w.row('sydney');
        assert.equal((await w.claim(asker, { name: 'sydney' })).status, 409);
        assert.deepEqual((await w.holder(asker, { name: 'sydney' })).body,
            { name: 'sydney', held: 'other', holder_key: gated.pubHex, state: 'pending', since: pending.requested_at });
        assert.deepEqual((await w.holder(gated, { name: 'sydney' })).body,
            { name: 'sydney', held: 'you', state: 'pending', since: pending.requested_at });

        // A legacy 'revoked' row (the old Worker's): holdsName treats a state it doesn't know as held.
        await liveName(w, 'oldrow', owner);
        await w.backdate('oldrow', { status: 'revoked' });
        assert.equal((await w.holder(asker, { name: 'oldrow' })).body.held, 'other');
        assert.equal((await w.holder(asker, { name: 'oldrow' })).body.holder_key, owner.pubHex);
        assert.equal((await w.holder(owner, { name: 'oldrow' })).body.held, 'you');
    } finally { w.restore(); }
});

test('holder: a released name is its key\'s through the hold; past it, abandoned, freed at once or unknown, it is free', async () => {
    const w = await world();
    try {
        const [owner, asker] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'lakeside', owner);
        const rel = await w.release(owner, { name: 'lakeside' });
        const row = await w.row('lakeside');
        const heldUntil = row.released_at + COOLOFF;
        assert.equal(rel.body.held_until, heldUntil);

        // Inside its hold: the releasing key's own ("I clicked the wrong button"), another key's to everyone else.
        assert.deepEqual((await w.holder(owner, { name: 'lakeside' })).body,
            { name: 'lakeside', held: 'you', state: 'released', since: row.requested_at, held_until: heldUntil });
        assert.deepEqual((await w.holder(asker, { name: 'lakeside' })).body,
            { name: 'lakeside', held: 'other', holder_key: owner.pubHex, state: 'released', since: row.requested_at, held_until: heldUntil });

        // One minute short of 30 days, still held.
        await w.backdate('lakeside', { released_at: nowS() - COOLOFF + 60 });
        assert.equal((await w.holder(owner, { name: 'lakeside' })).body.held, 'you');
        assert.equal((await w.holder(asker, { name: 'lakeside' })).body.held, 'other');

        // Past the hold: free, to the old key as to anyone — and nobody's key is named.
        await w.backdate('lakeside', { released_at: nowS() - COOLOFF - 1 });
        for (const k of [owner, asker]) assert.deepEqual((await w.holder(k, { name: 'lakeside' })).body, { name: 'lakeside', held: 'free' });
        assert.equal((await w.available('lakeside')).body.available, true, 'the same answer a claim would get');

        // Abandoned: free.
        await liveName(w, 'quietvale', owner);
        await w.backdate('quietvale', { status: 'abandoned' });
        for (const k of [owner, asker]) assert.deepEqual((await w.holder(k, { name: 'quietvale' })).body, { name: 'quietvale', held: 'free' });

        // Freed at once: a gated claim its key withdrew before the admin approved it.
        assert.equal((await w.claim(owner, { name: 'cairns' })).body.status, 'pending');
        assert.equal((await w.release(owner, { name: 'cairns' })).body.status, 'released');
        assert.equal((await w.row('cairns')).pause_reason, 'withdrawn');
        for (const k of [owner, asker]) assert.deepEqual((await w.holder(k, { name: 'cairns' })).body, { name: 'cairns', held: 'free' });

        // A name nobody ever claimed, gated or not, is free (a gated claim then waits for the admin; nobody holds it).
        for (const name of ['nobodyhere', 'melbourne']) {
            for (const k of [owner, asker]) assert.deepEqual((await w.holder(k, { name })).body, { name, held: 'free' });
        }
        // The name is a label, in any case.
        assert.deepEqual((await w.holder(asker, { name: 'LakeSide' })).body, { name: 'lakeside', held: 'free' });
    } finally { w.restore(); }
});

test('holder: a policy-blocked name nobody holds is `reserved`; a row on one still says who holds it', async () => {
    const w = await world();
    try {
        const [owner, asker] = await Promise.all([makeKey(), makeKey()]);
        // Our fleet's names (0001, 0005) and the system ones.
        for (const name of ['mullum', 'castlemaine', 'global', 'earth', 'ssh-global', 'www']) {
            const r = await w.holder(asker, { name });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.deepEqual(r.body, { name, held: 'reserved' }, name);
        }

        // A key that claimed a name before the admin reserved it still holds it (its claim is still a heal).
        await liveName(w, 'hilltop', owner);
        const { requested_at: since } = await w.row('hilltop');
        w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES ('hilltop', 'blocked')").run();
        assert.deepEqual((await w.holder(owner, { name: 'hilltop' })).body, { name: 'hilltop', held: 'you', state: 'live', since });
        assert.deepEqual((await w.holder(asker, { name: 'hilltop' })).body, { name: 'hilltop', held: 'other', holder_key: owner.pubHex, state: 'live', since });

        // Once nobody holds it, policy decides: reserved, to its old key too.
        await w.release(owner, { name: 'hilltop' });
        await w.backdate('hilltop', { released_at: nowS() - COOLOFF - 1 });
        for (const k of [owner, asker]) assert.deepEqual((await w.holder(k, { name: 'hilltop' })).body, { name: 'hilltop', held: 'reserved' });
    } finally { w.restore(); }
});

test('holder: signed like status — a bad, missing, stale or re-aimed signature is 401, and the name is inside the signed bytes', async () => {
    const w = await world();
    try {
        const [owner, asker, stranger] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'riverside', owner);
        const before = everything(w);
        const text = JSON.stringify({ name: 'riverside' });
        const refused = { error: 'bad signature', accepted_proto: ['v1'] };

        // The good request first, so each refusal below differs from it in one thing only.
        assert.equal((await send(w, await signedRaw(asker, { text }))).body.held, 'other');

        const bad = {
            unsigned: new Request('https://beanpool.org/api/registrar/holder', { method: 'POST', body: text, headers: { 'content-type': 'application/json' } }),
            // Signed for one name, sent asking about another: the body is inside the signed bytes.
            'another name': await (async () => {
                const r = await signedRaw(asker, { text: JSON.stringify({ name: 'lakeside' }) });
                return new Request(r.url, { method: 'POST', headers: r.headers, body: text });
            })(),
            // Another route's signature replayed at /holder: /status's (method and path), and a claim's for this very body.
            'status signature': await (async () => {
                const r = await signedRaw(asker, { method: 'GET', signedPath: '/api/registrar/status', text: '' });
                return new Request('https://beanpool.org/api/registrar/holder', { method: 'POST', headers: r.headers, body: text });
            })(),
            'claim signature': await signedRaw(asker, { signedPath: '/api/registrar/claim', sentPath: '/api/registrar/holder', text }),
            // Signed by one key, claiming to be another.
            'someone else\'s key': await signedRaw(asker, { text, pubHex: stranger.pubHex }),
            // Outside the 5-minute window.
            stale: await signedRaw(asker, { text, ts: nowS() - 3600 }),
            // A protocol this Worker doesn't speak.
            'unknown proto': await (async () => {
                const r = await signedRaw(asker, { text });
                const headers = new Headers(r.headers); headers.set('x-bp-proto', 'v9');
                return new Request(r.url, { method: 'POST', headers, body: text });
            })(),
        };
        for (const [what, req] of Object.entries(bad)) {
            const r = await send(w, req);
            assert.equal(r.status, 401, `${what}: ${JSON.stringify(r.body)}`);
            assert.deepEqual(r.body, refused, what);
        }
        assert.deepEqual(everything(w), before, 'a refused ask changed nothing');
    } finally { w.restore(); }
});

test('holder: read-only — no write (not even the contact /status records), nothing at Cloudflare, no node asked', async () => {
    const w = await world();
    try {
        const [owner, asker] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'orchard', owner);
        await liveName(w, 'lakeside', owner);
        await w.release(owner, { name: 'lakeside' });
        // Contact long ago and a warning served: a request that recorded contact would change both.
        await w.backdate('orchard', { last_contact_at: 1, warned_at: 2 });
        let asked = 0;
        const answer = w.nodes['orchard.beanpool.org'];
        w.nodes['orchard.beanpool.org'] = (nonce) => { asked++; return answer(nonce); };

        const before = everything(w);
        const calls = w.cf.calls.length;
        const writes = w.writes();
        for (const k of [owner, asker]) {
            for (const name of ['orchard', 'lakeside', 'nobodyhere', 'mullum']) assert.equal((await w.holder(k, { name })).status, 200);
        }
        assert.deepEqual(everything(w), before, 'nothing in the database changed');
        assert.equal(w.writes(), writes, 'no write was even attempted');
        assert.equal(w.cf.calls.length, calls, 'nothing asked of Cloudflare');
        assert.equal(asked, 0, 'no node asked');
    } finally { w.restore(); }
});

test('holder: a malformed ask is 400 and changes nothing; only POST is a route', async () => {
    const w = await world();
    try {
        const asker = await makeKey();
        const before = everything(w);
        for (const body of [{}, { name: '' }, { name: 'ab' }, { name: '-bad' }, { name: 'bad-' }, { name: 'a'.repeat(33) },
            { name: 'riverside.beanpool.org' }, { name: 'under_score' }, { name: 42 }, { name: ['riverside'] }, 'riverside', null]) {
            const r = await w.holder(asker, body);
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.match(r.body.error, /invalid name/, JSON.stringify(body));
        }
        const notJson = await send(w, await signedRaw(asker, { text: 'name=riverside' }));
        assert.equal(notJson.status, 400);
        assert.deepEqual(notJson.body, { error: 'bad json' });
        // GET (a name in the query would be outside the signed bytes) is not a route.
        const get = await send(w, await signedRaw(asker, { method: 'GET', text: '' }));
        assert.equal(get.status, 404);
        assert.deepEqual(everything(w), before);
    } finally { w.restore(); }
});

// ── Decision D-C: the admin's release holds the name too ──────────────────────────────────────────────────────────

test('D-C: the admin\'s release holds the name 30 days — another key can\'t claim it, its own key can take it back', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'meadow', owner);
        const first = await w.row('meadow');

        const rel = await w.admin('meadow', 'release');
        assert.equal(rel.status, 200, JSON.stringify(rel.body));
        let row = await w.row('meadow');
        assert.equal(row.status, 'released');
        assert.equal(row.pause_reason, 'admin-held');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.deepEqual(rel.body, { status: 'released', name: 'meadow', held_until: row.released_at + COOLOFF });
        assert.deepEqual(routing(w, 'meadow'), { dns: null, tunnels: [] }, 'routing goes, as with any release');
        assert.match(w.events('meadow').at(-1).detail, /released by the admin \(was live\): held 30 days for key/);

        // Held: taken to everyone else.
        assert.deepEqual((await w.available('meadow')).body, { available: false, reason: 'taken', tier: 'auto' });
        const grab = await w.claim(other, { name: 'meadow' });
        assert.equal(grab.status, 409);
        assert.deepEqual(grab.body, { error: 'name taken', owner: 'other' });
        assert.equal((await w.row('meadow')).node_pubkey, owner.pubHex);
        assert.deepEqual((await w.holder(other, { name: 'meadow' })).body,
            { name: 'meadow', held: 'other', holder_key: owner.pubHex, state: 'released', since: first.requested_at, held_until: row.released_at + COOLOFF });
        assert.equal((await w.holder(owner, { name: 'meadow' })).body.held, 'you');
        // Its node hears the hold, as it does after its own release.
        const st = await w.status(owner);
        assert.equal(st.body.status, 'released');
        assert.equal(st.body.reason, 'admin-held');
        assert.equal(st.body.held_until, row.released_at + COOLOFF);

        // The same release again, without "free now", changes nothing: the hold runs from the first.
        const again = await w.admin('meadow', 'release');
        assert.deepEqual(again.body, rel.body);
        assert.deepEqual(await w.row('meadow'), row);

        // Its own key takes it back inside the hold (a misclick, undone by its node's next claim).
        const back = await w.claim(owner, { name: 'meadow' });
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(back.body.status, 'live');
        row = await w.row('meadow');
        assert.equal(row.node_pubkey, owner.pubHex);
        assert.equal(row.released_at, null);
        assert.equal(back.body.tunnelToken, `token-${row.tunnel_id}`);
        assert.notEqual(row.tunnel_id, first.tunnel_id, 'a fresh tunnel');
        assert.deepEqual(w.events('meadow').map((e) => e.event), ['claimed', 'released', 'claimed']);

        // Released by the admin again, and the hold runs out: then another key may have it.
        await w.admin('meadow', 'release');
        await w.backdate('meadow', { released_at: nowS() - COOLOFF + 60 });
        assert.equal((await w.claim(other, { name: 'meadow' })).status, 409);
        await w.backdate('meadow', { released_at: nowS() - COOLOFF - 1 });
        assert.deepEqual((await w.available('meadow')).body, { available: true, reason: 'free', tier: 'auto' });
        assert.deepEqual((await w.holder(other, { name: 'meadow' })).body, { name: 'meadow', held: 'free' });
        const taken = await w.claim(other, { name: 'meadow' });
        assert.equal(taken.body.status, 'live');
        assert.equal((await w.row('meadow')).node_pubkey, other.pubHex);
    } finally { w.restore(); }
});

test('D-C: an approved gated name the admin released without "free now" is taken back live; with it, its key waits again', async () => {
    const w = await world();
    try {
        const owner = await makeKey();
        assert.equal((await w.claim(owner, { name: 'perth' })).body.status, 'pending');   // gated in the 0001 seed
        assert.equal((await w.admin('perth', 'approve')).body.status, 'live');

        assert.equal((await w.admin('perth', 'release')).body.status, 'released');
        const back = await w.claim(owner, { name: 'perth' });
        assert.equal(back.body.status, 'live', 'held for its key, approval and all');

        assert.equal((await w.admin('perth', 'release', { free_now: true })).body.status, 'released');
        assert.equal((await w.claim(owner, { name: 'perth' })).body.status, 'pending', 'freed: its old key is just another claimant');
    } finally { w.restore(); }
});

test('D-C: "free now" frees the name at once, to any key — also a release already held, the owner\'s or the admin\'s', async () => {
    const w = await world();
    try {
        const [owner, other] = await Promise.all([makeKey(), makeKey()]);

        // A live name, freed now.
        await liveName(w, 'crossing', owner);
        const rel = await w.admin('crossing', 'release', { free_now: true });
        assert.equal(rel.status, 200, JSON.stringify(rel.body));
        assert.deepEqual(rel.body, { status: 'released', name: 'crossing' });
        assert.equal((await w.row('crossing')).pause_reason, 'admin');
        assert.deepEqual(routing(w, 'crossing'), { dns: null, tunnels: [] });
        assert.match(w.events('crossing').at(-1).detail, /released by the admin \(was live\): free now/);
        const st = await w.status(owner);
        assert.equal(st.body.status, 'released');
        assert.equal(st.body.held_until, undefined, 'no hold');
        for (const k of [owner, other]) assert.deepEqual((await w.holder(k, { name: 'crossing' })).body, { name: 'crossing', held: 'free' });
        assert.deepEqual((await w.available('crossing')).body, { available: true, reason: 'free', tier: 'auto' });
        assert.equal((await w.claim(other, { name: 'crossing' })).body.status, 'live');

        // Its owner's own release, held: "Free now" ends the hold.
        await liveName(w, 'ferry', owner);
        await w.release(owner, { name: 'ferry' });
        assert.equal((await w.admin('ferry', 'release')).body.held_until, (await w.row('ferry')).released_at + COOLOFF, 'without the box: still held');
        assert.equal((await w.row('ferry')).pause_reason, 'owner');
        assert.equal((await w.claim(other, { name: 'ferry' })).status, 409);
        assert.deepEqual((await w.admin('ferry', 'release', { free_now: true })).body, { status: 'released', name: 'ferry' });
        assert.deepEqual((await w.holder(other, { name: 'ferry' })).body, { name: 'ferry', held: 'free' });
        assert.equal((await w.claim(other, { name: 'ferry' })).body.status, 'live');

        // The admin's own held release, freed now.
        await liveName(w, 'wharf', owner);
        await w.admin('wharf', 'release');
        assert.equal((await w.claim(other, { name: 'wharf' })).status, 409);
        assert.deepEqual((await w.admin('wharf', 'release', { free_now: true })).body, { status: 'released', name: 'wharf' });
        assert.equal((await w.claim(other, { name: 'wharf' })).body.status, 'live');
        assert.deepEqual(w.events('wharf').map((e) => e.event), ['claimed', 'released', 'released', 'claimed']);

        // Only `true` frees now: anything else is the default, the hold.
        await liveName(w, 'jetty', owner);
        await w.admin('jetty', 'release', { free_now: 'yes' });
        assert.equal((await w.row('jetty')).pause_reason, 'admin-held');
        // A body that isn't JSON is refused, and nothing is done.
        await liveName(w, 'pier', owner);
        const before = await w.row('pier');
        const res = await worker.fetch(new Request('https://beanpool.org/api/local/admin/registrar/pier/release', {
            method: 'POST', headers: { 'x-admin-secret': 'test-admin-secret' }, body: 'free_now',
        }), w.env);
        assert.equal(res.status, 400);
        assert.deepEqual(await w.row('pier'), before);
    } finally { w.restore(); }
});

test('D-C: the admin rejecting a gated claim nobody approved frees the name at once — the key never held it', async () => {
    const w = await world();
    try {
        const [first, second] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(first, { name: 'sydney' })).body.status, 'pending');   // gated in the 0001 seed
        const rej = await w.admin('sydney', 'release');                                    // no "free now"
        assert.deepEqual(rej.body, { status: 'released', name: 'sydney' });
        assert.equal((await w.row('sydney')).pause_reason, 'admin');
        for (const k of [first, second]) assert.deepEqual((await w.holder(k, { name: 'sydney' })).body, { name: 'sydney', held: 'free' });
        assert.equal((await w.claim(second, { name: 'sydney' })).body.status, 'pending');
        assert.equal((await w.row('sydney')).node_pubkey, second.pubHex);
    } finally { w.restore(); }
});

// ── Block's promise holds through a release (r4117740868) ─────────────────────────────────────────────────────────
// The names page offers Release only on a blocked row. Its default release must never hand the name back to the key
// the admin blocked: it holds the name 30 days from EVERY key, that one included, then it is free. "Free now" frees it
// at once. The same for a name the admin paused. A community's own release keeps D-C's meaning (the tests above).

// What the blocked key's node gets, trying every way it has to get the name back, and what every other key gets.
async function nobodyMayClaim(w, name, blocked, other) {
    const before = await w.row(name);
    const refused = { error: 'name blocked' };
    const tries = {
        claim: await w.claim(blocked, { name }),
        'claim, direct': await w.claim(blocked, { name, mode: 'direct', public_ip: '198.51.100.7' }),
        heal: await w.heal(blocked, { name }),
        'heal, no name': await w.heal(blocked),
        release: await w.release(blocked, { name }),
        offline: await w.release(blocked, {}, '/api/registrar/offline'),
    };
    for (const [what, r] of Object.entries(tries)) {
        assert.equal(r.status, 403, `the blocked key's ${what}: ${JSON.stringify(r.body)}`);
        assert.deepEqual(r.body, refused, `the blocked key's ${what}`);
    }
    const grab = await w.claim(other, { name });
    assert.equal(grab.status, 409, JSON.stringify(grab.body));
    assert.deepEqual(grab.body, { error: 'name taken', owner: 'other' });
    assert.equal((await w.available(name)).body.available, false);
    assert.deepEqual(await w.row(name), before, 'nothing moved');
    assert.deepEqual(routing(w, name), { dns: null, tunnels: [] }, 'nothing routed');
    // Who holds it: to the blocked key, nobody it may claim; to anyone else, the key of the row that holds it.
    assert.deepEqual((await w.holder(blocked, { name })).body, { name, held: 'reserved' });
    const theirs = (await w.holder(other, { name })).body;
    assert.equal(theirs.held, 'other');
    assert.equal(theirs.holder_key, blocked.pubHex);
}

test('a blocked name released without "free now" is held 30 days from EVERY key, the blocked one included; then it is free', async () => {
    const w = await world();
    try {
        const [blocked, other, later] = await Promise.all([makeKey(), makeKey(), makeKey()]);
        await liveName(w, 'thornfield', blocked);
        assert.equal((await w.admin('thornfield', 'block')).body.status, 'blocked');

        // Release, as the names page sends it with its box unticked.
        const rel = await w.admin('thornfield', 'release', { free_now: false });
        assert.equal(rel.status, 200, JSON.stringify(rel.body));
        const row = await w.row('thornfield');
        assert.equal(row.status, 'released');
        assert.equal(row.pause_reason, 'admin-held-all');
        assert.equal(row.node_pubkey, blocked.pubHex);
        const heldUntil = row.released_at + COOLOFF;
        assert.deepEqual(rel.body, { status: 'released', name: 'thornfield', reason: 'admin-held-all', held_until: heldUntil });
        assert.match(w.events('thornfield').at(-1).detail,
            /^released by the admin \(was blocked\): held 30 days from every key, its own \S+ included, then free$/);

        await nobodyMayClaim(w, 'thornfield', blocked, other);
        // Its node hears the admin's release, and no hold it could take the name back inside.
        const st = await w.status(blocked);
        assert.equal(st.body.status, 'released');
        assert.equal(st.body.reason, 'admin-held-all');
        assert.equal(st.body.held_until, undefined, 'nothing for this key to take back');

        // The same release again, without "free now", changes nothing: the hold runs from the first.
        assert.deepEqual((await w.admin('thornfield', 'release')).body, rel.body);
        assert.deepEqual(await w.row('thornfield'), row);
        // Nor does the sweep, however often it runs.
        await attestSweep(w.env); await attestSweep(w.env);
        assert.deepEqual(await w.row('thornfield'), row);

        // One minute short of 30 days: still held from every key.
        await w.backdate('thornfield', { released_at: nowS() - COOLOFF + 60 });
        await nobodyMayClaim(w, 'thornfield', blocked, other);

        // Past the hold: free, to anyone.
        await w.backdate('thornfield', { released_at: nowS() - COOLOFF - 1 });
        assert.deepEqual((await w.available('thornfield')).body, { available: true, reason: 'free', tier: 'auto' });
        for (const k of [blocked, other]) assert.deepEqual((await w.holder(k, { name: 'thornfield' })).body, { name: 'thornfield', held: 'free' });
        const taken = await w.claim(other, { name: 'thornfield' });
        assert.equal(taken.body.status, 'live', JSON.stringify(taken.body));
        assert.equal((await w.row('thornfield')).node_pubkey, other.pubHex);
        assert.equal((await w.claim(blocked, { name: 'thornfield' })).status, 409, 'another community holds it now');

        // Past the hold the blocked key is a new claimant, never its old tenure taken back.
        await liveName(w, 'brambles', blocked);
        await w.admin('brambles', 'block');
        await w.admin('brambles', 'release');                                // no body at all: the default, too
        assert.equal((await w.row('brambles')).pause_reason, 'admin-held-all');
        await w.backdate('brambles', { released_at: nowS() - COOLOFF - 1 });
        assert.equal((await w.claim(blocked, { name: 'brambles' })).body.status, 'live');
        assert.match(w.events('brambles').at(-1).detail, /^claimed by key \S+; it was released, last held by /);

        // "Free now": free at once, to any key.
        await liveName(w, 'nettles', blocked);
        await w.admin('nettles', 'block');
        const freed = await w.admin('nettles', 'release', { free_now: true });
        assert.deepEqual(freed.body, { status: 'released', name: 'nettles' });
        assert.equal((await w.row('nettles')).pause_reason, 'admin');
        for (const k of [blocked, other]) assert.deepEqual((await w.holder(k, { name: 'nettles' })).body, { name: 'nettles', held: 'free' });
        assert.equal((await w.claim(later, { name: 'nettles' })).body.status, 'live');
        assert.equal((await w.row('nettles')).node_pubkey, later.pubHex);

        // "Free now" also ends a hold from every key at once.
        await liveName(w, 'thistle', blocked);
        await w.admin('thistle', 'block');
        await w.admin('thistle', 'release');
        assert.deepEqual((await w.admin('thistle', 'release', { free_now: true })).body, { status: 'released', name: 'thistle' });
        assert.equal((await w.claim(later, { name: 'thistle' })).body.status, 'live');
    } finally { w.restore(); }
});

test('a blocked gated name released without "free now": nobody may claim it for 30 days, then its old key waits for approval', async () => {
    const w = await world();
    try {
        const [blocked, other] = await Promise.all([makeKey(), makeKey()]);
        assert.equal((await w.claim(blocked, { name: 'perth' })).body.status, 'pending');   // gated in the 0001 seed
        assert.equal((await w.admin('perth', 'approve')).body.status, 'live');
        assert.equal((await w.admin('perth', 'block')).body.status, 'blocked');
        assert.equal((await w.admin('perth', 'release', { free_now: false })).body.status, 'released');
        assert.equal((await w.row('perth')).pause_reason, 'admin-held-all');
        await nobodyMayClaim(w, 'perth', blocked, other);

        // Past the hold: free — and its old key's approval went with the name. It waits for the admin like anyone.
        await w.backdate('perth', { released_at: nowS() - COOLOFF - 1 });
        const again = await w.claim(blocked, { name: 'perth' });
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.equal(again.body.status, 'pending', 'a gated name still needs approval');
        assert.deepEqual(routing(w, 'perth'), { dns: null, tunnels: [] });

        // With "free now": free at once, and its old key waits for approval too.
        assert.equal((await w.claim(blocked, { name: 'hobart' })).body.status, 'pending');
        assert.equal((await w.admin('hobart', 'approve')).body.status, 'live');
        await w.admin('hobart', 'block');
        assert.deepEqual((await w.admin('hobart', 'release', { free_now: true })).body, { status: 'released', name: 'hobart' });
        assert.equal((await w.claim(blocked, { name: 'hobart' })).body.status, 'pending');
    } finally { w.restore(); }
});

test('a name the admin paused, released without "free now", is held from every key too; any other pause keeps D-C', async () => {
    const w = await world();
    try {
        const [paused, other] = await Promise.all([makeKey(), makeKey()]);
        await liveName(w, 'stillpond', paused);
        assert.equal((await w.admin('stillpond', 'pause')).body.status, 'paused');
        const rel = await w.admin('stillpond', 'release');
        const row = await w.row('stillpond');
        assert.deepEqual(rel.body, { status: 'released', name: 'stillpond', reason: 'admin-held-all', held_until: row.released_at + COOLOFF });
        assert.match(w.events('stillpond').at(-1).detail, /^released by the admin \(was paused\): held 30 days from every key/);
        await nobodyMayClaim(w, 'stillpond', paused, other);

        // A pause the admin didn't make (the sweep's, a take-back's): the admin's release holds it for its key (D-C).
        await liveName(w, 'sweptpond', paused);
        await w.admin('sweptpond', 'pause');
        await w.backdate('sweptpond', { pause_reason: 'impostor' });
        const held = await w.admin('sweptpond', 'release');
        assert.deepEqual(held.body, { status: 'released', name: 'sweptpond', held_until: (await w.row('sweptpond')).released_at + COOLOFF });
        assert.equal((await w.row('sweptpond')).pause_reason, 'admin-held');
        assert.equal((await w.holder(paused, { name: 'sweptpond' })).body.held, 'you');
    } finally { w.restore(); }
});

test('the blocked node\'s own public-address agent, polling every 5 minutes through the hold, never brings the name back', async () => {
    const w = await world();
    try {
        const [blocked, other] = await Promise.all([makeKey(), makeKey()]);
        for (const [name, gated] of [['thornfield', false], ['perth', true]]) {
            assert.equal((await w.claim(blocked, { name })).body.status, gated ? 'pending' : 'live');
            if (gated) assert.equal((await w.admin(name, 'approve')).body.status, 'live');
            await w.admin(name, 'block');
            await w.admin(name, 'release', { free_now: false });
            const row = await w.row(name);
            // reconcile() (apps/server/src/services/public-address-agent.ts): /status; anything but live or pending is
            // claimed again, with the body claimAddress() sends. An hour of it, the sweep running between.
            for (let round = 0; round < 12; round++) {
                const st = await w.status(blocked);
                assert.equal(st.status, 200);
                assert.notEqual(st.body.status, 'live', `round ${round}`);
                assert.equal(st.body.tunnelToken, undefined);
                const c = await w.claim(blocked, { name, mode: 'tunnel', origin: 'https://localhost:8443', community_name: 'Thorns' });
                assert.equal(c.status, 403, `round ${round}: ${JSON.stringify(c.body)}`);
                assert.equal(c.body.tunnelToken, undefined);
                await attestSweep(w.env);
            }
            assert.deepEqual(await w.row(name), row, `${name}: the row is as the release left it`);
            assert.deepEqual(routing(w, name), { dns: null, tunnels: [] }, `${name}: nothing at Cloudflare`);
            assert.equal((await w.claim(other, { name })).status, 409);
        }
    } finally { w.restore(); }
});

// ── The names page ────────────────────────────────────────────────────────────────────────────────────────────────

// The served admin script, run against a stub page: the tables it renders, and what its buttons send.
async function adminPage(w) {
    const html = await (await worker.fetch(new Request('https://beanpool.org/admin'), w.env)).text();
    const script = html.split('<script>')[1].split('</script>')[0];
    const els = {};
    const boxes = {};
    const sent = [];
    const confirms = [];
    const alerts = [];
    // What the stubbed Worker answers an action (the Worker's own answers are tested above).
    const answer = { status: 'released' };
    const ctx = {
        console,
        document: {
            getElementById: (id) => (els[id] ??= { id, innerHTML: '', value: '', textContent: '', style: {}, addEventListener() {} }),
            addEventListener() {},
            querySelector: (sel) => {
                const m = /^input\[data-free-now-for="([a-z0-9-]+)"\]$/.exec(sel);
                return m ? (boxes[m[1]] ??= { checked: false }) : null;
            },
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        confirm: (text) => { confirms.push(text); return true; },
        alert: (text) => { alerts.push(text); },
        fetch: async (url, init = {}) => {
            sent.push({ url, init });
            return { ok: true, status: 200, json: async () => ({ ...answer, allocations: [], events: [] }) };
        },
    };
    vm.createContext(ctx);
    vm.runInContext(script, ctx);
    const button = (attrs) => ({ getAttribute: (k) => attrs[k] ?? null });
    // The tables as rendered: an action reloads them (and, with no secret in this stub, blanks them).
    const shots = {};
    const shoot = () => { for (const id of ['activeTableContainer', 'pendingTableContainer']) shots[id] = els[id]?.innerHTML ?? ''; };
    // Click a button as rendered: the attributes it carries in the table's HTML.
    const click = async (container, name, action) => {
        const tag = new RegExp(`<button data-name="${name}" data-action="${action}"[^>]*>`).exec(shots[container] ?? '')?.[0];
        assert.ok(tag, `a ${action} button for ${name} in ${container}`);
        const attrs = Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
        await ctx.adminAction(name, action, button(attrs));
    };
    const releases = () => sent.filter((s) => /\/release$/.test(s.url)).map((s) => ({ url: s.url, body: s.init.body === undefined ? undefined : JSON.parse(s.init.body) }));
    const answers = (body) => { for (const k of Object.keys(answer)) delete answer[k]; Object.assign(answer, body); };
    return { ctx, els, boxes, confirms, alerts, answers, shoot, click, releases };
}

test('the names page: Release has a "free now" box and sends free_now only when it is ticked; Reject and Free now free at once', async () => {
    const w = await world();
    try {
        const p = await adminPage(w);
        const key = 'ab'.repeat(32);
        p.ctx.renderActive([
            { name: 'blockedname', status: 'blocked', pause_reason: 'admin', node_pubkey: key, mode: 'tunnel', paused_at: 1 },
            { name: 'heldname', status: 'released', pause_reason: 'admin-held', node_pubkey: key, mode: 'tunnel', released_at: 1 },
            { name: 'ownerheld', status: 'released', pause_reason: 'owner', node_pubkey: key, mode: 'tunnel', released_at: 1 },
            { name: 'freedname', status: 'released', pause_reason: 'admin', node_pubkey: key, mode: 'tunnel', released_at: 1 },
            { name: 'livename', status: 'live', node_pubkey: key, mode: 'tunnel' },
        ]);
        p.ctx.renderPending([{ name: 'sydney', status: 'pending', node_pubkey: key, mode: 'tunnel', requested_at: 1 }]);
        p.shoot();
        const table = p.els.activeTableContainer.innerHTML;
        assert.match(table, /<input type="checkbox" data-free-now-for="blockedname">/, 'the box sits by Release');
        assert.doesNotMatch(table, /data-free-now-for="(heldname|ownerheld|freedname|livename)"/, 'only by Release');
        assert.doesNotMatch(table, /data-name="freedname"/, 'a name already free has no action');
        assert.doesNotMatch(table, /data-name="livename" data-action="release"/, 'a live name still has no Release');

        // Release on a blocked name, box not ticked: held — from every key, the blocked one included (r4117740868).
        await p.click('activeTableContainer', 'blockedname', 'release');
        assert.match(p.confirms.at(-1), /held 30 days from EVERY key, this one included/);
        assert.doesNotMatch(p.confirms.at(-1), /FREE AT ONCE|can take it back/);
        // Ticked: free now.
        p.boxes.blockedname.checked = true;
        await p.click('activeTableContainer', 'blockedname', 'release');
        assert.match(p.confirms.at(-1), /FREE AT ONCE/);
        // "Free now" on a held release, the admin's or the owner's, and Reject on a pending claim: at once, as before.
        await p.click('activeTableContainer', 'heldname', 'release');
        assert.match(p.confirms.at(-1), /FREE AT ONCE/);
        await p.click('activeTableContainer', 'ownerheld', 'release');
        await p.click('pendingTableContainer', 'sydney', 'release');
        assert.match(p.confirms.at(-1), /FREE AT ONCE/);

        const base = '/api/local/admin/registrar/';
        assert.deepEqual(p.releases(), [
            { url: `${base}blockedname/release`, body: { free_now: false } },
            { url: `${base}blockedname/release`, body: { free_now: true } },
            { url: `${base}heldname/release`, body: { free_now: true } },
            { url: `${base}ownerheld/release`, body: { free_now: true } },
            { url: `${base}sydney/release`, body: { free_now: true } },
        ]);
    } finally { w.restore(); }
});

test('the names page says what a blocked name\'s release does: held from every key, the blocked one included', async () => {
    const w = await world();
    try {
        const p = await adminPage(w);
        const key = 'ab'.repeat(32);
        p.ctx.renderActive([
            { name: 'livename', status: 'live', node_pubkey: key, mode: 'tunnel' },
            { name: 'blockedname', status: 'blocked', pause_reason: 'admin', node_pubkey: key, mode: 'tunnel', paused_at: 1 },
            // A state the page doesn't know (a legacy 'revoked' row) gets Block and Release; its release keeps D-C.
            { name: 'oldrow', status: 'revoked', node_pubkey: key, mode: 'tunnel' },
        ]);
        p.shoot();

        // Block no longer promises that Release gives the name back to anyone.
        await p.click('activeTableContainer', 'livename', 'block');
        assert.match(p.confirms.at(-1), /its node cannot heal or release it/);
        assert.match(p.confirms.at(-1), /Release holds it 30 days from every key, this one included/);

        // A blocked name's release, and the Worker's answer to it.
        p.answers({ status: 'released', name: 'blockedname', reason: 'admin-held-all', held_until: 1790000000 });
        await p.click('activeTableContainer', 'blockedname', 'release');
        assert.match(p.confirms.at(-1), /held 30 days from EVERY key, this one included/);
        assert.match(p.alerts.at(-1), /^blockedname\.beanpool\.org is now released \(admin-held-all\), held from every key, its own included, until /);
        assert.doesNotMatch(p.alerts.at(-1), /held for its key/);

        // Any other row's release is held for its key, which can take it back (D-C).
        p.answers({ status: 'released', name: 'oldrow', held_until: 1790000000 });
        await p.click('activeTableContainer', 'oldrow', 'release');
        assert.match(p.confirms.at(-1), /held 30 days for its key, which can take it back/);
        assert.doesNotMatch(p.confirms.at(-1), /EVERY key/);
        assert.match(p.alerts.at(-1), /^oldrow\.beanpool\.org is now released, held for its key until /);

        const base = '/api/local/admin/registrar/';
        assert.deepEqual(p.releases(), [
            { url: `${base}blockedname/release`, body: { free_now: false } },
            { url: `${base}oldrow/release`, body: { free_now: false } },
        ]);
    } finally { w.restore(); }
});
