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

/** The pairing screen's route for a pairing link (`/pair-device?qr=<the whole link>`), or null for any other path. */
export function pairRouteFromSystemPath(path: unknown): string | null {
    const link = pairLinkFromSystemPath(path);
    return link === null ? null : `/pair-device?qr=${encodeURIComponent(link)}`;
}

/** A pairing link, so the root layout's invite reader leaves it alone (its `node=` is not an invite's server). */
export function isPairLink(url: unknown): boolean {
    return pairLinkFromSystemPath(url) !== null;
}
