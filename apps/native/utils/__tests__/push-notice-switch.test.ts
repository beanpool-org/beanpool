/**
 * A tap on a notice from another community this phone keeps opens it in that community (Marty, 24 Oct: "a push
 * notification doesn't direct me to a specific node, it just drops you onto the node you are already on";
 * utils/push-notice-switch.ts).
 *
 * Driven end to end with the app's own pieces: push-notice-check.ts `followTap` (the signature check, the details
 * request), push-notice-switch.ts `openNoticeIn`, the community list's own switch (use-communities.ts `switchCommunity`:
 * the database closed and opened again, the anchor, the update screen told, the bounce through Welcome), the guard's
 * landings (member-landing.ts), the counts (notice-counts.ts) and the join record (onboarding-state.ts). Only the
 * database, the router and the root layout's recognition are stood in for. The root guard is modelled in its order, and
 * tied to app/_layout.tsx below; services/push-notifications.ts's wiring is tied to its source too.
 *
 * A community here is a fake that signs as a server does and answers `GET /api/notices/push/<id>` to its recipient only,
 * checking the request's signature with core and noble. Nothing here contacts a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nodeCrypto from 'node:crypto';

const mem = vi.hoisted(() => ({ async: new Map<string, string>(), log: [] as string[], initGate: null as Promise<void> | null }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => {}),
    deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
vi.mock('expo-router', () => ({
    router: {
        canDismiss: () => true,
        dismissAll: () => { mem.log.push('router.dismissAll'); },
        replace: (href: string) => { mem.log.push(`router.replace ${href}`); },
        push: (href: string) => { mem.log.push(`router.push ${href}`); },
    },
}));
vi.mock('../db', () => ({
    closeDB: vi.fn(async () => { mem.log.push(`closeDB (on ${mem.async.get('beanpool_anchor_url')})`); }),
    initDB: vi.fn(async () => { await mem.initGate; mem.log.push(`initDB (on ${mem.async.get('beanpool_anchor_url')})`); }),
    clearDB: vi.fn(async () => {}),
}));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: null }) }));
vi.mock('../../services/pillar-sync', () => ({ getLastSyncTime: async () => null }));
vi.mock('../membership-probe', () => ({ fetchMembership: vi.fn() }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isPushNoticeKind, pushCommunityTag, pushNoticeBytes, pushNoticeWords, type PushNoticeKind } from '@beanpool/core';
import { followTap, takeNoticeWarning, type IncomingNotice, type NoticeRoute } from '../push-notice-check';
import { openNoticeIn } from '../push-notice-switch';
import { communitySwitchUnderWay, switchCommunity } from '../use-communities';
import { getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding } from '../onboarding-state';
import { DEFAULT_MEMBER_LANDING, memberRedirect, NOTICE_LANDING_MS, takeOpenAfterLanding } from '../member-landing';
import { readNoticeCounts, watchNoticeCounts } from '../notice-counts';
import { onCommunitySwitched } from '../community-switch';
import { notRecognisedStays } from '../mismatch-plan';
import { PUSH_PINS_STORE_KEY, SAVED_NODES_STORE_KEY } from '../storage-keys';
import { boundSignatureValid } from './server-signature-check';

const MULLUM = 'https://mullum.beanpool.org';
const BYRON = 'https://byron.example.net';
const ANCHOR = 'beanpool_anchor_url';
const POST_ID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';

type Account = { publicKey: string; privateKey: string };
function account(): Account {
    const seed = nodeCrypto.randomBytes(32);
    return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: seed.toString('hex') };
}

/** One community's server, as far as notices go: it signs them and answers where each lands, to its recipient only. */
class Community {
    readonly seed = nodeCrypto.randomBytes(32);
    readonly pushKey = bytesToHex(ed25519.getPublicKey(this.seed));
    readonly tag = pushCommunityTag(this.pushKey);
    details = new Map<string, { recipient: string; data: Record<string, unknown> }>();
    constructor(readonly url: string) {}
    notice(recipient: string, data: Record<string, unknown> = {}, kind: PushNoticeKind = 'market.request') {
        const fields = { c: this.tag, k: kind, i: nodeCrypto.randomBytes(16).toString('hex'), t: Math.floor(Date.now() / 1000) };
        this.details.set(fields.i, { recipient, data });
        return { bp: 1, ...fields, s: bytesToHex(ed25519.sign(pushNoticeBytes(fields, recipient), this.seed)) };
    }
}

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[];
let communities: Map<string, Community>;

