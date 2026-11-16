import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { openGroupEpochRecord, openGroupLine } from '../group-crypto.js';
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

function fake() {
    let chats: GuestChats = {};
    const meta = new Map<string, string>();
    const held: Array<{ id: string; host: string; group: string; kind: string; data: unknown; receivedAt: number }> = [];
    const groups: unknown[] = [];
    const posted: RelayItem[] = [];
    const confirmed: string[] = [];
    let saves = 0;
    let failSave = false;
    let ids = 0;
    const io: GuestMailIO = {
        me: gus.pk, myEdPrivHex: gus.seedHex,
        home: async () => HOME,
        device: async () => 'device-aaaaaaaa',
        get: async (path) => {
            expect(path).toMatch(/^\/api\/mail\/group\?device=device-aaaaaaaa/);
            return { items: held.filter((h) => !confirmed.includes(h.id)), more: false, groups, sent: [], sentMore: false };
        },
        post: async (path, body: any) => {
            if (path === '/api/mail/group/confirm') { confirmed.push(...body.ids); return { confirmed: body.ids.length }; }
            expect(path).toBe('/api/mail/send');
            posted.push(...body.items);
            return { items: body.items.map((i: RelayItem) => ({ itemId: i.envelope.itemId, state: 'sent' })) };
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
    return { io, held, groups, posted, confirmed, get chats() { return chats; }, meta, setFailSave: (b: boolean) => { failSave = b; }, get saves() { return saves; } };
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
