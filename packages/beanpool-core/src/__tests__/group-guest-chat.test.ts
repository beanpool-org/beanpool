import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeGroupEpochRecord, openGroupLine, sealGroupLine, sealGroupLineEdit } from '../group-crypto.js';
import {
    applyGuestMail, applyGuestTicks, gateGuestNotice, guestAccess, guestChatAuthorName, guestChatId, guestChatListed, guestClosedWhyOf, guestClosedWords,
    guestEpochDue, guestLinePayload, guestRosterMark, guestSealEpoch, guestViewerOf, makeGuestEpochFor, readGuestChats, takeOwnEpoch,
    GUEST_EDIT_ACTIONS_APPLIED, GUEST_NOTICE_KINDS_APPLIED, GUEST_REMOVED_WHYS,
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
let fresh = 900;
/** A new item id, as io.newId makes one. */
const freshId = () => uuid(++fresh);

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
    // Round 4: an edit's new words pass as a line does; a takedown reaches every chat that may show the line (it only takes
    // away); an edit that says no change is malformed (dropped); a kind, or an edit's change, this device can't apply waits
    // (left unconfirmed), whatever the chat.
    const kinds = ['invite', 'invite-blocked', 'roster', 'epoch', 'line', 'removed', 'edit', 'edit-words', 'edit-takedown', 'edit-other', 'other-kind'] as const;
    const W = 'wait';
    const want: Record<(typeof states)[number], Record<(typeof kinds)[number], string>> = {
        none: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop', 'edit-words': 'drop', 'edit-takedown': 'drop', 'edit-other': W, 'other-kind': W },
        invited: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'take', edit: 'drop', 'edit-words': 'drop', 'edit-takedown': 'drop', 'edit-other': W, 'other-kind': W },
        joining: { invite: 'drop', 'invite-blocked': 'drop', roster: 'take', epoch: 'take', line: 'take', removed: 'take', edit: 'drop', 'edit-words': 'take', 'edit-takedown': 'take', 'edit-other': W, 'other-kind': W },
        in: { invite: 'drop', 'invite-blocked': 'drop', roster: 'take', epoch: 'take', line: 'take', removed: 'take', edit: 'drop', 'edit-words': 'take', 'edit-takedown': 'take', 'edit-other': W, 'other-kind': W },
        declined: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop', 'edit-words': 'drop', 'edit-takedown': 'drop', 'edit-other': W, 'other-kind': W },
        left: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop', 'edit-words': 'drop', 'edit-takedown': 'take', 'edit-other': W, 'other-kind': W },
        removed: { invite: 'invite', 'invite-blocked': 'drop', roster: 'drop', epoch: 'drop', line: 'drop', removed: 'drop', edit: 'drop', 'edit-words': 'drop', 'edit-takedown': 'take', 'edit-other': W, 'other-kind': W },
    };
    const kindOf: Record<(typeof kinds)[number], string> = {
        invite: 'invite', 'invite-blocked': 'invite', roster: 'roster', epoch: 'epoch', line: 'line', removed: 'removed', edit: 'edit',
        'edit-words': 'edit', 'edit-takedown': 'edit', 'edit-other': 'edit', 'other-kind': 'poll',
    };
    const dataOf: Partial<Record<(typeof kinds)[number], unknown>> = {
        invite: { name: 'Seed Library', invitedBy: { key: ana.pk, name: 'Ana' } }, 'invite-blocked': { name: 'Seed Library', invitedBy: { key: ana.pk, name: 'Ana' } },
        'edit-words': { id: uuid(1), action: 'edited' }, 'edit-takedown': { id: uuid(1), action: 'removed', by: 'convenor' }, 'edit-other': { id: uuid(1), action: 'pinned' },
    };
    for (const s of states) {
        for (const k of kinds) {
            it(`${s} · ${k} -> ${want[s][k]}`, () => {
                const chat = s === 'none' ? null : { state: s };
                expect(gateGuestNotice(chat, kindOf[k], dataOf[k] ?? {}, (key) => k === 'invite-blocked' && key === ana.pk)).toBe(want[s][k]);
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
        const made = makeGuestEpochFor(chats[ID], step!, gus.pk, gus.seedHex, NOW, uuid(6));
        expect(JSON.parse(made.payload).epoch).toMatchObject({ epoch: 4, reason: 'join', subject: gus.pk, createdBy: gus.pk });
        chats = { ...chats, [ID]: takeOwnEpoch(chats[ID], made.ownEpoch, gus.pk, NOW)! };
        // Never a second epoch for the same number in the next round.
        expect(guestEpochDue(chats[ID], gus.pk)).toBeNull();
        // My epoch seals nothing until the host has taken it (round 2, finding 4); then my line goes under it.
        expect(guestSealEpoch(chats[ID])).toBeNull();
        ({ chats } = applyGuestTicks(chats, [{ itemId: uuid(6), kind: 'group-epoch', host: HOST, group: GROUP, state: 'sent', refused: null, at: NOW }], NOW, freshId));
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
        // The members voted to close the group: the host says `group-closed` (engine/group-guests.ts closeGroupGuests).
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

    it("my no stands while my server still lists the invitation (the host hasn't taken it yet): it never comes back as one", () => {
        for (const mine of ['declined', 'left'] as const) {
            const before = chatWith(mine);
            for (const theirs of ['invited', 'joining']) {
                const { chats } = applyGuestMail(before, { groups: [{ host: HOST, group: GROUP, state: theirs, roster: null, rosterAt: null }] }, ctx());
                expect(chats[ID].state, `${mine} / ${theirs}`).toBe(mine);
            }
        }
    });

    it('the same invitation fetched again (its confirm lost) never reopens it after my no', () => {
        const inv = invite();
        const first = applyGuestMail({}, { items: [inv] }, ctx()).chats;
        first[ID].state = 'declined';
        const again = applyGuestMail(first, { items: [inv] }, ctx());
        expect(again.chats[ID].state).toBe('declined');
        expect(again.confirm).toEqual([inv.id]);
        // A new invitation (a new notice) opens one again.
        expect(applyGuestMail(first, { items: [invite()] }, ctx()).chats[ID].state).toBe('invited');
    });

    it('only chats are listed among the chats: joining, in, and closed ones (removed, left); never an invitation or a decline', () => {
        const states = ['invited', 'joining', 'in', 'declined', 'left', 'removed'] as const;
        expect(states.filter((s) => guestChatListed({ state: s }))).toEqual(['joining', 'in', 'left', 'removed']);
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
        const { chats } = applyGuestTicks(withMine('sending'), tick(state, refused), NOW, freshId);
        expect(chats[ID].lines[0].state).toBe(want);
        if (want === 'waiting') expect(chats[ID].lines[0].item).toBeNull();
        if (want === 'failed') expect(chats[ID].lines[0].note).toBeTruthy();
    });
    it('a line refused for its epoch lets the next epoch be made, even when no tick for my epoch ever came', () => {
        const chats = withMine('sending');
        chats[ID].epochSent = 4;
        const out = applyGuestTicks(chats, tick('refused', 'epoch-stale'), NOW, freshId).chats[ID];
        expect(out.lines[0].state).toBe('waiting');
        expect(out.epochSent).toBeNull();
    });
    it('a refused epoch can be made again', () => {
        const chats = chatWith('in');
        chats[ID].epochSent = 4;
        expect(applyGuestTicks(chats, tick('refused', 'epoch-stale', 'group-epoch'), NOW, freshId).chats[ID].epochSent).toBeNull();
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

// ── Round 2 (#3246): the four rules of the file's header, each as a table ───────────────────────

describe('IDENTITY: a line is named by the key that signed it (signed-by x author column -> shown / refused)', () => {
    const e6 = epochNotice(6);
    const keyed = () => applyGuestMail(chatWith('in'), { items: [notice('roster', rosterData({ current: 6, stale: false, record: e6.record, wraps: e6.wraps }))] }, ctx()).chats;
    type Row = { signer: ReturnType<typeof person>; author: string; sender?: string; type?: string; epoch?: number };
    function signed(id: string, o: Row, groupKey = e6.made.groupKey) {
        const epoch = o.epoch ?? 6;
        const sealed = sealGroupLine('the words', { myEdPrivHex: o.signer.seedHex, groupKey, groupId: GROUP, epoch, messageId: id });
        const metadata: Record<string, unknown> = { epoch };
        if (o.sender !== undefined) metadata.sender = o.sender;
        return notice('line', { id, author: o.author, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type: o.type ?? 'text', metadata, timestamp: '2026-11-16T09:40:00.000Z' });
    }
    const rows: Array<[string, 'shown' | 'refused', Row, string | null]> = [
        ['same: signed by Ana, author Ana, sender Ana', 'shown', { signer: ana, author: ana.pk, sender: ana.pk }, ana.pk],
        ['same, no sender named: signed by Ana, author Ana', 'shown', { signer: ana, author: ana.pk }, ana.pk],
        ['same: signed by me, author me (my line as the host sends it on)', 'shown', { signer: gus, author: gus.pk, sender: gus.pk }, gus.pk],
        ['different: signed by a stray key named as sender, author Ana (the review probe)', 'refused', { signer: stray, author: ana.pk, sender: stray.pk }, null],
        ['different: signed by a stray key named as sender, author me', 'refused', { signer: stray, author: gus.pk, sender: stray.pk }, null],
        ['different: signed by Ana named as sender, author Ben', 'refused', { signer: ana, author: ben.pk, sender: ana.pk }, null],
        ['different: a sender that is not a key, author Ana', 'refused', { signer: ana, author: ana.pk, sender: 'not-a-key' }, null],
        ['unknown: signed by a key the line names nowhere, author and sender Ana', 'refused', { signer: stray, author: ana.pk, sender: ana.pk }, null],
        ['unknown: signed by a key the line names nowhere, author and sender me', 'refused', { signer: stray, author: gus.pk, sender: gus.pk }, null],
        ['unknown: no sender named, author Ana, signed by a stray key', 'refused', { signer: stray, author: ana.pk }, null],
        ['photo, same: signed by Ana', 'shown', { signer: ana, author: ana.pk, sender: ana.pk, type: 'image' }, ana.pk],
        ['photo, different: signed by a stray key, author Ana', 'refused', { signer: stray, author: ana.pk, sender: stray.pk, type: 'image' }, null],
        ['voice, unknown: author and sender Ana, signed by a stray key', 'refused', { signer: stray, author: ana.pk, sender: ana.pk, type: 'voice' }, null],
        ['a signer the roster does not name, named alike everywhere: shown under a short key, never a name', 'shown', { signer: stray, author: stray.pk, sender: stray.pk }, stray.pk],
    ];
    it.each(rows)('%s -> %s', (_name, want, o, by) => {
        const id = freshId();
        const { chats } = applyGuestMail(keyed(), { items: [signed(id, o)] }, ctx());
        const line = chats[ID].lines.find((l) => l.id === id);
        // Refused is refused: never shown, and never kept waiting for a key either.
        expect(chats[ID].held.some((h) => h.id === id)).toBe(false);
        if (want === 'refused') return expect(line).toBeUndefined();
        expect(line!.author).toBe(by);
        expect(line!.text).toBe(o.type && o.type !== 'text' ? "A photo or voice message: it doesn't show here yet." : 'the words');
        const name = guestChatAuthorName(chats[ID], line!.author);
        expect(name).toBe(by === ana.pk ? 'Ana' : by === gus.pk ? 'Gus · hillside.example · guest' : by!.slice(0, 8));
    });
    it("a line held for its key is refused when the key comes, if it doesn't open as its sender's", () => {
        const e7 = epochNotice(7);
        const id = freshId();
        let chats = keyed();
        ({ chats } = applyGuestMail(chats, { items: [signed(id, { signer: stray, author: ana.pk, sender: ana.pk, epoch: 7 }, e7.made.groupKey)] }, ctx()));
        expect(chats[ID].held.map((h) => h.id)).toEqual([id]);
        ({ chats } = applyGuestMail(chats, { items: [notice('epoch', { record: e7.record, wraps: e7.wraps })] }, ctx()));
        expect(chats[ID].held).toEqual([]);
        expect(chats[ID].lines.some((l) => l.id === id)).toBe(false);
    });
});

describe('IDS: a re-send after a refusal goes under a fresh item id (refusal x re-send)', () => {
    const mine = () => {
        const chats = chatWith('in');
        chats[ID].lines.push({ id: uuid(40), author: gus.pk, text: 'mine', at: NOW, state: 'sending', item: '{"x":1}' });
        return chats;
    };
    const refusal = (refused: string) => [{ itemId: uuid(40), kind: 'group-line', host: HOST, group: GROUP, state: 'refused', refused, at: NOW }];
    it.each([
        ['epoch-stale', 'waiting', 'a new id: it is sealed again under the next epoch'],
        ['group-refused', 'failed', 'the same id: it is not sent again'],
        ['refused', 'failed', 'the same id: it is not sent again'],
    ])('refused %s -> %s, %s', (refused, want) => {
        const { chats } = applyGuestTicks(mine(), refusal(refused), NOW, freshId);
        const line = chats[ID].lines[0];
        expect(line.state).toBe(want);
        if (want !== 'waiting') return expect(line.id).toBe(uuid(40));
        expect(line.id).not.toBe(uuid(40));
        expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(line.item).toBeNull();
        // The same refusal heard again (the post's answer, then the round's tick) moves nothing further.
        const again = applyGuestTicks(chats, refusal(refused), NOW, freshId);
        expect(again.changed).toBe(false);
        expect(again.chats[ID].lines[0].id).toBe(line.id);
    });
});

describe('EPOCH: a line is sealed only under an epoch the host has taken (my epoch x line -> sealed / waiting)', () => {
    const MINE = uuid(50);
    const made = (): GuestChats => {
        let chats = chatWith('in');
        ({ chats } = applyGuestMail(chats, { groups: [{ host: HOST, group: GROUP, state: 'in', roster: rosterData({ current: 3, stale: true }), rosterAt: NOW }] }, ctx()));
        chats[ID].lines.push({ id: uuid(51), author: gus.pk, text: 'waits', at: NOW, state: 'waiting' });
        const step = guestEpochDue(chats[ID], gus.pk)!;
        return { ...chats, [ID]: takeOwnEpoch(chats[ID], makeGuestEpochFor(chats[ID], step, gus.pk, gus.seedHex, NOW, MINE).ownEpoch, gus.pk, NOW)! };
    };
    const epochTick = (state: string, refused: string | null, itemId = MINE) => [{ itemId, kind: 'group-epoch', host: HOST, group: GROUP, state, refused, at: NOW }];
    it.each([
        ['made, no answer yet', 'waiting', null],
        ['queued at my server (the host not reached)', 'waiting', epochTick('queued', null)],
        ['taken by the host', 'sealed', epochTick('sent', null)],
        ['refused by the host (one made at the same time won)', 'waiting', epochTick('refused', 'epoch-stale')],
        ['failed (a day of no answer)', 'waiting', epochTick('failed', null)],
    ])('%s -> the line %s', (_name, want, ticks) => {
        const chats = ticks ? applyGuestTicks(made(), ticks, NOW, freshId).chats : made();
        const seal = guestSealEpoch(chats[ID]);
        if (want === 'sealed') {
            expect(seal?.epoch).toBe(4);
            expect(chats[ID].ownEpoch).toBeNull();
            return;
        }
        expect(seal).toBeNull();
        if (ticks && ticks[0].state === 'failed') {
            // Failed (my server never reached the host): its key goes for good, and another may be made at once for the
            // line that waits.
            expect(chats[ID].ownEpoch).toBeNull();
            expect(chats[ID].keys).toEqual({});
            expect(guestEpochDue(chats[ID], gus.pk)).toMatchObject({ epoch: 4 });
        } else if (ticks && ticks[0].state !== 'queued') {
            // Refused (round 3, "Refusals"): its key goes for good, and none is made again from the roster it was made from
            // (round 2 made it again at once, from that same roster, every round until the roster came). The roster the
            // host sends after a refusal makes the next one, even when it names the same epoch with someone new in it.
            expect(chats[ID].ownEpoch).toBeNull();
            expect(chats[ID].keys).toEqual({});
            expect(guestEpochDue(chats[ID], gus.pk)).toBeNull();
            const next = applyGuestMail(chats, { groups: [{ host: HOST, group: GROUP, state: 'in', roster: rosterData({ current: 3, stale: true }, [gus, stray]), rosterAt: NOW }] }, ctx()).chats;
            expect(guestEpochDue(next[ID], gus.pk)).toMatchObject({ epoch: 4, recipients: [ana.pk, ben.pk, gus.pk, stray.pk].sort() });
        } else {
            // On its way: no second one.
            expect(chats[ID].ownEpoch).toMatchObject({ epoch: 4, itemId: MINE });
            expect(guestEpochDue(chats[ID], gus.pk)).toBeNull();
        }
    });
    it('a tick for another epoch item of mine changes nothing about the one on its way', () => {
        for (const other of [epochTick('sent', null, uuid(52)), epochTick('refused', 'epoch-stale', uuid(52))]) {
            const out = applyGuestTicks(made(), other, NOW, freshId);
            expect(out.changed).toBe(false);
            expect(guestSealEpoch(out.chats[ID])).toBeNull();
            expect(out.chats[ID].ownEpoch).toMatchObject({ itemId: MINE });
        }
    });
});

describe('WRITES (round 3): my epoch goes onto the chat as it is at the write (what changed meanwhile x takeOwnEpoch -> taken / not)', () => {
    const MINE = uuid(55);
    const base = (): GuestChat => {
        let chats = chatWith('in');
        ({ chats } = applyGuestMail(chats, { groups: [{ host: HOST, group: GROUP, state: 'in', roster: rosterData({ current: 3, stale: true }), rosterAt: NOW }] }, ctx()));
        chats[ID].lines.push({ id: uuid(56), author: gus.pk, text: 'waits', at: NOW, state: 'waiting' });
        return chats[ID];
    };
    const made = () => { const c = base(); return makeGuestEpochFor(c, guestEpochDue(c, gus.pk)!, gus.pk, gus.seedHex, NOW, MINE).ownEpoch; };
    it.each([
        ['nothing', (_c: GuestChat) => undefined, true],
        ["a line of Ana's held", (c: GuestChat) => { c.held.push({ id: uuid(57), author: ana.pk, sender: ana.pk, epoch: 3, ciphertext: 'x', nonce: 'y', replyToId: null, type: 'text', at: NOW }); }, true],
        ['a new line of mine', (c: GuestChat) => { c.lines.push({ id: uuid(58), author: gus.pk, text: 'second', at: NOW, state: 'waiting' }); }, true],
        ['an epoch of mine put on its way by another send', (c: GuestChat) => { c.ownEpoch = { ...made(), itemId: uuid(59) }; }, false],
        ['a new roster (someone joined)', (c: GuestChat) => { c.roster = rosterData({ current: 3, stale: true }, [gus, stray]) as GuestChat['roster']; }, false],
        ['a key newer than the roster, my line sealable now', (c: GuestChat) => { c.keys = { 4: 'AAAA' }; }, false],
        ['a refusal under epoch 4', (c: GuestChat) => { c.refusedEpoch = 4; }, false],
    ])('meanwhile: %s -> taken %s', (_name, meanwhile, taken) => {
        const own = made();
        const c = base();
        meanwhile(c);
        const before = JSON.parse(JSON.stringify(c)) as GuestChat;
        const out = takeOwnEpoch(c, own, gus.pk, NOW);
        if (!taken) return expect(out).toBeNull();
        // Only my epoch changes: everything written meanwhile stays as it was.
        expect(out).toEqual({ ...before, ownEpoch: own, epochSent: 4, updatedAt: NOW });
    });
});

describe('REFUSALS (round 3): a line refused under epoch 4 is written down (what came after x seal / epoch due)', () => {
    const KEY4 = new Uint8Array(32).fill(4);
    /** The host's own epoch 4 (Ana's), not the key of mine the line was refused under. */
    const E4 = epochNotice(4);
    /** The chat after a roster notice from the host. */
    const rosterIn = (c: GuestChat, epoch: unknown): GuestChat => applyGuestMail({ [ID]: c }, { items: [notice('roster', rosterData(epoch))] }, ctx()).chats[ID];
    it("the roster that names 4 as current seals under the host's key for 4, never my refused one", () => {
        const c = rosterIn(refused(), { current: 4, stale: false, record: E4.record, wraps: E4.wraps });
        expect(c.refusedEpoch).toBeNull();
        expect(Buffer.from(guestSealEpoch(c)!.key).toString('hex')).toBe(Buffer.from(E4.made.groupKey).toString('hex'));
    });
    const refused = (): GuestChat => {
        const chats = chatWith('in');
        // My own epoch 4, taken while the host's roster still says 3 is stale; my line under it refused epoch-stale.
        chats[ID].roster = rosterData({ current: 3, stale: true }) as GuestChat['roster'];
        chats[ID].keys = { 4: Buffer.from(KEY4).toString('base64') };
        chats[ID].epochSent = 4;
        const payload = guestLinePayload('w', { group: GROUP, epoch: 4, key: KEY4, messageId: uuid(60), myEdPrivHex: gus.seedHex });
        chats[ID].lines.push({ id: uuid(60), author: gus.pk, text: 'w', at: NOW, state: 'sending', item: JSON.stringify({ envelope: { itemId: uuid(60) }, payload }) });
        return applyGuestTicks(chats, [{ itemId: uuid(60), kind: 'group-line', host: HOST, group: GROUP, state: 'refused', refused: 'epoch-stale', at: NOW }], NOW, freshId).chats[ID];
    };
    it.each([
        ['nothing (the roster not come)', (_c: GuestChat) => undefined, null, null],
        ['the same refusal again under an older epoch', (c: GuestChat) => { c.refusedEpoch = Math.max(c.refusedEpoch ?? 0, 3); }, null, null],
        ['a roster: epoch 4 is stale', (c: GuestChat) => { c.roster = rosterData({ current: 4, stale: true }) as GuestChat['roster']; }, null, 5],
        ['a roster: epoch 3 still stale, someone new in it', (c: GuestChat) => { c.roster = rosterData({ current: 3, stale: true }, [gus, stray]) as GuestChat['roster']; }, null, null],
        ['a key newer than 4 (an epoch notice)', (c: GuestChat) => { c.keys = { ...c.keys, 5: 'BBBB' }; }, 5, null],
        // Round 4: the refusal is of my key for 4, not of the number. A roster naming 4 as current and not stale brings the
        // host's own key for 4 from my wrap: lines go under it (round 3 left the line waiting until the group's epoch 5).
        ['a roster: epoch 4 current, not stale, with my wrap (the host\'s own key for 4)', (c: GuestChat) => { Object.assign(c, rosterIn(c, { current: 4, stale: false, record: E4.record, wraps: E4.wraps })); }, 4, null],
        ['a roster: epoch 4 current, not stale, no wrap of mine', (c: GuestChat) => { Object.assign(c, rosterIn(c, { current: 4, stale: false, record: E4.record, wraps: [] })); }, null, null],
        ['a roster: epoch 4 current and stale, with my wrap', (c: GuestChat) => { Object.assign(c, rosterIn(c, { current: 4, stale: true, record: E4.record, wraps: E4.wraps })); }, null, 5],
    ])('then %s (sealed under, epoch due: as the row says)', (_name, after, sealed, due) => {
        const c = refused();
        expect(c.refusedEpoch).toBe(4);
        expect(c.lines[0]).toMatchObject({ state: 'waiting', item: null });
        after(c);
        expect(guestSealEpoch(c)?.epoch ?? null).toBe(sealed);
        expect(guestEpochDue(c, gus.pk)?.epoch ?? null).toBe(due);
    });
    it('my own epoch refused: none from the roster it was made from; the mark tells rosters apart', () => {
        expect(guestRosterMark(rosterData({ current: 3, stale: true }) as GuestChat['roster'])).toBe(guestRosterMark(rosterData({ current: 3, stale: true }) as GuestChat['roster']));
        expect(guestRosterMark(rosterData({ current: 3, stale: true }) as GuestChat['roster'])).not.toBe(guestRosterMark(rosterData({ current: 3, stale: true }, [gus, stray]) as GuestChat['roster']));
    });
});

describe('STATE: what this device shows follows what my server lists now (server link x what is held here -> shown / cleared)', () => {
    const page = (state: string) => ({
        groups: state === 'declined' || state === 'left' ? [] : [{ host: HOST, group: GROUP, state, roster: state === 'in' ? rosterData(null) : null, rosterAt: NOW }],
    });
    const local = (state: GuestChat['state']): GuestChats => {
        const chats = chatWith(state);
        if (state === 'in') chats[ID].keys = { 3: 'AAAA' };
        return chats;
    };
    const rows: Array<[GuestChat['state'], string, GuestChat['state'] | 'cleared']> = [
        ['invited', 'invited', 'invited'],
        ['invited', 'in', 'in'],
        ['invited', 'declined', 'cleared'],
        ['invited', 'left', 'cleared'],
        ['invited', 'removed', 'cleared'],
        ['joining', 'declined', 'cleared'],
        ['joining', 'left', 'cleared'],
        ['in', 'in', 'in'],
        ['in', 'left', 'left'],
        ['in', 'removed', 'removed'],
        ['declined', 'declined', 'declined'],
        ['left', 'left', 'left'],
        ['removed', 'removed', 'removed'],
    ];
    it.each(rows)('held here %s, my server says %s -> %s', (mine, theirs, want) => {
        const { chats } = applyGuestMail(local(mine), page(theirs), ctx());
        if (want === 'cleared') return expect(chats[ID]).toBeUndefined();
        expect(chats[ID].state).toBe(want);
        if (want === 'left' || want === 'removed') expect(chats[ID].keys).toEqual({});
        expect(guestChatListed(chats[ID])).toBe(want !== 'invited' && want !== 'declined');
    });
    it('an invitation fetched with a page that no longer lists it is never shown', () => {
        const { chats, confirm } = applyGuestMail({}, { items: [invite()], groups: [] }, ctx());
        expect(chats).toEqual({});
        expect(confirm).toHaveLength(1);
    });
    it('a page with no list of groups changes nothing here', () => {
        expect(applyGuestMail(local('invited'), { items: [] }, ctx()).chats[ID].state).toBe('invited');
    });
});

// ── Round 4 (#3246): every notice the host sends is applied here or left unconfirmed; every why has its own words ─────

describe('NOTICES (round 4): a line edited or taken down at the host (notice x what this device has -> what it shows, confirmed)', () => {
    const e6 = epochNotice(6);
    const e7 = epochNotice(7);
    const LINE = uuid(70);
    const T1 = '2026-11-16T09:40:00.000Z', T2 = '2026-11-16T09:45:00.000Z', T3 = '2026-11-16T09:50:00.000Z';
    type Has = 'shown' | 'held for its key' | 'not fetched' | 'edited, newer here' | 'edited, older here' | 'a photo shown';
    const epochOf = (has: Has) => (has === 'held for its key' ? 7 : 6);
    const keyOf = (epoch: number) => (epoch === 7 ? e7.made.groupKey : e6.made.groupKey);
    /** Ana's line LINE, as the host sends a member's line. */
    const line = (epoch: number, type = 'text') => {
        const n = lineNotice(LINE, 'first words', epoch, keyOf(epoch));
        (n.data as Record<string, unknown>).type = type;
        return n;
    };
    /**
     * Its edit, as engine/group-guests.ts queueLineChange sends one: sealed again under the line's epoch by sealGroupLineEdit,
     * as both apps' editSealedGroupLine seal it (part 'edit', after the line's own id; round 5: never a hand-built seal).
     */
    const edit = (text: string, editedAt: string | null, o: { by?: ReturnType<typeof person>; author?: string; epoch?: number } = {}) => {
        const by = o.by ?? ana;
        const epoch = o.epoch ?? 6;
        const sealed = sealGroupLineEdit(text, { myEdPrivHex: by.seedHex, groupKey: keyOf(epoch), groupId: GROUP, epoch, messageId: LINE });
        return notice('edit', { id: LINE, action: 'edited', author: o.author ?? by.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: by.pk }, editedAt });
    };
    const takedown = (by: 'author' | 'convenor') => notice('edit', { id: LINE, action: 'removed', by });
    /** A chat in, epoch 6's key here from the roster, and what the device has of LINE. */
    const device = (has: Has): GuestChats => {
        let chats = applyGuestMail(chatWith('in'), { items: [notice('roster', rosterData({ current: 6, stale: false, record: e6.record, wraps: e6.wraps }))] }, ctx()).chats;
        if (has === 'not fetched') return chats;
        ({ chats } = applyGuestMail(chats, { items: [line(epochOf(has), has === 'a photo shown' ? 'image' : 'text')] }, ctx()));
        if (has === 'edited, newer here') ({ chats } = applyGuestMail(chats, { items: [edit('newest words', T3)] }, ctx()));
        if (has === 'edited, older here') ({ chats } = applyGuestMail(chats, { items: [edit('older words', T1)] }, ctx()));
        return chats;
    };
    /** What the chat shows of LINE: its words (a line held for its key: once the key comes), or `gone`. */
    const shows = (chats: GuestChats): string => {
        const opened = chats[ID].held.length ? applyGuestMail(chats, { items: [notice('epoch', { record: e7.record, wraps: e7.wraps })] }, ctx()).chats : chats;
        return opened[ID].lines.find((l) => l.id === LINE)?.text ?? 'gone';
    };
    const PHOTO = "A photo or voice message: it doesn't show here yet.";
    const rows: Array<[string, Has, (has: Has) => ReturnType<typeof notice>, string]> = [
        ['new words (T2)', 'shown', (h) => edit('new words', T2, { epoch: epochOf(h) }), 'new words'],
        ['new words (T2)', 'held for its key', (h) => edit('new words', T2, { epoch: epochOf(h) }), 'new words'],
        ['new words (T2)', 'not fetched', (h) => edit('new words', T2, { epoch: epochOf(h) }), 'gone'],
        ['new words (T2)', 'edited, newer here', (h) => edit('new words', T2, { epoch: epochOf(h) }), 'newest words'],
        ['new words (T2)', 'edited, older here', (h) => edit('new words', T2, { epoch: epochOf(h) }), 'new words'],
        ['new words (T2)', 'a photo shown', (h) => edit('new words', T2, { epoch: epochOf(h) }), PHOTO],
        ['taken down by its author', 'shown', () => takedown('author'), 'gone'],
        ['taken down by its author', 'held for its key', () => takedown('author'), 'gone'],
        ['taken down by its author', 'not fetched', () => takedown('author'), 'gone'],
        ['taken down by its author', 'edited, newer here', () => takedown('author'), 'gone'],
        ['taken down by a convenor', 'shown', () => takedown('convenor'), 'gone'],
        ['taken down by a convenor', 'held for its key', () => takedown('convenor'), 'gone'],
        ['taken down by a convenor', 'edited, older here', () => takedown('convenor'), 'gone'],
        ['taken down by a convenor', 'a photo shown', () => takedown('convenor'), 'gone'],
        // Words that aren't the line's author's, or not for this line, change nothing (and are read, so confirmed).
        ['new words signed by a stray key, named as Ana', 'shown', () => edit('not hers', T2, { by: stray, author: ana.pk }), 'first words'],
        ["new words of Ben's for Ana's line", 'shown', () => edit('his words', T2, { by: ben }), 'first words'],
        ["new words under another epoch than the line's", 'shown', () => edit('elsewhere', T2, { epoch: 7 }), 'first words'],
        ['new words with no time, over words edited at T1', 'edited, older here', () => edit('no time', null), 'older words'],
        // Held for its key: words that don't open as Ana's never cost the line its own words once the key comes.
        ['new words signed by a stray key, named as Ana', 'held for its key', () => edit('not hers', T2, { by: stray, author: ana.pk, epoch: 7 }), 'first words'],
    ];
    it.each(rows)('%s · line %s (what it shows: as the row says; confirmed)', (_name, has, make, want) => {
        const n = make(has);
        const { chats, confirm } = applyGuestMail(device(has), { items: [n] }, ctx());
        expect(confirm).toEqual([n.id]);
        expect(shows(chats)).toBe(want);
    });
    it('a line held for its key, edited twice, the newer edit served first: the newer words show once the key comes', () => {
        let chats = device('held for its key');
        ({ chats } = applyGuestMail(chats, { items: [edit('newest words', T3, { epoch: 7 })] }, ctx()));
        ({ chats } = applyGuestMail(chats, { items: [edit('older words', T2, { epoch: 7 })] }, ctx()));
        expect(shows(chats)).toBe('newest words');
    });
    it('a line taken down leaves nothing of it on the device: no words, no sealed copy, no photo', () => {
        for (const has of ['shown', 'held for its key', 'a photo shown'] as Has[]) {
            const before = device(has);
            expect(JSON.stringify(before), has).toContain(LINE);
            const { chats } = applyGuestMail(before, { items: [takedown('convenor')] }, ctx());
            const stored = JSON.stringify(chats);
            expect(stored, has).not.toContain(LINE);
            expect(stored, has).not.toContain('first words');
        }
    });
    it('a closed chat: a takedown still takes the line away; new words never reach it', () => {
        for (const why of ['removed', 'group-closed', 'closed']) {
            const closed = applyGuestMail(device('shown'), { items: [notice('removed', { why })] }, ctx()).chats;
            expect(closed[ID].lines.find((l) => l.id === LINE)?.text).toBe('first words');
            const words = applyGuestMail(closed, { items: [edit('after', T2)] }, ctx());
            expect(words.confirm).toHaveLength(1);
            expect(words.chats[ID].lines.find((l) => l.id === LINE)?.text).toBe('first words');
            expect(applyGuestMail(closed, { items: [takedown('convenor')] }, ctx()).chats[ID].lines.some((l) => l.id === LINE)).toBe(false);
        }
    });
    it('a kind, or a change of a line, this device does not apply is left unconfirmed, and changes nothing', () => {
        const before = device('shown');
        for (const n of [notice('poll', { id: LINE }), notice('edit', { id: LINE, action: 'pinned' })]) {
            const { chats, confirm, changed } = applyGuestMail(before, { items: [n] }, ctx());
            expect(confirm, n.kind).toEqual([]);
            expect(changed).toBe(false);
            expect(chats).toEqual(before);
        }
    });
});

describe('WHYS (round 4): each reason the host gives for a removal (host why -> what the chat keeps, the words both apps show)', () => {
    const rows: Array<[string, string | undefined, GuestChat['why'], string]> = [
        ["a convenor's Remove", 'removed', 'removed', 'You were removed from this chat. Nothing more reaches you from it.'],
        ['the members voted to close the group (closeGroupGuests)', 'group-closed', 'group-closed', 'This group was closed. Nothing more reaches you from it.'],
        ['the owners turned guests off (closeGuestsIfSwitchedOff)', 'closed', 'guests-off', "This group's community turned off guests from other communities. Nothing more reaches you from it."],
        ['a reason this device does not know', 'moved', null, 'This chat is closed. Nothing more reaches you from it.'],
        ['no reason given', undefined, null, 'This chat is closed. Nothing more reaches you from it.'],
    ];
    it.each(rows)('%s (why %s) -> kept as %s, says %s', (_name, why, kept, words) => {
        const n = notice('removed', why === undefined ? {} : { why });
        const { chats, confirm } = applyGuestMail(chatWith('in'), { items: [n] }, ctx());
        expect(confirm).toEqual([n.id]);
        expect(chats[ID]).toMatchObject({ state: 'removed', why: kept });
        expect(guestClosedWords(chats[ID])).toBe(words);
    });
    it("removed by my server's word alone (no notice held for me): it says only that the chat is closed, never 'You were removed'", () => {
        const { chats } = applyGuestMail(chatWith('in'), { groups: [{ host: HOST, group: GROUP, state: 'removed', roster: null, rosterAt: null }] }, ctx());
        expect(chats[ID]).toMatchObject({ state: 'removed', why: null });
        expect(guestClosedWords(chats[ID])).toBe('This chat is closed. Nothing more reaches you from it.');
    });
    it('the notice keeps its reason when my server lists the removal on the same page', () => {
        const page = { items: [notice('removed', { why: 'group-closed' })], groups: [{ host: HOST, group: GROUP, state: 'removed', roster: null, rosterAt: null }] };
        expect(guestClosedWords(applyGuestMail(chatWith('in'), page, ctx()).chats[ID])).toBe('This group was closed. Nothing more reaches you from it.');
    });
});

describe("GUARD (round 4): every kind, change and why the host's code sends is one this device applies, with its own words", () => {
    const read = (f: string) => readFileSync(new URL(`../../../../apps/server/src/engine/${f}`, import.meta.url), 'utf8');
    const host = read('group-guests.ts');
    const home = read('group-guest-home.ts');
    const listOf = (src: string, name: string): string[] => {
        const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
        return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
    };
    const kinds = [...new Set([...listOf(host, 'GUEST_NOTICE_KINDS'), ...listOf(home, 'GROUP_NOTICE_KINDS')])];
    const whys = [...new Set([...host.matchAll(/queueToHome\([^;]*?'removed',\s*\{\s*why:\s*'([^']+)'/g)].map((m) => m[1]))];
    const actions = [...new Set([...host.matchAll(/\baction:\s*'([^']+)'/g)].map((m) => m[1]))];
    /** The words each reason the host gives says: a reason the host adds has no row here, and fails. */
    const WORDS: Record<string, string> = {
        removed: 'You were removed from this chat. Nothing more reaches you from it.',
        'group-closed': 'This group was closed. Nothing more reaches you from it.',
        closed: "This group's community turned off guests from other communities. Nothing more reaches you from it.",
    };
    it("the host's code is read where the guard looks (its kinds, the whys its removals send, an edit's changes)", () => {
        expect(kinds).toEqual(expect.arrayContaining(['invite', 'roster', 'line', 'edit', 'epoch', 'removed']));
        expect(whys.length).toBeGreaterThanOrEqual(3);
        expect(actions).toEqual(expect.arrayContaining(['edited', 'removed']));
    });
    it.each(kinds)('kind %s: one this device applies', (k) => expect(GUEST_NOTICE_KINDS_APPLIED as readonly string[]).toContain(k));
    it.each(actions)('an edit that says %s: one this device applies', (a) => expect(GUEST_EDIT_ACTIONS_APPLIED as readonly string[]).toContain(a));
    it.each(whys)('why %s: its own words', (w) => {
        expect(GUEST_REMOVED_WHYS as readonly string[]).toContain(w);
        expect(guestClosedWords({ state: 'removed', why: guestClosedWhyOf(w) })).toBe(WORDS[w]);
    });
    it("each reason its own sentence: only a convenor's Remove says 'You were removed'", () => {
        const said = whys.map((w) => guestClosedWords({ state: 'removed', why: guestClosedWhyOf(w) }));
        expect(new Set(said).size).toBe(whys.length);
        expect(said.filter((s) => s?.startsWith('You were removed'))).toHaveLength(1);
    });

    // Each kind the host sends, APPLIED on a chat it reaches (not only confirmed): a kind with no row here fails.
    const e5 = epochNotice(5);
    const e6 = epochNotice(6);
    const keyed = () => applyGuestMail(chatWith('in'), { items: [notice('roster', rosterData({ current: 6, stale: false, record: e6.record, wraps: e6.wraps }))] }, ctx()).chats;
    const withLine = () => applyGuestMail(keyed(), { items: [lineNotice(uuid(80), 'first words', 6, e6.made.groupKey)] }, ctx()).chats;
    /** Ana's edit as both apps seal it (sealGroupLineEdit; round 5: never a hand-built seal). */
    const editOf = () => {
        const sealed = sealGroupLineEdit('new words', { myEdPrivHex: ana.seedHex, groupKey: e6.made.groupKey, groupId: GROUP, epoch: 6, messageId: uuid(80) });
        return notice('edit', { id: uuid(80), action: 'edited', author: ana.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch: 6, sender: ana.pk }, editedAt: '2026-11-16T09:45:00.000Z' });
    };
    type Row = { before: () => GuestChats; n: () => ReturnType<typeof notice>; shows: (c: GuestChats) => unknown; want: unknown };
    const APPLIED: Record<string, Row[]> = {
        invite: [{ before: () => ({}), n: () => invite(), shows: (c) => c[ID]?.state, want: 'invited' }],
        roster: [{ before: () => chatWith('in'), n: () => notice('roster', rosterData({ current: 6, stale: false, record: e6.record, wraps: e6.wraps })), shows: (c) => Object.keys(c[ID].keys), want: ['6'] }],
        line: [{ before: keyed, n: () => lineNotice(uuid(81), 'hello', 6, e6.made.groupKey), shows: (c) => c[ID].lines.map((l) => l.text), want: ['hello'] }],
        edit: [
            { before: withLine, n: editOf, shows: (c) => c[ID].lines.map((l) => l.text), want: ['new words'] },
            { before: withLine, n: () => notice('edit', { id: uuid(80), action: 'removed', by: 'convenor' }), shows: (c) => c[ID].lines, want: [] },
        ],
        epoch: [{ before: () => chatWith('in'), n: () => notice('epoch', { record: e5.record, wraps: e5.wraps }), shows: (c) => Object.keys(c[ID].keys), want: ['5'] }],
        removed: [{ before: () => chatWith('in'), n: () => notice('removed', { why: 'removed' }), shows: (c) => c[ID].state, want: 'removed' }],
    };
    it.each(kinds)('kind %s: applied on a chat it reaches, then confirmed', (k) => {
        expect(APPLIED[k], `no row for the host's kind ${k}`).toBeDefined();
        for (const row of APPLIED[k]) {
            const n = row.n();
            const { chats, confirm } = applyGuestMail(row.before(), { items: [n] }, ctx());
            expect(row.shows(chats)).toEqual(row.want);
            expect(confirm).toEqual([n.id]);
        }
    });
});
