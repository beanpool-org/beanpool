/**
 * THE AAD RULE (#3246 round 5): every sealed thing a guest's device opens is opened with exactly the associated data its
 * sender sealed it with: the group, the line's epoch, the signer, the message id, the part, and what the line answers.
 *
 * One table: each kind of thing a guest's device opens, its fixture SEALED BY THE SENDER'S OWN CODE (a member's line as
 * sendSealedGroupLine seals it, a member's edit by sealGroupLineEdit as editSealedGroupLine seals it on both apps, another
 * guest's line by guestLinePayload, epochs by makeGroupEpochRecord and makeGuestEpoch), served as the host serves it, and
 * the words the guest's device then shows. Round 4's tests sealed their edits by hand with the default part, which no
 * member's app does, so a guest's device that opened every edit as 'body' passed them.
 *
 * Then the mutations: an opener that gets one field wrong (an edit opened as 'body', the round 4 defect; a reply opened
 * without what it answers; a line opened as 'edit') must fail exactly the rows it would break. openGroupLine is wrapped
 * below so a test can bend the binding core's guest code asks for; with no mutation set it is core's own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

type Ref = { groupId: string; epoch: number; senderPubHex: string; messageId: string; part?: string; replyToId?: string | null };
const mutation = vi.hoisted(() => ({ bend: null as null | ((ref: Ref) => Ref) }));
vi.mock('../group-crypto.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../group-crypto.js')>();
    const openGroupLine: typeof real.openGroupLine = (payload, ref, key, memo) =>
        real.openGroupLine(payload, (mutation.bend ? mutation.bend(ref as Ref) : ref) as typeof ref, key, memo);
    return { ...real, openGroupLine };
});

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { makeGroupEpochRecord, openGroupLine, sealGroupLine, sealGroupLineEdit, type GroupLinePayload } from '../group-crypto.js';
import { applyGuestMail, guestChatId, guestLinePayload, type GuestChats } from '../group-guest-chat.js';
import { guestEpochStep, makeGuestEpoch, readGuestRoster } from '../group-guest-steps.js';

afterEach(() => { mutation.bend = null; });

function person(name: string) {
    const seed = sha256(utf8ToBytes(`group-guest-aad.test ${name}`));
    return { seedHex: bytesToHex(seed), pk: bytesToHex(ed25519.getPublicKey(seed)), name };
}
type Person = ReturnType<typeof person>;
// Ana and Ben are members; Gus is the guest whose device this is; Gia is another guest, from another community.
const ana = person('Ana'), ben = person('Ben'), gus = person('Gus'), gia = person('Gia');
const HOST = 'riverside.example';
const GROUP = 'grp-seed-library';
const ID = guestChatId(HOST, GROUP);
const NOW = Date.parse('2026-11-16T10:00:00.000Z');
const ctx = { me: gus.pk, myEdPrivHex: gus.seedHex, blocked: () => false, now: NOW };
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const L1 = uuid(1), L2 = uuid(2), L3 = uuid(3);
const T0 = '2026-11-16T09:30:00.000Z', T1 = '2026-11-16T09:35:00.000Z', T2 = '2026-11-16T09:40:00.000Z';
const PHOTO = "A photo or voice message: it doesn't show here yet.";

let seq = 0;
type Notice = { id: string; host: string; group: string; kind: string; data: unknown; receivedAt: number };
const notice = (kind: string, data: unknown): Notice => ({ id: `notice-${++seq}-abcdefgh`, host: HOST, group: GROUP, kind, data, receivedAt: NOW });

// ── The senders' own sealing code ───────────────────────────────────────────────────────────

const RECIPIENTS = [ana.pk, ben.pk, gus.pk, gia.pk];
/** An epoch as a member's app makes one (makeGroupEpochRecord; the apps call its async twin), served as the host serves it. */
function membersEpoch(epoch: number, maker: Person) {
    const made = makeGroupEpochRecord({ myEdPrivHex: maker.seedHex, groupId: GROUP, epoch, reason: 'rotate', subject: null, createdAt: T0, recipients: RECIPIENTS });
    return served(made.record, made.groupKey, maker);
}
/** An epoch another guest's device made (makeGuestEpoch: the `group-epoch` item's payload), served as the host serves it. */
function guestsEpoch(epoch: number, maker: Person) {
    const roster = readGuestRoster(rosterData({ current: epoch - 1, stale: true }))!;
    const step = guestEpochStep(roster, maker.pk);
    if (step.send !== 'group-epoch' || step.epoch !== epoch) throw new Error('the roster does not ask for this epoch');
    const { payload, groupKey } = makeGuestEpoch(step, GROUP, maker.pk, maker.seedHex, T0);
    return served(JSON.parse(payload).epoch, groupKey, maker);
}
/** The host's record (engine/group-guests.ts epochRecord: no group id, no wraps) and Gus's wrap only (wrapsFor). */
function served(record: object, groupKey: Uint8Array, maker: Person) {
    const { groupId: _g, wraps, ...rest } = record as { groupId: string; wraps: Array<Record<string, string>> };
    return { key: groupKey, record: rest, wraps: wraps.filter((w) => w.recipient === gus.pk).map((w) => ({ ...w, wrapper: maker.pk })) };
}
function rosterData(epoch: unknown) {
    return {
        name: 'Seed Library',
        members: [ana, ben].map((p) => ({ key: p.pk, name: p.name })),
        guests: [gus, gia].map((p) => ({ key: p.pk, home: 'hillside.example', name: p.name })),
        epoch,
    };
}
const e6 = membersEpoch(6, ana), e7 = membersEpoch(7, ben), e8 = guestsEpoch(8, gia), e9 = membersEpoch(9, ben);
const keyOf: Record<number, Uint8Array> = { 6: e6.key, 7: e7.key, 8: e8.key, 9: e9.key };

