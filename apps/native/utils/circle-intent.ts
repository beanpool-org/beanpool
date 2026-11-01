/**
 * "Remind me to join when it starts" and Ask to join (entry S8 part 3, as the place circle merged it; Marty, 1 Nov: one tap):
 * the wish is kept on this phone only, never on the global community, and it sends nothing. Nothing goes to a community, no
 * knock and no status read, until the member taps Ask to join on the retired card. The tap sends this phone's own signed
 * knock to that community's own node, as any knock goes. Nothing moves through global.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PLACE_CIRCLE_WORDS, circleKnockReady, circleKnockTrouble, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { communityOrigin } from './community-directory';
import { KNOCK_CALLSIGN_CHARS, cancelledKnocks, rememberKnock, rememberedKnocks, sendKnock } from './knock';

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

/** The circles this account asked to be reminded about when one starts. */
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

/** What this phone holds about asking a retired circle's community. All of it is read here: nothing goes to that community. */
export interface CircleAsk {
    /** They set the reminder. */
    wished: boolean;
    /** A request to it is open. */
    asked: boolean;
    /** They cancelled one within the day: the community would refuse another until then (utils/knock.ts). */
    cancelled: boolean;
    /** It refused this circle's knock. */
    refused: boolean;
}

export async function readCircleAsk(pubkey: string, circleId: string, url: string | null | undefined): Promise<CircleAsk> {
    const origin = communityOrigin(url);
    const [wishes, refused, open, recent] = await Promise.all([circleIntents(pubkey), readList(refusedKey(pubkey)), rememberedKnocks(pubkey), cancelledKnocks(pubkey)]);
    return {
        wished: wishes.includes(circleId),
        asked: !!origin && open.some(k => k.url === origin),
        cancelled: !!origin && origin in recent,
        refused: refused.includes(circleId),
    };
}

/** Those being sent now: a second tap while the first knock is out sends nothing. */
const sending = new Set<string>();

/** What a tap on Ask to join came to: whether a request now stands, why not, and what the community said if that's all. */
export interface CircleKnockResult { sent: boolean; trouble: CircleKnockTrouble | null; said: string | null }

/**
 * Ask to join on a retired circle's card, and only that: sends one knock, and nothing calls this but the tap. An answer
 * that says nothing about this person keeps the wish and the button for another tap (core's circleKnockTrouble). A refusal
 * ends the wish, and each later read says so (readCircleAsk).
 */
export async function knockForCircle(identity: BeanPoolIdentity, circle: CircleCard & { id: string }): Promise<CircleKnockResult> {
    if (!circleKnockReady(circle) || sending.has(circle.id)) return { sent: false, trouble: null, said: null };
    sending.add(circle.id);
    const pubkey = identity.publicKey;
    try {
        const { url, name, key } = circle.community;
        const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: Array.from(identity.callsign ?? '').slice(0, KNOCK_CALLSIGN_CHARS).join('') });
        const trouble = circleKnockTrouble(sent);
        if (trouble === 'later') return { sent: false, trouble, said: null };
        await setCircleIntent(pubkey, circle.id, false);
        if (trouble === 'refused') {
            await AsyncStorage.setItem(refusedKey(pubkey), JSON.stringify([...await readList(refusedKey(pubkey)), circle.id]));
            return { sent: false, trouble, said: null };
        }
        if (sent.kind === 'member') return { sent: false, trouble: null, said: sent.message };
        await rememberKnock(pubkey, { url, name, key });
        return { sent: true, trouble: null, said: null };
    } finally {
        sending.delete(circle.id);
    }
}
