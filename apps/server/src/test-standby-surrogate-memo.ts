/**
 * #1515: a standby that re-checks ledger authorship (ENFORCE_LEDGER_AUTH=true, engine/sync.ts verifyTransactionAuthorship)
 * keeps a signed Beans send whose note holds a lone UTF-16 surrogate.
 *
 * The main server stores such a note with each lone surrogate replaced by U+FFFD (state-engine.ts transfer,
 * replaceLoneSurrogates), so the stored note is no longer the exact string the sender signed. The standby compared the
 * two as they were and skipped the row (`conflictsSkipped`): the balances still replicated, but that send's history row
 * was missing on the standby. It now compares the stored note with the signed note normalised the same way, which still
 * accepts only the words the sender signed.
 *
 * Over real HTTPS through the real signature middleware on this node (as the main server), then as its own standby:
 *   1. sends with the notes '\ud83c' and 'a\udf31b' are accepted and stored with U+FFFD in place of each lone surrogate;
 *   2. removed and imported back from a signed snapshot with ENFORCE_LEDGER_AUTH=true, both are kept, and so are an emoji
 *      note and a plain one;
 *   3. a copy of the 'a\udf31b' row with a different note ('a�c'), and a copy of the plain row whose note is U+FFFD,
 *      are both skipped: only the words signed pass, and U+FFFD stands in only for a lone surrogate that was signed.
 *
 *   SERVER_SUITES_ONLY=test-standby-surrogate-memo node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ENFORCE_LEDGER_AUTH = 'true';
process.env.CF_RECORD_NAME = 'ledger.test';
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function main(): Promise<void> {
    // After the environment above: ENFORCE_LEDGER_AUTH is read when engine/sync.ts loads.
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { startP2P } = await import('./p2p.js');
    const { addConnector, removeConnector } = await import('./connector-manager.js');
    const { db } = await import('./db/db.js');

    console.log('A standby with ENFORCE_LEDGER_AUTH keeps a signed send whose note holds a lone surrogate (#1515)\n');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    const node = await startP2P(0, 0);
    const nodeId = node.peerId.toString();
    const base = `https://localhost:${port}`;

    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    const member = (callsign: string) => {
        const seed = new Uint8Array(crypto.randomBytes(32));
        const pk = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
        setMemberPhoto(db, pk, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        se.transfer('genesis', pk, 100, `seed ${callsign}`, 'direct', true);
        return { pk, seed, sign: core.ed25519Signer(seed) };
    };
    const founder = crypto.randomBytes(32).toString('hex');
    se.seedGenesisMember(founder, 'Founder');
    const mia = member('Mia');
    const xan = member('Xan');
    // A trade each, so the two can send Beans to each other (the same set-up as test-request-binding-ledger.ts).
    const offer = (pk: string, title: string) => se.createPost('offer', 'produce', title, `${title}, fresh`, 10, 'fixed', pk)!;
    offer(mia.pk, 'Mia seedlings');
    se.completePostTransaction(se.acceptPost(offer(xan.pk, 'Xan bread').id, mia.pk).id, mia.pk);

    const send = async (amount: number, memo: string) => {
        const body = JSON.stringify({ from: mia.pk, to: xan.pk, amount, memo });
        const headers = await core.buildBoundRequestHeaders({ method: 'POST', url: 'https://ledger.test/api/ledger/transfer', body, publicKeyHex: mia.pk, sign: mia.sign });
        const res = await fetch(`${base}/api/ledger/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };
    const storedMemo = (id: string) => (db.prepare('SELECT memo FROM transactions WHERE id = ?').get(id) as { memo: string } | undefined)?.memo;

    try {
        // ── 1. Accepted, stored normalised ──
        const notes = [
            { label: "lone high surrogate '\\ud83c'", memo: '\ud83c', stored: '�' },
            { label: "lone low surrogate inside 'a\\udf31b'", memo: 'a\udf31b', stored: 'a�b' },
            { label: 'emoji note', memo: 'seedlings \u{1F331}', stored: 'seedlings \u{1F331}' },
            { label: 'plain note', memo: 'thanks for the bread', stored: 'thanks for the bread' },
        ];
        const ids: Record<string, string> = {};
        for (const [i, n] of notes.entries()) {
            const r = await send(i + 1, n.memo);
            assert(r.status === 200 && r.body?.transaction?.id, `a send with a ${n.label} is accepted (${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
            ids[n.label] = r.body?.transaction?.id;
            assert(storedMemo(ids[n.label]) === n.stored, `the ${n.label} is stored as ${JSON.stringify(n.stored)} (${JSON.stringify(storedMemo(ids[n.label]))})`);
        }

        // ── 2. Imported by a standby with ENFORCE_LEDGER_AUTH=true ──
        const snapshot = await se.exportSyncState(nodeId);
        const { signature: _s, publicKey: _p, ...basePayload } = snapshot as any;
        const loneTx = (basePayload.transactions as any[]).find((t) => t.id === ids[notes[1].label]);
        const plainTx = (basePayload.transactions as any[]).find((t) => t.id === ids[notes[3].label]);
        // Two rows carrying notes their senders never signed: the 'a\udf31b' send with another note, and the plain send with
        // U+FFFD for a note.
        const otherNote = { ...loneTx, id: crypto.randomUUID(), memo: 'a�c' };
        const fffdNote = { ...plainTx, id: crypto.randomUUID(), memo: '�' };
        const payload = await se.signSyncPayload({ ...basePayload, transactions: [...basePayload.transactions, otherNote, fffdNote] });
        for (const id of Object.values(ids)) db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
        se.setNodeRole('backup');
        const trustedAddr = `/ip4/127.0.0.1/tcp/4999/p2p/${nodeId}`;
        addConnector(trustedAddr, 'mirror', 'self-test-peer');
        try {
            const result: any = await se.importRemoteState(payload);
            for (const n of notes) {
                assert(storedMemo(ids[n.label]) === n.stored, `the send with a ${n.label} is kept on the standby, note ${JSON.stringify(storedMemo(ids[n.label]))}`);
            }
            assert(storedMemo(otherNote.id) === undefined, 'a copy of that row with a note the sender did not sign is skipped');
            assert(storedMemo(fffdNote.id) === undefined, 'a copy of the plain send whose note is U+FFFD is skipped');
            assert(result?.newTransactions === notes.length && Number(result?.conflictsSkipped) >= 2,
                `the import wrote exactly the ${notes.length} real sends and skipped the two changed ones (${JSON.stringify({ n: result?.newTransactions, s: result?.conflictsSkipped })})`);
        } finally {
            removeConnector(trustedAddr);
        }
    } catch (e: any) {
        assert(false, `the suite ran to the end (${e?.stack || e})`);
    } finally {
        await node.stop();
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && run > 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
