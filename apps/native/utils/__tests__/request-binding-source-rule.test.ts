/**
 * The phone never signs bytes a node chose (request binding, design §4.1's rule, written as a test).
 *
 * Every signature the member key makes goes through @beanpool/core's builders, which build the text themselves and
 * put 0xFF in front, or through one of the listed fallbacks for a server older than request binding, which sign
 * plain UTF-8 that they built from fields they checked (utils/crypto.ts, utils/member-statements.ts). This reads the
 * app's source (app, components, services, utils; not tests) and fails on any other path to the key:
 *
 *   - `signData(…)`, the raw signer, is called only inside `memberSigner` (the Signer handed to the builders and the
 *     fallbacks), and in `rsvpEvent`, whose `postId:status` statement is listed below with the check that makes it safe;
 *   - `memberSigner(…)` is called only in the functions that hand it to a core builder or a fallback;
 *   - a Signer is called directly only in the old-form fallbacks, and only on `utf8Bytes(…)`, which never starts
 *     with the 0xFF every format-2 signature does (request-binding.test.ts pins that);
 *   - nothing else calls an Ed25519 `sign` at all.
 *
 * A new place that signs has to be added here, with its reason, which is the point.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components', 'services', 'utils'];

function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === '__tests__' || e.name === 'node_modules') continue;
                walk(p);
            } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
                out.push(p);
            }
        }
    };
    for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    return out;
}

/** The nearest named function around `node`: a function declaration, a method, or an arrow/function held by a const. */
function enclosingName(node: ts.Node): string {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
        if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
    }
    return '<top level>';
}

interface Site { file: string; fn: string; callee: string; arg: string }

const WATCHED = ['signData', 'memberSigner', 'sign', 'ed25519Signer'];

/** Every call to a watched name, every `x.sign(…)` but Math.sign, and every import of a raw Ed25519 signer. */
function callSites(): { sites: Site[]; rawImports: string[] } {
    const sites: Site[] = [];
    const rawImports: string[] = [];
    for (const file of sourceFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        if (!/sign/i.test(text)) continue;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const rel = path.relative(ROOT, file);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                let name: string | null = null;
                if (ts.isIdentifier(callee) && WATCHED.includes(callee.text)) name = callee.text;
                else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sign' && callee.expression.getText(sf) !== 'Math') {
                    name = `${callee.expression.getText(sf)}.sign`;
                }
                if (name) sites.push({ file: rel, fn: enclosingName(node), callee: name, arg: node.arguments[0]?.getText(sf) ?? '' });
            }
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const from = node.moduleSpecifier.text;
                const named = node.importClause?.namedBindings;
                const names = named && ts.isNamedImports(named) ? named.elements.map(e => (e.propertyName ?? e.name).text) : [];
                if (from === '@noble/ed25519' && (names.includes('sign') || names.includes('signAsync') || (named && ts.isNamespaceImport(named)))) {
                    rawImports.push(`${rel}: ${from}`);
                }
                if (from.startsWith('@beanpool/core') && names.includes('ed25519Signer')) rawImports.push(`${rel}: ${from} ed25519Signer`);
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return { sites, rawImports };
}

const key = (s: Site) => `${s.file} ${s.fn}`;

