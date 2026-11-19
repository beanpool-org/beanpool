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
 * 1. With a chat write of its own, it takes no getDb()/waitForInit() after its first network call.
 * 2. It calls no self-handle chat writer after its first network call (that writer's getDb() is the same hole), unless
 *    it hands that writer the handle its fallback stands in for.
 * 3. With a chat write of its own, it reads neither the address nor the copy itself (no 'beanpool_anchor_url', no
 *    getDb()/waitForInit() anywhere): both come from one chatCopyForRequest() or copyStillFor(), at one moment.
 * 4. Taking chatCopyForRequest(), every signedGet / _signedRequest it makes is sent to that community's address
 *    (signedGet's `anchorUrl` option, _signedRequest's third argument): a request read from the address again could go to
 *    another community than the file its answer is written into.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const DB_TS = path.join(__dirname, '..', 'db.ts');
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
    const holes: string[] = [];
    for (const f of fns) {
        const firstNet = f.calls.find((c) => NETWORK.has(c.name));
        if (!firstNet) continue;
        const after = f.calls.filter((c) => c.pos > firstNet.pos);
        const at = `${f.name} (db.ts:${f.line})`;
        if (f.chatWrite) {
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
            async function fine() { const here = await chatCopyForRequest(); const r = await signedGet('/u', { anchorUrl: here.anchorUrl }); const d = await here.handle(); if (d) await d.runAsync('INSERT OR IGNORE INTO conversation_participants (a) VALUES (?)', [1]); }
        `;
        const holes = holesIn(broken);
        expect(holes.filter((x) => x.startsWith('rule1 ')).some((x) => x.includes('rule 1'))).toBe(true);
        expect(holes.filter((x) => x.startsWith('rule2 ')).some((x) => x.includes('rule 2'))).toBe(true);
        expect(holes.filter((x) => x.startsWith('rule3 ')).filter((x) => x.includes('rule 3')).length).toBe(2);
        expect(holes.filter((x) => x.startsWith('rule4 ')).filter((x) => x.includes('rule 4')).length).toBe(2);
        expect(holes.filter((x) => x.startsWith('fine '))).toEqual([]);
        expect(holes.filter((x) => x.startsWith('handsItOn '))).toEqual([]);
        expect(holes.filter((x) => x.startsWith('handsNothing ')).some((x) => x.includes('rule 2'))).toBe(true);
    });
});
