/**
 * Photos in a group chat, the node's side (group chat photos S2: scratch/fable-design/DESIGN-group-chat-photos-fable.md §2,
 * §3, §5). Over REAL HTTPS through the real signature middleware, with real Ed25519 identities, and every photo sealed on
 * the member's side with @beanpool/core's group line lock (part 'attachment', the caption as part 'body', one message key):
 *
 *   1. a sealed photo line is stored: type 'image', a message_attachments row and the object attachments/<id>.bin, and
 *      served to a member (an observer too) with its data, nonce and mime, which open as the photo that was sealed
 *   2. a readable photo (no group prefix, or a DM's) is 400 not_encrypted, nothing stored; a readable caption with a
 *      sealed photo likewise; a photo line sent as text, or an image line with no photo, is refused
 *   3. a photo over GROUP_PHOTO_MAX_BYTES is 400 with its sentence, no row, no object, the budget untouched; one at the
 *      cap goes
 *   4. the day's photo budget counts it: at the limit 429 with Retry-After, nothing stored; the storage floor is 507
 *   5. a non-member, an outsider and an invitee of an invite-only group (an observer of another group among them), and a
 *      signed-out caller: the attachment answers word for word as a missing id
 *   6. a member whose from_epoch is later than the line's epoch, and a member with no epoch yet: the same
 *   7. a removed member and a leaver: the same for a photo from their time and after; after a re-join the gap's photo
 *      stays a missing id while a new one is served
 *   8. the author's delete and the convenor's removal: a tombstone, the attachment row gone, the object gone, a missing id
 *   9. the old /api/messages/send route stores and refuses exactly as the group route
 *  10. an attachment insert that fails leaves no message row (one transaction), answers a server fault, and the object it
 *      put first is swept by storage-health once past its grace
 *  11. a stale epoch, or one that is not current: 409 with `current`, nothing stored
 *  12. the live update and the chat reads carry type 'image', to the chat's people only; a photo line's push is the text
 *      line's: the same fixed words and kind through Apple's and Google's servers, "sent a message" in its details
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-group-chat-photo node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createGroup, joinGroup, removeGroupMember, setMemberRole, inviteGroupMember,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { setMemberPhoto } from '@beanpool/engine';
import { dmPublicKeyOf, openGroupLine, sealGroupLine } from '@beanpool/core';
import { getImageStore, imagesDir } from './storage/image-store.js';
import { getMemberPhotoUsageForTests, resetPhotoBudgetForTests, setSimulatedFreeDiskBytesForTests } from './engine/photo-upload-budget.js';
import { cleanStorageAndCompressLogs, getStorageCleanPreview } from './engine/storage-health.js';
import { putPushTokenRow } from './services/push-token-seal.js';
import { freshGroupEpoch } from './group-test-payload.js';
import { lockedDm } from './dm-test-payload.js';
// Loaded at run time, so on a server without it (origin/main, the fail-first run) the suite reports a count, not a crash.
const writerLimits: any = await import('./config/writer-limits.js');
const CAP: number = writerLimits.GROUP_PHOTO_MAX_BYTES ?? 768 * 1024;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// ── Expo, stubbed: every push the node hands it, by token; nothing leaves this machine ────────────────────────────
const realFetch = globalThis.fetch;
const expo: { to: string; title: string; body: string; data: any }[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).includes('exp.host')) {
        expo.push(...JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as any;
    }
    return realFetch(url, init);
};

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
    setMemberPhoto(db, id.pk, `https://example.org/${name}.jpg`);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; headers: Record<string, string> }
async function call(method: 'GET' | 'POST', signer: Id | null, p: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = signer.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${p}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, headers: Object.fromEntries(res.headers.entries()) };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

// ── the members' side: one random key per epoch, which the node never sees ────────────────────────────────────────
const epochKeys = new Map<string, Uint8Array>();
const keyFor = (groupId: string, epoch: number): Uint8Array => {
    const k = `${groupId}:${epoch}`;
    if (!epochKeys.has(k)) epochKeys.set(k, new Uint8Array(crypto.randomBytes(32)));
    return epochKeys.get(k)!;
};

/** The base64 length of a sealed photo whose JPEG is `n` bytes: data URI → frame (format, signature, after) → AEAD tag. */
const sealedPhotoChars = (n: number) => 4 * Math.ceil((1 + 64 + 1 + 'data:image/jpeg;base64,'.length + 4 * Math.ceil(n / 3) + 16) / 3);
/** The largest JPEG whose sealed photo is at most `chars` of base64. */
function jpegBytesForChars(chars: number): number {
    let n = Math.floor(chars * 0.5625);
    while (sealedPhotoChars(n) > chars) n--;
    while (sealedPhotoChars(n + 1) <= chars) n++;
    return n;
}

