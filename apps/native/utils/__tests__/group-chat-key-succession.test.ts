/**
 * Group chats: a member who changes phones keeps their name on their old lines (DESIGN-group-chat-line-display-fable.md
 * §4, §5, §7; review of #1788, NB2 and "Owed when §5 lands"), against a REAL node on this machine
 * (apps/server/src/phone-door-test-harness.ts: the real HTTPS server, signature middleware, group, key and re-key routes),
 * started from the packages' sources and killed by its PID. Each phone is its own identity and key store and runs the
 * phone's own code (group-chat-keys.ts, group-chat-lines.ts, group-line-display.ts, key-succession.ts):
 *
 *   a re-keyed member's old lines read "A former member" until their new key's statement is served, then their name, with
 *   the earlier-key details; a chain signed by anyone but the member's current key (the old key, the node, another member)
 *   is refused, and so is a node serving a member's row with someone else's old key; the two-hop chain; and NB2: once a
 *   member of an epoch re-keys, another member tops up a spoiled slot again.
 *
 *   Review of #1826 (finding 1; the director's option 2): a chain proves the new key's claim, not the old key's owner,
 *   and the node's members answer can leave the honest claimant out, so NO epoch is ever handed through a former key.
 *   A member who changes phones keeps their name on their old lines; the group's history from before the change does
 *   not follow them to the new phone. The reviewers' cases A, A2, A3, B, C, E, F, R1, R2, J, V and A3w are ported here:
 *   in each, nobody is handed anything.
 *
 * Nothing else is contacted: the phones' fetch is held to this node's address, and the node's own fetch refuses every
 * host but this machine.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wrapGroupKey, keySuccessionCanonical } from '@beanpool/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

(globalThis as any).__DEV__ = false;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
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

import { signedGet, signedPost, signedDelete } from '../node-post';
import { groupKeyring, memoryGroupKeyStore, forgetGroupKeys, joinGroupWithEpoch, type GroupKeyStore } from '../group-chat-keys';
import { sendSealedGroupLine, openGroupThread, chatIsLocked } from '../group-chat-lines';
import { GROUP_LINE_FORMER_MEMBER, earlierKeyDetails, type DisplayRosterRow } from '../group-line-display';
import { attestJustCompletedRekey, attestOwnRekeys, postKeySuccession, rekeyToAsk, rekeysToMe, unattestedRekeys, keySuccessionPromptText, KEY_SUCCESSION_PROMPT_YES, KEY_SUCCESSION_PROMPT_NO } from '../key-succession';
import { makeKeySuccession } from '../group-chat-crypto';
import type { BeanPoolIdentity } from '../identity';

const SERVER_DIR = fileURLToPath(new URL('../../../server/', import.meta.url).href);
const START_MS = 120_000;

let node: ChildProcessWithoutNullStreams;
let dataDir: string;
let URL_BASE = '';
const replies = new Map<number, (r: { result?: any; error?: string }) => void>();
let nextId = 1;
const realFetch = globalThis.fetch;
const sent: { method: string; path: string; status: number }[] = [];
const elsewhere: string[] = [];
/** The node made dishonest in the fetch layer: a hook answers instead of the node (the phone can't tell the difference). */
type Hook = (r: { method: string; path: string; input: any; init: any }) => Promise<Response | undefined> | Response | undefined;
const hooks: Hook[] = [];

function control<T = any>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        replies.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)));
        node.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
}

interface Phone { name: string; identity: BeanPoolIdentity; store: GroupKeyStore }
function phone(name: string, seed = randomBytes(32)): Phone {
    const identity: BeanPoolIdentity = {
        publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(seed), callsign: name, createdAt: new Date().toISOString(),
    };
    return { name, identity, store: memoryGroupKeyStore() };
}

