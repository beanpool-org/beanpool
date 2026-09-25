// Invariant fuzz for the registrar's races (PR 1b; kept from the deciding pass's scratch fuzz). One run: a setup puts
// a name in a state; a primary request runs; an interfering request or decision lands just before Cloudflare answers
// one of the primary's calls, just before one of its D1 writes (PR 1c), or during its edge re-attest; and Cloudflare
// refuses some writes for a while (a failure mode). Then Cloudflare recovers, and the name settles as it would in
// production: the sweep runs and nodes poll /status, three times. After that, on the name and its two neighbours:
//   1. nothing routes a key that doesn't own the name: no attest in the last two sweeps reached one (the first sweep
//      after recovery attests before its upkeep repairs), and the record at the hostname points only at the live row's
//      key (an address that key serves, or a tunnel only it was given);
//   2. a paused, blocked, released or pending name routes nothing: no record at its hostname;
//   3. a live name routes exactly what its row records (its record, pointing at its target; its tunnel alive), and
//      its owner's node answers there (or, at an old address its row still records, whatever was recycled there);
//   4. no teardown is lost: no bp-<name> tunnel is alive but the row's, and nothing is still owed but a tunnel the
//      row keeps (live on it, or the admin's pause) — owed on purpose until no row does (settleOwed);
//   5. a node's move (healMoved, claimMoved: it leaves OLD_IP, which is then recycled) that the registrar answered live
//      is what the row records, if the name is still its owner's and live — unless the owner's own request naming
//      another target raced it;
// and no request answered 500.
// Nodes answer only where Cloudflare routes: an A record reaches the node serving that address (none: 522); a CNAME
// reaches the node whose connector runs that tunnel — the last token the registrar gave it — if the tunnel is alive and
// its ingress names the hostname (else 530 or 404). So a record left pointing at another key is seen as that key.
//
// `npm test` runs every setup × primary × mode once undisturbed (1,134 runs), then the moves' cases in full (moveCase:
// 1,395), then a seeded sample of the rest of the matrix (FUZZ_SAMPLE runs, default 1000; FUZZ_SEED, default 1137,
// printed with each failing case): about 19 s. `npm run fuzz` runs the whole matrix, ~105,000 cases in about 11 minutes
// (FUZZ_SETUP=<name> or FUZZ_PRIMARY=<name> for one share: the largest setup takes about 2½ minutes).
// FUZZ_CASE='setup|primary|interferer|mode|at' replays one case and prints its trace.

import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { attestSweep } from '../src/index.js';
import { world, makeKey, attestsAs, routing } from './harness.js';

const NAME = 'fuzzname';
const HOST = `${NAME}.beanpool.org`;
const NEIGHBOURS = ['nb-a', 'nb-b'];
const OLD_IP = '198.51.100.1';     // the owner's node
const MOVED_IP = '198.51.100.2';   // the owner's node, moved
const NEW_IP = '203.0.113.9';      // the other key's node
const direct = (ip) => ({ mode: 'direct', public_ip: ip });

