/**
 * "Show my community on global" on the server (slice F10; scratch/fable-design/DESIGN-forums-fable.md §12, §15, §16, §21 F10;
 * the joint design §2.6). @beanpool/core membership-note.ts holds the note, its bytes and its check; routes/membership-note.ts
 * answers both halves.
 *
 * **The member's community** signs a note for a member who asks (routes/membership-note.ts): it holds nothing of it.
 *
 * **A public forum** (`forumPublic`, the worldwide community) keeps what each member chose to show (`forum_labels`):
 *   - "Don't show": no row (deleted, with its tombstone).
 *   - "I'm waiting to join one": the member's own word, kept as it is; nothing checks it.
 *   - their community: only with a note that passes, checked here at once, in the member's own request: the community must be
 *     listed in the directory this server keeps (`directory_cache`, the hourly mirror's), and the note's signature must be that
 *     community's key, which is inside its directory key (a PeerId names its Ed25519 key). No other server is asked anything,
 *     so the design's rule that a member's request never makes this server call another holds, and the member reads the answer
 *     at once ("Your community isn't listed publicly…") instead of a label that never comes. The note itself is not kept:
 *     only the community's key and when the note lapses.
 *
 * **At each read** (forumLabelsOf) a writer's label is drawn only while it holds: 'waiting' as kept; 'community' while its note
 * lasts and its community is listed, with the name the directory shows for it now. Anything else is the name alone, never a
 * wrong community. That is one indexed read for every writer in an answer (30 at most), on a server where the forum is public,
 * and none anywhere else: nothing is held in memory, nothing runs on a timer, and nothing is checked again per read but two
 * columns (design §15). A standby holds the same rows (the manifest's `forum_labels` line) and the same directory, so it draws
 * the same labels; it changes none (503 `standby` at the route).
 *
 * A re-key leaves the old key's label behind (engine/key-move.ts): the note was for that key, and the member's app asks for one
 * for the new key. Deleting an account, or its removal, deletes its label (engine/forum.ts dropForumOf).
 */
import crypto from 'node:crypto';
import { peerIdFromPublicKey, peerIdFromString } from '@libp2p/peer-id';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { FORUM_LABEL_SHOWS, checkMembershipNote, readMembershipNote, word, type ForumLabelShow, type ForumWriterLabel, type MembershipNoteProblem } from '@beanpool/core';
import { db, deletePlainRows } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';

const iso = (ms: number) => new Date(ms).toISOString();

export class MembershipNoteRefusal extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
    }
}

export const MEMBERSHIP_NOTE_WORDS = {
    notListed: word('Your community isn’t listed publicly, so its name can’t be shown.'),
    otherKey: word('This note from your community is for another account, so its name can’t be shown. Ask your community again from this account.'),
    expired: word('This note from your community has run out. Ask your community again.'),
    badSignature: word('This note couldn’t be checked against your community’s key, so its name can’t be shown.'),
    malformed: word('That isn’t a note from a community.'),
    notHere: word('Only the worldwide community’s forum shows the community you are from.'),
};

const PROBLEM_REFUSAL: Record<MembershipNoteProblem, [number, string, string]> = {
    malformed: [400, 'note_malformed', MEMBERSHIP_NOTE_WORDS.malformed],
    other_key: [403, 'note_other_key', MEMBERSHIP_NOTE_WORDS.otherKey],
    not_yet: [400, 'note_expired', MEMBERSHIP_NOTE_WORDS.expired],
    expired: [400, 'note_expired', MEMBERSHIP_NOTE_WORDS.expired],
    too_long: [400, 'note_expired', MEMBERSHIP_NOTE_WORDS.expired],
    bad_signature: [400, 'note_bad_signature', MEMBERSHIP_NOTE_WORDS.badSignature],
};

// ── Directory keys and node keys ────────────────────────────────────────────────────────────────────────────────