async function json(res: Response): Promise<any> {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${body?.error ?? ''}`), { status: res.status, body });
    return body;
}
const getChat = async (p: Phone, g: string) => json(await signedGet(URL_BASE, `/api/groups/${g}/chat?limit=100`, p.identity));
const roster = async (p: Phone, g: string): Promise<DisplayRosterRow[]> =>
    (await json(await signedGet(URL_BASE, `/api/groups/${g}/members`, p.identity))).map((m: any) => ({ memberPubkey: m.memberPubkey, callsign: m.callsign, formerKeys: m.formerKeys }));
const ring = (p: Phone, g: string) => groupKeyring(URL_BASE, p.identity, g, p.store);
const say = (p: Phone, g: string, text: string, extra: Record<string, unknown> = {}) =>
    sendSealedGroupLine(URL_BASE, p.identity, p.store, { groupId: g, text, clientId: randomUUID(), ...extra });

/** What a phone shows of a group's chat: each sealed line as the display rule names it, in order. */
async function shown(p: Phone, g: string, rosterOverride?: DisplayRosterRow[], nodeNameOf?: (pk: string) => string | null) {
    const answer = await getChat(p, g);
    expect(chatIsLocked(answer)).toBe(true);
    const opened = await openGroupThread(ring(p, g), answer, rosterOverride ?? await roster(p, g), nodeNameOf);
    const lines = (answer.messages as any[]).filter((m) => opened.views.has(m.id)).map((m) => ({ id: m.id as string, ...opened.views.get(m.id)! }));
    return { answer, opened, lines, visible: lines.filter((l) => !l.hidden) };
}

beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'group-chat-succession-'));
    node = spawn(process.execPath, ['--import', 'tsx', 'src/phone-door-test-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, PHONE_DOOR_PROFILE: 'community', TSX_TSCONFIG_PATH: 'tsconfig.phone-door-test-harness.json' },
        stdio: 'pipe',
    });
    let out = '';
    let log = '';
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the test node did not start in time:\n${log.slice(-3000)}`)), START_MS - 5_000);
        node.stdout.on('data', (chunk: Buffer) => {
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
        node.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
        node.on('exit', (code) => reject(new Error(`the test node exited (${code}):\n${log.slice(-3000)}`)));
    });
    URL_BASE = `https://127.0.0.1:${port}`;
    globalThis.fetch = (async (input: any, init?: any) => {
        const href = String(input instanceof Request ? input.url : input);
        if (!href.startsWith(`${URL_BASE}/`)) {
            elsewhere.push(href);
            throw new TypeError(`Network request failed: the phone contacted ${href}`);
        }
        const u = new URL(href);
        for (const h of [...hooks]) {
            const r = await h({ method: String(init?.method ?? 'GET'), path: u.pathname, input, init });
            if (r) return r;
        }
        const res = await realFetch(input, init);
        sent.push({ method: String(init?.method ?? 'GET'), path: new URL(href).pathname, status: res.status });
        return res;
    }) as typeof fetch;
}, START_MS);

afterAll(async () => {
    globalThis.fetch = realFetch;
    if (node && node.exitCode === null) {
        node.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { node.kill('SIGKILL'); resolve(); }, 5_000);
            node.on('exit', () => { clearTimeout(timer); resolve(); });
        });
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    expect(elsewhere).toEqual([]);
}, START_MS);
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ana = phone('Ana');
const ben = phone('Ben');
const cat = phone('Cat');
const mal = phone('Mal');

async function newGroup(owner: Phone, name: string): Promise<string> {
    return (await json(await signedPost(URL_BASE, '/api/groups', { name, joinPolicy: 'open' }, owner.identity))).id;
}
const join_ = (p: Phone, g: string) => joinGroupWithEpoch(URL_BASE, p.identity, p.store, { id: g, joinPolicy: 'open' });
/** The admin's re-key on the node (the harness's `rekey`: issueRekeyCode + completeRekey); the new phone starts empty. */
async function rekeyed(old: Phone, name: string): Promise<Phone> {
    const next = phone(name);
    await control('rekey', { oldKey: old.identity.publicKey, newKey: next.identity.publicKey });
    return next;
}
const nameOf = (v: Awaited<ReturnType<typeof shown>>, text: string) => v.visible.find((l) => l.text === text)?.name;
const pk = (p: Phone) => p.identity.publicKey;
const AT = '2026-10-03T04:00:00.000Z';
/** A statement `by` signs that `oldPub` was its key before it: a claim, which proves only that `by` makes it. */
const claim = (by: Phone, oldPub: string, at = AT) => {
    const s = makeKeySuccession({ newEdPrivHex: by.identity.privateKey, oldPubHex: oldPub, at });
    return { pubkey: s.pubkey, at: s.at, sig: s.sig };
};
/** The node serves other formerKeys on some rows of GET …/members, and may list one row first. */
function membersHook(g: string, extra: Record<string, unknown[]>, first?: string): Hook {
    return async (r) => {
        if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
        const rows = await (await realFetch(r.input, r.init)).json();
        let out = rows.map((m: any) => (extra[m.memberPubkey] ? { ...m, formerKeys: extra[m.memberPubkey] } : m));
        if (first) out = [...out.filter((m: any) => m.memberPubkey === first), ...out.filter((m: any) => m.memberPubkey !== first)];
        return jsonResponse(200, out);
    };
}
/** The epochs the node holds a wrap of for `p`. */
const wrapsTo = async (g: string, p: Phone) => (await control<any[]>('sql', { sql: 'SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ? ORDER BY epoch', params: [g, pk(p)], all: true })).map((w) => w.epoch as number);
/** The puppet: a member the node put in the group with no epoch, listed as missing every epoch from 1. */
async function puppetIn(g: string, p: Phone) {
    await control('groupRows', { groupId: g, keys: [pk(p)] });
    await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(p)] });
}
/** The lines a phone can read, as "name: words". */
const reads = async (p: Phone, g: string) => (await shown(p, g)).visible.filter((l) => !l.waitingKey && !l.unverified).map((l) => `${l.name}: ${l.text}`);
/** One line from `p`, after its phone has read the roster the screen shows (so a stale record rotates first, rule 2). */
async function writes(p: Phone, g: string, text: string) {
    forgetGroupKeys();
    ring(p, g).noteShownRoster((await roster(p, g)).map((r) => r.memberPubkey));
    await say(p, g, text);
}

