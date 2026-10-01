/**
 * The app checks a notice's signature before it acts on it (scratch/global-node/DESIGN-push-relay-fable.md §4.3, push
 * design step 4; utils/push-pins.ts, utils/push-notice-check.ts).
 *
 * The communities here are fakes that do what the server does (apps/server engine/push-notices.ts, routes/notices.ts,
 * routes/community.ts `POST /api/push-tokens`): they sign each notice with node:crypto over @beanpool/core's bytes for
 * one recipient, answer a registration with `pushKey`, and answer `GET /api/notices/push/<id>` to that recipient only,
 * checking the request's signature with core and noble (server-signature-check.ts), never the app's code. Nothing here
 * contacts a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nodeCrypto from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const mem = vi.hoisted(() => ({ async: new Map<string, string>(), secure: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => mem.secure.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => { mem.secure.set(key, value); }),
    deleteItemAsync: vi.fn(async (key: string) => { mem.secure.delete(key); }),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('../db', () => ({ clearDB: vi.fn(async () => {}), closeDB: vi.fn(async () => {}) }));
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    isPushNoticeKind, PUSH_NOTICE_LIFETIME_SECONDS, PUSH_NOTICE_TITLE, pushCommunityTag, pushNoticeBytes, pushNoticeWords,
    type PushNoticeKind,
} from '@beanpool/core';
import { registerPushTokenWithCommunity } from '../push-registrations';
import { readPushPins } from '../push-pins';
import {
    checkWhileOpen, droppedNoticeCounts, followTap, FORGED_NOTICE_LINE, LOCAL_NOTICE_DATA, noticeRoute,
    onNoticeWarning, takeNoticeWarning, UNSIGNED_NOTICE_WORDS, type IncomingNotice, type NoticeRoute,
} from '../push-notice-check';
import {
    PUSH_NOTICE_WARNING_INSET, PUSH_NOTICE_WARNING_OK, PUSH_NOTICE_WARNING_TEXT_ON, PUSH_NOTICE_WARNING_TOUCH_TARGETS,
    pushNoticeWarningStyleSpec,
} from '../push-notice-warning-style';
import { PUSH_REGISTERED_AT_STORE_KEY, SAVED_NODES_STORE_KEY, vaultPushTokenStoreKey } from '../storage-keys';
import { lightColors, darkColors, earthColors, slateColors } from '../../constants/colors';
import { boundSignatureValid } from './server-signature-check';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.example.net';
const OLDTOWN = 'https://oldtown.example.org';
const ANCHOR = 'beanpool_anchor_url';
const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';
const POST_ID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';
const CHAT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

type Account = { publicKey: string; privateKey: string };

function account(): Account {
    const seed = nodeCrypto.randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed.toString('hex') };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The DER header of a PKCS#8 Ed25519 private key (apps/server engine/push-notices.ts). */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Signs as the server does: node:crypto, the node key's seed, over core's bytes for one recipient. */
function serverSign(seed: Buffer, fields: { c: string; k: string; i: string; t: number }, recipient: string): string {
    const key = nodeCrypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    return nodeCrypto.sign(null, pushNoticeBytes(fields as Parameters<typeof pushNoticeBytes>[0], recipient), key).toString('hex');
}

interface Details { recipient: string; kind: string; title: string; body: string; data: Record<string, unknown>; sentAt: number }

/** One community's server, as far as notices go. `signs: false` is a server from before signed notices. */
class Community {
    readonly pushKey: string;
    readonly tag: string;
    details = new Map<string, Details>();
    /** `seed`: the node key's (a take-over carries it to the promoted server). */
    constructor(readonly url: string, readonly signs = true, readonly seed: Buffer = nodeCrypto.randomBytes(32)) {
        this.pushKey = bytesToHex(ed25519.getPublicKey(this.seed));
        this.tag = pushCommunityTag(this.pushKey);
    }

    /** A notice for `recipient`, its details kept here, as dispatchPushNotification does. */
    notice(kind: PushNoticeKind, recipient: string, details: Partial<Omit<Details, 'recipient' | 'kind'>> = {}, opts: { t?: number } = {}) {
        const i = nodeCrypto.randomBytes(16).toString('hex');
        const t = opts.t ?? nowSeconds();
        this.details.set(i, { recipient, kind, title: 'Maya sent you a message', body: 'hello', data: {}, sentAt: t, ...details });
        const fields = { c: this.tag, k: kind, i, t };
        return { bp: 1, ...fields, s: serverSign(this.seed, fields, recipient) };
    }
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }

let communities: Map<string, Community>;
let sent: Sent[];
let down: Set<string>;

