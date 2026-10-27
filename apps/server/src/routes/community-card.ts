/**
 * A stranger at a community's door (front doors S15, scratch/fable-design/DESIGN-doors-follow-through-fable.md §4.2): the
 * community's public card, in place of a sign-in form.
 *
 *   GET /api/community/card   the card as JSON, for both apps (the web app's welcome page, the phone's card screen)
 *   GET /                     the card as plain HTML (serveCommunityCard, from routes/settings.ts), for a browser with no
 *                             account here at a local community's bare address: no script, Open Graph tags for a chat's
 *                             preview
 *
 * What a stranger may read (Marty, 28 Sep: a local community's listings, its people and its balances are its members'):
 * the card says nothing the directory isn't already told by the same switches (state-engine getDirectoryInfo), and less:
 *   - the name: the community's own (`communityName`), or its address's host where it has none of its own (the default
 *     "BeanPool Community" or blank), never the operator's callsign;
 *   - how many members, only with "Share member count" (`publishMembers`) on;
 *   - the area: the town or area in the owner's words (`areaName`) and the service area's radius, only while "Share
 *     Location & Radius" (`publishLocation`) is on, as the place is (config/community-place.ts). Never a point;
 *   - how it takes new members: requests to join (engine/directory-promise.ts acceptingKnocks, the directory's own word),
 *     anyone (an open door), or by invite.
 * No member's name, key or face, no listing, no balance, no place finer than the area's words: test-community-card.ts
 * reads it as a stranger and checks.
 *
 * The doors on it:
 *   - **Ask to join**, where it takes requests: on an Android phone the BeanPool app's card screen
 *     (`beanpool://community-card?node=…`, as an intent link that falls back to the next door when the app isn't there);
 *     elsewhere the global community's lobby with this community first (`{globalCommunityUrl}/?ask=<host>`), only where
 *     the node names a global community AND is listed in the directory, which the lobby's list is (a community the lobby
 *     doesn't list would be a door to nowhere). Neither: "Ask to join from the BeanPool app", and no link.
 *   - **I have an invite**: the web app's invite form (`/app?door=invite`).
 *   - **Already a member**: the web app's sign-in (`/app?door=signin`).
 *   - **Look around the global community**: the node's global community, where it names one.
 * No domain lock-in (memory no-domain-lock-in): nothing here is fetched or asked of anyone. A node that names no global
 * community (GLOBAL_COMMUNITY_URL=off) links nothing of ours.
 *
 * Words: the visitor's language, from `?lang=` (the website and the web app pass one) or the browser's Accept-Language,
 * read for this answer and never stored; the server's catalogs (apps/server/words), English where a sentence has none.
 */
import Router from '@koa/router';
import type Koa from 'koa';
import {
    brandCssVariableMap, communityCardFacts, communityCardName, normaliseLang, COMMUNITY_CARD_WORDS, WEB_INK_GROUNDS,
    type CommunityCard, type Lang,
} from '@beanpool/core';
import { getLocalConfig } from '../config/local-config.js';
import { getNodeConfig, communityCountsCached, resolvePublicNodeUrl, PUBLIC_URL_RULES } from '../state-engine.js';
import { getNodeProfile, getProfileSwitches } from '../config/node-profile.js';
import { placeShownTo } from '../config/community-place.js';
import { acceptingKnocks } from '../engine/directory-promise.js';
import { getDoor } from '../config/door.js';
import { getGlobalCommunityUrl } from '../config/global-community.js';
import { directoryHeldBack, isDefaultOrEmptyCommunityName } from '../services/directory-publisher.js';
import { wordsIn } from '../member-words.js';
import { useAppDocumentPolicy } from '../app-document-csp.js';
import type { RouteDeps } from './types.js';

/**
 * The web app's hint that this browser keeps an account here (apps/pwa src/lib/account-hint.ts): set while it holds one,
 * cleared at sign-out. Not a credential and never trusted for anything but which page `/` opens: a stranger who sets it
 * gets the web app's welcome page, which shows this same card.
 */
export const ACCOUNT_HINT_COOKIE = 'bp_account_here';

/** The Android app's package, for the intent link that opens its card screen. */
const ANDROID_PACKAGE = 'org.beanpool.pillar';

/** Whether the global community's list holds this community: listed, not held back, and told at least once. */
function listedInDirectory(): boolean {
    return getProfileSwitches().publishToDirectory && directoryHeldBack() === null && !!getNodeConfig().lastDirectoryPush;
}

