import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeGroupEpochRecord, openGroupEpochRecord, openGroupLine, sealGroupLine } from '../group-crypto.js';
import { guestChatId, guestClosedWords, type GuestChats } from '../group-guest-chat.js';
import { answerGuestInvitation, leaveGuestChat, sendGuestLine, syncGuestMail, GUEST_CURSOR_META, type GuestMailIO } from '../group-guest-mail.js';
import { relayEnvelopeVerifies, signRelayEnvelope, type RelayItem } from '../relay-envelope.js';

// G2: the guest's round and sends against a fake of their own community's server (engine/group-guest-home.ts's routes):
// write before confirm, the yes, the join epoch made on the device, a line sealed under it and posted as a signed relay item.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-guest-mail.test ${name}`));
    return { seedHex: bytesToHex(seed), pk: bytesToHex(ed25519.getPublicKey(seed)), name };
}
const ana = person('Ana'), gus = person('Gus');
const HOST = 'riverside.example', HOME = 'hillside.example', GROUP = 'grp-tools';
const ID = guestChatId(HOST, GROUP);

/** My server's word on an item: its state, and the host's refusal when it gave one. */
type Answer = { state: string; refused?: string };

function fake() {
    let chats: GuestChats = {};
    const meta = new Map<string, string>();
    const held: Array<{ id: string; host: string; group: string; kind: string; data: unknown; receivedAt: number }> = [];
    const groups: unknown[] = [];
    const posted: RelayItem[] = [];
    const confirmed: string[] = [];
    // As the real home keeps group_guest_sent: one row per item id, and an id it has is answered with that row, never sent
    // again (engine/group-guest-home.ts sendGroupItems); each change of a row is a tick after the device's cursor.
    const rows = new Map<string, Answer & { kind: string; at: number }>();
    let clock = 1;
    let answer: (item: RelayItem) => Answer = () => ({ state: 'sent' });
    let saves = 0;
    let failSave = false;
    let ids = 0;
    const settle = (itemId: string, a: Answer) => {
        const row = rows.get(itemId)!;
        rows.set(itemId, { ...row, ...a, refused: a.refused, at: ++clock });
    };
    const io: GuestMailIO = {
        me: gus.pk, myEdPrivHex: gus.seedHex,
        home: async () => HOME,
        device: async () => 'device-aaaaaaaa',
        get: async (path) => {
            expect(path).toMatch(/^\/api\/mail\/group\?device=device-aaaaaaaa/);
            const q = new URLSearchParams(path.split('?')[1]);
            const since = Number(q.get('since') ?? 0), sinceId = q.get('sinceId') ?? '';
            const sent = [...rows.entries()]
                .filter(([id, r]) => r.at > since || (r.at === since && id > sinceId))
                .sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1))
                .map(([itemId, r]) => ({ itemId, kind: r.kind, host: HOST, group: GROUP, state: r.state, refused: r.refused ?? null, at: r.at }));
            // Where I stand, as the real home lists it: a group set here by the test, else the link an invitation made
            // (`invited`; `in` once the host took my yes; not listed once it took my no).
            const listed = [...groups] as Array<{ host: string; group: string }>;
            for (const h of held) {
                if (h.kind !== 'invite' || listed.some((l) => l.host === h.host && l.group === h.group)) continue;
                const answers = posted.filter((p) => p.envelope.kind === 'group-invite' && rows.get(p.envelope.itemId)?.state === 'sent');
                const last = answers.length ? (JSON.parse(answers[answers.length - 1].payload) as { answer: string }).answer : null;
                if (last === 'no') continue;
                listed.push({ host: h.host, group: h.group, state: last === 'yes' ? 'in' : 'invited', roster: null, rosterAt: null } as never);
            }
            // A leave the host took moves my link to `left`, which the home lists no more (moveLinkOn, part 2).
            const leftThere = posted.some((p) => p.envelope.kind === 'group-leave' && rows.get(p.envelope.itemId)?.state === 'sent');
            const shown = leftThere ? listed.filter((l) => !(l.host === HOST && l.group === GROUP)) : listed;
            return { items: held.filter((h) => !confirmed.includes(h.id)), more: false, groups: shown, sent, sentMore: false };
        },
        post: async (path, body: any) => {
            if (path === '/api/mail/group/confirm') { confirmed.push(...body.ids); return { confirmed: body.ids.length }; }
            expect(path).toBe('/api/mail/send');
            return {
                items: body.items.map((i: RelayItem) => {
                    const id = i.envelope.itemId;
                    if (!rows.has(id)) {
                        posted.push(i);
                        rows.set(id, { kind: i.envelope.kind, ...answer(i), at: ++clock });
                    }
                    const r = rows.get(id)!;
                    return r.refused ? { itemId: id, state: r.state, refused: r.refused } : { itemId: id, state: r.state };
                }),
            };
        },
        sign: (f) => signRelayEnvelope(f, async (d) => ed25519.sign(d, Buffer.from(gus.seedHex, 'hex'))),
        load: async () => JSON.parse(JSON.stringify(chats)),
        save: async (c) => { if (failSave) throw new Error('disk'); saves++; chats = JSON.parse(JSON.stringify(c)); },
        getMeta: async (k) => meta.get(k) ?? null,
        setMeta: async (k, v) => { meta.set(k, v); },
        isBlocked: async () => false,
        now: () => Date.parse('2026-11-16T10:00:00.000Z'),
        newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    };
    return {
        io, held, groups, posted, confirmed, get chats() { return chats; }, meta, setFailSave: (b: boolean) => { failSave = b; }, get saves() { return saves; },
        /** How my server answers each new item from now on. */
        answerWith: (f: (item: RelayItem) => Answer) => { answer = f; },
        /** My server settles an item later (the host answered at a retry): a tick for the next round. */
        settle,
    };
}

