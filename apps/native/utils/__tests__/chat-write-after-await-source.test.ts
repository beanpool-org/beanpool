/**
 * Source guard: every chat write that follows a network await takes its handle from the file the request was for
 * (utils/db.ts chatCopyForRequest / copyStillFor), never from getDb() (the copy open NOW, which after a switch is another
 * community's). The S1 probe measured the bug this closes: syncMessages took getDb() after the answer came back and wrote
 * community A's conversation into B's file (scratch/walks/RESULT-s1-second-handle-probe.md (4), run 6). The behaviour is
 * pinned in chat-switch-wrong-file.test.ts; this fails the next function written the old way.
 *
 * Read with the TypeScript parser, per top-level function of utils/db.ts (nested callbacks count as the function's own):
 * - a "chat write": SQL that inserts, updates, replaces or deletes rows of a chat table;
 * - a "self-handle chat writer": a function that takes getDb()/waitForInit() itself and makes a chat write. One whose
 *   every getDb() is the fallback for a handle parameter (`database ?? await getDb()`) takes none when it is handed one;
 * - a "network call": signedGet, _signedRequest, signedRequest, signedRequestWithMethod or fetch.
 * The rules, for a function that makes a network call:
 * 1. When it writes a chat table, itself or through a function of the file it calls (writeConversationFromNode, handed a
 *    handle), it takes no getDb()/waitForInit() after its first network call.
 * 2. It calls no self-handle chat writer after its first network call (that writer's getDb() is the same hole), unless
 *    it hands that writer the handle its fallback stands in for.
 * 3. With a chat write of its own, it reads neither the address nor the copy itself (no 'beanpool_anchor_url', no
 *    getDb()/waitForInit() anywhere): both come from one chatCopyForRequest() or copyStillFor(), at one moment.
 * 4. Taking chatCopyForRequest(), every signedGet / _signedRequest it makes is sent to that community's address
 *    (signedGet's `anchorUrl` option, _signedRequest's third argument): a request read from the address again could go to
 *    another community than the file its answer is written into.
 *
 * And the held copies (slice S1, utils/held-copies.ts): a chat read of another community's copy takes that community by name.
 * 5. A function that reads a held copy (`heldCopies.all`) reads the file it names from one of its own parameters
 *    (`const file = getDatabaseFilenameForNode(<parameter>)`, then `heldCopies.all(file, …)`): never a file worked out from
 *    anything else.
 * 6. It never takes the copy open now or the address in use: no getDb(), waitForInit(), chatCopyForRequest() or
 *    copyStillFor(), no 'beanpool_anchor_url', no anchorUrl or getCachedAnchorUrl (a photo built from the anchor would ask
 *    the community in use for another's).
 * 7. `heldCopies` is used only through its own methods (all, close, closeAll, paused, pauseUntil, openFiles, and S2's inPlace
 *    and closeReads), never handed
 *    on: no held handle reaches a writer.
 * 8. Only utils/db.ts makes held copies (createHeldCopies, once), and no other file of the app sets `query_only`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const DB_TS = path.join(__dirname, '..', 'db.ts');
const APP = path.join(__dirname, '..', '..');
const NETWORK = new Set(['signedGet', '_signedRequest', 'signedRequest', 'signedRequestWithMethod', 'fetch']);
const TAKES_THE_COPY_OPEN_NOW = new Set(['getDb', 'waitForInit']);
const CHAT_TABLES = ['messages', 'conversations', 'conversation_participants', 'groups', 'group_members'];
const CHAT_WRITE = new RegExp(String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:${CHAT_TABLES.join('|')})\b`, 'i');

interface Call { name: string; pos: number; node: ts.CallExpression }
interface Fn {
    name: string; line: number; calls: Call[]; chatWrite: boolean; readsAddress: boolean;
    /** The handle parameter every getDb()/waitForInit() of this function stands in for (`p ?? await getDb()`), or null. */
    fallbackFor: number | null;
}

function calledName(e: ts.Expression): string | null {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return null;
}

