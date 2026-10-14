#!/usr/bin/env node
/**
 * Where one heavy read's memory goes (docs/global-heavy-lists.md): builds GET /api/members' and the convenor's roster's
 * answers the way the routes do, from the built server's own functions, on a copy of a seeded data directory, and
 * measures the heap each stage keeps (after a full GC) and how long it takes:
 *   1. SQLite rows (better-sqlite3 .all(): one JS object per row)
 *   2. the answer's objects (the route's map, with each photo's keyed URL)
 *   3. JSON.stringify of the array: the body as one string
 *   4. the string as UTF-8 bytes (what the socket write needs), as Buffer.from makes it, and as the socket's own
 *      string write sizes it (3 bytes a character: node's StringBytes::StorageSize for UTF-8)
 *   5. the bytes compressed once (gzip level 6, Brotli quality 5): what a cached answer could send instead
 *
 * Run with --expose-gc, NODE_PROFILE=global and BEANPOOL_DATA_DIR=<a copy of the seeded directory>, from apps/server:
 *   NODE_PROFILE=global BEANPOOL_DATA_DIR=/copy node --expose-gc ../../scripts/load/heavy-lists-anatomy.mjs
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = (p) => pathToFileURL(path.join(ROOT, 'apps/server/dist', p)).href;
const mb = (b) => Math.round((b / 2 ** 20) * 10) / 10;

function heap() { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; }

async function main() {
    const se = await import(dist('state-engine.js'));
    const { db } = await import(dist('db/db.js'));
    const core = await import(pathToFileURL(path.join(ROOT, 'apps/server/node_modules/@beanpool/core/dist/index.js')).href);
    const engine = await import(pathToFileURL(path.join(ROOT, 'apps/server/node_modules/@beanpool/engine/dist/index.js')).href);
    se.initStateEngine();
    const groupId = db.prepare("SELECT id FROM groups WHERE name='Everyone'").get().id;

    const builds = {
        members: {
            rows: () => se.getMemberDirectoryRows(undefined),
            answer: (rows) => rows.filter(r => !r.public_key.startsWith('escrow_') && !r.public_key.startsWith('project_') && !r.is_treasury).map(r => ({
                publicKey: r.public_key, callsign: r.callsign, joinedAt: r.joined_at, nodeRole: null,
                avatarUrl: core.avatarUrlOf(r.public_key, r.avatar_ref), profileUpdatedAt: r.profile_updated_at || null,
                earnedCredit: r.earned_credit ?? 0, elderVouchedBy: r.elder_vouched_by || null, archetype: r.archetype || null,
            })),
        },
        roster: {
            // getGroupMembers' query and map (engine groups.ts), split so each stage can be measured.
            rows: () => db.prepare(`SELECT gm.*, m.callsign, m.avatar_ref FROM group_members gm LEFT JOIN members m ON m.public_key = gm.member_pubkey
                                    WHERE gm.group_id = ? AND gm.status != 'removed'
                                    ORDER BY CASE gm.role WHEN 'convenor' THEN 1 WHEN 'member' THEN 2 WHEN 'observer' THEN 3 ELSE 4 END, gm.joined_at ASC`).all(groupId),
            answer: (rows) => rows.map(r => ({
                groupId: r.group_id, memberPubkey: r.member_pubkey, role: r.role, status: r.status, joinedAt: r.joined_at,
                invitedBy: r.invited_by || undefined, updatedAt: r.updated_at, callsign: r.callsign || undefined,
                avatarUrl: r.avatar_ref ? core.avatarUrlOf(r.member_pubkey, r.avatar_ref) ?? undefined : undefined,
            })),
            check: () => engine.getGroupMembers(db, groupId, {}),
        },
    };

    for (const [name, b] of Object.entries(builds)) {
        // Warm up once (statement compile, the keyer), then measure.
        JSON.stringify(b.answer(b.rows()));
        const h0 = heap();
        let t = performance.now();
        let rows = b.rows();
        const tRows = performance.now() - t;
        const h1 = heap();
        t = performance.now();
        let answer = b.answer(rows);
        const tAnswer = performance.now() - t;
        const h2 = heap();
        t = performance.now();
        let body = JSON.stringify(answer);
        const tJson = performance.now() - t;
        const h3 = heap();
        t = performance.now();
        let bytes = Buffer.from(body, 'utf8');
        const tBuf = performance.now() - t;
        const h4 = heap();
        t = performance.now();
        const gz = zlib.gzipSync(bytes, { level: 6 });
        const tGz = performance.now() - t;
        t = performance.now();
        const br = zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
        const tBr = performance.now() - t;
        if (b.check) {
            const same = JSON.stringify(b.check()) === body;
            if (!same) throw new Error(`${name}: the split build differs from the engine's own`);
        }
        console.log(JSON.stringify({
            list: name, rows: rows.length, bodyMb: mb(body.length),
            rowsHeapMb: mb(h1 - h0), rowsMs: Math.round(tRows),
            answerHeapMb: mb(h2 - h1), answerMs: Math.round(tAnswer),
            stringHeapMb: mb(h3 - h2), stringifyMs: Math.round(tJson),
            bufferHeapMb: mb(h4 - h3), bufferExternalMb: mb(bytes.length), bufferMs: Math.round(tBuf),
            socketStringWriteStorageMb: mb(body.length * 3),
            gzipMb: mb(gz.length), gzipMs: Math.round(tGz), brotliMb: mb(br.length), brotliMs: Math.round(tBr),
            totalLiveMb: mb(h4 - h0 + bytes.length),
        }));
        rows = answer = body = bytes = null;
    }
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
