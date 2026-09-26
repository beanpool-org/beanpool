/**
 * The phone never signs bytes a node chose (request binding, design §4.1's rule, written as a test).
 *
 * Every signature the member key makes goes through @beanpool/core's builders, which build the text themselves and
 * put 0xFF in front, or through one of the listed fallbacks for a server older than request binding, which sign
 * plain UTF-8 that they built from fields they checked (utils/crypto.ts, utils/member-statements.ts). This reads the
 * app's source (app, components, services, utils; not tests) and fails on any other path to the key:
 *
 *   - `signData(…)`, the raw signer, is called only inside `memberSigner` (the Signer handed to the builders and the
 *     fallbacks), and in `rsvpEvent`, whose `postId:status` statement is listed below;
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
            // The event RSVP carries a signature over `postId:status` (docs/events-on-the-map.md §2.2). Untagged and plain
            // UTF-8, so never a format-2 signature; the node stores it and verifies nothing against it today. It moves to
            // a format-2 statement if anything starts verifying it (design §6).
            'utils/db.ts rsvpEvent',
        ]);
        expect(sites.filter(s => s.callee === 'signData' && !allowed.has(key(s))).map(key)).toEqual([]);
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
