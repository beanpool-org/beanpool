/**
 * A knock's key is shown its 12 words at its first join, even when that join's answer was lost (PR #2604 review
 * 4413166460; the gap join-after-lost-answer.test.ts closed for a key Next makes, #1205 confirmation 3c).
 *
 * A phone with no account that asked a community to let it in (slice S3) holds a key a knock made, its words never shown,
 * and marked so (utils/knock-key.ts). A yes is joined through the invite step's Next (welcome.tsx handleCreate) with that
 * key. Its redeem can land on the community and its answer never reach the phone, or the app can stop while it waits.
 * Before:
 *
 * - Next again found the invite spent and the node said the key was in. No record named the key, so Next went into the
 *   app: no Safety Backup. The root layout then saw a community and no record and took the mark off. The words were only
 *   behind Settings' lock.
 * - An app stopped between the community and the record started with a community and no record: the root layout took
 *   the mark off, and the phone opened on the tabs.
 *
 * Now the mark makes the key this join's own at a spent invite (invite-next.ts `afterSpentInvite`), and Next records the
 * key before it sets the community. A redeem that fails puts both back, and the phone waits as it did, the mark still on.
 *
 * The screen cannot be rendered here (see vitest.config.ts): its order is simulated with the real functions, and pinned
 * against its source below. The key rule, the mark, the record and the membership probe are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

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
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { commitKnockKey, forgetKnockKey, knockKeyForThisPhone, knockKeyIsNew } from '../knock-key';
import { afterSpentInvite, redeemRefusalMeansIn } from '../invite-next';
import {
    clearPendingOnboarding, getPendingOnboarding, keyMadeForThisJoin, recordJoinKeyMade, resumePlan, setPendingOnboarding,
    type PendingOnboarding,
} from '../onboarding-state';
import { phoneIsWaiting } from '../waiting-to-join';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { boundSignatureValid } from './server-signature-check';

const NODE = 'https://riverside.example.org';
const ANCHOR = 'beanpool_anchor_url';
const JOIN = { inviteCode: 'INV-RIVER', anchorUrl: NODE, callsign: 'River Kid' };
const USED_BY_ANOTHER = 'This invite has already been used';

/** The app was stopped while the redeem was out: nothing after it runs, the catch included. */
class AppStopped extends Error {}

/**
 * The community, as far as Next sees it: its members, its single-use invite (a key it has already is answered
 * `alreadyMember`, engine/invites.ts), and every redeem that reached it.
 */
function communityNode() {
    const node = {
        members: new Set<string>(),
        usedBy: null as string | null,
        redeems: [] as string[],
        /** GET /api/invite/check. */
        check(): { valid: boolean; reason?: string } {
            return node.usedBy ? { valid: false, reason: 'used' } : { valid: true };
        },
        /**
         * POST /api/invite/redeem. `lost`: it lands, and its answer never reaches the phone. `stopped`: it lands, and the
         * app is stopped before its answer. `stoppedBefore`: the app is stopped before it goes. `offline`: it never arrives.
         */
        async redeem(publicKey: string, how: 'answered' | 'lost' | 'stopped' | 'stoppedBefore' | 'offline' = 'answered'): Promise<void> {
            if (how === 'stoppedBefore') throw new AppStopped();
            if (how === 'offline') throw new Error('Network request failed');
            node.redeems.push(publicKey);
            if (node.members.has(publicKey)) return;
            if (node.usedBy) throw new Error(USED_BY_ANOTHER);
            node.members.add(publicKey);
            node.usedBy = publicKey;
            if (how === 'stopped') throw new AppStopped();
            if (how === 'lost') throw new Error('Relay Node Offline: The selected community node is currently unreachable (HTTP 502).');
        },
    };
    return node;
}
let node: ReturnType<typeof communityNode>;