// A world whose nodes answer only where Cloudflare routes, and keep the tunnel tokens they are given.
async function fuzzWorld(K) {
    const w = await world();
    const serves = new Map([[OLD_IP, K.owner], [MOVED_IP, K.owner], [NEW_IP, K.other]]);
    const recycled = new Set();  // addresses a web page that isn't a BeanPool node now answers at
    const runs = new Map();      // key → the tunnel its connector runs
    const given = new Map();     // tunnel id → the keys the registrar gave its token
    const heard = [];            // each attest that reached a node: { host, key }
    const statuses = [];         // every answer a request got
    const took = (key, body) => {
        const id = /^token-(.+)$/.exec(body?.tunnelToken ?? '')?.[1];
        if (!id) return;
        runs.set(key, id);
        if (!given.has(id)) given.set(id, new Set());
        given.get(id).add(key);
    };
    // The node Cloudflare sends `host`'s traffic to, or the HTTP status Cloudflare answers instead.
    const reaches = (host) => {
        const rec = w.cf.recordAt(host);
        if (!rec) return { status: 'unresolved' };
        if (rec.type === 'A') {
            if (serves.has(rec.content)) return { key: serves.get(rec.content) };
            return recycled.has(rec.content) ? { status: 200, page: true } : { status: 522 };
        }
        const id = rec.content.replace(/\.cfargotunnel\.com$/, '');
        const t = w.cf.liveTunnel(id);
        if (!t) return { status: 530 };
        if (!t.ingress?.some((r) => r.hostname === host)) return { status: 404 };
        const key = [K.intruder, K.owner, K.other, K.n1, K.n2].find((k) => runs.get(k) === id);
        return key ? { key } : { status: 530 };
    };
    const answer = (host) => async (nonce) => {
        const r = reaches(host);
        if (r.status === 'unresolved') throw new Error(`${host} does not resolve`);
        if (r.page) return new Response('<html>router login</html>', { status: 200 });
        if (!r.key) return new Response(`cloudflare ${r.status}`, { status: r.status });
        heard.push({ host, key: r.key });
        return attestsAs(r.key)(nonce);
    };
    for (const host of [HOST, ...NEIGHBOURS.map((n) => `${n}.beanpool.org`)]) w.nodes[host] = answer(host);
    const keeping = (key) => async (p) => { const r = await p; statuses.push(r.status); took(key, r.body); return r; };
    return {
        w, K, serves, recycled, runs, given, heard, statuses, reaches, answer,
        // The owner's node moves off OLD_IP (nothing answers there: Cloudflare's 522); later the address is recycled.
        move: () => { serves.delete(OLD_IP); },
        recycle: () => { if (!serves.has(OLD_IP)) recycled.add(OLD_IP); },
        claim: (key, body) => keeping(key)(w.claim(key, body)),
        heal: (key, body) => keeping(key)(w.heal(key, body)),
        release: (key, body) => keeping(key)(w.release(key, body)),
        admin: async (action) => { const r = await w.admin(NAME, action); statuses.push(r.status); return r; },
        // Every node polls /status, as its 5-minute reconcile does, and runs the token it is given.
        reconcile: async () => { for (const k of [K.owner, K.other, K.n1, K.n2]) await keeping(k)(w.status(k)); },
    };
}

const SETUPS = {
    liveTunnel: (fz) => fz.claim(fz.K.owner, { name: NAME }),
    liveDirect: (fz) => fz.claim(fz.K.owner, { name: NAME, ...direct(OLD_IP) }),
    // Paused for an impostor riding a leaked token; Cloudflare refused the tunnel's delete, so it is kept. The
    // intruder then goes.
    impostorKept: async (fz) => {
        await fz.claim(fz.K.owner, { name: NAME });
        fz.runs.set(fz.K.intruder, (await fz.w.row(NAME)).tunnel_id);
        fz.w.cf.fail.deleteTunnel = true;
        await attestSweep(fz.w.env); await attestSweep(fz.w.env);
        fz.w.cf.fail.deleteTunnel = false;
        fz.runs.delete(fz.K.intruder);
    },
    adminPaused: async (fz) => { await fz.claim(fz.K.owner, { name: NAME }); await fz.admin('pause'); },
    blocked: async (fz) => { await fz.claim(fz.K.owner, { name: NAME }); await fz.admin('block'); },
    adminReleased: async (fz) => { await fz.claim(fz.K.owner, { name: NAME, ...direct(OLD_IP) }); await fz.admin('release'); },
    gatedPending: async (fz) => {
        fz.w.sqlite.prepare("INSERT INTO name_policy (pattern, tier) VALUES (?, 'gated')").run(NAME);
        await fz.claim(fz.K.owner, { name: NAME });
    },
};
const SETTLED = {
    liveTunnel: ['live', null], liveDirect: ['live', null], impostorKept: ['paused', 'impostor'], adminPaused: ['paused', 'admin'],
    blocked: ['blocked', 'admin'], adminReleased: ['released', 'admin'], gatedPending: ['pending', null],
};

