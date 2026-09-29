/**
 * Test Suite: GitHub is no longer a sign-in (Marty, 2026-09-29), and the GitHub rows a server holds go at its start
 * (engine/github-sign-in-removal.ts).
 *
 * GitHub's `sub` is its public, sequential user id, so a copy locked to it is locked to nothing its owner controls, and a
 * lookup hash or open-door hash made from it names the account to anyone holding the data. So every GitHub recovery copy
 * (a linked sign-in, single-blob or two-layer), every released copy of one, and every GitHub open-door join record is
 * removed when a server starts, and the device-flow routes are gone. A member loses nothing they cannot restore: their 12
 * words always work, and Google or Apple still link.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots. Google
 * copies are deposited and recovered over the main server's real HTTPS server and signature middleware, with a stand-in
 * Google (recovery-seal-test-http.ts); the GitHub rows are planted as a server from before this change stored them. The
 * standbys pull through their real puller from the main server's real backup routes. No other host is reached.
 *
 *  1. A main server whose members hold, between them, every shape of GitHub row: Gia (Google + GitHub), Hugo (GitHub
 *     only), Ines (Google only), Jo (Apple + GitHub), Kai (two-layer: hub + GitHub + Google), Lea (two-layer: hub +
 *     GitHub only); a released copy of Gia's and of Hugo's GitHub copies beside a released copy of Gia's Google one; Mia
 *     (joined through the open door with GitHub) and Ned (with Google).
 *  2. Standby A copies it, and holds the take-over keys; a GitHub open-door record arriving there is refused. Standby
 *     B is a copy of A's data from then, holding Mia's GitHub record as a standby from before this change would. A
 *     starts again: it removes that record itself (no deletion of that table reaches a standby) and leaves the copies
 *     to its main server.
 *  3. The main server starts again (the upgrade): every GitHub row is gone, counted in one log line that names nobody;
 *     every Google and Apple copy is the same bytes, and Ines's the same row; Gia's Google sign-in still brings her
 *     account back and Jo's Apple copy still opens; Mia is still a member. The sign-in answers offer no GitHub, and every
 *     GitHub route answers 404. A second start removes nothing.
 *  4. Standby A pulls, a delta then a whole copy: it holds exactly the main server's copies, released copies and
 *     open-door records, and a record naming GitHub is refused when one arrives.
 *  5. The main server dies. Standby B, which still holds every GitHub copy, starts (removing its own GitHub open-door
 *     record) and takes over: the server it becomes holds no GitHub row, and Gia's Google sign-in brings her account
 *     back there.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-github-sign-in-removed.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, recoverySealCommands, type NodeProc } from './takeover-test-harness.js';
import { fixtureWords } from './recovery-seal-test-http.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

// Every process of this suite: no host but this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Github-Removed-Main-Pw-5521!';
const PW_STANDBY = 'Github-Removed-Standby-Pw-77!';

/** GitHub's numeric user ids, and an Apple subject, for the planted copies. */
const SUBS = { gia: '24680', hugo: '13579', jo: '8675309', kai: '1001', lea: '2002', joApple: '001234.abcdef0123456789.0123' };

