import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeGroupEpochRecord, openGroupEpochRecord, openGroupLine, sealGroupLine } from '../group-crypto.js';
import { guestChatId, type GuestChats } from '../group-guest-chat.js';
import { answerGuestInvitation, sendGuestLine, syncGuestMail, GUEST_CURSOR_META, type GuestMailIO } from '../group-guest-mail.js';
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
            return { items: held.filter((h) => !confirmed.includes(h.id)), more: false, groups: listed, sent, sentMore: false };
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