describe('a member who changes phones keeps their name on their old lines', () => {
    it('setup: node members', async () => {
        await control('limiters');
        await control('members', { members: [ana, ben, cat, mal].map((p) => ({ key: p.identity.publicKey, callsign: p.name })) });
    });

    it('NB2 + §7 4: before the statement, a re-keyed member\'s old line is "A former member" and nobody tops up their slot; after it, their name, and others\' slots repaired; her new key gets no old epoch', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Changed phones');
        await say(ana, g, 'first');
        await join_(ben, g);
        await join_(cat, g);
        await say(cat, g, 'Cat on her old phone');
        // The node spoils Ben's wrap for epoch 3 (Cat's join); Ben's phone refuses it, as in #1788's repair case.
        const [ep] = await control<any[]>('sql', { sql: 'SELECT created_by FROM group_key_epochs WHERE group_id = ? AND epoch = 3', params: [g], all: true });
        const junk = wrapGroupKey(new Uint8Array(randomBytes(32)), { groupId: g, epoch: 3, recipientPubHex: ben.identity.publicKey, wrapperPubHex: ep.created_by });
        await control('sql', { sql: 'UPDATE group_key_wraps SET eph_pub = ?, nonce = ?, wrapped = ? WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ? AND sig IS NULL', params: [junk.ephPub, junk.nonce, junk.wrapped, g, ben.identity.publicKey] });
        const benFresh: Phone = { ...ben, store: memoryGroupKeyStore() };
        expect(nameOf(await shown(benFresh, g), 'Cat on her old phone')).toBeUndefined();

        const cat2 = await rekeyed(cat, 'Cat');
        forgetGroupKeys();
        // Before Cat₂ signs: her old line names nobody, and decision (a) holds: no top-up to Ben (the record's wraps lack
        // Cat₁ now) or to Cat₂ (in no record).
        expect(nameOf(await shown(ana, g), 'Cat on her old phone')).toBe(GROUP_LINE_FORMER_MEMBER);
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await control<any[]>('sql', { sql: 'SELECT epoch FROM group_key_wraps WHERE group_id = ? AND recipient_pubkey = ?', params: [g, cat2.identity.publicKey], all: true })).toEqual([]);

        // Cat₂ confirms, as her new phone does right after its own re-key.
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        forgetGroupKeys();
        const v = await shown(ana, g);
        const line = v.visible.find((l) => l.text === 'Cat on her old phone');
        expect(line?.name).toBe('Cat');
        const [inv] = await control<any[]>('sql', { sql: 'SELECT succession_at FROM invalidated_keys WHERE public_key = ?', params: [cat.identity.publicKey], all: true });
        expect(line?.details).toBe(earlierKeyDetails('Cat', inv.succession_at));
        // NB2: Ana now tops up Ben's spoiled slot (epoch 3's wraps lack Cat₁; her verified chain completes them to the
        // signed set). Cat₂ is handed nothing: no epoch goes through a former key (review of #1826, finding 1; option 2).
        expect(await ring(ana, g).serveMissing()).toBe(1);
        expect(await wrapsTo(g, cat2)).toEqual([]);
        // Ana writes: the roster has Cat₂ and the current record Cat₁, so her phone rotates first. Still nothing old to Cat₂.
        await writes(ana, g, 'Ana after the re-key');
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await wrapsTo(g, cat2)).toEqual([4]);
        forgetGroupKeys();
        expect(nameOf(await shown(benFresh, g), 'Cat on her old phone')).toBe('Cat');
        // On Cat₂'s new phone: what is said from her next epoch, and her old line waits for a key it won't be handed.
        const cat2Sees = await shown(cat2, g);
        expect(cat2Sees.visible.filter((l) => !l.waitingKey).map((l) => `${l.name}: ${l.text}`)).toEqual(['Ana: Ana after the re-key']);
        expect(cat2Sees.visible.filter((l) => l.waitingKey).length).toBeGreaterThanOrEqual(1);
    });

    it('§7 5: the pin attack — a node serving someone else\'s old key on a member\'s row is refused, however it is signed', async () => {
        await control('limiters');
        forgetGroupKeys();
        const g = await newGroup(ana, 'Pin attack');
        await join_(mal, g);
        await say(mal, g, 'Mal says this');
        const mal2 = await rekeyed(mal, 'Mal');
        // Mal is a node member under his new key, but has left this group: his old line is his, not anyone's in the roster.
        await control('sql', { sql: "UPDATE group_members SET status = 'removed' WHERE group_id = ? AND member_pubkey = ?", params: [g, mal2.identity.publicKey] });
        await control('groupRows', { groupId: g, keys: [] });
        const at = '2026-10-03T04:00:00.000Z';
        const sign = (seedHex: string, newPub: string) => Buffer.from(ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(mal.identity.publicKey, newPub, at))), Buffer.from(seedHex, 'hex'))).toString('base64');
        const forged = [
            sign(mal.identity.privateKey, ana.identity.publicKey),   // (i) signed by that old key itself
            sign(randomBytes(32).toString('hex'), ana.identity.publicKey), // (ii) by a key of the node owner's
            Buffer.from(ed25519.sign(sha256(utf8ToBytes(keySuccessionCanonical(ben.identity.publicKey, ana.identity.publicKey, at))), Buffer.from(ana.identity.privateKey, 'hex'))).toString('base64'), // (iii) Ana over another old key
        ];
        for (const sig of forged) {
            hooks.push(async (r) => {
                if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
                const rows = await (await realFetch(r.input, r.init)).json();
                return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === ana.identity.publicKey ? { ...m, formerKeys: [{ pubkey: mal.identity.publicKey, at, sig }] } : m)));
            });
            forgetGroupKeys();
            const name = nameOf(await shown(ana, g), 'Mal says this');
            hooks.pop();
            expect(name).not.toBe('Ana');
            expect(name).toBe(GROUP_LINE_FORMER_MEMBER);
        }
    });

    it('§7 6: two re-keys, Ana₁ → Ana₂ → Ana₃: her first line is hers once both are confirmed; the middle one missing breaks it', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana1 = phone('Ana');
        await control('members', { members: [{ key: ana1.identity.publicKey, callsign: 'Anaa' }] });
        const g = await newGroup(ben, 'Two re-keys');
        await join_(ana1, g);
        await say(ana1, g, 'from her first phone');
        const ana2 = await rekeyed(ana1, 'Anaa');
        expect(await attestJustCompletedRekey(URL_BASE, ana2.identity)).toBe(1);
        const ana3 = await rekeyed(ana2, 'Anaa');
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'from her first phone')).toBe(GROUP_LINE_FORMER_MEMBER);
        expect(await attestJustCompletedRekey(URL_BASE, ana3.identity)).toBe(1);
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'from her first phone')).toBe('Anaa');
        // A node that drops the middle statement: the chain is broken, and the line names nobody.
        hooks.push(async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === ana3.identity.publicKey ? { ...m, formerKeys: m.formerKeys.slice(1) } : m)));
        });
        forgetGroupKeys();
        const broken = nameOf(await shown(ben, g), 'from her first phone');
        hooks.pop();
        expect(broken).toBe(GROUP_LINE_FORMER_MEMBER);
    });

    it('§7 7: an admin-path re-key reads "A former member" until the phone confirms at sign-in; "Not me" signs nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const dee = phone('Dee');
        await control('members', { members: [{ key: dee.identity.publicKey, callsign: 'Dee' }] });
        const g = await newGroup(ben, 'Admin path');
        await join_(dee, g);
        await say(dee, g, 'Dee before the re-key');
        const dee2 = await rekeyed(dee, 'Dee');
        const pending = await unattestedRekeys(URL_BASE, dee2.identity);
        expect(pending.map((r) => r.pubkey)).toEqual([dee.identity.publicKey]);
        expect(keySuccessionPromptText(pending[0].at)).toMatch(/^This account was re-keyed on \d{1,2} [A-Z][a-z]{2} \d{4}\. Confirm it was you, and the messages you sent before then will show under your name again\.$/);
        expect([KEY_SUCCESSION_PROMPT_YES, KEY_SUCCESSION_PROMPT_NO]).toEqual(['Yes, that was me', 'Not me']);
        // "Not me": nothing is sent, and the line still names nobody.
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'Dee before the re-key')).toBe(GROUP_LINE_FORMER_MEMBER);
        // "Yes, that was me", to the one date the prompt shows.
        const ask = await rekeyToAsk(URL_BASE, dee2.identity);
        expect(ask?.pubkey).toBe(dee.identity.publicKey);
        expect(await attestOwnRekeys(URL_BASE, dee2.identity, [ask!])).toBe(1);
        expect(await unattestedRekeys(URL_BASE, dee2.identity)).toEqual([]);
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'Dee before the re-key')).toBe('Dee');
        // Asked again (a second sign-in): the node keeps the first; nothing changes.
        expect(await postKeySuccession(URL_BASE, dee2.identity, dee.identity.publicKey, '2026-10-05T00:00:00.000Z')).toBe('already');
    });

    it('§8 + review of #1826 NB5: a node listing a second old key for a brand-new key gets no statement when the re-key completes, and no prompt', async () => {
        await control('limiters');
        forgetGroupKeys();
        const eve = phone('Eve');
        const zed = phone('Zed');
        await control('members', { members: [{ key: eve.identity.publicKey, callsign: 'Eve' }, { key: zed.identity.publicKey, callsign: 'Zed' }] });
        const g = await newGroup(ben, 'Second old key');
        await join_(zed, g);
        await say(zed, g, 'Zed wrote this');
        const eve2 = await rekeyed(eve, 'Eve');
        // The dishonest part: Zed's key listed as also re-keyed to Eve's new key.
        await control('sql', { sql: `INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to) VALUES (?, 'rekeyed', '2026-01-01T00:00:00.000Z', ?)`, params: [zed.identity.publicKey, eve2.identity.publicKey] });
        expect((await unattestedRekeys(URL_BASE, eve2.identity)).map((r) => r.pubkey).sort()).toEqual([eve.identity.publicKey, zed.identity.publicKey].sort());
        expect(await attestJustCompletedRekey(URL_BASE, eve2.identity)).toBe(0);
        expect(await control<any[]>('sql', { sql: 'SELECT public_key FROM invalidated_keys WHERE rekeyed_to = ? AND succession_sig IS NOT NULL', params: [eve2.identity.publicKey], all: true })).toEqual([]);
        // More than one re-key listed, attested or not: an honest node lists one, so the member isn't asked at all.
        expect(await rekeyToAsk(URL_BASE, eve2.identity)).toBeNull();
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'Zed wrote this')).toBe('Zed');
    });
});

