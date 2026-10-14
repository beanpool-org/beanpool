/**
 * Where "Use your account on another device" may send the account (fable-security-signin finding 1, round 2).
 *
 * The QR names the server that relays the account. The relay's number matching (pairing-relay.ts) only holds on an
 * honest server: a hand-made QR naming the sender's own server could skip it. So the phone sends the key and the
 * 12 words only to a server it already uses (the community it is on, or one in its saved list), the way the Settings
 * QR sign-in only signs in to the phone's own community (settings-signin.ts readSigninScan). Any other host: nothing
 * is sent. Moving to a brand-new community's server by QR is therefore not possible; the 12 words still are.
 */
import { isSameNode, nodeOrigin } from '@beanpool/core';

export type TransferTarget =
    | { kind: 'ok'; nodeUrl: string }
    /** The QR names a server this phone does not use. */
    | { kind: 'foreign'; scannedHost: string }
    /** No server in the QR and none on the phone. */
    | { kind: 'no-node' };

/**
 * @param scannedNodeUrl the QR's `node=` (or a plain link's origin); empty means "this phone's community"
 * @param appNodeUrl the community this phone is on (`beanpool_anchor_url`)
 * @param savedNodeUrls the phone's saved communities (utils/nodes getSavedNodes)
 */
export function transferTarget(scannedNodeUrl: string, appNodeUrl: string | null, savedNodeUrls: readonly string[]): TransferTarget {
    const scanned = (scannedNodeUrl || '').trim();
    if (!scanned) return appNodeUrl && nodeOrigin(appNodeUrl) ? { kind: 'ok', nodeUrl: appNodeUrl } : { kind: 'no-node' };
    const known = [appNodeUrl, ...savedNodeUrls].filter((u): u is string => !!u);
    if (known.some((u) => isSameNode(scanned, u))) return { kind: 'ok', nodeUrl: scanned };
    const origin = nodeOrigin(scanned);
    return { kind: 'foreign', scannedHost: origin ? origin.replace(/^https?:\/\//, '') : scanned.slice(0, 80) };
}
