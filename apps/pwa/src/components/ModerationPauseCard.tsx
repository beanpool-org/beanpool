/**
 * "Posting paused": a member the moderators have paused (G3's auto-mute, GET /api/community/me `mute`) sees plainly, in
 * the app shell and in Settings, that they can't post or send messages here, and until when. The web app has no push,
 * so this is how a paused web member learns it before they meet a refusal, whenever the notice itself was shown.
 *
 * Renders nothing when they are not paused, when the node is older than the route, for a guest, or offline.
 */
import { useEffect, useState } from 'react';
import { getCommunityMe, type CommunityStanding } from '../lib/api';
import { inAbout } from './NewAccountCard';

type Mute = CommunityStanding['mute'];

/** A pause with no end the node names: until a moderator lifts it (the node writes the year 9999 for that). */
export function isUntilLifted(until: string | null | undefined): boolean {
    const ms = until ? Date.parse(until) : NaN;
    return !Number.isFinite(ms) || new Date(ms).getUTCFullYear() >= 9999;
}

/** "until a moderator lifts this", or "until 3 Oct 2026, 2:00 pm (in about 7 days)". */
export function pausedUntil(until: string | null | undefined, now: number = Date.now()): string {
    if (isUntilLifted(until)) return 'until a moderator lifts this';
    const when = new Date(Date.parse(until!)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return `until ${when} (${inAbout(until!, now)})`;
}

export interface ModerationPauseCardProps {
    /** Read again when this changes: after a pause or a lift is shown. */
    refreshKey?: unknown;
}

export function ModerationPauseCard({ refreshKey }: ModerationPauseCardProps) {
    const [mute, setMute] = useState<Mute | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Inside the promise chain, so nothing this read throws (an older node, a guest, offline) reaches the page.
        Promise.resolve()
            .then(() => getCommunityMe())
            .then(me => { if (!cancelled) setMute(me?.mute?.muted === true ? me.mute : null); })
            .catch(() => { if (!cancelled) setMute(null); });
        return () => { cancelled = true; };
    }, [refreshKey]);

    if (!mute) return null;

    return (
        <section
            data-testid="moderation-pause-card"
            role="status"
            aria-labelledby="moderation-pause-card-title"
            className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl shadow-sm border border-amber-300 dark:border-amber-800 p-4 mb-3 min-w-0"
        >
            <h2 id="moderation-pause-card-title" className="font-bold text-base text-amber-900 dark:text-amber-100 m-0 min-w-0 break-words">
                <span aria-hidden="true">🛡️ </span>Posting paused
            </h2>
            <p data-testid="moderation-pause-until" className="text-sm text-amber-900 dark:text-amber-200 mt-1 mb-2 leading-relaxed break-words">
                The community’s moderators have paused your posting. You can’t post or send messages here {pausedUntil(mute.until)}.
            </p>
            <p className="text-sm text-amber-800 dark:text-amber-300 m-0 leading-relaxed break-words">
                You can still read, edit your profile and leave.
            </p>
        </section>
    );
}
