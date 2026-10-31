/**
 * Bring my listings, end to end (Lounge L7, utils/bring-listings.ts): the phone's own code against two REAL nodes on this
 * machine, apps/server/src/phone-door-test-harness.ts, each started from the packages' sources with its real HTTPS server
 * and signature middleware, and killed by its PID. One is the global profile, one a community with Beans on.
 *
 *   The posts arrive on the community signed by the same key, each with at most five photos, their bytes as global
 *   holds them, Offers first (the community's own Offer-first rule is what would refuse them otherwise). A photo that
 *   fails to fetch is reported; a listing left with none is refused by the community's own photo rule and said. A listing
 *   the node's real retention run archived stays behind with a line. A run cut off halfway posts nothing twice.
 *
 *   Global receives no request from the community: every request global's door counted is one the phone made
 *   (the harness's `requests`), and the community's own fetch refuses every host but this machine.
 *
 * Nothing else is contacted: the phone's fetch is held to these two addresses.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: { alert: vi.fn() },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))),
    randomUUID: vi.fn(() => randomUUID()),
    digest: vi.fn(async (_algorithm: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }),
}));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));

import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { signedPost } from '../node-post';
import { fetchNodeProfile } from '../node-profile';
import {
    bringLineWords, broughtId, noteBringOffer, pendingBringOffer, planBring, runBring, settleBringOffer, type BringOffer, type BringPlan,
} from '../bring-listings';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
/** A 1×1 PNG, as the server suites post (apps/server/src/post-test-helper.ts). */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

// A phone's FileReader; Node has none.
(globalThis as any).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
        blob.arrayBuffer().then((b) => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
            this.onload?.();
        }, () => this.onerror?.());
    }
};

interface TestNode {
    url: string;
    log: () => string;
    control<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    stop(): Promise<void>;
}

async function startNode(tag: string, env: Record<string, string>): Promise<TestNode> {
    const dataDir = mkdtempSync(join(tmpdir(), `bring-listings-e2e-${tag}-`));
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json', ...env },
        stdio: 'pipe',
    });
    const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
    let nextId = 1;
    let out = '';
    let log = '';
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the test node did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            log += chunk.toString();
            let nl: number;
            while ((nl = out.indexOf('\n')) >= 0) {
                const line = out.slice(0, nl);
                out = out.slice(nl + 1);
                const started = /^PHONE-DOOR-NODE-PORT (\d+)$/.exec(line);
                if (started) { clearTimeout(timer); resolve(Number(started[1])); }
                const reply = /^PHONE-DOOR-NODE-REPLY (.*)$/.exec(line);
                if (reply) {
                    const r = JSON.parse(reply[1]) as { id: number; result?: unknown; error?: string };
                    replies.get(r.id)?.(r);
                    replies.delete(r.id);
                }
            }
        });
        child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        child.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    return {
        url: `https://127.0.0.1:${port}`,
        log: () => log,
        control: (cmd, args = {}) => {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result)));
                child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
            });
        },
        stop: async () => {
            if (child.exitCode === null) {
                child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
                    child.on('exit', () => { clearTimeout(timer); resolve(); });
                });
            }
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

let global_: TestNode;
let local: TestNode;
const realFetch = globalThis.fetch;
/** Every request the phone sent the global community, as its door counts them. */
const phoneToGlobal: string[] = [];
const elsewhere: string[] = [];
/** Paths that answer 404 to the phone, as a photo gone from the store does. */
const failing = new Set<string>();
let globalDown = false;
/** The n-th POST of a listing to the community reaches it, and its answer is lost. */
let loseAnswerOfPost: number | null = null;
let postsToLocal = 0;

beforeAll(async () => {
    [global_, local] = await Promise.all([startNode('global', {}), startNode('local', { PHONE_DOOR_PROFILE: 'community' })]);
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        const url = new URL(href);
        const toGlobal = href.startsWith(`${global_.url}/`);
        const toLocal = href.startsWith(`${local.url}/`);
        if (!toGlobal && !toLocal) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        if (toGlobal && globalDown) throw new TypeError('Network request failed');
        if (failing.has(url.pathname)) return new Response('{}', { status: 404 });
        if (toGlobal) phoneToGlobal.push(`${String(init?.method ?? 'GET')} ${url.pathname}${url.search}`);
        const res = await realFetch(input, init);
        if (toLocal && init?.method === 'POST' && url.pathname === '/api/marketplace/posts' && ++postsToLocal === loseAnswerOfPost) {
            throw new TypeError('Network request failed');
        }
        return res;
    }) as typeof fetch;
}, START_MS);

afterAll(async () => {
    globalThis.fetch = realFetch;
    await Promise.all([global_?.stop(), local?.stop()]);
    expect(elsewhere).toEqual([]);
}, START_MS);

