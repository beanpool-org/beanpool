/**
 * Inviting people to a group from the web (groups decision 8, the phone's components/InvitePeopleSheet.tsx).
 *
 * Who may invite is the server's rule, mirrored here so the web never offers what the node will refuse
 * (packages/beanpool-engine/src/groups.ts inviteGroupMember + apps/server/src/routes/groups.ts POST /members):
 * an ACTIVE convenor of the group, whatever its join policy, in a group its members have not closed
 * (assertGroupNotClosed), and not under a moderation mute (assertNotMuted). Any other member is refused 403.
 *
 * An invitation is only a membership row ('invited'): no key is wrapped by the inviter. The person invited does the
 * group-keys work when they accept (state-engine.ts joinGroup, epoch reason 'invite'), on the phone or the web alike.
 */
import type { Group, GroupMember } from './api';

export function canInviteToGroup(opts: {
    group: Pick<Group, 'viewerRole' | 'viewerStatus' | 'closedAt'>;
    members: readonly Pick<GroupMember, 'memberPubkey' | 'role' | 'status'>[];
    myPubkey?: string | null;
    /** The signer's moderation mute (GET /api/community/me): null while it is not known, which offers nothing. */
    muted: boolean | null;
}): boolean {
    const { group, members, myPubkey, muted } = opts;
    if (group.closedAt) return false;
    if (muted !== false) return false;
    // The roster's own row, never the card alone: without the roster the sheet can't tell who is already in or asking,
    // and an invitation to someone who asked admits them at once (review of #1979, N1).
    const mine = myPubkey ? members.find(m => m.memberPubkey === myPubkey) : undefined;
    return !!mine && mine.role === 'convenor' && mine.status === 'active';
}

/** Already in the group, or already asked: active, invited or waiting for approval. A removed member may be invited again. */
export function alreadyInGroup(members: readonly Pick<GroupMember, 'memberPubkey' | 'status'>[]): Set<string> {
    return new Set(members.filter(m => m.status === 'active' || m.status === 'invited' || m.status === 'pending_approval').map(m => m.memberPubkey));
}

export interface InvitablePerson { publicKey: string; callsign: string; avatarUrl?: string | null }

const notPeople = (pk: string) => pk === 'SYSTEM' || pk.startsWith('escrow_');

/** The people the sheet lists: never the signer, never a system account, matching the typed name; sorted by name. */
export function invitableShown(people: readonly InvitablePerson[], query: string, myPubkey?: string | null): InvitablePerson[] {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const out: InvitablePerson[] = [];
    for (const p of people) {
        if (!p?.publicKey || p.publicKey === myPubkey || notPeople(p.publicKey) || seen.has(p.publicKey)) continue;
        if (q && !(p.callsign || '').toLowerCase().includes(q)) continue;
        seen.add(p.publicKey);
        out.push(p);
    }
    return out.sort((a, b) => (a.callsign || '').localeCompare(b.callsign || '', undefined, { sensitivity: 'base' }));
}

/**
 * The node's words when it refused who is asking (403), `UNAUTHORIZED: ` taken off: a refusal that won't pass in a moment
 * (a suspended convenor, whom the web can't see), said as the node says it (review of #1979, N2). Null for anything else,
 * and for a 403 with no words of the node's own (a proxy's page: lib/api.ts refusalError `unsaid`).
 */
export function refusalWords(e: unknown): string | null {
    const err = e as { status?: number; message?: unknown; unsaid?: boolean } | null;
    if (!err || err.status !== 403 || err.unsaid || typeof err.message !== 'string') return null;
    const words = err.message.replace(/^UNAUTHORIZED:\s*/, '').trim();
    return words || null;
}

/** One call per person, four at a time (the phone's batching); what failed is named back, never hidden. */
export async function sendInvitations(keys: readonly string[], invite: (pk: string) => Promise<unknown>): Promise<{ sent: string[]; failed: string[]; refusal: string | null }> {
    const sent: string[] = [];
    const failed: string[] = [];
    let refusal: string | null = null;
    for (let i = 0; i < keys.length; i += 4) {
        const batch = keys.slice(i, i + 4);
        const results = await Promise.allSettled(batch.map(pk => invite(pk)));
        batch.forEach((pk, j) => {
            const r = results[j];
            if (r.status === 'fulfilled') { sent.push(pk); return; }
            failed.push(pk);
            refusal ??= refusalWords(r.reason);
        });
    }
    return { sent, failed, refusal };
}
