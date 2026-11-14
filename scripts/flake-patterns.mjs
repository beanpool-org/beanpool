#!/usr/bin/env node
/**
 * Known flaky test shapes do not land (scripts/test-all.sh, `flake_patterns`; Marty, 15 Nov 2026: "stop the known flaky test
 * shapes landing"). Each rule below is a shape that went red on a loaded runner and was fixed this fortnight:
 *
 *   focus-after-await   `expect(document.activeElement)` / `toHaveFocus()` read straight after an await that is not act(), outside
 *                       waitFor. React 19 commits an update made after an await in one task and runs its focusing effect in a
 *                       later one; RTL's findBy/waitFor resolve after a setTimeout(0) that a loaded runner can run first
 *                       (#3161 RecoveryKitButton, the 4 tests lane 1134 fixes). Fix: `await waitFor(() => expect(...))`.
 *   fixed-ms-bound      a time the test measured (performance.now(), Date.now() - t0, process.hrtime/cpuUsage) held under a fixed
 *                       number of milliseconds. A shared runner's neighbour moves it (#3166 members-on-demand p95, #3115 the id
 *                       guard, place-circles' CPU 50 ms). Fix: a ratio to a baseline measured in the same run, in the same loop.
 *   clock-per-row       the rows of one list each read the live clock (a fixture helper with `Date.now()`/`new Date()` called for
 *                       every row) where the clock is not stopped. The rows' times are equal, except when the clock ticks between
 *                       two of them, so an order sorted by that time is fixed by nothing but luck (notice-bell-header, 15 Nov:
 *                       three credit notices, `sentAt` from Date.now() each, sorted newest first). Fix: read the clock once and
 *                       give each row its own time (`now - i`), or stop the clock (vi.useFakeTimers / vi.setSystemTime).
 *
 * Only what can be found with few false alarms: each rule reads code with its comments and strings blanked, matches exact API
 * names (never a word inside a longer name: #3165 went red on a local named `sign`), and was measured over every test file in the
 * repo (the PR that added this says how many hits each rule found and how many were judged real).
 *
 * THE CEILING (scripts/flake-patterns-ceiling.json): today's hits per rule, per file. A file over its count fails; a file under it
 * passes and is printed, and `node scripts/flake-patterns.mjs --update` lowers the counts (never raises one, never adds a file).
 * A NEW hit that is not the shape (or is, harmlessly) takes a comment on its line or the line above:
 *     // flake-ok(<rule>): <why, in at least four words>
 * An allow without a reason, or one that excuses nothing, fails.
 *
 * `node scripts/flake-patterns.mjs` checks; `--list` prints every hit; `--update` lowers the ceiling. The tests (planted bad and
 * good samples for each rule, and the repository against the ceiling) are scripts/flake-patterns.test.mjs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CEILING_FILE = 'scripts/flake-patterns-ceiling.json';

/** The files read: every test, check and e2e walk in the repo. */
export const TEST_FILE = /(\.test\.(ts|tsx|mjs|js)$|\.check\.ts$|\.spec\.(ts|tsx)$|^apps\/server\/src\/test-[^/]*\.ts$|\/e2e\/.*\.(ts|tsx|mjs|js)$)/;
const SKIP_DIR = /(^|\/)(node_modules|dist|generated|build|\.expo)\//;

// ── Reading code: comments and strings blanked, lines and columns kept ─────────────────────────────────────────────

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * The source with every comment, string and template text replaced by spaces (newlines kept), so a rule reads only code and a
 * match's offset is its place in the file. A template's `${...}` stays code. A regex literal is blanked too.
 */
export function blank(src, onComment = null) {
    const out = src.split('');
    const n = src.length;
    const stack = []; // template nesting: the brace depth at which each `${` opened
    let depth = 0;
    let i = 0;
    let lastSig = ''; // the last significant code character, for regex-vs-divide
    let lastWordEnd = -1;
    const wipe = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
    const template = () => {
        // at the char after ` or after the } that closed a ${
        const start = i;
        while (i < n) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '`') { wipe(start, i); i++; lastSig = 'a'; return; }
            if (c === '$' && src[i + 1] === '{') { wipe(start, i); i += 2; stack.push(depth); depth++; lastSig = '{'; return; }
            i++;
        }
        wipe(start, n);
    };
    while (i < n) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; onComment?.(i, src.slice(i, end)); wipe(i, end); i = end; continue; }
        if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; wipe(i, end); i = end; continue; }
        if (c === '"' || c === "'") {
            const s = i; i++;
            while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
            wipe(s + 1, i); i++; lastSig = 'a'; continue;
        }
        if (c === '`') { i++; template(); continue; }
        if (c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) { stack.pop(); depth--; i++; template(); continue; }
        if (c === '/') {
            const before = src.slice(Math.max(0, lastWordEnd - 12), i).trimEnd();
            const isRegex = lastSig === '' || REGEX_BEFORE.has(lastSig) || (lastWordEnd >= 0 && REGEX_AFTER_WORD.test(src.slice(0, i).trimEnd()) && before.length);
            if (isRegex) {
                const s = i; i++;
                let cls = false;
                while (i < n && src[i] !== '\n') {
                    if (src[i] === '\\') { i += 2; continue; }
                    if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '/' && !cls) break;
                    i++;
                }
                wipe(s + 1, i); i++;
                while (i < n && /[a-z]/i.test(src[i])) i++;
                lastSig = 'a'; continue;
            }
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (/[\w$]/.test(c)) { while (i < n && /[\w$]/.test(src[i])) i++; lastSig = 'a'; lastWordEnd = i; continue; }
        if (!/\s/.test(c)) lastSig = c;
        i++;
    }
    return out.join('');
}

