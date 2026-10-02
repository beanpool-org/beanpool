/**
 * Test Suite: Delete account blanks every chat line the member wrote and deletes the photos they sent, on the main server,
 * on its standby and on a phone (data-at-rest report F1 and F2; Marty, 2026-10-01: "Yes, blank lines and photos").
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests. A standby pulls through its real puller (services/backup-puller.ts `pullNow`) from
 * the main server's real backup routes. Nothing leaves this machine.
 *
 *  1. The main server M. Rhea writes in a group's chat (a reply, a line Bo reacts to, one Bo replies to, one the convenor
 *     removed), an enterprise's discussion, an event's chat and a DM with Bo (text, a photo, and a line carrying a photo in
 *     the old in-row form); Bo and Cy write beside her, Bo sends a photo too. Every line of hers names words found nowhere
 *     else. Bo's phone syncs, and every route shows her words (so the checks below can fail).
 *  2. The standby S copies M: it holds her lines as they were.
 *  3. Rhea deletes her account (POST /api/member/purge). On M: each line she wrote is a tombstone of her own ("This
 *     message was deleted", removedBy her key, accountDeleted), the line the convenor removed keeps the convenor's name,
 *     her photos' rows and stored objects are gone, Bo's photo and every line of Bo's and Cy's are exactly as they were.
 *     The WAL is empty, and neither state.db nor state.db-wal holds a byte of her words, her DM ciphertext or her photo.
 *  4. Bo's phone syncs as the app does (the conversation list, then each conversation): exactly her lines come back
 *     changed, each a tombstone the app's merge takes; her DM lines older than the newest 50 come back in no page, and
 *     the conversation list names her as deleted (`deletedAccounts`), so the app blanks them itself
 *     (apps/native/utils/db.ts blankLinesOfDeletedAccounts); it names nobody else, never a member the community removed
 *     (Dee) and nobody to a member in no chat with her (Gwen). The group, event and enterprise chats read "This message
 *     was deleted" for her lines; her photo is gone from the attachment route, Bo's is not.
 *  5. S's next pull (a delta) makes its lines M's: the tombstones, never her words.
 *  6. A new standby S2 copies M afterwards: its rows are M's, and its files hold none of her words.
 *  7. Cy deletes his account while a reader holds M's WAL (a copy being served to a standby): the delete answers at once,
 *     not after the 5-second busy timeout, and the WAL is emptied once the reader lets go.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-delete-blanks-chat.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';
import { setMemberPhoto } from '@beanpool/engine';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Blank-Chat-Main-Pw-6612!';
const PW_STANDBY = 'Blank-Chat-Standby-Pw-3307!';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DELETED_TEXT = 'This message was deleted';

/** Rhea's words, each found nowhere else. None may be read, or found in a file, after she deletes her account. */
const WORDS = {
    group: 'Quillomere seeds are in the shed',
    reply: 'Vandrelle says the tomatoes split',
    reacted: 'Ostrevain compost by Friday',
    repliedTo: 'Pemberlook ladder is free to borrow',
    removed: 'Thrennick rant the convenor took down',
    enterprise: 'Grollimer flour is short this week',
    event: 'Saffington cakes for the picnic',
};
/** Cy's one line, in the group chat; he deletes his account in section 7. */
const CY_WORDS = 'Morravel tools in the hall';

// ── The node processes' commands ───────────────────────────────────────────────────────────

const quiet = { broadcast: () => 0, dispatchPushNotification: () => {}, registerVisitor: () => {} } as any;
let reader: any = null;