const ACTIONS = {
    heal: (fz) => fz.heal(fz.K.owner, { name: NAME }),
    healDirect: (fz) => fz.heal(fz.K.owner, { name: NAME, ...direct(MOVED_IP) }),
    healTunnel: (fz) => fz.heal(fz.K.owner, { name: NAME, mode: 'tunnel' }),
    claim: (fz) => fz.claim(fz.K.owner, { name: NAME }),
    ownerRelease: (fz) => fz.release(fz.K.owner, { name: NAME }),
    newClaim: (fz) => fz.claim(fz.K.other, { name: NAME }),
    newClaimDirect: (fz) => fz.claim(fz.K.other, { name: NAME, ...direct(NEW_IP) }),
    approve: (fz) => fz.admin('approve'),
    pause: (fz) => fz.admin('pause'),
    block: (fz) => fz.admin('block'),
    resume: (fz) => fz.admin('resume'),
    release: (fz) => fz.admin('release'),
    pauseResume: async (fz) => { await fz.admin('pause'); return fz.admin('resume'); },
    blockResume: async (fz) => { await fz.admin('block'); return fz.admin('resume'); },
    relNew: async (fz) => { await fz.admin('release'); return fz.claim(fz.K.other, { name: NAME }); },
    relNewDirect: async (fz) => { await fz.admin('release'); return fz.claim(fz.K.other, { name: NAME, ...direct(NEW_IP) }); },
    // The owner's node moves to a new address (nothing answers at OLD_IP any more), then heals, or claims, there. Once
    // the primary is done, OLD_IP is recycled: a web page that isn't a BeanPool node answers there, which isn't dark.
    healMoved: (fz) => { fz.move(); return fz.heal(fz.K.owner, { name: NAME, ...direct(MOVED_IP) }); },
    claimMoved: (fz) => { fz.move(); return fz.claim(fz.K.owner, { name: NAME, ...direct(MOVED_IP) }); },
    // Interfering only: the same key's heal, or claim, back to its old address.
    healOld: (fz) => fz.heal(fz.K.owner, { name: NAME, ...direct(OLD_IP) }),
    claimOld: (fz) => fz.claim(fz.K.owner, { name: NAME, ...direct(OLD_IP) }),
    sweep: (fz) => attestSweep(fz.w.env),
    // The sweep while nothing answers at the owner's new address yet — Cloudflare's edge takes a few seconds to follow a
    // PATCH, or the node is still coming up there — so its attest at the name finds nothing (522) and its upkeep looks.
    sweepDark: async (fz) => {
        fz.serves.delete(MOVED_IP);
        try { return await attestSweep(fz.w.env); } finally { fz.serves.set(MOVED_IP, fz.K.owner); }
    },
};
const PRIMARIES = Object.keys(ACTIONS).filter((a) => !['sweep', 'sweepDark', 'healOld', 'claimOld'].includes(a));
const MOVES = new Set(['healMoved', 'claimMoved']);
// A move is a primary only: the node leaving its old address is what (5) checks, and as an interfering request its heal
// may rightly be refused (a block, a pause) with the node gone from the address its row records. healDirect interferes
// with the same request, the node staying where it was.
const INTERFERERS = Object.keys(ACTIONS).filter((a) => !MOVES.has(a));
// Run in full by `npm test`: a node's move with the requests that read the row at its old address — the sweep's repair
// (the node has just left it: Cloudflare's 52x), a bare heal, a heal or claim back to it — landing just before one of
// the move's D1 writes (r4101264972).
const MOVE_INTERFERERS = ['sweep', 'sweepDark', 'heal', 'healOld', 'claimOld'];
const moveCase = (c) => MOVES.has(c.primary) && MOVE_INTERFERERS.includes(c.interferer) && String(c.at).startsWith('write:');
// The owner's own requests naming a routing target: a move racing one of them may end on either (invariant 5).
const OWN_TARGETS = new Set(['healDirect', 'healTunnel', 'claim', 'healOld', 'claimOld', 'healMoved', 'claimMoved']);

// What Cloudflare refuses (fake Cloudflare's `fail` flags), and when: from the primary's start, while the interfering
// action runs, from the end of that action, or from the call after the one it landed at (the in-flight call goes
// through); `outage` = through one sweep before it recovers.
const MODES = {
    none: {},
    patchDuring: { during: ['patchDns', 'deleteDns'] },
    dnsThroughSweep: { from: 'start', refuse: ['patchDns', 'deleteDns'], outage: true },
    postThrough: { from: 'start', refuse: ['postDns'] },
    ingressThrough: { from: 'start', refuse: ['ingress'] },
    deletesThroughSweep: { from: 'start', refuse: ['deleteDns', 'deleteTunnel'], outage: true },
    everythingThroughSweep: { from: 'start', refuse: ['patchDns', 'deleteDns', 'postDns', 'ingress', 'deleteTunnel'], outage: true },
    fromActionThroughSweep: { from: 'action', refuse: ['patchDns', 'deleteDns', 'deleteTunnel', 'ingress'], outage: true },
    // Deletes refused while the action runs (a release leaves its record for the next claim to adopt), then every
    // record change after the call it landed at: the undo can't point the record back (r4100737470).
    deletesDuringThenAllThroughSweep: { during: ['deleteDns'], from: 'next', refuse: ['patchDns', 'deleteDns', 'deleteTunnel'], outage: true },
};

