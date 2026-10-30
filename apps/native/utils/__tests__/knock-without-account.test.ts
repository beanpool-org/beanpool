/**
 * Ask to join from a phone with no account (DESIGN-account-without-global-fable.md §2.4, slice S3), the phone's half:
 *
 *   - the key: drafted in memory when the form opens, nothing written; written once, with the name, when Send is tapped,
 *     before the knock goes out, and marked as the knock's (its words never shown); never a second key over the phone's;
 *     a phone that was only looking around global stops looking (no community in use);
 *   - the knock: signed by that key, addressed to the community (`toNode`), and naming no community it came from unless
 *     the phone is a member of global (`fromNode`);
 *   - which community: a typed address, an app link or a scanned code, never a word, http, a home number or global;
 *   - the waiting state: an account, no community, no wizard; its lines; the yes handed from Find to welcome in memory;
 *   - the root guard: Find a community with no account, and a waiting phone held on welcome, never the tabs, never asked;
 *     an invite link on a waiting phone goes to welcome's invite step (the wizard, so the 12 words), never "Switch Nodes?";
 *   - Restore over a waiting key still asks first, and replacing it takes the knock's mark and requests with it.
 *
 * Nothing here contacts a node: fetch is a stub that plays the one community, and anything else fails the test.
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

import * as SecureStore from 'expo-secure-store';
import { commitKnockKey, forgetKnockKey, knockKeyForThisPhone, knockKeyIsNew, KNOCK_KEY_DIFFERS, type CommitDeps } from '../knock-key';
import { knockAddressFrom, knockFromNode, knockScanTarget } from '../knock-address';
import { knockBody, sendKnock, rememberKnock, rememberedKnocks, KNOCK_FROM_NODE, KNOCK_MESSAGES, type KnockStatusResult } from '../knock';
import { handKnockYesToWelcome, inviteLinkToWelcome, phoneIsWaiting, takeKnockYes, waitingLines } from '../waiting-to-join';
import { setupRedirect } from '../auth-return';
import { draftIdentity, importIdentity, loadIdentity } from '../identity';
import { restoreFromWords } from '../restore-account';
import { KNOCK_KEY_STORE_KEY, KNOCKS_STORE_KEY } from '../storage-keys';
import { GLOBAL_NODE_URL } from '../global-node-url';
import { boundSignatureValid } from './server-signature-check';

const RIVERSIDE = 'https://riverside.example.org';
const ANCHOR = 'beanpool_anchor_url';
// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
let sent: Sent[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    mem.async.clear();
    mem.secure.clear();
    sent = [];
    vi.mocked(SecureStore.setItemAsync).mockClear();
    globalThis.fetch = vi.fn(async (url: string, init: any) => {
        const req = { url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ?? '' };
        sent.push(req);
        if (!req.url.startsWith(`${RIVERSIDE}/`)) throw new TypeError(`Network request failed: ${req.url}`);
        return new Response(JSON.stringify({ knock: { status: 'pending' } }), { status: 201 });
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** Every write of the phone's key (SecureStore) carrying `publicKey`. */
const keyWrites = (publicKey: string) => vi.mocked(SecureStore.setItemAsync).mock.calls.filter(([, v]) => String(v).includes(publicKey)).length;