/** A line as the host stores it (engine/group-thread.ts postGroupThreadMessage: metadata { epoch, sender, replyToId? }). */
type Row = { id: string; author: string; ciphertext: string; nonce: string; type: string; metadata: Record<string, unknown>; timestamp: string; editedAt: string | null };

/**
 * A member's line, sealed as sendSealedGroupLine seals it on both apps (apps/native/utils/group-chat-lines.ts,
 * apps/pwa/src/lib/group-chat-lines.ts): the words under { group, epoch, message id, what it answers }, after the newest
 * line they had; a photo's own part sealed beside them. Stored as the host stores it.
 */
function memberLine(by: Person, text: string, o: { id: string; epoch?: number; replyToId?: string | null; after?: string | null; type?: 'image' | 'voice' }): Row {
    const epoch = o.epoch ?? 6;
    const binding = { myEdPrivHex: by.seedHex, groupKey: keyOf[epoch], groupId: GROUP, epoch, messageId: o.id, replyToId: o.replyToId ?? null };
    const sealed = sealGroupLine(text, { ...binding, after: o.after ?? null });
    if (o.type === 'image') sealGroupLine('data:image/jpeg;base64,AAAA', { ...binding, part: 'attachment', after: null });
    return row(by, o.id, sealed, epoch, o.replyToId ?? null, o.type ?? 'text');
}
/** Another guest's line, sealed by the guest's own code (guestLinePayload), stored as the host stores a guest's. */
function guestLine(by: Person, text: string, o: { id: string; epoch: number }): Row {
    const p = JSON.parse(guestLinePayload(text, { group: GROUP, epoch: o.epoch, key: keyOf[o.epoch], messageId: o.id, myEdPrivHex: by.seedHex })) as GroupLinePayload;
    return row(by, o.id, p, o.epoch, null, 'text');
}
function row(by: Person, id: string, sealed: GroupLinePayload, epoch: number, replyToId: string | null, type: string): Row {
    const metadata: Record<string, unknown> = { epoch, sender: by.pk };
    if (replyToId) metadata.replyToId = replyToId;
    return { id, author: by.pk, ciphertext: sealed.ciphertext, nonce: sealed.nonce, type, metadata, timestamp: T0, editedAt: null };
}
/**
 * The line after its author's edit: sealed by sealGroupLineEdit, as editSealedGroupLine seals it on both apps (the line's
 * own epoch and key, what the line answers from its metadata), then stored as the host stores it (engine/group-thread.ts
 * groupChatEdit: the edit's bytes, the line's metadata kept with `sender` the editor; edited_at).
 */
function edited(r: Row, text: string, at: string): Row {
    const by = [ana, ben, gus, gia].find((p) => p.pk === r.author)!;
    const epoch = r.metadata.epoch as number;
    const replyToId = typeof r.metadata.replyToId === 'string' ? r.metadata.replyToId : null;
    const sealed = sealGroupLineEdit(text, { myEdPrivHex: by.seedHex, groupKey: keyOf[epoch], groupId: GROUP, epoch, messageId: r.id, replyToId });
    return { ...r, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { ...r.metadata, epoch, sender: by.pk }, editedAt: at };
}