function serve(): void {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const req: Sent = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') };
        sent.push(req);
        if (down.has(url.origin)) throw new TypeError('Network request failed');
        const c = communities.get(url.origin);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        if (!c) return json(404, { error: 'Not found' });
        if (url.pathname === '/api/push-tokens' && req.method === 'POST') {
            const { publicKey } = JSON.parse(req.body);
            if (!boundSignatureValid(req, publicKey)) return json(403, { error: 'Invalid cryptographic signature' });
            return json(200, c.signs ? { success: true, pushKey: c.pushKey } : { success: true });
        }
        const one = /^\/api\/notices\/push\/([0-9a-f]{32})$/.exec(url.pathname);
        if (one && req.method === 'GET') {
            const signer = req.headers['X-Public-Key'];
            if (!signer || !boundSignatureValid(req, signer)) return json(401, { error: 'A signed request is required' });
            const d = c.details.get(one[1]);
            if (!d || d.recipient !== signer) return json(404, { code: 'no_notice' });
            return json(200, { id: one[1], kind: d.kind, title: d.title, body: d.body, data: d.data, sentAt: d.sentAt });
        }
        return json(404, { error: 'Not found' });
    });
}

/** The phone keeps these communities (its saved list), set to the first. */
function keep(...urls: string[]): void {
    mem.async.set(ANCHOR, urls[0]);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(urls.map((url) => ({ url, alias: new URL(url).hostname }))));
}

const saved = () => JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) ?? '[]') as Array<Record<string, unknown>>;

/** A push as the phone's push service delivers it, with its kind's fixed words unless told otherwise. */
function push(data: unknown, words?: { title: string; body: string }): IncomingNotice {
    const k = (data as { k?: unknown })?.k;
    const fixed = words ?? (isPushNoticeKind(k) ? pushNoticeWords(k) : { title: 'BeanPool', body: 'Open BeanPool' });
    return { identifier: nodeCrypto.randomUUID(), remote: true, title: fixed.title, body: fixed.body, data };
}

let kim: Account;
let lee: Account;
let mullum: Community;
let byron: Community;
let navigated: NoticeRoute[];
const navigate = (route: NoticeRoute) => { navigated.push(route); };
const tap = (n: IncomingNotice) => followTap(n, { storage: AsyncStorage, account: kim }, navigate);
const open = (n: IncomingNotice) => checkWhileOpen(n, { storage: AsyncStorage, recipient: kim.publicKey });

/** Kim registered at each community, as the app does at start, so each answered with its key (or none). */
async function registerAt(...urls: string[]): Promise<void> {
    for (const url of urls) {
        expect(await registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 12000, AsyncStorage, url)).toBe(true);
    }
}

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kim = account();
    lee = account();
    mullum = new Community(MULLUM);
    byron = new Community(BYRON);
    communities = new Map([[MULLUM, mullum], [BYRON, byron]]);
    sent = [];
    down = new Set();
    navigated = [];
    serve();
    takeNoticeWarning();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ── 1. The pin ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('the key a community signs with is pinned from the answer to its own registration', () => {
    it('kept on the community\'s saved record, beside what the record already held', async () => {
        keep(MULLUM, BYRON);
        await registerAt(MULLUM);

        const record = saved().find((n) => n.url === MULLUM)!;
        expect(record.pushKey).toBe(mullum.pushKey);
        expect(record.alias).toBe('mullum.beanpool.org');
        expect(saved().find((n) => n.url === BYRON)!.pushKey).toBeUndefined();
        const pins = await readPushPins(AsyncStorage);
        expect(pins.pinned).toEqual([{ community: MULLUM, pushKey: mullum.pushKey, tag: mullum.tag }]);
    });

    it('the community the phone is set to gets a record if it had none yet', async () => {
        mem.async.set(ANCHOR, `${MULLUM}/`);
        await registerAt(MULLUM);
        expect(saved()).toEqual([expect.objectContaining({ url: `${MULLUM}/`, pushKey: mullum.pushKey })]);
    });

    it('survives a take-over: the promoted server keeps the node key, its answer names the same one, and its notices verify', async () => {
        keep(MULLUM);
        await registerAt(MULLUM);
        // The standby takes over at the same address with the same node key (the take-over bundle carries it).
        const promoted = new Community(MULLUM, true, mullum.seed);
        communities.set(MULLUM, promoted);
        await registerAt(MULLUM);
        expect(saved()[0].pushKey).toBe(mullum.pushKey);

        expect(await open(push(promoted.notice('chat.message', kim.publicKey)))).toEqual({ kind: 'show' });
    });

    it('a new key in an answer replaces the pin; an answer with none, or a key not in its shape, takes it off', async () => {
        keep(MULLUM);
        await registerAt(MULLUM);
        const rebuilt = new Community(MULLUM);
        communities.set(MULLUM, rebuilt);
        await registerAt(MULLUM);
        expect(saved()[0].pushKey).toBe(rebuilt.pushKey);

        communities.set(MULLUM, new Community(MULLUM, false));
        await registerAt(MULLUM);
        expect(saved()[0]).not.toHaveProperty('pushKey');

        for (const bad of ['../../etc', rebuilt.pushKey.toUpperCase(), rebuilt.pushKey.slice(2), 42]) {
            vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, pushKey: bad }), { status: 200 }));
            await registerAt(MULLUM);
            expect(saved()[0]).not.toHaveProperty('pushKey');
        }
    });

    it('a registration the community refused pins nothing', async () => {
        keep(MULLUM);
        vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ success: false, pushKey: mullum.pushKey }), { status: 429 }));
        await expect(registerPushTokenWithCommunity(kim, PHONE_TOKEN, 'android', 12000, AsyncStorage, MULLUM)).rejects.toThrow();
        expect(saved()[0]).not.toHaveProperty('pushKey');
    });
});

