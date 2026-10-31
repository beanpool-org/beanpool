/**
 * "Join when it starts" (entry S8 part 3, as the place circle merged it), the phone's utils/circle-intent.ts for this
 * browser: the wish is kept here only, never on the global community. When the circle's card says a community has started
 * and takes requests, this browser sends its own signed knock to that community's own node, once.
 */
import { PLACE_CIRCLE_WORDS, circleKnockReady, t, type CircleCard } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { rememberKnock, sendKnock } from './knock';

const storeKey = (pubkey: string) => `beanpool_circle_joins_${pubkey}`;

export function circleIntents(pubkey: string): string[] {
    try {
        const held = JSON.parse(localStorage.getItem(storeKey(pubkey)) ?? '[]');
        return Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

export function setCircleIntent(pubkey: string, circleId: string, on: boolean): void {
    try {
        const rest = circleIntents(pubkey).filter(id => id !== circleId);
        localStorage.setItem(storeKey(pubkey), JSON.stringify(on ? [...rest, circleId] : rest));
    } catch {
        // storage disabled or full: the wish is this browser's, and it can't keep one
    }
}

/**
 * Sends the knock this browser owes for a circle a community retired, if it owes one. True when one went. Taken off the
 * list before it goes, so it can't go twice; put back only when the community couldn't be reached, for the next read.
 */
export async function knockForCircle(identity: BeanPoolIdentity, circle: CircleCard & { id: string }): Promise<boolean> {
    if (!circleKnockReady(circle) || !circleIntents(identity.publicKey).includes(circle.id)) return false;
    setCircleIntent(identity.publicKey, circle.id, false);
    const { url, name, key } = circle.community;
    const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: identity.callsign });
    if (sent.kind === 'unreachable') setCircleIntent(identity.publicKey, circle.id, true);
    if (sent.kind !== 'waiting') return false;
    await rememberKnock(identity.publicKey, { url, name, key });
    return true;
}
