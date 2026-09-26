/**
 * Test Suite: a standby keeps up with re-keys (engine/key-move.ts). The keys its main server replaced reach it, it follows
 * each re-key the way the main server made it, and a server that takes over refuses a replaced key at every door.
 *
 * Before this, a re-key on the main server stopped its standby copying anything: the re-keyed member's row (the new key,
 * the same callsign) went in beside the old key's row, the members' callsign index refused it, and the import is one
 * transaction, so nothing landed, every pull after it failing the same way until a force-resync. And `invalidated_keys`
 * travelled in no copy, so after a take-over a lost phone's key could sign again, knock, join by the open door or
 * redeem an invite.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots, and the
 * standby pulls through its real puller (services/backup-puller.ts `pullNow`, the loop's own step) from the main
 * server's real backup routes. No other host is reached.
 *
 *  1. A main server: Anna (owner), Rex, Sue, Tom, Bea and Cat, whom Rex invited. Rex, Sue and Tom each have a post, an
 *     RSVP, friends, a rating, a group, a chat, an open-door record and a recovery copy, and keep another member's; another
 *     member addressed a post to each of them alone and gave each a task.
 *  2. Its standby copies it (a force-resync) and holds the take-over keys. Members trade, and a delta brings the trades:
 *     the standby holds every balance the main server does. (Trades come after the standby's first copy: a first copy
 *     leaves every balance made before it at 0 on the standby, since the import stamps each new member's account with its
 *     own clock and then keeps it over the main server's older row. That is not a re-key's doing, and not this suite's.)
 *  3. Rex is re-keyed on the main server. The standby's next pull is a delta and imports: Rex is his new key there, the old
 *     key is replaced there, every row that named him names the new key as on the main server, his old recovery copies are
 *     gone, and the balances are the main server's. His row keeps the main server's stamp, so a change the main server
 *     makes after the re-key (his bio) reaches the standby by the next delta.
 *  4. Sue is re-keyed, and the standby's next pull is a whole copy: it imports, the same, and the replica check agrees.
 *  5. Tom is re-keyed, and the standby gets it as a main server from before this version sends it (no replaced keys): the
 *     import fails on the callsign index, as every pull did. With both servers on this version, its next pull heals it,
 *     with no force-resync.
 *  6. A standby from before this version holds none of the keys its main server replaced before it upgraded, and no delta
 *     brings them: it asks for one whole copy, once, and has them.
 * 6b. Between two pulls, Bea is re-keyed twice and Cat once. Bea keeps a recovery copy of Cat's. The copy brings the main
 *     server's recovery copies under the last keys only (it moved the same rows each time), and the standby's own go from
 *     under every replaced key: none is left under Bea's first key, nor under Cat's old key and Bea's first.
 * 6c. A re-key's start and its completion stamped in one millisecond reach the standby in two copies: the completion is
 *     taken, with the key that replaced the old one, and the start, again, does not undo it.
 * 6d. Between two pulls, Dan stops going to an event, he and Fay unfriend each other, a convenor removes him from one group
 *     and he leaves another (each delete writing its tombstones, under his key), and he is then re-keyed. The standby's
 *     next pull is a delta, then a whole copy: after each, his RSVPs, friend rows, chat places and group rows are the main
 *     server's. (The standby applies the tombstones naming a key before it follows that key's re-key, as the main server
 *     deleted before it re-keyed; the other way round they named a key no row had any more, and the deleted rows came
 *     back under the new key.)
 * 6e. Eve's deletes come before her re-key and between it and a second one; the standby's next pull is a whole copy, and
 *     it holds her rows as the main server does.
 *  7. The main server dies and the standby takes over. Each replaced key is refused by the middleware, and Rex's old key
 *     at every door (knock, open door, invite, ticket); his new key reads his account. A line in the group chat Dan and Eve
 *     were removed from, and in the event chat they left, goes to neither of them, and neither reads either chat.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-rekey.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

// Every process of this suite: no host but this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Standby-Rekey-Main-Pw-731!';
const PW_STANDBY = 'Standby-Rekey-Standby-Pw-52!';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every column this suite looks at that names a member by key: the same counts on both servers, for each key. */
const KEY_COLUMNS: [string, string][] = [
    ['members', 'public_key'], ['members', 'invited_by'], ['accounts', 'public_key'],
    ['transactions', 'from_pubkey'], ['transactions', 'to_pubkey'], ['posts', 'author_pubkey'],
    ['posts', 'target_pubkey'], ['posts', 'assigned_to'],
    ['event_rsvps', 'member_pubkey'], ['friends', 'owner_pubkey'], ['friends', 'friend_pubkey'],
    ['ratings', 'target_pubkey'], ['ratings', 'rater_pubkey'], ['groups', 'created_by'], ['group_members', 'member_pubkey'],
    ['conversations', 'created_by'], ['conversation_participants', 'public_key'], ['messages', 'author_pubkey'],
    ['open_joins', 'member_pubkey'], ['recovery_shares', 'owner_pubkey'], ['recovery_shares', 'holder_ref'],
];

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const { runNodeChild } = await import('./takeover-test-harness.js');
    await runNodeChild({
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const { ed25519 } = await import('@noble/curves/ed25519.js');
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
            const owner = Buffer.from(ed25519.getPublicKey(Buffer.from(a.ownerSeedHex, 'hex'))).toString('hex');
            se.seedGenesisMember(owner, 'Anna');
            setReplicationToken(a.replicationToken);
            return { owner, code: (await makeRecoveryCode()).code };
        },
        members: async (a: { members: [string, string, string][] }) => {
            const { db } = await import('./db/db.js');
            for (const [name, pk, invitedBy] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, updated_at)
                            VALUES (?, ?, ?, ?, 'TEST', 'active', ?)`).run(pk, name, new Date(Date.now() - 30 * DAY_MS).toISOString(), invitedBy, new Date().toISOString());
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
            }
            return true;
        },
        // A settled trade as the ledger keeps one: the payer's row down, the payee's up, both stamped, and its
        // transaction. Zero-sum, as every trade is; the in-memory ledger is reloaded as a raw-SQL change reloads it.
        trade: async (a: { from: string; to: string; amount: number }) => {
            const { db } = await import('./db/db.js');
            const se = await import('./state-engine.js');
            const now = new Date().toISOString();
            db.transaction(() => {
                db.prepare('UPDATE accounts SET balance = balance - ?, last_updated_at = ? WHERE public_key = ?').run(a.amount, now, a.from);
                db.prepare('UPDATE accounts SET balance = balance + ?, last_updated_at = ? WHERE public_key = ?').run(a.amount, now, a.to);
                db.prepare('INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(crypto.randomUUID(), a.from, a.to, a.amount, 'standby re-key test', now);
            })();
            se.reconcileLedgerFromDb();
            return true;
        },
        // What a member leaves in the tables a re-key moves: some stamped (the main server's copy carries the move), some
        // not (only the standby's own move reaches them), some keyed by the member (a second row beside the moved one).
        'seed-rows': async (a: { pk: string; peer: string; tag: string }) => {
            const { db } = await import('./db/db.js');
            const { sealRecoveryFields, shareRowAad } = await import('./services/recovery-seal-key.js');
            const now = new Date().toISOString();
            const t = a.tag;
            db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at)
                        VALUES (?, 'offer', 'general', 'Firewood', 'Split and dry', 5, ?, ?, ?)`).run(`post-${t}`, a.pk, now, now);
            // A post the peer addressed to them alone, and a task the peer gave them: who may read it and who does it.
            db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, audience_scope, target_pubkey, assigned_to, created_at, updated_at)
                        VALUES (?, 'request', 'general', 'Kindling', 'For you', 0, ?, 'direct', ?, ?, ?, ?)`).run(`post-${t}-for`, a.peer, a.pk, a.pk, now, now);
            db.prepare(`INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, updated_at) VALUES (?, ?, 'going', '', ?)`).run(`post-${t}`, a.pk, now);
            db.prepare('INSERT INTO friends (owner_pubkey, friend_pubkey, added_at) VALUES (?, ?, ?), (?, ?, ?)').run(a.pk, a.peer, now, a.peer, a.pk, now);
            db.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment, transaction_id, created_at)
                        VALUES (?, ?, ?, 'seller', 5, 'Great', ?, ?)`).run(`rating-${t}`, a.pk, a.peer, `tx-${t}`, now);
            db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, join_policy, created_at, updated_at)
                        VALUES (?, ?, ?, 'general', ?, 'open', ?, ?)`).run(`group-${t}`, `Group ${t}`, `group-${t}`, a.pk, now, now);
            db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'convenor', 'active', ?, ?), (?, ?, 'member', 'active', ?, ?)`)
                .run(`group-${t}`, a.pk, now, now, `group-${t}`, a.peer, now, now);
            db.prepare(`INSERT INTO conversations (id, type, created_by, created_at) VALUES (?, 'dm', ?, ?)`).run(`conv-${t}`, a.pk, now);
            db.prepare('INSERT INTO conversation_participants (conversation_id, public_key, last_read_at) VALUES (?, ?, ?), (?, ?, ?)').run(`conv-${t}`, a.pk, now, `conv-${t}`, a.peer, now);
            db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp) VALUES (?, ?, ?, 'c', 'n', 'text', ?)`).run(`msg-${t}`, `conv-${t}`, a.pk, now);
            db.prepare('INSERT INTO open_joins (member_pubkey, provider, join_hash, joined_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(a.pk, 'google', `hash-${t}`, now, now);
            // A recovery copy of theirs, wrapped as this server stores one, and a keeper copy of the peer's that they hold.
            const insertShare = db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, kdf_params, generation, created_at, updated_at)
                                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
            const own = sealRecoveryFields({ encryptedShare: `share-${t}`, shareIv: 'iv', shareTag: 'tag', kdfParams: '{"alg":"sso-single"}' }, shareRowAad(a.pk, 'sso'));
            insertShare.run(a.pk, 'sso', 'google', 1, own.encryptedShare, own.shareIv, own.shareTag, own.kdfParams, now, now);
            const kept = sealRecoveryFields({ encryptedShare: `keeper-${t}`, shareIv: 'iv', shareTag: 'tag', kdfParams: null }, shareRowAad(a.peer, 'member'));
            insertShare.run(a.peer, 'member', a.pk, 2, kept.encryptedShare, kept.shareIv, kept.shareTag, kept.kdfParams, now, now);
            return true;
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        'set-bio': async (a: { pk: string; bio: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('UPDATE members SET bio = ? WHERE public_key = ?').run(a.bio, a.pk).changes;
        },
        // The copy as a main server makes it; `withoutReplacedKeys`: as one from before this version, signed all the same.
        export: async (a: { since?: string; withoutReplacedKeys?: boolean }) => {
            const se = await import('./state-engine.js');
            const payload: any = await se.exportSyncState('main-server', a.since ?? null);
            if (!a.withoutReplacedKeys) return payload;
            const { signature: _sig, publicKey: _pub, invalidatedKeys: _keys, ...unsigned } = payload;
            return se.signSyncPayload(unsigned);
        },
        import: async (a: { payload: any }) => {
            const { importRemoteState } = await import('./state-engine.js');
            return importRemoteState(a.payload);
        },
        now: async () => new Date().toISOString(),
        reseal: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return (await flushTakeoverChecks()).envelopeId;
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
        envelope: async () => {
            const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return pullTakeoverEnvelopeNow();
        },
        // The puller's next pull, of the kind it chooses; `whole` forces a routine whole copy (the reconcile timer, due).
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            try {
                const result = await pullNow();
                const status = getBackupStatus();
                return { ...result, whole: status.lastFullReconcileAt !== before, consistency: status.consistency };
            } finally {
                delete process.env.BACKUP_RECONCILE_EVERY_MS;
            }
        },
        state: async (a: { keys: string[] }) => {
            const { db } = await import('./db/db.js');
            const keyRows: Record<string, Record<string, number>> = {};
            for (const key of a.keys) {
                keyRows[key] = {};
                for (const [table, column] of KEY_COLUMNS) {
                    keyRows[key][`${table}.${column}`] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(key) as { n: number }).n;
                }
            }
            const members = Object.fromEntries(a.keys.map((k) => [k,
                db.prepare('SELECT callsign, status, bio, updated_at FROM members WHERE public_key = ?').get(k) ?? null]));
            return {
                keyRows,
                members,
                accounts: db.prepare('SELECT public_key, balance FROM accounts ORDER BY public_key').all(),
                sum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
                invalidated: db.prepare('SELECT public_key, reason, rekeyed_to FROM invalidated_keys ORDER BY public_key').all(),
                marker: (db.prepare("SELECT value FROM node_config WHERE key = 'replicated_invalidated_keys_v1'").get() as { value: string } | undefined)?.value ?? null,
            };
        },
        // A standby as a version from before this left it: no replaced key of its main server's, and no word of them.
        'as-old-standby': async () => {
            const { db } = await import('./db/db.js');
            db.prepare('DELETE FROM invalidated_keys').run();
            db.prepare("DELETE FROM node_config WHERE key = 'replicated_invalidated_keys_v1'").run();
            return true;
        },
        // The replaced keys of two copies, merged as an import merges them: a re-key's start, then its completion stamped
        // in the same millisecond, then the start again. The rows are this command's own and go when it is done.
        'merge-same-stamp': async () => {
            const { db } = await import('./db/db.js');
            const { mergeReplicatedInvalidatedKeys } = await import('./engine/key-move.js');
            const oldKey = crypto.randomBytes(32).toString('hex'), newKey = crypto.randomBytes(32).toString('hex');
            const at = new Date().toISOString();
            const started = { publicKey: oldKey, reason: 'rekey_pending', invalidatedAt: at, rekeyedTo: null };
            const completed = { publicKey: oldKey, reason: 'rekeyed', invalidatedAt: at, rekeyedTo: newKey };
            const row = () => db.prepare('SELECT reason, rekeyed_to FROM invalidated_keys WHERE public_key = ?').get(oldKey) as { reason: string; rekeyed_to: string | null } | undefined;
            try {
                mergeReplicatedInvalidatedKeys([started]);
                const first = mergeReplicatedInvalidatedKeys([completed]);
                const afterCompleted = row();
                const again = mergeReplicatedInvalidatedKeys([started]);
                const twice = mergeReplicatedInvalidatedKeys([completed]);
                return { newKey, first, afterCompleted, again, twice, afterAgain: row() };
            } finally {
                db.prepare('DELETE FROM invalidated_keys WHERE public_key = ?').run(oldKey);
            }
        },
        // A group chat, a second group, an event with its chat, and friends, made as members make them (state-engine.ts).
        'social-setup': async (a: { owner: string; members: string[]; friend: string }) => {
            const se = await import('./state-engine.js');
            const { db } = await import('./db/db.js');
            // A photo, which posting asks of its author.
            db.prepare('UPDATE members SET avatar_url = ? WHERE public_key = ?').run('data:image/png;base64,iVBORw0KGgo=', a.owner);
            const kept = se.createGroup({ name: 'Garden', createdBy: a.owner, joinPolicy: 'open' });
            const left = se.createGroup({ name: 'Choir', createdBy: a.owner, joinPolicy: 'open' });
            const event = se.createPost('event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', a.owner, -28.55, 153.5, [], false, undefined, false,
                { eventStartAt: new Date(Date.now() + DAY_MS).toISOString(), eventPlaceName: 'The old bowls club', eventPrivateNote: 'Gate code 1234' });
            if (!event) throw new Error('no event');
            for (const pk of [...a.members, a.friend]) {
                se.joinGroup(kept.id, pk);
                se.joinGroup(left.id, pk);
                se.rsvpEvent(event.id, pk, 'going');
            }
            for (const pk of a.members) {
                se.addFriend(pk, a.friend);
                se.addFriend(a.friend, pk);
            }
            return { keptGroup: kept.id, leftGroup: left.id, event: event.id };
        },
        // Each delete as the member or convenor makes it, each writing its tombstones.
        'not-going': async (a: { event: string; pk: string }) => {
            const se = await import('./state-engine.js');
            return se.rsvpEvent(a.event, a.pk, null).success;
        },
        unfriend: async (a: { owner: string; friend: string }) => {
            const se = await import('./state-engine.js');
            return se.removeFriend(a.owner, a.friend);
        },
        'group-remove': async (a: { group: string; actor: string; target: string }) => {
            const se = await import('./state-engine.js');
            return se.removeGroupMember(a.group, a.actor, a.target);
        },
        // The rows a delete removes, for each key: friends, RSVPs, chat participants and group memberships.
        'social-rows': async (a: { keys: string[] }) => {
            const { db } = await import('./db/db.js');
            const marks = a.keys.map(() => '?').join(', ');
            return {
                friends: db.prepare(`SELECT owner_pubkey, friend_pubkey FROM friends WHERE owner_pubkey IN (${marks}) OR friend_pubkey IN (${marks})
                                     ORDER BY owner_pubkey, friend_pubkey`).all(...a.keys, ...a.keys),
                rsvps: db.prepare(`SELECT post_id, member_pubkey, status FROM event_rsvps WHERE member_pubkey IN (${marks}) ORDER BY post_id, member_pubkey`).all(...a.keys),
                participants: db.prepare(`SELECT conversation_id, public_key FROM conversation_participants WHERE public_key IN (${marks})
                                          ORDER BY conversation_id, public_key`).all(...a.keys),
                groupMembers: db.prepare(`SELECT group_id, member_pubkey, role, status FROM group_members WHERE member_pubkey IN (${marks})
                                          ORDER BY group_id, member_pubkey`).all(...a.keys),
            };
        },
        // A line in the group's chat and one in the event's, as their author posts them, and who each goes to live; and
        // whether each key may read either chat.
        'chat-reach': async (a: { group: string; event: string; author: string; keys: string[] }) => {
            const { postGroupThreadMessage, canReadGroupThread } = await import('./engine/group-thread.js');
            const { postEventThreadMessage, canReadEventThread, loadEventForThread } = await import('./engine/event-thread.js');
            const sent: { threadType?: string; recipients?: string[] }[] = [];
            const cb = { broadcast: (event: any, recipients?: string[]) => { sent.push({ threadType: event?.threadType, recipients }); }, dispatchPushNotification: () => {} };
            postGroupThreadMessage(cb as any, a.group, a.author, 'Seedlings on Saturday');
            postEventThreadMessage(cb as any, a.event, a.author, 'Gloves are in the shed');
            const event = loadEventForThread(a.event);
            return {
                sent,
                reads: Object.fromEntries(a.keys.map((k) => [k, { group: canReadGroupThread(a.group, k), event: canReadEventThread(event, k) }])),
            };
        },
        'make-invite': async (a: { pk: string }) => {
            const { generateInvite } = await import('./state-engine.js');
            return generateInvite(a.pk)?.code ?? null;
        },
        serve: async () => {
            const { initTls } = await import('./services/tls.js');
            const { startHttpsServer } = await import('./https-server.js');
            await initTls();
            return { port: await startHttpsServer(0) };
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
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * The standby's accounts for the main server's keys. Any other row it holds must hold no Beans: the import makes a zero
 * account for every member row it takes, and the SYSTEM member row, which each server seeds at boot, has no account on
 * the main server. A row with Beans in it would come back here and fail the comparison.
 */
function heldBy(standby: { public_key: string; balance: number }[], main: { public_key: string }[]): unknown[] {
    const keys = new Set(main.map((a) => a.public_key));
    return standby.flatMap((a) => (keys.has(a.public_key) ? [a] : a.balance === 0 ? [] : [a]));
}

interface Id { name: string; pk: string; priv: crypto.KeyObject; seedHex: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        name,
        pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
        priv: privateKey,
        seedHex: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
    };
}

/** A request through the node's real HTTPS stack, signed by `id` when given, as the apps sign one. */
async function call(port: number, id: Id | null, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; body: any }> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`https://127.0.0.1:${port}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

