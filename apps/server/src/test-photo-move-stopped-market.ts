/**
 * #1482 (a): while a main server's move of members' photos out of their rows (db.ts moveMemberPhotosOutOfRows) is stopped
 * part way, a member whose photo the move has not reached yet can still use the marketplace.
 *
 * Both photo gates (engine/posts.ts and engine/escrow.ts assertProfileComplete) read only `avatar_ref`, which stays NULL
 * until the member's row is moved, so a member whose photo was still inline was refused with "Please set a profile photo
 * before using the marketplace." (400) until the node's next restart finished the move; and the phone's self-heal acted
 * on that answer. The gates now count a photo the member has either way: moved (its reference in the row) or still
 * inline in the old column, by the move's own rule (@beanpool/engine memberPhotoColumnsOf).
 *
 * As #1482's reviewer measured it: a node made into one from before the move, the move stopped by a RAISE(ABORT) trigger
 * on one member's photo (batches of one), then the real node over real HTTPS through the real middleware:
 *   1. the move stopped where it was made to: Bea's photo moved, Ann's still inline, the old column still there;
 *   2. Ann lists an offer and asks for a deal on Bea's: both accepted (400 before);
 *   3. Bea, moved, lists as before; Cal, who has no photo, and Dee, whose inline value is this node's own avatar address
 *      sent back (no photo, by the same rule), are both still refused with the gate's words.
 *
 *   SERVER_SUITES_ONLY=test-photo-move-stopped-market node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Batches of one, so the batch before Ann's commits and hers is the one that throws.
process.env.MEMBER_PHOTO_MOVE_BATCH = '1';

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import { bootInto } from './schema-upgrade-test-harness.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const PHOTO_REFUSAL = 'Please set a profile photo before using the marketplace.';

interface Who { name: string; pk: string; priv: crypto.KeyObject }
function newId(name: string): Who {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { name, pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

async function main(): Promise<void> {
    console.log('A half-finished photo move no longer blocks the marketplace (#1482 a)\n');
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR is needed (the suite runner gives every suite a fresh one)');

    // ── A node from before the move, its move made to stop at Ann ──
    if (!bootInto(dir).ok) throw new Error('a fresh node did not boot');
    const ann = newId('Ann'), bea = newId('Bea'), cal = newId('Cal'), dee = newId('Dee');
    const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    {
        const d = new Database(path.join(dir, 'state.db'));
        d.exec(`DROP TRIGGER members_touch_updated_at; DROP TABLE member_photos;
                ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
                ALTER TABLE members ADD COLUMN avatar_url TEXT;`);
        const ins = d.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, avatar_url, updated_at)
                               VALUES (?, ?, '2025-06-01T00:00:00.000Z', 'active', ?, '2025-06-01T00:00:00.000Z')`);
        // In rowid order, the order the move walks: Bea (moved), Ann (where it stops), Dee (not reached), Cal (no value).
        ins.run(bea.pk, bea.name, PHOTO);
        ins.run(ann.pk, ann.name, PHOTO);
        ins.run(dee.pk, dee.name, '/api/avatar/abc?size=thumb');
        ins.run(cal.pk, cal.name, null);
        // The move creates member_photos IF NOT EXISTS, so it is made here first, as the move makes it, to hang the trigger on.
        d.exec(`CREATE TABLE IF NOT EXISTS member_photos (public_key TEXT PRIMARY KEY, photo TEXT NOT NULL);
                CREATE TRIGGER injected_failure BEFORE INSERT ON member_photos WHEN NEW.public_key = '${ann.pk}'
                BEGIN SELECT RAISE(ABORT, 'injected: database or disk is full'); END;`);
        d.close();
    }

    // ── The node boots on it (the move runs, and stops) and runs on ──
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, reconcileLedgerFromDb } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    await initTls();
    initStateEngine();
    // The disk is freed: the node runs on with its move stopped, until a restart.
    db.exec('DROP TRIGGER injected_failure');
    for (const m of [ann, bea, cal, dee]) db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 100, 0)').run(m.pk);
    const totalSum = (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s;
    db.prepare(`UPDATE node_config SET value = ? WHERE key = 'ledger_audit_baseline'`).run(String(totalSum));
    reconcileLedgerFromDb();
    const port = await startHttpsServer(0);
    const base = `https://localhost:${port}`;

    const signed = async (who: Who, route: string, body: unknown) => {
        const raw = JSON.stringify(body);
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const res = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'X-Public-Key': who.pk, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
                'X-Signature': crypto.sign(null, Buffer.from(`POST\n${route}\n${ts}\n${nonce}\n${raw}`), who.priv).toString('base64'),
            },
            body: raw,
        });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    const offer = (who: Who, title: string) => signed(who, '/api/marketplace/posts', {
        type: 'offer', category: 'general', title, description: `${title}, fresh`, credits: 5, priceType: 'fixed', authorPublicKey: who.pk,
    });

    try {
        // ── 1. The move stopped at Ann ──
        const row = (pk: string) => db.prepare('SELECT avatar_url, avatar_ref FROM members WHERE public_key = ?').get(pk) as { avatar_url: string | null; avatar_ref: string | null };
        const hasColumn = (db.prepare(`SELECT 1 FROM pragma_table_info('members') WHERE name = 'avatar_url'`).get()) != null;
        assert(hasColumn && row(bea.pk).avatar_ref !== null && row(bea.pk).avatar_url === null
            && row(ann.pk).avatar_ref === null && row(ann.pk).avatar_url === PHOTO && row(dee.pk).avatar_url !== null,
            `the move stopped at Ann: Bea's photo moved, Ann's and Dee's values still inline, the old column still there (${JSON.stringify({ hasColumn, bea: row(bea.pk).avatar_ref, ann: row(ann.pk) })})`);

        // ── 2. Ann, still inline, uses the marketplace ──
        const beaOffer = await offer(bea, 'Bea seedlings');
        assert(beaOffer.status === 200 && beaOffer.body?.post?.id, `Bea, moved, lists an offer (${beaOffer.status} ${beaOffer.body?.error ?? ''})`);
        const annOffer = await offer(ann, 'Ann bread');
        assert(annOffer.status === 200 && annOffer.body?.post?.id, `Ann, whose photo the move has not reached, lists an offer (${annOffer.status} ${annOffer.body?.error ?? ''})`);
        const deal = await signed(ann, '/api/marketplace/posts/request', { postId: beaOffer.body?.post?.id, buyerPublicKey: ann.pk });
        assert(deal.status === 200 && deal.body?.transaction?.id, `Ann asks for a deal on Bea's offer (${deal.status} ${deal.body?.error ?? ''})`);

        // ── 3. No photo is still no photo ──
        const calOffer = await offer(cal, 'Cal eggs');
        assert(calOffer.status === 400 && String(calOffer.body?.error).startsWith(PHOTO_REFUSAL), `Cal, who has no photo, is still refused (${calOffer.status} ${calOffer.body?.error ?? ''})`);
        const deeOffer = await offer(dee, 'Dee honey');
        assert(deeOffer.status === 400 && String(deeOffer.body?.error).startsWith(PHOTO_REFUSAL),
            `Dee, whose inline value is this node's own avatar address sent back, is still refused (${deeOffer.status} ${deeOffer.body?.error ?? ''})`);
        const calDeal = await signed(cal, '/api/marketplace/posts/request', { postId: beaOffer.body?.post?.id, buyerPublicKey: cal.pk });
        assert(calDeal.status === 400 && String(calDeal.body?.error).startsWith(PHOTO_REFUSAL), `and Cal can't ask for a deal (${calDeal.status} ${calDeal.body?.error ?? ''})`);
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && run > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
