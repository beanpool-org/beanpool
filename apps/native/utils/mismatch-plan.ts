/**
 * Which page the "This community doesn't recognise you" screen draws (DESIGN-global-entry-fable.md §C.1, §C.3), from what
 * the community it reached says it is (its profile: `GET /api/community/info`, node-profile.ts) and what it answered
 * about this key. The screen asks the NODE and never guesses from a flag on the phone (§C.2): whether a stranger can do
 * anything here but leave is a property of the community.
 *
 * - `open`: a community whose door is open (the global profile, `openJoin`, not in a private preview). Being a stranger is
 *   the normal state before joining, so the first action is Join with this account.
 * - `invite`: a community that joins people by invite (a local profile, or one that says nothing about itself, or can't be
 *   asked): today's page, worded for "wrong address, or not joined yet", with the invite field.
 * - `preview`: a community in a private preview: its own sentence, and the invite field for an owner's or admin's invite.
 * - `closed`: the community closed this key's account there (403 `account_closed`), whatever kind it is.
 */

import type { NodeProfile } from './node-profile';
import { extractNodeOrigin, normaliseInviteCode } from './invite-parser';

export type MismatchPage = 'open' | 'invite' | 'preview' | 'closed';

export interface MismatchInput {
    /** What the community answered about this key: a stranger, or an account it closed. */
    recognition: 'stranger' | 'closed';
    /**
     * The community's profile: the fresh answer when `reachable`, else this phone's copy from before (or null, never
     * heard). A copy is still drawn from, so the page doesn't change because one ask failed; the door screen asks again
     * itself before anything is sent.
     */
    profile: NodeProfile | null;
    /** The community answered the profile ask just now. */
    reachable: boolean;
    /**
     * The phone's door screen can take this community (join-global.tsx): only the global community's address until slice
     * P5 generalises it to any open-door node. Another open-door community gets the invite page meanwhile, which is true
     * of it too ("not joined yet") and never sends anyone to a different community's door.
     */
    doorScreenTakes: boolean;
}

export interface MismatchPlan {
    page: MismatchPage;
    /** The page is drawn from a copy the community didn't confirm just now (it couldn't be asked). */
    fromCopy: boolean;
}

/** The page, decided. Pure. */
export function mismatchPlan(input: MismatchInput): MismatchPlan {
    const fromCopy = !input.reachable && !!input.profile;
    if (input.recognition === 'closed') return { page: 'closed', fromCopy };
    const p = input.profile;
    if (!p) return { page: 'invite', fromCopy: false };
    if (p.features.privatePreview === true) return { page: 'preview', fromCopy };
    if (p.profile === 'global' && p.features.openJoin === true && input.doorScreenTakes) return { page: 'open', fromCopy };
    return { page: 'invite', fromCopy };
}

/**
 * The invite field on the invite and preview pages (§C.1: "Paste an invite", "Got an invite from its owner or an admin?"):
 * what was typed or pasted, read as People's "Join another community" reads it (invite-parser.ts). An invite link names its
 * community; a bare code is for the community the page is about. Null when there is nothing to use. Throws node-url.ts
 * UnsafeNodeAddressError for a link whose address isn't plain host[:port]: refused, never quietly sent elsewhere.
 */
export function inviteFromText(raw: string, pageUrl: string | null): { targetUrl: string; code: string } | null {
    const text = raw.trim();
    if (!text) return null;
    const origin = extractNodeOrigin(text);
    const code = normaliseInviteCode(text);
    const targetUrl = origin ?? pageUrl;
    if (!code || !targetUrl) return null;
    return { targetUrl, code };
}
