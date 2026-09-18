/**
 * The Market feed's section headings in list view. No React Native imports, so vitest can hold it.
 *
 * Listings are headed by when they were POSTED — Today / Yesterday / This Week / Older Listings — in local
 * calendar days. Events are not: a Saturday event posted this morning used to sit under TODAY, which read as
 * "happening today" (events round 2, B6). An event's card already leads with its own date in the largest
 * text, so events go together under one heading of their own, soonest first, ahead of the listings.
 *
 * The buckets were also rolling 24-hour blocks rather than days, which mislabelled every post type: at 9 am
 * a listing from 11 pm last night was under TODAY. They are local calendar days now.
 */

export const UPCOMING_EVENTS_HEADING = 'Upcoming events';

export interface FeedSection<T> {
    id: string;
    title: string;
    posts: T[];
}

function startOfLocalDay(ms: number): number {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** Whole local calendar days between two instants: 0 for earlier today, 1 for any time yesterday. */
export function localDaysAgo(thenMs: number, nowMs: number): number {
    // Rounded, because a day with a daylight-saving change is 23 or 25 hours long.
    return Math.round((startOfLocalDay(nowMs) - startOfLocalDay(thenMs)) / (24 * 60 * 60 * 1000));
}

function startMs(p: any): number {
    const iso = p?.event_start_at ?? p?.eventStartAt;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Split the (already filtered) feed into headed sections, empty ones left out. The order within a listing
 * section is the order the feed was given in.
 */
export function feedSections<T extends Record<string, any>>(posts: T[], nowMs: number = Date.now()): FeedSection<T>[] {
    const events: T[] = [];
    const today: T[] = [];
    const yesterday: T[] = [];
    const thisWeek: T[] = [];
    const older: T[] = [];

    for (const post of posts) {
        if (post.type === 'event') {
            events.push(post);
            continue;
        }
        const posted = new Date(post.created_at || post.createdAt).getTime();
        const days = Number.isFinite(posted) ? localDaysAgo(posted, nowMs) : Number.POSITIVE_INFINITY;
        if (days <= 0) today.push(post);
        else if (days === 1) yesterday.push(post);
        else if (days < 7) thisWeek.push(post);
        else older.push(post);
    }

    events.sort((a, b) => startMs(a) - startMs(b));
    const sections: FeedSection<T>[] = [
        { id: 'header-events', title: UPCOMING_EVENTS_HEADING, posts: events },
        { id: 'header-today', title: 'Today', posts: today },
        { id: 'header-yesterday', title: 'Yesterday', posts: yesterday },
        { id: 'header-thisweek', title: 'This Week', posts: thisWeek },
        { id: 'header-older', title: 'Older Listings', posts: older },
    ];
    return sections.filter(s => s.posts.length > 0);
}