beforeEach(async () => {
    mem.async.clear();
    failing.clear();
    globalDown = false;
    loseAnswerOfPost = null;
    postsToLocal = 0;
    await Promise.all([global_.control('limiters'), local.control('limiters')]);
    // The fixtures list more in a day than a new account may (engine/probation.ts); the limits themselves aren't under test here.
    await global_.control('profileSwitch', { name: 'probation', value: 'false' });
});

/** A member of both: joined to the community's rules, with the profile photo a community with Beans asks for. */
async function memberOfBoth(name: string): Promise<BeanPoolIdentity> {
    const me = await draftIdentity(name);
    await global_.control('join', { key: me.publicKey, callsign: name });
    await local.control('join', { key: me.publicKey, callsign: name });
    await local.control('sql', { sql: "UPDATE members SET avatar_ref = 'bundled://koala' WHERE public_key = ?", params: [me.publicKey] });
    return me;
}

/** A listing posted to the global community as the app posts one. */
async function listOnGlobal(me: BeanPoolIdentity, type: 'offer' | 'need', title: string, photos: number, tags?: string[]): Promise<string> {
    const res = await signedPost(global_.url, '/api/marketplace/posts', {
        type, category: 'food', title, description: `About ${title}`, credits: 0, priceType: 'fixed', authorPublicKey: me.publicKey,
        lat: -28.54, lng: 153.51, photos: Array.from({ length: photos }, () => PNG), ...(tags ? { tags } : {}),
    }, me);
    const answer = await res.json() as { post?: { id: string }; error?: string };
    expect(answer.error, title).toBeUndefined();
    return answer.post!.id;
}

async function offerFor(me: BeanPoolIdentity): Promise<BringOffer> {
    // What the tab strip keeps: the nodes' own word on what they are.
    await fetchNodeProfile(global_.url);
    await fetchNodeProfile(local.url);
    expect(await noteBringOffer({ publicKey: me.publicKey, from: global_.url, to: local.url, name: 'Mullumbimby', alreadyMember: false })).toBe(true);
    return (await pendingBringOffer(me.publicKey, local.url))!;
}

const rowsOn = (node: TestNode, key: string) => node.control<Array<Record<string, any>>>('sql', {
    sql: `SELECT p.id, p.type, p.title, p.description, p.credits, p.status, p.lat, p.lng, p.author_pubkey, p.tags,
                 (SELECT COUNT(*) FROM post_photos ph WHERE ph.post_id = p.id) AS photos
            FROM posts p WHERE p.author_pubkey = ? ORDER BY p.created_at, p.rowid`,
    params: [key], all: true,
});

