/**
 * A member asks an admin to invite someone (Marty, 3 Nov: "a request to an admin of a [closed] community"). Where only its
 * admins invite (the door, config/door.ts) a member who knows someone had no way to say so. The routes are
 * routes/invite-asks.ts; this file owns the rules and what the node keeps.
 *
 * ## Who
 *
 * A member in good standing asks, only while the door is `admins` and invites are on, and only if they can't invite
 * themselves. An owner or admin answers (node_roles by nodeRoleOf, on the request's own signature): a moderator reads
 * nothing and answers nothing, as they neither read nor answer requests to join where only admins invite.
 *
 * ## What an answer makes
 *
 * "Send invite" is an ordinary invite: made by the admin who answers (`generateInvite`, under the same limit, W-main). It names nobody: `intended_for` stays empty, so nothing of the request
 * is on it. Anyone who holds the code joins with it. "No" carries a reason if the admin wrote one.
 *
 * ## What is kept, and for how long
 *
 * One row in `invite_asks`: who asked, the first name, the line, when. It is deleted, with a tombstone, the moment it is
 * answered or taken back, 30 days after it was made (`tidyInviteAsks`, on a timer, main server only), and when its member
 * is removed or deletes their account. secure_delete zeroes the row's bytes where they were. The tombstone holds the row's
 * id and nothing else, so a standby deletes its copy. A backup is a copy of the database at the moment it was taken, so it
 * holds the asks waiting at that moment until that backup itself goes.
 *
 * What tells the member how it ended is a kept notice (engine/kept-notices.ts), not the request: fixed words, and in its
 * data the outcome, the time they asked, and the code or the admin's reason. No name and no line of the request, and no
 * admin's name: the moderation notices' own rule. A notice goes with a member's account, moves with a re-key and leaves a
 * standby by tombstone like any other, and is gone after 60 days. The push carries the fixed words only, and no socket
 * event carries anything about an ask.
 *
 * ## Limits
 *
 * `INVITE_ASK_LIMITS.waiting` waiting at once, read from the rows. `INVITE_ASK_LIMITS.perDay` made in any 24 hours can't be:
 * an ask leaves no row once it is answered or taken back, and it must count all the same, or asking and taking back
 * would ring the admins' Needs you for as long as a member liked. The count is in memory, a key and the times of its asks:
 * nothing of a request goes to disk to count it, and what a restart forgets is one more ask.
 *
 * ## Who reads it
 *
 * The member who asked (their own, signed) and owners and admins. It is in no directory, no assistant read (the admin
 * queue counts it only for a caller that asks, and the assistant's tools don't), and no log: nothing here logs the text.
 * An ask whose member can no longer be answered (paused, removed, or a key since replaced) is not listed or counted.
 */
import crypto from 'node:crypto';
import { db, deletePlainRows } from '../db/db.js';
import { getMember, isNodeMember, isSuspendedAccount } from '@beanpool/engine';
import { INVITE_ASK_LIMITS, INVITE_ASK_WORDS, type InviteAskAnswer, type InviteAskToAnswer, type InviteAskWaiting } from '@beanpool/core';
import { assertFeatureOn, getProfileSwitches } from '../config/node-profile.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { getDoor } from '../config/door.js';
import { isNodeAdmin, nodeRoleOf } from './node-roles.js';
import { getNodeRole } from './sync.js';
import { generateInvite } from './invites.js';
import { assertMayMakeInvite } from './writer-bounds.js';
import { keepNotice, listKeptNotices } from './kept-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An invite's life: redeemInvite refuses one older than this. */
const INVITE_LIFE_MS = 30 * DAY_MS;
const iso = (ms: number) => new Date(ms).toISOString();

/** How a kept notice says it is an ask's answer (engine/kept-notices.ts `data.kind`). */
const NOTICE_KIND = 'invite_ask';

interface AskRow { id: string; asker_pubkey: string; first_name: string; how_known: string; asked_at: string }

/** What counts as an ask to answer, as SQL: unexpired, and its member still in good standing here. */
const LIVE = `asked_at >= ? AND EXISTS (SELECT 1 FROM members m WHERE m.public_key = invite_asks.asker_pubkey AND m.status = 'active' AND m.is_visitor = 0)`;
const liveSince = (now: number) => iso(now - INVITE_ASK_LIMITS.keptDays * DAY_MS);

// ── The member ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type AskRefusal = 'not_member' | 'not_active' | 'door_not_admins' | 'may_invite' | 'too_many_waiting' | 'asked_enough_today';

