/**
 * One pause (removal by vote, slice S1: scratch/fable-design/DESIGN-removal-by-vote-fable.md §3, §9). An admin's
 * emergency suspension and a report actioned with a suspension are the same pause (decisions-engine.ts pauseMember):
 * the account is 'disabled', its node role is held aside, the record everyone sees opens (a 7-day "Keep …'s
 * suspension?" vote, or with formal Decisions off one nobody votes on that lifts itself), its listings leave the board
 * and it brings nobody in, until the pause ends. Nothing in it moves Beans. What the vote is stays as it was (S2 changes
 * it).
 *
 * Boots the real server; every request goes over HTTPS through the real signature middleware, an admin's through a real
 * key session.
 *
 *  0. The upgrade: a node from before this version (the board's off-board index and standing trigger in their old shape,
 *     no marker) holds Ella, whom an admin suspended before it, with an offer still on the board. Booted on this version:
 *     the index and the trigger are replaced, Ella's board standing is stamped once (Fern's, active, is not; no
 *     updated_at moves; the marker is written), the board leaves her offer out, and a phone's delta from before the
 *     upgrade carries it as paused.
 *  1. An admin pauses Pia (POST /api/local/admin/users/:pubkey/suspend): 'disabled', the record with the reason, her
 *     moderator role held aside, no Bean moved. Her listings leave the board and a delta carries them as paused, but as
 *     they are to Bea, who has a deal open on one, and to Pia herself. She can't invite: no new code, a ticket she signs
 *     admits nobody, and a code she made before is refused (the check says so, the redeem in words that don't say she
 *     left), unused. She still can't answer a knock (403 not_active). She answers in the conversation she is in, and gets
 *     it again when her app asks, but starts no new one (403 `paused`), as §3.1 has it: an admin's suspension refused her
 *     every line before, a report's let her open any. She CAN close the deals she has open: Bea completes hers and Pia
 *     is paid, Pia completes one she bought, and cancels another; and she can take her own listing down.
 *  2. A report actioned with suspendUser (POST /api/local/admin/reports/:id/action) is the same pause: Al, an admin,
 *     reported and paused by an owner, is 'disabled', not 'suspended'; the report opens the record (a default reason that
 *     names no reporter, or the admin's own); his admin role is held aside, not dropped; the report says it paused him;
 *     his listings leave the board; he can't invite. A reason too short is refused before anything is written. A second
 *     report on a member already paused opens no second record. An enterprise's account can't be paused this way.
 *  3. The lift: an admin lifts Pia's pause (her role back, the record halted, her listings back on the board and in the
 *     delta as they are, invites again, and the code she made before now admits someone); Al's lifts itself at the tick
 *     when nobody keeps it (his admin role back, his listings back).
 *  4. With formal Decisions off (the operator's switch), a report's pause opens the record nobody votes on, and the tick
 *     lifts it when its 7 days end.
 *
 * The re-key's interplay with a report's pause is test-rekey-cancel's (sections H to J); a standby's copy of a pause is
 * test-standby-board-standing's; what a paused member reads is test-suspended-and-visitor-reads'.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-pause.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setMemberPhoto } from '@beanpool/engine';
import { lockedDm } from './dm-test-payload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; text: string; body: any };

async function answerOf(res: Response): Promise<Answer> {
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body };
}

async function get(p: string, id?: Id): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} }));
}

async function post(p: string, payload: unknown, id?: Id): Promise<Answer> {
    const body = JSON.stringify(payload);
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(id ? signedHeaders('POST', p, body, id) : {}) },
        body,
    }));
}

/** An admin route, under a key session's headers (admin-auth-test-harness.ts). */
async function asAdmin(session: Record<string, string>, p: string, payload: unknown): Promise<Answer> {
    return answerOf(await fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...session },
        body: JSON.stringify(payload),
    }));
}

