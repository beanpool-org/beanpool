/**
 * Who is told a DM participant's former keys (DESIGN-dm-peer-key-pin-fable.md §5 slice 3, P11; #1871 review NB1, NB4).
 * Over REAL HTTPS through the real signature middleware, with real Ed25519 identities and the members' own signed
 * statements. Run with read auth on (the plain run) and with ENFORCE_READ_AUTH=false (an open node, the readauth-off
 * variant in scripts/server-suites.mjs): on an open node anyone may read anyone's list or DM, so only the routes' own
 * choice of reader keeps `formerKeys` to the DM's people.
 *
 *   A.  every reader (a guest with no key, Cat a member outside the DM, Adam the node's admin, Olive its owner, Ben and
 *       Ana₃ the DM's two, Zed whom Ana₃ blocked) reads their own list, Ben's list, the DM by id, a DM nobody re-keyed by
 *       id, and the DM Zed opened to Ana₃, withheld because she blocked him, by id. `formerKeys` is on the answer only for
 *       someone in that DM reading it as theirs: Ben and Ana₃ on their own lists and on the DM by id, Zed on his own list
 *       and on his withheld DM by id (left out there, it would tell him he is blocked). Every other answer names no former
 *       key anywhere in its body. Read auth on: the refusals as before (a guest 401, someone else's list or DM 403).
 *       Read auth off: every answer is a 200, so "none" is never a refusal passing for one — except someone else's
 *       conversation list, which is its owner's alone whatever read auth says (#1909): a guest 401, anyone else 403.
 *   B.  a participant who deleted their account (#1871 review NB4): Fay₂'s former keys are served to nobody, while Dan₂'s
 *       in the same DM still are, on the list and by id; a DM in which only Fay re-keyed is served as one nobody re-keyed.
 *       Fay's replaced keys stay refused (their rows are kept).
 *   R.  her group's roster (#1898 review finding 2): an open group Ben convenes, with Fay, Dan and Cat in it. After the
 *       deletion every signed reader (Ana₃ and Zed outside the group too) is served the roster, and on an open node a
 *       guest as well: Fay₂'s row, kept as "Deleted Member", serves `formerKeys: []` and her former key appears nowhere in
 *       the answer, while Dan₂'s row still serves his chain, walking to Dan₁. Read auth on: a guest 401, as before.
 *   S.  a standby's copy (a signed whole export, the copied tables emptied, a real import as a backup) answers A, B and R
 *       the same.
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-dm-former-keys-readers node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import * as se from './state-engine.js';
import { initStateEngine, seedGenesisMember, setNodeRole, createGroup, joinGroup } from './state-engine.js';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { addBlocks } from './engine/member-blocks.js';
import { dmPublicKeyOf, makeKeySuccession, walkKeySuccession } from '@beanpool/core';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

const OPEN = process.env.ENFORCE_READ_AUTH === 'false';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';
interface Id { pk: string; seedHex: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(id.pk, name, owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
/** The member's account moves to a new key, as the admin's re-key does it (engine/member-wizards.ts). */
function rekey(old: Id, name: string): Id {
    const next = newId(name);
    completeRekey(old.pk, next.pk, issueRekeyCode(old.pk, owner.pk).code, owner.pk);
    return next;
}

interface Res { status: number; body: any; text: string }
/** Signed by `signer` through the real middleware, or unsigned (a guest) when `signer` is null. */
async function call(method: 'GET' | 'POST', signer: Id | null, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, text };
}
/** The new key's signed statement over its re-key, through the real route. */
async function attest(next: Id, old: Id, at: string): Promise<number> {
    const s = makeKeySuccession({ newEdPrivHex: next.seedHex, oldPubHex: old.pk, at });
    return (await call('POST', next, '/api/community/me/key-succession', { oldPubkey: s.pubkey, at: s.at, sig: s.sig })).status;
}

