import { describe, expect, it } from 'vitest';
import {
    FRESH_PROOF_WORDS,
    FreshProofRequiredError,
    SECOND_FACTOR_ASK,
    SecondFactorRequiredError,
    freshProofRefusal,
    freshProofRefusalOf,
    isSecondFactorAsk,
    isSecondFactorAskOf,
    proofField,
    proofHeader,
    refusalOf,
    statusSentence,
    throwIfFreshProof,
} from './fresh-proof';

describe('fresh-proof lib module', () => {
    describe('freshProofRefusal', () => {
        it('returns null for invalid or empty body', () => {
            expect(freshProofRefusal(401, null)).toBeNull();
            expect(freshProofRefusal(401, 'not-an-object')).toBeNull();
            expect(freshProofRefusal(200, { ok: true })).toBeNull();
        });

        it('returns null when 401 is checkAdminAuth second-factor ask', () => {
            expect(
                freshProofRefusal(401, {
                    totpRequired: true,
                    error: SECOND_FACTOR_ASK,
                })
            ).toBeNull();
        });

        it('returns code refusal for 401 totpRequired with standard error message', () => {
            const refusal = freshProofRefusal(401, {
                totpRequired: true,
                error: 'Invalid authenticator code',
            });
            expect(refusal).toEqual({
                kind: 'code',
                error: 'Invalid authenticator code',
            });
        });

        it('returns code refusal with empty string when error is not a string', () => {
            const refusal = freshProofRefusal(401, {
                totpRequired: true,
            });
            expect(refusal).toEqual({
                kind: 'code',
                error: '',
            });
        });

        it('returns phone refusal for 403 phone_required or phoneRequired flag', () => {
            expect(
                freshProofRefusal(403, {
                    code: 'phone_required',
                    error: 'Phone unlock required',
                })
            ).toEqual({
                kind: 'phone',
                error: 'Phone unlock required',
            });

            expect(
                freshProofRefusal(403, {
                    phoneRequired: true,
                    error: 'Phone required flag set',
                })
            ).toEqual({
                kind: 'phone',
                error: 'Phone required flag set',
            });
        });

        it('returns step-up refusal for 403 step_up_required', () => {
            expect(
                freshProofRefusal(403, {
                    code: 'step_up_required',
                    error: 'Press Manage on phone',
                })
            ).toEqual({
                kind: 'step-up',
                error: 'Press Manage on phone',
            });
        });

        it('returns needs-2fa refusal for 403 fresh_proof_needs_2fa', () => {
            expect(
                freshProofRefusal(403, {
                    code: 'fresh_proof_needs_2fa',
                    error: 'Enable 2FA first',
                })
            ).toEqual({
                kind: 'needs-2fa',
                error: 'Enable 2FA first',
            });
        });
    });

    describe('freshProofRefusalOf', () => {
        it('returns null for non-401/403 responses', async () => {
            const res = new Response(JSON.stringify({ ok: true }), { status: 200 });
            expect(await freshProofRefusalOf(res)).toBeNull();
        });

        it('returns null if response JSON cloning fails', async () => {
            const res = new Response('invalid-json', { status: 401 });
            expect(await freshProofRefusalOf(res)).toBeNull();
        });

        it('returns refusal for 401 refusal response', async () => {
            const res = new Response(
                JSON.stringify({ totpRequired: true, error: 'Code needed' }),
                { status: 401 }
            );
            expect(await freshProofRefusalOf(res)).toEqual({
                kind: 'code',
                error: 'Code needed',
            });
        });
    });

    describe('isSecondFactorAskOf and isSecondFactorAsk', () => {
        it('isSecondFactorAskOf identifies 401 second-factor response', async () => {
            const match = new Response(
                JSON.stringify({ totpRequired: true, error: SECOND_FACTOR_ASK }),
                { status: 401 }
            );
            const nonMatch = new Response(
                JSON.stringify({ totpRequired: true, error: 'Other code error' }),
                { status: 401 }
            );
            const badStatus = new Response(
                JSON.stringify({ totpRequired: true, error: SECOND_FACTOR_ASK }),
                { status: 403 }
            );

            expect(await isSecondFactorAskOf(match)).toBe(true);
            expect(await isSecondFactorAskOf(nonMatch)).toBe(false);
            expect(await isSecondFactorAskOf(badStatus)).toBe(false);
        });

        it('isSecondFactorAskOf returns false when response JSON parsing fails', async () => {
            const badJson = new Response('not-json', { status: 401 });
            expect(await isSecondFactorAskOf(badJson)).toBe(false);
        });

        it('isSecondFactorAsk identifies SecondFactorRequiredError instances', () => {
            expect(isSecondFactorAsk(new SecondFactorRequiredError())).toBe(true);
            expect(isSecondFactorAsk(new Error('Other'))).toBe(false);
            expect(isSecondFactorAsk(null)).toBe(false);
        });
    });

    describe('throwIfFreshProof', () => {
        it('throws SecondFactorRequiredError when second factor ask is present', () => {
            expect(() =>
                throwIfFreshProof(401, {
                    totpRequired: true,
                    error: SECOND_FACTOR_ASK,
                })
            ).toThrow(SecondFactorRequiredError);
        });

        it('throws FreshProofRequiredError with refusal when fresh proof is required', () => {
            try {
                throwIfFreshProof(403, {
                    code: 'phone_required',
                    error: 'Must use phone',
                });
                expect.unreachable('Should have thrown FreshProofRequiredError');
            } catch (err) {
                expect(err).toBeInstanceOf(FreshProofRequiredError);
                const proofErr = err as FreshProofRequiredError;
                expect(proofErr.refusal).toEqual({
                    kind: 'phone',
                    error: 'Must use phone',
                });
                expect(proofErr.status).toBe(403);
                expect(proofErr.code).toBe('phone_required');
            }
        });

        it('does not throw when response body is not a fresh proof refusal', () => {
            expect(() => throwIfFreshProof(200, { ok: true })).not.toThrow();
        });
    });

    describe('refusalOf', () => {
        it('extracts refusal from FreshProofRequiredError', () => {
            const err = new FreshProofRequiredError({
                kind: 'step-up',
                error: 'Manage on phone',
            });
            expect(refusalOf(err)).toEqual({
                kind: 'step-up',
                error: 'Manage on phone',
            });
        });

        it('extracts refusal from custom object carrying refusal property', () => {
            const customErr = {
                refusal: {
                    kind: 'code',
                    error: 'Code required',
                },
            };
            expect(refusalOf(customErr)).toEqual({
                kind: 'code',
                error: 'Code required',
            });
        });

        it('returns null for non-objects or invalid refusal kinds', () => {
            expect(refusalOf(null)).toBeNull();
            expect(refusalOf(new Error('Generic'))).toBeNull();
            expect(
                refusalOf({
                    refusal: { kind: 'unknown-kind', error: 'Test' },
                })
            ).toBeNull();
        });
    });

    describe('proofField and proofHeader', () => {
        it('returns proof object/header for valid trimmed code', () => {
            expect(proofField(' 123456 ')).toEqual({ code: '123456' });
            expect(proofHeader(' ABCD-1234 ')).toEqual({ 'X-Fresh-Proof': 'ABCD-1234' });
        });

        it('returns empty object when code is invalid or missing', () => {
            expect(proofField(undefined)).toEqual({});
            expect(proofField('')).toEqual({});
            expect(proofField('   ')).toEqual({});
            expect(proofField('12')).toEqual({}); // less than 4 chars
            expect(proofHeader('!@#$')).toEqual({}); // invalid chars
        });
    });

    describe('statusSentence', () => {
        it('returns body error message if string and non-empty', () => {
            expect(
                statusSentence(500, { error: ' Custom server failure ' }, 'Fallback')
            ).toBe(' Custom server failure ');
        });

        it('returns default sentences for status codes when body has no error message', () => {
            expect(statusSentence(401, {}, 'Fallback')).toContain('sign-in has ended');
            expect(statusSentence(403, {}, 'Fallback')).toContain('Only an owner');
            expect(statusSentence(404, {}, 'Fallback')).toContain('server does not offer');
            expect(statusSentence(400, {}, 'Fallback')).toContain('did not accept');
            expect(statusSentence(429, {}, 'Fallback')).toContain('Too many tries');
            expect(statusSentence(500, {}, 'Fallback')).toContain('server had a problem');
            expect(statusSentence(503, {}, 'Fallback')).toContain('server had a problem');
        });

        it('returns fallback string for unhandled status codes without body error', () => {
            expect(statusSentence(200, {}, 'Default Fallback')).toBe('Default Fallback');
        });
    });

    describe('FRESH_PROOF_WORDS', () => {
        it('contains expected word keys', () => {
            expect(FRESH_PROOF_WORDS.codeLabel).toBe('Current code');
            expect(FRESH_PROOF_WORDS.confirm).toBe('Confirm');
            expect(FRESH_PROOF_WORDS.cancel).toBe('Cancel');
        });
    });
});
