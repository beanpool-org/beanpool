/**
 * Three of the gates on a vault-configured build (apps/native/.env.example; utils/vault.ts header), closed on the phone:
 *
 * - **Finding 3** (PR #1336 review): a member whose only copy is still at a community gets back in. A vault build used to
 *   restore only through the vault, and the move card showed only in Settings. Now, on the vault's SIGNED "no copy" for a
 *   sign-in, the restore goes on at the community exactly as a build without a vault does it, and the move card is
 *   offered at once. An unsigned, forged, replayed, locked or missing answer never opens that path.
 * - **N1** (confirmation review 2): "none" is believed for 7 days per account per phone; then the app-open check asks
 *   again, once. A copy the member made meanwhile on another phone is learnt of there: its holds show, and its push token
 *   reaches the copy.
 * - **N2**: a 2xx status answer that isn't a status (signed as another kind, signed without the lists, or unsigned) is
 *   never recorded as "none".
 *
 * And a build without a vault is unchanged: no request reaches the vault.
 *
 * Nothing is contacted: fake-vault.ts plays the vault, and the community keeps old-style copies (`/api/recovery/*`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn(async () => undefined) }));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(), openBrowserAsync: vi.fn(), dismissAuthSession: vi.fn(), dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false), signInAsync: vi.fn(), AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
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
vi.mock('../community-cache', () => ({ removeCommunityCaches: vi.fn(async () => {}) }));

/** The providers' sheets, stubbed: a token carrying the nonce they were given, for a fixed account per provider. */
vi.mock('../sso-signin', async (importOriginal) => {
    const real = await importOriginal<typeof import('../sso-signin')>();
    const { fakeJwt } = await import('./fake-vault');
    const subs = { google: 'google-sub-42', apple: 'apple-sub-7', facebook: 'fb-sub-9' } as const;
    const sheet = (provider: keyof typeof subs) => vi.fn(async (nonce: string) => ({ idToken: fakeJwt({ sub: subs[provider], nonce }), nonce }));
    const sheets = { google: sheet('google'), apple: sheet('apple'), facebook: sheet('facebook') };
    return {
        ...real,
        signInWithGoogle: sheets.google,
        signInWithApple: sheets.apple,
        signInWithFacebook: sheets.facebook,
        signInWithProvider: vi.fn(async (provider: keyof typeof subs, nonce: string) => ({ provider, ...await sheets[provider](nonce) })),
    };
});

import { sealSeedToSso, toEd25519Seed } from '@beanpool/core';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from '../identity';
import { hexToBytes } from '../crypto';
import {
    COMMUNITY_RESTORE_NOT_OFFERED, recoverAccountWithSso, startSsoRestore, vaultKeepsNoCopyFor, waitingSsoRestore,
} from '../sso-recovery';
import { vaultMoveOffer } from '../vault-move';
import {
    noteVaultCopy, VAULT_MESSAGES, VAULT_NONE_KEPT_MS, vaultCopyKnowledge, vaultHoldsAtOpen, vaultStatus,
} from '../vault';
import { PUSH_TOKEN_STORE_KEY } from '../storage-keys';
import {
    COMMUNITY, CommunityKeepingCopies, HOLD_MS, VAULT,
    installNetwork, noVault, useVault, type AnswerMode, type Network, type SentRequest,
} from './fake-vault';

const ANCHOR = 'beanpool_anchor_url';
const COPY_KNOWN = (pk: string) => `beanpool_vault_copy_known:${pk.toLowerCase()}`;
const SUB = 'google-sub-42';
const DAY = 24 * 60 * 60 * 1000;
/** Every way a server at the vault's address can answer without the vault's signature on this request. */
const NOT_THE_VAULTS: AnswerMode[] = ['unsigned', 'forged', 'replayed', 'other_key', 'other_kind'];
const UNVERIFIED = { reason: 'unreachable', code: 'unverified', message: VAULT_MESSAGES.unverified };

let net: Network;
let community: CommunityKeepingCopies;
let member: BeanPoolIdentity;
const originalFetch = globalThis.fetch;
const quietError = console.error;

beforeEach(async () => {
    mem.async.clear();
    mem.secure.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Failed to migrate legacy identity')) return;
        quietError(...args);
    });
    useVault();
    net = installNetwork();
    community = new CommunityKeepingCopies('Sam');
    net.community.handle = (req) => community.handle(req);
    member = await draftIdentity('Sam');
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    noVault();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const to = (origin: string) => net.sent.filter(s => s.origin === origin);
const paths = (origin: string) => to(origin).map(s => `${s.method} ${s.path}`);
const statusReads = () => to(VAULT).filter(s => s.path === '/v1/copies/status').length;
const sealedFor = (who: BeanPoolIdentity, provider = 'google', sub = SUB) =>
    sealSeedToSso(toEd25519Seed(hexToBytes(who.privateKey)), provider as 'google', sub, { words: who.mnemonic! });

