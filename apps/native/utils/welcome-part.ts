/**
 * BeanPool's part of Home's welcome, once per phone (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.3,
 * slice S5): one mark in the phone's own storage naming the community whose Home first drew the WELCOME TO BEANPOOL! tile
 * for this account. That community keeps its tile until Got it or the tour's end (the account's record); any other
 * community on this phone never draws BeanPool's part (its own welcome is slice S7's). Nothing is sent anywhere.
 *
 * A phone that can't read its storage draws the tile (never hidden for a missing fact, at most shown once more).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { communityKeyOf } from './community-index';
import { homeWelcomePartStoreKey } from './storage-keys';
import { stillOnPhone, type HomeAccount } from './home-account';

/** The community a Home is for, as the mark names it: its record's name (community-index.ts), in one spelling. */
const communityOf = (url: string): string => communityKeyOf(url).trim().replace(/\/+$/, '').toLowerCase();

export interface WelcomePartMark {
    v: 1;
    /** The community whose Home drew it first, in Home's key spelling. */
    where: string;
    at: string;
}

/** A stored mark, tolerantly: anything that isn't one is none (the tile may be drawn). */
export function readWelcomePartMark(raw: unknown): WelcomePartMark | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (m.v !== 1 || typeof m.where !== 'string' || !m.where || m.where.length > 512 || typeof m.at !== 'string') return null;
    return { v: 1, where: m.where, at: m.at };
}

/** Whether BeanPool's part was drawn first for another community on this phone, so this one leaves it out. */
export function welcomePartElsewhere(mark: WelcomePartMark | null, url: string): boolean {
    return !!mark && mark.where !== communityOf(url);
}

/** The account's mark on this phone; none when there is none or it can't be read. */
export async function loadWelcomePart(publicKey: string): Promise<WelcomePartMark | null> {
    try {
        const raw = await AsyncStorage.getItem(homeWelcomePartStoreKey(publicKey));
        return readWelcomePartMark(raw ? JSON.parse(raw) : null);
    } catch {
        return null;
    }
}

/**
 * The tile drawn for `url`: the mark is written once, for the first community only, while `whose` is still the account on
 * the phone. Returns the mark that stands afterwards (the one already there, or this one).
 */
export async function markWelcomePart(whose: HomeAccount, url: string, now: number = Date.now()): Promise<WelcomePartMark | null> {
    const had = await loadWelcomePart(whose.publicKey);
    if (had) return had;
    if (!stillOnPhone(whose)) return null;
    const mark: WelcomePartMark = { v: 1, where: communityOf(url), at: new Date(now).toISOString() };
    try {
        await AsyncStorage.setItem(homeWelcomePartStoreKey(whose.publicKey), JSON.stringify(mark));
    } catch {
        // Not kept: the tile may show once more in another community.
    }
    return mark;
}
