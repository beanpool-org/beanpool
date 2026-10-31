/**
 * "Join when it starts" (entry S8 part 3, as the place circle merged it): the wish is kept on this phone only, never on the
 * global community. When the circle's card says a community has started and takes requests, this phone sends its own
 * signed knock to that community's own node, once, as any knock goes. Nothing moves through global.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PLACE_CIRCLE_WORDS, circleKnockReady, t, type CircleCard } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { rememberKnock, sendKnock } from './knock';

const storeKey = (pubkey: string) => `circle-join-intents:${pubkey}`;

/** The circles this account asked to join from when one starts. */
export async function circleIntents(pubkey: string): Promise<string[]> {
    try {
        const held = JSON.parse((await AsyncStorage.getItem(storeKey(pubkey))) ?? '[]');
        return Array.isArray(held) ? held.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

export async function setCircleIntent(pubkey: string, circleId: string, on: boolean): Promise<void> {
    const rest = (await circleIntents(pubkey)).filter(id => id !== circleId);
    await AsyncStorage.setItem(storeKey(pubkey), JSON.stringify(on ? [...rest, circleId] : rest));
}

/** Those being sent now: a second read of Home while the first knock is out sends nothing. */
const sending = new Set<string>();

/**
 * Sends the knock this phone owes for a circle a community retired, if it owes one. True when one went. Taken off the
 * list before it goes, so it can't go twice; put back only when the community couldn't be reached, for the next read.
 */
export async function knockForCircle(identity: BeanPoolIdentity, circle: CircleCard & { id: string }): Promise<boolean> {
    if (!circleKnockReady(circle) || sending.has(circle.id)) return false;
    sending.add(circle.id);
    try {
        if (!(await circleIntents(identity.publicKey)).includes(circle.id)) return false;
        await setCircleIntent(identity.publicKey, circle.id, false);
        const { url, name, key } = circle.community;
        const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: identity.callsign });
        if (sent.kind === 'unreachable') await setCircleIntent(identity.publicKey, circle.id, true);
        if (sent.kind !== 'waiting') return false;
        await rememberKnock(identity.publicKey, { url, name, key });
        return true;
    } finally {
        sending.delete(circle.id);
    }
}
