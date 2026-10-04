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