describe('the member key signs only through core\'s builders and the listed old-form fallbacks', () => {
    const { sites, rawImports } = callSites();

    it('finds the signing code it is meant to police', () => {
        // Guards the test itself: if the scan stopped seeing these, every rule below would pass vacuously.
        expect(sites.some(s => s.callee === 'signData' && key(s) === 'utils/crypto.ts memberSigner')).toBe(true);
        expect(sites.some(s => s.callee === 'memberSigner' && key(s) === 'utils/member-statements.ts signAdminChallenge')).toBe(true);
        expect(sites.some(s => s.callee === 'sign' && key(s) === 'utils/crypto.ts unboundRequestHeaders')).toBe(true);
    });

    it('signData, the raw signer, is called only inside memberSigner (and the listed RSVP statement)', () => {
        const allowed = new Set([
            'utils/crypto.ts memberSigner',
            // The event RSVP's signature over `postId:status` (docs/events-on-the-map.md §2.2). The node verifies it
            // against the member's key (apps/server engine/posts.ts rsvpEvent). It is plain UTF-8, so never a format-2
            // signature. But the id is the node's, and until the switch every community still accepts old-format member
            // signatures. So it is safe only because rsvpEvent first refuses an id that isn't a UUID, the shape the node
            // issues, and a status outside going/interested/none (events.ts isSignableRsvp; pinned below). That leaves
            // one line with one colon, so never a request in the old format (#1224 review 4113495332). It can match a poll
            // vote's `postId:optionId` (engine/posts.ts votePoll), but both routes take the member from the request
            // signature, never from this one (#1224 review 4113638143). It moves to a tagged format-2 statement the next
            // time it's touched (design §6).
            'utils/db.ts rsvpEvent',
        ]);
        expect(sites.filter(s => s.callee === 'signData' && !allowed.has(key(s))).map(key)).toEqual([]);
    });

    it('the RSVP checks the node\'s id and the status before it signs them', () => {
        const src = fs.readFileSync(path.join(ROOT, 'utils/db.ts'), 'utf8');
        const start = src.indexOf('export async function rsvpEvent(');
        const fn = src.slice(start, src.indexOf('\n}\n', start));
        const check = fn.indexOf('if (!isSignableRsvp(postId, status)) throw');
        expect(start).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(fn.indexOf('signData('));
        expect(fn.match(/signData\(/g)).toHaveLength(1);
    });

    it('memberSigner is handed out only where a core builder or an old-form fallback takes it', () => {
        const allowed = new Set([
            'utils/crypto.ts buildSignedHeaders',
            'utils/crypto.ts buildSignedWsParams',
            'utils/member-statements.ts signAdminChallenge',
            'utils/member-statements.ts signPairing',
            'utils/member-statements.ts makeOfflineTicket',
        ]);
        expect(sites.filter(s => s.callee === 'memberSigner' && !allowed.has(key(s))).map(key)).toEqual([]);
    });

    it('a Signer is called directly only by the old-form fallbacks, and only on plain UTF-8 they built', () => {
        const fallbacks = new Set([
            'utils/crypto.ts unboundRequestHeaders',
            'utils/crypto.ts unboundWsParams',
            'utils/member-statements.ts oldFormSignature',
        ]);
        const direct = sites.filter(s => s.callee === 'sign' && key(s) !== 'utils/crypto.ts signData'); // signData wraps noble's sign
        expect(direct.filter(s => !fallbacks.has(key(s))).map(key)).toEqual([]);
        for (const s of direct) expect(s.arg, key(s)).toMatch(/^utf8Bytes\(/);
    });

    it('nothing else calls an Ed25519 sign, or holds one', () => {
        expect(sites.filter(s => s.callee.endsWith('.sign') || s.callee === 'ed25519Signer').map(s => `${key(s)}: ${s.callee}`)).toEqual([]);
        // noble's sign is imported once, by signData; core's ed25519Signer is for tests and scripts.
        expect(rawImports).toEqual(['utils/crypto.ts: @noble/ed25519']);
    });
});

// ── Where the phone's community address is written ─────────────────────────────────────────────────────────────
//
// Every signature is bound to the host of the phone's community address (`beanpool_anchor_url`). An address whose
// authority isn't plain host[:port] names one host to core and reaches another on iOS (#1224 review 4113495290,
// utils/node-url.ts). So every write of it is listed here with the check it passes first, and a new one fails
// until it is added with its own. addSavedNode refuses by itself (utils/nodes.ts).

interface AnchorWrite { file: string; fn: string; fnText: string; value: string }

const ANCHOR_KEY_ARG = /^(?:'beanpool_anchor_url'|"beanpool_anchor_url"|ANCHOR_STORE_KEY|ANCHOR_KEY)$/;

function anchorWrites(): AnchorWrite[] {
    const out: AnchorWrite[] = [];
    for (const file of sourceFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        if (!text.includes('setItem')) continue;
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const rel = path.relative(ROOT, file);
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setItem'
                && node.arguments.length >= 2 && ANCHOR_KEY_ARG.test(node.arguments[0].getText(sf))) {
                // The nearest named function: declared, a method, or held by a const, directly or through a hook
                // (`const switchTo = useCallback(async (url) => …)`).
                let fn = '<top level>';
                let fnNode: ts.Node | undefined = node.parent;
                for (; fnNode; fnNode = fnNode.parent) {
                    if ((ts.isFunctionDeclaration(fnNode) || ts.isMethodDeclaration(fnNode)) && fnNode.name) { fn = fnNode.name.getText(sf); break; }
                    if (ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode)) {
                        const holder = ts.isCallExpression(fnNode.parent) ? fnNode.parent.parent : fnNode.parent;
                        if (ts.isVariableDeclaration(holder)) { fn = holder.name.getText(sf); break; }
                    }
                }
                out.push({ file: rel, fn, fnText: fnNode?.getText(sf) ?? '', value: node.arguments[1].getText(sf) });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return out;
}

describe('the phone\'s community address is written only after the plain-address check', () => {
    const writes = anchorWrites();

    /** Each writer, and what its function must contain: the check it makes before the write. */
    const CHECKED: Record<string, RegExp> = {
        // The deep link's "Switch Nodes?": the address comes from deepLinkNodeOrigin, which refuses one that isn't plain.
        'app/_layout.tsx RootLayoutNav': /deepLinkNodeOrigin\(/,
        // A typed address, or one from a saved-node pick.
        'app/node-mismatch.tsx switchToNode': /assertPlainNodeAddress\(url\)/,
        // The invite join: looksLikeNodeAddress, which requires isPlainNodeAddress (utils/node-url.ts).
        'app/welcome.tsx handleCreate': /looksLikeNodeAddress\(nodeUrl\)/,
        'app/(tabs)/settings.tsx handleSwitchNode': /isPlainNodeAddress\(targetUrl\)/,
        'app/(tabs)/settings.tsx handleUpdateAnchor': /isPlainNodeAddress\(finalAnchorUrl\)/,
        // People's "Join another community", an approved knock, a directory pick; and the way back when a redeem fails.
        'utils/join-another-community.ts joinAnotherCommunity': /assertPlainNodeAddress\(targetUrl\)[\s\S]*isPlainNodeAddress\(opts\.returnUrl\)/,
        // The header's community switcher.
        'utils/use-communities.ts switchTo': /assertPlainNodeAddress\(url\)/,
        // Both restores (12 words, sign-in).
        'utils/restore-account.ts saveRestoredAccount': /assertPlainNodeAddress\(anchorUrl\)/,
        // Development discovery: only plain candidates are probed.
        'services/pillar-sync.ts discoverAnchor': /isPlainNodeAddress\(url\)/,
    };
    /** Writers of a fixed address. */
    const CONSTANT: Record<string, string> = {
        'app/welcome.tsx finishGlobalJoin': 'GLOBAL_NODE_URL',
    };

    it('finds the writes it is meant to police', () => {
        expect(writes.length).toBeGreaterThanOrEqual(Object.keys(CHECKED).length);
        expect(writes.some(w => `${w.file} ${w.fn}` === 'utils/join-another-community.ts joinAnotherCommunity')).toBe(true);
    });

    it('every write is a listed one', () => {
        const listed = new Set([...Object.keys(CHECKED), ...Object.keys(CONSTANT)]);
        expect(writes.map(w => `${w.file} ${w.fn}`).filter(k => !listed.has(k))).toEqual([]);
    });

    it('and each makes its check (or writes its constant)', () => {
        for (const w of writes) {
            const k = `${w.file} ${w.fn}`;
            if (CONSTANT[k]) expect(w.value, k).toBe(CONSTANT[k]);
            else expect(w.fnText, k).toMatch(CHECKED[k]);
        }
        // And every listed writer still writes: a stale entry would hide a moved one.
        const seen = new Set(writes.map(w => `${w.file} ${w.fn}`));
        expect([...Object.keys(CHECKED), ...Object.keys(CONSTANT)].filter(k => !seen.has(k))).toEqual([]);
    });
});
