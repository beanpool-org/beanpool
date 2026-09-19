/**
 * "Check your 12 words" — owners only (sealed-keys.md §7, slice 7). The logic under components/OwnerWordsCard.tsx,
 * components/OwnerWordsPrompt.tsx and app/owner-words-check.tsx.
 *
 * Why an owner is asked: the community's take-over lock and its sealed backups are locked to each owner's member key.
 * If an owner loses this phone, the 12 words are what rebuild that key when the main server is gone too.
 *
 *   - The words are checked HERE, on the phone (@beanpool/core checkOwnerWords): derive the key, compare it with the
 *     account's public key, and open a throwaway sealed envelope with it. The words are never sent, never stored,
 *     and the screen clears them as soon as the check answers (see {@link ownerWordsReducer}).
 *   - On a match the node gets one signed statement, `{ attestation: 'owner-12-words-checked' }`: the fact, and the
 *     date (the signed timestamp). Nothing derived from the words.
 *   - Never a gate. Nothing in the app or on the node waits for this. "Later" is always there, and the prompt comes
 *     back only on the design's cadence: once on becoming an owner, then 12 months after the last check.
 */

import { buildSignedHeaders } from './crypto';
import {
    OWNER_WORDS_CHECK_PATH, checkOwnerWords, isOwnerWordsCheckDue, ownerWordsPromptRound, splitTypedWords,
    type OwnerWordsCheckResult,
} from '@beanpool/core';
import type { BeanPoolIdentity } from './identity';

export const OWNER_WORDS_ATTESTATION = 'owner-12-words-checked';

export interface OwnerWordsStatus {
    owner: boolean;
    /** ms since epoch, or null: never checked. */
    wordsCheckedAt: number | null;
}

function base(nodeUrl: string): string {
    return nodeUrl.replace(/\/+$/, '');
}

/**
 * Am I an owner, and when did I last check? Null when the node gave no answer (offline, older node, 5xx): the app
 * then shows nothing, which is the safe default for a prompt that must never get in the way.
 */
