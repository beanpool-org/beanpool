import { word, wordsFor, type WordKey } from '@beanpool/core';

/** Operators' Settings is English for launch (translation design M8); the sentences are marked so a catalog can come later. */
export const { t } = wordsFor('en');

/**
 * An owner's fresh proof (apps/server admin-auth.ts requireFreshProof; design case 18 §5): the rare changes that can lose
 * the community's data or address, or lock an owner out, ask for it every time. What the server answers, by the kind of
 * sign-in the request came with:
 *   the admin password          401 totpRequired: a code the authenticator shows now (or a backup code) in `code`;
 *                               a wrong or spent code is 401 again, with its own sentence;
 *   the phone's Manage hand-off 403 step_up_required once the unlock is older than 90 seconds;
 *   a computer's key session    403 phone_required: it has no unlock of its own;
 *   the password, 2FA off       403 fresh_proof_needs_2fa (the proof fails closed).
 * This module reads that answer; FreshProofBox (components/common) shows it, and useFreshProof re-sends the request once
 * per code typed.
 */
export type FreshProofRefusal =
    | { kind: 'code'; error: string }
    | { kind: 'step-up'; error: string }
    | { kind: 'phone'; error: string }
    | { kind: 'needs-2fa'; error: string };

export const FRESH_PROOF_WORDS = {
    codeLabel: word('Current code'),
    confirm: word('Confirm'),
    cancel: word('Cancel'),
    checking: word('Checking…'),
    codeAsk: word('This change asks for a current code each time. Enter the code your authenticator app shows now.'),
    codeAgain: word('Type the new code your authenticator app shows, then press Confirm.'),
    stepUp: word('Press Manage on your phone again, then make this change within 90 seconds.'),
    phone: word('Do this from your phone: open BeanPool, press Manage, then make this change there.'),
    needs2fa: word('Turn on two-factor sign-in first: this change asks for a current code each time.'),
} satisfies Record<string, WordKey>;

/**
 * checkAdminAuth's own 401 when a password request carries no 2FA (admin-auth.ts: the fleet manager's 4-hour 2FA
 * session ended). It is not the fresh proof: a code in `code` never reaches it, so it goes to the 2FA prompt, not the
 * box (opus-2028 N4).
 */
export const SECOND_FACTOR_ASK = '2FA code required';

function secondFactorAsk(status: number, body: unknown): boolean {
    if (status !== 401 || !body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return b.totpRequired === true && b.error === SECOND_FACTOR_ASK;
}

/** The fresh-proof refusal in a server's answer, or null when the answer is anything else. */
export function freshProofRefusal(status: number, body: unknown): FreshProofRefusal | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const error = typeof b.error === 'string' ? b.error : '';
    if (status === 401 && b.totpRequired === true) return secondFactorAsk(status, body) ? null : { kind: 'code', error };
    if (status === 403 && (b.code === 'phone_required' || b.phoneRequired === true)) return { kind: 'phone', error };
    if (status === 403 && b.code === 'step_up_required') return { kind: 'step-up', error };
    if (status === 403 && b.code === 'fresh_proof_needs_2fa') return { kind: 'needs-2fa', error };
    return null;
}

/** The refusal in a fetch Response, read from a clone so the caller can still read the body. */
export async function freshProofRefusalOf(res: Response): Promise<FreshProofRefusal | null> {
    if (res.status !== 401 && res.status !== 403) return null;
    let body: unknown = null;
    try {
        body = await res.clone().json();
    } catch {
        return null;
    }
    return freshProofRefusal(res.status, body);
}

/**
 * Thrown by node-client helpers when the server asks the fresh proof, so a screen can open the box. It keeps what the
 * helpers' errors carried before (the node's sentence as the message, its `status` and its short `code`), so a screen
 * without the box still says the node's words.
 */
export class FreshProofRequiredError extends Error {
    constructor(readonly refusal: FreshProofRefusal, readonly status?: number, readonly code?: string) {
        super(refusal.error || 'This change asks for a fresh proof');
        this.name = 'FreshProofRequiredError';
    }
}

