/**
 * scripts/flake-patterns.mjs (test-all `flake_patterns`): each rule goes red on a planted bad sample, the shape that went red on
 * a loaded runner, and stays green on the planted good one (the fix that landed), and on near-miss names (#3165 went red on a
 * local named `sign`). Then the repository against scripts/flake-patterns-ceiling.json.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RULE_IDS, blank, judge, lowerCeiling, mainCeiling, raisedOver, readCeiling, scanRepo, scanSource, total } from './flake-patterns.mjs';

const SORT_KEYS = new Set(['sentAt', 'createdAt']);
const hitsOf = (src, rule) => scanSource(src, { sortKeys: SORT_KEYS }).hits.filter((h) => h.rule === rule);

describe('reading code: comments and strings are not code', () => {
    it('blanks comments, strings and template text, keeps lines and ${} code', () => {
        const src = "const a = 'expect(document.activeElement)'; // await x\nconst b = `t ${performance.now()} u`; /* Date.now() */\nconst r = /a\\/b'/g; const c = 1;";
        const out = blank(src);
        assert.equal(out.length, src.length);
        assert.equal(out.split('\n').length, 3);
        assert.doesNotMatch(out, /activeElement|await|Date\.now/);
        assert.match(out, /performance\.now\(\)/);
        assert.match(out, /const c = 1;/);
    });
});

describe('focus-after-await', () => {
    const R = 'focus-after-await';
    // The RecoveryKitButton test before #3161: the question is found, then the focus is read at once.
    const BAD = `
it('the question comes with the focus', async () => {
    printed(onKept);
    const group = await screen.findByRole('group', { name: ASK });
    expect(onKept).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(group);
});
it('focus goes back when the sheet closes', async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sheet')).toBeNull());
    expect(sheet.contains(document.activeElement)).toBe(false);
    expect(opener).toHaveFocus();
});
it('a sleep is not a wait', async () => {
    const sheet = await screen.findByTestId('sheet');
    await new Promise((r) => setTimeout(r, 50));
    expect(sheet.contains(document.activeElement)).toBe(true);
});`;
    // The fix (#3161), and reads that are settled: after act(), after userEvent, after a click in act, with no await at all.
    const GOOD = `
const pause = async (ms = 50) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
it('the question comes with the focus', async () => {
    printed(onKept);
    const group = await screen.findByRole('group', { name: ASK });
    await waitFor(() => expect(document.activeElement).toBe(group));
});
it('after act', async () => {
    await act(async () => { render(<Sheet />); });
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
});
it('after a helper that ends in act', async () => {
    await pause(60);
    expect(document.activeElement).toBe(menu);
});
it('after userEvent', async () => {
    await user.tab();
    expect(document.activeElement).toBe(next);
});
it('a click in act after the await', async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Not yet' }));
    expect(document.activeElement).toBe(kit);
});
it('the test moves the focus itself', async () => {
    expect(await screen.findByTestId('shop-front')).toBeInTheDocument();
    nameButton.focus();
    expect(document.activeElement).toBe(nameButton);
});
it('no await at all', () => {
    render(<Sheet />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
});
it('not a read in an expect', async () => {
    await screen.findByRole('dialog');
    const activeElementName = document.activeElement?.tagName;
    (document.activeElement as HTMLElement | null)?.blur();
});`;
    it('goes red on the bad sample, once per read', () => {
        assert.deepEqual(hitsOf(BAD, R).map((h) => h.line), [6, 11, 12, 17]);
    });
    it('stays green on the good sample', () => {
        assert.deepEqual(hitsOf(GOOD, R), []);
    });
});

