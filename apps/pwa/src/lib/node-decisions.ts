/**
 * Whether members propose and vote on formal Decisions on this node (`features.decisions` in `/api/community/info`,
 * config/node-profile.ts on the server). Off on the global node (Marty, 2026-09-27): anyone may join it with one
 * sign-in, so one person with several accounts could swing a vote, and the server refuses every proposal and vote
 * there. Only a node that says outright it has none has none: every node before the switch allowed them.
 */

import type { CommunityInfo } from './api';

export function decisionsOn(info: CommunityInfo | null | undefined): boolean {
    return (info?.features as { decisions?: boolean } | undefined)?.decisions !== false;
}