/** GET /api/community/membership/<key>, answered as routes/community.ts does: only to a request signed by that key. */
const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const m = /\/api\/community\/membership\/([0-9a-f]+)$/.exec(url);
    if (!m || !url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: ${url}`);
    if (!boundSignatureValid({ url, method: 'GET', headers: init?.headers ?? {}, body: '' }, m[1])) {
        return { ok: false, status: 401, json: async () => ({ error: 'Sign the membership probe with the key it asks about' }) };
    }
    return { ok: true, status: 200, json: async () => ({ isMember: node.members.has(m[1]) }) };
});
const realFetch = globalThis.fetch;

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    node = communityNode();
    fetchMock.mockClear();
    (globalThis as any).fetch = fetchMock;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** Ask to join from a phone with no account: Send writes the drafted key, marked as the knock's (knock-key.ts). */
async function knockFromAPhoneWithNoAccount(): Promise<BeanPoolIdentity> {
    return commitKnockKey(await knockKeyForThisPhone(), JOIN.callsign);
}

type Outcome =
    | { went: 'profileSetup'; identity: BeanPoolIdentity; pendingNewKey: string | null }
    | { went: 'app'; identity: BeanPoolIdentity }
    | { went: 'told'; reason: string };

/**
 * Next on "Your Name" (welcome.tsx handleCreate) for the key on the phone, with the real functions, in its order (pinned
 * against the screen's source below). The name check, adoptJoinKey, the consent and the knock list are left out: none
 * decides where the member goes or what the record says. `pendingNewKey` is what Safety Backup is handed: the words are
 * drawn with no lock exactly when it is the key's own (join-words-behind-lock.test.ts).
 */
async function next(how: Parameters<typeof node.redeem>[1] = 'answered'): Promise<Outcome> {
    let undoCommunity = false;
    let undoKnockRecord: (() => Promise<void>) | null = null;
    try {
        const storedIdentity = await loadIdentity();
        const joinRecord = storedIdentity ? await getPendingOnboarding() : null;
        const knockMade = storedIdentity ? await knockKeyIsNew(storedIdentity.publicKey) : false;
        undoCommunity = !!storedIdentity && !(await AsyncStorage.getItem(ANCHOR));

        const check = node.check();
        let inAlready = false;
        if (!check.valid) {
            const spent = check.reason === 'used' ? await afterSpentInvite(NODE, storedIdentity, joinRecord, knockMade) : 'spent';
            if (spent === 'enterApp' && storedIdentity) {
                await AsyncStorage.setItem(ANCHOR, NODE);
                await clearPendingOnboarding();
                return { went: 'app', identity: storedIdentity };
            }
            if (spent !== 'carryOn') return { went: 'told', reason: check.reason ?? '' };
            inAlready = true;
        }

        if (!storedIdentity) throw new Error('this suite joins with the knock\'s key, or another the phone holds');
        const identity = { ...storedIdentity, callsign: JOIN.callsign };
        if (knockMade) undoKnockRecord = () => (joinRecord ? setPendingOnboarding(joinRecord) : clearPendingOnboarding());
        if (knockMade) await recordJoinKeyMade(JOIN, identity.publicKey);

        await AsyncStorage.setItem(ANCHOR, NODE);

        const keyIsNew = keyMadeForThisJoin(joinRecord, storedIdentity.publicKey) || knockMade;
        if (!inAlready) {
            try {
                await node.redeem(identity.publicKey, how);
            } catch (redeemErr: any) {
                if (redeemErr instanceof AppStopped) throw redeemErr;
                if (!(await redeemRefusalMeansIn(redeemErr?.message, NODE, identity))) throw redeemErr;
            }
        }
        undoCommunity = false;

        await setPendingOnboarding({ step: 'profileSetup', ...JOIN, redeemed: true, ...(keyIsNew ? { newKey: identity.publicKey } : {}) });
        if (knockMade) await forgetKnockKey();
        return { went: 'profileSetup', identity, pendingNewKey: keyIsNew ? identity.publicKey : null };
    } catch (err) {
        // A stopped app runs nothing more, its catch included.
        if (err instanceof AppStopped) throw err;
        if (undoCommunity) {
            await AsyncStorage.removeItem(ANCHOR);
            if (undoKnockRecord) await undoKnockRecord();
        }
        throw err;
    }
}

/** The root layout's look at the phone (app/_layout.tsx, pinned below): a community and no wizard is a key that has joined. */
async function rootLayoutLooks(): Promise<void> {
    if (!(await loadIdentity())) return;
    const [record, anchor] = [await getPendingOnboarding(), await AsyncStorage.getItem(ANCHOR)];
    if (anchor && !record) await forgetKnockKey();
}

/** What the phone holds now, as the root guard and welcome read it. */
async function phone() {
    const identity = await loadIdentity();
    const record = await getPendingOnboarding();
    const anchorUrl = await AsyncStorage.getItem(ANCHOR);
    return {
        identity,
        record,
        anchorUrl,
        marked: await knockKeyIsNew(identity?.publicKey),
        waiting: phoneIsWaiting({ hasIdentity: !!identity, record, anchorUrl }),
    };
}

const wordsWithNoLock = (o: Outcome) => o.went === 'profileSetup' && o.pendingNewKey === o.identity.publicKey;

describe("a yes's redeem that landed with its answer lost, then Join again: the knock's words, with no lock", () => {
    it('the phone waits again as it did, the mark still on; Join again goes on to Safety Backup, and nothing redeems twice', async () => {
        const key = await knockFromAPhoneWithNoAccount();
        expect(await phone()).toMatchObject({ anchorUrl: null, record: null, marked: true, waiting: true });

        await expect(next('lost')).rejects.toThrow('Relay Node Offline');
        // It landed: the community has the key, and the invite is spent.
        expect(node.members.has(key.publicKey)).toBe(true);
        expect(node.check()).toEqual({ valid: false, reason: 'used' });
        // The phone is put back as it was: no community, no record, the mark on, the waiting mode.
        expect(await phone()).toMatchObject({ anchorUrl: null, record: null, marked: true, waiting: true });
        // And the root layout, looking now, leaves the mark: the phone has no community.
        await rootLayoutLooks();
        expect((await phone()).marked).toBe(true);

        const again = await next();
        expect(again).toMatchObject({ went: 'profileSetup', identity: { publicKey: key.publicKey }, pendingNewKey: key.publicKey });
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toEqual({ step: 'profileSetup', ...JOIN, redeemed: true, newKey: key.publicKey });
        // The one redeem that landed; the retry asked the community instead, signed by the key.
        expect(node.redeems).toEqual([key.publicKey]);
        expect(fetchMock).toHaveBeenCalledWith(`${NODE}/api/community/membership/${key.publicKey}`, expect.anything());
        // The record says the words are new from here; the mark goes, and a restart resumes at the photo with them new.
        expect((await phone()).marked).toBe(false);
        expect(resumePlan(await getPendingOnboarding(), key)).toMatchObject({ action: 'resume', mode: 'profileSetup', redeemed: true, newKey: true });
    });

    it('before: the same Join again went into the app, and the root layout then took the mark off (what the fix stops)', async () => {
        const key = await knockFromAPhoneWithNoAccount();
        await expect(next('lost')).rejects.toThrow();
        // Without the mark, the spent invite's answer for this key is the established account's: into the app.
        expect(await afterSpentInvite(NODE, key, await getPendingOnboarding())).toBe('enterApp');
        // With it, as Next now asks: on through the wizard.
        expect(await afterSpentInvite(NODE, key, await getPendingOnboarding(), true)).toBe('carryOn');
    });
});

describe('the app stopped during the yes\'s join: started again, the words are still the knock\'s new ones', () => {
    it('stopped after the redeem landed, before its answer: the record names the key, the mark stays, and Join goes on', async () => {
        const key = await knockFromAPhoneWithNoAccount();
        await expect(next('stopped')).rejects.toBeInstanceOf(AppStopped);

        // What the next start finds: the community set, and the record Next wrote before it, naming the key.
        const started = await phone();
        expect(started.anchorUrl).toBe(NODE);
        expect(started.record).toEqual({ step: 'create', ...JOIN, redeemed: false, newKey: key.publicKey });
        // A wizard part-way, never a key that has joined: the root layout leaves the mark.
        await rootLayoutLooks();
        expect((await phone()).marked).toBe(true);
        expect(resumePlan(started.record, key)).toMatchObject({ action: 'resume', mode: 'create', redeemed: false, newKey: true });

        const again = await next();
        expect(wordsWithNoLock(again)).toBe(true);
        expect(await getPendingOnboarding()).toEqual({ step: 'profileSetup', ...JOIN, redeemed: true, newKey: key.publicKey });
        expect(node.redeems).toEqual([key.publicKey]);
    });

    it('stopped before the redeem went out: Join again redeems once, with the words new', async () => {
        const key = await knockFromAPhoneWithNoAccount();
        await expect(next('stoppedBefore')).rejects.toBeInstanceOf(AppStopped);
        await rootLayoutLooks();
        expect(await phone()).toMatchObject({ anchorUrl: NODE, marked: true, record: { step: 'create', newKey: key.publicKey } });

        const again = await next();
        expect(wordsWithNoLock(again)).toBe(true);
        expect(node.redeems).toEqual([key.publicKey]);
    });
});

describe("a yes's redeem that never arrived: the phone waits again exactly as it did", () => {
    it('no community, no record, the mark on; Join again joins with the words new', async () => {
        const key = await knockFromAPhoneWithNoAccount();
        await expect(next('offline')).rejects.toThrow('Network request failed');
        expect(node.members.size).toBe(0);
        expect(await phone()).toMatchObject({ anchorUrl: null, record: null, marked: true, waiting: true });

        expect(wordsWithNoLock(await next())).toBe(true);
        expect(node.redeems).toEqual([key.publicKey]);
    });

    it('a record the phone held before Next is the one put back, as it was', async () => {
        await knockFromAPhoneWithNoAccount();
        const before: PendingOnboarding = { step: 'create', inviteCode: 'INV-OTHER', anchorUrl: 'https://other.example.org', callsign: 'River Kid', redeemed: false };
        await setPendingOnboarding(before);
        await expect(next('offline')).rejects.toThrow();
        expect(await getPendingOnboarding()).toEqual(before);
        expect(await AsyncStorage.getItem(ANCHOR)).toBeNull();
        expect((await phone()).marked).toBe(true);
    });
});

describe("an established account is not read as new: the mark names that exact key", () => {
    it('a key the mark does not name, in already: into the app, as before, no words drawn', async () => {
        const had = await draftIdentity('Kim');
        await importIdentity(had);
        node.members.add(had.publicKey);
        node.usedBy = had.publicKey;
        expect(await next()).toEqual({ went: 'app', identity: expect.objectContaining({ publicKey: had.publicKey }) });
        expect(await getPendingOnboarding()).toBeNull();
        expect(node.redeems).toEqual([]);
    });

    it("the spent invite's answer: on only for this join's key or the knock's, into the app for any other, told if not in", async () => {
        const key = await draftIdentity('Kim');
        expect(await afterSpentInvite(NODE, key, null, true)).toBe('spent');
        node.members.add(key.publicKey);
        expect(await afterSpentInvite(NODE, key, null, true)).toBe('carryOn');
        expect(await afterSpentInvite(NODE, key, null, false)).toBe('enterApp');
        expect(await afterSpentInvite(NODE, key, null)).toBe('enterApp');
        expect(await afterSpentInvite(NODE, null, null, true)).toBe('spent');
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => code(fs.readFileSync(path.resolve(__dirname, p), 'utf-8'));
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
function inOrder(s: string, needles: string[]) {
    let at = -1;
    for (const n of needles) {
        const i = s.indexOf(n, at + 1);
        expect(i, `missing, or out of order: ${n}`).toBeGreaterThan(at);
        at = i;
    }
}

describe('welcome.tsx: Next on "Your Name" does what the simulation above does', () => {
    const handleCreate = () => slice(read('../../app/welcome.tsx'), 'async function handleCreate() {', '\n    }\n');

    it("the mark at a spent invite; the knock's record before the community; the mark gone once the record says the words are new", () => {
        inOrder(handleCreate(), [
            'const joinRecord = storedIdentity ? await getPendingOnboarding() : null;',
            'const knockMade = storedIdentity ? await knockKeyIsNew(storedIdentity.publicKey) : false;',
            "undoCommunity = !!storedIdentity && !(await AsyncStorage.getItem('beanpool_anchor_url'));",
            'const check = await checkInvite(parsedCode, nodeUrl);',
            "const spent = check.reason === 'used' ? await afterSpentInvite(nodeUrl, storedIdentity, joinRecord, knockMade) : 'spent';",
            ': await createIdentity(callsign.trim());',
            'if (knockMade) undoKnockRecord = () => (joinRecord ? setPendingOnboarding(joinRecord) : clearPendingOnboarding());',
            'if (!storedIdentity || knockMade) await recordJoinKeyMade({ inviteCode: parsedCode, anchorUrl: nodeUrl, callsign: callsign.trim() }, identity.publicKey);',
            "await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);",
            'const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey) || knockMade;',
            'await redeemInvite(parsedCode, identity.callsign, identity, { timeoutMs: NEXT_REQUEST_TIMEOUT_MS });',
            'undoCommunity = false;',
            "step: 'profileSetup',",
            'if (knockMade) await forgetKnockKey();',
        ]);
    });

    it('sets the community in two places only: into the app on a spent invite, and after the record', () => {
        const s = handleCreate();
        expect(s.match(/AsyncStorage\.setItem\('beanpool_anchor_url', nodeUrl\)/g)).toHaveLength(2);
        const enterApp = slice(s, "if (spent === 'enterApp' && storedIdentity) {", 'return;');
        expect(enterApp).toContain("await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);");
        // Whichever key the record is written for, it is written before the community.
        const recorded = s.indexOf('await recordJoinKeyMade(');
        expect(recorded).toBeGreaterThan(s.indexOf(enterApp) + enterApp.length);
        expect(s.indexOf("await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);", s.indexOf(enterApp) + enterApp.length)).toBeGreaterThan(recorded);
    });

    it("a redeem that doesn't land takes the community off first, then puts the record back", () => {
        const caught = slice(handleCreate(), '} catch (err: any) {', 'if (err instanceof StoredKeyUnreadableError)');
        const undo = slice(caught, 'if (undoCommunity) {', '\n                }');
        inOrder(undo, [
            "await AsyncStorage.removeItem('beanpool_anchor_url')",
            'communitySwitched();',
            'if (undoKnockRecord) await undoKnockRecord();',
        ]);
        // Only there, never on any other failure.
        expect(caught.match(/undoKnockRecord\(\)/g)).toHaveLength(1);
    });
});

describe('app/_layout.tsx: the root layout takes the mark off only for a community with no record', () => {
    it('the rule rootLayoutLooks plays', () => {
        const layout = read('../../app/_layout.tsx');
        expect(layout).toContain("Promise.all([getPendingOnboarding(), AsyncStorage.getItem('beanpool_anchor_url')])");
        expect(layout).toContain('.then(([record, anchor]) => { if (alive && anchor && !record) void forgetKnockKey(); })');
        expect(layout.match(/forgetKnockKey\(\)/g)).toHaveLength(1);
    });
});