describe('review of #1826: nobody is handed an old epoch through a former key, and whose name goes on an old line', () => {
    it('A: a puppet whose served chain claims a CURRENT member\'s key is handed nothing, and reads nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaX'); const ben = phone('BenX'); const pup = phone('PupX');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'A group');
        await say(ana, g, 'A1 ana, epoch 1, before the puppet');
        await join_(ben, g);
        await say(ben, g, 'A2 ben, before the puppet');
        await say(ana, g, 'A3 ana, before the puppet');
        await puppetIn(g, pup);
        // Control: no chain served. Decision (a): nothing goes to the puppet.
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0);
        // The node serves the puppet's row with a statement the puppet signed over Ben's key. Ben never re-keyed.
        hooks.push(membersHook(g, { [pk(pup)]: [claim(pup, pk(ben))] }));
        forgetGroupKeys();
        const byAna = await ring(ana, g).serveMissing();
        forgetGroupKeys();
        const byBen = await ring(ben, g).serveMissing();
        hooks.pop();
        expect(byAna + byBen).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('A2: a chain claiming the serving phone\'s OWN key is handed nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaA2'); const ben = phone('BenA2'); const pup = phone('PupA2');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'A2 group');
        await say(ana, g, 'A2-1 ana alone, epoch 1');
        await join_(ben, g);
        await say(ana, g, 'A2-2 ana, epoch 2');
        await puppetIn(g, pup);
        hooks.push(membersHook(g, { [pk(pup)]: [claim(pup, pk(ana))] }));
        forgetGroupKeys();
        const byAna = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(byAna).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('A3: as A, with the node leaving Ben out of the members answer while it serves the puppet\'s chain: nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaA3'); const ben = phone('BenA3'); const pup = phone('PupA3');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'A3 group');
        await say(ana, g, 'A3-1 ana, epoch 1');
        await join_(ben, g);
        await say(ben, g, 'A3-2 ben, before the puppet');
        await say(ana, g, 'A3-3 ana, before the puppet');
        await puppetIn(g, pup);
        hooks.push(async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.filter((m: any) => m.memberPubkey !== pk(ben))
                .map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(ben))] } : m)));
        });
        forgetGroupKeys();
        const byAna = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(byAna).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('F: a chain that does not verify (signed the wrong way round) is handed nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaF'); const ben = phone('BenF'); const pup = phone('PupF');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'F group');
        await say(ana, g, 'F1');
        await join_(ben, g);
        await say(ben, g, 'F2');
        await puppetIn(g, pup);
        const byOld = claim(ben, pk(pup)); // Ben's key signing "the puppet's key was mine": the wrong direction
        hooks.push(membersHook(g, { [pk(pup)]: [{ pubkey: pk(ben), at: AT, sig: byOld.sig }] }));
        forgetGroupKeys();
        const byAna = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(byAna).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
    });

    it('G: a re-keyed member\'s new key is handed no old epoch: not by a forged chain, not by a verified one, whatever the record\'s wraps', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaG'); const ben = phone('BenG'); const cat = phone('CatG');
        await control('members', { members: [ana, ben, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'G group');
        await say(ana, g, 'G1 ana');
        await join_(ben, g);
        await join_(cat, g);
        await say(cat, g, 'G2 cat on her old phone');
        const cat2 = await rekeyed(cat, 'CatG'); // the admin's re-key: no statement yet
        // Ana writes: her phone rotates, and her new record (epoch 4) lacks Cat₁ (what the own-record rule went by).
        await writes(ana, g, 'G3 ana after the re-key');
        const [made] = await control<any[]>('sql', { sql: 'SELECT MAX(epoch) AS epoch FROM group_key_epochs WHERE group_id = ? AND created_by = ?', params: [g, pk(ana)], all: true });
        expect(made.epoch).toBe(4);
        // The node serves Cat₂'s row with a statement that doesn't verify (Cat₁'s key signing for Cat₂: the wrong way round).
        const wrongWay = claim(cat, pk(cat2));
        hooks.push(membersHook(g, { [pk(cat2)]: [{ pubkey: pk(cat), at: AT, sig: wrongWay.sig }] }));
        forgetGroupKeys();
        const forged = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(forged).toBe(0);
        expect(await wrapsTo(g, cat2)).toEqual([4]);
        // Cat₂ confirms. The node also hides Ben's wrap of epoch 3 from the record's own set: nothing goes.
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await control('sql', { sql: "UPDATE group_key_wraps SET sig = 'hidden' WHERE group_id = ? AND epoch = 3 AND recipient_pubkey = ? AND sig IS NULL", params: [g, pk(ben)] });
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await wrapsTo(g, cat2)).toEqual([4]);
        // The wraps as the record made them and her verified chain served: still nothing to Cat₂. Her old line is hers on
        // Ana's screen, and her new phone reads from epoch 4.
        await control('sql', { sql: "UPDATE group_key_wraps SET sig = NULL WHERE group_id = ? AND epoch = 3 AND sig = 'hidden'", params: [g] });
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await wrapsTo(g, cat2)).toEqual([4]);
        forgetGroupKeys();
        expect(nameOf(await shown(ana, g), 'G2 cat on her old phone')).toBe('CatG');
        forgetGroupKeys();
        expect(await reads({ ...cat2, store: memoryGroupKeyStore() }, g)).toEqual(['AnaG: G3 ana after the re-key']);
    });

    it('B: two shown members both carry a verified chain to one old key: neither is named, and neither is handed its epochs', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('BenB'); const cat = phone('CatB'); const pup = phone('PupB');
        await control('members', { members: [ben, cat, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'B group');
        await join_(cat, g);
        await say(cat, g, 'B1 cat on her old phone');
        const [{ epoch: catsEpoch }] = await control<any[]>('sql', { sql: 'SELECT MAX(epoch) AS epoch FROM group_key_epochs WHERE group_id = ?', params: [g], all: true });
        const cat2 = await rekeyed(cat, 'CatB');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        // Ben writes after the re-key, so his newest record lacks Cat₁ (what the own-record rule went by).
        await writes(ben, g, 'B2 ben after the re-key');
        await puppetIn(g, pup);
        const pupClaim = claim(pup, pk(cat));
        for (const first of [pk(pup), pk(cat2)]) {
            hooks.push(membersHook(g, { [pk(pup)]: [pupClaim] }, first));
            forgetGroupKeys();
            expect(nameOf(await shown(ben, g), 'B1 cat on her old phone')).toBe(GROUP_LINE_FORMER_MEMBER);
            hooks.pop();
        }
        hooks.push(membersHook(g, { [pk(pup)]: [pupClaim] }, pk(pup)));
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0);
        hooks.pop();
        expect(await wrapsTo(g, pup)).toEqual([]);
        expect(await wrapsTo(g, cat2)).not.toContain(catsEpoch);
        // §8's accepted limit, for comparison: a node that drops Cat₂'s chain and serves only the puppet's names the line
        // after the puppet. A name only: the puppet is handed nothing (R1).
        hooks.push(async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            return jsonResponse(200, rows.map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [pupClaim] } : m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [] } : m)));
        });
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'B1 cat on her old phone')).toBe('PupB');
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0);
        hooks.pop();
        expect(await wrapsTo(g, pup)).toEqual([]);
        // The node honest again (only Cat₂'s chain): her name is back on her line, and Cat₂ is handed nothing old either.
        forgetGroupKeys();
        expect(nameOf(await shown(ben, g), 'B1 cat on her old phone')).toBe('CatB');
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0);
        expect(await wrapsTo(g, cat2)).not.toContain(catsEpoch);
        expect(await wrapsTo(g, pup)).toEqual([]);
    });

    it('C: a node listing a CURRENT member\'s key as also re-keyed to a new key: no prompt, and a statement over that key gets nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('BenC'); const zed = phone('ZedC'); const eve = phone('EveC');
        await control('members', { members: [ben, zed, eve].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'C group');
        await join_(zed, g);
        await say(zed, g, 'C1 zed, before eve was here');
        const eve2 = await rekeyed(eve, 'EveC'); // the admin's re-key: unattested
        // The dishonest node: Zed's (current) key listed as also re-keyed to Eve₂, stamped NEWER than Eve's own re-key.
        const newer = new Date(Date.now() + 60_000).toISOString();
        await control('sql', { sql: `INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to) VALUES (?, 'rekeyed', ?, ?)`, params: [pk(zed), newer, pk(eve2)] });
        expect((await rekeysToMe(URL_BASE, eve2.identity)).length).toBe(2);
        expect(await rekeyToAsk(URL_BASE, eve2.identity)).toBeNull();
        expect(await attestOwnRekeys(URL_BASE, eve2.identity)).toBe(0);
        // Even if Eve₂'s key did sign over Zed's (an older app, or §8's one misled moment), Zed is a shown member under
        // that key: it is nobody's former key, so nothing of Zed's goes to Eve₂.
        expect(await postKeySuccession(URL_BASE, eve2.identity, pk(zed), newer)).toBe('stored');
        await join_(eve2, g);
        await control('sql', { sql: 'UPDATE group_members SET from_epoch = 1 WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(eve2)] });
        await writes(ben, g, 'C2 ben, after eve joined');
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0);
        forgetGroupKeys();
        const eveReads = await reads({ ...eve2, store: memoryGroupKeyStore() }, g);
        expect(eveReads.some((t) => t.includes('C1 zed'))).toBe(false);
    });

    it('E: the honest re-key: Cat₂ is handed none of her old epochs, by anyone, before or after a rotation; her name stays on her old line', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaE'); const ben = phone('BenE'); const cat = phone('CatE');
        await control('members', { members: [ana, ben, cat].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'E group');
        await say(ana, g, 'E1 first');
        await join_(ben, g);
        await join_(cat, g);
        await say(cat, g, 'E2 Cat on her old phone');
        const cat2 = await rekeyed(cat, 'CatE');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        expect(await wrapsTo(g, cat2)).toEqual([]);
        await writes(ben, g, 'E3 after the re-key');
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        forgetGroupKeys();
        expect(await ring(ben, g).serveMissing()).toBe(0); // Ben's newest record lacks Cat₁: still nothing (option 2)
        expect(await wrapsTo(g, cat2)).toEqual([4]);
        forgetGroupKeys();
        expect(await reads({ ...cat2, store: memoryGroupKeyStore() }, g)).toEqual(['BenE: E3 after the re-key']);
        forgetGroupKeys();
        expect(nameOf(await shown(ana, g), 'E2 Cat on her old phone')).toBe('CatE');
    });
});

