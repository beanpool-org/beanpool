/**
 * "Show my community on global" (slice F10; scratch/fable-design/DESIGN-forums-fable.md §12, §21 F10): both halves. The note and
 * its check are @beanpool/core membership-note.ts; what a public forum keeps and draws, engine/membership-note.ts. Every route
 * is signed, and the member is always the signer, never a body field.
 *
 * On every community, the note its own members carry (the local half):
 *   GET  /api/membership/note → { note }   a member who reads as one. The note says this key is a member here, the community's
 *        name and its directory key, for 30 days, signed by this server's node key (the key its directory key names).
 *        403 `not_member` / `not_active`; 409 `not_listed` (not listed in the public directory: its Listed switch off, held
 *        back, or its closing day come; members read why their community can't be shown); 503 `standby` (a standby's key is
 *        not the one the directory names until it takes over); 503 `no_key` (no node key yet).
 *        Open to a web app on another origin (https-server.ts SIGNED_KNOCK_CORS): the worldwide community's web app asks the
 *        member's own community directly, signed by the member's key. No cookie, no credential; the answer is for the signer.
 *        No other server is asked anything, ours included: a community on its own domain gives its members the same note.
 * On a public forum (`forumPublic`, the worldwide community's; anywhere else 404 `not_here`), a member who reads as one:
 *   GET  /api/forum/label → { show, community, lapsesAt, label, why }   (engine/membership-note.ts ForumLabelState)
 *   POST /api/forum/label { show: 'none' | 'community' | 'waiting', note? } → the same   an active member, on the main server
 *        (a standby 503 `standby`). 'community' takes a note that passes: 400 `note_malformed`, `note_expired`, `note_bad_time`
 *        (dated ahead of this server's clock, or promising more than 30 days) or `note_bad_signature`; 403 `note_other_key`; 409 `not_listed`. A refused note changes nothing kept.
 */
import Router from '@koa/router';
import { MEMBERSHIP_NOTE_MAX_MS, signMembershipNote, toMembershipNoteName, word } from '@beanpool/core';
import { isNodeMember, readsAsMember, assertMemberActive, getNodeRole } from '../state-engine.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { getLocalConfig } from '../config/local-config.js';
import { directoryHeldBack } from '../services/directory-publisher.js';
import { closingDayReached } from '../engine/directory-promise.js';
import { ownNodeSigner } from '../engine/node-key.js';
import { MembershipNoteRefusal, MEMBERSHIP_NOTE_WORDS, communityKeyOfNodeKey, forumLabelState, setForumLabel } from '../engine/membership-note.js';
import { respondProfileRefusal } from './profile-feature-gate.js';
import { memberErrorText } from './member-error-text.js';

const NOTE_WORDS = {
    notMember: word('Only a member of this community can ask it for a note saying so.'),
    paused: word('Your account here is paused for now, so this community can’t give you a note.'),
};
const FORUM_WORDS = {
    notMember: word('Only a member of this community can read its forum.'),
    paused: word('Your account here is paused for now, so you can’t read or write in the forum.'),
};
const STANDBY = word('This server is a standby copy of the community, so it can’t take this. Please try again at the community’s own address.');
const NO_KEY = word('This community’s server has no key of its own yet, so it can’t sign a note. Please try again later.');

function answer(ctx: any, status: number, error: string, code: string): void {
    ctx.status = status;
    ctx.body = { error, code };
}

/** The signer, a member who reads as one, or null once the refusal is written (in `words`). */
function reader(ctx: any, words: typeof NOTE_WORDS): string | null {
    const key = ctx.state?.actor as string | undefined;
    if (!key) { answer(ctx, 401, word('A signed request is required.'), 'unsigned'); return null; }
    if (!isNodeMember(key)) { answer(ctx, 403, words.notMember, 'not_member'); return null; }
    if (!readsAsMember(key)) { answer(ctx, 403, words.paused, 'not_active'); return null; }
    return key;
}

function refused(ctx: any, e: unknown): void {
    if (e instanceof MembershipNoteRefusal) return answer(ctx, e.status, e.message, e.code);
    if (respondProfileRefusal(ctx, e)) return;
    ctx.status = 400;
    ctx.body = { error: memberErrorText(e, word('Couldn’t save what you show beside your name.')) };
}

/** Whether this community is listed in the public directory now, as its own publisher decides (services/directory-publisher.ts). */
function listedHere(now: number): boolean {
    return getProfileSwitches().publishToDirectory && directoryHeldBack() === null && closingDayReached(now) === null;
}

export function createMembershipNoteRoutes(): Router {
    const router = new Router();

    router.get('/api/membership/note', (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = reader(ctx, NOTE_WORDS);
        if (!member) return;
        if (getNodeRole() !== 'primary') return answer(ctx, 503, STANDBY, 'standby');
        const now = Date.now();
        const name = toMembershipNoteName(getLocalConfig().communityName);
        if (!listedHere(now) || !name) return answer(ctx, 409, MEMBERSHIP_NOTE_WORDS.notListed, 'not_listed');
        const signer = ownNodeSigner();
        if (!signer) return answer(ctx, 503, NO_KEY, 'no_key');
        ctx.body = {
            note: signMembershipNote({ community: communityKeyOfNodeKey(signer.keyHex), name, member, issuedAt: now, expiresAt: now + MEMBERSHIP_NOTE_MAX_MS }, signer.sign),
        };
    });

    router.get('/api/forum/label', (ctx) => {
        ctx.set('Cache-Control', 'no-store');
        const member = reader(ctx, FORUM_WORDS);
        if (!member) return;
        try {
            ctx.body = forumLabelState(member);
        } catch (e) {
            refused(ctx, e);
        }
    });

    router.post('/api/forum/label', (ctx) => {
        const member = reader(ctx, FORUM_WORDS);
        if (!member) return;
        try {
            assertMemberActive(member);
        } catch {
            return answer(ctx, 403, FORUM_WORDS.paused, 'not_active');
        }
        if (getNodeRole() !== 'primary') return answer(ctx, 503, STANDBY, 'standby');
        const raw = (ctx.request as { body?: unknown }).body;
        const body = raw && typeof raw === 'object' ? raw as { show?: unknown; note?: unknown } : {};
        try {
            ctx.body = setForumLabel(member, body);
        } catch (e) {
            refused(ctx, e);
        }
    });

    return router;
}