// ── What the host sends ─────────────────────────────────────────────────────────────────────

/**
 * A `line` notice (engine/group-guests.ts fanOutGroupLine). A copy of a line edited before it went carries the words
 * members read now, with the edit's time (copyOfLine and queueLineChange: wordsNow; at the guest's home, replaceHeldWords).
 */
const lineNotice = (r: Row) => notice('line', {
    id: r.id, author: r.author, ciphertext: r.ciphertext, nonce: r.nonce, type: r.type, metadata: r.metadata, timestamp: r.timestamp,
    ...(r.editedAt ? { editedAt: r.editedAt } : {}),
});
/** An `edit` notice with new words (queueLineChange: the line as members read it now). */
const editNotice = (r: Row) => notice('edit', { id: r.id, action: 'edited', author: r.author, ciphertext: r.ciphertext, nonce: r.nonce, metadata: r.metadata, editedAt: r.editedAt });
/** An `edit` notice that takes a line down (queueLineChange: its id and who took it down, never its words). */
const takedownNotice = (r: Row, by: 'author' | 'convenor') => notice('edit', { id: r.id, action: 'removed', by });
const epochNotice = (e: { record: unknown; wraps: unknown }) => notice('epoch', { record: e.record, wraps: e.wraps });
const rosterNotice = (current: number, e: { record: unknown; wraps: unknown }) => notice('roster', rosterData({ current, stale: false, record: e.record, wraps: e.wraps }));

/** Gus's device: in the chat, epoch 6's key opened from the roster the host sent after his yes. */
function device(): GuestChats {
    const invited = applyGuestMail({}, { items: [notice('invite', { name: 'Seed Library', invitedBy: { key: ana.pk, name: 'Ana' } })] }, ctx).chats;
    invited[ID].state = 'in';
    return applyGuestMail(invited, { items: [rosterNotice(6, e6)] }, ctx).chats;
}
/** Each notice applied as a page of its own, in turn; the words the chat then shows, in its order. */
function shows(notices: Notice[]): string[] {
    let chats = device();
    for (const n of notices) chats = applyGuestMail(chats, { items: [n] }, ctx).chats;
    return chats[ID].lines.map((l) => l.text);
}

// ── The table: what a guest's device opens -> what it shows ─────────────────────────────────

const line1 = memberLine(ana, 'first words', { id: L1 });
const reply2 = memberLine(ben, 'a reply', { id: L2, replyToId: L1, after: L1 });
const held3 = memberLine(ana, 'first words', { id: L3, epoch: 7 });
const ROWS: Array<{ name: string; notices: () => Notice[]; want: string[] }> = [
    { name: "a member's line", notices: () => [lineNotice(line1)], want: ['first words'] },
    { name: "a member's reply (what it answers is in its binding)", notices: () => [lineNotice(line1), lineNotice(reply2)], want: ['first words', 'a reply'] },
    { name: "a member's line after the newest line they had", notices: () => [lineNotice(memberLine(ben, 'after one', { id: L2, after: L1 }))], want: ['after one'] },
    { name: "a member's photo line (its words' part; the photo's own part is never opened here)", notices: () => [lineNotice(memberLine(ana, 'a caption', { id: L1, type: 'image' }))], want: [PHOTO] },
    { name: "a member's voice line", notices: () => [lineNotice(memberLine(ana, '', { id: L1, type: 'voice' }))], want: [PHOTO] },
    { name: 'an edit to a line shown', notices: () => [lineNotice(line1), editNotice(edited(line1, 'new words', T1))], want: ['new words'] },
    { name: 'an edit to a reply shown', notices: () => [lineNotice(line1), lineNotice(reply2), editNotice(edited(reply2, 'a new reply', T1))], want: ['first words', 'a new reply'] },
    { name: 'a line fetched after its edit (the copy carries the edit)', notices: () => [lineNotice(edited(line1, 'new words', T1))], want: ['new words'] },
    { name: 'a reply fetched after its edit', notices: () => [lineNotice(line1), lineNotice(edited(reply2, 'a new reply', T1))], want: ['first words', 'a new reply'] },
    { name: 'an edit to a line held for its key, then the key', notices: () => [lineNotice(held3), editNotice(edited(held3, 'new words', T1)), epochNotice(e7)], want: ['new words'] },
    { name: 'a line fetched after its edit, held for its key, then the key', notices: () => [lineNotice(edited(held3, 'new words', T1)), epochNotice(e7)], want: ['new words'] },
    { name: 'a line edited twice, each edit served', notices: () => [lineNotice(line1), editNotice(edited(line1, 'new words', T1)), editNotice(edited(line1, 'newest words', T2))], want: ['newest words'] },
    { name: 'a line edited twice, fetched after both', notices: () => [lineNotice(edited(edited(line1, 'new words', T1), 'newest words', T2))], want: ['newest words'] },
    { name: 'a line taken down by its author (nothing sealed to open)', notices: () => [lineNotice(line1), takedownNotice(line1, 'author')], want: [] },
    { name: 'an edited line taken down by a convenor', notices: () => [lineNotice(line1), editNotice(edited(line1, 'new words', T1)), takedownNotice(line1, 'convenor')], want: [] },
    { name: "another guest's line (guestLinePayload)", notices: () => [lineNotice(guestLine(gia, 'from Gia', { id: L1, epoch: 6 }))], want: ['from Gia'] },
    { name: "another guest's line, edited (sealGroupLineEdit)", notices: () => { const g = guestLine(gia, 'from Gia', { id: L1, epoch: 6 }); return [lineNotice(g), editNotice(edited(g, 'Gia again', T1))]; }, want: ['Gia again'] },
    { name: "a key from an epoch notice (a member's epoch), and a line under it", notices: () => [epochNotice(e7), lineNotice(held3)], want: ['first words'] },
    { name: "a key from an epoch another guest's device made (makeGuestEpoch), and a line under it", notices: () => [epochNotice(e8), lineNotice(memberLine(ben, 'under eight', { id: L1, epoch: 8 }))], want: ['under eight'] },
    { name: "a key from a later roster (a member's epoch), and a line under it", notices: () => [rosterNotice(9, e9), lineNotice(memberLine(ben, 'under nine', { id: L1, epoch: 9 }))], want: ['under nine'] },
];

