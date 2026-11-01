/**
 * "Also show this on the global community", end to end (slice G2′, utils/show-on-global.ts): the phone's own code against two
 * REAL nodes on this machine, apps/server/src/phone-door-test-harness.ts, one the global profile and one a community with
 * Beans on, as utils/__tests__/bring-listings-e2e.test.ts runs them.
 *
 *   The copy lands on global by the same key, its point the rounded home point, with no typed place and no note, and its photo
 *   as home holds it. Global's from-line is the directory's; an unlisted host is dropped and the member told. An edit, a
 *   time change, a cancelled date and a cancel repeat. Global down, it all waits, and a phone back comes into step, a cancel
 *   included. A lost answer posts nothing twice. A global that predates copies keeps nothing with the member's name on.
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

import { repeatPatternFor, roundToArea } from '@beanpool/core';
import { draftIdentity, type BeanPoolIdentity } from '../identity';
import { signedDelete, signedGet, signedPost } from '../node-post';
import { fetchedPostPhoto } from '../post-photo';
import { COPY_KEEP_ALIVE_MS, copyFields, copyResultLine, homeHostOf, pairOf, repeatOnCopy, showOnGlobal, stopShowing, tendCopies, type CopyDeps, type HomeEvent } from '../show-on-global';

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
