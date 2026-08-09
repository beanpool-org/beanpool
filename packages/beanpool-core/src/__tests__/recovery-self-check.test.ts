import { describe, it, expect, afterEach, vi } from 'vitest';
import { checkRecoveryWorksHere, rebuildSet } from '../recovery-self-check.js';
import * as split from '../recovery-split.js';
import { RECOVERY_THRESHOLD } from '../recovery-split.js';
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

    it('blames the CSPRNG rather than the cipher when the seal stage reports entropy trouble', async () => {
        // Generating the throwaway keypair now sits inside the seal try/catch, because it reads
        // crypto.getRandomValues like every other step and the contract here is "never throws".
        // That enclosure cannot be tested directly — noble defines `ed25519.getPublicKey` as
        // non-configurable, so it cannot be made to throw — but the classification it feeds can
        // be, and that is the part with a decision in it.
        vi.spyOn(keeperCrypto, 'sealShareToMember').mockImplementation(() => {
            throw new Error('crypto.getRandomValues is not a function');
        });
        await expect(checkRecoveryWorksHere()).resolves.toMatchObject({ ok: false, failedAt: 'csprng' });
    });

    it('rebuilds from exactly the threshold, leaving a fragment spare', async () => {
        const combine = vi.spyOn(split, 'combineRecoveryPhrase');
        const splitSpy = vi.spyOn(split, 'splitRecoveryPhrase');
        expect(await checkRecoveryWorksHere()).toEqual({ ok: true });

        const [, keeperCount] = splitSpy.mock.calls[0];
        expect(combine.mock.calls[0][0]).toHaveLength(RECOVERY_THRESHOLD);
        // Strictly more keepers than the threshold is what makes this "any three of them"
        // rather than "all of them" — the promise the model actually makes to a member.
        expect(keeperCount).toBeGreaterThan(RECOVERY_THRESHOLD);
    });

    // The selection is tested apart from the check because inside it the property is invisible:
    // at a threshold of 3, "take the first two plus the reopened one" and a hard-coded
    // `[0], [1], opened` produce identical results. Mutation-checking proved the point — the
    // hard-coded version failed no test. These run it at thresholds the constant never takes.
    describe('rebuildSet', () => {
        it.each([3, 4, 5, 8])('returns exactly %i fragments at that threshold', (threshold) => {
            const fragments = Array.from({ length: threshold + 1 }, (_, i) => i);
            const set = rebuildSet(fragments, 99, threshold);
            expect(set).toHaveLength(threshold);
            expect(set[set.length - 1]).toBe(99);
        });

        it.each([3, 4, 5, 8])('never reuses the fragment that was sealed, at threshold %i', (threshold) => {
            // CHECK_KEEPERS is threshold + 1 and the sealed fragment is the last, so the front
            // slice must stop short of it. Reusing it would mean the rebuild secretly depends on
            // the same fragment twice, which raw Shamir rejects — turning a real device failure
            // into a confusing one.
            const fragments = Array.from({ length: threshold + 1 }, (_, i) => i);
            const sealed = fragments[fragments.length - 1];
            expect(rebuildSet(fragments, 99, threshold)).not.toContain(sealed);
        });

        it('takes from the front, so the spare is always the untouched one', () => {
            expect(rebuildSet(['a', 'b', 'c', 'd'], 'opened', 3)).toEqual(['a', 'b', 'opened']);
        });
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
