/**
 * Whether this node's polls are labelled informal: on the global community (`profile: 'global'` in
 * `/api/community/info`, config/node-profile.ts on the server). Anyone may join it with a sign-in, so one person with
 * several accounts can tip a poll's count (FABLE-sec-global-abuse LOW-7), and nothing there is decided by a vote:
 * Decisions are off. Polls decide nothing anywhere; there each one says so. A node that doesn't say its profile is a
 * local community, as every node before the profile was.
 */

import type { CommunityInfo } from './api';

/** What a poll card says on the global community, above how its ballot works. */
export const INFORMAL_POLL_NOTE = 'An informal poll; it decides nothing';

export function pollsInformal(info: CommunityInfo | null | undefined): boolean {
    return info?.profile === 'global';
}