const inviteNotice = (id: string) => ({ id, host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ana.pk, name: 'Ana' } }, receivedAt: 1 });
const rosterOf = (epoch: unknown) => ({ name: 'Tools', members: [{ key: ana.pk, name: 'Ana' }], guests: [{ key: gus.pk, home: HOME, name: 'Gus' }], epoch });

/** Gus in the chat at the host, the roster saying `epoch`; the round not run yet. */
async function guestIn(epoch: unknown = { current: 1, stale: true }) {
    const f = fake();
    f.held.push(inviteNotice('n-invite-r2'));
    await syncGuestMail(f.io);
    await answerGuestInvitation(f.io, ID, 'yes');
    f.groups.push({ host: HOST, group: GROUP, state: 'in', rosterAt: 2, roster: rosterOf(epoch) });
    return f;
}

/** An epoch Ana made over Ana and Gus, as a roster carries it (Gus's wrap only). */
function anasEpoch(epoch: number) {
    const made = makeGroupEpochRecord({ myEdPrivHex: ana.seedHex, groupId: GROUP, epoch, reason: 'rotate', subject: null, createdAt: '2026-11-16T09:00:00.000Z', recipients: [ana.pk, gus.pk] });
    const { groupId: _g, wraps, ...record } = made.record;
    return { key: made.groupKey, roster: { current: epoch, stale: false, record, wraps: wraps!.filter((w) => w.recipient === gus.pk).map((w) => ({ ...w, wrapper: ana.pk })) } };
}

describe("the guest's round and sends", () => {
    it('a notice is confirmed only after the chats are written; a failed write confirms nothing', async () => {
        const f = fake();
        f.held.push({ id: 'n-invite-1', host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ana.pk, name: 'Ana' } }, receivedAt: 1 });
        f.setFailSave(true);
        await expect(syncGuestMail(f.io)).rejects.toThrow('disk');
        expect(f.confirmed).toEqual([]);
        f.setFailSave(false);
        expect(await syncGuestMail(f.io)).toMatchObject({ notices: 1, changed: true });
        expect(f.confirmed).toEqual(['n-invite-1']);
        expect(f.chats[ID]).toMatchObject({ state: 'invited', name: 'Tools' });
        expect(f.meta.has(GUEST_CURSOR_META)).toBe(false);
    });

    it('yes, then the join epoch made here, then my line under it, each a relay item I signed to group:<id> at the host', async () => {
        const f = fake();
        f.held.push({ id: 'n-invite-2', host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ana.pk, name: 'Ana' } }, receivedAt: 1 });
        await syncGuestMail(f.io);
        await answerGuestInvitation(f.io, ID, 'yes');
        expect(f.chats[ID].state).toBe('joining');
        const yes = f.posted[0];
        expect(yes.envelope).toMatchObject({ kind: 'group-invite', senderKey: gus.pk, senderHome: HOME, recipient: `group:${GROUP}`, recipientHome: HOST });
        expect(JSON.parse(yes.payload)).toEqual({ v: 1, answer: 'yes' });
        expect(relayEnvelopeVerifies(yes.envelope)).toBe(true);
        // My line written before the chat opens is refused: nothing is kept or sent while joining.
        expect(await sendGuestLine(f.io, ID, 'too soon')).toBeNull();

        // The host took it: in, and its roster says the epoch is stale. The round makes my join epoch.
        f.groups.push({ host: HOST, group: GROUP, state: 'in', rosterAt: 2, roster: {
            name: 'Tools', members: [{ key: ana.pk, name: 'Ana' }], guests: [{ key: gus.pk, home: HOME, name: 'Gus' }], epoch: { current: 1, stale: true },
        } });
        await syncGuestMail(f.io);
        expect(f.chats[ID].state).toBe('in');
        const epochItem = f.posted.find((p) => p.envelope.kind === 'group-epoch')!;
        const record = JSON.parse(epochItem.payload).epoch;
        expect(record).toMatchObject({ epoch: 2, reason: 'join', createdBy: gus.pk });
        // A second round makes no second epoch.
        await syncGuestMail(f.io);
        expect(f.posted.filter((p) => p.envelope.kind === 'group-epoch')).toHaveLength(1);

        const line = await sendGuestLine(f.io, ID, '  hello, tools group  ');
        expect(line).toMatchObject({ text: 'hello, tools group', state: 'sent' });
        const lineItem = f.posted.find((p) => p.envelope.kind === 'group-line')!;
        expect(lineItem.envelope.itemId).toBe(line!.id);
        const payload = JSON.parse(lineItem.payload);
        expect(payload).toMatchObject({ clientId: line!.id, metadata: { epoch: 2 }, type: 'text' });
        // Ana, a member at the host, opens it with the key from my epoch's record, as from any member's line.
        const key = openGroupEpochRecord({ ...record, groupId: GROUP }, ana.seedHex, { groupId: GROUP, epoch: 2 });
        expect(openGroupLine(payload, { groupId: GROUP, epoch: 2, senderPubHex: gus.pk, messageId: line!.id }, key).text).toBe('hello, tools group');
    });

    it('an epoch my server never took (the request failed) is made again at the next round, so a waiting line is not stuck', async () => {
        const f = fake();
        f.held.push({ id: 'n-invite-4', host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ana.pk, name: 'Ana' } }, receivedAt: 1 });
        await syncGuestMail(f.io);
        await answerGuestInvitation(f.io, ID, 'yes');
        f.groups.push({ host: HOST, group: GROUP, state: 'in', rosterAt: 2, roster: {
            name: 'Tools', members: [{ key: ana.pk, name: 'Ana' }], guests: [{ key: gus.pk, home: HOME, name: 'Gus' }], epoch: { current: 1, stale: true },
        } });
        const realPost = f.io.post;
        f.io.post = async (path, body: any) => {
            if (path === '/api/mail/send' && body.items.some((i: RelayItem) => i.envelope.kind === 'group-epoch')) throw new Error('network');
            return realPost(path, body);
        };
        await expect(syncGuestMail(f.io)).rejects.toThrow('network');
        expect(f.chats[ID].epochSent).toBeNull();
        expect(f.chats[ID].keys).toEqual({});
        f.io.post = realPost;
        await syncGuestMail(f.io);
        expect(f.posted.filter((p) => p.envelope.kind === 'group-epoch')).toHaveLength(1);
        expect(f.chats[ID].epochSent).toBe(2);
    });

    it('no answers to an invitation that is not waiting; a no declines it', async () => {
        const f = fake();
        await answerGuestInvitation(f.io, ID, 'yes');
        expect(f.posted).toEqual([]);
        f.held.push({ id: 'n-invite-3', host: HOST, group: GROUP, kind: 'invite', data: { name: 'Tools', invitedBy: { key: ana.pk, name: 'Ana' } }, receivedAt: 1 });
        await syncGuestMail(f.io);
        await answerGuestInvitation(f.io, ID, 'no');
        expect(f.chats[ID].state).toBe('declined');
        expect(JSON.parse(f.posted[0].payload)).toEqual({ v: 1, answer: 'no' });
    });
});