/** An offline ticket, as the app signs one: the payload and its signature, base64 JSON. */
function offlineTicket(inviter: Id): string {
    const payload = JSON.stringify({ i: inviter.pk, t: Date.now() });
    const s = crypto.sign(null, Buffer.from(payload), inviter.priv).toString('base64');
    return Buffer.from(JSON.stringify({ p: payload, s })).toString('base64');
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });
    const anna = newId('Anna');
    const rex = newId('Rex'), rex2 = newId('Rex (new phone)');
    const sue = newId('Sue'), sue2 = newId('Sue (new phone)');
    const tom = newId('Tom'), tom2 = newId('Tom (new phone)');
    const bea = newId('Bea'), cat = newId('Cat');
    const bea2 = newId('Bea (second phone)'), bea3 = newId('Bea (third phone)'), cat2 = newId('Cat (new phone)');
    const dan = newId('Dan'), dan2 = newId('Dan (new phone)'), fay = newId('Fay');
    const eve = newId('Eve'), eve2 = newId('Eve (second phone)'), eve3 = newId('Eve (third phone)');

    /** Both servers agree: each key's rows, every balance and their sum. */
    const agree = async (main: NodeProc, standby: NodeProc, who: string, oldId: Id, newId_: Id) => {
        const keys = [oldId.pk, newId_.pk];
        const m = await main.send('state', { keys });
        const s = await standby.send('state', { keys });
        assert(s.members[newId_.pk]?.callsign === who && s.members[oldId.pk] === null,
            `on the standby, ${who} is the new key, and no member row is left under the old one (${JSON.stringify(s.members)})`);
        const inv = s.invalidated.find((r: any) => r.public_key === oldId.pk);
        assert(inv?.reason === 'rekeyed' && inv?.rekeyed_to === newId_.pk, `the old key is replaced there, by the new one (${JSON.stringify(inv ?? null)})`);
        assert(same(s.keyRows, m.keyRows),
            `every row that named ${who} names the new key there, as on the main server (${JSON.stringify(s.keyRows[newId_.pk])} / ${JSON.stringify(m.keyRows[newId_.pk])})`);
        assert(Object.values(s.keyRows[oldId.pk] as Record<string, number>).every((n) => n === 0), `and none names the old key (${JSON.stringify(s.keyRows[oldId.pk])})`);
        assert(same(heldBy(s.accounts, m.accounts), m.accounts) && s.sum === m.sum && m.accounts.some((a: any) => a.public_key === newId_.pk && a.balance !== 0),
            `every balance is the main server's, ${who}'s under the new key: no Beans moved, none made (sum ${s.sum} / ${m.sum})`);
        return { m, s };
    };

    try {
        // ── 1. A main server ──
        console.log('\n— 1. a main server; Rex, Sue and Tom leave rows in the tables a re-key moves —');
        const main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        const { owner, code } = await main.send('setup-primary', { ownerSeedHex: anna.seedHex, replicationToken });
        require_(owner === anna.pk, 'Anna owns the main server');
        await main.send('members', {
            members: [['Rex', rex.pk, owner], ['Sue', sue.pk, owner], ['Tom', tom.pk, owner], ['Bea', bea.pk, owner], ['Cat', cat.pk, rex.pk]],
        });
        await main.send('seed-rows', { pk: rex.pk, peer: bea.pk, tag: 'rex' });
        await main.send('seed-rows', { pk: sue.pk, peer: cat.pk, tag: 'sue' });
        await main.send('seed-rows', { pk: tom.pk, peer: anna.pk, tag: 'tom' });

        // ── 2. Its standby ──
        console.log('\n— 2. its standby copies it, and members trade —');
        await main.send('reseal');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies the main server (${JSON.stringify(seeded)})`);
        require_(await standby.send('envelope') === 'stored', 'and holds its take-over keys');
        // Trades, after the standby's first copy (see the header), and the delta that brings them.
        for (const [from, to, amount] of [[bea, rex, 7], [rex, cat, 2], [cat, sue, 3], [anna, tom, 4]] as [Id, Id, number][]) {
            require_(await main.send('trade', { from: from.pk, to: to.pk, amount }), `${from.name} pays ${to.name} ${amount} Beans`);
        }
        const traded = await standby.send('pull', {});
        require_(traded.ok && !traded.whole, `the standby copies the trades as a delta (${JSON.stringify({ ok: traded.ok, error: traded.error })})`);
        const mt = await main.send('state', { keys: [] });
        const st = await standby.send('state', { keys: [] });
        require_(same(heldBy(st.accounts, mt.accounts), mt.accounts) && st.sum === mt.sum,
            `before any re-key, the standby holds every balance the main server does (${JSON.stringify(mt.accounts.map((a: any) => a.balance))})`);

        // ── 3. A re-key, copied as a delta ──
        console.log('\n— 3. Rex is re-keyed on the main server; the standby\'s next pull is a delta —');
        require_(await main.send('rekey', { oldPk: rex.pk, newPk: rex2.pk, operator: owner }), 'Rex is re-keyed to his new phone\'s key');
        const delta = await standby.send('pull', {});
        assert(delta.ok === true && delta.whole === false, `the standby imports the delta (${JSON.stringify({ ok: delta.ok, error: delta.error, whole: delta.whole })})`);
        const rexAfter = await agree(main, standby, 'Rex', rex, rex2);
        assert(rexAfter.s.members[rex2.pk]?.updated_at === rexAfter.m.members[rex2.pk]?.updated_at,
            `his row keeps the main server's stamp (${rexAfter.s.members[rex2.pk]?.updated_at} / ${rexAfter.m.members[rex2.pk]?.updated_at})`);
        assert(rexAfter.s.keyRows[rex2.pk]['recovery_shares.owner_pubkey'] === 1 && rexAfter.s.keyRows[rex2.pk]['recovery_shares.holder_ref'] === 1,
            'his recovery copy and the keeper copy he holds for Bea are under the new key there, once each');
        await main.send('set-bio', { pk: rex2.pk, bio: 'New phone, same Rex' });
        const later = await standby.send('pull', {});
        const bio = (await standby.send('state', { keys: [rex2.pk] })).members[rex2.pk]?.bio;
        assert(later.ok && !later.whole && bio === 'New phone, same Rex', `a change the main server makes after the re-key reaches the standby by the next delta (${bio})`);

        // ── 4. A re-key, copied whole ──
        console.log('\n— 4. Sue is re-keyed; the standby\'s next pull is a whole copy —');
        require_(await main.send('rekey', { oldPk: sue.pk, newPk: sue2.pk, operator: owner }), 'Sue is re-keyed');
        const whole = await standby.send('pull', { whole: true });
        assert(whole.ok === true && whole.whole === true, `the standby imports the whole copy (${JSON.stringify({ ok: whole.ok, error: whole.error, whole: whole.whole })})`);
        await agree(main, standby, 'Sue', sue, sue2);
        const replaced = whole.consistency?.tables?.find((t: any) => t.name === 'invalidated_keys');
        assert(replaced?.match === true && replaced.primary === 2 && whole.consistency?.sumBalances?.match === true,
            `the replica check counts both replaced keys on each server, and the same Beans (${JSON.stringify(replaced ?? null)}, ${JSON.stringify(whole.consistency?.sumBalances ?? null)})`);

        // ── 5. A standby wedged by a re-key heals ──
        console.log('\n— 5. Tom is re-keyed, and the copy first reaches the standby as a main server from before this version sends it —');
        const sinceTom = await main.send('now');
        require_(await main.send('rekey', { oldPk: tom.pk, newPk: tom2.pk, operator: owner }), 'Tom is re-keyed');
        const oldStyle = await main.send('export', { since: sinceTom, withoutReplacedKeys: true });
        require_(oldStyle.invalidatedKeys === undefined && Array.isArray(oldStyle.members), 'a copy with no replaced keys, as an older main server sends it');
        const wedged = await standby.send('import', { payload: oldStyle }).then(() => null, (e: Error) => e.message);
        assert(typeof wedged === 'string' && /idx_members_callsign_unique/.test(wedged),
            `without the replaced keys the import fails on the members' callsign index, as every pull did before (${wedged})`);
        const healed = await standby.send('pull', {});
        assert(healed.ok === true, `with both servers on this version, the standby's next pull imports, with no force-resync (${JSON.stringify({ ok: healed.ok, error: healed.error, whole: healed.whole })})`);
        await agree(main, standby, 'Tom', tom, tom2);

        // ── 6. Keys replaced before the standby had this version ──
        console.log('\n— 6. a standby from before this version: one whole copy brings the keys replaced before it —');
        await standby.send('as-old-standby');
        const first = await standby.send('pull', {});
        const afterFirst = await standby.send('state', { keys: [] });
        assert(first.ok && !first.whole && afterFirst.invalidated.length === 0,
            `its next pull is a delta, which brings none of them (${afterFirst.invalidated.length}), and the main server's word that it sends them (${afterFirst.marker})`);
        const second = await standby.send('pull', {});
        const afterSecond = await standby.send('state', { keys: [] });
        const mainKeys = (await main.send('state', { keys: [] })).invalidated;
        assert(second.ok && second.whole, `the pull after it is one whole copy (${JSON.stringify({ ok: second.ok, whole: second.whole })})`);
        assert(/Replaced keys: taking one whole copy/.test(standby.output()), 'and the standby says so in its log');
        assert(same(afterSecond.invalidated, mainKeys) && mainKeys.length === 3 && afterSecond.marker === 'copied',
            `it holds every key the main server replaced (${afterSecond.invalidated.length} of ${mainKeys.length})`);
        const third = await standby.send('pull', {});
        assert(third.ok && !third.whole, 'the whole copy was asked for once: the next pull is a delta');

        // ── 6b. Re-keys in a row between two pulls ──
        console.log('\n— 6b. Bea is re-keyed twice, and Cat, whose recovery copy she keeps, once, between two of the standby\'s pulls —');
        await main.send('seed-rows', { pk: bea.pk, peer: cat.pk, tag: 'bea' });
        const beaSeeded = await standby.send('pull', {});
        const beforeHops = await standby.send('state', { keys: [bea.pk, cat.pk] });
        require_(beaSeeded.ok && beforeHops.keyRows[bea.pk]['recovery_shares.owner_pubkey'] === 2 && beforeHops.keyRows[bea.pk]['recovery_shares.holder_ref'] === 1
            && beforeHops.keyRows[cat.pk]['recovery_shares.owner_pubkey'] === 2,
            `the standby holds Bea's two recovery copies, the copy of Cat's she keeps, and Cat's two (${JSON.stringify(beforeHops.keyRows[bea.pk])})`);
        require_(await main.send('rekey', { oldPk: bea.pk, newPk: bea2.pk, operator: owner }), 'Bea is re-keyed');
        require_(await main.send('rekey', { oldPk: bea2.pk, newPk: bea3.pk, operator: owner }), 'and re-keyed again');
        require_(await main.send('rekey', { oldPk: cat.pk, newPk: cat2.pk, operator: owner }), 'and Cat is re-keyed');
        const hops = await standby.send('pull', {});
        assert(hops.ok === true && hops.whole === false, `the standby imports the delta that carries all three (${JSON.stringify({ ok: hops.ok, error: hops.error, whole: hops.whole })})`);
        const hopKeys = [bea.pk, bea2.pk, bea3.pk, cat.pk, cat2.pk];
        const mh = await main.send('state', { keys: hopKeys });
        const sh = await standby.send('state', { keys: hopKeys });
        assert(sh.members[bea3.pk]?.callsign === 'Bea' && sh.members[cat2.pk]?.callsign === 'Cat'
            && [bea.pk, bea2.pk, cat.pk].every((k) => sh.members[k] === null),
            `on the standby, Bea is her third key and Cat his new one, and no member row is left under a replaced key (${JSON.stringify(sh.members)})`);
        assert(same(sh.invalidated, mh.invalidated), 'it holds every replaced key as the main server does, each with the key that replaced it');
        assert(same(sh.keyRows, mh.keyRows),
            `every row names the key the main server has it under (${JSON.stringify(sh.keyRows[bea.pk])} / ${JSON.stringify(mh.keyRows[bea.pk])})`);
        assert([bea.pk, bea2.pk, cat.pk].every((k) => Object.values(sh.keyRows[k] as Record<string, number>).every((n) => n === 0)),
            `none names a replaced key: no recovery copy is left under one (${JSON.stringify(sh.keyRows[bea.pk])}, ${JSON.stringify(sh.keyRows[cat.pk])})`);
        assert(sh.keyRows[bea3.pk]['recovery_shares.owner_pubkey'] === 2 && sh.keyRows[bea3.pk]['recovery_shares.holder_ref'] === 1
            && sh.keyRows[cat2.pk]['recovery_shares.owner_pubkey'] === 2,
            `Bea's two copies and the copy of Cat's she keeps are under her last key, and Cat's two under his new one, once each (${JSON.stringify(sh.keyRows[bea3.pk])})`);
        assert(same(heldBy(sh.accounts, mh.accounts), mh.accounts) && sh.sum === mh.sum, `every balance is the main server's (sum ${sh.sum} / ${mh.sum})`);

        // ── 6c. A re-key's two steps in one millisecond ──
        console.log('\n— 6c. a re-key started and completed in the same millisecond, in two copies —');
        const tie = await standby.send('merge-same-stamp');
        assert(tie.first.written === 1 && tie.afterCompleted?.reason === 'rekeyed' && tie.afterCompleted?.rekeyed_to === tie.newKey,
            `the completion is taken, with the key that replaced the old one (${JSON.stringify(tie.afterCompleted ?? null)}, ${JSON.stringify(tie.first)})`);
        assert(tie.again.kept === 1 && tie.twice.kept === 1 && tie.afterAgain?.reason === 'rekeyed' && tie.afterAgain?.rekeyed_to === tie.newKey,
            `the start, again, does not undo it, and the completion again is kept as it is (${JSON.stringify(tie.afterAgain ?? null)})`);

        // ── 6d. A delete, then a re-key, between two pulls: a delta, then a whole copy ──
        console.log('\n— 6d. Dan stops going, unfriends Fay, is removed from one group and leaves another, and is then re-keyed, between two pulls —');
        await main.send('members', { members: [['Dan', dan.pk, owner], ['Eve', eve.pk, owner], ['Fay', fay.pk, owner]] });
        const social = await main.send('social-setup', { owner, members: [dan.pk, eve.pk], friend: fay.pk });
        const socialSeeded = await standby.send('pull', {});
        const danBefore = await standby.send('social-rows', { keys: [dan.pk] });
        require_(socialSeeded.ok && danBefore.rsvps.length === 1 && danBefore.friends.length === 2
            && danBefore.groupMembers.filter((g: any) => g.status === 'active').length === 2 && danBefore.participants.length === 3,
            `the standby holds Dan's RSVP, both friend rows, his two groups and the three chats he is in (${JSON.stringify(danBefore)})`);
        require_(await main.send('not-going', { event: social.event, pk: dan.pk }), 'Dan is no longer going to the working bee');
        require_(await main.send('unfriend', { owner: dan.pk, friend: fay.pk }) && await main.send('unfriend', { owner: fay.pk, friend: dan.pk }),
            'Dan and Fay unfriend each other');
        require_(await main.send('group-remove', { group: social.keptGroup, actor: owner, target: dan.pk }), 'Anna removes Dan from the garden group');
        require_(await main.send('group-remove', { group: social.leftGroup, actor: dan.pk, target: dan.pk }), 'Dan leaves the choir');
        require_(await main.send('rekey', { oldPk: dan.pk, newPk: dan2.pk, operator: owner }), 'and Dan is re-keyed');
        const danKeys = [dan.pk, dan2.pk];
        const mainDan = await main.send('social-rows', { keys: danKeys });
        require_(mainDan.friends.length === 0 && mainDan.rsvps.length === 0 && mainDan.participants.length === 0
            && same(mainDan.groupMembers.map((g: any) => [g.group_id, g.member_pubkey, g.status]), [[social.keptGroup, dan2.pk, 'removed']]),
            `on the main server Dan has no RSVP, no friend and no chat, and his only group row is the removal, under his new key (${JSON.stringify(mainDan)})`);
        /** Each table as the main server holds it, on the standby, for these keys. */
        const socialAgrees = async (who: string, keys: string[], main_: any, when: string) => {
            const s = await standby.send('social-rows', { keys });
            assert(same(s.rsvps, main_.rsvps), `${when}, ${who}'s RSVPs on the standby are the main server's (${JSON.stringify(s.rsvps)} / ${JSON.stringify(main_.rsvps)})`);
            assert(same(s.friends, main_.friends), `${when}, ${who}'s friend rows are (${JSON.stringify(s.friends)} / ${JSON.stringify(main_.friends)})`);
            assert(same(s.participants, main_.participants),
                `${when}, the chats ${who} is in are (${JSON.stringify(s.participants)} / ${JSON.stringify(main_.participants)})`);
            assert(same(s.groupMembers, main_.groupMembers),
                `${when}, ${who}'s group rows are (${JSON.stringify(s.groupMembers)} / ${JSON.stringify(main_.groupMembers)})`);
            const [ms, ss] = [await main.send('state', { keys }), await standby.send('state', { keys })];
            assert(same(ss.keyRows, ms.keyRows), `${when}, every row that names ${who} does (${JSON.stringify(ss.keyRows)} / ${JSON.stringify(ms.keyRows)})`);
        };
        const danDelta = await standby.send('pull', {});
        assert(danDelta.ok === true && danDelta.whole === false, `the standby imports the delta (${JSON.stringify({ ok: danDelta.ok, error: danDelta.error, whole: danDelta.whole })})`);
        await socialAgrees('Dan', danKeys, mainDan, 'after the delta');
        const danWhole = await standby.send('pull', { whole: true });
        assert(danWhole.ok === true && danWhole.whole === true, `the standby then imports a whole copy (${JSON.stringify({ ok: danWhole.ok, error: danWhole.error, whole: danWhole.whole })})`);
        await socialAgrees('Dan', danKeys, mainDan, 'after the whole copy');

        // ── 6e. Deletes before and between two re-keys, copied whole ──
        console.log('\n— 6e. Eve stops going and unfriends Fay, is re-keyed, is removed from one group, leaves the other and is unfriended, and is re-keyed again; the standby\'s next pull is a whole copy —');
        require_(await main.send('not-going', { event: social.event, pk: eve.pk }), 'Eve is no longer going to the working bee');
        require_(await main.send('unfriend', { owner: eve.pk, friend: fay.pk }), 'Eve unfriends Fay');
        require_(await main.send('rekey', { oldPk: eve.pk, newPk: eve2.pk, operator: owner }), 'Eve is re-keyed');
        require_(await main.send('unfriend', { owner: fay.pk, friend: eve2.pk }), 'Fay unfriends Eve, under her new key');
        require_(await main.send('group-remove', { group: social.keptGroup, actor: owner, target: eve2.pk }), 'Anna removes Eve from the garden group');
        require_(await main.send('group-remove', { group: social.leftGroup, actor: eve2.pk, target: eve2.pk }), 'Eve leaves the choir');
        require_(await main.send('rekey', { oldPk: eve2.pk, newPk: eve3.pk, operator: owner }), 'and Eve is re-keyed again');
        const eveKeys = [eve.pk, eve2.pk, eve3.pk];
        const mainEve = await main.send('social-rows', { keys: eveKeys });
        require_(mainEve.friends.length === 0 && mainEve.rsvps.length === 0 && mainEve.participants.length === 0
            && same(mainEve.groupMembers.map((g: any) => [g.group_id, g.member_pubkey, g.status]), [[social.keptGroup, eve3.pk, 'removed']]),
            `on the main server Eve has no RSVP, no friend and no chat, and her only group row is the removal, under her last key (${JSON.stringify(mainEve)})`);
        const eveWhole = await standby.send('pull', { whole: true });
        assert(eveWhole.ok === true && eveWhole.whole === true, `the standby imports the whole copy (${JSON.stringify({ ok: eveWhole.ok, error: eveWhole.error, whole: eveWhole.whole })})`);
        await socialAgrees('Eve', eveKeys, mainEve, 'after the whole copy');

        // ── 7. The take-over ──
        console.log('\n— 7. the main server dies and the standby takes over —');
        await main.send('reseal');
        const envelope = await standby.send('envelope');
        require_(envelope === 'stored' || envelope === 'unchanged', `the standby holds the main server's latest take-over keys (${envelope})`);
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        require_(standby.ready.role === 'primary', 'it is the main server');
        const port = (await standby.send('serve')).port as number;

        const me = (id: Id) => call(port, id, 'GET', '/api/community/me');
        for (const id of [rex, sue, tom]) {
            const r = await me(id);
            assert(r.status === 403 && r.body?.code === 'key_invalidated', `${id.name}'s old key signs nothing on the new main server: the middleware refuses it (${r.status} ${JSON.stringify(r.body)})`);
        }
        const rexNow = await me(rex2);
        assert(rexNow.status === 200, `Rex's new key reads his account there (${rexNow.status} ${JSON.stringify(rexNow.body)?.slice(0, 120)})`);
        const knock = await call(port, rex, 'POST', '/api/join/knock', { callsign: 'Rex', message: 'Hello, I lost my phone.' });
        assert(knock.status === 403 && knock.body?.code === 'key_invalidated', `the knock door refuses his old key (${knock.status} ${JSON.stringify(knock.body)})`);
        const door = await call(port, rex, 'POST', '/api/join/sso-nonce', {});
        assert(door.status === 403 && door.body?.code === 'key_invalidated', `the open door refuses it (${door.status} ${JSON.stringify(door.body)})`);
        const inviteCode = await standby.send('make-invite', { pk: anna.pk });
        require_(typeof inviteCode === 'string', `Anna makes an invite on the new main server (${inviteCode})`);
        const invite = await call(port, null, 'POST', '/api/invite/redeem', { code: inviteCode, publicKey: rex.pk, callsign: 'RexAgain' });
        assert(invite.status === 400 && /replaced by a new one/.test(invite.body?.error ?? ''), `an invite refuses it (${invite.status} ${JSON.stringify(invite.body)})`);
        const ticket = await call(port, null, 'POST', '/api/invite/redeem-offline', { ticketB64: offlineTicket(anna), publicKey: rex.pk, callsign: 'RexAgain' });
        assert(ticket.status === 400 && /replaced by a new one/.test(ticket.body?.error ?? ''), `an offline ticket refuses it (${ticket.status} ${JSON.stringify(ticket.body)})`);

        // What the deletes before a re-key keep from a member who was removed, after a take-over.
        const gone = [dan, dan2, eve, eve2, eve3];
        const reach = await standby.send('chat-reach', { group: social.keptGroup, event: social.event, author: anna.pk, keys: [dan2.pk, eve3.pk, fay.pk] });
        const groupLine = reach.sent.find((s: any) => s.threadType === 'group_thread');
        const eventLine = reach.sent.find((s: any) => s.threadType === 'event_thread');
        assert(groupLine?.recipients?.includes(fay.pk) && !gone.some((id) => groupLine.recipients.includes(id.pk)),
            `a line in the garden group's chat goes to Fay, and to neither Dan nor Eve, whom it removed, under any key (${JSON.stringify(groupLine ?? null)})`);
        assert(eventLine?.recipients?.includes(fay.pk) && !gone.some((id) => eventLine.recipients.includes(id.pk)),
            `a line in the working bee's chat goes to Fay, and to neither Dan nor Eve, who are not going (${JSON.stringify(eventLine ?? null)})`);
        assert(reach.reads[fay.pk]?.group && reach.reads[fay.pk]?.event
            && [dan2, eve3].every((id) => reach.reads[id.pk]?.group === false && reach.reads[id.pk]?.event === false),
            `neither Dan nor Eve reads either chat, or the working bee's note; Fay reads both (${JSON.stringify(reach.reads)})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby keeps up with re-keys, and a server that takes over refuses a replaced key at every door.');
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