interface PhotoLine {
    id: string; epoch: number; uri: string; caption: string;
    ciphertext: string; nonce: string; metadata: string;
    attachment: { data: string; nonce: string; mime: string };
}
/** A photo line as an app seals one (design §2.2): the caption as part 'body', the JPEG data URI as part 'attachment'. */
function sealPhoto(sender: Id, groupId: string, o: { jpegBytes?: number; caption?: string; epoch?: number; replyToId?: string } = {}): PhotoLine {
    const epoch = o.epoch ?? freshGroupEpoch(db, groupId);
    const id = crypto.randomUUID();
    const caption = o.caption ?? '';
    const uri = `data:image/jpeg;base64,${crypto.randomBytes(o.jpegBytes ?? 1500).toString('base64')}`;
    const base = { myEdPrivHex: sender.seedHex, groupKey: keyFor(groupId, epoch), groupId, epoch, messageId: id, after: null, replyToId: o.replyToId ?? null };
    const body = sealGroupLine(caption, { ...base, part: 'body' });
    const att = sealGroupLine(uri, { ...base, part: 'attachment' });
    const meta: Record<string, unknown> = { epoch };
    if (o.replyToId) meta.replyToId = o.replyToId;
    return { id, epoch, uri, caption, ciphertext: body.ciphertext, nonce: body.nonce, metadata: JSON.stringify(meta), attachment: { data: att.ciphertext, nonce: att.nonce, mime: 'image/jpeg' } };
}
const viaGroup = (p: PhotoLine, extra: Record<string, unknown> = {}) =>
    ({ type: 'image', ciphertext: p.ciphertext, nonce: p.nonce, metadata: p.metadata, attachment: p.attachment, clientId: p.id, ...extra });
const viaSend = (groupId: string, author: Id, p: PhotoLine, extra: Record<string, unknown> = {}) =>
    ({ conversationId: groupId, authorPubkey: author.pk, type: 'image', ciphertext: p.ciphertext, nonce: p.nonce, metadata: p.metadata, attachment: p.attachment, id: p.id, ...extra });

const msgRow = (id: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
const attRow = (id: string) => db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').get(id) as any;
const objectOf = (id: string): Buffer | null => { try { return getImageStore().get(`attachments/${id}.bin`); } catch { return null; } };
const nothingStored = (id: string) => !msgRow(id) && !attRow(id) && !objectOf(id);
const used = (who: Id) => getMemberPhotoUsageForTests(who.pk).usedBytes;
const attachmentOf = (who: Id | null, id: string) => call('GET', who, `/api/messages/${id}/attachment`);
/** The attachment route answers `who` for `id` word for word as it answers them for an id nobody has (no oracle). */
async function sameAsMissing(who: Id | null, id: string): Promise<{ ok: boolean; got: string }> {
    const a = await attachmentOf(who, id);
    const b = await attachmentOf(who, crypto.randomUUID());
    return { ok: a.status >= 400 && a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body), got: `${show(a)} vs ${show(b)}` };
}
/** Served the photo exactly as it was sent. */
const served = (r: Res, p: PhotoLine) => r.status === 200 && r.body?.data === p.attachment.data && r.body?.nonce === p.attachment.nonce && r.body?.mime === p.attachment.mime;

