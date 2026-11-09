/**
 * GET /api/invite/mine/:publicKey tells a member what each invite they made is for and carries (invites-vouching slice I1;
 * scratch/fable-design/DESIGN-invites-vouching-review-fable.md §4 and §5): `namesEntryId`, `vouchAmount`, `voucherLevel` and
 * `expiresAt` (made-at + the one 30-day life), `forKnock` (made when the maker said yes to a request to join), and the
 * joiner's callsign on a used code. A bound invite carries its entry and its amounts; a plain one has null for each.
 * `forKnock` outlives the knock row: tidyKnocks deletes it 30 days after the yes, and a used code is still told by its own
 * columns (redeemInvite let only the applicant's key use a knock code, so its note is the key that used it), so Joined never
 * shows a key as a name.
 *
 * STOP rule of the slice: no code and no entry id reaches anyone but the maker. Boots the real server, through the real
 * middleware, and has another member, a signed key that is no member here, a visitor and nobody (unsigned) read the maker's
 * invites: all refused, with none of the maker's codes, entry ids or amounts in the answer, and the same answer as for a key
 * that is no member at all. Run again with ENFORCE_READ_AUTH=false (scripts/server-suites.mjs): it holds there too.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-invite-mine-fields.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';

const READ_AUTH_ON = process.env.ENFORCE_READ_AUTH !== 'false';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function get(path: string, id?: Id): Promise<{ status: number; text: string; body: any }> {
    const res = await fetch(`${BASE}${path}`, { headers: id ? signedHeaders('GET', path, '', id) : {} });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, text, body };
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
    console.log(`An invite tells its maker what it is for and carries, and nobody else, read auth ${READ_AUTH_ON ? 'ON' : 'OPTED OUT'}...\n`);
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { INVITE_LIFE_DAYS } = await import('@beanpool/core');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const row = (callsign: string, visitor = false): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, visitor ? 1 : 0);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const maker = row('maker');
    const other = row('otherMember');
    const joiner = row('joinerJo');
    const applicant = row('applicantAl');
    const applicantLate = row('applicantBo');
    const visitor = row('visitor', true);
    const nonMember = keypair();
    const nobodyKey = keypair().pubKeyHex;

    // Seven invites of the maker's: bound with a vouch and a budget, plain with a note, plain with nothing, one made for a request
    // to join (its note is the applicant's key), a used one, a used one that was made for a request to join over a month ago (its
    // knock row is tidied away below), and a used one that carries a note.
    const ENTRY = `entry-${crypto.randomBytes(8).toString('hex')}`;
    const BOUND = 'INV-BND1-CODE';
    const NOTE = 'INV-NOTE-CODE';
    const BARE = 'INV-BARE-CODE';
    const KNOCK = 'INV-KNCK-CODE';
    const USED = 'INV-USED-CODE';
    const USED_KNOCK = 'INV-UKNK-CODE';
    const USED_NOTE = 'INV-UNTE-CODE';
    const madeAt = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const insert = db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by, used_at, intended_for, names_entry_id, vouch_amount, voucher_level)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(BOUND, maker.pubKeyHex, madeAt(7), null, null, null, ENTRY, 200, 1000);
    insert.run(NOTE, maker.pubKeyHex, madeAt(1), null, null, 'CJ', null, null, null);
    insert.run(BARE, maker.pubKeyHex, madeAt(0), null, null, null, null, null, null);
    insert.run(KNOCK, maker.pubKeyHex, madeAt(2), null, null, applicant.pubKeyHex, null, null, null);
    insert.run(USED, maker.pubKeyHex, madeAt(10), joiner.pubKeyHex, madeAt(9), null, null, 100, null);
    insert.run(USED_KNOCK, maker.pubKeyHex, madeAt(31), applicantLate.pubKeyHex, madeAt(31), applicantLate.pubKeyHex, null, null, null);
    insert.run(USED_NOTE, maker.pubKeyHex, madeAt(12), joiner.pubKeyHex, madeAt(11), 'Sam', null, null, null);
    const knockRow = db.prepare(`INSERT INTO join_requests (id, pubkey, callsign, message, status, created_at, decided_by, invite_code, decided_at)
                                 VALUES (?, ?, ?, '', 'approved', ?, ?, ?, ?)`);
    knockRow.run(`jr-${crypto.randomUUID()}`, applicant.pubKeyHex, 'applicantAl', madeAt(2), maker.pubKeyHex, KNOCK, madeAt(2));
    knockRow.run(`jr-${crypto.randomUUID()}`, applicantLate.pubKeyHex, 'applicantBo', madeAt(32), maker.pubKeyHex, USED_KNOCK, madeAt(31));

    // ── the maker ────────────────────────────────────────────────────────────────────────────────
    const mine = await get(`/api/invite/mine/${maker.pubKeyHex}`, maker);
    assert(mine.status === 200, `the maker reads their invites → 200 (got ${mine.status})`);
    const byCode: Record<string, any> = Object.fromEntries((mine.body?.invites ?? []).map((i: any) => [i.code, i]));
    assert(Object.keys(byCode).length === 7, `…all seven of them (got ${Object.keys(byCode).length})`);

    const bound = byCode[BOUND] ?? {};
    assert(bound.namesEntryId === ENTRY, 'a bound invite carries its names-list entry id');
    assert(bound.vouchAmount === 200, 'a bound invite carries its vouch (200)');
    assert(bound.voucherLevel === 1000, 'a bound invite carries its voucher budget (1,000)');
    assert(bound.forKnock === false, 'a bound invite was not made for a request to join');
    assert(bound.expiresAt === new Date(Date.parse(bound.createdAt) + INVITE_LIFE_DAYS * DAY).toISOString(),
        `…and expires ${INVITE_LIFE_DAYS} days after it was made (${bound.expiresAt})`);

    for (const [label, code] of [['a plain invite with a note', NOTE], ['a plain invite with nothing', BARE]] as const) {
        const inv = byCode[code] ?? {};
        assert(inv.namesEntryId === null && inv.vouchAmount === null && inv.voucherLevel === null,
            `${label} has null for the entry, the vouch and the budget (${JSON.stringify([inv.namesEntryId, inv.vouchAmount, inv.voucherLevel])})`);
        assert(typeof inv.expiresAt === 'string' && Date.parse(inv.expiresAt) === Date.parse(inv.createdAt) + INVITE_LIFE_DAYS * DAY,
            `…and still says when it expires`);
    }
    assert(byCode[NOTE]?.intendedFor === 'CJ', 'the maker’s note is returned as before');
    assert(byCode[KNOCK]?.forKnock === true, 'an invite made for a request to join says so');
    assert(byCode[NOTE]?.forKnock === false && byCode[BARE]?.forKnock === false && byCode[BOUND]?.forKnock === false, 'and no other invite does');
    assert(byCode[USED]?.usedByCallsign === 'joinerJo' && byCode[USED]?.vouchAmount === 100, 'a used invite says who joined, and keeps the vouch it carried');
    assert(byCode[BARE]?.usedByCallsign === null, 'an unused invite has no joiner');
    assert(byCode[USED]?.forKnock === false && byCode[USED_NOTE]?.forKnock === false,
        'a used invite that was not made for a request to join says so too, with or without a note');
    assert(byCode[USED_KNOCK]?.forKnock === true && byCode[USED_KNOCK]?.usedByCallsign === 'applicantBo',
        'a used invite made for a request to join says so while its knock row is there');

    // ── a month after the yes: tidyKnocks deletes the knock row, and the invite still says what it was for ──
    const knockRows = (code: string) => (db.prepare('SELECT COUNT(*) AS n FROM join_requests WHERE invite_code = ?').get(code) as { n: number }).n;
    assert(knockRows(USED_KNOCK) === 1 && knockRows(KNOCK) === 1, 'before the tidy-up, both knock rows are there');
    // The applicant re-keys before the tidy-up (SSO recovery or an admin re-key): used_by moves, the note does not.
    const { moveMemberKeyRows } = await import('./engine/key-move.js');
    const lateNewKey = crypto.randomBytes(32).toString('hex');
    db.transaction(() => moveMemberKeyRows(applicantLate.pubKeyHex, lateNewKey, new Date().toISOString(), { keepStamps: false }))();
    const { tidyKnocks } = await import('./engine/knocks.js');
    const tidied = tidyKnocks();
    assert(tidied.deleted === 1 && knockRows(USED_KNOCK) === 0, `tidyKnocks deletes the knock row of the yes given 31 days ago (${JSON.stringify(tidied)})`);
    assert(knockRows(KNOCK) === 1, '…and keeps the one given 2 days ago');
    const later = await get(`/api/invite/mine/${maker.pubKeyHex}`, maker);
    const lateByCode: Record<string, any> = Object.fromEntries((later.body?.invites ?? []).map((i: any) => [i.code, i]));
    assert(later.status === 200 && Object.keys(lateByCode).length === 7, 'the maker still reads all seven after the tidy-up');
    assert(lateByCode[USED_KNOCK]?.forKnock === true && lateByCode[USED_KNOCK]?.intendedFor === applicantLate.pubKeyHex,
        'a used invite made for a request to join still says so with its knock row gone');
    assert(lateByCode[USED_KNOCK]?.usedByCallsign === 'applicantBo', '…and still says who joined');
    assert(lateByCode[USED_KNOCK]?.usedBy === lateNewKey && lateByCode[USED_KNOCK]?.forKnock === true,
        '…even though its joiner re-keyed before the tidy-up (used_by moved, the note did not)');
    assert(lateByCode[KNOCK]?.forKnock === true, 'an unused knock invite whose row is still there says so as before');
    assert(lateByCode[USED]?.forKnock === false && lateByCode[USED_NOTE]?.forKnock === false && lateByCode[NOTE]?.forKnock === false,
        'and no other invite does');

    // ── nobody else (the STOP rule) ──────────────────────────────────────────────────────────────
    const secrets = [BOUND, NOTE, BARE, KNOCK, USED, USED_KNOCK, USED_NOTE, ENTRY, joiner.pubKeyHex, applicant.pubKeyHex, applicantLate.pubKeyHex, lateNewKey];
    const leaked = (text: string) => secrets.filter((s) => text.includes(s));
    const readers: [string, Id | undefined, number][] = [
        ['another member', other, 403],
        ['a signed key that is no member here', nonMember, 403],
        ['a visitor', visitor, 403],
        ['the person the invite was made for', applicant, 403],
        ['nobody (unsigned)', undefined, 401],
    ];
    for (const [who, id, want] of readers) {
        const r = await get(`/api/invite/mine/${maker.pubKeyHex}`, id);
        assert(r.status === want, `${who} reading the maker's invites → ${want} (got ${r.status})`);
        assert(leaked(r.text).length === 0, `…and is sent no code, entry id or key (saw ${leaked(r.text).join(', ') || 'none'})`);
        assert(!/"(namesEntryId|vouchAmount|voucherLevel|expiresAt|forKnock)"/.test(r.text), '…and none of the new fields');
        const none = await get(`/api/invite/mine/${nobodyKey}`, id);
        assert(none.status === r.status && none.text === r.text, '…the same answer as for a key that is no member here');
    }

    // Reading as the maker for another key is refused too: the key in the path must be the signer's.
    const crossed = await get(`/api/invite/mine/${other.pubKeyHex}`, maker);
    assert(crossed.status === 403 && leaked(crossed.text).length === 0, 'the maker asking for another member’s invites → 403, nothing sent');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ An invite says what it is for and carries to its maker alone, read auth ${READ_AUTH_ON ? 'on' : 'opted out'}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
