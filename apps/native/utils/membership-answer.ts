/**
 * What a community's answer to the membership probe (`GET /api/community/membership/<key>`, utils/membership-probe.ts)
 * says about the key, read one way for every place that asks: the phone's own community (NodeStatusContext), the
 * Reconnect on the not-recognised screen (utils/reconnect.ts) and the global community's standing (utils/global-entry.ts).
 *
 * Only a definite answer counts (DESIGN-global-entry-fable.md §B.2, §C.3):
 * - 200 `isMember: true` is a member; 200 `isMember: false` a stranger (`recovering` when the node reports a recovery
 *   under way for the key, an UNSIGNED claim that only ever prompts, never moves the member: _layout.tsx NAT-20).
 * - 403 `account_closed` (the signature gate's answer for a key whose account there was closed, removed or deleted by its
 *   owner) is a definite answer too: closed.
 * - 403 `members_only` or `private_preview`: the node keeps its reads for members, and this key isn't one. A stranger.
 * - Anything else (401 unsigned, 403 `not_your_key`, a 5xx, a body that isn't the probe's) is no answer: null, and each
 *   caller keeps what it had. Never "stranger" for a flaky connection.
 */

export type MembershipAnswer =
    | { kind: 'member' }
    | { kind: 'stranger'; recovering: boolean }
    | { kind: 'closed' };

/** The refusal codes that mean "not a member here" (a definite answer about the key, not about the connection). */
const STRANGER_CODES: ReadonlySet<string> = new Set(['members_only', 'private_preview']);

/** Read a probe's status and parsed body. Pure; null for no answer. */
export function readMembershipAnswer(status: number, body: unknown): MembershipAnswer | null {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (status === 200) {
        if (!b || typeof b.isMember !== 'boolean') return null;
        if (b.isMember) return { kind: 'member' };
        return { kind: 'stranger', recovering: b.isRecovering === true };
    }
    if (status === 403 && b && typeof b.code === 'string') {
        if (b.code === 'account_closed') return { kind: 'closed' };
        if (STRANGER_CODES.has(b.code)) return { kind: 'stranger', recovering: false };
    }
    return null;
}

/** `readMembershipAnswer` for a fetch Response: its body read once, as JSON; a body that isn't JSON is no answer. */
export async function membershipAnswerOf(res: Response): Promise<MembershipAnswer | null> {
    const body = await res.json().catch(() => null);
    return readMembershipAnswer(res.status, body);
}