describe('round 2 (#3246): the round against a home that counts each item id once', () => {
    const kind = (f: ReturnType<typeof fake>, k: string) => f.posted.filter((p) => p.envelope.kind === k);

    it('IDS: a line refused epoch-stale goes again under a new id, sealed under the next epoch, and is sent (finding 1)', async () => {
        const f = await guestIn();
        await syncGuestMail(f.io);
        expect(f.chats[ID].keys).toHaveProperty('2');
        // A member joined at the host meanwhile: my line under epoch 2 is refused for its epoch.
        f.answerWith((i) => (i.envelope.kind === 'group-line' ? { state: 'refused', refused: 'epoch-stale' } : { state: 'sent' }));
        const line = await sendGuestLine(f.io, ID, 'hello again');
        const first = kind(f, 'group-line')[0].envelope.itemId;
        expect(line).toMatchObject({ state: 'waiting', text: 'hello again' });
        expect(line!.id).not.toBe(first);
        // The roster after the refusal says epoch 2 is stale; the round makes epoch 3, and the line goes under it.
        f.answerWith(() => ({ state: 'sent' }));
        f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: rosterOf({ current: 2, stale: true }) };
        await syncGuestMail(f.io);
        const lines = kind(f, 'group-line');
        expect(lines).toHaveLength(2);
        expect(lines[1].envelope.itemId).not.toBe(first);
        expect(lines[1].envelope.itemId).toBe(f.chats[ID].lines[0].id);
        expect(JSON.parse(lines[1].payload)).toMatchObject({ clientId: lines[1].envelope.itemId, metadata: { epoch: 3 } });
        expect(f.chats[ID].lines[0].state).toBe('sent');
    });

    it.each([
        ['queued (the host not reached yet)', 'waiting', 0, { state: 'queued' }],
        ['taken by the host', 'sent', 1, { state: 'sent' }],
        ['refused by the host', 'waiting', 0, { state: 'refused', refused: 'epoch-stale' }],
    ] as Array<[string, string, number, Answer]>)('EPOCH: my join epoch %s -> my line is %s (%s line items posted)', async (_name, want, linesPosted, epochAnswer) => {
        const f = await guestIn();
        f.answerWith((i) => (i.envelope.kind === 'group-epoch' ? epochAnswer : { state: 'sent' }));
        await syncGuestMail(f.io);
        const line = await sendGuestLine(f.io, ID, 'my words');
        expect(line!.state).toBe(want);
        expect(kind(f, 'group-line')).toHaveLength(linesPosted);
        if (want === 'waiting') expect(f.chats[ID].keys).toEqual({});
    });

    it('EPOCH: queued, then taken at my server\'s retry: the line waits, never "sent", until a round hears it (finding 4)', async () => {
        const f = await guestIn();
        f.answerWith((i) => (i.envelope.kind === 'group-epoch' ? { state: 'queued' } : { state: 'sent' }));
        await syncGuestMail(f.io);
        await sendGuestLine(f.io, ID, 'waits for the host');
        await syncGuestMail(f.io);
        expect(kind(f, 'group-epoch')).toHaveLength(1);
        expect(kind(f, 'group-line')).toHaveLength(0);
        expect(f.chats[ID].lines[0].state).toBe('waiting');
        f.settle(kind(f, 'group-epoch')[0].envelope.itemId, { state: 'sent' });
        await syncGuestMail(f.io);
        const sent = kind(f, 'group-line');
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0].payload).metadata.epoch).toBe(2);
        expect(f.chats[ID].lines[0].state).toBe('sent');
    });

    it('EPOCH: queued, then refused (one made at the same time won): the line goes only under the key the host took (finding 4)', async () => {
        const f = await guestIn();
        f.answerWith((i) => (i.envelope.kind === 'group-epoch' ? { state: 'queued' } : { state: 'sent' }));
        await syncGuestMail(f.io);
        await sendGuestLine(f.io, ID, 'never under a refused key');
        expect(kind(f, 'group-line')).toHaveLength(0);
        f.settle(kind(f, 'group-epoch')[0].envelope.itemId, { state: 'refused', refused: 'epoch-stale' });
        // Ana's epoch 2 won: the roster after the refusal carries it, with my wrap.
        const a2 = anasEpoch(2);
        f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: rosterOf(a2.roster) };
        await syncGuestMail(f.io);
        const sent = kind(f, 'group-line');
        expect(sent).toHaveLength(1);
        expect(kind(f, 'group-epoch')).toHaveLength(1);
        const payload = JSON.parse(sent[0].payload);
        expect(openGroupLine(payload, { groupId: GROUP, epoch: 2, senderPubHex: gus.pk, messageId: sent[0].envelope.itemId }, a2.key).text).toBe('never under a refused key');
        expect(f.chats[ID].lines[0].state).toBe('sent');
    });

    it('a round and a send at the same moment: neither write is lost (the chats are one document, written in turn)', async () => {
        const a1 = anasEpoch(1);
        const f = await guestIn(a1.roster);
        await syncGuestMail(f.io);
        expect(Object.keys(f.chats[ID].keys)).toEqual(['1']);
        const realLoad = f.io.load;
        f.io.load = async () => {
            const c = await realLoad();
            await new Promise((r) => setTimeout(r, 5));
            return c;
        };
        const id = '00000000-0000-4000-8000-0000000000aa';
        const sealed = sealGroupLine('from Ana', { myEdPrivHex: ana.seedHex, groupKey: a1.key, groupId: GROUP, epoch: 1, messageId: id });
        f.held.push({ id: 'n-line-1', host: HOST, group: GROUP, kind: 'line', receivedAt: 3, data: {
            id, author: ana.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type: 'text', metadata: { epoch: 1, sender: ana.pk }, timestamp: '2026-11-16T09:59:00.000Z',
        } });
        await Promise.all([syncGuestMail(f.io), sendGuestLine(f.io, ID, 'mine')]);
        expect(f.chats[ID].lines.map((l) => l.text).sort()).toEqual(['from Ana', 'mine']);
        expect(f.confirmed).toContain('n-line-1');
    });
});