/**
 * After a send the node answered 2xx: the photo's rows as the node stored them. On a node that keeps no photo for a group
 * line (origin/main, the fail-first run) the photo is then put where a DM photo lives, so the read rules below are
 * measured on the attachment route as it is, not on a row that was never written.
 */
function photoStoredFor(p: PhotoLine, what: string): void {
    const ok = !!attRow(p.id) && !!objectOf(p.id);
    assert(ok, `${what}: the photo is stored with its line`);
    if (ok || !msgRow(p.id)) return;
    const key = `attachments/${p.id}.bin`;
    getImageStore().put(key, Buffer.from(p.attachment.data, 'base64'), { mime: 'application/octet-stream', sha256: crypto.createHash('sha256').update(Buffer.from(p.attachment.data, 'base64')).digest('hex') });
    db.prepare('INSERT OR IGNORE INTO message_attachments (message_id, data, nonce, mime, storage_key) VALUES (?, NULL, ?, ?, ?)').run(p.id, p.attachment.nonce, p.attachment.mime, key);
}
async function sendPhoto(sender: Id, groupId: string, what: string, o: Parameters<typeof sealPhoto>[2] = {}): Promise<PhotoLine> {
    const p = sealPhoto(sender, groupId, o);
    const r = await call('POST', sender, `/api/groups/${groupId}/chat/message`, viaGroup(p));
    assert(r.status === 201, `${what}: sent (got ${show(r)})`);
    photoStoredFor(p, what);
    return p;
}