/** The card as a stranger reads it now. */
export function communityCard(): CommunityCard {
    const config = getNodeConfig();
    const published = resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config);
    const host = published ? published.replace(/^https?:\/\//, '') : null;
    const own = getLocalConfig().communityName;
    const placeShared = placeShownTo({ ownerOrAdmin: false }) !== 'none';
    const door = getDoor();
    const joining = door === 'open' ? 'open' : acceptingKnocks() ? 'requests' : 'invite';
    const global = getGlobalCommunityUrl();
    return {
        name: isDefaultOrEmptyCommunityName(own) ? null : own!.trim(),
        host,
        members: config.publishMembers ? communityCountsCached().memberCount : null,
        area: placeShared && config.areaName
            ? { name: config.areaName, radiusKm: typeof config.serviceRadius?.radiusKm === 'number' ? config.serviceRadius.radiusKm : null }
            : null,
        joining,
        askUrl: global && host && joining === 'requests' && listedInDirectory() ? `${global}/?ask=${encodeURIComponent(host)}` : null,
        globalUrl: global,
    };
}

/** The visitor's language: `?lang=`, else the first language of Accept-Language BeanPool writes, else none (English). */
export function cardLanguage(ctx: Pick<Koa.Context, 'query' | 'get'>): Lang | null {
    const asked = typeof ctx.query.lang === 'string' ? normaliseLang(ctx.query.lang) : null;
    if (asked) return asked;
    for (const part of (ctx.get('Accept-Language') || '').split(',').slice(0, 10)) {
        const lang = normaliseLang(part.split(';')[0]);
        if (lang) return lang;
    }
    return null;
}

const RTL: ReadonlySet<string> = new Set(['ar', 'fa', 'ur']);

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The Android intent link to the app's card screen: the app when it is installed, else `fallback` (or the store). */
function androidCardLink(host: string, fallback: string | null): string {
    const node = encodeURIComponent(`https://${host}`);
    return `intent://community-card?node=${node}#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};`
        + (fallback ? `S.browser_fallback_url=${encodeURIComponent(fallback)};` : '') + 'end';
}

/**
 * The web app's own page and card grounds, from core's list of them (WEB_INK_GROUNDS, which every ink role is checked
 * against): light lists the card first (#ffffff, then the page), dark the page first (#1d231d, then the card).
 */
const GROUNDS = {
    light: { page: WEB_INK_GROUNDS.light[1], card: WEB_INK_GROUNDS.light[0] },
    dark: { page: WEB_INK_GROUNDS.dark[0], card: WEB_INK_GROUNDS.dark[1] },
} as const;

/** The page's colours: the brand roles it uses, from core's one library (brand-colours.ts), in each theme. */
function cardStyle(): string {
    const roles = ['--bp-commit-fill', '--bp-commit-hover', '--bp-commit-on', '--bp-ink-brand', '--bp-ink-accent', '--bp-ink-info', '--bp-chip-ok-tint', '--bp-chip-ok-ink'];
    const vars = (theme: 'light' | 'dark') => {
        const map = brandCssVariableMap(theme);
        const { page, card } = GROUNDS[theme];
        // Words in one theme are drawn in the other's page colour: near-black on light, near-white on dark.
        const ink = theme === 'light' ? GROUNDS.dark.page : GROUNDS.light.card;
        return [`--page:${page}`, `--card:${card}`, `--ink:${ink}`, ...roles.map(r => `${r}:${map[r]}`)].join(';');
    };
    return `
:root{${vars('light')};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars('dark')}}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-text-size-adjust:100%}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem 3rem}
.card{background:var(--card);border-radius:1rem;padding:1.5rem 1.25rem;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.kicker{margin:0 0 .25rem;font-size:.85rem;font-weight:600;color:var(--bp-ink-accent)}
h1{margin:0 0 .75rem;font-size:1.6rem;line-height:1.25;overflow-wrap:anywhere}
.facts{list-style:none;margin:0 0 1.25rem;padding:0;display:grid;gap:.35rem;font-size:1rem}
.facts li{overflow-wrap:anywhere}
.chip{display:inline-block;padding:.2rem .65rem;border-radius:999px;background:var(--bp-chip-ok-tint);color:var(--bp-chip-ok-ink);font-weight:700;font-size:.9rem}
.doors{display:grid;gap:.75rem}
.door{display:block;min-height:48px;padding:.8rem 1rem;border-radius:.75rem;text-align:center;text-decoration:none;font-weight:700;font-size:1rem;overflow-wrap:anywhere}
.primary{background:var(--bp-commit-fill);color:var(--bp-commit-on)}
.primary:hover{background:var(--bp-commit-hover)}
.secondary{border:1px solid var(--bp-ink-info);color:var(--bp-ink-info)}
.quiet{color:var(--bp-ink-brand);text-decoration:underline;font-weight:600}
.note{margin:-.25rem 0 .25rem;font-size:.9rem;overflow-wrap:anywhere}
a:focus-visible{outline:3px solid var(--bp-ink-info);outline-offset:2px}
`;
}

