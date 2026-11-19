/**
 * Source guard for slice S2 (a direct chat of another community this phone holds, read and written there in place:
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md §3, §6 S2): every in-place read and write takes its community by
 * name, and nothing else reaches the copy open in place. The behaviour is pinned in chat-in-place-wrong-file.test.ts; this
 * fails the next function or call written without the name.
 *
 * Read with the TypeScript parser:
 * 9. `heldCopies.inPlace(…)` (the one way to a writable connection on another community's file) is called only by
 *    copyInPlaceFor, on the file it names from its own parameter (`const file = getDatabaseFilenameForNode(community)`).
 * 10. A function of utils/db.ts that takes a chat's community (a parameter `community: ChatCommunity`, or getMessages's
 *     `const community = opts?.community`), the copy's own makers aside (chatCopyForRequest, chatReadFor, copyInPlaceFor,
 *     enterChatInPlace, leaveChatInPlace):
 *     a. takes no copy itself: no getDb(), waitForInit() or 'beanpool_anchor_url' (with no community, chatReadFor stands
 *        in for the copy in use);
 *     b. hands `community` to every chatCopyForRequest / chatDbFor / chatReadFor it calls;
 *     c. hands `community` on to every function of the file it calls that takes one, at that function's own place for it
 *        (getMessages: `{ community }` in its options).
 *     And the functions that take one are the in-place set this slice built, no fewer (so the rules above are not vacuous).
 * 11. app/chat/[id].tsx, the DM screen (ChatScreen): every call of an in-place function (enterChatInPlace and leaveChatInPlace too) hands it
 *     `at`, the community the chat lives in, at that function's place for it; every other function of utils/db.ts it calls
 *     sits behind `at`: in a function that returns (or throws) first when `at` is set, or under a condition that holds only
 *     with no `at`. The one exception is getKnownChatMute, a read of this run's memory by the chat's id (no copy, no server).
 * 12. app/chat/key-code.tsx hands its `at` to each of the three pin calls, and holds the chat in place by that `at` while it
 *     shows (enterChatInPlace, leaveChatInPlace in its cleanup), before its first read (#3305 review).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const DB_TS = path.join(__dirname, '..', 'db.ts');
const CHAT_TSX = path.join(__dirname, '..', '..', 'app', 'chat', '[id].tsx');
const KEY_CODE_TSX = path.join(__dirname, '..', '..', 'app', 'chat', 'key-code.tsx');

/** The in-place set (slice S2): every function of utils/db.ts that takes a community. */
const IN_PLACE = [
    'acceptOfferedPeer', 'callsignOfKey', 'createConversationApi', 'decideMessageRequest', 'deleteLocalMessage', 'deleteMessageApi',
    'editMessage', 'getConversation', 'getDecryptedAttachment', 'getDecryptedVoice', 'getDmKeyChange', 'getDmKeyCodeInfo',
    'getDmKeyContext', 'getMessages', 'insertMessage', 'lineToWriteAfter', 'lockForConversation', 'markConversationRead',
    'markConversationReadLocally', 'markDmPeerVerified', 'muteChatApi', 'pinsCopyFor', 'refreshConversationFromNode', 'removeDmPeerVerification',
    'requireDmKeyContext', 'sealOfLine', 'syncSingleConversation', 'syncSingleConversationOnce', 'toggleMessageReactionApi',
    'unplacedKeyChange',
].sort();
/** A function the DM screen may call with no `at`: it reads neither a copy nor a server (this run's memory, by the chat's id). */
const NO_COPY = new Set(['getKnownChatMute']);
/** The copy's own makers: they decide what the community names, and are read by rule 9 or by eye. */
const MAKERS = new Set(['chatCopyForRequest', 'chatReadFor', 'chatDbFor', 'copyInPlaceFor', 'enterChatInPlace', 'leaveChatInPlace']);
const RESOLVERS = new Set(['chatCopyForRequest', 'chatDbFor', 'chatReadFor']);
const TAKES_A_COPY = new Set(['getDb', 'waitForInit']);

function calledName(e: ts.Expression): string | null {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return null;
}