/** A key's asks in the last 24 hours, by the moment each was made. See "Limits" above. */
const askedTimes = new Map<string, number[]>();

export function _forgetAskTimesForTests(): void {
    askedTimes.clear();
}

function timesToday(member: string, now: number): number[] {
    const kept = (askedTimes.get(member) ?? []).filter((at) => now - at < DAY_MS);
    if (kept.length > 0) askedTimes.set(member, kept); else askedTimes.delete(member);
    return kept;
}

/** Why `member` can't ask now, or null when they can. Nothing is read of what they would ask. */
export function askRefusal(member: string, now = Date.now()): AskRefusal | null {
    if (!isNodeMember(db, member)) return 'not_member';
    if (isSuspendedAccount(db, member)) return 'not_active';
    if (getDoor() !== 'admins') return 'door_not_admins';
    if (isNodeAdmin(member)) return 'may_invite';
    const waiting = (db.prepare('SELECT COUNT(*) AS n FROM invite_asks WHERE asker_pubkey = ? AND asked_at >= ?')
        .get(member, liveSince(now)) as { n: number }).n;
    if (waiting >= INVITE_ASK_LIMITS.waiting) return 'too_many_waiting';
    if (timesToday(member, now).length >= INVITE_ASK_LIMITS.perDay) return 'asked_enough_today';
    return null;
}

