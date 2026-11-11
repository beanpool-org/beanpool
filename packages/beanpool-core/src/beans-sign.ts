/**
 * The "Beans accepted here" sign (Rob, via Marty, 11 Nov 2026): a printable page for a shop's window (A4) or a stall (A6),
 * made on the phone or in the browser from a shop's page (its keepers) or the community's page (anyone). It says "Beans
 * accepted here", the community's name and BeanPool's mark, and carries a QR code that opens the community's own public page at its
 * own address, the address the phone or browser is already using. Nothing on it names beanpool.org: a community on its own domain,
 * or on a plain IP, prints a sign for that (memory: no domain lock-in).
 *
 * Pure: no React Native, no DOM, no Node built-ins, no outside file. The code arrives as data (a QrMatrix, made by
 * qr-matrix.ts) and is drawn by lights-out-poster.ts's own drawing, so no markup of a caller's reaches the page. The mark
 * arrives as a PNG data URI, or not at all: the word "BeanPool" stands for it, so a sign is still whole with no image.
 *
 * Printed in black and white too: every word and the code are black on white, and the one brand colour (the commit green) is
 * only the frame's line, so a sign on a black-and-white printer loses nothing but a grey. The page sets its own paper
 * (`@page size`, in millimetres: browsers do not all know the keyword A6), so a browser's "Save as PDF" and a phone's PDF both
 * come out A4 or A6, portrait.
 *
 * Words: one table of `word()` keys, shown with `w.t()` where each is drawn (the apps with their own `t`, in the member's language).
 * "BeanPool" is the mark and is never translated.
 */
import { BRAND_COLOURS } from './brand-colours.js';
import { PRINTED_RTL_LANGS, printedEscapeHtml, printedQrSvg, type QrMatrix } from './lights-out-poster.js';
import { word, type Words } from './words.js';

export const BEANS_SIGN_WORDS = {
    /** The sign's headline, and the page's title. */
    title: word('Beans accepted here'),
    /** Under the code. A phone's camera opens the community's page; no app is needed first. */
    scan: word('Scan this code with your phone camera to find our community.'),
    /** Before the address, for a person who would rather type it. */
    orType: word('Or type this address:'),
    /** The heading over the two buttons, on a shop's page and the community's page. */
    heading: word('A sign for your window or stall'),
    /** The two buttons: the A4 window sign, and the A6 stall card. */
    a4: word('Make a window sign (A4)'),
    a6: word('Make a stall card (A6)'),
    /** Said when the sign could not be made (no address to point at, or the code or the PDF failed): never a false success. */
    failed: word('The sign couldn’t be made. Try again.'),
} as const;

export type BeansSignSize = 'a4' | 'a6';

/** Both sizes: portrait paper in millimetres (for the page) and in points (for a phone's PDF maker), and the page's measures. */
export const BEANS_SIGN_SIZES = {
    a4: { widthMm: 210, heightMm: 297, widthPt: 595, heightPt: 842, marginMm: 12, borderMm: 3, radiusMm: 6, padMm: 8, headlinePt: 52, communityPt: 28, scanPt: 18, addressPt: 14, brandPt: 22, qrMm: 100, logoMm: 16 },
    a6: { widthMm: 105, heightMm: 148, widthPt: 298, heightPt: 420, marginMm: 5, borderMm: 1.6, radiusMm: 3, padMm: 4, headlinePt: 21, communityPt: 12, scanPt: 8.5, addressPt: 7, brandPt: 10, qrMm: 50, logoMm: 7.5 },
} as const;

export interface BeansSignOptions {
    size: BeansSignSize;
    /** The community's name, large under the headline. */
    communityName: string;
    /** The community's address as a person types it ("mullum.beanpool.org"): printed under the code. See {@link beansSignAddress}. */
    address: string;
    /** The code, from the community's own address ({@link beansSignUrl}); anything that is not a QrMatrix makes no sign. */
    qr: QrMatrix;
    /** BeanPool's mark as `data:image/png;base64,…`. Left out, or anything else, the word "BeanPool" stands alone. */
    logoDataUri?: string;
}

/** The ink for the frame: the brand's own fill, from the central tokens (brand-colours.ts), never a hex of this page's own. */
export const BEANS_SIGN_FRAME = BRAND_COLOURS.commit.fill.light;