const who = (K, key) => Object.keys(K).find((k) => K[k] === key) ?? 'an unknown key';
const whoHex = (K, hex) => Object.keys(K).find((k) => K[k].pubHex === hex) ?? 'nobody';

// The invariants, for one name. `since`: attests from here on count for (1).
async function broken(fz, name, since) {
    const { w, K } = fz;
    const host = `${name}.beanpool.org`;
    const out = [];
    const row = await w.row(name);
    const rec = w.cf.recordAt(host);
    const live = row?.status === 'live';
    for (const h of fz.heard.slice(since)) {
        if (h.host === host && h.key.pubHex !== row?.node_pubkey) out.push(`1: an attest reached ${who(K, h.key)}, the row is ${whoHex(K, row?.node_pubkey)}'s`);
    }
    if (rec) {
        const to = rec.type === 'A' ? [fz.serves.get(rec.content)].filter(Boolean) : [...(fz.given.get(rec.content.replace(/\.cfargotunnel\.com$/, '')) ?? [])];
        if (!live) out.push(`2: ${row?.status ?? 'no'} row, its hostname routes ${rec.type === 'A' ? rec.content : 'a tunnel'}`);
        for (const k of to) {
            if (k.pubHex !== row?.node_pubkey)
                out.push(`1: the record routes ${who(K, k)}'s ${rec.type === 'A' ? 'address' : 'tunnel'}, the row is ${whoHex(K, row?.node_pubkey)}'s`);
        }
    }
    if (live) {
        const want = row.mode === 'direct' ? { type: 'A', content: row.public_ip } : { type: 'CNAME', content: `${row.tunnel_id}.cfargotunnel.com` };
        if (!rec) out.push('3: live, nothing at its hostname');
        else if (rec.id !== row.dns_record_id) out.push('3: live, its hostname has a record the row doesn\'t record');
        else if (rec.type !== want.type || rec.content !== want.content) out.push(`3: live ${row.mode}, the record points elsewhere`);
        if (row.mode === 'tunnel' && !w.cf.liveTunnel(row.tunnel_id)) out.push('3: live on a tunnel Cloudflare no longer has');
        const r = fz.reaches(host);
        const there = r.key ? who(K, r.key) : r.page ? 'a web page that isn\'t a BeanPool node (a recycled address)' : `Cloudflare's ${r.status}`;
        // An address its row still records that was recycled once its node left: the owner's own last word (a heal back
        // to it, or a move the registrar answered as failed). The registrar can't see that; (5) checks the moves.
        const ownOld = r.page && row.mode === 'direct' && rec?.content === row.public_ip;
        if (rec && r.key?.pubHex !== row.node_pubkey && !ownOld) out.push(`3: live, but ${there} answers there, not its owner's node`);
    }
    const keeps = (t) => t.kind === 'tunnel' && t.cf_id === row?.tunnel_id && (live || (row.status === 'paused' && row.pause_reason === 'admin'));
    const owed = w.sqlite.prepare('SELECT kind, cf_id FROM teardown WHERE name=?').all(name).filter((t) => !keeps(t));
    if (owed.length) out.push(`4: still owed: ${owed.map((o) => o.kind).join(', ')}`);
    const stray = routing(w, name).tunnels.filter((id) => id !== row?.tunnel_id);
    if (stray.length) out.push(`4: ${stray.length} bp-${name} tunnel(s) alive that no row records`);
    return out.map((b) => (name === NAME ? b : `${name}: ${b}`));
}