describe('fixed-ms-bound', () => {
    const R = 'fixed-ms-bound';
    // test-members-on-demand before #3166 (the chain, cut down): a helper times a read, a round takes p95s, the best is held
    // under fixed milliseconds. And a plain one, and the CPU helper place-circles uses.
    const BAD = `
async function get(p) {
    const t0 = performance.now();
    const r = await fetch(p);
    const ms = performance.now() - t0;
    return { status: r.status, ms };
}
async function round() {
    const times = { q: [] };
    for (let i = 0; i < 60; i++) { const q = await get('/q'); if (q.status === 200) times.q.push(q.ms); }
    return { all: times.q.length === 60, q: p95(times.q) };
}
const best = { q: Infinity };
const t = await round();
best.q = Math.min(best.q, t.q);
assert(best.all && best.q <= 5 * slack, 'q p95 under 5 ms');
const started = Date.now();
await work();
expect(Date.now() - started).toBeLessThan(2000);
const cpuMs = (work) => { const c0 = process.cpuUsage(); work(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; };
const runMs = Math.min(...[1, 2, 3].map(() => cpuMs(() => compare())));
assert(clusters.length > 0 && runMs < 50, 'compare in under 50 ms CPU');`;
    // The fix (#3166): the same reads held to a ratio of a plain read measured in the same round. And near misses: a timed
    // helper's other fields, a timestamp's age, a size, a local named like a clock.
    const GOOD = `
async function get(p) {
    const t0 = performance.now();
    const r = await fetch(p);
    return { status: r.status, text: await r.text(), ms: performance.now() - t0 };
}
async function round() {
    const times = { q: [], floor: [] };
    for (let i = 0; i < 60; i++) { times.q.push((await get('/q')).ms); times.floor.push((await get('/plain')).ms); }
    const floor = p95(times.floor);
    return { floor, x: p95(times.q) / floor };
}
const t = await round();
assert(t.x <= BOUND.q, 'q p95 within the bound of a plain read');
const r100 = await get('/keys');
assert(r100.status < 300 && r100.text.length < 40_000, 'answered, small');
expect(Math.abs(notes[0].at - Date.now())).toBeLessThan(60_000);
const performanceNow = 3; const dateNow = 4;
assert(performanceNow < 50 && dateNow < 5, 'not clocks');
const deadline = Date.now() + 5000;
assert(deadline < Infinity, 'a deadline is not a measured time');`;
    it('goes red on the bad sample: the old members-on-demand chain, a plain wall clock, a CPU helper', () => {
        assert.deepEqual(hitsOf(BAD, R).map((h) => h.line), [16, 19, 22]);
    });
    it('stays green on the good sample', () => {
        assert.deepEqual(hitsOf(GOOD, R), []);
    });
});

describe('clock-per-row', () => {
    const R = 'clock-per-row';
    // notice-bell-header (15 Nov): each notice reads the clock for sentAt, which the bell sorts newest first.
    const BAD = `
const notice = (id, over = {}) => ({ id, title: 'New', sentAt: Math.floor(Date.now() / 1000) - 120, seenAt: null, ...over });
it('rows in order', async () => {
    node.notices = Object.entries(words).map(([kind, body], i) => notice('c' + i, { body }));
    node.notices = [notice('n1'), notice('n2'), notice('n3')];
    const rows = ids.map((id) => ({ id, createdAt: new Date().toISOString() }));
});`;
    // The fix: the clock read once and each row its own time; or the clock stopped; or a field the product does not sort by.
    const GOOD = `
const NOW = Math.floor(Date.now() / 1000);
const notice = (id, i = 0, over = {}) => ({ id, title: 'New', sentAt: NOW - 120 - i, seenAt: null, ...over });
const profile = (u) => ({ url: u, checkedAt: new Date().toISOString() });
it('rows in order', async () => {
    node.notices = Object.entries(words).map(([kind, body], i) => notice('c' + i, i, { body }));
    node.notices = [notice('n1', 0), notice('n2', 1)];
    const rows = ids.map((id, i) => ({ id, createdAt: new Date(Date.now() - i * 1000).toISOString() }));
    const profiles = [profile('a'), profile('b')];
    const one = [notice('n1')];
});`;
    const STOPPED = `
vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
const notice = (id) => ({ id, sentAt: Math.floor(Date.now() / 1000) });
node.notices = [notice('n1'), notice('n2')];`;
    it('goes red on the bad sample', () => {
        assert.deepEqual(hitsOf(BAD, R).map((h) => h.line), [4, 5, 6]);
    });
    it('stays green on the good sample, and where the clock is stopped', () => {
        assert.deepEqual(hitsOf(GOOD, R), []);
        assert.deepEqual(hitsOf(STOPPED, R), []);
    });
    it('a stopped clock named only in a comment stops nothing', () => {
        assert.equal(hitsOf(`// no vi.useFakeTimers() here\n${BAD}`, R).length, 3);
    });
});