/**
 * Where the code leads: the community's own address, as a web page at its root (the public page a stranger at the address
 * reads: apps/server routes/community-card.ts). The scheme, host and port the caller holds, whatever domain or IP that is; any
 * path, query or fragment is dropped. Throws on an address that is not an http(s) one.
 */
export function beansSignUrl(communityAddress: string): string {
    const url = new URL(communityAddress);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('A sign needs a web address.');
    return `${url.protocol}//${url.host}/`;
}

/** The address as it is printed to be typed: no scheme where it is https (the usual), no trailing slash. */
export function beansSignAddress(communityAddress: string): string {
    const url = beansSignUrl(communityAddress);
    return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}

const LOGO_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
/** A mark larger than this is not put in the page (the apps hand the 512 px logo, about 0.5 MB as text). */
const LOGO_MAX_CHARS = 2_000_000;

function css(size: BeansSignSize): string {
    const s = BEANS_SIGN_SIZES[size];
    // One page, never two: the sheet is a little shorter than the paper inside its margins.
    const sheetMm = s.heightMm - 2 * s.marginMm - 3;
    return `
@page { size: ${s.widthMm}mm ${s.heightMm}mm; margin: ${s.marginMm}mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; background: #fff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.2; }
.sheet { height: ${sheetMm}mm; border: ${s.borderMm}mm solid ${BEANS_SIGN_FRAME}; border-radius: ${s.radiusMm}mm; padding: ${s.padMm}mm; display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; overflow: hidden; break-inside: avoid; }
.mark { display: flex; align-items: center; justify-content: center; gap: ${s.padMm / 2}mm; }
.logo { width: ${s.logoMm}mm; height: ${s.logoMm}mm; display: block; }
.brand { font-size: ${s.brandPt}pt; font-weight: 800; letter-spacing: 0.02em; direction: ltr; unicode-bidi: isolate; }
h1 { margin: 0; font-size: ${s.headlinePt}pt; line-height: 1.05; font-weight: 800; overflow-wrap: anywhere; }
.community { margin: 0; font-size: ${s.communityPt}pt; font-weight: 700; overflow-wrap: anywhere; }
.qr { flex: none; width: ${s.qrMm}mm; height: ${s.qrMm}mm; }
.qr svg { width: 100%; height: 100%; display: block; }
.scan { margin: 0; font-size: ${s.scanPt}pt; font-weight: 600; }
.address { margin: 0; font-size: ${s.addressPt}pt; overflow-wrap: anywhere; }
.url { direction: ltr; unicode-bidi: isolate; font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; }
@media print { .sheet { break-inside: avoid; } }
`;
}

/**
 * The sign as one self-contained page. `w` is the reader's words (the apps' `currentWords()`). Every text is escaped; the
 * code is drawn from its modules; the mark is read only if it is a plain PNG data URI. Throws when the code is not a code,
 * so a caller shows "couldn't be made" and prints no blank frame.
 */
export function beansSignHtml(w: Pick<Words, 'lang' | 't'>, o: BeansSignOptions): string {
    // Own names only: `in` also finds "constructor" and "toString", which would draw a page with no paper.
    if (!Object.prototype.hasOwnProperty.call(BEANS_SIGN_SIZES, o.size)) throw new Error('A sign is A4 or A6.');
    const qr = printedQrSvg(o.qr);
    if (!qr) throw new Error('A sign needs a code.');
    const W = BEANS_SIGN_WORDS;
    const logo = typeof o.logoDataUri === 'string' && o.logoDataUri.length <= LOGO_MAX_CHARS && LOGO_DATA_URI.test(o.logoDataUri)
        ? `<img class="logo" alt="" src="${o.logoDataUri}">`
        : '';
    const dir = PRINTED_RTL_LANGS.has(w.lang) ? 'rtl' : 'ltr';
    const title = printedEscapeHtml(w.t(W.title));
    return `<!doctype html>
<html lang="${printedEscapeHtml(w.lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css(o.size)}</style>
</head>
<body>
<main class="sheet">
<div class="mark">${logo}<span class="brand">BeanPool</span></div>
<h1>${title}</h1>
<p class="community"><bdi>${printedEscapeHtml(o.communityName)}</bdi></p>
<div class="qr" role="img" aria-label="${printedEscapeHtml(o.address)}">${qr}</div>
<p class="scan">${printedEscapeHtml(w.t(W.scan))}</p>
<p class="address">${printedEscapeHtml(w.t(W.orType))} <span class="url">${printedEscapeHtml(o.address)}</span></p>
</main>
</body>
</html>
`;
}
