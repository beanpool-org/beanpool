/**
 * Invite and share, the web's half (packages/beanpool-core invite-and-share.ts; components/InviteAndShare.tsx): the button on a
 * listing or an event that makes an ordinary invite and hands the share sheet the listing's title and
 * `{community}/?invite={code}&post={id}`. The phone's twin is apps/native/utils/invite-and-share.ts.
 *
 * Offered only where this member may invite: the community takes invites and its door lets them (an admin-only door asks their
 * role, not heard yet counting as before: the node refuses a member's invite itself). Where they can't, there is no button.
 * Never an offline ticket: it can't take a friend to a listing. With no answer from the node nothing is made and the member is
 * told so.
 */
import { INVITE_SHARE_WORDS, inviteAndShareLink, postIdFromInviteLink, t } from '@beanpool/core';
import { generateInvite, type CommunityInfo } from './api';
import { takePostParam } from './event-extras';
import { keepLinkedPost } from './visitor-lobby';
import { adminsOnlyRefusal, invitesOffRefusal, mayInviteHere, pausedRefusal, type InviteRole } from './node-invites';

export { inviteAndShareLink };

export function offersInviteAndShare(args: { info: CommunityInfo | null | undefined; role: InviteRole | undefined; hasKey: boolean; postId: unknown }): boolean {
    if (!args.hasKey || typeof args.postId !== 'string' || !args.postId) return false;
    return mayInviteHere(args.info, args.role);
}

export type InviteForShare = { ok: true; code: string } | { ok: false; offline: boolean; message: string };

/**
 * Ask the node for an invite. `offline`: it gave no answer at all, and no ticket is made. A refusal says the node's words (in
 * the member's language where the page knows them), and nothing is shared.
 */
export async function makeInviteForShare(
    publicKey: string,
    make: typeof generateInvite = generateInvite,
    vouchAmount?: number,
): Promise<InviteForShare> {
    try {
        const res = await make(publicKey, undefined, vouchAmount);
        const code = res?.invite?.code;
        return typeof code === 'string' && code ? { ok: true, code } : { ok: false, offline: false, message: t(INVITE_SHARE_WORDS.notMade) };
    } catch (e) {
        const status = (e as { status?: unknown } | null)?.status;
        // No status: the request never got an answer. Nothing is made, least of all a ticket.
        if (typeof status !== 'number') return { ok: false, offline: true, message: t(INVITE_SHARE_WORDS.offline) };
        const refusal = invitesOffRefusal(e) ?? adminsOnlyRefusal(e) ?? pausedRefusal(e);
        if (refusal) return { ok: false, offline: false, message: refusal };
        const serverMsg = typeof (e as any)?.message === 'string' && (e as any).message ? (e as any).message : typeof (e as any)?.error === 'string' && (e as any).error ? (e as any).error : null;
        if (serverMsg) return { ok: false, offline: false, message: serverMsg };
        return { ok: false, offline: false, message: t(INVITE_SHARE_WORDS.notMade) };
    }
}

/**
 * `?post=<id>` on the address the web app loaded at, taken out of it, as App holds it for after the identity: a shared listing
 * opens at once for a member. With an invite beside it (the trampoline's Continue in browser, `/app?invite=…&webjoin=1&post=…`;
 * invite-and-share) the friend is no member yet, so nothing is held in App: the listing, as an id and nothing else, is kept in
 * this tab like one the lobby opened (lib/visitor-lobby.ts), and opens when they have joined. One that isn't an id opens nothing,
 * with no error. Read before the address is cleaned of `post`.
 */
export function linkedPostAtLoad(win: Pick<Window, 'location' | 'history'> = window): string | null {
    const invited = /(?:^|[?&])invite=[^&\s]/.test(win.location.search || '');
    const sentFrom = postIdFromInviteLink(win.location.search || '');
    const carried = takePostParam(win);
    if (!invited) return carried;
    if (sentFrom) keepLinkedPost(sentFrom);
    return null;
}
