/**
 * Every switch the node can send in `features` is one the phone keeps (closing the class of the F7 apps walk's find,
 * 16 Nov 2026: readNodeProfile kept only the switches FEATURE_KEYS named, `forumPublic` was not one, and a visitor on the
 * worldwide community never got the Forum tab).
 *
 * The node's list is read from the server's own source: `NodeFeatures` in apps/server/src/config/node-profile.ts (what
 * getNodeFeatures says) and the two that GET /api/community/info and GET /api/community/me add to it, `ReaderFeatures`
 * in apps/server/src/config/features-for.ts. Each goes through the phone's own reads with a value of its type, and must
 * come back. A switch the server adds and the phone drops goes red here, before any screen is written against it.
 *
 * Both ways: a key the phone reads that the server never sends in `features` goes red too, unless it is one the server
 * says beside `features` (SAID_BESIDE), where the phone keeps it among them.
 *
 * Nothing here contacts a node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));

import { effectiveFeatures, readNodeProfile, readReaderFeatures, type NodeFeatures } from '../node-profile';

const SERVER_CONFIG = path.resolve(__dirname, '../../../server/src/config');
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** `name: type` for each field of `export interface <name> { ... }`, one field a line, as the server and phone write them. */
function interfaceFields(src: string, name: string): Map<string, string> {
    const start = src.indexOf(`export interface ${name} {`);
    if (start < 0) throw new Error(`no interface ${name}`);
    const body = src.slice(start, src.indexOf('\n}', start));
    const fields = new Map<string, string>();
    for (const m of body.matchAll(/^ {4}(\w+)\??: (.+);$/gm)) fields.set(m[1], m[2].trim());
    return fields;
}

/** The node's list: NodeFeatures, and what ReaderFeatures adds to it (`NodeFeatures & { contacts: boolean; door: Door }`). */
function serverSwitches(): Map<string, string> {
    const fields = interfaceFields(read(path.join(SERVER_CONFIG, 'node-profile.ts')), 'NodeFeatures');
    const reader = /export type ReaderFeatures = NodeFeatures & \{([^}]*)\}/.exec(read(path.join(SERVER_CONFIG, 'features-for.ts')));
    if (!reader) throw new Error('no ReaderFeatures in features-for.ts');
    for (const part of reader[1].split(';')) {
        const m = /^\s*(\w+)\??:\s*(.+?)\s*$/.exec(part);
        if (m) fields.set(m[1], m[2]);
    }
    return fields;
}

/** A value of the server's type for a switch. A type this guard doesn't know is red: teach the phone's read and this. */
function sample(key: string, type: string): unknown {
    if (type === 'boolean' || type === 'true') return true;
    if (type === 'number') return 3;
    if (type === 'Door') return 'admins';
    if (type.replace(/\s+/g, ' ') === '{ radiusKm: number; max: number }') return { radiusKm: 25, max: 100 };
    throw new Error(`the server's \`${key}\` is a ${type}: a shape the phone's readNodeProfile and this guard don't know yet`);
}

/**
 * Switches the server sends that the phone deliberately does not keep, each with its reason. Empty: the phone keeps
 * every one. A new entry needs a reason a reviewer can check.
 */
const DELIBERATELY_NOT_KEPT: Record<string, string> = {};

/** Keys the phone keeps among its features that the server says beside `features`, with where the server says each. */
const SAID_BESIDE: Record<string, { file: string; says: RegExp }> = {
    // GET /api/community/info, beside features (routes/community.ts): a poll here can offer a typed Other.
    pollOther: { file: '../routes/community.ts', says: /^\s*pollOther: true,$/m },
    // GET /api/community/me, beside features to a member (routes/community.ts, config/features-for.ts removalDeciderFor).
    removalDecider: { file: '../routes/community.ts', says: /removalDecider: removalRule/ },
};

/** Reader keys effectiveFeatures leaves as the node's, each with its reason. */
const NODE_ONLY: Record<string, string> = {
    showcase: "previews are the node's to show, never one reader's (design §4)",
    nearbyListings: "the node's own limits; a member's answer carries the same numbers",
};

const SERVER = serverSwitches();
const KEPT = [...SERVER.keys()].filter((k) => !(k in DELIBERATELY_NOT_KEPT));
const FULL: Record<string, unknown> = Object.fromEntries([...SERVER].map(([k, t]) => [k, sample(k, t)]));

describe("the node's switch list, as the server's source says it", () => {
    it('is read (a parse that finds nothing would pass every check below)', () => {
        expect(SERVER.size).toBeGreaterThan(30);
        for (const key of ['beans', 'forum', 'forumPublic', 'contacts', 'door', 'nearbyListings', 'knownFloor']) expect(SERVER.has(key)).toBe(true);
    });

    it('names no switch in the allow-lists that the server no longer sends, or no longer says beside', () => {
        for (const key of Object.keys(DELIBERATELY_NOT_KEPT)) expect(SERVER.has(key), key).toBe(true);
        for (const key of Object.keys(NODE_ONLY)) expect(SERVER.has(key), key).toBe(true);
        for (const [key, { file, says }] of Object.entries(SAID_BESIDE)) {
            expect(SERVER.has(key), `${key} is in features now: take it out of SAID_BESIDE`).toBe(false);
            expect(read(path.join(SERVER_CONFIG, file)), key).toMatch(says);
        }
    });
});

describe('the phone keeps every switch the node sends', () => {
    const info = readNodeProfile({ profile: 'global', pollOther: true, features: FULL })!;
    const me = readReaderFeatures({ features: FULL, removalDecider: 'jury' })!;

    for (const key of KEPT) {
        it(`\`${key}\` (${SERVER.get(key)}): in the community's info, in a member's answer, and as the reader's own`, () => {
            expect(info.features[key as keyof NodeFeatures], 'readNodeProfile dropped it: add it to FEATURE_KEYS and NodeFeatures').toEqual(FULL[key]);
            expect(me[key as keyof NodeFeatures], 'readReaderFeatures dropped it').toEqual(FULL[key]);
            if (!(key in NODE_ONLY)) expect(effectiveFeatures({}, me)[key as keyof NodeFeatures], "effectiveFeatures left the node's").toEqual(FULL[key]);
        });
    }

    it('and reads nothing the node never says, in `features` or beside them', () => {
        const phone = [...interfaceFields(read(path.resolve(__dirname, '../node-profile.ts')), 'NodeFeatures').keys()].sort();
        expect(phone).toEqual([...KEPT, ...Object.keys(SAID_BESIDE)].sort());
        const kept = new Set([...Object.keys(info.features), ...Object.keys(me)]);
        expect([...kept].sort()).toEqual(phone);
        expect(info.features.pollOther).toBe(true);
        expect(me.removalDecider).toBe('jury');
    });
});