/** Every top-level function of `source`: its calls in source order, whether it writes a chat table, whether it reads the address. */
export function functionsOf(source: string): Fn[] {
    const sf = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true);
    const out: Fn[] = [];
    const add = (name: string, f: ts.FunctionLikeDeclaration) => {
        const calls: Call[] = [];
        let chatWrite = false;
        let readsAddress = false;
        const params = f.parameters.map((p) => p.name.getText(sf));
        // For each getDb()/waitForInit(): the index of the parameter it falls back for (`p ?? await getDb()`), else -1.
        const fallbackOf: number[] = [];
        (function walk(x: ts.Node) {
            if (ts.isCallExpression(x)) {
                const name = calledName(x.expression);
                if (name) calls.push({ name, pos: x.getStart(sf), node: x });
                if (name && TAKES_THE_COPY_OPEN_NOW.has(name)) {
                    let up: ts.Node = x.parent;
                    while (ts.isAwaitExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent;
                    const isFallback = ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isIdentifier(up.left);
                    fallbackOf.push(isFallback ? params.indexOf((up as ts.BinaryExpression & { left: ts.Identifier }).left.text) : -1);
                }
            }
            if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateHead(x) || ts.isTemplateMiddle(x) || ts.isTemplateTail(x)) {
                if (CHAT_WRITE.test(x.text)) chatWrite = true;
                if (x.text === 'beanpool_anchor_url') readsAddress = true;
            }
            ts.forEachChild(x, walk);
        })(f);
        // Only when every getDb() of the function is the fallback for one and the same parameter.
        const fallbackFor = fallbackOf.length > 0 && fallbackOf[0] >= 0 && fallbackOf.every((i) => i === fallbackOf[0]) ? fallbackOf[0] : null;
        out.push({ name, line: sf.getLineAndCharacterOfPosition(f.getStart(sf)).line + 1, calls, chatWrite, readsAddress, fallbackFor });
    };
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && st.body) add(st.name.text, st);
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add(d.name.getText(sf), d.initializer);
            }
        }
    }
    return out;
}

/** Each rule broken in `source`, as "function (line): what". */
export function holesIn(source: string): string[] {
    const fns = functionsOf(source);
    const selfHandleWriters = new Map(fns.filter((f) => f.chatWrite && f.calls.some((c) => TAKES_THE_COPY_OPEN_NOW.has(c.name))).map((f) => [f.name, f.fallbackFor] as const));
    // Writes a chat table itself, or calls a function of the file that does (to any depth).
    const byName = new Map(fns.map((f) => [f.name, f] as const));
    const writesChat = new Set(fns.filter((f) => f.chatWrite).map((f) => f.name));
    for (let grew = true; grew;) {
        grew = false;
        for (const f of fns) {
            if (!writesChat.has(f.name) && f.calls.some((c) => c.name !== f.name && byName.has(c.name) && writesChat.has(c.name))) {
                writesChat.add(f.name);
                grew = true;
            }
        }
    }
    const holes: string[] = [];
    for (const f of fns) {
        const firstNet = f.calls.find((c) => NETWORK.has(c.name));
        if (!firstNet) continue;
        const after = f.calls.filter((c) => c.pos > firstNet.pos);
        const at = `${f.name} (db.ts:${f.line})`;
        if (writesChat.has(f.name)) {
            for (const c of after) if (TAKES_THE_COPY_OPEN_NOW.has(c.name)) holes.push(`${at}: rule 1, ${c.name}() after ${firstNet.name}()`);
        }
        for (const c of after) {
            if (!selfHandleWriters.has(c.name) || c.name === f.name) continue;
            const handed = selfHandleWriters.get(c.name);
            if (handed !== null && handed !== undefined && c.node.arguments.length > handed) continue;
            holes.push(`${at}: rule 2, ${c.name}() after ${firstNet.name}() takes getDb() itself`);
        }
        if (f.chatWrite) {
            if (f.readsAddress) holes.push(`${at}: rule 3, reads the address itself`);
            if (f.calls.some((c) => TAKES_THE_COPY_OPEN_NOW.has(c.name)) && !f.calls.some((c) => c.name === 'chatCopyForRequest' || c.name === 'copyStillFor')) {
                holes.push(`${at}: rule 3, takes the copy open now, not chatCopyForRequest()`);
            }
        }
        if (f.calls.some((c) => c.name === 'chatCopyForRequest')) {
            for (const c of f.calls) {
                if (c.name === 'signedGet') {
                    const opts = c.node.arguments[1];
                    const named = opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'anchorUrl');
                    if (!named) holes.push(`${at}: rule 4, signedGet() without the request's anchorUrl`);
                }
                if (c.name === '_signedRequest' && c.node.arguments.length < 3) holes.push(`${at}: rule 4, _signedRequest() without the request's address`);
            }
        }
    }
    return holes;
}

