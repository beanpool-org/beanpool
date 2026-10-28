/**
 * The community's rule for where members' copies go, on the phone (vault rethink VR2; design §5.3, §5.2; utils/copies-rule.ts,
 * utils/vault-config.ts signInCopiesAt).
 *
 * In a build WITH BeanPool's key vault:
 *   - `server`: a sign-in linked from the community's screens is kept at the community (its nonce, its deposit), and the
 *     fake vault sees no request at all;
 *   - `none`: nothing is linked and no sign-in sheet opens, in the community's words; neither the vault nor the
 *     community's copy routes are asked;
 *   - `vault`, and a community from before the rule: the vault, as before;
 *   - a community that can't be asked now, whose rule the phone never heard: nothing is linked (never a copy where the
 *     community may not want one); one whose rule the phone kept goes by it.
 *   - the move card both ways: under `server` the reverse (vault → community) is offered and finishing it removes the
 *     vault's copy only once the new one is at the community; under `none` nothing is offered; under `vault` the forward
 *     move as before, and a deposit that went elsewhere leaves the old copy.
 *   - Home's "rule changed" card: the first rule heard is only remembered, a change is shown once, by where a copy goes.
 *
 * Nothing here contacts a node, a vault or a provider: fake-vault.ts plays the vault and the community (a test one here
 * that says its rule and keeps copies), and Facebook's return is handed to the sign-in as its browser would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

(globalThis as any).__DEV__ = false;

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    openBrowserAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.delete(key); }),
    },
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));

import * as WebBrowser from 'expo-web-browser';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sealSeedToSso } from '@beanpool/core';
import { connectAndDeposit, CONNECT_RULE_MESSAGES } from '../sso-sheet-connect';
import { readNodeProfile } from '../node-profile';
import { readRecoveryCopiesRule, signInCopiesAt } from '../vault-config';
import { copiesRuleChange, copiesRuleNow, copiesRuleSeen, knownCopiesRule } from '../copies-rule';
import { finishMove, vaultMoveOffer } from '../vault-move';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';
import { COMMUNITY, CommunityKeepingCopies, installNetwork, noVault, useVault, VAULT, type Network } from './fake-vault';

const SEED = new Uint8Array(32).fill(7);
const MEMBER = {
    publicKey: Buffer.from(ed25519.getPublicKey(SEED)).toString('hex'),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

/** A community that says its rule in its info (or nothing, `rule` undefined: one from before the rule) and keeps copies. */
class RuledCommunity extends CommunityKeepingCopies {
    rule: string | undefined = 'vault';
    /** No answer to anything, as a community that is down. */
    down = false;
    handle(req: any): { status: number; body: unknown } {
        if (this.down) return { status: 503, body: { error: 'down' } };
        if (req.method === 'GET' && req.path === '/api/community/info') {
            return { status: 200, body: { profile: 'local', features: {}, requestSigning: 2, ...(this.rule === undefined ? {} : { recoveryCopies: this.rule }) } };
        }
        return super.handle(req);
    }
}

/** A Facebook id_token carrying `nonce`. Unsigned: the vault and the community here read its claims only. */
function fbIdToken(nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'RS256', kid: 'fb-kid-1' })}.${b64({ iss: 'https://www.facebook.com', sub: '10229876543210987', nonce })}.c2ln`;
}
function facebookSaysYes(): void {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (authUrl: string) => {
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        return { type: 'success', url: `https://beanpool.org/auth/facebook#${new URLSearchParams({ id_token: fbIdToken(nonce), state: nonce })}` } as any;
    });
}

let net: Network;
let community: RuledCommunity;
const atVault = () => net.sent.filter((s) => s.origin === VAULT);
const atCommunity = () => net.sent.filter((s) => s.origin === COMMUNITY).map((s) => `${s.method} ${s.path}`);

let originalFetch: typeof fetch;
beforeEach(() => {
    originalFetch = globalThis.fetch;
    mem.clear();
    mem.set('beanpool_anchor_url', COMMUNITY);
    useVault();
    vi.useFakeTimers();
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    net = installNetwork();
    community = new RuledCommunity('member');
    net.community.handle = (req) => community.handle(req) as any;
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    noVault();
});

/** The sheet's connect for the community the phone is on, as the sheet runs it. */
async function connect(url: string | null = COMMUNITY): Promise<{ value?: KeeperEnrolmentResult; error?: unknown }> {
    const outcome = connectAndDeposit({
        provider: 'facebook', url, identity: MEMBER, phoneLock: null, onSignedIn: () => {}, signal: new AbortController().signal,
    }).then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(30_000);
    return outcome;
}