/** Whether the visitor's browser is an Android phone's, where the BeanPool app may be installed. */
function onAndroid(ctx: Pick<Koa.Context, 'get'>): boolean {
    return /\bAndroid\b/i.test(ctx.get('User-Agent') || '');
}

/** The card as a page: no script (APP_DOCUMENT_CSP), every value escaped, Open Graph tags for a link's preview. */
export function renderCommunityCard(card: CommunityCard, opts: { lang: Lang | null; android: boolean; ogImage: string | null }): string {
    const w = wordsIn(opts.lang);
    const W = COMMUNITY_CARD_WORDS;
    const lang = opts.lang ?? 'en';
    const name = communityCardName(card, w);
    const facts = communityCardFacts(card, w);
    const e = escapeHtml;
    const description = [facts.members, facts.area, facts.joining].filter(Boolean).join(' · ');

    const doors: string[] = [];
    if (card.joining === 'requests') {
        const href = opts.android && card.host ? androidCardLink(card.host, card.askUrl) : card.askUrl;
        if (href) {
            doors.push(`<a class="door primary" data-door="ask" href="${e(href)}">${e(w.t(W.ask))}</a>`);
            if (!opts.android) doors.push(`<p class="note">${e(w.t(W.askViaGlobal, { name }))}</p>`);
        } else {
            doors.push(`<p class="note" data-door="ask-app">${e(w.t(W.askInApp))}</p>`);
        }
    }
    if (card.joining === 'open') doors.push(`<a class="door primary" data-door="join" href="/app">${e(w.t(W.join))}</a>`);
    else doors.push(`<a class="door ${card.joining === 'requests' ? 'secondary' : 'primary'}" data-door="invite" href="/app?door=invite">${e(w.t(W.haveInvite))}</a>`);
    doors.push(`<a class="door secondary" data-door="signin" href="/app?door=signin">${e(w.t(W.member))}</a>`);
    if (card.globalUrl) doors.push(`<a class="door quiet" data-door="global" href="${e(card.globalUrl)}" rel="noopener">${e(w.t(W.lookAround))}</a>`);

    return `<!doctype html>
<html lang="${e(lang)}"${RTL.has(lang) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(name)}</title>
<meta name="description" content="${e(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="BeanPool">
<meta property="og:title" content="${e(name)}">
<meta property="og:description" content="${e(description)}">
${opts.ogImage ? `<meta property="og:image" content="${e(opts.ogImage)}">\n` : ''}<link rel="icon" href="/assets/logo-192x192.png">
<style>${cardStyle()}</style>
</head>
<body>
<main>
<div class="card" data-testid="community-card">
<p class="kicker">${e(w.t(W.kicker))}</p>
<h1 dir="auto">${e(name)}</h1>
<ul class="facts">
${facts.members ? `<li data-fact="members">${e(facts.members)}</li>\n` : ''}${facts.area ? `<li data-fact="area" dir="auto">${e(facts.area)}</li>\n` : ''}<li data-fact="joining"><span class="chip">${e(facts.joining)}</span></li>
</ul>
<div class="doors">
${doors.join('\n')}
</div>
</div>
</main>
</body>
</html>`;
}

/** Whether `/` answers this request with the card: the bare address (or `?lang=` alone), a local community, no account hint. */
function cardIsForThisRequest(ctx: Koa.Context): boolean {
    const keys = Object.keys(ctx.query);
    if (keys.some(k => k !== 'lang')) return false;
    // The global community's lobby is its root's landing for a visitor, and so is a local community that shows visitors
    // its listings: the web app decides there, as before.
    if (getNodeProfile() === 'global' || getProfileSwitches().guestListingsOnly) return false;
    return ctx.cookies.get(ACCOUNT_HINT_COOKIE) !== '1';
}

/** `/` for a stranger at a local community (routes/settings.ts): the card, and true; else false, and nothing written. */
export function serveCommunityCard(ctx: Koa.Context): boolean {
    if (!cardIsForThisRequest(ctx)) return false;
    const card = communityCard();
    const lang = cardLanguage(ctx);
    useAppDocumentPolicy(ctx);
    ctx.vary('Cookie');
    ctx.vary('Accept-Language');
    ctx.vary('User-Agent');
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.type = 'html';
    ctx.body = renderCommunityCard(card, {
        lang,
        android: onAndroid(ctx),
        ogImage: card.host ? `https://${card.host}/assets/logo-192x192.png` : null,
    });
    return true;
}

export function createCommunityCardRoutes(_deps: RouteDeps): Router {
    const router = new Router();
    // Public (PUBLIC_READ_EXACT): what the card says, for both apps. The same answer for everyone, signed or not.
    router.get('/api/community/card', async (ctx) => {
        ctx.set('Cache-Control', 'no-cache');
        ctx.body = communityCard();
    });
    return router;
}