function serve(): void {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const req: Sent = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') };
        sent.push(req);
        const c = communities.get(url.origin);
        const one = /^\/api\/notices\/push\/([0-9a-f]{32})$/.exec(url.pathname);
        if (!c || !one) return new Response('{}', { status: 404 });
        const signer = req.headers['X-Public-Key'];
        if (!signer || !boundSignatureValid(req, signer)) return new Response('{}', { status: 401 });
        const d = c.details.get(one[1]);
        if (!d || d.recipient !== signer) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ id: one[1], data: d.data }), { status: 200 });
    });
}

function push(data: unknown): IncomingNotice {
    const k = (data as { k?: unknown })?.k;
    const words = isPushNoticeKind(k) ? pushNoticeWords(k) : { title: 'BeanPool', body: 'Open BeanPool' };
    return { identifier: nodeCrypto.randomUUID(), remote: true, ...words, data };
}

let kim: Account;
let mullum: Community;
let byron: Community;

// ── The root layout, as far as a tap goes ──────────────────────────────────────────────────────────────────────

type Recognition = 'member' | 'unknown' | 'stranger' | 'closed' | 'recovering';
/** What each community answers about Kim's key (app/NodeStatusContext.tsx `recheck`). */
let answers: Map<string, Recognition>;
/** The node status: the address its last recheck read, and the answer. */
let nodeUrl: string | null;
let recognition: Recognition;
async function recheck(): Promise<Recognition> {
    nodeUrl = mem.async.get(ANCHOR) ?? null;
    recognition = (nodeUrl && answers.get(nodeUrl)) || 'unknown';
    mem.log.push(`recheck (on ${nodeUrl}): ${recognition}`);
    return recognition;
}

/**
 * app/_layout.tsx's root guard, run on welcome after the bounce (the branches in its order; tied to the source below):
 * what it does with the member, and what it opens over the tabs.
 */
async function guardOnWelcome(): Promise<string[]> {
    const segments = ['welcome'];
    if (await getPendingOnboarding()) return ['stays in the join wizard'];
    if (recognition === 'recovering') return ['asks about the recovery'];
    if (recognition === 'closed') return notRecognisedStays('closed', segments) ? ['stays'] : ['router.replace /node-mismatch'];
    if (recognition === 'stranger') return notRecognisedStays('stranger', segments) ? ['stays (a stranger is held on welcome)'] : ['router.replace /node-mismatch'];
    const out: string[] = [];
    const landing = memberRedirect(segments, kim.publicKey);
    if (landing) out.push(`router.replace ${landing}`);
    const notice = landing === DEFAULT_MEMBER_LANDING ? takeOpenAfterLanding(kim.publicKey, nodeUrl) : null;
    if (notice) out.push(`router.push ${notice}`);
    return out;
}

/** A tap, as services/push-notifications.ts follows it (its wiring is tied to the source below). */
const navigated: NoticeRoute[] = [];
function tap(n: IncomingNotice) {
    return followTap(n, {
        storage: AsyncStorage,
        account: kim,
        openIn: (community, id, route) => openNoticeIn(community, id, route, {
            storage: AsyncStorage,
            publicKey: kim.publicKey,
            joinUnderWay: () => getPendingOnboarding().then((p) => !!p, () => true),
            switchUnderWay: communitySwitchUnderWay,
            switchTo: switchCommunity,
            recheck,
        }),
    }, (route) => { navigated.push(route); });
}

const detailRequests = () => sent.filter((s) => new URL(s.url).pathname.startsWith('/api/notices/push/'));

