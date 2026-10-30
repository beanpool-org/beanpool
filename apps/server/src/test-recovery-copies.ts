/**
 * Where members' copies go: the community's rule (vault rethink VR2; scratch/fable-design/DESIGN-vault-rethink-fable.md
 * §5.3, §5.5; config/recovery-copies.ts). Over REAL HTTPS through the real signature middleware, every member request
 * signed by the member's own key. No provider, no vault and no host but this machine is contacted: the Google keys are a
 * test key primed into the node's cache, and every other fetch is refused.
 *
 *   1. The rule as the community says it: /api/community/info `recoveryCopies` is `vault` with no row, and How this
 *      community works reads it, from the default.
 *   2. An owner changes it under How this community works: written through its setter (the row, `server` or `none`; the
 *      default removes it), one log line, every member told in the fixed sentence, the community settings record carries
 *      it, and the info says it. A value it can't take → 400, an admin → 403, a standby → 409: nothing written.
 *   3. `none` at the sign-in copy routes: the nonce and the deposit → 409 `no_copies_here`, nothing stored; a copy kept
 *      from before stays the member's: its status lists it and its delete removes it. `server`: the nonce and a deposit of
 *      a real sealed copy, with a sign-in the node checks, are kept here.
 *   4. The open door (the global kind, the vault's ticket keys pinned): the door lists the keys only under `vault`. Under
 *      `server` the nonce answer says `vault: null`, a ticket join → 401 ticket_unsupported (nobody joins), and a join
 *      carrying its copy keeps it here. Under `none` a join with a copy stands, says `no_copies_here` and keeps none;
 *      adding a sign-in later does the same.
 *   5. A release's copy is kept 30 days, then emptied (Marty's pick 6): the row stays, as the record of the release, and
 *      reads as the same kind of copy; a release 29 days old, and one in a session still live, keep theirs; the boot's
 *      wrap leaves an emptied one alone; a second run empties nothing; a standby writes nothing. The device of an old
 *      completed or expired session whose copy went is answered by the release rules at its routes, its sign-in too.
 *      With a reader holding the WAL (a copy being served to a standby), the sweep answers at once, never waiting out
 *      the busy timeout, and once the reader lets go the WAL is emptied and the copy is in neither file.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-recovery-copies.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The flags the server reads at import, set before anything is imported (every import below is dynamic).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.FACEBOOK_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;
// A directory push that got past every hold-back would go here: a closed port on this machine, never the registry.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:9/directory-register';

// No host but this machine: a provider's keys are primed below, so a fetch to one means a sign-in went unprimed.
const realFetch = globalThis.fetch;
let outsideFetches = 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return realFetch(input, init);
    outsideFetches++;
    throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
}) as typeof fetch;

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

type Id = { pk: string; priv: crypto.KeyObject; seed: Uint8Array; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;
const DAY = 86_400_000;

function keypair(name: string): Id {
    const seed = new Uint8Array(crypto.randomBytes(32));
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8',
    });
    const pk = (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv, seed, name };
}

// ── A Google sign-in the node checks with a test key ────────────────────────────────────────────
const GOOGLE_KID = 'test-recovery-copies-google';
const GOOGLE_AUD = '653933790375-vkedasi9cs2aeoo2968ttmscqno484jd.apps.googleusercontent.com';
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' } as any;
function googleToken(sub: string, nonce: string): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'RS256', kid: GOOGLE_KID, typ: 'JWT' });
    const p = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub, email_verified: true, iat: now, exp: now + 3600, nonce });
    return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), google.privateKey).toString('base64url')}`;
}

async function main(): Promise<void> {
    console.log("Where members' copies go: the community's rule (VR2)\n");
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { ownerSessionHeaders, seedOwnerForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { readCommunitySettings, parseCommunitySettings } = await import('./config/community-settings.js');
    const { readShape } = await import('./config/community-shape.js');
    const { RECOVERY_COPIES_KEY, NO_COPIES_HERE_MESSAGE } = await import('./config/recovery-copies.js');
    const sso = await import('./sso.js');
    const core = await import('@beanpool/core');
    const rr = await import('./engine/recovery-release.js');
    const seal = await import('./services/recovery-seal-key.js');

    await initTls();
    se.initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;
    sso._resetJwksCacheForTests();
    sso._resetJwksCacheForTests('google', { keys: [googleJwk], expiresAt: Date.now() + 3600_000 });
    sso._clearNoncesForTests();

    function makeMember(name: string): Id {
        const id = keypair(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 30 * DAY).toISOString());
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
        return id;
    }
    async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
        resetGatewayRateLimit();
        resetAdminRateLimit();
        resetAdminAuthTarpit();
        pruneAuthAttempts(Date.now() + 120_000);
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const headers: Record<string, string> = { ...extra };
        if (id) {
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            headers['X-Public-Key'] = id.pk;
            headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
            headers['X-Timestamp'] = String(ts);
            headers['X-Nonce'] = nonce;
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
        let json: any; try { json = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: json };
    }
    const info = async () => (await call('GET', null, '/api/community/info')).body;
    const rowOf = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(RECOVERY_COPIES_KEY) as { value: string } | undefined)?.value ?? null;
    const copiesOf = (pk: string) => (db.prepare(`SELECT holder_ref FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'`).all(pk) as { holder_ref: string }[])
        .map((r) => r.holder_ref);
    /** A sign-in copy as the phone seals it (keeper-enrolment.ts sealSsoShares), for the body of a deposit or a join. */
    async function sealedCopy(id: Id, sub: string) {
        const sealed = await core.sealSeedToSso(id.seed, 'google', sub);
        return [{ holderType: 'sso', holderRef: 'google', shareIndex: 1, ...sealed }];
    }

    se.seedGenesisMember(keypair('Founder').pk, 'Founder');
    const owenPk = seedOwnerForTests('Owen');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sam = makeMember('Sam');
    const owner = ownerSessionHeaders(owenPk);
    const adminSession = (() => {
        const { handshakeToken } = mintHandshakeToken(ada.pk, 'admin');
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`no admin session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    })();
    const PATH = '/api/local/admin/community-shape';
    const change = (rule: unknown, headers: Record<string, string> = owner) => call('POST', null, PATH, { changes: { recoveryCopies: rule } }, headers);
    const logLines = () => db.prepare(`SELECT old_value, new_value FROM community_settings_log WHERE setting = 'recoveryCopies' ORDER BY id`).all() as
        { old_value: string; new_value: string }[];
    const noticeMark = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM moderation_notices').get() as { m: number }).m;
    const noticesSince = (mark: number) => db.prepare('SELECT recipient, body FROM moderation_notices WHERE rowid > ? ORDER BY rowid').all(mark) as
        { recipient: string; body: string }[];

    // ── 1. The rule as the community says it ────────────────────────────────────────────────────
    console.log('── 1. the default ──');
    assert((await info())?.recoveryCopies === 'vault' && rowOf() === null,
        `/api/community/info says recoveryCopies: vault with no row (got ${JSON.stringify((await info())?.recoveryCopies)})`);
    const shape0 = readShape().settings.recoveryCopies;
    assert(shape0?.value === 'vault' && shape0.configured === 'vault' && shape0.source === 'default' && shape0.lock === null,
        `How this community works reads it: vault, from the default, no lock (got ${JSON.stringify(shape0)})`);

    // ── 2. An owner changes it ──────────────────────────────────────────────────────────────────
    console.log('\n── 2. an owner changes it ──');
    let mark = noticeMark();
    const toServer = await change('server');
    assert(toServer.status === 200 && toServer.body?.told === 'members' && toServer.body?.shape?.settings?.recoveryCopies?.value === 'server',
        `an owner sets server: 200, members told (${show(toServer)})`);
    assert(rowOf() === 'server' && (await info())?.recoveryCopies === 'server', 'the row says server, and so does the info');
    assert(JSON.stringify(logLines()) === JSON.stringify([{ old_value: 'vault', new_value: 'server' }]), 'one log line: vault → server');
    const told = noticesSince(mark);
    const serverSentence = "Your community's owners changed how it works: this community's server keeps members' sign-in copies now. Any copy you have stays where it is until you move or remove it.";
    assert(told.length > 0 && told.some((n) => n.recipient === sam.pk) && told.every((n) => n.body === serverSentence),
        `every member is told, in the fixed sentence (${told.length} notices: ${JSON.stringify(told[0]?.body)})`);
    assert(readCommunitySettings().nodeConfig.recovery_copies === 'server', 'the community settings record a standby keeps carries it');
    const parsed = parseCommunitySettings({ localConfig: {}, directory: {}, nodeConfig: { recovery_copies: 'none' } });
    const notARule = parseCommunitySettings({ localConfig: {}, directory: {}, nodeConfig: { recovery_copies: 'vault' } });
    assert(parsed?.record.nodeConfig.recovery_copies === 'none' && parsed.left.length === 0
        && notARule?.left.join() === 'nodeConfig.recovery_copies (not a value it can take)',
        'a standby takes none from its main server, and leaves out a stored "vault" (the default is no row)');
    const same = await change('server');
    assert(same.status === 200 && same.body?.told === 'nobody' && logLines().length === 1, 'the same rule again changes nothing: nobody told, no line');
    for (const [label, rule] of [['a rule it can\'t take', 'everywhere'], ['a number', 3], ['null', null]] as const) {
        const r = await change(rule);
        assert(r.status === 400 && rowOf() === 'server' && logLines().length === 1, `${label} → 400, nothing written (${show(r)})`);
    }
    const byAdmin = await change('none', adminSession);
    assert(byAdmin.status === 403 && rowOf() === 'server', `an admin → 403, nothing written (${show(byAdmin)})`);
    setNodeRole('backup');
    const onStandby = await change('none');
    setNodeRole('primary');
    assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && rowOf() === 'server', `on a standby → 409 standby, nothing written (${show(onStandby)})`);
    mark = noticeMark();
    const toVault = await change('vault');
    assert(toVault.status === 200 && rowOf() === null && (await info())?.recoveryCopies === 'vault', 'back to vault: the row is removed, the info says vault');
    assert(noticesSince(mark).every((n) => n.body.includes("BeanPool's key vault keeps members' sign-in copies now.")), 'and members are told the vault keeps them');

    // ── 3. The sign-in copy routes ─────────────────────────────────────────────────────────────
    console.log('\n── 3. none and server at the sign-in copy routes ──');
    const SAM_SUB = '110169484474386279001';
    // A copy Sam kept here before the rule changed.
    const nonce1 = await call('POST', sam, '/api/recovery/sso-nonce', {});
    const dep1 = await call('POST', sam, '/api/recovery/shares/sso', {
        provider: 'google', shares: await sealedCopy(sam, SAM_SUB), idToken: googleToken(SAM_SUB, nonce1.body?.nonce), nonce: nonce1.body?.nonce,
    });
    assert(dep1.status === 200 && JSON.stringify(copiesOf(sam.pk)) === '["google"]', `under vault, a member's sign-in copy is still kept here, as a build without a vault does (${show(dep1)})`);

    assert((await change('none')).status === 200 && rowOf() === 'none', 'an owner sets none');
    const noNonce = await call('POST', sam, '/api/recovery/sso-nonce', {});
    assert(noNonce.status === 409 && noNonce.body?.code === 'no_copies_here' && noNonce.body?.error === NO_COPIES_HERE_MESSAGE && !noNonce.body?.nonce,
        `none: no nonce → 409 no_copies_here, in its sentence (${show(noNonce)})`);
    const genBefore = (db.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM recovery_shares WHERE owner_pubkey = ?').get(sam.pk) as { g: number }).g;
    const noDeposit = await call('POST', sam, '/api/recovery/shares/sso', {
        provider: 'google', shares: await sealedCopy(sam, SAM_SUB), idToken: googleToken(SAM_SUB, 'any'), nonce: 'any',
    });
    const genAfter = (db.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM recovery_shares WHERE owner_pubkey = ?').get(sam.pk) as { g: number }).g;
    assert(noDeposit.status === 409 && noDeposit.body?.code === 'no_copies_here' && genAfter === genBefore,
        `none: a deposit → 409 no_copies_here, and nothing stored (${show(noDeposit)})`);
    const status = await call('POST', sam, '/api/recovery/shares/status', {});
    assert(status.status === 200 && JSON.stringify(status.body?.enrolledSso) === '["google"]',
        `none: the copy kept from before is still the member's: its status lists it (${show(status)})`);
    const removed = await call('DELETE', sam, '/api/recovery/shares/sso/google');
    assert(removed.status === 200 && removed.body?.removed === 'google' && copiesOf(sam.pk).length === 0, `none: and its delete removes it (${show(removed)})`);

    assert((await change('server')).status === 200 && rowOf() === 'server', 'an owner sets server');
    const nonce2 = await call('POST', sam, '/api/recovery/sso-nonce', {});
    const dep2 = await call('POST', sam, '/api/recovery/shares/sso', {
        provider: 'google', shares: await sealedCopy(sam, SAM_SUB), idToken: googleToken(SAM_SUB, nonce2.body?.nonce), nonce: nonce2.body?.nonce,
    });
    assert(nonce2.status === 200 && dep2.status === 200 && dep2.body?.provider === 'google' && JSON.stringify(copiesOf(sam.pk)) === '["google"]',
        `server: the nonce and a deposit keep the copy here, the sign-in checked by the node (${show(dep2)})`);

    // ── 4. The open door ───────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the open door ──');
    process.env.NODE_PROFILE = 'global';
    const vaultSeed = new Uint8Array(crypto.randomBytes(32));
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const VAULT_KEY = Buffer.from(ed25519.getPublicKey(vaultSeed)).toString('hex');
    process.env.BEANPOOL_VAULT_TICKET_KEYS = VAULT_KEY;
    // Every join here comes from one address: earlier joins are moved a day back so the door's signal never says busy.
    const call2 = (id: Id, path: string, body: unknown) => {
        const dayAgo = new Date(Date.now() - 25 * 3600_000).toISOString();
        db.prepare('UPDATE open_joins SET joined_at = ? WHERE joined_at > ?').run(dayAgo, dayAgo);
        return call('POST', id, path, body);
    };
    const ticketFor = (pk: string) => core.signVaultTicket(core.newVaultTicket(pk, 'deposit', Date.now()), vaultSeed);

    assert((await change('vault')).status === 200, 'an owner sets vault');
    const vaultAnswer = await call2(keypair('Probe'), '/api/join/sso-nonce', {});
    assert(JSON.stringify(vaultAnswer.body?.vault) === JSON.stringify({ ticketKeys: [VAULT_KEY] }), `vault: the door lists the vault's ticket keys (${show(vaultAnswer)})`);

    assert((await change('server')).status === 200, 'an owner sets server');
    const serverAnswer = await call2(keypair('Probe2'), '/api/join/sso-nonce', {});
    assert(serverAnswer.status === 200 && 'vault' in (serverAnswer.body ?? {}) && serverAnswer.body.vault === null && typeof serverAnswer.body.nonce === 'string',
        `server: the nonce answer says vault: null, beside the door's own nonce (${show(serverAnswer)})`);
    const tia = keypair('Tia');
    const tiaTicket = ticketFor(tia.pk);
    const tiaTicketJoin = await call2(tia, '/api/join', {
        callsign: 'Tia', provider: 'google', idToken: googleToken('tia-sub', core.vaultTicketNonce(tiaTicket)), nonce: core.vaultTicketNonce(tiaTicket), vaultTicket: tiaTicket,
    });
    const tiaRow = db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(tia.pk);
    assert(tiaTicketJoin.status === 401 && tiaTicketJoin.body?.code === 'ticket_unsupported' && !tiaRow,
        `server: a join bound to a vault ticket → 401 ticket_unsupported, and nobody joined (${show(tiaTicketJoin)})`);
    const tiaNonce = (await call2(tia, '/api/join/sso-nonce', {})).body?.nonce;
    const tiaJoin = await call2(tia, '/api/join', {
        callsign: 'Tia', provider: 'google', idToken: googleToken('tia-sub', tiaNonce), nonce: tiaNonce, recovery: { shares: await sealedCopy(tia, 'tia-sub') },
    });
    assert(tiaJoin.status === 200 && tiaJoin.body?.recovery?.enrolled === true && JSON.stringify(copiesOf(tia.pk)) === '["google"]',
        `server: a join carrying its copy keeps it here (${show(tiaJoin)})`);

    assert((await change('none')).status === 200, 'an owner sets none');
    const noneAnswer = await call2(keypair('Probe3'), '/api/join/sso-nonce', {});
    assert(noneAnswer.body?.vault === null, 'none: the door lists no ticket keys either');
    const ugo = keypair('Ugo');
    const ugoNonce = (await call2(ugo, '/api/join/sso-nonce', {})).body?.nonce;
    const ugoJoin = await call2(ugo, '/api/join', {
        callsign: 'Ugo', provider: 'google', idToken: googleToken('ugo-sub', ugoNonce), nonce: ugoNonce, recovery: { shares: await sealedCopy(ugo, 'ugo-sub') },
    });
    assert(ugoJoin.status === 200 && ugoJoin.body?.success === true && ugoJoin.body?.recovery?.enrolled === false
        && ugoJoin.body?.recovery?.code === 'no_copies_here' && copiesOf(ugo.pk).length === 0,
        `none: a join with a copy stands, says no_copies_here, and keeps none (${show(ugoJoin)})`);
    // A 12-words member adding a sign-in later (POST /api/join/link): the same.
    const vic = keypair('Vic');
    const { nodeSha256 } = await import('./services/door-work.js');
    const work = await call2(vic, '/api/join/work', { door: 'words' });
    const solved = { challenge: work.body?.work?.challenge, counters: core.solveDoorWorkSync(work.body?.work?.challenge, nodeSha256) };
    const vicJoin = await call2(vic, '/api/join', { door: 'words', callsign: 'Vic', work: solved });
    const linkNonce = (await call2(vic, '/api/join/link/sso-nonce', {})).body?.nonce;
    const vicLink = await call2(vic, '/api/join/link', {
        provider: 'google', idToken: googleToken('vic-sub', linkNonce), nonce: linkNonce, recovery: { shares: await sealedCopy(vic, 'vic-sub') },
    });
    assert(vicJoin.status === 200 && vicLink.status === 200 && vicLink.body?.recovery?.enrolled === false && copiesOf(vic.pk).length === 0,
        `none: a sign-in added later is linked, and its copy is not kept (join ${show(vicJoin)}, link ${show(vicLink)})`);
    delete process.env.NODE_PROFILE;
    delete process.env.BEANPOOL_VAULT_TICKET_KEYS;
    assert((await change('vault')).status === 200, 'an owner sets vault again');

    // ── 5. A release's copy: 30 days ──────────────────────────────────────────────────────────
    console.log('\n── 5. released copies are kept 30 days ──');
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const session = (id: string, status: string, expiresAt: string, requester = crypto.randomBytes(32).toString('hex')) => db.prepare(`INSERT INTO recovery_collections
        (id, owner_pubkey, requester_ephemeral_pubkey, generation, status, created_at, expires_at)
        VALUES (?, ?, ?, 1, ?, ?, ?)`).run(id, sam.pk, requester, status, ago(31 * DAY), expiresAt);
    const SINGLE = JSON.stringify({ alg: core.KEEPER_ALG_SSO_SINGLE });
    const release = (collectionId: string, shareId: number, releasedAt: string) => {
        const sealed = seal.sealRecoveryFields({ encryptedShare: 'c2VjcmV0', shareIv: 'aXY=', shareTag: 'dGFn', kdfParams: SINGLE },
            seal.releaseRowAad(collectionId, shareId, 'sso'));
        db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at, owner_pubkey)
                    VALUES (?, ?, 'sso', 1, ?, ?, ?, ?, ?, ?)`).run(collectionId, shareId, sealed.encryptedShare, sealed.shareIv, sealed.shareTag, sealed.kdfParams, releasedAt, sam.pk);
        return (db.prepare('SELECT id FROM recovery_releases WHERE collection_id = ? AND share_id = ?').get(collectionId, shareId) as { id: number }).id;
    };
    session('done-old', 'complete', ago(28 * DAY));
    session('done-new', 'complete', ago(28 * DAY));
    session('live', 'open', new Date(Date.now() + DAY).toISOString());
    const oldId = release('done-old', 901, ago(31 * DAY));
    const newId = release('done-new', 902, ago(29 * DAY));
    // A live session's release, whatever its clock says, is one its device may still be handed.
    const liveId = release('live', 903, ago(31 * DAY));
    const rowById = (id: number) => db.prepare('SELECT * FROM recovery_releases WHERE id = ?').get(id) as any;
    const before = { old: rowById(oldId), fresh: rowById(newId), live: rowById(liveId) };
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM recovery_releases').get() as { n: number }).n;
    const rowsBefore = count();

    setNodeRole('backup');
    const onAStandby = await rr.forgetOldReleasedCopies();
    setNodeRole('primary');
    assert(onAStandby === 0 && JSON.stringify(rowById(oldId)) === JSON.stringify(before.old), 'a standby writes nothing: its releases are its main server\'s');

    await new Promise((r) => setTimeout(r, 5));
    const gone = await rr.forgetOldReleasedCopies();
    const old = rowById(oldId);
    assert(gone === 1 && count() === rowsBefore, `one copy emptied, every row still there (emptied ${gone}, rows ${count()} of ${rowsBefore})`);
    assert(old.payload === '' && old.payload_iv === '' && old.payload_tag === '' && seal.isReleasedCopyGone(old.kdf_params),
        'the 31-day release: its copy is gone, marked');
    assert(old.collection_id === 'done-old' && old.share_id === 901 && old.holder_type === 'sso' && old.released_at === before.old.released_at && old.owner_pubkey === sam.pk,
        'and its record stays: the session, the kind, when and whose');
    assert(seal.isSingleBlobSsoStored(old.kdf_params) === seal.isSingleBlobSsoStored(before.old.kdf_params) && seal.isSingleBlobSsoStored(old.kdf_params),
        'and it reads as the same kind of copy (single blob), so a session\'s progress counts as before');
    assert(old.updated_at > before.old.updated_at, 'its row is stamped, so a standby is sent it emptied');
    assert(!JSON.stringify(old).includes(before.old.payload), 'none of the old copy is left in the row');
    assert(JSON.stringify(rowById(newId)) === JSON.stringify(before.fresh), 'the 29-day release keeps its copy');
    assert(JSON.stringify(rowById(liveId)) === JSON.stringify(before.live), 'and so does a release of a session still live');
    let openErr = '';
    try { rr.listReleases('done-old'); } catch (e) { openErr = (e as Error).name; }
    assert(openErr === 'RecoverySealUnopenable', `nothing opens an emptied copy (got ${openErr || 'no error'})`);
    assert(seal.wrapRecoveryRows().releases === 0 && JSON.stringify(rowById(oldId)) === JSON.stringify(old), 'the boot\'s wrap leaves it as it is');
    assert((await rr.forgetOldReleasedCopies()) === 0 && JSON.stringify(rowById(oldId)) === JSON.stringify(old), 'a second run empties nothing');

    // The device that opened a session long gone still reaches its routes: they check the session is its own, and each
    // release checks it is live. So its sign-in is answered by the release rules, never by a copy that is gone (an
    // emptied release can't be opened, and "this server cannot open a copy" would blame the server's key).
    const device = keypair('Device');
    const oldSessions = [
        { label: 'completed', id: 'gone-complete', status: 'complete', words: 'That recovery session is already complete.' },
        { label: 'expired', id: 'gone-expired', status: 'open', words: 'That recovery session has expired. Start a new one.' },
    ];
    oldSessions.forEach((s, i) => { session(s.id, s.status, ago(28 * DAY), device.pk); release(s.id, 904 + i, ago(31 * DAY)); });
    assert((await rr.forgetOldReleasedCopies()) === oldSessions.length, 'a completed and an expired session\'s 31-day releases are emptied');
    for (const s of oldSessions) {
        const progress = await call('POST', device, '/api/recovery/collect/status', { collectionId: s.id });
        assert(progress.status === 200 && progress.body?.live === false && progress.body?.collected === 1 && progress.body?.threshold === 1,
            `an old ${s.label} session: its status still counts its release (${show(progress)})`);
        for (const route of ['fragments', 'hub']) {
            const r = await call('POST', device, `/api/recovery/collect/${route}`, { collectionId: s.id });
            assert(r.status === 400 && r.body?.error === s.words, `an old ${s.label} session: /collect/${route} → 400, "${s.words}" (${show(r)})`);
        }
        const n = await call('POST', device, '/api/recovery/collect/sso-nonce', { collectionId: s.id });
        const signIn = await call('POST', device, '/api/recovery/collect/sso', {
            collectionId: s.id, provider: 'google', idToken: googleToken(SAM_SUB, n.body?.nonce), nonce: n.body?.nonce,
        });
        assert(n.status === 200 && signIn.status === 400 && signIn.body?.error === s.words && signIn.body?.code === undefined,
            `an old ${s.label} session: its device's good sign-in → 400, "${s.words}", not the server's key (${show(signIn)})`);
    }

    // A copy being served to a standby in pages holds a read on a second connection (engine/open-copies.ts). The sweep
    // runs on the timer of a live main server, so it never waits on that reader with the event loop held: the WAL is
    // emptied once the reader lets go (db/wal-truncate.ts, which a suite sets to try again every 150 ms).
    process.env.WAL_TRUNCATE_RETRY_MS = '150';
    const WAL = `${db.name}-wal`;
    const fileBytes = (f: string) => { try { return fs.readFileSync(f); } catch { return Buffer.alloc(0); } };
    session('held-old', 'complete', ago(28 * DAY));
    const heldId = release('held-old', 906, ago(31 * DAY));
    const heldCopy = Buffer.from(rowById(heldId).payload, 'utf8');
    const filesHolding = () => [db.name, WAL].filter((f) => fileBytes(f).includes(heldCopy)).map((f) => path.basename(f));
    assert(filesHolding().length > 0, `before the sweep, the database's files hold the copy (${filesHolding().join(', ') || 'neither'})`);
    const Database = (await import('better-sqlite3')).default;
    const reader = new Database(db.name, { readonly: true, fileMustExist: true });
    reader.prepare('BEGIN').run();
    reader.prepare('SELECT COUNT(*) AS n FROM recovery_releases').get();
    const t0 = Date.now();
    const heldGone = await rr.forgetOldReleasedCopies();
    const took = Date.now() - t0;
    assert(heldGone === 1 && rowById(heldId).payload === '', `with a reader holding the WAL, the sweep still empties the copy (emptied ${heldGone})`);
    assert(took < 2_000, `and answers at once, never waiting out the 5-second busy timeout for the reader (${took} ms)`);
    const heldWal = fileBytes(WAL).length;
    assert(heldWal > 0, `while the reader holds it, the WAL cannot be emptied (${heldWal} bytes)`);
    reader.prepare('COMMIT').run();
    reader.close();
    let walLeft = -1;
    for (let i = 0; i < 40 && walLeft !== 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        walLeft = fileBytes(WAL).length;
    }
    assert(walLeft === 0 && filesHolding().length === 0,
        `once the reader lets go, the next try empties the WAL, and the copy is in neither file (WAL ${walLeft} bytes; in ${filesHolding().join(', ') || 'neither'})`);

    assert(outsideFetches === 0, `no host but this machine was asked (${outsideFetches})`);
    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
