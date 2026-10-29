/**
 * Home's "A chat" card, the node's half (scratch/fable-design/DESIGN-home-chosen-chat-fable.md §1–§4, slice C1; Marty,
 * 29 Oct 2026: "Accept all five"). Over REAL HTTPS through the real signature middleware, on a local node as it ships.
 *
 *   1. a pinned direct chat: its last 3 lines oldest first, each sealed line's bytes exactly as stored (nothing opened),
 *      the other person's name, the unread count the member's own chat list gives, muted once they mute it; built only
 *      when asked (counted), and with no `cards=` from the member's version-2 layout; never with nothing picked
 *   2. the bound: a sealed line whose ciphertext, nonce and metadata come to 512 characters travels; 513, or a line sent at
 *      600 characters, is `🔒 Message` and its bytes are nowhere in the answer
 *   3. who is answered: an outsider who pins someone else's chat, a group they aren't in, an event chat they have no seat
 *      in or an id nobody has gets `{ gone: 'left' }` and nothing else, the same for each; a request waiting for the
 *      member gets `{ gone: 'request' }` until they accept it (its opener reads their own line); someone who left the
 *      group gets `gone`; an event hidden from someone who had a seat, `hidden`; a blocked opener's own conversation is
 *      theirs as their chat read answers it (nothing says they are blocked)
 *   4. a group's chat: readable lines as their words, a sealed line's bytes, and no line sealed before the reader's
 *      membership (fromEpochOf), as the group's own chat read serves them
 *   5. the tag: a new line in a pinned direct chat (theirs or the member's own) moves it, and the chat stamp names it;
 *      a Home without a chat card asked is a 304 after the same line, and its stamp is the one it had
 *   6. the node opens nothing: home-answer.ts has no decrypting call in it and imports none
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-home-chat-card.ts
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
import { fileURLToPath } from 'node:url';
import { lockedDm } from './dm-test-payload.js';
import { localFetch } from './keepalive-test-fetch.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const DAY = 86_400_000;
const LOCKED = '🔒 Message';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Id = { pk: string; privateKey: crypto.KeyObject; name: string };
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, name };
}
function signedHeaders(method: string, urlPath: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}
let BASE = '';
let beforeCall: () => void = () => {};
type Res = { status: number; text: string; body: any; etag: string | null };
async function get(urlPath: string, id: Id, extra: Record<string, string> = {}): Promise<Res> {
    beforeCall();
    const res = await localFetch(`${BASE}${urlPath}`, { headers: { ...signedHeaders('GET', urlPath, '', id), ...extra } });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* empty (304) */ }
    return { status: res.status, text, body, etag: res.headers.get('etag') };
}
async function postJson(urlPath: string, id: Id, payload: unknown): Promise<Res> {
    beforeCall();
    const body = JSON.stringify(payload);
    const res = await localFetch(`${BASE}${urlPath}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', urlPath, body, id) } });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, body: parsed, etag: res.headers.get('etag') };
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

async function main(): Promise<void> {
    console.log('\n=== Home: a chosen chat (C1) ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { ensureGroupThread } = await import('./engine/group-thread.js');
    const { ensureEventThread } = await import('./engine/event-thread.js');
    // A tree without the card (origin/main) runs every step anyway, so each fails as an assertion rather than an abort.
    const answer: any = await import('./routes/home-answer.js' as string).catch(() => ({}));
    const homeCardBuilds: Record<string, number> = answer.homeCardBuilds ?? {};
    beforeCall = () => { resetGatewayRateLimit(); resetChatRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owner = newId('ChatOwner');
    se.seedGenesisMember(owner.pk, 'ChatOwner');
    const member = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, ?, ?)`)
            .run(id.pk, name, new Date(Date.now() - 60 * DAY).toISOString(), owner.pk, `INV-${name.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const ana = member('ChatAna');
    const ben = member('ChatBen');
    const cy = member('ChatCy');   // in nobody's chat but her own
    const dee = member('ChatDee'); // a stranger to Ana: her first line to Ana waits as a request
    const eve = member('ChatEve'); // blocked by Ana before she writes
    se.reconcileLedgerFromDb();

    const setLayout = (id: Id, cards: { id: string; type: string; settings?: Record<string, unknown> }[]) => db.prepare(
        'INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value',
    ).run(id.pk, 'home.layout', JSON.stringify({ v: 2, cards, dismissed: {}, updatedAt: new Date().toISOString() }));
    const pin = (instance: string, conversationId: string, kind: string, name = 'Picked name') => ({ id: instance, type: 'chat', settings: { conversationId, kind, name } });
    const cardOf = async (id: Id, instance: string, ask = `needs,${instance},community`) => (await get(`/api/home?cards=${ask}`, id)).body?.cards?.[instance];
    const stored = (messageId: string) => db.prepare('SELECT ciphertext, nonce, metadata, author_pubkey, timestamp FROM messages WHERE id = ?').get(messageId) as
        { ciphertext: string; nonce: string; metadata: string | null; author_pubkey: string; timestamp: string } | undefined;

    // ── 1. A pinned direct chat ─────────────────────────────────────────────────────────────────────────────────────
    const opened = await postJson('/api/messages/conversation', ana, { type: 'dm', participants: [ana.pk, ben.pk], createdBy: ana.pk });
    const dmId: string = opened.body?.conversation?.id;
    assert(opened.status === 200 && typeof dmId === 'string', `setup: Ana opens a direct chat with Ben (${opened.status})`);
    const sent: string[] = [];
    const say = async (who: Id, bytes = 32, conversationId = dmId) => {
        const r = await postJson('/api/messages/send', who, { conversationId, authorPubkey: who.pk, ...lockedDm(bytes) });
        const mid = r.body?.message?.id ?? r.body?.id;
        if (conversationId === dmId && mid) sent.push(mid);
        return { r, id: mid as string };
    };
    for (const who of [ana, ben, ana, ben]) await say(who);
    assert(sent.length === 4, `setup: four sealed lines in it, two each (${sent.length})`);

    setLayout(ana, [{ id: 'steps', type: 'steps' }, pin('chat-ana1', dmId, 'dm'), pin('chat-none', '', 'dm')]);
    const before = homeCardBuilds.chat ?? 0;
    const full = await get('/api/home?cards=needs,chat-ana1,community', ana);
    const card = full.body?.cards?.['chat-ana1'];
    assert(full.status === 200 && card?.kind === 'dm' && card?.name === 'ChatBen' && card?.muted === false && Array.isArray(card?.lines),
        `Ana's pinned chat: a direct one, named for Ben, not muted (${show(card)})`);
    assert((homeCardBuilds.chat ?? 0) === before + 1, `built once, as asked (${before} → ${homeCardBuilds.chat})`);
    const lines: any[] = card?.lines ?? [];
    assert(JSON.stringify(lines.map(l => l.id)) === JSON.stringify(sent.slice(1)), `its last 3 lines, oldest first (${show(lines.map(l => l.id))})`);
    const untouched = lines.length === 3 && lines.every(l => {
        const row = stored(l.id);
        return !!row && l.sealed?.ciphertext === row.ciphertext && l.sealed?.nonce === row.nonce && l.sealed?.metadata === (row.metadata ?? null)
            && l.author === row.author_pubkey && l.at === row.timestamp && l.text === undefined && l.type === 'text' && l.systemType === null;
    });
    assert(untouched, `each line's bytes exactly as stored, its author and time, and no words: the node opened nothing (${show(lines[0])})`);
    assert(lines[0]?.who === 'ChatBen' && lines[1]?.who === 'ChatAna' && lines[1]?.author === ana.pk,
        `each line names its author, Ana's own by her key for the device to say "You" (${show(lines.map(l => [l.who, l.author === ana.pk]))})`);
    const talk = await get(`/api/messages/conversations/${ana.pk}`, ana);
    const listed = (talk.body?.conversations ?? []).find((c: any) => c.id === dmId);
    assert(typeof card?.unread === 'number' && card.unread === listed?.unreadCount && card.unread === 2,
        `unread is what her chat list says, Ben's two lines (${card?.unread}, the list ${listed?.unreadCount})`);
    const mute = await postJson('/api/messages/mute', ana, { conversationId: dmId, duration: '8h' });
    assert(mute.status === 200 && (await cardOf(ana, 'chat-ana1'))?.muted === true, `muted once she mutes it (${mute.status})`);

    // Not asked, not built; with no cards=, built from her layout; nothing picked, never built into a card.
    const counted = homeCardBuilds.chat ?? 0;
    const notAsked = await get('/api/home?cards=needs,community', ana);
    assert(notAsked.status === 200 && !('chat-ana1' in (notAsked.body?.cards ?? {})) && (homeCardBuilds.chat ?? 0) === counted,
        `not asked: not built, no chat read (${Object.keys(notAsked.body?.cards ?? {})})`);
    const fromLayout = await get('/api/home', ana);
    assert(fromLayout.body?.cards?.['chat-ana1']?.kind === 'dm' && !('chat-none' in (fromLayout.body?.cards ?? {})),
        `with no cards=, built from her version-2 layout; one with nothing picked has no card (${Object.keys(fromLayout.body?.cards ?? {})})`);
    const unstored = await get('/api/home?cards=needs,chat-zzzz,community', ana);
    assert(!('chat-zzzz' in (unstored.body?.cards ?? {})), 'an instance id her layout does not hold is never built: the settings are the node\'s to read');

    // ── 2. The bound ────────────────────────────────────────────────────────────────────────────────────────────────
    const big = await say(ben, 450);
    const bigRow = stored(big.id);
    const afterBig = await get('/api/home?cards=chat-ana1', ana);
    const bigLine = (afterBig.body?.cards?.['chat-ana1']?.lines ?? []).at(-1);
    assert(!!bigRow && bigRow.ciphertext.length + bigRow.nonce.length > 600 && bigLine?.id === big.id && bigLine?.text === LOCKED
        && bigLine?.sealed === undefined && !afterBig.text.includes(bigRow.ciphertext.slice(0, 40)),
        `a line sent at ${bigRow ? bigRow.ciphertext.length + bigRow.nonce.length : '?'} characters: "${LOCKED}", its bytes nowhere in the answer (${show(bigLine)})`);
    let lineAt = Date.now() + 1000;
    const rawLine = (conversationId: string, author: Id | 'SYSTEM', fields: { ciphertext: string; nonce: string; metadata?: string | null; type?: string; systemType?: string }) => {
        const mid = crypto.randomUUID();
        db.prepare('INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(mid, conversationId, author === 'SYSTEM' ? 'SYSTEM' : author.pk, fields.ciphertext, fields.nonce, fields.type ?? 'text', fields.systemType ?? null,
                fields.metadata ?? null, new Date(lineAt += 1000).toISOString());
        return mid;
    };
    /** A sealed DM line's three stored parts coming to `chars` characters. */
    const dmOf = (chars: number) => {
        const { nonce } = lockedDm();
        const metadata = '{"replyToId":null}';
        const left = chars - nonce.length - metadata.length;
        return { ciphertext: crypto.randomBytes(left).toString('base64').slice(0, left), nonce, metadata };
    };
    const at512 = dmOf(512), at513 = dmOf(513);
    const id512 = rawLine(dmId, ben, at512);
    const id513 = rawLine(dmId, ben, at513);
    const bound = await get('/api/home?cards=chat-ana1', ana);
    const [l512, l513] = (bound.body?.cards?.['chat-ana1']?.lines ?? []).slice(-2);
    assert(l512?.id === id512 && JSON.stringify(l512?.sealed) === JSON.stringify(at512) && l512?.text === undefined,
        `512 characters: its bytes as stored (${show(l512)})`);
    assert(l513?.id === id513 && l513?.text === LOCKED && l513?.sealed === undefined && !bound.text.includes(at513.ciphertext.slice(0, 40)),
        `513: "${LOCKED}" and no bytes (${show(l513)})`);

    // ── 3. Who is answered ──────────────────────────────────────────────────────────────────────────────────────────
    const group = se.createGroup({ name: 'ChatSentinel garden crew', createdBy: ana.pk });
    ensureGroupThread(group.id);
    se.joinGroup(group.id, ben.pk);
    const eventPost = se.createPost('event', 'general', 'ChatSentinel seed swap', 'Swap seeds', 0, 'fixed', ana.pk, -28.6, 153.6, [TINY_PNG], false, undefined, false, {
        eventStartAt: new Date(Date.now() + 3 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 3 * DAY + 3600_000).toISOString(),
    } as any)!;
    ensureEventThread(eventPost.id);
    const nobody = `conv-${crypto.randomUUID()}`;
    setLayout(cy, [pin('chat-cy01', dmId, 'dm', 'Ana and Ben'), pin('chat-cy02', group.id, 'group'), pin('chat-cy03', eventPost.id, 'event'), pin('chat-cy04', nobody, 'dm')]);
    const outsider = await get('/api/home?cards=needs,chat-cy01,chat-cy02,chat-cy03,chat-cy04,community', cy);
    const gone = ['chat-cy01', 'chat-cy02', 'chat-cy03', 'chat-cy04'].map(k => outsider.body?.cards?.[k]);
    assert(outsider.status === 200 && gone.every(g => JSON.stringify(g) === '{"gone":"left"}'),
        `an outsider's pins (someone else's direct chat, a group and an event chat she isn't in, an id nobody has): each { gone: 'left' } alone, the same (${show(gone)})`);
    assert(!outsider.text.includes('ChatBen') && !outsider.text.includes('ChatSentinel') && !sent.some(m => outsider.text.includes(stored(m)!.ciphertext.slice(0, 24))),
        'no name and no line of any of them anywhere in her answer');

    // A request waiting for Ana: gone for her, her own line for its opener.
    db.prepare("INSERT INTO node_config (key, value) VALUES ('nodeProfile.dmRequests', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const asked = await postJson('/api/messages/conversation', dee, { type: 'dm', participants: [dee.pk, ana.pk], createdBy: dee.pk });
    const reqId: string = asked.body?.conversation?.id;
    const deesLine = await say(dee, 32, reqId);
    const waiting = (await get(`/api/messages/conversations/${ana.pk}`, ana)).body?.requests?.conversations ?? [];
    assert(asked.status === 200 && !!reqId && deesLine.r.status === 200 && waiting.some((c: any) => c.id === reqId),
        `setup: with requests on, Dee's first line to Ana waits as a request (${asked.status}, send ${deesLine.r.status}, ${waiting.length} waiting)`);
    setLayout(ana, [pin('chat-ana1', dmId, 'dm'), pin('chat-ana2', reqId, 'dm', 'Dee')]);
    const held = await cardOf(ana, 'chat-ana2');
    assert(JSON.stringify(held) === '{"gone":"request"}', `a request waiting for her: { gone: 'request' }, no name and no line (${show(held)})`);
    setLayout(dee, [pin('chat-dee1', reqId, 'dm', 'Ana')]);
    const deeCard = await cardOf(dee, 'chat-dee1');
    assert(deeCard?.kind === 'dm' && deeCard?.name === 'ChatAna' && deeCard?.lines?.length === 1 && deeCard.lines[0].id === deesLine.id,
        `its opener reads their own line on their card (${show(deeCard)})`);
    const accept = await postJson('/api/messages/request', ana, { conversationId: reqId, decision: 'accept' });
    const accepted = await cardOf(ana, 'chat-ana2');
    assert(accept.status === 200 && accepted?.kind === 'dm' && accepted?.name === 'ChatDee' && accepted?.lines?.[0]?.id === deesLine.id,
        `once she accepts it, it is a chat on her Home (${accept.status} ${show(accepted)})`);
    db.prepare("DELETE FROM node_config WHERE key = 'nodeProfile.dmRequests'").run();

    // Someone who left the group: gone.
    setLayout(ben, [pin('chat-ben1', group.id, 'group'), pin('chat-ben2', dmId, 'dm')]);
    const inGroup = await cardOf(ben, 'chat-ben1');
    assert(inGroup?.kind === 'group' && inGroup?.name === 'ChatSentinel garden crew', `Ben, in the group, has its chat (${show(inGroup)})`);
    db.prepare("UPDATE group_members SET status = 'removed' WHERE group_id = ? AND member_pubkey = ?").run(group.id, ben.pk);
    const left = await cardOf(ben, 'chat-ben1');
    assert(JSON.stringify(left) === '{"gone":"left"}', `removed from it: { gone: 'left' } (${show(left)})`);
    db.prepare("UPDATE group_members SET status = 'active' WHERE group_id = ? AND member_pubkey = ?").run(group.id, ben.pk);

    // An event's chat: its host has it; one hidden by reports is 'hidden' to someone with a seat, still 'left' to anyone else.
    setLayout(ana, [pin('chat-ana1', dmId, 'dm'), pin('chat-ana3', eventPost.id, 'event')]);
    const hosted = await cardOf(ana, 'chat-ana3');
    assert(hosted?.kind === 'event' && hosted?.name === 'ChatSentinel seed swap', `the host has her event's chat (${show(hosted)})`);
    db.prepare('INSERT OR IGNORE INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(eventPost.id, ben.pk);
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), eventPost.id);
    setLayout(ben, [pin('chat-ben3', eventPost.id, 'event')]);
    const hidden = await cardOf(ben, 'chat-ben3');
    const stillLeft = (await get('/api/home?cards=chat-cy03', cy)).body?.cards?.['chat-cy03'];
    assert(JSON.stringify(hidden) === '{"gone":"hidden"}' && JSON.stringify(stillLeft) === '{"gone":"left"}',
        `hidden by reports: 'hidden' to Ben, who had a seat in it, 'left' to Cy, who never did (${show(hidden)}, ${show(stillLeft)})`);
    db.prepare('UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?').run(eventPost.id);

    // A blocked opener: their own conversation, kept for them alone, reads as theirs; the one who blocked them can't pin it.
    const blocked = await postJson('/api/blocks', ana, { targetPubkey: eve.pk });
    const evesOpen = await postJson('/api/messages/conversation', eve, { type: 'dm', participants: [eve.pk, ana.pk], createdBy: eve.pk });
    const keptId: string = evesOpen.body?.conversation?.id;
    const evesLine = await say(eve, 32, keptId);
    setLayout(eve, [pin('chat-eve1', keptId, 'dm', 'Ana')]);
    const evesCard = await cardOf(eve, 'chat-eve1');
    assert(blocked.status === 200 && evesOpen.status === 200 && evesLine.r.status === 200 && evesCard?.kind === 'dm' && evesCard?.name === 'ChatAna'
        && evesCard?.lines?.length === 1 && evesCard.lines[0].sealed?.ciphertext && evesCard.lines[0].author === eve.pk,
        `Eve, whom Ana blocked, reads her own line on her card as on her chat: nothing says she is blocked (${show(evesCard)})`);
    setLayout(ana, [pin('chat-ana4', keptId, 'dm', 'Eve')]);
    const anasTry = await cardOf(ana, 'chat-ana4');
    assert(JSON.stringify(anasTry) === '{"gone":"left"}', `and Ana, pinning its id, gets { gone: 'left' }: Eve's line never reaches her (${show(anasTry)})`);

    // ── 4. A group's chat, as its own read serves it ───────────────────────────────────────────────────────────────
    const plain = (text: string) => ({ ciphertext: Buffer.from(text).toString('base64'), nonce: 'plaintext-v1' });
    const groupSealed = (epoch: number) => ({ ciphertext: crypto.randomBytes(48).toString('base64'), nonce: `group-xc20p-v1:${crypto.randomBytes(24).toString('base64')}`, metadata: JSON.stringify({ epoch }) });
    db.prepare('UPDATE group_members SET from_epoch = ? WHERE group_id = ? AND member_pubkey = ?').run(1, group.id, ana.pk);
    db.prepare('UPDATE group_members SET from_epoch = ? WHERE group_id = ? AND member_pubkey = ?').run(2, group.id, ben.pk);
    const g1 = rawLine(group.id, ana, plain('ChatSentinel who has a ladder?'));
    const old = groupSealed(1);
    const g2 = rawLine(group.id, ana, old);
    const g3 = rawLine(group.id, 'SYSTEM', { ciphertext: 'ChatBen joined the group', nonce: '00000', type: 'system', systemType: 'GROUP_MEMBER_JOINED' });
    const fresh = groupSealed(2);
    const g4 = rawLine(group.id, ben, fresh);
    setLayout(ana, [pin('chat-ana5', group.id, 'group')]);
    setLayout(ben, [pin('chat-ben1', group.id, 'group')]);
    const anasGroup = await cardOf(ana, 'chat-ana5');
    const bensGroup = await cardOf(ben, 'chat-ben1');
    const ids = (c: any) => (c?.lines ?? []).map((l: any) => l.id);
    assert(JSON.stringify(ids(anasGroup)) === JSON.stringify([g2, g3, g4]) && JSON.stringify(anasGroup.lines[0].sealed) === JSON.stringify(old)
        && anasGroup.lines[1].text === 'ChatBen joined the group' && anasGroup.lines[1].who === null && anasGroup.lines[1].systemType === 'GROUP_MEMBER_JOINED'
        && JSON.stringify(anasGroup.lines[2].sealed) === JSON.stringify(fresh),
        `Ana (from epoch 1): the last 3, the sealed ones as stored, the node's own line as its words (${show(ids(anasGroup))})`);
    assert(JSON.stringify(ids(bensGroup)) === JSON.stringify([g1, g3, g4]) && bensGroup.lines[0].text === 'ChatSentinel who has a ladder?'
        && bensGroup.lines[0].sealed === undefined && !JSON.stringify(bensGroup).includes(old.ciphertext),
        `Ben (from epoch 2): never the line sealed before his membership, and a readable line as its words (${show(ids(bensGroup))})`);

    // ── 5. The tag ──────────────────────────────────────────────────────────────────────────────────────────────────
    setLayout(ana, [{ id: 'steps', type: 'steps' }, pin('chat-ana1', dmId, 'dm')]);
    const ASK = '/api/home?cards=needs,chat-ana1,community';
    const start = await get(ASK, ana);
    const same = await get(ASK, ana, { 'If-None-Match': start.etag! });
    assert(same.status === 304, `an unchanged Home with a pinned chat is a 304 (${same.status})`);
    const bens = await say(ben);
    const moved = await get(ASK, ana, { 'If-None-Match': start.etag! });
    assert(moved.status === 200 && moved.etag !== start.etag && moved.body?.cards?.['chat-ana1']?.lines?.at(-1)?.id === bens.id,
        `a new line from Ben in her pinned chat moves the tag, and the card has it (${moved.status})`);
    const noCard = '/api/home?cards=needs,community';
    const plainHome = await get(noCard, ana);
    const anas = await say(ana);
    const unchanged = await get(noCard, ana, { 'If-None-Match': plainHome.etag! });
    const pinnedMoved = await get(ASK, ana, { 'If-None-Match': moved.etag! });
    assert(unchanged.status === 304, `a Home with no chat card asked is still a 304 after her own line in that chat (${unchanged.status})`);
    assert(pinnedMoved.status === 200 && pinnedMoved.body?.cards?.['chat-ana1']?.lines?.at(-1)?.id === anas.id,
        `while the Home that pins it moves on her own line from another device (${pinnedMoved.status})`);
    if (typeof answer.buildHome === 'function') {
        const stamp = (asked: string[]) => answer.buildHome({ actor: ana.pk, point: null, asked }).chatStamp as string | null;
        const withChat = stamp(['needs', 'chat-ana1', 'community']);
        const without = stamp(['needs', 'community']);
        const groupsOnly = (se.listYourChats(ana.pk).items as { lastActivityAt: string }[])
            .reduce<string | null>((n, g) => (n === null || g.lastActivityAt > n ? g.lastActivityAt : n), null);
        assert(!!withChat && withChat.includes(dmId) && withChat.includes(anas.id), `the chat stamp names the pinned chat's newest line (${withChat})`);
        assert(without === groupsOnly && !String(without).includes(dmId), `and a Home with no chat card has the stamp it had: her groups' newest line (${without})`);
    } else {
        assert(false, 'buildHome is exported with its chat stamp');
    }

    // ── 6. The node opens nothing ───────────────────────────────────────────────────────────────────────────────────
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, 'routes/home-answer.ts'), 'utf8');
    const opener = /\b(openDmLine|openDmThread|openGroupLine|openGroupLines|decrypt\w*|createDecipheriv|xchacha20poly1305|secretbox|crypto_box\w*|deriveDmKey|unwrapGroupKey)\b/;
    assert(/\bfunction chatCard\b/.test(source) && !opener.test(source),
        `home-answer.ts, which builds the card, calls and imports nothing that opens a line (${source.match(opener)?.[0] ?? 'none'})`);
    const dmLines = [...(start.body?.cards?.['chat-ana1']?.lines ?? []), ...(moved.body?.cards?.['chat-ana1']?.lines ?? [])];
    assert(dmLines.length > 0 && dmLines.every((l: any) => (l.sealed && l.text === undefined) || l.text === LOCKED),
        'every line of a direct chat in her answers is its sealed bytes, or the lock: never words');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
