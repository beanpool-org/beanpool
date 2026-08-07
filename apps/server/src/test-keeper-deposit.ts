/**
 * Depositing a sign-in (K4) keeper fragment — Google and Apple.
 *
 * The test that matters is the account-takeover one: a client that supplies its own
 * `ssoLookupHash` could index a fragment under somebody else's provider account and then recover
 * it by signing in as itself. The lookup hash is what a restore searches on, so a
 * client-controlled value is a client-controlled takeover. Everything else here is scaffolding
 * around proving that the node derives it from a token it verified.
 *
 * The second property, added with Apple: `holderRef` is the provider that VERIFIED, never the one
 * the request named. A Google token deposited as 'apple' must fail rather than file a Google
 * fragment under Apple, which nothing would notice until the member tried to recover with the
 * wrong account.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-deposit.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import {
    issueNonce, ssoLookupHash, _resetJwksCacheForTests, _clearNoncesForTests, type SsoProvider,
} from './sso.js';
import { depositSsoKeeperGeneration, maskEmail } from './engine/keeper-deposit.js';
import { getCurrentShares, findShareBySsoLookup, listKeeperTypes } from './engine/recovery-shares.js';
import type { KeeperShareInput } from './engine/recovery-shares.js';

initStateEngine();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<void> {
    run++;
    try { await fn(); console.error(`✗ ${msg} — it RESOLVED`); }
    catch { passed++; console.log(`✓ ${msg}`); }
}

const KID = 'kd-test-key';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

interface Fixture {
    provider: SsoProvider;
    label: string;
    aud: string;
    sub: string;
    jwk: any;
    mint(sub: string, nonce: string, extra?: Record<string, unknown>): string;
}

function makeFixture(provider: SsoProvider, iss: string, aud: string, sub: string, email: string): Fixture {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;
    return {
        provider,
        label: provider === 'google' ? 'Google' : 'Apple',
        aud,
        sub,
        jwk,
        mint(s, nonce, extra = {}) {
            const now = Math.floor(Date.now() / 1000);
            const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
            const p = b64({ iss, aud, sub: s, email, email_verified: true,
                            iat: now, exp: now + 3600, nonce, ...extra });
            return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), privateKey).toString('base64url')}`;
        },
    };
}

const GOOGLE = makeFixture('google', 'https://accounts.google.com',
    '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com',
    '110169484474386276334', 'someone@gmail.com');

const APPLE = makeFixture('apple', 'https://appleid.apple.com',
    'org.beanpool.pillar',
    '001234.fedcba9876543210fedcba9876543210.0123', 'someone@privaterelay.appleid.com');

/** Prime BOTH caches every time, so a cross-provider attempt fails on its merits rather than on a
 *  cold cache — the shared kid means a leaky cache would otherwise look like a pass. */