/** An offline ticket, as the app signs one: the payload and its signature, base64 JSON. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pubKeyHex, t: Date.now() });
    const s = crypto.sign(null, Buffer.from(payload), inviter.privateKey).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
/** The phone's feed query (apps/native utils/events.ts EVENT_TYPES_QUERY). */
const TYPES = 'types=offer,need,poll,event';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The node_config marker of the one-time fill of a paused member's board standing (db.ts). */
const PAUSED_STANDING_MARKER = 'migration_board_standing_paused_v1';
/** The two schema objects as a node from before this version holds them (schema.sql before S1). */
const OLD_OFF_BOARD_INDEX = `CREATE INDEX IF NOT EXISTS idx_members_off_board ON members(public_key)
    WHERE NOT ((paused IS NULL OR paused = 0) AND (status IS NULL OR status NOT IN ('winding_up', 'completed')));`;
const OLD_STANDING_TRIGGER = `CREATE TRIGGER IF NOT EXISTS members_touch_board_standing
AFTER UPDATE OF paused, status ON members
FOR EACH ROW
WHEN NEW.board_standing_changed_at IS OLD.board_standing_changed_at
    AND ((OLD.paused IS NULL OR OLD.paused = 0) IS NOT (NEW.paused IS NULL OR NEW.paused = 0)
        OR (CASE WHEN OLD.status IN ('winding_up', 'completed') THEN OLD.status END)
            IS NOT (CASE WHEN NEW.status IN ('winding_up', 'completed') THEN NEW.status END))
BEGIN
    UPDATE members SET board_standing_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;`;

