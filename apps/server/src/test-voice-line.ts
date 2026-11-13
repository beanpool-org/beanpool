/**
 * Test Suite: voice lines on the node (slice V2: scratch/fable-design/DESIGN-cross-chat-voice-fable.md §5.4, §11 V2;
 * engine/voice-lines.ts). A voice line is type 'voice' with its voice part, sealed by the app as bytes (core sealDmVoice,
 * sealGroupVoice), as its attachment marked audio/mp4.
 *
 * Two processes, each its own data dir (takeover-test-harness.ts), over REAL HTTPS through the real signature middleware,
 * with real Ed25519 identities and parts sealed as the apps seal them. Nothing leaves this machine.
 *
 *  1. Stored: Anna's DM voice line and her group voice line are stored where a photo is (message_attachments, the image
 *     store), counted in her day of photo bytes; Ben and Dan read them back and open them as voice.
 *  2. Refused, and nothing stored (no line, no attachment row, no object, no budget): a readable part, a part over 1.15 MB,
 *     a voice line not marked audio/mp4 or with no part, a photo marked audio/mp4, in a DM and in a group; and over the
 *     day's photo budget.
 *  3. A standby's first copy holds each voice row as M holds it, and each object byte for byte.
 *  4. Reports: Ben reports Anna's DM voice line handing over its voice part (verified under part `voice`, kept); a part
 *     Ben sealed himself is not kept; Dan reports Anna's group voice line with its key and the moderators hear it.
 *  5. After 30 days: the expiry deletes the part (object and attachment row) and the line stays; a line of 29 days and a
 *     line under a pending report keep theirs; the read answers 410 voice_expired to the chat's people, 404 to anyone else;
 *     a withheld line's part goes the same day and its sender reads the same 410. The standby's delta follows: the rows
 *     and objects gone there too, the lines kept. A moderator opening a report on an expired group line reads unavailable.
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-voice-line node scripts/run-server-suites.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import {
    dmPublicKeyOf, groupMessageKey, openDmVoice, openGroupVoice, sealDmLine, sealDmVoice, sealGroupLine, sealGroupVoice,
    VOICE_BARS, VOICE_EXPIRED_CODE, VOICE_MIME, VOICE_SEALED_MAX_BYTES,
} from '@beanpool/core';
import { lockedDm } from './dm-test-payload.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SCRIPT = fileURLToPath(import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node here reaches anything but localhost; what it tried is counted, so the suite can say so. */
function guardFetch(): string[] {
    const blocked: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return blocked;
}

