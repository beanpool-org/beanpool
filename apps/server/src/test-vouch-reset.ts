/**
 * Test Suite: the vouching reset (slice R0, scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §1 and §7
 * R0; db/vouch-reset.ts). Marty, 5 Nov 2026: "reset them to off and then we are free to reset all the code behind that
 * also".
 *
 * Every node is its own process on its own data dir (takeover-test-harness.ts), booting as index.ts does. The suite gives
 * a fresh node the previous release's shape, exactly as that release's own boot made it on a live node: the four columns
 * from its ALTERs (origin/main db.ts:1378-1383, :1673) and its members_touch_updated_at, whose whitelist names three of
 * them (origin/main schema.sql:1480). The rows go in with no node running.
 *
 *  1. Refusal. Two appointed vouchers (Val, Vee); Vic, vouched by Val for 100 with nothing else, owing 30 (his line was
 *     100, all of it the vouch); Mo, vouched by Vee for 25 with 100 granted (earned_credit), owing 40; Pat holding what
 *     they owe, so the ledger sums to zero; an unused vouched invite in date, an expired one, a used one and a plain one.
 *     The boot stops before it is ready, with the sentence; no table's rows moved, the four columns are still there, no
 *     reset line was logged.
 *  2. The same at 0: Vic settles (Pat's +30 back to him). The boot runs: the counts A-G as the measure script reads them
 *     beforehand, one system_logs line with them, the owners' alert, the four columns gone, the two unused vouched
 *     invites deleted with their tombstones, the used and the plain one kept; members and invite_codes have exactly a fresh
 *     install's columns. Mo keeps a line of 100 (it was 125 with the vouch; his -40 is within it): the harm count was 0.
 *     The ledger sums to zero before and after, and the audit is ok.
 *  3. A third boot finds nothing to reset: no second line.
 *  4. A standby holding the previous release's copy resets it at its own boot the same way, writing no tombstone; and the
 *     hashes: a node on version 21 compares none made by version 20 (row counts only, so neither side reads the other's
 *     copies as wrong and force-resyncs), and a version-20 main server's invite row with vouch_level lands on a reset
 *     standby with the column left out.
 *  5. The deleted routes have no handler on the node's real HTTPS server (every route and its middleware), signed or with
 *     an owner's session: no stub anywhere. The admin voucher route answers 404; POST /api/profile/vouch and /unvouch
 *     answer 405 with Allow: GET, HEAD, because their paths match the profile read (GET /api/profile/:publicKey). Beside
 *     them, routes that are still there answer, so neither can be a server that serves nothing.
 *  6. The measure script prints the seven counts, numbers only, and exits 2 on a node where F or G is above zero.
 *  7. `git grep` for every identifier §1.3 deletes finds it nowhere outside docs/ and scratch/ but the reset's own files:
 *     this suite, db/vouch-reset.ts, the phone's DROP COLUMN line and its test, the old shape a fixture keeps on purpose
 *     (__fixtures__/schema-v1.2.18.sql), and the hash version's history notes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-vouch-reset.ts
 */

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, adminCredentialCommands, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Vouch-Reset-Pw-8831!';
const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_COLUMNS = ['can_vouch', 'vouch_credit', 'elder_vouched_by'];
/**
 * The story's figures are Beans; the node's balances, grants and lines are whole hundredths (`*_c`). `hc` turns a Beans figure
 * into hundredths. The old vouch_credit column is the previous release's own figure and is only ever zeroed: it keeps its Beans.
 */
const hc = (beans: number) => Math.round(beans * 100);

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

// ── The node processes' commands ───────────────────────────────────────────────────────────

function guardFetch(): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
}

