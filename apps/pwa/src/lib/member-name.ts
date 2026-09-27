/**
 * The web app's name for its member is the community's (#1231's confirmation, NON-BLOCKING 4113964261 and 4113964223).
 *
 * The node decides the name a key goes by. A join may land on another than the one typed: `/api/invite/redeem`,
 * `/api/invite/redeem-offline` and `/api/community/register` keep 20 characters, and a name another member holds is
 * numbered ("Sam" becomes "Sam2", engine/members.ts uniquifyCallsign). A rename can land on the node while this browser
 * fails to keep it. Wherever the app hears the node's name for this key it takes it, so every screen says what everyone
 * else sees, and nothing sent later carries this browser's old copy back (`/api/community/register` renames an existing
 * member to whatever it is sent: registerMemberInternal). Only the callsign follows the node: the key, the 12 words and
 * the rest of the stored identity never change here.
 */
import { checkMembership, registerMember } from './api';
import { updateCallsign, type BeanPoolIdentity } from './identity';

/**
 * The name a node's member card gives `identity`'s key (a redeem's, a register's or a profile update's answer), or null
 * when the card is about another key, or names no one.
 */
export function nodeNameFor(identity: BeanPoolIdentity, card: unknown): string | null {
    if (!card || typeof card !== 'object') return null;
    const { publicKey, callsign } = card as { publicKey?: unknown; callsign?: unknown };
    return publicKey === identity.publicKey && typeof callsign === 'string' && callsign.trim() ? callsign : null;
}

/**
 * Keep `nodeName` as this browser's name for `identity`, when it is one and differs. Written only while the stored
 * identity is that same key (another tab may have changed it since). The updated identity, or null when nothing was
 * written. Throws when the write fails.
 */
export async function adoptNodeName(identity: BeanPoolIdentity, nodeName: string | null | undefined): Promise<BeanPoolIdentity | null> {
    if (typeof nodeName !== 'string' || !nodeName.trim() || nodeName === identity.callsign) return null;
    return updateCallsign(nodeName, identity.publicKey);
}

/**
 * What the app does with its identity as it opens (App.tsx). A member: the node's name is theirs, and this browser takes
 * it. No register goes, because for a member it can only rename them to this browser's copy. A key the node does not
 * have as a member: the no-invite register, as before, and the name its answer gives this key. Throws, having sent
 * nothing further, when the node can't be asked.
 *
 * `identity`: the updated identity when this browser's name changed, else null.
 */
export async function openWithNodeName(identity: BeanPoolIdentity): Promise<{ isMember: boolean; identity: BeanPoolIdentity | null }> {
    const membership = await checkMembership(identity.publicKey);
    if (membership.isMember) {
        return { isMember: true, identity: await keepQuietly(identity, membership.callsign) };
    }
    const answer = await registerMember(identity.publicKey, identity.callsign).catch(() => null);
    return { isMember: false, identity: await keepQuietly(identity, nodeNameFor(identity, answer?.member)) };
}

/** adoptNodeName on opening: a failed write leaves this browser's name for the next open, which asks again. */
async function keepQuietly(identity: BeanPoolIdentity, nodeName: string | null | undefined): Promise<BeanPoolIdentity | null> {
    try {
        return await adoptNodeName(identity, nodeName);
    } catch (e) {
        console.warn("[Identity] the community's name for this member not saved in this browser:", e);
        return null;
    }
}
