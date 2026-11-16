import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeGroupEpochRecord, openGroupLine, sealGroupLine } from '../group-crypto.js';
import {
    applyGuestMail, applyGuestTicks, gateGuestNotice, guestAccess, guestChatAuthorName, guestChatId, guestEpochDue, guestLinePayload,
    guestSealEpoch, guestViewerOf, makeGuestEpochFor, readGuestChats,
    type GuestAccess, type GuestChat, type GuestChats, type GuestScreen, type GuestViewer,
} from '../group-guest-chat.js';
import * as core from '../index.js';

// G2: a guest's side of a group hosted by another community, on their own device. Three tables (who sees what; the request
// gate; what a server page does to the chats) and the whole way in: invitation, yes, the guest's own epoch, a line each way.

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-guest-chat.test ${name}`));
    return { seedHex: bytesToHex(seed), pk: bytesToHex(ed25519.getPublicKey(seed)), name };
}
const ana = person('Ana'), ben = person('Ben'), gus = person('Gus'), stray = person('Stray');
const HOST = 'riverside.example';
const GROUP = 'grp-seed-library';
const ID = guestChatId(HOST, GROUP);
const NOW = Date.parse('2026-11-16T10:00:00.000Z');
const ctx = (blocked: string[] = []) => ({ me: gus.pk, myEdPrivHex: gus.seedHex, blocked: (k: string) => blocked.includes(k), now: NOW });

let n = 0;
const notice = (kind: string, data: unknown) => ({ id: `notice-${++n}-abcdefgh`, host: HOST, group: GROUP, kind, data, receivedAt: NOW });
const invite = (by = ana) => notice('invite', { name: 'Seed Library', invitedBy: { key: by.pk, name: by.name } });
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** An epoch made by `maker` over `recipients`, as the host sends it: no group id, only Gus's wrap. */
function epochNotice(epoch: number, maker = ana, recipients = [ana.pk, ben.pk, gus.pk]) {
    const made = makeGroupEpochRecord({
        myEdPrivHex: maker.seedHex, groupId: GROUP, epoch, reason: 'rotate', subject: null, createdAt: '2026-11-16T09:00:00.000Z', recipients,
    });
    const { groupId: _g, wraps, ...record } = made.record;
    const mine = wraps!.filter((w) => w.recipient === gus.pk).map((w) => ({ ...w, wrapper: maker.pk }));
    return { made, record, wraps: mine };
}
function rosterData(epoch: unknown, guests = [gus]) {
    return {
        name: 'Seed Library',
        members: [ana, ben].map((p) => ({ key: p.pk, name: p.name })),
        guests: guests.map((p) => ({ key: p.pk, home: 'hillside.example', name: p.name })),
        epoch,
    };
}
function lineNotice(id: string, text: string, epoch: number, groupKey: Uint8Array, by = ana) {
    const sealed = sealGroupLine(text, { myEdPrivHex: by.seedHex, groupKey, groupId: GROUP, epoch, messageId: id });
    return notice('line', { id, author: by.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type: 'text', metadata: { epoch, sender: by.pk }, timestamp: '2026-11-16T09:30:00.000Z' });
}
const chatWith = (state: GuestChat['state']): GuestChats => {
    const { chats } = applyGuestMail({}, { items: [invite()] }, ctx());
    chats[ID].state = state;
    return chats;
};

describe('who sees what (viewer x screen -> shown / hidden / refused), the one table both apps draw from', () => {
    const want: Record<GuestViewer, Record<GuestScreen, GuestAccess>> = {
        convenor: { chat: 'shown', sections: 'shown', roster: 'shown', report: 'shown', invite: 'shown' },
        member: { chat: 'shown', sections: 'shown', roster: 'shown', report: 'shown', invite: 'hidden' },
        guest: { chat: 'shown', sections: 'hidden', roster: 'shown', report: 'hidden', invite: 'hidden' },
        removed: { chat: 'refused', sections: 'hidden', roster: 'hidden', report: 'hidden', invite: 'hidden' },
        blocked: { chat: 'refused', sections: 'hidden', roster: 'hidden', report: 'hidden', invite: 'refused' },
    };
    for (const viewer of Object.keys(want) as GuestViewer[]) {
        for (const screen of Object.keys(want[viewer]) as GuestScreen[]) {
            it(`${viewer} · ${screen} -> ${want[viewer][screen]}`, () => expect(guestAccess(viewer, screen)).toBe(want[viewer][screen]));
        }
    }
    it('a guest never sees a section, whatever else', () => {
        for (const v of ['guest', 'removed', 'blocked'] as GuestViewer[]) expect(guestAccess(v, 'sections')).toBe('hidden');
    });
    it("a chat's state makes its viewer: joining and in are a guest, out is removed, an invitation is no chat", () => {
        expect(['invited', 'joining', 'in', 'declined', 'left', 'removed'].map((s) => guestViewerOf({ state: s as GuestChat['state'] })))
            .toEqual([null, 'guest', 'guest', 'removed', 'removed', 'removed']);
    });
});

describe('the request gate (chat state x notice -> invite / take / drop)', () => {
    const states = ['none', 'invited', 'joining', 'in', 'declined', 'left', 'removed'] as const;
    const kinds = ['invite', 'invite-blocked', 'roster', 'epoch', 'line', 'removed', 'edit'] as const;
    const want: Record<(typeof states)[number], Record<(typeof kinds)[number], string>> = {
        none: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop' },
        invited: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'take', edit: 'drop' },
        joining: { invite: 'drop', 'invite-blocked': 'drop', roster: 'take', epoch: 'take', line: 'take', removed: 'take', edit: 'drop' },
        in: { invite: 'drop', 'invite-blocked': 'drop', roster: 'take', epoch: 'take', line: 'take', removed: 'take', edit: 'drop' },
        declined: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop' },
        left: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop' },
        removed: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop' },
    };
    for (const s of states) {
        for (const k of kinds) {
            it(`${s} · ${k} -> ${want[s][k]}`, () => {
                const chat = s === 'none' ? null : { state: s };
                const kind = k === 'invite-blocked' ? 'invite' : k;
                const data = kind === 'invite' ? { name: 'Seed Library', invitedBy: { key: ana.pk, name: 'Ana' } } : {};
                expect(gateGuestNotice(chat, kind, data, (key) => k === 'invite-blocked' && key === ana.pk)).toBe(want[s][k]);
            });
        }
    }
    it('an invitation that names no inviter, or no group name, is dropped', () => {
        expect(gateGuestNotice(null, 'invite', { name: 'X' }, () => false)).toBe('drop');
        expect(gateGuestNotice(null, 'invite', { invitedBy: { key: ana.pk, name: 'Ana' } }, () => false)).toBe('drop');
        expect(gateGuestNotice(null, 'invite', { name: 'X', invitedBy: { key: 'not-a-key', name: 'Ana' } }, () => false)).toBe('drop');
    });
});

describe('a server page applied to the chats', () => {
    it('an invitation waits as one, naming the group, its community and who invited; every notice read is confirmed', () => {
        const inv = invite();
        const { chats, confirm, changed } = applyGuestMail({}, { items: [inv] }, ctx());
        expect(changed).toBe(true);
        expect(confirm).toEqual([inv.id]);
        expect(chats[ID]).toMatchObject({ state: 'invited', name: 'Seed Library', host: HOST, group: GROUP, invitedBy: { key: ana.pk, name: 'Ana' }, lines: [] });
    });

    it('an invitation from someone blocked never shows, and is confirmed all the same', () => {
        const inv = invite(stray);
        const { chats, confirm } = applyGuestMail({}, { items: [inv] }, ctx([stray.pk]));
        expect(chats).toEqual({});
        expect(confirm).toEqual([inv.id]);
    });

    it("before Accept nothing of the group's passes: a roster, an epoch, a line are dropped", () => {
        const before = chatWith('invited');
        const { made } = epochNotice(3);
        const items = [notice('roster', rosterData(null)), notice('epoch', epochNotice(3)), lineNotice(uuid(1), 'hello', 3, made.groupKey)];
        const { chats, confirm } = applyGuestMail(before, { items }, ctx());
        expect(chats[ID].roster).toBeNull();
        expect(chats[ID].keys).toEqual({});
        expect(chats[ID].lines).toEqual([]);
        expect(chats[ID].held).toEqual([]);
        expect(confirm).toHaveLength(3);
    });

    it('the input is never changed in place', () => {
        const before = chatWith('in');
        const copy = JSON.stringify(before);
        applyGuestMail(before, { items: [notice('removed', { why: 'removed' })] }, ctx());
        expect(JSON.stringify(before)).toBe(copy);
    });

    it('the whole way in: yes, the stale roster, my own join epoch, my line opens as mine for members, their line opens for me', () => {
        let chats = chatWith('joining');
        // The host took the yes: my server lists me in, with the roster that says the epoch is stale (I joined).
        ({ chats } = applyGuestMail(chats, { groups: [{ host: HOST, group: GROUP, state: 'in', roster: rosterData({ current: 3, stale: true }), rosterAt: NOW }] }, ctx()));
        expect(chats[ID].state).toBe('in');
        expect(guestSealEpoch(chats[ID])).toBeNull();
        const step = guestEpochDue(chats[ID], gus.pk);
        expect(step).toMatchObject({ send: 'group-epoch', epoch: 4, reason: 'join', recipients: [ana.pk, ben.pk, gus.pk].sort() });
        const made = makeGuestEpochFor(chats[ID], step!, gus.pk, gus.seedHex, NOW);
        expect(JSON.parse(made.payload).epoch).toMatchObject({ epoch: 4, reason: 'join', subject: gus.pk, createdBy: gus.pk });
        chats = { ...chats, [ID]: made.chat };
        // Never a second epoch for the same number in the next round.
        expect(guestEpochDue(chats[ID], gus.pk)).toBeNull();
        // My line goes under my epoch, as members open lines (sender = me, signed inside the seal), under the item's own id.
        const seal = guestSealEpoch(chats[ID])!;
        expect(seal.epoch).toBe(4);
        const payload = JSON.parse(guestLinePayload('hello from Hillside', { group: GROUP, epoch: 4, key: seal.key, messageId: uuid(7), myEdPrivHex: gus.seedHex }));
        expect(payload).toMatchObject({ metadata: { epoch: 4 }, type: 'text', clientId: uuid(7) });
        const memberKey = core.openGroupEpochRecord({ ...JSON.parse(made.payload).epoch, groupId: GROUP }, ana.seedHex, { groupId: GROUP, epoch: 4 });
        expect(openGroupLine(payload, { groupId: GROUP, epoch: 4, senderPubHex: gus.pk, messageId: uuid(7) }, memberKey).text).toBe('hello from Hillside');
        // Ana's line under epoch 4 opens here, with her name.
        ({ chats } = applyGuestMail(chats, { items: [lineNotice(uuid(8), 'welcome, Gus', 4, memberKey)] }, ctx()));
        expect(chats[ID].lines.map((l) => [l.author, l.text])).toEqual([[ana.pk, 'welcome, Gus']]);
        expect(guestChatAuthorName(chats[ID], ana.pk)).toBe('Ana');
        expect(guestChatAuthorName(chats[ID], gus.pk)).toBe('Gus · hillside.example · guest');
    });

    it('a line under an epoch whose key is not here waits, and opens when the epoch comes', () => {
        let chats = chatWith('in');
        const e5 = epochNotice(5);
        ({ chats } = applyGuestMail(chats, { items: [lineNotice(uuid(2), 'first', 5, e5.made.groupKey)] }, ctx()));
        expect(chats[ID].lines).toEqual([]);
        expect(chats[ID].held).toHaveLength(1);
        ({ chats } = applyGuestMail(chats, { items: [notice('epoch', { record: e5.record, wraps: e5.wraps })] }, ctx()));
        expect(chats[ID].held).toEqual([]);
        expect(chats[ID].lines.map((l) => l.text)).toEqual(['first']);
    });

    it("a roster that isn't stale brings the current key from my wrap; a line that isn't its sender's never shows", () => {
        let chats = chatWith('in');
        const e6 = epochNotice(6);
        ({ chats } = applyGuestMail(chats, { items: [notice('roster', rosterData({ current: 6, stale: false, record: e6.record, wraps: e6.wraps }))] }, ctx()));
        expect(Object.keys(chats[ID].keys)).toEqual(['6']);
        const forged = lineNotice(uuid(3), 'I am Ana', 6, e6.made.groupKey, stray);
        (forged.data as any).author = ana.pk;
        (forged.data as any).metadata.sender = ana.pk;
        ({ chats } = applyGuestMail(chats, { items: [forged] }, ctx()));
        expect(chats[ID].lines).toEqual([]);
    });

    it('a removal closes the chat, keys gone, and nothing after it passes; a withdrawn invitation leaves no chat', () => {
        let chats = chatWith('in');
        const e5 = epochNotice(5);
        ({ chats } = applyGuestMail(chats, { items: [notice('epoch', { record: e5.record, wraps: e5.wraps }), notice('removed', { why: 'group-closed' })] }, ctx()));
        expect(chats[ID]).toMatchObject({ state: 'removed', why: 'group-closed', keys: {} });
        ({ chats } = applyGuestMail(chats, { items: [lineNotice(uuid(4), 'after', 5, e5.made.groupKey)] }, ctx()));
        expect(chats[ID].lines).toEqual([]);
        const withdrawn = applyGuestMail(chatWith('invited'), { items: [notice('removed', { why: 'removed' })] }, ctx());
        expect(withdrawn.chats[ID]).toBeUndefined();
    });

    it("my server's word on where I stand wins: listed in on a new device makes the chat; removed closes it", () => {
        const fresh = applyGuestMail({}, { groups: [{ host: HOST, group: GROUP, state: 'in', roster: rosterData(null), rosterAt: NOW }] }, ctx());
        expect(fresh.chats[ID]).toMatchObject({ state: 'in', name: 'Seed Library' });
        const out = applyGuestMail(fresh.chats, { groups: [{ host: HOST, group: GROUP, state: 'removed', roster: null, rosterAt: null }] }, ctx());
        expect(out.chats[ID].state).toBe('removed');
        // An invitation or a removal listed for a chat this device never had makes none.
        expect(applyGuestMail({}, { groups: [{ host: HOST, group: GROUP, state: 'invited', roster: null, rosterAt: null }] }, ctx()).chats).toEqual({});
        expect(applyGuestMail({}, { groups: [{ host: HOST, group: GROUP, state: 'removed', roster: null, rosterAt: null }] }, ctx()).chats).toEqual({});
    });

    it('chats read back from storage; anything that is not one is left out', () => {
        const chats = chatWith('in');
        expect(readGuestChats(JSON.stringify(chats))).toEqual(chats);
        expect(readGuestChats('not json')).toEqual({});
        expect(readGuestChats(JSON.stringify({ x: { id: 'y' } }))).toEqual({});
    });
});

describe("what became of my lines (my server's ticks)", () => {
    const withMine = (state: 'sending' | 'queued') => {
        const chats = chatWith('in');
        chats[ID].lines.push({ id: uuid(9), author: gus.pk, text: 'mine', at: NOW, state, item: '{}' });
        return chats;
    };
    const tick = (state: string, refused: string | null, kind = 'group-line') => [{ itemId: uuid(9), kind, host: HOST, group: GROUP, state, refused, at: NOW }];
    it.each([
        ['queued', null, 'queued'],
        ['sent', null, 'sent'],
        ['failed', null, 'failed'],
        ['refused', 'group-refused', 'failed'],
        ['refused', 'epoch-stale', 'waiting'],
    ])('%s / %s -> %s', (state, refused, want) => {
        const { chats } = applyGuestTicks(withMine('sending'), tick(state, refused), NOW);
        expect(chats[ID].lines[0].state).toBe(want);
        if (want === 'waiting') expect(chats[ID].lines[0].item).toBeNull();
        if (want === 'failed') expect(chats[ID].lines[0].note).toBeTruthy();
    });
    it('a refused epoch can be made again', () => {
        const chats = chatWith('in');
        chats[ID].epochSent = 4;
        expect(applyGuestTicks(chats, tick('refused', 'epoch-stale', 'group-epoch'), NOW).chats[ID].epochSent).toBeNull();
    });
    it('a waiting line makes an epoch due when the roster says it is stale; with nothing waiting and a key here, none is', () => {
        const chats = chatWith('in');
        chats[ID].roster = rosterData({ current: 4, stale: true }) as any;
        chats[ID].keys = { 4: 'AAAA' };
        expect(guestEpochDue(chats[ID], gus.pk)).toBeNull();
        chats[ID].lines.push({ id: uuid(10), author: gus.pk, text: 'w', at: NOW, state: 'waiting' });
        expect(guestEpochDue(chats[ID], gus.pk)).toMatchObject({ epoch: 5, reason: 'rotate' });
    });
});