let stopCounting: () => void = () => {};
let stopListening: () => void = () => {};
beforeEach(() => {
    mem.async.clear();
    mem.log.length = 0;
    mem.initGate = null;
    navigated.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No node may be contacted from a test'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kim = account();
    mullum = new Community(MULLUM);
    byron = new Community(BYRON);
    communities = new Map([[MULLUM, mullum], [BYRON, byron]]);
    sent = [];
    serve();
    // Kim's phone keeps Mullum and Byron, set to Mullum, a member of both, each one's key pinned.
    mem.async.set(ANCHOR, MULLUM);
    mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: BYRON, alias: 'Byron' }]));
    mem.async.set(PUSH_PINS_STORE_KEY, JSON.stringify({ [MULLUM]: mullum.pushKey, [BYRON]: byron.pushKey }));
    answers = new Map([[MULLUM, 'member'], [BYRON, 'member']]);
    nodeUrl = MULLUM;
    recognition = 'member';
    // Nothing left over from another test.
    memberRedirect(['welcome']);
    stopCounting = watchNoticeCounts(AsyncStorage);
    stopListening = onCommunitySwitched(() => { mem.log.push(`communitySwitched (on ${mem.async.get(ANCHOR)})`); });
    takeNoticeWarning();
});

afterEach(async () => {
    stopCounting();
    stopListening();
    await readNoticeCounts(AsyncStorage);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('a verified tap for another community the phone keeps: the phone moves there, and the notice opens there', () => {
    it('through the community list\'s own switch, recognition asked again, then the guard opens the notice over the tabs', async () => {
        const data = byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: BYRON, active: false });

        // The switch, in its order: the copy closed, the anchor, the new copy, the update screen told; recognition asked of
        // Byron; then back to the bottom of the stack and through Welcome. Nothing opened over Mullum on the way.
        expect(mem.log).toEqual([
            `closeDB (on ${MULLUM})`,
            `initDB (on ${BYRON})`,
            `communitySwitched (on ${BYRON})`,
            `recheck (on ${BYRON}): member`,
            'router.dismissAll',
            'router.replace /welcome',
        ]);
        expect(navigated).toEqual([]);
        // Where it lands was asked of Byron, signed by Kim, and of nobody else.
        expect(detailRequests().map((r) => r.url)).toEqual([`${BYRON}/api/notices/push/${data.i}`]);
        expect(boundSignatureValid(detailRequests()[0], kim.publicKey)).toBe(true);

        // The guard lands Kim from welcome on the tabs, and opens the notice over them, once.
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)', `router.push /post/${POST_ID}`]);
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
        // Byron is the one in use: its row shows nothing.
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
        expect(takeNoticeWarning()).toBe(false);
    });

    it('a community saved with a trailing slash: the switch uses the saved address, so no second row appears (#2436 review r4366867289)', async () => {
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM, alias: 'Mullum' }, { url: `${BYRON}/`, alias: 'Byron' }]));
        const data = byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: BYRON, active: false });
        expect(mem.async.get(ANCHOR)).toBe(`${BYRON}/`);
        const saved = JSON.parse(mem.async.get(SAVED_NODES_STORE_KEY) as string) as { url: string; alias?: string }[];
        expect(saved.map((n) => n.url)).toEqual([MULLUM, `${BYRON}/`]);
        expect(saved.find((n) => n.url === `${BYRON}/`)?.alias).toBe('Byron');
    });

    it('Byron can\'t say where (down, or it forgot the notice): the tab for the notice\'s kind, after the same switch', async () => {
        communities.delete(BYRON);
        await tap(push(byron.notice(kim.publicKey, {}, 'chat.message')));
        expect(mem.async.get(ANCHOR)).toBe(BYRON);
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)', 'router.push /(tabs)/chats']);
    });

    it('Byron can\'t be reached for recognition either (unknown): the guard still lets Kim in, and the notice opens', async () => {
        answers.delete(BYRON);
        await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)', `router.push /post/${POST_ID}`]);
    });
});

describe('a tap for the community in use is as it was', () => {
    it('opened at once where its community says; nothing switched, recognition not asked, nothing left for the guard', async () => {
        const data = mullum.notice(kim.publicKey, { screen: 'post', postId: POST_ID });
        expect(await tap(push(data))).toMatchObject({ kind: 'open', community: MULLUM, active: true });
        expect(navigated).toEqual([`/post/${POST_ID}`]);
        expect(mem.log).toEqual([]);
        expect(mem.async.get(ANCHOR)).toBe(MULLUM);
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
    });
});