async function main() {
    console.log('One pause: an emergency suspension and a report\'s are the same pause...\n');
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    // ── 0. The fixture: a node from before this version ──────────────────────────────────────────────────────────
    // Booted on this version in its own process (the database module is one per process), then put back as an older
    // node holds it.
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    const booted = execFileSync(process.execPath, [...process.execArgv, script], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, BEANPOOL_DATA_DIR: dir }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!booted.includes('BOOT_OK')) throw new Error(`the fixture's first boot failed: ${booted}`);

    const ella = keypair('EllaPausedBefore'), fern = keypair('FernOnBoard'), rhea = keypair('RheaReader');
    const fixtureOffers: Record<string, string> = {};
    const seeded = { ella: ago(90 * MIN), fern: ago(90 * MIN), rhea: ago(180 * MIN) };
    const cursor = ago(60 * MIN);
    {
        const d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF');
        d.exec('DROP TRIGGER IF EXISTS members_touch_board_standing; DROP INDEX IF EXISTS idx_members_off_board;');
        d.exec(OLD_OFF_BOARD_INDEX);
        d.exec(OLD_STANDING_TRIGGER);
        d.prepare('DELETE FROM node_config WHERE key = ?').run(PAUSED_STANDING_MARKER);
        const insert = d.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, updated_at)
                                  VALUES (?, ?, ?, ?, 'seed', ?, ?)`);
        const restamp = d.prepare('UPDATE members SET updated_at = ? WHERE public_key = ?');
        const joined = ago(365 * DAY);
        for (const [id, status, stamp] of [[ella, 'disabled', seeded.ella], [fern, 'active', seeded.fern], [rhea, 'active', seeded.rhea]] as const) {
            insert.run(id.pubKeyHex, id.callsign, status, joined, `INV-${id.callsign.toUpperCase()}`, stamp);
            setMemberPhoto(d, id.pubKeyHex, AVATAR);
            restamp.run(stamp, id.pubKeyHex);
        }
        // With search keywords, as every listing posted has them: the boot's keyword backfill writes (and so stamps) a row
        // that has none (state-engine.ts backfillSearchKeywords).
        const offer = d.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, search_keywords)
                                 VALUES (?, 'offer', 'food', ?, '', 5, ?, 'active', 1, ?, ?, lower(?))`);
        for (const [who, id, title] of [['ella', ella, 'Plums'], ['fern', fern, 'Figs']] as const) {
            fixtureOffers[who] = crypto.randomUUID();
            offer.run(fixtureOffers[who], title, id.pubKeyHex, ago(240 * MIN), ago(240 * MIN), title);
        }
        d.close();
    }

    // ── The upgrade: this version boots on it, and serves ──
    const upgradedAt = new Date().toISOString();
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const de = await import('./decisions-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { ownerSessionHeaders } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const row = (pk: string): any => db.prepare('SELECT * FROM members WHERE public_key = ?').get(pk);
    const statusOf = (id: Id) => row(id.pubKeyHex)?.status as string | undefined;
    const roleOf = (id: Id) => (db.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(id.pubKeyHex) as { role: string } | undefined)?.role ?? null;
    const heldAside = (decisionId: string) => db.prepare('SELECT member_pubkey, role FROM suspended_node_roles WHERE decision_id = ?').get(decisionId) as { member_pubkey: string; role: string } | undefined;
    const records = (id: Id) => db.prepare("SELECT * FROM decisions WHERE subject = ? AND effect = 'keep_suspension' ORDER BY created_at").all(id.pubKeyHex) as any[];
    const paramsOf = (r: any) => { try { return JSON.parse(r?.params ?? '{}'); } catch { return {}; } };
    const objectSql = (type: string, name: string) => (db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) as { sql: string } | undefined)?.sql ?? '';
    const list = (a: Answer): any[] => (Array.isArray(a.body) ? a.body : (a.body?.posts ?? []));
    /** The board as `reader` reads it (the list read every app's Market shows), as ids. */
    const board = async (reader: Id) => new Set(list(await get(`/api/marketplace/posts?limit=500&${TYPES}`, reader)).map((p: any) => p.id as string));
    /** A phone's delta from `since`, as `reader` syncs it: each listing's status, by id. */
    const delta = async (reader: Id, since: string) => {
        const rows = list(await get(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(since)}`, reader));
        return new Map(rows.map((p: any) => [p.id as string, p.status as string]));
    };

    console.log('── 0. the upgrade ──');
    assert(/'disabled'/.test(objectSql('trigger', 'members_touch_board_standing')),
        'the upgrade replaces the standing trigger: a pause or its end moves a member\'s board standing');
    assert(/'disabled'/.test(objectSql('index', 'idx_members_off_board')),
        'and the off-board index, in the board\'s own expression, so the area set still reads paused authors from it');
    const standing = (id: Id) => row(id.pubKeyHex)?.board_standing_changed_at as string | null | undefined;
    assert((standing(ella) ?? '') >= upgradedAt, `Ella, paused before the upgrade, has its time as her board standing (${standing(ella)})`);
    assert(standing(fern) == null && standing(rhea) == null, `Fern and Rhea, active, have none (${standing(fern)}, ${standing(rhea)})`);
    assert(row(ella.pubKeyHex)?.updated_at === seeded.ella && row(fern.pubKeyHex)?.updated_at === seeded.fern,
        'no member\'s updated_at moves: the fill stamps no row for delta sync');
    assert(!!db.prepare('SELECT 1 FROM node_config WHERE key = ?').get(PAUSED_STANDING_MARKER), 'the one-time marker is written');
    {
        const rheaDelta = await delta(rhea, cursor);
        assert(rheaDelta.get(fixtureOffers.ella) === 'paused', `Rhea's next delta, from before the upgrade, carries Ella's offer as paused (${rheaDelta.get(fixtureOffers.ella)})`);
        assert(!rheaDelta.has(fixtureOffers.fern), 'and not Fern\'s, which nothing changed since her cursor');
        const b = await board(rhea);
        assert(!b.has(fixtureOffers.ella) && b.has(fixtureOffers.fern), `the board leaves Ella's offer out and shows Fern's (${b.has(fixtureOffers.ella)}, ${b.has(fixtureOffers.fern)})`);
    }

    // ── The people ─────────────────────────────────────────────────────────────────────────────────────────────────
    const gen = keypair('GenesisGwen');
    se.seedGenesisMember(gen.pubKeyHex, gen.callsign);
    const seedMember = (callsign: string): Id => {
        const id = keypair(callsign);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`)
            .run(id.pubKeyHex, callsign, gen.pubKeyHex, `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pubKeyHex);
        se.transfer('genesis', id.pubKeyHex, 50, `seed ${callsign}`, 'direct', true);
        return id;
    };
    const otto = seedMember('OwnerOtto');       // a second owner, so Gwen isn't the only one
    grantNodeRole(otto.pubKeyHex, 'owner', gen.pubKeyHex);
    const ada = seedMember('AdminAda');         // an admin
    grantNodeRole(ada.pubKeyHex, 'admin', gen.pubKeyHex);
    const pia = seedMember('PausedPia');        // a moderator an admin pauses at once
    grantNodeRole(pia.pubKeyHex, 'moderator', gen.pubKeyHex);
    const al = seedMember('ReportedAl');        // an admin a report pauses, under an owner
    grantNodeRole(al.pubKeyHex, 'admin', gen.pubKeyHex);
    const rob = seedMember('ReportedRob');      // a member a report pauses, under an admin, with a reason
    const sam = seedMember('ShortReasonSam');   // a report whose reason is too short
    const tess = seedMember('VotesOffTess');    // a report's pause with formal Decisions off
    const rae = seedMember('ReporterRae');
    const bea = seedMember('BuyerBea');         // has a deal open on one of Pia's listings
    const vic = seedMember('BuyerVic');         // has another, which Pia cancels
    const olive = seedMember('SellerOlive');    // sells Pia something
    const rita = seedMember('ReaderRita');      // reads the board, with no deal on anything
    const ownerSession = ownerSessionHeaders(gen.pubKeyHex);
    const adaSession = (() => {
        const { handshakeToken } = mintHandshakeToken(ada.pubKeyHex, 'admin');
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open Ada's key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
    })();
    const offer = (author: Id, title: string) => se.createPost('offer', 'food', title, `${title}, fresh this week`, 5, 'fixed', author.pubKeyHex)!.id;
    const openDeal = (postId: string, author: Id, buyer: Id) => {
        const tx = se.requestPost(postId, buyer.pubKeyHex);
        se.approvePostRequest(tx.id, author.pubKeyHex);
        return tx.id;
    };
    const dealStatus = (txId: string) => (db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(txId) as { status: string } | undefined)?.status;
    const balanceOf = (id: Id) => Number(se.getBalance(id.pubKeyHex)?.balance);
    const accountsNow = () => JSON.stringify(db.prepare('SELECT public_key, balance FROM accounts ORDER BY public_key').all());
    const codeUser = (code: string) => (db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null } | undefined)?.used_by ?? null;
    const codesBy = (id: Id) => (db.prepare('SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?').get(id.pubKeyHex) as { n: number }).n;
    const reportOn = (target: Id, reason: string) => {
        const r = se.submitReport(rae.pubKeyHex, target.pubKeyHex, reason);
        if (!r) throw new Error(`the report on ${target.callsign} was refused`);
        return r.id;
    };
    const reportRow = (id: string) => db.prepare('SELECT status, suspended_member FROM abuse_reports WHERE id = ?').get(id) as { status: string; suspended_member: number | null };
    const PAUSED_INVITE = /paused/i;
    const CANT_BRING_IN = /can’t bring anyone in/;

    // ── 1. An admin pauses Pia ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. an admin pauses Pia at once ──');
    const piaHoney = offer(pia, 'Pia honey'), piaBread = offer(pia, 'Pia bread'), piaJam = offer(pia, 'Pia jam'), piaApples = offer(pia, 'Pia apples');
    const oliveEggs = offer(olive, 'Olive eggs');
    // A buyer lists an Offer of their own before taking one (CONTRIBUTION_REQUIRED).
    offer(bea, 'Bea basil');
    offer(vic, 'Vic chillies');
    const beaDeal = openDeal(piaHoney, pia, bea);
    const vicDeal = openDeal(piaBread, pia, vic);
    const piaBuys = openDeal(oliveEggs, olive, pia);
    assert([beaDeal, vicDeal, piaBuys].every(t => dealStatus(t) === 'pending'), 'setup: Bea and Vic each have a deal open on Pia\'s listings, and Pia one on Olive\'s');
    const madeBefore = await post('/api/invite/generate', { publicKey: pia.pubKeyHex }, pia);
    const piaCode = madeBefore.body?.invite?.code as string;
    assert(madeBefore.status === 200 && !!piaCode, `setup: Pia makes an invite before her pause (${madeBefore.status})`);
    const oliveDm = se.createConversation('dm', [olive.pubKeyHex, pia.pubKeyHex], olive.pubKeyHex)!.id;
    const kay = keypair('KnockingKay');
    const knocked = await post('/api/join/knock', { callsign: kay.callsign, message: 'Hello, I live nearby and grow beans.', fromNode: 'https://global.beanpool.org/' }, kay);
    const kayKnock = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(kay.pubKeyHex) as { id: string } | undefined)?.id ?? '';
    assert(knocked.status === 201 && !!kayKnock, `setup: Kay asks to join (${knocked.status})`);
    assert((await board(rita)).has(piaApples), 'setup: Rita reads Pia\'s apples on the board');

    const beforePause = new Date(Date.now() - 1).toISOString();
    await sleep(5);
    const accountsBefore = accountsNow();
    const PIA_REASON = 'Threats made to another member at the market';
    const paused = await asAdmin(adaSession, `/api/local/admin/users/${pia.pubKeyHex}/suspend`, { reason: PIA_REASON });
    const accountsAfter = accountsNow();
    const piaRecord = records(pia)[0];
    assert(paused.status === 200 && statusOf(pia) === 'disabled', `Ada pauses Pia: her account is 'disabled' (${paused.status} ${statusOf(pia)})`);
    assert(piaRecord?.status === 'open' && paramsOf(piaRecord).reason === PIA_REASON && paramsOf(piaRecord).suspendedBy === ada.pubKeyHex,
        `the record opens, with Ada's reason (${piaRecord?.status}, ${JSON.stringify(paramsOf(piaRecord).reason)})`);
    assert(roleOf(pia) === null && heldAside(piaRecord?.id)?.role === 'moderator', `her moderator role is held aside under the record (${roleOf(pia)}, ${heldAside(piaRecord?.id)?.role})`);
    assert(accountsBefore === accountsAfter, 'the pause moves no Beans: every account holds what it held');

    const ritaBoard = await board(rita);
    assert(![piaApples, piaJam].some(p => ritaBoard.has(p)), 'her listings leave the board Rita reads');
    const ritaDelta = await delta(rita, beforePause);
    assert(ritaDelta.get(piaApples) === 'paused' && ritaDelta.get(piaJam) === 'paused',
        `Rita's next delta carries them as paused, so her phone takes them off (${ritaDelta.get(piaApples)}, ${ritaDelta.get(piaJam)})`);
    const beaDelta = await delta(bea, beforePause);
    assert(beaDelta.has(piaHoney) && beaDelta.get(piaHoney) !== 'paused',
        `Bea, with a deal open on Pia's honey, gets it as it is (${beaDelta.get(piaHoney)})`);
    const piaDelta = await delta(pia, beforePause);
    assert(piaDelta.has(piaApples) && piaDelta.get(piaApples) === 'active', `Pia's own phone holds her listings as they are (${piaDelta.get(piaApples)})`);

    const piaMakes = await post('/api/invite/generate', { publicKey: pia.pubKeyHex }, pia);
    assert(piaMakes.status === 403 && piaMakes.body?.code === 'paused' && PAUSED_INVITE.test(piaMakes.body?.error ?? '') && codesBy(pia) === 1,
        `she can't make an invite while paused, told why, and no code is written (${piaMakes.status} ${piaMakes.text.slice(0, 120)})`);
    const nia = keypair('NewNia');
    const viaTicket = await post('/api/invite/redeem-offline', { ticketB64: offlineTicket(pia), publicKey: nia.pubKeyHex, callsign: nia.callsign }, nia);
    assert(viaTicket.status === 400 && CANT_BRING_IN.test(viaTicket.body?.error ?? '') && !row(nia.pubKeyHex),
        `an offline ticket she signs admits nobody (${viaTicket.status} ${viaTicket.text.slice(0, 140)})`);
    const checked = await get(`/api/invite/check?code=${piaCode}`);
    assert(checked.status === 200 && checked.body?.valid === false, `the pre-flight check calls the code she made before no good now (${checked.text.slice(0, 100)})`);
    const viaCode = await post('/api/invite/redeem', { code: piaCode, publicKey: nia.pubKeyHex, callsign: nia.callsign }, nia);
    assert(viaCode.status === 400 && CANT_BRING_IN.test(viaCode.body?.error ?? '') && !/no longer in this community/.test(viaCode.body?.error ?? '')
        && !row(nia.pubKeyHex) && codeUser(piaCode) === null,
        `and its redeem is refused, in words that don't say she left, the code unused (${viaCode.status} ${viaCode.text.slice(0, 140)})`);
    const piaAnswers = await post(`/api/join/knocks/${kayKnock}/approve`, {}, pia);
    assert(piaAnswers.status === 403 && piaAnswers.body?.code === 'not_active', `she can't answer a knock: 403 not_active, as before (${piaAnswers.status} ${piaAnswers.body?.code})`);
    const piaReplies = await post('/api/messages/send', { conversationId: oliveDm, authorPubkey: pia.pubKeyHex, ...lockedDm() }, pia);
    assert(piaReplies.status === 200, `she answers in the conversation she is in with Olive (${piaReplies.status} ${piaReplies.text.slice(0, 100)})`);
    const piaAsksAgain = await post('/api/messages/conversation', { type: 'dm', participants: [pia.pubKeyHex, olive.pubKeyHex], createdBy: pia.pubKeyHex }, pia);
    assert(piaAsksAgain.status === 200 && piaAsksAgain.body?.conversation?.id === oliveDm, `and gets it again when her app asks for it (${piaAsksAgain.status})`);
    const piaOpens = await post('/api/messages/conversation', { type: 'dm', participants: [pia.pubKeyHex, rita.pubKeyHex], createdBy: pia.pubKeyHex }, pia);
    const ritaDms = (db.prepare(`SELECT COUNT(*) AS n FROM conversation_participants a JOIN conversation_participants b ON a.conversation_id = b.conversation_id
                                 WHERE a.public_key = ? AND b.public_key = ?`).get(pia.pubKeyHex, rita.pubKeyHex) as { n: number }).n;
    assert(piaOpens.status === 403 && piaOpens.body?.code === 'paused' && PAUSED_INVITE.test(piaOpens.body?.error ?? '') && ritaDms === 0,
        `but starts no new one, told why, and none is made (${piaOpens.status} ${piaOpens.text.slice(0, 120)})`);

    const piaBefore = balanceOf(pia);
    const beaCompletes = await post('/api/marketplace/transactions/complete', { transactionId: beaDeal, confirmerPublicKey: bea.pubKeyHex }, bea);
    assert(beaCompletes.status === 200 && dealStatus(beaDeal) === 'completed' && balanceOf(pia) > piaBefore,
        `Bea completes the deal she had open with Pia, and Pia is paid (${beaCompletes.status}, ${piaBefore} → ${balanceOf(pia)})`);
    const piaCompletes = await post('/api/marketplace/transactions/complete', { transactionId: piaBuys, confirmerPublicKey: pia.pubKeyHex }, pia);
    assert(piaCompletes.status === 200 && dealStatus(piaBuys) === 'completed', `Pia completes the deal she had open on Olive's eggs (${piaCompletes.status} ${piaCompletes.text.slice(0, 100)})`);
    const vicBefore = balanceOf(vic);
    const piaCancels = await post('/api/marketplace/transactions/cancel', { transactionId: vicDeal, cancellerPublicKey: pia.pubKeyHex }, pia);
    assert(piaCancels.status === 200 && dealStatus(vicDeal) === 'cancelled' && balanceOf(vic) > vicBefore,
        `Pia cancels the one Vic had open on her bread, and Vic is refunded (${piaCancels.status}, ${vicBefore} → ${balanceOf(vic)})`);
    const takesDown = await post('/api/marketplace/posts/remove', { id: piaJam, authorPublicKey: pia.pubKeyHex }, pia);
    const jam = db.prepare('SELECT active, status FROM posts WHERE id = ?').get(piaJam) as { active: number; status: string };
    assert(takesDown.status === 200 && takesDown.body?.success === true && (jam.active === 0 || jam.status === 'cancelled'),
        `she takes her own listing down (${takesDown.status}, active ${jam.active} ${jam.status})`);

    // ── 2. A report's suspension is the same pause ───────────────────────────────────────────────────────────────────
    console.log('\n── 2. a report actioned with a suspension is the same pause ──');
    const alOffer = offer(al, 'Al firewood');
    const alReport = reportOn(al, 'Selling things that were never his to sell');
    const alPaused = await asAdmin(ownerSession, `/api/local/admin/reports/${alReport}/action`, { suspendUser: true });
    const alRecord = records(al)[0];
    assert(alPaused.status === 200 && statusOf(al) === 'disabled', `an owner pauses Al through a report: 'disabled', not 'suspended' (${alPaused.status} ${statusOf(al)})`);
    assert(alRecord?.status === 'open' && alRecord?.title === `Keep ${al.callsign}'s suspension?`,
        `the report opens the record, as an emergency suspension does (${alRecord?.status} ${JSON.stringify(alRecord?.title)})`);
    const alReason = String(paramsOf(alRecord).reason ?? '');
    assert(alReason.includes(al.callsign) && /report/i.test(alReason) && !alReason.includes('never his to sell') && !alReason.includes(rae.callsign),
        `with a reason that names Al and the report, and neither the reporter nor what they wrote (${JSON.stringify(alReason)})`);
    assert(roleOf(al) === null && heldAside(alRecord?.id)?.role === 'admin', `his admin role is held aside under the record, not dropped (${roleOf(al)}, ${heldAside(alRecord?.id)?.role})`);
    assert(reportRow(alReport)?.status === 'actioned' && reportRow(alReport)?.suspended_member === 1, 'the report is actioned and says it paused him');
    assert(!(await board(rita)).has(alOffer), 'his listings leave the board');
    const alMakes = await post('/api/invite/generate', { publicKey: al.pubKeyHex }, al);
    assert(alMakes.status === 403 && alMakes.body?.code === 'paused', `he can't make an invite (${alMakes.status} ${alMakes.text.slice(0, 100)})`);

    const ROB_REASON = 'Spamming the market chats again after a warning';
    const robPaused = await asAdmin(adaSession, `/api/local/admin/reports/${reportOn(rob, 'Spam in every chat')}/action`, { suspendUser: true, reason: ROB_REASON });
    assert(robPaused.status === 200 && statusOf(rob) === 'disabled' && paramsOf(records(rob)[0]).reason === ROB_REASON,
        `an admin pauses Rob through a report with a reason of their own: the record carries it (${robPaused.status} ${JSON.stringify(paramsOf(records(rob)[0]).reason)})`);
    const samReport = reportOn(sam, 'Rude in the chats');
    const samShort = await asAdmin(adaSession, `/api/local/admin/reports/${samReport}/action`, { suspendUser: true, reason: 'rude' });
    assert(samShort.status === 400 && /at least 10 characters/.test(samShort.body?.error ?? '') && statusOf(sam) === 'active'
        && records(sam).length === 0 && reportRow(samReport)?.status === 'pending',
        `a reason too short is refused before anything is written (${samShort.status} ${samShort.text.slice(0, 100)})`);
    let engineRefusal = '';
    try { se.actionReport(samReport, false, true, false, { actor: ada.pubKeyHex, reason: 'rude' }); } catch (e: any) { engineRefusal = `${e?.status} ${e?.message}`; }
    assert(/^400 .*at least 10 characters/.test(engineRefusal) && statusOf(sam) === 'active' && reportRow(samReport)?.status === 'pending',
        `underneath the route too: the engine refuses it, and writes nothing (${engineRefusal || 'no refusal'})`);
    const robAgain = reportOn(rob, 'Still spamming, from a second member');
    const robTwice = await asAdmin(adaSession, `/api/local/admin/reports/${robAgain}/action`, { suspendUser: true });
    assert(robTwice.status === 200 && records(rob).length === 1 && reportRow(robAgain)?.status === 'actioned' && reportRow(robAgain)?.suspended_member === 0,
        `a second report on Rob, already paused, is actioned and opens no second record (${robTwice.status}, ${records(rob).length} record(s))`);
    const { publicKey: shop } = se.createTreasury('PauseShop', AVATAR, 0);
    db.prepare("INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, reason, status) VALUES ('pause-shop-report', ?, ?, 'Never delivers', 'pending')")
        .run(rae.pubKeyHex, shop);
    const shopPaused = await asAdmin(ownerSession, '/api/local/admin/reports/pause-shop-report/action', { suspendUser: true });
    assert(shopPaused.status === 400 && /enterprise/i.test(shopPaused.body?.error ?? '') && row(shop)?.status === 'active'
        && reportRow('pause-shop-report')?.status === 'pending',
        `an enterprise's account can't be paused through a report, and nothing is written (${shopPaused.status} ${shopPaused.text.slice(0, 100)})`);

    // ── 3. The lift ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. the lift ──');
    const beforeLift = new Date(Date.now() - 1).toISOString();
    await sleep(5);
    const lifted = await asAdmin(adaSession, `/api/local/admin/users/${pia.pubKeyHex}/status`, { status: 'active' });
    assert(lifted.status === 200 && statusOf(pia) === 'active' && roleOf(pia) === 'moderator' && records(pia)[0]?.status === 'admin_halted',
        `Ada lifts Pia's pause: active, her moderator role back, the record halted (${lifted.status} ${statusOf(pia)} ${roleOf(pia)} ${records(pia)[0]?.status})`);
    assert((await board(rita)).has(piaApples), 'her listings are back on the board');
    const ritaBack = await delta(rita, beforeLift);
    assert(ritaBack.get(piaApples) === 'active', `and Rita's next delta carries them as they are (${ritaBack.get(piaApples)})`);
    const piaMakesNow = await post('/api/invite/generate', { publicKey: pia.pubKeyHex }, pia);
    assert(piaMakesNow.status === 200 && !!piaMakesNow.body?.invite?.code, `she makes an invite again (${piaMakesNow.status})`);
    const niaJoins = await post('/api/invite/redeem', { code: piaCode, publicKey: nia.pubKeyHex, callsign: nia.callsign }, nia);
    assert(niaJoins.status === 200 && codeUser(piaCode) === nia.pubKeyHex, `and the code she made before admits Nia now (${niaJoins.status} ${niaJoins.text.slice(0, 100)})`);

    const closesAt = Date.parse(alRecord?.closes_at ?? new Date().toISOString());
    de.tickDecisions(closesAt + MIN);
    const alAfter = db.prepare('SELECT status FROM decisions WHERE id = ?').get(alRecord?.id) as { status: string } | undefined;
    assert(alAfter?.status === 'unresolved' && statusOf(al) === 'active' && roleOf(al) === 'admin',
        `nobody keeps Al's pause: the tick lifts it, his admin role back (${alAfter?.status} ${statusOf(al)} ${roleOf(al)})`);
    assert((await board(rita)).has(alOffer), 'and his listings are back on the board');

    // ── 4. Formal Decisions off ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. formal Decisions off ──');
    const decisionsOff = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    decisionsOff.run(`${NODE_PROFILE_KEY}.decisions`, 'false');
    try {
        const tessOffer = offer(tess, 'Tess kale');
        const tessPaused = await asAdmin(ownerSession, `/api/local/admin/reports/${reportOn(tess, 'Shouting at people in the market')}/action`, { suspendUser: true });
        const tessRecord = records(tess)[0];
        assert(tessPaused.status === 200 && statusOf(tess) === 'disabled' && paramsOf(tessRecord).noVote === true
            && String(tessRecord?.title).startsWith(`${tess.callsign} is suspended until`),
            `a report's pause opens the record nobody votes on (${tessPaused.status} ${statusOf(tess)} ${JSON.stringify(tessRecord?.title)})`);
        assert(!(await board(rita)).has(tessOffer), 'her listings leave the board');
        de.tickDecisions(Date.parse(tessRecord?.closes_at ?? new Date().toISOString()) + MIN);
        assert(statusOf(tess) === 'active' && (db.prepare('SELECT status FROM decisions WHERE id = ?').get(tessRecord?.id) as any)?.status === 'unresolved',
            `when its 7 days end, the tick lifts it (${statusOf(tess)})`);
        assert((await board(rita)).has(tessOffer), 'and her listings are back');
    } finally {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.decisions`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        console.error(`❌ ${run - passed} check(s) failed`);
        process.exit(1);
    }
    console.log('⭐️ One pause: an emergency suspension and a report\'s are the same pause, and it ends.');
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