describe('allow comments', () => {
    const SRC = (comment) => `
it('x', async () => {
    await screen.findByRole('dialog');
    ${comment}
    expect(document.activeElement).toBe(box);
});`;
    it('a reason on the line above excuses the hit', () => {
        const r = scanSource(SRC('// flake-ok(focus-after-await): the focus moved in the click, before the wait'));
        assert.deepEqual(r.hits, []);
        assert.deepEqual(r.badAllows, []);
    });
    it('no reason: the hit stays and the comment is named', () => {
        const r = scanSource(SRC('// flake-ok(focus-after-await): fine'));
        assert.equal(r.hits.length, 1);
        assert.match(r.badAllows[0].why, /no reason/);
    });
    it('a rule that does not exist is named', () => {
        const r = scanSource(SRC('// flake-ok(focus-after-wait): the focus moved in the click, before the wait'));
        assert.equal(r.hits.length, 1);
        assert.match(r.badAllows[0].why, /names no rule/);
    });
    it('an allow written inside a string (a sample, as in this file) is not an allow', () => {
        const r = scanSource("const sample = '// flake-ok(focus-after-await): fine';\nconst t = `\n// flake-ok(nope): x\n`;\n");
        assert.deepEqual(r.badAllows, []);
    });
    it('an allow that excuses nothing is named', () => {
        const r = scanSource("const a = 1;\n// flake-ok(fixed-ms-bound): a generous bound on a hang, never close\nconst b = 2;\n");
        assert.match(r.badAllows[0].why, /excuses nothing/);
    });
});

describe('the ceiling only falls', () => {
    const ceiling = { 'focus-after-await': { 'a.test.tsx': 2 }, 'fixed-ms-bound': {}, 'clock-per-row': {} };
    it('a file over its count fails; a new file with a hit fails', () => {
        assert.equal(judge({ 'focus-after-await': { 'a.test.tsx': 3 } }, ceiling).over.length, 1);
        assert.equal(judge({ 'fixed-ms-bound': { 'b.test.ts': 1 } }, ceiling).over.length, 1);
    });
    it('a file under its count passes and is listed; --update lowers it, never raises or adds', () => {
        const j = judge({ 'focus-after-await': { 'a.test.tsx': 1 } }, ceiling);
        assert.equal(j.over.length, 0);
        assert.equal(j.lowered.length, 1);
        assert.deepEqual(lowerCeiling({ 'focus-after-await': { 'a.test.tsx': 1 } }, ceiling)['focus-after-await'], { 'a.test.tsx': 1 });
        assert.deepEqual(lowerCeiling({ 'focus-after-await': { 'a.test.tsx': 5, 'new.test.ts': 1 } }, ceiling)['focus-after-await'], { 'a.test.tsx': 2 });
        assert.deepEqual(lowerCeiling({}, ceiling)['focus-after-await'], {});
    });
    it('a ceiling raised over main\'s, or a file added to it, is named', () => {
        assert.deepEqual(raisedOver(ceiling, ceiling), []);
        assert.deepEqual(raisedOver({ 'focus-after-await': { 'a.test.tsx': 1 } }, ceiling), []);
        assert.deepEqual(raisedOver({ 'focus-after-await': { 'a.test.tsx': 3 } }, ceiling).map((r) => r.was), [2]);
        assert.deepEqual(raisedOver({ 'fixed-ms-bound': { 'b.test.ts': 1 } }, ceiling).map((r) => r.file), ['b.test.ts']);
    });
});

describe('the repository', () => {
    const scan = scanRepo();
    const ceiling = readCeiling();
    it('is reading the test files (not passing because it sees none)', () => {
        // 2,681 on 15 Nov 2026; a listing that breaks reads far fewer.
        assert.ok(scan.files >= 2000, `read ${scan.files} test files`);
        assert.deepEqual(Object.keys(ceiling).sort(), [...RULE_IDS].sort());
    });
    it('has no file over its ceiling for a known flaky shape', () => {
        const { over } = judge(scan.counts, ceiling);
        const named = over.map((o) => `${o.rule} ${o.file}: ${o.n} (ceiling ${o.cap}); lines ${scan.list.filter((h) => h.file === o.file && h.rule === o.rule).map((h) => h.line).join(', ')}`);
        assert.deepEqual(named, [], `run node scripts/flake-patterns.mjs for the fix each rule asks for (${RULE_IDS.map((r) => `${r} ${total(scan.counts[r])}`).join(', ')})`);
    });
    it('never raises the ceiling over main\'s (a new hit takes a flake-ok reason instead)', (t) => {
        const base = mainCeiling();
        if (!base) { t.skip('no ceiling on origin/main to compare with (no origin/main, or before this file landed)'); return; }
        assert.deepEqual(raisedOver(ceiling, base).map((r) => `${r.rule} ${r.file}: ${r.n}, main ${r.was}`), []);
    });
    it('has no flake-ok comment without a reason, or that excuses nothing', () => {
        assert.deepEqual(scan.badAllows.map((b) => `${b.file}:${b.line}: ${b.why}`), []);
    });
});
