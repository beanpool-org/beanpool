/**
 * Invite and share, the phone's half (packages/beanpool-core invite-and-share.ts; components/InviteAndShare.tsx): the button
 * on a listing or an event that makes an ordinary invite and hands the share sheet the listing's title and
 * `{community}/?invite={code}&post={id}`.
 *
 * Where it is offered: where this member may invite (the node's door, `features.door`, and the node makes the code), and
 * only then. Where they can't, there is no button: asking an admin is another slice. Never to a guest of the community, who
 * has no invites to give, nor where the node takes none.
 *
 * What it makes: the node's own invite (POST /api/invite/generate), with the Vouch for them choice of the People tab for
 * someone who can vouch (None unless they choose). Never an offline ticket: a ticket can't take a friend to a listing, and
 * can't carry a vouch. With no answer from the node, nothing is made and the member is told so.
 */
import { INVITE_SHARE_WORDS, inviteAndShareLink, inviteVouchRefusalWords, t, type VouchLevel } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { adminsOnlyRefusal, invitesOffRefusal, mayInviteHere, pausedRefusal, type InviteRole } from './invite-entries';
import { invitesOn, type NodeFeatures } from './node-profile';

export { inviteAndShareLink };

/**
 * Whether the button is drawn: the community takes invites, this member may make them (an admin-only door asks their role,
 * not heard yet counting as before: the node refuses a member's invite itself), they are no guest, and the post is one
 * with an id. A listing that is the member's to open is always one; an event too.
 */
export function offersInviteAndShare(args: {
    features: NodeFeatures | null | undefined; role: InviteRole | undefined; guest: boolean; postId: unknown;
}): boolean {
    if (args.guest || typeof args.postId !== 'string' || !args.postId) return false;
    return invitesOn(args.features) && mayInviteHere(args.features, args.role);
}

export type InviteForShare = { ok: true; code: string } | { ok: false; offline: boolean; message: string };

export interface MakeInviteDeps {
    fetchImpl?: typeof fetch;
    /** The request builder the phone's other invites use (utils/crypto buildSignedHeaders); a test hands in a stand-in. */
    signedHeaders?: typeof import('./crypto').buildSignedHeaders;
}

/**
 * How long the phone waits for the community to make the invite: the Share sheet holds while it is made
 * (components/ShareSheet.tsx), so a community that never answers must not hold it for good. As long as a link to share
 * outside waits (utils/peek.ts TIMEOUT_MS, not imported: that module reads the whole of utils/db).
 */
export const INVITE_FOR_SHARE_WAIT_MS = 15_000;

/**
 * Ask the node for an invite. `offline`: it gave no answer at all, or none within {@link INVITE_FOR_SHARE_WAIT_MS} (the
 * request is given up, its signal aborted: React Native's fetch has no time limit of its own, and an answer that still
 * comes after it is not used), and no ticket is made. Any refusal says the node's words (in the member's language where the
 * phone knows them), and nothing is shared.
 */
export async function makeInviteForShare(
    anchorUrl: string, identity: BeanPoolIdentity, vouchLevel: VouchLevel | null, features: NodeFeatures | null | undefined,
    deps: MakeInviteDeps = {},
): Promise<InviteForShare> {
    const offline: InviteForShare = { ok: false, offline: true, message: t(INVITE_SHARE_WORDS.offline) };
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<InviteForShare>((resolve) => {
        timer = setTimeout(() => { stop.abort(); resolve(offline); }, INVITE_FOR_SHARE_WAIT_MS);
    });
    try {
        return await Promise.race([askForInvite(anchorUrl, identity, vouchLevel, features, deps, stop.signal, offline), limit]);
    } finally {
        clearTimeout(timer);
    }
}

async function askForInvite(
    anchorUrl: string, identity: BeanPoolIdentity, vouchLevel: VouchLevel | null, features: NodeFeatures | null | undefined,
    deps: MakeInviteDeps, signal: AbortSignal, offline: InviteForShare,
): Promise<InviteForShare> {
    const doFetch = deps.fetchImpl ?? fetch;
    const notMade: InviteForShare = { ok: false, offline: false, message: t(INVITE_SHARE_WORDS.notMade) };
    const url = `${anchorUrl}/api/invite/generate`;
    const body = JSON.stringify({ publicKey: identity.publicKey, vouchLevel: vouchLevel ?? undefined });
    let res: Response;
    try {
        // Loaded when a tap needs it: the key's crypto is not read by a screen that only draws the button.
        const buildHeaders = deps.signedHeaders ?? (await import('./crypto')).buildSignedHeaders;
        const headers = await buildHeaders('POST', url, body, identity.privateKey, identity.publicKey);
        res = await doFetch(url, { method: 'POST', headers, body, signal });
    } catch {
        // No answer at all: no offline ticket, which can't take a friend to this listing.
        return offline;
    }
    if (res.ok) {
        const data = await res.json().catch(() => null) as { success?: unknown; invite?: { code?: unknown } } | null;
        const code = data?.success && typeof data.invite?.code === 'string' ? data.invite.code : '';
        return code ? { ok: true, code } : notMade;
    }
    const said = await res.json().catch(() => null) as { error?: unknown } | null;
    const refusal = invitesOffRefusal(res.status, said, features) ?? adminsOnlyRefusal(res.status, said) ?? pausedRefusal(res.status, said);
    if (refusal) return { ok: false, offline: false, message: refusal };
    // The node refused the vouch: its words, and no invite that would quietly carry none.
    if (vouchLevel !== null && typeof said?.error === 'string') return { ok: false, offline: false, message: inviteVouchRefusalWords(said.error) };
    return notMade;
}
