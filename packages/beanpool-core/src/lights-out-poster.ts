/**
 * The hall poster (lights-out mode, slice H0; scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.6, §2.8, §2.9): what
 * a person standing at a laptop in a hall reads when the internet and the phone network are down, in the reader's language.
 * Four lines for the phone, one line on what the Wi-Fi shows other people, one on how old the record is, and the places for
 * the two codes (the hall door, and the Android app from the laptop).
 *
 * This file is words and a printable page, and nothing else: it builds no code, signs nothing and asks no address. The
 * lights-out switch and the page that serves this one come with slice H1, the hall door in the app with H2, the Android app
 * from the laptop with H3. They call `lightsOutPosterHtml`; an owner can also print it before the lights go out.
 *
 * Words: one table of `word()` keys, shown with `w.t()` where each is drawn (the server renders for a visitor with
 * `wordsFor(lang, catalogs)`; the apps with their own `t`). The four lines are pinned in all 25 languages by
 * __tests__/lights-out-poster.test.ts.
 */
import { word, type Words } from './words.js';

export const LIGHTS_OUT_POSTER_WORDS = {
    title: word('BeanPool works here without the internet.'),
    /** Line 1. Android sends traffic to mobile data when it has any, and an iPhone's Wi-Fi Assist can too (design §2.8). */
    airplane: word('Turn on Airplane mode, then turn Wi-Fi back on.'),
    /** Line 2. Android may ask "Stay connected?" on a Wi-Fi with no internet. */
    joinWifi: word("Join the hall's Wi-Fi. If your phone asks to stay connected, say yes."),
    /** Line 3, beside the first code: beanpool://hall?... The app checks the laptop is the community before it moves. */
    scanApp: word('Open the BeanPool app and scan this code. It takes you to the hall laptop.'),
    /** Line 4, beside the second code: the laptop's /android (slice H3). Printed only when the laptop holds the app. */
    scanAndroid: word('No app on your Android phone? Scan this code to get it from the laptop.'),
    /** Design §2.9: said plainly on the poster. Direct messages and group chats are locked on the phones. */
    readable: word('On this Wi-Fi, what you post and your balance can be read by others on the Wi-Fi. Your messages stay private.'),
    /** Design §2.5, §3.5: the day and the time in the reader's language, never "stale" or "out of date". */
    record: word('The record on this laptop is as of {when}. Trades made since then on the old server are not here.'),
    trouble: word("Can't connect? Check that your phone's date and time are right."),
    wifiName: word('Wi-Fi name'),
    wifiPassword: word('Password'),
    address: word('Laptop address'),
} as const;

/** The four lines for a phone, in order. */
export function lightsOutPosterLines(w: Pick<Words, 't'>): [string, string, string, string] {
    const W = LIGHTS_OUT_POSTER_WORDS;
    return [w.t(W.airplane), w.t(W.joinWifi), w.t(W.scanApp), w.t(W.scanAndroid)];
}

/** What a poster is made from. Every text is shown escaped; the two codes are SVG markup the caller's own code made. */
export interface LightsOutPosterOptions {
    /** The community's name, large under the title. */
    communityName: string;
    /** The laptop's address as a phone types it, for example "192.168.2.1:8080". */
    address: string;
    /** The short form of the node's peer id, so a careful person can compare it; shown in small type under the address. */
    peerShort?: string;
    /** Left out, the poster leaves a line to write on by hand (an owner writes the Wi-Fi name and password on the paper). */
    wifiName?: string;
    wifiPassword?: string;
    /** The record's age already written in the reader's language ("Tue 3 Nov, 14:02"). Left out, the line is not printed. */
    recordAsOf?: string;
    /** The first code (line 3). Left out, an empty frame stands in its place, for the code to be pasted on. */
    hallQr?: string;
    /**
     * The second code (line 4). Left out (undefined), line 4 and its frame are not printed: the laptop does not hold the
     * Android app. An empty string prints line 4 with an empty frame, for a code to be pasted on.
     */
    androidQr?: string;
}

/** Languages written right to left: the page's direction, which every text on it follows. */
const RTL = new Set<string>(['ar', 'fa', 'ur']);

/** First-strong isolate and its end: the date inside a sentence keeps its own order, whichever way the sentence runs. */
const FSI = '⁨';
const PDI = '⁩';

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A code's markup is used only if it is an <svg> with no script or handler in it; anything else prints as an empty frame. */
function safeSvg(markup: string | undefined): string | null {
    if (!markup || !/^\s*<svg[\s>]/i.test(markup)) return null;
    if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed/i.test(markup)) return null;
    return markup;
}

