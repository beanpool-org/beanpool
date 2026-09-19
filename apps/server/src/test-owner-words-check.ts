/**
 * "Check your 12 words" — the owner's signed record (sealed-keys.md §7, slice 7), over REAL HTTPS through the
 * signature middleware.
 *
 *  1. POST /api/node/owner/words-check: the actor is the signing key and nothing else. An owner's signed statement is
 *     stored with the signed timestamp as the date; unsigned → 401; a member or an admin who is not an owner → 403;
 *     a body naming someone else is refused; a body carrying anything but the one statement is refused (so nothing
 *     derived from the words can be stored); the stored signature re-verifies against the owner's key.
 *  2. GET /api/node/owner/words-check: the owner's own last check, null before; a member → 403.
 *  3. POST /api/local/admin/takeover/words-checks: every current owner with "checked <date>" or null ("not yet");
 *     owners and admins by key session, the admin password too; unauthenticated → 401; a removed owner drops off.
 *  4. A never-checked owner can still do everything: their owner routes answer 200.
 *  5. Nothing gates on the record: no server source outside this feature reads the table.
 *  6. The silent open check (slice 6): an owner's app reads the current lock's header (signed), opens its own stanza
 *     with its key — here the web app's PKCS8 form — and reports it; the list shows "opened the current lock" with
 *     the date. A report on an older lock shows as not current; a device that could NOT open it says so. Owners only,
 *     signed, one statement; nothing gates on it either.
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-owner-words-check.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { updateLocalConfig } from './config/local-config.js';

const PORT = 8691;
const BASE = `https://localhost:${PORT}`;
const WC = '/api/node/owner/words-check';
const LIST = '/api/local/admin/takeover/words-checks';
const STATEMENT = { attestation: 'owner-12-words-checked' };

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Identity { pub: string; priv: crypto.KeyObject; pubObj: crypto.KeyObject }
function keypair(): Identity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, pubObj: publicKey };
}
const signText = (who: Identity, text: string) => crypto.sign(null, Buffer.from(text), who.priv).toString('base64');

function seedMember(pk: string, callsign: string) {
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pk, callsign);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

/** A member-signed request, exactly as the apps send it: METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY. */
async function signed(method: 'GET' | 'POST', p: string, signer?: Identity, body?: unknown, ts = Date.now()) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (signer) {
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pub;
        headers['X-Signature'] = signText(signer, `${method}\n${p}\n${ts}\n${nonce}\n${raw}`);
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : raw });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}

async function admin(method: 'GET' | 'POST', p: string, headers: Record<string, string>, body: unknown = {}) {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
}