// One case: { setup, primary, interferer, mode, at } — `at` the n-th Cloudflare call of the primary (a number),
// 'write:n' (just before the primary's n-th D1 write: between its last Cloudflare answer and its row write),
// 'attest' (its edge re-attest at the name), 'sweep:n' (the n-th Cloudflare call of the sweep during the outage: a
// take-down landing while the sweep settles what is owed), or null (undisturbed). Returns the invariants broken, and
// where an interfering action can land: the primary's Cloudflare calls and D1 writes, whether it attested at the name,
// and the outage sweep's Cloudflare calls.
async function run(K, c) {
    const fz = await fuzzWorld(K);
    const { w } = fz;
    const m = MODES[c.mode];
    const refuse = (flags, on) => { for (const f of flags ?? []) w.cf.fail[f] = on; };
    try {
        for (const [i, n] of NEIGHBOURS.entries()) await fz.claim(K[`n${i + 1}`], { name: n });
        await SETUPS[c.setup](fz);
        const set = await w.row(NAME);
        if (JSON.stringify([set?.status, set?.pause_reason]) !== JSON.stringify(SETTLED[c.setup])) return { bad: [`setup ended ${set?.status}/${set?.pause_reason}`] };

        let attested = false;
        let armed = false;
        const interfere = async () => {
            refuse(m.during, true);
            try { await ACTIONS[c.interferer](fz); } catch (e) { fz.statuses.push(`threw ${e.message}`); }
            refuse(m.during, false);
            if (m.from === 'action') refuse(m.refuse, true);
            if (m.from === 'next') w.cf.at(1, () => refuse(m.refuse, true));
        };
        const answer = w.nodes[HOST];
        w.nodes[HOST] = async (nonce) => {
            attested = true;
            if (armed) { armed = false; await interfere(); }
            return answer(nonce);
        };
        if (c.at === 'attest') armed = true;
        else if (typeof c.at === 'number') w.cf.at(c.at, interfere);
        else if (String(c.at).startsWith('write:')) w.atWrite(Number(c.at.slice(6)), interfere);
        const n0 = w.cf.calls.length;
        const d0 = w.writes();
        if (m.from === 'start') refuse(m.refuse, true);
        let answered;
        try { answered = await ACTIONS[c.primary](fz); } catch (e) { fz.statuses.push(`threw ${e.message}`); }
        const used = w.cf.calls.length - n0;
        const wrote = w.writes() - d0;
        w.nodes[HOST] = answer;
        w.cf.hooks.length = 0;
        w.runHooks.length = 0;
        if (MOVES.has(c.primary)) fz.recycle();
        let sweepCalls = 0;
        if (m.outage) {
            if (String(c.at).startsWith('sweep:')) w.cf.at(Number(c.at.slice(6)), interfere);
            const s0 = w.cf.calls.length;
            await attestSweep(w.env);
            sweepCalls = w.cf.calls.length - s0;
            w.cf.hooks.length = 0;
        }
        for (const f of Object.keys(w.cf.fail)) w.cf.fail[f] = false;

        // Cloudflare has recovered: the sweep and the nodes' reconcile, three times.
        await attestSweep(w.env); await fz.reconcile();
        const since = fz.heard.length;
        await attestSweep(w.env); await fz.reconcile();
        await attestSweep(w.env); await fz.reconcile();
        const bad = [];
        for (const n of [NAME, ...NEIGHBOURS]) bad.push(...await broken(fz, n, since));
        if (MOVES.has(c.primary) && answered?.status === 200 && answered.body?.status === 'live' && !OWN_TARGETS.has(c.interferer)) {
            const row = await w.row(NAME);
            if (row?.status === 'live' && row.node_pubkey === K.owner.pubHex && !(row.mode === 'direct' && row.public_ip === MOVED_IP))
                bad.push(`5: its move was answered live, but the row records ${row.mode === 'direct' ? row.public_ip : 'a tunnel'}`);
        }
        for (const s of fz.statuses) if (s === 500 || String(s).startsWith('threw')) bad.push(`a request answered ${s}`);
        const trace = c.trace && {
            answers: fz.statuses, events: w.events(NAME), row: await w.row(NAME), record: w.cf.recordAt(HOST),
            tunnels: routing(w, NAME).tunnels, owed: w.sqlite.prepare('SELECT * FROM teardown').all(),
            attests: fz.heard.map((h, i) => `${i < since ? '' : '(settled) '}${h.host} → ${who(K, h.key)}`), calls: w.cf.calls,
        };
        return { bad, used, wrote, attested, sweepCalls, trace };
    } finally { w.restore(); }
}