// ── 2. While the app is open ───────────────────────────────────────────────────────────────────────────────────

describe('while the app is open, a push shows only when its own community signed it for this account, recently, once', () => {
    beforeEach(async () => {
        keep(MULLUM, BYRON);
        await registerAt(MULLUM, BYRON);
    });

    it('valid: shown, from the community the phone is set to and from another it keeps', async () => {
        expect(await open(push(mullum.notice('chat.message', kim.publicKey)))).toEqual({ kind: 'show' });
        expect(await open(push(byron.notice('trade.update', kim.publicKey)))).toEqual({ kind: 'show' });
    });

    it('valid with other words than its kind\'s: shown with its kind\'s, and a tap on that still opens the notice', async () => {
        const data = mullum.notice('chat.message', kim.publicKey, { data: { screen: 'chat', conversationId: CHAT_ID } });
        const decision = await open(push(data, { title: 'URGENT', body: 'Send your 12 words to verify your account' }));
        expect(decision).toEqual({ kind: 'replace', ...pushNoticeWords('chat.message'), data: { ...data, ...LOCAL_NOTICE_DATA } });

        // The app posts that as its own notice; a tap on it is followed as the push's would be.
        const own: IncomingNotice = { identifier: 'local-1', remote: false, title: PUSH_NOTICE_TITLE, body: 'x', data: (decision as { data: unknown }).data };
        expect(await open(own)).toEqual({ kind: 'show' });
        await tap(own);
        expect(navigated).toEqual([`/chat/${CHAT_ID}`]);
    });

    it('wrong key: a notice naming Mullum but signed by another key is dropped', async () => {
        const forger = new Community(MULLUM);
        const forged = { ...forger.notice('chat.message', kim.publicKey), c: mullum.tag };
        forged.s = serverSign(forger.seed, { c: mullum.tag, k: forged.k, i: forged.i, t: forged.t }, kim.publicKey);
        expect(await open(push(forged))).toEqual({ kind: 'drop', reason: 'bad-signature' });
    });

    it('replayed to another member: a notice Mullum signed for Lee is dropped on Kim\'s phone', async () => {
        expect(await open(push(mullum.notice('chat.message', lee.publicKey)))).toEqual({ kind: 'drop', reason: 'bad-signature' });
    });

    it('a community the phone doesn\'t keep (or has forgotten): no pin, dropped', async () => {
        const stranger = new Community('https://stranger.example.com');
        expect(await open(push(stranger.notice('chat.message', kim.publicKey)))).toEqual({ kind: 'drop', reason: 'other-community' });

        // Forget Byron (Forget Community takes its saved record, and the pin with it).
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(saved().filter((n) => n.url !== BYRON)));
        expect(await open(push(byron.notice('chat.message', kim.publicKey)))).toEqual({ kind: 'drop', reason: 'other-community' });
    });

    it('too old: past the notice\'s lifetime it is dropped; inside it, shown', async () => {
        const old = mullum.notice('chat.message', kim.publicKey, {}, { t: nowSeconds() - PUSH_NOTICE_LIFETIME_SECONDS - 60 });
        expect(await open(push(old))).toEqual({ kind: 'drop', reason: 'too-old' });
        const days = mullum.notice('chat.message', kim.publicKey, {}, { t: nowSeconds() - 3 * 24 * 3600 });
        expect(await open(push(days))).toEqual({ kind: 'show' });
        const ahead = mullum.notice('chat.message', kim.publicKey, {}, { t: nowSeconds() + 3600 });
        expect(await open(push(ahead))).toEqual({ kind: 'drop', reason: 'from-the-future' });
    });

    it('repeated: the same notice again is dropped, as is a copy that arrives with its time sent as text', async () => {
        const data = mullum.notice('chat.message', kim.publicKey);
        expect(await open(push(data))).toEqual({ kind: 'show' });
        expect(await open(push(data))).toEqual({ kind: 'drop', reason: 'repeated' });
        expect(await open(push({ ...data, t: String(data.t) }))).toEqual({ kind: 'drop', reason: 'repeated' });
    });

    it('a time sent as text is read as the number it spells (the signed bytes are the same)', async () => {
        const data = mullum.notice('chat.message', kim.publicKey);
        expect(await open(push({ ...data, t: String(data.t), bp: '1' }))).toEqual({ kind: 'show' });
    });

    it('every drop is counted', async () => {
        const before = droppedNoticeCounts()['bad-signature'] ?? 0;
        await open(push(mullum.notice('chat.message', lee.publicKey)));
        expect(droppedNoticeCounts()['bad-signature']).toBe(before + 1);
    });

    it('no account on the phone: nothing is anyone\'s, dropped', async () => {
        expect(await checkWhileOpen(push(mullum.notice('chat.message', kim.publicKey)), { storage: AsyncStorage, recipient: null }))
            .toEqual({ kind: 'drop', reason: 'no-account' });
    });

    it('the app\'s own notices show as they are', async () => {
        expect(await open({ identifier: 'l', remote: false, title: 'Post hidden', body: 'Your post was hidden', data: { ...LOCAL_NOTICE_DATA } }))
            .toEqual({ kind: 'show' });
    });

    it('an unsigned push, once every community the phone sent its token to has pinned a key: dropped', async () => {
        expect(await open(push({ screen: 'chat', conversationId: CHAT_ID }, { title: 'Maya', body: 'Your account is locked: tap to unlock' })))
            .toEqual({ kind: 'drop', reason: 'unsigned' });
        // Stripping the signature off a forgery doesn't get it through either.
        const stripped: Record<string, unknown> = { ...mullum.notice('chat.message', lee.publicKey) };
        delete stripped.s;
        expect(await open(push(stripped))).toEqual({ kind: 'drop', reason: 'unsigned' });
    });
});

