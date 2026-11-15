/**
 * Who learns which names-list entry an invite is for (Marty's 12 Nov idea, yes 15 Nov: "Show the names-list name beside an
 * invite, so you can see who an invite is for").
 *
 * The name itself never reaches this server: it is sealed on the admins' phones (engine/names-list.ts), and a phone that
 * holds the list's key opens it. What the server hands out is the link, an invite's `namesEntryId`, and with it a phone
 * shows the name beside the invite (core inviteWho, People → Invites). So the link goes only to someone the server lets
 * read the names list now: an owner or admin whose role acts, the same rule as every /api/names read. An admin who made a
 * bound invite and has since stopped being one (role revoked, or changed to moderator) still sees the invite (to share or
 * revoke it), but not whose entry it is for; their phone no longer opens the list either. Read at each request: made an
 * admin again, the link is back.
 *
 * A table, through the real HTTPS stack and its signature middleware, over the readers (owner, admin, the inviter now a
 * plain member, the inviter now a moderator, another member, a visitor, nobody) and the invites (bound to an entry, or
 * not), for both reads that carry the link: a maker's own invites (GET /api/invite/mine/:publicKey) and the names list's
 * own read of every bound invite (GET /api/names/invites). An invite with no entry reads as before for everyone.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-invite-names-entry-readers.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

const READ_AUTH_ON = process.env.ENFORCE_READ_AUTH !== 'false';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string };

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, name };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': signRequest(id.privateKey, { method, path: path.split('?')[0], timestamp: ts, nonce, body }),
        [SIGNED_FOR_HEADER]: signedForHost(),
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
const entryId = () => crypto.randomBytes(16).toString('hex');

async function main() {
    console.log(`Which names-list entry an invite is for reaches only those who may read the names list, read auth ${READ_AUTH_ON ? 'ON' : 'OPTED OUT'}...\n`);
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { grantNodeRole, revokeNodeRole } = await import('./engine/node-roles.js');
    const { claimGrantor } = await import('./claim-code.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const read = async (path: string, id?: Id) => {
        // Fresh limiter windows: the suite's own count never decides a result.
        pruneAuthAttempts(Date.now() + 120_000);
        resetGatewayRateLimit();
        return get(path, id);
    };

    const row = (name: string, visitor = false): Id => {
        const id = keypair(name);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_visitor)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, name, `INV-${name.toUpperCase()}`, visitor ? 1 : 0);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const olive = row('oliveOwner');
    const ada = row('adaAdmin');
    const ian = row('ianWasAdmin');
    const max = row('maxWasAdmin');
    const mo = row('moMember');
    const vic = row('vicVisitor', true);

    grantNodeRole(olive.pubKeyHex, 'owner', claimGrantor(crypto.randomBytes(4).toString('hex')));
    for (const who of [ada, ian, max]) grantNodeRole(who.pubKeyHex, 'admin', olive.pubKeyHex);

    // Each maker's two invites, made while they were an owner or admin: one bound to their entry (with a vouch and a
    // voucher budget, as amend3 allows) and one plain with a note. Bound invites are made only by an owner or admin who can
    // open the entry (engine/names-list.ts assertMayBindInvite), so each is written here as that admin made it.
    const madeAt = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
    const insert = db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for, names_entry_id, vouch_amount_c, voucher_level_c)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`);
    interface Made { bound: string; plain: string; entry: string }
    const makers = new Map<string, Made>();
    for (const [i, who] of [olive, ada, ian, max].entries()) {
        const made = { bound: `INV-BND${i}-${who.name.slice(0, 4).toUpperCase()}`, plain: `INV-PLN${i}-${who.name.slice(0, 4).toUpperCase()}`, entry: entryId() };
        insert.run(made.bound, who.pubKeyHex, madeAt(3 + i), null, made.entry, 20000, 100000);
        insert.run(made.plain, who.pubKeyHex, madeAt(1 + i), `For ${who.name}`, null, null, null);
        makers.set(who.pubKeyHex, made);
    }
    const allEntries = [...makers.values()].map((m) => m.entry);

    // Since then: Ian stopped being an admin (the owner revoked it), and Max was changed to moderator.
    revokeNodeRole(ian.pubKeyHex, 'admin', olive.pubKeyHex);
    revokeNodeRole(max.pubKeyHex, 'admin', olive.pubKeyHex);
    grantNodeRole(max.pubKeyHex, 'moderator', olive.pubKeyHex);

    // ── 1. A maker's own invites: the bound one carries its entry only while its maker may read the names list ──────────
    // [who, may read the names list now]
    const ownRows: [string, Id, boolean][] = [
        ['the owner', olive, true],
        ['an admin', ada, true],
        ['the inviter, now a plain member (admin revoked)', ian, false],
        ['the inviter, now a moderator', max, false],
    ];
    for (const [who, id, shown] of ownRows) {
        const made = makers.get(id.pubKeyHex)!;
        const r = await read(`/api/invite/mine/${id.pubKeyHex}`, id);
        assert(r.status === 200, `${who} reads their own invites → 200 (got ${r.status})`);
        const byCode: Record<string, any> = Object.fromEntries((r.body?.invites ?? []).map((i: any) => [i.code, i]));
        const bound = byCode[made.bound];
        const plain = byCode[made.plain];
        assert(!!bound && !!plain, `…both their invites are listed, the bound one too (to share or revoke)`);
        if (shown) {
            assert(bound?.namesEntryId === made.entry, `…× invite with an entry: the entry is given (${bound?.namesEntryId})`);
        } else {
            assert(bound?.namesEntryId === null, `…× invite with an entry: no entry (got ${JSON.stringify(bound?.namesEntryId)})`);
            assert(!r.text.includes(made.entry), '…and the entry id is nowhere in the answer');
        }
        assert(bound?.vouchAmount === 20000 && bound?.voucherLevel === 100000, '…the bound invite still says what it carries (vouch and voucher budget)');
        assert(plain?.namesEntryId === null && plain?.intendedFor === `For ${id.name}`, `…× invite without an entry: no entry and the note, as before`);
    }

    // Another member has none of their own: an empty list. A visitor neither: refused by the read gate where read auth is on
    // (a visitor's key reads as no member's), an empty list under the opt-out. No entry anywhere.
    const moOwn = await read(`/api/invite/mine/${mo.pubKeyHex}`, mo);
    assert(moOwn.status === 200 && Array.isArray(moOwn.body?.invites) && moOwn.body.invites.length === 0, `another member reads their own invites → none (${moOwn.status})`);
    const vicOwn = await read(`/api/invite/mine/${vic.pubKeyHex}`, vic);
    assert(READ_AUTH_ON ? vicOwn.status === 403 : vicOwn.status === 200 && vicOwn.body?.invites?.length === 0,
        `a visitor reads their own invites → ${READ_AUTH_ON ? '403' : 'none'} (${vicOwn.status})`);
    assert(allEntries.every((e) => !moOwn.text.includes(e) && !vicOwn.text.includes(e)), '…and neither answer holds an entry');

    // ── 2. Anyone else reading a maker's invites: refused, with no code and no entry (the maker-only rule holds) ─────────
    const leaked = (text: string) => [...allEntries, ...[...makers.values()].flatMap((m) => [m.bound, m.plain])].filter((s) => text.includes(s));
    const strangers: [string, Id | undefined, number][] = [
        ['the owner', olive, 403],
        ['an admin', ada, 403],
        ['the inviter, now a plain member', ian, 403],
        ['another member', mo, 403],
        ['a visitor', vic, 403],
        ['nobody (unsigned)', undefined, 401],
    ];
    for (const [target, targetId] of [['the admin’s', ada], ['the plain inviter’s', ian]] as const) {
        for (const [who, id, want] of strangers) {
            if (id === targetId) continue;
            const r = await read(`/api/invite/mine/${targetId.pubKeyHex}`, id);
            assert(r.status === want, `${who} reading ${target} invites → ${want} (got ${r.status})`);
            assert(leaked(r.text).length === 0, `…no code and no entry in the answer (saw ${leaked(r.text).join(', ') || 'none'})`);
        }
    }

    // ── 3. The names list's own read of every bound invite: owners and admins whose role acts, nobody else ────────────
    const listReaders: [string, Id | undefined, number][] = [
        ['the owner', olive, 200],
        ['an admin', ada, 200],
        ['the inviter, now a plain member', ian, 403],
        ['the inviter, now a moderator', max, 403],
        ['another member', mo, 403],
        ['a visitor', vic, 403],
        ['nobody (unsigned)', undefined, 401],
    ];
    for (const [who, id, want] of listReaders) {
        const r = await read('/api/names/invites', id);
        assert(r.status === want, `${who} reading the names list's bound invites → ${want} (got ${r.status})`);
        if (want === 200) {
            const entries = new Set((r.body?.invites ?? []).map((i: any) => i.entryId));
            assert(allEntries.every((e) => entries.has(e)), `…every bound invite with its entry (${entries.size})`);
            assert(!/"code"\s*:\s*"INV-/.test(r.text), '…and never a code, not even its maker’s');
        } else {
            assert(leaked(r.text).length === 0, `…no code and no entry in the answer (saw ${leaked(r.text).join(', ') || 'none'})`);
        }
    }

    // ── 4. The rule is read at each request: Ian made an admin again sees the entry again; Ada's revoked, she doesn't ────
    grantNodeRole(ian.pubKeyHex, 'admin', olive.pubKeyHex);
    revokeNodeRole(ada.pubKeyHex, 'admin', olive.pubKeyHex);
    const ianAgain = await read(`/api/invite/mine/${ian.pubKeyHex}`, ian);
    const ianBound = (ianAgain.body?.invites ?? []).find((i: any) => i.code === makers.get(ian.pubKeyHex)!.bound);
    assert(ianBound?.namesEntryId === makers.get(ian.pubKeyHex)!.entry, `Ian, an admin again: his bound invite gives its entry again (${ianBound?.namesEntryId})`);
    const adaNow = await read(`/api/invite/mine/${ada.pubKeyHex}`, ada);
    const adaBound = (adaNow.body?.invites ?? []).find((i: any) => i.code === makers.get(ada.pubKeyHex)!.bound);
    assert(adaBound?.namesEntryId === null && !adaNow.text.includes(makers.get(ada.pubKeyHex)!.entry),
        `Ada, her admin role revoked: her bound invite no longer gives its entry (${JSON.stringify(adaBound?.namesEntryId)})`);

    // A suspended owner's role does not act (NODE_ROLE_ACTS): no entry for her either while it lasts.
    db.prepare(`UPDATE members SET status = 'suspended' WHERE public_key = ?`).run(olive.pubKeyHex);
    const oliveSuspended = await read(`/api/invite/mine/${olive.pubKeyHex}`, olive);
    assert(!oliveSuspended.text.includes(makers.get(olive.pubKeyHex)!.entry),
        `the owner while her account is suspended: no entry in her invites (${oliveSuspended.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log(`⭐️ An invite's names-list entry reaches only an owner or admin whose role acts, read auth ${READ_AUTH_ON ? 'on' : 'opted out'}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