describe('a chat write after a network await goes through the file its request was for (chatCopyForRequest)', () => {
    it('no function in utils/db.ts breaks a rule', () => {
        expect(holesIn(fs.readFileSync(DB_TS, 'utf8'))).toEqual([]);
    });

    it('the guard sees each rule broken (so a clean read above is a real one)', () => {
        const broken = `
            async function rule1() { const r = await signedGet('/x'); const d = await getDb(); await d.runAsync('INSERT INTO messages (id) VALUES (?)', [1]); }
            async function writer(id) { const d = await getDb(); await d.runAsync('UPDATE conversations SET request = ? WHERE id = ?', [1, id]); }
            async function rule2() { await _signedRequest('/y', {}); await writer('c'); }
            async function fallbackWriter(ids, database) { const d = database ?? await getDb(); await d.runAsync("UPDATE conversations SET type = 'dm' WHERE id = ?", [1]); }
            async function handsItOn() { const here = await chatCopyForRequest(); await signedGet('/t', { anchorUrl: here.anchorUrl }); const d = await here.handle(); await fallbackWriter([], d); }
            async function handsNothing() { await signedGet('/s'); await fallbackWriter([]); }
            async function rule3() { const d = await getDb(); const a = await AsyncStorage.getItem('beanpool_anchor_url'); await fetch(a + '/z'); await d.runAsync('DELETE FROM messages WHERE id = ?', [1]); }
            async function rule4() { const here = await chatCopyForRequest(); await signedGet('/w', { signal: s }); await _signedRequest('/v', {}); }
            async function handleWriter(database, id) { await database.runAsync('INSERT OR IGNORE INTO conversations (id) VALUES (?)', [id]); }
            async function rule1Through() { const r = await signedGet('/r'); await handleWriter(await getDb(), 'c'); }
            async function fine() { const here = await chatCopyForRequest(); const r = await signedGet('/u', { anchorUrl: here.anchorUrl }); const d = await here.handle(); if (d) await d.runAsync('INSERT OR IGNORE INTO conversation_participants (a) VALUES (?)', [1]); }
        `;
        const holes = holesIn(broken);
        expect(holes.filter((x) => x.startsWith('rule1 ')).some((x) => x.includes('rule 1'))).toBe(true);
        expect(holes.filter((x) => x.startsWith('rule2 ')).some((x) => x.includes('rule 2'))).toBe(true);
        expect(holes.filter((x) => x.startsWith('rule1Through ')).some((x) => x.includes('rule 1'))).toBe(true);
        expect(holes.filter((x) => x.startsWith('rule3 ')).filter((x) => x.includes('rule 3')).length).toBe(2);
        expect(holes.filter((x) => x.startsWith('rule4 ')).filter((x) => x.includes('rule 4')).length).toBe(2);
        expect(holes.filter((x) => x.startsWith('fine '))).toEqual([]);
        expect(holes.filter((x) => x.startsWith('handsItOn '))).toEqual([]);
        expect(holes.filter((x) => x.startsWith('handsNothing ')).some((x) => x.includes('rule 2'))).toBe(true);
    });
});

// inPlace and closeReads: slice S2's copy open in place (its own rule, 9, is chat-in-place-source.test.ts).
const HELD_METHODS = new Set(['all', 'close', 'closeAll', 'paused', 'pauseUntil', 'openFiles', 'inPlace', 'closeReads']);
const HELD_TAKES_NOW = new Set(['getDb', 'waitForInit', 'chatCopyForRequest', 'copyStillFor', 'getCachedAnchorUrl']);

/** Each held-copy rule (5-7) broken in `source`, as "function (line): what". */
export function heldHolesIn(source: string): string[] {
    const sf = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const holes: string[] = [];
    // Rule 7: every use of heldCopies is a call of one of its methods, or its declaration.
    (function walk(x: ts.Node) {
        if (ts.isIdentifier(x) && x.text === 'heldCopies') {
            const p = x.parent;
            const declared = ts.isVariableDeclaration(p) && p.name === x;
            const method = ts.isPropertyAccessExpression(p) && p.expression === x && HELD_METHODS.has(p.name.text)
                && ts.isCallExpression(p.parent) && p.parent.expression === p;
            if (!declared && !method) holes.push(`heldCopies (db.ts:${lineOf(x)}): rule 7, used other than by a call of its methods`);
        }
        ts.forEachChild(x, walk);
    })(sf);
    const check = (name: string, f: ts.FunctionLikeDeclaration) => {
        const reads: ts.CallExpression[] = [];
        const params = new Set(f.parameters.map((p) => p.name.getText(sf)));
        // Each local named from a parameter's community: `const x = getDatabaseFilenameForNode(<parameter>)`.
        const byName = new Set<string>();
        const at = `${name} (db.ts:${lineOf(f)})`;
        const takes: string[] = [];
        (function walk(x: ts.Node) {
            if (ts.isCallExpression(x)) {
                const e = x.expression;
                if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'heldCopies' && e.name.text === 'all') reads.push(x);
                const called = calledName(e);
                if (called && HELD_TAKES_NOW.has(called)) takes.push(`${called}()`);
            }
            if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.initializer && ts.isCallExpression(x.initializer)
                && calledName(x.initializer.expression) === 'getDatabaseFilenameForNode'
                && x.initializer.arguments.length === 1 && ts.isIdentifier(x.initializer.arguments[0]) && params.has(x.initializer.arguments[0].text)) {
                byName.add(x.name.text);
            }
            if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === 'beanpool_anchor_url') takes.push("'beanpool_anchor_url'");
            if (ts.isIdentifier(x) && x.text === 'anchorUrl') takes.push('anchorUrl');
            ts.forEachChild(x, walk);
        })(f);
        if (reads.length === 0) return;
        for (const r of reads) {
            const file = r.arguments[0];
            if (!file || !ts.isIdentifier(file) || !byName.has(file.text)) holes.push(`${at}: rule 5, heldCopies.all() on a file not named from a parameter`);
        }
        for (const t of new Set(takes)) holes.push(`${at}: rule 6, a held read that takes ${t}`);
    };
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && st.body) check(st.name.text, st);
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) check(d.name.getText(sf), d.initializer);
            }
        }
    }
    return holes;
}

