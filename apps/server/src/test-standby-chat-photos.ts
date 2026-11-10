/**
 * Test Suite: chat photos survive a take-over (gap G4; scratch/fable-design/DESIGN-group-chat-photos-fable.md §2.7). A
 * standby copies `message_attachments` on the plain-table path, verbatim, and fetches each photo's object by reference
 * (its sha256 and size, routes/backup.ts sync-object), as listing photos go; every delete on the main server writes a
 * tombstone, and the standby deletes the row and its object.
 *
 * Two processes, each its own data dir (takeover-test-harness.ts), over REAL HTTPS through the real signature middleware,
 * with real Ed25519 identities. Nothing leaves this machine.
 *
 *  1. On M: Anna (the owner) and Ben share a DM, with photos from each; Anna and Dan share a locked group chat, with photos
 *     sealed as an app seals them (@beanpool/core sealGroupLine, part 'attachment'). Each stored row names its object's
 *     sha256 and size. One DM photo is planted as a row from before this change (no sha256), as an upgraded M holds them.
 *  2. S's first copy holds every photo row verbatim, and the object of each that names one; the planted row lands without
 *     its object (no copy can name it yet).
 *  3. On M: Anna deletes a DM photo, Anna deletes a group photo of hers, Ben deletes his account (his photos go), a new
 *     DM photo is sent, and M's evacuation job names the planted row's object. S's next pull (a delta): the deleted rows
 *     AND their objects are gone from S, the new photo and the planted one's object are there.
 *  4. The take-over (the recovery code), M down. On the promoted server: Anna opens the DM photos and Dan the group photo,
 *     byte for byte as they were sent; Cat, in neither chat, gets the answer for a missing id; every deleted photo is a
 *     missing id to its own chat's people.
 *
 * Every check past the setup is an assert, not a stop, so the fail-first run reaches the take-over and says what it lost.
 *
 * Fail-first: on origin/main before this change, S copies no `message_attachments` row (it was local, gap G4), so steps
 * 2 to 4 fail: every photo is unavailable after the take-over.
 *
 * Run through the runner: SERVER_SUITES_ONLY=test-standby-chat-photos node scripts/run-server-suites.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { dmPublicKeyOf, sealGroupLine } from '@beanpool/core';
import { lockedDm } from './dm-test-payload.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Chat-Photos-Main-Pw-5521!';
const PW_STANDBY = 'Chat-Photos-Standby-Pw-8830!';

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
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            se.seedGenesisMember(a.ownerPk, 'Anna');
            setMemberPhoto(db, a.ownerPk, 'bundled://leaf');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            pinMainServerForTests(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** A member of the community, invited by the owner, as test-group-chat-photo.ts makes one. */
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
        /** The group's epoch a line may go under (what an app's rotate makes, when it needs one). */
        epoch: async (a: { groupId: string }) => {
            const { db } = await import('./db/db.js');
            const { freshGroupEpoch } = await import('./group-test-payload.js');
            return freshGroupEpoch(db, a.groupId);
        },
        /** A photo row as a main server from before this change holds it: its object stored, no sha256 or size. */
        'plant-unhashed': async (a: { id: string }) => {
            const { db } = await import('./db/db.js');
            try {
                return db.prepare('UPDATE message_attachments SET sha256 = NULL, bytes = NULL WHERE message_id = ?').run(a.id).changes;
            } catch (e) {
                return `not planted: ${(e as Error).message}`; // a server with no such columns (the fail-first run)
            }
        },
        /** The evacuation job's passes, until one does nothing (services/image-evacuation.ts). */
        evacuate: async () => {
            const { evacuateImagesOnce, evacuationPassDidWork } = await import('./services/image-evacuation.js');
            let hashed = 0;
            for (let i = 0; i < 20; i++) {
                const pass = evacuateImagesOnce() as any;
                hashed += pass.attachmentsHashed ?? 0;
                if (!evacuationPassDidWork(pass)) break;
            }
            return hashed;
        },
        'delete-account': async (a: { pk: string }) => {
            const se = await import('./state-engine.js');
            return se.purgeMemberSelf(a.pk);
        },
        /** Every photo row, and whether this server's store holds the object it names, at its size. */
        photos: async () => {
            const { db } = await import('./db/db.js');
            const { getImageStore } = await import('./storage/image-store.js');
            const store = getImageStore();
            const rows = db.prepare('SELECT * FROM message_attachments ORDER BY message_id').all() as any[];
            return rows.map((r) => {
                let object: number | null = null;
                try { object = r.storage_key ? store.get(r.storage_key)?.length ?? null : null; } catch { object = null; }
                return { ...r, object };
            });
        },
        /** Whether this server's store holds `attachments/<id>.bin`, whatever any row says. */
        objects: async (a: { ids: string[] }) => {
            const { getImageStore, attachmentKey } = await import('./storage/image-store.js');
            const store = getImageStore();
            return Object.fromEntries(a.ids.map((id) => {
                try { return [id, !!store.get(attachmentKey(id))]; } catch { return [id, false]; }
            }));
        },
        resync: async () => {
            const { requestResync, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return { resync: await requestResync(), envelope: await pullTakeoverEnvelopeNow() };
        },
        pull: async () => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const result = await pullNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before, envelope: await pullTakeoverEnvelopeNow() };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
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
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64'),
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
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 140)}`;

interface Sent { id: string; data: string; nonce: string; mime: string }

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ NODE_ROLE: role, BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const anna = newId('Anna');
    const ben = newId('Ben');
    const cat = newId('Cat');
    const dan = newId('Dan');

    try {
        // ── 1. Photos on M ──
        console.log('\n— 1. on M: DM photos from Anna and Ben, group photos from Anna, each row naming its object —');
        const main = await spawnNode(SCRIPT, dirs.main, env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { ownerPk: anna.pk, replicationToken });
        const mainPeerId = main.ready.peerId;
        for (const m of [ben, cat, dan]) await main.send('member', { pk: m.pk, name: m.name, owner: anna.pk });
        const M = `https://localhost:${await main.send('serve')}`;

        const convo = await call(M, 'POST', anna, '/api/messages/conversation', { type: 'dm', participants: [anna.pk, ben.pk], createdBy: anna.pk });
        const convoId = convo.body?.conversation?.id ?? convo.body?.id;
        require_(convo.status < 300 && !!convoId, `Anna opens a DM with Ben (${show(convo)})`);
        const dmPhoto = async (from: Id): Promise<Sent> => {
            const jpeg = lockedDm(900 + Math.floor(Math.random() * 200));
            const sent: Sent = { id: crypto.randomUUID(), data: jpeg.ciphertext, nonce: jpeg.nonce, mime: 'image/jpeg' };
            const r = await call(M, 'POST', from, '/api/messages/send', {
                conversationId: convoId, authorPubkey: from.pk, ...lockedDm(), type: 'image', id: sent.id,
                attachment: { data: sent.data, nonce: sent.nonce, mime: sent.mime },
            });
            require_(r.status < 300, `${from.name} sends a DM photo (${show(r)})`);
            return sent;
        };
        const dmKept = await dmPhoto(anna);
        const dmDeleted = await dmPhoto(anna);
        const dmOfBen = await dmPhoto(ben);
        const dmPlanted = await dmPhoto(anna);

        const groupId: string = await main.send('make-group', { name: 'Garden Crew', createdBy: anna.pk, members: [dan.pk] });
        const groupKey = new Uint8Array(crypto.randomBytes(32)); // the members' key: the node never sees it
        const groupPhoto = async (from: Id): Promise<Sent> => {
            const epoch: number = await main.send('epoch', { groupId });
            const id = crypto.randomUUID();
            const base = { myEdPrivHex: from.seedHex, groupKey, groupId, epoch, messageId: id, after: null, replyToId: null };
            const caption = sealGroupLine('', { ...base, part: 'body' });
            const photo = sealGroupLine(`data:image/jpeg;base64,${crypto.randomBytes(1200).toString('base64')}`, { ...base, part: 'attachment' });
            const sent: Sent = { id, data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' };
            const r = await call(M, 'POST', from, `/api/groups/${groupId}/chat/message`, {
                type: 'image', ciphertext: caption.ciphertext, nonce: caption.nonce, metadata: JSON.stringify({ epoch }), clientId: id,
                attachment: { data: sent.data, nonce: sent.nonce, mime: sent.mime },
            });
            require_(r.status < 300, `${from.name} sends a photo to the group chat (${show(r)})`);
            return sent;
        };
        const groupKept = await groupPhoto(anna);
        const groupDeleted = await groupPhoto(anna);

        const sentAll = [dmKept, dmDeleted, dmOfBen, dmPlanted, groupKept, groupDeleted];
        const onM = new Map((await main.send('photos') as any[]).map((r) => [r.message_id, r]));
        const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'base64')).digest('hex');
        assert(sentAll.every((s) => onM.get(s.id)?.storage_key === `attachments/${s.id}.bin` && onM.get(s.id)?.data === null
            && onM.get(s.id)?.sha256 === sha(s.data) && onM.get(s.id)?.bytes === Buffer.from(s.data, 'base64').length),
        `M stores each of the ${sentAll.length} photos in its image store, its row naming the object's sha256 and size`);
        const planted = await main.send('plant-unhashed', { id: dmPlanted.id });
        assert(planted === 1, `one DM photo planted as a row from before this change (no sha256, no size) (${planted})`);

        // ── 2. S's first copy ──
        console.log("\n— 2. S's first copy: every photo row verbatim, and each named object fetched —");
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: mainPeerId });
        const first = await standby.send('resync');
        require_(first.resync.ok && first.envelope === 'stored', `S: the first copy and the keys (${JSON.stringify(first.resync).slice(0, 160)})`);
        const mRows = new Map((await main.send('photos') as any[]).map((r) => [r.message_id, r]));
        const sRows = new Map((await standby.send('photos') as any[]).map((r) => [r.message_id, r]));
        const verbatim = (id: string) => {
            const a = mRows.get(id), b = sRows.get(id);
            if (!a || !b) return false;
            const { object: _a, ...ra } = a;
            const { object: _b, ...rb } = b;
            return JSON.stringify(ra) === JSON.stringify(rb);
        };
        assert(sentAll.every((s) => verbatim(s.id)), `S holds all ${sentAll.length} photo rows as M holds them, stamps included (${sRows.size} on S)`);
        const withObject = sentAll.filter((s) => s !== dmPlanted);
        assert(withObject.every((s) => sRows.get(s.id)?.object === Buffer.from(s.data, 'base64').length),
            `and the object of each of the ${withObject.length} that name one, at its size (${withObject.filter((s) => sRows.get(s.id)?.object).length} held)`);
        assert(sRows.has(dmPlanted.id) && sRows.get(dmPlanted.id)?.object === null,
            'the row from before this change lands without its object: no copy names it yet');

        // ── 3. Deletes, a new photo, and the planted row named, on M; S's delta ──
        console.log("\n— 3. on M: a DM photo and a group photo deleted, Ben's account deleted, a new photo; S's delta —");
        const delDm = await call(M, 'POST', anna, '/api/messages/delete', { messageId: dmDeleted.id });
        require_(delDm.status < 300, `Anna deletes one of her DM photos (${show(delDm)})`);
        const delGroup = await call(M, 'POST', anna, '/api/messages/delete', { messageId: groupDeleted.id });
        require_(delGroup.status < 300, `Anna deletes one of her group photos (${show(delGroup)})`);
        const gone = await main.send('delete-account', { pk: ben.pk });
        require_(gone?.ok, `Ben deletes his account (${JSON.stringify(gone).slice(0, 120)})`);
        const dmNew = await dmPhoto(anna);
        const hashed = await main.send('evacuate');
        assert(hashed === 1, `M's evacuation job names the planted row's object: its sha256 and size (${hashed} hashed)`);
        const deleted = [dmDeleted, groupDeleted, dmOfBen];
        const mAfter = new Map((await main.send('photos') as any[]).map((r) => [r.message_id, r]));
        assert(deleted.every((s) => !mAfter.has(s.id)) && !!mAfter.get(dmPlanted.id)?.sha256 && mAfter.has(dmNew.id),
            'M: the three deleted photos\' rows are gone, the planted row names its object, the new photo is stored');

        const delta = await standby.send('pull');
        require_(delta.ok, `S pulls (${delta.whole ? 'whole' : 'delta'}: ${JSON.stringify(delta).slice(0, 160)})`);
        assert(!delta.whole, 'a delta, not a whole copy');
        const sAfter = new Map((await standby.send('photos') as any[]).map((r) => [r.message_id, r]));
        const sObjects = await standby.send('objects', { ids: deleted.map((s) => s.id) });
        assert(deleted.every((s) => !sAfter.has(s.id)),
            `S: the deleted DM photo's, the deleted group photo's and Ben's photo's rows are gone (${deleted.filter((s) => sAfter.has(s.id)).length} left)`);
        assert(deleted.every((s) => sObjects[s.id] === false),
            `and their objects are gone from S's image store too (${deleted.filter((s) => sObjects[s.id]).length} left)`);
        assert(sAfter.get(dmNew.id)?.object === Buffer.from(dmNew.data, 'base64').length,
            'the photo sent after the first copy reached S with its object, in the delta');
        assert(sAfter.get(dmPlanted.id)?.object === Buffer.from(dmPlanted.data, 'base64').length && sAfter.get(dmPlanted.id)?.sha256 === mAfter.get(dmPlanted.id)?.sha256,
            'the planted row came again once M named its object, and S fetched it');

        // ── 4. The take-over ──
        console.log('\n— 4. the take-over: on the promoted server each kept photo opens for its chat\'s people, and no one else —');
        const mainBlocked: string[] = await main.send('blocked');
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const standbyOwner: Record<string, string> = await standby.send('owner-session');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, standbyOwner);
        require_(opened.status === 200 && opened.body.preview?.peerId === mainPeerId, `the recovery code opens the keys (${opened.status})`);
        const missing: string[] = opened.body.preview.missing ?? [];
        assert(!missing.some((m) => /photos sent in chats/.test(m)), `the preview no longer says chat photos will be missing (${JSON.stringify(missing).slice(0, 200)})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, standbyOwner);
        require_(confirmed.status === 200, `the take-over is confirmed (${confirmed.status})`);
        require_((await standby.exited) === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === mainPeerId, 'it is the main server, with the same PeerId');
        const S = `https://localhost:${await standby.send('serve')}`;

        const open = (who: Id, s: Sent) => call(S, 'GET', who, `/api/messages/${s.id}/attachment`);
        const asSent = (r: Res, s: Sent) => r.status === 200 && r.body?.data === s.data && r.body?.nonce === s.nonce && r.body?.mime === s.mime;
        const bensDm = await Promise.all([dmKept, dmNew, dmPlanted].map((s) => open(anna, s)));
        assert(bensDm.every((r, i) => asSent(r, [dmKept, dmNew, dmPlanted][i])),
            `Anna opens the DM photos on the promoted server, byte for byte as sent: from before the first copy, after it, and the planted one (${bensDm.map(show).join(' | ').slice(0, 300)})`);
        const dansGroup = await open(dan, groupKept);
        assert(asSent(dansGroup, groupKept), `Dan opens the group photo on the promoted server, byte for byte as sealed (${show(dansGroup)})`);
        const missingId = await open(cat, { id: crypto.randomUUID(), data: '', nonce: '', mime: '' });
        const catsTries = await Promise.all([dmKept, groupKept].map((s) => open(cat, s)));
        assert(missingId.status === 404 && catsTries.every((r) => r.status === missingId.status && JSON.stringify(r.body) === JSON.stringify(missingId.body)),
            `Cat, in neither chat, gets the answer for a missing id for both (${catsTries.map(show).join(' | ')})`);
        const deletedTries = await Promise.all([open(anna, dmDeleted), open(anna, dmOfBen), open(dan, groupDeleted)]);
        assert(deletedTries.every((r) => r.status === 404 && JSON.stringify(r.body) === JSON.stringify(missingId.body)),
            `every deleted photo is a missing id to its own chat's people on the promoted server (${deletedTries.map(show).join(' | ')})`);

        const blocked = [...mainBlocked, ...await standby.send('blocked')];
        assert(blocked.length === 0, `nothing reached off this machine, from M or the promoted server (refused: ${blocked.join(', ') || 'none'})`);
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