const CSS = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; background: #fff; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.3; }
main { max-width: 182mm; margin: 0 auto; padding: 8mm 0; }
h1 { margin: 0 0 3mm; font-size: 26pt; line-height: 1.15; }
.community { margin: 0 0 4mm; font-size: 20pt; font-weight: 700; }
ol { margin: 0; padding: 0; list-style: none; }
.step { display: flex; align-items: center; gap: 6mm; margin: 0 0 4mm; min-height: 20mm; break-inside: avoid; }
.num { flex: none; width: 14mm; height: 14mm; border: 1.2mm solid #000; border-radius: 50%; font-size: 18pt; font-weight: 700; text-align: center; line-height: 11.6mm; }
.text { flex: 1; font-size: 18pt; }
.qr { flex: none; width: 38mm; height: 38mm; border: 0.6mm solid #000; display: flex; align-items: center; justify-content: center; }
.qr svg { width: 100%; height: 100%; display: block; }
.qr.empty { border-style: dashed; }
.facts { margin: 4mm 0 0; padding: 4mm 0 0; border-top: 0.6mm solid #000; font-size: 14pt; }
.facts p { margin: 0 0 3mm; }
.label { font-weight: 700; }
.blank { display: inline-block; min-width: 70mm; border-bottom: 0.5mm solid #000; height: 1.2em; vertical-align: bottom; }
.address, .peer { direction: ltr; unicode-bidi: isolate; font-family: ui-monospace, Menlo, Consolas, monospace; }
.address { font-size: 20pt; font-weight: 700; }
.peer { font-size: 9pt; }
.small { margin-top: 5mm; font-size: 12pt; }
@media print { main { padding: 0; } }
`;

/**
 * The poster as one self-contained page that prints on A4 (no script, no outside file, black on white). `w` is the reader's
 * words: `wordsFor(lang, catalogs)` on a server, or the app's own. Nothing here asks the internet for anything.
 */
export function lightsOutPosterHtml(w: Pick<Words, 'lang' | 't'>, o: LightsOutPosterOptions): string {
    const W = LIGHTS_OUT_POSTER_WORDS;
    const [airplane, joinWifi, scanApp, scanAndroid] = lightsOutPosterLines(w);
    const hall = safeSvg(o.hallQr);
    const android = o.androidQr === undefined ? undefined : safeSvg(o.androidQr);
    const frame = (svg: string | null) => svg ? `<div class="qr">${svg}</div>` : '<div class="qr empty" aria-hidden="true"></div>';
    const step = (n: number, text: string, code?: string) =>
        `<li class="step"><span class="num" aria-hidden="true">${n}</span><span class="text">${escapeHtml(text)}</span>${code ?? ''}</li>`;
    // What an owner typed (a name, a password) is wrapped in <bdi>: it keeps its own direction and cannot reorder its neighbours.
    const field = (label: string, value: string | undefined) =>
        `<p><span class="label">${escapeHtml(label)}</span> ${value ? `<bdi>${escapeHtml(value)}</bdi>` : '<span class="blank"></span>'}</p>`;
    const dir = RTL.has(w.lang) ? 'rtl' : 'ltr';
    return `<!doctype html>
<html lang="${escapeHtml(w.lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(w.t(W.title))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(w.t(W.title))}</h1>
<p class="community"><bdi>${escapeHtml(o.communityName)}</bdi></p>
<ol>
${step(1, airplane)}
${step(2, joinWifi)}
${step(3, scanApp, frame(hall))}
${android !== undefined ? step(4, scanAndroid, frame(android)) + '\n' : ''}</ol>
<div class="facts">
${field(w.t(W.wifiName), o.wifiName)}
${field(w.t(W.wifiPassword), o.wifiPassword)}
<p><span class="label">${escapeHtml(w.t(W.address))}</span> <span class="address">${escapeHtml(o.address)}</span>${o.peerShort ? ` <span class="peer">${escapeHtml(o.peerShort)}</span>` : ''}</p>
${o.recordAsOf ? `<p>${escapeHtml(w.t(W.record, { when: `${FSI}${o.recordAsOf}${PDI}` }))}</p>\n` : ''}</div>
<p class="small">${escapeHtml(w.t(W.readable))}</p>
<p class="small">${escapeHtml(w.t(W.trouble))}</p>
</main>
</body>
</html>
`;
}
