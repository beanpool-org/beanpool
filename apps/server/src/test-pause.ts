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
 *     admits nobody (the check says so too), though one forged in her name reads as one forged in an active member's, so
 *     it tells nobody she is paused, and a code she made before is refused (the check says so, the redeem in words that
 *     don't say she left), unused. She still can't answer a knock (403 not_active). She answers in the conversation she is in, and gets
 *     it again when her app asks, but starts no new one (403 `paused`), as §3.1 has it: an admin's suspension refused her
 *     every line before, a report's let her open any. The one she opened with Bob, who had blocked her, kept for her alone
 *     (engine/withheld-lines.ts), she gets again as she gets Olive's, and it stays kept for her: refusing it would tell her of
 *     the block. One she doesn't have is refused alike, whoever has blocked whom: Cleo, who blocked her, or Wes, whom she
 *     blocked, whose own with her is kept for him. She takes a line of her own down in it; her group's chat still
 *     refuses her taking hers down there (403), as it did before her pause, and the line stays. She CAN close the deals
 *     she has open: Bea completes hers and Pia is paid, Pia completes one she bought, and cancels another; and she can
 *     take her own listing down.
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
 *  5. A visitor's row (someone a member wrote to, who never joined) paused by an admin, or through a report, answers nobody:
 *     its line is refused as an admin's suspension refused it before the one pause (400, 'Account is disabled'), and so is
 *     asking for the conversation again. A paused member answers in the conversations they are in (§3.1); a visitor's row
 *     can only ever answer, so a pause that let it would take nothing from it.
 *  6. Where the operator turns message requests on (engine/dm-requests.ts), a pause and a request agree. Pip, paused, is held
 *     by her own requests as Quin, who isn't, is held by his (403 dm_request_pending), to Una and to Bly, who blocked her,
 *     alike; she gets each again with her request pending, the one kept for her alone as Una's; and she finds Quin's request
 *     waiting for her, accepts it, which is answering in a conversation she is in, and answers him.
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
import { lockedGroupLine } from './group-test-payload.js';

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

/** One anyone can write: it names `named` (whose key every ticket they gave out carries) over 64 bytes no key signed. */
function forgedTicket(named: Id): string {
    const payload = JSON.stringify({ i: named.pubKeyHex, t: Date.now() });
    return Buffer.from(JSON.stringify({ p: payload, s: crypto.randomBytes(64).toString('base64') })).toString('base64');
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
    const bob = seedMember('BlockingBob');      // has blocked Pia, who opens a DM with him all the same
    const cleo = seedMember('BlockingCleo');    // has blocked Pia, who has no DM with her
    const wes = seedMember('BlockedWes');       // Pia has blocked him, and he opens a DM with her all the same
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
    const piaDmLine = (() => { const p = lockedDm(); return se.sendMessage(oliveDm, pia.pubKeyHex, p.ciphertext, p.nonce)!.id; })();
    // A group Olive runs, with Pia in it and a line of hers in its chat (sealed, as a member's app sends one).
    const crew = se.createGroup({ name: 'Market Crew', joinPolicy: 'request_to_join', createdBy: olive.pubKeyHex });
    se.joinGroup(crew.id, pia.pubKeyHex);
    se.approveGroupMember(crew.id, olive.pubKeyHex, pia.pubKeyHex);
    const piaGroupLine = se.postGroupThreadMessage(crew.id, pia.pubKeyHex, lockedGroupLine(db, crew.id)).id;
    const lineType = (id: string) => (db.prepare('SELECT type FROM messages WHERE id = ?').get(id) as { type: string } | undefined)?.type;
    const kay = keypair('KnockingKay');
    const knocked = await post('/api/join/knock', { callsign: kay.callsign, message: 'Hello, I live nearby and grow beans.', fromNode: 'https://global.beanpool.org/' }, kay);
    const kayKnock = (db.prepare('SELECT id FROM join_requests WHERE pubkey = ?').get(kay.pubKeyHex) as { id: string } | undefined)?.id ?? '';
    assert(knocked.status === 201 && !!kayKnock, `setup: Kay asks to join (${knocked.status})`);
    assert((await board(rita)).has(piaApples), 'setup: Rita reads Pia\'s apples on the board');
    // Bob and Cleo have blocked Pia, and she has blocked Wes. The DM she opens with Bob is kept for her alone
    // (engine/withheld-lines.ts), as the one Wes opens with her is for him: neither is a chat the other has.
    for (const [blocker, blocked] of [[bob, pia], [cleo, pia], [pia, wes]] as const) {
        const blocking = await post('/api/blocks', { targetPubkey: blocked.pubKeyHex }, blocker);
        if (blocking.status !== 200) throw new Error(`${blocker.callsign} could not block ${blocked.callsign}: ${blocking.status} ${blocking.text}`);
    }
    const openDm = (by: Id, other: Id) =>
        post('/api/messages/conversation', { type: 'dm', participants: [by.pubKeyHex, other.pubKeyHex], createdBy: by.pubKeyHex }, by);
    const keptFor = (id: string) => (db.prepare('SELECT owner_pubkey FROM withheld_conversations WHERE id = ?').get(id) as { owner_pubkey: string } | undefined)?.owner_pubkey;
    const isChat = (id: string) => !!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id);
    const bobDm = String((await openDm(pia, bob)).body?.conversation?.id ?? '');
    const wesDm = String((await openDm(wes, pia)).body?.conversation?.id ?? '');
    assert(keptFor(bobDm) === pia.pubKeyHex && !isChat(bobDm) && keptFor(wesDm) === wes.pubKeyHex && !isChat(wesDm),
        'setup: the DM Pia opens with Bob, who blocked her, is kept for her alone, and the one Wes opens with her, whom she blocked, for him');

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
    const ticketChecked = await get(`/api/invite/check?code=${encodeURIComponent(`BP-${offlineTicket(pia)}`)}`);
    assert(ticketChecked.status === 200 && ticketChecked.body?.valid === false && ticketChecked.body?.reason === 'unknown_inviter',
        `and the pre-flight check calls one no good (${ticketChecked.text.slice(0, 100)})`);
    // A ticket forged in her name: her key is in every ticket she gave out, so anyone can name it. It reads as one forged
    // in Rita's, who isn't paused, in the redeem and in the check, so it tells nobody that Pia's account is paused.
    const forgedAnswers = async (named: Id) => {
        const joiner = keypair('ForgingFay');
        const redeemed = await post('/api/invite/redeem-offline', { ticketB64: forgedTicket(named), publicKey: joiner.pubKeyHex, callsign: joiner.callsign }, joiner);
        const checkedForged = await get(`/api/invite/check?code=${encodeURIComponent(`BP-${forgedTicket(named)}`)}`);
        return {
            redeemed: `${redeemed.status} ${redeemed.body?.error}`,
            checked: `${checkedForged.status} ${checkedForged.body?.valid} ${checkedForged.body?.reason}`,
            joined: !!row(joiner.pubKeyHex),
        };
    };
    const forgedPia = await forgedAnswers(pia), forgedRita = await forgedAnswers(rita);
    assert(forgedPia.redeemed === forgedRita.redeemed && /^400 .*signature/i.test(forgedRita.redeemed) && !forgedPia.joined && !forgedRita.joined,
        `a ticket forged in her name is refused in the redeem as one forged in Rita's is, for its signature (${forgedPia.redeemed} | ${forgedRita.redeemed})`);
    assert(forgedPia.checked === forgedRita.checked && forgedRita.checked === '200 false invalid',
        `and in the check (${forgedPia.checked} | ${forgedRita.checked})`);
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
    // The one kept for her alone (Bob blocked her before she opened it) answers as Olive's does: the same conversation, in
    // the same shape. Refused, it would tell her of the block, which the node keeps from her (engine/withheld-lines.ts).
    const shape = (a: Answer) => `${a.status} ${Object.keys(a.body?.conversation ?? {}).sort().join(',')}`;
    const bobAgain = await openDm(pia, bob);
    assert(shape(bobAgain) === shape(piaAsksAgain) && bobAgain.body?.conversation?.id === bobDm,
        `she gets the one she opened with Bob, who had blocked her, again, as she gets Olive's (${shape(bobAgain)} | ${shape(piaAsksAgain)})`);
    assert(keptFor(bobDm) === pia.pubKeyHex && !isChat(bobDm), 'and it is still kept for her alone: Bob has no chat with her');
    const refusal = (a: Answer) => `${a.status} ${a.body?.code} ${a.body?.error}`;
    const cleoAsked = await openDm(pia, cleo), wesAsked = await openDm(pia, wes);
    const anyWithCleo = db.prepare(`SELECT 1 FROM withheld_conversations WHERE (owner_pubkey = @a AND other_pubkey = @b) OR (owner_pubkey = @b AND other_pubkey = @a)
                                    UNION ALL SELECT 1 FROM conversation_participants x JOIN conversation_participants y ON x.conversation_id = y.conversation_id
                                    WHERE x.public_key = @a AND y.public_key = @b`).get({ a: pia.pubKeyHex, b: cleo.pubKeyHex });
    assert(refusal(cleoAsked) === refusal(piaOpens) && refusal(wesAsked) === refusal(piaOpens) && !anyWithCleo,
        `one with Cleo, who blocked her, or with Wes, whom she blocked, is refused as Rita's is, and none is made (${refusal(cleoAsked)} | ${refusal(wesAsked)})`);
    assert(keptFor(wesDm) === wes.pubKeyHex && !isChat(wesDm), 'and the one Wes opened with her is still kept for him alone');
    const piaTakesDmLineDown = await post('/api/messages/delete', { messageId: piaDmLine }, pia);
    assert(piaTakesDmLineDown.status === 200 && lineType(piaDmLine) === 'removed',
        `she takes a line of her own down in it (${piaTakesDmLineDown.status} ${lineType(piaDmLine)} ${piaTakesDmLineDown.text.slice(0, 100)})`);
    const piaTakesGroupLineDown = await post('/api/messages/delete', { messageId: piaGroupLine }, pia);
    assert(piaTakesGroupLineDown.status === 403 && piaTakesGroupLineDown.body?.error === 'Account is disabled' && lineType(piaGroupLine) === 'text',
        `but not one in her group's chat, which refuses her as it did before her pause, and the line stays (${piaTakesGroupLineDown.status} ${lineType(piaGroupLine)} ${piaTakesGroupLineDown.text.slice(0, 100)})`);

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

    // ── 5. A visitor's row ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a visitor\'s row ──');
    // Vee and Wren never joined: Mia wrote to each, which made each a visitor's row, and each answers her.
    const mia = seedMember('MessagingMia');
    const vee = keypair('VisitingVee'), wren = keypair('VisitingWren');
    const veeDm = se.createConversation('dm', [mia.pubKeyHex, vee.pubKeyHex], mia.pubKeyHex)!.id;
    const wrenDm = se.createConversation('dm', [mia.pubKeyHex, wren.pubKeyHex], mia.pubKeyHex)!.id;
    const answers = (visitor: Id, conversationId: string) =>
        post('/api/messages/send', { conversationId, authorPubkey: visitor.pubKeyHex, ...lockedDm() }, visitor);
    const linesBy = (id: Id) => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_pubkey = ?').get(id.pubKeyHex) as { n: number }).n;
    const veeAnswers = await answers(vee, veeDm), wrenAnswers = await answers(wren, wrenDm);
    assert(row(vee.pubKeyHex)?.is_visitor === 1 && row(wren.pubKeyHex)?.is_visitor === 1 && veeAnswers.status === 200 && wrenAnswers.status === 200,
        `setup: Vee and Wren, visitors' rows Mia wrote to, each answer her (${veeAnswers.status}, ${wrenAnswers.status})`);
    const veePaused = await asAdmin(ownerSession, `/api/local/admin/users/${vee.pubKeyHex}/suspend`, { reason: 'Threats to a member in a direct message' });
    const wrenPaused = await asAdmin(adaSession, `/api/local/admin/reports/${reportOn(wren, 'Threats in a direct message')}/action`, { suspendUser: true });
    assert(veePaused.status === 200 && statusOf(vee) === 'disabled' && wrenPaused.status === 200 && statusOf(wren) === 'disabled',
        `an owner pauses Vee's row, and an admin Wren's through a report, as a member's are (${veePaused.status} ${statusOf(vee)}, ${wrenPaused.status} ${statusOf(wren)})`);
    const linesBefore = linesBy(vee) + linesBy(wren);
    const veeAgain = await answers(vee, veeDm), wrenAgain = await answers(wren, wrenDm);
    assert(veeAgain.status === 400 && veeAgain.body?.error === 'Account is disabled' && refusal(wrenAgain) === refusal(veeAgain)
        && linesBy(vee) + linesBy(wren) === linesBefore,
        `then neither answers: each line is refused as an admin's suspension refused it before the one pause, and none is stored (${refusal(veeAgain)} | ${refusal(wrenAgain)})`);
    const veeAsks = await post('/api/messages/conversation', { type: 'dm', participants: [vee.pubKeyHex, mia.pubKeyHex], createdBy: vee.pubKeyHex }, vee);
    assert(veeAsks.status === 400 && veeAsks.body?.error === 'Account is disabled', `nor does Vee get the conversation again (${refusal(veeAsks)})`);

    // ── 6. Message requests ──────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. message requests ──');
    const setSwitch = db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    setSwitch.run(`${NODE_PROFILE_KEY}.dmRequests`, 'true');
    try {
        const pip = seedMember('PausedPip'), una = seedMember('AskedUna'), quin = seedMember('AskingQuin'), bly = seedMember('BlockingBly');
        const blyBlocks = await post('/api/blocks', { targetPubkey: pip.pubKeyHex }, bly);
        const writes = (by: Id, conversationId: string) =>
            post('/api/messages/send', { conversationId, authorPubkey: by.pubKeyHex, ...lockedDm() }, by);
        const requestState = (id: string) => (db.prepare('SELECT state FROM dm_requests WHERE conversation_id = ?').get(id) as { state: string } | undefined)?.state;
        // Pip writes to Una, and to Bly, who has blocked her (kept for her alone); Quin writes to Pip. A request each.
        const unaDm = String((await openDm(pip, una)).body?.conversation?.id ?? '');
        const blyDm = String((await openDm(pip, bly)).body?.conversation?.id ?? '');
        const quinDm = String((await openDm(quin, pip)).body?.conversation?.id ?? '');
        const firstLines = [await writes(pip, unaDm), await writes(pip, blyDm), await writes(quin, quinDm)];
        assert(blyBlocks.status === 200 && firstLines.every(a => a.status === 200) && keptFor(blyDm) === pip.pubKeyHex
            && [unaDm, blyDm, quinDm].every(id => requestState(id) === 'pending'),
            `setup: Pip's first lines to Una and to Bly (who blocked her: kept for her alone) and Quin's to Pip each wait as a request (${firstLines.map(a => a.status).join(' ')})`);

        const pipPaused = await asAdmin(adaSession, `/api/local/admin/users/${pip.pubKeyHex}/suspend`, { reason: 'Threats made to another member at the market' });
        assert(pipPaused.status === 200 && statusOf(pip) === 'disabled', `Ada pauses Pip (${pipPaused.status} ${statusOf(pip)})`);
        const held = (a: Answer) => `${a.status} ${a.body?.code}`;
        const quinMore = await writes(quin, quinDm), pipToUna = await writes(pip, unaDm), pipToBly = await writes(pip, blyDm);
        assert(held(quinMore) === '403 dm_request_pending' && held(pipToUna) === held(quinMore) && held(pipToBly) === held(quinMore),
            `Pip's second line, to Una or to Bly, waits on her request as Quin's, who isn't paused, waits on his (${held(pipToUna)} | ${held(pipToBly)} | ${held(quinMore)})`);
        const requestShape = (a: Answer) => `${shape(a)} ${a.body?.conversation?.request?.state}`;
        const unaAgain = await openDm(pip, una), blyAgain = await openDm(pip, bly);
        assert(unaAgain.status === 200 && unaAgain.body?.conversation?.request?.state === 'pending' && requestShape(blyAgain) === requestShape(unaAgain)
            && unaAgain.body?.conversation?.id === unaDm && blyAgain.body?.conversation?.id === blyDm,
            `she gets each again with her request pending, the one kept for her alone as Una's (${requestShape(unaAgain)} | ${requestShape(blyAgain)})`);
        const listed = await get(`/api/messages/conversations/${pip.pubKeyHex}`, pip);
        const quinWaits = (listed.body?.requests?.conversations ?? []).some((c: any) => c.id === quinDm);
        const accepted = await post('/api/messages/request', { conversationId: quinDm, decision: 'accept' }, pip);
        const quinWritesOn = await writes(quin, quinDm), pipAnswers = await writes(pip, quinDm);
        assert(quinWaits && accepted.status === 200 && accepted.body?.request?.state === 'accepted' && requestState(quinDm) === 'accepted',
            `Quin's request waits in her list, and she accepts it (${listed.status} ${quinWaits}, ${accepted.status} ${accepted.body?.request?.state})`);
        assert(quinWritesOn.status === 200 && pipAnswers.status === 200, `Quin writes on, and she answers him (${quinWritesOn.status}, ${pipAnswers.status})`);
    } finally {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.dmRequests`);
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