export async function fetchOwnerWordsStatus(nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>): Promise<OwnerWordsStatus | null> {
    try {
        const headers = await buildSignedHeaders('GET', OWNER_WORDS_CHECK_PATH, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(`${base(nodeUrl)}${OWNER_WORDS_CHECK_PATH}`, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
        if (res.status === 403) return { owner: false, wordsCheckedAt: null };
        if (!res.ok) return null;
        const body = await res.json() as { owner?: unknown; wordsCheckedAt?: unknown };
        return {
            owner: body.owner === true,
            wordsCheckedAt: typeof body.wordsCheckedAt === 'number' && Number.isFinite(body.wordsCheckedAt) ? body.wordsCheckedAt : null,
        };
    } catch {
        return null;
    }
}

/**
 * The status for the home prompt, remembered in memory (never on disk) for STATUS_CACHE_MS per node and key, so the
 * home tab asks at most once per ten minutes. Only a real answer is remembered. A check forgets it.
 */
export const STATUS_CACHE_MS = 10 * 60_000;
const statusCache = new Map<string, { at: number; value: OwnerWordsStatus }>();
const statusKey = (nodeUrl: string, publicKey: string) => `${base(nodeUrl)} ${publicKey}`;

export async function cachedOwnerWordsStatus(
    nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>, now: number = Date.now(),
): Promise<OwnerWordsStatus | null> {
    const key = statusKey(nodeUrl, identity.publicKey);
    const hit = statusCache.get(key);
    if (hit && now - hit.at < STATUS_CACHE_MS) return hit.value;
    const value = await fetchOwnerWordsStatus(nodeUrl, identity);
    if (value) statusCache.set(key, { at: now, value });
    return value;
}

export function forgetOwnerWordsStatus(): void {
    statusCache.clear();
}

/** Tell the node "I checked my words" — the one signed statement. Returns the recorded date, or null. */
export async function sendOwnerWordsAttestation(nodeUrl: string, identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>): Promise<number | null> {
    try {
        const body = JSON.stringify({ attestation: OWNER_WORDS_ATTESTATION });
        const headers = await buildSignedHeaders('POST', OWNER_WORDS_CHECK_PATH, body, identity.privateKey, identity.publicKey);
        const res = await fetch(`${base(nodeUrl)}${OWNER_WORDS_CHECK_PATH}`, { method: 'POST', headers: { Accept: 'application/json', ...headers }, body });
        if (!res.ok) return null;
        const json = await res.json() as { wordsCheckedAt?: unknown };
        return typeof json.wordsCheckedAt === 'number' ? json.wordsCheckedAt : null;
    } catch {
        return null;
    }
}

/**
 * Check the typed words against this phone's account. Accepts the native raw-seed key and a PKCS8 key imported from
 * the PWA alike (core normalises). Only the public key and the stored key are read from the identity: never its
 * stored `mnemonic`, so a phone that still holds the words cannot "pass" by comparing them with themselves.
 */
export function checkMyWords(typed: string, identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>): Promise<OwnerWordsCheckResult> {
    return checkOwnerWords(typed, { publicKeyHex: identity.publicKey, privateKey: identity.privateKey });
}

/** How many words are typed so far, for the "7 of 12" hint. Counts only; never which word. */
export function typedWordCount(typed: string): number {
    return splitTypedWords(typed).length;
}

// ── The prompt's cadence ────────────────────────────────────────────────────────────────────

/** The only thing stored for this feature: which prompt round the owner said "Later" to. Never a word. */
export const laterKey = (publicKey: string) => `beanpool:owner-words-later:${publicKey}`;

export interface KeyValueStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** Show the gentle prompt? Owners only; due (never checked, or 12 months on); not already put off this round. */
export function shouldPromptOwner(status: OwnerWordsStatus | null, laterRound: string | null, now: number = Date.now()): boolean {
    if (!status?.owner) return false;
    if (!isOwnerWordsCheckDue(status.wordsCheckedAt, now)) return false;
    return laterRound !== ownerWordsPromptRound(status.wordsCheckedAt);
}

export async function readLaterRound(store: KeyValueStore, publicKey: string): Promise<string | null> {
    try { return await store.getItem(laterKey(publicKey)); } catch { return null; }
}

export async function rememberLater(store: KeyValueStore, publicKey: string, status: OwnerWordsStatus): Promise<void> {
    try { await store.setItem(laterKey(publicKey), ownerWordsPromptRound(status.wordsCheckedAt)); } catch { /* the prompt simply shows again */ }
}

// ── Words for the screens ───────────────────────────────────────────────────────────────────

export function formatCheckedDate(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const OWNER_WORDS_COPY = {
    title: 'Check your 12 words',
    why: "You're an owner of this community. Its take-over keys and backups are locked to your account. If you lose this phone, your 12 words are what get you back in — so check you still have the right ones.",
    notChecked: "Your 12 words aren't checked. If you lose this phone you couldn't take over the server or open a backup.",
    promptTitleNever: "Your 12 words aren't checked",
    promptBodyNever: "If you lose this phone you couldn't take over the server or open a backup.",
    promptTitleRenew: 'Time to check your 12 words',
    promptBodyRenew: "It's a year since you last checked them. If you lose this phone, they're how you'd take over the server or open a backup.",
    checked: (ms: number) => `12 words checked ${formatCheckedDate(ms)}`,
    stays: 'Your words stay on this phone. They are never sent or saved.',
    match: 'These are the right words.',
    matchSaved: 'These are the right words. Your community can see you checked them today.',
    matchNotSaved: "These are the right words. We couldn't tell your community's server just now; check again later to record it.",
    mismatch: "These aren't the words for this account.",
    count: (n: number) => `That's ${n} word${n === 1 ? '' : 's'}. Type all 12, in order.`,
    findThem: "Can't find them? If this phone still has them, Settings → View Recovery Phrase shows them.",
    checkNow: 'Check now',
    later: 'Later',
} as const;

// ── The screen's state: the typed words live here and nowhere else, and are cleared on every answer ──────────

export type OwnerWordsOutcome = 'match' | 'mismatch' | 'count';

export interface OwnerWordsState {
    typed: string;
    busy: boolean;
    outcome: OwnerWordsOutcome | null;
    /** The word count at the last "count" answer, for its message. */
    countSeen: number;
    /** After a match: telling the node ('sending'), told ('saved', with its date), or it could not be reached. */
    record: 'none' | 'sending' | 'saved' | 'failed';
    recordedAt: number | null;
}

export type OwnerWordsAction =
    | { type: 'typed'; text: string }
    | { type: 'checking' }
    | { type: 'answered'; result: OwnerWordsCheckResult; countSeen: number }
    | { type: 'recorded'; at: number | null }
    | { type: 'clear' };

export const OWNER_WORDS_INITIAL: OwnerWordsState = { typed: '', busy: false, outcome: null, countSeen: 0, record: 'none', recordedAt: null };

export function ownerWordsReducer(state: OwnerWordsState, action: OwnerWordsAction): OwnerWordsState {
    switch (action.type) {
        case 'typed':
            // Typing again after an answer starts a fresh try.
            return { ...state, typed: action.text, outcome: null };
        case 'checking':
            return { ...state, busy: true };
        case 'answered':
            // Not 12 words: nothing was checked, so keep what they typed and say how many there are.
            if (!action.result.matches && action.result.reason === 'count') {
                return { ...state, busy: false, outcome: 'count', countSeen: action.countSeen };
            }
            // Checked: the words are cleared whatever the answer. A right answer needs them no more, and a wrong
            // one should be typed again from the paper rather than edited from a guess on screen.
            return {
                typed: '', busy: false, countSeen: 0,
                outcome: action.result.matches ? 'match' : 'mismatch',
                record: action.result.matches ? 'sending' : 'none', recordedAt: null,
            };
        case 'recorded':
            return { ...state, record: action.at === null ? 'failed' : 'saved', recordedAt: action.at };
        case 'clear':
            return OWNER_WORDS_INITIAL;
    }
}