describe('bringing listings to a first local community (the phone against two real nodes)', () => {
    it('the posts arrive signed by the same key with at most five photos; what cannot come is said; global hears from nobody but the phone', async () => {
        const me = await memberOfBoth('Robin');
        const need = await listOnGlobal(me, 'need', 'A ladder', 2);
        const seedlings = await listOnGlobal(me, 'offer', 'Seedlings', 5);
        const honey = await listOnGlobal(me, 'offer', 'Honey', 2);
        const jam = await listOnGlobal(me, 'offer', 'Jam', 1);
        const stale = await listOnGlobal(me, 'offer', 'Old bike', 1);
        const taken = await listOnGlobal(me, 'offer', 'Taken down', 1);
        const bare = await listOnGlobal(me, 'offer', 'From before the rule', 1);

        // The node's own retention run, on a listing nothing has changed in for months.
        await global_.control('postsSql', { q: "UPDATE posts SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", p: [stale] });
        expect(await global_.control('archive')).toMatchObject({ archived: 1, photosDropped: 1 });
        // Its member's own removal: not worth a line.
        expect((await signedPost(global_.url, '/api/marketplace/posts/remove', { id: taken, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
        // A listing from before photos were mandatory.
        await global_.control('postsSql', { q: 'DELETE FROM post_photos WHERE post_id = ?', p: [bare] });
        // One of Honey's two photos, and Jam's only one, can't be fetched.
        failing.add(`/api/marketplace/posts/${honey}/photos/1`);
        failing.add(`/api/marketplace/posts/${jam}/photos/0`);

        const before = await global_.control<string[]>('requests');
        const fromPhone = phoneToGlobal.length;
        const offer = await offerFor(me);
        const plan = await planBring(offer, me) as BringPlan;
        expect(plan.bring.map((p) => p.title)).toEqual(['Seedlings', 'Honey', 'Jam', 'From before the rule', 'A ladder']);
        expect(plan.gone).toEqual(['Old bike']);

        const result = await runBring(offer, plan, me);
        expect(result).toMatchObject({ brought: 3, kept: false, held: false });
        expect(result.lines.map((l) => bringLineWords(l, 'Mullumbimby'))).toEqual([
            '"Old bike" is no longer up on the global community, so it stayed behind.',
            '"Honey" came across without some of its photos: they could not be fetched.',
            '"Jam" stayed behind: its photos could not be fetched, and Mullumbimby needs at least one.',
            '"From before the rule" stayed behind: it has no photo, and Mullumbimby needs at least one.',
        ]);

        const arrived = await rowsOn(local, me.publicKey);
        expect(arrived.map((p) => [p.type, p.title, p.photos])).toEqual([['offer', 'Seedlings', 5], ['offer', 'Honey', 1], ['need', 'A ladder', 2]]);
        for (const p of arrived) {
            expect(p).toMatchObject({ author_pubkey: me.publicKey, credits: 0, status: 'active', lat: -28.54, lng: 153.51 });
            expect(p.description).toBe(`About ${p.title}`);
        }
        expect(arrived[0].id).toBe(broughtId(seedlings, offer.to));
        expect(arrived[2].id).toBe(broughtId(need, offer.to));
        // Their bytes as global holds them.
        const hashes = (node: TestNode, id: string) => node.control<Array<{ sha256: string }>>('sql', {
            sql: 'SELECT sha256 FROM post_photos WHERE post_id = ? ORDER BY order_num', params: [id], all: true,
        });
        expect(await hashes(local, arrived[0].id)).toEqual(await hashes(global_, seedlings));

        // Global still holds its own, untouched, and was told nothing of where they went.
        expect((await rowsOn(global_, me.publicKey)).filter((p) => p.status === 'active').map((p) => p.title))
            .toEqual(['A ladder', 'Seedlings', 'Honey', 'Jam', 'From before the rule']);
        const after = await global_.control<string[]>('requests');
        expect(after.slice(before.length)).toEqual(phoneToGlobal.slice(fromPhone));
        expect(after.slice(before.length).every((r) => r.startsWith('GET '))).toBe(true);
        expect(JSON.stringify(after)).not.toContain(new URL(local.url).port);
        expect(local.log()).not.toContain('BLOCKED-FETCH');
    }, START_MS);

    it('a listing keeps its tags, which are how a community\'s search finds it', async () => {
        const me = await memberOfBoth('Tam');
        await listOnGlobal(me, 'offer', 'Lemons', 1, ['food.fruit.lemon', 'food.fruit.lime']);
        await listOnGlobal(me, 'offer', 'Plain', 1);
        const offer = await offerFor(me);
        expect(await runBring(offer, await planBring(offer, me) as BringPlan, me)).toMatchObject({ brought: 2, kept: false, lines: [] });
        expect((await rowsOn(local, me.publicKey)).map((p) => [p.title, p.tags])).toEqual([['Lemons', 'food.fruit.lemon food.fruit.lime'], ['Plain', '']]);
    }, START_MS);

    it('a community with Beans takes a Need only after an Offer: with no Offer to bring, its own words say so', async () => {
        const me = await memberOfBoth('Sage');
        await listOnGlobal(me, 'need', 'A spade', 1);
        const offer = await offerFor(me);
        const result = await runBring(offer, await planBring(offer, me) as BringPlan, me);
        expect(result).toMatchObject({ brought: 0, kept: false, lines: [{ kind: 'refused', title: 'A spade' }] });
        expect(await rowsOn(local, me.publicKey)).toEqual([]);
    }, START_MS);

    it('a run cut off halfway, its answer lost, posts nothing twice when it runs again', async () => {
        const me = await memberOfBoth('Kit');
        for (const title of ['Plums', 'Pears', 'Figs']) await listOnGlobal(me, 'offer', title, 1);
        const offer = await offerFor(me);
        loseAnswerOfPost = 2;
        const first = await runBring(offer, await planBring(offer, me) as BringPlan, me);
        expect(first).toMatchObject({ brought: 1, kept: true });
        await settleBringOffer(offer, first);
        expect((await rowsOn(local, me.publicKey)).map((p) => p.title)).toEqual(['Plums', 'Pears']);

        const kept = (await pendingBringOffer(me.publicKey, local.url))!;
        expect(kept).toMatchObject({ accepted: true, tries: 1 });
        const again = await planBring(kept, me) as BringPlan;
        expect(again.bring.map((p) => p.title)).toEqual(['Figs']);
        const second = await runBring(kept, again, me);
        expect(second).toMatchObject({ brought: 1, kept: false });
        await settleBringOffer(kept, second);
        expect((await rowsOn(local, me.publicKey)).map((p) => p.title)).toEqual(['Plums', 'Pears', 'Figs']);
        expect(await pendingBringOffer(me.publicKey, local.url)).toBeNull();
    }, START_MS);

    it('offline: the offer is kept, and the run goes when the global community answers again', async () => {
        const me = await memberOfBoth('Ash');
        await listOnGlobal(me, 'offer', 'Lemons', 1);
        const offer = await offerFor(me);
        globalDown = true;
        expect(await planBring(offer, me)).toBe('unreachable');
        expect(await pendingBringOffer(me.publicKey, local.url)).not.toBeNull();
        globalDown = false;
        const result = await runBring(offer, await planBring(offer, me) as BringPlan, me);
        expect(result).toMatchObject({ brought: 1, kept: false });
    }, START_MS);
});