/** Thrown by node-client helpers for checkAdminAuth's own "2FA code required" (SECOND_FACTOR_ASK), with its sentence. */
export class SecondFactorRequiredError extends Error {
    readonly status = 401;
    constructor() {
        super(SECOND_FACTOR_ASK);
        this.name = 'SecondFactorRequiredError';
    }
}

/** The answer (a Response, read from a clone) or the thrown error is checkAdminAuth's own 2FA ask, not the fresh proof. */
export async function isSecondFactorAskOf(res: Response): Promise<boolean> {
    if (res.status !== 401) return false;
    try {
        return secondFactorAsk(res.status, await res.clone().json());
    } catch {
        return false;
    }
}
export function isSecondFactorAsk(err: unknown): boolean {
    return err instanceof SecondFactorRequiredError;
}

/**
 * Throws FreshProofRequiredError when `status`/`body` is a fresh-proof refusal, and SecondFactorRequiredError when it is
 * checkAdminAuth's own 2FA ask.
 */
export function throwIfFreshProof(status: number, body: unknown): void {
    if (secondFactorAsk(status, body)) throw new SecondFactorRequiredError();
    const refusal = freshProofRefusal(status, body);
    if (!refusal) return;
    const code = body && typeof (body as Record<string, unknown>).code === 'string' ? (body as Record<string, string>).code : undefined;
    throw new FreshProofRequiredError(refusal, status, code);
}

const REFUSAL_KINDS: ReadonlyArray<FreshProofRefusal['kind']> = ['code', 'step-up', 'phone', 'needs-2fa'];

/**
 * The fresh-proof refusal a thrown error carries: a FreshProofRequiredError's, or a helper's own error class that holds
 * one in `refusal` (node-client RekeyBindError, whose callers read its `code` and `triesLeft` too).
 */
export function refusalOf(err: unknown): FreshProofRefusal | null {
    if (err instanceof FreshProofRequiredError) return err.refusal;
    const r = err && typeof err === 'object' ? (err as { refusal?: unknown }).refusal : undefined;
    if (!r || typeof r !== 'object') return null;
    const { kind, error } = r as { kind?: unknown; error?: unknown };
    return REFUSAL_KINDS.includes(kind as FreshProofRefusal['kind']) ? { kind, error: typeof error === 'string' ? error : '' } as FreshProofRefusal : null;
}

/**
 * A fresh proof is a code a person types: six digits from the authenticator, or an 8-character backup code. Anything else
 * (a password or an automation token put in its place by mistake) is never sent as one.
 */
const PROOF_SHAPE = /^[A-Za-z0-9-]{4,32}$/;
function usableProof(code: string | undefined): string | undefined {
    const clean = typeof code === 'string' ? code.trim() : '';
    return PROOF_SHAPE.test(clean) ? clean : undefined;
}

/** The `code` field for a request body: nothing when there is no code yet. */
export function proofField(code: string | undefined): { code?: string } {
    const proof = usableProof(code);
    return proof ? { code: proof } : {};
}

/** The X-Fresh-Proof header, for a route whose body already has a `code` of its own (rekey/complete). */
export function proofHeader(code: string | undefined): Record<string, string> {
    const proof = usableProof(code);
    return proof ? { 'X-Fresh-Proof': proof } : {};
}

/**
 * A plain-words sentence for an answer that would otherwise show only an HTTP status (opus-1984 N4): the server's own
 * sentence when it gave one, else what the status means for the person.
 */
export function statusSentence(status: number, body: unknown, fallback: string): string {
    const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
    if (typeof error === 'string' && error.trim()) return error;
    if (status === 401) return t('Your sign-in has ended or this change needs a code. Sign in again, then try once more.');
    if (status === 403) return t('Only an owner can make this change.');
    if (status === 404) return t('This server does not offer that any more. Update the server, then try again.');
    if (status === 400) return t('The server did not accept that setting. Check it and try again.');
    if (status === 429) return t('Too many tries. Wait a minute, then try again.');
    if (status >= 500) return t('The server had a problem. Nothing was changed. Try again in a minute.');
    return fallback;
}
