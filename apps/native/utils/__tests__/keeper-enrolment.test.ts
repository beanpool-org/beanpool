import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the rewritten keeper enrolment — the two-layer model.
 *
 * The old test file tested device fragments, inviter candidates, and storage probes,
 * all of which are retired. Under the two-layer model:
 *
 * - At signup: sovereign (nothing stored, nothing uploaded).
 * - SSO tier: splitHubAndWhole → hub + sealed SSO fragment → POST /api/recovery/shares/sso.
 * - Friend tier: splitTwoLayer → hub + friend shares → POST /api/recovery/shares.
 *
 * SSO and friend enrolment are separate, user-initiated flows called AFTER signup.
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => 'https://test.beanpool.org') },
}));

vi.mock('expo-file-system/legacy', () => ({
    documentDirectory: 'file:///docs/',
    EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: vi.fn(async () => {}),
    deleteAsync: vi.fn(async () => {}),
}));

vi.mock('../crypto', () => ({
    buildSignedHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })),
    encodeBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
    mnemonicToSeed: vi.fn(async () => new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff)),
}));

import { enrolKeepers } from '../keeper-enrolment';

const IDENTITY = {
    publicKey: 'aa'.repeat(32),
    privateKey: 'bb'.repeat(32),
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

// ---------------------------------------------------------------------------
// Signup — sovereign by default
// ---------------------------------------------------------------------------

describe('enrolKeepers at signup — sovereign', () => {
    it('returns sovereign (nothing enrolled) for every member at signup', async () => {
        const result = await enrolKeepers(IDENTITY);
        expect(result.enrolled).toEqual([]);
        expect(result.generation).toBeNull();
        expect(result.available).toBe(0);
        expect(result.error).toBeUndefined();
    });

    it('never throws — the never-throws contract is unchanged', async () => {
        // The call site (welcome.tsx) wraps this in .catch() anyway, but the contract is
        // that it should never throw. This is true for all inputs, including bad ones.
        await expect(enrolKeepers(IDENTITY)).resolves.toBeDefined();
        await expect(enrolKeepers({ ...IDENTITY, mnemonic: [] })).resolves.toBeDefined();
        await expect(enrolKeepers({ ...IDENTITY, mnemonic: undefined })).resolves.toBeDefined();
    });

    it('does not touch fetch at all — no network calls at signup', async () => {
        const spy = vi.fn();
        global.fetch = spy as any;
        await enrolKeepers(IDENTITY);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not write any files — no device fragment', async () => {
        const FileSystem = await import('expo-file-system/legacy');
        vi.mocked(FileSystem.writeAsStringAsync).mockClear();
        await enrolKeepers(IDENTITY);
        expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
    });

    it('returns empty skipped array — nothing was attempted', async () => {
        const result = await enrolKeepers(IDENTITY);
        expect(result.skipped).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe('EnrolledKeeper type — device is retired', () => {
    it("'device' is not a valid enrolled keeper", async () => {
        // The type no longer includes 'device'. This test verifies the runtime
        // contract: the function never returns 'device' in enrolled.
        const result = await enrolKeepers(IDENTITY);
        expect(result.enrolled).not.toContain('device');
    });
});
