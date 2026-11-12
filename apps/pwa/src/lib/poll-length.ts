/**
 * How long a poll may run (@beanpool/core poll-length; the node's half is apps/server engine/posts.ts createPost). 3, 7 and 14 days
 * are every member's; 30 and 90 are an owner's and an admin's. The poll form asks the node for the signed-in member's role each time
 * the Poll choice is open (GET /api/node-admin/me, once a page load), and offers the long lengths only to those two. A role the node
 * has not said offers the short ones, so a form is never held back while it asks (the node checks at Create). The phone does the
 * same in NewPollModal.
 */
import { useEffect, useState } from 'react';
import { mayChooseLongPolls, pollDayChoices, type PollDays } from '@beanpool/core';
import { myNodeRoleOnce } from './api';

/** The lengths the poll form offers, while `enabled`: 3, 7 and 14, and 30 and 90 for an owner or an admin. */
export function usePollDayChoices(enabled: boolean): readonly PollDays[] {
    const [longRuns, setLongRuns] = useState(false);
    useEffect(() => {
        if (!enabled) { setLongRuns(false); return; }
        let cancelled = false;
        myNodeRoleOnce().then((role) => { if (!cancelled) setLongRuns(mayChooseLongPolls(role)); }, () => {});
        return () => { cancelled = true; };
    }, [enabled]);
    return pollDayChoices(longRuns);
}
