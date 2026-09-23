/**
 * "Your events" — the row at the top of ★ For You holding the events you said you would be at.
 *
 * It is `GET /api/events/mine` and nothing else: the signer's own upcoming RSVPs, soonest first, on the
 * same card the rest of the app uses. It has three quiet states and no loud ones — nothing yet, a node
 * that does not have the route (404: an older community), and a node that could not be reached — because
 * this row sits above a feed that is working, and a red box over somebody else's outage would only get in
 * the way of it.
 */

import { useEffect, useState } from 'react';
import { getMyEvents, isRouteMissing, type MarketplacePost } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { sortMyEvents, type MyEvent } from '../lib/event-extras';
import { EventCard } from './EventCard';

/**
 * A row of `/api/events/mine` as the event card reads it.
 *
 * The counts are deliberately absent, not zero: this route does not carry them, and the card leaves the
 * line out rather than telling a member that nobody is coming to the thing they are going to.
 */
export function myEventAsPost(row: MyEvent): MarketplacePost {
    return {
        id: row.postId,
        type: 'event',
        category: 'community',
        title: row.title,
        description: '',
        credits: 0,
        priceType: 'fixed',
        authorPublicKey: '',
        authorCallsign: '',
        createdAt: row.startAt,
        active: true,
        status: 'active',
        repeatable: false,
        eventStartAt: row.startAt,
        ...(row.endAt ? { eventEndAt: row.endAt } : {}),
        ...(row.placeName ? { eventPlaceName: row.placeName } : {}),
        ...(row.photo ? { photos: [row.photo] } : {}),
        eventState: 'scheduled',
        myRsvp: row.rsvp,
    };
}

interface YourEventsProps {
    identity?: BeanPoolIdentity | null;
    /** Opens the event the same way the feed does. */
    onOpen?: (postId: string) => void;
    /** Bumped by the page when something may have changed an RSVP. */
    refreshKey?: number;
}

export function YourEvents({ identity, onOpen, refreshKey = 0 }: YourEventsProps) {
    const [rows, setRows] = useState<MyEvent[] | null>(null);

    useEffect(() => {
        if (!identity?.publicKey) return;
        let cancelled = false;
        getMyEvents()
            .then(list => { if (!cancelled) setRows(sortMyEvents(list)); })
            .catch(e => {
                if (!cancelled) setRows([]);
                if (!isRouteMissing(e)) console.warn('[YourEvents] Could not read your events:', e);
            });
        return () => { cancelled = true; };
    }, [identity?.publicKey, refreshKey]);

    // Nothing to say: no identity, still loading, nothing coming up, or a node without the route.
    if (!rows || rows.length === 0) return null;

    return (
        <div data-testid="your-events" className="mb-6">
            <h3 className="m-0 mb-2 text-xs font-black uppercase tracking-wider text-nature-500 dark:text-nature-400">
                Your events
            </h3>
            <div className="flex flex-col gap-3">
                {rows.map(row => (
                    <EventCard
                        key={row.postId}
                        post={myEventAsPost(row)}
                        identity={identity}
                        onOpen={onOpen ? () => onOpen(row.postId) : undefined}
                    />
                ))}
            </div>
        </div>
    );
}
