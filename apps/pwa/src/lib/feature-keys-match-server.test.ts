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
 * Nothing here contacts a node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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

/** The node's list: each field of NodeFeatures (one a line), and what ReaderFeatures adds to it. */
function serverSwitches(): string[] {
    const src = read('node-profile.ts');
    const start = src.indexOf('export interface NodeFeatures {');
    if (start < 0) throw new Error('no NodeFeatures in node-profile.ts');
    const keys = [...src.slice(start, src.indexOf('\n}', start)).matchAll(/^ {4}(\w+)\??: .+;$/gm)].map((m) => m[1]);
    const reader = /export type ReaderFeatures = NodeFeatures & \{([^}]*)\}/.exec(read('features-for.ts'));
    if (!reader) throw new Error('no ReaderFeatures in features-for.ts');
    for (const part of reader[1].split(';')) {
        const m = /^\s*(\w+)\??:/.exec(part);
        if (m) keys.push(m[1]);
    }
    return keys;
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