describe('review of #1826, confirmation 1: what the own-record rule left open is closed (option 2: no hand-off through a former key)', () => {
    /** A members-answer hook that applies `edit` to the rows. */
    const doctor = (g: string, edit: (rows: any[]) => any[]): Hook => async (r) => {
        if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
        return jsonResponse(200, edit(await (await realFetch(r.input, r.init)).json()));
    };
    const rosterLabels = async (p: Phone, g: string) => (await roster(p, g)).map((r) => `${r.callsign}${r.formerKeys?.length ? `(+${r.formerKeys.length} former)` : ''}`);

    it('R1: after a re-key and one honest rotation, a puppet claiming the re-keyed member\'s OLD key is handed nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('BenR1'); const cat = phone('CatR1'); const pup = phone('PupR1');
        await control('members', { members: [ben, cat, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'R1 group');
        await join_(cat, g);
        await say(cat, g, 'R1-a cat on her old phone');
        await say(ben, g, 'R1-b ben, before the re-key');
        const cat2 = await rekeyed(cat, 'CatR1');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await writes(ben, g, 'R1-c ben, after the re-key'); // the honest rotation: Ben's newest record names Cat₂, not Cat₁
        await puppetIn(g, pup);
        // The node drops Cat₂'s chain and serves the puppet's claim over Cat₁.
        hooks.push(doctor(g, (rows) => rows.map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(cat))] } : m.memberPubkey === pk(cat2) ? { ...m, formerKeys: [] } : m))));
        forgetGroupKeys();
        const handed = await ring(ben, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('R2: as R1, with Cat₂ left out of the one members read inside serveMissing: nothing, and Ben\'s screen is the same before and after', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ben = phone('BenR2'); const cat = phone('CatR2'); const pup = phone('PupR2');
        await control('members', { members: [ben, cat, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ben, 'R2 group');
        await join_(cat, g);
        await say(cat, g, 'R2-a cat on her old phone');
        const cat2 = await rekeyed(cat, 'CatR2');
        expect(await attestJustCompletedRekey(URL_BASE, cat2.identity)).toBe(1);
        await writes(ben, g, 'R2-b ben, after the re-key');
        await puppetIn(g, pup);
        forgetGroupKeys();
        const before = { catsOldLine: nameOf(await shown(ben, g), 'R2-a cat on her old phone'), roster: await rosterLabels(ben, g) };
        expect(before).toEqual({ catsOldLine: 'CatR2', roster: ['BenR2', 'CatR2(+1 former)', 'PupR2'] });
        hooks.push(doctor(g, (rows) => rows.filter((m: any) => m.memberPubkey !== pk(cat2)).map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(cat))] } : m))));
        const handed = await ring(ben, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect({ catsOldLine: nameOf(await shown(ben, g), 'R2-a cat on her old phone'), roster: await rosterLabels(ben, g) }).toEqual(before);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('J: a member who left and rejoined, left out of one members answer while a puppet claims his key: nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaJ'); const ben = phone('BenJ'); const pup = phone('PupJ');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'J group');
        await join_(ben, g);
        await say(ben, g, 'J1 ben, before he left');
        await say(ana, g, 'J2 ana, while ben was in');
        expect((await signedDelete(URL_BASE, `/api/groups/${g}/members/${pk(ben)}`, ben.identity)).status).toBe(200);
        await writes(ana, g, 'J3 ana, after ben left'); // Ana's phone rotates without Ben
        forgetGroupKeys();
        await join_(ben, g); // Ben rejoins: his own join epoch
        await say(ben, g, 'J4 ben, back in the group');
        const status = await control<any[]>('sql', { sql: 'SELECT status FROM group_members WHERE group_id = ? AND member_pubkey = ?', params: [g, pk(ben)], all: true });
        expect(status.map((s) => s.status)).toEqual(['active']);
        await puppetIn(g, pup);
        // Control: Ben shown, the puppet claiming his current key.
        hooks.push(membersHook(g, { [pk(pup)]: [claim(pup, pk(ben))] }));
        forgetGroupKeys();
        expect(await ring(ana, g).serveMissing()).toBe(0);
        hooks.pop();
        // The node leaves Ben out of the one answer.
        hooks.push(doctor(g, (rows) => rows.filter((m: any) => m.memberPubkey !== pk(ben)).map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(ben))] } : m))));
        forgetGroupKeys();
        const handed = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('V: a member the node cut from the KEYS roster only while another wrote, then restored, claimed by a puppet: nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaV'); const ben = phone('BenV'); const pup = phone('PupV');
        await control('members', { members: [ana, ben, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'V group');
        await join_(ben, g);
        await say(ben, g, 'V1 ben');
        await say(ana, g, 'V2 ana');
        // The cut: Ben 'removed' in the node's tables (its keys roster drops him) while Ana's members screen shows him active.
        await control('sql', { sql: "UPDATE group_members SET status = 'removed' WHERE group_id = ? AND member_pubkey = ?", params: [g, pk(ben)] });
        await control('groupRows', { groupId: g, keys: [] }).catch(() => null);
        hooks.push(async (r) => {
            if (r.method !== 'GET' || r.path !== `/api/groups/${g}/members`) return undefined;
            const rows = await (await realFetch(r.input, r.init)).json();
            const has = rows.some((m: any) => m.memberPubkey === pk(ben));
            return jsonResponse(200, has ? rows.map((m: any) => (m.memberPubkey === pk(ben) ? { ...m, status: 'active' } : m)) : [...rows, { memberPubkey: pk(ben), callsign: 'BenV', status: 'active', role: 'member', formerKeys: [] }]);
        });
        await writes(ana, g, 'V3 ana, while the node cut ben from the keys roster');
        expect((await roster(ana, g)).map((r) => r.callsign)).toContain('BenV');
        hooks.pop();
        await control('sql', { sql: "UPDATE group_members SET status = 'active' WHERE group_id = ? AND member_pubkey = ?", params: [g, pk(ben)] });
        await control('groupRows', { groupId: g, keys: [] }).catch(() => null);
        await puppetIn(g, pup);
        hooks.push(doctor(g, (rows) => rows.filter((m: any) => m.memberPubkey !== pk(ben)).map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(ben))] } : m))));
        forgetGroupKeys();
        const handed = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });

    it('A3w: as A3, but the serving phone has written since Ben joined (its newest record names Ben): nothing', async () => {
        await control('limiters');
        forgetGroupKeys();
        const ana = phone('AnaW'); const ben = phone('BenW'); const cat = phone('CatW'); const pup = phone('PupW');
        await control('members', { members: [ana, ben, cat, pup].map((p) => ({ key: pk(p), callsign: p.name })) });
        const g = await newGroup(ana, 'A3w group');
        await say(ana, g, 'W1 ana, epoch 1');
        await join_(ben, g);
        await say(ben, g, 'W2 ben, before the puppet');
        await control('groupRows', { groupId: g, keys: [pk(cat)] }); // a member let in without a rotation (an old app's join)
        await writes(ana, g, 'W3 ana: her phone rotates, and her new record names Ben');
        const epochs = await control<any[]>('sql', { sql: 'SELECT epoch, created_by FROM group_key_epochs WHERE group_id = ? ORDER BY epoch', params: [g], all: true });
        expect(epochs.map((e) => `${e.epoch}:${e.created_by === pk(ana) ? 'Ana' : e.created_by === pk(ben) ? 'Ben' : '?'}`)).toEqual(['1:Ana', '2:Ben', '3:Ana']);
        await puppetIn(g, pup);
        hooks.push(doctor(g, (rows) => rows.filter((m: any) => m.memberPubkey !== pk(ben)).map((m: any) => (m.memberPubkey === pk(pup) ? { ...m, formerKeys: [claim(pup, pk(ben))] } : m))));
        forgetGroupKeys();
        const handed = await ring(ana, g).serveMissing();
        hooks.pop();
        expect(handed).toBe(0);
        expect(await wrapsTo(g, pup)).toEqual([]);
        forgetGroupKeys();
        expect(await reads(pup, g)).toEqual([]);
    });
});
