/**
 * Test Suite: the node's memory of the nearby sets it named, by which a changed set is sent as a diff
 * (engine/nearby-set-memory.ts, scratch/global-node/DESIGN-nearby-set-diff-fable.md §5.2, §5.6).
 *
 *   1. the canonical hash: order-free, deduped, injective where a join was not (an id holding a comma), and the pinned
 *      vector the phone's suite pins too (apps/native utils/__tests__/posts-nearby.test.ts);
 *   2. ids pack and unpack exactly: canonical UUIDs (16 bytes each) and any other id (kept as the string), so a diff
 *      against an entry names exactly the ids that changed;
 *   3. equivalence over 3,000 seeded cycles: 60 readers with 1-2 phones each over 12 worlds of 20-600 ids, each cycle
 *      changing 0-40 ids of one world and flipping ties, the memory under a tiny budget (so it evicts) and replaced every
 *      ~150 cycles (a restart), reads cut short at random (not applied), some phones that never say setDiff, and the
 *      304's confirmation. After every answer a model phone applies it as the app does and holds exactly the set and its
 *      `tied`, hashed to `setHash`; a hash not on the reader's own list (none, from before a restart, another reader's)
 *      is never answered a diff; a diff is smaller than the set, and names `tied` exactly when it moved; bytes, sets and
 *      readers stay within their bounds after every step;
 *   4. the bound measured: 20,000 distinct hub-size sets (500 UUIDs + 100 tied) under the default bounds hold at most
 *      32 MB as counted, at most 20,000 sets and readers, and the heap (heapUsed + arrayBuffers) grows by at most 1.5×
 *      what is counted;
 *   5. NEARBY_SET_MEMORY_MB: 0 turns the memory off (every changed set whole, `setUnchanged` still answered); a value out
 *      of range is the default.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-nearby-set-memory)
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import {
    NearbySetMemory, nearbySetHash, diffNearbySet, nearbySetMemoryLimits, NEARBY_SET_HASHES_PER_READER,
    type NearbySetAnswer, type NearbySetMemoryLimits,
} from './engine/nearby-set-memory.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** For the many checks of a loop: counted once, at the end, with the first failure's detail. */
function tally() {
    let bad = 0, first = '';
    return {
        check(cond: boolean, detail: () => string) { if (!cond && bad++ === 0) first = detail(); },
        report(msg: string, n: number) { assert(bad === 0, `${msg} (${n} checks${bad ? `; ${bad} failed, first: ${first}` : ''})`); },
    };
}

const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
    const x = new Set(a), y = new Set(b);
    return x.size === y.size && [...x].every(v => y.has(v));
};