// ── 3. On a tap ────────────────────────────────────────────────────────────────────────────────────────────────

describe('a tap is followed only for a valid notice; anything else goes nowhere and shows the calm line once', () => {
    beforeEach(async () => {
        keep(MULLUM, BYRON);
        await registerAt(MULLUM, BYRON);
        sent = [];
    });

    const detailRequests = () => sent.filter((s) => new URL(s.url).pathname.startsWith('/api/notices/push/'));

    it('valid: the community is asked, signed by Kim, where it lands, and the app goes there', async () => {
        const data = mullum.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: MULLUM, id: data.i, active: true });
        expect(navigated).toEqual([`/post/${POST_ID}`]);
        expect(detailRequests()).toHaveLength(1);
        expect(detailRequests()[0].url).toBe(`${MULLUM}/api/notices/push/${data.i}`);
        expect(boundSignatureValid(detailRequests()[0], kim.publicKey)).toBe(true);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('valid, and the community can\'t say where (down, or it forgot the notice): the tab for its kind', async () => {
        down.add(MULLUM);
        await tap(push(mullum.notice('chat.message', kim.publicKey, { data: { screen: 'chat', conversationId: CHAT_ID } })));
        down.clear();
        const forgotten = mullum.notice('trade.update', kim.publicKey);
        mullum.details.clear();
        await tap(push(forgotten));
        expect(navigated).toEqual(['/(tabs)/chats', '/(tabs)']);
    });

    it('wrong key, replayed to another member, a community the phone doesn\'t keep: no request, no navigation, the line once each', async () => {
        const forger = new Community(MULLUM);
        const forged = forger.notice('chat.message', kim.publicKey);
        const cases = [
            { ...forged, c: mullum.tag, s: serverSign(forger.seed, { c: mullum.tag, k: forged.k, i: forged.i, t: forged.t }, kim.publicKey) },
            mullum.notice('chat.message', lee.publicKey, { data: { screen: 'post', postId: POST_ID } }),
            new Community('https://stranger.example.com').notice('chat.message', kim.publicKey),
        ];
        let warnings = 0;
        const off = onNoticeWarning(() => { warnings++; });
        for (const data of cases) {
            expect((await tap(push(data))).kind).toBe('warn');
            expect(takeNoticeWarning()).toBe(true);
            expect(takeNoticeWarning()).toBe(false);
        }
        off();
        expect(warnings).toBe(3);
        expect(navigated).toEqual([]);
        expect(detailRequests()).toEqual([]);
    });

    it('too old, but signed by its community for Kim: no navigation, and no warning (it isn\'t a forgery)', async () => {
        const old = mullum.notice('chat.message', kim.publicKey, { data: { screen: 'post', postId: POST_ID } }, { t: nowSeconds() - PUSH_NOTICE_LIFETIME_SECONDS - 60 });
        expect(await tap(push(old))).toEqual({ kind: 'nothing', reason: 'too-old' });
        expect(navigated).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('repeated: a notice is followed once, however often its tap comes back (the launch tap, a replay)', async () => {
        const data = mullum.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        await tap(push(data));
        expect(await tap(push(data))).toEqual({ kind: 'nothing', reason: 'repeated' });
        expect(navigated).toEqual([`/post/${POST_ID}`]);
    });

    it('shown while open, then tapped: still followed (shown and opened are noted apart)', async () => {
        const data = mullum.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        expect(await open(push(data))).toEqual({ kind: 'show' });
        await tap(push(data));
        expect(navigated).toEqual([`/post/${POST_ID}`]);
    });

    it('valid, from a community the phone keeps but isn\'t set to: nothing opened, no request, no warning', async () => {
        const data = byron.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: BYRON, active: false });
        expect(navigated).toEqual([]);
        expect(detailRequests()).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('an unsigned push, with every registered community pinned: the warning, and nowhere', async () => {
        expect((await tap(push({ kind: 'recovery_started', screen: 'settings' }))).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
        expect(navigated).toEqual([]);
    });

    it('the key vault\'s notice opens Settings on a phone that gave the vault its token, and is an unsigned push on any other', async () => {
        const vault = push({ type: 'vault-hold' }, { title: 'Someone is getting back into your BeanPool account', body: '…' });
        expect((await tap(vault)).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
        expect(await open(vault)).toEqual({ kind: 'drop', reason: 'unsigned' });

        mem.async.set(vaultPushTokenStoreKey(kim.publicKey), PHONE_TOKEN);
        const again = push({ type: 'vault-hold' }, { title: 'Someone is getting back into your BeanPool account', body: '…' });
        expect(await open(again)).toEqual({ kind: 'show' });
        expect(await tap(again)).toEqual({ kind: 'settings' });
        expect(navigated).toEqual(['/(tabs)/settings']);
    });

    it('the app\'s own notices open the app where it was, and never warn', async () => {
        expect(await tap({ identifier: 'l', remote: false, title: 'x', body: 'y', data: { ...LOCAL_NOTICE_DATA } })).toEqual({ kind: 'nothing', reason: 'local' });
        expect(navigated).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a push dressed as the app\'s own (its data copied) is still a push: the warning', async () => {
        expect((await tap(push({ ...LOCAL_NOTICE_DATA }))).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
    });
});

// ── 4. No string from a push reaches a route ───────────────────────────────────────────────────────────────────

describe('no string from a push, nor a forged target from an answer, reaches the router', () => {
    const FORGED = [
        '../(tabs)/settings', `${POST_ID}/../../settings`, `${POST_ID}?admin=1`, `${POST_ID}#x`, ' ' + POST_ID, `${POST_ID}\n`,
        '%2e%2e%2fsettings', 'https://evil.example/phish', '//evil.example', `${POST_ID}x`, POST_ID.replace(/-/g, ''),
    ];

    beforeEach(async () => {
        keep(MULLUM);
        await registerAt(MULLUM);
    });

    it('noticeRoute takes a post or chat id only in the node\'s own shape; anything else lands on the kind\'s tab', () => {
        for (const bad of [...FORGED, 42, null, ['a'], { a: 1 }]) {
            expect(noticeRoute('market.request', { screen: 'post', postId: bad })).toBe('/(tabs)');
            expect(noticeRoute('chat.message', { screen: 'chat', conversationId: bad })).toBe('/(tabs)/chats');
        }
        expect(noticeRoute('market.request', { screen: 'post', postId: POST_ID })).toBe(`/post/${POST_ID}`);
        expect(noticeRoute('chat.group', { screen: 'chat', conversationId: CHAT_ID, groupId: CHAT_ID })).toBe(`/chat/${CHAT_ID}`);
        expect(noticeRoute('account.recovery-started', { screen: 'settings', kind: 'recovery_started' })).toBe('/(tabs)/settings');
        expect(noticeRoute('owner.standby', null)).toBe('/(tabs)/settings');
        expect(noticeRoute('community.notice', { screen: 'nowhere' })).toBe('/(tabs)');
    });

    it('a valid notice whose community answers a forged target lands on its kind\'s tab, the target nowhere in the route', async () => {
        for (const bad of FORGED) {
            await tap(push(mullum.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: bad } })));
            await tap(push(mullum.notice('chat.message', kim.publicKey, { data: { screen: 'chat', conversationId: bad } })));
        }
        expect(new Set(navigated)).toEqual(new Set(['/(tabs)', '/(tabs)/chats']));
    });

    it('what a push itself carries (screen, postId, conversationId, url) is never read, signed or not', async () => {
        const signed = { ...mullum.notice('market.request', kim.publicKey), screen: 'post', postId: '../(tabs)/settings', url: 'https://evil.example' };
        await tap(push(signed));
        expect(navigated).toEqual(['/(tabs)']);

        // An old-style push with its own target: the warning (every registered community signs), and no route at all.
        navigated = [];
        await tap(push({ screen: 'post', postId: POST_ID }));
        await tap(push({ screen: 'chat', conversationId: CHAT_ID }));
        expect(navigated).toEqual([]);
    });

    it('an answer for another notice id is not taken: the kind\'s tab', async () => {
        const data = mullum.notice('market.request', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ id: 'f'.repeat(32), data: { screen: 'post', postId: POST_ID } }), { status: 200 }));
        await tap(push(data));
        expect(navigated).toEqual(['/(tabs)']);
    });
});

