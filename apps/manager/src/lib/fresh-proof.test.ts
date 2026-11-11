import { describe, expect, it } from 'vitest';
import {
    FRESH_PROOF_WORDS,
    FreshProofRequiredError,
    freshProofRefusal,
    freshProofRefusalOf,
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

        it('reads no typed-code ask: the server never sends totpRequired, so a 401 that carries it is no refusal', () => {
            expect(freshProofRefusal(401, { totpRequired: true, error: 'Invalid authenticator code' })).toBeNull();
            expect(freshProofRefusal(401, { totpRequired: true })).toBeNull();
            expect(freshProofRefusal(403, { totpRequired: true, error: 'Owners only' })).toBeNull();
        });

        it('keeps the error as an empty string when the answer carries none', () => {
            expect(freshProofRefusal(403, { code: 'step_up_required' })).toEqual({ kind: 'step-up', error: '' });
            expect(freshProofRefusal(403, { code: 'phone_required' })).toEqual({ kind: 'phone', error: '' });
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

        it('no longer knows the needs-2fa refusal: the server has no 2FA to turn on', () => {
            expect(
                freshProofRefusal(403, {
                    code: 'fresh_proof_needs_2fa',
                    error: 'Enable 2FA first',
                })
            ).toBeNull();
            expect('needs2fa' in FRESH_PROOF_WORDS).toBe(false);
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

        it('returns the refusal in a 403 response', async () => {
            const res = new Response(
                JSON.stringify({ code: 'step_up_required', error: 'Press Manage on your phone again' }),
                { status: 403 }
            );
            expect(await freshProofRefusalOf(res)).toEqual({
                kind: 'step-up',
                error: 'Press Manage on your phone again',
            });
            // Read from a clone: the caller can still read the body.
            expect(await res.json()).toMatchObject({ code: 'step_up_required' });
        });

        it('returns null for a 401 that carries the old totpRequired: it is no refusal any more', async () => {
            const res = new Response(
                JSON.stringify({ totpRequired: true, error: 'Code needed' }),
                { status: 401 }
            );
            expect(await freshProofRefusalOf(res)).toBeNull();
        });
    });

    describe('throwIfFreshProof', () => {
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
            // The needs-2fa refusal is gone with the server's 2FA: it is an ordinary answer now.
            expect(() => throwIfFreshProof(403, { code: 'fresh_proof_needs_2fa', error: 'Enable 2FA first' })).not.toThrow();
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
                    kind: 'phone',
                    error: 'Use your phone',
                },
            };
            expect(refusalOf(customErr)).toEqual({
                kind: 'phone',
                error: 'Use your phone',
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
            // The needs-2fa kind was removed with the server's 2FA, and the typed-code kind with the code box.
            expect(refusalOf({ refusal: { kind: 'needs-2fa', error: 'Test' } })).toBeNull();
            expect(refusalOf({ refusal: { kind: 'code', error: 'Code required' } })).toBeNull();
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
            expect(FRESH_PROOF_WORDS.cancel).toBe('Cancel');
            expect(FRESH_PROOF_WORDS.stepUp).toBe('Press Manage on your phone again, then make this change within 90 seconds.');
            expect(FRESH_PROOF_WORDS.phone).toBe('Do this from your phone: open BeanPool, press Manage, then make this change there.');
        });

        it('has no word for a typed code: no authenticator app, no current code, no Confirm', () => {
            expect(Object.keys(FRESH_PROOF_WORDS).sort()).toEqual(['cancel', 'phone', 'stepUp']);
            expect(JSON.stringify(Object.values(FRESH_PROOF_WORDS))).not.toMatch(/authenticator|current code|backup code/i);
        });
    });
});
