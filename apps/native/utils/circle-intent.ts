/**
 * "Join when it starts" (entry S8 part 3, as the place circle merged it): the wish is kept on this phone only, never on the
 * global community. When the circle's card says a community has started and takes requests, this phone sends its own
 * signed knock to that community's own node, once, as any knock goes. Nothing moves through global.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PLACE_CIRCLE_WORDS, circleKnockReady, circleKnockTrouble, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { rememberKnock, sendKnock } from './knock';

const storeKey = (pubkey: string) => `circle-join-intents:${pubkey}`;
/** The circles whose community refused the knock: the wish is over, and the card goes on saying so. */
const refusedKey = (pubkey: string) => `circle-join-refused:${pubkey}`;

async function readList(key: string): Promise<string[]> {
    try {
        const held = JSON.parse((await AsyncStorage.getItem(key)) ?? '[]');
        return Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

/** The circles this account asked to join from when one starts. */
export function circleIntents(pubkey: string): Promise<string[]> {
    return readList(storeKey(pubkey));
}

export async function setCircleIntent(pubkey: string, circleId: string, on: boolean): Promise<void> {
    const rest = (await circleIntents(pubkey)).filter(id => id !== circleId);
    await AsyncStorage.setItem(storeKey(pubkey), JSON.stringify(on ? [...rest, circleId] : rest));
}

/** The community this phone is on: a circle is on it, whatever its address (no community needs ours). */
export async function currentNodeUrl(): Promise<string | undefined> {
    return (await AsyncStorage.getItem('beanpool_anchor_url')) ?? undefined;
}

/** Those being sent now: a second read of Home while the first knock is out sends nothing. */
const sending = new Set<string>();

/** What a look at a retired circle came to: whether a knock went, and why not when it should have. */
export interface CircleKnockResult { sent: boolean; trouble: CircleKnockTrouble | null }

/**
 * Sends the knock this phone owes for a circle a community retired, if it owes one. Taken off the list before it goes, so
 * it can't go twice; put back when the answer says nothing about this person, for the next read (core's circleKnockTrouble).
 * A refusal ends the wish, and each later read says so, so the card can.
 */
export async function knockForCircle(identity: BeanPoolIdentity, circle: CircleCard & { id: string }): Promise<CircleKnockResult> {
    if (!circleKnockReady(circle) || sending.has(circle.id)) return { sent: false, trouble: null };
    sending.add(circle.id);
    const pubkey = identity.publicKey;
    try {
        if (!(await circleIntents(pubkey)).includes(circle.id)) {
            return { sent: false, trouble: (await readList(refusedKey(pubkey))).includes(circle.id) ? 'refused' : null };
        }
        await setCircleIntent(pubkey, circle.id, false);
        const { url, name, key } = circle.community;
        const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: identity.callsign });
        const trouble = circleKnockTrouble(sent);
        if (trouble === 'later') await setCircleIntent(pubkey, circle.id, true);
        if (trouble === 'refused') await AsyncStorage.setItem(refusedKey(pubkey), JSON.stringify([...await readList(refusedKey(pubkey)), circle.id]));
        if (sent.kind !== 'waiting') return { sent: false, trouble };
        await rememberKnock(pubkey, { url, name, key });
        return { sent: true, trouble: null };
    } finally {
        sending.delete(circle.id);
    }
}
