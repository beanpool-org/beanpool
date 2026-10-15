/**
 * Sending a group's invitations (components/InvitePeopleSheet.tsx, groups decision 8): one call per person, four at a
 * time, and what failed named back. A refusal (403: a suspended convenor, whom the phone can't see, or a role lost since
 * the sheet opened) won't pass when the signal comes back, so it is said in the node's own words (review of #1979, N2;
 * the web's lib/group-invite.ts says it the same way).
 */

/** The node's words for a 403, `UNAUTHORIZED: ` taken off; null for anything else, or a 403 with no words of its own. */
export function inviteRefusalWords(e: unknown): string | null {
    const err = e as { status?: number; message?: unknown; unsaid?: boolean } | null;
    if (!err || err.status !== 403 || err.unsaid || typeof err.message !== 'string') return null;
    const words = err.message.replace(/^UNAUTHORIZED:\s*/, '').trim();
    return words || null;
}

export async function sendGroupInvitations(keys: readonly string[], invite: (pk: string) => Promise<unknown>): Promise<{ sent: string[]; failed: string[]; refusal: string | null }> {
    const sent: string[] = [];
    const failed: string[] = [];
    let refusal: string | null = null;
    // Four at a time, not one round trip after another: ten invitations on a slow link took ten waits.
    for (let i = 0; i < keys.length; i += 4) {
        const batch = keys.slice(i, i + 4);
        const results = await Promise.allSettled(batch.map(pk => invite(pk)));
        batch.forEach((pk, j) => {
            const r = results[j];
            if (r.status === 'fulfilled') { sent.push(pk); return; }
            failed.push(pk);
            refusal ??= inviteRefusalWords(r.reason);
        });
    }
    return { sent, failed, refusal };
}