// A seeded random, so a failure reproduces.
let seedState = 0x5eed;
function rand(): number {
    seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
    return seedState / 0x7fffffff;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

let minted = 0;
const uuid = () => {
    const n = minted++;
    return `${n.toString(16).padStart(8, '0')}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}-4abc-8def-${Math.floor(rand() * 2 ** 40).toString(16).padStart(12, '0')}`;
};
/** A client-minted id: any string, a comma or a newline in it included. */
const oddId = () => pick(['x,', 'y\n', 'Z', 'ä', 'p-', 'a"b', '']) + String(minted++);

/** The phone's rule (apps/native utils/posts-nearby.ts nearbyApplyDiff), line for line. */
function applyDiff(held: { set: string[]; tied: string[] }, page: { setAdd: string[]; setDrop: string[]; tied?: string[] }) {
    const drop = new Set(page.setDrop);
    const seen = new Set<string>();
    const set: string[] = [];
    for (const id of held.set) if (!drop.has(id) && !seen.has(id)) { seen.add(id); set.push(id); }
    for (const id of page.setAdd) if (!seen.has(id)) { seen.add(id); set.push(id); }
    return { set, tied: page.tied ?? held.tied };
}

function main() {
    console.log('The memory of the nearby sets a node named (setDiff)...\n');

    // ── 1. the canonical hash ──
    console.log('── 1. the canonical hash ──');
    assert(nearbySetHash(['b', 'a', 'a'], ['a']) === 'b515109816ef8786513b9a68',
        `the pinned vector: ids ['b','a','a'], tied ['a'] → b515109816ef8786513b9a68 (the phone's suite pins the same)`);
    assert(nearbySetHash(['a', 'b'], ['a']) === nearbySetHash(['b', 'a', 'b'], ['a', 'a']), 'order and repeats change nothing');
    assert(nearbySetHash(['a,b'], []) !== nearbySetHash(['a', 'b'], []), 'an id holding a comma is not two ids (a join was not injective)');
    assert(nearbySetHash(['a'], []) !== nearbySetHash(['a'], ['a']), '`tied` is part of it');
    assert(/^[0-9a-f]{24}$/.test(nearbySetHash([], [])), 'the empty set has a hash, 24 hex');

    // ── 2. ids pack and unpack exactly ──
    console.log('\n── 2. ids pack and unpack exactly ──');
    {
        const m = new NearbySetMemory({ budgetBytes: 1 << 20, maxSets: 100, maxReaders: 100 });
        const uuids = Array.from({ length: 50 }, uuid);
        const odd = [...uuids.slice(0, 10), 'A0000000-0000-4000-8000-000000000000', 'p,1', 'q\n2'];
        for (const ids of [uuids, odd]) {
            const tied = ids.slice(0, 3);
            const first = m.answer('r', { ids, tied }, { setDiff: true });
            const next = [...ids.slice(2), 'new-1'];
            const second = m.answer('r', { ids: next, tied: tied.slice(2) }, { setHash: (first as { setHash: string }).setHash, setDiff: true }) as Extract<NearbySetAnswer, { setAdd: string[] }>;
            assert('setAdd' in second && second.setAdd.join() === 'new-1' && sameSet(second.setDrop, ids.slice(0, 2)) && second.tied?.join() === tied.slice(2).join(),
                `${ids === uuids ? '50 UUIDs, packed' : 'an uppercase UUID and ids with a comma and a newline, kept as strings'}: the diff names exactly what changed (+${'setAdd' in second ? second.setAdd.length : '?'} −${'setDrop' in second ? second.setDrop.length : '?'}, tied moved: ${'tied' in second})`);
        }
        const packed = new NearbySetMemory({ budgetBytes: 1 << 20, maxSets: 100, maxReaders: 100 });
        packed.answer('r', { ids: uuids, tied: [] }, {});
        assert(packed.held().bytes === uuids.length * 16 + 128, `50 UUIDs count 16 bytes each plus 128 (${packed.held().bytes})`);
        const d = diffNearbySet(['a', 'b', 'c'], ['d', 'b', 'e', 'd']);
        assert(d.setAdd.join() === 'd,e' && d.setDrop.join() === 'a,c', 'setAdd in the new set\'s order, each once; setDrop what went');
    }

    // ── 3. equivalence over 3,000 cycles ──
    console.log('\n── 3. equivalence over 3,000 seeded cycles, with evictions and restarts ──');
    {
        const LIMITS: NearbySetMemoryLimits = { budgetBytes: 160 * 1024, maxSets: 40, maxReaders: 48 };
        let memory = new NearbySetMemory(LIMITS);
        type World = { ids: string[]; odd: boolean };
        const worlds: World[] = Array.from({ length: 12 }, (_, i) => {
            const odd = i % 4 === 3;
            return { ids: Array.from({ length: 20 + Math.floor(rand() * 581) }, odd ? oddId : uuid), odd };
        });
        type Device = { held: { set: string[]; tied: string[]; hash: string } | null; diffs: boolean };
        type Reader = { key: string; world: number; tied: Set<string>; devices: Device[] };
        const readers: Reader[] = Array.from({ length: 60 }, (_, i) => ({
            key: `reader-${i}`,
            world: i % worlds.length,
            tied: new Set<string>(),
            devices: Array.from({ length: rand() < 0.5 ? 1 : 2 }, () => ({ held: null, diffs: rand() < 0.85 })),
        }));
        // The reader's list as the memory keeps it: the last 4 hashes named or confirmed, emptied by a restart.
        const lists = new Map<string, string[]>();
        const listed = (r: Reader, h: string) => {
            const l = (lists.get(r.key) ?? []).filter(x => x !== h);
            l.push(h);
            lists.set(r.key, l.slice(-NEARBY_SET_HASHES_PER_READER));
        };
        const current = (r: Reader) => {
            const ids = worlds[r.world].ids;
            const inSet = new Set(ids);
            for (const t of [...r.tied]) if (!inSet.has(t)) r.tied.delete(t);
            return { ids, tied: ids.filter(id => r.tied.has(id)) };
        };
        const t = tally();
        let checks = 0, restarts = 0, cut = 0, confirms = 0, foreign = 0;
        const shapes = { whole: 0, diff: 0, unchanged: 0 };
        const CYCLES = 3000;
        for (let cycle = 0; cycle < CYCLES; cycle++) {
            if (cycle > 0 && cycle % 150 === Math.floor(rand() * 3)) {
                memory = new NearbySetMemory(LIMITS);
                lists.clear();
                restarts++;
            }
            // One world changes 0-40 ids: some go, some come (nearest first is the order: a few move up).
            const w = pick(worlds);
            const changes = Math.floor(rand() * 41);
            for (let c = 0; c < changes; c++) {
                const roll = rand();
                if (roll < 0.45 && w.ids.length > 20) w.ids.splice(Math.floor(rand() * w.ids.length), 1);
                else if (roll < 0.9 && w.ids.length < 600) w.ids.splice(Math.floor(rand() * (w.ids.length + 1)), 0, w.odd ? oddId() : uuid());
                else if (w.ids.length > 1) {
                    const [moved] = w.ids.splice(Math.floor(rand() * w.ids.length), 1);
                    w.ids.splice(Math.floor(rand() * w.ids.length), 0, moved);
                }
            }
            const r = pick(readers);
            // Ties flip: a deal opened on a listing in the set, or one closed.
            if (rand() < 0.3) {
                const id = pick(worlds[r.world].ids);
                if (r.tied.has(id)) r.tied.delete(id); else r.tied.add(id);
            }
            const dev = pick(r.devices);
            const S = current(r);
            const want = nearbySetHash(S.ids, S.tied);
            // A 304: the phone holds the set as it is, and the node confirms it.
            if (dev.held?.hash === want && rand() < 0.25) {
                memory.confirmed(r.key, S);
                listed(r, want);
                confirms++;
            } else {
                // Now and then a phone sends another reader's hash (one not on its own list): never a diff.
                let sent = dev.held?.hash;
                let foreignHash = false;
                if (rand() < 0.05) {
                    const other = pick(readers.filter(o => o !== r)).devices.find(d => d.held)?.held?.hash;
                    if (other && other !== want && !(lists.get(r.key) ?? []).includes(other)) { sent = other; foreignHash = true; foreign++; }
                }
                const known = !!sent && (lists.get(r.key) ?? []).includes(sent);
                const ans = memory.answer(r.key, S, { setHash: sent, setDiff: dev.diffs });
                listed(r, want);
                checks++;
                if ('setUnchanged' in ans) {
                    shapes.unchanged++;
                    t.check(ans.setUnchanged === want && sent === want, () => `cycle ${cycle}: unchanged ${ans.setUnchanged} for a set hashed ${want}`);
                } else if ('setAdd' in ans) {
                    shapes.diff++;
                    t.check(dev.diffs && known && !foreignHash, () => `cycle ${cycle}: a diff to a phone that ${dev.diffs ? '' : 'never said setDiff, '}sent ${known ? 'a hash on its list' : 'a hash not on its list'}${foreignHash ? ' (another reader\'s)' : ''}`);
                    t.check(ans.setAdd.length + ans.setDrop.length < new Set(S.ids).size, () => `cycle ${cycle}: a diff of ${ans.setAdd.length}+${ans.setDrop.length} for a set of ${S.ids.length}`);
                    t.check(ans.setHash === want, () => `cycle ${cycle}: the diff's hash ${ans.setHash}, the set's ${want}`);
                    if (dev.held && !foreignHash) {
                        const tiedMoved = !sameSet(dev.held.tied, S.tied);
                        t.check(('tied' in ans) === tiedMoved, () => `cycle ${cycle}: tied ${'tied' in ans ? 'named' : 'absent'} where it ${tiedMoved ? 'moved' : 'did not'}`);
                    }
                } else {
                    shapes.whole++;
                    t.check(ans.setHash === want && ans.set.join() === S.ids.join() && ans.tied.join() === S.tied.join(), () => `cycle ${cycle}: a whole answer that is not the set`);
                }
                // The phone: a read cut short applies nothing; else it applies the answer and verifies it as the app does.
                if (rand() < 0.1) { cut++; continue; }
                if ('setUnchanged' in ans) continue;
                if ('setAdd' in ans) {
                    if (!dev.held) { t.check(false, () => `cycle ${cycle}: a diff to a phone that holds nothing`); continue; }
                    const applied = applyDiff(dev.held, ans);
                    const ok = nearbySetHash(applied.set, applied.tied) === ans.setHash;
                    t.check(ok, () => `cycle ${cycle}: the applied diff hashes to ${nearbySetHash(applied.set, applied.tied)}, not ${ans.setHash}`);
                    dev.held = ok ? { ...applied, hash: ans.setHash } : null;
                } else {
                    dev.held = { set: ans.set, tied: ans.tied, hash: ans.setHash };
                }
                t.check(!!dev.held && sameSet(dev.held.set, S.ids) && sameSet(dev.held.tied, S.tied) && nearbySetHash(dev.held.set, dev.held.tied) === want,
                    () => `cycle ${cycle}: the phone holds ${dev.held?.set.length} ids, the set is ${S.ids.length}`);
            }
            const h = memory.held();
            t.check(h.bytes <= LIMITS.budgetBytes && h.sets <= LIMITS.maxSets && h.readers <= LIMITS.maxReaders,
                () => `cycle ${cycle}: ${h.bytes} bytes, ${h.sets} sets, ${h.readers} readers past the bounds`);
        }
        t.report(`every answer applied by a model phone is exactly the set and its tied, hashed to setHash; a hash not on the reader's own list is never a diff; within the bounds after every step`, checks);
        const all = shapes.whole + shapes.diff + shapes.unchanged;
        console.log(`  ${CYCLES} cycles: ${all} answers (${shapes.diff} diffs = ${(100 * shapes.diff / all).toFixed(1)}%, ${shapes.whole} whole, ${shapes.unchanged} unchanged), ${confirms} 304s, ${cut} reads cut short, ${foreign} foreign hashes, ${restarts} restarts, ${memory.held().evictions} evictions since the last`);
        assert(shapes.diff > all / 10 && restarts >= 15 && foreign > 50 && cut > 100,
            `the model reaches every case: diffs ${shapes.diff}, restarts ${restarts}, foreign hashes ${foreign}, cut reads ${cut}`);
        assert(memory.held().evictions > 0, `the tiny budget evicts (${memory.held().evictions} since the last restart)`);
    }

    // ── 4. the bound, measured ──
    console.log('\n── 4. 20,000 distinct hub-size sets under the default bounds ──');
    {
        delete process.env.NEARBY_SET_MEMORY_MB;
        const limits = nearbySetMemoryLimits();
        assert(limits.budgetBytes === 32 * 1024 * 1024 && limits.maxSets === 20_000 && limits.maxReaders === 20_000, 'the defaults: 32 MB, 20,000 sets, 20,000 readers');
        let gc: (() => void) | null = null;
        try {
            v8.setFlagsFromString('--expose-gc');
            gc = vm.runInNewContext('gc') as () => void;
        } catch { gc = null; }
        const heap = () => { gc?.(); gc?.(); const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
        const before = heap();
        const memory = new NearbySetMemory(limits);
        let maxBytes = 0, maxSets = 0;
        const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
        for (let i = 0; i < 20_000; i++) {
            const ids = Array.from({ length: 500 }, (_, j) => `${hex(i, 8)}-${hex(j, 4)}-4000-8000-${hex(i * 500 + j, 12)}`);
            memory.answer(hex(i, 64), { ids, tied: ids.slice(0, 100) }, {});
            if (i % 1000 === 999) { const h = memory.held(); maxBytes = Math.max(maxBytes, h.bytes); maxSets = Math.max(maxSets, h.sets); }
        }
        const held = memory.held();
        const after = heap();
        const grew = after - before;
        console.log(`  held: ${held.sets} sets, ${(held.bytes / 1048576).toFixed(1)} MB counted, ${held.readers} readers, ${held.evictions} evictions; heap grew ${(grew / 1048576).toFixed(1)} MB${gc ? '' : ' (no forced GC)'}`);
        assert(held.bytes <= 32 * 1024 * 1024 && maxBytes <= 32 * 1024 * 1024, `at most 32 MB counted, at every sample (${(maxBytes / 1048576).toFixed(1)} MB at most)`);
        assert(held.sets <= 20_000 && maxSets <= 20_000 && held.readers <= 20_000, `at most 20,000 sets and readers (${held.sets} sets, ${held.readers} readers)`);
        assert(held.evictions === 20_000 - held.sets, `the oldest went: ${held.evictions} evictions`);
        assert(grew <= 1.5 * held.bytes, `the heap grew ${(grew / 1048576).toFixed(1)} MB for ${(held.bytes / 1048576).toFixed(1)} MB counted: within 1.5× (${(grew / held.bytes).toFixed(2)}×)`);
    }

    // ── 5. NEARBY_SET_MEMORY_MB ──
    console.log('\n── 5. NEARBY_SET_MEMORY_MB ──');
    {
        process.env.NEARBY_SET_MEMORY_MB = '0';
        const off = new NearbySetMemory(nearbySetMemoryLimits());
        const ids = Array.from({ length: 40 }, uuid);
        const first = off.answer('r', { ids, tied: [] }, { setDiff: true }) as { setHash: string };
        const same = off.answer('r', { ids, tied: [] }, { setHash: first.setHash, setDiff: true });
        const moved = off.answer('r', { ids: [...ids, 'new'], tied: [] }, { setHash: first.setHash, setDiff: true });
        assert('setUnchanged' in same && 'set' in moved && off.held().sets === 0 && off.held().readers === 0,
            `0: nothing held, an unchanged set still { setUnchanged }, a changed one whole (${Object.keys(moved).join('+')})`);
        process.env.NEARBY_SET_MEMORY_MB = '-1';
        assert(nearbySetMemoryLimits().budgetBytes === 32 * 1024 * 1024, 'a value out of range is the default');
        process.env.NEARBY_SET_MEMORY_MB = '8';
        assert(nearbySetMemoryLimits().budgetBytes === 8 * 1024 * 1024, '8 is 8 MB');
        delete process.env.NEARBY_SET_MEMORY_MB;
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A changed nearby set goes as what changed, and a phone always ends with exactly the set.');
}

try {
    main();
    process.exit(0);
} catch (e) {
    console.error('❌ Test failed:', e);
    process.exit(1);
}