describe('an unknown or unverified notice opens nothing and moves nothing', () => {
    it('signed by a key that isn\'t Byron\'s, for another account, by a community the phone doesn\'t keep, or not signed at all', async () => {
        const forger = new Community(BYRON);
        const forged = forger.notice(kim.publicKey, { screen: 'post', postId: POST_ID });
        const lee = account();
        for (const data of [
            { ...forged, c: byron.tag },
            byron.notice(lee.publicKey, { screen: 'post', postId: POST_ID }),
            new Community('https://stranger.example.com').notice(kim.publicKey),
            { screen: 'post', postId: POST_ID, community: BYRON },
        ]) {
            expect(['warn', 'nothing']).toContain((await tap(push(data))).kind);
        }
        expect(mem.log).toEqual([]);
        expect(mem.async.get(ANCHOR)).toBe(MULLUM);
        expect(navigated).toEqual([]);
        expect(detailRequests()).toEqual([]);
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({});
    });
});

describe('what holds the member wins: the tap lands where that sends them, never around it', () => {
    it('a join part-way through: nothing moves, Byron is asked nothing, the wizard keeps Kim, and Byron\'s row counts the notice', async () => {
        await setPendingOnboarding({ step: 'profileSetup', inviteCode: 'ABC-DEF', anchorUrl: MULLUM, callsign: 'Kim' });
        expect(await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })))).toMatchObject({ kind: 'open', active: false });
        expect(mem.log).toEqual([]);
        expect(mem.async.get(ANCHOR)).toBe(MULLUM);
        expect(detailRequests()).toEqual([]);
        expect(await guardOnWelcome()).toEqual(['stays in the join wizard']);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [BYRON]: 1 });
        // The join done, the guard's next landing opens nothing: the notice was never handed to it.
        await clearPendingOnboarding();
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
    });

    it('a switch already under way (the community list\'s, here): the tap starts no second one, and is counted', async () => {
        let release!: () => void;
        mem.initGate = new Promise<void>((r) => { release = r; });
        const listSwitch = switchCommunity(BYRON);
        await new Promise((r) => setTimeout(r, 0));
        expect(communitySwitchUnderWay()).toBe(true);
        const oldtown = 'https://oldtown.example.org';
        const third = new Community(oldtown);
        communities.set(oldtown, third);
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: BYRON }, { url: oldtown }]));
        mem.async.set(PUSH_PINS_STORE_KEY, JSON.stringify({ [MULLUM]: mullum.pushKey, [BYRON]: byron.pushKey, [oldtown]: third.pushKey }));
        await tap(push(third.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
        release();
        await listSwitch;
        expect(communitySwitchUnderWay()).toBe(false);
        expect(mem.async.get(ANCHOR)).toBe(BYRON);
        expect(mem.log.filter((l) => l.startsWith('closeDB'))).toHaveLength(1);
        expect(detailRequests()).toEqual([]);
        expect(await readNoticeCounts(AsyncStorage)).toEqual({ [oldtown]: 1 });
    });

    it('Byron doesn\'t know Kim\'s key (or closed it, or reports a recovery): the guard holds Kim where it does, and the notice never opens', async () => {
        for (const answer of ['stranger', 'closed', 'recovering'] as const) {
            mem.async.set(ANCHOR, MULLUM);
            answers.set(BYRON, answer);
            await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
            expect(mem.async.get(ANCHOR), answer).toBe(BYRON);
            const guard = await guardOnWelcome();
            expect(guard.some((g) => g.startsWith('router.push')), answer).toBe(false);
            // Nor is it left for a later landing: none was asked for.
            expect(takeOpenAfterLanding(kim.publicKey, BYRON), answer).toBeNull();
        }
        // Long after, another landing on Byron opens none of them.
        answers.set(BYRON, 'member');
        recognition = 'member';
        expect(takeOpenAfterLanding(kim.publicKey, BYRON, Date.now() + NOTICE_LANDING_MS + 1)).toBeNull();
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
    });

    it('an address that isn\'t plain is refused before anything moves', async () => {
        const odd = 'https://byron.example.net\\@evil.example';
        mem.async.set(SAVED_NODES_STORE_KEY, JSON.stringify([{ url: MULLUM }, { url: odd }]));
        mem.async.set(PUSH_PINS_STORE_KEY, JSON.stringify({ [MULLUM]: mullum.pushKey, [odd]: byron.pushKey }));
        await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
        expect(mem.log).toEqual([]);
        expect(mem.async.get(ANCHOR)).toBe(MULLUM);
        expect(await guardOnWelcome()).toEqual(['router.replace /(tabs)']);
    });
});