/** A member's key from their seed, as the apps derive it. */
function pkOf(seedHex: string): string {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8',
    });
    return (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

const print = (v: unknown) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const { runNodeChild } = await import('./takeover-test-harness.js');
    await runNodeChild({
        ...recoverySealCommands,
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
            const owner = pkOf(a.ownerSeedHex);
            se.seedGenesisMember(owner, 'Anna');
            setReplicationToken(a.replicationToken);
            return { owner, code: (await makeRecoveryCode()).code };
        },
        /**
         * A generation as a server from before this change stored it: the member's current copies carried (`carry`), and
         * these added. `single` is a copy as the apps seal one; `legacy` a two-layer sign-in piece; `hub` the hub piece.
         */
        plant: async (a: { seedHex: string; words: string[]; callsign: string; addMember: boolean; carry: boolean;
            copies: { kind: 'single' | 'legacy' | 'hub'; provider?: string; sub?: string }[] }) => {
            const { db } = await import('./db/db.js');
            const { putShareGeneration, getCurrentSharesToCarry } = await import('./engine/recovery-shares.js');
            const { ssoLookupHash, newSsoLookupSalt } = await import('./sso.js');
            const { sealSeedToSso } = await import('@beanpool/core');
            const pk = pkOf(a.seedHex);
            if (a.addMember) {
                db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                            VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'github-removed-test', 'TEST')`).run(pk, a.callsign);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            }
            const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
            const shares: any[] = a.carry ? getCurrentSharesToCarry(pk).map((s) => ({
                holderType: s.holderType, holderRef: s.holderRef, shareIndex: s.shareIndex, encryptedShare: s.encryptedShare,
                shareIv: s.shareIv, shareTag: s.shareTag, ephemeralPubkey: s.ephemeralPubkey, ssoLookupHash: s.ssoLookupHash,
                ssoLookupSalt: s.ssoLookupSalt, kdfParams: s.kdfParams,
            })) : [];
            let index = shares.reduce((m, s) => Math.max(m, s.shareIndex), 0);
            for (const c of a.copies) {
                index++;
                if (c.kind === 'hub') {
                    shares.push({ holderType: 'hub', holderRef: 'self', shareIndex: index, encryptedShare: b64(32), shareIv: b64(24), shareTag: b64(16),
                        kdfParams: JSON.stringify({ alg: 'plaintext-v1' }) });
                    continue;
                }
                const salt = newSsoLookupSalt();
                const lookup = { ssoLookupHash: await ssoLookupHash(c.provider as any, c.sub!, salt), ssoLookupSalt: salt };
                if (c.kind === 'legacy') {
                    shares.push({ holderType: 'sso', holderRef: c.provider, shareIndex: index, encryptedShare: b64(32), shareIv: b64(24), shareTag: b64(16),
                        kdfParams: JSON.stringify({ alg: 'scrypt-xc20p-v1', salt: b64(16), N: 16384, r: 8, p: 1 }), ...lookup });
                } else {
                    const sealed = await sealSeedToSso(new Uint8Array(Buffer.from(a.seedHex, 'hex')), c.provider!, c.sub!, { words: a.words });
                    shares.push({ holderType: 'sso', holderRef: c.provider, shareIndex: index, ...(sealed as any), ...lookup });
                }
            }
            return { pk, generation: putShareGeneration(pk, shares) };
        },
        /**
         * A released copy of the member's current `holderRef` copy, in a finished recovery session, as the release path
         * (engine/recovery-release.ts recordRelease) stores one: the client's copy, wrapped again bound to the release.
         */
        'plant-release': async (a: { pk: string; holderRef: string }) => {
            const { db } = await import('./db/db.js');
            const { getShareForHolder } = await import('./engine/recovery-shares.js');
            const { sealRecoveryFields, releaseRowAad } = await import('./services/recovery-seal-key.js');
            const share = getShareForHolder(a.pk, 'sso', a.holderRef);
            if (!share) throw new Error('no such copy');
            const collectionId = crypto.randomBytes(32).toString('base64url');
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, expires_at)
                        VALUES (?, ?, ?, ?, 'complete', ?)`).run(collectionId, a.pk, share.generation, crypto.randomBytes(32).toString('hex'), now);
            const sealed = sealRecoveryFields(
                { encryptedShare: share.encryptedShare, shareIv: share.shareIv, shareTag: share.shareTag, kdfParams: share.kdfParams ?? null },
                releaseRowAad(collectionId, share.id, 'sso'),
            );
            const r = db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag,
                                  kdf_params, released_at, owner_pubkey) VALUES (?, ?, 'sso', ?, ?, ?, ?, ?, ?, ?)`)
                .run(collectionId, share.id, share.shareIndex, sealed.encryptedShare, sealed.shareIv, sealed.shareTag, sealed.kdfParams, now, a.pk);
            return Number(r.lastInsertRowid);
        },
        /**
         * Someone who joined through the open door with `provider`, as registerOpenJoin records them (on a standby: the
         * record as one from before this change copied it, the member already copied).
         */
        'plant-open-join': async (a: { pk: string; callsign: string; provider: string }) => {
            const { db } = await import('./db/db.js');
            const now = new Date().toISOString();
            db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                        VALUES (?, ?, 'active', ?, ?, NULL)`).run(a.pk, a.callsign, now, `open:${a.provider}`);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.pk);
            db.prepare(`INSERT OR IGNORE INTO open_joins (member_pubkey, provider, join_hash, joined_at, ip_hash, updated_at) VALUES (?, ?, ?, ?, NULL, ?)`)
                .run(a.pk, a.provider, crypto.randomBytes(32).toString('base64url'), now, now);
            return true;
        },
        /** Everything this suite compares, by what identifies it, with a print of any copy's bytes (never the bytes). */
        state: async () => {
            const { db } = await import('./db/db.js');
            const copies = (db.prepare(`SELECT id, owner_pubkey, holder_type, holder_ref, generation, share_index, encrypted_share, updated_at
                                        FROM recovery_shares ORDER BY owner_pubkey, generation, holder_type, holder_ref`).all() as any[]).map((r) => ({
                id: r.id, owner: r.owner_pubkey, type: r.holder_type, ref: r.holder_ref, generation: r.generation, index: r.share_index,
                print: print(r.encrypted_share), stamp: r.updated_at,
            }));
            const releases = (db.prepare(`SELECT id, collection_id, share_id, holder_type, share_index, payload, owner_pubkey, updated_at
                                          FROM recovery_releases ORDER BY id`).all() as any[]).map((r) => ({
                id: r.id, collection: r.collection_id, shareId: r.share_id, type: r.holder_type, index: r.share_index, owner: r.owner_pubkey,
                print: print(r.payload), stamp: r.updated_at,
            }));
            const joins = db.prepare('SELECT member_pubkey, provider, join_hash, joined_at, updated_at FROM open_joins ORDER BY member_pubkey').all();
            const tombstones = db.prepare(`SELECT table_name, row_key FROM tombstones WHERE table_name IN ('recovery_shares', 'recovery_releases')
                                           ORDER BY table_name, row_key`).all();
            return { copies, releases, joins, tombstones };
        },
        member: async (a: { pk: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('SELECT status, is_visitor, invited_by FROM members WHERE public_key = ?').get(a.pk) ?? null;
        },
        /** The member's current copy for `provider`, opened as the device would open it: the seed it gives, or why not. */
        'open-copy': async (a: { pk: string; provider: string; sub: string }) => {
            const { getShareForHolder } = await import('./engine/recovery-shares.js');
            const { openSeedFromSso } = await import('@beanpool/core');
            const s = getShareForHolder(a.pk, 'sso', a.provider);
            if (!s) return { seedHex: null, error: 'no copy' };
            try {
                const o = await openSeedFromSso({ encryptedShare: s.encryptedShare, shareIv: s.shareIv, shareTag: s.shareTag, kdfParams: s.kdfParams! },
                    a.provider, a.sub);
                return { seedHex: Buffer.from(o.seed).toString('hex'), error: null };
            } catch (e) {
                return { seedHex: null, error: (e as Error)?.message || String(e) };
            }
        },
        /** A request to this node's own HTTPS server, signed by `seedHex` (a member, or a recovering device's own key). */
        signed: async (a: { seedHex: string; path: string; body?: unknown }) => {
            const { startRecoveryHttps } = await import('./recovery-seal-test-http.js');
            const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
            const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
            const { base } = await startRecoveryHttps();
            resetGatewayRateLimit();
            pruneAuthAttempts(Date.now() + 120_000);
            const priv = crypto.createPrivateKey({
                key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(a.seedHex, 'hex')]), format: 'der', type: 'pkcs8',
            });
            const bodyString = JSON.stringify(a.body ?? {});
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            const res = await fetch(`${base}${a.path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Public-Key': pkOf(a.seedHex),
                    'X-Signature': crypto.sign(null, Buffer.from(`POST\n${a.path}\n${ts}\n${nonce}\n${bodyString}`), priv).toString('base64'),
                    'X-Timestamp': String(ts),
                    'X-Nonce': nonce,
                },
                body: bodyString,
            });
            let parsed: any;
            try { parsed = await res.json(); } catch { parsed = undefined; }
            return { status: res.status, body: parsed };
        },
        /** The door's record arriving from a main server (a pull, a take-over's keys), as engine/sync.ts hands it over. */
        'write-open-joins': async (a: { joins: unknown }) => {
            const { writeOpenJoinRecord } = await import('./engine/open-join.js');
            return writeOpenJoinRecord(undefined, a.joins);
        },
        reseal: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return (await flushTakeoverChecks()).envelopeId;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        envelope: async () => {
            const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return pullTakeoverEnvelopeNow();
        },
        // The puller's next pull, of the kind it chooses; `whole` forces a routine whole copy (the reconcile timer, due).
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            try {
                const result = await pullNow();
                return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
            } finally {
                delete process.env.BACKUP_RECONCILE_EVERY_MS;
            }
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Member { name: string; seedHex: string; words: string[]; pk: string }
let fixture = 0;
function member(name: string): Member {
    const { words, seedHex } = fixtureWords(++fixture);
    return { name, seedHex, words, pk: pkOf(seedHex) };
}

/** A copy as a standby must hold it to match: everything but the row id, which each server numbers itself. */
const asHeld = (c: any) => ({ owner: c.owner, type: c.type, ref: c.ref, generation: c.generation, index: c.index, print: c.print, stamp: c.stamp });
/** A released copy likewise: the row id travels with it (engine/replication-manifest.ts, a plain table). */
const releaseHeld = (r: any) => ({ id: r.id, collection: r.collection, shareId: r.shareId, type: r.type, index: r.index, owner: r.owner, print: r.print });

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), a: path.join(root, 'standby-a'), b: path.join(root, 'standby-b') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    const anna = member('Anna');
    const [gia, hugo, ines, jo, kai, lea, mia, ned] = ['Gia', 'Hugo', 'Ines', 'Jo', 'Kai', 'Lea', 'Mia', 'Ned'].map(member);
    const everyone = [anna, gia, hugo, ines, jo, kai, lea, mia, ned];
    const names = new Map(everyone.map((m) => [m.pk, m.name]));
    const named = (rows: any[]) => rows.map((r) => `${names.get(r.owner) ?? r.owner.slice(0, 8)}:${r.type}/${r.ref}#${r.generation}`);
    const of = (rows: any[], m: Member) => rows.filter((r: any) => r.owner === m.pk);
    const refs = (rows: any[], m: Member) => of(rows, m).map((r: any) => `${r.type}/${r.ref}`).sort();

    let main: NodeProc;
    let a: NodeProc;
    let b: NodeProc;

    const githubLine = /GitHub is no longer a sign-in: removed [^\n]*/g;

    try {
        // ── 1. A main server holding every shape of GitHub row ──
        console.log('\n— 1. a main server whose members hold GitHub copies, released copies and open-door records —');
        main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        const { owner, code } = await main.send('setup-primary', { ownerSeedHex: anna.seedHex, replicationToken });
        require_(owner === anna.pk, 'Anna owns the main server');
        for (const m of [gia, ines]) {
            const r = await main.send('recovery-deposit', { seedHex: m.seedHex, words: m.words, callsign: m.name, addMember: true });
            require_(r.status === 200 && r.pk === m.pk, `${m.name} connects Google over HTTPS (${r.status} ${JSON.stringify(r.body?.error ?? r.body?.generation)})`);
        }
        const plant = (m: Member, addMember: boolean, carry: boolean, copies: any[]) =>
            main.send('plant', { seedHex: m.seedHex, words: m.words, callsign: m.name, addMember, carry, copies });
        await plant(gia, false, true, [{ kind: 'single', provider: 'github', sub: SUBS.gia }]);
        await plant(hugo, true, false, [{ kind: 'single', provider: 'github', sub: SUBS.hugo }]);
        await plant(jo, true, false, [{ kind: 'single', provider: 'apple', sub: SUBS.joApple }, { kind: 'single', provider: 'github', sub: SUBS.jo }]);
        await plant(kai, true, false, [{ kind: 'hub' }, { kind: 'legacy', provider: 'github', sub: SUBS.kai }, { kind: 'legacy', provider: 'google', sub: '104729384756102938475' }]);
        await plant(lea, true, false, [{ kind: 'hub' }, { kind: 'legacy', provider: 'github', sub: SUBS.lea }]);
        const giaBack = await main.send('recovery-recover', { callsign: 'Gia' });
        require_(giaBack.released.status === 200 && giaBack.seedHex === gia.seedHex, `Gia recovers with Google, which leaves a released copy (${giaBack.released.status} ${giaBack.error ?? 'opened'})`);
        const giaGithubRelease = await main.send('plant-release', { pk: gia.pk, holderRef: 'github' });
        const hugoGithubRelease = await main.send('plant-release', { pk: hugo.pk, holderRef: 'github' });
        await main.send('plant-open-join', { pk: mia.pk, callsign: 'Mia', provider: 'github' });
        await main.send('plant-open-join', { pk: ned.pk, callsign: 'Ned', provider: 'google' });

        const before = await main.send('state');
        const githubBefore = before.copies.filter((c: any) => c.ref === 'github');
        require_(githubBefore.length === 5, `the main server holds five GitHub copies, one each for Gia, Hugo, Jo, Kai and Lea (${JSON.stringify(named(githubBefore))})`);
        require_(same(refs(before.copies, gia), ['sso/github', 'sso/google']) && same(refs(before.copies, jo), ['sso/apple', 'sso/github'])
            && same(refs(before.copies, kai), ['hub/self', 'sso/github', 'sso/google']) && same(refs(before.copies, lea), ['hub/self', 'sso/github']),
        `beside Gia's Google, Jo's Apple, and Kai's and Lea's hub pieces (${JSON.stringify(named(before.copies))})`);
        require_(before.releases.length === 3, `three released copies: Gia's Google one, and Gia's and Hugo's GitHub ones (${before.releases.length})`);
        require_(before.joins.length === 2, `two open-door records, Mia's GitHub one and Ned's Google one (${before.joins.length})`);

        // ── 2. Standby A copies it; B is a copy of A ──
        console.log('\n— 2. standby A copies it and holds its take-over keys; standby B is a copy of A from then —');
        await main.send('reseal');
        fs.mkdirSync(dirs.a, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.a, 'genesis.json'));
        a = await spawnNode(SCRIPT, dirs.a, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(a);
        await a.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await a.send('resync');
        require_(seeded.ok, `standby A copies the main server (${JSON.stringify(seeded)})`);
        require_(await a.send('envelope') === 'stored', 'and holds its take-over keys');
        const aFirst = await a.send('state');
        require_(same(aFirst.copies.map(asHeld), before.copies.map(asHeld)), `standby A holds every copy the main server holds, GitHub ones included (${aFirst.copies.length})`);
        require_(aFirst.releases.length === 3, `and its released copies (${aFirst.releases.length})`);
        assert(same(aFirst.joins.map((j: any) => j.member_pubkey), [ned.pk]),
            `Ned's open-door record arrives, and Mia's GitHub one is refused as it arrives (${JSON.stringify(aFirst.joins.map((j: any) => `${names.get(j.member_pubkey)}/${j.provider}`))})`);
        // As a standby from before this change holds it: copied before the main server's GitHub rows were refused anywhere.
        await a.send('plant-open-join', { pk: mia.pk, callsign: 'Mia', provider: 'github' });
        require_((await a.send('state')).joins.length === 2, 'standby A holds Mia\'s GitHub record as a standby from before this change would');
        await a.kill('SIGTERM');
        copyDir(dirs.a, dirs.b);
        a = await spawnNode(SCRIPT, dirs.a, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(a);
        require_(a.ready.role === 'backup', 'standby A starts again, as the standby');
        const aLines = a.output().match(githubLine) ?? [];
        assert(aLines.length === 1 && /removed 0 GitHub recovery copies \(0 members, 0 of them left with no sign-in copy\), 0 released copies and 1 open-door join record\b/.test(aLines[0]),
            `it removes its own GitHub open-door record, which no deletion of its main server's reaches, and leaves the copies to its main server (${JSON.stringify(aLines)})`);
        // Its first pull after a start is a whole copy; the next, after the main server's start, is a delta.
        const firstPull = await a.send('pull', {});
        require_(firstPull.ok === true && firstPull.whole === true, `standby A pulls a whole copy (${JSON.stringify({ ok: firstPull.ok, error: firstPull.error, whole: firstPull.whole })})`);
        const aAgain = await a.send('state');
        require_(aAgain.copies.filter((c: any) => c.ref === 'github').length === 5 && same(aAgain.joins.map((j: any) => j.member_pubkey), [ned.pk]),
            'and still holds the five GitHub copies, which are its main server\'s to remove, and no GitHub open-door record');

        // ── 3. The main server starts again ──
        console.log('\n— 3. the main server starts again: every GitHub row goes, and nothing else changes —');
        await main.kill('SIGTERM');
        main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        require_(main.ready.role === 'primary', 'it starts as the main server');
        const lines = main.output().match(githubLine) ?? [];
        assert(lines.length === 1 && /removed 5 GitHub recovery copies \(5 members, 2 of them left with no sign-in copy\), 2 released copies and 1 open-door join record\b/.test(lines[0]),
            `one log line counts what went (${JSON.stringify(lines)})`);
        assert(!everyone.some((m) => main.output().split('\n').some((l) => /GitHub/.test(l) && l.includes(m.pk))),
            'and no line about it names a member');
        const after = await main.send('state');
        assert(!after.copies.some((c: any) => c.ref === 'github'), `no GitHub copy is left (${JSON.stringify(named(after.copies.filter((c: any) => c.ref === 'github')))})`);

        const copy = (rows: any[], m: Member, ref: string) => of(rows, m).find((c: any) => c.ref === ref);
        const gen = (rows: any[], m: Member) => Math.max(0, ...of(rows, m).map((c: any) => c.generation));
        // Gia, Jo and Kai keep every other copy, the same bytes at the same place in the split, in a generation after the one with GitHub.
        for (const [m, kept] of [[gia, ['google']], [jo, ['apple']], [kai, ['self', 'google']]] as [Member, string[]][]) {
            const now = of(after.copies, m);
            assert(same(now.map((c: any) => c.ref).sort(), [...kept].sort()), `${m.name} keeps ${kept.join(' and ')}, and only that (${JSON.stringify(named(now))})`);
            for (const ref of kept) {
                const was = copy(before.copies, m, ref);
                const is = copy(after.copies, m, ref);
                assert(is && was && is.print === was.print && is.index === was.index && is.generation === gen(before.copies, m) + 1,
                    `${m.name}'s ${ref} copy is the same bytes at the same index, in the next generation (${was?.generation} → ${is?.generation})`);
            }
        }
        // Hugo and Lea had no other sign-in: every copy goes, with the tombstone a disconnect writes.
        for (const m of [hugo, lea]) {
            assert(of(after.copies, m).length === 0, `${m.name}, whose only sign-in was GitHub, has no copy left (${JSON.stringify(named(of(after.copies, m)))})`);
            assert(after.tombstones.some((t: any) => t.table_name === 'recovery_shares' && t.row_key === `${m.pk}|${gen(before.copies, m)}`),
                `and a tombstone names the generation deleted, so a standby deletes it too`);
        }
        assert(same(of(after.copies, ines), of(before.copies, ines)), `Ines's Google copy is the same row, untouched (${JSON.stringify(named(of(after.copies, ines)))})`);
        const giaGoogle = await main.send('recovery-recover', { callsign: 'Gia' });
        assert(giaGoogle.released.status === 200 && giaGoogle.seedHex === gia.seedHex, `Gia's Google sign-in still brings her account back (${giaGoogle.released.status} ${giaGoogle.error ?? 'opened'})`);
        const joApple = await main.send('open-copy', { pk: jo.pk, provider: 'apple', sub: SUBS.joApple });
        assert(joApple.seedHex === jo.seedHex, `Jo's Apple copy still opens to her account (${joApple.error ?? 'opened'})`);
        const inesGoogle = await main.send('recovery-recover', { callsign: 'Ines' });
        assert(inesGoogle.released.status === 200 && inesGoogle.seedHex === ines.seedHex, 'and so does Ines\'s Google sign-in');

        const releaseIds = after.releases.map((r: any) => r.id);
        assert(!releaseIds.includes(giaGithubRelease) && !releaseIds.includes(hugoGithubRelease), 'both released GitHub copies are gone');
        const keptReleases = before.releases.filter((r: any) => r.id !== giaGithubRelease && r.id !== hugoGithubRelease);
        assert(same(after.releases.filter((r: any) => keptReleases.some((k: any) => k.id === r.id)).map(releaseHeld), keptReleases.map(releaseHeld))
            && after.releases.length >= keptReleases.length,
        `every other released copy is as it was (${keptReleases.length} kept, ${after.releases.length} now)`);
        assert([giaGithubRelease, hugoGithubRelease].every((id) => after.tombstones.some((t: any) => t.table_name === 'recovery_releases' && t.row_key === String(id))),
            'with a tombstone each, so a standby deletes them too');

        assert(same(after.joins.map((j: any) => j.member_pubkey), [ned.pk]) && same(after.joins, before.joins.filter((j: any) => j.member_pubkey === ned.pk)),
            'Mia\'s GitHub open-door record is gone, and Ned\'s Google one is as it was');
        const miaNow = await main.send('member', { pk: mia.pk });
        assert(miaNow?.status === 'active' && !miaNow?.is_visitor, `Mia is still a member, not taken for a visitor (${JSON.stringify(miaNow)})`);

        // The sign-in answers and the routes.
        const nonce = await main.send('signed', { seedHex: ines.seedHex, path: '/api/recovery/sso-nonce' });
        assert(nonce.status === 200 && !nonce.body?.providers?.includes('github') && !('githubFlow' in (nonce.body ?? {})),
            `the sign-in nonce offers no GitHub (${JSON.stringify({ status: nonce.status, providers: nonce.body?.providers, githubFlow: nonce.body?.githubFlow })})`);
        // Each GitHub route answers as a route that does not exist: some of their handlers answered 404 themselves ("no
        // recovery session", "invite-only"), so the answer is compared with one to a path next to it that never existed.
        const device = crypto.randomBytes(32).toString('hex');
        for (const [seedHex, route, body] of [
            [ines.seedHex, '/api/recovery/sso/github/start', {}], [ines.seedHex, '/api/recovery/sso/github/poll', { sessionId: 'x' }],
            [device, '/api/recovery/collect/github/start', { collectionId: 'x' }], [device, '/api/recovery/collect/github/poll', { collectionId: 'x', sessionId: 'x' }],
            [device, '/api/join/github/start', {}], [device, '/api/join/github/poll', { sessionId: 'x' }],
        ] as [string, string, unknown][]) {
            const r = await main.send('signed', { seedHex, path: route, body });
            const none = await main.send('signed', { seedHex, path: route.replace('/github/', '/no-such-provider/'), body });
            assert(r.status === 404 && same(r, none), `${route} answers as no route (${r.status} ${JSON.stringify(r.body)}; no route: ${none.status} ${JSON.stringify(none.body)})`);
        }
        const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
        const deposit = await main.send('signed', { seedHex: ines.seedHex, path: '/api/recovery/shares/sso', body: {
            provider: 'github', proof: { sessionId: 'x' }, nonce: 'x', shares: [{ holderType: 'sso', holderRef: 'github', shareIndex: 1,
                encryptedShare: b64(32), shareIv: b64(24), shareTag: b64(16), kdfParams: JSON.stringify({ alg: 'scrypt-xc20p-single-v1', salt: b64(32), N: 16384, r: 8, p: 1 }) }],
        } });
        assert(deposit.status === 400 && /not a sign-in provider/.test(deposit.body?.error ?? ''), `a GitHub copy is refused as no sign-in provider (${deposit.status} ${deposit.body?.error})`);

        // A second start removes nothing.
        const beforeSecond = await main.send('state');
        await main.kill('SIGTERM');
        main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        assert((main.output().match(githubLine) ?? []).length === 0, 'the next start finds nothing to remove, and says nothing');
        const again = await main.send('state');
        assert(same(again, beforeSecond), 'and changes nothing');

        // ── 4. Standby A pulls ──
        console.log('\n— 4. standby A pulls, a delta then a whole copy: it holds exactly what the main server holds —');
        // The main server listens on a new port after each start.
        await a.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const agree = async (when: string) => {
            const m = await main.send('state');
            const s = await a.send('state');
            assert(same(s.copies.map(asHeld), m.copies.map(asHeld)),
                `${when}: every copy on the standby is the main server's, as it holds it (${s.copies.length} / ${m.copies.length}; only on the standby: ${JSON.stringify(named(s.copies.filter((r: any) => !m.copies.some((x: any) => same(asHeld(x), asHeld(r))))))})`);
            assert(same(s.releases.map(releaseHeld), m.releases.map(releaseHeld)), `${when}: and every released copy (${s.releases.length} / ${m.releases.length})`);
            assert(same(s.joins, m.joins), `${when}: and every open-door record (${s.joins.length} / ${m.joins.length})`);
            assert(!s.copies.some((c: any) => c.ref === 'github'), `${when}: no GitHub copy on the standby`);
        };
        const delta = await a.send('pull', {});
        require_(delta.ok === true && delta.whole === false, `standby A pulls a delta (${JSON.stringify({ ok: delta.ok, error: delta.error, whole: delta.whole })})`);
        await agree('after the delta');
        const whole = await a.send('pull', { whole: true });
        require_(whole.ok === true && whole.whole === true, `and then a whole copy (${JSON.stringify({ ok: whole.ok, error: whole.error, whole: whole.whole })})`);
        await agree('after the whole copy');
        const refused = await a.send('write-open-joins', { joins: [{ memberPubkey: mia.pk, provider: 'github', joinHash: crypto.randomBytes(32).toString('base64url'),
            joinedAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 60_000).toISOString() }] });
        assert(refused.invalid === 1 && refused.written === 0, `a GitHub open-door record arriving from a main server is refused (${JSON.stringify(refused)})`);
        assert(!(await a.send('state')).joins.some((j: any) => j.provider === 'github'), 'and is not stored');

        // ── 5. Standby B takes over ──
        console.log('\n— 5. the main server dies, and standby B, which still holds every GitHub row, takes over —');
        await a.kill('SIGTERM');
        await main.kill('SIGKILL');
        b = await spawnNode(SCRIPT, dirs.b, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(b);
        require_(b.ready.role === 'backup', 'standby B starts as a standby');
        assert((b.output().match(githubLine) ?? []).some((l) => /removed 0 GitHub recovery copies[^\n]*1 open-door join record\b/.test(l)),
            'it removes its own GitHub open-door record as it starts');
        const bBefore = await b.send('state');
        require_(bBefore.copies.filter((c: any) => c.ref === 'github').length === 5 && bBefore.releases.length === 3 && bBefore.joins.length === 1,
            `it holds the five GitHub copies and the released ones, as copied before the main server's start (${bBefore.copies.filter((c: any) => c.ref === 'github').length})`);
        const opened = await post(b.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(b.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await b.exited;
        assert(exit === 0, `standby B restarts itself (exit ${exit})`);
        b = await spawnNode(SCRIPT, dirs.b, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(b);
        require_(b.ready.role === 'primary', 'it is the main server');
        const bLines = b.output().match(githubLine) ?? [];
        assert(bLines.some((l) => /removed 5 GitHub recovery copies \(5 members, 2 of them left with no sign-in copy\), 2 released copies/.test(l)),
            `at its first start as the main server it removes every GitHub copy and released copy it inherited (${JSON.stringify(bLines)})`);
        const bAfter = await b.send('state');
        assert(!bAfter.copies.some((c: any) => c.ref === 'github'), 'no GitHub copy is left on the server that took over');
        assert(bAfter.releases.length === 1 && !bAfter.joins.some((j: any) => j.provider === 'github'), `nor a released GitHub copy, nor a GitHub open-door record (${bAfter.releases.length} released)`);
        for (const m of [gia, jo, kai]) {
            assert(same(of(bAfter.copies, m).map((c: any) => c.print).sort(), of(after.copies, m).map((c: any) => c.print).sort()),
                `${m.name} keeps the same copies there as on the main server that restarted`);
        }
        const giaThere = await b.send('recovery-recover', { callsign: 'Gia' });
        assert(giaThere.released.status === 200 && giaThere.seedHex === gia.seedHex, `Gia's Google sign-in brings her account back there (${giaThere.released.status} ${giaThere.error ?? 'opened'})`);
        const joThere = await b.send('open-copy', { pk: jo.pk, provider: 'apple', sub: SUBS.joApple });
        assert(joThere.seedHex === jo.seedHex, `and Jo's Apple copy opens there (${joThere.error ?? 'opened'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ GitHub is no longer a sign-in: every GitHub row goes at a server\'s start, a standby matches, and a take-over brings none back.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