// ── Round 3 (#3246): writes made from the chats as they are; a refused epoch written down ──────────────

const bea = person('Bea');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const kindOf = (f: ReturnType<typeof fake>, k: string) => f.posted.filter((p) => p.envelope.kind === k);

/** Gus in the chat with no key and no epoch made yet: a round moves him in while his server knows no name for itself. */
async function inNoEpoch() {
    const f = await guestIn();
    const realHome = f.io.home;
    f.io.home = async () => null;
    await syncGuestMail(f.io);
    f.io.home = realHome;
    expect(f.chats[ID]).toMatchObject({ state: 'in', keys: {}, ownEpoch: null });
    return f;
}

/** Runs `during` once, while the send is inside its await (signing an item of `kind`, or posting one), then lets it go on. */
function pauseAt(f: ReturnType<typeof fake>, at: 'sign' | 'post', kind: string, during: () => Promise<unknown>) {
    let done = false;
    if (at === 'sign') {
        const real = f.io.sign;
        f.io.sign = async (fields) => {
            if (!done && fields.kind === kind) { done = true; await during(); }
            return real(fields);
        };
    } else {
        const real = f.io.post;
        f.io.post = async (path, body: any) => {
            if (!done && path === '/api/mail/send' && body.items.some((i: RelayItem) => i.envelope.kind === kind)) { done = true; await during(); }
            return real(path, body);
        };
    }
}

/** A line of Ana's under `epoch`, sealed with `key`, as a notice. */
function anaLine(f: ReturnType<typeof fake>, noticeId: string, lineId: string, epoch: number, key: Uint8Array) {
    const sealed = sealGroupLine('from Ana', { myEdPrivHex: ana.seedHex, groupKey: key, groupId: GROUP, epoch, messageId: lineId });
    f.held.push({ id: noticeId, host: HOST, group: GROUP, kind: 'line', receivedAt: 3, data: {
        id: lineId, author: ana.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type: 'text', metadata: { epoch, sender: ana.pk }, timestamp: '2026-11-16T09:59:00.000Z',
    } });
}

