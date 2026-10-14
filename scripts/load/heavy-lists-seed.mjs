#!/usr/bin/env node
/**
 * Seeds a data directory for scripts/load/heavy-lists.mjs: a global-profile node with `n` members, each with a 20 KB
 * JPEG set by the profile route's own writer (state-engine updateProfile), all in one open group led by member 0 (with
 * members 1..255 as co-convenors, so each concurrent roster read is a convenor's), and
 * `groups` more open groups, each with a 20 KB group picture (the list of groups' heaviest field on main, #1486).
 *
 * Every member's key is a real Ed25519 key derived from its index (memberKey below), so the load driver signs as any of
 * them. Uses the built server (apps/server/dist): build core, signin, engine and server first.
 *
 * Run inside the fence (it needs no network), with an empty data directory:
 *   BEANPOOL_DATA_DIR=/tmp/hl/tpl TMPDIR=/tmp/hl/tpl NODE_PROFILE=global \
 *     scripts/load/fenced.sh node scripts/load/heavy-lists-seed.mjs '{"n":30000,"groups":200}'
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = (p) => pathToFileURL(path.join(ROOT, 'apps/server/dist', p)).href;

/** Member `i`'s key pair: an Ed25519 seed from its index, so the driver can derive the same one. */
export function memberKey(i) {
    const seed = crypto.createHash('sha256').update(`heavy-lists member ${i}`).digest();
    const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const pk = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pk, priv };
}

/** A JPEG the photo rules take (the server suites' own: test-member-photos-out-of-rows.ts), about `size` bytes. */
export function jpeg(size, seed = 1) {
    const head = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
        0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(0x08),
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array(12).fill(0x01),
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    ]);
    const body = Buffer.alloc(Math.max(0, size - head.length - 2));
    for (let i = 0; i < body.length; i++) body[i] = ((i * 7 + seed) % 254) + 1; // never 0xFF: no marker inside
    return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;

async function seed({ n, groups = 0, convenors = 256 }) {
    const se = await import(dist('state-engine.js'));
    const { db } = await import(dist('db/db.js'));
    // The server's own copy of the engine (pnpm links it under apps/server, not the repo root).
    const engine = await import(pathToFileURL(path.join(ROOT, 'apps/server/node_modules/@beanpool/engine/dist/index.js')).href);
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const photos = Array.from({ length: 16 }, (_, s) => dataUrl(jpeg(20_000, s + 1)));
    const t0 = Date.now();
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(memberKey(i).pk);
    const BATCH = 500;
    for (let start = 0; start < n; start += BATCH) {
        db.transaction(() => {
            for (let i = start; i < Math.min(n, start + BATCH); i++) {
                insert.run(keys[i], `Load${i}`, new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), `INV-LOAD-${i}`);
            }
        })();
        for (let i = start; i < Math.min(n, start + BATCH); i++) se.updateProfile(keys[i], { avatar: photos[i % photos.length] });
        if (start % 5000 === 0) process.stderr.write(`  members ${start}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
    }
    const big = se.createGroup({ name: 'Everyone', createdBy: keys[0], joinPolicy: 'open' });
    for (let start = 1; start < n; start += BATCH) {
        db.transaction(() => {
            for (let i = start; i < Math.min(n, start + BATCH); i++) engine.joinGroup(db, big.id, keys[i]);
        })();
    }
    // Members 1..convenors-1 are co-convenors with member 0, so each concurrent roster read is a convenor's: every
    // relationship to the group, requests and invitations included (all active here, so the same 30,000 rows).
    const toConvenor = db.prepare(`UPDATE group_members SET role = 'convenor' WHERE group_id = ? AND member_pubkey = ?`);
    db.transaction(() => { for (let i = 1; i < Math.min(n, convenors); i++) toConvenor.run(big.id, keys[i]); })();
    const picture = dataUrl(jpeg(20_000, 99));
    for (let g = 0; g < groups; g++) {
        // Started by members 1.., each group with the creator and a few members; the picture as the app sends one.
        const group = se.createGroup({ name: `Group ${g}`, description: `A group for load ${g}`, createdBy: keys[1 + g], joinPolicy: 'open', avatarUrl: picture });
        for (let j = 0; j < 5; j++) engine.joinGroup(db, group.id, keys[(1000 + g * 5 + j) % n]);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(`@@ ${JSON.stringify({ groupId: big.id, members: n, groups, ms: Date.now() - t0 })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    seed(JSON.parse(process.argv[2] || '{"n":1000}')).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
