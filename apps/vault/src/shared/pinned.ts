import { isVaultKeyHex } from '@beanpool/core';

declare const __BEANPOOL_VAULT_ROOT_KEYS__: readonly string[] | undefined;

/**
 * The vault's genesis custodian keys, baked into the release build by `scripts/bundle.mjs` (esbuild `define`): the root
 * every release is checked from (release.ts `resolveChain`). The API checks releases against the keys it was built
 * with, and a config file can't change them. Null when run from source (tests, a rehearsal), where the caller passes
 * the keys itself.
 */
export const BUILT_ROOT_KEYS: readonly string[] | null = typeof __BEANPOOL_VAULT_ROOT_KEYS__ === 'undefined'
    ? null
    : __BEANPOOL_VAULT_ROOT_KEYS__;

/** Three different custodian keys, or an error saying what is wrong. */
export function checkRootKeys(keys: unknown): readonly string[] {
    if (!Array.isArray(keys) || keys.length !== 3 || !keys.every(isVaultKeyHex) || new Set(keys).size !== 3) {
        throw new Error('The root keys are the vault\'s three genesis custodian keys (64 lower-case hex characters each).');
    }
    return keys as string[];
}

/** The baked keys when there are any; otherwise the ones given; otherwise none (no release is ever trusted). */
export function rootKeysFor(given: unknown): readonly string[] | null {
    if (BUILT_ROOT_KEYS) return checkRootKeys(BUILT_ROOT_KEYS);
    return given === undefined || given === null ? null : checkRootKeys(given);
}