describe('the notice the guard opens is only the one asked for', () => {
    it('for the account and the community it was asked for, once, and only in its time', async () => {
        await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
        expect(takeOpenAfterLanding(kim.publicKey, MULLUM)).toBeNull();
        expect(takeOpenAfterLanding(kim.publicKey, `${BYRON}/`)).toBe(`/post/${POST_ID}`);
        expect(takeOpenAfterLanding(kim.publicKey, BYRON)).toBeNull();

        mem.async.set(ANCHOR, MULLUM);
        await tap(push(byron.notice(kim.publicKey, { screen: 'post', postId: POST_ID })));
        // Another account on the phone drops it.
        expect(takeOpenAfterLanding(account().publicKey, BYRON)).toBeNull();
        expect(takeOpenAfterLanding(kim.publicKey, BYRON)).toBeNull();
    });
});

describe('the app is the model', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it('the community list\'s rows and a tapped notice move the phone through the one switch', () => {
        const hook = read('../use-communities.ts');
        // The row's switch is that function, and nothing else in the file writes the phone's community.
        expect(hook).toMatch(/const switchTo = useCallback\(async \(url: string\) => \{\s*if \(url === active \|\| switching \|\| communitySwitchUnderWay\(\)\) return;\s*setSwitching\(true\);\s*try \{\s*await switchCommunity\(url\);/);
        expect(hook.match(/setItem\('beanpool_anchor_url'/g)).toHaveLength(1);
        const service = read('../../services/push-notifications.ts');
        expect(service).toMatch(/await openNoticeIn\(community, id, route, \{[^}]*switchUnderWay: communitySwitchUnderWay,\s*switchTo: switchCommunity,\s*recheck: options\.recheck,\s*\}\);/);
        expect(service).toMatch(/joinUnderWay: \(\) => getPendingOnboarding\(\)\.then\(\(p\) => !!p, \(\) => true\),/);
        expect(service).toMatch(/import\('\.\.\/utils\/use-communities'\), import\('\.\.\/utils\/onboarding-state'\)/);
    });

    it('app/_layout.tsx lends the taps its recheck, and its guard opens the notice only after landing a member on the tabs\' index', () => {
        const layout = read('../../app/_layout.tsx');
        expect(layout).toMatch(/setupNotificationResponseHandler\(\{ recheck: \(\) => recheckRef\.current\(\) \}\)/);
        expect(layout).toMatch(/const \{ recognition, nodeUrl, recheck \} = useNodeStatus\(\);\s*(\/\/.*\s*)*const recheckRef = useRef\(recheck\);\s*recheckRef\.current = recheck;/);
        const guard = layout.slice(layout.indexOf('        if (isLoading) return;\n        const root = (segments as string[])[0];'));
        // Since S3 the guard also looks again when the phone's community comes or goes (`noCommunity`, a waiting phone).
        const body = guard.slice(0, guard.indexOf('}, [identity, isLoading, segments, recognition, pendingOnboarding, noCommunity]);'));
        // The model's order: no identity, the join wizard, a recovery, closed, stranger, then the member's landing.
        const order = ['if (!identity) {', 'if (pendingOnboarding) {', "if (recognition === 'recovering') {", "if (recognition === 'closed') {",
            "if (recognition === 'stranger') {", 'const landing = memberRedirect(segments as string[], identity.publicKey);'];
        const at = order.map((s) => body.indexOf(s));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        // Each of those branches before the landing returns: none reaches the notice.
        expect(body.match(/takeOpenAfterLanding\(/g)).toHaveLength(1);
        expect(body).toMatch(/const landing = memberRedirect\(segments as string\[\], identity\.publicKey\);\n\s*if \(landing\) router\.replace\(landing\);\n\s*const notice = landing === DEFAULT_MEMBER_LANDING \? takeOpenAfterLanding\(identity\.publicKey, nodeUrl\) : null;\n\s*if \(notice\) router\.push\(notice\);\n\s*$/);
    });
});
