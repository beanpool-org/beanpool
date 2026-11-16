/**
 * Every switch the node can send in `features` reaches the web app's screens (the web's half of the guard the F7 apps walk
 * called for, 16 Nov 2026: the phone dropped `forumPublic` because its read kept only the switches it named).
 *
 * The web keeps no list: the community's info (lib/visitor-lobby-gate.ts communityInfoOnce) and a member's own set
 * (lib/features.ts readerFeaturesOnce) carry `features` whole, as the node sent them. This holds them to that, through the
 * real request and a stubbed fetch, for every switch the server's source names: `NodeFeatures` in
 * apps/server/src/config/node-profile.ts and what `ReaderFeatures` adds in apps/server/src/config/features-for.ts. A read
 * that starts picking keys goes red here for each one it leaves out.
 *
 * The server's list is read with the TypeScript parser (typeFields), not line by line: a field written over two lines
 * counts as one, and a member the guard can't read is red, never skipped (#3254 review).
 *
 * Nothing here contacts a node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ current: null as { publicKey: string; privateKey: string } | null }));
vi.mock('./identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./identity')>()),
    loadIdentity: async () => identity.current,
}));

import { communityInfoOnce, resetCommunityInfoOnce } from './visitor-lobby-gate';
import { readerFeaturesOnce, resetReaderFeaturesOnce } from './features';

const SERVER_CONFIG = path.resolve(__dirname, '../../../server/src/config');
const read = (file: string) => fs.readFileSync(path.join(SERVER_CONFIG, file), 'utf8');

/**
 * The field names of the type `name` in `src`, read with the TypeScript parser: an interface's members, or the `{ ... }`
 * parts of a type alias (`NodeFeatures & { contacts: boolean; door: Door }`). A field over several lines is one field.
 * `besides`: the named types an alias may join to its own parts, which this doesn't read. Anything else it can't read
 * throws, so nothing is quietly left out.
 */
function typeFields(src: string, name: string, besides: readonly string[] = []): string[] {
    const sf = ts.createSourceFile(`${name}.ts`, src, ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    const take = (members: ts.NodeArray<ts.TypeElement>) => {
        for (const m of members) {
            if (!ts.isPropertySignature(m) || !m.type || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
                throw new Error(`${name} has a member this guard can't read as a field: ${m.getText(sf).slice(0, 80)}`);
            }
            keys.push(m.name.text);
        }
    };
    let found = 0;
    for (const st of sf.statements) {
        if (ts.isInterfaceDeclaration(st) && st.name.text === name) {
            if (st.heritageClauses?.length) throw new Error(`${name} extends another type: teach this guard to read it`);
            take(st.members);
            found++;
        } else if (ts.isTypeAliasDeclaration(st) && st.name.text === name) {
            for (const part of ts.isIntersectionTypeNode(st.type) ? st.type.types : [st.type]) {
                if (ts.isTypeLiteralNode(part)) take(part.members);
                else if (!(ts.isTypeReferenceNode(part) && besides.includes(part.typeName.getText(sf)))) {
                    throw new Error(`${name} joins ${part.getText(sf).slice(0, 60)}, which this guard doesn't read`);
                }
            }
            found++;
        }
    }
    if (found !== 1) throw new Error(`${found} declarations of ${name}`);
    return keys;
}

/** The node's list: each field of NodeFeatures, and what ReaderFeatures adds to it. */
function serverSwitches(): string[] {
    return [...typeFields(read('node-profile.ts'), 'NodeFeatures'), ...typeFields(read('features-for.ts'), 'ReaderFeatures', ['NodeFeatures'])];
}

const SERVER = serverSwitches();
/** One value a switch never has by chance, so a key the read rebuilt or defaulted can't pass for the node's. */
const FULL: Record<string, unknown> = Object.fromEntries(SERVER.map((k, i) => [k, `sent-${i}`]));
FULL.showcase = true; // so the reader's own set is asked for (lib/features.ts readerSetMatters)

let answer: (pathname: string) => unknown;

beforeEach(() => {
    identity.current = null;
    resetCommunityInfoOnce();
    resetReaderFeaturesOnce();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return new Response(JSON.stringify(answer(new URL(url, 'http://x').pathname)), { status: 200 });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the web app carries every switch the node sends", () => {
    it('reads a list field by field, however a field is laid out (#3254 review: one field a line missed a two-line one)', () => {
        const src = [
            'export interface NodeFeatures {',
            '    /** one line */',
            '    beans: boolean;',
            '    forum?:',
            '        boolean;',
            '    nearbyListings?: {',
            '        radiusKm: number;',
            '        max: number;',
            '    };',
            "    'kebab-key': number; door: Door;",
            '}',
            'export type ReaderFeatures = NodeFeatures & {',
            '    contacts:',
            '        boolean;',
            '};',
        ].join('\n');
        expect(typeFields(src, 'NodeFeatures')).toEqual(['beans', 'forum', 'nearbyListings', 'kebab-key', 'door']);
        expect(typeFields(src, 'ReaderFeatures', ['NodeFeatures'])).toEqual(['contacts']);
        // What it can't read is red, never skipped.
        expect(() => typeFields(src, 'ReaderFeatures')).toThrow(/joins NodeFeatures/);
        expect(() => typeFields('export interface NodeFeatures { [key: string]: boolean }', 'NodeFeatures')).toThrow(/can't read/);
        expect(() => typeFields('export interface NodeFeatures extends Base { a: boolean }', 'NodeFeatures')).toThrow(/extends/);
        expect(() => typeFields(src, 'Missing')).toThrow(/0 declarations/);
    });

    it("reads the server's list (a parse that finds nothing would pass the rest)", () => {
        expect(SERVER.length).toBeGreaterThan(30);
        for (const key of ['beans', 'forum', 'forumPublic', 'groupGuests', 'contacts', 'door']) expect(SERVER).toContain(key);
    });

    it("in the community's info, key for key", async () => {
        answer = (p) => (p === '/api/community/info' ? { profile: 'global', features: FULL } : {});
        const features = (await communityInfoOnce()).features as Record<string, unknown>;
        for (const key of SERVER) expect(features[key], `communityInfoOnce dropped \`${key}\``).toEqual(FULL[key]);
    });

    it("in a member's own answer, key for key", async () => {
        identity.current = { publicKey: 'aa'.repeat(32), privateKey: 'bb'.repeat(32) };
        answer = (p) => (p === '/api/community/me' ? { publicKey: 'aa'.repeat(32), features: FULL } : {});
        const own = (await readerFeaturesOnce({ features: FULL } as never)) as Record<string, unknown>;
        for (const key of SERVER) expect(own?.[key], `readerFeaturesOnce dropped \`${key}\``).toEqual(FULL[key]);
    });
});