describe("the info answer's rule", () => {
    it('reads vault, server and none; a server that says nothing is the default; anything else keeps no copy', () => {
        expect(readNodeProfile({ recoveryCopies: 'server' })?.recoveryCopies).toBe('server');
        expect(readNodeProfile({ recoveryCopies: 'none' })?.recoveryCopies).toBe('none');
        expect(readNodeProfile({})?.recoveryCopies).toBe('vault');
        expect(readRecoveryCopiesRule('everywhere')).toBe('none');
        expect(readRecoveryCopiesRule(7)).toBe('none');
    });

    it('a vault build keeps copies where the rule says; with no rule, where it always did', () => {
        expect(signInCopiesAt('vault')).toBe('vault');
        expect(signInCopiesAt('server')).toBe('community');
        expect(signInCopiesAt('none')).toBe('none');
        expect(signInCopiesAt()).toBe('vault');
        noVault();
        expect(signInCopiesAt('vault')).toBe('community');
        expect(signInCopiesAt('server')).toBe('community');
        expect(signInCopiesAt('none')).toBe('none');
    });
});

describe('linking a sign-in, by the community\'s rule, in a build with the key vault', () => {
    it('server: kept at the community, with its nonce, and the vault sees no request', async () => {
        community.rule = 'server';
        facebookSaysYes();
        const { value, error } = await connect();
        expect(error).toBeUndefined();
        expect(value?.error).toBeUndefined();
        expect(value?.keptAt).toBe('community');
        expect(value?.enrolledSso).toEqual(['facebook']);
        expect([...community.copies.keys()]).toEqual(['facebook']);
        expect(atCommunity()).toEqual(expect.arrayContaining(['GET /api/community/info', 'POST /api/recovery/sso-nonce', 'POST /api/recovery/shares/sso']));
        expect(atVault()).toEqual([]);
    });

    it('none: nothing linked and no sheet opened, in its words; neither the vault nor the copy routes are asked', async () => {
        community.rule = 'none';
        facebookSaysYes();
        const { value, error } = await connect();
        expect(error).toBeUndefined();
        expect(value?.error).toBe(CONNECT_RULE_MESSAGES.none);
        expect(value?.enrolled).toEqual([]);
        expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
        expect(atVault()).toEqual([]);
        expect(atCommunity()).toEqual(['GET /api/community/info']);
        expect(community.copies.size).toBe(0);
    });

    it('vault: kept at the vault, as before; the community is asked only for its rule', async () => {
        community.rule = 'vault';
        facebookSaysYes();
        const { value } = await connect();
        expect(value?.error).toBeUndefined();
        expect(value?.keptAt).toBe('vault');
        expect(net.vault.copiesOf(MEMBER.publicKey).map((c) => c.provider)).toEqual(['facebook']);
        expect(atCommunity()).toEqual(['GET /api/community/info']);
    });

    it('a community from before the rule (its info says nothing): the vault, as before', async () => {
        community.rule = undefined;
        facebookSaysYes();
        const { value } = await connect();
        expect(value?.keptAt).toBe('vault');
        expect(atVault().length).toBeGreaterThan(0);
    });

    it('a community that can\'t be asked, whose rule this phone never heard: nothing linked, nothing sent anywhere else', async () => {
        community.down = true;
        facebookSaysYes();
        const { value } = await connect();
        expect(value?.error).toBe(CONNECT_RULE_MESSAGES.unknown);
        expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
        expect(atVault()).toEqual([]);
    });

    it('…and one whose rule this phone kept goes by it: none kept, no answer now, still nothing linked', async () => {
        community.rule = 'none';
        expect(await knownCopiesRule(COMMUNITY)).toBeNull();
        await connect();
        expect(await knownCopiesRule(COMMUNITY)).toBe('none');
        community.down = true;
        const { value } = await connect();
        expect(value?.error).toBe(CONNECT_RULE_MESSAGES.none);
        expect(atVault()).toEqual([]);
    });

    it('with no community at all (no address), the build\'s own place, as before the rule', async () => {
        facebookSaysYes();
        const { value } = await connect(null);
        expect(value?.keptAt).toBe('vault');
        expect(atCommunity()).toEqual([]);
    });
});

