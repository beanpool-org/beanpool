/**
 * The membership probe, `GET /api/community/membership/<key>`, as the phone asks it everywhere: its own community
 * (NodeStatusContext, Settings, People), the other communities it saved (delete-here.ts, use-communities.ts), and an
 * invite's (the deep link, invite-next.ts).
 *
 * A community answers it only to a request signed by the key it asks about, and refuses anyone else (401 unsigned,
 * 403 signed by another key): otherwise anyone holding a member's key (every member sees the others' keys) could ask
 * each community whether that person is in it (multi-community review F3). The phone only ever asks about its own key,
 * so it signs with it, for the host it asks (request binding: no good at any other community). A request to the phone's
 * own community already carries the signature, so the read-signing wrapper leaves it as it is.
 */
import { buildSignedHeaders } from './crypto';

/** The key asked about: the whole key, to sign with, or only its public half, signed with when it is the phone's. */
export type ProbeKey = string | { publicKey: string; privateKey: string };

/**
 * Ask `community` whether `key` is one of its members, signed by that key. Given only a public key, signs with the key
 * on the phone when it is that one; any other goes unsigned, and the community refuses it, which every caller reads as
 * no answer. Throws what fetch throws, and node-url.ts UnsafeNodeAddressError for an address that isn't plain.
 */
export async function fetchMembership(community: string, key: ProbeKey, signal?: AbortSignal): Promise<Response> {
    const publicKey = typeof key === 'string' ? key : key.publicKey;
    // Through the identity module, the one reader of the stored key, and only when the caller has no key to hand.
    const signer = typeof key === 'string' ? await (await import('./identity')).loadIdentity() : key;
    const target = `${community.replace(/\/+$/, '')}/api/community/membership/${publicKey}`;
    const signed = signer?.privateKey && signer.publicKey === publicKey
        ? await buildSignedHeaders('GET', target, '', signer.privateKey, signer.publicKey)
        : {};
    return fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json', ...signed },
        ...(signal ? { signal } : {}),
    });
}
