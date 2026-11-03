/**
 * What Join with an invite's Scan a QR code does with a read (front doors S10, DESIGN-entry-points-fable.md §3.2 item 1):
 * an invite (a link with `invite=`, a code INV-… / BP-…, or an offline ticket BP-…) goes to the invite step as a pasted one does;
 * anything else a camera happens to see (a website's QR, a community's address) is not an invite, and the camera keeps reading.
 */
/** The same shapes Find a community's Scan a code takes as an invite (utils/knock-address.ts `knockScanTarget`), kept here so this file loads alone. */
const INVITE_SHAPE = /[?&]invite=|\b(?:INV|BP)-[A-Z0-9]{4}-[A-Z0-9]{4}/i;

/** The invite a QR read carries, as it is to be handed to the invite step, or null when the read is no invite. */
export function inviteFromScan(data: unknown): string | null {
    const raw = typeof data === 'string' ? data.trim() : '';
    if (!raw) return null;
    if (INVITE_SHAPE.test(raw) || /^(BP|INV)-/.test(raw)) return raw;
    return null;
}