interface DbFn { name: string; line: number; node: ts.FunctionLikeDeclaration; communityAt: number | 'opts' | null }

/** Every top-level function of a db.ts source, with where it takes a community: a parameter's index, 'opts' (getMessages), or null. */
function dbFunctions(source: string): { sf: ts.SourceFile; fns: DbFn[] } {
    const sf = ts.createSourceFile('db.ts', source, ts.ScriptTarget.Latest, true);
    const fns: DbFn[] = [];
    const add = (name: string, f: ts.FunctionLikeDeclaration) => {
        // A chat's community: a parameter named `community` typed ChatCommunity (S1's held reads take a plain string).
        const params = f.parameters.map((p) => (p.name.getText(sf) === 'community' && p.type?.getText(sf) === 'ChatCommunity' ? 'community' : ''));
        let communityAt: DbFn['communityAt'] = params.indexOf('community');
        if (communityAt < 0) {
            communityAt = null;
            const body = f.body && ts.isBlock(f.body) ? f.body.statements : [];
            for (const st of body) {
                if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText(sf) === 'community' && !!d.initializer && /^opts\??\.community$/.test(d.initializer.getText(sf)))) {
                    communityAt = 'opts';
                }
            }
        }
        fns.push({ name, line: sf.getLineAndCharacterOfPosition(f.getStart(sf)).line + 1, node: f, communityAt });
    };
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && st.body) add(st.name.text, st);
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add(d.name.getText(sf), d.initializer);
            }
        }
    }
    return { sf, fns };
}

/** Whether `call` hands `name` on at `at` (a parameter's index), or in an options object (`{ community: name }`) for 'opts'. */
function handsOn(call: ts.CallExpression, at: number | 'opts', name: string, optsIndex = 1): boolean {
    if (at === 'opts') {
        const opts = call.arguments[optsIndex];
        return !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
            (ts.isShorthandPropertyAssignment(p) && p.name.text === 'community' && name === 'community')
            || (ts.isPropertyAssignment(p) && p.name.getText() === 'community' && p.initializer.getText() === name));
    }
    const arg = call.arguments[at];
    return !!arg && ts.isIdentifier(arg) && arg.text === name;
}

/** Each rule 9 and 10 broken in a db.ts source, as "function (db.ts:line): what". */
export function inPlaceHolesIn(source: string): string[] {
    const { sf, fns } = dbFunctions(source);
    const byName = new Map(fns.map((f) => [f.name, f] as const));
    const holes: string[] = [];
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    // Rule 9.
    (function walk(x: ts.Node, inFn: DbFn | null) {
        const here = fns.find((f) => f.node === x) ?? inFn;
        if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ts.isIdentifier(x.expression.expression)
            && x.expression.expression.text === 'heldCopies' && x.expression.name.text === 'inPlace') {
            const at = `${here?.name ?? 'top level'} (db.ts:${lineOf(x)})`;
            if (here?.name !== 'copyInPlaceFor') holes.push(`${at}: rule 9, heldCopies.inPlace() outside copyInPlaceFor`);
            else {
                const arg = x.arguments[0];
                const named = !!arg && ts.isIdentifier(arg) && !!here.node.body && ts.isBlock(here.node.body) && here.node.body.statements.some((st) =>
                    ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText(sf) === arg.text
                        && !!d.initializer && /^getDatabaseFilenameForNode\(community\)$/.test(d.initializer.getText(sf))));
                if (!named) holes.push(`${at}: rule 9, heldCopies.inPlace() on a file not named from its community`);
            }
        }
        ts.forEachChild(x, (c) => walk(c, here));
    })(sf, null);
    // Rule 10.
    for (const f of fns) {
        if (f.communityAt === null || MAKERS.has(f.name)) continue;
        const at = `${f.name} (db.ts:${f.line})`;
        (function walk(x: ts.Node) {
            if (ts.isCallExpression(x)) {
                const name = calledName(x.expression);
                if (name && TAKES_A_COPY.has(name)) holes.push(`${at}: rule 10a, ${name}() in a function that takes a community`);
                if (name && RESOLVERS.has(name) && !handsOn(x, 0, 'community')) holes.push(`${at}: rule 10b, ${name}() without its community`);
                const callee = name && ts.isIdentifier(x.expression) ? byName.get(name) : undefined;
                if (callee && callee !== f && callee.communityAt !== null && !MAKERS.has(callee.name) && !handsOn(x, callee.communityAt, 'community')) {
                    holes.push(`${at}: rule 10c, ${name}() without its community`);
                }
            }
            if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === 'beanpool_anchor_url') holes.push(`${at}: rule 10a, reads the address in use`);
            ts.forEachChild(x, walk);
        })(f.node);
    }
    return holes;
}