describe('the key at the knock (utils/knock-key.ts)', () => {
    it('drafted when the form opens: in memory only, nothing on the phone', async () => {
        const key = await knockKeyForThisPhone(null);
        expect(key.createdHere).toBe(true);
        expect(key.identity.mnemonic).toHaveLength(12);
        expect(await loadIdentity()).toBeNull();
        expect(vi.mocked(SecureStore.setItemAsync)).not.toHaveBeenCalled();
        expect(await knockKeyIsNew(key.identity.publicKey)).toBe(false);
        // Asked again with the key the form holds: the same one, never a second draft.
        expect((await knockKeyForThisPhone(key)).identity.publicKey).toBe(key.identity.publicKey);
    });

    it('Send writes it once, with the name typed, and marks it as the knock\'s; the knock then carries no fromNode', async () => {
        const key = await knockKeyForThisPhone(null);
        const pk = key.identity.publicKey;
        const signer = await commitKnockKey(key, '  River   Kid ');
        expect(signer.publicKey).toBe(pk);
        expect(signer.callsign).toBe('River Kid');
        expect((await loadIdentity())?.publicKey).toBe(pk);
        expect((await loadIdentity())?.callsign).toBe('River Kid');
        expect(keyWrites(pk)).toBe(1);
        expect(await knockKeyIsNew(pk)).toBe(true);

        // The knock, as Find a community sends it from a phone with no community: no fromNode.
        const r = await sendKnock(RIVERSIDE, signer, { callsign: 'River Kid', message: 'I grow beans by the river.' }, knockFromNode(null, false));
        expect(r).toEqual({ kind: 'waiting', message: KNOCK_MESSAGES.waiting });
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe(`${RIVERSIDE}/api/join/knock`);
        const body = JSON.parse(sent[0].body);
        expect(body).toEqual({ message: 'I grow beans by the river.', callsign: 'River Kid', toNode: 'riverside.example.org' });
        expect('fromNode' in body).toBe(false);
        expect(await boundSignatureValid(sent[0], pk)).toBe(true);

        // Asked again (a second knock, or the form opened again): the phone's key, nothing written a second time.
        const again = await knockKeyForThisPhone(null);
        expect(again).toEqual({ identity: expect.objectContaining({ publicKey: pk }), createdHere: false });
        expect((await commitKnockKey(again, 'River Kid')).publicKey).toBe(pk);
        expect(keyWrites(pk)).toBe(1);
    });

    it('never a second key: an account the phone stored by Send signs the knock, the draft never written; handed any other key, the commit writes nothing', async () => {
        const drafted = await knockKeyForThisPhone(null);
        const other = await draftIdentity('Kim');
        await importIdentity(other);
        // Send asks again with the key the form holds (find-community.tsx): the phone's own account, as stored, signs it.
        const atSend = await knockKeyForThisPhone(drafted);
        expect(atSend).toEqual({ identity: expect.objectContaining({ publicKey: other.publicKey }), createdHere: false });
        const signer = await commitKnockKey(atSend, 'River Kid');
        expect(signer.publicKey).toBe(other.publicKey);
        expect(signer.callsign).toBe('Kim');
        expect(keyWrites(other.publicKey)).toBe(1);
        // The commit itself never writes over it: handed the draft (the account changed between Send's two reads), it refuses.
        await expect(commitKnockKey(drafted, 'River Kid')).rejects.toThrow(KNOCK_KEY_DIFFERS);
        expect((await loadIdentity())?.publicKey).toBe(other.publicKey);
        expect(keyWrites(drafted.identity.publicKey)).toBe(0);
        expect(await knockKeyIsNew(drafted.identity.publicKey)).toBe(false);
        // The form opened with the account, which has gone since: nothing is made in its place.
        mem.secure.clear();
        await expect(commitKnockKey({ identity: other, createdHere: false }, 'Kim')).rejects.toThrow(KNOCK_KEY_DIFFERS);
        expect(await loadIdentity()).toBeNull();
    });

    it('a phone looking around global as a visitor stops looking before the key is written: no community in use', async () => {
        const order: string[] = [];
        const deps: CommitDeps = {
            loadIdentity: async () => null,
            importIdentity: async () => { order.push('key'); },
            forgetTheLook: async () => { order.push('look'); },
            removeAnchor: async () => { order.push('community'); },
        };
        const key = await knockKeyForThisPhone(null);
        await commitKnockKey(key, 'River Kid', deps);
        expect(order).toEqual(['look', 'community', 'key']);
        // The real removal: the look's community goes.
        mem.async.set(ANCHOR, GLOBAL_NODE_URL);
        await commitKnockKey(await knockKeyForThisPhone(null), 'River Kid');
        expect(mem.async.has(ANCHOR)).toBe(false);
    });

    it('the mark names that key alone, and goes', async () => {
        const key = await knockKeyForThisPhone(null);
        await commitKnockKey(key, 'River Kid');
        expect(await knockKeyIsNew(key.identity.publicKey)).toBe(true);
        expect(await knockKeyIsNew((await draftIdentity()).publicKey)).toBe(false);
        expect(await knockKeyIsNew(null)).toBe(false);
        await forgetKnockKey();
        expect(await knockKeyIsNew(key.identity.publicKey)).toBe(false);
    });
});