describe('THE AAD RULE (round 5): each thing a guest device opens, sealed by its sender\'s own code -> the words it shows', () => {
    it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, r) => {
        expect(shows(r.notices())).toEqual(r.want);
    });

    it("a member's edit is what both apps seal (part 'edit', after the line's own id): it never opens as 'body'", () => {
        const e = edited(reply2, 'a new reply', T1);
        const ref = { groupId: GROUP, epoch: 6, senderPubHex: ben.pk, messageId: L2, replyToId: L1 };
        expect(openGroupLine(e, { ...ref, part: 'edit' }, e6.key)).toEqual({ text: 'a new reply', after: L2 });
        expect(() => openGroupLine(e, { ...ref, part: 'body' }, e6.key)).toThrow();
        expect(() => openGroupLine(e, { ...ref, part: 'edit', replyToId: null }, e6.key)).toThrow();
    });
});

// ── Mutations: an opener with one field wrong fails exactly the rows it would break ─────────

describe('MUTATIONS (round 5): bend one field of what the guest device opens with -> exactly these rows fail', () => {
    const EDITS = [
        'an edit to a line shown', 'an edit to a reply shown', 'a line fetched after its edit (the copy carries the edit)', 'a reply fetched after its edit',
        'an edit to a line held for its key, then the key', 'a line fetched after its edit, held for its key, then the key', 'a line edited twice, each edit served',
        'a line edited twice, fetched after both', "another guest's line, edited (sealGroupLineEdit)",
    ];
    const REPLIES = ["a member's reply (what it answers is in its binding)", 'an edit to a reply shown', 'a reply fetched after its edit'];
    const failing = () => ROWS.filter((r) => JSON.stringify(shows(r.notices())) !== JSON.stringify(r.want)).map((r) => r.name);
    it("an edit opened as 'body' (round 4's defect): every row with an edit in it fails, and no other", () => {
        mutation.bend = (ref) => (ref.part === 'edit' ? { ...ref, part: 'body' } : ref);
        expect(failing().sort()).toEqual([...EDITS].sort());
    });
    it('a reply opened without what it answers: every reply row fails, and no other', () => {
        mutation.bend = (ref) => ({ ...ref, replyToId: null });
        expect(failing().sort()).toEqual([...REPLIES].sort());
    });
    it("a line's own words opened as 'edit': every row with an unedited line shown fails", () => {
        mutation.bend = (ref) => ((ref.part ?? 'body') === 'body' ? { ...ref, part: 'edit' } : ref);
        const f = failing();
        for (const r of ROWS.filter((x) => x.want.length && !EDITS.includes(x.name))) expect(f, r.name).toContain(r.name);
    });
    it('with no mutation, no row fails (the bends above are what fail them)', () => {
        expect(failing()).toEqual([]);
    });
});