/** The directory key (PeerId) of a node key given as 64 hex characters: what a listed server pushes as its `nodeId`. */
export function communityKeyOfNodeKey(keyHex: string): string {
    return peerIdFromPublicKey(publicKeyFromRaw(Buffer.from(keyHex, 'hex'))).toString();
}

/** The 32 raw bytes of the Ed25519 key a directory key names, or null: not a PeerId, or one that carries no Ed25519 key. */
export function nodeKeyOfCommunityKey(communityKey: string): Uint8Array | null {
    try {
        const peer = peerIdFromString(communityKey);
        if (peer.type !== 'Ed25519' || !peer.publicKey) return null;
        const raw = peer.publicKey.raw;
        return raw.length === 32 ? new Uint8Array(raw) : null;
    } catch {
        return null;
    }
}

// ── The member's choice, on a public forum ──────────────────────────────────────────────────────────────────────

interface LabelRow { member_pubkey: string; kind: 'community' | 'waiting'; community_key: string | null; lapses_at: string | null }

/** What a member chose and what the forum draws for it (GET /api/forum/label, for both apps' Settings row). */
export interface ForumLabelState {
    show: ForumLabelShow;
    /** The community chosen: its directory key, and its name as the directory shows it now (null while it isn't listed). */
    community: { key: string; name: string | null } | null;
    /** When the community's note lapses; the app asks for a new one before then. */
    lapsesAt: string | null;
    /** What the forum draws beside their name now; null: their name alone. */
    label: ForumWriterLabel | null;
    /** Why a community chosen is not drawn: its note ran out, or it isn't listed now. */
    why: 'expired' | 'not_listed' | null;
}

function assertPublicForum(): void {
    const s = getProfileSwitches();
    if (!s.forum || !s.forumPublic) throw new MembershipNoteRefusal(404, 'not_here', MEMBERSHIP_NOTE_WORDS.notHere);
}

/** A listed community's name in the directory this server keeps, or null: not there, not listed, or no name that passed. */
function listedName(communityKey: string): string | null {
    const row = db.prepare('SELECT name FROM directory_cache WHERE community_key = ? AND listed = 1').get(communityKey) as { name: string | null } | undefined;
    return row?.name ?? null;
}

/** The label a row draws at `now`, and why a community's isn't. */
function drawn(row: LabelRow | undefined, name: string | null, now: number): { label: ForumWriterLabel | null; why: ForumLabelState['why'] } {
    if (!row) return { label: null, why: null };
    if (row.kind === 'waiting') return { label: { kind: 'waiting' }, why: null };
    if (!row.lapses_at || row.lapses_at <= iso(now)) return { label: null, why: 'expired' };
    if (!name) return { label: null, why: 'not_listed' };
    return { label: { kind: 'community', community: name }, why: null };
}

export function forumLabelState(member: string, now = Date.now()): ForumLabelState {
    assertPublicForum();
    const row = db.prepare('SELECT * FROM forum_labels WHERE member_pubkey = ?').get(member) as LabelRow | undefined;
    const name = row?.community_key ? listedName(row.community_key) : null;
    const { label, why } = drawn(row, name, now);
    return {
        show: row?.kind ?? 'none',
        community: row?.community_key ? { key: row.community_key, name } : null,
        lapsesAt: row?.lapses_at ?? null,
        label,
        why,
    };
}

/**
 * The member's choice (POST /api/forum/label { show, note? }), on the main server. 'community' takes only a note that passes
 * (see the header); one that doesn't is refused with why, and what was kept before stays.
 */
