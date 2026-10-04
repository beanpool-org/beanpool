/**
 * The consent a known community asks for (community modes slice 6; apps/server engine/community-health.ts): the text
 * the admins can see your balance under, from the community's two lines. Offered in the app, never required: a member
 * who says nothing is still a member, and is simply never one of the admins' exceptions.
 */
export interface KnownConsent {
    known: boolean;
    version: string;
    text: string;
    confirmed: boolean;
    consentedAt: string | null;
    consentedVersion: string | null;
    /** When they last withdrew, while they have no consent now. */
    withdrawnAt: string | null;
}

/** A whole answer from GET /api/names/consent, or null (an older node answers 404, the global node 404 too). */
export function readKnownConsent(v: unknown): KnownConsent | null {
    const o = v as Partial<KnownConsent> | null;
    if (!o || typeof o.known !== 'boolean' || typeof o.version !== 'string' || typeof o.text !== 'string') return null;
    return {
        known: o.known, version: o.version, text: o.text, confirmed: o.confirmed === true,
        consentedAt: typeof o.consentedAt === 'string' ? o.consentedAt : null,
        consentedVersion: typeof o.consentedVersion === 'string' ? o.consentedVersion : null,
        withdrawnAt: typeof o.withdrawnAt === 'string' ? o.withdrawnAt : null,
    };
}

/** Whether to offer it: a known community, and the member hasn't agreed to the text it says now. */
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

/** The text a known community shows on its join screen (GET /api/community/consent-terms, public), before joining. */
export interface ConsentTerms {
    known: boolean;
    version: string;
    text: string;
}

/** A whole answer from GET /api/community/consent-terms, or null (an older node answers 404: the join shows nothing). */
export function readConsentTerms(v: unknown): ConsentTerms | null {
    const o = v as Partial<ConsentTerms> | null;
    if (!o || typeof o.known !== 'boolean' || typeof o.version !== 'string' || typeof o.text !== 'string') return null;
    return { known: o.known, version: o.version, text: o.text };
}

/** Whether the join screen shows the tick: only a known community, with text to agree to. */
export function joinAsksConsent(t: ConsentTerms | null): t is ConsentTerms {
    return !!t && t.known && t.text.length > 0 && t.version.length > 0;
}
