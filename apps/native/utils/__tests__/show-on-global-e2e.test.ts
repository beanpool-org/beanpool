/**
 * "Also show this on the global community", end to end (slices G2′ and G1′, utils/show-on-global.ts): the phone's own code against two
 * REAL nodes on this machine, apps/server/src/phone-door-test-harness.ts, one the global profile and one a community with
 * Beans on, as utils/__tests__/bring-listings-e2e.test.ts runs them.
 *
 *   The copy lands on global by the same key, its point the rounded home point, with no typed place and no note, and its photo
 *   as home holds it. Global's from-line is the directory's; an unlisted host is dropped and the member told. An edit, a
 *   time change, a cancelled date and a cancel repeat. Global down, it all waits, and a phone back comes into step, a cancel
 *   included. A lost answer posts nothing twice. A refusal forgets a copy only once it has gone from global, and a series
 *   between dates isn't over. A holiday at home takes the copy down and its end brings it back. A Stop showing that lands during
 *   a tend stands, and a request that never answers ends in time for the next tend to run. A global that predates copies keeps
 *   nothing with the member's name on.
 *
 *   The home harness's request log holds nothing but the phone: no call to global, and home is asked nothing it isn't always
 *   asked. The community's own fetch refuses every host but this machine. The phone's fetch is held to these two addresses.
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

import { copyPriceLine, eventCopyOf, repeatPatternFor, roundToArea } from '@beanpool/core';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { signedDelete, signedGet, signedPost } from '../node-post';
import { fetchedPostPhoto } from '../post-photo';
import { COPY_KEEP_ALIVE_MS, COPY_TIMEOUT_MS, copyFields, copyResultLine, homeHostOf, mayShowOnGlobal, pairOf, repeatOnCopy, showOnGlobal, stopLaterLine, stopShowing, tendCopies, type CopyDeps, type HomeEvent } from '../show-on-global';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const HOST = 'mullum.example.org';
const PLACE = 'The old bowls club, 12 Station Street';
const NOTE = 'Gate code 4321';
const PIN = { lat: -28.68731, lng: 153.52219 };

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
    const dataDir = mkdtempSync(join(tmpdir(), `show-on-global-e2e-${tag}-`));
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
const elsewhere: string[] = [];
const phoneToLocal: string[] = [];
let globalDown = false;
/** The next POST to global's posts route reaches it, and its answer is lost. */
let loseNextCreate = false;
/** Where the home community says it lives now, as a community that moved to a new main name does. */
let mainAddress: string | null = null;
/** The home community answers everything but what the member's preferences are. */
let homeHidesPreferences = false;
/** The home community answers everything but a read of its listings: its photos still come, so only the read itself can hold a tick back. */
let homeHidesListings = false;

const deps = (): CopyDeps => ({ global: global_.url, get: signedGet, post: signedPost, del: signedDelete, fetchPhoto: fetchedPostPhoto, hostOf: () => HOST });

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
        if (toLocal) phoneToLocal.push(`${String(init?.method ?? 'GET')} ${url.pathname}${url.search}`);
        if (toLocal && homeHidesPreferences && url.pathname === '/api/members/preferences') return new Response('{}', { status: 503 });
        if (toLocal && homeHidesListings && url.pathname === '/api/marketplace/posts') return new Response('{}', { status: 503 });
        const res = await realFetch(input, init);
        if (toLocal && mainAddress && url.pathname === '/api/community/info') {
            const info = await res.json() as Record<string, unknown>;
            return new Response(JSON.stringify({ ...info, addresses: [HOST, mainAddress], primaryAddress: mainAddress }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (toGlobal && loseNextCreate && init?.method === 'POST' && url.pathname === '/api/marketplace/posts') {
            loseNextCreate = false;
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
    globalDown = false;
    loseNextCreate = false;
    mainAddress = null;
    homeHidesPreferences = false;
    homeHidesListings = false;
    await Promise.all([global_.control('limiters'), local.control('limiters')]);
    await global_.control('profileSwitch', { name: 'probation', value: 'false' });
    await global_.control('directory', { url: `https://${HOST}`, name: 'Mullumbimby' });
});

async function memberOfBoth(name: string): Promise<BeanPoolIdentity> {
    const me = await draftIdentity(name);
    await global_.control('join', { key: me.publicKey, callsign: name });
    await local.control('join', { key: me.publicKey, callsign: name });
    await local.control('sql', { sql: "UPDATE members SET avatar_ref = 'bundled://koala' WHERE public_key = ?", params: [me.publicKey] });
    return me;
}

/** On the minute, as the app's pickers set a time: the clock a copy goes by holds no seconds. */
const inHours = (h: number) => `${new Date(Date.now() + h * 3_600_000).toISOString().slice(0, 16)}:00.000Z`;

/** An event on the home community, as the app posts one: the member's answer. */
async function eventAtHome(me: BeanPoolIdentity, title: string, extra: Record<string, unknown> = {}): Promise<HomeEvent> {
    const res = await signedPost(local.url, '/api/marketplace/posts', {
        id: randomUUID(), type: 'event', category: 'community', title, description: `About ${title}`, authorPublicKey: me.publicKey,
        ...PIN, eventStartAt: inHours(48), eventEndAt: inHours(50), eventPlaceName: PLACE, eventPrivateNote: NOTE, eventHostLetsIn: false, photos: [PNG], ...extra,
    }, me);
    const answer = await res.json() as { post?: HomeEvent; error?: string };
    expect(answer.error, title).toBeUndefined();
    return answer.post!;
}

async function editAtHome(me: BeanPoolIdentity, id: string, patch: Record<string, unknown>): Promise<HomeEvent> {
    const res = await signedPost(local.url, '/api/marketplace/posts/update', { id, authorPublicKey: me.publicKey, ...patch }, me);
    const answer = await res.json() as { post?: HomeEvent; error?: string };
    expect(answer.error).toBeUndefined();
    return answer.post!;
}

const copyRow = async (id: string) => (await global_.control<Array<Record<string, any>>>('sql', {
    sql: `SELECT p.*, (SELECT COUNT(*) FROM post_photos ph WHERE ph.post_id = p.id) AS photo_count FROM posts p WHERE p.id = ?`, params: [id], all: true,
}))[0];
const copyIdOf = async (homeId: string, me: BeanPoolIdentity) => (await pairOf(homeId, me.publicKey))!.copyId;
const hashes = (node: TestNode, id: string) => node.control<Array<{ sha256: string }>>('sql', { sql: 'SELECT sha256 FROM post_photos WHERE post_id = ? ORDER BY order_num', params: [id], all: true });
const copyCount = async (me: BeanPoolIdentity) => (await global_.control<Array<{ c: number }>>('sql', { sql: 'SELECT COUNT(*) AS c FROM posts WHERE author_pubkey = ?', params: [me.publicKey], all: true }))[0].c;
/** A mute on global, as a moderator's third removal sets one: `/posts/update` refuses it with words (assertNotMuted). */
const muteOnGlobal = (me: BeanPoolIdentity, muted: boolean) => global_.control('sql', {
    sql: 'UPDATE members SET moderation_muted_until = ? WHERE public_key = ?', params: [muted ? new Date(Date.now() + 3_600_000).toISOString() : null, me.publicKey],
});

/** Fails rather than hangs: the tend queue is the module's, so one stuck tend would hang every test after it. */
const within = <T,>(waiting: Promise<T>, ms = 20_000) => Promise.race([
    waiting,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms); }),
]);