describe('round 3 (#3246): every write is made from the chats as they are at that write', () => {
    it("PROBE A (finding A): a send making my epoch, a round landing Ana's line meanwhile and confirming it: her line is never lost", async () => {
        const f = await inNoEpoch();
        const a1 = anasEpoch(1);
        const ANA = '00000000-0000-4000-8000-0000000000a1';
        pauseAt(f, 'sign', 'group-epoch', async () => {
            anaLine(f, 'n-ana-1', ANA, 1, a1.key);
            await syncGuestMail(f.io);
            expect(f.chats[ID].held.map((h) => h.id)).toEqual([ANA]);
        });
        await sendGuestLine(f.io, ID, 'hi');
        expect(f.confirmed).toContain('n-ana-1');
        expect(f.chats[ID].held.map((h) => h.id)).toEqual([ANA]);
        // The notice was confirmed, so it is never served again: the copy here is the only one, and it stays.
        await syncGuestMail(f.io);
        expect(f.chats[ID].held.map((h) => h.id)).toEqual([ANA]);
        expect(kindOf(f, 'group-epoch')).toHaveLength(1);
        expect(f.chats[ID].lines.map((l) => [l.text, l.state])).toEqual([['hi', 'sent']]);
    });

    // (write path: a send inside its await) x (a write landing then) -> both are kept.
    const a1 = anasEpoch(1), a2 = anasEpoch(2);
    const ANA = '00000000-0000-4000-8000-0000000000a2';
    const paths: Record<string, { setup: () => Promise<ReturnType<typeof fake>>; at: 'sign' | 'post'; kind: string }> = {
        'my join epoch, being signed': { setup: inNoEpoch, at: 'sign', kind: 'group-epoch' },
        'my line, being sealed': { setup: async () => { const f = await guestIn(a1.roster); await syncGuestMail(f.io); return f; }, at: 'sign', kind: 'group-line' },
        'my line, being posted': { setup: async () => { const f = await guestIn(a1.roster); await syncGuestMail(f.io); return f; }, at: 'post', kind: 'group-line' },
    };
    const landing: Record<string, { land: (f: ReturnType<typeof fake>) => Promise<unknown>; kept: (f: ReturnType<typeof fake>) => void }> = {
        "a round's page: Ana's line, its notice confirmed": {
            land: async (f) => { anaLine(f, 'n-ana-2', ANA, 1, a1.key); await syncGuestMail(f.io); },
            kept: (f) => {
                expect(f.confirmed).toContain('n-ana-2');
                expect([...f.chats[ID].lines.map((l) => l.id), ...f.chats[ID].held.map((h) => h.id)]).toContain(ANA);
            },
        },
        'my new line': {
            land: (f) => sendGuestLine(f.io, ID, 'second'),
            kept: (f) => expect(f.chats[ID].lines.map((l) => l.text)).toContain('second'),
        },
        'a roster (the group renamed)': {
            land: async (f) => {
                const g = f.groups[0] as { roster: ReturnType<typeof rosterOf> };
                f.groups[0] = { ...g, roster: { ...g.roster, name: 'Tools and seeds' } };
                await syncGuestMail(f.io);
            },
            kept: (f) => expect([f.chats[ID].name, f.chats[ID].roster?.name]).toEqual(['Tools and seeds', 'Tools and seeds']),
        },
        "a round's page: Ana's epoch 2, its notice confirmed": {
            land: async (f) => {
                f.held.push({ id: 'n-epoch-2', host: HOST, group: GROUP, kind: 'epoch', receivedAt: 3, data: { record: a2.roster.record, wraps: a2.roster.wraps } });
                await syncGuestMail(f.io);
            },
            kept: (f) => {
                expect(f.confirmed).toContain('n-epoch-2');
                expect(f.chats[ID].keys['2']).toBe(b64(a2.key));
            },
        },
    };
    const rows = Object.keys(paths).flatMap((p) => Object.keys(landing).map((l) => [p, l] as [string, string]));
    it.each(rows)('%s, while %s lands -> both are kept', async (p, l) => {
        const path = paths[p];
        const f = await path.setup();
        pauseAt(f, path.at, path.kind, () => landing[l].land(f));
        await sendGuestLine(f.io, ID, 'mine');
        landing[l].kept(f);
        await syncGuestMail(f.io);
        landing[l].kept(f);
        // The send's own write is kept too: my line is here and went once; never a second epoch of mine.
        const mine = f.chats[ID].lines.filter((x) => x.author === gus.pk && x.text === 'mine');
        expect(mine.map((x) => x.state)).toEqual(['sent']);
        expect(kindOf(f, 'group-line').filter((i) => i.envelope.itemId === mine[0].id)).toHaveLength(1);
        expect(kindOf(f, 'group-epoch').length).toBeLessThanOrEqual(1);
    });

    it('my yes to an invitation withdrawn and sent again while the yes was posted answers only the old one: the new one still waits', async () => {
        const f = fake();
        f.held.push(inviteNotice('n-invite-w1'));
        await syncGuestMail(f.io);
        pauseAt(f, 'post', 'group-invite', async () => {
            f.held.push({ id: 'n-removed-w', host: HOST, group: GROUP, kind: 'removed', data: { why: 'removed' }, receivedAt: 2 });
            f.held.push(inviteNotice('n-invite-w2'));
            await syncGuestMail(f.io);
            expect(f.chats[ID]).toMatchObject({ state: 'invited', inviteId: 'n-invite-w2' });
        });
        await answerGuestInvitation(f.io, ID, 'yes');
        expect(f.chats[ID]).toMatchObject({ state: 'invited', inviteId: 'n-invite-w2' });
    });
});

