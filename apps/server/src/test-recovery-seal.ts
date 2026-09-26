/**
 * The node locks every sign-in recovery copy with a key kept outside its database (recovery seal S1:
 * services/recovery-seal-key.ts, engine/recovery-shares.ts). Over real HTTP, through the real signature
 * middleware, with the round-trip suite's Google fixture (test-sso-recovery-roundtrip.ts):
 *
 *   1. after a deposit, the database FILE holds none of the client's seed box, salt or words box;
 *   2. a copy of state.db, opened in a second process with no key file, does not open with the sub;
 *   3. the same copy beside the key file opens, to the same seed;
 *   4. with the key file deleted at runtime, a deposit is refused (503, the sentence) and stores nothing, and a
 *      collect answers the sentence;
 *   5. rows written before the wrap (the frozen 1b fixtures) are wrapped by the migration, a second run changes
 *      nothing, and they still recover end to end;
 *   6. a released row in recovery_releases holds none of the inner bytes, and the fragments route hands back
 *      exactly what the client deposited;
 *   7. the reverse migration (the rollback command, run as a command) restores the rows byte for byte;
 *   8. a standby (NODE_ROLE=backup) makes no key file, a main server makes one (0600), and an unreadable key
 *      file never stops a boot;
 *   9. moving a member to a new key (the re-key wizard) keeps their copy openable, and stamps what it moves;
 *  10. without the key file, a re-key is refused and changes nothing, and the same code works once the key is back;
 *  11. a copy locked with another key stays under the old key it is bound to, and the re-key does not wait on it.
 *  12. copies a main server dropped BEFORE the seal (re-deposits, removals, a purge, the way the code before it deleted:
 *      secure_delete off) are gone from state.db and its WAL after the upgrade's boot: one VACUUM, once, retried at the
 *      next boot when the disk has no room, and posts' search still finds the right post after it;
 *  13. the same on a standby, which never wraps, with the history of a real one: it imported deposits and re-deposits,
 *      then its main server's members disconnected or were purged, which no pull carries, so their copies are still rows
 *      there that open with the sub alone. Its one VACUUM waits while every copy is in the old form and runs after the
 *      delta that brings the main server's wrapped ones; that delta removes nothing, and the standby's real puller then
 *      pulls one whole copy, after which none of the deleted copies is a row, none of any dropped or replaced copy is left
 *      in its state.db, -wal or -shm, and after a take-over (the real one, by recovery code: the main server's key comes
 *      inside its take-over envelope, S2) every current copy opens to exactly what its member deposited and no deleted
 *      one came back;
 *  14. a data folder without hard links (link() fails with EPERM, ENOTSUP, EMLINK, ENOSYS or EXDEV) still gets its key,
 *      made in place, never over a file already there, and a failed write leaves nothing behind;
 *  15. on a standby, only a whole copy removes a copy in the old form, and only one its main server no longer holds;
 *  16. a standby that holds no copy at its first boot on this code (a new one beside a main server that has not updated,
 *      or one whose main server holds none yet) records no clear: it seeds by its real force-resync from the main server
 *      before the seal, takes the members' re-deposits, and only the delta that brings the wrapped copies clears it, after
 *      which its running state.db, -wal and -shm hold none of the copies it was sent in the client's form;
 *  17. a standby whose main server deleted every copy before the seal: a routine whole copy of that server removes all
 *      of them and a force-resync clears them, and either way its running files hold none of them, nor of the older copies
 *      its re-deposits dropped, while it records no clear until the first wrapped copy arrives;
 *  18. (S2, S1's last finding) a standby that recorded its clear and is then sent copies in the client's form (its main
 *      server rolled back past the seal) forgets the record, waits through the rollback's deltas, and clears again after
 *      the delta that brings the wrapped copies back, after which its running files hold none of them;
 *  19. (S2) a carried key never loses one already there: the one it replaces is kept (retired), byte for byte, 0600;
 *      the reader opens what only the retired key opens; the boot locks those rows again with the live key; a crash
 *      between the two writes finishes at the next run; nothing is ever written over a different file.
 *
 * 20–29, a rollback past the seal, are in test-recovery-seal-rollback.ts and test-recovery-seal-removed.ts. The three
 * share recovery-seal-test-harness.ts and keep one numbering.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-seal.ts
 *
 * The second processes are this file again, with RECOVERY_SEAL_CHILD set (recovery-seal-test-harness.ts runs them);
 * each gets its own data directory and is stopped with this run however it ends.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sealSeedToSso, openSeedFromSso, openShareFromSso } from '@beanpool/core';
import {
    CHILD, SEAL_CLI, SENTENCE, KEY_FILE, GOOGLE_SUB, WORDS, SEED, OLD_SEED_HEX, OLD_LOOKUP_SALT, OLD_ENROLMENTS, CLEARED_KEY,
    FTS_PROBE_WORD, type Sealed, type History, type StandbyScript, type Id, fakeCopy, needlesOf, copiesFoundIn, exportRow, idFromSeed,
    newId, tempDir, runChild, resultOf, thrown, child, check, section, finish, sealLines, bootParent,
} from './recovery-seal-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
    console.log('\nRecovery seal S1: sign-in recovery copies a database alone cannot open\n');
    const { keyPath, dbPath, getCurrentShares, listReleases, call, addMember, deposit, collectGoogle, foundInDbFiles } = await bootParent();
    const { db } = await import('./db/db.js');

    // ── 1. after a deposit, the database file holds none of the client's box ───────────────────
    const m1 = idFromSeed(SEED);
    const callsign1 = addMember(m1, 'Seal');
    const sealed1 = await sealSeedToSso(new Uint8Array(SEED), 'google', GOOGLE_SUB, { words: WORDS }) as Sealed;
    const needles1 = needlesOf(sealed1);
    await section('1. a deposit leaves nothing in the database that the sub alone opens', async () => {
        const { res } = await deposit(m1, sealed1);
        check(res.status === 200 && res.body?.threshold === 1, `the deposit is accepted through the real middleware (got ${res.status} ${JSON.stringify(res.body)})`);
        check(foundInDbFiles([{ label: 'callsign', bytes: Buffer.from(callsign1) }]).length === 1,
            'control: the search does find what the database really holds (the callsign)');
        const inWal = foundInDbFiles(needles1);
        check(inWal.length === 0, `state.db and its WAL hold none of the client's seed box, salt or words box (found: ${inWal.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...nor does state.db after a checkpoint (found: ${inFile.join(', ') || 'none'})`);
        const row = db.prepare("SELECT kdf_params, sso_lookup_hash FROM recovery_shares WHERE owner_pubkey = ?").get(m1.pk) as any;
        check(!!row?.sso_lookup_hash, 'the lookup hash stays in the clear, where it finds the row and reveals nothing');
        check(!!row && JSON.parse(row.kdf_params).alg === 'node-wrap-xc20p-v1' && JSON.parse(row.kdf_params).inner === 'scrypt-xc20p-single-v1',
            `the stored kdf_params names the node wrap and the client scheme inside it, and nothing else (got ${row?.kdf_params})`);
        const served = getCurrentShares(m1.pk)[0];
        check(!!served && served.encryptedShare === sealed1.encryptedShare && served.shareIv === sealed1.shareIv
            && served.shareTag === sealed1.shareTag && served.kdfParams === sealed1.kdfParams,
            'every caller above storage still sees the bytes the client deposited');
    });

    // ── 6. a released row holds none of the inner bytes; the fragments route returns the deposit ──
    let collection6 = '';
    let eph6: Id | null = null;
    await section('6. a released copy is no more readable in the database than a stored one', async () => {
        const { eph, collectionId, released } = await collectGoogle(callsign1, GOOGLE_SUB);
        collection6 = collectionId; eph6 = eph;
        check(released.status === 200 && released.body?.enough === true, `a verified sign-in releases the copy (got ${released.status} ${JSON.stringify(released.body)})`);
        const rel = db.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(collectionId) as any;
        check(!!rel, 'the release is recorded in recovery_releases');
        const relText = Buffer.from(JSON.stringify(rel ?? {}));
        const inRow = needles1.filter(n => relText.includes(n.bytes)).map(n => n.label);
        check(!!rel && inRow.length === 0 && rel.payload !== sealed1.encryptedShare,
            `the release row holds none of the inner bytes (found: ${inRow.join(', ') || 'none'})`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        const inFile = foundInDbFiles(needles1);
        check(inFile.length === 0, `...and neither does the database file (found: ${inFile.join(', ') || 'none'})`);
        const frags = await call(eph, '/api/recovery/collect/fragments', { collectionId });
        const f = frags.body?.fragments?.[0];
        check(frags.status === 200 && frags.body?.fragments?.length === 1, `the fragments route answers the device (got ${frags.status})`);
        check(!!f && f.payload === sealed1.encryptedShare && f.payloadIv === sealed1.shareIv && f.payloadTag === sealed1.shareTag
            && f.kdfParams === sealed1.kdfParams, '...with exactly what the client deposited, byte for byte');
        const opened = await openSeedFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', GOOGLE_SUB);
        check(Buffer.from(opened.seed).equals(SEED) && JSON.stringify(opened.words) === JSON.stringify(WORDS),
            '...which the recovering device opens with its sign-in to the seed and the 12 words');
    });

    // ── 2 and 3. a copy of the database, in another process, without and with the key ─────────
    await section('2. a copy of state.db in a second process, with no key file, does not open with the sub', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('nokey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.rowFound === true, 'the copy holds the member\'s sign-in row');
        check(typeof r.asStored === 'string' && r.asStored.startsWith('threw:'), `the row as stored does not open with the sub (${r.asStored})`);
        check(typeof r.withClientSalt === 'string' && /did not open/.test(r.withClientSalt),
            `even with the client's own salt beside the sub, the stored box fails on the tag (${r.withClientSalt})`);
        check(r.serverReader === `threw: ${SENTENCE}`, `and this server's own reader, with no key file, says the sentence (${r.serverReader})`);
    });

    await section('3. the same copy beside the key file opens, to the same seed', async () => {
        check(fs.existsSync(keyPath), 'the main server keeps data/recovery-seal.key');
        const st = fs.existsSync(keyPath) ? fs.statSync(keyPath) : null;
        check(!!st && st.size === 32 && (st.mode & 0o777) === 0o600, `...32 bytes, readable by the server alone (0600) (got ${st?.size} bytes, ${st ? (st.mode & 0o777).toString(8) : '-'})`);
        const copy = tempDir('withkey');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (st) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        const r = resultOf(await runChild([SCRIPT], copy, {
            RECOVERY_SEAL_CHILD: 'open-with-key', SEAL_OWNER: m1.pk, SEAL_CLIENT_KDF: sealed1.kdfParams,
        }));
        check(r.serverReader === 'opened' && r.seedHex === SEED.toString('hex'), `with the key, the copy opens to the member's seed (${r.serverReader})`);
        check(JSON.stringify(r.words) === JSON.stringify(WORDS), '...and the 12 words inside it');
    });

    // ── 4. the key file deleted while the server runs ───────────────────────────────────────────
    await section('4. with the key file gone, a deposit is refused and stores nothing, and a collect says so', async () => {
        const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
        check(!!saved, 'setup: the key file exists before it is deleted');
        fs.rmSync(keyPath, { force: true });
        try {
            const m4 = newId();
            addMember(m4, 'SealNoKey');
            const sealed4 = await sealSeedToSso(new Uint8Array(m4.seed), 'google', GOOGLE_SUB) as Sealed;
            const d = await deposit(m4, sealed4);
            check(d.res.status === 503 && d.res.body?.error === SENTENCE,
                `a deposit is refused with 503 and the sentence (got ${d.res.status} ${JSON.stringify(d.res.body)})`);
            const stored = (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(m4.pk) as any).n;
            check(stored === 0, `...and nothing is stored, wrapped or not (${stored} rows)`);

            const c = await collectGoogle(callsign1, GOOGLE_SUB);
            check(c.opened.status === 200, `a recovering device can still open a collection (got ${c.opened.status})`);
            check(c.released.status === 503 && c.released.body?.error === SENTENCE,
                `...and the sign-in release answers 503 with the sentence (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
            if (eph6) {
                const frags = await call(eph6, '/api/recovery/collect/fragments', { collectionId: collection6 });
                check(frags.status === 503 && frags.body?.error === SENTENCE,
                    `a copy already released is not served either (got ${frags.status} ${JSON.stringify(frags.body)})`);
            }
            const status = await call(m1, '/api/recovery/shares/status', {});
            check(status.status === 503 && status.body?.error === SENTENCE,
                `the member's protection status says the same rather than reporting a copy that cannot open (got ${status.status})`);

            if (saved) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            const again = await deposit(m4, sealed4, d.nonce, d.token);
            check(again.res.status === 200,
                `with the key back, the same sign-in deposits: the refusal did not spend its nonce (got ${again.res.status} ${JSON.stringify(again.res.body)})`);
            const releasedNow = await call(c.eph, '/api/recovery/collect/sso', {
                collectionId: c.collectionId, provider: 'google', idToken: c.token, nonce: c.nonce,
            });
            check(releasedNow.status === 200 && releasedNow.body?.enough === true,
                `...and the recovering device's same sign-in releases: its nonce was not spent either (got ${releasedNow.status} ${JSON.stringify(releasedNow.body)})`);
        } finally {
            if (saved && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 5. rows written before the wrap are wrapped in place, once ──────────────────────────────
    const oldMember = idFromSeed(Buffer.from(OLD_SEED_HEX, 'hex'));
    const oldCallsign = addMember(oldMember, 'SealOld');
    const PRE_COLLECTION = `pre-wrap-${crypto.randomBytes(8).toString('hex')}`;
    const STALE = '2026-01-01T00:00:00.000Z';
    await section('5. the migration wraps copies stored before it, a second run changes nothing, and they still recover', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const ins = db.prepare(`INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
             sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at)
            VALUES (?, 'sso', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
        const ids: number[] = [];
        OLD_ENROLMENTS.forEach((o, i) => {
            ids.push(Number(ins.run(oldMember.pk, o.provider, i + 1, o.sealed.encryptedShare, o.sealed.shareIv, o.sealed.shareTag,
                o.lookupHash, OLD_LOOKUP_SALT, o.sealed.kdfParams, STALE, STALE).lastInsertRowid));
        });
        db.prepare(`INSERT INTO recovery_collections (id, owner_pubkey, generation, requester_ephemeral_pubkey, status, created_at, expires_at)
                    VALUES (?, ?, 1, ?, 'complete', ?, ?)`).run(PRE_COLLECTION, oldMember.pk, newId().pk, STALE, STALE);
        const g = OLD_ENROLMENTS[0].sealed;
        db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag, kdf_params, released_at)
                    VALUES (?, ?, 'sso', 1, ?, ?, ?, ?, ?)`).run(PRE_COLLECTION, ids[0], g.encryptedShare, g.shareIv, g.shareTag, g.kdfParams, STALE);

        const first = seal.wrapRecoveryRows();
        check(first.shares === 2 && first.releases === 1, `the first run wraps the two copies and the one release stored before it (got ${JSON.stringify(first)})`);
        const snap = () => JSON.stringify({
            shares: db.prepare('SELECT id, encrypted_share, share_iv, share_tag, kdf_params, updated_at FROM recovery_shares ORDER BY id').all(),
            releases: db.prepare('SELECT id, payload, payload_iv, payload_tag, kdf_params, updated_at FROM recovery_releases ORDER BY id').all(),
        });
        const afterFirst = snap();
        const wrapped = db.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? ORDER BY id').all(oldMember.pk) as any[];
        check(wrapped.length === 2 && wrapped.every(r => JSON.parse(r.kdf_params).alg === 'node-wrap-xc20p-v1'),
            'both are now wrapped');
        check(wrapped.every(r => r.updated_at > STALE), '...and stamped, so a standby that already holds the unwrapped copy is sent the wrapped one');
        check(wrapped.every(r => r.sso_lookup_hash === OLD_ENROLMENTS.find(o => o.provider === r.holder_ref)!.lookupHash
            && r.sso_lookup_salt === OLD_LOOKUP_SALT), '...with their lookup hashes untouched');
        const second = seal.wrapRecoveryRows();
        check(second.shares === 0 && second.releases === 0, `a second run finds nothing to do (got ${JSON.stringify(second)})`);
        check(snap() === afterFirst, '...and every row is byte for byte what the first run left');
        const oldNeedles = OLD_ENROLMENTS.flatMap(o => needlesOf(o.sealed as Sealed));
        const left = foundInDbFiles(oldNeedles);
        check(left.length === 0, `the migration leaves none of the unwrapped bytes in the database files (found: ${left.join(', ') || 'none'})`);

        const c = await collectGoogle(oldCallsign, OLD_ENROLMENTS[0].sub);
        check(c.released.status === 200 && c.released.body?.enough === true, `a copy stored before the wrap still releases on a verified sign-in (got ${c.released.status} ${JSON.stringify(c.released.body)})`);
        const frags = await call(c.eph, '/api/recovery/collect/fragments', { collectionId: c.collectionId });
        const f = frags.body?.fragments?.[0];
        check(!!f && f.payload === g.encryptedShare && f.payloadIv === g.shareIv && f.payloadTag === g.shareTag && f.kdfParams === g.kdfParams,
            '...as exactly the bytes the earlier code stored');
        const seed = f ? await openShareFromSso({ encryptedShare: f.payload, shareIv: f.payloadIv, shareTag: f.payloadTag, kdfParams: f.kdfParams }, 'google', OLD_ENROLMENTS[0].sub) : null;
        check(!!seed && Buffer.from(seed).toString('hex') === OLD_SEED_HEX, '...which opens with the sign-in to the member\'s seed');
        const pre = listReleases(PRE_COLLECTION)[0];
        check(!!pre && pre.payload === g.encryptedShare && pre.payloadIv === g.shareIv && pre.payloadTag === g.shareTag && pre.kdfParams === g.kdfParams,
            'a release recorded before the wrap reads back as it was recorded');
    });

    // ── 7. the reverse migration: the rollback command ──────────────────────────────────────────
    await section('7. the reverse migration restores every row byte for byte', async () => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const copy = tempDir('rollback');
        fs.copyFileSync(dbPath, path.join(copy, 'state.db'));
        if (fs.existsSync(keyPath)) fs.copyFileSync(keyPath, path.join(copy, KEY_FILE));
        check(!!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY),
            'setup: this server recorded clearing its database at boot');
        const r = await runChild([SEAL_CLI, '--unwrap-recovery-rows'], copy, {});
        check(r.code === 0, `the rollback command exits 0 (got ${r.code}: ${r.stderr.slice(-400)})`);
        check(!/[A-Za-z0-9+/]{40,}={0,2}/.test(r.stdout.replace(/[0-9a-f]{64}/g, '')), 'its output holds counts, not keys or copies');
        const back = new Database(path.join(copy, 'state.db'), { readonly: true });
        try {
            const cols = (row: any) => row && { encryptedShare: row.encrypted_share, shareIv: row.share_iv, shareTag: row.share_tag, kdfParams: row.kdf_params };
            const same = (a: any, b: Sealed) => !!a && a.encryptedShare === b.encryptedShare && a.shareIv === b.shareIv
                && a.shareTag === b.shareTag && a.kdfParams === b.kdfParams;
            for (const o of OLD_ENROLMENTS) {
                const row = back.prepare('SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_ref = ?').get(oldMember.pk, o.provider);
                check(same(cols(row), o.sealed as Sealed), `${o.provider}: the copy stored before the wrap is back exactly as it was`);
            }
            const m1Row = back.prepare("SELECT * FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso'").get(m1.pk);
            check(same(cols(m1Row), sealed1), 'a copy deposited after the wrap comes back as exactly what the client sent');
            const rel = (id: string) => {
                const x = back.prepare('SELECT * FROM recovery_releases WHERE collection_id = ?').get(id) as any;
                return x && { encryptedShare: x.payload, shareIv: x.payload_iv, shareTag: x.payload_tag, kdfParams: x.kdf_params };
            };
            check(same(rel(PRE_COLLECTION), OLD_ENROLMENTS[0].sealed as Sealed), 'the release recorded before the wrap is back as it was');
            if (collection6) check(same(rel(collection6), sealed1), 'a release recorded after the wrap comes back as the client\'s bytes');
            const still = (back.prepare("SELECT COUNT(*) AS n FROM recovery_shares WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n
                + (back.prepare("SELECT COUNT(*) AS n FROM recovery_releases WHERE kdf_params LIKE '%node-wrap-xc20p-v1%'").get() as any).n;
            check(still === 0, `no wrapped row is left for the older server to trip on (${still})`);
            check(!back.prepare('SELECT 1 FROM node_config WHERE key = ?').get(CLEARED_KEY),
                'the record of the clearing is gone: the older server deletes without zeroing, so coming back clears again');
        } finally { back.close(); }
    });

    // ── 8. who makes a key, and a boot that never stops for one ─────────────────────────────────
    await section('8. a standby makes no key file; a main server makes one; a bad key file never stops a boot', async () => {
        const standby = resultOf(await runChild([SCRIPT], tempDir('standby'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'backup' }));
        check(standby.booted === true && standby.keyExists === false, `a standby (NODE_ROLE=backup) boots with no key of its own (${JSON.stringify(standby)})`);
        const main = resultOf(await runChild([SCRIPT], tempDir('main'), { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(main.booted === true && main.keyExists === true && main.keyBytes === 32 && main.keyMode === '600',
            `a main server makes its key at boot: 32 bytes, 0600 (${JSON.stringify(main)})`);
        const badDir = tempDir('badkey');
        fs.writeFileSync(path.join(badDir, KEY_FILE), Buffer.from('short'), { mode: 0o600 });
        const bad = resultOf(await runChild([SCRIPT], badDir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' }));
        check(bad.booted === true, `a key file that is not a key does not stop the boot (${JSON.stringify(bad)})`);
        check(fs.readFileSync(path.join(badDir, KEY_FILE)).toString() === 'short', '...and is never overwritten: it may be the only copy someone can repair');
    });

    // ── 9. a member moved to a new key keeps an openable copy ───────────────────────────────────
    await section('9. moving a member to a new key keeps their copy openable', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const m9 = newId();
        addMember(m9, 'SealRekey');
        const sealed9 = await sealSeedToSso(new Uint8Array(m9.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m9, sealed9);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        // A copy another member holds for m9 (a member keeper), so the rename is seen too. Both rows stamped long ago.
        const other9 = newId();
        addMember(other9, 'SealRekeyOther');
        const keeperRowId = Number(db.prepare(`INSERT INTO recovery_shares
            (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
            VALUES (?, 'member', ?, 1, 'a', 'b', 'c', 1)`).run(other9.pk, m9.pk).lastInsertRowid);
        const ownRowId = (db.prepare('SELECT id FROM recovery_shares WHERE owner_pubkey = ?').get(m9.pk) as any)?.id;
        db.prepare('UPDATE recovery_shares SET updated_at = ? WHERE id IN (?, ?)').run(STALE, ownRowId, keeperRowId);
        const moved = newId();
        const { code } = issueRekeyCode(m9.pk, 'owner:password');
        completeRekey(m9.pk, moved.pk, code, 'owner:password');
        const shares = getCurrentShares(moved.pk);
        check(shares.length === 1 && shares[0].encryptedShare === sealed9.encryptedShare && shares[0].kdfParams === sealed9.kdfParams,
            'after the move, the copy is filed under the new key and still opens with the server\'s key');
        const seed = shares[0] ? await openShareFromSso(shares[0] as Sealed, 'google', GOOGLE_SUB) : null;
        check(!!seed && Buffer.from(seed).equals(m9.seed), '...to the seed it was made from');
        const own = db.prepare('SELECT owner_pubkey, updated_at FROM recovery_shares WHERE id = ?').get(ownRowId) as any;
        check(own?.owner_pubkey === moved.pk && own.updated_at > STALE,
            `the moved copy is stamped, so a standby is sent the move (updated_at ${own?.updated_at})`);
        const keeper = db.prepare('SELECT holder_ref, updated_at FROM recovery_shares WHERE id = ?').get(keeperRowId) as any;
        check(keeper?.holder_ref === moved.pk && keeper.updated_at > STALE,
            `...and so is a copy the member keeps for someone else, renamed to the new key (updated_at ${keeper?.updated_at})`);
    });

    // ── 10. without the key file, a re-key moves nothing, and runs once the key is back ────────
    await section('10. without the key file, a re-key is refused and changes nothing, and runs once the key is back', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const { getMember } = await import('./state-engine.js');
        const m10 = newId();
        addMember(m10, 'SealRekeyNoKey');
        const sealed10 = await sealSeedToSso(new Uint8Array(m10.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m10, sealed10);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        const moved = newId();
        const { code } = issueRekeyCode(m10.pk, 'owner:password');
        const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
        check(!!saved, 'setup: the key file exists before it is deleted');
        fs.rmSync(keyPath, { force: true });
        try {
            let refused = '';
            try { completeRekey(m10.pk, moved.pk, code, 'owner:password'); } catch (e) { refused = (e as Error)?.message ?? String(e); }
            check(refused === SENTENCE, `the re-key is refused with the sentence (got ${refused || 'no refusal'})`);
            const under = (pk: string) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?').get(pk) as any).n;
            check(under(m10.pk) === 1 && under(moved.pk) === 0, 'the copy stays under the old key, where it is bound');
            check(!!getMember(m10.pk) && !getMember(moved.pk), '...and nothing else moved: the whole re-key rolled back');
            const req = db.prepare('SELECT status FROM rekey_requests WHERE code = ?').get(code) as any;
            check(req?.status === 'pending', `the re-enrolment code is still pending (got ${req?.status})`);

            if (saved) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            completeRekey(m10.pk, moved.pk, code, 'owner:password');
            const shares = getCurrentShares(moved.pk);
            const seed = shares[0] ? await openShareFromSso(shares[0] as Sealed, 'google', GOOGLE_SUB) : null;
            check(shares.length === 1 && !!seed && Buffer.from(seed).equals(m10.seed),
                'with the key back, the same code moves the member, and the copy opens under the new key to their seed');
        } finally {
            if (saved && !fs.existsSync(keyPath)) fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 11. a copy another key locked stays where it is bound, and the re-key does not wait on it ──
    await section('11. a copy locked with another key stays under the old key, where it still opens, and the re-key completes', async () => {
        const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
        const { getMember } = await import('./state-engine.js');
        const m11 = newId();
        addMember(m11, 'SealRekeyLocked');
        const sealed11 = await sealSeedToSso(new Uint8Array(m11.seed), 'google', GOOGLE_SUB) as Sealed;
        const { res } = await deposit(m11, sealed11);
        check(res.status === 200, `setup: the member deposits a copy (got ${res.status})`);
        const rowId = (db.prepare('SELECT id FROM recovery_shares WHERE owner_pubkey = ?').get(m11.pk) as any)?.id;
        const moved = newId();
        const { code } = issueRekeyCode(m11.pk, 'owner:password');
        const saved = fs.readFileSync(keyPath);
        // Another server's key, as after a restore from a plain backup: this one does not open the copy.
        fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
        try {
            let threw = '';
            try { completeRekey(m11.pk, moved.pk, code, 'owner:password'); } catch (e) { threw = (e as Error)?.message ?? String(e); }
            check(threw === '' && !!getMember(moved.pk) && !getMember(m11.pk), `the re-key completes (${threw || 'no error'})`);
            const row = db.prepare('SELECT owner_pubkey FROM recovery_shares WHERE id = ?').get(rowId) as any;
            check(row?.owner_pubkey === m11.pk, 'the copy it cannot open stays under the old key it is bound to');
            check(getCurrentShares(moved.pk).length === 0, '...so the new key holds no copy that could never open');

            fs.writeFileSync(keyPath, saved, { mode: 0o600 });
            const back = getCurrentShares(m11.pk);
            const seed = back[0] ? await openShareFromSso(back[0] as Sealed, 'google', GOOGLE_SUB) : null;
            check(back.length === 1 && back[0].encryptedShare === sealed11.encryptedShare && !!seed && Buffer.from(seed).equals(m11.seed),
                'with the key that locked it back, the copy left there still opens, to the seed it was made from');
        } finally {
            fs.writeFileSync(keyPath, saved, { mode: 0o600 });
        }
    });

    // ── 12. copies a main server dropped before the seal ────────────────────────────────────────
    await section('12. copies a main server dropped before the seal are gone from state.db and its WAL after the upgrade', async () => {
        const dir = tempDir('dropped-main');
        const fx = resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-node' }));
        const dropped: Sealed[] = fx.dropped;
        const live: Sealed[] = fx.live;
        const before = copiesFoundIn(dir, dropped);
        check(before > 0, `control: before the upgrade, ${before} of the ${dropped.length} copies re-deposits, removals and a purge dropped are still in state.db or its WAL`);

        // The upgrade's first boot, on a disk without room for the VACUUM: the wrap runs, the clearing waits.
        const tight = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary', SEAL_FREE_BYTES: String(1024 * 1024) });
        const t = resultOf(tight);
        check(t.booted === true && t.keyExists === true, `a disk without room never stops the boot (booted ${t.booted}, key ${t.keyExists})`);
        check(t.cleared === null && /needs about \d+ MB free in .*, which has 1 MB\. The server runs; the next boot tries again/.test(tight.stderr),
            `...it says why it did not clear, and records nothing, so the next boot tries again (${sealLines(tight)})`);
        check(copiesFoundIn(dir, dropped) > 0, '...and the dropped copies are still there: it does not claim what it did not do');

        const first = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary', SEAL_FTS_PROBE: '1' });
        const f = resultOf(first);
        check(f.booted === true && f.secureDelete === 1, `the next boot runs, with secure_delete on for the connection (secure_delete ${f.secureDelete})`);
        check(typeof f.cleared === 'string' && /cleared state\.db of sign-in recovery copies deleted before the seal \(one VACUUM, [\d.]+ s/.test(first.stdout),
            `...it runs the VACUUM, says so, and records it (${sealLines(first)})`);
        const after = copiesFoundIn(dir, dropped);
        check(after === 0, `none of the ${dropped.length} dropped copies is left in state.db, -wal or -shm (found ${after}; ${before} before)`);
        const liveLeft = copiesFoundIn(dir, live);
        check(liveLeft === 0, `nor any of the ${live.length} copies the wrap rewrote (found ${liveLeft})`);
        check(f.ftsIntegrity === 'ok' && JSON.stringify(f.ftsHit) === JSON.stringify(['fixture-post-40']),
            `posts' search index still matches its posts after the VACUUM (integrity ${f.ftsIntegrity}, '${FTS_PROBE_WORD}' finds ${JSON.stringify(f.ftsHit)})`);

        const second = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'primary' });
        const s = resultOf(second);
        check(s.booted === true && s.cleared === f.cleared && !/one VACUUM/.test(second.stdout), `a later boot does not run it again (${sealLines(second)})`);
    });

    // ── 13. the same on a standby, which never wraps ────────────────────────────────────────────
    await section('13. a standby holding copies its main server deleted before the seal clears its files, then the copies, and keeps every current one', async () => {
        const mainDir = tempDir('history-main');
        const standbyDir = tempDir('history-standby');
        const N = 24;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [18, 19, 20, 21, 22, 23], real: [] };
        // Two members who keep their copy and one who deletes it have copies the app really sealed, so each can be opened.
        for (const i of [0, 1, 18]) {
            const words = [...WORDS.slice(i % WORDS.length), ...WORDS.slice(0, i % WORDS.length)].reverse();
            const seed = crypto.createHash('sha256').update(crypto.createHash('sha256').update(words.join(' ')).digest()).digest();
            h.gen2[i] = await sealSeedToSso(new Uint8Array(seed), 'google', GOOGLE_SUB, { words }) as Sealed;
            h.real.push({ i, seedHex: seed.toString('hex') });
        }
        const historyFile = path.join(tempDir('history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        const deleted = new Set(h.deleted);
        const current = owners.filter((_, i) => !deleted.has(i));
        const orphanCopies = h.gen2.filter((_, i) => deleted.has(i));
        const currentCopies = h.gen2.filter((_, i) => !deleted.has(i));

        const m = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'main' }));
        const sb = resultOf(await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        check(m.rows === N - h.deleted.length && sb.rows === N,
            `control: before the upgrade the main server holds ${m.rows} copies and its standby ${sb.rows}: the ${h.deleted.length} deleted there are still rows here`);
        const before = copiesFoundIn(standbyDir, h.gen1);
        check(before > 0, `control: ${before} of the ${N} copies the re-deposits dropped are still in the standby's state.db`);
        // What anyone holding a copy of the standby's database could do before: open a deleted member's copy with the sub.
        const snapshotOf = (dir: string) => {
            const copy = tempDir('standby-copy');
            for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
            return copy;
        };
        const orphanBefore = resultOf(await runChild([SCRIPT], snapshotOf(standbyDir), { RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: owners[18] }));
        check(orphanBefore.rowFound === true && orphanBefore.asStored === 'opened',
            `control: on the standby, the copy member 18 deleted is still a row that opens with the sub alone (${orphanBefore.asStored})`);

        // The main server upgrades: the wrap stamps every copy it holds, and its VACUUM runs. SINCE: its standby's last pull
        // before that, after the deletions.
        const SINCE = '2026-06-03T00:00:00.000Z';
        const me = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: SINCE }));
        const wrappedOnly = (rows: any[]) => rows.every(r => String(r.kdfParams).includes('node-wrap-xc20p-v1'));
        check(typeof me.cleared === 'string' && me.delta.length === current.length && me.full.length === current.length
            && wrappedOnly(me.delta) && wrappedOnly(me.full),
            `the main server seals, and its next delta, like a whole copy, carries every copy it holds, wrapped (${me.delta.length} and ${me.full.length} of ${current.length})`);
        const exportFile = path.join(tempDir('main-export'), 'export.json');
        fs.writeFileSync(exportFile, JSON.stringify({ delta: me.delta, full: me.full }));

        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-pull', NODE_ROLE: 'backup', SEAL_MAIN_EXPORT: exportFile, SEAL_SINCE: SINCE });
        const s = resultOf(r);
        const [p1, p2, p3] = s.pulls ?? [];
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped });
        check(s.keyExists === false && s.secureDelete === 1 && s.atBoot?.cleared === null && s.atBoot?.unwrapped === N,
            `at boot the standby makes no key, zeroes what it deletes, and waits: every copy it holds is in the old form (${JSON.stringify({ key: s.keyExists, secureDelete: s.secureDelete, cleared: s.atBoot?.cleared, unwrapped: s.atBoot?.unwrapped })})`);
        check(/every sign-in recovery copy it holds \(24\) is still in the form stored before the seal/.test(r.stdout + r.stderr),
            `...and says why it waits (${sealLines(r)})`);
        check(p1?.route === 'delta' && p1.since === SINCE, `its first pull after the seal is a delta from where it left off (${JSON.stringify(p1 && { route: p1.route, since: p1.since })})`);
        check(typeof p2?.before?.cleared === 'string' && p2.before.rows === N && p2.before.unwrapped === h.deleted.length,
            `after that delta brings the wrapped copies, it runs its one VACUUM, and a delta removes nothing: the ${h.deleted.length} deleted copies are still rows (${brief(p2?.before)})`);
        check(p2?.route === 'snapshot' && p2.snapshotCursor === null && /6 sign-in recovery copies in the form stored before the seal/.test(r.stdout + r.stderr),
            `...its next pull is a whole copy, never a 304, which it asked for and says why (${JSON.stringify(p2 && { route: p2.route, snapshotCursor: p2.snapshotCursor })})`);
        check(p3?.route === 'delta' && s.final?.unwrapped === 0 && s.final.rows === current.length
            && JSON.stringify(s.final.owners) === JSON.stringify([...current].sort()) && JSON.stringify(p3.before) === JSON.stringify(s.final),
            `after the whole copy, no copy the main server deleted is left, every copy it holds is here, wrapped, and the pulls go back to deltas (${brief(p3?.before)}, then ${p3?.route})`);
        check(/removed 6 sign-in recovery copies its main server deleted before the seal/.test(r.stdout),
            `...and says so (${sealLines(r)})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 1, `the VACUUM ran once (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);

        const dropped = copiesFoundIn(standbyDir, [...h.gen1, ...orphanCopies]);
        check(dropped === 0, `none of the ${N + orphanCopies.length} copies dropped or deleted before the seal is left in the standby's state.db, -wal or -shm (found ${dropped}; ${before} re-deposits before)`);
        const replaced = copiesFoundIn(standbyDir, currentCopies);
        check(replaced === 0, `nor any current copy in the form the wrapped ones replaced (found ${replaced} of ${currentCopies.length})`);
        const orphanAfter = resultOf(await runChild([SCRIPT], snapshotOf(standbyDir), { RECOVERY_SEAL_CHILD: 'open-without-key', SEAL_OWNER: owners[18] }));
        check(orphanAfter.rowFound === false, `the copy member 18 deleted is no longer a row on the standby (${orphanAfter.rowFound})`);

        // A take-over, the real one (S2): the main server's own envelope service seals its keys, the key that opens these
        // copies among them; the standby keeps that envelope, pinned to its main server, and the recovery code opens it.
        const env = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-envelope', NODE_ROLE: 'primary' }));
        check(!fs.existsSync(path.join(standbyDir, KEY_FILE)), 'control: before the take-over the standby has no key file');
        fs.copyFileSync(path.join(mainDir, 'genesis.json'), path.join(standbyDir, 'genesis.json'));
        const envFile = path.join(tempDir('history-envelope'), 'envelope.b64');
        fs.writeFileSync(envFile, env.envelope);
        const tc = resultOf(await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'takeover-confirm', NODE_ROLE: 'backup', SEAL_ENVELOPE: envFile, SEAL_MAIN_PEER: env.peerId, SEAL_CODE: env.code,
        }));
        const standbyKey = path.join(standbyDir, KEY_FILE);
        check(tc.recoverySealKey === true && /the key that opens members' sign-in recovery copies/.test(tc.identityFiles ?? '')
            && fs.existsSync(standbyKey) && fs.readFileSync(standbyKey).equals(fs.readFileSync(path.join(mainDir, KEY_FILE))) && (fs.statSync(standbyKey).mode & 0o777) === 0o600,
            `the take-over by recovery code brings the main server's key inside its envelope, byte for byte, 0600 (${JSON.stringify({ carried: tc.recoverySealKey, step: tc.identityFiles })})`);
        const t = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'takeover-open', NODE_ROLE: 'primary', SEAL_HISTORY: historyFile });
        const o = resultOf(t);
        check(o.same === current.length && o.differ.length === 0 && o.missing.length === 0 && o.unopenable.length === 0,
            `after a take-over, all ${current.length} current copies open to exactly what each member deposited (same ${o.same}, differ ${JSON.stringify(o.differ)}, missing ${JSON.stringify(o.missing)}, unopenable ${JSON.stringify(o.unopenable)})`);
        check(o.opened?.[0] === 'its seed' && o.opened?.[1] === 'its seed',
            `...and the two the app really sealed open with the sub to their member's seed (${JSON.stringify(o.opened)})`);
        check(o.held.length === 0 && o.opened?.[18] === undefined, `...and none of the ${h.deleted.length} deleted copies came back (${JSON.stringify(o.held)})`);
        check(!/cannot be opened here/.test(t.stderr), `...and the promoted server's boot names no copy it cannot open (${sealLines(t)})`);
    });

    // ── 14. a data folder without hard links ─────────────────────────────────────────────────────
    await section('14. a data folder without hard links still gets its key, made in place and never over another file', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const fsw = fs as any;
        const realLink = fs.linkSync, realFsync = fs.fsyncSync;
        const savedDir = process.env.BEANPOOL_DATA_DIR;
        const errno = (code: string) => Object.assign(new Error(`${code}: operation not permitted, link`), { code });
        const others = (dir: string) => fs.readdirSync(dir).filter(f => f !== KEY_FILE);
        try {
            for (const code of ['EPERM', 'ENOTSUP', 'EMLINK', 'ENOSYS', 'EXDEV']) {
                const dir = tempDir(`nolink-${code.toLowerCase()}`);
                process.env.BEANPOOL_DATA_DIR = dir;
                fsw.linkSync = () => { throw errno(code); };
                const kp = path.join(dir, KEY_FILE);
                let made: { created: boolean } | string;
                try { made = seal.ensureRecoverySealKey(); } catch (e) { made = thrown(e); }
                const st = fs.existsSync(kp) ? fs.statSync(kp) : null;
                check(typeof made === 'object' && made.created && st?.size === 32 && (st.mode & 0o777) === 0o600 && others(dir).length === 0,
                    `${code}: the key is made in place, 32 bytes, 0600, with no temporary file left (${JSON.stringify(made)}, ${st?.size} bytes, left ${JSON.stringify(others(dir))})`);
                const bytes = st ? fs.readFileSync(kp) : Buffer.alloc(0);
                const again = seal.ensureRecoverySealKey();
                check(!again.created && fs.readFileSync(kp).equals(bytes), `${code}: a second boot keeps it, byte for byte`);
            }
            // A key that appears between the look and the create is never written over.
            const raceDir = tempDir('nolink-race');
            process.env.BEANPOOL_DATA_DIR = raceDir;
            const theirs = crypto.randomBytes(32);
            fsw.linkSync = () => { fs.writeFileSync(path.join(raceDir, KEY_FILE), theirs, { mode: 0o600 }); throw errno('EPERM'); };
            const raced = seal.ensureRecoverySealKey();
            check(!raced.created && fs.readFileSync(path.join(raceDir, KEY_FILE)).equals(theirs) && others(raceDir).length === 0,
                'a key file that appears in the meantime is kept as it is, and nothing is left beside it');
            // Any other failure of link is not a filesystem without links: it is thrown, and nothing is left.
            const accDir = tempDir('nolink-eacces');
            process.env.BEANPOOL_DATA_DIR = accDir;
            fsw.linkSync = () => { throw errno('EACCES'); };
            let accErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { accErr = thrown(e); }
            check(accErr.includes('EACCES') && fs.readdirSync(accDir).length === 0, `EACCES is thrown, not worked around, and leaves nothing (${accErr})`);
            // A write that fails leaves no temporary file behind (it did, before: the parked "a .tmp left on a failed fsync").
            fsw.linkSync = realLink;
            const ioDir = tempDir('fsync-fails');
            process.env.BEANPOOL_DATA_DIR = ioDir;
            fsw.fsyncSync = () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); };
            let ioErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { ioErr = thrown(e); }
            check(ioErr.includes('EIO') && fs.readdirSync(ioDir).length === 0, `a failed fsync is thrown and leaves no file at all (${ioErr}; left ${JSON.stringify(fs.readdirSync(ioDir))})`);
            // Without links, a key whose own write fails is removed, so the next boot makes a whole one.
            const halfDir = tempDir('nolink-fsync-fails');
            process.env.BEANPOOL_DATA_DIR = halfDir;
            fsw.linkSync = () => { throw errno('EPERM'); };
            let syncs = 0;
            fsw.fsyncSync = (fd: number) => { if (++syncs === 2) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); return realFsync(fd); };
            let halfErr = '';
            try { seal.ensureRecoverySealKey(); } catch (e) { halfErr = thrown(e); }
            check(halfErr.includes('EIO') && fs.readdirSync(halfDir).length === 0, `without links, a key whose write fails is removed rather than left half made (${halfErr}; left ${JSON.stringify(fs.readdirSync(halfDir))})`);
            fsw.fsyncSync = realFsync;
            const retry = seal.ensureRecoverySealKey();
            check(retry.created && fs.statSync(path.join(halfDir, KEY_FILE)).size === 32, '...and the next try makes it');
        } finally {
            fsw.linkSync = realLink;
            fsw.fsyncSync = realFsync;
            process.env.BEANPOOL_DATA_DIR = savedDir;
        }
    });

    // ── 15. only a whole copy removes a copy, and only one the main server no longer holds ───────
    await section('15. on a standby, only a whole copy removes a copy in the old form, and only one its main server no longer holds', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        // This database's other copies are all wrapped, as a standby's are once its main server has sealed.
        const owner = newId().pk, other = newId().pk;
        const put = db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv,
            share_tag, sso_lookup_hash, sso_lookup_salt, kdf_params, generation) VALUES (?, 'sso', ?, 1, ?, ?, ?, ?, 'lookup-salt', ?, ?)`);
        const add = (o: string, ref: string, generation: number, c: { encryptedShare: string; shareIv: string; shareTag: string; kdfParams: string | null }) =>
            put.run(o, ref, c.encryptedShare, c.shareIv, c.shareTag, crypto.randomBytes(16).toString('hex'), c.kdfParams, generation);
        const held = fakeCopy(), deleted = fakeCopy(), otherSignIn = fakeCopy();
        add(owner, 'google', 2, held);          // still held by the main server in the old form (one rolled back, say)
        add(owner, 'github', 2, otherSignIn);   // same owner and generation, a sign-in the main server no longer holds
        add(other, 'google', 1, deleted);       // deleted there before the seal
        add(other, 'facebook', 1, seal.sealRecoveryFields(fakeCopy(), seal.shareRowAad(other, 'sso')));  // deleted there after it: wrapped
        const count = () => db.prepare('SELECT COUNT(*) FROM recovery_shares').pluck().get() as number;
        const refsOf = (o: string) => db.prepare('SELECT holder_ref FROM recovery_shares WHERE owner_pubkey = ? ORDER BY holder_ref').pluck().all(o);
        const before = count();

        seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy: null });
        check(count() === before && seal.takeRecoverySealFullPull() === true && seal.takeRecoverySealFullPull() === false,
            `after a delta nothing is removed, and the puller is asked once for a whole copy (${before - count()} removed)`);

        const wholeCopy = (db.prepare('SELECT owner_pubkey, generation, holder_type, holder_ref FROM recovery_shares').all() as any[])
            .filter(r => !(r.owner_pubkey === other || (r.owner_pubkey === owner && r.holder_ref === 'github')))
            .map(r => ({ ownerPubkey: r.owner_pubkey, generation: r.generation, holderType: r.holder_type, holderRef: r.holder_ref }));
        seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy });
        check(count() === before - 2 && JSON.stringify(refsOf(owner)) === '["google"]' && JSON.stringify(refsOf(other)) === '["facebook"]',
            `a whole copy removes the 2 copies in the old form it does not hold, and keeps the one it holds in that form and the wrapped one (${JSON.stringify({ owner: refsOf(owner), other: refsOf(other) })})`);
        const left = foundInDbFiles([...needlesOf(deleted), ...needlesOf(otherSignIn)]);
        check(left.length === 0, `...zeroed: none of their bytes is left in state.db, -wal or -shm (found: ${left.join(', ') || 'none'})`);
        db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey IN (?, ?)').run(owner, other);
    });

    // ── 16. a standby that held no copy at its first boot on this code ───────────────────────────
    await section('16. a standby that holds no copy at its first boot waits, and clears its files only once its main server\'s wrapped copies arrive', async () => {
        const mainDir = tempDir('empty-standby-main');
        const standbyDir = tempDir('empty-standby');
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [], real: [] };
        const historyFile = path.join(tempDir('empty-standby-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        // Its main server, on the code before the seal: every member deposits, then re-deposits. Then it upgrades: the wrap
        // stamps every copy, and its next delta carries them all, wrapped.
        const SINCE = '2026-06-03T00:00:00.000Z';
        resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'main' }));
        const me = resultOf(await runChild([SCRIPT], mainDir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: SINCE }));
        check(me.delta.length === N && me.delta.every((r: any) => String(r.kdfParams).includes('node-wrap-xc20p-v1')),
            `control: after the main server seals, its delta carries all ${N} copies, wrapped (${me.delta.length})`);

        // The standby boots on this code holding nothing, and seeds by its real force-resync from the main server before
        // the seal; the members' re-deposits reach it by a delta; then the delta after the seal.
        const scriptFile = path.join(tempDir('empty-standby-script'), 'script.json');
        const script: StandbyScript = {
            resyncFirst: true, reconcileMinutes: 0, pulls: 4, watch: [...h.gen1, ...h.gen2],
            steps: [
                owners.map((o, i) => exportRow(o, i, h.gen1[i], 1, '2026-06-01T00:00:00.000Z')),
                owners.map((o, i) => exportRow(o, i, h.gen2[i], 2, '2026-06-02T00:00:00.000Z')),
                me.delta,
            ],
        };
        fs.writeFileSync(scriptFile, JSON.stringify(script));
        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: scriptFile });
        const s = resultOf(r);
        const [seed, redeposits, wrapped, after] = s.pulls ?? [];
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        check(s.atBoot?.rows === 0 && s.atBoot?.cleared === null,
            `at its first boot, holding no copy, the standby records no clear: nothing shows its main server has sealed (${brief(s.atBoot)})`);
        check(/this standby waits to clear state\.db of sign-in recovery copies deleted before the seal/.test(r.stdout + r.stderr),
            `...and says it waits (${sealLines(r)})`);
        check(s.resync?.ok === true && seed?.route === 'snapshot' && redeposits?.route === 'delta' && wrapped?.route === 'delta' && after?.route === 'delta',
            `it seeds by a force-resync, then pulls deltas (${JSON.stringify({ resync: s.resync, routes: (s.pulls ?? []).map((p: any) => p.route) })})`);
        check(redeposits?.before?.rows === N && redeposits.before.unwrapped === N && redeposits.before.cleared === null && redeposits.before.inFiles > 0,
            `control: after the seed, its files hold copies in the client's form, and it still records nothing (${brief(redeposits?.before)})`);
        check(wrapped?.before?.rows === N && wrapped.before.unwrapped === N && wrapped.before.cleared === null,
            `after the re-deposits it still waits: every copy it holds is in the old form (${brief(wrapped?.before)})`);
        check(typeof after?.before?.cleared === 'string' && after.before.rows === N && after.before.unwrapped === 0,
            `the delta that brings the wrapped copies is when it clears, and records it (${brief(after?.before)})`);
        check(after?.before?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${script.watch.length} copies in the client's form it was sent before the seal (found ${after?.before?.inFiles})`);
        check(s.final?.inFiles === 0 && s.final?.cleared === after?.before?.cleared,
            `...nor after the next pull (found ${s.final?.inFiles})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 1, `the VACUUM ran once (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);
    });

    // ── 17. a standby whose main server deleted every copy before the seal ─────────────────────
    await section('17. a standby whose main server deleted every copy before the seal clears its files once they are gone, and records the clear only when wrapped copies arrive', async () => {
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: owners.map((_, i) => i), real: [] };
        const historyFile = path.join(tempDir('all-deleted-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        // The standby before the seal: it imported every deposit and re-deposit. Its main server then deleted every copy,
        // which never reached it: all N are still rows here, and the re-deposits' older copies are in its free pages.
        const pristine = tempDir('all-deleted-standby');
        const sb = resultOf(await runChild([SCRIPT], pristine, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        const watch = [...h.gen1, ...h.gen2];
        const before = copiesFoundIn(pristine, h.gen1);
        check(sb.rows === N && before > 0,
            `control: before the upgrade the standby holds all ${sb.rows} copies its main server deleted, and ${before} of the ${N} older ones in its free pages`);
        const copyOf = (dir: string, label: string) => {
            const d = tempDir(label);
            for (const f of ['state.db', 'state.db-wal', 'state.db-shm']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(d, f));
            return d;
        };
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        // A member who deposits after the seal: the first wrapped copy the standby is sent.
        const seal = await import('./services/recovery-seal-key.js');
        const newcomer = newId().pk;
        const later = exportRow(newcomer, N, seal.sealRecoveryFields(fakeCopy(), seal.shareRowAad(newcomer, 'sso')), 1, new Date().toISOString());

        // (1) Its routine whole copy of the main server, which holds no copy, then a delta with the newcomer's.
        const routineDir = copyOf(pristine, 'all-deleted-routine');
        const routineFile = path.join(tempDir('all-deleted-routine-script'), 'script.json');
        fs.writeFileSync(routineFile, JSON.stringify({ resyncFirst: false, reconcileMinutes: 60, pulls: 3, watch, steps: [[], [later]] } satisfies StandbyScript));
        const r = await runChild([SCRIPT], routineDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: routineFile });
        const s = resultOf(r);
        const [whole, delta, next] = s.pulls ?? [];
        check(s.atBoot?.rows === N && s.atBoot?.unwrapped === N && s.atBoot?.cleared === null,
            `at boot it waits: every copy it holds is in the old form (${brief(s.atBoot)})`);
        check(whole?.route === 'snapshot' && whole.snapshotCursor === null && delta?.route === 'delta',
            `its first pull is a routine whole copy, never a 304, then a delta (${JSON.stringify((s.pulls ?? []).map((p: any) => p.route))})`);
        check(delta?.before?.rows === 0 && /removed 12 sign-in recovery copies its main server deleted before the seal/.test(r.stdout),
            `the whole copy, which holds none of them, removes all ${N} (${brief(delta?.before)}; ${sealLines(r)})`);
        check(delta?.before?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${watch.length} copies deleted or dropped before the seal (found ${delta?.before?.inFiles}; ${before} older ones before)`);
        check(delta?.before?.cleared === null,
            `...and it records no clear: nothing yet shows its main server has sealed (${brief(delta?.before)})`);
        const unrecorded = /holds no sign-in recovery copy now: the 12 sign-in recovery copies it held in the form stored before the seal are gone\. It cleared state\.db/;
        check(unrecorded.test(r.stdout), '...and says so');
        check(typeof next?.before?.cleared === 'string' && next.before.rows === 1 && next.before.unwrapped === 0 && next.before.inFiles === 0,
            `the delta that brings the first wrapped copy is when it records the clear (${brief(next?.before)})`);

        // (2) The same standby force-resynced from the main server, which holds no copy.
        const resyncDir = copyOf(pristine, 'all-deleted-resync');
        const resyncFile = path.join(tempDir('all-deleted-resync-script'), 'script.json');
        fs.writeFileSync(resyncFile, JSON.stringify({ resyncFirst: true, reconcileMinutes: 0, pulls: 1, watch, steps: [[]] } satisfies StandbyScript));
        const rr = await runChild([SCRIPT], resyncDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: resyncFile });
        const t = resultOf(rr);
        check(t.atBoot?.rows === N && t.resync?.ok === true && t.final?.rows === 0,
            `a force-resync from it leaves the standby holding no copy (${JSON.stringify({ boot: t.atBoot?.rows, resync: t.resync, after: t.final?.rows })})`);
        check(t.final?.inFiles === 0,
            `...and its running state.db, -wal and -shm hold none of the ${watch.length} copies deleted or dropped before the seal (found ${t.final?.inFiles})`);
        check(t.final?.cleared === null && unrecorded.test(rr.stdout), `...and it records no clear, and says so (${brief(t.final)}; ${sealLines(rr)})`);
    });

    // ── 18. a rollback after the standby recorded its clear ────────────────────────────────────────
    await section('18. a standby that recorded its clear and is then sent copies in the client\'s form (a rollback) forgets it, and clears again once the wrapped copies return', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const standbyDir = tempDir('rollback-standby');
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen2 = owners.map(() => fakeCopy());
        const gen3 = owners.map(() => fakeCopy());
        // What its main server sends, wrapped the way that server wraps (this process's key stands in for it: the standby
        // holds none and never opens a copy, it only tells the forms apart).
        const wrapped = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) =>
            exportRow(o, i, seal.sealRecoveryFields(copiesOf[i], seal.shareRowAad(o, 'sso')), generation, at));
        const clientForm = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) => exportRow(o, i, copiesOf[i], generation, at));
        const scriptFile = path.join(tempDir('rollback-script'), 'script.json');
        const script: StandbyScript = {
            resyncFirst: true, reconcileMinutes: 0, pulls: 5, watch: [...gen2, ...gen3],
            steps: [
                wrapped(gen2, 2, '2026-06-02T00:00:00.000Z'),      // its main server has sealed: the seed is all wrapped
                clientForm(gen2, 2, '2026-06-05T00:00:00.000Z'),   // the rollback command unwraps and stamps every copy
                clientForm(gen3, 3, '2026-06-06T00:00:00.000Z'),   // the older code stores the re-deposits as the app sealed them
                wrapped(gen3, 3, '2026-06-07T00:00:00.000Z'),      // the upgrade again: the wrap stamps every copy
            ],
        };
        fs.writeFileSync(scriptFile, JSON.stringify(script));
        const r = await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup', SEAL_SCRIPT: scriptFile });
        const st = resultOf(r);
        const [, afterSeed, afterRollback, afterRedeposits, afterReseal] = (st.pulls ?? []).map((x: any) => x.before);
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        check(st.resync?.ok === true && typeof afterSeed?.cleared === 'string' && afterSeed.unwrapped === 0 && afterSeed.inFiles === 0,
            `control: seeded with its main server's wrapped copies, the standby records its clear (${brief(afterSeed)})`);
        check(afterRollback?.cleared === null && afterRollback.unwrapped === N,
            `the rollback's delta brings every copy in the client's form, and it forgets the clear (${brief(afterRollback)})`);
        check(/was then sent 12 sign-in recovery copies in the client's form .* So it forgets that clear/.test(r.stdout + r.stderr),
            `...and says why (${sealLines(r)})`);
        check(afterRedeposits?.cleared === null && afterRedeposits.inFiles > 0,
            `control: after the re-deposits it still waits, and its files hold copies in the client's form (${brief(afterRedeposits)})`);
        check(typeof afterReseal?.cleared === 'string' && afterReseal.unwrapped === 0,
            `the delta that brings the wrapped copies back is when it clears again, and records it (${brief(afterReseal)})`);
        check(afterReseal?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${script.watch.length} copies it was sent in the client's form (found ${afterReseal?.inFiles})`);
        check(st.final?.inFiles === 0 && st.final?.cleared === afterReseal?.cleared, `...nor after the next pull (found ${st.final?.inFiles})`);
        check((r.stdout.match(/one VACUUM/g) ?? []).length === 2, `it cleared twice: at the seed, and after the wrapped copies came back (${(r.stdout.match(/one VACUUM/g) ?? []).length})`);
    });

    // ── 19. a carried key never loses one already there ──────────────────────────────────────────
    await section('19. a carried key never loses one already there: the one it replaces is kept, opens what it locked, and those rows are locked again', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const savedDir = process.env.BEANPOOL_DATA_DIR;
        const b64 = (b: Buffer) => b.toString('base64');
        const listing = (dir: string) => fs.readdirSync(dir).sort();
        try {
            // Nothing carried, or not a key: nothing is written, and a key already there stays.
            const d1 = tempDir('carried-none');
            process.env.BEANPOOL_DATA_DIR = d1;
            const own = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d1, KEY_FILE), own, { mode: 0o600 });
            const absent = seal.installCarriedRecoverySealKey(null);
            const invalid = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(31)));
            check(absent.outcome === 'absent' && invalid.outcome === 'invalid' && fs.readFileSync(path.join(d1, KEY_FILE)).equals(own)
                && JSON.stringify(listing(d1)) === JSON.stringify([KEY_FILE]),
                `nothing carried, or not a 32-byte key: nothing is written, and the key already there stays (${absent.outcome}, ${invalid.outcome})`);
            // No key here: it is written, 0600, nothing beside it.
            const d2 = tempDir('carried-fresh');
            process.env.BEANPOOL_DATA_DIR = d2;
            const community = crypto.randomBytes(32);
            const fresh = seal.installCarriedRecoverySealKey(b64(community));
            check(fresh.outcome === 'installed' && fs.readFileSync(path.join(d2, KEY_FILE)).equals(community)
                && (fs.statSync(path.join(d2, KEY_FILE)).mode & 0o777) === 0o600 && JSON.stringify(listing(d2)) === JSON.stringify([KEY_FILE]),
                `no key here: the carried one is written, 0600, and nothing is left beside it (${fresh.outcome})`);
            const same = seal.installCarriedRecoverySealKey(b64(community));
            check(same.outcome === 'same' && JSON.stringify(listing(d2)) === JSON.stringify([KEY_FILE]), 'the same key again (a take-over step run twice) changes nothing');
            // A different key here: kept beside it, byte for byte, 0600, before the carried one takes its place.
            const replaced = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(32)));
            const kept = replaced.outcome === 'replaced' ? path.join(d2, replaced.retiredAs) : '';
            check(replaced.outcome === 'replaced' && /^recovery-seal-retired-[0-9a-f]{16}\.key$/.test(replaced.retiredAs)
                && fs.readFileSync(kept).equals(community) && (fs.statSync(kept).mode & 0o777) === 0o600 && listing(d2).length === 2,
                `a different key here is never lost: it is kept as ${replaced.outcome === 'replaced' ? replaced.retiredAs : '?'}, byte for byte, 0600`);
            check(!listing(d2).some(n => n.includes(b64(community).slice(0, 12)) || n.includes(community.toString('hex').slice(0, 16))),
                "...under a name that is a hash of it, never its bytes");
            // A crash between the two writes: the old key is in both places; the next run finishes the swap.
            const d3 = tempDir('carried-crash');
            process.env.BEANPOOL_DATA_DIR = d3;
            const old3 = crypto.randomBytes(32), new3 = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d3, KEY_FILE), old3, { mode: 0o600 });
            const first = seal.installCarriedRecoverySealKey(b64(new3));
            const retiredName = first.outcome === 'replaced' ? first.retiredAs : '';
            fs.writeFileSync(path.join(d3, KEY_FILE), old3, { mode: 0o600 }); // as if the rename never happened
            const rerun = seal.installCarriedRecoverySealKey(b64(new3));
            check(rerun.outcome === 'replaced' && rerun.retiredAs === retiredName && fs.readFileSync(path.join(d3, KEY_FILE)).equals(new3)
                && fs.readFileSync(path.join(d3, retiredName)).equals(old3) && listing(d3).length === 2,
                'a crash between keeping the old key and writing the new one: the next run finishes it, with the same kept file');
            // A file of the kept name that holds other bytes is never written over, and never stops the install: the key
            // is kept under another name.
            const d4 = tempDir('carried-collision');
            process.env.BEANPOOL_DATA_DIR = d4;
            const old4 = crypto.randomBytes(32), new4 = crypto.randomBytes(32);
            fs.writeFileSync(path.join(d4, KEY_FILE), old4, { mode: 0o600 });
            const probe = seal.installCarriedRecoverySealKey(b64(crypto.randomBytes(32)));
            const name4 = probe.outcome === 'replaced' ? probe.retiredAs : '';
            fs.writeFileSync(path.join(d4, KEY_FILE), old4, { mode: 0o600 });
            fs.writeFileSync(path.join(d4, name4), Buffer.from('other bytes'), { mode: 0o600 });
            let collided: any;
            try { collided = seal.installCarriedRecoverySealKey(b64(new4)); } catch (e) { collided = thrown(e); }
            const other4 = collided?.outcome === 'replaced' ? path.join(d4, collided.retiredAs) : '';
            check(collided?.outcome === 'replaced' && collided.retiredAs !== name4 && /^recovery-seal-retired-[0-9a-f]{16}\.key$/.test(collided.retiredAs)
                && fs.readFileSync(other4).equals(old4) && (fs.statSync(other4).mode & 0o777) === 0o600
                && fs.readFileSync(path.join(d4, name4)).equals(Buffer.from('other bytes')) && fs.readFileSync(path.join(d4, KEY_FILE)).equals(new4),
                `a file of the kept name holding other bytes is left as it is; the key is kept under another name, and the install goes on (${JSON.stringify(collided)})`);
        } finally {
            process.env.BEANPOOL_DATA_DIR = savedDir;
        }

        // The rows: a main server's copies and a release under its own key (K1), then a carried key (K2).
        const r = await runChild([SCRIPT], tempDir('carried-rewrap'), { RECOVERY_SEAL_CHILD: 'carried-key-rewrap', NODE_ROLE: 'primary' });
        const o = resultOf(r);
        check(o.install?.outcome === 'replaced' && o.liveIsK2 === true && o.retired?.length === 1 && o.retired[0].isK1 && o.retired[0].mode === '600',
            `the carried key takes the place of K1, which is kept (${JSON.stringify({ install: o.install?.outcome, retired: o.retired })})`);
        check(o.liveOnlyBefore?.wrapped === 3 && o.liveOnlyBefore.unopenable === 3 && o.withRetiredBefore?.unopenable === 1,
            `before anything is locked again, the live key alone opens none of the 3, and with the kept key only the altered one stays shut (${JSON.stringify({ live: o.liveOnlyBefore, all: o.withRetiredBefore })})`);
        check(o.readerBefore === 'the deposit', `the reader opens a copy only the kept key opens, to exactly what was deposited (${o.readerBefore})`);
        check(o.rewrap?.shares === 2 && o.rewrap.releases === 1 && o.liveOnlyAfter?.unopenable === 1 && o.stamped === true,
            `locking again: the 2 copies and the release K1 locked, with the live key, stamped so a standby is sent them (${JSON.stringify({ rewrap: o.rewrap, live: o.liveOnlyAfter, stamped: o.stamped })})`);
        check(o.alteredLeft === true, 'a row no key here opens is left exactly as it was');
        check(o.releaseAfter === 're-locked, same inside', `the release, locked again, still opens to what was released (${o.releaseAfter})`);
        check(o.rewrapAgain?.shares === 0 && o.rewrapAgain.releases === 0 && o.retiredStill === 1 && o.tmpLeft === 0,
            `a second run finds nothing; the kept key stays; no temporary file is left (${JSON.stringify({ again: o.rewrapAgain, kept: o.retiredStill, tmp: o.tmpLeft })})`);
    });

    finish('⭐️ Recovery seal: a database, a copy of it or a released row opens nothing without the key kept beside it.');
}

if (CHILD) {
    child(CHILD).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
