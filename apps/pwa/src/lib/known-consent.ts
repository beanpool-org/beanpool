/**
 * The consent a known community asks for (community modes slice 6; apps/server engine/community-health.ts): the text
 * the admins can see a member's balance under, from the community's two lines. Shown on the join step and offered in
 * Settings, never required: a member who says nothing is still a member, and is simply never one of the admins'
 * exceptions. The same reading as the phone's (apps/native utils/known-consent.ts).
 */
import { request } from './api';

/** The text a known community shows on its join step (GET /api/community/consent-terms, public), before joining. */
export interface ConsentTerms {
    known: boolean;
    version: string;
    text: string;
}

/** A member's own (GET /api/names/consent): the terms, and whether they agreed to them. */
export interface KnownConsent extends ConsentTerms {
    confirmed: boolean;
    consentedAt: string | null;
    consentedVersion: string | null;
    /** When they last withdrew, while they have no consent now. */
    withdrawnAt: string | null;
}

/** A whole answer from GET /api/community/consent-terms, or null (an older node answers 404: the join shows nothing). */
export function readConsentTerms(v: unknown): ConsentTerms | null {
    const o = v as Partial<ConsentTerms> | null;
    if (!o || typeof o.known !== 'boolean' || typeof o.version !== 'string' || typeof o.text !== 'string') return null;
    return { known: o.known, version: o.version, text: o.text };
}

/** Whether the join step shows the tick: only a known community, with text to agree to. */
export function joinAsksConsent(t: ConsentTerms | null): t is ConsentTerms {
    return !!t && t.known && t.text.length > 0 && t.version.length > 0;
}

/** A whole answer from GET /api/names/consent, or null. */
export function readKnownConsent(v: unknown): KnownConsent | null {
    const terms = readConsentTerms(v);
    if (!terms) return null;
    const o = v as Partial<KnownConsent>;
    return {
        ...terms, confirmed: o.confirmed === true,
        consentedAt: typeof o.consentedAt === 'string' ? o.consentedAt : null,
        consentedVersion: typeof o.consentedVersion === 'string' ? o.consentedVersion : null,
        withdrawnAt: typeof o.withdrawnAt === 'string' ? o.withdrawnAt : null,
    };
}

/** Whether Settings offers it: a known community, and the member hasn't agreed to the text it says now. */
export function shouldOfferConsent(c: KnownConsent | null): boolean {
    return !!c && c.known && c.consentedVersion !== c.version;
}

/** Whether the member can withdraw: they agreed to some text, whatever the community says now (GDPR Art. 7(3)). */
export function canWithdrawConsent(c: KnownConsent | null): boolean {
    return !!c && !!c.consentedVersion;
}

/** Whether Settings shows the card: to offer the text, or to show the member what they agreed to, with Withdraw. */
export function showsConsentCard(c: KnownConsent | null): boolean {
    return shouldOfferConsent(c) || canWithdrawConsent(c);
}

/** The heading: a first ask, or the community changed its lines since. */
export function consentHeading(c: KnownConsent): string {
    return c.consentedVersion ? 'Your community changed what its admins can see' : 'What this community\'s admins can see';
}

/** The join step's text, or null: an older node, a plain community, offline. Never throws. */
export async function fetchConsentTerms(): Promise<ConsentTerms | null> {
    const terms = await request<unknown>('GET', '/api/community/consent-terms').then(readConsentTerms).catch(() => null);
    return joinAsksConsent(terms) ? terms : null;
}

/** The member's own consent, or null (an older node, a guest, offline). Never throws. */
export async function fetchMyConsent(): Promise<KnownConsent | null> {
    return request<unknown>('GET', '/api/names/consent').then(readKnownConsent).catch(() => null);
}

/** Withdraws the member's consent: from that moment they are in no exception. Throws the node's refusal. */
export async function withdrawConsent(): Promise<KnownConsent | null> {
    return readKnownConsent(await request<unknown>('POST', '/api/names/consent', { withdraw: true }));
}

/** Records the member's consent to the text they were shown. Throws the node's refusal (the lines changed meanwhile). */
export async function agreeToConsent(version: string): Promise<KnownConsent | null> {
    return readKnownConsent(await request<unknown>('POST', '/api/names/consent', { version }));
}

/**
 * The consent text laid out to read on a small screen, without changing a word of it (rehearsal 5 Oct, d1: one
 * 2,500-character paragraph, the tick at its end, about four screens at 320 dp and 130% text). `summary` is the
 * sentences before the first list; `rest` is everything after, the long "…: a; b; and c." sentence as its lead and one
 * item per clause, each later sentence its own paragraph. The screens show the summary, then the rest behind "Read all
 * of it". Joined with single spaces the parts are the text again, character for character; any text that doesn't split
 * that way comes back whole as the summary.
 */
export interface ConsentTextParts {
    summary: string;
    rest: { text: string; item: boolean }[];
}

export function consentTextParts(text: string): ConsentTextParts {
    const sentences: string[] = [];
    let start = 0;
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] === ' ' && '.!?'.includes(text[i - 1]) && /[A-Z]/.test(text[i + 1])) {
            sentences.push(text.slice(start, i));
            start = i + 1;
        }
    }
    sentences.push(text.slice(start));
    const blocks: { text: string; item: boolean }[] = [];
    for (const s of sentences) {
        const colon = s.indexOf(': ');
        if (colon > 0 && s.indexOf('; ', colon) > 0) {
            blocks.push({ text: s.slice(0, colon + 1), item: false });
            const clauses = s.slice(colon + 2).split('; ');
            clauses.forEach((c, i) => blocks.push({ text: i < clauses.length - 1 ? `${c};` : c, item: true }));
        } else {
            blocks.push({ text: s, item: false });
        }
    }
    const firstItem = blocks.findIndex((b) => b.item);
    const summaryEnd = firstItem < 0 ? blocks.length : firstItem - 1;
    const summary = blocks.slice(0, summaryEnd).map((b) => b.text).join(' ');
    const rest = blocks.slice(summaryEnd);
    if (!summary || [summary, ...rest.map((b) => b.text)].join(' ') !== text) return { summary: text, rest: [] };
    return { summary, rest };
}