// ── 5. A community from before signed notices ──────────────────────────────────────────────────────────────────

describe('a community whose server sends no pushKey: its pushes show with fixed words, and a tap goes nowhere', () => {
    let oldtown: Community;

    beforeEach(async () => {
        oldtown = new Community(OLDTOWN, false);
        communities.set(OLDTOWN, oldtown);
        keep(OLDTOWN, MULLUM);
        await registerAt(OLDTOWN, MULLUM);
        sent = [];
    });

    it('no pin, and the phone knows it sent that community its token', async () => {
        const pins = await readPushPins(AsyncStorage);
        expect(pins.pinned.map((p) => p.community)).toEqual([MULLUM]);
        expect(pins.unpinnedRegistered).toEqual([OLDTOWN]);
    });

    it('while open: its own words never show; the fixed ones do, with nothing to act on', async () => {
        const old = push({ screen: 'chat', conversationId: CHAT_ID }, { title: '💬 Maya', body: 'Send me your 12 words' });
        expect(await open(old)).toEqual({ kind: 'replace', ...UNSIGNED_NOTICE_WORDS, data: { ...LOCAL_NOTICE_DATA } });
        // A newer server with no node key yet names its kind: that kind's words.
        const named = push({ bp: 1, k: 'trade.update', i: 'a'.repeat(32), t: nowSeconds() }, { title: 'x', body: 'y' });
        expect(await open(named)).toEqual({ kind: 'replace', ...pushNoticeWords('trade.update'), data: { ...LOCAL_NOTICE_DATA } });
    });

    it('a tap opens the app where it was: no request, no navigation, and no warning (it may well be that community\'s)', async () => {
        for (const data of [{ screen: 'post', postId: POST_ID }, { kind: 'recovery_started', screen: 'settings' }, {}]) {
            expect(await tap(push(data))).toEqual({ kind: 'nothing', reason: 'unsigned' });
        }
        expect(navigated).toEqual([]);
        expect(sent).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a signed notice from it before the phone has learnt its key (it signs by now): fixed words, nowhere, no warning', async () => {
        // Oldtown's server was updated, but this phone hasn't registered there since, so it has no pin for it yet.
        const updated = new Community(OLDTOWN);
        const data = updated.notice('trade.update', kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        expect(await open(push(data))).toEqual({ kind: 'replace', ...pushNoticeWords('trade.update'), data: { ...LOCAL_NOTICE_DATA } });
        expect(await tap(push(data))).toEqual({ kind: 'nothing', reason: 'other-community' });
        expect(navigated).toEqual([]);
        expect(sent).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
        // A forgery of a pinned community's notice is still refused: its tag names Mullum, whose key it fails.
        expect(await open(push({ ...data, c: mullum.tag }))).toEqual({ kind: 'drop', reason: 'bad-signature' });
    });

    it('signed notices from the communities that sign are still checked as ever', async () => {
        expect(await open(push(mullum.notice('chat.message', lee.publicKey)))).toEqual({ kind: 'drop', reason: 'bad-signature' });
        expect((await tap(push(mullum.notice('chat.message', lee.publicKey)))).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
    });

    it('once that server signs (its next registration answer names a key), unsigned pushes are no one\'s', async () => {
        communities.set(OLDTOWN, new Community(OLDTOWN));
        await registerAt(OLDTOWN);
        expect((await readPushPins(AsyncStorage)).unpinnedRegistered).toEqual([]);
        expect(await open(push({ screen: 'post', postId: POST_ID }))).toEqual({ kind: 'drop', reason: 'unsigned' });
        expect((await tap(push({ screen: 'post', postId: POST_ID }))).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
    });

    it('once the phone forgets it, its pushes are no one\'s either', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify(saved().filter((n) => n.url !== OLDTOWN)));
        mem.async.set(ANCHOR, MULLUM);
        expect(JSON.parse(mem.async.get(PUSH_REGISTERED_AT_STORE_KEY)!)).toContain(OLDTOWN);
        expect(await open(push({ screen: 'post', postId: POST_ID }))).toEqual({ kind: 'drop', reason: 'unsigned' });
        expect((await tap(push({}))).kind).toBe('warn');
        expect(takeNoticeWarning()).toBe(true);
    });
});

// ── 5b. A notice newer than this build ─────────────────────────────────────────────────────────────────────────

describe('a genuine notice of a kind (or format) this build doesn\'t know is never called a forgery', () => {
    // Core's table grows (market.listing and event.update came after the design), and a community's server can be a
    // release ahead of the member's app. A kind this build doesn't know is still checked against the pin.
    const NEW_KIND = 'group.invite' as PushNoticeKind;

    beforeEach(async () => {
        keep(MULLUM, BYRON);
        await registerAt(MULLUM, BYRON);
        sent = [];
    });

    const detailRequests = () => sent.filter((s) => new URL(s.url).pathname.startsWith('/api/notices/push/'));

    it('the kind really is outside this build\'s table', () => {
        expect(isPushNoticeKind(NEW_KIND)).toBe(false);
    });

    it('signed by its community for this account: shown while open with general words, once', async () => {
        const data = mullum.notice(NEW_KIND, kim.publicKey);
        const decision = await open(push(data, { title: 'BeanPool', body: 'You were invited to a group.' }));
        expect(decision).toEqual({ kind: 'replace', ...UNSIGNED_NOTICE_WORDS, data: { ...data, ...LOCAL_NOTICE_DATA } });
        expect(await open(push(data))).toEqual({ kind: 'drop', reason: 'repeated' });
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a tap opens what its community says, through the fixed list, with no warning', async () => {
        const data = mullum.notice(NEW_KIND, kim.publicKey, { data: { screen: 'chat', conversationId: CHAT_ID } });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: MULLUM, id: data.i, noticeKind: null, active: true });
        expect(navigated).toEqual([`/chat/${CHAT_ID}`]);
        expect(detailRequests()).toHaveLength(1);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a tap when the community can\'t say where, or answers a forged target: the Market tab, no warning', async () => {
        down.add(MULLUM);
        await tap(push(mullum.notice(NEW_KIND, kim.publicKey)));
        down.clear();
        await tap(push(mullum.notice(NEW_KIND, kim.publicKey, { data: { screen: 'post', postId: '../(tabs)/settings' } })));
        expect(navigated).toEqual(['/(tabs)', '/(tabs)']);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('the general words shown in its place, when tapped, open it just the same', async () => {
        const data = mullum.notice(NEW_KIND, kim.publicKey, { data: { screen: 'post', postId: POST_ID } });
        const decision = await open(push(data)) as { data: unknown };
        await tap({ identifier: 'local-new', remote: false, title: UNSIGNED_NOTICE_WORDS.title, body: UNSIGNED_NOTICE_WORDS.body, data: decision.data });
        expect(navigated).toEqual([`/post/${POST_ID}`]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('from a community the phone keeps but isn\'t set to: nothing opened, no warning', async () => {
        expect(await tap(push(byron.notice(NEW_KIND, kim.publicKey)))).toMatchObject({ kind: 'open', community: BYRON, active: false });
        expect(navigated).toEqual([]);
        expect(takeNoticeWarning()).toBe(false);
    });

    it('signed late: no navigation and no warning, as for a kind it knows', async () => {
        const old = mullum.notice(NEW_KIND, kim.publicKey, {}, { t: nowSeconds() - PUSH_NOTICE_LIFETIME_SECONDS - 60 });
        expect(await open(push(old))).toEqual({ kind: 'drop', reason: 'too-old' });
        expect(await tap(push(old))).toEqual({ kind: 'nothing', reason: 'too-old' });
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a bad signature is still a forgery: dropped while open, and a tap gets the warning', async () => {
        const forger = new Community(MULLUM);
        const forged = forger.notice(NEW_KIND, kim.publicKey);
        const wrongKey = { ...forged, c: mullum.tag, s: serverSign(forger.seed, { c: mullum.tag, k: NEW_KIND, i: forged.i, t: forged.t }, kim.publicKey) };
        const forLee = mullum.notice(NEW_KIND, lee.publicKey);
        // A known kind's genuine signature, its kind changed to one this build doesn't know.
        const relabelled = { ...mullum.notice('chat.message', kim.publicKey), k: NEW_KIND };
        for (const data of [wrongKey, forLee, relabelled]) {
            expect(await open(push(data))).toEqual({ kind: 'drop', reason: 'bad-signature' });
            expect((await tap(push(data))).kind).toBe('warn');
            expect(takeNoticeWarning()).toBe(true);
        }
        expect(navigated).toEqual([]);
        expect(detailRequests()).toEqual([]);
    });

    it('a kind in no shape a kind has is not a notice: the warning, even signed', async () => {
        for (const k of ['Group Invite', 'group.invite\nx', '../settings', '', 'a'.repeat(65)]) {
            const t = nowSeconds();
            const i = nodeCrypto.randomBytes(16).toString('hex');
            const data = { bp: 1, c: mullum.tag, k, i, t, s: serverSign(mullum.seed, { c: mullum.tag, k, i, t }, kim.publicKey) };
            expect(await open(push(data))).toEqual({ kind: 'drop', reason: 'not-a-notice' });
            expect((await tap(push(data))).kind).toBe('warn');
            expect(takeNoticeWarning()).toBe(true);
        }
    });

    it('noticeRoute has a place for a kind it doesn\'t know: what the answer names, else the Market tab', () => {
        expect(noticeRoute(null, null)).toBe('/(tabs)');
        expect(noticeRoute(null, { screen: 'post', postId: POST_ID })).toBe(`/post/${POST_ID}`);
        expect(noticeRoute(null, { screen: 'settings' })).toBe('/(tabs)/settings');
        expect(noticeRoute(null, { screen: 'post', postId: '../(tabs)/settings' })).toBe('/(tabs)');
        expect(noticeRoute(NEW_KIND, null)).toBe('/(tabs)');
    });

    describe('a newer notice format (bp above this build\'s): its bytes can\'t be rebuilt, so it is treated as unsigned, without a warning', () => {
        const newer = (extra: Record<string, unknown> = {}) => ({
            ...mullum.notice('chat.message', kim.publicKey), bp: 2, ...extra,
        });

        it('while open: general words, never its own, and nothing to act on', async () => {
            for (const data of [newer(), newer({ bp: '2' }), newer({ k: 'group.invite', screen: 'post', postId: POST_ID })]) {
                expect(await open(push(data, { title: 'URGENT', body: 'Send your 12 words' })))
                    .toEqual({ kind: 'replace', ...UNSIGNED_NOTICE_WORDS, data: { ...LOCAL_NOTICE_DATA } });
            }
        });

        it('a tap opens the app where it was: no request, no navigation, and no warning', async () => {
            for (const data of [newer(), newer({ s: undefined }), newer({ screen: 'post', postId: POST_ID })]) {
                expect(await tap(push(data))).toEqual({ kind: 'nothing', reason: 'newer-format' });
            }
            expect(navigated).toEqual([]);
            expect(sent).toEqual([]);
            expect(takeNoticeWarning()).toBe(false);
        });

        it('on a phone that sent its token to no community it keeps, it is no one\'s', async () => {
            mem.async.delete(SAVED_NODES_STORE_KEY);
            mem.async.delete(ANCHOR);
            expect(await open(push(newer()))).toEqual({ kind: 'drop', reason: 'newer-format' });
            expect((await tap(push(newer()))).kind).toBe('warn');
            expect(takeNoticeWarning()).toBe(true);
        });

        it('a format number that isn\'t a whole number above this build\'s is not a newer format: unsigned, as before', async () => {
            for (const bp of [0, -1, 1.5, '2a', 'two', null]) {
                expect(await open(push(newer({ bp })))).toEqual({ kind: 'drop', reason: 'unsigned' });
            }
        });
    });
});

// ── 6. The calm line, at 320dp and 1.3× text ───────────────────────────────────────────────────────────────────

/** A luminance-contrast ratio, as WCAG defines it. */
function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
        const m = hex.replace('#', '');
        const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
        const [r, g, bl] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
            .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/** The smallest phone we hold to, and the enlarged text we hold it at. */
const SCREEN = 320;
const FONT_SCALE = 1.3;

/** A generous glyph width for a Latin face (Roboto / SF average is nearer 0.55em). */
const wordWidth = (word: string, fontSize: number) => [...word].length * 0.62 * fontSize * FONT_SCALE;

describe('the calm line', () => {
    it('says exactly what the design asks, and nothing else', () => {
        expect(FORGED_NOTICE_LINE).toBe(
            "That notification didn't come from your community. Ignore what it said. BeanPool never asks for your 12 words or a password in a notification.",
        );
    });

    describe.each([['light', lightColors], ['earth', earthColors], ['slate', slateColors], ['dark', darkColors]] as const)('in the %s theme', (_name, colors) => {
        const spec = pushNoticeWarningStyleSpec(colors as typeof lightColors) as Record<string, Record<string, unknown>>;

        it('its button is at least 48dp tall and wide', () => {
            for (const k of PUSH_NOTICE_WARNING_TOUCH_TARGETS) {
                expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
                expect(Number(spec[k].minWidth), k).toBeGreaterThanOrEqual(48);
            }
        });

        it('nothing has a fixed width or height, so the line wraps and the card grows at 320dp and 1.3× text', () => {
            for (const [k, v] of Object.entries(spec)) {
                for (const fixed of ['width', 'height', 'maxHeight', 'maxWidth']) expect(v[fixed], `${k}.${fixed}`).toBeUndefined();
            }
            // Pinned to both sides, so it is as wide as the screen allows and never wider.
            expect(spec.card.left).toBe(PUSH_NOTICE_WARNING_INSET);
            expect(spec.card.right).toBe(PUSH_NOTICE_WARNING_INSET);
        });

        it('every word of the line, and the button, fit inside the card at 320dp and 1.3× text', () => {
            const inner = SCREEN - 2 * PUSH_NOTICE_WARNING_INSET - 2 * Number(spec.card.padding) - 2 * Number(spec.card.borderWidth);
            const longest = Math.max(...FORGED_NOTICE_LINE.split(/\s+/).map((w) => wordWidth(w, Number(spec.line.fontSize))));
            expect(longest).toBeLessThan(inner);
            const button = wordWidth(PUSH_NOTICE_WARNING_OK, Number(spec.okBtnText.fontSize)) + 2 * Number(spec.okBtn.paddingHorizontal) + 2 * Number(spec.okBtn.borderWidth);
            expect(button).toBeLessThan(inner);
        });

        it('its text is readable on its background (WCAG AA, 4.5:1)', () => {
            for (const [text, bg] of Object.entries(PUSH_NOTICE_WARNING_TEXT_ON)) {
                const fg = String(spec[text].color);
                const back = String(spec[bg].backgroundColor);
                expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
                expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
            }
        });
    });

    it('the component draws the line from that spec, cuts it to no number of lines, and sits below the status bar', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../components/PushNoticeWarning.tsx'), 'utf8');
        expect(source).toContain('pushNoticeWarningStyleSpec(colors)');
        expect(source).toContain('{FORGED_NOTICE_LINE}');
        expect(source).not.toMatch(/numberOfLines|adjustsFontSizeToFit|ellipsizeMode/);
        expect(source).toContain('insets.top + PUSH_NOTICE_WARNING_INSET');
    });

    it('the root layout draws it over every screen', () => {
        const layout = fs.readFileSync(path.join(__dirname, '../../app/_layout.tsx'), 'utf8');
        expect(layout).toMatch(/<PushNoticeWarning \/>/);
    });
});