describe('round 3 (#3246): a refused epoch is written on the chat; nothing goes again under it until the host sends something newer', () => {
    /** Gus's line refused under epoch 2 (his own join epoch, taken while the roster still says 1 is stale). */
    async function lineRefused() {
        const f = await guestIn();
        await syncGuestMail(f.io);
        expect(Object.keys(f.chats[ID].keys)).toEqual(['2']);
        f.answerWith(() => ({ state: 'refused', refused: 'epoch-stale' }));
        await sendGuestLine(f.io, ID, 'w');
        expect(f.chats[ID].refusedEpoch).toBe(2);
        return f;
    }
    /** Gus's own join epoch 2 refused (one made at the same time won), his line written after it. */
    async function ownRefused() {
        const f = await guestIn();
        f.answerWith(() => ({ state: 'refused', refused: 'epoch-stale' }));
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ keys: {}, ownEpoch: null });
        await sendGuestLine(f.io, ID, 'w');
        return f;
    }

    it('PROBE B (finding B): a line refused epoch-stale, the roster not come: rounds send nothing more, the line waits', async () => {
        const f = await lineRefused();
        for (let i = 0; i < 4; i++) await syncGuestMail(f.io);
        expect(kindOf(f, 'group-line')).toHaveLength(1);
        expect(kindOf(f, 'group-epoch')).toHaveLength(1);
        expect(f.chats[ID].lines.map((l) => l.state)).toEqual(['waiting']);
    });

    const rosters: Record<string, (f: ReturnType<typeof fake>) => void> = {
        "doesn't come": () => undefined,
        'comes: the epoch it was refused under is stale': (f) => { f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: rosterOf({ current: 2, stale: true }) }; },
        "comes: Ana's epoch 2 is current, with my wrap": (f) => { f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: rosterOf(anasEpoch(2).roster) }; },
        "comes: Ana's epoch 3 is current, with my wrap": (f) => { f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: rosterOf(anasEpoch(3).roster) }; },
        'comes: epoch 1 still stale, with Bea in now': (f) => {
            f.groups[0] = { host: HOST, group: GROUP, state: 'in', rosterAt: 3, roster: { ...rosterOf({ current: 1, stale: true }), members: [{ key: ana.pk, name: 'Ana' }, { key: bea.pk, name: 'Bea' }] } };
        },
    };
    // (what was refused) x (the roster after it) -> the line sealed once under this epoch, or 'waits'; my epochs posted in all.
    const table: Array<[string, string, number | 'waits', number]> = [
        ['my line, under epoch 2', "doesn't come", 'waits', 1],
        ['my line, under epoch 2', 'comes: the epoch it was refused under is stale', 3, 2],
        ['my line, under epoch 2', "comes: Ana's epoch 3 is current, with my wrap", 3, 1],
        ['my line, under epoch 2', 'comes: epoch 1 still stale, with Bea in now', 'waits', 1],
        ['my own epoch 2', "doesn't come", 'waits', 1],
        ['my own epoch 2', "comes: Ana's epoch 2 is current, with my wrap", 2, 1],
        ['my own epoch 2', 'comes: the epoch it was refused under is stale', 3, 2],
        ['my own epoch 2', 'comes: epoch 1 still stale, with Bea in now', 2, 2],
    ];
    it.each(table)('refused: %s; the roster %s -> the line %s (%s epochs of mine posted)', async (what, roster, want, epochs) => {
        const f = what === 'my own epoch 2' ? await ownRefused() : await lineRefused();
        const linesBefore = kindOf(f, 'group-line').length, epochsBefore = kindOf(f, 'group-epoch').length;
        // Meanwhile the host still refuses for the epoch: four rounds with the roster as it was send nothing new.
        for (let i = 0; i < 4; i++) await syncGuestMail(f.io);
        expect([kindOf(f, 'group-line').length, kindOf(f, 'group-epoch').length]).toEqual([linesBefore, epochsBefore]);
        expect(f.chats[ID].lines.map((l) => l.state)).toEqual(['waiting']);
        // Then the roster after the refusal (or none), and the host takes what comes under it.
        rosters[roster](f);
        f.answerWith(() => ({ state: 'sent' }));
        for (let i = 0; i < 3; i++) await syncGuestMail(f.io);
        expect(kindOf(f, 'group-epoch')).toHaveLength(epochs);
        const after = kindOf(f, 'group-line').slice(linesBefore);
        if (want === 'waits') {
            expect(after).toHaveLength(0);
            expect(f.chats[ID].lines.map((l) => l.state)).toEqual(['waiting']);
            return;
        }
        expect(after).toHaveLength(1);
        expect(JSON.parse(after[0].payload).metadata.epoch).toBe(want);
        expect(f.chats[ID].lines.map((l) => [l.id, l.state])).toEqual([[after[0].envelope.itemId, 'sent']]);
    });
});

describe('NOTICES (round 4): the round applies a takedown before it confirms it, and never confirms what it cannot apply', () => {
    it("a convenor's takedown of a line shown here: gone from the stored chats, then confirmed; a kind this phone can't apply is never confirmed, and the round doesn't read the same page again for it", async () => {
        const LINE = '00000000-0000-4000-8000-000000000777';
        const e = anasEpoch(2);
        const f = await guestIn(e.roster);
        const sealed = sealGroupLine('to be taken down', { myEdPrivHex: ana.seedHex, groupKey: e.key, groupId: GROUP, epoch: 2, messageId: LINE });
        f.held.push({
            id: 'n-line-td', host: HOST, group: GROUP, kind: 'line', receivedAt: 3,
            data: { id: LINE, author: ana.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type: 'text', metadata: { epoch: 2, sender: ana.pk }, timestamp: '2026-11-16T09:30:00.000Z' },
        });
        await syncGuestMail(f.io);
        expect(f.chats[ID].lines.map((l) => l.text)).toEqual(['to be taken down']);
        f.held.push({ id: 'n-takedown', host: HOST, group: GROUP, kind: 'edit', data: { id: LINE, action: 'removed', by: 'convenor' }, receivedAt: 4 });
        f.held.push({ id: 'n-later-kind', host: HOST, group: GROUP, kind: 'poll', data: { id: LINE }, receivedAt: 5 });
        // My server says there is more each time, as it would with a full page.
        let gets = 0;
        const get = f.io.get;
        f.io.get = async (path) => { gets++; return { ...(await get(path) as object), more: true }; };
        await syncGuestMail(f.io);
        expect(f.chats[ID].lines).toEqual([]);
        expect(JSON.stringify(f.chats)).not.toContain(LINE);
        expect(f.confirmed).toContain('n-takedown');
        expect(f.confirmed).not.toContain('n-later-kind');
        // The page with the takedown, then the same page again holding only what can't be applied yet: no third read.
        expect(gets).toBe(2);
    });
});