describe('what a knock says it came from (knock-address.ts knockFromNode)', () => {
    it('the global community only from a member there; nothing from no community, a local one, or a guest visit', () => {
        expect(knockFromNode(GLOBAL_NODE_URL, false)).toBe(KNOCK_FROM_NODE);
        expect(knockFromNode(`${GLOBAL_NODE_URL}/`, false)).toBe(KNOCK_FROM_NODE);
        expect(knockFromNode(GLOBAL_NODE_URL, true)).toBeNull();
        expect(knockFromNode(null, false)).toBeNull();
        expect(knockFromNode('', false)).toBeNull();
        expect(knockFromNode('https://mullum.beanpool.org', false)).toBeNull();
    });

    it('knockBody leaves fromNode out for a key that is no member of global, and keeps it for one that is', () => {
        const req = { callsign: 'Robin', message: 'Hi' };
        expect(knockBody(req, 'riverside.example.org', null)).toEqual({ message: 'Hi', callsign: 'Robin', toNode: 'riverside.example.org' });
        expect(knockBody(req, 'riverside.example.org', knockFromNode(GLOBAL_NODE_URL, false)))
            .toEqual({ message: 'Hi', callsign: 'Robin', fromNode: 'global.beanpool.org', toNode: 'riverside.example.org' });
    });
});

describe('which community: typed, linked or scanned (knock-address.ts)', () => {
    it('an address with a dot, bare or with https, or one of its pages', () => {
        expect(knockAddressFrom('riverside.example.org')).toBe(RIVERSIDE);
        expect(knockAddressFrom('  Riverside.Example.org  ')).toBe(RIVERSIDE);
        expect(knockAddressFrom('https://riverside.example.org/')).toBe(RIVERSIDE);
        expect(knockAddressFrom('https://riverside.example.org/some/page?x=1')).toBe(RIVERSIDE);
        expect(knockAddressFrom('riverside.example.org:8443')).toBe('https://riverside.example.org:8443');
        expect(knockAddressFrom('203.0.113.9')).toBe('https://203.0.113.9');
    });

    it('an app link that names it: a community\'s card, its open door, its claim', () => {
        const node = encodeURIComponent(RIVERSIDE);
        expect(knockAddressFrom(`beanpool://community-card?node=${node}`)).toBe(RIVERSIDE);
        expect(knockAddressFrom(`beanpool://join-open-door?node=${node}`)).toBe(RIVERSIDE);
        expect(knockAddressFrom(`beanpool:///claim?node=${node}&id=abc`)).toBe(RIVERSIDE);
        expect(knockAddressFrom('beanpool://community-card')).toBeNull();
    });

    it('never a word (a name to look for), http, a home number, the global community, a login or a space', () => {
        for (const no of ['riverside', 'http://riverside.example.org', '192.168.1.9', 'https://10.0.0.5', GLOBAL_NODE_URL, 'global.beanpool.org',
            'https://user:pw@riverside.example.org', 'river side.org', '', '   ', 42, null]) {
            expect(knockAddressFrom(no), String(no)).toBeNull();
        }
    });

    it('a scanned code: an invite goes to the invite step as it is; a community\'s address to the box; else nothing', () => {
        expect(knockScanTarget('INV-ABCD-EFGH')).toEqual({ kind: 'invite', raw: 'INV-ABCD-EFGH' });
        expect(knockScanTarget('https://riverside.example.org/join?invite=INV-ABCD-EFGH')?.kind).toBe('invite');
        expect(knockScanTarget('beanpool://join?invite=INV-ABCD-EFGH&server=https://riverside.example.org')?.kind).toBe('invite');
        expect(knockScanTarget('https://riverside.example.org/')).toEqual({ kind: 'community', origin: RIVERSIDE });
        expect(knockScanTarget('hello there')).toBeNull();
        expect(knockScanTarget('')).toBeNull();
    });
});