/** The in-place set a db.ts source has: its functions that take a community, the makers aside. */
export function inPlaceSetOf(source: string): string[] {
    return dbFunctions(source).fns.filter((f) => f.communityAt !== null && !MAKERS.has(f.name)).map((f) => f.name).sort();
}

/** Whether `n` sits behind `at`: a function around it that returns or throws first when `at` is set, or a condition that needs no `at`. */
function behindAt(n: ts.Node, stopAt: ts.Node): boolean {
    const mentionsAt = (e: ts.Node): boolean => {
        let found = false;
        (function walk(x: ts.Node) { if (ts.isIdentifier(x) && x.text === 'at') found = true; else ts.forEachChild(x, walk); })(e);
        return found;
    };
    const negatesAt = (e: ts.Expression): boolean => {
        let found = false;
        (function walk(x: ts.Node) {
            if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken && ts.isIdentifier(x.operand) && x.operand.text === 'at') found = true;
            else ts.forEachChild(x, walk);
        })(e);
        return found;
    };
    const exits = (s: ts.Statement): boolean => ts.isReturnStatement(s) || ts.isThrowStatement(s)
        || (ts.isBlock(s) && s.statements.length > 0 && exits(s.statements[s.statements.length - 1]));
    let child: ts.Node = n;
    for (let up = n.parent; up && up !== stopAt; child = up, up = up.parent) {
        if (ts.isIfStatement(up) && up.thenStatement === child && negatesAt(up.expression)) return true;
        if (ts.isConditionalExpression(up) && up.whenFalse === child && mentionsAt(up.condition) && !negatesAt(up.condition)) return true;
        if (ts.isConditionalExpression(up) && up.whenTrue === child && negatesAt(up.condition)) return true;
        if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && up.right === child && negatesAt(up.left)) return true;
        if ((ts.isArrowFunction(up) || ts.isFunctionExpression(up) || ts.isFunctionDeclaration(up)) && up.body && ts.isBlock(up.body)) {
            for (const st of up.body.statements) {
                if (st.getStart() >= n.getStart()) break;
                if (ts.isIfStatement(st) && mentionsAt(st.expression) && !negatesAt(st.expression) && exits(st.thenStatement)) return true;
            }
        }
    }
    return false;
}

/** The db.ts names a file imports from utils/db. */
function dbImportsOf(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /utils\/db$/.test(st.moduleSpecifier.text)) {
            const b = st.importClause?.namedBindings;
            if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly) names.add(e.name.text);
        }
    }
    return names;
}

/** Each rule 11 broken in the DM screen's source (`screen`: the function that draws it), given where each in-place function takes its community. */
export function screenHolesIn(source: string, takesAt: ReadonlyMap<string, number | 'opts'>, screen = 'ChatScreen'): string[] {
    const sf = ts.createSourceFile('[id].tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imported = dbImportsOf(sf);
    const fn = sf.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === screen);
    if (!fn) return [`${screen}: not found`];
    const holes: string[] = [];
    (function walk(x: ts.Node) {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && imported.has(x.expression.text)) {
            const name = x.expression.text;
            const line = sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1;
            const where = takesAt.get(name);
            if (where !== undefined) {
                if (!handsOn(x, where, 'at')) holes.push(`${name} ([id].tsx:${line}): rule 11, an in-place call without \`at\``);
            } else if (!NO_COPY.has(name) && !behindAt(x, fn)) {
                holes.push(`${name} ([id].tsx:${line}): rule 11, not in place, and not behind \`at\``);
            }
        }
        ts.forEachChild(x, walk);
    })(fn);
    return holes;
}