/** Every .ts/.tsx file of the app, tests and native projects left out. */
function appSources(dir = APP, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '__tests__', 'e2e', 'android', 'ios', 'dist'].includes(e.name) || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) appSources(p, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
}

describe('a held chat read takes its community by name (slice S1, utils/held-copies.ts)', () => {
    it('no function in utils/db.ts breaks a held-copy rule', () => {
        const source = fs.readFileSync(DB_TS, 'utf8');
        expect(heldHolesIn(source)).toEqual([]);
        // And it is not vacuous: the one held chat read there is getHeldConversations, by its community.
        expect(source).toMatch(/export async function getHeldConversations\(myPubkey: string, community: string\)/);
        expect(source.match(/heldCopies\.all</g)?.length ?? 0).toBeGreaterThan(0);
    });

    it('only utils/db.ts makes held copies, once, and no other file of the app sets query_only', () => {
        const makers: string[] = [];
        const queryOnly: string[] = [];
        for (const f of appSources()) {
            const text = fs.readFileSync(f, 'utf8');
            const rel = path.relative(APP, f);
            if (rel === path.join('utils', 'held-copies.ts')) continue;
            const made = text.match(/\bcreateHeldCopies\s*(?:<[^>]*>)?\s*\(/g)?.length ?? 0;
            if (made) makers.push(`${rel} x${made}`);
            if (/query_only/i.test(text)) queryOnly.push(rel);
        }
        expect(makers).toEqual([`${path.join('utils', 'db.ts')} x1`]);
        expect(queryOnly).toEqual([]);
    });

    it('the guard sees each held rule broken (so a clean read above is a real one)', () => {
        const broken = `
            const heldCopies = createHeldCopies({});
            async function byAnchor(me) { const file = getDatabaseFilenameForNode(await AsyncStorage.getItem('beanpool_anchor_url')); return heldCopies.all(file, 'SELECT 1', []); }
            async function byOpenCopy(me, community) { const file = getDatabaseFilenameForNode(community); const d = await getDb(); return heldCopies.all(file, 'SELECT 1', []); }
            async function photoFromAnchor(me, community) { const file = getDatabaseFilenameForNode(community); const anchorUrl = getCachedAnchorUrl(); return heldCopies.all(file, 'SELECT 1', [anchorUrl]); }
            async function notFromAParameter(me) { const file = getDatabaseFilenameForNode(SOMEWHERE); return heldCopies.all(file, 'SELECT 1', []); }
            async function literalFile(me, community) { return heldCopies.all('community_x.db', 'SELECT 1', []); }
            function handsItOn() { return heldCopies; }
            async function fine(me, community) { const file = getDatabaseFilenameForNode(community); const rows = await heldCopies.all(file, 'SELECT 1', [me]); await heldCopies.close(file); return rows; }
        `;
        const holes = heldHolesIn(broken);
        const of = (fn: string) => holes.filter((x) => x.startsWith(`${fn} `));
        expect(of('byAnchor').some((x) => x.includes('rule 5'))).toBe(true);
        expect(of('byAnchor').some((x) => x.includes('rule 6') && x.includes('beanpool_anchor_url'))).toBe(true);
        expect(of('byOpenCopy').some((x) => x.includes('rule 6') && x.includes('getDb()'))).toBe(true);
        expect(of('photoFromAnchor').some((x) => x.includes('rule 6') && x.includes('getCachedAnchorUrl()'))).toBe(true);
        expect(of('photoFromAnchor').some((x) => x.includes('rule 6') && x.includes('takes anchorUrl'))).toBe(true);
        expect(of('notFromAParameter').some((x) => x.includes('rule 5'))).toBe(true);
        expect(of('literalFile').some((x) => x.includes('rule 5'))).toBe(true);
        expect(holes.some((x) => x.startsWith('heldCopies ') && x.includes('rule 7'))).toBe(true);
        expect(of('fine')).toEqual([]);
    });
});
