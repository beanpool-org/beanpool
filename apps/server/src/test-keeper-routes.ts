/**
 * The keyholder fragment routes — what must be impossible to ask for over HTTP.
 *
 * The engine layer (#214) and the sign-in deposit (#220) are already covered by their own suites.
 * What is new here is that any of it is *reachable*, and the thing a route can get wrong that a
 * function cannot: exposing a storage primitive whose guard lives in a different function.
 *
 * THE HEADLINE TEST. `putShareGeneration` will store an sso fragment with whatever
 * `ssoLookupHash` the caller supplies — correct for a storage primitive, catastrophic as an
 * endpoint, because the lookup hash is what a restore searches on. #220 exists to make the node
 * derive it from a verified token. `POST /api/recovery/shares` must refuse the fragment type
 * outright, or one line of client code routes around every check #220 added.
 *
 * Handlers are driven directly, the way the other route suites do it. That means the signature
 * middleware is NOT crossed, so `ctx.state.actor` is supplied here as the middleware would supply
 * it — and every test that matters is about what the handler does with it, including refusing when
 * it is absent.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-routes.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createKeeperRoutes } from './routes/keepers.js';
import { getCurrentShares, countCurrentShares, findShareBySsoLookup } from './engine/recovery-shares.js';
import { _resetJwksCacheForTests, _clearNoncesForTests, ssoLookupHash } from './sso.js';

initStateEngine();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ─── the router under test ────────────────────────────────────────────────────────────────────

const router = createKeeperRoutes({
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, def = 20) => def,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
});

function handlerFor(method: string, path: string) {
    const layer = (router as any).stack.find((l: any) =>
        l.path === path && l.methods.includes(method.toUpperCase()));
    if (!layer) throw new Error(`${method} ${path} is not mounted — this test is looking at the wrong path`);
    return layer.stack[layer.stack.length - 1];
}

/** Invoke a mounted handler the way Koa would. `actor` undefined = an unsigned request. */
async function call(
    method: string, path: string,
    opts: { actor?: string; body?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
    const ctx: any = {
        state: opts.actor ? { actor: opts.actor } : {},
        requestBody: opts.body ?? {},
        params: opts.params ?? {},
        status: 200,
        body: undefined,
    };
    await handlerFor(method, path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

// ─── fixtures ─────────────────────────────────────────────────────────────────────────────────

let callsignSeq = 0;
function member(status = 'active'): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `kr${++callsignSeq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubkey, callsign, status);
    return { pubkey, callsign };
}

/**
 * A member brought in by a specific inviter. `member()` above seeds invited_by='genesis', which
 * makes every one of its members a FOUNDER for K3 purposes — correct for the other tests, and
 * exactly the case that must not be mistaken for an enrolable inviter.
 */
function memberInvitedBy(inviterPubkey: string): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `kr${++callsignSeq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'code')`)
      .run(pubkey, callsign, inviterPubkey);
    return { pubkey, callsign };
}

/** A stranger who signs but is not a member of this node — a minted keypair, which anyone can do. */
function outsider(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`share-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

/** K1 is RECORDED, not uploaded — the node stores that the keeper exists and none of its bytes. */
const deviceFrag = (i: number) => ({ shareIndex: i, encryptedShare: '', shareIv: '', shareTag: '' });

/** Phone + hub + a human buddy. Threshold is 3, so this is the minimum viable split. */
function generation(overrides: Record<string, unknown>[] = []): Record<string, unknown>[] {
    const base = [
        { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
        { holderType: 'hub', holderRef: 'node', ...frag(2) },
        { holderType: 'member', holderRef: 'b'.repeat(64), ephemeralPubkey: 'ZXBoZW1lcmFs', ...frag(3) },
    ];
    return overrides.length ? overrides : base;
}

// ─── a real Google token, for the sso route ───────────────────────────────────────────────────

const KID = 'kr-test-key';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const GOOGLE_SUB = '110169484474386276334';
const { publicKey: gPub, privateKey: gPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const gJwk = { ...gPub.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' } as any;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');

function googleToken(nonce: string, sub = GOOGLE_SUB): string {
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
    const p = b64({
        iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub,
        email: 'someone@gmail.com', email_verified: true, iat: now, exp: now + 3600, nonce,
    });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), gPriv).toString('base64url')}`;
}

function primeGoogle(): void {
    _resetJwksCacheForTests();
    _resetJwksCacheForTests('google', { keys: [gJwk], expiresAt: Date.now() + 3600_000 });
    _clearNoncesForTests();
}

async function main(): Promise<void> {
    console.log('\nKeyholder fragment routes\n');

    // ── THE HEADLINE: the general route must not be a way around #220 ─────────────────────────
    console.log('── the sign-in bypass ───────────────────────────────────');

    // A real victim with a real, node-derived lookup hash, so the attempt below is the actual
    // attack rather than a shape test against a made-up value.
    primeGoogle();
    const victim = member();
    const victimNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: victim.pubkey })).body.nonce;
    const deposited = await call('POST', '/api/recovery/shares/sso', {
        actor: victim.pubkey,
        body: {
            provider: 'google', idToken: googleToken(victimNonce), nonce: victimNonce,
            shares: [
                { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'sso', holderRef: 'unset', ...frag(3) },
            ],
        },
    });
    assert(deposited.status === 200 && deposited.body.provider === 'google',
        'a member can deposit a Google fragment through the verified route');
    const victimHash = getCurrentShares(victim.pubkey).find(s => s.holderType === 'sso')!.ssoLookupHash!;
    assert(await ssoLookupHash('google', GOOGLE_SUB, getCurrentShares(victim.pubkey)
        .find(s => s.holderType === 'sso')!.ssoLookupSalt!) === victimHash,
        'and the stored hash is the one the node derived from the verified sub');

    const thief = member();
    const bypass = await call('POST', '/api/recovery/shares', {
        actor: thief.pubkey,
        body: {
            shares: [
                { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'sso', holderRef: 'google', ssoLookupHash: victimHash,
                  ssoLookupSalt: 'whatever', ...frag(3) },
            ],
        },
    });
    assert(bypass.status === 400,
        'BYPASS: an sso fragment cannot be deposited through the general route');
    assert(String(bypass.body.error).includes('/api/recovery/shares/sso'),
        '...and the refusal names the route that WOULD verify it, rather than just saying no');
    assert(countCurrentShares(thief.pubkey) === 0, '...and nothing was written');
    assert(findShareBySsoLookup(victimHash)?.ownerPubkey === victim.pubkey,
        "...and the victim's Google account still resolves to the victim");

    // The same smuggle one level down: no sso fragment, but a lookup hash planted on a device row.
    // findShareBySsoLookup matches on the column with no keeper-type filter, so this row would
    // answer the lookup if it were stored.
    const smuggler = member();
    const planted = await call('POST', '/api/recovery/shares', {
        actor: smuggler.pubkey,
        body: {
            shares: [
                { holderType: 'device', holderRef: 'self', ssoLookupHash: victimHash, ...frag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'member', holderRef: 'c'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) },
            ],
        },
    });
    assert(planted.status === 400, "a lookup hash planted on a 'device' fragment is refused too");
    assert(countCurrentShares(smuggler.pubkey) === 0, '...and nothing was written');
    assert(findShareBySsoLookup(victimHash)?.ownerPubkey === victim.pubkey,
        "...and the victim's lookup is still the victim's");

    // ── the owner is the signer, never the body ───────────────────────────────────────────────
    console.log('\n── whose fragments are these ────────────────────────────');

    const impostor = member();
    const spoof = await call('POST', '/api/recovery/shares', {
        actor: impostor.pubkey,
        // The signature middleware's spoof guard only inspects TOP-LEVEL fields, and it would
        // catch this one — but the handler must not read it in the first place.
        body: { ownerPubkey: victim.pubkey, owner: victim.pubkey, shares: generation() },
    });
    assert(spoof.status === 200, 'a body-supplied owner does not break the request...');
    assert(countCurrentShares(impostor.pubkey) === 3,
        '...it is ignored — the fragments are filed under the SIGNER');
    assert(getCurrentShares(victim.pubkey).some(s => s.holderType === 'sso'),
        "...and the named victim's own generation was not touched");

    const unsigned = await call('POST', '/api/recovery/shares', { body: { shares: generation() } });
    assert(unsigned.status === 401, 'an unsigned deposit is refused');

    const stranger = await call('POST', '/api/recovery/shares', {
        actor: outsider(), body: { shares: generation() },
    });
    assert(stranger.status === 401,
        'a valid signature from a non-member is refused — a signature only proves key possession');

    const migrated = member('migrated');
    const migratedPost = await call('POST', '/api/recovery/shares', {
        actor: migrated.pubkey, body: { shares: generation() },
    });
    assert(migratedPost.status === 401, 'a migrated member cannot re-split — that account is gone');

    // ── validation ────────────────────────────────────────────────────────────────────────────
    console.log('\n── the wire shape ───────────────────────────────────────');

    const v = member();
    const bad = async (shares: unknown, what: string) => {
        const res = await call('POST', '/api/recovery/shares', { actor: v.pubkey, body: { shares } });
        assert(res.status === 400, `refused: ${what}`);
    };
    await bad(undefined, 'no shares field at all');
    await bad('not-an-array', 'shares is a string');
    await bad([], 'an empty array');
    await bad(Array.from({ length: 33 }, (_, i) => ({ holderType: 'member', holderRef: `m${i}`,
        ephemeralPubkey: 'ZQ==', ...frag(i + 1) })), 'more than 32 keepers');
    await bad([{ holderType: 'wizard', holderRef: 'gandalf', ...frag(1) }, ...generation().slice(1)],
        'an unknown keeper type');
    await bad([{ holderType: 'device', holderRef: 'self', ...frag(1), shareIndex: 1.5 },
        ...generation().slice(1)], 'a non-integer share index');
    await bad([{ holderType: 'device', ...frag(1) }, ...generation().slice(1)], 'a missing holderRef');
    await bad([{ holderType: 'device', holderRef: 'self', shareIv: 'x', shareTag: 'y', shareIndex: 1 },
        ...generation().slice(1)], 'a missing encryptedShare');
    await bad([{ holderType: 'device', holderRef: 'self', ...frag(1),
        encryptedShare: 'A'.repeat(4097) }, ...generation().slice(1)], 'an oversized fragment field');
    await bad([{ holderType: 'device', holderRef: 'z'.repeat(129), ...frag(1) },
        ...generation().slice(1)], 'an oversized holderRef');
    assert(countCurrentShares(v.pubkey) === 0, 'and not one of those wrote anything');

    // Engine refusals must surface as 400, not an unhandled 500 — these are client mistakes.
    const engineBad = async (shares: unknown, what: string) => {
        const res = await call('POST', '/api/recovery/shares', { actor: v.pubkey, body: { shares } });
        assert(res.status === 400 && typeof res.body?.error === 'string', `refused with a reason: ${what}`);
    };
    await engineBad(generation().slice(0, 2), 'fewer fragments than the threshold');
    await engineBad([{ holderType: 'device', holderRef: 'self', ...frag(1) },
                     { holderType: 'hub', holderRef: 'node', ...frag(1) },
                     { holderType: 'member', holderRef: 'd'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) }],
        'two fragments at the same x-coordinate');
    await engineBad([{ holderType: 'device', holderRef: 'self', ...frag(1) },
                     { holderType: 'device', holderRef: 'self', ...frag(2) },
                     { holderType: 'member', holderRef: 'e'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) }],
        'the same keeper twice in one generation');
    await engineBad([{ holderType: 'device', holderRef: 'self', ...frag(1) },
                     { holderType: 'hub', holderRef: 'node', ...frag(2) },
                     { holderType: 'member', holderRef: 'f'.repeat(64), ...frag(3) }],
        'a member fragment with no ephemeral key its keeper could unwrap');
    await engineBad([{ holderType: 'device', holderRef: 'self', ...frag(1) },
                     { holderType: 'hub', holderRef: 'node', ...frag(2) },
                     { holderType: 'member', holderRef: 'g'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(300) }],
        'a share index outside the Shamir byte range');
    assert(countCurrentShares(v.pubkey) === 0, 'and still nothing written after the engine refusals');

    // ── the happy path and re-splitting ───────────────────────────────────────────────────────
    console.log('\n── deposit and re-split ─────────────────────────────────');

    const ok = await call('POST', '/api/recovery/shares', { actor: v.pubkey, body: { shares: generation() } });
    assert(ok.status === 200 && ok.body.generation === 1, 'a well-formed split stores as generation 1');
    assert(ok.body.shareCount === 3 && ok.body.threshold === RECOVERY_THRESHOLD,
        'and reports the count and the threshold it was measured against');
    assert(Array.isArray(ok.body.keepers) && ok.body.keepers.length === 3,
        'and echoes back the keeper types now in force');

    const resplit = await call('POST', '/api/recovery/shares', {
        actor: v.pubkey,
        body: { shares: [...generation(), { holderType: 'member', holderRef: 'h'.repeat(64),
                ephemeralPubkey: 'ZQ==', ...frag(4) }] },
    });
    assert(resplit.body.generation === 2, 'uploading again bumps the generation');
    assert(countCurrentShares(v.pubkey) === 4, 'and only the new generation survives');

    // ── the sso route ─────────────────────────────────────────────────────────────────────────
    console.log('\n── the verified sign-in route ───────────────────────────');

    primeGoogle();
    const g = member();
    const nonceRes = await call('POST', '/api/recovery/sso-nonce', { actor: g.pubkey });
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string' && nonceRes.body.nonce.length > 20,
        'the node issues a sign-in nonce to a signed member');
    assert(Array.isArray(nonceRes.body.providers) && nonceRes.body.providers.includes('apple'),
        'and tells the client which providers it can verify');
    assert((await call('POST', '/api/recovery/sso-nonce', {})).status === 401,
        'but not to an unsigned caller — a nonce nobody owns protects nobody');

    const ssoShares = [
        { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
        { holderType: 'hub', holderRef: 'node', ...frag(2) },
        { holderType: 'sso', holderRef: 'unset', ...frag(3) },
    ];

    // A nonce issued to one member, used by another. The binding is enforced in sso.ts; this
    // proves the route passes the right subject through rather than trusting the body.
    const otherNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: v.pubkey })).body.nonce;
    const stolenNonce = await call('POST', '/api/recovery/shares/sso', {
        actor: g.pubkey,
        body: { provider: 'google', idToken: googleToken(otherNonce), nonce: otherNonce, shares: ssoShares },
    });
    assert(stolenNonce.status === 400, "a nonce issued to another member cannot be used");

    const gNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: g.pubkey })).body.nonce;
    const gOk = await call('POST', '/api/recovery/shares/sso', {
        actor: g.pubkey,
        body: { provider: 'google', idToken: googleToken(gNonce), nonce: gNonce, shares: ssoShares },
    });
    assert(gOk.status === 200 && gOk.body.provider === 'google', 'a verified Google deposit succeeds');
    assert(gOk.body.email === 's•••@gmail.com', 'and returns a masked email for the keeper list');
    assert(!JSON.stringify(gOk.body).includes(GOOGLE_SUB),
        'and the raw Google subject is not echoed back in the response');

    const replay = await call('POST', '/api/recovery/shares/sso', {
        actor: g.pubkey,
        body: { provider: 'google', idToken: googleToken(gNonce), nonce: gNonce, shares: ssoShares },
    });
    assert(replay.status === 400, 'REPLAY: the same token and nonce cannot be presented twice');

    const badProvider = await call('POST', '/api/recovery/shares/sso', {
        actor: g.pubkey,
        body: { provider: 'facebook', idToken: googleToken(gNonce), nonce: gNonce, shares: ssoShares },
    });
    assert(badProvider.status === 400, 'a paused provider is refused (D11)');

    const clientHash = await call('POST', '/api/recovery/shares/sso', {
        actor: g.pubkey,
        body: {
            provider: 'google', idToken: googleToken(gNonce), nonce: gNonce,
            shares: ssoShares.map(s => s.holderType === 'sso' ? { ...s, ssoLookupHash: victimHash } : s),
        },
    });
    assert(clientHash.status === 400,
        'and a client-supplied lookup hash is refused on the verified route as well');

    assert((await call('POST', '/api/recovery/shares/sso', { body: { provider: 'google', shares: ssoShares } })).status === 401,
        'an unsigned sign-in deposit is refused');

    // ── the public restore screen ─────────────────────────────────────────────────────────────
    console.log('\n── the public keeper summary ────────────────────────────');

    const pub = await call('GET', '/api/recovery/keepers/:callsign', { params: { callsign: v.callsign } });
    assert(pub.status === 200 && pub.body.total === 4, 'the summary reports how many fragments exist');
    assert(pub.body.canAffordToLose === 1, "and 'you can afford to lose 1' — the number users act on");
    assert(pub.body.recoverable === true, 'and whether the threshold is met at all');

    const serialised = JSON.stringify(pub.body);
    assert(!serialised.includes(v.pubkey), 'the summary never contains the owner\'s public key');
    assert(!serialised.includes('h'.repeat(64)) && !serialised.includes('b'.repeat(64)),
        "and never a keeper's — a callsign must not become a map of who trusts whom");
    assert(!serialised.includes('encryptedShare') && !serialised.includes(frag(1).encryptedShare),
        'and no fragment ciphertext leaves the node on a public read');

    const upper = await call('GET', '/api/recovery/keepers/:callsign', {
        params: { callsign: v.callsign.toUpperCase() },
    });
    assert(upper.body.total === 4, 'callsign matching is case-insensitive');

    const nobody = await call('GET', '/api/recovery/keepers/:callsign', { params: { callsign: 'no-such-callsign' } });
    assert(nobody.status === 200 && nobody.body.total === 0 && nobody.body.recoverable === false,
        'an unknown callsign gets the same shape as a member with no split, not a 404');

    const unsplit = member();
    const noSplit = await call('GET', '/api/recovery/keepers/:callsign', { params: { callsign: unsplit.callsign } });
    assert(JSON.stringify(noSplit.body.keepers) === JSON.stringify(nobody.body.keepers)
        && noSplit.body.total === nobody.body.total,
        '...and the two are indistinguishable, so the oracle is no crisper than it has to be');

    assert((await call('GET', '/api/recovery/keepers/:callsign', { params: { callsign: '  ' } })).status === 400,
        'a blank callsign is a bad request');

    // PRUNE-THEN-REUSE — the realistic ambiguity, and the one that was broken (CR).
    //
    // idx_members_callsign_unique is `WHERE status NOT IN ('migrated', 'pruned')`, and pruning
    // never clears the callsign, so a callsign IS legitimately reusable once its owner is pruned.
    // The route originally filtered on `status != 'migrated'`, matched the tombstone as well as
    // the live member, and returned a 409 for a completely unambiguous account — on the one screen
    // that exists for somebody who has just lost their phone.
    //
    // The index-drop test below did NOT catch this: it manufactures ambiguity artificially, so it
    // never exercised the path a real node produces. This one needs no index surgery at all, which
    // is exactly why it is the more valuable of the two.
    const ghost = member();
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(ghost.pubkey);
    const reused = member();
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(ghost.callsign, reused.pubkey);
    await call('POST', '/api/recovery/shares', { actor: reused.pubkey, body: { shares: generation() } });

    const reusedLookup = await call('GET', '/api/recovery/keepers/:callsign', {
        params: { callsign: ghost.callsign },
    });
    assert(reusedLookup.status === 200,
        'PRUNE-REUSE: a callsign inherited from a pruned member is NOT ambiguous');
    assert(reusedLookup.body.total === 3,
        "...and resolves to the live member's keepers, not to the tombstone");

    // The same fix is what lets the query use the partial index instead of scanning the table on
    // every hit of a public, unauthenticated endpoint.
    const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT public_key FROM members
        WHERE LOWER(callsign) = ? AND status NOT IN ('migrated', 'pruned')`)
        .all('anything') as { detail: string }[];
    assert(plan.some(p => p.detail.includes('idx_members_callsign_unique')),
        '...and the predicate matches the index, so the public lookup is a SEARCH rather than a SCAN');

    // A pruned account cannot deposit at all — its callsign now belongs to somebody else, so
    // fragments filed against it would sit under a stranger's name.
    assert((await call('POST', '/api/recovery/shares', {
        actor: ghost.pubkey, body: { shares: generation() },
    })).status === 401, 'a pruned member cannot deposit fragments — the account is a tombstone');

    // ...but a SUSPENDED one can, and that divergence from assertMemberActive is deliberate (CR).
    // Blocking it would turn a temporary sanction into a permanent loss the first time that member
    // lost their phone: moderation becoming confiscation, which Principle 8 exists to prevent.
    for (const status of ['disabled', 'suspended'] as const) {
        const sanctioned = member();
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, sanctioned.pubkey);
        const res = await call('POST', '/api/recovery/shares', {
            actor: sanctioned.pubkey, body: { shares: generation() },
        });
        assert(res.status === 200,
            `a '${status}' member CAN still maintain their keepers — recovery is not a sanction`);
    }

    // Callsigns are unique per node (#83), and the index enforces it — creating a duplicate the
    // ordinary way fails at the database, which is the correct behaviour and the reason the 409
    // branch would otherwise be untestable. The branch exists for nodes whose data predates that
    // index, so the test models one: drop the index, create the collision, restore it. The index
    // DDL is read back from sqlite_master rather than retyped, so the restore cannot drift from
    // whatever schema.sql actually built.
    const indexRow = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_members_callsign_unique'"
    ).get() as { sql: string } | undefined;
    assert(!!indexRow?.sql, 'the per-node callsign unique index exists (#83)');

    const dupA = member();
    db.exec('DROP INDEX IF EXISTS idx_members_callsign_unique');
    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(dupA.callsign, unsplit.pubkey);
    const ambiguous = await call('GET', '/api/recovery/keepers/:callsign', { params: { callsign: dupA.callsign } });
    assert(ambiguous.status === 409, 'an ambiguous callsign is refused rather than resolved arbitrarily');
    assert(!JSON.stringify(ambiguous.body).includes(dupA.pubkey)
        && !JSON.stringify(ambiguous.body).includes(unsplit.pubkey),
        '...and the refusal names neither of the two members it could have meant');

    db.prepare('UPDATE members SET callsign = ? WHERE public_key = ?').run(unsplit.callsign, unsplit.pubkey);
    db.exec(indexRow!.sql);
    assert(!!(db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'idx_members_callsign_unique'"
    ).get() as { ok: number } | undefined),
        '...and the index is back, so nothing after this point runs against a weakened schema');

    // ── the owner's own view ──────────────────────────────────────────────────────────────────
    console.log('\n── status and deletion ──────────────────────────────────');

    const status = await call('POST', '/api/recovery/shares/status', { actor: v.pubkey });
    assert(status.status === 200 && status.body.generation === 2 && status.body.total === 4,
        'the owner can read their own generation and count');
    assert(status.body.canRemoveKeeper === true,
        'and whether dropping one would still leave them recoverable');
    assert((await call('POST', '/api/recovery/shares/status', { actor: unsplit.pubkey })).body.canRemoveKeeper === false,
        '...which is false at exactly the threshold, where losing one is losing the account');
    assert((await call('POST', '/api/recovery/shares/status', {})).status === 401,
        'and an unsigned status read is refused');

    // ── telling the truth about how protected somebody actually is ────────────────────────────
    //
    // "You can afford to lose 0" is accurate and far too gentle for a member whose third keeper is
    // a person they met once. `unattendedPieces` is the number that says so.
    const hubOnly = member();
    await call('POST', '/api/recovery/shares', {
        actor: hubOnly.pubkey,
        body: {
            shares: [
                { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'member', holderRef: 'i'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) },
            ],
        },
    });
    const lonely = (await call('POST', '/api/recovery/shares/status', { actor: hubOnly.pubkey })).body;
    assert(lonely.canAffordToLose === 0 && lonely.recoverable === true,
        'phone + hub + inviter reads as recoverable with nothing to spare...');
    assert(lonely.unattendedPieces === 2 && lonely.humanKeepers === 1,
        '...but only TWO pieces are reachable without another person agreeing');
    assert(lonely.dependsOnPeople === true,
        '...so getting back in DEPENDS on one specific human, and the screen must say so');

    // The same member once they connect a sign-in keeper: now self-sufficient.
    const withSso = member();
    await call('POST', '/api/recovery/shares', {
        actor: withSso.pubkey,
        body: {
            shares: [
                { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'member', holderRef: 'j'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) },
                { holderType: 'sso', holderRef: 'unset', ...frag(4) },
            ],
        },
    });
    // The sso fragment cannot go through the general route, so that deposit was refused — which is
    // itself the guarantee this file opens with. Build the same shape through the verified path.
    primeGoogle();
    const ssoNonce = (await call('POST', '/api/recovery/sso-nonce', { actor: withSso.pubkey })).body.nonce;
    await call('POST', '/api/recovery/shares/sso', {
        actor: withSso.pubkey,
        body: {
            provider: 'google', idToken: googleToken(ssoNonce, '777-self-sufficient'), nonce: ssoNonce,
            shares: [
                { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
                { holderType: 'hub', holderRef: 'node', ...frag(2) },
                { holderType: 'member', holderRef: 'j'.repeat(64), ephemeralPubkey: 'ZQ==', ...frag(3) },
                { holderType: 'sso', holderRef: 'unset', ...frag(4) },
            ],
        },
    });
    const sufficient = (await call('POST', '/api/recovery/shares/status', { actor: withSso.pubkey })).body;
    assert(sufficient.unattendedPieces === 3 && sufficient.dependsOnPeople === false,
        'adding a sign-in keeper is what makes a member able to recover WITHOUT asking anyone');
    assert(sufficient.humanKeepers === 1,
        '...while still counting the human they have — the buddy is spare capacity, not the plan');

    const noConfirm = await call('DELETE', '/api/recovery/shares', { actor: v.pubkey, body: {} });
    assert(noConfirm.status === 400 && noConfirm.body.currentShareCount === 4,
        'deleting every fragment needs an explicit confirmation, and says what is at stake');
    assert(countCurrentShares(v.pubkey) === 4, 'and the unconfirmed attempt deleted nothing');

    const wrongConfirm = await call('DELETE', '/api/recovery/shares', {
        actor: v.pubkey, body: { confirm: 'yes' },
    });
    assert(wrongConfirm.status === 400 && countCurrentShares(v.pubkey) === 4,
        'a near-miss confirmation is still a refusal');

    assert((await call('DELETE', '/api/recovery/shares', {
        body: { confirm: 'delete-my-recovery-keepers' },
    })).status === 401, 'and an unsigned delete is refused');

    const gone = await call('DELETE', '/api/recovery/shares', {
        actor: v.pubkey, body: { confirm: 'delete-my-recovery-keepers' },
    });
    assert(gone.status === 200 && gone.body.removed === 4, 'a confirmed delete drops every fragment');
    assert(countCurrentShares(v.pubkey) === 0 && gone.body.generation === 0,
        'and the member is back to the 12 words alone');
    assert(getCurrentShares(victim.pubkey).length > 0,
        "...without touching anybody else's");

    // ── K3: who can be enrolled as the inviter keeper ─────────────────────────────────────────
    //
    // The eligible case is the easy one. What these pin is the two cases where there is NO human
    // inviter — a founding member and an admin-invited member — because that is the state the
    // client is most likely to paper over, and papering over it produces an account that says it
    // has three keepers and cannot actually be recovered.
    console.log('\n── K3: inviter keeper candidates ─────────────────────────');

    assert((await call('POST', '/api/recovery/keeper-candidates')).status === 401,
        'an unsigned candidate lookup is refused');

    const inviter = member();
    const invitee = memberInvitedBy(inviter.pubkey);
    const cand = await call('POST', '/api/recovery/keeper-candidates', { actor: invitee.pubkey });
    assert(cand.status === 200 && cand.body.inviter.eligible === true,
        'a peer-invited member can enrol their inviter');
    assert(cand.body.inviter.publicKey === inviter.pubkey,
        '...and gets the ACCOUNT key a member fragment is wrapped to');
    assert(cand.body.inviter.callsign === inviter.callsign,
        '...with the name to show them, so the client need not ask twice');
    assert(cand.body.threshold === 3, '...alongside the threshold it has to reach');

    // member() seeds invited_by='genesis' — a founding member.
    const founder = member();
    const fCand = await call('POST', '/api/recovery/keeper-candidates', { actor: founder.pubkey });
    assert(fCand.body.inviter.eligible === false && fCand.body.inviter.reason === 'founder',
        'a FOUNDING member has no inviter to hold a piece, and is told so');
    assert(fCand.body.inviter.publicKey === undefined,
        '...and is handed no key to wrap to, so the client cannot invent a keeper');

    const adminInvited = memberInvitedBy('SYSTEM');
    const aCand = await call('POST', '/api/recovery/keeper-candidates', { actor: adminInvited.pubkey });
    assert(aCand.body.inviter.eligible === false && aCand.body.inviter.reason === 'admin',
        'an ADMIN-invited member likewise has no human inviter');

    // Enrol the inviter, then ask again: this is now a re-split, not an enrolment.
    await call('POST', '/api/recovery/shares', {
        actor: invitee.pubkey,
        body: { shares: [
            { holderType: 'device', holderRef: 'self', ...deviceFrag(1) },
            { holderType: 'hub', holderRef: 'node', ...frag(2) },
            { holderType: 'member', holderRef: inviter.pubkey, ephemeralPubkey: 'eph', ...frag(3) },
        ] },
    });
    const again = await call('POST', '/api/recovery/keeper-candidates', { actor: invitee.pubkey });
    assert(again.body.inviter.eligible === false && again.body.inviter.reason === 'already_enrolled',
        'an inviter already holding a fragment is not offered again');
    assert(again.body.inviter.publicKey === inviter.pubkey,
        '...but is still named, so the UI can show who holds it');
    assert(again.body.generation === 1, '...and the generation reflects the split that happened');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Keyholder route checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