/** The member's copy is still at their community, made before the vault and never moved; the vault keeps none. */
async function copyOnlyAtCommunity() {
    community.copies.set('google', await sealedFor(member));
}

const restoreAtCommunity = (provider: 'google' | 'facebook' = 'google') =>
    recoverAccountWithSso({ callsign: 'Sam', anchorUrl: COMMUNITY, provider });

describe('finding 3: on the vault\'s signed "no copy", a vault build restores at the community, as a build without a vault does', () => {
    it('the member gets back in with the community\'s copy, and the move card is offered at once', async () => {
        await copyOnlyAtCommunity();
        expect(await loadIdentity()).toBeNull();

        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'no_copy', message: VAULT_MESSAGES.noCopy });
        expect(vaultKeepsNoCopyFor('google')).toBe(true);
        // Nothing is left waiting at the vault for this sign-in.
        expect(await waitingSsoRestore()).toBeNull();

        const result = await restoreAtCommunity();
        expect(result.identity.publicKey).toBe(member.publicKey);
        expect(result.identity.mnemonic).toEqual(member.mnemonic);
        expect((await loadIdentity())?.publicKey).toBe(member.publicKey);
        expect(mem.async.get(ANCHOR)).toBe(COMMUNITY);

        // The vault was asked for a ticket and the restore, and nothing else; the community for its restore, as main does.
        expect(paths(VAULT)).toEqual(['POST /v1/ticket', 'POST /v1/restore']);
        expect(paths(COMMUNITY)).toEqual([
            'POST /api/recovery/collect', 'POST /api/recovery/collect/sso-nonce', 'POST /api/recovery/collect/sso', 'POST /api/recovery/collect/fragments',
        ]);
        // The community's sign-in carried the community's own nonce, never the vault ticket's.
        const collectSso = to(COMMUNITY).find(s => s.path === '/api/recovery/collect/sso')!;
        expect(collectSso.body.nonce).toMatch(/^collect-nonce-/);

        // The move card's offer holds the moment the account is back: the community keeps a copy, the vault none.
        expect(await vaultMoveOffer(result.identity, COMMUNITY)).toEqual({ kind: 'move', provider: 'google', communityUrl: COMMUNITY });
    });

    it('the welcome screen: the community form only on that signed answer, only for that sign-in; then Account Protection, where the card is', () => {
        const welcome = fs.readFileSync(path.resolve(__dirname, '../../app/welcome.tsx'), 'utf8');
        // The form a build without a vault shows, and in a vault build only for a sign-in the vault has no copy for.
        expect(welcome).toMatch(/if \(mode === 'ssoRecover' && \(!hasVault\(\) \|\| ssoAtCommunity\)\) \{/);
        expect(welcome.match(/setSsoAtCommunity\((?!null\))[^)]*\)/g)).toEqual(['setSsoAtCommunity(provider)']);
        expect(welcome).toMatch(/\} else if \(vaultKeepsNoCopyFor\(provider\)\) \{\n(\s*\/\/.*\n)*\s*setError\(null\);\n\s*setSsoAtCommunity\(provider\);/);
        expect(welcome).toMatch(/const offeredHere = \(p: SsoProvider\) => !hasVault\(\) \|\| ssoAtCommunity === p;/);
        for (const p of ['apple', 'google', 'facebook']) {
            expect(welcome, p).toMatch(new RegExp(`offeredHere\\('${p}'\\) && \\(\\s*<\\w+Button\\s+title="Recover with \\w+"\\s+onPress=\\{\\(\\) => handleSsoRecoverAtCommunity\\('${p}'\\)\\}`));
        }
        // Back in from the community's copy in a vault build: Account Protection, whose first card is the move.
        const at = welcome.indexOf('async function handleSsoRecoverAtCommunity(');
        const handler = welcome.slice(at, welcome.indexOf('\n    }\n', at));
        expect(handler).toMatch(
            /if \(hasVault\(\)\) \{[\s\S]*?router\.replace\(\{ pathname: '\/\(tabs\)\/settings', params: \{ section: 'protection' \} \}\);\n\s*\} else \{\n\s*router\.replace\('\/'\);\n\s*\}/,
        );
        const settings = fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf8');
        expect(settings).toMatch(/\} else if \(params\.section === 'protection'\) \{/);
        const protection = settings.slice(settings.indexOf("{mode === 'protection' && ("));
        expect(protection.slice(0, protection.indexOf('<KeeperProtectionPanel'))).toMatch(/<VaultMoveCard /);
        // And the restore itself refuses in a vault build without the vault's signed "no copy" for that sign-in.
        const recovery = fs.readFileSync(path.resolve(__dirname, '../sso-recovery.ts'), 'utf8');
        const restore = recovery.slice(recovery.indexOf('export async function recoverAccountWithSso('));
        expect(restore.slice(0, restore.indexOf('const rawCallsign'))).toMatch(
            /\n {4}if \(hasVault\(\) && !vaultKeepsNoCopyFor\(options\.provider\)\) throw new Error\(COMMUNITY_RESTORE_NOT_OFFERED\);\n/,
        );
        expect(recovery.match(/noCopyAtVault\.add\(/g)).toHaveLength(1);
        expect(recovery).toMatch(/if \(e instanceof VaultError && e\.reason === 'no_copy'\) noCopyAtVault\.add\(provider\);/);
    });

    for (const mode of NOT_THE_VAULTS) {
        it(`${mode}: a "no copy" the phone can't check never falls back: the community is not asked, and nothing is saved`, async () => {
            await copyOnlyAtCommunity();
            net.vault.answers = mode;
            net.vault.answersOn = ['/v1/restore'];
            await expect(startSsoRestore('google')).rejects.toMatchObject(UNVERIFIED);
            expect(vaultKeepsNoCopyFor('google')).toBe(false);
            await expect(restoreAtCommunity()).rejects.toThrow(COMMUNITY_RESTORE_NOT_OFFERED);
            expect(to(COMMUNITY)).toEqual([]);
            expect(await loadIdentity()).toBeNull();
        });
    }

    it('no answer, a 5xx that says "no_copy", or a locked vault never falls back either', async () => {
        await copyOnlyAtCommunity();
        const real = net.vault.handle.bind(net.vault);
        const installed = globalThis.fetch;

        // No answer to the restore (after a ticket that checked out).
        globalThis.fetch = (async (input: any, init?: any) => {
            if (String(input) === `${VAULT}/v1/restore`) throw new TypeError('Network request failed');
            return installed(input, init);
        }) as typeof fetch;
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'unreachable', message: VAULT_MESSAGES.unreachable });
        expect(vaultKeepsNoCopyFor('google')).toBe(false);
        globalThis.fetch = installed;

        // A 503 whose body says "no_copy": unsigned, so its code is nobody's word.
        net.vault.handle = (req: SentRequest) => (req.path === '/v1/restore' ? { status: 503, body: { error: 'x', code: 'no_copy' } } : real(req));
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'unreachable', code: undefined });
        expect(vaultKeepsNoCopyFor('google')).toBe(false);
        net.vault.handle = real;

        // Locked (§2.3): paused, not "no copy".
        net.vault.locked = true;
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'locked', message: VAULT_MESSAGES.paused });
        expect(vaultKeepsNoCopyFor('google')).toBe(false);

        await expect(restoreAtCommunity()).rejects.toThrow(COMMUNITY_RESTORE_NOT_OFFERED);
        expect(to(COMMUNITY)).toEqual([]);
        expect(await loadIdentity()).toBeNull();
    });

    it('it opens the community only for the sign-in the vault answered, and only while that is the vault\'s latest word', async () => {
        await copyOnlyAtCommunity();
        await expect(startSsoRestore('google')).rejects.toMatchObject({ reason: 'no_copy' });
        // Facebook was never asked about at the vault: not at the community either.
        expect(vaultKeepsNoCopyFor('facebook')).toBe(false);
        await expect(restoreAtCommunity('facebook')).rejects.toThrow(COMMUNITY_RESTORE_NOT_OFFERED);
        expect(to(COMMUNITY)).toEqual([]);

        // Google again, and this time the answer can't be checked: the earlier "no copy" is forgotten, not kept.
        net.vault.answers = 'unsigned';
        net.vault.answersOn = ['/v1/restore'];
        await expect(startSsoRestore('google')).rejects.toMatchObject(UNVERIFIED);
        expect(vaultKeepsNoCopyFor('google')).toBe(false);
        await expect(restoreAtCommunity()).rejects.toThrow(COMMUNITY_RESTORE_NOT_OFFERED);

        // And once the vault keeps a copy (moved from another phone), the vault's own restore goes on as ever: held.
        net.vault.answers = 'signed';
        net.vault.keep('google', SUB, member.publicKey, await sealedFor(member));
        expect(await startSsoRestore('google')).toMatchObject({ provider: 'google', holdId: expect.any(String) });
        expect(vaultKeepsNoCopyFor('google')).toBe(false);
        await expect(restoreAtCommunity()).rejects.toThrow(COMMUNITY_RESTORE_NOT_OFFERED);
        expect(to(COMMUNITY)).toEqual([]);
    });
});