describe('waiting to be let in (utils/waiting-to-join.ts)', () => {
    it('an account, no community in use, no wizard part-way', () => {
        expect(phoneIsWaiting({ hasIdentity: true, record: null, anchorUrl: null })).toBe(true);
        expect(phoneIsWaiting({ hasIdentity: true, record: null, anchorUrl: '' })).toBe(true);
        expect(phoneIsWaiting({ hasIdentity: false, record: null, anchorUrl: null })).toBe(false);
        expect(phoneIsWaiting({ hasIdentity: true, record: null, anchorUrl: RIVERSIDE })).toBe(false);
        const wizard = { step: 'profileSetup' as const, inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'Kid', redeemed: true };
        expect(phoneIsWaiting({ hasIdentity: true, record: wizard, anchorUrl: null })).toBe(false);
    });

    it('one line per community asked: waiting (also before it is read), a yes with its invite, closed, trouble', async () => {
        const at = (url: string, name: string | null) => ({ url, name, key: null, sentAt: '2026-10-29T00:00:00.000Z' });
        const asked = [at(RIVERSIDE, 'Riverside'), at('https://hill.example.org', null), at('https://dale.example.org', 'Dale'), at('https://moor.example.org', 'Moor'), at('https://fen.example.org', 'Fen')];
        const statuses: Record<string, KnockStatusResult> = {
            [RIVERSIDE]: { ok: true, value: { status: 'pending' } },
            'https://hill.example.org': { ok: true, value: { status: 'approved', invite: 'INV-ABCD-EFGH', expiresAt: null } },
            'https://dale.example.org': { ok: true, value: { status: 'none' } },
            'https://moor.example.org': { ok: false, kind: 'unreachable', message: KNOCK_MESSAGES.unreachable },
        };
        expect(waitingLines(asked, statuses)).toEqual([
            { kind: 'waiting', url: RIVERSIDE, name: 'Riverside', text: 'Waiting for Riverside: usually a few days.' },
            { kind: 'invited', url: 'https://hill.example.org', name: 'hill.example.org', text: 'hill.example.org said yes. Join now.', invite: 'INV-ABCD-EFGH' },
            { kind: 'closed', url: 'https://dale.example.org', name: 'Dale', note: KNOCK_MESSAGES.none },
            { kind: 'trouble', url: 'https://moor.example.org', name: 'Moor', note: KNOCK_MESSAGES.unreachable },
            { kind: 'waiting', url: 'https://fen.example.org', name: 'Fen', text: 'Waiting for Fen: usually a few days.' },
        ]);
        expect(waitingLines([], {})).toEqual([]);
    });

    it('an invite link goes to the invite step for a phone in no community or with a wizard part-way; "Switch Nodes?" only with a community', () => {
        const wizard = { step: 'profileSetup' as const, inviteCode: 'INV-ABCD-EFGH', anchorUrl: RIVERSIDE, callsign: 'Kid', redeemed: true };
        // Waiting to be let in (a knock's key, or a wipe that kept the key): the invite step, so the wizard runs.
        expect(inviteLinkToWelcome({ record: null, anchorUrl: null })).toBe(true);
        expect(inviteLinkToWelcome({ record: null, anchorUrl: '' })).toBe(true);
        expect(inviteLinkToWelcome({ record: null, anchorUrl: '  ' })).toBe(true);
        // A wizard part-way, with a community or not: the invite step, as before.
        expect(inviteLinkToWelcome({ record: wizard, anchorUrl: RIVERSIDE })).toBe(true);
        expect(inviteLinkToWelcome({ record: wizard, anchorUrl: null })).toBe(true);
        // A member, with a community in use: the member's own path ("Switch Nodes?"), as before.
        expect(inviteLinkToWelcome({ record: null, anchorUrl: RIVERSIDE })).toBe(false);
        expect(inviteLinkToWelcome({ record: null, anchorUrl: GLOBAL_NODE_URL })).toBe(false);
    });

    it('a yes Find a community hands to welcome: in memory, for this account only, taken once', () => {
        handKnockYesToWelcome({ url: `${RIVERSIDE}/`, invite: ' INV-ABCD-EFGH ', name: 'Riverside' }, 'aa');
        expect(takeKnockYes('bb')).toBeNull();
        handKnockYesToWelcome({ url: RIVERSIDE, invite: 'INV-ABCD-EFGH', name: 'Riverside' }, 'aa');
        expect(takeKnockYes('aa')).toEqual({ url: RIVERSIDE, invite: 'INV-ABCD-EFGH', name: 'Riverside' });
        expect(takeKnockYes('aa')).toBeNull();
        // Never to the global community, and never an empty invite.
        handKnockYesToWelcome({ url: GLOBAL_NODE_URL, invite: 'INV-ABCD-EFGH', name: null }, 'aa');
        expect(takeKnockYes('aa')).toBeNull();
        handKnockYesToWelcome({ url: RIVERSIDE, invite: '  ', name: null }, 'aa');
        expect(takeKnockYes('aa')).toBeNull();
    });
});