describe("LEAVE (part 2): the guest's Leave closes the chat here at once, and the signed leave goes until the host has it", () => {
    const leaves = (f: ReturnType<typeof fake>) => f.posted.filter((p) => p.envelope.kind === 'group-leave');
    /** Gus in, his join epoch taken, one line of his sent; the chat open here. */
    async function inChat() {
        const f = await guestIn();
        await syncGuestMail(f.io);
        await sendGuestLine(f.io, ID, 'hello from Gus');
        expect(f.chats[ID]).toMatchObject({ state: 'in' });
        return f;
    }
    /** My server's answer to every send from now on fails as a request (can't be reached, or `status`), until the returned undo. */
    function cutOff(f: ReturnType<typeof fake>, status?: number) {
        const real = f.io.post;
        f.io.post = async (path, body) => {
            if (path === '/api/mail/send') throw Object.assign(new Error(status ? `HTTP ${status}` : 'network'), status ? { status } : {});
            return real(path, body);
        };
        return () => { f.io.post = real; };
    }

    it('taken at once: the chat is left here, its keys gone; my leave is a relay item I signed to group:<id> at the host; nothing more goes after', async () => {
        const f = await inChat();
        expect(await leaveGuestChat(f.io, ID)).toBe(true);
        const [leave] = leaves(f);
        expect(leave.envelope).toMatchObject({ kind: 'group-leave', senderKey: gus.pk, senderHome: HOME, recipient: `group:${GROUP}`, recipientHome: HOST });
        expect(JSON.parse(leave.payload)).toEqual({ v: 1 });
        expect(relayEnvelopeVerifies(leave.envelope)).toBe(true);
        expect(f.chats[ID]).toMatchObject({ state: 'left', keys: {}, held: [], ownEpoch: null, leave: null, why: null });
        expect(guestClosedWords(f.chats[ID])).toBe('You left this chat.');
        // The line shown stays; nothing more is sent or written from here.
        expect(f.chats[ID].lines.map((l) => l.text)).toEqual(['hello from Gus']);
        const before = f.posted.length;
        await syncGuestMail(f.io);
        await syncGuestMail(f.io);
        expect(f.posted.length).toBe(before);
        expect(await sendGuestLine(f.io, ID, 'too late')).toBeNull();
        expect(f.chats[ID].state).toBe('left');
    });

    // (what my server answers my leave) -> the leave kept here, and the leaves posted at once. Then a round while my server
    // still lists me in (with the roster): the chat stays left and never opens again; then the host takes it: nothing more.
    const TABLE: Array<[string, (f: ReturnType<typeof fake>) => () => void, { kept: string | null; posts: number }]> = [
        ['taken by the host', () => () => {}, { kept: null, posts: 1 }],
        ['queued (the host not reached yet)', (f) => { f.answerWith((i) => (i.envelope.kind === 'group-leave' ? { state: 'queued' } : { state: 'sent' })); return () => {}; }, { kept: 'queued', posts: 1 }],
        ["my server can't be reached", (f) => cutOff(f), { kept: 'sending', posts: 0 }],
    ];
    it.each(TABLE)('%s: left at once, left while my server still lists me in, one leave until the host has it', async (_name, setUp, want) => {
        const f = await inChat();
        const back = setUp(f);
        expect(await leaveGuestChat(f.io, ID)).toBe(true);
        expect(f.chats[ID].state).toBe('left');
        expect(f.chats[ID].leave?.state ?? null).toBe(want.kept);
        expect(leaves(f)).toHaveLength(want.posts);
        back();
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ state: 'left', keys: {} });
        // Nothing of the chat goes again: the join epoch and the one line are all that were ever posted.
        expect(f.posted.filter((p) => p.envelope.kind === 'group-line' || p.envelope.kind === 'group-epoch')).toHaveLength(2);
        // One leave, under one id (not reached before: the round posted the kept one).
        expect(new Set(leaves(f).map((p) => p.envelope.itemId)).size).toBe(1);
        for (const p of leaves(f)) f.settle(p.envelope.itemId, { state: 'sent' });
        await syncGuestMail(f.io);
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ state: 'left', leave: null });
        expect(new Set(leaves(f).map((p) => p.envelope.itemId)).size).toBe(1);
    });

    it('failed (a day with no answer from the host): a new leave goes under a new id at the next round, and is taken', async () => {
        const f = await inChat();
        f.answerWith((i) => (i.envelope.kind === 'group-leave' ? { state: 'queued' } : { state: 'sent' }));
        await leaveGuestChat(f.io, ID);
        const first = leaves(f)[0].envelope.itemId;
        f.settle(first, { state: 'failed' });
        f.answerWith(() => ({ state: 'sent' }));
        await syncGuestMail(f.io);
        const again = leaves(f);
        expect(again).toHaveLength(2);
        expect(again[1].envelope.itemId).not.toBe(first);
        expect(relayEnvelopeVerifies(again[1].envelope)).toBe(true);
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ state: 'left', leave: null });
        expect(leaves(f)).toHaveLength(2);
    });

    it('kept past what my server takes (7 days): a new one is signed under a new id', async () => {
        const f = await inChat();
        const back = cutOff(f);
        await leaveGuestChat(f.io, ID);
        const kept = f.chats[ID].leave!;
        back();
        const later = Date.parse('2026-11-23T10:00:00.000Z');
        f.io.now = () => later;
        await syncGuestMail(f.io);
        const [posted] = leaves(f);
        expect(posted.envelope.itemId).not.toBe(kept.itemId);
        expect(posted.envelope.at).toBe(later);
        expect(f.chats[ID].leave).toBeNull();
    });

    it('refused for good by my server (403: a leave of mine from another device already waits there): nothing more goes, the chat stays left while I am still listed in, until I am listed no more', async () => {
        const f = await inChat();
        const back = cutOff(f, 403);
        expect(await leaveGuestChat(f.io, ID)).toBe(true);
        expect(f.chats[ID]).toMatchObject({ state: 'left', leave: { state: 'refused', item: null } });
        back();
        const before = f.posted.length;
        // My server still lists me in, with the roster: the chat never opens again, and nothing goes (no epoch, no leave).
        await syncGuestMail(f.io);
        await syncGuestMail(f.io);
        expect(f.posted.length).toBe(before);
        expect(f.chats[ID]).toMatchObject({ state: 'left', keys: {} });
        // The other device's leave taken: my server lists me no more, and nothing is kept.
        f.groups.length = 0;
        f.held.length = 0;
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ state: 'left', leave: null });
    });

    it('a removal my server lists while my leave waits: the chat stays left (my own words), and the leave goes no more', async () => {
        const f = await inChat();
        f.answerWith((i) => (i.envelope.kind === 'group-leave' ? { state: 'queued' } : { state: 'sent' }));
        await leaveGuestChat(f.io, ID);
        f.groups[0] = { host: HOST, group: GROUP, state: 'removed', rosterAt: null, roster: null };
        await syncGuestMail(f.io);
        expect(f.chats[ID]).toMatchObject({ state: 'left', leave: null });
        expect(guestClosedWords(f.chats[ID])).toBe('You left this chat.');
    });

    it('a line of mine still waiting when I leave never goes: it says it was not delivered', async () => {
        const f = await guestIn();
        // My join epoch queued: the line waits for its key.
        f.answerWith((i) => (i.envelope.kind === 'group-epoch' ? { state: 'queued' } : { state: 'sent' }));
        await syncGuestMail(f.io);
        await sendGuestLine(f.io, ID, 'never sent');
        expect(f.chats[ID].lines[0].state).toBe('waiting');
        await leaveGuestChat(f.io, ID);
        f.settle(f.posted.find((p) => p.envelope.kind === 'group-epoch')!.envelope.itemId, { state: 'sent' });
        await syncGuestMail(f.io);
        expect(f.chats[ID].lines[0]).toMatchObject({ text: 'never sent', state: 'failed', item: null });
        expect(f.posted.filter((p) => p.envelope.kind === 'group-line')).toHaveLength(0);
    });

    it("a line of mine my server had when I left, then refused for its epoch: it says the group didn't take it, and never waits in the closed chat", async () => {
        const f = await guestIn();
        await syncGuestMail(f.io);
        f.answerWith((i) => (i.envelope.kind === 'group-line' ? { state: 'queued' } : { state: 'sent' }));
        const line = await sendGuestLine(f.io, ID, 'just before I go');
        expect(line!.state).toBe('queued');
        await leaveGuestChat(f.io, ID);
        f.settle(line!.id, { state: 'refused', refused: 'epoch-stale' });
        await syncGuestMail(f.io);
        expect(f.chats[ID].lines[0]).toMatchObject({ id: line!.id, text: 'just before I go', state: 'failed', note: "The group didn't take this message." });
        expect(f.chats[ID].refusedEpoch ?? null).toBeNull();
        expect(f.posted.filter((p) => p.envelope.kind === 'group-line')).toHaveLength(1);
    });

    it('while joining (my yes on its way): left here, and the leave goes behind the yes', async () => {
        const f = fake();
        f.held.push(inviteNotice('n-invite-leave'));
        await syncGuestMail(f.io);
        await answerGuestInvitation(f.io, ID, 'yes');
        expect(f.chats[ID].state).toBe('joining');
        expect(await leaveGuestChat(f.io, ID)).toBe(true);
        expect(f.chats[ID].state).toBe('left');
        expect(f.posted.map((p) => p.envelope.kind)).toEqual(['group-invite', 'group-leave']);
    });

    it.each(['invited', 'declined', 'left', 'removed'] as const)('nothing to leave when %s: false, nothing posted', async (state) => {
        const f = fake();
        f.held.push(inviteNotice('n-invite-none'));
        await syncGuestMail(f.io);
        await f.io.save({ [ID]: { ...f.chats[ID], state } });
        expect(await leaveGuestChat(f.io, ID)).toBe(false);
        expect(leaves(f)).toHaveLength(0);
        expect(f.chats[ID].state).toBe(state);
    });
});