/** Record an ask, or say why not. The caller has read and cleaned the two lines. */
export function makeInviteAsk(member: string, firstName: string, howKnown: string, now = Date.now()): { ok: true; ask: InviteAskWaiting } | { ok: false; reason: AskRefusal } {
    assertPlainTablesWritable();
    assertFeatureOn('invites');
    const reason = askRefusal(member, now);
    if (reason) return { ok: false, reason };
    const id = crypto.randomUUID();
    const askedAt = iso(now);
    db.prepare('INSERT INTO invite_asks (id, asker_pubkey, first_name, how_known, asked_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, member, firstName, howKnown, askedAt);
    askedTimes.set(member, [...timesToday(member, now), now]);
    return { ok: true, ask: { id, firstName, howKnown, askedAt } };
}

const toWaiting = (r: AskRow): InviteAskWaiting => ({ id: r.id, firstName: r.first_name, howKnown: r.how_known, askedAt: r.asked_at });

/** The member's own: what is waiting, and how the others ended, newest first. */
export function myInviteAsks(member: string, now = Date.now()): { waiting: InviteAskWaiting[]; answers: InviteAskAnswer[] } {
    const rows = db.prepare('SELECT * FROM invite_asks WHERE asker_pubkey = ? AND asked_at >= ? ORDER BY asked_at DESC, id DESC')
        .all(member, liveSince(now)) as AskRow[];
    const shownSince = now - INVITE_LIFE_MS;
    const answers = listKeptNotices(member, {}, now)
        .filter((n) => n.data.kind === NOTICE_KIND && Date.parse(n.createdAt) >= shownSince)
        .reverse()
        .map((n): InviteAskAnswer => {
            const d = n.data as { outcome?: unknown; code?: unknown; askedAt?: unknown; reason?: unknown };
            const base = { id: n.id, askedAt: typeof d.askedAt === 'string' ? d.askedAt : n.createdAt, answeredAt: n.createdAt };
            if (d.outcome !== 'invited') return { ...base, outcome: 'no', ...(typeof d.reason === 'string' && d.reason ? { reason: d.reason } : {}) };
            const code = typeof d.code === 'string' ? d.code : '';
            const invite = db.prepare('SELECT used_by, created_at FROM invite_codes WHERE code = ?').get(code) as { used_by: string | null; created_at: string } | undefined;
            if (invite?.used_by) return { ...base, outcome: 'invited', state: 'used' };
            if (!invite || now - Date.parse(invite.created_at) > INVITE_LIFE_MS) return { ...base, outcome: 'invited', state: 'lapsed' };
            return { ...base, outcome: 'invited', state: 'ready', code };
        });
    return { waiting: rows.map(toWaiting), answers };
}

/** The member takes their own ask back: it is deleted, and it still counts towards today's. Someone else's reads as none. */
export function withdrawInviteAsk(member: string, id: string): boolean {
    assertPlainTablesWritable();
    return deletePlainRows('invite_asks', 'id = ? AND asker_pubkey = ?', id, member) > 0;
}

// ── The owners and admins ────────────────────────────────────────────────────────────────────────────────────────────

/** Whether this key answers asks here: an owner or admin, now, by their role. Never a moderator. */
export function answersInviteAsks(pubkey: string): boolean {
    const role = nodeRoleOf(pubkey);
    return role === 'owner' || role === 'admin';
}

/**
 * How many asks wait for an answer, for Needs you: none while invites are off, when nothing can answer them, nor once the door
 * is no longer `admins`, when neither app shows the list (any member may invite then; the asks lapse in their 30 days).
 */
export function inviteAskCount(now = Date.now()): number {
    if (!getProfileSwitches().invites || getDoor() !== 'admins') return 0;
    return liveCount(now);
}

const liveCount = (now: number) => (db.prepare(`SELECT COUNT(*) AS n FROM invite_asks WHERE ${LIVE}`).get(liveSince(now)) as { n: number }).n;

/** The asks to answer, oldest first: the longest waiting is the next to read. */
export function listInviteAsks(limit: number, offset: number, now = Date.now()): { asks: InviteAskToAnswer[]; total: number } {
    const rows = db.prepare(`SELECT * FROM invite_asks WHERE ${LIVE} ORDER BY asked_at ASC, id ASC LIMIT ? OFFSET ?`)
        .all(liveSince(now), limit, offset) as AskRow[];
    return {
        asks: rows.map((r) => ({ ...toWaiting(r), askerPubkey: r.asker_pubkey, askerCallsign: getMember(db, r.asker_pubkey)?.callsign ?? '' })),
        total: liveCount(now),
    };
}

function liveAsk(id: string, now: number): AskRow | undefined {
    return db.prepare(`SELECT * FROM invite_asks WHERE id = ? AND ${LIVE}`).get(id, liveSince(now)) as AskRow | undefined;
}

export type AskAnswerOutcome = { ok: true; asker: string } | { ok: false; reason: 'not_found' };

/**
 * "Send invite": in one transaction the invite, the ask's delete and the notice that holds the code, so an invite nobody
 * can read is never made. A refusal of the invite (the admin's limit) throws, and nothing commits.
 */
export function answerWithInvite(id: string, admin: string, now = Date.now()): AskAnswerOutcome {
    return db.transaction((): AskAnswerOutcome => {
        const row = liveAsk(id, now);
        if (!row) return { ok: false, reason: 'not_found' };
        const invite = generateInvite(admin, undefined, () => assertMayMakeInvite(admin));
        if (!invite) throw new Error('an ask could not be answered: the invite was not made');
        deletePlainRows('invite_asks', 'id = ?', id);
        const kept = keepNotice(row.asker_pubkey, INVITE_ASK_WORDS.noticeTitle, INVITE_ASK_WORDS.noticeBody,
            { kind: NOTICE_KIND, outcome: 'invited', code: invite.code, askedAt: row.asked_at }, now);
        if (!kept) throw new Error('an ask could not be answered: the answer was not kept');
        return { ok: true, asker: row.asker_pubkey };
    })();
}

/** "No", with what the admin wrote if they did. In one transaction with the ask's delete, as above. */
export function answerNo(id: string, reason: string, now = Date.now()): AskAnswerOutcome {
    return db.transaction((): AskAnswerOutcome => {
        const row = liveAsk(id, now);
        if (!row) return { ok: false, reason: 'not_found' };
        deletePlainRows('invite_asks', 'id = ?', id);
        const kept = keepNotice(row.asker_pubkey, INVITE_ASK_WORDS.noticeTitle, INVITE_ASK_WORDS.noticeBody,
            { kind: NOTICE_KIND, outcome: 'no', askedAt: row.asked_at, ...(reason ? { reason } : {}) }, now);
        if (!kept) throw new Error('an ask could not be answered: the answer was not kept');
        return { ok: true, asker: row.asker_pubkey };
    })();
}

// ── The tidy-up ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Deletes every ask past its 30 days, each with its tombstone. Returns how many went. */
export function tidyInviteAsks(now = Date.now()): number {
    return deletePlainRows('invite_asks', 'asked_at < ?', liveSince(now));
}

let tidyTimer: ReturnType<typeof setInterval> | null = null;

/** The tidy-up on a timer, on the main server only: a standby takes the deletions from its copy. */
export function startTidyingInviteAsks(everyMs = 60 * 60 * 1000): void {
    if (tidyTimer) clearInterval(tidyTimer);
    tidyTimer = setInterval(() => {
        if (getNodeRole() !== 'primary') return;
        try { tidyInviteAsks(); } catch (e) { console.warn('[Invite asks] could not tidy:', (e as Error)?.message || e); }
    }, everyMs);
    tidyTimer.unref?.();
}