async function main(): Promise<void> {
    console.log(`\n=== Who is told a DM's former keys (read auth ${OPEN ? 'OFF: an open node' : 'on'}) ===\n`);
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'test')`).run(owner.pk);
    const adam = member('Adam');
    db.prepare(`INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', ?)`).run(adam.pk, owner.pk);
    const ana1 = member('Ana'), ben = member('Ben'), cat = member('Cat'), zed = member('Zed'), eve = member('Eve');
    const dan1 = member('Dan'), fay1 = member('Fay');
    // DMs opened before anyone re-keyed: a re-key moves the participant row to the new key (key-move.ts).
    const dmAna = se.createConversation('dm', [ben.pk, ana1.pk], ben.pk)!.id;
    const dmEve = se.createConversation('dm', [ben.pk, eve.pk], ben.pk)!.id;
    const dmDanFay = se.createConversation('dm', [dan1.pk, fay1.pk], dan1.pk)!.id;
    const dmBenFay = se.createConversation('dm', [ben.pk, fay1.pk], ben.pk)!.id;
    // A group joined before the re-keys too: a re-key moves the member's row to the new key (key-move.ts).
    const grp = createGroup({ name: 'Roster', joinPolicy: 'open', createdBy: ben.pk } as any).id;
    for (const m of [dan1, fay1, cat]) joinGroup(grp, m.pk);
    const AT1 = '2026-10-03T04:00:00.000Z', AT2 = '2026-10-09T04:00:00.000Z';
    const ana2 = rekey(ana1, 'Ana₂');
    assert(await attest(ana2, ana1, AT1) === 201, 'the fixture: Ana₂ signs for Ana₁');
    const ana3 = rekey(ana2, 'Ana₃');
    assert(await attest(ana3, ana2, AT2) === 201, 'the fixture: Ana₃ signs for Ana₂');
    const dan2 = rekey(dan1, 'Dan₂'), fay2 = rekey(fay1, 'Fay₂');
    assert(await attest(dan2, dan1, AT1) === 201 && await attest(fay2, fay1, AT1) === 201, 'the fixture: Dan₂ and Fay₂ each sign for their old key');

    // Ana₃ blocks Zed; the DM Zed then opens to her is kept for him alone (engine/withheld-lines.ts).
    addBlocks(ana3.pk, [zed.pk]);
    const zOpen = await call('POST', zed, '/api/messages/conversation', { type: 'dm', participants: [zed.pk, ana3.pk], createdBy: zed.pk });
    const dmZed: string = zOpen.body?.conversation?.id;
    assert(zOpen.status === 200 && !!db.prepare('SELECT 1 FROM withheld_conversations WHERE id = ?').get(dmZed),
        `the fixture: the DM Zed opens to Ana₃ is withheld (${zOpen.status})`);

    const anaFormer = [ana1.pk, ana2.pk];
    const namesAnasFormer = (text: string) => anaFormer.some((k) => text.includes(k));
    const anasChainWalks = (fk: any) => JSON.stringify(fk?.[ana3.pk]?.map((f: any) => [f.pubkey, f.at])) === JSON.stringify([[ana2.pk, AT2], [ana1.pk, AT1]])
        && walkKeySuccession({ memberPubkey: ana3.pk, formerKeys: fk[ana3.pk] }, ana1.pk);

    // ── A. every reader, every route ─────────────────────────────────────────────────────────────────
    type Reader = { name: string; who: Id | null };
    const readers: Reader[] = [
        { name: 'a guest', who: null }, { name: 'Cat', who: cat }, { name: 'Adam (admin)', who: adam }, { name: 'Olive (owner)', who: owner },
        { name: 'Ben', who: ben }, { name: 'Ana₃', who: ana3 }, { name: 'Zed', who: zed },
    ];
    const sweep = async (phase: string) => {
        console.log(`\n── A. every reader, every route (${phase}) ──`);
        for (const { name, who } of readers) {
            // ownerOnly: refused to anyone else even on an open node (a conversation list, #1909).
            const routes: { route: string; path: string; conv: string; theirs: boolean; refused: number | null; ownerOnly?: boolean }[] = [];
            const unsigned = who === null;
            if (who) {
                const conv = who === zed ? dmZed : dmAna;
                routes.push({ route: 'their own list', path: `/api/messages/conversations/${who.pk}`, conv, theirs: who === ben || who === ana3 || who === zed, refused: null });
            }
            routes.push(
                { route: 'Ben\'s list', path: `/api/messages/conversations/${ben.pk}`, conv: dmAna, theirs: who === ben, refused: unsigned ? 401 : who === ben ? null : 403, ownerOnly: true },
                { route: 'the DM by id', path: `/api/messages/${dmAna}?limit=1`, conv: dmAna, theirs: who === ben || who === ana3, refused: unsigned ? 401 : who === ben || who === ana3 ? null : 403 },
                { route: 'Eve\'s DM by id', path: `/api/messages/${dmEve}?limit=1`, conv: dmEve, theirs: false, refused: unsigned ? 401 : who === ben ? null : 403 },
                { route: 'Zed\'s withheld DM by id', path: `/api/messages/${dmZed}?limit=1`, conv: dmZed, theirs: who === zed, refused: unsigned ? 401 : who === zed ? null : 403 },
            );
            for (const r of routes) {
                const res = await call('GET', who, r.path);
                const want = (OPEN && !r.ownerOnly) || r.refused === null ? 200 : r.refused;
                const conv = r.route.endsWith('list') ? (res.body?.conversations as any[] | undefined)?.find((c) => c.id === r.conv) : res.body?.conversation;
                const label = `${phase}: ${name}, ${r.route}: ${want}`;
                if (r.theirs) {
                    assert(res.status === want && anasChainWalks(conv?.formerKeys) && Object.keys(conv.formerKeys).length === 1,
                        `${label}, Ana₃'s former keys with their dates, walking to Ana₁ (got ${res.status}, ${JSON.stringify(conv?.formerKeys && Object.keys(conv.formerKeys).length)})`);
                } else {
                    assert(res.status === want && !(conv && 'formerKeys' in conv) && !namesAnasFormer(res.text),
                        `${label}, no formerKeys and no former key anywhere in the answer (got ${res.status}${conv && 'formerKeys' in conv ? ', formerKeys' : ''}${namesAnasFormer(res.text) ? ', a former key' : ''})`);
                }
            }
        }
    };

    // ── B. a participant who deleted their account ────────────────────────────────────────────────────
    const fayFormer = fay1.pk;
    const deleted = async (phase: string) => {
        console.log(`\n── B. Fay₂ deleted her account (${phase}) ──`);
        const danList = await call('GET', dan2, `/api/messages/conversations/${dan2.pk}`);
        const dfListed = (danList.body?.conversations as any[] | undefined)?.find((c) => c.id === dmDanFay);
        assert(danList.status === 200 && !!dfListed && (danList.body.deletedAccounts ?? []).includes(fay2.pk),
            `${phase}: the fixture: Dan₂'s list still holds the DM, and names Fay₂ as deleted`);
        const danOnly = (fk: any) => JSON.stringify(Object.keys(fk ?? {})) === JSON.stringify([dan2.pk])
            && walkKeySuccession({ memberPubkey: dan2.pk, formerKeys: fk[dan2.pk] }, dan1.pk);
        assert(danOnly(dfListed?.formerKeys) && !danList.text.includes(fayFormer),
            `${phase}: Dan₂'s list, the DM with Fay₂: his own former key, none of hers, and hers nowhere in the answer (got ${JSON.stringify(Object.keys(dfListed?.formerKeys ?? {}).map((k) => k === dan2.pk ? 'Dan₂' : k === fay2.pk ? 'Fay₂' : '?'))})`);
        const dfById = await call('GET', dan2, `/api/messages/${dmDanFay}?limit=1`);
        assert(dfById.status === 200 && danOnly(dfById.body?.conversation?.formerKeys) && !dfById.text.includes(fayFormer), `${phase}: and the DM read by id`);
        const benList = await call('GET', ben, `/api/messages/conversations/${ben.pk}`);
        const bfListed = (benList.body?.conversations as any[] | undefined)?.find((c) => c.id === dmBenFay);
        assert(!!bfListed && !('formerKeys' in bfListed) && !benList.text.includes(fayFormer),
            `${phase}: Ben's DM with Fay₂, in which only she re-keyed: served as one nobody re-keyed (got ${JSON.stringify(bfListed && Object.keys(bfListed.formerKeys ?? {}).length)})`);
        const bfById = await call('GET', ben, `/api/messages/${dmBenFay}?limit=1`);
        assert(bfById.status === 200 && !('formerKeys' in (bfById.body?.conversation ?? {})) && !bfById.text.includes(fayFormer), `${phase}: and by id`);
        const kept = db.prepare(`SELECT COUNT(*) AS n FROM invalidated_keys WHERE public_key = ? AND rekeyed_to = ? AND succession_sig IS NOT NULL`).get(fay1.pk, fay2.pk) as { n: number };
        assert(kept.n === 1, `${phase}: Fay₁'s row is kept, so her replaced key stays refused`);
    };

    // ── R. her group's roster ─────────────────────────────────────────────────────────────────────────
    const rosterReaders: Reader[] = [...readers, { name: 'Dan₂', who: dan2 }];
    const danRow = (rows: any[]) => rows.find((r) => r.memberPubkey === dan2.pk);
    const danChainWalks = (row: any) => JSON.stringify(row?.formerKeys?.map((f: any) => [f.pubkey, f.at])) === JSON.stringify([[dan1.pk, AT1]])
        && walkKeySuccession({ memberPubkey: dan2.pk, formerKeys: row.formerKeys }, dan1.pk);
    const rosters = async (phase: string) => {
        console.log(`\n── R. Fay₂'s group roster after she deleted her account (${phase}) ──`);
        for (const { name, who } of rosterReaders) {
            const res = await call('GET', who, `/api/groups/${grp}/members`);
            const want = OPEN || who ? 200 : 401;
            const label = `${phase}: ${name}, the group's roster: ${want}`;
            if (want !== 200) {
                assert(res.status === want && !res.text.includes(fayFormer), `${label}, and her former key nowhere in the answer (got ${res.status})`);
                continue;
            }
            const rows: any[] = Array.isArray(res.body) ? res.body : [];
            const fayRow = rows.find((r) => r.memberPubkey === fay2.pk);
            assert(res.status === 200 && fayRow?.status === 'active' && Array.isArray(fayRow.formerKeys) && fayRow.formerKeys.length === 0
                && !res.text.includes(fayFormer),
                `${label}, Fay₂'s row serves formerKeys [] and her former key is nowhere in the answer (got ${res.status}, ${fayRow ? JSON.stringify(fayRow.formerKeys?.length) : 'no row'}${res.text.includes(fayFormer) ? ', her former key' : ''})`);
            assert(danChainWalks(danRow(rows)), `${label}, Dan₂'s row still serves his former key with its date, walking to Dan₁`);
        }
    };

    {
        // Before the deletion both are served: the fixture holds what B and R take away. The roster read here is held as a
        // snapshot (roster-snapshots.ts), so R also shows the deletion moves its key.
        const rosterBefore = await call('GET', ben, `/api/groups/${grp}/members`);
        const fayBefore = (rosterBefore.body as any[] | undefined)?.find?.((r: any) => r.memberPubkey === fay2.pk);
        assert(rosterBefore.status === 200 && fayBefore?.formerKeys?.[0]?.pubkey === fay1.pk && danChainWalks(danRow(rosterBefore.body)),
            `the fixture: before Fay₂ deletes her account, the group's roster names her former key and Dan₂'s (got ${rosterBefore.status})`);
        const before = (await call('GET', dan2, `/api/messages/conversations/${dan2.pk}`)).body?.conversations?.find((c: any) => c.id === dmDanFay);
        assert(JSON.stringify(Object.keys(before?.formerKeys ?? {}).sort()) === JSON.stringify([dan2.pk, fay2.pk].sort()),
            'the fixture: before Fay₂ deletes her account, Dan₂\'s DM with her names both their former keys');
        const purged = se.purgeMemberSelf(fay2.pk);
        assert(purged.ok, `the fixture: Fay₂ deletes her account (${purged.message})`);
    }
    await sweep('main');
    await deleted('main');
    await rosters('main');

    // ── S. a standby's copy ───────────────────────────────────────────────────────────────────────────
    {
        // A copy is signed by the main server's node key and taken from a connector the standby knows (test-dm-standby-order).
        const p2p = await startP2P(0, 0);
        const nodeId = p2p.peerId.toString();
        pinMainServerForTests(`/ip4/127.0.0.1/tcp/4099/p2p/${nodeId}`);
        const whole = await se.exportSyncState(nodeId);
        emptyCopiedTables(db);
        assert((db.prepare('SELECT COUNT(*) AS n FROM invalidated_keys').get() as { n: number }).n === 0, 'the fixture: the copied tables are empty before the copy');
        setNodeRole('backup');
        await se.importRemoteState(whole);
        const signed = (db.prepare('SELECT COUNT(*) AS n FROM invalidated_keys WHERE succession_sig IS NOT NULL').get() as { n: number }).n;
        assert(signed === 4, `the fixture: the standby's copy holds the four signed statements (${signed})`);
        try {
            await sweep('standby');
            await deleted('standby');
            await rosters('standby');
        } finally {
            setNodeRole('primary');
            try { await p2p.stop(); } catch { /* stopping only */ }
        }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});