describe('the root guard (auth-return.ts setupRedirect)', () => {
    const NO_KEY = { hasIdentity: false, pendingOnboarding: false };
    const LOOKING = { ...NO_KEY, lookingAround: true as const };
    const WAITING = { hasIdentity: true, pendingOnboarding: false, waiting: true };

    it('with no account, Find a community stays, looking around global or not: the knock makes the key there', () => {
        expect(setupRedirect(['find-community'], NO_KEY)).toBeNull();
        expect(setupRedirect(['find-community'], LOOKING)).toBeNull();
        // Every other screen that needs a key still goes where it went.
        expect(setupRedirect(['new-message'], NO_KEY)).toBe('/welcome');
        expect(setupRedirect(['(tabs)', 'people'], LOOKING)).toEqual({ pathname: '/welcome', params: { join: 'look' } });
    });

    it('a waiting phone stays on welcome (its waiting mode), Find, Start a community, the guide and the no-account screens', () => {
        for (const root of ['welcome', 'find-community', 'start-community', 'guide', 'recover-identity', 'rekey-code', 'claim-community',
            'join-open-door', 'community-card', 'peek']) {
            expect(setupRedirect([root], WAITING), root).toBeNull();
        }
    });

    it('…and every other screen goes to welcome: the bare root, the tabs, the not-recognised screen, a chat, never the look\'s door', () => {
        for (const segments of [[], ['(tabs)'], ['(tabs)', 'index'], ['(tabs)', 'market'], ['(tabs)', 'settings'], ['node-mismatch'], ['chat', '[id]'],
            ['profile-setup'], ['join-global'], ['auth', 'google']]) {
            expect(setupRedirect(segments, WAITING), segments.join('/') || '(root)').toBe('/welcome');
        }
        // Not waiting (a member with a community), nothing changes.
        expect(setupRedirect(['(tabs)'], { hasIdentity: true, pendingOnboarding: false })).toBeNull();
        // A wizard part-way still comes first.
        expect(setupRedirect(['find-community'], { hasIdentity: true, pendingOnboarding: true, waiting: true })).toBe('/welcome');
    });

    it('app/_layout.tsx holds a waiting phone before any community is asked about it, and reads the community again before moving it', () => {
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
        const guard = layout.slice(layout.indexOf('        if (isLoading) return;\n        const root = (segments as string[])[0];'));
        const held = guard.indexOf("const to = setupRedirect(segments, { hasIdentity: true, pendingOnboarding: false, waiting: true });");
        expect(held).toBeGreaterThan(guard.indexOf('if (pendingOnboarding) {'));
        // Before the recovery prompt, the closed and stranger diversions, and the landing on the tabs.
        for (const later of ["if (recognition === 'recovering') {", "if (recognition === 'closed') {", "if (recognition === 'stranger') {", 'const landing = memberRedirect(']) {
            expect(guard.indexOf(later), later).toBeGreaterThan(held);
        }
        const branch = guard.slice(held, guard.indexOf("if (recognition === 'recovering') {"));
        expect(branch).toMatch(/AsyncStorage\.getItem\('beanpool_anchor_url'\)\.then\(\(anchor\) => \{[\s\S]*if \(anchor\) \{ refreshHold\.current\(\); return; \}\s*router\.replace\(to\);/);
        expect(branch).toMatch(/\n\s*return;\n\s*\}\n/);
    });

    it('app/_layout.tsx sends an invite link on a phone in no community to welcome\'s invite step, before "Switch Nodes?" or any redeem', () => {
        const layout = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
        const handler = layout.slice(layout.indexOf('const inviteToken = extractInviteToken(currentUrl);'));
        // No account: the invite step, as before.
        expect(handler).toMatch(/if \(!identity\) \{\s*routeToWelcomeWithInvite\(\);\s*return;\s*\}/);
        const case2 = handler.slice(handler.indexOf('// Case 2: User has active identity (Logged in)'));
        const read = case2.indexOf("AsyncStorage.getItem('beanpool_anchor_url').then(async current => {");
        const toWelcome = case2.indexOf('if (inviteLinkToWelcome({ record: await getPendingOnboarding(), anchorUrl: current })) {\n                routeToWelcomeWithInvite();\n                return;\n            }');
        expect(read).toBeGreaterThan(-1);
        expect(toWelcome).toBeGreaterThan(read);
        // Everything that switches the community or redeems comes after: a phone with a community still gets them.
        for (const later of ["t('Switch Nodes?')", "t('Switch & Join')", 'redeemInvite(parsedCode', "AsyncStorage.setItem('beanpool_anchor_url', targetOrigin)"]) {
            expect(case2.indexOf(later), later).toBeGreaterThan(toWelcome);
        }
        // The invite step gets the link's invite and its community, as for a phone with no account.
        const route = handler.slice(handler.indexOf('const routeToWelcomeWithInvite = () => {'), handler.indexOf('// Case 1:'));
        expect(route).toMatch(/pathname: '\/welcome',\s*params: \{\s*invite: parsedCode,\s*server: extractedNodeOrigin \|\| undefined,/);
    });
});

describe('Restore over a waiting key', () => {
    it('asks first; Cancel keeps the knock\'s key, its mark and its requests; Replace takes all three', async () => {
        const key = await knockKeyForThisPhone(null);
        const knockKey = await commitKnockKey(key, 'River Kid');
        await rememberKnock(knockKey.publicKey, { url: RIVERSIDE, name: 'Riverside' });

        const asked: string[] = [];
        await expect(restoreFromWords(WORDS, RIVERSIDE, {
            confirmReplace: async (outgoing) => { asked.push(outgoing.publicKey); return false; },
            nameOnNode: async () => 'Kim',
        })).rejects.toThrow();
        expect(asked).toEqual([knockKey.publicKey]);
        expect((await loadIdentity())?.publicKey).toBe(knockKey.publicKey);
        expect(await knockKeyIsNew(knockKey.publicKey)).toBe(true);
        expect(await rememberedKnocks(knockKey.publicKey)).toHaveLength(1);
        expect(mem.async.has(ANCHOR)).toBe(false);

        const restored = await restoreFromWords(WORDS, RIVERSIDE, { confirmReplace: async () => true, nameOnNode: async () => 'Kim' });
        expect(restored.publicKey).not.toBe(knockKey.publicKey);
        expect((await loadIdentity())?.publicKey).toBe(restored.publicKey);
        expect(mem.async.get(ANCHOR)).toBe(RIVERSIDE);
        expect(mem.async.has(KNOCK_KEY_STORE_KEY)).toBe(false);
        expect(mem.async.has(KNOCKS_STORE_KEY)).toBe(false);
        expect(await knockKeyIsNew(restored.publicKey)).toBe(false);
    });
});

describe('the welcome screen joins a yes through the invite step, and Safety Backup shows the knock\'s words as new', () => {
    const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
    const handleCreate = welcome.slice(welcome.indexOf('async function handleCreate() {'), welcome.indexOf('\n    }\n', welcome.indexOf('async function handleCreate() {')));

    it('the knock\'s mark is read with the record, before the community is set, and makes the key new', () => {
        const record = handleCreate.indexOf('const joinRecord = storedIdentity ? await getPendingOnboarding() : null;');
        const mark = handleCreate.indexOf('const knockMade = storedIdentity ? await knockKeyIsNew(storedIdentity.publicKey) : false;');
        const community = handleCreate.indexOf("await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);\n                // The update screen");
        expect(record).toBeGreaterThan(-1);
        expect(mark).toBeGreaterThan(record);
        expect(community).toBeGreaterThan(mark);
        expect(handleCreate).toContain('const keyIsNew = !storedIdentity || keyMadeForThisJoin(joinRecord, storedIdentity.publicKey) || knockMade;');
    });

    it('the mark goes once the record says the words are new, never before the redeem', () => {
        const redeemed = handleCreate.indexOf('setInviteRedeemed(true);');
        const record = handleCreate.indexOf("step: 'profileSetup',");
        const forget = handleCreate.indexOf('if (knockMade) await forgetKnockKey();');
        expect(forget).toBeGreaterThan(record);
        expect(record).toBeGreaterThan(redeemed);
    });

    it('a redeem that does not land puts a waiting phone back with no community, never on one that has not taken it', () => {
        expect(handleCreate).toContain("undoCommunity = !!storedIdentity && !(await AsyncStorage.getItem('beanpool_anchor_url'));");
        const landed = handleCreate.indexOf('setInviteRedeemed(true);\n                undoCommunity = false;');
        expect(landed).toBeGreaterThan(-1);
        const caught = handleCreate.slice(handleCreate.indexOf('} catch (err: any) {'));
        expect(caught).toMatch(/if \(undoCommunity\) \{\s*await AsyncStorage\.removeItem\('beanpool_anchor_url'\)\.catch\(\(\) => \{\}\);[\s\S]*communitySwitched\(\);/);
    });

    it('a yes is joined by the invite step\'s own Next, with this phone\'s key: no join of its own', () => {
        const start = welcome.slice(welcome.indexOf('function startKnockJoin(yes: KnockYes) {'), welcome.indexOf('/** Got it, on a request'));
        expect(start).toContain('setInviteCode(yes.invite);');
        expect(start).toContain('setCreateAnchorUrl(yes.url);');
        expect(start).toContain("setMode('create');");
        expect(start).toMatch(/if \(!knockJoin \|\| mode !== 'create' \|\| inviteCode !== knockJoin\.invite \|\| createAnchorUrl !== knockJoin\.url\) return;[\s\S]*void handleCreate\(\);/);
        expect(start).not.toMatch(/redeemInvite|joinAnotherCommunity|fetch\(/);
    });
});