async function child(): Promise<void> {
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; gwen: string; members: [string, string][] }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            se.seedGenesisMember(a.gwen, 'Gwen');
            setReplicationToken(a.replicationToken);
            for (const [key, name] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, updated_at)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
                    .run(key, name, a.gwen, `INV-${name}`);
                setMemberPhoto(db, key, AVATAR);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            return true;
        },
        /** Section 1's chats. Returns the ids the orchestrator checks, and Rhea's DM ciphertexts and photo bytes. */
        'chat-fixture': async (a: { rhea: string; bo: string; cy: string; words: typeof WORDS; cyWords: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            const { postGroupThreadMessage, removeGroupThreadMessage } = await import('./engine/group-thread.js');
            const { postEnterpriseThreadMessage } = await import('./engine/enterprise-thread.js');
            const { postEventThreadMessage } = await import('./engine/event-thread.js');
            const { rsvpEvent } = await import('./engine/posts.js');
            const { sendMessage, toggleMessageReaction } = await import('./engine/messaging.js');
            const { rhea, bo, cy, words } = a;

            const group = se.createGroup({ name: 'Seed Savers', joinPolicy: 'open', createdBy: bo });
            se.joinGroup(group.id, rhea);
            se.joinGroup(group.id, cy);
            const g1 = postGroupThreadMessage(quiet, group.id, rhea, words.group);
            const boLine = postGroupThreadMessage(quiet, group.id, bo, 'Thanks, I will pick some up');
            const reply = postGroupThreadMessage(quiet, group.id, rhea, words.reply, undefined, boLine.id);
            const reacted = postGroupThreadMessage(quiet, group.id, rhea, words.reacted);
            toggleMessageReaction(quiet, reacted.id, bo, '👍');
            const repliedTo = postGroupThreadMessage(quiet, group.id, rhea, words.repliedTo);
            const boReply = postGroupThreadMessage(quiet, group.id, bo, 'Can I have it Sunday?', undefined, repliedTo.id);
            const removed = postGroupThreadMessage(quiet, group.id, rhea, words.removed);
            removeGroupThreadMessage(quiet, group.id, removed.id, bo);
            const cyLine = postGroupThreadMessage(quiet, group.id, cy, a.cyWords);

            const bakery = se.createTreasury('Village Bakery', AVATAR, 0).publicKey;
            se.adminAssignTreasuryOperator(bakery, bo, 'admin');
            const ent = postEnterpriseThreadMessage(quiet, bakery, rhea, words.enterprise);
            const boEnt = postEnterpriseThreadMessage(quiet, bakery, bo, 'We will bake rye instead');

            const ev = se.createPost('event', 'community', 'Riverside picnic', 'Bring a rug', 0, 'fixed', bo, -28.5, 153.5, [], false, undefined, false,
                { eventStartAt: new Date(Date.now() + 24 * 3600_000).toISOString(), eventPlaceName: 'The river bank' })!;
            rsvpEvent(() => { }, ev.id, rhea, 'going');
            const evLine = postEventThreadMessage(quiet, ev.id, rhea, words.event);
            const boEv = postEventThreadMessage(quiet, ev.id, bo, 'I will bring the urn');

            // Chats where her line is the LAST one, so the Talk list's preview is hers (nobody writes after her).
            const bakery2 = se.createTreasury('Corner Shop', AVATAR, 0).publicKey;
            se.adminAssignTreasuryOperator(bakery2, bo, 'admin');
            const lastEnt = postEnterpriseThreadMessage(quiet, bakery2, rhea, words.enterprise);
            const ev2 = se.createPost('event', 'community', 'Quiet tea', 'Bring a cup', 0, 'fixed', bo, -28.5, 153.5, [], false, undefined, false,
                { eventStartAt: new Date(Date.now() + 48 * 3600_000).toISOString(), eventPlaceName: 'The hall' })!;
            rsvpEvent(() => { }, ev2.id, rhea, 'going');
            const lastEv = postEventThreadMessage(quiet, ev2.id, rhea, words.event);

            const dm = se.createConversation('dm', [rhea, bo], rhea)!;
            const t1 = lockedDm(48);
            const dmText = sendMessage(quiet, dm.id, rhea, t1.ciphertext, t1.nonce)!;
            const cap = lockedDm(24);
            const photo = lockedDm(96);
            const dmPhoto = sendMessage(quiet, dm.id, rhea, cap.ciphertext, cap.nonce, 'image', { data: photo.ciphertext, nonce: photo.nonce })!;
            // A photo in the old form, its ciphertext in the row itself (before the image store).
            const old = lockedDm(48);
            const oldPhotoData = lockedDm(80).ciphertext;
            const dmOld = sendMessage(quiet, dm.id, rhea, old.ciphertext, old.nonce, 'image')!;
            db.prepare(`INSERT INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, ?, ?, 'image/jpeg', NULL)`)
                .run(dmOld.id, oldPhotoData, lockedDm().nonce);
            const bt = lockedDm(48);
            const boDm = sendMessage(quiet, dm.id, bo, bt.ciphertext, bt.nonce)!;
            const bcap = lockedDm(24);
            const boPhotoBytes = lockedDm(96);
            const boPhoto = sendMessage(quiet, dm.id, bo, bcap.ciphertext, bcap.nonce, 'image', { data: boPhotoBytes.ciphertext, nonce: boPhotoBytes.nonce })!;

            return {
                groupId: group.id, bakery, eventId: ev.id, dmId: dm.id,
                rheaLines: [g1.id, reply.id, reacted.id, repliedTo.id, ent.id, evLine.id, dmText.id, dmPhoto.id, dmOld.id, lastEnt.id, lastEv.id],
                lastEntId: bakery2, lastEvId: ev2.id,
                rheaRemovedByConvenor: removed.id,
                othersLines: [boLine.id, boReply.id, cyLine.id, boEnt.id, boEv.id, boDm.id, boPhoto.id],
                rheaPhotos: [dmPhoto.id, dmOld.id], boPhoto: boPhoto.id, cyLine: cyLine.id,
                // What of hers sits in the database as bytes: her DM ciphertexts and her photos.
                rheaSecrets: [t1.ciphertext, cap.ciphertext, photo.ciphertext, old.ciphertext, oldPhotoData],
                boSecrets: [bt.ciphertext, bcap.ciphertext],
            };
        },
        /** Dee, in a DM with Bo, removed by the community (adminPruneUser): her lines stay, and she is no deleted account. */
        'removed-member': async (a: { dee: string; bo: string }) => {
            const se = await import('./state-engine.js');
            const { sendMessage } = await import('./engine/messaging.js');
            const dm = se.createConversation('dm', [a.dee, a.bo], a.dee)!;
            const t = lockedDm(24);
            sendMessage(quiet, dm.id, a.dee, t.ciphertext, t.nonce);
            se.adminPruneUser(a.dee, 'owner:password');
            return { dmId: dm.id, status: se.getMember(a.dee)?.status ?? null };
        },
        /** Eli, an active member, in a DM with Bo: the conversation a forged tombstone line is sent into. */
        'forger-dm': async (a: { eli: string; bo: string }) => {
            const se = await import('./state-engine.js');
            return se.createConversation('dm', [a.eli, a.bo], a.eli)!.id;
        },
        /** After Bo's phone synced once: Bo writes 55 more DM lines, then Rhea one. Her first DM lines are now older than the newest 50. */
        'dm-more': async (a: { rhea: string; bo: string; dmId: string }) => {
            const { sendMessage } = await import('./engine/messaging.js');
            const boIds: string[] = [];
            for (let i = 0; i < 55; i++) { const t = lockedDm(24); boIds.push(sendMessage(quiet, a.dmId, a.bo, t.ciphertext, t.nonce)!.id); }
            const t = lockedDm(48);
            const rheaNewest = sendMessage(quiet, a.dmId, a.rhea, t.ciphertext, t.nonce)!;
            return { boIds, rheaNewest: rheaNewest.id, secret: t.ciphertext };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        pull: async () => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
        },
        /** Every chat line, every column, and the photos: their rows and the objects in the store. */
        messages: async () => {
            const { db } = await import('./db/db.js');
            const { getImageStore } = await import('./storage/image-store.js');
            return {
                rows: db.prepare(`SELECT id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp, edited_at, updated_at
                                  FROM messages ORDER BY id`).all(),
                attachments: db.prepare('SELECT message_id, storage_key, data IS NOT NULL AS inline FROM message_attachments ORDER BY message_id').all(),
                objects: getImageStore().list('attachments/'),
            };
        },
        /** The database's own files: the WAL's size, and which of `needles` each holds, byte for byte. Checkpoints nothing. */
        files: async (a: { needles: string[] }) => {
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f)); } catch { return Buffer.alloc(0); } };
            const dbBytes = read('state.db');
            const wal = read('state.db-wal');
            return {
                walBytes: wal.length,
                inDb: a.needles.filter((n) => dbBytes.includes(Buffer.from(n, 'utf8'))),
                inWal: a.needles.filter((n) => wal.includes(Buffer.from(n, 'utf8'))),
            };
        },
        /** A second connection holding a read transaction on the WAL, as a copy being served to a standby does. */
        'hold-reader': async () => {
            const Database = (await import('better-sqlite3')).default;
            reader = new Database(path.join(process.env.BEANPOOL_DATA_DIR!, 'state.db'), { readonly: true, fileMustExist: true });
            reader.prepare('BEGIN').run();
            return (reader.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
        },
        'release-reader': async () => {
            reader?.prepare('COMMIT').run();
            reader?.close();
            reader = null;
            return true;
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Answer { status: number; body: any; text: string }

/** A call to a node's real HTTPS server, signed by `as`. */
async function api(base: string, method: 'GET' | 'POST', route: string, as: Id, body: unknown = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': as.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), as.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');
const meta = (raw: unknown): any => { try { return JSON.parse(String(raw ?? '{}')) ?? {}; } catch { return {}; } };
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 4).join(' | ')}`);
const brief = (a: Answer) => `${a.status} ${a.text.slice(0, 160)}`;

/** Which of Rhea's words a text gives away, as written or as the base64 a plaintext chat stores. */
function leaks(text: string): string[] {
    return Object.values(WORDS).filter((w) => text.includes(w) || text.includes(b64(w)));
}

/**
 * Bo's phone's message sync, as utils/db.ts syncMessages makes it: the conversation list, then each conversation's lines with
 * NO `limit`, so the server's default applies (the newest 50). Never add a limit here: the app sends none.
 */
async function phoneSync(base: string, who: Id): Promise<{ byId: Map<string, any>; text: string; convs: string[]; deleted: unknown }> {
    const list = await api(base, 'GET', `/api/messages/conversations/${who.pk}`, who);
    require_(list.status === 200 && Array.isArray(list.body?.conversations), `${who.name}'s phone lists its conversations (${brief(list)})`);
    const byId = new Map<string, any>();
    let text = list.text;
    const convs: string[] = [];
    for (const c of list.body.conversations) {
        const r = await api(base, 'GET', `/api/messages/${c.id}`, who);
        if (r.status !== 200) continue;
        convs.push(c.id);
        text += r.text;
        for (const m of r.body.messages ?? []) byId.set(m.id, m);
    }
    return { byId, text, convs, deleted: list.body.deletedAccounts };
}