describe('the move card, both ways', () => {
    async function vaultKeeps(provider: string): Promise<void> {
        const sealed = await sealSeedToSso(SEED, provider as any, 'sub-1');
        net.vault.keep(provider, 'sub-1', MEMBER.publicKey, sealed);
    }
    async function offer() {
        const p = vaultMoveOffer(MEMBER, COMMUNITY);
        await vi.advanceTimersByTimeAsync(30_000);
        return p;
    }
    /** The rule this phone has heard there, as the screens that read it keep it. */
    async function heard(rule: string): Promise<void> {
        community.rule = rule;
        const p = copiesRuleNow(COMMUNITY);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await p).toBe(rule);
        net.sent.length = 0;
    }

    it('server: the reverse is offered for a copy the vault keeps and the community doesn\'t; finishing it removes the vault\'s', async () => {
        await heard('server');
        await vaultKeeps('google');
        const o = await offer();
        expect(o).toEqual({ kind: 'keep-here', provider: 'google', communityUrl: COMMUNITY });
        const kept = { enrolled: ['sso'], generation: 1, skipped: [], available: 1, enrolledSso: ['google'], keptAt: 'community' } as KeeperEnrolmentResult;
        const done = finishMove(MEMBER, o!, kept);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await done).toBe('removed');
        expect(net.vault.copiesOf(MEMBER.publicKey)).toEqual([]);
    });

    it('server: a deposit that landed at the vault instead (the rule changed meanwhile) leaves the vault\'s copy', async () => {
        await heard('server');
        await vaultKeeps('google');
        const o = await offer();
        const atTheVault = { enrolled: ['sso'], generation: null, skipped: [], available: 1, enrolledSso: ['google'], keptAt: 'vault' } as KeeperEnrolmentResult;
        expect(await finishMove(MEMBER, o!, atTheVault)).toBe('kept');
        expect(net.vault.copiesOf(MEMBER.publicKey).map((c) => c.provider)).toEqual(['google']);
        expect(atVault().filter((s) => s.path === '/v1/copies/delete')).toEqual([]);
    });

    it('server: a copy the community keeps already is not offered again', async () => {
        await heard('server');
        await vaultKeeps('google');
        community.copies.set('google', await sealSeedToSso(SEED, 'google', 'sub-1'));
        expect(await offer()).toBeNull();
    });

    it('none: nothing is offered, either way', async () => {
        await heard('none');
        await vaultKeeps('google');
        community.copies.set('facebook', await sealSeedToSso(SEED, 'facebook', 'sub-2'));
        expect(await offer()).toBeNull();
    });

    it('vault: the forward move as before; a deposit kept at the community instead leaves the community\'s copy', async () => {
        await heard('vault');
        community.copies.set('facebook', await sealSeedToSso(SEED, 'facebook', 'sub-2'));
        const o = await offer();
        expect(o).toEqual({ kind: 'move', provider: 'facebook', communityUrl: COMMUNITY });
        const elsewhere = { enrolled: ['sso'], generation: 1, skipped: [], available: 1, enrolledSso: ['facebook'], keptAt: 'community' } as KeeperEnrolmentResult;
        expect(await finishMove(MEMBER, o!, elsewhere)).toBe('kept');
        expect([...community.copies.keys()]).toEqual(['facebook']);
    });
});

describe('Home\'s "rule changed" card', () => {
    const pk = MEMBER.publicKey;
    /** The community's answer kept, as the tab strip reads it afresh at each start. */
    async function appOpens(rule: string) {
        community.rule = rule;
        const p = copiesRuleNow(COMMUNITY);
        await vi.advanceTimersByTimeAsync(30_000);
        await p;
    }
    async function change() {
        const sentBefore = net.sent.length;
        const p = copiesRuleChange(pk, COMMUNITY);
        await vi.advanceTimersByTimeAsync(30_000);
        const found = await p;
        // Home's one request for the whole screen: the card asks the community nothing of its own.
        expect(net.sent.length).toBe(sentBefore);
        return found;
    }

    it('nothing heard yet: no card; the first rule heard is only remembered; the same one again says nothing', async () => {
        expect(await change()).toBeNull();
        await appOpens('vault');
        expect(await change()).toBeNull();
        expect(await change()).toBeNull();
    });

    it('a change is shown, by where a copy goes, until it is put away', async () => {
        await appOpens('vault');
        await change();
        await appOpens('server');
        expect(await change()).toEqual({ url: COMMUNITY, rule: 'server', from: 'vault', to: 'community' });
        expect(await change()).toEqual({ url: COMMUNITY, rule: 'server', from: 'vault', to: 'community' });
        await copiesRuleSeen(pk, COMMUNITY, 'server');
        expect(await change()).toBeNull();
        await appOpens('none');
        expect(await change()).toEqual({ url: COMMUNITY, rule: 'none', from: 'community', to: 'none' });
    });

    it('a build without the vault is never told of vault ↔ server: copies stay at the community either way', async () => {
        noVault();
        await appOpens('vault');
        await change();
        await appOpens('server');
        expect(await change()).toBeNull();
        await appOpens('none');
        expect(await change()).toEqual({ url: COMMUNITY, rule: 'none', from: 'community', to: 'none' });
    });
});