async function child(): Promise<void> {
    const blocked = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { ownerPk: string; replicationToken: string }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const { setMemberPhoto } = await import('@beanpool/engine');
            const { setReplicationToken } = await import('./config/local-config.js');
            se.seedGenesisMember(a.ownerPk, 'Anna');
            setMemberPhoto(db, a.ownerPk, 'bundled://leaf');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            pinMainServerForTests(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        member: async (a: { pk: string; name: string; owner: string }) => {
            const { db } = await import('./db/db.js');
            const { setMemberPhoto } = await import('@beanpool/engine');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active')`).run(a.pk, a.name, a.owner);
            setMemberPhoto(db, a.pk, `https://example.org/${a.name}.jpg`);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.pk);
            return true;
        },
        'make-group': async (a: { name: string; createdBy: string; members: string[] }) => {
            const se = await import('./state-engine.js');
            const g = se.createGroup({ name: a.name, joinPolicy: 'open', createdBy: a.createdBy });
            for (const m of a.members) se.joinGroup(g.id, m);
            return g.id;
        },
        epoch: async (a: { groupId: string }) => {
            const { db } = await import('./db/db.js');
            const { freshGroupEpoch } = await import('./group-test-payload.js');
            return freshGroupEpoch(db, a.groupId);
        },
        block: async (a: { blocker: string; blocked: string }) => {
            const { db } = await import('./db/db.js');
            db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(a.blocker, a.blocked);
            return true;
        },
        /** Each id's line, its attachment row, and the sha256 of the object its row names in this server's store. */
        lines: async (a: { ids: string[] }) => {
            const { db } = await import('./db/db.js');
            const { getImageStore, attachmentKey } = await import('./storage/image-store.js');
            const store = getImageStore();
            return Object.fromEntries(a.ids.map((id) => {
                const line = db.prepare('SELECT id, type, timestamp FROM messages WHERE id = ?').get(id) as any;
                const att = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(id) as any;
                let object: string | null = null;
                try {
                    const bytes = store.get(attachmentKey(id));
                    object = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
                } catch { object = null; }
                return [id, { line: line ?? null, att: att ?? null, object }];
            }));
        },
        withheld: async (a: { id: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('SELECT id, type, attachment_nonce, attachment_mime, storage_key FROM withheld_lines WHERE id = ?').get(a.id) ?? null;
        },
        /** A line `days` old, as if it had been sent then: its own time and the withheld copy's. */
        age: async (a: { id: string; days: number }) => {
            const { db } = await import('./db/db.js');
            const at = new Date(Date.now() - a.days * DAY_MS).toISOString();
            return db.prepare('UPDATE messages SET timestamp = ? WHERE id = ?').run(at, a.id).changes
                + db.prepare('UPDATE withheld_lines SET timestamp = ? WHERE id = ?').run(at, a.id).changes;
        },
        expire: async () => {
            const { expireVoiceOnce } = await import('./engine/voice-lines.js');
            const pass = expireVoiceOnce();
            await new Promise((r) => setTimeout(r, 50)); // the objects go after the commit
            return pass;
        },
        'photo-used': async (a: { pk: string }) => {
            const { getMemberPhotoUsageForTests } = await import('./engine/photo-upload-budget.js');
            return getMemberPhotoUsageForTests(a.pk).usedBytes;
        },
        'photo-budget': async (a: { bytes: string | null }) => {
            if (a.bytes === null) delete process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY;
            else process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = a.bytes;
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return { resync: await requestResync() };
        },
        pull: async () => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
        },
        blocked: async () => blocked,
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

interface Id { pk: string; seedHex: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const seed = crypto.randomBytes(32);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const seedHex = seed.toString('hex');
    return { pk: dmPublicKeyOf(seedHex), seedHex, priv: crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), name };
}

interface Res { status: number; body: any }
/** A signed request to a node's real HTTPS server, through its middleware, as both apps sign one. */
async function call(base: string, method: 'GET' | 'POST', signer: Id, p: string, body?: unknown): Promise<Res> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pk,
        'X-Signature': signRequest(signer.priv, { method, path: p.split('?')[0], timestamp: ts, nonce, body: raw }),
        [SIGNED_FOR_HEADER]: signedForHost(),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}