/** Where each in-place function of db.ts takes its community (leaveChatInPlace, a maker, too: the screen hands it `at`). */
function takesAtOf(source: string): Map<string, number | 'opts'> {
    const { fns } = dbFunctions(source);
    return new Map(fns.filter((f) => f.communityAt !== null && (!MAKERS.has(f.name) || f.name === 'enterChatInPlace' || f.name === 'leaveChatInPlace')).map((f) => [f.name, f.communityAt as number | 'opts']));
}

describe('slice S2: every in-place read and write takes its community by name', () => {
    const dbSource = fs.readFileSync(DB_TS, 'utf8');

    it('no function in utils/db.ts breaks rule 9 or 10', () => {
        expect(inPlaceHolesIn(dbSource)).toEqual([]);
    });

    it('the in-place set is the one this slice built (rules 9 and 10 are not vacuous)', () => {
        expect(inPlaceSetOf(dbSource)).toEqual(IN_PLACE);
        expect(dbSource.match(/heldCopies\.inPlace\(/g)?.length ?? 0).toBe(1);
    });

    it('the DM screen hands `at` to every in-place call and keeps every other behind it (rule 11)', () => {
        const source = fs.readFileSync(CHAT_TSX, 'utf8');
        expect(screenHolesIn(source, takesAtOf(dbSource))).toEqual([]);
        // Not vacuous: the screen makes in-place calls, and calls some that aren't.
        expect((source.match(/, at\)/g) ?? []).length).toBeGreaterThan(10);
        expect(source).toMatch(/getDealsBetween\(/);
    });

    it('the key code screen hands its `at` to each pin call (rule 12)', () => {
        const source = fs.readFileSync(KEY_CODE_TSX, 'utf8');
        for (const call of ['getDmKeyCodeInfo(String(id), at)', 'markDmPeerVerified(String(id), info.peer, at)', 'removeDmPeerVerification(String(id), at)']) {
            expect(source).toContain(call);
        }
        // It holds the chat in place while it shows (#3305 review): the hold's effect is written before the first read's, so
        // it runs first, and it lets go in its cleanup.
        const hold = source.search(/useEffect\(\(\) => \{\s*if \(!at\) return;\s*enterChatInPlace\(at\);\s*return \(\) => \{ void leaveChatInPlace\(at\); \};\s*\}, \[at\]\);/);
        expect(hold).toBeGreaterThan(0);
        expect(hold).toBeLessThan(source.indexOf('useEffect(() => { void load(); }, [load]);'));
    });

    it('the DM screen holds the chat in place from its focus effect\'s start, before any read, and lets go in its cleanup (#3305 review)', () => {
        const source = fs.readFileSync(CHAT_TSX, 'utf8');
        const focus = source.slice(source.indexOf('useFocusEffect('));
        const deps = '}, [id, identity, loadConversationData, dealsRerun, at])';
        expect(focus).toContain(deps);
        const effect = focus.slice(0, focus.indexOf(deps));
        // The peer's key re-runs it only for an ordinary chat: in place, a re-run would let go of the copy and hold it again
        // under the first poll (#3305 review). The rendered rows are dm-requests-chat-render's "held once" ones.
        expect(source).toContain('const dealsRerun = at ? null : loadDeals;');
        const enter = effect.indexOf('if (at) enterChatInPlace(at);');
        expect(enter).toBeGreaterThan(0);
        expect(enter).toBeLessThan(effect.indexOf('loadConversationData();'));
        expect(enter).toBeLessThan(effect.indexOf('loadMessages()'));
        const cleanup = effect.slice(effect.lastIndexOf('return () => {'));
        expect(cleanup).toMatch(/active = false;\s*inViewRef\.current = false;/);
        expect(cleanup).toContain('if (at) void leaveChatInPlace(at);');
        expect(effect.match(/enterChatInPlace\(/g)?.length).toBe(1);
        expect(effect.match(/leaveChatInPlace\(/g)?.length).toBe(1);
    });

    it('the guard sees each rule broken (so a clean read above is a real one)', () => {
        const broken = `
            const heldCopies = createHeldCopies({});
            async function chatCopyForRequest(community: ChatCommunity) { return getDb(); }
            async function copyInPlaceFor(community: string) { const file = getDatabaseFilenameForNode(community); return heldCopies.inPlace(file); }
            async function otherMaker(community: string) { return heldCopies.inPlace('community_x.db'); }
            async function wrongFile(community: string) { const file = getDatabaseFilenameForNode(SOMEWHERE); return heldCopies.inPlace(file); }
            async function getLines(id, community?: ChatCommunity) { const d = await chatDbFor(community); return d; }
            async function takesTheCopyInUse(id, community?: ChatCommunity) { const d = await getDb(); return d; }
            async function readsTheAnchor(id, community?: ChatCommunity) { return AsyncStorage.getItem('beanpool_anchor_url'); }
            async function resolvesNoCommunity(id, community?: ChatCommunity) { const here = await chatCopyForRequest(); return here; }
            async function dropsIt(id, community?: ChatCommunity) { return getLines(id); }
            async function handsItOn(id, community?: ChatCommunity) { return getLines(id, community); }
            async function getMessages(id, opts) { const community = opts?.community; return getLines(id, community); }
            async function optsDropped(id, community?: ChatCommunity) { return getMessages(id, { limit: 5 }); }
            async function optsHanded(id, community?: ChatCommunity) { return getMessages(id, { limit: 5, community }); }
            async function heldRead(myPubkey, community: string) { const d = await getDb(); return d; }
        `;
        const holes = inPlaceHolesIn(broken);
        const of = (fn: string) => holes.filter((x) => x.startsWith(`${fn} `));
        expect(of('otherMaker').some((x) => x.includes('rule 9'))).toBe(true);
        expect(of('wrongFile').some((x) => x.includes('rule 9'))).toBe(true);
        expect(of('copyInPlaceFor')).toEqual([]);
        expect(of('takesTheCopyInUse').some((x) => x.includes('rule 10a'))).toBe(true);
        expect(of('readsTheAnchor').some((x) => x.includes('rule 10a'))).toBe(true);
        expect(of('resolvesNoCommunity').some((x) => x.includes('rule 10b'))).toBe(true);
        expect(of('dropsIt').some((x) => x.includes('rule 10c'))).toBe(true);
        expect(of('optsDropped').some((x) => x.includes('rule 10c'))).toBe(true);
        // A plain-string community (S1's held reads) is not a chat's: its rules are chat-write-after-await-source's 5-8.
        for (const fine of ['getLines', 'handsItOn', 'getMessages', 'optsHanded', 'heldRead']) expect(of(fine)).toEqual([]);

        const screen = `
            import { getMessages, insertMessage, getDealsBetween, getDb, syncMessages } from '../../utils/db';
            function ChatScreen({ id, inPlace }) {
                const at = inPlace?.community;
                const fine = () => insertMessage(id, me, text, undefined, undefined, undefined, at);
                const read = () => getMessages(id, { limit: 5, community: at });
                const dropped = () => insertMessage(id, me, text);
                const readDropped = () => getMessages(id, { limit: 5 });
                const deals = async () => { if (!me || at) return; await getDealsBetween(me, peer); };
                const unguarded = async () => { await getDealsBetween(me, peer); };
                const guardedBelow = async () => { await getDb(); if (at) return; };
                const conditioned = () => { if (res.postId && !at) { void getDb(); } };
                const anded = () => !at && syncMessages(me);
            }
        `;
        const takesAt = new Map<string, number | 'opts'>([['insertMessage', 6], ['getMessages', 'opts']]);
        const sh = screenHolesIn(screen, takesAt);
        const at = (line: string) => sh.some((x) => x.includes(line));
        expect(sh.filter((x) => x.startsWith('insertMessage ')).length).toBe(1);
        expect(sh.filter((x) => x.startsWith('getMessages ')).length).toBe(1);
        expect(sh.filter((x) => x.startsWith('getDealsBetween ')).length).toBe(1);
        expect(sh.filter((x) => x.startsWith('getDb ')).length).toBe(1);
        expect(sh.some((x) => x.startsWith('syncMessages '))).toBe(false);
        expect(at('rule 11')).toBe(true);
    });
});