describe('N1: "none" is believed for a week per account per phone, then the app-open check asks again, once', () => {
    const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
    const openApp = async (who: BeanPoolIdentity, times = 1) => {
        let holds: Awaited<ReturnType<typeof vaultHoldsAtOpen>> = [];
        for (let i = 0; i < times; i++) holds = await vaultHoldsAtOpen(who);
        return holds;
    };

    beforeEach(async () => {
        vi.useFakeTimers({ now: T0, toFake: ['Date'] });
        await importIdentity(member);
        mem.async.set(ANCHOR, COMMUNITY);
    });

    it('asked once; not again for 7 days; then once more, and the new "none" lasts another week', async () => {
        expect(await openApp(member)).toEqual([]);
        expect(statusReads()).toBe(1);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');

        await openApp(member, 5);
        vi.setSystemTime(T0 + VAULT_NONE_KEPT_MS - 60_000);
        await openApp(member, 5);
        expect(statusReads()).toBe(1);

        vi.setSystemTime(T0 + VAULT_NONE_KEPT_MS);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('unknown');
        await openApp(member, 5);
        expect(statusReads()).toBe(2);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');

        vi.setSystemTime(T0 + 2 * VAULT_NONE_KEPT_MS - 60_000);
        await openApp(member, 5);
        expect(statusReads()).toBe(2);
        vi.setSystemTime(T0 + 2 * VAULT_NONE_KEPT_MS);
        await openApp(member, 5);
        expect(statusReads()).toBe(3);
    });

    it('a copy made meanwhile on the member\'s other phone: learnt of within the week, its restore shown, this phone\'s push token on it', async () => {
        mem.secure.set(PUSH_TOKEN_STORE_KEY, 'ExponentPushToken[phone-b]');
        expect(await openApp(member)).toEqual([]);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');

        // Phone A moves the copy to the vault; then A is lost, and someone holding the member's Google starts a restore.
        net.vault.keep('google', SUB, member.publicKey, await sealedFor(member));
        const attacker = await draftIdentity('Mallory');
        net.vault.holds.set('hold-n1', {
            holdId: 'hold-n1', copy: `google:${SUB}`, requester: attacker.publicKey, provider: 'google',
            openedAt: Date.now(), releaseAt: Date.now() + HOLD_MS, cancelled: false, released: false,
        });
        vi.setSystemTime(T0 + 3 * DAY);
        expect(await openApp(member, 3)).toEqual([]);
        expect(statusReads()).toBe(1);

        vi.setSystemTime(T0 + VAULT_NONE_KEPT_MS + 60_000);
        expect((await openApp(member)).map(h => h.holdId)).toEqual(['hold-n1']);
        expect(statusReads()).toBe(2);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('kept');
        await vi.waitFor(() => expect(net.vault.copiesOf(member.publicKey)[0].pushTokens).toEqual(['ExponentPushToken[phone-b]']));
    });

    it('two accounts on one phone: each is asked once, and once again after its own week', async () => {
        const other = await draftIdentity('Kim');
        await openApp(member);
        vi.setSystemTime(T0 + DAY);
        await openApp(other);
        const readsBy = (who: BeanPoolIdentity) => to(VAULT).filter(s => s.path === '/v1/copies/status' && s.headers['X-Public-Key'] === who.publicKey).length;
        await openApp(member, 3);
        await openApp(other, 3);
        expect([readsBy(member), readsBy(other)]).toEqual([1, 1]);

        vi.setSystemTime(T0 + VAULT_NONE_KEPT_MS);
        await openApp(member, 3);
        await openApp(other, 3);
        expect([readsBy(member), readsBy(other)]).toEqual([2, 1]);

        vi.setSystemTime(T0 + DAY + VAULT_NONE_KEPT_MS);
        await openApp(member, 3);
        await openApp(other, 3);
        expect([readsBy(member), readsBy(other)]).toEqual([2, 2]);
    });

    it('a "none" with no date (a build before the bound), or dated by a clock since set back, is asked again once', async () => {
        mem.async.set(COPY_KNOWN(member.publicKey), '0');
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('unknown');
        await openApp(member, 3);
        expect(statusReads()).toBe(1);

        await noteVaultCopy(member.publicKey, false, T0 + 30 * DAY);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('unknown');
        await openApp(member, 3);
        expect(statusReads()).toBe(2);
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');
    });
});