/** 1-based line of an offset. */
export function lineOf(src, at) {
    let line = 1;
    for (let k = 0; k < at && k < src.length; k++) if (src[k] === '\n') line++;
    return line;
}

/** The offsets of the `(` that are still open at `at`, innermost last. */
function openParens(code, at) {
    const open = [];
    for (let k = 0; k < at; k++) {
        const c = code[k];
        if (c === '(') open.push(k);
        else if (c === ')') open.pop();
    }
    return open;
}

/** The offset just past the `)` that closes the `(` at `p` (or the end). */
function closeOf(code, p) {
    let d = 0;
    for (let k = p; k < code.length; k++) {
        if (code[k] === '(') d++;
        else if (code[k] === ')') { d--; if (d === 0) return k + 1; }
    }
    return code.length;
}

/** The callee written just before the `(` at `p` (`waitFor`, `vi.waitFor`, `it.only`), or ''. */
function calleeBefore(code, p) {
    const m = /([\w$.]+)\s*(?:<[^<>()]*>)?\s*$/.exec(code.slice(Math.max(0, p - 80), p));
    return m ? m[1] : '';
}

// ── The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Calls whose callback is retried until it passes: a read inside one waits for the effect. */
const RETRIES = /(^|\.)(waitFor|waitForExpect|until|poll|eventually|retry|toPass)$/;
const TEST_CALL = /^(it|test)(\.(only|skip|concurrent|each|todo|fails))*$/;
/** An awaited call that settles React's effects before it resolves: act(), userEvent (its eventWrapper is act). */
const ACT_AWAIT = /(^|\.)act$|^(user|userEvent|u|ue)\.[\w$]+$|^userEvent$/;
/** A synchronous step that runs in act() or moves the focus itself. */
const ACT_STEP = /(?:^|[^\w$.])(?:fireEvent\s*\.\s*[\w$]+|fireEvent|act|render|rerender)\s*\(|[\w$)\]]\s*\??\.\s*(?:focus|blur|click)\s*\(\s*\)/;

