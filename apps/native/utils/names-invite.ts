/**
 * An invite bound to a names-list entry (community modes slice 3, design §4.1 ways 1–3). An admin taps "Invite this
 * person" on an entry: the node makes an invite bound to the entry's id (never the name), and redeeming it confirms
 * the joiner against the entry, by this admin. With no signal (a hall), the phone makes an offline ticket instead, the
 * entry's id signed inside it.
 *
 * Shared with the web app (DESIGN-names-list-web-fable.md S1): @beanpool/core names-list-invite.ts, moved from here
 * unchanged.
 */
export { BIND_OUTCOME_WORDS, boundInviteLine, invitesForEntry, inviteThisPerson, inviteLink } from '@beanpool/core';
export type { InviteBindOutcome, BoundInvite } from '@beanpool/core';
