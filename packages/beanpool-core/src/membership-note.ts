/**
 * "Show my community on global" (scratch/fable-design/DESIGN-forums-fable.md §12, slice F10; the joint design §2.6): the short
 * note a member's own community signs for them, and the check the worldwide forum makes of it before "Marty · Riverside" is
 * drawn beside their name.
 *
 * **The note** says: this member key is a member here, this is the community's name, from this time until that one (30 days
 * at the most). The community's server signs it with its node key: the key whose PeerId is that community's key in the public
 * directory (the `nodeId` every listed server pushes, services/directory-publisher.ts). So the forum that checks it needs
 * nothing but the directory row it already keeps: the key is inside the PeerId, and no other server is asked anything, by
 * the member's request or after it. A community on its own domain, an IP or a home network gets its note the same way: the
 * note names a key, never an address.
 *
 * **The check** (checkMembershipNote) is made in this order, the cheapest first: the note's shape, exactly its seven fields
 * (readMembershipNote); the member key it names is the key asking; its time (issued no later than a few minutes from now,
 * not lapsed, and promising no more than 30 days); then the signature, by the community key the caller looked up in its
 * directory (whether that community is listed is the caller's to say, before it asks for this). Anything else is no label.
 *
 * **The bytes** signed are a JSON array, so no field can run into the next: `["beanpool-membership-note", 1, community,
 * name, member, issuedAt, expiresAt]`, in UTF-8. Ed25519, strict (zip215 false), the signature as 128 hex characters.
 *
 * **The name line** (forumWriterNameLine): the forum's writer, with the label the forum proved, as @beanpool/core nameLine
 * takes it, so both apps write "Marty · Riverside", "Asha · waiting to join" or "Marty" the same way.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { NameLineInput } from './name-line.js';

/** How long a note is good for, at the most: the community signs this, the forum refuses a note promising longer. */
export const MEMBERSHIP_NOTE_DAYS = 30;
export const MEMBERSHIP_NOTE_MAX_MS = MEMBERSHIP_NOTE_DAYS * 24 * 60 * 60 * 1000;
/** How far ahead of the checking server's clock a note's issue time may be: two servers' clocks differ a little. */
export const MEMBERSHIP_NOTE_SKEW_MS = 5 * 60 * 1000;
/** The longest community name a note carries: the directory's own limit on a shown name (engine/directory-cache.ts). */
export const MEMBERSHIP_NOTE_NAME_MAX = 80;

const NOTE_DOMAIN = 'beanpool-membership-note';
const NOTE_FIELDS = ['v', 'community', 'name', 'member', 'issuedAt', 'expiresAt', 'sig'] as const;
/** A PeerId as the directory keeps it: base58btc, no padding. An Ed25519 one is 52 characters; longer than 100 is none. */
const COMMUNITY_KEY_RE = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;
const MEMBER_KEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;
// Control characters and the ones that turn text around: never in a name drawn beside someone else's.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/** The note as it travels: from the member's community, through their app, to the forum that checks it. */
export interface MembershipNote {
    v: 1;
    /** The community's key in the public directory: the PeerId of the node key that signed this. */
    community: string;
    /** The community's name, as its server signed it. */
    name: string;
    /** The member's key (64 lower-case hex characters), the key this note is for. */
    member: string;
    /** When it was signed, and when it lapses: milliseconds since 1970. */
    issuedAt: number;
    expiresAt: number;
    /** Ed25519 by the community's node key over membershipNoteBytes, 128 hex characters. */
    sig: string;
}

export type MembershipNoteFields = Omit<MembershipNote, 'v' | 'sig'>;

/** Why a note shows no label. */
export type MembershipNoteProblem = 'malformed' | 'other_key' | 'not_yet' | 'expired' | 'too_long' | 'bad_signature';

/** The bytes a community signs and a forum checks. */
export function membershipNoteBytes(f: MembershipNoteFields): Uint8Array {
    return utf8ToBytes(JSON.stringify([NOTE_DOMAIN, 1, f.community, f.name, f.member, f.issuedAt, f.expiresAt]));
}

/** Whether `name` is a community name a note may carry: some text, at most 80 characters, nothing that hides or turns text. */
export function isMembershipNoteName(name: unknown): name is string {
    return typeof name === 'string' && name.trim() === name && name.length > 0 && [...name].length <= MEMBERSHIP_NOTE_NAME_MAX
        && !UNSAFE_NAME_RE.test(name);
}

/**
 * A community's name as a note carries it, or null when nothing is left: the characters that hide or turn text taken out,
 * trimmed, and cut to 80 characters (as the directory cuts a shown name, engine/directory-cache.ts).
 */
