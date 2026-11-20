/**
 * Source guard for slice S2b (held rows' counts, previews and refresh): every held read and every refresh takes its
 * community by name. The behaviour is pinned in held-previews-refresh.test.ts; this fails the next function or call written
 * without the name. (Rules 5-7 of chat-write-after-await-source.test.ts already hold every `heldCopies.all` to a file named
 * from a parameter, with no address in use.)
 *
 * Read with the TypeScript parser:
 * 13. In utils/db.ts, getHeldLatest and getHeldPreviews take `community` and read `heldCopies.all` only on the file named
 *     from it (`const file = getDatabaseFilenameForNode(community)`).
 * 14. refreshHeldDms names the file from its own `community`, finds the saved row by that file, and hands the saved row's
 *     address (`saved.url`) to every getHeldLatest, enterChatInPlace, leaveChatInPlace and syncSingleConversation it calls,
 *     the last with that address as its community (never one left out: that would be the community in use); and its one
 *     signed read goes to that address (`anchorUrl: saved.url`).
 * 15. In utils/held-chats.ts, every call of getHeldLatest, getHeldPreviews and refreshHeldDms hands a held row's own
 *     community (`community` from the rows grouped by it, or `row.community`), never a literal or the address in use.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const DB_TS = path.join(__dirname, '..', 'db.ts');
const HELD_CHATS_TS = path.join(__dirname, '..', 'held-chats.ts');

function functionsOf(source: string, file: string): { sf: ts.SourceFile; fns: Map<string, ts.FunctionLikeDeclaration> } {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const fns = new Map<string, ts.FunctionLikeDeclaration>();
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st);
    }
    return { sf, fns };
}

function callsIn(node: ts.Node, names: ReadonlySet<string>): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    (function walk(x: ts.Node) {
        if (ts.isCallExpression(x)) {
            const e = x.expression;
            const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
            if (name && names.has(name)) out.push(x);
        }
        ts.forEachChild(x, walk);
    })(node);
    return out;
}

const fileFromCommunity = (fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile) =>
    /const file = getDatabaseFilenameForNode\(community\)/.test(fn.getText(sf)) && fn.parameters.some((p) => p.name.getText(sf) === 'community');

/** Each rule 13 and 14 broken in a db.ts source. */
export function dbHolesIn(source: string): string[] {
    const { sf, fns } = functionsOf(source, 'db.ts');
    const holes: string[] = [];
    for (const name of ['getHeldLatest', 'getHeldPreviews']) {
        const fn = fns.get(name);
        if (!fn) { holes.push(`${name}: not found`); continue; }
        if (!fileFromCommunity(fn, sf)) holes.push(`${name}: rule 13, its file is not named from its community`);
        const reads = callsIn(fn, new Set(['all'])).filter((c) => c.expression.getText(sf) === 'heldCopies.all');
        if (reads.length === 0) holes.push(`${name}: rule 13, no held read (the rule would be vacuous)`);
        for (const c of reads) {
            if (c.arguments[0]?.getText(sf) !== 'file') holes.push(`${name}: rule 13, heldCopies.all() on another file`);
        }
    }
    const refresh = fns.get('refreshHeldDms');
    if (!refresh) return [...holes, 'refreshHeldDms: not found'];
    const text = refresh.getText(sf);
    if (!fileFromCommunity(refresh, sf)) holes.push('refreshHeldDms: rule 14, its file is not named from its community');
    if (!/const saved = [^;]*getDatabaseFilenameForNode\(n\.url\) === file/.test(text)) holes.push('refreshHeldDms: rule 14, the saved row is not found by its file');
    for (const c of callsIn(refresh, new Set(['getHeldLatest', 'enterChatInPlace', 'leaveChatInPlace', 'syncSingleConversation']))) {
        const name = c.expression.getText(sf);
        const at = name === 'enterChatInPlace' || name === 'leaveChatInPlace' ? 0 : 1;
        if (c.arguments[at]?.getText(sf) !== 'saved.url') holes.push(`refreshHeldDms: rule 14, ${name}() without the saved row's address`);
    }
    if (callsIn(refresh, new Set(['syncSingleConversation'])).length === 0) holes.push('refreshHeldDms: rule 14, no syncSingleConversation (the rule would be vacuous)');
    for (const c of callsIn(refresh, new Set(['signedGet']))) {
        if (!/anchorUrl: saved\.url/.test(c.arguments[1]?.getText(sf) ?? '')) holes.push('refreshHeldDms: rule 14, signedGet() not sent to the saved row\'s address');
    }
    return holes;
}

/** Each rule 15 broken in a held-chats.ts source. */
export function heldChatsHolesIn(source: string): string[] {
    const { sf } = functionsOf(source, 'held-chats.ts');
    const holes: string[] = [];
    const calls = callsIn(sf, new Set(['getHeldLatest', 'getHeldPreviews', 'refreshHeldDms']));
    if (calls.length < 3) holes.push('rule 15: fewer held calls than this slice makes (the rule would be vacuous)');
    for (const c of calls) {
        const arg = c.arguments[1]?.getText(sf);
        if (arg !== 'community' && arg !== 'row.community') holes.push(`${c.expression.getText(sf)}(): rule 15, not a held row's own community (${arg ?? 'none'})`);
    }
    return holes;
}

describe('S2b: every held read and refresh takes its community by name', () => {
    it('utils/db.ts', () => {
        expect(dbHolesIn(fs.readFileSync(DB_TS, 'utf8'))).toEqual([]);
    });
    it('utils/held-chats.ts', () => {
        expect(heldChatsHolesIn(fs.readFileSync(HELD_CHATS_TS, 'utf8'))).toEqual([]);
    });

    it('each rule is seen broken', () => {
        const db = fs.readFileSync(DB_TS, 'utf8');
        const broken = (from: string, to: string) => {
            expect(db.includes(from), `the mutation's text: ${from}`).toBe(true);
            return dbHolesIn(db.replace(from, to));
        };
        expect(broken("heldCopies.all<any>(file, 'latest'", "heldCopies.all<any>(B_FILE, 'latest'")).toContain('getHeldLatest: rule 13, heldCopies.all() on another file');
        expect(broken("if (await syncSingleConversation(id, saved.url)) brought++;", 'if (await syncSingleConversation(id)) brought++;'))
            .toContain('refreshHeldDms: rule 14, syncSingleConversation() without the saved row\'s address');
        expect(broken('enterChatInPlace(saved.url);', 'enterChatInPlace(community);')).toContain("refreshHeldDms: rule 14, enterChatInPlace() without the saved row's address");
        expect(broken('{ signal: controller.signal, anchorUrl: saved.url }', '{ signal: controller.signal }')).toContain("refreshHeldDms: rule 14, signedGet() not sent to the saved row's address");
        const held = fs.readFileSync(HELD_CHATS_TS, 'utf8');
        const from = 'await getHeldPreviews(myPubkey, community, ids)';
        expect(held.includes(from)).toBe(true);
        expect(heldChatsHolesIn(held.replace(from, "await getHeldPreviews(myPubkey, 'https://riverside.example', ids)"))).toEqual([
            "getHeldPreviews(): rule 15, not a held row's own community ('https://riverside.example')",
        ]);
    });
});
