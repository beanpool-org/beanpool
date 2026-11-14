/**
 * Invite from a contact, the phone's requests (scratch/fable-design/DESIGN-private-contacts-fable.md §3.8, §3.9, slice C5; the
 * words and rules are core's contacts-invite.ts). Three, all to the community the phone is on, signed by the member, and none
 * of them names a contact: the invite is made by utils/invite-and-share.ts makeInviteForShare (its body is the maker's key
 * and nothing else: no note), the member's own invites are read to ask "Is this Dee?" ({@link readMyInvites}), and an unused
 * one is cancelled with Remove from contacts ({@link cancelContactInvite}). utils/__tests__/contacts-invite-render.test.ts
 * holds every request the flow sends to that: no name, number or email of any contact in a URL, a header or a body.
 */
import { inviteRevokeWords, type MyInviteSeen } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';

/**
 * The member's own invites at `anchor` (GET /api/invite/mine/:publicKey: theirs alone, the phone's fetch signs a GET), or null
 * when the community didn't answer: nothing is asked then, and nothing is assumed.
 */
export async function readMyInvites(anchor: string, identity: Pick<BeanPoolIdentity, 'publicKey'>, fetchImpl: typeof fetch = fetch): Promise<MyInviteSeen[] | null> {
    try {
        const res = await fetchImpl(`${anchor}/api/invite/mine/${identity.publicKey}`);
        if (!res.ok) return null;
        const body = await res.json() as { invites?: unknown };
        return Array.isArray(body?.invites) ? body.invites.filter((i): i is MyInviteSeen => !!i && typeof (i as MyInviteSeen).code === 'string') : null;
    } catch {
        return null;
    }
}

/**
 * "Also cancel the invite I sent": the maker's revoke (DELETE /api/invite/:code, signed). A code the community no longer holds
 * unused (`no_invite`: lapsed or gone; `invite_used`: someone joined) has nothing left to cancel, which is no failure.
 */
export async function cancelContactInvite(
    anchor: string, identity: BeanPoolIdentity, code: string,
    deps: { fetchImpl?: typeof fetch; signedHeaders?: typeof import('./crypto').buildSignedHeaders } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
    const failed = inviteRevokeWords.failed();
    try {
        const url = `${anchor}/api/invite/${encodeURIComponent(code)}`;
        const sign = deps.signedHeaders ?? (await import('./crypto')).buildSignedHeaders;
        const headers = await sign('DELETE', url, '', identity.privateKey, identity.publicKey);
        const res = await (deps.fetchImpl ?? fetch)(url, { method: 'DELETE', headers });
        if (res.ok) return { ok: true };
        const body = await res.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
        if (body?.code === 'no_invite' || body?.code === 'invite_used') return { ok: true };
        return { ok: false, message: typeof body?.error === 'string' && body.error ? body.error : failed };
    } catch {
        return { ok: false, message: failed };
    }
}
