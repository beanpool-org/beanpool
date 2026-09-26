/**
 * A Beans send made in the request-binding format (format 2, @beanpool/core request-signing.ts) keeps its authorship
 * re-verifiable on a backup (SRV-20), as an old-format one does.
 *
 * The signature middleware stores the text a transfer was signed as on its row (`auth_payload`), and a backup running
 * with ENFORCE_LEDGER_AUTH=true re-checks every member-to-member row it imports (engine/sync.ts
 * verifyTransactionAuthorship): the signature, the signer is the sender, and the body names the same recipient, amount
 * and note. A format-2 text starts `beanpool-request/2\n<host>\n…`, was signed as 0xFF then the text, and carries its
 * body after line 6, not line 4; before this the backup read it as the old format and skipped every such send.
 *
 * Over real HTTPS through the real middleware on this node (as the main server), then as its own backup:
 *   1. a format-2 send and an old-format send are both accepted, and the format-2 row stores its text (host included);
 *   2. both rows, removed and imported back from a signed snapshot with ENFORCE_LEDGER_AUTH=true, pass;
 *   3. a row whose amount was changed after signing is skipped, so the check did run.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-request-binding-ledger.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ENFORCE_LEDGER_AUTH = 'true';
process.env.CF_RECORD_NAME = 'ledger.test';
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
delete process.env.ACCEPT_UNBOUND_SIGNATURES_UNTIL;

import crypto from 'node:crypto';

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

    console.log('A format-2 Beans send stays re-verifiable on a backup (ENFORCE_LEDGER_AUTH=true)\n');
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
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        se.transfer('genesis', pk, 100, `seed ${callsign}`, 'direct', true);
        return { pk, seed, sign: core.ed25519Signer(seed) };
    };
    const founder = crypto.randomBytes(32).toString('hex');
    se.seedGenesisMember(founder, 'Founder');
    const mia = member('Mia');
    const xan = member('Xan');
    const offer = (pk: string, title: string) => se.createPost('offer', 'produce', title, `${title}, fresh`, 10, 'fixed', pk)!;
    offer(mia.pk, 'Mia seedlings');
    se.completePostTransaction(se.acceptPost(offer(xan.pk, 'Xan bread').id, mia.pk).id, mia.pk);

    const post = async (headers: Record<string, string>, body: string) => {
        const res = await fetch(`${base}/api/ledger/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
        return { status: res.status, body: await res.json().catch(() => null) as any };
    };

    try {
        // ── 1. Both formats accepted, the text stored ──
        const v2Body = JSON.stringify({ from: mia.pk, to: xan.pk, amount: 4, memo: 'format 2 send' });
        const v2 = await post(await core.buildBoundRequestHeaders({ method: 'POST', url: 'https://ledger.test/api/ledger/transfer', body: v2Body, publicKeyHex: mia.pk, sign: mia.sign }), v2Body);
        assert(v2.status === 200 && v2.body?.transaction?.id, `a format-2 send is accepted (${v2.status} ${JSON.stringify(v2.body).slice(0, 120)})`);
        const v1Body = JSON.stringify({ from: mia.pk, to: xan.pk, amount: 2, memo: 'old format send' });
        const ts = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const v1Text = core.unboundRequestText({ method: 'POST', path: '/api/ledger/transfer', timestamp: ts, nonce, body: v1Body });
        const v1 = await post({
            'X-Public-Key': mia.pk, 'X-Timestamp': ts, 'X-Nonce': nonce,
            'X-Signature': Buffer.from(ed25519.sign(core.utf8Bytes(v1Text), mia.seed)).toString('base64'),
        }, v1Body);
        assert(v1.status === 200 && v1.body?.transaction?.id, `an old-format send is accepted (${v1.status})`);
        const v2Id = v2.body.transaction.id as string;
        const v1Id = v1.body.transaction.id as string;
        const row = db.prepare('SELECT auth_signer, auth_signature, auth_payload FROM transactions WHERE id = ?').get(v2Id) as any;
        assert(row?.auth_signer === mia.pk && String(row?.auth_payload).startsWith('beanpool-request/2\nledger.test\nPOST\n/api/ledger/transfer\n')
            && String(row.auth_payload).endsWith(`\n${v2Body}`),
            `the format-2 row stores the text signed, host included (${JSON.stringify(String(row?.auth_payload).slice(0, 60))}…)`);

        // ── 2. Imported by a backup with ENFORCE_LEDGER_AUTH=true ──
        const snapshot = await se.exportSyncState(nodeId);
        const { signature: _s, publicKey: _p, ...basePayload } = snapshot as any;
        const v2Tx = (basePayload.transactions as any[]).find((t) => t.id === v2Id);
        const tampered = { ...v2Tx, id: crypto.randomUUID(), amount: 40 };
        const payload = await se.signSyncPayload({ ...basePayload, transactions: [...basePayload.transactions, tampered] });
        db.prepare('DELETE FROM transactions WHERE id IN (?, ?)').run(v2Id, v1Id);
        se.setNodeRole('backup');
        const trustedAddr = `/ip4/127.0.0.1/tcp/4999/p2p/${nodeId}`;
        addConnector(trustedAddr, 'mirror', 'self-test-peer');
        try {
            const result: any = await se.importRemoteState(payload);
            const back = (txId: string) => !!db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(txId);
            assert(back(v2Id), 'the format-2 send is imported: its authorship verifies (0xFF put back, body after line 6)');
            assert(back(v1Id), 'the old-format send is imported too');
            assert(!back(tampered.id), 'a format-2 row whose amount was changed after signing is skipped: the check ran');
            assert(result?.newTransactions === 2 && Number(result?.conflictsSkipped) >= 1,
                `the import wrote exactly the two real sends and counted the changed one as skipped (${JSON.stringify({ n: result?.newTransactions, s: result?.conflictsSkipped })})`);
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