type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id): Promise<Sock> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    const url = `${BASE.replace('https', 'wss')}/ws?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
    console.log('Group chat photos, the node (S2)\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    resetPhotoBudgetForTests();

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const alice = member('Alice');   // convenor
    const bob = member('Bob');       // member, sends most photos
    const carol = member('Carol');   // observer
    const dave = member('Dave');     // removed by the convenor
    const gina = member('Gina');     // leaves, then re-joins
    const nora = member('Nora');     // joins after the first photo
    const pat = member('Pat');       // a member with no epoch yet
    const erin = member('Erin');     // outsider
    const hugo = member('Hugo');     // invited to the quiet group, never accepts
    putPushTokenRow(alice.pk, 'ExponentPushToken[Alice]', 'android');

    const garden = createGroup({ name: 'Garden Crew', joinPolicy: 'open', createdBy: alice.pk });
    for (const m of [bob, carol, dave, gina]) joinGroup(garden.id, m.pk);
    setMemberRole(garden.id, alice.pk, carol.pk, 'observer');
    const g = garden.id;
    const chat = `/api/groups/${g}/chat/message`;

    // ── 1. A sealed photo line is stored and served ──────────────────────────────────────────────────────────────
    console.log('\n--- 1. A sealed photo line is stored and served ---');
    const first = sealPhoto(bob, g, { caption: 'Tomatoes are in' });
    const usedBefore = used(bob);
    const sent = await call('POST', bob, chat, viaGroup(first));
    assert(sent.status === 201 && sent.body?.message?.id === first.id && sent.body?.message?.type === 'image',
        `a member sends a sealed photo line: 201, type 'image' (got ${show(sent)})`);
    const row = msgRow(first.id);
    assert(row?.type === 'image' && row.conversation_id === g && row.ciphertext === first.ciphertext && row.nonce === first.nonce
        && JSON.parse(row.metadata).epoch === first.epoch, `the line is stored as sent, type 'image', under its epoch (got ${row?.type})`);
    const att = attRow(first.id);
    assert(!!att && att.data === null && att.storage_key === `attachments/${first.id}.bin` && att.nonce === first.attachment.nonce && att.mime === 'image/jpeg',
        `the photo has its message_attachments row, its ciphertext in the image store (got ${JSON.stringify(att)?.slice(0, 120)})`);
    assert(objectOf(first.id)?.toString('base64') === first.attachment.data, 'the stored object is exactly the sealed photo that was sent');
    assert(used(bob) - usedBefore === Buffer.byteLength(first.attachment.data, 'base64'), `the photo counts in the day's photo budget (got ${used(bob) - usedBefore})`);
    photoStoredFor(first, 'the first photo');
    const toCarol = await attachmentOf(carol, first.id);
    const toAlice = await attachmentOf(alice, first.id);
    assert(served(toCarol, first) && served(toAlice, first), `served to the chat's members, an observer too (got ${show(toCarol)})`);
    assert(toCarol.headers['cache-control'] === 'private, no-store', 'with no cache on the way keeping it');
    let opened = '';
    try {
        opened = openGroupLine({ ciphertext: toCarol.body.data, nonce: toCarol.body.nonce },
            { groupId: g, epoch: first.epoch, senderPubHex: bob.pk, messageId: first.id, part: 'attachment', replyToId: null }, keyFor(g, first.epoch)).text;
    } catch { /* stays empty */ }
    assert(opened === first.uri, 'and what is served opens, with the epoch key, as the photo Bob sealed');

    // ── 2. Only a sealed photo ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Readable photos and mismatched lines are refused ---');
    const readable = sealPhoto(bob, g);
    const readableRes = await call('POST', bob, chat, viaGroup(readable, { attachment: { data: crypto.randomBytes(900).toString('base64'), nonce: 'plaintext-v1', mime: 'image/jpeg' } }));
    assert(readableRes.status === 400 && readableRes.body?.code === 'not_encrypted', `a readable photo is 400 not_encrypted (got ${show(readableRes)})`);
    assert(nothingStored(readable.id), 'and nothing is stored: no line, no row, no object');
    const dmForm = sealPhoto(bob, g);
    const dmPhoto = lockedDm(900);
    const dmFormRes = await call('POST', bob, chat, viaGroup(dmForm, { attachment: { data: dmPhoto.ciphertext, nonce: dmPhoto.nonce, mime: 'image/jpeg' } }));
    assert(dmFormRes.status === 400 && dmFormRes.body?.code === 'not_encrypted' && nothingStored(dmForm.id), `a DM-sealed photo is refused the same (got ${show(dmFormRes)})`);
    const plainBody = sealPhoto(bob, g);
    const plainBodyRes = await call('POST', bob, chat, viaGroup(plainBody, { ciphertext: Buffer.from('look!').toString('base64'), nonce: 'plaintext-v1' }));
    assert(plainBodyRes.status === 400 && plainBodyRes.body?.code === 'not_encrypted' && nothingStored(plainBody.id),
        `a readable caption with a sealed photo is 400 not_encrypted, nothing stored (got ${show(plainBodyRes)})`);
    const asText = sealPhoto(bob, g);
    const asTextRes = await call('POST', bob, chat, viaGroup(asText, { type: 'text' }));
    assert(asTextRes.status === 400 && nothingStored(asText.id), `a photo sent as a text line is refused, nothing stored (got ${show(asTextRes)})`);
    const noPhoto = sealPhoto(bob, g);
    const noPhotoRes = await call('POST', bob, chat, viaGroup(noPhoto, { attachment: undefined }));
    assert(noPhotoRes.status === 400 && nothingStored(noPhoto.id), `an image line with no photo is refused, nothing stored (got ${show(noPhotoRes)})`);
    const observerRes = await call('POST', carol, chat, viaGroup(sealPhoto(carol, g)));
    assert(observerRes.status === 403, `an observer cannot send a photo (got ${show(observerRes)})`);

    // ── 3. The node's size cap ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. GROUP_PHOTO_MAX_BYTES ---');
    assert(typeof writerLimits.GROUP_PHOTO_MAX_BYTES === 'number', `config/writer-limits.ts names GROUP_PHOTO_MAX_BYTES (got ${writerLimits.GROUP_PHOTO_MAX_BYTES})`);
    const over = sealPhoto(bob, g, { jpegBytes: jpegBytesForChars(CAP) + 3 });
    assert(over.attachment.data.length > CAP, `(the test photo is over the cap: ${over.attachment.data.length} > ${CAP})`);
    const usedOver = used(bob);
    const overRes = await call('POST', bob, chat, viaGroup(over));
    assert(overRes.status === 400 && overRes.body?.error === 'This photo is too large to send. Try another one.',
        `a photo over the cap is 400 with its sentence (got ${show(overRes)})`);
    assert(nothingStored(over.id) && used(bob) === usedOver, 'no line, no row, no object, and the budget untouched');
    const atCap = sealPhoto(bob, g, { jpegBytes: jpegBytesForChars(CAP) });
    assert(atCap.attachment.data.length <= CAP && atCap.attachment.data.length > CAP - 8, `(the test photo is at the cap: ${atCap.attachment.data.length})`);
    const atCapRes = await call('POST', bob, chat, viaGroup(atCap));
    assert(atCapRes.status === 201 && !!attRow(atCap.id), `a photo at the cap goes (got ${show(atCapRes)})`);

    // ── 4. The day's photo budget and the storage floor ─────────────────────────────────────────────────────────
    console.log('\n--- 4. The photo budget counts a group photo ---');
    const budgeted = member('Budget');
    joinGroup(g, budgeted.pk);
    process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY = '6000';
    await sendPhoto(budgeted, g, 'a photo inside the budget', { jpegBytes: 2500 });
    const overBudget = sealPhoto(budgeted, g, { jpegBytes: 2500 });
    const overBudgetRes = await call('POST', budgeted, chat, viaGroup(overBudget));
    assert(overBudgetRes.status === 429 && overBudgetRes.body?.code === 'photo_budget' && Number(overBudgetRes.headers['retry-after']) > 0,
        `the next is 429 with Retry-After (got ${show(overBudgetRes)} retry-after ${overBudgetRes.headers['retry-after']})`);
    assert(nothingStored(overBudget.id), 'and nothing is stored');
    delete process.env.PHOTO_BYTES_PER_MEMBER_PER_DAY;
    setSimulatedFreeDiskBytesForTests(10 * 1024 * 1024);
    const full = sealPhoto(bob, g);
    const fullRes = await call('POST', bob, chat, viaGroup(full));
    assert(fullRes.status === 507 && nothingStored(full.id), `below the free-disk floor: 507, nothing stored (got ${show(fullRes)})`);
    setSimulatedFreeDiskBytesForTests(null);

    // ── 5. Outsiders: the answer of a missing id ─────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Non-members, invite-only outsiders, signed-out callers ---');
    let s = await sameAsMissing(erin, first.id);
    assert(s.ok, `a member of the node who is not in the group: the answer of a missing id (${s.got})`);
    const quiet = createGroup({ name: 'Quiet Room', joinPolicy: 'invite_only', createdBy: alice.pk });
    inviteGroupMember(quiet.id, alice.pk, hugo.pk);
    const quietPhoto = await sendPhoto(alice, quiet.id, 'a photo in an invite-only group');
    for (const [who, what] of [[erin, 'an outsider'], [hugo, 'an invitee who has not accepted'], [carol, "an observer of another group, not in this one"]] as const) {
        s = await sameAsMissing(who, quietPhoto.id);
        assert(s.ok, `invite-only group, ${what}: the answer of a missing id (${s.got})`);
    }
    s = await sameAsMissing(null, first.id);
    assert(s.ok, `signed out: the answer of a missing id (${s.got})`);

    // ── 6. Epochs: a newcomer, a member with no epoch ────────────────────────────────────────────────────────────
    console.log('\n--- 6. A photo from before a membership ---');
    joinGroup(g, nora.pk);
    const noraFrom = (db.prepare('SELECT from_epoch FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, nora.pk) as any)?.from_epoch;
    assert(typeof noraFrom === 'number' && noraFrom > first.epoch, `(Nora's from_epoch ${noraFrom} is after the first photo's epoch ${first.epoch})`);
    s = await sameAsMissing(nora, first.id);
    assert(s.ok, `a newcomer asking for a photo from before their from_epoch: the answer of a missing id (${s.got})`);
    const afterNora = await sendPhoto(bob, g, 'a photo after Nora joined');
    assert(served(await attachmentOf(nora, afterNora.id), afterNora), 'and a photo from their time is served to them');
    joinGroup(g, pat.pk);
    db.prepare(`UPDATE group_members SET from_epoch = NULL, joined_at = ? WHERE group_id = ? AND member_pubkey = ?`)
        .run(new Date(Date.now() + 3_600_000).toISOString(), g, pat.pk);
    const forPat = await sendPhoto(bob, g, 'a photo while Pat has no epoch');
    assert(db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND from_epoch IS NULL").get(g, pat.pk) !== undefined,
        '(Pat is an active member with no epoch)');
    s = await sameAsMissing(pat, forPat.id);
    assert(s.ok, `a member with no epoch yet: the answer of a missing id (${s.got})`);

    // ── 7. Removed, left, re-joined ──────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. A removed member, a leaver, a re-join ---');
    assert(served(await attachmentOf(dave, first.id), first) && served(await attachmentOf(gina, first.id), first), '(Dave and Gina are served the first photo while they are members)');
    removeGroupMember(g, alice.pk, dave.pk);
    removeGroupMember(g, gina.pk, gina.pk);
    const whileOut = await sendPhoto(bob, g, 'a photo while Dave and Gina are out');
    for (const [who, what] of [[dave, 'a removed member'], [gina, 'a leaver']] as const) {
        s = await sameAsMissing(who, first.id);
        assert(s.ok, `${what}, a photo from their time: the answer of a missing id (${s.got})`);
        s = await sameAsMissing(who, whileOut.id);
        assert(s.ok, `${what}, a photo from after: the same (${s.got})`);
    }
    joinGroup(g, gina.pk);
    const afterRejoin = await sendPhoto(bob, g, 'a photo after Gina re-joined');
    s = await sameAsMissing(gina, whileOut.id);
    assert(s.ok, `after a re-join, the gap's photo stays the answer of a missing id (${s.got})`);
    assert(served(await attachmentOf(gina, afterRejoin.id), afterRejoin), 'while a new one is served to her');

    // ── 8. Deletion ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. The author deletes, the convenor removes ---');
    for (const [label, doIt] of [
        ["the author's delete", async (p: PhotoLine) => call('POST', bob, '/api/messages/delete', { messageId: p.id })],
        ["the convenor's removal", async (p: PhotoLine) => call('POST', alice, `/api/groups/${g}/chat/remove`, { messageId: p.id })],
    ] as const) {
        const p = await sendPhoto(bob, g, `a photo for ${label}`);
        const r = await doIt(p);
        assert(r.status === 200 && r.body?.success === true, `${label} answers (got ${show(r)})`);
        assert(msgRow(p.id)?.type === 'removed', `${label}: the line is a tombstone`);
        assert(!attRow(p.id), `${label}: the attachment row is gone`);
        assert(!objectOf(p.id), `${label}: the object is gone`);
        s = await sameAsMissing(carol, p.id);
        assert(s.ok, `${label}: the photo is then the answer of a missing id (${s.got})`);
    }

    // ── 9. The old send route: one rule book ─────────────────────────────────────────────────────────────────────
    console.log('\n--- 9. /api/messages/send stores and refuses as the group route ---');
    const bridged = sealPhoto(bob, g, { caption: 'via the old route' });
    const bridgedRes = await call('POST', bob, '/api/messages/send', viaSend(g, bob, bridged));
    assert(bridgedRes.status === 200 && bridgedRes.body?.success === true && bridgedRes.body?.message?.type === 'image',
        `a sealed photo through /api/messages/send is stored (got ${show(bridgedRes)})`);
    assert(msgRow(bridged.id)?.type === 'image' && attRow(bridged.id)?.storage_key === `attachments/${bridged.id}.bin`
        && objectOf(bridged.id)?.toString('base64') === bridged.attachment.data, 'as the group route stores it: line, row and object');
    assert(served(await attachmentOf(alice, bridged.id), bridged), 'and served to a member');
    const pairs: [string, (p: PhotoLine) => Record<string, unknown>][] = [
        ['a readable photo', () => ({ attachment: { data: crypto.randomBytes(900).toString('base64'), nonce: 'plaintext-v1', mime: 'image/jpeg' } })],
        ['a readable caption', () => ({ ciphertext: Buffer.from('look!').toString('base64'), nonce: 'plaintext-v1' })],
        ['a photo over the cap', () => { const big = sealPhoto(bob, g, { jpegBytes: jpegBytesForChars(CAP) + 3 }); return { ciphertext: big.ciphertext, nonce: big.nonce, attachment: big.attachment, metadata: big.metadata }; }],
        ['a photo sent as text', () => ({ type: 'text' })],
    ];
    for (const [what, change] of pairs) {
        const a = sealPhoto(bob, g);
        const b = sealPhoto(bob, g);
        const ch = change(a);
        const viaChat = await call('POST', bob, chat, viaGroup(a, ch));
        const viaOld = await call('POST', bob, '/api/messages/send', viaSend(g, bob, b, ch));
        assert(viaOld.status === viaChat.status && viaOld.body?.code === viaChat.body?.code && viaOld.body?.error === viaChat.body?.error && viaChat.status >= 400,
            `${what}: the same refusal through both routes (group ${show(viaChat)}; send ${show(viaOld)})`);
        assert(nothingStored(b.id), `${what}: nothing stored through the old route`);
    }

    // ── 10. One transaction ──────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 10. A failing attachment insert ---');
    const doomed = sealPhoto(bob, g);
    const usedDoomed = used(bob);
    db.exec(`CREATE TEMP TRIGGER group_photo_insert_fails BEFORE INSERT ON message_attachments
             BEGIN SELECT RAISE(ABORT, 'the attachment insert fails (test)'); END`);
    let doomedRes: Res;
    try {
        doomedRes = await call('POST', bob, chat, viaGroup(doomed));
    } finally {
        db.exec('DROP TRIGGER IF EXISTS temp.group_photo_insert_fails');
    }
    assert(doomedRes.status >= 500, `the send answers a server fault, so the app retries with the same id (got ${show(doomedRes)})`);
    assert(!msgRow(doomed.id) && !attRow(doomed.id), 'no message row and no attachment row: one transaction');
    assert(used(bob) === usedDoomed, 'and nothing counted against the budget');
    const orphan = objectOf(doomed.id);
    assert(orphan?.toString('base64') === doomed.attachment.data, 'the object, put before the rows, is left for the sweep');
    const doomedFile = path.join(imagesDir(), 'attachments', `${doomed.id}.bin`);
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) / 1000;
    if (fs.existsSync(doomedFile)) fs.utimesSync(doomedFile, twoHoursAgo, twoHoursAgo);
    const preview = await getStorageCleanPreview();
    assert(preview.orphanedImageObjects.count >= 1, `storage-health counts it as an orphan once past its grace (got ${preview.orphanedImageObjects.count})`);
    await cleanStorageAndCompressLogs();
    assert(!objectOf(doomed.id) && !fs.existsSync(doomedFile), 'and its sweep removes it');
    assert(objectOf(first.id)?.toString('base64') === first.attachment.data, 'while a stored photo is kept');
    const retried = await call('POST', bob, chat, viaGroup(doomed));
    assert(retried.status === 201 && !!attRow(doomed.id) && !!objectOf(doomed.id), `the retry with the same id stores it whole (got ${show(retried)})`);

    // ── 11. Epochs on a send ─────────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 11. A stale epoch, an epoch that is not current ---');
    const current = freshGroupEpoch(db, g);
    joinGroup(g, member('Late').pk); // a membership change with no epoch: the current one is stale
    const stale = sealPhoto(bob, g, { epoch: current });
    const usedStale = used(bob);
    const staleRes = await call('POST', bob, chat, viaGroup(stale));
    assert(staleRes.status === 409 && staleRes.body?.code === 'epoch_stale' && staleRes.body?.current === current,
        `a photo under a stale epoch: 409 epoch_stale with current (got ${show(staleRes)})`);
    assert(nothingStored(stale.id) && used(bob) === usedStale, 'nothing stored, nothing counted');
    const fresh = freshGroupEpoch(db, g);
    const old = sealPhoto(bob, g, { epoch: current });
    const oldRes = await call('POST', bob, chat, viaGroup(old));
    assert(oldRes.status === 409 && oldRes.body?.code === 'epoch_not_current' && oldRes.body?.current === fresh && nothingStored(old.id),
        `a photo under an older epoch: 409 epoch_not_current with current ${fresh}, nothing stored (got ${show(oldRes)})`);
    const oldViaSend = sealPhoto(bob, g, { epoch: current });
    const oldViaSendRes = await call('POST', bob, '/api/messages/send', viaSend(g, bob, oldViaSend));
    assert(oldViaSendRes.status === 409 && oldViaSendRes.body?.code === 'epoch_not_current' && oldViaSendRes.body?.current === fresh && nothingStored(oldViaSend.id),
        `the same through /api/messages/send (got ${show(oldViaSendRes)})`);

    // ── 12. Live, read, pushed ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 12. The live update, the reads and the push ---');
    const carolSock = await socket(carol);
    const erinSock = await socket(erin);
    const daveSock = await socket(dave);
    await settle();
    expo.length = 0;
    const live = await sendPhoto(bob, g, 'a photo for the live update');
    await settle(300);
    const heardBy = (sk: Sock) => sk.events.filter((e) => e?.type === 'new_message' && e?.message?.id === live.id);
    const carolHeard = heardBy(carolSock);
    assert(carolHeard.length === 1 && carolHeard[0].message.type === 'image' && carolHeard[0].conversationId === g,
        `the live update reaches a member with type 'image' (got ${JSON.stringify(carolHeard.map((e) => e.message?.type))})`);
    assert(!erinSock.events.some((e) => JSON.stringify(e).includes(live.id)) && !daveSock.events.some((e) => JSON.stringify(e).includes(live.id)),
        'and nobody outside the chat: not an outsider, not a removed member');
    const chatRead = await call('GET', carol, `/api/groups/${g}/chat`);
    assert(chatRead.body?.messages?.find((m: any) => m.id === live.id)?.type === 'image', `GET …/chat carries type 'image' (got ${show(chatRead)})`);
    const oldRead = await call('GET', carol, `/api/messages/${g}`);
    assert(oldRead.body?.messages?.find((m: any) => m.id === live.id)?.type === 'image', `GET /api/messages/:id (the old apps' read) carries it too (got ${oldRead.status})`);
    const photoPush = expo.filter((m) => m.to === 'ExponentPushToken[Alice]');
    expo.length = 0;
    const textLine = sealPhoto(bob, g);
    const textRes = await call('POST', bob, chat, { ciphertext: textLine.ciphertext, nonce: textLine.nonce, metadata: textLine.metadata, clientId: textLine.id });
    assert(textRes.status === 201, `(a text line for comparison: ${show(textRes)})`);
    await settle(300);
    const textPush = expo.filter((m) => m.to === 'ExponentPushToken[Alice]');
    assert(photoPush.length === 1 && textPush.length === 1, `one push each to Alice's phone (got ${photoPush.length}, ${textPush.length})`);
    assert(photoPush[0]?.title === textPush[0]?.title && photoPush[0]?.body === textPush[0]?.body && photoPush[0]?.data?.k === 'chat.group' && textPush[0]?.data?.k === 'chat.group',
        `through Apple and Google a photo line's push is the text line's: the same words and kind (got "${photoPush[0]?.body}" ${photoPush[0]?.data?.k})`);
    assert(!/photo|image|📷/i.test(JSON.stringify(photoPush[0] ?? {})), 'nothing in it says it is a photo');
    const kept = db.prepare("SELECT body FROM push_notices WHERE recipient = ? ORDER BY sent_at DESC, rowid DESC LIMIT 2").all(alice.pk) as { body: string }[];
    assert(kept.length === 2 && kept.every((k) => k.body === 'Bob sent a message'), `its details on the node say "Bob sent a message" (got ${JSON.stringify(kept)})`);
    for (const sk of [carolSock, erinSock, daveSock]) sk.ws.close();

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error('❌ Test crashed:', e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