/** A key session for this member, the way the app hands off to /settings. */
async function keySession(who: Identity): Promise<string> {
    const chal = await admin('POST', '/api/local/admin/auth/challenge', {});
    const v = await admin('POST', '/api/local/admin/auth/verify-challenge', {}, {
        challengeId: chal.body.challengeId, memberPubkey: who.pub, signature: signText(who, chal.body.challenge),
    });
    const res = await fetch(`${BASE}/api/local/admin/auth/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: v.body.handshakeToken }),
    });
    const m = (res.headers.get('set-cookie') || '').match(/admin_session=([0-9a-f]+)/);
    if (!m) throw new Error(`no key session for ${who.pub.slice(0, 8)} (${res.status})`);
    return m[1];
}

async function main() {
    console.log('Running owner "check your 12 words" tests (real HTTPS)...\n');
    await initTls();
    // A node key and a genesis, so this server seals a real take-over lock to its owners (section 6).
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')), { mode: 0o600 });
    if (!fs.existsSync(path.join(dataDir, 'genesis.json'))) {
        fs.writeFileSync(path.join(dataDir, 'genesis.json'), JSON.stringify({ communityId: 'wordscheck000001', publicKey: '00', genesisHash: '00', createdAt: new Date().toISOString() }));
    }
    initStateEngine();

    const anna = keypair();   // owner who checks
    const ben = keypair();    // owner who never checks
    const mo = keypair();     // admin, not an owner
    const mem = keypair();    // plain member
    const outsider = keypair();
    seedMember(anna.pub, 'wcAnna');
    seedMember(ben.pub, 'wcBen');
    seedMember(mo.pub, 'wcMo');
    seedMember(mem.pub, 'wcMem');
    grantNodeRole(anna.pub, 'owner', 'SYSTEM');
    grantNodeRole(ben.pub, 'owner', anna.pub);
    grantNodeRole(mo.pub, 'admin', anna.pub);
    const adminPass = 'WordsCheck-Secret-123!';
    const salt = crypto.randomBytes(16).toString('hex');
    updateLocalConfig({
        adminHash: crypto.scryptSync(adminPass, salt, 64).toString('hex'), salt,
        totpEnabled: false, totpSecret: null, totpBackupCodesHashes: [], breakGlassMode: false, communityName: 'Words Test',
    } as any);

    await startHttpsServer(PORT);

    // ── 1. Recording a check ──
    console.log('\n1. POST words-check');
    {
        const anon = await signed('POST', WC, undefined, STATEMENT);
        assert(anon.status === 401, `unsigned → 401 (got ${anon.status})`);
        const m = await signed('POST', WC, mem, STATEMENT);
        assert(m.status === 403, `a plain member → 403 (got ${m.status})`);
        const a = await signed('POST', WC, mo, STATEMENT);
        assert(a.status === 403, `an admin who is not an owner → 403 (got ${a.status})`);
        const o = await signed('POST', WC, outsider, STATEMENT);
        assert(o.status === 403, `a key that is not a member → 403 (got ${o.status})`);
        assert((db.prepare('SELECT COUNT(*) AS n FROM owner_words_checks').get() as any).n === 0, 'none of those stored anything');

        // The actor is the signer: a member naming an owner in the body is refused by the middleware,
        // and an owner naming someone else cannot record for them.
        const spoof = await signed('POST', WC, mem, { ...STATEMENT, memberPubkey: anna.pub });
        assert(spoof.status >= 400 && spoof.status < 500, `a member naming an owner in the body is refused (got ${spoof.status})`);
        const forBen = await signed('POST', WC, anna, { ...STATEMENT, publicKey: ben.pub });
        assert(forBen.status >= 400 && forBen.status < 500, `an owner naming another owner in the body is refused (got ${forBen.status})`);
        assert((db.prepare('SELECT COUNT(*) AS n FROM owner_words_checks').get() as any).n === 0, 'still nothing stored');

        // Only the one statement: nothing derived from the words can ride along.
        for (const bad of [{}, { attestation: 'yes' }, { ...STATEMENT, seedChecksum: 'abcd' }, { ...STATEMENT, words: 'x' }]) {
            const r = await signed('POST', WC, anna, bad);
            assert(r.status === 400, `body ${JSON.stringify(bad)} → 400 (got ${r.status})`);
        }
        assert((db.prepare('SELECT COUNT(*) AS n FROM owner_words_checks').get() as any).n === 0, 'no bad body was stored');

        const ts = Date.now() - 5_000;
        const ok = await signed('POST', WC, anna, STATEMENT, ts);
        assert(ok.status === 200 && ok.body.wordsCheckedAt === ts, `an owner's statement → 200, dated by the signed timestamp (got ${ok.status} ${ok.body?.wordsCheckedAt})`);
        const row = db.prepare('SELECT * FROM owner_words_checks WHERE member_pubkey = ?').get(anna.pub) as any;
        assert(!!row && Number(row.checked_at) === ts, 'stored against the signer, with that date');
        const reverifies = crypto.verify(null, Buffer.from(row.signed_payload), anna.pubObj, Buffer.from(row.signature, 'base64'));
        assert(reverifies, 'the stored record re-verifies against the owner\'s key');
        assert(row.signed_payload.endsWith(JSON.stringify(STATEMENT)) && row.signed_payload.startsWith(`POST\n${WC}\n${ts}\n`), 'the record is the fact and the date, nothing else');
        const cols = (db.prepare('PRAGMA table_info(owner_words_checks)').all() as any[]).map((c) => c.name).sort();
        assert(JSON.stringify(cols) === JSON.stringify(['checked_at', 'member_pubkey', 'signature', 'signed_payload']), `the table holds only those columns (${cols.join(', ')})`);

        const stale = await signed('POST', WC, anna, STATEMENT, Date.now() - 24 * 3600_000);
        assert(stale.status === 401, `a stale signed date is refused by the middleware (got ${stale.status})`);
        const later = Date.now();
        const again = await signed('POST', WC, anna, STATEMENT, later);
        assert(again.status === 200, 'checking again → 200');
        assert((db.prepare('SELECT COUNT(*) AS n FROM owner_words_checks').get() as any).n === 1, 'one row per owner, the latest');
        assert(Number((db.prepare('SELECT checked_at FROM owner_words_checks WHERE member_pubkey = ?').get(anna.pub) as any).checked_at) === later, 'and it is the newer date');
    }

    // ── 2. The owner's own last check ──
    console.log('\n2. GET words-check');
    {
        const a = await signed('GET', WC, anna);
        assert(a.status === 200 && a.body.owner === true && typeof a.body.wordsCheckedAt === 'number', 'the owner sees their last check');
        const b = await signed('GET', WC, ben);
        assert(b.status === 200 && b.body.owner === true && b.body.wordsCheckedAt === null, 'a never-checked owner sees null');
        const m = await signed('GET', WC, mem);
        assert(m.status === 403 && m.body.owner === false, `a member → 403, owner:false (got ${m.status})`);
        const anon = await signed('GET', WC);
        assert(anon.status === 401, `unsigned → 401 (got ${anon.status})`);
    }

    // ── 3. The Settings list ──
    console.log('\n3. Settings: who has checked');
    const benSession = await keySession(ben);
    const moSession = await keySession(mo);
    {
        const pw = await admin('POST', LIST, { 'x-admin-password': adminPass });
        assert(pw.status === 200, `the admin password reads the list (got ${pw.status})`);
        const owners = pw.body.owners as any[];
        assert(owners.length === 2 && owners.map((o) => o.callsign).join(',') === 'wcAnna,wcBen', `the list is the owners, oldest first (${owners.map((o) => o.callsign)})`);
        assert(typeof owners[0].wordsCheckedAt === 'number' && owners[1].wordsCheckedAt === null, 'Anna checked, Ben not yet');
        assert(!JSON.stringify(pw.body).includes('signature') && !JSON.stringify(pw.body).includes('signed_payload'), 'the list carries the date only');
        const byOwner = await admin('POST', LIST, { 'x-admin-session': benSession });
        assert(byOwner.status === 200 && byOwner.body.owners.length === 2, `an owner's key session reads it (got ${byOwner.status})`);
        const byAdmin = await admin('POST', LIST, { 'x-admin-session': moSession });
        assert(byAdmin.status === 200 && byAdmin.body.owners.length === 2, `an admin's key session reads it (got ${byAdmin.status})`);
        const none = await admin('POST', LIST, {});
        assert(none.status === 401, `unauthenticated → 401 (got ${none.status})`);
    }

    // ── 4. A never-checked owner can still do everything ──
    console.log('\n4. never-checked owner is not blocked');
    {
        const me = await signed('GET', '/api/node-admin/me', ben);
        assert(me.status === 200 && me.body.role === 'owner', `node-admin/me → 200 owner (got ${me.status})`);
        const q = await signed('GET', '/api/node-admin/queue', ben);
        assert(q.status === 200, `node-admin/queue → 200 (got ${q.status})`);
        const h = { 'x-admin-session': benSession };
        const roles = await admin('GET', '/api/local/admin/node-roles', h);
        assert(roles.status === 200, `list node roles → 200 (got ${roles.status})`);
        const grant = await admin('POST', '/api/local/admin/node-roles', h, { pubkey: mem.pub, role: 'admin' });
        assert(grant.status === 200, `grant a role → 200 (got ${grant.status})`);
        const status = await admin('POST', '/api/local/admin/takeover/status', h);
        assert(status.status === 200, `take-over lock status → 200 (got ${status.status})`);
        const cfg = await admin('GET', '/api/local/admin/reports', h);
        assert(cfg.status === 200, `moderation reports → 200 (got ${cfg.status})`);
    }

    // ── 6. The silent open check (slice 6) ──
    console.log('\n6. the silent open check');
    {
        const core = await import('@beanpool/core');
        const OPEN = core.OWNER_LOCK_OPEN_CHECK_PATH;
        const before = await admin('POST', LIST, { 'x-admin-password': adminPass });
        const current = before.body.lock?.envelopeId as string | null;
        assert(typeof current === 'string' && /^[0-9a-f]{32}$/.test(current), `this server holds a take-over lock (${current})`);
        assert(before.body.owners.every((o: any) => o.lockOpen === null), 'before any report, no owner has one');

        // Anna's app, as it does it: the header from her own server, her stanza opened with her key, the key dropped.
        const got = await signed('GET', core.TAKEOVER_HEADER_PATH, anna);
        assert(got.status === 200 && got.body.youAreARecipient === true, 'the owner reads the current header, and is in it');
        const annaPkcs8 = anna.priv.export({ type: 'pkcs8', format: 'der' }) as Buffer;
        const opened = core.canOpenAsOwner(core.validateSealedHeader(got.body.header), annaPkcs8.toString('hex'));
        assert(opened === true, "her key in the web app's PKCS8 form opens her stanza");
        const ts = Date.now();
        const ok = await signed('POST', OPEN, anna, { envelopeId: got.body.envelopeId, opened }, ts);
        assert(ok.status === 200 && ok.body.checkedAt === ts, `the report is stored with the signed date (got ${ok.status})`);
        const cannot = await signed('POST', OPEN, ben, { envelopeId: 'cd'.repeat(16), opened: false });
        assert(cannot.status === 200, 'a device that could not open an (older) lock can say so too');

        const anon = await signed('POST', OPEN, undefined, { envelopeId: current, opened: true });
        assert(anon.status === 401, `unsigned → 401 (got ${anon.status})`);
        const m = await signed('POST', OPEN, mem, { envelopeId: current, opened: true });
        assert(m.status === 403, `a member → 403 (got ${m.status})`);
        const nonOwnerAdmin = await signed('POST', OPEN, mo, { envelopeId: current, opened: true });
        assert(nonOwnerAdmin.status === 403, `an admin who is not an owner → 403 (got ${nonOwnerAdmin.status})`);
        for (const bad of [{}, { envelopeId: current }, { envelopeId: 'xyz', opened: true }, { envelopeId: current, opened: 'yes' }, { envelopeId: current, opened: true, dataKey: 'ab' }]) {
            const r = await signed('POST', OPEN, anna, bad);
            assert(r.status === 400, `body ${JSON.stringify(bad)} → 400 (got ${r.status})`);
        }

        const list = await admin('POST', LIST, { 'x-admin-password': adminPass });
        const byName = Object.fromEntries((list.body.owners as any[]).map((o) => [o.callsign, o]));
        assert(byName.wcAnna.lockOpen?.opened === true && byName.wcAnna.lockOpen.current === true && byName.wcAnna.lockOpen.checkedAt === ts,
            `Who can unlock: @wcAnna's device opened the current lock (${JSON.stringify(byName.wcAnna.lockOpen)})`);
        assert(byName.wcBen.lockOpen?.opened === false && byName.wcBen.lockOpen.current === false,
            `@wcBen's last report is about another lock, and says it did not open (${JSON.stringify(byName.wcBen.lockOpen)})`);
        assert(!JSON.stringify(list.body).includes('signature') && !JSON.stringify(list.body).includes('signed_payload'), 'the list carries the date only');
        const row = db.prepare('SELECT signature, signed_payload FROM owner_lock_opens WHERE member_pubkey = ?').get(anna.pub) as any;
        assert(crypto.verify(null, Buffer.from(row.signed_payload), anna.pubObj, Buffer.from(row.signature, 'base64')),
            "the stored report re-verifies against the owner's key");
    }

    // ── 3b. A removed owner drops off the list ──
    revokeNodeRole(anna.pub, 'owner', ben.pub);
    {
        const pw = await admin('POST', LIST, { 'x-admin-password': adminPass });
        assert(pw.body.owners.length === 1 && pw.body.owners[0].callsign === 'wcBen', 'a removed owner is no longer listed');
        const a = await signed('POST', WC, anna, STATEMENT);
        assert(a.status === 403, `and can no longer record a check (got ${a.status})`);
    }

    // ── 5. Nothing gates on it ──
    console.log('\n5. nothing reads the record to allow or refuse');
    {
        const srcDir = path.dirname(fileURLToPath(import.meta.url));
        const allowed = new Set(['engine/owner-words-checks.ts', 'routes/owner-words-check.ts', 'test-owner-words-check.ts']);
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                if (!e.name.endsWith('.ts')) continue;
                const rel = path.relative(srcDir, full);
                if (allowed.has(rel)) continue;
                const text = fs.readFileSync(full, 'utf8');
                if (/owner_words_checks|owner-words-checks|getOwnerWordsCheckedAt|listOwnerWordsStatus/.test(text)) hits.push(rel);
            }
        };
        walk(srcDir);
        assert(hits.length === 0, `no other server source reads it (found: ${hits.join(', ') || 'none'})`);

        // The open-check records, likewise: written by their route, read only by the list.
        const openAllowed = new Set(['engine/owner-lock-opens.ts', 'engine/owner-words-checks.ts', 'routes/owner-unlock.ts', 'test-owner-words-check.ts']);
        const openHits: string[] = [];
        const walkOpen = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walkOpen(full); continue; }
                if (!e.name.endsWith('.ts')) continue;
                const rel = path.relative(srcDir, full);
                if (openAllowed.has(rel)) continue;
                if (/owner_lock_opens|owner-lock-opens|recordOwnerLockOpen/.test(fs.readFileSync(full, 'utf8'))) openHits.push(rel);
            }
        };
        walkOpen(srcDir);
        assert(openHits.length === 0, `no other server source reads the open-check records (found: ${openHits.join(', ') || 'none'})`);
    }

    console.log(`\n${passed}/${run} owner words-check tests passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
});