describe('N2: a 2xx status answer that isn\'t a status is never recorded as "none"', () => {
    beforeEach(async () => {
        await importIdentity(member);
        mem.async.set(ANCHOR, COMMUNITY);
    });

    /** The vault's answers to a status read, each 200, none of them a status. */
    const NOT_A_STATUS: { name: string; setUp: () => void }[] = [
        {
            name: 'signed as a status, with no copies or holds (a maintenance page\'s fields)',
            setUp: () => {
                const real = net.vault.handle.bind(net.vault);
                net.vault.handle = (req: SentRequest) => (req.path === '/v1/copies/status' ? { status: 200, body: { maintenance: true } } : real(req));
            },
        },
        {
            name: 'signed as a status, with copies but no holds',
            setUp: () => {
                const real = net.vault.handle.bind(net.vault);
                net.vault.handle = (req: SentRequest) => (req.path === '/v1/copies/status' ? { status: 200, body: { copies: [] } } : real(req));
            },
        },
        {
            name: 'the vault\'s real "no copies" signed as another kind of answer',
            setUp: () => { net.vault.answers = 'other_kind'; net.vault.answersOn = ['/v1/copies/status']; },
        },
        {
            name: 'no signature at all',
            setUp: () => { net.vault.answers = 'unsigned'; net.vault.answersOn = ['/v1/copies/status']; },
        },
        {
            name: 'not JSON (an HTML page)',
            setUp: () => {
                const real = net.vault.handle.bind(net.vault);
                net.vault.handle = (req: SentRequest) => (req.path === '/v1/copies/status' ? { status: 200, body: '<html>Back soon</html>', unsigned: true } : real(req));
            },
        },
    ];

    for (const answer of NOT_A_STATUS) {
        it(`${answer.name}: taken as no answer; a phone that knew of a copy still does, and one that knew nothing asks again`, async () => {
            // The member's copy is at the vault, and the phone knows it; a second account on the phone knows nothing yet.
            net.vault.keep('google', SUB, member.publicKey, await sealedFor(member));
            await noteVaultCopy(member.publicKey, true);
            const other = await draftIdentity('Kim');
            answer.setUp();

            await expect(vaultStatus(member)).rejects.toMatchObject(UNVERIFIED);
            await expect(vaultStatus(other)).rejects.toMatchObject(UNVERIFIED);
            expect(await vaultHoldsAtOpen(member)).toEqual([]);
            expect(await vaultHoldsAtOpen(other)).toEqual([]);
            expect(await vaultCopyKnowledge(member.publicKey)).toBe('kept');
            expect(await vaultCopyKnowledge(other.publicKey)).toBe('unknown');
            expect(mem.async.has(COPY_KNOWN(other.publicKey))).toBe(false);

            // Each is asked again at the next open.
            const before = statusReads();
            await vaultHoldsAtOpen(member);
            await vaultHoldsAtOpen(other);
            expect(statusReads()).toBe(before + 2);
        });
    }

    it('the vault\'s own status still counts: "none" is recorded from a real one', async () => {
        expect(await vaultStatus(member)).toEqual({ providers: [], holds: [] });
        expect(await vaultCopyKnowledge(member.publicKey)).toBe('none');
    });
});

describe('a build without a vault is unchanged: the community restore, and not one request to the vault', () => {
    it('restores from the community with the callsign and the sign-in, as main does, and asks the vault nothing', async () => {
        noVault();
        await copyOnlyAtCommunity();
        const result = await restoreAtCommunity();
        expect(result.identity.publicKey).toBe(member.publicKey);
        expect(mem.async.get(ANCHOR)).toBe(COMMUNITY);
        // Nor does anything in this change reach it: the app-open check, a week on, with every kind of record.
        for (const v of [null, '0', `0:${Date.now() - 8 * DAY}`, '1']) {
            if (v === null) mem.async.delete(COPY_KNOWN(member.publicKey));
            else mem.async.set(COPY_KNOWN(member.publicKey), v);
            expect(await vaultHoldsAtOpen(result.identity)).toEqual([]);
        }
        expect(vaultKeepsNoCopyFor('google')).toBe(false);
        expect(to(VAULT)).toEqual([]);
        expect(net.sent.filter(s => new URL(s.url).host === new URL(VAULT).host)).toEqual([]);
    });
});
