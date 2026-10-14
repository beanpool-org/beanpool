import type { AttestationPlatform } from '../shared/ceremony.js';

/**
 * What proves to a custodian which code holds the hello key (host design §5.1 item 2). Only the keyholder calls it,
 * because the process holding the hello key's private half is the one whose code must be measured.
 *
 * `evidence(bind)` returns the platform's signed report over the 64-byte `bind` (ceremony.ts `unlockBind`), or null
 * where there is none. A confidential host (V8, only if D7 picks one) adds an implementation that writes `bind` to
 * Linux's configfs-tsm (`/sys/kernel/config/tsm/report`) and returns the report; the custodian's tool checks it
 * against the host policy in the two-signed release, never against anything the vault says (V3).
 */
export interface Attestor {
    readonly platform: AttestationPlatform;
    evidence(bind: Uint8Array): Promise<Uint8Array | null>;
}

/**
 * No hardware proof: the host can read this vault's memory. The custodian's tool says so in plain words before a
 * share is sent (V3).
 */
export const noneAttestor: Attestor = {
    platform: 'none',
    async evidence(bind: Uint8Array): Promise<Uint8Array | null> {
        if (bind.length !== 64) throw new Error('An unlock binding is 64 bytes.');
        return null;
    },
};
