/**
 * "Show my community on global", slice F10 (scratch/fable-design/DESIGN-forums-fable.md §12, §15, §16, §21 F10; the joint
 * design §2.6), through the real HTTPS stack and its signature middleware.
 *
 * Two communities' servers in one process, as test-relay-mail has them. The real server is Riverside: its own note route,
 * signed by its own node key (data/libp2p_key, written here as a server's first start writes it). With its `forumPublic`
 * switch on it is also the worldwide forum that checks a note. Hillside, a second community, is played by this suite: its own
 * node key, its notes made by @beanpool/core signMembershipNote, the very call the route makes. The directory the forum keeps
 * (`directory_cache`) is written as the hourly mirror writes it. No other server is asked anything (counted, 0 and 9).
 *
 *  1. The note: a member gets one for their own key, naming the community's directory key (the PeerId its publisher pushes)
 *     and name, for 30 days, signed by the node key; a non-member, an unsigned request and a paused member get none; nor
 *     does a member of a community that isn't listed (Listed off, no name of its own, DIRECTORY_UNLISTED, its closing day);
 *     a standby gives none; a web app on another origin may ask (the preflight).
 *  2. The round trip: Riverside's own note, handed to the forum, draws "· Riverside" on Ada's topic and reply, in the list,
 *     the topic and a search hit; GET /api/forum/label says what is chosen and drawn.
 *  3. Closing the class: (Don't show / community / waiting) x (note fresh / expired / for another key / bad signature /
 *     community unlisted / no note) -> the label drawn, or none, never a wrong one; a refused note changes nothing kept.
 *  4. At each read: a note that lapses since, a community that leaves the directory, a renamed one: no label, then the
 *     directory's name now; the list's tag moves with each, so no list answers "not changed" with a label gone.
 *  5. A forum that is not public: no label drawn, and the label routes answer `not_here`.
 *  6. A standby: the manifest copies forum_labels; a whole copy carries it; the standby draws the same labels and changes
 *     none (503 `standby`).
 *  7. A re-key leaves the old key's label behind, with its tombstone: the new key shows none until it brings a note.
 *  8. Deleting an account deletes its label, with its tombstone.
 *  9. Nothing left this machine: every fetch the process made went to this server.
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-membership-note" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.DIRECTORY_UNLISTED;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MEMBERSHIP_NOTE_MAX_MS, checkMembershipNote, signMembershipNote, type MembershipNote } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState, purgeMemberSelf, setUserStatusRow } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { NODE_PROFILE_KEY } from './config/node-profile.js';
import { updateLocalConfig } from './config/local-config.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { TABLES } from './engine/replication-manifest.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { forgetOwnNodeKeyForTests } from './engine/node-key.js';
import { nodeKeyOfCommunityKey } from './engine/membership-note.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(id: Id | null, method: 'GET' | 'POST' | 'OPTIONS', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'POST' ? JSON.stringify(body ?? {}) : '';
    const h: Record<string, string> = { ...headers };
    if (method === 'POST') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'POST' ? raw : undefined });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 160)}` : '-');
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);
const dropOverride = (name: string) => db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.${name}`);
const tombstone = (table: string, key: string) => !!db.prepare('SELECT 1 FROM tombstones WHERE table_name = ? AND row_key = ?').get(table, key);
const labelRow = (pk: string) => db.prepare('SELECT * FROM forum_labels WHERE member_pubkey = ?').get(pk) as any;
const getNote = (id: Id | null) => call(id, 'GET', '/api/membership/note');
const setLabel = (id: Id, body: Record<string, unknown>) => call(id, 'POST', '/api/forum/label', body);
const labelState = (id: Id) => call(id, 'GET', '/api/forum/label');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A community this suite plays: its node key, its directory key, and notes it signs. */
interface Played { seed: Uint8Array; key: string; note: (member: string, opts?: { issuedAt?: number; expiresAt?: number; name?: string }) => MembershipNote }
async function playCommunity(name: string): Promise<Played> {
    const priv = await generateKeyPair('Ed25519');
    const seed = new Uint8Array(priv.raw.subarray(0, 32));
    const key = peerIdFromPrivateKey(priv).toString();
    return {
        seed, key,
        note: (member, opts = {}) => {
            const issuedAt = opts.issuedAt ?? Date.now();
            return signMembershipNote({ community: key, name: opts.name ?? name, member, issuedAt, expiresAt: opts.expiresAt ?? issuedAt + MEMBERSHIP_NOTE_MAX_MS },
                (b) => ed25519.sign(b, seed));
        },
    };
}
/** A directory row as the hourly mirror writes one (engine/directory-cache.ts). */
function listInDirectory(key: string, name: string | null, listed: 0 | 1): void {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO directory_cache (community_key, listed, name, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(community_key) DO UPDATE SET listed = excluded.listed, name = excluded.name, updated_at = excluded.updated_at`).run(key, listed, name, now, now);
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('BEANPOOL_DATA_DIR must be set to a fresh directory');
    await ensureGenesis();
    await initTls();
    initStateEngine();
    // Riverside's node key, as its first start writes it (p2p.ts): the key its directory key (its PeerId) names.
    const riversideKey = await generateKeyPair('Ed25519');
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(riversideKey));
    forgetOwnNodeKeyForTests();
    const riversidePeerId = peerIdFromPrivateKey(riversideKey).toString();
    updateLocalConfig({ communityName: 'Riverside' });
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // Every fetch this process makes from here on: the suite's own go to BASE; anything else would be a server asked.
    const outside: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
        const url = String(input?.url ?? input);
        if (!url.startsWith(BASE)) outside.push(url);
        return realFetch(input, init);
    }) as typeof fetch;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const [ada, bo, cy] = ['Ada', 'Bo', 'Cy'].map(newId);
    for (const who of [ada, bo, cy]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    const stranger = newId('Stranger');

    // ── 1. The note, on the member's own community ────────────────────────────────────────────────────────────────
    console.log('── 1. the note ──');
    const n1 = await getNote(ada);
    const note = n1.body?.note as MembershipNote;
    assert(n1.status === 200 && note?.member === ada.pk && note.name === 'Riverside' && note.community === riversidePeerId
        && note.expiresAt - note.issuedAt === MEMBERSHIP_NOTE_MAX_MS && Math.abs(note.issuedAt - Date.now()) < 60_000 && n1.headers.get('cache-control') === 'no-store',
        `1. a member gets a note for their own key: the community's directory key and name, 30 days (${show(n1)})`);
    assert(checkMembershipNote(note, { member: ada.pk, communityPublicKey: nodeKeyOfCommunityKey(riversidePeerId), now: Date.now() }).ok,
        '1. signed by the node key its directory key names');
    const noNote = [await getNote(stranger), await getNote(null)];
    assert(noNote.every((r) => r.status >= 400 && r.status < 500 && !r.body?.note) && noNote[0].status === 403,
        `1. a non-member and an unsigned request get no note (${noNote.map((r) => r.status).join()})`);
    setUserStatusRow(cy.pk, 'disabled');
    const paused = await getNote(cy);
    assert(paused.status === 403 && paused.body?.code === 'not_active' && !paused.body?.note, `1. a paused member gets none (${show(paused)})`);
    setUserStatusRow(cy.pk, 'active');
    const notListed: [string, () => void, () => void][] = [
        ['Listed off', () => setOverride('publishToDirectory', 'false'), () => dropOverride('publishToDirectory')],
        ['no name of its own', () => updateLocalConfig({ communityName: '' }), () => updateLocalConfig({ communityName: 'Riverside' })],
        ['DIRECTORY_UNLISTED', () => { process.env.DIRECTORY_UNLISTED = '1'; }, () => { delete process.env.DIRECTORY_UNLISTED; }],
    ];
    for (const [why, on, off] of notListed) {
        on();
        const r = await getNote(ada);
        off();
        assert(r.status === 409 && r.body?.code === 'not_listed' && r.body?.error === 'Your community isn’t listed publicly, so its name can’t be shown.' && !r.body?.note,
            `1. a community not listed gives no note: ${why} (${show(r)})`);
    }
    setNodeRole('backup');
    const standbyNote = await getNote(ada);
    setNodeRole('primary');
    assert(standbyNote.status === 503 && standbyNote.body?.code === 'standby' && !standbyNote.body?.note, `1. a standby gives none (${show(standbyNote)})`);
    const preflight = await call(null, 'OPTIONS', '/api/membership/note', undefined, {
        Origin: 'https://forum.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-signature, x-public-key',
    });
    assert(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*' && /GET/.test(preflight.headers.get('access-control-allow-methods') ?? '')
        && !preflight.headers.get('access-control-allow-credentials'), '1. a web app on another origin may ask for it, with no credential');

    // ── 2. The round trip, on the worldwide forum ─────────────────────────────────────────────────────────────────
    console.log('── 2. the round trip ──');
    const local = await labelState(ada);
    assert(local.status === 404 && local.body?.code === 'not_here', `2. a forum that is not public has no label to set (${show(local)})`);
    setOverride('forumPublic', 'true');
    const hillside = await playCommunity('Hillside');
    const unlisted = await playCommunity('Lakeside');
    listInDirectory(riversidePeerId, 'Riverside', 1);
    listInDirectory(hillside.key, 'Hillside', 1);
    listInDirectory(unlisted.key, null, 0);
    const before = await labelState(ada);
    assert(before.status === 200 && same(before.body, { show: 'none', community: null, lapsesAt: null, label: null, why: null }), `2. off by default (${show(before)})`);
    const set = await setLabel(ada, { show: 'community', note });
    assert(set.status === 200 && same(set.body?.label, { kind: 'community', community: 'Riverside' }) && set.body?.show === 'community'
        && set.body?.community?.key === riversidePeerId && set.body?.lapsesAt === new Date(note.expiresAt).toISOString(),
        `2. Riverside's own note shows "· Riverside" at once (${show(set)})`);
    assert(same(Object.keys(labelRow(ada.pk)).sort(), ['community_key', 'kind', 'lapses_at', 'member_pubkey', 'updated_at']) && !JSON.stringify(labelRow(ada.pk)).includes(note.sig),
        '2. the forum keeps the community and until when, never the note');
    const sections = (await call(ada, 'GET', '/api/forum')).body?.sections as any[];
    const section = sections?.[0]?.id as string;
    for (const who of [ada, bo, cy]) require_((await call(who, 'POST', '/api/forum/told', {})).status === 200, `${who.name} is told the forum is public`);
    const adaTopic = await call(ada, 'POST', '/api/forum/topics', { sectionId: section, title: 'Seed swap at the hall', words: 'Bring seeds marigold' });
    require_(adaTopic.status === 201, `Ada starts a topic (${show(adaTopic)})`);
    const boTopic = await call(bo, 'POST', '/api/forum/topics', { sectionId: section, title: 'Bo asks about tools', words: 'Who has a ladder' });
    require_(boTopic.status === 201, `Bo starts a topic (${show(boTopic)})`);
    const boTopicId = boTopic.body?.topic?.id as string;
    require_((await call(ada, 'POST', `/api/forum/topics/${boTopicId}/replies`, { words: 'I have one' })).status === 201, 'Ada replies to Bo');
    const writerIn = async (reader: Id, who: Id) => {
        const list = await call(reader, 'GET', '/api/forum/topics');
        const t = (list.body?.topics as any[] ?? []).find((x) => x.writer?.publicKey === who.pk);
        return t ? t.writer : null;
    };
    const RIVERSIDE = { kind: 'community', community: 'Riverside' };
    const adaInList = await writerIn(bo, ada);
    const inTopic = await call(bo, 'GET', `/api/forum/topics/${boTopicId}`);
    const adaReply = (inTopic.body?.posts as any[] ?? []).find((p) => p.writer?.publicKey === ada.pk);
    const search = await call(bo, 'GET', `/api/forum/search?q=${encodeURIComponent('marigold')}`);
    assert(same(adaInList?.label, RIVERSIDE) && same(adaReply?.writer?.label, RIVERSIDE) && same(search.body?.hits?.[0]?.writer?.label, RIVERSIDE)
        && same(inTopic.body?.topic?.writer?.label, null), `2. in the list, the topic and a search hit (${show(search)})`);

    // ── 3. Closing the class ──────────────────────────────────────────────────────────────────────────────────────
    console.log('── 3. the class table ──');
    const notes: Record<string, () => unknown> = {
        fresh: () => hillside.note(bo.pk),
        expired: () => hillside.note(bo.pk, { issuedAt: Date.now() - MEMBERSHIP_NOTE_MAX_MS - 3_600_000, expiresAt: Date.now() - 3_600_000 }),
        'for another key': () => hillside.note(ada.pk),
        'bad signature': () => ({ ...unlisted.note(bo.pk), community: hillside.key }),
        'community unlisted': () => unlisted.note(bo.pk),
        'no note': () => undefined,
    };
    const refusals: Record<string, [number, string]> = {
        expired: [400, 'note_expired'], 'for another key': [403, 'note_other_key'], 'bad signature': [400, 'note_bad_signature'],
        'community unlisted': [409, 'not_listed'], 'no note': [400, 'note_malformed'],
    };
    // Dated ahead of this server's clock, or promising more than 30 days: refused for its dates, never as one that ran out.
    const ahead = await setLabel(bo, { show: 'community', note: hillside.note(bo.pk, { issuedAt: Date.now() + 3_600_000 }) });
    const tooLong = await setLabel(bo, { show: 'community', note: hillside.note(bo.pk, { expiresAt: Date.now() + MEMBERSHIP_NOTE_MAX_MS + 3_600_000 }) });
    assert([ahead, tooLong].every((r) => r.status === 400 && r.body?.code === 'note_bad_time' && /clock/.test(r.body?.error ?? '')) && !labelRow(bo.pk),
        `3. a note dated ahead, or promising more than 30 days: refused for its dates (${show(ahead)} / ${show(tooLong)})`);
    for (const choice of ['none', 'community', 'waiting'] as const) {
        for (const [kind, make] of Object.entries(notes)) {
            require_((await setLabel(bo, { show: 'none' })).status === 200 && !labelRow(bo.pk), `Bo starts from Don't show (${choice} x ${kind})`);
            const r = await setLabel(bo, { show: choice, note: make() });
            const drawn = (await writerIn(ada, bo))?.label ?? null;
            const want = choice === 'none' ? null : choice === 'waiting' ? { kind: 'waiting' } : kind === 'fresh' ? { kind: 'community', community: 'Hillside' } : null;
            const refusal = choice === 'community' ? refusals[kind] : undefined;
            assert(same(drawn, want) && (refusal ? r.status === refusal[0] && r.body?.code === refusal[1] && !labelRow(bo.pk) : r.status === 200 && same(r.body?.label, want)),
                `3. ${choice} x ${kind}: ${want ? JSON.stringify(want) : 'no label'} (${show(r)})`);
        }
    }
    // A refused note changes nothing kept: Bo's Hillside label stays when a bad note follows it.
    await setLabel(bo, { show: 'community', note: hillside.note(bo.pk) });
    const kept = await setLabel(bo, { show: 'community', note: notes['bad signature']() });
    assert(kept.status === 400 && same((await writerIn(ada, bo))?.label, { kind: 'community', community: 'Hillside' }), '3. a refused note leaves what was kept');
    const odd = await setLabel(bo, { show: 'everyone' });
    assert(odd.status === 400 && odd.body?.code === 'bad_request', `3. a fourth choice is no choice (${show(odd)})`);

    // ── 4. At each read ───────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 4. at each read ──');
    const tagOf = async (who: Id) => (await call(who, 'GET', '/api/forum/topics')).headers.get('etag') ?? '';
    const notChanged = async (who: Id, etag: string) => (await call(who, 'GET', '/api/forum/topics', undefined, { 'If-None-Match': etag })).status === 304;
    let etag = await tagOf(cy);
    require_(etag && await notChanged(cy, etag), 'an unchanged list answers 304');
    db.prepare('UPDATE forum_labels SET lapses_at = ? WHERE member_pubkey = ?').run(new Date(Date.now() - 1000).toISOString(), bo.pk);
    const lapsed = await labelState(bo);
    assert(!(await notChanged(cy, etag)) && (await writerIn(cy, bo))?.label === null && lapsed.body?.why === 'expired' && lapsed.body?.label === null,
        `4. a note that lapsed since: no label, and the list is not "not changed" (${show(lapsed)})`);
    etag = await tagOf(cy);
    listInDirectory(riversidePeerId, null, 0);
    const gone = await labelState(ada);
    assert(!(await notChanged(cy, etag)) && (await writerIn(cy, ada))?.label === null && gone.body?.why === 'not_listed' && gone.body?.community?.name === null,
        `4. a community that left the directory: no label (${show(gone)})`);
    listInDirectory(riversidePeerId, 'Riverside Commons', 1);
    assert(same((await writerIn(cy, ada))?.label, { kind: 'community', community: 'Riverside Commons' }), '4. listed again, renamed: the directory\'s name now');
    listInDirectory(riversidePeerId, 'Riverside', 1);

    // ── 5. A forum that is not public ─────────────────────────────────────────────────────────────────────────────
    console.log('── 5. not public ──');
    dropOverride('forumPublic');
    const offRead = await writerIn(cy, ada);
    const offRoutes = [await labelState(ada), await setLabel(ada, { show: 'waiting' })];
    assert(offRead && offRead.label === null && offRoutes.every((r) => r.status === 404 && r.body?.code === 'not_here') && labelRow(ada.pk)?.kind === 'community',
        `5. no label drawn on a members' forum, and nothing to set (${offRoutes.map(show).join(' / ')})`);
    setOverride('forumPublic', 'true');

    // ── 6. A standby ──────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 6. a standby ──');
    const entry = (TABLES as any).forum_labels;
    assert(entry?.kind === 'replicated' && entry?.plain === true && same(entry.columns, ['member_pubkey', 'kind', 'community_key', 'lapses_at', 'updated_at']),
        '6. the manifest copies forum_labels as a plain table, every column');
    const copy = await exportSyncState('test-membership-note') as any;
    assert((copy.plainTables?.forum_labels ?? []).some((r: any) => r.member_pubkey === ada.pk && r.community_key === riversidePeerId), '6. a whole copy carries it');
    const onMain = { list: await writerIn(cy, ada), state: (await labelState(ada)).body };
    setNodeRole('backup');
    const onStandby = { list: await writerIn(cy, ada), state: (await labelState(ada)).body };
    const standbyWrite = await setLabel(ada, { show: 'none' });
    setNodeRole('primary');
    assert(same(onStandby, onMain) && same(onMain.list?.label, RIVERSIDE), '6. a standby draws the same label and answers the same');
    assert(standbyWrite.status === 503 && standbyWrite.body?.code === 'standby' && labelRow(ada.pk), `6. and changes none (${show(standbyWrite)})`);

    // ── 7. A re-key ───────────────────────────────────────────────────────────────────────────────────────────────
    console.log('── 7. a re-key ──');
    await setLabel(bo, { show: 'community', note: hillside.note(bo.pk) });
    require_(labelRow(bo.pk)?.kind === 'community', 'Bo shows Hillside');
    const boNew = newId('Bo');
    db.transaction(() => moveMemberKeyRows(bo.pk, boNew.pk, new Date().toISOString(), { keepStamps: false }))();
    assert(!labelRow(bo.pk) && !labelRow(boNew.pk) && tombstone('forum_labels', bo.pk), '7. the old key\'s label is left behind with its tombstone, not moved to the new key');
    assert((await writerIn(cy, boNew))?.label === null, '7. the new key shows its name alone');

    // ── 8. Deleting an account ────────────────────────────────────────────────────────────────────────────────────
    console.log('── 8. deleting an account ──');
    const purged = purgeMemberSelf(ada.pk);
    require_(purged.ok, `Ada deletes her account (${purged.message})`);
    assert(!labelRow(ada.pk) && tombstone('forum_labels', ada.pk), '8. her label goes, with its tombstone');

    // ── 9. Nothing left this machine ──────────────────────────────────────────────────────────────────────────────
    console.log('── 9. no other server ──');
    assert(outside.length === 0, `9. no fetch left this server (${outside.join(', ') || 'none'})`);

    globalThis.fetch = realFetch;
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