async function child(): Promise<void> {
    guardFetch();
    await runNodeChild({
        ...adminCredentialCommands,
        ...serveCommands,
        /** What the boot left, read after it (getBalance is safe once the boot is done: the treasuries are exempt by then). */
        look: async (w: { mo: string; vic: string; pat: string; codes: Record<string, string> }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const { getAlertsStatus } = await import('./services/alerts.js');
            const cols = (t: string) => (db.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).map((c) => c.name);
            const logs = db.prepare(`SELECT message, metadata FROM system_logs WHERE message LIKE 'Vouching reset%' ORDER BY id`).all() as { message: string; metadata: string | null }[];
            const codes = Object.fromEntries(Object.entries(w.codes).map(([k, code]) => [k, !!db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code)]));
            const tombstones = Object.fromEntries(Object.entries(w.codes).map(([k, code]) =>
                [k, !!db.prepare(`SELECT 1 FROM tombstones WHERE table_name = 'invite_codes' AND row_key = ?`).get(code)]));
            // The alert is told after the boot, from an import that resolves on a later tick.
            for (let i = 0; i < 50 && !getAlertsStatus().history.some((e) => e.key === 'reset.vouching'); i++) await new Promise((r) => setTimeout(r, 20));
            const alert = getAlertsStatus().history.filter((e) => e.key === 'reset.vouching').map((e) => e.detail);
            return {
                members: cols('members'), inviteCodes: cols('invite_codes'), logs, codes, tombstones, alert,
                // Whole hundredths, every figure (the trust profile's floor as getBalance's floor_c is it).
                mo: { profileFloor_c: se.getMemberTrustProfile(w.mo).floor, balanceFloor_c: se.getBalance(w.mo).floor_c, balance_c: se.getBalance(w.mo).balance_c },
                vic: { floor: se.getMemberTrustProfile(w.vic).floor, activated: se.getMemberTrustProfile(w.vic).activated },
                audit: se.runLedgerAudit(),
                sum: (db.prepare('SELECT COALESCE(SUM(balance_c), 0) AS s FROM accounts').get() as { s: number }).s,
                touchTrigger: (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_updated_at'`).get() as { sql: string } | undefined)?.sql ?? null,
            };
        },
        /** The version-20 side of a copy: its hashes, and its invite row with vouch_level, against this reset node. */
        'older-copy': async (w: { maker: string }) => {
            const { readTableHashes, tableContentHashes, TABLE_HASHES_VERSION } = await import('./engine/replica-hashes.js');
            const { importPlainTables } = await import('./engine/plain-tables.js');
            const { db } = await import('./db/db.js');
            const mine = tableContentHashes();
            const theirs20 = readTableHashes({ v: 20, tables: mine.tables });
            const code = `INV-OLDER-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const row = { code, created_by: w.maker, created_at: new Date().toISOString(), used_by: null, used_at: null, intended_for: null,
                genesis_type: 'standard', issued_by: null, names_entry_id: null, names_bind_outcome: null, vouch_level: 3, updated_at: new Date().toISOString() };
            let imported: unknown = null;
            let error: string | null = null;
            try { imported = db.transaction(() => importPlainTables({ invite_codes: [row] }, false))(); } catch (e) { error = (e as Error).message; }
            return { version: TABLE_HASHES_VERSION, mineVersion: mine.v, theirs20IsNull: theirs20 === null, imported, error,
                landed: !!db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code) };
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const j = (v: unknown) => JSON.stringify(v)?.slice(0, 500);

/** Each table's rows, as a digest: the same digest is the same rows, whatever the order SQLite returns them in. */
function tableDigests(file: string): Record<string, string> {
    const d = new Database(file, { readonly: true });
    try {
        const tables = (d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
        const out: Record<string, string> = {};
        for (const t of tables) {
            const cols = (d.prepare('SELECT name FROM pragma_table_info(?)').all(t) as { name: string }[]).map((c) => c.name).sort();
            const rows = (d.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[])
                .map((r) => JSON.stringify(cols.map((c) => [c, Buffer.isBuffer(r[c]) ? (r[c] as Buffer).toString('hex') : r[c]])))
                .sort();
            out[t] = crypto.createHash('sha256').update(JSON.stringify([cols, rows])).digest('hex').slice(0, 16);
        }
        return out;
    } finally { d.close(); }
}

/** The previous release's shape, as its boot made it: the four ALTERs and its members_touch_updated_at whitelist. */
function givePreviousShape(d: Database.Database): void {
    d.exec(`ALTER TABLE members ADD COLUMN elder_vouched_by TEXT REFERENCES members(public_key)`);
    d.exec(`ALTER TABLE members ADD COLUMN can_vouch INTEGER DEFAULT 0`);
    d.exec(`ALTER TABLE members ADD COLUMN vouch_credit REAL DEFAULT 0`);
    d.exec(`ALTER TABLE invite_codes ADD COLUMN vouch_level INTEGER`);
    const now = (d.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'members_touch_updated_at'`).get() as { sql: string }).sql;
    const before = now.replace('archetype, credit_frozen,', 'archetype, elder_vouched_by, can_vouch, vouch_credit, credit_frozen,');
    if (before === now) throw new Error('the touch trigger is not the shape this suite expects');
    d.exec('DROP TRIGGER members_touch_updated_at');
    d.exec(before);
}

interface World { val: Id; vee: Id; vic: Id; mo: Id; pat: Id; codes: Record<string, string> }

/** Two vouchers, Vic at -30 on a 100 vouch alone, Mo at -40 on 25 vouch + 100 granted, Pat holding +70; four invites. */
function writeOldRows(d: Database.Database, w: World): void {
    const member = d.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, earned_credit_c, can_vouch, vouch_credit, elder_vouched_by)
                              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 days'), NULL, NULL, 'active', ?, ?, ?, ?)`);
    const account = d.prepare(`INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)
                               ON CONFLICT(public_key) DO UPDATE SET balance_c = excluded.balance_c`);
    const epoch = Math.floor(Date.now() / DAY_MS);
    const code = d.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by, used_at, vouch_level) VALUES (?, ?, ?, ?, ?, ?)`);
    d.transaction(() => {
        member.run(w.val.pk, 'Val', 0, 1, 0, null);
        member.run(w.vee.pk, 'Vee', 0, 1, 0, null);
        member.run(w.vic.pk, 'Vic', 0, 0, 100, w.val.pk);
        member.run(w.mo.pk, 'Mo', hc(100), 0, 25, w.vee.pk);
        member.run(w.pat.pk, 'Pat', 0, 0, 0, null);
        account.run(w.vic.pk, -hc(30), epoch);
        account.run(w.mo.pk, -hc(40), epoch);
        account.run(w.pat.pk, hc(70), epoch);
        const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
        code.run(w.codes.openVouched, w.val.pk, iso(DAY_MS), null, null, 3);
        code.run(w.codes.expiredVouched, w.val.pk, iso(40 * DAY_MS), null, null, 2);
        code.run(w.codes.usedVouched, w.val.pk, iso(25 * DAY_MS), w.vic.pk, iso(20 * DAY_MS), 3);
        code.run(w.codes.plain, w.vee.pk, iso(DAY_MS), null, null, null);
    })();
}

function columnsOf(file: string, table: string): string[] {
    const d = new Database(file, { readonly: true });
    try { return (d.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((c) => c.name); } finally { d.close(); }
}

/** The measure script on `file`, as the director runs it: its output and exit code. */
function measure(file: string): { out: string; code: number } {
    try {
        const out = execFileSync(process.execPath, [...process.execArgv, path.join(path.dirname(SCRIPT), 'vouch-reset-measure.ts'), file], { encoding: 'utf-8' });
        return { out, code: 0 };
    } catch (e: any) {
        return { out: `${e?.stdout ?? ''}${e?.stderr ?? ''}`, code: e?.status ?? -1 };
    }
}

async function signed(base: string, who: Id, route: string, body: unknown): Promise<{ status: number; text: string; allow: string | null }> {
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
    return { status: res.status, text: (await res.text()).slice(0, 200), allow: res.headers.get('allow') };
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const env = { ADMIN_PASSWORD: PW, NODE_ROLE: 'primary', NODE_ENV: 'test' };
    const w: World = {
        val: newId('Val'), vee: newId('Vee'), vic: newId('Vic'), mo: newId('Mo'), pat: newId('Pat'),
        codes: { openVouched: 'INV-RESET-OPEN1', expiredVouched: 'INV-RESET-OLD01', usedVouched: 'INV-RESET-USED1', plain: 'INV-RESET-PLAIN' },
    };
    const lookArgs = { mo: w.mo.pk, vic: w.vic.pk, pat: w.pat.pk, codes: w.codes };
    const nodes: NodeProc[] = [];
    const dataDir = path.join(root, 'node');
    const file = path.join(dataDir, 'state.db');
    const freshDir = path.join(root, 'fresh');

    try {
        // ── 0. a fresh install's shape, for what the reset must end at ──
        const fresh = await spawnNode(SCRIPT, freshDir, env);
        await fresh.kill();
        const freshMembers = columnsOf(path.join(freshDir, 'state.db'), 'members');
        const freshInvites = columnsOf(path.join(freshDir, 'state.db'), 'invite_codes');
        require_(OLD_COLUMNS.every((c) => !freshMembers.includes(c)) && !freshInvites.includes('vouch_level'),
            `a fresh install has none of the four vouch columns (${j({ freshMembers: freshMembers.filter((c) => /vouch/.test(c)), freshInvites: freshInvites.filter((c) => /vouch/.test(c)) })})`);

        // ── 1. the previous release's shape and rows, refused ──
        console.log('\n— 1. a node of the previous shape with a vouched member at -30 on a 100 vouch alone refuses to boot —');
        const first = await spawnNode(SCRIPT, dataDir, env);
        await first.kill();
        {
            const d = new Database(file);
            givePreviousShape(d);
            writeOldRows(d, w);
            d.close();
        }
        require_(OLD_COLUMNS.every((c) => columnsOf(file, 'members').includes(c)) && columnsOf(file, 'invite_codes').includes('vouch_level'),
            'the data dir holds the previous release\'s shape: the four columns');
        const sumOf = () => { const d = new Database(file, { readonly: true }); try { return (d.prepare('SELECT COALESCE(SUM(balance_c), 0) AS s FROM accounts').get() as { s: number }).s; } finally { d.close(); } };
        assert(sumOf() === 0, `the ledger sums to zero before (${sumOf()})`);

        const measured = measure(file);
        assert(measured.code === 2 && /F people with a vouch below the line they keep without it: 1/.test(measured.out) && /STOP/.test(measured.out),
            `the measure script counts F = 1 and says STOP, exit 2 (${measured.code}: ${j(measured.out.split('\n').filter((l) => /^[A-G] |STOP|OK/.test(l)))})`);
        assert(/A members with the appointed-voucher switch on: 2/.test(measured.out) && /B members with a vouch: 2/.test(measured.out)
            && /C invites with a vouch, unused and in date: 1/.test(measured.out) && /D invites redeemed with a vouch: 1/.test(measured.out)
            && /E people whose stored balance is below zero: 2/.test(measured.out) && /G Decisions that could still give or take away vouching: 0/.test(measured.out),
            'and A 2, B 2, C 1 (the expired one is not in date), D 1, E 2, G 0');
        assert(![w.val, w.vee, w.vic, w.mo, w.pat].some((m) => measured.out.includes(m.pk) || measured.out.includes(m.name)),
            'the measure prints numbers only: no key and no name');

        const before = tableDigests(file);
        let refusal = '';
        try {
            const second = await spawnNode(SCRIPT, dataDir, env);
            nodes.push(second);
            assert(false, 'the boot should have refused');
        } catch (e: any) {
            refusal = String(e?.output ?? e?.message ?? e);
        }
        assert(/The vouching reset stopped before writing anything: 1 member\(s\) with a vouch owe more than the credit line they keep without it \(F\), and 0 Decision\(s\)/.test(refusal)
            && /the previous release boots this data untouched/.test(refusal),
            `the boot stops before it is ready, with the sentence (${j((/The vouching reset[^\n]*/.exec(refusal) ?? ['no sentence'])[0])})`);
        const after = tableDigests(file);
        const moved = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
        assert(moved.length === 0, `no table's rows moved in the refused boot (${moved.join(', ') || 'none'})`);
        assert(OLD_COLUMNS.every((c) => columnsOf(file, 'members').includes(c)) && columnsOf(file, 'invite_codes').includes('vouch_level'),
            'the four columns are still there');

        // ── 2. the same at 0 ──
        console.log('\n— 2. the same with Vic settled: the reset runs —');
        {
            const d = new Database(file);
            d.prepare('UPDATE accounts SET balance_c = 0 WHERE public_key = ?').run(w.vic.pk);
            d.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(hc(40), w.pat.pk);
            d.close();
        }
        assert(sumOf() === 0, `the ledger sums to zero before the reset (${sumOf()})`);
        const measured0 = measure(file);
        assert(measured0.code === 0 && /F people with a vouch below the line they keep without it: 0/.test(measured0.out) && /OK: F and G are 0/.test(measured0.out),
            `the measure script now reads F = 0 and says OK, exit 0 (Mo's -40 is within the 100 he keeps) (${measured0.code})`);
        const third = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(third);
        const look = await third.send('look', lookArgs);
        assert(OLD_COLUMNS.every((c) => !look.members.includes(c)) && !look.inviteCodes.includes('vouch_level'),
            `the four columns are gone (${j({ members: look.members.filter((c: string) => /vouch/.test(c)), invites: look.inviteCodes.filter((c: string) => /vouch/.test(c)) })})`);
        assert(JSON.stringify([...look.members].sort()) === JSON.stringify([...freshMembers].sort())
            && JSON.stringify([...look.inviteCodes].sort()) === JSON.stringify([...freshInvites].sort()),
            'members and invite_codes have exactly a fresh install\'s columns');
        assert(!!look.touchTrigger && !OLD_COLUMNS.some((c) => look.touchTrigger.includes(c)),
            'members_touch_updated_at is schema.sql\'s again, naming none of the three');
        assert(look.logs.length === 1 && /A appointed vouchers 2 · B vouched members 2 · C vouched invites unused 1 · D vouched invites redeemed 1 · E below zero 1 · F would lose credit 0 · G open voucher Decisions 0/.test(look.logs[0]?.message)
            && /4 member row\(s\) turned off, 2 unused invite\(s\) that promised a vouch deleted/.test(look.logs[0]?.message),
            `one system_logs line with the counts and the rows changed (${j(look.logs.map((l: { message: string }) => l.message))})`);
        assert(look.alert.length === 1 && look.alert[0] === look.logs[0]?.message, `the owners' alert says the same, once (${j(look.alert)})`);
        assert(![w.val, w.vee, w.vic, w.mo, w.pat].some((m) => JSON.stringify(look.logs).includes(m.pk) || JSON.stringify(look.logs).includes(m.name)),
            'the line names nobody');
        assert(look.codes.openVouched === false && look.codes.expiredVouched === false && look.codes.usedVouched === true && look.codes.plain === true,
            `the two unused vouched invites are deleted; the used one and the plain one stay (${j(look.codes)})`);
        assert(look.tombstones.openVouched === true && look.tombstones.expiredVouched === true && look.tombstones.plain === false,
            `each deleted invite has its tombstone, for a standby (${j(look.tombstones)})`);
        assert(look.mo.profileFloor_c === -hc(100) && look.mo.balanceFloor_c === -hc(100) && look.mo.balance_c === -hc(40),
            `Mo, at -40 with 100 granted and a 25 vouch, keeps a line of 100 (${j(look.mo)})`);
        assert(look.vic.floor === 0 && look.vic.activated === false, `Vic, whose line was the vouch alone, has none now, owing nothing (${j(look.vic)})`);
        assert(look.sum === 0 && look.audit.ok === true && look.audit.drift === 0, `the ledger sums to zero after, and the audit is ok (${j({ sum: look.sum, audit: look.audit })})`);

        // ── 5. the deleted routes 404, through the real middleware ──
        console.log('\n— 5. the deleted routes answer 404, signed or with an owner\'s session —');
        const https = `https://localhost:${await third.send('serve')}`;
        const vouch = await signed(https, w.val, '/api/profile/vouch', { targetPubkey: w.pat.pk, level: 3 });
        const unvouch = await signed(https, w.vee, '/api/profile/unvouch', { targetPubkey: w.mo.pk });
        // Their paths match the profile read, GET /api/profile/:publicKey, so the router's allowedMethods answers a POST 405
        // with Allow: GET and HEAD. No handler answers a POST there: no stub.
        const noPost = (a: { status: number; allow: string | null }) => a.status === 405 && !!a.allow && !/POST/i.test(a.allow);
        assert(noPost(vouch) && noPost(unvouch),
            `POST /api/profile/vouch and /unvouch have no handler, signed by a member: 405, Allow ${vouch.allow} / ${unvouch.allow} (${vouch.status} ${vouch.text} / ${unvouch.status} ${unvouch.text})`);
        const profile = await signed(https, w.val, '/api/profile/update', { publicKey: w.val.pk, bio: 'still here' });
        assert(profile.status === 200, `while POST /api/profile/update, beside them, answers the same member (${profile.status} ${profile.text})`);
        const session = await third.send('owner-session', {});
        const voucherRoute = `/api/local/admin/users/${w.pat.pk}/voucher`;
        const adminPost = async (route: string, body: unknown) => {
            const r = await fetch(`${https}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...session }, body: JSON.stringify(body) });
            return { status: r.status, text: (await r.text()).slice(0, 200) };
        };
        const voucher = await adminPost(voucherRoute, { grant: true });
        assert(voucher.status === 404, `POST /api/local/admin/users/:pubkey/voucher answers 404 with an owner's session (${voucher.status} ${voucher.text})`);
        const tier = await adminPost(`/api/local/admin/users/${w.pat.pk}/tier`, { tier: 'Resident' });
        assert(tier.status === 200, `while its neighbour, the tier route, answers the same session (${tier.status} ${tier.text})`);
        const invite = await signed(https, w.val, '/api/invite/generate', { publicKey: w.val.pk, vouchLevel: 3 });
        assert(invite.status === 200 || invite.status === 201, `and a member's invite asked with a vouchLevel is an ordinary invite: the field is read nowhere (${invite.status} ${invite.text})`);

        // ── 4. hashes and an older copy ──
        const older = await third.send('older-copy', { maker: w.val.pk });
        // 21 is the reset's; a later slice raises it again (22: vouchers, engine/replica-hashes.ts) and test-replica-hashes pins
        // the current one. What the reset needs of it holds at 21 and after: a node past 20 compares no hash made by 20.
        assert(older.version >= 21 && older.mineVersion === older.version && older.theirs20IsNull === true,
            `the hashes are version 21 or later, and a node on it compares none made by 20: row counts only (${j(older)})`);
        assert(older.error === null && older.landed === true, `a version-20 main server's invite row with vouch_level lands here, the column left out (${j(older)})`);
        await third.kill();
        nodes.pop();

        // ── 3. nothing left to reset ──
        console.log('\n— 3. a third boot finds nothing to reset —');
        const fourth = await spawnNode(SCRIPT, dataDir, env);
        nodes.push(fourth);
        const again = await fourth.send('look', lookArgs);
        assert(again.logs.length === 1, `still one reset line: this boot reset nothing (${again.logs.length})`);
        await fourth.kill();
        nodes.pop();
        const measuredAfter = measure(file);
        assert(measuredAfter.code === 0 && /already reset/.test(measuredAfter.out), `the measure script on a reset node says it is already reset, exit 0 (${measuredAfter.code})`);

        // ── 4b. a standby holding the previous release's copy ──
        console.log('\n— 4. a standby holding the previous release\'s copy resets it at its own boot —');
        const standbyDir = path.join(root, 'standby');
        const sb = await spawnNode(SCRIPT, standbyDir, { ...env, NODE_ROLE: 'backup' });
        await sb.kill();
        {
            const d = new Database(path.join(standbyDir, 'state.db'));
            givePreviousShape(d);
            writeOldRows(d, w);
            d.prepare('UPDATE accounts SET balance_c = 0 WHERE public_key = ?').run(w.vic.pk);
            d.prepare('UPDATE accounts SET balance_c = ? WHERE public_key = ?').run(hc(40), w.pat.pk);
            d.close();
        }
        const sb2 = await spawnNode(SCRIPT, standbyDir, { ...env, NODE_ROLE: 'backup' });
        nodes.push(sb2);
        const sbLook = await sb2.send('look', lookArgs);
        assert(OLD_COLUMNS.every((c) => !sbLook.members.includes(c)) && !sbLook.inviteCodes.includes('vouch_level')
            && sbLook.codes.openVouched === false && sbLook.codes.usedVouched === true,
            `the standby's copy is reset as its main server's is: the columns gone, the unused vouched invites deleted (${j(sbLook.codes)})`);
        assert(sbLook.tombstones.openVouched === false && sbLook.tombstones.expiredVouched === false,
            `and it writes no tombstone of its own: its copy is its main server's (${j(sbLook.tombstones)})`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => { });
    }

    // ── 7. nothing of the old vouch model is left ──
    console.log('\n— 7. git grep finds the §1.3 identifiers only in the reset\'s own files —');
    const ids = ['can_vouch', 'canVouch', 'vouch_credit', 'vouchCredit', 'elder_vouched_by', 'elderVouchedBy', 'vouch_level', 'vouchLevel',
        'VOUCH_CREDIT', 'VouchLevel', 'VOUCH_LEVELS', 'isVouchLevel', 'vouchCreditForLevel', 'vouchMember', 'unvouchMember', 'writeVouch',
        'vouchOnJoin', 'readInviteVouch', 'adminSetVoucher', 'grant_voucher', 'revoke_voucher', 'askCanVouch', 'vouchMemberApi',
        'unvouchMemberApi', 'updateNodeUserVoucher', 'InviteVouchChoice', 'invite-vouch\\.ts', 'inviteVouch', 'INVITE_VOUCH'];
    const repo = path.resolve(path.dirname(SCRIPT), '..', '..', '..');
    let hits: string[] = [];
    try {
        hits = execFileSync('git', ['grep', '-n', '-E', ids.join('|'), '--', ':!docs/', ':!scratch/'], { cwd: repo, encoding: 'utf-8' })
            .split('\n').filter(Boolean);
    } catch (e: any) {
        if (e?.status !== 1) throw e; // 1: nothing found
    }
    const allowed: Record<string, (line: string) => boolean> = {
        'apps/server/src/test-vouch-reset.ts': () => true,
        'apps/server/src/db/vouch-reset.ts': () => true,
        'apps/server/src/__fixtures__/schema-v1.2.18.sql': () => true,
        'apps/native/utils/__tests__/members-old-column-drop.test.ts': () => true,
        'apps/native/utils/db.ts': (l) => /ALTER TABLE members DROP COLUMN elder_vouched_by/.test(l),
        'apps/server/src/engine/replica-hashes.ts': (l) => /^\s*\*/.test(l),
    };
    const stray = hits.filter((h) => {
        const [file, , ...rest] = h.split(':');
        const check = allowed[file];
        return !check || !check(rest.join(':'));
    });
    assert(hits.length > 0 && stray.length === 0,
        `outside docs/ and scratch/, only the reset's own files name them (${hits.length} lines; stray: ${stray.slice(0, 8).join(' | ') || 'none'})`);

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ The vouching reset counts first, refuses before writing, and leaves a fresh install\'s shape.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        process.exit(1);
    });
}
