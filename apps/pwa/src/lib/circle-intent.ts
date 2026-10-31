/**
 * "Join when it starts" (entry S8 part 3, as the place circle merged it), the phone's utils/circle-intent.ts for this
 * browser: the wish is kept here only, never on the global community. When the circle's card says a community has started
 * and takes requests, this browser sends its own signed knock to that community's own node, once.
 */
import { PLACE_CIRCLE_WORDS, circleKnockReady, circleKnockTrouble, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { rememberKnock, sendKnock } from './knock';

const storeKey = (pubkey: string) => `beanpool_circle_joins_${pubkey}`;
/** The circles whose community refused the knock: the wish is over, and the card goes on saying so. */
const refusedKey = (pubkey: string) => `beanpool_circle_joins_refused_${pubkey}`;

function readList(key: string): string[] {
    try {
        const held = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

function writeList(key: string, list: string[]): void {
    try {
        localStorage.setItem(key, JSON.stringify(list));
    } catch {
        // storage disabled or full: the wish is this browser's, and it can't keep one
    }
}

export function circleIntents(pubkey: string): string[] {
    return readList(storeKey(pubkey));
}

export function setCircleIntent(pubkey: string, circleId: string, on: boolean): void {
    const rest = circleIntents(pubkey).filter(id => id !== circleId);
    writeList(storeKey(pubkey), on ? [...rest, circleId] : rest);
}

/** What a look at a retired circle came to: whether a knock went, and why not when it should have. */
export interface CircleKnockResult { sent: boolean; trouble: CircleKnockTrouble | null }

/**
 * Sends the knock this browser owes for a circle a community retired, if it owes one. Taken off the list before it goes,
 * so it can't go twice; put back when the answer says nothing about this person, for the next read (core's
 * circleKnockTrouble). A refusal ends the wish, and each later read says so, so the card can.
 */
export async function knockForCircle(identity: BeanPoolIdentity, circle: CircleCard & { id: string }): Promise<CircleKnockResult> {
    if (!circleKnockReady(circle)) return { sent: false, trouble: null };
    const pubkey = identity.publicKey;
    if (!circleIntents(pubkey).includes(circle.id)) {
        return { sent: false, trouble: readList(refusedKey(pubkey)).includes(circle.id) ? 'refused' : null };
    }
    setCircleIntent(pubkey, circle.id, false);
    const { url, name, key } = circle.community;
    const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: identity.callsign });
    const trouble = circleKnockTrouble(sent);
    if (trouble === 'later') setCircleIntent(pubkey, circle.id, true);
    if (trouble === 'refused') writeList(refusedKey(pubkey), [...readList(refusedKey(pubkey)), circle.id]);
    if (sent.kind !== 'waiting') return { sent: false, trouble };
    await rememberKnock(pubkey, { url, name, key });
    return { sent: true, trouble: null };
}
