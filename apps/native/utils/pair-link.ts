/**
 * The web app's pairing QR (`beanpool://pair?session=…&pub=…&node=…`, apps/pwa WelcomePage) opened from the phone's
 * camera app, or any app that hands the link on, rather than scanned inside BeanPool. The app has no `pair` route, so
 * Expo Router showed Unmatched Route; app/+native-intent.ts sends it to the pairing screen instead.
 *
 * Only the route is decided here. The link goes to the screen whole, as the text a scan would have read, and the
 * screen reads it with the same strict grammar and the same saved-server rule as a scan (pair-device-target.ts
 * readPairingCode). Nothing is checked, trusted or sent on the way: the confirmation, the phone's unlock and the two
 * digits are all still the screen's.
 *
 * Kept free of the screen's imports, so +native-intent.ts can route the link without loading the camera or the signer.
 */

/**
 * `beanpool://pair?…` in the spellings a system hands over: the link itself, `beanpool:///pair?…` (some normalisers add
 * a slash), and the bare `pair?…` / `/pair?…` path forms, on Android and iOS, cold start and warm. `pair` must be the
 * whole first segment (`pairing`, `pair-device` are not it); one trailing slash after it is dropped, as it carries
 * nothing. Everything from the `?` on is kept exactly as it came, so the grammar judges what was in the QR.
 */
const PAIR_PATH = /^(?:beanpool:\/\/\/?|\/)?pair\/?(?=[?#]|$)/i;

/** The pairing link a system path stands for, rebuilt as `beanpool://pair` + its query exactly as given, or null. */
export function pairLinkFromSystemPath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const m = PAIR_PATH.exec(path);
    if (!m) return null;
    return `beanpool://pair${path.slice(m[0].length)}`;
}

/** The longest code the grammar reads (pair-device-target.ts parsePairingQr). */
const MAX_LINK = 600;

/**
 * The pairing screen's route for a pairing link (`/pair-device?qr=<the whole link, as hex>`), or null for any other path.
 *
 * Hex, not percent-encoding: Expo Router decodes a route's query once when it reads the path, and useLocalSearchParams
 * decodes every value AGAIN (expo-router 55 build/hooks.js). A percent-encoded link reached the screen with its `node=`
 * unescaped (`https://…`), and the grammar refused every real code (seen on the emulator, #2025 fix round 1). Hex has
 * nothing to decode, however many times it is decoded; the screen turns it back into the link exactly (pairLinkFromRoute).
 * A link longer than the grammar takes is cut to one character over it: still refused, and the route stays small.
 */
export function pairRouteFromSystemPath(path: unknown): string | null {
    const link = pairLinkFromSystemPath(path);
    if (link === null) return null;
    // Four hex digits per UTF-16 code unit: any string, and back exactly.
    let hex = '';
    for (let i = 0; i < Math.min(link.length, MAX_LINK + 1); i++) hex += link.charCodeAt(i).toString(16).padStart(4, '0');
    return `/pair-device?qr=${hex}`;
}

/** The link a route's `qr` carries (pairRouteFromSystemPath), exactly; '' for anything that isn't that hex: unreadable. */
export function pairLinkFromRoute(qr: unknown): string {
    if (typeof qr !== 'string' || qr.length % 4 !== 0 || !/^[0-9a-f]*$/.test(qr)) return '';
    let link = '';
    for (let i = 0; i < qr.length; i += 4) link += String.fromCharCode(parseInt(qr.slice(i, i + 4), 16));
    return link;
}

/** A pairing link, so the root layout's invite reader leaves it alone (its `node=` is not an invite's server). */
export function isPairLink(url: unknown): boolean {
    return pairLinkFromSystemPath(url) !== null;
}