const caseId = (c) => [c.setup, c.primary, c.interferer ?? '-', c.mode, c.at ?? '-'].join('|');
const parseCase = (s) => {
    const [setup, primary, interferer, mode, at] = s.split('|');
    return { setup, primary, interferer: interferer === '-' ? null : interferer, mode, at: at === '-' ? null : (/^\d+$/.test(at) ? Number(at) : at) };
};

// mulberry32: a small seeded PRNG, so a sample is the same sample on every machine.
function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The console is the Worker's log: thousands of runs of it would drown the test output.
async function quietly(fn) {
    const saved = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = () => {};
    try { return await fn(); } finally { [console.log, console.warn, console.error] = saved; }
}

const FULL = process.env.REGISTRAR_FUZZ === 'full';
const SAMPLE = parseInt(process.env.FUZZ_SAMPLE || '1000', 10);
const SEED = parseInt(process.env.FUZZ_SEED || '1137', 10);

test(`fuzz: races × Cloudflare refusals leave every name routed as its row says, and nothing lost (${FULL ? 'full matrix' : `seed ${SEED}, ${SAMPLE} sampled`})`, async () => {
    const K = Object.fromEntries(await Promise.all(['owner', 'other', 'intruder', 'n1', 'n2'].map(async (k) => [k, await makeKey()])));
    const failures = new Map();   // the shape of what broke → the cases that broke it
    let ran = 0;
    const tally = (c, bad) => {
        ran++;
        if (!bad.length) return;
        const shape = `${c.setup} | ${c.primary} ← ${c.interferer ?? 'nothing'} | ${c.mode} | ${bad.join('; ')}`;
        if (!failures.has(shape)) failures.set(shape, []);
        failures.get(shape).push(caseId(c));
    };
    let matrix = 0;
    let moves = 0;
    let trace;
    const started = Date.now();
    await quietly(async () => {
        if (process.env.FUZZ_CASE) {
            const c = { ...parseCase(process.env.FUZZ_CASE), trace: true };
            const r = await run(K, c);
            tally(c, r.bad);
            trace = r.trace;
            return;
        }
        // Every setup × primary × mode undisturbed: where an interfering action can land.
        const cases = [];
        for (const setup of Object.keys(SETUPS)) {
            if (process.env.FUZZ_SETUP && setup !== process.env.FUZZ_SETUP) continue;
            for (const primary of PRIMARIES) {
                if (process.env.FUZZ_PRIMARY && primary !== process.env.FUZZ_PRIMARY) continue;
                for (const mode of Object.keys(MODES)) {
                    const c = { setup, primary, interferer: null, mode, at: null };
                    const base = await run(K, c);
                    tally(c, base.bad);
                    const points = [
                        ...Array.from({ length: base.used ?? 0 }, (_, i) => i + 1), ...(base.attested ? ['attest'] : []),
                        ...Array.from({ length: base.wrote ?? 0 }, (_, i) => `write:${i + 1}`),
                        ...Array.from({ length: base.sweepCalls ?? 0 }, (_, i) => `sweep:${i + 1}`),
                    ];
                    for (const interferer of INTERFERERS) for (const at of points) cases.push({ setup, primary, interferer, mode, at });
                }
            }
        }
        matrix = cases.length;
        let todo = cases;
        if (!FULL) {
            // The moves' cases in full, then a seeded sample of the rest.
            const rest = cases.filter((c) => !moveCase(c));
            moves = cases.length - rest.length;
            const rand = prng(SEED);
            for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
            todo = [...cases.filter(moveCase), ...rest.slice(0, SAMPLE)];
        }
        for (const c of todo) tally(c, (await run(K, c)).bad);
    });
    if (trace) console.log('[fuzz] FUZZ_CASE trace', JSON.stringify(trace, null, 1));
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const brokenRuns = [...failures.values()].reduce((n, cs) => n + cs.length, 0);
    const report = [...failures].map(([shape, cs]) => `${shape}\n    ${cs.length} case(s), e.g. FUZZ_CASE='${cs[0]}'`);
    console.log(`[fuzz] ${ran} runs (every setup × primary × mode undisturbed, then ${FULL ? 'all' : `its ${moves} move cases and a seed-${SEED} sample of the rest`} of a `
        + `${matrix}-case matrix) in ${secs}s: ${brokenRuns} broken, ${failures.size} distinct shapes`);
    assert.deepEqual(report, [], `seed ${SEED}:\n${report.join('\n')}`);
});
