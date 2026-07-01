import { Buffer } from 'buffer';

/**
 * Creates a deterministic Uint8Array from a JSON object.
 */
export const createSignableBytes = (payload: any): Uint8Array => {
    return new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));
};

/**
 * Reconstructs the Ed25519 Private Key from AsyncStorage bytes, and signs the payload.
 */
export const signPayload = async (privKeyProtobuf: Uint8Array, payload: any): Promise<string> => {
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const privKey = privateKeyFromProtobuf(privKeyProtobuf);
    const payloadBytes = createSignableBytes(payload);
    const signature = await privKey.sign(payloadBytes);
    return Buffer.from(signature).toString('base64');
};

/**
 * Verifies an Ed25519 signature purely from a libp2p PeerId string (which embeds the pubkey).
 */
export const verifySignature = async (peerIdStr: string, payload: any, signatureBase64: string): Promise<boolean> => {
    try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const peerId = peerIdFromString(peerIdStr);
        if (!peerId.publicKey) {
            console.warn('[Crypto] PeerId does not contain an inline public key. Cannot verify.');
            return false;
        }

        const signatureBytes = new Uint8Array(Buffer.from(signatureBase64, 'base64'));
        const payloadBytes = createSignableBytes(payload);

        return await peerId.publicKey.verify(payloadBytes, signatureBytes);
    } catch (e: any) {
        console.error('[Crypto] Signature verification failed:', e.message || e);
        return false;
    }
};