export function toMembershipNoteName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const cut = [...raw.replace(new RegExp(UNSAFE_NAME_RE.source, 'g'), '').trim()].slice(0, MEMBERSHIP_NOTE_NAME_MAX).join('').trim();
    return isMembershipNoteName(cut) ? cut : null;
}

/**
 * The note `raw` is, or null: an object with exactly the seven fields, each what it says. Any other field, a number as text,
 * a key in capitals, a time that is not a whole number of milliseconds, and it is no note.
 */
export function readMembershipNote(raw: unknown): MembershipNote | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== NOTE_FIELDS.length || !NOTE_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) return null;
    if (o.v !== 1) return null;
    if (typeof o.community !== 'string' || !COMMUNITY_KEY_RE.test(o.community)) return null;
    if (!isMembershipNoteName(o.name)) return null;
    if (typeof o.member !== 'string' || !MEMBER_KEY_RE.test(o.member)) return null;
    if (!Number.isSafeInteger(o.issuedAt) || !Number.isSafeInteger(o.expiresAt) || (o.issuedAt as number) < 0) return null;
    if (typeof o.sig !== 'string' || !SIG_RE.test(o.sig)) return null;
    return {
        v: 1, community: o.community, name: o.name, member: o.member, issuedAt: o.issuedAt as number, expiresAt: o.expiresAt as number, sig: o.sig,
    };
}

/**
 * A note signed by `sign` (the community's node key: Ed25519 over the bytes given). Throws on fields no note may hold, so a
 * server never hands out one the forum would refuse for its shape.
 */
export function signMembershipNote(f: MembershipNoteFields, sign: (bytes: Uint8Array) => Uint8Array): MembershipNote {
    const sig = bytesToHex(sign(membershipNoteBytes(f)));
    const note = readMembershipNote({ v: 1, community: f.community, name: f.name, member: f.member, issuedAt: f.issuedAt, expiresAt: f.expiresAt, sig });
    if (!note) throw new Error('These fields do not make a membership note (a community key, a name of up to 80 characters, a member key, two times).');
    return note;
}

/**
 * Whether `note` shows a label for `member` at `now`, signed by the community key `communityPublicKey` (the 32 raw bytes of
 * the Ed25519 key the caller's directory row names for `note.community`). The cheapest checks first; never throws.
 */
export function checkMembershipNote(
    raw: unknown,
    opts: { member: string; communityPublicKey: Uint8Array | null; now: number },
): { ok: true; note: MembershipNote } | { ok: false; problem: MembershipNoteProblem } {
    const note = readMembershipNote(raw);
    if (!note) return { ok: false, problem: 'malformed' };
    if (note.member !== opts.member) return { ok: false, problem: 'other_key' };
    if (note.issuedAt > opts.now + MEMBERSHIP_NOTE_SKEW_MS) return { ok: false, problem: 'not_yet' };
    if (note.expiresAt <= opts.now) return { ok: false, problem: 'expired' };
    if (note.expiresAt - note.issuedAt > MEMBERSHIP_NOTE_MAX_MS) return { ok: false, problem: 'too_long' };
    if (!opts.communityPublicKey || opts.communityPublicKey.length !== 32) return { ok: false, problem: 'bad_signature' };
    let good = false;
    try {
        good = ed25519.verify(hexToBytes(note.sig), membershipNoteBytes(note), opts.communityPublicKey, { zip215: false });
    } catch {
        good = false;
    }
    return good ? { ok: true, note } : { ok: false, problem: 'bad_signature' };
}

// ── The three-way switch and the name line ──────────────────────────────────────────────────────────────────────

/** What a member chose to show beside their name on the worldwide forum: nothing, their community, or "waiting to join". */
export const FORUM_LABEL_SHOWS = ['none', 'community', 'waiting'] as const;
export type ForumLabelShow = typeof FORUM_LABEL_SHOWS[number];

/** The label the forum proved for a writer, as its answers carry it (`writer.label`); null: the name alone. */
export type ForumWriterLabel = { kind: 'community'; community: string } | { kind: 'waiting' };

/** A forum writer, as the forum answers name them, for the one name line (@beanpool/core nameLine). */
export function forumWriterNameLine(writer: { name: string; label?: ForumWriterLabel | null }): NameLineInput {
    const label = writer.label ?? null;
    if (label?.kind === 'community') return { name: writer.name, kind: 'community', community: label.community };
    if (label?.kind === 'waiting') return { name: writer.name, kind: 'waiting' };
    return { name: writer.name, kind: 'name' };
}