async function adminGet(base: string, p: string, headers: Record<string, string>): Promise<Res> {
    const res = await fetch(`${base}${p}`, { headers });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

/** An ISO-BMFF box, and the head of an .m4a as an iPhone writes it (`ftyp` M4A, then `mdat`): what core's checks read. */
function box(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
}
function m4a(soundBytes: number): Uint8Array {
    return new Uint8Array(Buffer.concat([
        box('ftyp', Buffer.concat([Buffer.from('M4A '), Buffer.alloc(4), Buffer.from('M4A mp42isom')])),
        box('mdat', crypto.randomBytes(soundBytes)),
    ]));
}
const BARS = Array.from({ length: VOICE_BARS }, (_, i) => (i * 37) % 256);
const sha = (b64: string) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');

interface Sent { id: string; data: string; nonce: string; sound: Uint8Array; body: { ciphertext: string; nonce: string } }

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (role: string) => ({ NODE_ROLE: role, BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const anna = newId('Anna');
    const ben = newId('Ben');
    const cat = newId('Cat');
    const dan = newId('Dan');
    const eve = newId('Eve');

    try {
        // ── 1. Stored ──
        console.log('\n— 1. on M: Anna\'s DM voice line and her group voice line, stored where a photo is —');
        const main = await spawnNode(SCRIPT, dirs.main, env('primary'));
        nodes.push(main);
        await main.send('setup-primary', { ownerPk: anna.pk, replicationToken });
        const mainPeerId = main.ready.peerId;
        for (const m of [ben, cat, dan, eve]) await main.send('member', { pk: m.pk, name: m.name, owner: anna.pk });
        const M = `https://localhost:${await main.send('serve')}`;

        const convo = await call(M, 'POST', anna, '/api/messages/conversation', { type: 'dm', participants: [anna.pk, ben.pk], createdBy: anna.pk });
        const convoId: string = convo.body?.conversation?.id ?? convo.body?.id;
        require_(convo.status < 300 && !!convoId, `Anna opens a DM with Ben (${show(convo)})`);
        // Ben answers, so the conversation is no request waiting for him.
        const benLine = await call(M, 'POST', ben, '/api/messages/send', { conversationId: convoId, authorPubkey: ben.pk, ...lockedDm(), id: crypto.randomUUID() });
        require_(benLine.status < 300, `Ben answers (${show(benLine)})`);

        const sealDm = (from: Id, to: Id, convId: string, soundBytes = 4000): Sent => {
            const id = crypto.randomUUID();
            const sound = m4a(soundBytes);
            const ctx = { myEdPrivHex: from.seedHex, peerEdPubHex: to.pk, conversationId: convId };
            const voice = sealDmVoice({ durationMs: 42_000, bars: BARS, sound }, ctx, { senderPubHex: from.pk, messageId: id });
            const body = sealDmLine('', ctx, { senderPubHex: from.pk, messageId: id, part: 'body' });
            return { id, data: voice.ciphertext, nonce: voice.nonce, sound, body };
        };
        const sendDm = (from: Id, s: Sent, extra: Record<string, unknown> = {}, convId = convoId) => call(M, 'POST', from, '/api/messages/send', {
            conversationId: convId, authorPubkey: from.pk, ...s.body, type: 'voice', id: s.id,
            attachment: { data: s.data, nonce: s.nonce, mime: VOICE_MIME }, ...extra,
        });
        const usedBefore: number = await main.send('photo-used', { pk: anna.pk });
        const dmVoice = sealDm(anna, ben, convoId);
        const sentDm = await sendDm(anna, dmVoice);
        require_(sentDm.status === 200 && sentDm.body?.message?.type === 'voice', `Anna sends a DM voice line: stored as type 'voice' (${show(sentDm)})`);
        const onM1 = (await main.send('lines', { ids: [dmVoice.id] }))[dmVoice.id];
        assert(onM1.att?.mime === VOICE_MIME && onM1.att?.data === null && onM1.att?.storage_key === `attachments/${dmVoice.id}.bin`
            && onM1.att?.sha256 === sha(dmVoice.data) && onM1.object === sha(dmVoice.data),
        `its part is in the image store, its row marked audio/mp4 and naming the object's sha256 (${JSON.stringify(onM1.att).slice(0, 160)})`);
        const usedAfter: number = await main.send('photo-used', { pk: anna.pk });
        assert(usedAfter - usedBefore === Buffer.from(dmVoice.data, 'base64').length,
            `it counts in Anna's day of photo bytes (${usedAfter - usedBefore} bytes)`);
        const benReads = await call(M, 'GET', ben, `/api/messages/${dmVoice.id}/attachment`);
        let benOpens = false;
        try {
            const v = openDmVoice({ ciphertext: benReads.body?.data, nonce: benReads.body?.nonce }, { myEdPrivHex: ben.seedHex, peerEdPubHex: anna.pk },
                { conversationId: convoId, senderPubHex: anna.pk, messageId: dmVoice.id });
            benOpens = v.durationMs === 42_000 && Buffer.from(v.sound).equals(Buffer.from(dmVoice.sound));
        } catch { benOpens = false; }
        assert(benReads.status === 200 && benReads.body?.mime === VOICE_MIME && benOpens,
            `Ben reads it back and opens it as Anna's voice message, 0:42, the sound as recorded (${benReads.status})`);

        const groupId: string = await main.send('make-group', { name: 'Garden Crew', createdBy: anna.pk, members: [dan.pk] });
        const groupKey = new Uint8Array(crypto.randomBytes(32)); // the members' key: the node never sees it
        const sealGroup = async (from: Id) => {
            const epoch: number = await main.send('epoch', { groupId });
            const id = crypto.randomUUID();
            const base = { myEdPrivHex: from.seedHex, groupKey, groupId, epoch, messageId: id, after: null, replyToId: null };
            const sound = m4a(3000);
            const voice = sealGroupVoice({ durationMs: 42_000, bars: BARS, sound }, base);
            const body = sealGroupLine('', { ...base, part: 'body' });
            return { id, epoch, data: voice.ciphertext, nonce: voice.nonce, sound, body: { ciphertext: body.ciphertext, nonce: body.nonce } };
        };
        const sendGroup = (from: Id, s: Awaited<ReturnType<typeof sealGroup>>, extra: Record<string, unknown> = {}) =>
            call(M, 'POST', from, `/api/groups/${groupId}/chat/message`, {
                type: 'voice', ...s.body, metadata: JSON.stringify({ epoch: s.epoch }), clientId: s.id,
                attachment: { data: s.data, nonce: s.nonce, mime: VOICE_MIME }, ...extra,
            });
        const gVoice = await sealGroup(anna);
        const sentG = await sendGroup(anna, gVoice);
        require_(sentG.status === 201 && sentG.body?.message?.type === 'voice', `Anna sends a group voice line: stored as type 'voice' (${show(sentG)})`);
        const danReads = await call(M, 'GET', dan, `/api/messages/${gVoice.id}/attachment`);
        let danOpens = false;
        try {
            const v = openGroupVoice({ ciphertext: danReads.body?.data, nonce: danReads.body?.nonce },
                { groupId, epoch: gVoice.epoch, senderPubHex: anna.pk, messageId: gVoice.id, replyToId: null }, groupKey);
            danOpens = Buffer.from(v.sound).equals(Buffer.from(gVoice.sound));
        } catch { danOpens = false; }
        assert(danReads.status === 200 && danReads.body?.mime === VOICE_MIME && danOpens, `Dan reads it back and opens it as Anna's voice message (${danReads.status})`);

        // ── 2. Refused, nothing stored ──
        console.log('\n— 2. refused, and nothing stored: readable, over 1.15 MB, not marked audio/mp4, no part; over the day\'s budget —');
        const nothingStored = async (ids: string[]) => {
            const got = await main.send('lines', { ids });
            return ids.every((id) => got[id].line === null && got[id].att === null && got[id].object === null);
        };
        const readable = sealDm(anna, ben, convoId);
        const plain = Buffer.from(readable.sound).toString('base64');
        const usedBeforeRefusals: number = await main.send('photo-used', { pk: anna.pk });
        const dmRefusals: Array<[string, Res, string]> = [];
        const tryDm = async (label: string, s: Sent, attachment: unknown, code: string, type = 'voice') => {
            const r = await call(M, 'POST', anna, '/api/messages/send', { conversationId: convoId, authorPubkey: anna.pk, ...s.body, type, id: s.id, attachment });
            dmRefusals.push([label, r, code]);
            return s.id;
        };
        const asPart = (sealed: { ciphertext: string; nonce: string }, mime: string) => ({ data: sealed.ciphertext, nonce: sealed.nonce, mime });
        const dmIds = [
            await tryDm('a readable part', readable, { data: plain, nonce: 'plaintext-v1', mime: VOICE_MIME }, 'dm_not_encrypted'),
            await tryDm('a part over 1.15 MB', sealDm(anna, ben, convoId), asPart(lockedDm(VOICE_SEALED_MAX_BYTES * 3 / 4), VOICE_MIME), 'voice_too_large'),
            await tryDm('a voice part marked image/jpeg', sealDm(anna, ben, convoId), { data: dmVoice.data, nonce: dmVoice.nonce, mime: 'image/jpeg' }, 'voice_line_form'),
            await tryDm('a voice line with no part', sealDm(anna, ben, convoId), undefined, 'voice_line_form'),
            await tryDm('a photo marked audio/mp4', sealDm(anna, ben, convoId), asPart(lockedDm(2000), VOICE_MIME), 'voice_line_form', 'image'),
        ];
        for (const [label, r, code] of dmRefusals) {
            assert(r.status === 400 && r.body?.code === code, `DM: ${label} → 400 ${code} (${show(r)})`);
        }
        assert(await nothingStored(dmIds), `DM: none of the ${dmIds.length} refused lines left a line, an attachment row or an object`);

        const gRefusals: Array<[string, Res, string]> = [];
        const gIds: string[] = [];
        for (const [label, attachment, code, type] of [
            ['a readable part', { data: plain, nonce: 'plaintext-v1', mime: VOICE_MIME }, 'not_encrypted', 'voice'],
            ['a part over 1.15 MB', { data: 'A'.repeat(VOICE_SEALED_MAX_BYTES + 4), nonce: gVoice.nonce, mime: VOICE_MIME }, 'voice_too_large', 'voice'],
            ['a voice part marked image/jpeg', { data: gVoice.data, nonce: gVoice.nonce, mime: 'image/jpeg' }, 'voice_line_form', 'voice'],
            ['a photo marked audio/mp4', { data: gVoice.data, nonce: gVoice.nonce, mime: VOICE_MIME }, 'voice_line_form', 'image'],
        ] as Array<[string, unknown, string, string]>) {
            const s = await sealGroup(anna);
            gIds.push(s.id);
            gRefusals.push([label, await sendGroup(anna, s, { attachment, type }), code]);
        }
        for (const [label, r, code] of gRefusals) assert(r.status === 400 && r.body?.code === code, `group: ${label} → 400 ${code} (${show(r)})`);
        assert(await nothingStored(gIds), `group: none of the ${gIds.length} refused lines left a line, an attachment row or an object`);
        const usedAfterRefusals: number = await main.send('photo-used', { pk: anna.pk });
        assert(usedAfterRefusals === usedBeforeRefusals, `no refused line counted in Anna's day of photo bytes (${usedAfterRefusals - usedBeforeRefusals})`);

        await main.send('photo-budget', { bytes: String(usedAfterRefusals + 1000) });
        const overBudget = sealDm(anna, ben, convoId);
        const overR = await sendDm(anna, overBudget);
        const overG = await sealGroup(anna);
        const overGR = await sendGroup(anna, overG);
        await main.send('photo-budget', { bytes: null });
        assert(overR.status === 429 && overGR.status === 429, `over the day's photo budget, a voice line is refused 429 in a DM and a group (${show(overR)} | ${show(overGR)})`);
        assert(await nothingStored([overBudget.id, overG.id]), 'and neither left anything stored');

        // The lines the expiry is tried on: one 31 days old in each chat, one of 29 days, one under a pending report; one
        // withheld (Eve, blocked by Cat, sends Cat one).
        const dmOld = sealDm(anna, ben, convoId);
        const dm29 = sealDm(anna, ben, convoId);
        const dmReported = sealDm(anna, ben, convoId);
        for (const s of [dmOld, dm29, dmReported]) require_((await sendDm(anna, s)).status === 200, 'Anna sends another DM voice line');
        const gOld = await sealGroup(anna);
        require_((await sendGroup(anna, gOld)).status === 201, 'Anna sends another group voice line');
        const eveConvo = await call(M, 'POST', eve, '/api/messages/conversation', { type: 'dm', participants: [eve.pk, cat.pk], createdBy: eve.pk });
        const eveConvoId: string = eveConvo.body?.conversation?.id ?? eveConvo.body?.id;
        require_(eveConvo.status < 300 && !!eveConvoId, `Eve opens a DM with Cat (${show(eveConvo)})`);
        await main.send('block', { blocker: cat.pk, blocked: eve.pk });
        const eveOld = sealDm(eve, cat, eveConvoId);
        const eveSent = await sendDm(eve, eveOld, {}, eveConvoId);
        const eveWithheld = await main.send('withheld', { id: eveOld.id });
        require_(eveSent.status === 200 && eveWithheld?.type === 'voice' && eveWithheld?.attachment_mime === VOICE_MIME,
            `Eve's voice line to Cat, who blocked her, is answered as stored and kept for Eve alone (${show(eveSent)})`);

        // ── 3. A standby's first copy ──
        console.log("\n— 3. S's first copy: each voice row as M holds it, and each object byte for byte —");
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        const standby = await spawnNode(SCRIPT, dirs.standby, env('backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
        const first = await standby.send('resync');
        require_(first.resync.ok, `S: the first copy (${JSON.stringify(first.resync).slice(0, 160)})`);
        const voiceIds = [dmVoice.id, gVoice.id, dmOld.id, dm29.id, dmReported.id, gOld.id];
        const mRows = await main.send('lines', { ids: voiceIds });
        const sRows = await standby.send('lines', { ids: voiceIds });
        assert(voiceIds.every((id) => sRows[id].line?.type === 'voice' && JSON.stringify(sRows[id].att) === JSON.stringify(mRows[id].att)),
            `S holds all ${voiceIds.length} voice lines, and each attachment row as M holds it, stamps included`);
        assert(voiceIds.every((id) => sRows[id].object !== null && sRows[id].object === mRows[id].object && sRows[id].object === mRows[id].att?.sha256),
            `and each voice part's object, byte for byte (sha256 equal on M and S: ${voiceIds.filter((id) => sRows[id].object === mRows[id].object).length}/${voiceIds.length})`);

        // ── 4. Reports ──
        console.log('\n— 4. reports: a DM voice line with its part, verified as `voice`; a group voice line heard by the moderators —');
        const reportDm = (s: Sent, voice?: { ciphertext: string; nonce: string }) => call(M, 'POST', ben, '/api/messages/report', {
            messageId: s.id, reason: 'Harassment',
            disclosure: { v: 1, ...s.body, conversationId: convoId, words: '(a voice message)', ...(voice ? { voice } : {}) },
        });
        const repDm = await reportDm(dmReported, { ciphertext: dmReported.data, nonce: dmReported.nonce });
        require_(repDm.status === 200 && repDm.body?.report?.id, `Ben reports Anna's DM voice line, handing over its voice part (${show(repDm)})`);
        // A part Ben sealed himself, under Anna's line's id.
        const forgedPart = sealDmVoice({ durationMs: 1000, bars: BARS, sound: m4a(500) }, { myEdPrivHex: ben.seedHex, peerEdPubHex: anna.pk, conversationId: convoId },
            { senderPubHex: ben.pk, messageId: dm29.id });
        const repForged = await reportDm(dm29, forgedPart);
        require_(repForged.status === 200 && repForged.body?.report?.id, `Ben reports another, handing over a voice part he sealed himself (${show(repForged)})`);
        const repG = await call(M, 'POST', dan, `/api/groups/${groupId}/chat/report`, {
            messageId: gVoice.id, reason: 'Harassment', disclosure: { epoch: gVoice.epoch, mk: Buffer.from(groupMessageKey(groupKey, gVoice.id)).toString('base64') },
        });
        require_(repG.status === 200 && repG.body?.report?.id, `Dan reports Anna's group voice line with its key (${show(repG)})`);

        const owner: Record<string, string> = await main.send('owner-session');
        const viewDm = await adminGet(M, `/api/local/admin/reports/${repDm.body.report.id}/message`, owner);
        const dmView = viewDm.body?.message ?? viewDm.body;
        assert(viewDm.status === 200 && dmView?.voice?.signature === 'verified' && typeof dmView?.voice?.signedAt === 'string' && dmView?.signature === 'verified',
            `the moderators read the DM report: the voice part verified as Anna's to Ben, signed at a time (${show(viewDm)})`);
        const viewForged = await adminGet(M, `/api/local/admin/reports/${repForged.body.report.id}/message`, owner);
        const forgedView = viewForged.body?.message ?? viewForged.body;
        assert(viewForged.status === 200 && forgedView?.voice === null, `a voice part Anna never signed is not kept with the report (${show(viewForged)})`);
        const viewG = await adminGet(M, `/api/local/admin/reports/${repG.body.report.id}/message`, owner);
        const gView = viewG.body?.message ?? viewG.body;
        const heard = typeof gView?.voice?.dataUri === 'string' && gView.voice.dataUri.startsWith(`data:${VOICE_MIME};base64,`)
            && Buffer.from(gView.voice.dataUri.split(',')[1], 'base64').equals(Buffer.from(gVoice.sound));
        assert(viewG.status === 200 && gView?.voice?.state === 'verified' && gView.voice.durationMs === 42_000 && heard,
            `the moderators open the group report: the voice message verified, 0:42, its sound as recorded (${show(viewG)})`);
        const list = await adminGet(M, '/api/local/admin/reports?status=pending', owner);
        const listed = (list.body?.reports ?? []) as any[];
        assert(listed.find((r) => r.id === repDm.body.report.id)?.directMessage?.voice === true
            && listed.find((r) => r.id === repG.body.report.id)?.groupMessage?.voice === true,
        `the Reports queue marks both as voice lines (${listed.length} listed)`);

        // ── 5. After 30 days ──
        console.log('\n— 5. after 30 days: the part goes and the line stays; 29 days and a reported line keep theirs; the standby follows —');
        for (const [id, days] of [[dmOld.id, 31], [gOld.id, 31], [dm29.id, 29], [dmReported.id, 31], [eveOld.id, 31]] as Array<[string, number]>) {
            require_(await main.send('age', { id, days }) >= 1, `a line made ${days} days old`);
        }
        const pass = await main.send('expire');
        assert(pass.expired === 2 && pass.withheld === 1 && pass.heldForReport === 1,
            `the expiry deletes two stored parts and one withheld part, and keeps the one under a pending report (${JSON.stringify(pass)})`);
        const mExp = await main.send('lines', { ids: [dmOld.id, gOld.id, dm29.id, dmReported.id, dmVoice.id] });
        assert([dmOld.id, gOld.id].every((id) => mExp[id].att === null && mExp[id].object === null),
            'M: the 31-day parts are gone, attachment row and object');
        assert([dmOld.id, gOld.id].every((id) => mExp[id].line?.type === 'voice'), 'M: and their lines stay, type voice, so the chat still shows the bubble');
        assert([dm29.id, dmReported.id, dmVoice.id].every((id) => mExp[id].att !== null && mExp[id].object !== null),
            'M: the 29-day part, the reported part and a new part are kept');
        const eveAfter = await main.send('withheld', { id: eveOld.id });
        assert(eveAfter?.type === 'voice' && eveAfter.storage_key === null && eveAfter.attachment_nonce === null, "M: Eve's withheld line stays, its part gone");
        const again = await main.send('expire');
        assert(again.expired === 0 && again.withheld === 0, `a second pass finds nothing more (${JSON.stringify(again)})`);

        const benOld = await call(M, 'GET', ben, `/api/messages/${dmOld.id}/attachment`);
        const annaOld = await call(M, 'GET', anna, `/api/messages/${dmOld.id}/attachment`);
        const danOld = await call(M, 'GET', dan, `/api/messages/${gOld.id}/attachment`);
        const eveOwn = await call(M, 'GET', eve, `/api/messages/${eveOld.id}/attachment`);
        assert([benOld, annaOld, danOld, eveOwn].every((r) => r.status === 410 && r.body?.code === VOICE_EXPIRED_CODE),
            `its read answers 410 ${VOICE_EXPIRED_CODE} to the chat's people, and to Eve for her withheld line alike (${[benOld, annaOld, danOld, eveOwn].map(show).join(' | ').slice(0, 300)})`);
        const missing = await call(M, 'GET', cat, `/api/messages/${crypto.randomUUID()}/attachment`);
        const catOld = await call(M, 'GET', cat, `/api/messages/${dmOld.id}/attachment`);
        assert(catOld.status === 404 && JSON.stringify(catOld.body) === JSON.stringify(missing.body),
            `to Cat, in neither chat, it is the answer for a missing id (${show(catOld)})`);

        const repGone = await call(M, 'POST', dan, `/api/groups/${groupId}/chat/report`, {
            messageId: gOld.id, reason: 'Spam', disclosure: { epoch: gOld.epoch, mk: Buffer.from(groupMessageKey(groupKey, gOld.id)).toString('base64') },
        });
        require_(repGone.status === 200, `Dan reports the expired group voice line (${show(repGone)})`);
        const viewGone = await adminGet(M, `/api/local/admin/reports/${repGone.body.report.id}/message`, owner);
        const goneView = viewGone.body?.message ?? viewGone.body;
        assert(goneView?.voice?.state === 'unavailable' && goneView?.words?.state === 'verified',
            `the moderators read its words verified and its voice unavailable: the server no longer has it (${show(viewGone)})`);

        const delta = await standby.send('pull');
        require_(delta.ok, `S pulls (${delta.whole ? 'whole' : 'delta'}: ${JSON.stringify(delta).slice(0, 160)})`);
        const sExp = await standby.send('lines', { ids: [dmOld.id, gOld.id, dm29.id, dmReported.id, dmVoice.id] });
        assert([dmOld.id, gOld.id].every((id) => sExp[id].att === null && sExp[id].object === null),
            `S: the expired parts' rows and objects are gone there too (${[dmOld.id, gOld.id].filter((id) => sExp[id].att !== null || sExp[id].object !== null).length} left)`);
        assert([dmOld.id, gOld.id].every((id) => sExp[id].line?.type === 'voice'), 'S: and their lines stay');
        assert([dm29.id, dmReported.id, dmVoice.id].every((id) => sExp[id].att !== null && sExp[id].object === mExp[id].object),
            "S: the kept parts are still there, byte for byte as M's");

        const blocked = [...await main.send('blocked'), ...await standby.send('blocked')];
        assert(blocked.length === 0, `nothing reached off this machine (refused: ${blocked.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill().catch(() => {});
    }

    console.log(`\n${testsPassed}/${testsRun} passed`);
    if (testsPassed !== testsRun) process.exit(1);
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error(e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error(e?.output ? `${e.message}\n--- node output ---\n${e.output}` : e);
        console.log(`\n${testsPassed}/${testsRun} passed`);
        process.exit(1);
    });
}
