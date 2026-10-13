/**
 * Group chats: a re-keyed member's succession statement (scratch/global-node/DESIGN-group-chat-line-display-fable.md §5, §7
 * "Node"; Marty's picks of 11 Oct 2026). Over REAL HTTPS through the real signature middleware, with real Ed25519
 * identities and @beanpool/core's statements on the member's side:
 *
 *   R.  POST /api/community/me/key-succession: 201 once for the new key's statement over its own re-key; 400 on a
 *       statement the old key or another key signed, or over another date; 404 for a key not re-keyed to the signer
 *       (another member asking, a key never re-keyed, an unfinished re-key); 409 once set, whatever the second one says
 *   M.  GET /api/community/me lists rekeyedFrom with attested false, then true
 *   S.  GET /api/groups/:id/members serves formerKeys on the member's row: attested only, newest first, each verifying
 *       (core walkKeySuccession); [] for a member never re-keyed and for an unattested re-key; the roster snapshot is
 *       rebuilt when a statement lands
 *   K.  a second re-key keeps the first row's rekeyed_to and signature (key-move leaves invalidated_keys alone): the chain
 *       Ana₁ → Ana₂ → Ana₃ is two rows, served newest first, and walks from Ana₃ to Ana₁
 *   K9. the node's cap (review of #1826, NB6): a member re-keyed nine times is served the newest eight, which walk; a
 *       ninth served would make the phone's walker refuse the whole chain
 *   C.  replication: a whole snapshot, a delta from after the re-key and before the statement, and a copy in pages all
 *       carry both columns and agree (twin parity: exportSyncState and the spec a copy in pages reads by); a standby's merge takes a statement it lacks, never overwrites one
 *       with null, and takes none for another new key
 *   D.  a DM's answers name its people's former keys (DESIGN-dm-peer-key-pin-fable.md §5 slice 3, P11): Ben's DM list and
 *       the DM read by id serve formerKeys for Ana₃, each with the date it signed, walking to Ana₁; to someone in the DM
 *       only (Cat₂ is refused both, and her own list names nothing of Ana's); nothing for an unattested re-key or a
 *       member never re-keyed, nor on a group's chat; every other field and a DM nobody re-keyed served as before; a
 *       statement that does not verify is dropped with every older one
 *   DS. a standby's copy serves the same, and drops a statement its copy took that does not verify
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-key-succession node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import * as se from './state-engine.js';
import { initStateEngine, seedGenesisMember, createGroup, joinGroup, setNodeRole } from './state-engine.js';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setMemberPhoto, EXPORT_CATEGORIES } from '@beanpool/engine';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { mergeReplicatedInvalidatedKeys } from './engine/key-move.js';
import { formerKeysReader } from './engine/key-succession.js';
import { dmPublicKeyOf, keySuccessionCanonical, makeKeySuccession, walkKeySuccession, KEY_SUCCESSION_MAX } from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';

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

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', signer: Id, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}
const ROUTE = '/api/community/me/key-succession';
const statementOf = (newKey: Id, old: Id, at: string) => {
    const s = makeKeySuccession({ newEdPrivHex: newKey.seedHex, oldPubHex: old.pk, at });
    return { oldPubkey: s.pubkey, at: s.at, sig: s.sig };
};
const row = (pk: string) => db.prepare('SELECT * FROM invalidated_keys WHERE public_key = ?').get(pk) as any;
const rosterRow = async (viewer: Id, g: string, pk: string) =>
    ((await call('GET', viewer, `/api/groups/${g}/members`)).body as any[]).find((r) => r.memberPubkey === pk);

async function main(): Promise<void> {
    console.log('\n=== Group chats: a re-keyed member\'s succession statement ===\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ana1 = member('Ana');
    const ben = member('Ben');
    const cat1 = member('Cat');
    const g = createGroup({ name: 'Succession', joinPolicy: 'open', createdBy: ana1.pk }).id;
    joinGroup(g, ben.pk);
    joinGroup(g, cat1.pk);
    const eve = member('Eve');
    // Ben's DMs, opened before anyone re-keyed: a re-key moves the participant row to the new key (key-move.ts).
    const dmWith = (other: Id) => se.createConversation('dm', [ben.pk, other.pk], ben.pk)!.id;
    const dmAna = dmWith(ana1), dmCat = dmWith(cat1), dmEve = dmWith(eve);
    const AT1 = '2026-10-03T04:00:00.000Z';

    // ── R. the route ──────────────────────────────────────────────────────────────────────────────────
    console.log('── R. POST /api/community/me/key-succession ──');
    const ana2 = rekey(ana1, 'Ana₂');
    const cat2 = rekey(cat1, 'Cat₂');
    const beforeStatement = new Date().toISOString();
    {
        const me = await call('GET', ana2, '/api/community/me');
        assert(me.status === 200 && JSON.stringify(me.body.rekeyedFrom?.map((r: any) => [r.pubkey, r.attested])) === JSON.stringify([[ana1.pk, false]]),
            `M. /me lists Ana₁ as unattested (got ${JSON.stringify(me.body.rekeyedFrom)})`);
        assert(typeof me.body.rekeyedFrom?.[0]?.at === 'string' && me.body.rekeyedFrom[0].at === row(ana1.pk).invalidated_at, 'with the date the node stamped the re-key');
        const benMe = await call('GET', ben, '/api/community/me');
        assert(Array.isArray(benMe.body.rekeyedFrom) && benMe.body.rekeyedFrom.length === 0, 'a member never re-keyed: rekeyedFrom is []');

        const r0 = await rosterRow(ben, g, ana2.pk);
        assert(Array.isArray(r0?.formerKeys) && r0.formerKeys.length === 0, `S. before the statement, Ana₂'s roster row serves no former key (got ${JSON.stringify(r0?.formerKeys)})`);

        const byOld = ed25519.sign(crypto.createHash('sha256').update(keySuccessionCanonical(ana1.pk, ana2.pk, AT1), 'utf8').digest(), Buffer.from(ana1.seedHex, 'hex'));
        const bad = await call('POST', ana2, ROUTE, { oldPubkey: ana1.pk, at: AT1, sig: Buffer.from(byOld).toString('base64') });
        assert(bad.status === 400, `a statement the OLD key signed: 400 (got ${bad.status})`);
        const byBen = statementOf(ben, ana1, AT1);
        assert((await call('POST', ana2, ROUTE, byBen)).status === 400, 'a statement another member\'s key signed: 400');
        const otherDate = { ...statementOf(ana2, ana1, AT1), at: '2026-10-04T04:00:00.000Z' };
        assert((await call('POST', ana2, ROUTE, otherDate)).status === 400, 'Ana₂\'s statement sent with another date: 400');
        assert((await call('POST', ana2, ROUTE, { oldPubkey: ana1.pk, at: 'yesterday', sig: 'x' })).status === 400, 'a malformed body: 400');
        assert(row(ana1.pk).succession_sig === null, 'nothing was written by any of them');

        assert((await call('POST', ben, ROUTE, statementOf(ben, ana1, AT1))).status === 404, 'Ben, signing for Ana₁ with his own key: 404');
        assert((await call('POST', ana2, ROUTE, statementOf(ana2, ben, AT1))).status === 404, 'Ana₂ naming Ben\'s key, never re-keyed: 404');
        assert((await call('POST', ana2, ROUTE, statementOf(ana2, cat1, AT1))).status === 404, 'Ana₂ naming Cat₁, re-keyed to someone else: 404');
        const dee = member('Dee');
        issueRekeyCode(dee.pk, owner.pk);
        const deeNext = newId('Dee₂');
        db.prepare("INSERT INTO members (public_key, callsign, joined_at, status) VALUES (?, 'Dee₂', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active')").run(deeNext.pk);
        assert((await call('POST', deeNext, ROUTE, statementOf(deeNext, dee, AT1))).status === 404, 'a re-key not yet completed (rekey_pending): 404');

        const ok = await call('POST', ana2, ROUTE, statementOf(ana2, ana1, AT1));
        assert(ok.status === 201, `Ana₂'s own statement: 201 (got ${ok.status} ${JSON.stringify(ok.body)})`);
        const stored = row(ana1.pk);
        assert(stored.succession_at === AT1 && typeof stored.succession_sig === 'string' && stored.succession_stored_at >= beforeStatement
            && stored.rekeyed_to === ana2.pk && stored.reason === 'rekeyed', 'stored beside the row: the signed date, the signature, the node\'s clock; the row otherwise unchanged');
        const again = await call('POST', ana2, ROUTE, statementOf(ana2, ana1, '2026-10-05T00:00:00.000Z'));
        assert(again.status === 409 && row(ana1.pk).succession_at === AT1, `a second statement, another date: 409, and the first stays (got ${again.status})`);
        assert((await call('POST', ana2, ROUTE, statementOf(ana2, ana1, AT1))).status === 409, 'the same one again: 409');

        const me2 = await call('GET', ana2, '/api/community/me');
        assert(JSON.stringify(me2.body.rekeyedFrom?.map((r: any) => [r.pubkey, r.attested])) === JSON.stringify([[ana1.pk, true]]), 'M. /me now lists Ana₁ as attested');
    }

    // ── S. served with the roster ─────────────────────────────────────────────────────────────────────
    console.log('\n── S. the roster serves formerKeys ──');
    {
        const a = await rosterRow(ben, g, ana2.pk);
        assert(Array.isArray(a?.formerKeys) && a.formerKeys.length === 1 && a.formerKeys[0].pubkey === ana1.pk && a.formerKeys[0].at === AT1,
            `Ana₂'s row serves Ana₁ (the snapshot was rebuilt when the statement landed) (got ${JSON.stringify(a?.formerKeys)})`);
        assert(walkKeySuccession({ memberPubkey: ana2.pk, formerKeys: a.formerKeys }, ana1.pk), 'and the chain verifies on the member\'s side');
        const c = await rosterRow(ben, g, cat2.pk);
        assert(Array.isArray(c?.formerKeys) && c.formerKeys.length === 0, 'Cat₂\'s re-key is unattested: no row served for it');
        const b = await rosterRow(ana2, g, ben.pk);
        assert(Array.isArray(b?.formerKeys) && b.formerKeys.length === 0, 'Ben, never re-keyed: []');
    }

    // ── K. a second re-key keeps the first row ─────────────────────────────────────────────────────────
    console.log('\n── K. Ana₁ → Ana₂ → Ana₃ ──');
    const ana3 = rekey(ana2, 'Ana₃');
    const AT2 = '2026-10-09T04:00:00.000Z';
    {
        const first = row(ana1.pk);
        assert(first.rekeyed_to === ana2.pk && first.succession_at === AT1 && typeof first.succession_sig === 'string',
            `the first row still names Ana₂, signed, after the second re-key (rekeyed_to ${first.rekeyed_to === ana2.pk ? 'Ana₂' : first.rekeyed_to})`);
        assert(row(ana2.pk)?.rekeyed_to === ana3.pk && row(ana2.pk).succession_sig === null, 'the second row names Ana₃, unattested');
        assert((await rosterRow(ben, g, ana3.pk))?.formerKeys?.length === 0, 'Ana₃\'s row serves nothing while the newest link is unattested');
        assert((await call('POST', ana3, ROUTE, statementOf(ana3, ana1, AT2))).status === 404, 'Ana₃ cannot sign for Ana₁ (re-keyed to Ana₂): 404');
        assert((await call('POST', ana3, ROUTE, statementOf(ana3, ana2, AT2))).status === 201, 'Ana₃ signs for Ana₂: 201');
        const a = await rosterRow(ben, g, ana3.pk);
        assert(JSON.stringify(a?.formerKeys?.map((f: any) => f.pubkey)) === JSON.stringify([ana2.pk, ana1.pk]), 'Ana₃\'s row serves both, newest first');
        assert(walkKeySuccession({ memberPubkey: ana3.pk, formerKeys: a.formerKeys }, ana1.pk), 'and Ana₁ walks to Ana₃');
        const me = await call('GET', ana3, '/api/community/me');
        assert(JSON.stringify(me.body.rekeyedFrom?.map((r: any) => [r.pubkey, r.attested])) === JSON.stringify([[ana2.pk, true]]), '/me lists only the key Ana₃ replaced');
    }

    // ── K9. the node's cap of eight ──────────────────────────────────────────────────────────────────────
    console.log('\n── K9. nine re-keys ──');
    {
        // keys[0] the oldest … keys[9] the current; each row attested by its successor, stamped in order.
        const keys = Array.from({ length: 10 }, () => {
            const seed = crypto.randomBytes(32);
            return { seedHex: seed.toString('hex'), pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
        });
        const insert = db.prepare(`INSERT INTO invalidated_keys (public_key, reason, invalidated_at, rekeyed_to, succession_at, succession_sig, succession_stored_at)
                                   VALUES (?, 'rekeyed', ?, ?, ?, ?, ?)`);
        const statements = keys.slice(0, 9).map((k, i) => {
            const at = new Date(Date.UTC(2026, 8, 1 + i)).toISOString();
            const s = makeKeySuccession({ newEdPrivHex: keys[i + 1].seedHex, oldPubHex: k.pk, at });
            insert.run(k.pk, at, keys[i + 1].pk, at, s.sig, at);
            return { pubkey: s.pubkey, at: s.at, sig: s.sig };
        });
        const served = formerKeysReader()(keys[9].pk);
        assert(KEY_SUCCESSION_MAX === 8 && served.length === 8, `nine attested re-keys: the newest eight are served (${served.length})`);
        assert(JSON.stringify(served.map((f) => f.pubkey)) === JSON.stringify(keys.slice(1, 9).map((k) => k.pk).reverse()), 'newest first, keys₈ … keys₁');
        assert(walkKeySuccession({ memberPubkey: keys[9].pk, formerKeys: served }, keys[1].pk), 'and the eight walk to the oldest served');
        assert(!walkKeySuccession({ memberPubkey: keys[9].pk, formerKeys: [...served, statements[0]] }, keys[1].pk),
            'a ninth served would make the walker refuse the whole chain: the cap keeps the eight usable');
    }

    // ── D. a DM's answers name its people's former keys ─────────────────────────────────────────────────
    console.log('\n── D. the DM list serves formerKeys (DM peer key pin, slice 3) ──');
    const listOf = (who: Id) => call('GET', who, `/api/messages/conversations/${who.pk}`);
    const listed = async (who: Id, id: string) => ((await listOf(who)).body?.conversations as any[] | undefined)?.find((c) => c.id === id);
    let servedToBen: unknown = null;
    {
        const l = await listOf(ben);
        assert(l.status === 200 && JSON.stringify(Object.keys(l.body)) === JSON.stringify(['conversations', 'totalUnread', 'deletedAccounts']),
            `Ben's list: 200, the same three fields at the top (got ${l.status} ${JSON.stringify(Object.keys(l.body ?? {}))})`);
        const dm = (l.body.conversations as any[]).find((c) => c.id === dmAna);
        assert(JSON.stringify([...dm?.participants ?? []].sort()) === JSON.stringify([ben.pk, ana3.pk].sort()), 'the fixture: the re-keys moved the DM to Ana₃');
        assert(dm?.formerKeys && JSON.stringify(Object.keys(dm.formerKeys)) === JSON.stringify([ana3.pk]),
            `the DM with Ana₃ names her former keys, and nobody else's (got ${JSON.stringify(dm?.formerKeys && Object.keys(dm.formerKeys))})`);
        const chain = dm?.formerKeys?.[ana3.pk] ?? [];
        assert(JSON.stringify(chain.map((f: any) => [f.pubkey, f.at])) === JSON.stringify([[ana2.pk, AT2], [ana1.pk, AT1]]),
            `Ana₂ then Ana₁, newest first, each with the date it signed (the banner's "re-keyed on") (got ${JSON.stringify(chain.map((f: any) => f.at))})`);
        assert(walkKeySuccession({ memberPubkey: ana3.pk, formerKeys: chain }, ana1.pk), 'and the chain walks from Ana₃ to Ana₁ on the phone\'s side');
        servedToBen = dm?.formerKeys;

        const one = await call('GET', ben, `/api/messages/${dmAna}?limit=1`);
        assert(one.status === 200 && JSON.stringify(one.body.conversation?.formerKeys) === JSON.stringify(dm?.formerKeys),
            'the DM read by id (the phone\'s refresh of one conversation) serves the same');
        const theirs = await listed(ana3, dmAna);
        assert(JSON.stringify(theirs?.formerKeys) === JSON.stringify(dm?.formerKeys), 'Ana₃\'s own list: the same, her own chain under her key');

        const plain = (l.body.conversations as any[]).find((c) => c.id === dmEve);
        assert(plain && !('formerKeys' in plain), `the DM with Eve, never re-keyed: no formerKeys field (got ${JSON.stringify(plain?.formerKeys)})`);
        const unattested = (l.body.conversations as any[]).find((c) => c.id === dmCat);
        assert(unattested && JSON.stringify([...unattested.participants].sort()) === JSON.stringify([ben.pk, cat2.pk].sort()) && !('formerKeys' in unattested),
            'the DM with Cat₂, re-keyed but unattested: none');
        const { formerKeys: _f, ...rest } = dm ?? {};
        assert(JSON.stringify(Object.keys(rest)) === JSON.stringify(Object.keys(plain ?? {})),
            `every other field of the re-keyed DM is the field set of one nobody re-keyed (${Object.keys(rest).length} fields)`);
        const engine = se.getConversationsByMember(ben.pk).find((c) => c.id === dmAna);
        assert(JSON.stringify(rest) === JSON.stringify({ ...engine, unreadCount: dm?.unreadCount, mute: dm?.mute }),
            'and each as the listing served it before: the engine\'s conversation, its unread count and mute');
        const others = (l.body.conversations as any[]).filter((c) => c.type !== 'dm');
        assert(others.length > 0 && others.every((c) => !('formerKeys' in c)) && others.some((c) => c.participants?.includes(ana3.pk)),
            `not on a group's chat, though Ana₃ is in it (${others.map((c) => c.type).join(', ')})`);

        const catReadsBens = await call('GET', cat2, `/api/messages/conversations/${ben.pk}`);
        assert(catReadsBens.status === 403 && !JSON.stringify(catReadsBens.body).includes(ana1.pk), `Cat₂ reading Ben's list: 403, nothing of Ana's (got ${catReadsBens.status})`);
        const catReadsDm = await call('GET', cat2, `/api/messages/${dmAna}?limit=1`);
        assert(catReadsDm.status === 403 && !JSON.stringify(catReadsDm.body).includes(ana1.pk), `Cat₂ reading the DM by id: 403, nothing of Ana's (got ${catReadsDm.status})`);
        const catsOwn = await listOf(cat2);
        assert(catsOwn.status === 200 && !(catsOwn.body.conversations as any[]).some((c) => c.id === dmAna) && !JSON.stringify(catsOwn.body).includes(ana1.pk),
            'Cat₂\'s own list: the DM is not in it, and nothing names Ana\'s former keys (she shares only the group\'s chat with Ana₃)');

        // The rule itself, for an open node (read auth off: anyone may read anyone's list or DM, keyless or not).
        const { withDmFormerKeys } = await import('./engine/key-succession.js') as any;
        const convs = se.getConversationsByMember(ben.pk);
        assert(typeof withDmFormerKeys === 'function', 'withDmFormerKeys is there');
        if (typeof withDmFormerKeys === 'function') {
            const has = (rows: any[]) => rows.some((c) => 'formerKeys' in c);
            assert(!has(withDmFormerKeys(convs, undefined)), 'a reader with no key (an open node\'s guest): none');
            assert(!has(withDmFormerKeys(convs, cat2.pk)), 'a member not in the DMs reading Ben\'s list on an open node: none');
            assert(JSON.stringify(withDmFormerKeys(convs, ben.pk).find((c: any) => c.id === dmAna)?.formerKeys) === JSON.stringify(dm?.formerKeys), 'Ben: Ana₃\'s');
        }

        // A statement that does not verify: the newest link, then an older one.
        const sigOf = (pk: string) => row(pk).succession_sig as string;
        const [sig1, sig2] = [sigOf(ana1.pk), sigOf(ana2.pk)];
        db.prepare('UPDATE invalidated_keys SET succession_sig = ? WHERE public_key = ?').run(sig1, ana2.pk);
        const brokenNewest = await listed(ben, dmAna);
        assert(brokenNewest && !('formerKeys' in brokenNewest), `Ana₂'s statement altered: nothing is served, Ana₁'s with it (got ${JSON.stringify(brokenNewest?.formerKeys)})`);
        db.prepare('UPDATE invalidated_keys SET succession_sig = ?, succession_at = ? WHERE public_key = ?').run(sig2, AT2, ana2.pk);
        db.prepare('UPDATE invalidated_keys SET succession_at = ? WHERE public_key = ?').run('2026-10-04T04:00:00.000Z', ana1.pk);
        const brokenOlder = await listed(ben, dmAna);
        assert(JSON.stringify(brokenOlder?.formerKeys?.[ana3.pk]?.map((f: any) => f.pubkey)) === JSON.stringify([ana2.pk]),
            `Ana₁'s date altered: Ana₂ alone is served (got ${JSON.stringify(brokenOlder?.formerKeys)})`);
        db.prepare('UPDATE invalidated_keys SET succession_at = ? WHERE public_key = ?').run(AT1, ana1.pk);
        assert(JSON.stringify((await listed(ben, dmAna))?.formerKeys) === JSON.stringify(servedToBen), 'put back: the whole chain again');
    }

    // ── C. replication ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── C. replication ──');
    {
        const nodeId = 'key-succession-node';
        const pick = (rows: any[] | undefined, pk: string) => (rows ?? []).find((r) => r.publicKey === pk);
        const whole = await se.exportSyncState(nodeId);
        const w = pick(whole.invalidatedKeys, ana1.pk);
        assert(w?.successionSig === row(ana1.pk).succession_sig && w?.successionAt === AT1 && w?.successionStoredAt === row(ana1.pk).succession_stored_at,
            'a whole snapshot carries the statement');
        assert(pick(whole.invalidatedKeys, cat1.pk)?.successionSig === null, 'and null for an unattested row');
        // A delta from after Ana₂'s re-key and before her statement: the statement did not move invalidated_at.
        assert(row(ana1.pk).invalidated_at < beforeStatement, 'the fixture: Ana₁\'s row was re-keyed before the cursor');
        const delta = await se.exportSyncState(nodeId, beforeStatement);
        assert(pick(delta.invalidatedKeys, ana1.pk)?.successionSig === row(ana1.pk).succession_sig, 'a delta from before the statement carries the row, by its second watermark');
        // A copy in pages reads each category by the engine's spec (engine/copy-pages.ts stepsOf): its own where, the cursor in
        // each place, shaped by the category's own code.
        const cat = EXPORT_CATEGORIES.find((c) => c.key === 'invalidatedKeys')!;
        const d = cat.delta as { where: string; sinceParams: number };
        const paged = cat.shape(db as any, db.prepare(`SELECT * FROM ${cat.table} WHERE (${d.where})`).all(...Array.from({ length: d.sinceParams }, () => beforeStatement))) as any[];
        const norm = (rows: any[]) => JSON.stringify([...rows].sort((x, y) => (x.publicKey < y.publicKey ? -1 : 1)));
        assert(typeof d.where === 'string' && norm(paged) === norm(delta.invalidatedKeys ?? []),
            `twin parity: a copy in pages carries the same replaced keys as the delta (${paged.length} vs ${(delta.invalidatedKeys ?? []).length})`);

        // A standby's merge, here on this database: the statement taken when missing, never cleared, never for another key.
        const sig = row(ana1.pk).succession_sig;
        const storedAt = row(ana1.pk).succession_stored_at;
        db.prepare('UPDATE invalidated_keys SET succession_sig = NULL, succession_at = NULL, succession_stored_at = NULL WHERE public_key = ?').run(ana1.pk);
        mergeReplicatedInvalidatedKeys([w]);
        assert(row(ana1.pk).succession_sig === sig && row(ana1.pk).succession_at === AT1 && row(ana1.pk).succession_stored_at === storedAt,
            'a merge sets a statement this copy lacks, even when invalidated_at is the same');
        mergeReplicatedInvalidatedKeys([{ ...w, successionSig: null, successionAt: null, successionStoredAt: null, invalidatedAt: new Date().toISOString() }]);
        assert(row(ana1.pk).succession_sig === sig && row(ana1.pk).succession_at === AT1, 'a newer row with no statement never overwrites one with null');
        db.prepare('UPDATE invalidated_keys SET succession_sig = NULL, succession_at = NULL, succession_stored_at = NULL WHERE public_key = ?').run(cat1.pk);
        mergeReplicatedInvalidatedKeys([{ ...pick(whole.invalidatedKeys, cat1.pk), successionSig: sig, successionAt: AT1, rekeyedTo: ben.pk }]);
        assert(row(cat1.pk).succession_sig === null, 'a statement carried with another new key than this row\'s is not taken');
    }

    // ── DS. a standby's copy ──────────────────────────────────────────────────────────────────────────
    console.log('\n── DS. a standby\'s copy serves the DM\'s formerKeys ──');
    {
        // A copy is signed by the main server's node key and taken from a connector the standby knows (test-dm-standby-order).
        const p2p = await startP2P(0, 0);
        const nodeId = p2p.peerId.toString();
        addConnector(`/ip4/127.0.0.1/tcp/4099/p2p/${nodeId}`, 'mirror', 'self-test-peer');
        const whole = await se.exportSyncState(nodeId);
        const copyInto = async (payload: any) => {
            emptyCopiedTables(db);
            setNodeRole('backup');
            try { await se.importRemoteState(payload); } finally { setNodeRole('primary'); }
        };
        await copyInto(whole);
        const onCopy = await listed(ben, dmAna);
        assert(onCopy && JSON.stringify(onCopy.formerKeys) === JSON.stringify(servedToBen),
            `the copy's Ben's list names Ana₃'s former keys, as the main server's did (got ${JSON.stringify(onCopy?.formerKeys && Object.keys(onCopy.formerKeys))})`);
        assert(JSON.stringify((await call('GET', ben, `/api/messages/${dmAna}?limit=1`)).body.conversation?.formerKeys) === JSON.stringify(servedToBen), 'and the DM read by id');
        const plainOnCopy = await listed(ben, dmEve);
        assert(plainOnCopy && !('formerKeys' in plainOnCopy), 'the DM with Eve: none, on the copy too');
        // A copy that took a statement Ana₃ never signed (a merge takes them unchecked, key-move.ts): here the main server's
        // own row was altered before its copy was made.
        db.prepare('UPDATE invalidated_keys SET succession_sig = ? WHERE public_key = ?').run(row(ana1.pk).succession_sig, ana2.pk);
        const forged = await se.exportSyncState(nodeId);
        await copyInto(forged);
        assert(row(ana2.pk)?.succession_sig === row(ana1.pk)?.succession_sig, 'the fixture: the copy holds the altered statement');
        const forgedOnCopy = await listed(ben, dmAna);
        assert(forgedOnCopy && !('formerKeys' in forgedOnCopy), `and serves nothing for it (got ${JSON.stringify(forgedOnCopy?.formerKeys)})`);
        await copyInto(whole);
        try { await p2p.stop(); } catch { /* stopping only */ }
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run + 1} passed (stopped: ${e?.message ?? e})`);
    process.exit(1);
});
