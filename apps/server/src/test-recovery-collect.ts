/**
 * The recovery collection routes — who may drive a session, and what falls out of it.
 *
 * Covers:
 *   - POST /api/recovery/collect, by a find's hold (engine/recovery-find.ts holdFind, as POST /api/recovery/find leaves
 *     it once the sign-in is verified; the find itself, over HTTP, is test-recovery-find), and never by a name
 *   - POST /api/recovery/collect/status
 *   - POST /api/recovery/collect/hub
 *   - POST /api/recovery/collect/fragments
 *   - POST /api/recovery/collect/mine
 *   - POST /api/recovery/collect/cancel
 *   - POST /api/recovery/find-nonce and /find: a sign-in they refuse asks no provider and holds nothing
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-collect.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { createRecoveryCollectRoutes } from './routes/recovery-collect.js';
import { putShareGeneration, type KeeperShareInput } from './engine/recovery-shares.js';
import { listReleases, HUB_DELAY_MS, openCollection } from './engine/recovery-release.js';
import { holdFind } from './engine/recovery-find.js';
import { _resetJwksCacheForTests, _clearNoncesForTests, ssoLookupHash } from './sso.js';

initStateEngine();

// No provider is contacted from this suite. Every request is recorded and answered as an outage, so
// a test can also assert that a refusal was made without asking anyone.
const providerRequests: string[] = [];
globalThis.fetch = (async (input: any) => {
    providerRequests.push(typeof input === 'string' ? input : input?.url ?? String(input));
    return new Response('stubbed: test-recovery-collect contacts no provider', { status: 503 });
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const router = createRecoveryCollectRoutes({
    checkAdminAuth: async () => false,
    rateLimit: () => true,
    clampLimit: (_v: unknown, d = 20) => d,
    clampOffset: () => 0,
    activeConnections: new Map(),
    calculateAnalytics: () => ({}),
    enforceReadAuth: false,
});

function handlerFor(path: string) {
    const layer = (router as any).stack.find((l: any) => l.path === path && l.methods.includes('POST'));
    if (!layer) throw new Error(`POST ${path} is not mounted`);
    return layer.stack[layer.stack.length - 1];
}

async function call(path: string, actor: string | undefined, body: Record<string, unknown> = {}) {
    const ctx: any = { state: actor ? { actor } : {}, requestBody: body, status: 200, body: undefined };
    await handlerFor(path)(ctx, async () => {});
    return { status: ctx.status, body: ctx.body };
}

let seq = 0;
function member(): { pubkey: string; callsign: string } {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const callsign = `col${++seq}-${pubkey.slice(0, 6)}`;
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pubkey, callsign);
    return { pubkey, callsign };
}

/** A device with no identity at all — just a freshly minted keypair, which anybody can make. */
const ephemeral = (): string => crypto.randomBytes(32).toString('hex');

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`ct-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

const SSO_HASH_SALT = crypto.randomBytes(16).toString('base64url');
/** A two-layer copy: the hub's piece, and the sign-in's piece under `ssoHash`. */
function split(owner: string, ssoHash: string): number {
    const shares: KeeperShareInput[] = [
        { holderType: 'hub', holderRef: 'node', ...frag(1) },
        { holderType: 'sso', holderRef: 'google', ssoLookupHash: ssoHash,
          ssoLookupSalt: SSO_HASH_SALT, ...frag(2) },
    ];
    return putShareGeneration(owner, shares);
}

/** What POST /api/recovery/find leaves once it has verified `sub`: a hold for the device, naming the account it found. */
function heldBy(device: string, m: { pubkey: string; callsign: string }, sub: string): void {
    holdFind(device, 'google', sub, [{ publicKey: m.pubkey, callsign: m.callsign }]);
}

async function main(): Promise<void> {
    console.log('\nRecovery collection routes\n');
    _resetJwksCacheForTests(); _clearNoncesForTests();

    const OWNER_SUB = '110169484474386276334', OTHER_SUB = '110169484474386270001';
    const owner = member();
    const other = member();
    split(owner.pubkey, await ssoLookupHash('google', OWNER_SUB, SSO_HASH_SALT));
    split(other.pubkey, await ssoLookupHash('google', OTHER_SUB, SSO_HASH_SALT));
    const sessionsOf = (pk: string): number =>
        (db.prepare('SELECT COUNT(*) AS n FROM recovery_collections WHERE owner_pubkey = ?').get(pk) as { n: number }).n;

    // ── opening ───────────────────────────────────────────────────────────────────────────────
    console.log('── opening a session ────────────────────────────────────');

    const device = ephemeral();
    assert((await call('/api/recovery/collect', undefined, { candidatePublicKey: owner.pubkey })).status === 401,
        'an UNSIGNED open is refused — there would be nobody to bind the session to');
    const noKey = await call('/api/recovery/collect', device, {});
    assert(noKey.status === 400 && noKey.body?.error === 'Which account are you recovering?', 'and one that names no account is refused');
    const byName = await call('/api/recovery/collect', device, { callsign: owner.callsign });
    assert(byName.status === 400 && sessionsOf(owner.pubkey) === 0,
        `a name alone opens nothing: no account is found by a typed name (${byName.status} ${JSON.stringify(byName.body)})`);
    const noHold = await call('/api/recovery/collect', device, { candidatePublicKey: owner.pubkey });
    assert(noHold.status === 400 && noHold.body?.error === "Sign in with your account's sign-in first." && sessionsOf(owner.pubkey) === 0,
        'a key with no find behind it opens nothing, with the sign-in-first sentence');

    heldBy(device, owner, OWNER_SUB);
    const opened = await call('/api/recovery/collect', device, { candidatePublicKey: owner.pubkey });
    assert(opened.status === 200 && typeof opened.body.collectionId === 'string',
        'a device with NO identity opens a collection for the account its find named — it only has to sign');
    assert(opened.body.generation === 1 && opened.body.threshold === 2 && opened.body.progress?.collected === 1,
        '...pinned to the generation it is collecting, threshold 2, with the sign-in\'s piece released in the same request');
    const cid = opened.body.collectionId as string;
    assert((await call('/api/recovery/collect', device, { candidatePublicKey: owner.pubkey })).status === 400
        && sessionsOf(owner.pubkey) === 1, 'the hold is spent: the same collect again opens nothing');

    // ── THE PROPERTY: the id is not a credential ──────────────────────────────────────────────
    console.log('\n── the session belongs to a key ─────────────────────────');

    const thief = ephemeral();
    for (const path of ['/api/recovery/collect/status', '/api/recovery/collect/fragments', '/api/recovery/collect/hub']) {
        const stolen = await call(path, thief, { collectionId: cid });
        assert(stolen.status === 404, `knowing the id is not enough for ${path.split('/').pop()}`);
    }
    assert((await call('/api/recovery/collect/status', undefined, { collectionId: cid })).status === 404,
        '...and neither is knowing it with no signature at all');
    assert((await call('/api/recovery/collect/status', device, { collectionId: 'made-up' })).status === 404,
        'a made-up id and somebody else\'s id are indistinguishable — no existence oracle');

    const mine = await call('/api/recovery/collect/status', device, { collectionId: cid });
    assert(mine.status === 200 && mine.body.collected === 1,
        '...while the device that opened it can read its own progress');

    // ── D7 through the route ──────────────────────────────────────────────────────────────────
    console.log('\n── the hub (D7) ─────────────────────────────────────────');

    // A session opened by its sign-in: the sign-in has verified, so the hub's piece is released at once.
    const hubDevice = ephemeral();
    heldBy(hubDevice, owner, OWNER_SUB);
    const signedIn = await call('/api/recovery/collect', hubDevice, { candidatePublicKey: owner.pubkey });
    const signedInId = signedIn.body?.collectionId as string;
    const hubAtOnce = await call('/api/recovery/collect/hub', hubDevice, { collectionId: signedInId });
    assert(signedIn.status === 200 && hubAtOnce.status === 200 && hubAtOnce.body.collected === 2,
        `a session opened by its sign-in gets the hub's piece at once (${hubAtOnce.status} ${JSON.stringify(hubAtOnce.body)})`);

    // A session with no sign-in's release: one a collect by name opened before S3, still live when its community updated
    // (opened here through the engine, as that collect did). Its hub waits the 24 hours.
    const coldDevice = ephemeral();
    const coldId = openCollection(owner.pubkey, coldDevice).id;
    const coldHub = await call('/api/recovery/collect/hub', coldDevice, { collectionId: coldId });
    assert(coldHub.status === 400 && /held for/i.test(String(coldHub.body.error)),
        'with no sign-in approval the hub refuses on 24h delay');
    assert(listReleases(coldId).length === 0, '...having released nothing');
    const coldStatus = await call('/api/recovery/collect/status', coldDevice, { collectionId: coldId });
    assert(coldStatus.body?.hubReason === 'delay', '...and the session reports it is on the delay path');

    // Age past 24h
    db.prepare('UPDATE recovery_collections SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - HUB_DELAY_MS - 60_000).toISOString(), coldId);
    const agedHub = await call('/api/recovery/collect/hub', coldDevice, { collectionId: coldId });
    assert(agedHub.status === 200 && agedHub.body.collected === 1,
        '...and releases once the 24 hours are up');

    // ── fragments come from releases ──────────────────────────────────────────────────────────
    console.log('\n── fragments ────────────────────────────────────────────');

    const frags = await call('/api/recovery/collect/fragments', coldDevice, { collectionId: coldId });
    assert(frags.status === 200 && frags.body.fragments.length === 1,
        'asking for the fragments returns what was actually released');
    assert(frags.body.fragments[0].payload === frag(1).encryptedShare,
        '...as the stored hub ciphertext');
    assert(frags.body.enough === false, '...and one of two is not enough');
    const both = await call('/api/recovery/collect/fragments', hubDevice, { collectionId: signedInId });
    assert(both.status === 200 && both.body.fragments.length === 2 && both.body.enough === true
        && both.body.fragments.some((f: any) => f.holderType === 'sso' && f.payload === frag(2).encryptedShare),
        'the session opened by its sign-in holds both pieces, the sign-in\'s as deposited: enough');

    // ── a sign-in the find refuses ────────────────────────────────────────────────────────────
    console.log('\n── a sign-in the find refuses ───────────────────────────');

    const finder = ephemeral();
    const nonceRes = await call('/api/recovery/find-nonce', finder, {});
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string',
        'the recovering device gets a sign-in nonce bound to its OWN throwaway key');
    const requestsBefore = providerRequests.length;
    const facebook = await call('/api/recovery/find', finder, { provider: 'facebook', idToken: 'x', nonce: nonceRes.body.nonce });
    assert(facebook.status === 400, 'a Facebook "token" that is not an id_token is refused');
    // Until S1 a non-JWT Facebook "token" went to Graph, which vouches for any app's access token.
    assert(providerRequests.length === requestsBefore, '...without asking Graph');
    const longProvider = await call('/api/recovery/find', finder, { provider: 'x'.repeat(80_000), idToken: 'x', nonce: nonceRes.body.nonce });
    assert(longProvider.status === 400 && longProvider.body?.error === `'${'x'.repeat(40)}' is not a sign-in provider this node can verify.`,
        `a provider of 80 KB is refused, the refusal holding 40 characters of it (${String(longProvider.body?.error).length} characters)`);
    const garbage = await call('/api/recovery/find', finder, { provider: 'google', idToken: 'not-a-token', nonce: nonceRes.body.nonce });
    assert(garbage.status === 400, 'and a token that does not verify finds nothing');
    const afterRefusals = await call('/api/recovery/collect', finder, { candidatePublicKey: owner.pubkey });
    assert(afterRefusals.status === 400 && providerRequests.length === requestsBefore,
        '...holds nothing to collect with, and no provider was asked');

    // ── the owner can see and stop it ─────────────────────────────────────────────────────────
    console.log('\n── the owner\'s stop button ─────────────────────────────');

    const otherDevice = ephemeral();
    heldBy(otherDevice, other, OTHER_SUB);
    const othersId = (await call('/api/recovery/collect', otherDevice, { candidatePublicKey: other.pubkey })).body?.collectionId as string;
    const listed = await call('/api/recovery/collect/mine', owner.pubkey);
    assert(listed.status === 200 && listed.body.collections.some((c: any) => c.collectionId === cid),
        'the owner can see live recoveries against their account...');
    assert(typeof othersId === 'string' && !listed.body.collections.some((c: any) => c.collectionId === othersId),
        "...and never anybody else's");
    assert((await call('/api/recovery/collect/mine', undefined)).status === 401,
        '...and an unsigned caller sees nothing');

    assert((await call('/api/recovery/collect/cancel', other.pubkey, { collectionId: cid })).status === 400,
        'another member cannot cancel somebody else\'s recovery');
    const cancelled = await call('/api/recovery/collect/cancel', owner.pubkey, { collectionId: cid });
    assert(cancelled.status === 200 && cancelled.body.cancelled === true,
        'but the account owner can — the one person who does not have the session id');

    assert((await call('/api/recovery/collect/hub', device, { collectionId: cid })).status === 400,
        '...and the cancelled session can release nothing more');
    const deadStatus = await call('/api/recovery/collect/status', device, { collectionId: cid });
    assert(deadStatus.body.live === false && deadStatus.body.reason === 'cancelled',
        '...and reports itself cancelled rather than silently stalling');
    assert(deadStatus.body.hubEligibleAt === null,
        '...with no hub countdown to wait on');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery collection route checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
