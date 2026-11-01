/**
 * A community's voucher (vault rethink VR4; core vault-wire.ts "Vouchers"): this server's statement to BeanPool's key vault
 * that its admin saw a member in person and typed the number on a new phone, signed with this server's node key
 * (data/libp2p_key). A bring-back's release is worked out inside synchronous reads and the node key signs asynchronously,
 * so the engine says what the voucher will say (engine/bring-back.ts `voucherFor`) and the route signs it here, on its way
 * out. The node key is the one thing a shared placement needs of this server's identity, and it needs nothing of ours: this
 * server never calls the vault, and the phone carries the voucher there.
 */

import { joinVaultVoucher, vaultVoucherToSign, type VaultVoucher } from '@beanpool/core';
import { getPrivateKey } from '../p2p.js';
import { nodePubkeyHex } from './registrar-client.js';

/** This server has no node key to sign with yet (it is still starting). The route answers 503, and the phone asks again. */
export class NodeKeyNotReady extends Error {
    readonly code = 'node_key_not_ready';
    constructor() {
        super('This server is still starting. Try again in a moment.');
    }
}

/** The key this server's vouchers are signed with (hex), or null while it has none. */
export function nodeKeyHex(): string | null {
    return getPrivateKey() ? nodePubkeyHex() : null;
}

/** A release's answer with its voucher signed, if it needs one. Anything else goes through as it came. */
export async function withVoucher<T extends object>(answer: T): Promise<Omit<T, 'voucherFor'> & { voucher?: string }> {
    const { voucherFor, ...rest } = answer as T & { voucherFor?: Omit<VaultVoucher, 'v' | 'community'> };
    if (!voucherFor) return rest;
    const key = getPrivateKey();
    if (!key) throw new NodeKeyNotReady();
    const { payloadB64, bytes } = vaultVoucherToSign({ v: 1, community: nodePubkeyHex(), ...voucherFor });
    return { ...rest, voucher: joinVaultVoucher(payloadB64, await key.sign(bytes)) };
}