function prime(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [GOOGLE.jwk], expiresAt: Date.now() + 3600_000 });
    _resetJwksCacheForTests('apple', { keys: [APPLE.jwk], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
}

function memberKey(): string {
    const { publicKey: pk } = crypto.generateKeyPairSync('ed25519');
    const hex = (pk.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(hex, `kd-${hex.slice(0, 8)}`);
    return hex;
}

/** A plausible generation: phone + hub + the sign-in fragment. Threshold is 3. */
function generation(overrides: Partial<KeeperShareInput> = {}): KeeperShareInput[] {
    const frag = (i: number) => ({
        shareIndex: i,
        encryptedShare: Buffer.from(`share-${i}`).toString('base64'),
        shareIv: Buffer.from(`iv-${i}`).toString('base64'),
        shareTag: Buffer.from(`tag-${i}`).toString('base64'),
    });
    return [
        { holderType: 'device', holderRef: 'self', ...frag(1) },
        { holderType: 'hub', holderRef: 'node', ...frag(2) },
        { holderType: 'sso', holderRef: 'unset', ...frag(3), ...overrides },
    ];
}

/**
 * The per-provider battery. Returns the owner and their stored sso row so the cross-provider
 * checks below can reuse a real victim.
 */
async function battery(f: Fixture): Promise<{ owner: string; ssoRow: KeeperShareInput }> {
    console.log(`\n── ${f.label} ────────────────────────────────────────────`);
    const { provider, sub, mint } = f;

    // ── the happy path ────────────────────────────────────────────────────────────────────────
    prime();
    const owner = memberKey();
    let nonce = issueNonce(owner);
    const result = await depositSsoKeeperGeneration({
        provider, ownerPubkey: owner, shares: generation(), idToken: mint(sub, nonce), nonce,
    });
    assert(result.generation === 1, 'a first deposit creates generation 1');
    assert(result.shareCount === 3, 'and stores all three fragments together');
    assert(result.provider === provider, 'and reports the provider that verified');
    assert(result.email === (provider === 'google' ? 's•••@gmail.com' : 's•••@privaterelay.appleid.com'),
        'and returns a masked email for display');

    const stored = getCurrentShares(owner);
    assert(stored.length === 3, 'the generation reads back with every fragment');
    const ssoRow = stored.find(s => s.holderType === 'sso')!;
    assert(ssoRow.holderRef === provider, `holder_ref is '${provider}', not the subject`);
    assert(!!ssoRow.ssoLookupHash && !!ssoRow.ssoLookupSalt, 'the node filled in the lookup hash and salt');
    assert(!JSON.stringify(stored).includes(sub), 'and the raw subject appears NOWHERE in storage');

    // The hash must be the one a restore flow would compute from the same verified sub.
    const recomputed = await ssoLookupHash(provider, sub, ssoRow.ssoLookupSalt!);
    assert(recomputed === ssoRow.ssoLookupHash, 'the stored hash is reproducible from the sub + salt');
    assert(findShareBySsoLookup(recomputed)?.ownerPubkey === owner,
        "so signing in with that account finds exactly this member's fragment");

    assert(listKeeperTypes(owner).some(k => k.holderType === 'sso'),
        "and the keeper shows up in the member's keeper list");

    // ── the takeover this file exists to stop ─────────────────────────────────────────────────
    prime();
    const attacker = memberKey();
    const victimHash = ssoRow.ssoLookupHash!;
    nonce = issueNonce(attacker);
    await rejects(() => depositSsoKeeperGeneration({
        provider,
        ownerPubkey: attacker,
        shares: generation({ ssoLookupHash: victimHash, ssoLookupSalt: ssoRow.ssoLookupSalt }),
        idToken: mint('999-attackers-own-account', nonce),
        nonce,
    }), 'TAKEOVER: a client supplying its own lookup hash is REFUSED, not silently corrected');

    assert(findShareBySsoLookup(victimHash)?.ownerPubkey === owner,
        "and the victim's lookup still resolves to the victim");

    // The same smuggling attempt, but hidden on a NON-sso fragment (CR finding on #220). The
    // original check only inspected the sso share, so a hash on a 'device' or 'hub' fragment was
    // persisted verbatim — and findShareBySsoLookup matches on the column alone, with no
    // holder_type filter, so the planted row would answer the lookup.
    prime();
    const smuggler = memberKey();
    nonce = issueNonce(smuggler);
    for (const holderType of ['device', 'hub'] as const) {
        const shares = generation();
        const target = shares.find(x => x.holderType === holderType)!;
        target.ssoLookupHash = victimHash;
        target.ssoLookupSalt = ssoRow.ssoLookupSalt;
        await rejects(() => depositSsoKeeperGeneration({
            provider, ownerPubkey: smuggler, shares, idToken: mint('999-attacker', nonce), nonce,
        }), `SMUGGLING: a lookup hash hidden on a '${holderType}' fragment is refused too`);
    }
    assert(getCurrentShares(smuggler).length === 0, 'and nothing was written by those attempts');
    assert(findShareBySsoLookup(victimHash)?.ownerPubkey === owner,
        "the victim's lookup is still the victim's after every smuggling attempt");

    // ── the nonce binding ─────────────────────────────────────────────────────────────────────
    prime();
    const memberA = memberKey();
    const memberB = memberKey();
    const nonceA = issueNonce(memberA);
    await rejects(() => depositSsoKeeperGeneration({
        provider, ownerPubkey: memberB, shares: generation(), idToken: mint(sub, nonceA), nonce: nonceA,
    }), 'a nonce issued to one member cannot be used by another');

    // ...and A's nonce survived B's attempt, which is the whole reason it is not consumed on failure.
    const stillWorks = await depositSsoKeeperGeneration({
        provider, ownerPubkey: memberA, shares: generation(), idToken: mint(sub, nonceA), nonce: nonceA,
    });
    assert(stillWorks.generation === 1, "and A's own sign-in still works afterwards");

    // ── re-splitting ──────────────────────────────────────────────────────────────────────────
    prime();
    nonce = issueNonce(owner);
    const second = await depositSsoKeeperGeneration({
        provider, ownerPubkey: owner, shares: generation(), idToken: mint(sub, nonce), nonce,
    });
    assert(second.generation === 2, 're-depositing bumps the generation');
    assert(getCurrentShares(owner).length === 3, 'and only the new generation remains');
    const gen2 = getCurrentShares(owner).find(s => s.holderType === 'sso')!;
    assert(gen2.ssoLookupSalt !== ssoRow.ssoLookupSalt,
        'with a fresh salt, so the same account produces an unrelated hash each generation');
    assert(findShareBySsoLookup(gen2.ssoLookupHash!)?.ownerPubkey === owner,
        'and the new hash resolves to the same member');

    // ── shape ─────────────────────────────────────────────────────────────────────────────────
    prime();
    const shaped = memberKey();
    nonce = issueNonce(shaped);
    await rejects(() => depositSsoKeeperGeneration({
        provider, ownerPubkey: shaped,
        shares: generation().filter(s => s.holderType !== 'sso'),
        idToken: mint(sub, nonce), nonce,
    }), 'a deposit with no sso fragment is refused');

    prime();
    nonce = issueNonce(shaped);
    await rejects(() => depositSsoKeeperGeneration({
        provider, ownerPubkey: shaped,
        shares: [...generation(), { holderType: 'sso', holderRef: 'x', shareIndex: 4,
                 encryptedShare: 'e', shareIv: 'i', shareTag: 't' }],
        idToken: mint(sub, nonce), nonce,
    }), 'a deposit with two sso fragments is refused');

    // Distinct messages, because the two cases need different actions from the caller (CR).
    const msgs: string[] = [];
    for (const shares of [generation().filter(x => x.holderType !== 'sso'),
                          [...generation(), { holderType: 'sso' as const, holderRef: 'x', shareIndex: 4,
                           encryptedShare: 'e', shareIv: 'i', shareTag: 't' }]]) {
        prime();
        const n = issueNonce(shaped);
        try {
            await depositSsoKeeperGeneration({ provider, ownerPubkey: shaped, shares, idToken: mint(sub, n), nonce: n });
        } catch (e) { msgs.push((e as Error).message); }
    }
    assert(msgs.length === 2 && msgs[0] !== msgs[1],
        'and the no-sso and too-many-sso cases report DIFFERENT messages');

    prime();
    nonce = issueNonce(shaped);
    await rejects(() => depositSsoKeeperGeneration({
        provider, ownerPubkey: shaped, shares: generation(), idToken: mint(sub, 'wrong-nonce'), nonce,
    }), 'a token whose nonce does not match is refused');

    prime();
    nonce = issueNonce(shaped);
    await rejects(() => depositSsoKeeperGeneration({
        provider, ownerPubkey: '', shares: generation(), idToken: mint(sub, nonce), nonce,
    }), 'a deposit with no signed-in member is refused');

    // Storage must be untouched by every one of those refusals.
    assert(getCurrentShares(shaped).length === 0,
        'and NONE of those refusals wrote anything — a failed sign-in leaves existing keepers alone');

    return { owner, ssoRow };
}

async function main(): Promise<void> {
    console.log('\nSign-in keeper deposit\n');

    const google = await battery(GOOGLE);
    const apple = await battery(APPLE);

    // ── the provider is verified, not taken from the request ──────────────────────────────────
    console.log('\n── provider integrity ───────────────────────────────────');

    prime();
    const crossed = memberKey();
    let nonce = issueNonce(crossed);
    await rejects(() => depositSsoKeeperGeneration({
        provider: 'apple', ownerPubkey: crossed, shares: generation(),
        idToken: GOOGLE.mint(GOOGLE.sub, nonce), nonce,
    }), "a Google token deposited as 'apple' is refused rather than filed under Apple");

    prime();
    nonce = issueNonce(crossed);
    await rejects(() => depositSsoKeeperGeneration({
        provider: 'google', ownerPubkey: crossed, shares: generation(),
        idToken: APPLE.mint(APPLE.sub, nonce), nonce,
    }), "...and an Apple token deposited as 'google' likewise");

    // D11 paused Facebook and GitHub. A route forwarding a body field must not turn one into a
    // stored holder_ref, which is member-visible and part of a UNIQUE constraint.
    prime();
    nonce = issueNonce(crossed);
    await rejects(() => depositSsoKeeperGeneration({
        provider: 'facebook' as SsoProvider, ownerPubkey: crossed, shares: generation(),
        idToken: GOOGLE.mint(GOOGLE.sub, nonce), nonce,
    }), 'an unsupported provider name is refused before it can become a holder_ref');

    assert(getCurrentShares(crossed).length === 0, 'and none of those wrote anything');

    // ── the two providers coexist ─────────────────────────────────────────────────────────────
    //
    // Each deposit is a whole new generation (#214), so adding the second provider REPLACES the
    // first one's generation rather than joining it. That is the constraint the route has to
    // carry: the client re-splits with both fragments in one call, it does not deposit twice.
    console.log('\n── coexistence ──────────────────────────────────────────');

    prime();
    const both = memberKey();
    nonce = issueNonce(both);
    await depositSsoKeeperGeneration({
        provider: 'google', ownerPubkey: both, shares: generation(),
        idToken: GOOGLE.mint(GOOGLE.sub, nonce), nonce,
    });
    const afterGoogle = getCurrentShares(both).find(s => s.holderType === 'sso')!;

    nonce = issueNonce(both);
    await depositSsoKeeperGeneration({
        provider: 'apple', ownerPubkey: both, shares: generation(),
        idToken: APPLE.mint(APPLE.sub, nonce), nonce,
    });
    const afterApple = getCurrentShares(both).find(s => s.holderType === 'sso')!;

    assert(afterApple.holderRef === 'apple', 'depositing Apple after Google leaves Apple as the keeper');
    assert(findShareBySsoLookup(afterGoogle.ssoLookupHash!) === null,
        '...and the superseded Google lookup no longer resolves — a second deposit REPLACES, it does not add');
    assert(findShareBySsoLookup(afterApple.ssoLookupHash!)?.ownerPubkey === both,
        'while the new one does');

    // Two different people, one on each provider, must not collide.
    assert(google.ssoRow.ssoLookupHash !== apple.ssoRow.ssoLookupHash,
        'lookups from the two providers are distinct values');
    assert(findShareBySsoLookup(google.ssoRow.ssoLookupHash!) === null,
        "the first Google owner's generation-1 lookup was superseded by their own re-split");

    // ── masking ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── masking ──────────────────────────────────────────────');
    assert(maskEmail('martin@cytec.com.au') === 'm•••@cytec.com.au', 'emails are masked for display');
    assert(maskEmail(undefined) === undefined, 'a missing email masks to nothing rather than throwing');
    assert(maskEmail('nonsense') === undefined, 'and so does a value with no @');
    assert(maskEmail('  martin@cytec.com.au  ') === 'm•••@cytec.com.au',
        'and surrounding whitespace does not become the initial (CR)');
    assert(maskEmail('@nolocalpart.com') === undefined, 'an address with no local part masks to nothing');

    // Apple returns the email on first authorization only, so a re-deposit legitimately has none.
    // The result must carry undefined rather than fail — the keeper list renders "Apple" alone.
    prime();
    const silent = memberKey();
    nonce = issueNonce(silent);
    const noEmail = await depositSsoKeeperGeneration({
        provider: 'apple', ownerPubkey: silent, shares: generation(),
        idToken: APPLE.mint(APPLE.sub, nonce, { email: undefined, email_verified: undefined }), nonce,
    });
    assert(noEmail.email === undefined && noEmail.generation === 1,
        'an Apple deposit with no email still succeeds — Apple omits it after the first authorization');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Sign-in keeper deposit checks PASSED (Google + Apple).');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
