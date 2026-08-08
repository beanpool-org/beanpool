import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkRecoveryWorksHere } from '../recovery-self-check.js';
import * as split from '../recovery-split.js';
import * as keeperCrypto from '../keeper-crypto.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('recovery self-check', () => {
    it('passes on a device where recovery actually works', async () => {
        expect(await checkRecoveryWorksHere()).toEqual({ ok: true });
    });

    it('reports a missing CSPRNG as a wiring problem, not a broken split', () => {
        // The distinction is the whole point of naming the stages: this one means the expo-crypto
        // polyfill has not been imported, which is fixed in the app, not in the crypto.
        vi.spyOn(split, 'splitRecoveryPhrase').mockRejectedValue(
            new Error('Recovery split needs crypto.getRandomValues, which is missing.'),
        );
        return expect(checkRecoveryWorksHere()).resolves.toMatchObject({ ok: false, failedAt: 'csprng' });
    });

    it('reports a throwing split as a split failure', async () => {
        vi.spyOn(split, 'splitRecoveryPhrase').mockRejectedValue(new Error('shamir exploded'));
        expect(await checkRecoveryWorksHere()).toMatchObject({ ok: false, failedAt: 'split' });
    });

    it('catches a split that returns the wrong number of fragments', async () => {
        vi.spyOn(split, 'splitRecoveryPhrase').mockResolvedValue([new Uint8Array([1])]);
        expect(await checkRecoveryWorksHere()).toMatchObject({ ok: false, failedAt: 'split' });
    });

    it('catches a fragment that passes the tag check and still comes back wrong', async () => {
        // The failure mode the whole function exists for. An engine that returns plausible-looking
        // wrong bytes passes every throw-based check above and would sail through without this.
        vi.spyOn(keeperCrypto, 'openShareAsMember').mockReturnValue(new Uint8Array(32).fill(9));
        const result = await checkRecoveryWorksHere();
        expect(result.ok).toBe(false);
        expect(result.failedAt).toBe('open');
        expect(result.detail).toMatch(/different bytes/);
    });

    it('catches fragments that rebuild a phrase that is not the one they came from', async () => {
        // Raw Shamir's signature failure: too few or mismatched shares return a DIFFERENT valid
        // secret rather than an error. The envelope checksum should turn that into a throw — this
        // asserts the self-check still notices if it ever does not.
        vi.spyOn(split, 'combineRecoveryPhrase').mockResolvedValue('some other twelve words entirely');
        const result = await checkRecoveryWorksHere();
        expect(result.ok).toBe(false);
        expect(result.failedAt).toBe('combine');
        expect(result.detail).toMatch(/not the one they came from/);
    });

    it('reports a throwing combine as a combine failure', async () => {
        vi.spyOn(split, 'combineRecoveryPhrase').mockRejectedValue(new Error('nope'));
        expect(await checkRecoveryWorksHere()).toMatchObject({ ok: false, failedAt: 'combine' });
    });

    it('never throws, whatever fails underneath', async () => {
        // A caller is asking "is this safe to offer?". An exception escaping would make the check
        // itself the thing that breaks enrolment — the opposite of its job.
        vi.spyOn(keeperCrypto, 'sealShareToMember').mockImplementation(() => { throw new Error('boom'); });
        await expect(checkRecoveryWorksHere()).resolves.toMatchObject({ ok: false, failedAt: 'seal' });
    });

    it('never puts a real recovery phrase through the check', async () => {
        // The member's phrase is the most sensitive value in the app and the check does not need
        // it. If someone later wires the real phrase in for realism, this fails.
        const spy = vi.spyOn(split, 'splitRecoveryPhrase');
        await checkRecoveryWorksHere();
        expect(spy).toHaveBeenCalledTimes(1);
        const [phrase] = spy.mock.calls[0];
        expect(phrase).toBe(
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        );
    });
});