export function setForumLabel(member: string, body: { show?: unknown; note?: unknown }, now = Date.now()): ForumLabelState {
    assertPublicForum();
    const show = body.show;
    if (typeof show !== 'string' || !(FORUM_LABEL_SHOWS as readonly string[]).includes(show)) {
        throw new MembershipNoteRefusal(400, 'bad_request', 'show is one of none, community or waiting.');
    }
    assertPlainTablesWritable();
    const upsert = db.prepare(`INSERT INTO forum_labels (member_pubkey, kind, community_key, lapses_at) VALUES (@member, @kind, @community, @lapses)
        ON CONFLICT(member_pubkey) DO UPDATE SET kind = excluded.kind, community_key = excluded.community_key, lapses_at = excluded.lapses_at`);
    if (show === 'none') {
        deletePlainRows('forum_labels', 'member_pubkey = ?', member);
    } else if (show === 'waiting') {
        upsert.run({ member, kind: 'waiting', community: null, lapses: null });
    } else {
        // The cheapest first. Its shape, its member and its time, with no key: a note good in every other way then fails only
        // its signature, so any other problem is refused for what it is.
        const unsigned = checkMembershipNote(body.note, { member, communityPublicKey: null, now });
        if (!unsigned.ok && unsigned.problem !== 'bad_signature') refuse(unsigned.problem);
        const note = readMembershipNote(body.note)!;
        // Then the directory (one indexed read): an unlisted community is told so, and its signature never checked.
        if (!listedName(note.community)) throw new MembershipNoteRefusal(409, 'not_listed', MEMBERSHIP_NOTE_WORDS.notListed);
        // Then the signature, by the key inside the community's directory key.
        const checked = checkMembershipNote(note, { member, communityPublicKey: nodeKeyOfCommunityKey(note.community), now });
        if (!checked.ok) refuse(checked.problem);
        upsert.run({ member, kind: 'community', community: note.community, lapses: iso(note.expiresAt) });
    }
    return forumLabelState(member, now);
}

function refuse(problem: MembershipNoteProblem): never {
    const [status, code, words] = PROBLEM_REFUSAL[problem];
    throw new MembershipNoteRefusal(status, code, words);
}

// ── At each read ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The label each of `members` shows on this forum now (writers of one answer: 30 at most): one indexed read, joined to the
 * directory for the community's name while it is listed. On a forum that is not public, none, and no read at all.
 */
export function forumLabelsOf(members: readonly string[], now = Date.now()): Map<string, ForumWriterLabel> {
    const out = new Map<string, ForumWriterLabel>();
    const s = getProfileSwitches();
    const keys = [...new Set(members)];
    if (!s.forumPublic || keys.length === 0) return out;
    const rows = db.prepare(`SELECT l.member_pubkey, l.kind, l.community_key, l.lapses_at, d.name AS name FROM forum_labels l
        LEFT JOIN directory_cache d ON d.community_key = l.community_key AND d.listed = 1
        WHERE l.member_pubkey IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys)) as (LabelRow & { name: string | null })[];
    for (const row of rows) {
        const { label } = drawn(row, row.name, now);
        if (label) out.set(row.member_pubkey, label);
    }
    return out;
}

/**
 * What the labels drawn depend on, for a list's tag (engine/forum.ts forumListTag): the rows (their count and newest stamp),
 * the next note to lapse, and the directory's newest change. Each is one indexed read; any change, a lapse included, moves it.
 */
export function forumLabelsTag(now = Date.now()): string {
    if (!getProfileSwitches().forumPublic) return '';
    const at = iso(now);
    const rows = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM forum_labels').get() as { n: number; u: string | null };
    const next = db.prepare('SELECT MIN(lapses_at) AS l FROM forum_labels WHERE lapses_at > ?').get(at) as { l: string | null };
    const directory = db.prepare('SELECT MAX(updated_at) AS u FROM directory_cache').get() as { u: string | null };
    return crypto.createHash('sha256').update(`${rows.n}:${rows.u ?? ''}|${next.l ?? ''}|${directory.u ?? ''}`).digest('hex').slice(0, 16);
}

/** A member gone (account deleted, or removed): their label too, with its tombstone. Inside the removal's transaction. */
export function dropForumLabelOf(member: string): void {
    deletePlainRows('forum_labels', 'member_pubkey = ?', member);
}
