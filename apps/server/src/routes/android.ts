/**
 * The Android APK on the node's local network (lights-out H3; services/apk-mirror.ts holds it):
 *   GET /android                          a short page: the version, size and SHA-256, the three install steps in the
 *                                         reader's language, the download button, the signing certificate;
 *   GET /android/BeanPool-<v>-<code>.apk  the file;
 *   GET /android/link                     for the web app's welcome screen: 200 with the version when it may show its
 *                                         "Get the Android app" link (an APK is held, the operator has not hidden the link).
 *
 * ONLY to a request straight off the local network (direct-lan.ts): never through the tunnel, a proxy or from the
 * internet. Everyone else is answered exactly as for a path that does not exist, so nothing says the file is here (Marty,
 * 4 Nov 2026: spammers who found the node "on the cloud" downloading it over and over would cost the operator data).
 * That is also why this is a middleware, not a route of the router: the router's case check answers /ANDROID with its
 * own 404 for any route it holds, which would say one is there. No public page links here.
 *
 * HIDE_APK_LINK=true in .env hides the web app's link (and the trust page's); the page and the file stay for whoever
 * types the address on the local network.
 */
import fs from 'node:fs';
import type Koa from 'koa';
import { ANDROID_ON_NODE_WORDS as W, type Lang } from '@beanpool/core';
import { wordsIn } from '../member-words.js';
import { cardLanguage, cardStyle, escapeHtml as e, RTL } from './community-card.js';
import { isDirectLanContext } from '../direct-lan.js';
import { servedApk } from '../services/apk-mirror.js';

export const ANDROID_PAGE = '/android';

/** Whether the operator has hidden the link to the page (HIDE_APK_LINK=true in .env). */
export function apkLinkHidden(): boolean {
    return (process.env.HIDE_APK_LINK ?? '').trim().toLowerCase() === 'true';
}

/** Whether this request is shown a link to the page: straight off the local network, an APK held, the link not hidden. */
export function showsApkLink(ctx: Parameters<typeof isDirectLanContext>[0]): boolean {
    return !apkLinkHidden() && isDirectLanContext(ctx) && servedApk() !== null;
}

/** AA:BB:… for a hex digest, as the website and apksigner print a certificate's. */
function colonHex(hex: string): string {
    return (hex.toUpperCase().match(/../g) ?? []).join(':');
}

const PAGE_STYLE = `
.door{margin:1rem 0}
.steps{margin:0 0 1rem;padding-inline-start:1.25rem;display:grid;gap:.5rem}
.digest{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;overflow-wrap:anywhere;word-break:break-all}
h2{font-size:1.15rem;margin:1.25rem 0 .5rem}
p{margin:0 0 .75rem}
`;

/** The page, in `lang` (English when null): no script, every value escaped. */
export function renderAndroidPage(apk: { version: string; versionCode: number; size: number; sha256: string; certSha256: string; fileName: string } | null,
    lang: Lang | null): string {
    const w = wordsIn(lang);
    const l = lang ?? 'en';
    const body = apk ? `<p>${e(w.t(W.fromHere))}</p>
<p><strong>${e(w.t(W.sameApp))}</strong></p>
<a class="door primary" data-apk="download" href="${e(`${ANDROID_PAGE}/${encodeURIComponent(apk.fileName)}`)}" download="${e(apk.fileName)}">${e(w.t(W.download, { version: apk.version }))}</a>
<p data-apk="facts">${e(w.t(W.facts, { version: apk.version, mb: String(Math.round(apk.size / 1_000_000)) }))}</p>
<p class="digest" data-apk="sha256">${e(w.t(W.fileDigest, { sha256: apk.sha256 }))}</p>
<h2>${e(w.t(W.installHeading))}</h2>
<ol class="steps">
<li>${e(w.t(W.stepOpen))}</li>
<li>${e(w.t(W.stepAllow))}</li>
<li>${e(w.t(W.stepConfirm))}</li>
</ol>
<p>${e(w.t(W.certificate))}</p>
<p class="digest" data-apk="cert">${e(colonHex(apk.certSha256))}</p>` : `<p data-apk="none">${e(w.t(W.noneYet))}</p>`;
    return `<!doctype html>
<html lang="${e(l)}"${RTL.has(l) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(w.t(W.title))}</title>
<style>${cardStyle()}${PAGE_STYLE}</style>
</head>
<body>
<main>
<div class="card" data-testid="android-on-node">
<h1>${e(w.t(W.title))}</h1>
${body}
</div>
</main>
</body>
</html>`;
}

/** The three answers above, for the HTTPS app (the plain listener hands it these paths from the local network). */
export function androidOnTheLocalNetwork(): Koa.Middleware {
    return async (ctx, next) => {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();
        const p = ctx.path;
        if (p !== ANDROID_PAGE && !p.startsWith(`${ANDROID_PAGE}/`)) return next();
        if (!isDirectLanContext(ctx)) return next();
        const apk = servedApk();
        if (p === ANDROID_PAGE) {
            ctx.vary('Accept-Language');
            ctx.set('Cache-Control', 'no-store');
            ctx.type = 'html';
            ctx.body = renderAndroidPage(apk, cardLanguage(ctx));
            return;
        }
        if (p === `${ANDROID_PAGE}/link`) {
            if (!apk || apkLinkHidden()) return next();
            ctx.set('Cache-Control', 'no-store');
            ctx.body = { version: apk.version, versionCode: apk.versionCode, href: ANDROID_PAGE };
            return;
        }
        if (!apk || p !== `${ANDROID_PAGE}/${apk.fileName}`) return next();
        ctx.set('Cache-Control', 'no-cache');
        ctx.set('Content-Disposition', `attachment; filename="${apk.fileName}"`);
        ctx.set('ETag', `"${apk.sha256}"`);
        ctx.type = 'application/vnd.android.package-archive';
        ctx.length = apk.size;
        if (ctx.method === 'HEAD') { ctx.status = 200; return; }
        ctx.body = fs.createReadStream(apk.file);
    };
}