/** The body of each function this file declares by name (`function f() {…}`, `const f = async () => {…}` or `=> expr`). */
export function localFunctions(code) {
    const out = new Map();
    const re = /(?:\b(?:async\s+)?function\s*\*?\s*([\w$]+)\s*(?:<[^>]*>)?\s*\(|\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b[^(]*)?\()/g;
    let m;
    while ((m = re.exec(code))) {
        const name = m[1] ?? m[2];
        const params = m.index + m[0].length - 1;
        let k = closeOf(code, params);
        const arrow = /^\s*(?::[^={]+)?(=>)?\s*/.exec(code.slice(k));
        if (m[2] && !arrow[1] && !/function/.test(m[0])) continue; // `const x = (a)` is a value, not a function
        k += arrow[0].length;
        let end;
        if (code[k] === '{') {
            let d = 0; end = code.length;
            for (let j = k; j < code.length; j++) { if (code[j] === '{') d++; else if (code[j] === '}') { d--; if (d === 0) { end = j + 1; break; } } }
        } else {
            let d = 0; end = code.length;
            for (let j = k; j < code.length; j++) {
                const c = code[j];
                if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { if (d === 0) { end = j; break; } d--; } else if ((c === ';' || c === ',') && d === 0) { end = j; break; }
            }
        }
        if (!out.has(name)) out.set(name, code.slice(k, end));
    }
    return out;
}

/** True when awaiting this local helper settles React's effects: its own last wait is act() or userEvent, or an act step follows it. */
function helperSettles(body) {
    // The helper's own awaits: not those inside an act() callback (`await act(async () => { await sleep(); })` settles).
    const awaits = [...body.matchAll(/\bawait\b\s*([\w$.]*)/g)]
        .filter((a) => !openParens(body, a.index).some((p) => /(^|\.)act$/.test(calleeBefore(body, p))));
    const last = awaits[awaits.length - 1];
    if (!last) return /(?:^|[^\w$.])act\s*\(/.test(body) && !/\b(?:findBy|findAllBy|waitFor)\w*\s*\(/.test(body);
    return ACT_AWAIT.test(last[1]) || ACT_STEP.test(body.slice(last.index + last[0].length).replace(/^[^;]*;/, ''));
}

function focusAfterAwait(code) {
    const hits = [];
    let helpers = null;
    const re = /\bactiveElement\b|\.\s*toHaveFocus\s*\(/g;
    let m;
    const seen = new Set();
    while ((m = re.exec(code))) {
        const open = openParens(code, m.index);
        // A read inside expect(...)'s subject (`expect(document.activeElement)`, `expect(box.contains(document.activeElement))`),
        // or a toHaveFocus() matcher; once per statement.
        if (!m[0].includes('toHaveFocus') && !open.some((p) => /(^|[^\w$.])expect$/.test(' ' + calleeBefore(code, p)))) continue;
        if (open.some((p) => RETRIES.test(calleeBefore(code, p)))) continue;
        if (/\bexpect\.poll\s*\(/.test(code.slice(Math.max(0, m.index - 300), m.index + 40)) && open.some((p) => /expect\.poll$/.test(calleeBefore(code, p)))) continue;
        const testOpen = [...open].reverse().find((p) => TEST_CALL.test(calleeBefore(code, p)));
        if (testOpen === undefined) continue;
        // The statement this read sits in, and the awaits before it in the same test.
        const stmtStart = Math.max(code.lastIndexOf(';', m.index), code.lastIndexOf('{', m.index), code.lastIndexOf('}', m.index));
        if (seen.has(stmtStart)) continue;
        seen.add(stmtStart);
        const body = code.slice(testOpen, stmtStart + 1);
        const awaits = [...body.matchAll(/\bawait\b\s*([\w$.]*)/g)]
            .filter((a) => !openParens(body, a.index).some((p) => p > 0 && /(^|\.)act$/.test(calleeBefore(body, p))));
        // An await inside the statement itself (`expect((await x).activeElement)`) counts as the one before it.
        const own = /\bawait\b\s*([\w$.]*)/.exec(code.slice(stmtStart + 1, m.index));
        const last = own ?? awaits[awaits.length - 1];
        if (!last) continue; // no await before it: the render that drew it ran in act(), effects and all
        // act() runs every effect it scheduled before it resolves; so do userEvent's actions (RTL's eventWrapper is act).
        if (ACT_AWAIT.test(last[1])) continue;
        helpers ??= localFunctions(code);
        if (helpers.has(last[1]) && helperSettles(helpers.get(last[1]))) continue;
        // An act()-wrapped step after that await, before the read (`fireEvent.click(await findBy…)`, a render, a .focus()):
        // the focus is then the step's own, settled in act.
        const lastAt = own ? stmtStart + 1 + own.index : testOpen + last.index;
        const lastStmt = Math.max(code.lastIndexOf(';', lastAt), code.lastIndexOf('{', lastAt), code.lastIndexOf('}', lastAt));
        if (ACT_STEP.test(code.slice(lastStmt + 1, m.index))) continue;
        hits.push({ at: m.index, what: `focus read after \`await ${last[1] || '…'}\`, outside waitFor` });
    }
    return hits;
}

// A clock read, written as a call.
const CLOCK_READ = String.raw`(?:performance\s*\.\s*now\s*\(\s*\)|Date\s*\.\s*now\s*\(\s*\)|process\s*\.\s*hrtime\s*(?:\.\s*bigint\s*)?\(\s*\)|process\s*\.\s*cpuUsage\s*\(\s*\))`;
const CLOCK_ANY = /\b(?:performance\s*\.\s*now|process\s*\.\s*hrtime|process\s*\.\s*cpuUsage)\s*\(|\bDate\s*\.\s*now\s*\(/;
const TIME_PROP = /^(?:ms|[\w$]*Ms|took|elapsed|duration|lag|waited|wait|secs|seconds)$/;
const esc = (s) => s.replace(/[$.]/g, (c) => `\\${c}`);
const word = (name) => new RegExp(`(?:^|[^\\w$.])${esc(name)}(?![\\w$])`);
/** `name` read as a value (not `name.x` or `name[...]`, which reads something it holds). */
const bare = (name) => new RegExp(`(?:^|[^\\w$.])${esc(name)}(?![\\w$]|\\s*[.[]\\s*[\\w$'"\`])`);

/** Names that hold the moment a clock was read: `const t0 = performance.now()`. */
function startMarks(code) {
    const marks = new Set();
    for (const m of code.matchAll(new RegExp(String.raw`(?:\b(?:const|let|var)\s+|(?:^|[^\w$.]))([\w$]+)\s*(?::\s*number\s*)?=\s*${CLOCK_READ}\s*[;,\n)]`, 'g'))) marks.add(m[1]);
    return marks;
}

/** A time measured from a start mark in this file: `performance.now() - t0`, `t1 - t0`, `process.hrtime(t0)`, `process.cpuUsage(c0)`. */
function diffTest(marks) {
    if (!marks.size) return () => false;
    const alt = [...marks].map(esc).join('|');
    const res = [
        new RegExp(String.raw`\b(?:performance|Date)\s*\.\s*now\s*\(\s*\)\s*-\s*(?:${alt})(?![\w$])`),
        new RegExp(String.raw`(?:^|[^\w$.])(?:${alt})\s*-\s*(?:${alt})(?![\w$])`),
        new RegExp(String.raw`\bprocess\s*\.\s*(?:hrtime|cpuUsage)\s*\(\s*(?:${alt})\s*\)`),
        new RegExp(String.raw`\bhrtime\s*\.\s*bigint\s*\(\s*\)\s*-\s*(?:${alt})(?![\w$])`),
    ];
    return (text) => res.some((r) => r.test(text));
}

/**
 * Names that hold a time this file measured, as numbers (`took`, `best.q`), and helpers whose result holds one (`cpuMs`, a
 * `timed()` that returns `{ status, ms }`). A number spreads to what is computed from it (`median(times)`, `Math.min(a, b)`);
 * a helper's result counts only as itself or through a time-named field (`r.ms`), never `r.status` or `r.text.length`.
 */
export function measuredNames(code) {
    const marks = startMarks(code);
    const isDiff = diffTest(marks);
    const nums = new Set();
    const fns = new Set();
    const results = new Set();
    const fnProps = new Map(); // a helper -> the fields of its returned object that hold a time
    const resultProps = new Map(); // a helper's result -> those fields
    const locals = localFunctions(code);
    for (const [name, body] of locals) if (isDiff(body)) fns.add(name);
    const assignRe = /(?:\b(?:const|let|var)\s+([\w$]+)|(?:^|[^\w$.])([\w$]+(?:\s*\.\s*[\w$]+)*))\s*(?::\s*[\w$<>[\]|, ]+)?\s*(?:[-+*/]?=)(?!=|>)([^;]*)/g;
    const pushRe = /(?:^|[^\w$.])([\w$]+(?:\s*\.\s*[\w$]+)*)\s*\.\s*push\s*\(([^;]*)/g;
    const calledFn = (text) => [...fns].find((f) => new RegExp(`(?:^|[^\\w$.])${esc(f)}\\s*\\(`).test(text));
    const timedField = (v, p) => TIME_PROP.test(p) || !!resultProps.get(v)?.has(p);
    const readsNum = (text) => isDiff(text) || [...nums].some((v) => (v.includes('.') ? word(v) : bare(v)).test(text))
        || [...results].some((v) => [...text.matchAll(new RegExp(`(?:^|[^\\w$.])${esc(v)}\\s*\\.\\s*([\\w$]+)`, 'g'))].some((m) => timedField(v, m[1])));
    for (let round = 0; round < 6; round++) {
        const before = nums.size + results.size + fns.size;
        for (const m of code.matchAll(assignRe)) {
            const lhs = (m[1] ?? m[2]).replace(/\s+/g, '');
            if (marks.has(lhs) || locals.has(lhs)) continue;
            const rhs = m[3];
            if (/^\s*(?:async\b|\([^()]*\)\s*=>|[\w$]+\s*=>|function\b)/.test(rhs)) continue; // a function, read above
            const fn = calledFn(rhs);
            if (fn && !lhs.includes('.') && /^\s*(?:await\s+)?[\w$.]+\s*\(/.test(rhs) && fnProps.get(fn)?.size) {
                results.add(lhs);
                resultProps.set(lhs, fnProps.get(fn));
            } else if (readsNum(rhs)) nums.add(lhs);
            else if (fn && !lhs.includes('.')) results.add(lhs);
        }
        for (const m of code.matchAll(pushRe)) if (readsNum(m[2])) nums.add(m[1].replace(/\s+/g, ''));
        // A helper that returns an object: the fields computed from a measured time (`return { q: p95(times.q), all }`).
        for (const [name, body] of locals) {
            for (const r of body.matchAll(/(?:\breturn\s*|^\s*\(\s*)\{/g)) {
                const open = r.index + r[0].length - 1;
                let d = 0;
                let end = body.length;
                for (let k = open; k < body.length; k++) { if (body[k] === '{') d++; else if (body[k] === '}') { d--; if (d === 0) { end = k; break; } } }
                for (const part of splitTop(body.slice(open + 1, end), [','])) {
                    const kv = /^\s*([\w$]+)\s*:([\s\S]*)$/.exec(part);
                    if (kv && readsNum(kv[2])) {
                        if (!fnProps.has(name)) fnProps.set(name, new Set());
                        fnProps.get(name).add(kv[1]);
                        fns.add(name);
                    }
                }
            }
        }
        if (nums.size + results.size + fns.size === before) break;
    }
    return { marks, isDiff, nums, fns, results, resultProps };
}

/** True when `side` is a measured time: a difference itself, a measured number, a helper's time, or one of these in a call. */
function isMeasured(side, t) {
    let s = side.trim();
    for (let k = 0; k < 4; k++) {
        const w = /^(?:Math\s*\.\s*(?:round|floor|ceil|abs|min|max)|Number|median|p\d\d|percentile|mean|avg|average|best|fastest|slowest|sum)\s*\(([\s\S]*)\)$/.exec(s)
            ?? /^\(([\s\S]*)\)$/.exec(s);
        if (!w) break;
        s = w[1].replace(/^\s*\.\.\./, '').trim();
    }
    s = s.replace(/\s*\/\s*1e?[\d_]*n?\s*$/, '').trim();
    if (t.isDiff(s)) return true;
    const path = /^([\w$]+(?:\s*\.\s*[\w$]+)*)$/.exec(s);
    if (!path) return /^[\w$]+\s*\(/.test(s) && t.fns.has(/^([\w$]+)/.exec(s)[1]);
    const p = path[1].replace(/\s+/g, '');
    if (t.nums.has(p) || t.results.has(p)) return true;
    const head = p.split('.')[0];
    const field = p.split('.').pop();
    if (p.includes('.') && (t.results.has(head) || t.nums.has(head)) && (TIME_PROP.test(field) || !!t.resultProps.get(head)?.has(field))) return true;
    return false;
}

/** A bound written as a number: `50`, `5 * slack`, `10_000`, `FETCH_TIMEOUT_MS * 4`; no measured name and no call in it. */
function fixedBound(text, t) {
    const s = text.trim().replace(/^\(+|\)+$/g, '').trim();
    if (!s || (!/\d/.test(s) && !/^[A-Z][A-Z0-9_]*$/.test(s))) return false;
    if (CLOCK_ANY.test(s) || t.isDiff(s)) return false;
    if ([...t.nums, ...t.results, ...t.marks].some((v) => word(v).test(s))) return false;
    return /^[\w$.\s*+\-/()]+$/.test(s) && !/[\w$]\s*\(/.test(s);
}

/** Split at the top level of brackets on any of `seps`. */
function splitTop(text, seps) {
    const out = [];
    let d = 0;
    let s = 0;
    for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if ('([{'.includes(c)) d++;
        else if (')]}'.includes(c)) d--;
        else if (d === 0) {
            const sep = seps.find((x) => text.startsWith(x, k));
            if (sep) { out.push(text.slice(s, k)); s = k + sep.length; k += sep.length - 1; }
        }
    }
    out.push(text.slice(s));
    return out;
}

function fixedMsBound(code) {
    const hits = [];
    if (!CLOCK_ANY.test(code)) return hits;
    const t = measuredNames(code);
    if (!t.marks.size) return hits;
    const hit = (at, bound) => hits.push({ at, what: `a time measured here, held under a fixed ${bound.trim().replace(/\s+/g, ' ')}` });
    // expect(<measured>).toBeLessThan(<number>) / toBeLessThanOrEqual(<number>), or expect(<measured> < <number>).toBe(true)
    for (const m of code.matchAll(/\bexpect\s*\(/g)) {
        const p = m.index + m[0].length - 1;
        const end = closeOf(code, p);
        const subject = code.slice(p + 1, end - 1);
        const tail = /^\s*\.\s*(toBeLessThan|toBeLessThanOrEqual)\s*\(/.exec(code.slice(end, end + 60));
        if (tail) {
            const bp = end + tail[0].length - 1;
            const bound = code.slice(bp + 1, closeOf(code, bp) - 1);
            if (isMeasured(subject, t) && fixedBound(bound, t)) hit(m.index, bound);
            continue;
        }
        const cmp = /^([^<>=]+?)\s*<=?\s*([^<>=][^<>]*)$/.exec(subject);
        if (cmp && isMeasured(cmp[1], t) && fixedBound(cmp[2], t)) hit(m.index, cmp[2]);
    }
    // assert(<measured> < <number> && ..., message), assert.ok(...)
    for (const m of code.matchAll(/(?:^|[^\w$.])(assert(?:\s*\.\s*ok)?|check|ok)\s*\(/g)) {
        const p = m.index + m[0].length - 1;
        const inner = code.slice(p + 1, closeOf(code, p) - 1);
        const first = splitTop(inner, [','])[0];
        for (const clause of splitTop(first, ['&&', '||'])) {
            const cmp = /^\s*([^<>=]+?)\s*<=?\s*([^<>=][^<>]*)$/.exec(clause);
            if (cmp && isMeasured(cmp[1], t) && fixedBound(cmp[2], t)) { hit(p - m[1].length, cmp[2]); break; }
        }
    }
    return hits;
}

const STOPPED_CLOCK = /\b(?:vi|jest)\s*\.\s*(?:useFakeTimers|setSystemTime)\s*\(|\bspyOn\s*\(\s*Date\s*,\s*['"`]?\s*now|\bDate\s*\.\s*now\s*=|\bmockdate\b|\bFakeTimers\b|\binstall\s*\(\s*\{[^}]*now/;
const LIVE_CLOCK = /\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)/;
/** `field: <a live clock read>` in an object literal; the value with no per-row offset (`now - i * 1000` is the fix). */
const CLOCK_FIELD = /([\w$]+)\s*:\s*([^,}]*?(?:\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\))[^,}]*)/g;
const PER_ROW_OFFSET = /\*|\b(?:i|idx|index|k|n|row|rank|order|offset)\b/;

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/**
 * The fields the product orders lists by, read from the app code (not tests): `.sort((a, b) => b.sentAt - a.sentAt)`,
 * `a.createdAt.localeCompare(b.createdAt)`, `ORDER BY sent_at` (also as sentAt). A row whose time is one of these is put in
 * order by it, so rows that each read the clock are ordered by when the clock ticked.
 */
export function productSortKeys(root = ROOT) {
    const keys = new Set();
    const out = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'workers'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const file of out.split('\0')) {
        if (!/\.(ts|tsx|js|mjs|sql)$/.test(file) || TEST_FILE.test(file) || SKIP_DIR.test(file) || /__tests__|\/test\/|\.d\.ts$/.test(file)) continue;
        let src;
        try { src = readFileSync(join(root, file), 'utf8'); } catch { continue; }
        for (const m of src.matchAll(/\bsort\s*\(\s*\(\s*([\w$]+)\s*(?::[^,)]*)?,\s*([\w$]+)\s*(?::[^)]*)?\)\s*=>([^\n]{0,240})/g)) {
            for (const f of m[3].matchAll(new RegExp(`\\b(?:${m[1]}|${m[2]})\\s*\\.\\s*([\\w$]+)`, 'g'))) if (!/^(localeCompare|getTime|valueOf|length)$/.test(f[1])) keys.add(f[1]);
        }
        for (const m of src.matchAll(/\bORDER\s+BY\s+([^;`'")]{1,200})/gi)) {
            for (const col of m[1].split(',')) {
                const c = /([a-z_][\w]*)\s*(?:asc|desc)?\s*$/i.exec(col.trim().replace(/\s+(?:limit|offset)\b[\s\S]*$/i, '').replace(/\s+nulls\s+(?:first|last)$/i, ''));
                if (c && /_at$|At$|time|date|^ts$|stamp/i.test(c[1])) { keys.add(c[1]); keys.add(camel(c[1])); }
            }
        }
    }
    return keys;
}

let sortKeysCache = null;

function clockPerRow(code, raw, opts = {}) {
    const hits = [];
    if (!LIVE_CLOCK.test(code) || STOPPED_CLOCK.test(raw)) return hits;
    const sortKeys = opts.sortKeys ?? (sortKeysCache ??= productSortKeys());
    /** The clock-read fields of an object-literal body that the product sorts by, with no per-row offset. */
    const sortedClockFields = (text) => [...text.matchAll(CLOCK_FIELD)]
        .filter((f) => sortKeys.has(f[1]) && !PER_ROW_OFFSET.test(f[2].replace(/\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)/g, '')))
        .map((f) => f[1]);
    // Fixture helpers whose row carries a sorted-by field from the live clock (`sentAt: Math.floor(Date.now() / 1000) - 120`).
    const helpers = new Map();
    for (const [name, body] of localFunctions(code)) {
        const fields = sortedClockFields(body);
        if (fields.length) helpers.set(name, fields[0]);
    }
    const helperCall = helpers.size ? new RegExp(`(?:^|[^\\w$.])(${[...helpers.keys()].map(esc).join('|')})\\s*\\(`, 'g') : null;
    // One list built from them: a .map / Array.from callback, or an array literal that calls a helper twice or more.
    for (const m of code.matchAll(/\.\s*(?:map|flatMap)\s*\(|\bArray\s*\.\s*from\s*\(/g)) {
        const p = m.index + m[0].length - 1;
        const inner = code.slice(p + 1, closeOf(code, p) - 1);
        if (!/=>|\bfunction\b/.test(inner)) continue;
        const calls = helperCall ? [...inner.matchAll(helperCall)] : [];
        const own = sortedClockFields(inner);
        if (calls.length) hits.push({ at: m.index, what: `each row reads the clock for ${helpers.get(calls[0][1])} (in ${calls[0][1]}()), which the product sorts by` });
        else if (own.length) hits.push({ at: m.index, what: `each row reads the clock for ${own[0]}, which the product sorts by` });
    }
    if (helperCall) {
        for (const m of code.matchAll(/\[/g)) {
            if (/[\w$)\]]\s*$/.test(code.slice(Math.max(0, m.index - 2), m.index))) continue; // an index, not a literal
            let d = 0;
            let k = m.index;
            for (; k < code.length; k++) { if ('([{'.includes(code[k])) d++; else if (')]}'.includes(code[k])) { d--; if (d === 0) break; } }
            const inner = code.slice(m.index + 1, k);
            // the helper called at the literal's own level twice or more
            const calls = [...inner.matchAll(helperCall)].filter((c) => {
                const head = inner.slice(0, c.index);
                return (head.match(/[([{]/g) ?? []).length === (head.match(/[)\]}]/g) ?? []).length;
            });
            if (calls.length >= 2) hits.push({ at: m.index, what: `${calls.length} rows each read the clock for ${helpers.get(calls[0][1])} (in ${calls[0][1]}()), which the product sorts by` });
        }
    }
    return hits;
}

export const RULES = [
    { id: 'focus-after-await', find: (code) => focusAfterAwait(code),
        fix: 'wait for the focus itself: await waitFor(() => expect(document.activeElement).toBe(el))' },
    { id: 'fixed-ms-bound', find: (code) => fixedMsBound(code),
        fix: 'hold the time to a ratio of a baseline measured in the same run, in the same loop (test-members-on-demand.ts, #3166)' },
    { id: 'clock-per-row', find: (code, raw, opts) => clockPerRow(code, raw, opts),
        fix: 'read the clock once and give each row its own time (now - i * 1000), or stop the clock (vi.setSystemTime)' },
];
export const RULE_IDS = RULES.map((r) => r.id);

// ── Allow comments ────────────────────────────────────────────────────────────────────────────────────────────────────

const ALLOW = /\/\/\s*flake-ok\(([\w-]*)\)\s*:?\s*(.*)$/;
const REASON_WORDS = 4;

/** The allow comments of a file: { line, rule, reason, ok, why }. */
export function allowsOf(raw) {
    const out = [];
    // Only real line comments: a sample inside a string (this check's own tests) is not one.
    const comments = [];
    blank(raw, (at, text) => comments.push({ at, text }));
    comments.forEach(({ at, text }) => {
        const m = ALLOW.exec(text);
        if (!m) return;
        const i = lineOf(raw, at) - 1;
        const rule = m[1];
        const reason = m[2].trim();
        let why = '';
        if (!RULE_IDS.includes(rule)) why = `names no rule (${RULE_IDS.join(', ')})`;
        else if (reason.split(/\s+/).filter((w) => /\w/.test(w)).length < REASON_WORDS) why = `gives no reason (at least ${REASON_WORDS} words after the colon)`;
        out.push({ line: i + 1, rule, reason, ok: !why, why });
    });
    return out;
}

/** One file's hits per rule, after its allow comments; plus allows that are malformed or excuse nothing. */
export function scanSource(raw, opts = {}) {
    const code = blank(raw);
    const allows = allowsOf(raw);
    const used = new Set();
    const hits = [];
    for (const rule of RULES) {
        for (const h of rule.find(code, raw, opts)) {
            const line = lineOf(code, h.at);
            const allow = allows.find((a) => a.ok && a.rule === rule.id && (a.line === line || a.line === line - 1));
            if (allow) { used.add(allow.line); continue; }
            hits.push({ rule: rule.id, line, what: h.what });
        }
    }
    hits.sort((a, b) => RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule) || a.line - b.line);
    const badAllows = allows.filter((a) => !a.ok).map((a) => ({ line: a.line, why: a.why }))
        .concat(allows.filter((a) => a.ok && !used.has(a.line)).map((a) => ({ line: a.line, why: `excuses nothing: no ${a.rule} hit on this line or the next` })));
    return { hits, badAllows };
}

/** Every test file in the repo (tracked), relative to ROOT. */
export function testFiles(root = ROOT) {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter((f) => f && TEST_FILE.test(f) && !SKIP_DIR.test(f));
}

/** The repo's hits: { counts: { rule: { file: n } }, list: [{ file, rule, line, what }], badAllows: [...] }. */
export function scanRepo(root = ROOT, files = testFiles(root)) {
    const counts = Object.fromEntries(RULE_IDS.map((r) => [r, {}]));
    const list = [];
    const badAllows = [];
    for (const file of files) {
        let raw;
        try { raw = readFileSync(join(root, file), 'utf8'); } catch { continue; }
        const { hits, badAllows: bad } = scanSource(raw);
        for (const h of hits) {
            counts[h.rule][file] = (counts[h.rule][file] ?? 0) + 1;
            list.push({ file, ...h });
        }
        for (const b of bad) badAllows.push({ file, ...b });
    }
    return { counts, list, badAllows, files: files.length };
}

/** Against the ceiling: `over` (more than recorded: fails) and `lowered` (fewer: passes; --update lowers it). */
export function judge(counts, ceiling) {
    const over = [];
    const lowered = [];
    for (const rule of RULE_IDS) {
        const now = counts[rule] ?? {};
        const cap = ceiling[rule] ?? {};
        for (const [file, n] of Object.entries(now)) if (n > (cap[file] ?? 0)) over.push({ rule, file, n, cap: cap[file] ?? 0 });
        for (const [file, n] of Object.entries(cap)) if ((now[file] ?? 0) < n) lowered.push({ rule, file, n: now[file] ?? 0, cap: n });
    }
    return { over, lowered };
}

/** The ceiling lowered to what is found: never raised, never a new file or rule; files at 0 drop out. */
export function lowerCeiling(counts, ceiling) {
    const next = {};
    for (const rule of Object.keys(ceiling)) {
        next[rule] = {};
        for (const file of Object.keys(ceiling[rule]).sort()) {
            const n = Math.min(ceiling[rule][file], counts[rule]?.[file] ?? 0);
            if (n > 0) next[rule][file] = n;
        }
    }
    return next;
}

export const total = (perFile) => Object.values(perFile ?? {}).reduce((a, b) => a + b, 0);

export function readCeiling(root = ROOT) {
    return JSON.parse(readFileSync(join(root, CEILING_FILE), 'utf8'));
}

function main(argv) {
    const scan = scanRepo();
    if (argv.includes('--list')) {
        for (const h of scan.list) console.log(`${h.rule}\t${h.file}:${h.line}\t${h.what}`);
        for (const rule of RULE_IDS) console.log(`# ${rule}: ${total(scan.counts[rule])} hits in ${Object.keys(scan.counts[rule]).length} files`);
        return 0;
    }
    const ceiling = readCeiling();
    if (argv.includes('--update')) {
        const next = lowerCeiling(scan.counts, ceiling);
        writeFileSync(join(ROOT, CEILING_FILE), `${JSON.stringify(next, null, 2)}\n`);
        console.log(`lowered ${CEILING_FILE}: ${RULE_IDS.map((r) => `${r} ${total(ceiling[r])} → ${total(next[r])}`).join(', ')}`);
        return 0;
    }
    const { over, lowered } = judge(scan.counts, ceiling);
    console.log(`flake_patterns: ${scan.files} test files read; ${RULE_IDS.map((r) => `${r} ${total(scan.counts[r])} (ceiling ${total(ceiling[r])})`).join(', ')}`);
    let bad = false;
    if (over.length) {
        bad = true;
        console.log(`\n❌ ${over.length} file(s) over the ceiling for a known flaky shape:`);
        for (const o of over) {
            const rule = RULES.find((r) => r.id === o.rule);
            console.log(`  ${o.rule}  ${o.file}: ${o.n} now, ceiling ${o.cap}`);
            for (const h of scan.list.filter((h) => h.file === o.file && h.rule === o.rule)) console.log(`      line ${h.line}: ${h.what}`);
            console.log(`      fix: ${rule.fix}`);
        }
        console.log(`  Not the shape? Say why on the line above: // flake-ok(<rule>): <at least ${REASON_WORDS} words>. Never raise ${CEILING_FILE}.`);
    }
    if (scan.badAllows.length) {
        bad = true;
        console.log(`\n❌ ${scan.badAllows.length} flake-ok comment(s) to fix:`);
        for (const b of scan.badAllows) console.log(`  ${b.file}:${b.line}: ${b.why}`);
    }
    if (lowered.length) {
        console.log(`\n  ${lowered.length} file(s) under their ceiling: \`node scripts/flake-patterns.mjs --update\` locks the fall in.`);
        for (const l of lowered) console.log(`    ${l.rule}  ${l.file}: ${l.n} now, ceiling ${l.cap}`);
    }
    if (!bad) console.log('✅ no file over its ceiling');
    return bad ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
