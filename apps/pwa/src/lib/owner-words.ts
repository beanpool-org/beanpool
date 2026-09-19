/**
 * "Check your 12 words" — owners only (sealed-keys.md §7, slice 7). The web app's half; the phone's is
 * apps/native/utils/owner-words.ts and the two say the same things.
 *
 *   - The words are checked in this browser (@beanpool/core checkOwnerWords): derive the key, compare it with the
 *     account's public key, open a throwaway sealed envelope with it. This browser keeps the key as 48-byte PKCS8;
 *     core normalises it. The words are never sent and never stored, and the card clears them after the check.
 *   - On a match the node gets one signed statement, `{ attestation: 'owner-12-words-checked' }`.
 *   - Never a gate. "Later" is always there; the prompt comes back only on the design's cadence.
 */
import {
    OWNER_WORDS_CHECK_PATH, checkOwnerWords, isOwnerWordsCheckDue, ownerWordsPromptRound, splitTypedWords,
    type OwnerWordsCheckResult,
} from '@beanpool/core';
import { request } from './api';

export const OWNER_WORDS_ATTESTATION = 'owner-12-words-checked';

export interface OwnerWordsStatus {
    owner: boolean;
    wordsCheckedAt: number | null;
}

/**
 * Am I an owner, and when did I last check? A refusal (403: not an owner) is `owner: false`; no answer at all is
 * null, and the app shows nothing.
 */
export async function fetchOwnerWordsStatus(): Promise<OwnerWordsStatus | null> {
    try {
        const body = await request<{ owner?: unknown; wordsCheckedAt?: unknown }>('GET', OWNER_WORDS_CHECK_PATH);
        return {
            owner: body.owner === true,
            wordsCheckedAt: typeof body.wordsCheckedAt === 'number' && Number.isFinite(body.wordsCheckedAt) ? body.wordsCheckedAt : null,
        };
    } catch (e) {
        return /owners are asked|403/i.test(String((e as Error)?.message)) ? { owner: false, wordsCheckedAt: null } : null;
    }
}

/** In memory only, ten minutes: the prompt asks once, not on every tab switch. A check forgets it. */
export const STATUS_CACHE_MS = 10 * 60_000;
let cached: { at: number; value: OwnerWordsStatus } | null = null;

export async function cachedOwnerWordsStatus(now: number = Date.now()): Promise<OwnerWordsStatus | null> {
    if (cached && now - cached.at < STATUS_CACHE_MS) return cached.value;
    const value = await fetchOwnerWordsStatus();
    if (value) cached = { at: now, value };
    return value;
}

export function forgetOwnerWordsStatus(): void {
    cached = null;
}

/** Tell the node "I checked my words". Returns the recorded date, or null if it could not be told. */
export async function sendOwnerWordsAttestation(): Promise<number | null> {
    try {
        const res = await request<{ wordsCheckedAt?: unknown }>('POST', OWNER_WORDS_CHECK_PATH, { attestation: OWNER_WORDS_ATTESTATION });
        return typeof res.wordsCheckedAt === 'number' ? res.wordsCheckedAt : null;
    } catch {
        return null;
    } finally {
        forgetOwnerWordsStatus();
    }
}

/** Check typed words against this browser's account. Never reads the stored words. */
export function checkMyWords(typed: string, identity: { publicKey: string; privateKey: string }): Promise<OwnerWordsCheckResult> {
    return checkOwnerWords(typed, { publicKeyHex: identity.publicKey, privateKey: identity.privateKey });
}

export function typedWordCount(typed: string): number {
    return splitTypedWords(typed).length;
}

// ── Cadence ──

/** The only thing kept for this feature: which prompt round the owner said "Later" to. Never a word. */
export const laterKey = (publicKey: string) => `beanpool:owner-words-later:${publicKey}`;

export function shouldPromptOwner(status: OwnerWordsStatus | null, laterRound: string | null, now: number = Date.now()): boolean {
    if (!status?.owner) return false;
    if (!isOwnerWordsCheckDue(status.wordsCheckedAt, now)) return false;
    return laterRound !== ownerWordsPromptRound(status.wordsCheckedAt);
}

export function readLaterRound(publicKey: string): string | null {
    try { return localStorage.getItem(laterKey(publicKey)); } catch { return null; }
}

export function rememberLater(publicKey: string, status: OwnerWordsStatus): void {
    try { localStorage.setItem(laterKey(publicKey), ownerWordsPromptRound(status.wordsCheckedAt)); } catch { /* it simply shows again */ }
}

export function formatCheckedDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const OWNER_WORDS_COPY = {
    title: 'Check your 12 words',
    why: "You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this device, your 12 words are what get you back in — so check you still have the right ones.",
    notChecked: "Your 12 words aren't checked. If you lose this device you couldn't take over the server or open a backup.",
    checked: (ms: number) => `12 words checked ${formatCheckedDate(ms)}`,
    stays: 'Your words stay in this browser. They are never sent or saved.',
    match: 'These are the right words.',
    matchSaved: 'These are the right words. Your community can see you checked them today.',
    matchNotSaved: "These are the right words. We couldn't tell your community's server just now; check again later to record it.",
    mismatch: "These aren't the words for this account.",
    count: (n: number) => `That's ${n} word${n === 1 ? '' : 's'}. Type all 12, in order.`,
    findThem: "Can't find them? If this browser still has them, View Recovery Phrase (below) shows them.",
    promptTitleNever: "Your 12 words aren't checked",
    promptBodyNever: "If you lose this device you couldn't take over the server or open a backup.",
    promptTitleRenew: 'Time to check your 12 words',
    promptBodyRenew: "It's a year since you last checked them. If you lose this device, they're how you'd take over the server or open a backup.",
    checkNow: 'Check now',
    later: 'Later',
} as const;