/** What the phone's diffChangedMessages takes from a sync: a new line, new metadata, a newer edit, or a new tombstone. */
function phoneWouldRewrite(local: any | undefined, incoming: any): boolean {
    if (!local) return true;
    if ((incoming.metadata || null) !== (local.metadata || null)) return true;
    if (incoming.editedAt && incoming.editedAt !== local.editedAt) return true;
    return incoming.type === 'removed' && local.type !== 'removed';
}

type MsgRow = Record<string, any>;
/** Where `b`'s lines differ from `a`'s, column for column. */
function rowsDiff(a: MsgRow[], b: MsgRow[]): string[] {
    const out: string[] = [];
    const bs = new Map(b.map((r) => [r.id, r]));
    for (const r of a) {
        const o = bs.get(r.id);
        if (!o) { out.push(`${String(r.id).slice(0, 8)} missing`); continue; }
        for (const c of Object.keys(r)) {
            if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) out.push(`${String(r.id).slice(0, 8)}.${c}: ${JSON.stringify(r[c])?.slice(0, 40)} vs ${JSON.stringify(o[c])?.slice(0, 40)}`);
        }
    }
    const as = new Set(a.map((r) => r.id));
    for (const id of bs.keys()) if (!as.has(id)) out.push(`${String(id).slice(0, 8)} extra`);
    return out;
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const gwen = newId('Gwen');
    const rhea = newId('Rhea');
    const bo = newId('Bo');
    const cy = newId('Cy');
    const dee = newId('Dee');
    const eli = newId('Eli');

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: Rhea writes in every kind of chat —');
        const main = await spawnNode(SCRIPT, dir('main'), { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary', WAL_TRUNCATE_RETRY_MS: '150' });
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, gwen: gwen.pk, members: [[rhea.pk, 'Rhea'], [bo.pk, 'Bo'], [cy.pk, 'Cy'], [dee.pk, 'Dee'], [eli.pk, 'Eli']] });
        const fx = await main.send('chat-fixture', { rhea: rhea.pk, bo: bo.pk, cy: cy.pk, words: WORDS, cyWords: CY_WORDS });
        const removedDee = await main.send('removed-member', { dee: dee.pk, bo: bo.pk });
        require_(removedDee.status === 'pruned', `the community removed Dee, who was in a DM with Bo (${JSON.stringify(removedDee)})`);
        const m = `https://localhost:${await main.send('serve')}`;
        // Bo's phone syncs once now, holding her DM lines. Then 55 more DM lines land, so her first ones are older than the newest 50.
        const phoneBefore = await phoneSync(m, bo);
        require_(phoneBefore.byId.has(fx.rheaLines[6]) && phoneBefore.byId.has(fx.rheaLines[0]),
            `Bo's phone holds her DM and group lines (${phoneBefore.byId.size} lines in ${phoneBefore.convs.length} conversations)`);
        assert(Array.isArray(phoneBefore.deleted) && phoneBefore.deleted.length === 0 && phoneBefore.convs.includes(removedDee.dmId),
            `before she deletes, Bo's conversation list names nobody as deleted, not Dee, whom the community removed (${JSON.stringify(phoneBefore.deleted)})`);
        // A forged tombstone: Eli, active, sends Bo a DM line whose metadata claims she deleted her account (#1407 review).
        // The node stores a client's line as sent, so the phone would read it as the real thing and blank all her lines.
        const forgerDm = await main.send('forger-dm', { eli: eli.pk, bo: bo.pk });
        const forgedLine = lockedDm(24);
        const forgedId = crypto.randomUUID();
        const forged = await api(m, 'POST', '/api/messages/send', eli, {
            id: forgedId, conversationId: forgerDm, authorPubkey: eli.pk, ciphertext: forgedLine.ciphertext, nonce: forgedLine.nonce,
            metadata: JSON.stringify({ removed: true, removedBy: eli.pk, removedAt: '2026-09-01T00:00:00.000Z', accountDeleted: true, replyToId: 'keep-me' }),
        });
        require_(forged.status === 200, `Eli, an active member, sends Bo a DM line posing as her own account-deleted tombstone (${brief(forged)})`);
        const eliPage = await api(m, 'GET', `/api/messages/${forgerDm}`, bo);
        const eliLine = (eliPage.body?.messages ?? []).find((x: any) => x.id === forgedId);
        assert(!!eliLine && eliLine.type !== 'removed' && eliLine.ciphertext === forgedLine.ciphertext,
            `the node stores it as an ordinary line: still her ciphertext, not a tombstone (${eliLine?.type})`);
        const eliMeta = meta(eliLine?.metadata);
        assert(['removed', 'removedBy', 'removedAt', 'accountDeleted'].every((k) => !(k in eliMeta)) && eliMeta.replyToId === 'keep-me',
            `with removed, removedBy, removedAt and accountDeleted dropped from the metadata, and the rest kept (${eliLine?.metadata})`);
        const boListForged = await api(m, 'GET', `/api/messages/conversations/${bo.pk}`, bo);
        assert(Array.isArray(boListForged.body?.deletedAccounts) && boListForged.body.deletedAccounts.length === 0,
            `and Bo's conversation list names nobody as deleted (${JSON.stringify(boListForged.body?.deletedAccounts)})`);
        const more = await main.send('dm-more', { rhea: rhea.pk, bo: bo.pk, dmId: fx.dmId });
        fx.rheaLines.push(more.rheaNewest);
        fx.othersLines.push(...more.boIds);
        fx.rheaSecrets.push(more.secret);
        const before = await main.send('messages');
        const rowBefore = new Map<string, MsgRow>(before.rows.map((r: MsgRow) => [r.id, r]));
        require_(fx.rheaLines.every((id: string) => rowBefore.get(id)?.type !== 'removed' && rowBefore.get(id)?.author_pubkey === rhea.pk),
            `Rhea has ${fx.rheaLines.length} lines up: group, enterprise, event and DM`);
        require_(rowBefore.get(fx.rheaRemovedByConvenor)?.type === 'removed' && meta(rowBefore.get(fx.rheaRemovedByConvenor)?.metadata).removedBy === bo.pk,
            'and one the convenor took down');
        require_(fx.rheaPhotos.every((id: string) => before.attachments.some((x: any) => x.message_id === id))
            && before.attachments.some((x: any) => x.message_id === fx.rheaPhotos[1] && x.inline === 1)
            && before.objects.length === 2,
            `her two photos are stored, one in the image store and one in its row; Bo's too (${JSON.stringify(before.attachments)}; ${before.objects.length} objects)`);
        require_(meta(rowBefore.get(fx.rheaLines[2])?.metadata).reactions && meta(rowBefore.get(fx.rheaLines[1])?.metadata).replyToId,
            'a line of hers carries Bo\'s reaction, another her reply to Bo');
        const needles = [...Object.values(WORDS).map(b64), ...fx.rheaSecrets];
        const filesBefore = await main.send('files', { needles });
        require_(filesBefore.inDb.length + filesBefore.inWal.length > 0, `M's files hold her words before (${first([...filesBefore.inDb, ...filesBefore.inWal])})`);
        const groupBefore = await api(m, 'GET', `/api/groups/${fx.groupId}/chat?limit=100`, bo);
        const eventBefore = await api(m, 'GET', `/api/marketplace/posts/${fx.eventId}/chat?limit=100`, bo);
        const entBefore = await api(m, 'GET', `/api/enterprise/${fx.bakery}/thread?limit=100`, bo);
        require_([WORDS.group, WORDS.reply, WORDS.reacted, WORDS.repliedTo].every((w) => leaks(groupBefore.text).includes(w))
            && leaks(eventBefore.text).includes(WORDS.event) && leaks(entBefore.text).includes(WORDS.enterprise),
            `the group, event and enterprise chats show her words to Bo (${brief(groupBefore)}; ${brief(eventBefore)}; ${brief(entBefore)})`);

        // ── 2. S copies M ──
        console.log('\n— 2. the standby S copies M —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dir('standby'), { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `S copies M (${JSON.stringify(seeded)})`);
        const sBefore = await standby.send('messages');
        require_(rowsDiff(before.rows, sBefore.rows).length === 0, `S holds her lines exactly as M does (${first(rowsDiff(before.rows, sBefore.rows))})`);

        // ── 3. Rhea deletes ──
        console.log('\n— 3. Rhea deletes her account —');
        await new Promise((r) => setTimeout(r, 5)); // so each tombstone's stamp is after the lines' own
        const purged = await api(m, 'POST', '/api/member/purge', rhea);
        require_(purged.status === 200 && purged.body?.ok === true, `M deletes her account (${brief(purged)})`);
        const after = await main.send('messages');
        const rowAfter = new Map<string, MsgRow>(after.rows.map((r: MsgRow) => [r.id, r]));
        const notBlank = fx.rheaLines.filter((id: string) => {
            const r = rowAfter.get(id);
            const md = meta(r?.metadata);
            return !(r && r.type === 'removed' && r.nonce === 'plaintext-v1' && decode(r.ciphertext) === DELETED_TEXT
                && md.removed === true && md.removedBy === rhea.pk && md.accountDeleted === true);
        });
        assert(notBlank.length === 0, `every line she wrote, in the group, enterprise and event chats and the DM, is her own tombstone reading "${DELETED_TEXT}" (not: ${first(notBlank)})`);
        assert(fx.rheaLines.every((id: string) => { const md = meta(rowAfter.get(id)?.metadata); return !md.reactions && !md.replyToId && !md.mentions; }),
            'with no reaction, reply or mention left on any');
        assert(fx.rheaLines.every((id: string) => rowAfter.get(id)?.updated_at > rowBefore.get(id)?.updated_at),
            'and each one stamped anew, so a standby\'s next pull and a phone\'s next sync carry it');
        assert(fx.rheaLines.every((id: string) => ['conversation_id', 'author_pubkey', 'timestamp'].every((c) => rowAfter.get(id)?.[c] === rowBefore.get(id)?.[c])),
            'each stays where it was in its conversation, under her key, at its time');
        const conv = rowAfter.get(fx.rheaRemovedByConvenor);
        assert(conv?.type === 'removed' && meta(conv.metadata).removedBy === bo.pk && !meta(conv.metadata).accountDeleted
            && JSON.stringify(conv) === JSON.stringify(rowBefore.get(fx.rheaRemovedByConvenor)),
            'the line the convenor took down keeps the convenor\'s name, untouched');
        const othersChanged = fx.othersLines.filter((id: string) => JSON.stringify(rowAfter.get(id)) !== JSON.stringify(rowBefore.get(id)));
        assert(othersChanged.length === 0, `every line of Bo's and Cy's is exactly as it was, every column (changed: ${first(othersChanged)})`);
        const systemChanged = before.rows.filter((r: MsgRow) => r.type === 'system').filter((r: MsgRow) => JSON.stringify(rowAfter.get(r.id)) !== JSON.stringify(r));
        assert(systemChanged.length === 0, 'and so is every system line');
        assert(after.rows.length === before.rows.length, `no line is deleted outright (${before.rows.length} → ${after.rows.length})`);
        assert(!after.attachments.some((x: any) => fx.rheaPhotos.includes(x.message_id)),
            `her photos' rows are gone, the stored one and the old in-row one (${JSON.stringify(after.attachments)})`);
        assert(after.attachments.length === 1 && after.attachments[0].message_id === fx.boPhoto,
            'Bo\'s photo row stays');
        assert(after.objects.length === 1 && !after.objects.some((k: string) => k.includes(fx.rheaPhotos[0])) && after.objects.some((k: string) => k.includes(fx.boPhoto)),
            `her photo's object is gone from the image store, Bo's stays (${JSON.stringify(after.objects)})`);
        const files = await main.send('files', { needles: [...needles, ...fx.boSecrets] });
        assert(files.walBytes === 0, `the WAL is empty once the delete has committed (${files.walBytes} bytes)`);
        const herBytes = [...files.inDb, ...files.inWal].filter((n: string) => needles.includes(n));
        assert(herBytes.length === 0, `neither state.db nor state.db-wal holds a byte of her words, her DM ciphertext or her photos (found: ${first(herBytes)})`);
        assert(fx.boSecrets.every((s: string) => files.inDb.includes(s) || files.inWal.includes(s)),
            'while Bo\'s lines are there, as they should be (the search sees what is there)');

        // ── 4. Bo's phone ──
        console.log('\n— 4. Bo\'s phone syncs —');
        const phoneAfter = await phoneSync(m, bo);
        const rewritten = [...phoneAfter.byId.values()].filter((msg) => phoneBefore.byId.has(msg.id) && phoneWouldRewrite(phoneBefore.byId.get(msg.id), msg)).map((msg) => msg.id as string);
        // The app sends no `limit`, so a sync carries only the newest 50 lines of each conversation. Her lines older than
        // that come back in no page: the conversation list names her instead, and the app blanks every line of hers it holds
        // (apps/native/utils/db.ts blankLinesOfDeletedAccounts, utils/__tests__/deleted-account-lines.test.ts).
        const olderDm = fx.rheaLines.slice(6, 9);
        const newestDm = more.rheaNewest as string;
        assert(olderDm.every((id: string) => phoneBefore.byId.has(id) && !phoneAfter.byId.has(id)),
            'her three first DM lines are on Bo\'s phone from before, and the sync no longer reaches them (older than the newest 50)');
        assert(JSON.stringify(phoneAfter.deleted) === JSON.stringify([rhea.pk]),
            `so Bo's conversation list names her as deleted, and nobody else: not Dee, whom the community removed (${JSON.stringify(phoneAfter.deleted)})`);
        const gwenList = await api(m, 'GET', `/api/messages/conversations/${gwen.pk}`, gwen);
        assert(gwenList.status === 200 && Array.isArray(gwenList.body?.deletedAccounts) && gwenList.body.deletedAccounts.length === 0,
            `and Gwen, in no chat with her, is told of nobody (${brief(gwenList)})`);
        const herOnPhone = fx.rheaLines.filter((id: string) => phoneAfter.byId.has(id));
        assert(herOnPhone.includes(newestDm) && herOnPhone.every((id: string) => rewritten.includes(id) || !phoneBefore.byId.has(id)),
            `her newest DM line, and every line of hers the sync does carry, comes as her tombstone (${herOnPhone.length} of hers; rewritten ${rewritten.length})`);
        assert(rewritten.every((id) => fx.rheaLines.includes(id)), `and nothing else: no line of Bo's or Cy's is rewritten (${first(rewritten.filter((id) => !fx.rheaLines.includes(id)))})`);
        assert(herOnPhone.every((id: string) => {
            const msg = phoneAfter.byId.get(id);
            return msg?.type === 'removed' && msg.nonce === 'plaintext-v1' && meta(msg.metadata).removed === true && meta(msg.metadata).accountDeleted === true;
        }), 'each a tombstone, which the app\'s merge (utils/chat-sync.ts) puts in place of the words it held');
        assert(leaks(phoneAfter.text).length === 0 && !fx.rheaSecrets.some((s: string) => phoneAfter.text.includes(s)),
            `no answer to the phone carries her words or her DM ciphertext (${first(leaks(phoneAfter.text))})`);
        const groupAfter = await api(m, 'GET', `/api/groups/${fx.groupId}/chat?limit=100`, bo);
        const eventAfter = await api(m, 'GET', `/api/marketplace/posts/${fx.eventId}/chat?limit=100`, bo);
        const entAfter = await api(m, 'GET', `/api/enterprise/${fx.bakery}/thread?limit=100`, bo);
        const shown = (a: Answer, id: string) => {
            const msgs = a.body?.messages ?? [];
            const msg = msgs.find((x: any) => x.id === id);
            return msg ? decode(msg.ciphertext) : null;
        };
        assert(leaks(groupAfter.text).length === 0 && leaks(eventAfter.text).length === 0 && leaks(entAfter.text).length === 0,
            `the group, event and enterprise chats show none of her words (${first([...leaks(groupAfter.text), ...leaks(eventAfter.text), ...leaks(entAfter.text)])})`);
        assert(shown(groupAfter, fx.rheaLines[0]) === DELETED_TEXT && shown(eventAfter, fx.rheaLines[5]) === DELETED_TEXT && shown(entAfter, fx.rheaLines[4]) === DELETED_TEXT,
            `each reads "${DELETED_TEXT}" there, not a host's or a keeper's removal (group ${shown(groupAfter, fx.rheaLines[0])}, event ${shown(eventAfter, fx.rheaLines[5])}, enterprise ${shown(entAfter, fx.rheaLines[4])})`);
        assert(shown(groupAfter, fx.othersLines[1]) === 'Can I have it Sunday?' && shown(eventAfter, fx.othersLines[4]) === 'I will bring the urn',
            'and Bo\'s lines read as he wrote them, his reply to her line too');
        // The Talk list (GET /api/your-groups): her line is the LAST one in an event chat and in an enterprise chat.
        const talk = await api(m, 'GET', '/api/your-groups', bo);
        const talkOf = (id: string) => (talk.body?.items ?? []).find((i: any) => i.conversationId === id)?.lastMessage;
        assert(talkOf(fx.lastEvId)?.text === DELETED_TEXT && talkOf(fx.lastEntId)?.text === DELETED_TEXT,
            `the Talk list reads "${DELETED_TEXT}" for her last line in an event chat and in an enterprise chat, never the host's or a keeper's removal (event ${JSON.stringify(talkOf(fx.lastEvId)?.text)}, enterprise ${JSON.stringify(talkOf(fx.lastEntId)?.text)})`);
        const herPhoto = await api(m, 'GET', `/api/messages/${fx.rheaPhotos[0]}/attachment`, bo);
        const herOldPhoto = await api(m, 'GET', `/api/messages/${fx.rheaPhotos[1]}/attachment`, bo);
        const boPhoto = await api(m, 'GET', `/api/messages/${fx.boPhoto}/attachment`, bo);
        assert(herPhoto.status === 404 && herOldPhoto.status === 404, `her photos are gone from the attachment route (${herPhoto.status}, ${herOldPhoto.status})`);
        assert(boPhoto.status === 200, `Bo's is still served (${boPhoto.status})`);

        // ── 5. S's next pull ──
        console.log('\n— 5. S\'s next pull —');
        const pulled = await standby.send('pull');
        assert(pulled.ok && !pulled.whole, `S pulls a delta (${JSON.stringify(pulled)})`);
        const sAfter = await standby.send('messages');
        assert(rowsDiff(after.rows, sAfter.rows).length === 0, `S's lines are M's, every column: her tombstones, never her words (${first(rowsDiff(after.rows, sAfter.rows))})`);
        assert(leaks(JSON.stringify(sAfter.rows)).length === 0 && !fx.rheaSecrets.some((s: string) => JSON.stringify(sAfter.rows).includes(s)),
            'no row on S holds her words or her DM ciphertext');
        const sFiles = await standby.send('files', { needles });
        // Not an empty WAL: the puller writes its own records after the import (its audit row, its status).
        assert(sFiles.inDb.length + sFiles.inWal.length === 0,
            `and S's files hold none of them either: its WAL is emptied once the pull has blanked them (found ${first([...sFiles.inDb, ...sFiles.inWal])}; ${sFiles.walBytes} WAL bytes written since)`);

        // ── 6. A new standby copies M afterwards ──
        console.log('\n— 6. a new standby S2 copies M afterwards —');
        fs.mkdirSync(dir('standby2'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby2'), 'genesis.json'));
        const standby2 = await spawnNode(SCRIPT, dir('standby2'), { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby2);
        await standby2.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const copied = await standby2.send('resync');
        require_(copied.ok, `S2 copies M (${JSON.stringify(copied)})`);
        const s2 = await standby2.send('messages');
        assert(rowsDiff(after.rows, s2.rows).length === 0, `S2's lines are M's, every column (${first(rowsDiff(after.rows, s2.rows))})`);
        const s2Files = await standby2.send('files', { needles });
        assert(s2Files.inDb.length + s2Files.inWal.length === 0, `and S2's files hold none of her words, DM ciphertext or photos (${first([...s2Files.inDb, ...s2Files.inWal])})`);

        // ── 7. A reader holds the WAL ──
        console.log('\n— 7. Cy deletes his account while a reader holds M\'s WAL —');
        require_(await main.send('hold-reader') > 0, 'a second connection opens a read on M, as a copy being served to a standby does');
        const t0 = Date.now();
        const cyPurged = await api(m, 'POST', '/api/member/purge', cy);
        const took = Date.now() - t0;
        require_(cyPurged.status === 200 && cyPurged.body?.ok === true, `M deletes Cy's account (${brief(cyPurged)})`);
        assert(took < 2_000, `the delete answers at once, never waiting out the 5-second busy timeout for the reader (${took} ms)`);
        const cyRow = (await main.send('messages')).rows.find((r: MsgRow) => r.id === fx.cyLine);
        assert(cyRow?.type === 'removed' && meta(cyRow.metadata).accountDeleted === true, 'his line is his own tombstone');
        const boList = await api(m, 'GET', `/api/messages/conversations/${bo.pk}`, bo);
        assert(JSON.stringify(boList.body?.deletedAccounts) === JSON.stringify([cy.pk, rhea.pk].sort()),
            `and Bo's conversation list names him too, from the group chat they share (no DM) (${JSON.stringify(boList.body?.deletedAccounts)})`);
        const held = await main.send('files', { needles: [b64(CY_WORDS)] });
        assert(held.walBytes > 0, `while the reader holds it, the WAL cannot be emptied (${held.walBytes} bytes)`);
        await main.send('release-reader');
        let emptied = -1;
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const f = await main.send('files', { needles: [b64(CY_WORDS)] });
            if (f.walBytes === 0) { emptied = f.inDb.length + f.inWal.length; break; }
        }
        assert(emptied === 0, `once the reader lets go, the next try empties the WAL, and his words are in neither file (${emptied === -1 ? 'never emptied' : `${emptied} found`})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ Delete account blanks every chat line the member wrote and deletes their photos, on the main server, its standbys and phones.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