describe('an in-person event shown on the global community (the phone against two real nodes)', () => {
    it('the tick: a copy by the same key, the point rounded, no place and no note; home hears nothing of it and calls nobody', async () => {
        const me = await memberOfBoth('Robin');
        const home = await eventAtHome(me, 'Street party');
        const asked = await local.control<string[]>('requests');
        const fromPhone = phoneToLocal.length;
        const globalBefore = await global_.control<string[]>('requests');

        expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');

        const row = await copyRow(await copyIdOf(home.id, me));
        expect(row).toMatchObject({ author_pubkey: me.publicKey, type: 'event', title: 'Street party', status: 'active', photo_count: 1,
            shown_from_host: HOST, shown_from_post_id: home.id, event_place_name: null, event_private_note: null, event_tz: home.eventTz });
        expect(row.lat).toBe(roundToArea(PIN.lat));
        expect(row.lng).toBe(roundToArea(PIN.lng));
        expect(await hashes(global_, row.id)).toEqual(await hashes(local, home.id));
        expect(JSON.stringify(row)).not.toContain(PLACE);
        expect(JSON.stringify(copyFields(home, me.publicKey))).not.toMatch(/Station Street|4321|153\.52219/);

        // A visitor reads it with nobody in it, and the line and the door are the directory's.
        const read = await (await realFetch(`${global_.url}/api/marketplace/posts?id=${row.id}`)).json() as any[];
        expect(read[0]).toMatchObject({ authorPublicKey: 'hidden', shownCopy: true, shownFrom: { name: 'Mullumbimby', door: 'ask', host: HOST } });

        // Home: nothing but the phone's unsigned photo read, and that is not a call to global. Global: only the phone.
        const after = await local.control<string[]>('requests');
        expect(after.slice(asked.length)).toEqual(phoneToLocal.slice(fromPhone));
        expect(after.slice(asked.length).every((r) => /^GET \/api\/marketplace\/posts\/[^/]+\/photos\//.test(r))).toBe(true);
        expect(local.log()).not.toContain('BLOCKED-FETCH');
        expect(JSON.stringify((await global_.control<string[]>('requests')).slice(globalBefore.length))).not.toContain(new URL(local.url).port);
    }, START_MS);

    it('an unlisted community: the copy goes without its name, and the member is told once', async () => {
        const me = await memberOfBoth('Tam');
        const home = await eventAtHome(me, 'Quiet gathering');
        const result = await showOnGlobal(home, local.url, me, { ...deps(), hostOf: () => 'not-listed.example.org' });
        expect(result).toBe('shown-no-name');
        expect(copyResultLine(result)).toBe("Your community isn't in the directory, so this shows there without its name.");
        expect(await copyRow(await copyIdOf(home.id, me))).toMatchObject({ shown_from_host: '', shown_from_post_id: null });
    }, START_MS);

    it('a time change, the title and the pin repeat; a typed place never does', async () => {
        const me = await memberOfBoth('Noor');
        const home = await eventAtHome(me, 'Working bee');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const start = inHours(72);
        const end = inHours(74);
        const edited = await editAtHome(me, home.id, { eventStartAt: start, eventEndAt: end, title: 'Working bee, later', lat: -28.91234, lng: 153.11111, eventPlaceName: 'Another hall' });
        await repeatOnCopy(edited, me, deps());
        expect(await copyRow(id)).toMatchObject({ title: 'Working bee, later', event_start_at: start, event_end_at: end, lat: -28.9, lng: 153.1, event_place_name: null, event_private_note: null });
    }, START_MS);

    it('the last tag taken off at home comes off the copy too, and a tend then finds nothing owed', async () => {
        const me = await memberOfBoth('Tamsin');
        const home = await eventAtHome(me, 'Seed swap', { tags: ['food.eggs'], freeTags: ['wombat'] });
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const tagged = await copyRow(id);
        expect(tagged.tags).toContain('food.eggs');
        expect(tagged.free_tags).toContain('wombat');

        await repeatOnCopy(await editAtHome(me, home.id, { tags: [], freeTags: [] }), me, deps());
        const bare = await copyRow(id);
        expect(bare.tags ?? '').not.toContain('food.eggs');
        expect(bare.free_tags ?? '').not.toContain('wombat');
        // The copy's own word, as anyone reads it: the column could be right and the read not.
        const read = await (await signedGet(global_.url, `/api/marketplace/posts?id=${id}`, me)).json() as Array<{ tags?: string[]; freeTags?: string[] }>;
        expect(read[0].tags ?? []).toEqual([]);
        expect(read[0].freeTags ?? []).toEqual([]);

        const moved = (await copyRow(id)).updated_at;
        await tendCopies(me, deps());
        expect((await copyRow(id)).updated_at).toBe(moved);
    }, START_MS);

    it('one tag of two taken off leaves the other, and tags left alone at home are left alone on the copy', async () => {
        const me = await memberOfBoth('Tobi');
        const home = await eventAtHome(me, 'Plant swap', { freeTags: ['wombat', 'quoll'] });
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        await repeatOnCopy(await editAtHome(me, home.id, { title: 'Plant swap, renamed' }), me, deps());
        expect((await copyRow(id)).free_tags).toContain('quoll');
        await repeatOnCopy(await editAtHome(me, home.id, { freeTags: ['quoll'] }), me, deps());
        const after = await copyRow(id);
        expect(after.free_tags).toContain('quoll');
        expect(after.free_tags).not.toContain('wombat');
    }, START_MS);

    it('an "until" cleared at home is cleared on the copy, and one still set stays', async () => {
        const me = await memberOfBoth('Ulla');
        const start = new Date(Date.now() + 8 * 24 * 3_600_000);
        const clock = (d: Date) => d.toISOString().slice(0, 16);
        const day = (d: Date) => d.toISOString().slice(0, 10);
        const until = day(new Date(start.getTime() + 28 * 24 * 3_600_000));
        const home = await eventAtHome(me, 'Weekly bee', {
            eventStartLocal: clock(start), eventEndLocal: clock(new Date(start.getTime() + 2 * 3_600_000)), eventTz: 'UTC',
            eventRepeat: repeatPatternFor('weekly', day(start)), eventRepeatUntil: until,
        });
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect((await copyRow(id)).event_repeat_until).toBe(until);

        await repeatOnCopy(await editAtHome(me, home.id, { title: 'Weekly bee, renamed' }), me, deps());
        expect(await copyRow(id)).toMatchObject({ title: 'Weekly bee, renamed', event_repeat_until: until });

        await repeatOnCopy(await editAtHome(me, home.id, { eventRepeatUntil: null }), me, deps());
        const after = await copyRow(id);
        expect(after.event_repeat_until).toBeNull();
        expect(after.event_repeat).toBeTruthy();
    }, START_MS);

    it('a new photo goes with the edit; an unchanged one is not sent again', async () => {
        const me = await memberOfBoth('Sam');
        const home = await eventAtHome(me, 'Plant swap');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const before = await hashes(global_, id);
        const words = await editAtHome(me, home.id, { description: 'Bring a pot' });
        const posted: string[] = [];
        await repeatOnCopy(words, me, { ...deps(), fetchPhoto: async (url) => { posted.push(url); return fetchedPostPhoto(url); } });
        expect(posted).toEqual([]);
        expect((await copyRow(id)).description).toBe('Bring a pot');
        expect(await hashes(global_, id)).toEqual(before);
    }, START_MS);

    it('a cancel at home takes the copy off; Stop showing does too, and it can be shown again', async () => {
        const me = await memberOfBoth('Ash');
        const home = await eventAtHome(me, 'Picnic');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect(await stopShowing(home.id, me, deps())).toBe(true);
        expect((await copyRow(id)).status).toBe('cancelled');
        expect(await pairOf(home.id, me.publicKey)).toBeNull();

        expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');
        const again = await copyIdOf(home.id, me);
        expect(again).not.toBe(id);
        expect((await copyRow(again)).status).toBe('active');

        // Cancelled at home by another device: the phone hears it from home when it next comes round.
        expect((await signedPost(local.url, '/api/marketplace/posts/remove', { id: home.id, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
        await tendCopies(me, deps());
        expect((await copyRow(again)).status).toBe('cancelled');
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    describe('a holiday at home: the copy leaves global with the member\'s listings, and goes back up when they\'re back', () => {
        const holiday = async (me: BeanPoolIdentity, enabled: boolean) => {
            expect((await signedPost(local.url, '/api/members/holiday', { enabled }, me)).ok).toBe(true);
        };
        const liveCopies = async (me: BeanPoolIdentity) => (await global_.control<Array<{ id: string; title: string }>>('sql', {
            sql: "SELECT id, title FROM posts WHERE author_pubkey = ? AND status = 'active' AND active = 1", params: [me.publicKey], all: true,
        }));

        it('down at the next tend, back at the first one after, as a new copy with what changed at home in between', async () => {
            const me = await memberOfBoth('Away Hana');
            const home = await eventAtHome(me, 'Market day', { freeTags: ['stalls'] });
            await showOnGlobal(home, local.url, me, deps());
            const id = await copyIdOf(home.id, me);
            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('active');

            await holiday(me, true);
            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('cancelled');
            expect(await liveCopies(me)).toEqual([]);
            expect((await pairOf(home.id, me.publicKey))?.resting).toBe(true);

            // Nothing sends it while they're away: not a tend, not an edit at home.
            await tendCopies(me, deps());
            const edited = await editAtHome(me, home.id, { title: 'Market day, moved', freeTags: [] });
            await repeatOnCopy(edited, me, deps());
            expect(await showOnGlobal(edited, local.url, me, deps())).toBe('later');
            expect(await liveCopies(me)).toEqual([]);

            await holiday(me, false);
            await tendCopies(me, deps());
            const pair = await pairOf(home.id, me.publicKey);
            expect(pair?.copyId).not.toBe(id);
            expect(pair?.resting).toBe(false);
            const back = await copyRow(pair!.copyId);
            expect(back).toMatchObject({ status: 'active', title: 'Market day, moved', author_pubkey: me.publicKey, shown_from_host: HOST, shown_from_post_id: home.id, photo_count: 1 });
            expect((await copyRow(id)).status).toBe('cancelled');

            const stamp = back.updated_at;
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toHaveLength(1);
            expect((await copyRow(pair!.copyId)).updated_at).toBe(stamp);
        }, START_MS);

        it('a date cancelled at home is cancelled on the copy that comes back', async () => {
            const me = await memberOfBoth('Away Noor');
            const first = new Date(inHours(14 * 24));
            const end = new Date(first.getTime() + 2 * 3_600_000);
            const clock = (d: Date) => d.toISOString().slice(0, 16);
            const later = new Date(first.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
            const home = await eventAtHome(me, 'Weekly', {
                eventStartAt: first.toISOString(), eventEndAt: end.toISOString(), eventStartLocal: clock(first), eventEndLocal: clock(end), eventTz: 'UTC',
                eventRepeat: repeatPatternFor('weekly', clock(first).slice(0, 10)),
            });
            await showOnGlobal(home, local.url, me, deps());
            await holiday(me, true);
            await tendCopies(me, deps());
            expect((await signedPost(local.url, `/api/events/${home.id}/skip`, { date: later }, me)).ok).toBe(true);
            await holiday(me, false);
            await tendCopies(me, deps());
            const pair = await pairOf(home.id, me.publicKey);
            expect(pair?.skips).toEqual([later]);
            expect(String((await copyRow(pair!.copyId)).event_repeat_skips)).toContain(later);
        }, START_MS);

        it('global down when the holiday starts: the copy comes down when it answers, and the pair still waits', async () => {
            const me = await memberOfBoth('Away Otis');
            const home = await eventAtHome(me, 'Swap meet');
            await showOnGlobal(home, local.url, me, deps());
            const id = await copyIdOf(home.id, me);
            await holiday(me, true);
            globalDown = true;
            await tendCopies(me, deps());
            globalDown = false;
            expect((await copyRow(id)).status).toBe('active');
            expect(await pairOf(home.id, me.publicKey)).toMatchObject({ copyId: id, leaving: true, resting: true });

            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('cancelled');
            await holiday(me, false);
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toHaveLength(1);
        }, START_MS);

        it('home not saying changes nothing, whichever way the holiday stands', async () => {
            const me = await memberOfBoth('Away Pax');
            const home = await eventAtHome(me, 'Working bee');
            await showOnGlobal(home, local.url, me, deps());
            const id = await copyIdOf(home.id, me);
            homeHidesPreferences = true;
            await holiday(me, true);
            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('active');
            homeHidesPreferences = false;
            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('cancelled');

            homeHidesPreferences = true;
            await holiday(me, false);
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toEqual([]);
            expect((await pairOf(home.id, me.publicKey))?.resting).toBe(true);
        }, START_MS);

        it('resting, a cancel at home, moving online and Stop showing each end it: nothing comes back', async () => {
            const me = await memberOfBoth('Away Quin');
            const cancelled = await eventAtHome(me, 'Cancelled while away');
            const online = await eventAtHome(me, 'Online while away');
            const stopped = await eventAtHome(me, 'Stopped while away');
            for (const event of [cancelled, online, stopped]) await showOnGlobal(event, local.url, me, deps());
            await holiday(me, true);
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toEqual([]);
            const removed = { ok: true } as Response;
            const noGlobal: CopyDeps = { ...deps(), post: vi.fn(async () => removed) };

            expect((await signedPost(local.url, '/api/marketplace/posts/remove', { id: cancelled.id, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
            await tendCopies(me, noGlobal);
            expect(await pairOf(cancelled.id, me.publicKey)).toBeNull();
            await repeatOnCopy({ ...online, eventOnline: true }, me, noGlobal);
            expect(await pairOf(online.id, me.publicKey)).toBeNull();
            expect(await stopShowing(stopped.id, me, noGlobal)).toBe(true);
            expect(await pairOf(stopped.id, me.publicKey)).toBeNull();
            // Global was told nothing: there was nothing up to take down.
            expect(noGlobal.post).not.toHaveBeenCalled();

            await holiday(me, false);
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toEqual([]);
        }, START_MS);

        it('Stop showing before global has heard takes it down for good', async () => {
            const me = await memberOfBoth('Away Rae');
            const home = await eventAtHome(me, 'Stopped on the way down');
            await showOnGlobal(home, local.url, me, deps());
            const id = await copyIdOf(home.id, me);
            await holiday(me, true);
            globalDown = true;
            await tendCopies(me, deps());
            globalDown = false;
            expect(await stopShowing(home.id, me, deps())).toBe(true);
            expect((await copyRow(id)).status).toBe('cancelled');
            expect(await pairOf(home.id, me.publicKey)).toBeNull();
            await holiday(me, false);
            await tendCopies(me, deps());
            expect(await liveCopies(me)).toEqual([]);
        }, START_MS);

        it('two tends at once, as the app coming to the front and the holiday switch can start, leave one copy', async () => {
            const me = await memberOfBoth('Away Tully');
            const home = await eventAtHome(me, 'Only once');
            await showOnGlobal(home, local.url, me, deps());
            await holiday(me, true);
            await Promise.all([tendCopies(me, deps()), tendCopies(me, deps())]);
            await holiday(me, false);
            await Promise.all([tendCopies(me, deps()), tendCopies(me, deps())]);
            expect(await liveCopies(me)).toHaveLength(1);
        }, START_MS);

        it('one tend asks home once, however many events the member has shown', async () => {
            const me = await memberOfBoth('Away Sol');
            for (const title of ['One', 'Two', 'Three']) await showOnGlobal(await eventAtHome(me, title), local.url, me, deps());
            const from = phoneToLocal.length;
            await tendCopies(me, deps());
            expect(phoneToLocal.slice(from).filter((r) => r.includes('/api/members/preferences'))).toHaveLength(1);
        }, START_MS);

        /** One step of a tend held open until the test lets it go, as a slow line holds it. */
        function held() {
            let reached!: () => void;
            let release!: () => void;
            const at = new Promise<void>((resolve) => { reached = resolve; });
            const until = new Promise<void>((resolve) => { release = resolve; });
            return { at, release, hold: () => { reached(); return until; } };
        }
        type Held = ReturnType<typeof held>;
        const homeHeld = (gate: Held, part: string): CopyDeps => ({ ...deps(), get: async (url, path, identity, signal) => {
            if (url === local.url && path.includes(part)) await gate.hold();
            return signedGet(url, path, identity, signal);
        } });
        /** A write to global held on its way there, or held after it has landed with its answer on the way back. */
        const globalHeld = (gate: Held, part: RegExp, when: 'going' | 'landed'): CopyDeps => ({ ...deps(), post: async (url, path, body, identity, signal) => {
            if (!part.test(path)) return signedPost(url, path, body, identity, signal);
            if (when === 'going') await gate.hold();
            const res = await signedPost(url, path, body, identity, signal);
            if (when === 'landed') await gate.hold();
            return res;
        } });
        const weekly = async (me: BeanPoolIdentity, title: string) => {
            const first = new Date(inHours(14 * 24));
            const end = new Date(first.getTime() + 2 * 3_600_000);
            const clock = (d: Date) => d.toISOString().slice(0, 16);
            const home = await eventAtHome(me, title, {
                eventStartAt: first.toISOString(), eventEndAt: end.toISOString(), eventStartLocal: clock(first), eventEndLocal: clock(end), eventTz: 'UTC',
                eventRepeat: repeatPatternFor('weekly', clock(first).slice(0, 10)),
            });
            await showOnGlobal(home, local.url, me, deps());
            return { home, date: new Date(first.getTime() + 7 * 86_400_000).toISOString().slice(0, 10) };
        };

        describe('a Stop showing that lands during a tend stands: the pair stays gone, and nothing comes back when the holiday ends', () => {
            const staysStopped = async (me: BeanPoolIdentity, homeId: string, tend: Promise<void>, gate: Held, others: string[] = []) => {
                await within(gate.at);
                expect(await stopShowing(homeId, me, deps())).toBe(true);
                gate.release();
                await within(tend);
                expect(await pairOf(homeId, me.publicKey)).toBeNull();
                await holiday(me, false);
                await within(tendCopies(me, deps()));
                expect((await liveCopies(me)).map((c) => c.title)).toEqual(others);
            };

            it('on the next event, while the tend is reading the first from home', async () => {
                const me = await memberOfBoth('Mid Uma');
                const kept = await eventAtHome(me, 'Still shown');
                const stopped = await eventAtHome(me, 'Stopped mid-tend');
                for (const event of [kept, stopped]) await showOnGlobal(event, local.url, me, deps());
                await holiday(me, true);
                const gate = held();
                await staysStopped(me, stopped.id, tendCopies(me, homeHeld(gate, kept.id)), gate, ['Still shown']);
            }, START_MS);

            it.each([['its own read from home', 'id'], ['the read of the holiday', 'preferences']] as const)('on the event itself, during %s', async (_step, part) => {
                const me = await memberOfBoth(`Mid Vee ${part}`);
                const home = await eventAtHome(me, 'Stopped during a read');
                await showOnGlobal(home, local.url, me, deps());
                await holiday(me, true);
                const gate = held();
                await staysStopped(me, home.id, tendCopies(me, homeHeld(gate, part === 'id' ? home.id : '/api/members/preferences')), gate);
            }, START_MS);

            it('on the next event, both waiting for global to hear, while the first is being retried', async () => {
                const me = await memberOfBoth('Mid Tess');
                const first = await eventAtHome(me, 'Retried first');
                const stopped = await eventAtHome(me, 'Stopped while waiting');
                for (const event of [first, stopped]) await showOnGlobal(event, local.url, me, deps());
                await holiday(me, true);
                globalDown = true;
                await tendCopies(me, deps());
                globalDown = false;
                const gate = held();
                await staysStopped(me, stopped.id, tendCopies(me, globalHeld(gate, /\/remove$/, 'going')), gate, ['Retried first']);
            }, START_MS);

            it('with the rest\'s own remove on its way to global', async () => {
                const me = await memberOfBoth('Mid Wren');
                const home = await eventAtHome(me, 'Stopped mid-remove');
                await showOnGlobal(home, local.url, me, deps());
                await holiday(me, true);
                const gate = held();
                await staysStopped(me, home.id, tendCopies(me, globalHeld(gate, /\/remove$/, 'going')), gate);
            }, START_MS);

            const rested = async (me: BeanPoolIdentity, title: string) => {
                const home = await eventAtHome(me, title);
                await showOnGlobal(home, local.url, me, deps());
                await holiday(me, true);
                await tendCopies(me, deps());
                await holiday(me, false);
                return home;
            };

            it('at the holiday\'s end, while the tend is reading from home: no new copy goes up', async () => {
                const me = await memberOfBoth('Mid Xan');
                const home = await rested(me, 'Stopped at the end');
                const gate = held();
                await staysStopped(me, home.id, tendCopies(me, homeHeld(gate, home.id)), gate);
                // Not one up and taken down again: only the first copy ever reached global.
                expect(await copyCount(me)).toBe(1);
            }, START_MS);

            it.each(['going', 'landed'] as const)('at the holiday\'s end, with the new copy %s: it comes down', async (when) => {
                const me = await memberOfBoth(`Mid Yara ${when}`);
                const home = await rested(me, 'Stopped on its way back');
                const gate = held();
                await staysStopped(me, home.id, tendCopies(me, globalHeld(gate, /\/api\/marketplace\/posts$/, when)), gate);
            }, START_MS);

            it('with its remove reaching global before the send does: the copy still comes down', async () => {
                const me = await memberOfBoth('Mid Cleo');
                const home = await eventAtHome(me, 'Overtaken');
                globalDown = true;
                await showOnGlobal(home, local.url, me, deps());
                globalDown = false;
                const sending = held();
                const tend = tendCopies(me, globalHeld(sending, /\/api\/marketplace\/posts$/, 'going'));
                await within(sending.at);
                const removing = held();
                const stop = stopShowing(home.id, me, globalHeld(removing, /\/remove$/, 'landed'));
                await within(removing.at);
                sending.release();
                await within(tend);
                removing.release();
                await within(stop);
                expect(await liveCopies(me)).toEqual([]);
                expect(await pairOf(home.id, me.publicKey)).toBeNull();
            }, START_MS);

            it('with an edit\'s answer on its way back: the pair doesn\'t return', async () => {
                const me = await memberOfBoth('Mid Zed');
                const home = await eventAtHome(me, 'Edited, then stopped');
                await showOnGlobal(home, local.url, me, deps());
                const id = await copyIdOf(home.id, me);
                await editAtHome(me, home.id, { title: 'Edited again' });
                const gate = held();
                const tend = tendCopies(me, globalHeld(gate, /\/update$/, 'landed'));
                await staysStopped(me, home.id, tend, gate);
                expect((await copyRow(id)).status).toBe('cancelled');
            }, START_MS);

            it('with a cancelled date\'s answer on its way back: the pair doesn\'t return', async () => {
                const me = await memberOfBoth('Mid Abe');
                const { home, date } = await weekly(me, 'Dated, then stopped');
                expect((await signedPost(local.url, `/api/events/${home.id}/skip`, { date }, me)).ok).toBe(true);
                const gate = held();
                await staysStopped(me, home.id, tendCopies(me, globalHeld(gate, /\/skip$/, 'landed')), gate);
            }, START_MS);
        });

        describe('a request that never answers ends in time: the tends after it still run', () => {
            /** The request timer the code under test has running, fired by hand: a minute going by on a dead line. */
            function requestClock() {
                const running = new Map<unknown, () => void>();
                const [realSet, realClear] = [globalThis.setTimeout, globalThis.clearTimeout];
                const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
                    const handle = realSet(fn, ms);
                    if (ms === COPY_TIMEOUT_MS) running.set(handle, fn);
                    return handle;
                }) as unknown as typeof setTimeout);
                const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: any) => {
                    running.delete(handle);
                    realClear(handle);
                }) as typeof clearTimeout);
                return { fire: () => { for (const fn of running.values()) fn(); }, restore: () => { set.mockRestore(); clear.mockRestore(); } };
            }
            /** A line that has gone quiet. It ends for the signal it was given, or when the test is over, so a failure can't hang the rest. */
            function deadLine({ deaf = false } = {}) {
                const over = new AbortController();
                const signals: Array<AbortSignal | undefined> = [];
                let heard!: () => void;
                const reached = new Promise<void>((resolve) => { heard = resolve; });
                const stall = (signal?: AbortSignal) => {
                    signals.push(signal);
                    heard();
                    return new Promise<never>((_, reject) => {
                        const dies = () => reject(new TypeError('Network request failed'));
                        if (!deaf) signal?.addEventListener('abort', dies);
                        over.signal.addEventListener('abort', dies);
                    });
                };
                return { reached, signals, stall, end: () => over.abort() };
            }
            type Dead = ReturnType<typeof deadLine>;
            /** The headers came, and the body never does. */
            const noBody = (line: Dead, signal?: AbortSignal) => ({ ok: true, status: 200, json: () => line.stall(signal) }) as unknown as Response;

            async function stalledThenTended(me: BeanPoolIdentity, line: Dead, stuck: CopyDeps): Promise<void> {
                const clock = requestClock();
                try {
                    const tend = tendCopies(me, stuck);
                    await within(line.reached);
                    clock.fire();
                    await within(tend);
                } finally {
                    clock.restore();
                    line.end();
                }
                expect(line.signals).toHaveLength(1);
                expect(line.signals[0]?.aborted).toBe(true);
            }

            it('a cancelled date: the holiday switch\'s tend still runs, and the copy comes down', async () => {
                const me = await memberOfBoth('Dead Ann');
                const { home, date } = await weekly(me, 'Skip on a dead line');
                expect((await signedPost(local.url, `/api/events/${home.id}/skip`, { date }, me)).ok).toBe(true);
                const line = deadLine();
                await stalledThenTended(me, line, { ...deps(), post: (url, path, body, identity, signal) => (path.endsWith('/skip') ? line.stall(signal) : signedPost(url, path, body, identity, signal)) });
                await holiday(me, true);
                await within(tendCopies(me, deps()));
                expect(await liveCopies(me)).toEqual([]);
            }, START_MS);

            it('a step that doesn\'t hear the signal is given up on all the same', async () => {
                const me = await memberOfBoth('Dead Gus');
                const { home, date } = await weekly(me, 'Skip that hears nothing');
                expect((await signedPost(local.url, `/api/events/${home.id}/skip`, { date }, me)).ok).toBe(true);
                const line = deadLine({ deaf: true });
                await stalledThenTended(me, line, { ...deps(), post: (url, path, body, identity, signal) => (path.endsWith('/skip') ? line.stall(signal) : signedPost(url, path, body, identity, signal)) });
                await within(tendCopies(me, deps()));
            }, START_MS);

            it('a date brought back: the same, and the delete gives up on its signal', async () => {
                const me = await memberOfBoth('Dead Bo');
                const { home, date } = await weekly(me, 'Unskip on a dead line');
                const path = `/api/events/${home.id}/skip`;
                expect((await signedPost(local.url, path, { date }, me)).ok).toBe(true);
                await tendCopies(me, deps());
                expect((await pairOf(home.id, me.publicKey))?.skips).toEqual([date]);
                expect((await signedDelete(local.url, `${path}?date=${date}`, me)).ok).toBe(true);
                const line = deadLine();
                await stalledThenTended(me, line, { ...deps(), del: (_url, _path, _identity, signal) => line.stall(signal) });
                await holiday(me, true);
                await within(tendCopies(me, deps()));
                expect(await liveCopies(me)).toEqual([]);

                const gaveUp = new AbortController();
                gaveUp.abort();
                await expect(signedDelete(global_.url, `/api/events/${randomUUID()}/skip?date=${date}`, me, gaveUp.signal)).rejects.toThrow();
            }, START_MS);

            it.each([
                ['the home read', (id: string) => id],
                ['the read of the holiday', () => '/api/members/preferences'],
            ])('the body of %s never comes: the next tend still asks', async (name, part) => {
                const me = await memberOfBoth(`Dead Cy ${name}`);
                const home = await eventAtHome(me, 'A quiet body');
                await showOnGlobal(home, local.url, me, deps());
                const line = deadLine();
                await stalledThenTended(me, line, {
                    ...deps(),
                    get: async (url, path, identity, signal) => (path.includes(part(home.id)) ? noBody(line, signal) : signedGet(url, path, identity, signal)),
                });
                const next: CopyDeps = { ...deps(), get: vi.fn(signedGet) };
                await within(tendCopies(me, next));
                expect(next.get).toHaveBeenCalled();
            }, START_MS);

            it('the body of an edit\'s answer never comes: the next tend sends it', async () => {
                const me = await memberOfBoth('Dead Di');
                const home = await eventAtHome(me, 'A quiet edit');
                await showOnGlobal(home, local.url, me, deps());
                await editAtHome(me, home.id, { title: 'A quiet edit, moved' });
                const line = deadLine();
                await stalledThenTended(me, line, { ...deps(), post: async (url, path, body, identity, signal) => (path.endsWith('/update') ? noBody(line, signal) : signedPost(url, path, body, identity, signal)) });
                await within(tendCopies(me, deps()));
                expect((await liveCopies(me)).map((c) => c.title)).toEqual(['A quiet edit, moved']);
            }, START_MS);

            it('the body of a remove\'s answer never comes: the rest is tried again', async () => {
                const me = await memberOfBoth('Dead Eve');
                const home = await eventAtHome(me, 'A quiet remove');
                await showOnGlobal(home, local.url, me, deps());
                await holiday(me, true);
                const line = deadLine();
                await stalledThenTended(me, line, { ...deps(), post: async (url, path, body, identity, signal) => (path.endsWith('/remove') ? noBody(line, signal) : signedPost(url, path, body, identity, signal)) });
                await within(tendCopies(me, deps()));
                expect(await liveCopies(me)).toEqual([]);
                expect((await pairOf(home.id, me.publicKey))?.resting).toBe(true);
            }, START_MS);

            it.each(['the read a waiting copy starts with', 'a new copy\'s answer'])('the body of %s never comes: the next tend sends it', async (step) => {
                const me = await memberOfBoth(`Dead Flo ${step.length}`);
                const home = await eventAtHome(me, 'A quiet first send');
                globalDown = true;
                await showOnGlobal(home, local.url, me, deps());
                globalDown = false;
                const copyId = await copyIdOf(home.id, me);
                const line = deadLine();
                await stalledThenTended(me, line, {
                    ...deps(),
                    ...(step.startsWith('the read')
                        ? { get: async (url, path, identity, signal) => (url === global_.url && path.includes(copyId) ? noBody(line, signal) : signedGet(url, path, identity, signal)) }
                        : { post: async (url, path, body, identity, signal) => (/\/api\/marketplace\/posts$/.test(path) ? noBody(line, signal) : signedPost(url, path, body, identity, signal)) }),
                } as CopyDeps);
                await within(tendCopies(me, deps()));
                expect((await liveCopies(me)).map((c) => c.title)).toEqual(['A quiet first send']);
            }, START_MS);
        });
    });

    it('what the tick is not for never goes, whoever asks: a group\'s event, an enterprise\'s, an online one', async () => {
        const me = await memberOfBoth('Odile');
        const home = await eventAtHome(me, 'Committee dinner');
        for (const notForIt of [{ ...home, audienceScope: 'group' }, { ...home, authorPublicKey: 'ab'.repeat(32) }, { ...home, eventOnline: true }]) {
            expect(await showOnGlobal(notForIt, local.url, me, deps())).toEqual({ refused: expect.any(String) });
        }
        expect(await copyCount(me)).toBe(0);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('an event moved online comes off global, at the moment and in the catch-up: no copy is left at 0,0', async () => {
        const me = await memberOfBoth('Perrin');
        const atOnce = await eventAtHome(me, 'Moved online, phone in hand');
        const later = await eventAtHome(me, 'Moved online from the web app');
        await showOnGlobal(atOnce, local.url, me, deps());
        await showOnGlobal(later, local.url, me, deps());
        const [first, second] = [await copyIdOf(atOnce.id, me), await copyIdOf(later.id, me)];

        const online = { eventOnline: true, eventLink: 'https://meet.example.org/room', eventTz: 'Australia/Sydney' };
        await repeatOnCopy(await editAtHome(me, atOnce.id, online), me, deps());
        expect((await copyRow(first)).status).toBe('cancelled');
        expect(await pairOf(atOnce.id, me.publicKey)).toBeNull();

        await editAtHome(me, later.id, online);
        await tendCopies(me, deps());
        expect((await copyRow(second)).status).toBe('cancelled');
        expect(await pairOf(later.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('a community that moved to a new main name: a phone still on the old one goes by the new, and its name shows', async () => {
        const me = await memberOfBoth('Remy');
        mainAddress = 'byron.example.org';
        await global_.control('directory', { url: `https://${mainAddress}`, name: 'Byron Shire' });
        const home = await eventAtHome(me, 'Reached by the old name');
        expect(await showOnGlobal(home, local.url, me, { ...deps(), hostOf: homeHostOf })).toBe('shown');
        expect((await copyRow(await copyIdOf(home.id, me))).shown_from_host).toBe(mainAddress);
    }, START_MS);

    it('a repeating event carries its rule, and a date cancelled at home is cancelled on the copy', async () => {
        const me = await memberOfBoth('Kit');
        const start = new Date(Date.now() + 8 * 24 * 3_600_000);
        const clock = (d: Date) => d.toISOString().slice(0, 16);
        const home = await eventAtHome(me, 'Weekly market', {
            eventStartLocal: clock(start), eventEndLocal: clock(new Date(start.getTime() + 2 * 3_600_000)), eventTz: 'UTC',
            eventRepeat: repeatPatternFor('weekly', clock(start).slice(0, 10)),
        });
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');
        const id = await copyIdOf(home.id, me);
        expect((await copyRow(id)).event_repeat).toBeTruthy();
        const next = new Date(start.getTime() + 7 * 24 * 3_600_000).toISOString().slice(0, 10);
        const skipped = await signedPost(local.url, `/api/events/${home.id}/skip`, { date: next }, me);
        const { post } = await skipped.json() as { post: HomeEvent };
        expect(post.eventRepeatSkips).toEqual([next]);
        await repeatOnCopy(post, me, deps());
        expect(JSON.parse((await copyRow(id)).event_repeat_skips)).toEqual([next]);
    }, START_MS);

    it('global down: it waits; back, the phone comes into step, a cancel included', async () => {
        const me = await memberOfBoth('Wren');
        const first = await eventAtHome(me, 'Waits to go');
        const second = await eventAtHome(me, 'Comes down late');
        await showOnGlobal(second, local.url, me, deps());
        const secondId = await copyIdOf(second.id, me);

        globalDown = true;
        expect(await showOnGlobal(first, local.url, me, deps())).toBe('later');
        expect(copyResultLine('later')).toBe('It will go up on the global community as soon as it can.');
        expect(await stopShowing(second.id, me, deps())).toBe(false);
        expect(stopLaterLine()).toBe('It will come down from the global community as soon as it can.');
        globalDown = false;

        await tendCopies(me, deps());
        expect(await copyRow(await copyIdOf(first.id, me))).toMatchObject({ title: 'Waits to go', status: 'active' });
        expect((await copyRow(secondId)).status).toBe('cancelled');
        expect(await pairOf(second.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('an answer lost on the way back posts nothing twice', async () => {
        const me = await memberOfBoth('Jude');
        const home = await eventAtHome(me, 'Lost answer');
        loseNextCreate = true;
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('later');
        expect(await copyCount(me)).toBe(1);
        await tendCopies(me, deps());
        expect(await copyCount(me)).toBe(1);
        expect((await pairOf(home.id, me.publicKey))!.sent).not.toBe('');
    }, START_MS);

    it('an edit refused with the copy still up keeps the pair: muted on global, the catch-up and a cancel at home both still reach it', async () => {
        const me = await memberOfBoth('Bex');
        const home = await eventAtHome(me, 'Refused edit');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const { sent } = (await pairOf(home.id, me.publicKey))!;

        await muteOnGlobal(me, true);
        await repeatOnCopy(await editAtHome(me, home.id, { title: 'Refused edit, first go' }), me, deps());
        expect((await copyRow(id)).title).toBe('Refused edit');
        expect(await pairOf(home.id, me.publicKey)).toMatchObject({ copyId: id, sent });

        // The mute lifts: `sent` is as it was, so the next tend sees the difference and tries again.
        await muteOnGlobal(me, false);
        await tendCopies(me, deps());
        expect((await copyRow(id)).title).toBe('Refused edit, first go');

        // Refused again, and this time the event is cancelled at home.
        await muteOnGlobal(me, true);
        await repeatOnCopy(await editAtHome(me, home.id, { title: 'Refused edit, second go' }), me, deps());
        expect(await stopShowing(home.id, me, deps())).toBe(true);
        expect((await copyRow(id)).status).toBe('cancelled');
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('an edit refused because the copy has gone forgets the pair, so the row stops saying Shown and it can be shown again', async () => {
        const me = await memberOfBoth('Dara');
        const home = await eventAtHome(me, 'Taken down on global');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        // From My posts on global. Its host can still read a cancelled event by id, and that isn't a copy that is up.
        expect((await signedPost(global_.url, '/api/marketplace/posts/remove', { id, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
        expect((await (await signedGet(global_.url, `/api/marketplace/posts?id=${id}`, me)).json() as unknown[]).length).toBe(1);

        const edited = await editAtHome(me, home.id, { title: 'Taken down, then edited' });
        await repeatOnCopy(edited, me, deps());
        expect(await pairOf(home.id, me.publicKey)).toBeNull();

        expect(await showOnGlobal(edited, local.url, me, deps())).toBe('shown');
        expect((await copyRow(await copyIdOf(home.id, me))).title).toBe('Taken down, then edited');
    }, START_MS);

    it('an edit during the first upload sends the same id twice: the refused second POST forgets nothing, and a cancel reaches the copy', async () => {
        const me = await memberOfBoth('Cass');
        const home = await eventAtHome(me, 'Sent twice');
        let upload!: () => void;
        const uploading = new Promise<void>((resolve) => { upload = resolve; });
        let finishUpload!: () => void;
        const held = new Promise<void>((resolve) => { finishUpload = resolve; });
        const first = showOnGlobal(home, local.url, me, { ...deps(), fetchPhoto: async (url) => { upload(); await held; return fetchedPostPhoto(url); } });
        await uploading;

        // The edit finds the pair not yet sent and global without the copy, so it makes the copy itself.
        await repeatOnCopy(home, me, deps());
        const id = await copyIdOf(home.id, me);
        expect((await copyRow(id)).status).toBe('active');

        // The first send then POSTs the same id, and global's primary key refuses it. The copy is up: nothing to tell the member.
        finishUpload();
        expect(await first).toBe('shown');
        expect(await copyCount(me)).toBe(1);
        expect(await pairOf(home.id, me.publicKey)).toMatchObject({ copyId: id, sent: JSON.stringify(copyFields(home, me.publicKey)) });

        expect(await stopShowing(home.id, me, deps())).toBe(true);
        expect((await copyRow(id)).status).toBe('cancelled');
    }, START_MS);

    describe('a tend in the minute a date ends: the row keeps that date until home\'s minute roll moves it on', () => {
        const clock = (d: Date) => d.toISOString().slice(0, 16);
        const WEEK_MS = 7 * 24 * 3_600_000;

        /** A weekly event a week off, shown on global; then its row as home holds it when a date has just ended and no roll has run. */
        async function dateJustEnded(me: BeanPoolIdentity, title: string): Promise<{ home: HomeEvent; copyId: string; date: string }> {
            const end = new Date(Math.floor(Date.now() / 60_000) * 60_000);
            const start = new Date(end.getTime() - 2 * 3_600_000);
            const [nextStart, nextEnd] = [new Date(start.getTime() + WEEK_MS), new Date(end.getTime() + WEEK_MS)];
            const home = await eventAtHome(me, title, {
                eventStartAt: nextStart.toISOString(), eventEndAt: nextEnd.toISOString(),
                eventStartLocal: clock(nextStart), eventEndLocal: clock(nextEnd), eventTz: 'UTC',
                eventRepeat: repeatPatternFor('weekly', clock(nextStart).slice(0, 10)),
            });
            expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');
            await local.control('sql', {
                sql: 'UPDATE posts SET event_start_at = ?, event_end_at = ?, event_start_local = ?, event_end_local = ? WHERE id = ?',
                params: [start.toISOString(), end.toISOString(), clock(start), clock(end), home.id],
            });
            return { home, copyId: await copyIdOf(home.id, me), date: clock(start).slice(0, 10) };
        }

        it('a series with dates to come keeps its copy and its pair, and the same tend sends nothing', async () => {
            const me = await memberOfBoth('Ivo');
            const { home, copyId } = await dateJustEnded(me, 'Weekly bee');
            const stamp = (await copyRow(copyId)).updated_at;
            await tendCopies(me, deps());
            expect(await copyRow(copyId)).toMatchObject({ status: 'active', updated_at: stamp });
            expect((await pairOf(home.id, me.publicKey))?.copyId).toBe(copyId);
        }, START_MS);

        it('the same, with an end date still ahead of it', async () => {
            const me = await memberOfBoth('Una');
            const { home, copyId } = await dateJustEnded(me, 'Weekly bee, for now');
            await local.control('sql', { sql: 'UPDATE posts SET event_repeat_until = ? WHERE id = ?', params: [clock(new Date(Date.now() + 3 * WEEK_MS)).slice(0, 10), home.id] });
            await tendCopies(me, deps());
            expect((await copyRow(copyId)).status).toBe('active');
            expect((await pairOf(home.id, me.publicKey))?.copyId).toBe(copyId);
        }, START_MS);

        it('the series\' last date is the end of it: the copy comes down', async () => {
            const me = await memberOfBoth('Tove');
            const { home, copyId, date } = await dateJustEnded(me, 'Last of the bees');
            await local.control('sql', { sql: 'UPDATE posts SET event_repeat_until = ? WHERE id = ?', params: [date, home.id] });
            await tendCopies(me, deps());
            expect((await copyRow(copyId)).status).toBe('cancelled');
            expect(await pairOf(home.id, me.publicKey)).toBeNull();
        }, START_MS);

        it('a series cancelled at home comes down, whatever its date says', async () => {
            const me = await memberOfBoth('Sol');
            const { home, copyId } = await dateJustEnded(me, 'Called off');
            await local.control('sql', { sql: "UPDATE posts SET status = 'cancelled', event_state = 'cancelled', active = 0 WHERE id = ?", params: [home.id] });
            await tendCopies(me, deps());
            expect((await copyRow(copyId)).status).toBe('cancelled');
            expect(await pairOf(home.id, me.publicKey)).toBeNull();
        }, START_MS);

        it('a one-off that has ended comes down', async () => {
            const me = await memberOfBoth('Rae');
            const home = await eventAtHome(me, 'One night only');
            await showOnGlobal(home, local.url, me, deps());
            const id = await copyIdOf(home.id, me);
            await local.control('sql', { sql: 'UPDATE posts SET event_end_at = ? WHERE id = ?', params: [new Date(Date.now() - 20_000).toISOString(), home.id] });
            await tendCopies(me, deps());
            expect((await copyRow(id)).status).toBe('cancelled');
            expect(await pairOf(home.id, me.publicKey)).toBeNull();
        }, START_MS);
    });

    it('a copy nothing has changed is left alone, and sent again before retention would take it', async () => {
        const me = await memberOfBoth('Lee');
        const home = await eventAtHome(me, 'Far off');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const stamp = (await copyRow(id)).updated_at;
        await tendCopies(me, deps());
        expect((await copyRow(id)).updated_at).toBe(stamp);
        await tendCopies(me, deps(), Date.now() + COPY_KEEP_ALIVE_MS + 1000);
        expect((await copyRow(id)).updated_at > stamp).toBe(true);
    }, START_MS);

    it('a global that predates copies: nothing stays there with the member\'s name on it', async () => {
        const me = await memberOfBoth('Max');
        await global_.control('profileSwitch', { name: 'directoryMirror', value: 'false' });
        try {
            const home = await eventAtHome(me, 'Too early');
            const result = await showOnGlobal(home, local.url, me, deps());
            expect(result).toEqual({ refused: "The global community can't show this yet." });
            expect(await pairOf(home.id, me.publicKey)).toBeNull();
            const rows = await global_.control<Array<{ status: string }>>('sql', { sql: 'SELECT status FROM posts WHERE author_pubkey = ?', params: [me.publicKey], all: true });
            expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
        } finally {
            await global_.control('profileSwitch', { name: 'directoryMirror', value: 'true' });
        }
    }, START_MS);

    it('a phone on another key tends nothing of this one\'s', async () => {
        const me = await memberOfBoth('Oren');
        const other = await memberOfBoth('Pia');
        const home = await eventAtHome(me, 'Mine');
        await showOnGlobal(home, local.url, me, deps());
        const before = (await copyRow(await copyIdOf(home.id, me))).updated_at;
        await tendCopies(other, deps(), Date.now() + COPY_KEEP_ALIVE_MS + 1000);
        expect((await copyRow(await copyIdOf(home.id, me))).updated_at).toBe(before);
        expect(await pairOf(home.id, other.publicKey)).toBeNull();
    }, START_MS);
});

/** An Offer or a Need on the home community, as the app posts one: the member's answer. */
async function listingAtHome(me: BeanPoolIdentity, title: string, extra: Record<string, unknown> = {}): Promise<HomeEvent> {
    const res = await signedPost(local.url, '/api/marketplace/posts', {
        id: randomUUID(), type: 'offer', category: 'food', title, description: `About ${title}`, authorPublicKey: me.publicKey, credits: 20, ...PIN, photos: [PNG], ...extra,
    }, me);
    const answer = await res.json() as { post?: HomeEvent; error?: string };
    expect(answer.error, title).toBeUndefined();
    return answer.post!;
}

const liveCopies = async (me: BeanPoolIdentity) => (await global_.control<Array<Record<string, any>>>('sql', {
    sql: "SELECT * FROM posts WHERE author_pubkey = ? AND status = 'active' AND active = 1", params: [me.publicKey], all: true,
}));
const homeSql = (sql: string, params: unknown[]) => local.control('sql', { sql, params });

describe('an Offer or a Need shown on the global community (the phone against two real nodes)', () => {
    it('the tick: the same key, 0 Beans, the price as words, the rounded point, its photos; home hears nothing of it', async () => {
        const me = await memberOfBoth('Robin Offers');
        const home = await listingAtHome(me, 'Sourdough loaves', { credits: 20 });
        const asked = await local.control<string[]>('requests');
        const fromPhone = phoneToLocal.length;

        expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');

        const row = await copyRow(await copyIdOf(home.id, me));
        expect(row).toMatchObject({ author_pubkey: me.publicKey, type: 'offer', title: 'Sourdough loaves', credits: 0, price_type: 'fixed', shown_price: '20 fixed', status: 'active', photo_count: 1,
            shown_from_host: HOST, shown_from_post_id: home.id, reach: 'local', repeatable: 0 });
        expect(row.lat).toBe(roundToArea(PIN.lat));
        expect(row.lng).toBe(roundToArea(PIN.lng));
        expect(await hashes(global_, row.id)).toEqual(await hashes(local, home.id));
        expect(JSON.stringify(copyFields(home, me.publicKey))).not.toMatch(/153\.52219|credits/);

        // A visitor reads nobody, and the line is the directory's and the price's words.
        const read = await (await realFetch(`${global_.url}/api/marketplace/posts?id=${row.id}`)).json() as any[];
        expect(read[0]).toMatchObject({ authorPublicKey: 'hidden', shownCopy: true, shownFrom: { name: 'Mullumbimby', door: 'ask', host: HOST }, shownPrice: '20 fixed', credits: 0 });
        expect(copyPriceLine(eventCopyOf(read[0])!)).toBe("20 Beans in Mullumbimby · You can't buy or take this until Mullumbimby welcomes you.");

        // Home hears the phone and nobody else: its photos, and the one read a listing's tick needs (is it on the board?).
        const after = await local.control<string[]>('requests');
        expect(after.slice(asked.length)).toEqual(phoneToLocal.slice(fromPhone));
        const isPhoto = (r: string) => /^GET \/api\/marketplace\/posts\/[^/]+\/photos\//.test(r);
        expect(after.slice(asked.length).filter((r) => !isPhoto(r))).toEqual([`GET /api/marketplace/posts?id=${home.id}`]);
        expect(after.slice(asked.length).some(isPhoto)).toBe(true);
        expect(local.log()).not.toContain('BLOCKED-FETCH');
    }, START_MS);

    it('a Need, and a lendable Offer as an Offer: the price and its unit, and nothing of the loan', async () => {
        const me = await memberOfBoth('Noor Lends');
        const loan = await listingAtHome(me, 'Post-hole digger', { credits: 3, priceType: 'daily', lendable: true, lendMaxDays: 7, lendTerms: 'Ring 0400 000 000', replacementValue: '50 dollars' });
        expect((loan as { lendable?: boolean }).lendable).toBe(true);
        expect(await showOnGlobal(loan, local.url, me, deps())).toBe('shown');
        const copy = await copyRow(await copyIdOf(loan.id, me));
        expect(copy).toMatchObject({ shown_price: '3 daily', credits: 0, lend_terms: null, replacement_value: null });
        expect(copy.lendable ?? 0).toBe(0);
        const need = await listingAtHome(me, 'Help moving a piano', { type: 'need', credits: 5, priceType: 'hourly' });
        expect(await showOnGlobal(need, local.url, me, deps())).toBe('shown');
        const needCopy = await copyRow(await copyIdOf(need.id, me));
        expect(needCopy).toMatchObject({ type: 'need', shown_price: '5 hourly', credits: 0 });
        const read = await (await realFetch(`${global_.url}/api/marketplace/posts?id=${needCopy.id}`)).json() as any[];
        expect(copyPriceLine(eventCopyOf(read[0])!)).toBe("5 Beans an hour in Mullumbimby · You can't answer this until Mullumbimby welcomes you.");
    }, START_MS);

    it('an edit at home follows: its words, its price, and a tend then finds nothing owed', async () => {
        const me = await memberOfBoth('Tam Edits');
        const home = await listingAtHome(me, 'Rye loaves', { credits: 20, freeTags: ['wombat'] });
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        await editAtHome(me, home.id, { title: 'Rye loaves, fresh', category: 'tools', credits: 25, priceType: 'hourly', lat: -28.91234, lng: 153.11111, freeTags: [] });
        await tendCopies(me, deps());
        const row = await copyRow(id);
        expect(row).toMatchObject({ title: 'Rye loaves, fresh', category: 'tools', shown_price: '25 hourly', credits: 0, lat: -28.9, lng: 153.1 });
        expect(row.free_tags ?? '').not.toContain('wombat');
        await tendCopies(me, deps());
        expect((await copyRow(id)).updated_at).toBe(row.updated_at);
    }, START_MS);

    it('pause at home takes the copy down, and un-pause brings it back', async () => {
        const me = await memberOfBoth('Pia Pauses');
        const home = await listingAtHome(me, 'Lemons');
        await showOnGlobal(home, local.url, me, deps());
        const paused = await signedPost(local.url, '/api/marketplace/posts/pause', { postId: home.id, authorPublicKey: me.publicKey }, me);
        expect(paused.ok).toBe(true);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect((await pairOf(home.id, me.publicKey))?.resting).toBe(true);

        await signedPost(local.url, '/api/marketplace/posts/resume', { postId: home.id, authorPublicKey: me.publicKey }, me);
        await tendCopies(me, deps());
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Lemons']);
        expect((await pairOf(home.id, me.publicKey))?.resting).toBeFalsy();
    }, START_MS);

    it('hidden by reports at home takes the copy down, and a moderator\'s restore brings it back', async () => {
        const me = await memberOfBoth('Hana Hidden');
        const home = await listingAtHome(me, 'Eggs');
        await showOnGlobal(home, local.url, me, deps());
        await homeSql("UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [home.id]);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        await homeSql('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?', [home.id]);
        await tendCopies(me, deps());
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Eggs']);
    }, START_MS);

    it('in a deal at home it rests; the deal called off brings it back, and a finished one takes it down for good', async () => {
        const me = await memberOfBoth('Dana Deals');
        const home = await listingAtHome(me, 'Firewood');
        await showOnGlobal(home, local.url, me, deps());
        await homeSql("UPDATE posts SET status = 'pending' WHERE id = ?", [home.id]);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        await homeSql("UPDATE posts SET status = 'active' WHERE id = ?", [home.id]);
        await tendCopies(me, deps());
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Firewood']);
        await homeSql("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?", [home.id]);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('removed at home, here or in the web app: the copy goes and the pair with it', async () => {
        const me = await memberOfBoth('Remy Removes');
        const here = await listingAtHome(me, 'Honey');
        const there = await listingAtHome(me, 'Jam');
        await showOnGlobal(here, local.url, me, deps());
        await showOnGlobal(there, local.url, me, deps());
        expect(await stopShowing(here.id, me, deps())).toBe(true);
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Jam']);
        await signedPost(local.url, '/api/marketplace/posts/remove', { id: there.id, authorPublicKey: me.publicKey }, me);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await pairOf(there.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('a listing that is not the member\'s own, for everyone, with a place is never sent, whatever a screen asks', async () => {
        const me = await memberOfBoth('Gil Groups');
        const home = await listingAtHome(me, 'Plums');
        for (const home2 of [{ ...home, audienceScope: 'group' }, { ...home, audienceScope: 'direct' }, { ...home, authorPublicKey: 'an-enterprise' }, { ...home, lat: null }, { ...home, originNode: 'peer' }, { ...home, type: 'poll' }]) {
            expect(mayShowOnGlobal(home2 as HomeEvent, me.publicKey)).toBe(false);
            expect(await showOnGlobal(home2 as HomeEvent, local.url, me, deps())).toEqual({ refused: "The global community can't show this yet." });
        }
        expect(await liveCopies(me)).toEqual([]);
        expect(mayShowOnGlobal(home, me.publicKey)).toBe(true);
    }, START_MS);

    it('an unlisted community: no name, no door, the price in words, and the member told once', async () => {
        const me = await memberOfBoth('Una Unlisted');
        const home = await listingAtHome(me, 'Quiet valley honey');
        const result = await showOnGlobal(home, local.url, me, { ...deps(), hostOf: () => 'not-listed.example.org' });
        expect(result).toBe('shown-no-name');
        expect(copyResultLine(result)).toBe("Your community isn't in the directory, so this shows there without its name.");
        const id = await copyIdOf(home.id, me);
        expect(await copyRow(id)).toMatchObject({ shown_from_host: '', shown_from_post_id: null, shown_price: '20 fixed' });
        const read = await (await realFetch(`${global_.url}/api/marketplace/posts?id=${id}`)).json() as any[];
        expect(copyPriceLine(eventCopyOf(read[0])!)).toBe("20 Beans in another community · You can't buy or take this here.");
    }, START_MS);
});

/** Off the board at home and back, each as it happens there: what a rest and a return go through. */
const homeRests: Array<[string, (me: BeanPoolIdentity, home: HomeEvent) => Promise<unknown>, (me: BeanPoolIdentity, home: HomeEvent) => Promise<unknown>]> = [
    ['a pause and un-pause',
        (me, home) => signedPost(local.url, '/api/marketplace/posts/pause', { postId: home.id, authorPublicKey: me.publicKey }, me),
        (me, home) => signedPost(local.url, '/api/marketplace/posts/resume', { postId: home.id, authorPublicKey: me.publicKey }, me)],
    ['a deal called off',
        (_me, home) => homeSql("UPDATE posts SET status = 'pending' WHERE id = ?", [home.id]),
        (_me, home) => homeSql("UPDATE posts SET status = 'active' WHERE id = ?", [home.id])],
    ['a report hide restored',
        (_me, home) => homeSql("UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [home.id]),
        (_me, home) => homeSql('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?', [home.id])],
    ['a holiday ending',
        (me) => signedPost(local.url, '/api/members/holiday', { enabled: true }, me),
        (me) => signedPost(local.url, '/api/members/holiday', { enabled: false }, me)],
];

/** What Stop showing on the copy's own page does (ListingCopyDetail, then utils/db.ts deletePost): global by the copy's id, then the pair. */
async function stopFromCopysPage(me: BeanPoolIdentity, copyId: string): Promise<boolean> {
    expect((await signedPost(global_.url, '/api/marketplace/posts/remove', { id: copyId, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
    return stopShowing(copyId, me, deps());
}

const globalSql = (sql: string, params: unknown[]) => global_.control('sql', { sql, params });
const holdByReports = (copyId: string) => globalSql("UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [copyId]);

describe('a copy global\'s reports hold: a rest at home waits, so nothing comes back clean', () => {
    it.each(homeRests)('it stays held and no new copy is posted through %s', async (why, off, on) => {
        const me = await memberOfBoth(`Holly ${why}`);
        const home = await listingAtHome(me, 'Plums');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        await holdByReports(id);

        await off(me, home);
        await tendCopies(me, deps());
        await on(me, home);
        await tendCopies(me, deps());
        expect(await copyCount(me)).toBe(1);
        expect(await copyIdOf(home.id, me)).toBe(id);
    }, START_MS);

    it('a moderator\'s restore while the listing is off the board: the rest goes ahead and the copy comes back', async () => {
        const me = await memberOfBoth('Holly Restored');
        const home = await listingAtHome(me, 'Pears');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        await holdByReports(id);
        const [, off, on] = homeRests[0];
        await off(me, home);
        await tendCopies(me, deps());
        expect(await copyCount(me)).toBe(1);

        await globalSql('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?', [id]);
        await tendCopies(me, deps());
        await on(me, home);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toHaveLength(1);
        expect(await copyCount(me)).toBe(2);
    }, START_MS);

    it('a listing finished at home still takes a held copy down and ends the pair', async () => {
        const me = await memberOfBoth('Holly Finished');
        const home = await listingAtHome(me, 'Quinces');
        await showOnGlobal(home, local.url, me, deps());
        await holdByReports(await copyIdOf(home.id, me));
        await homeSql("UPDATE posts SET status = 'completed' WHERE id = ?", [home.id]);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);
});

describe('Stop showing from the copy\'s own page: all it knows is the copy\'s id', () => {
    it.each(homeRests)('the pair goes, the home row stops saying Shown, and nothing comes back through %s', async (why, off, on) => {
        const me = await memberOfBoth(`Stella ${why}`);
        const home = await listingAtHome(me, 'Cherries');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect(await liveCopies(me)).toHaveLength(1);

        expect(await stopFromCopysPage(me, id)).toBe(true);
        expect(await liveCopies(me)).toEqual([]);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();

        await off(me, home);
        await tendCopies(me, deps());
        await on(me, home);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('an event\'s copy, cancelled from its own page by the same door (EventDetail): the holiday\'s end brings nothing back', async () => {
        const me = await memberOfBoth('Evie Stops');
        const home = await eventAtHome(me, 'Barn dance');
        await showOnGlobal(home, local.url, me, deps());
        expect(await stopFromCopysPage(me, await copyIdOf(home.id, me))).toBe(true);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
        await signedPost(local.url, '/api/members/holiday', { enabled: true }, me);
        await tendCopies(me, deps());
        await signedPost(local.url, '/api/members/holiday', { enabled: false }, me);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
    }, START_MS);

    it('a page left open through a rest holds the id the copy had: its Stop showing still ends the pair, under the new id', async () => {
        const me = await memberOfBoth('Olive Stale');
        const home = await listingAtHome(me, 'Olives');
        await showOnGlobal(home, local.url, me, deps());
        const before = await copyIdOf(home.id, me);
        const [, off, on] = homeRests[0];
        await off(me, home);
        await tendCopies(me, deps());
        const resting = await pairOf(home.id, me.publicKey);
        expect(resting?.resting).toBe(true);
        expect(resting?.copyId).not.toBe(before);

        expect(await stopFromCopysPage(me, before)).toBe(true);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
        await on(me, home);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
    }, START_MS);

    it('global not answering the stop: it comes down at the next tend, and the pair still goes', async () => {
        const me = await memberOfBoth('Gale Offline');
        const home = await listingAtHome(me, 'Quinces');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        globalDown = true;
        expect(await stopShowing(id, me, deps())).toBe(false);
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
        globalDown = false;
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
        const [, off, on] = homeRests[0];
        await off(me, home);
        await tendCopies(me, deps());
        await on(me, home);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
    }, START_MS);

    it('someone else\'s phone holding that id ends nothing of this member\'s', async () => {
        const me = await memberOfBoth('Mo Mine');
        const other = await memberOfBoth('Ot Other');
        const home = await listingAtHome(me, 'Medlars');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect(await stopShowing(id, other, deps())).toBe(true);
        expect(await copyIdOf(home.id, me)).toBe(id);
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Medlars']);
    }, START_MS);

    it('a copy\'s id is no home event: what follows a home event never takes a copy for one', async () => {
        const me = await memberOfBoth('Theo Twice');
        const home = await listingAtHome(me, 'Walnuts');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect(await pairOf(id, me.publicKey)).toBeNull();
        const row = await copyRow(id);
        await repeatOnCopy({ ...home, id, title: 'Written over' }, me, deps());
        expect((await copyRow(id)).title).toBe(row.title);
    }, START_MS);

    it('taken down behind this phone (another phone, a moderator): the next rest ends the pair, and it stays down', async () => {
        const me = await memberOfBoth('Bea Elsewhere');
        const home = await listingAtHome(me, 'Chestnuts');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        expect((await signedPost(global_.url, '/api/marketplace/posts/remove', { id, authorPublicKey: me.publicKey }, me)).ok).toBe(true);
        const [, off, on] = homeRests[0];
        await off(me, home);
        await tendCopies(me, deps());
        expect(await pairOf(home.id, me.publicKey)).toBeNull();
        await on(me, home);
        await tendCopies(me, deps());
        expect(await liveCopies(me)).toEqual([]);
        expect(await copyCount(me)).toBe(1);
    }, START_MS);
});

describe('a listing off the board at home goes nowhere, whichever door asks (show-on-global itself, on its community\'s word)', () => {
    const OFF_THE_BOARD = homeRests.slice(0, 3);

    it.each(OFF_THE_BOARD)('at the start of %s: nothing is sent, the tick waits, and the listing\'s return sends it', async (why, off, on) => {
        const me = await memberOfBoth(`Rhea ${why}`);
        const home = await listingAtHome(me, 'Pears');
        await off(me, home);

        // What the screen holds may still read active: the phone's table has no hidden_by_reports_at, and it can be behind.
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('later');
        expect(await copyCount(me)).toBe(0);
        expect((await pairOf(home.id, me.publicKey))?.resting).toBe(true);

        await tendCopies(me, deps());
        expect(await copyCount(me)).toBe(0);

        await on(me, home);
        await tendCopies(me, deps());
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Pears']);
        expect((await pairOf(home.id, me.publicKey))?.resting).toBeFalsy();
    }, START_MS);

    it('a door holding a paused row is told the same, and Stop showing ends the wait', async () => {
        const me = await memberOfBoth('Pax Waits');
        const home = await listingAtHome(me, 'Plumcots');
        const [, off, on] = homeRests[0];
        await off(me, home);
        expect(await showOnGlobal({ ...home, status: 'paused' }, local.url, me, deps())).toBe('later');
        expect(await stopShowing(home.id, me, deps())).toBe(true);
        await on(me, home);
        await tendCopies(me, deps());
        expect(await copyCount(me)).toBe(0);
    }, START_MS);

    it('a pair already held, its listing now off the board: the copy comes down, and the pair rests under a new id', async () => {
        const me = await memberOfBoth('Kit Kept');
        const home = await listingAtHome(me, 'Figs');
        await showOnGlobal(home, local.url, me, deps());
        const id = await copyIdOf(home.id, me);
        const [, off] = homeRests[0];
        await off(me, home);
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('later');
        expect(await liveCopies(me)).toEqual([]);
        const pair = await pairOf(home.id, me.publicKey);
        expect(pair?.resting).toBe(true);
        expect(pair?.copyId).not.toBe(id);
    }, START_MS);

    it('home not answering: nothing goes on the phone\'s word alone; the tick waits, and home\'s word decides', async () => {
        const me = await memberOfBoth('Hal Waits');
        const home = await listingAtHome(me, 'Nectarines');
        homeHidesListings = true;
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('later');
        expect(await copyCount(me)).toBe(0);
        expect((await pairOf(home.id, me.publicKey))?.resting).toBeFalsy();
        homeHidesListings = false;
        await tendCopies(me, deps());
        expect((await liveCopies(me)).map((r) => r.title)).toEqual(['Nectarines']);
    }, START_MS);

    it('gone or finished at home, though the screen still shows it: refused, and no pair is left to come back', async () => {
        const me = await memberOfBoth('Finn Finished');
        const gone = await listingAtHome(me, 'Damsons');
        await signedPost(local.url, '/api/marketplace/posts/remove', { id: gone.id, authorPublicKey: me.publicKey }, me);
        expect(await showOnGlobal(gone, local.url, me, deps())).toEqual({ refused: "The global community can't show this yet." });
        const done = await listingAtHome(me, 'Sloes');
        await homeSql("UPDATE posts SET status = 'completed', active = 0 WHERE id = ?", [done.id]);
        expect(await showOnGlobal(done, local.url, me, deps())).toEqual({ refused: "The global community can't show this yet." });
        // These two still read back from home, so it is what the row says that refuses them, not an empty answer.
        const finished = await listingAtHome(me, 'Bullaces');
        await homeSql("UPDATE posts SET status = 'completed' WHERE id = ?", [finished.id]);
        expect(await showOnGlobal(finished, local.url, me, deps())).toEqual({ refused: "The global community can't show this yet." });
        const unpinned = await listingAtHome(me, 'Cobnuts');
        await homeSql('UPDATE posts SET lat = NULL, lng = NULL WHERE id = ?', [unpinned.id]);
        expect(await showOnGlobal(unpinned, local.url, me, deps())).toEqual({ refused: "The global community can't show this yet." });
        expect(await copyCount(me)).toBe(0);
        for (const home of [gone, done, finished, unpinned]) expect(await pairOf(home.id, me.publicKey)).toBeNull();
    }, START_MS);

    it('an event is not asked about (the control): its tick reads nothing of home', async () => {
        const me = await memberOfBoth('Eve Control');
        const home = await eventAtHome(me, 'Harvest supper');
        const fromPhone = phoneToLocal.length;
        expect(await showOnGlobal(home, local.url, me, deps())).toBe('shown');
        expect(phoneToLocal.slice(fromPhone).every((r) => /^GET \/api\/marketplace\/posts\/[^/]+\/photos\//.test(r))).toBe(true);
    }, START_MS);
});
