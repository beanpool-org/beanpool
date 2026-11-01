/**
 * "Remind me to join when it starts" and Ask to join (entry S8 part 3, as the place circle merged it; Marty, 1 Nov: one tap),
 * the phone's utils/circle-intent.ts for this browser. The wish is kept here only, never on the global community, and it
 * sends nothing. Nothing goes to a community, no knock and no status read, until the member taps Ask to join on the retired
 * card. The tap sends this browser's own signed knock to that community's own node, as any knock goes.
 */
import { PLACE_CIRCLE_WORDS, circleKnockReady, circleKnockTrouble, t, type CircleCard, type CircleKnockTrouble } from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';
import { cancelledKnocks, communityOrigin, rememberKnock, rememberedKnocks, sendKnock } from './knock';

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

/** What this browser holds about asking a retired circle's community. All of it is read here: nothing goes to that community. */
export interface CircleAsk {
    /** They set the reminder. */
    wished: boolean;
    /** A request to it is open. */
    asked: boolean;
    /** They cancelled one within the day: the community would refuse another until then (lib/knock.ts). */
    cancelled: boolean;
    /** It refused this circle's knock. */
    refused: boolean;
}

export async function readCircleAsk(pubkey: string, circleId: string, url: string | null | undefined): Promise<CircleAsk> {
    const origin = communityOrigin(url);
    const [open, recent] = await Promise.all([rememberedKnocks(pubkey), cancelledKnocks(pubkey)]);
    return {
        wished: circleIntents(pubkey).includes(circleId),
        asked: !!origin && open.some(k => k.url === origin),
        cancelled: !!origin && origin in recent,
        refused: readList(refusedKey(pubkey)).includes(circleId),
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
        const sent = await sendKnock(url, identity, { message: t(PLACE_CIRCLE_WORDS.knockMessage), callsign: identity.callsign });
        const trouble = circleKnockTrouble(sent);
        if (trouble === 'later') return { sent: false, trouble, said: null };
        setCircleIntent(pubkey, circle.id, false);
        if (trouble === 'refused') {
            writeList(refusedKey(pubkey), [...readList(refusedKey(pubkey)), circle.id]);
            return { sent: false, trouble, said: null };
        }
        if (sent.kind === 'member') return { sent: false, trouble: null, said: sent.message };
        await rememberKnock(pubkey, { url, name, key });
        return { sent: true, trouble: null, said: null };
    } finally {
        sending.delete(circle.id);
    }
}
