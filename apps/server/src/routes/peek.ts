/**
 * The peek ticket's routes (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4; engine/peek-tickets.ts
 * says what a ticket opens and when):
 *
 *   POST /api/peek                      a member asks for a link to share one post outside: `{ postId }`, signed. 201
 *                                       `{ ticket, id, postId, expiresAt }`; the apps build the link (@beanpool/core
 *                                       peekLink) from the address they reach the community at.
 *   GET  /api/peek/mine                 the member's open links (Settings, Shared outside), signed: `{ shares }`.
 *   POST /api/peek/stop                 Stop sharing one of them: `{ id }`, signed. It opens nothing from now.
 *   GET  /api/marketplace/posts/:id?peek=<ticket>
 *                                       the one read a ticket opens: `{ post }`, that post under the visitors' rules
 *                                       (guestPost), to anyone holding the link. The read gate lets it through by the
 *                                       ticket alone (https-server.ts peekReadAllowed); anything else gets the plain
 *                                       visitor answer, the listings' members-only refusal, the same in every case.
 *   GET  /?post=<id>&peek=<ticket>      the share page (servePeekPage, from routes/settings.ts): plain HTML, no script,
 *                                       Open Graph tags so a chat draws a preview, and the doors: Open in the BeanPool
 *                                       app, Get the app, See it in your browser, Look around the global community. A
 *                                       link that opens nothing is the community's card (routes/community-card.ts).
 *
 * No domain lock-in: the link is the community's own address, the page is this node's, and nothing here asks anyone
 * else for anything. The store links are the apps' own stores, as the invite trampoline's are.
 */
import Router from '@koa/router';
import type Koa from 'koa';
import { COMMUNITY_CARD_WORDS, PEEK_WORDS, brandCssVariableMap, communityCardFacts, communityCardName, isPeekPostId, isPeekTicket, peekKindWord, WEB_INK_GROUNDS, type CommunityCard, type Lang } from '@beanpool/core';
import type { MarketplacePost } from '@beanpool/engine';
import { makePeekTicket, listPeekTickets, peekPost, stopPeekTicket, PeekError } from '../engine/peek-tickets.js';
import { communityCard, cardLanguage, ACCOUNT_HINT_COOKIE, serveCommunityCardPage } from './community-card.js';
import { useAppDocumentPolicy } from '../app-document-csp.js';
import { wordsIn } from '../member-words.js';
import { getNodeProfile, getProfileSwitches } from '../config/node-profile.js';
import { LISTINGS_MEMBERS_ONLY } from '../listings-members-only.js';
import type { RouteDeps } from './types.js';

const ANDROID_PACKAGE = 'org.beanpool.pillar';
const APP_STORE_URL = 'https://apps.apple.com/app/id6761870086';
const PLAY_BASE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

/** The most of a post's own words the share page shows, and its preview's description. */
const PAGE_WORDS_MAX = 600;
const PREVIEW_WORDS_MAX = 180;

function refuse(ctx: Koa.Context, e: unknown): void {
    if (!(e instanceof PeekError)) throw e;
    ctx.status = e.status;
    ctx.body = { error: e.message, code: e.code };
}

export function createPeekRoutes(_deps: RouteDeps): Router {
    const router = new Router();

    // Signed (the middleware binds ctx.state.actor): the member's key signs the post it asks a link for.
    router.post('/api/peek', async (ctx) => {
        const actor = ctx.state.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        const body = (ctx as any).requestBody || {};
        try {
            ctx.status = 201;
            ctx.body = makePeekTicket(actor, body.postId);
        } catch (e) {
            refuse(ctx, e);
        }
    });

    // A gated read: a member's own, signed.
    router.get('/api/peek/mine', async (ctx) => {
        const actor = ctx.state.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        ctx.set('Cache-Control', 'private, no-store');
        ctx.body = { shares: listPeekTickets(actor) };
    });

    router.post('/api/peek/stop', async (ctx) => {
        const actor = ctx.state.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        const body = (ctx as any).requestBody || {};
        try {
            stopPeekTicket(actor, body.id);
            ctx.body = { stopped: true };
        } catch (e) {
            refuse(ctx, e);
        }
    });

    // The one read a ticket opens. Reached unsigned only through peekReadAllowed (https-server.ts), and checked again
    // here: whoever reaches it, signed or not, gets the post only with a ticket that opens it now.
    router.get('/api/marketplace/posts/:id', async (ctx) => {
        // Never kept by any cache: a stopped link must stop at once, and the answer is a link holder's alone.
        ctx.set('Cache-Control', 'private, no-store');
        ctx.set('X-Robots-Tag', 'noindex');
        const post = typeof ctx.query.peek === 'string' ? peekPost(ctx.params.id, ctx.query.peek) : null;
        if (!post) {
            ctx.status = 403;
            ctx.body = { ...LISTINGS_MEMBERS_ONLY };
            return;
        }
        ctx.body = { post };
    });

    return router;
}

// ── The share page ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const RTL: ReadonlySet<string> = new Set(['ar', 'fa', 'ur']);

/** Cut to `max` characters on a word, with an ellipsis, and on one line for a preview. */
function cut(text: string, max: number, oneLine = false): string {
    const t = (oneLine ? text.replace(/\s+/g, ' ') : text).trim();
    if (t.length <= max) return t;
    const head = t.slice(0, max);
    const space = head.lastIndexOf(' ');
    return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** Which phone the visitor's browser is on, where the BeanPool app may be: the doors differ (design §4.1). */
export type PeekDevice = 'android' | 'ios' | 'computer';
export function peekDevice(ctx: Pick<Koa.Context, 'get'>): PeekDevice {
    const ua = ctx.get('User-Agent') || '';
    if (/\bAndroid\b/i.test(ua)) return 'android';
    if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) return 'ios';
    return 'computer';
}

/** The page's colours: the web app's grounds and the brand roles, in each theme (as the community's card). */
function pageStyle(): string {
    const GROUNDS = {
        light: { page: WEB_INK_GROUNDS.light[1], card: WEB_INK_GROUNDS.light[0] },
        dark: { page: WEB_INK_GROUNDS.dark[0], card: WEB_INK_GROUNDS.dark[1] },
    } as const;
    const roles = ['--bp-commit-fill', '--bp-commit-hover', '--bp-commit-on', '--bp-ink-brand', '--bp-ink-accent', '--bp-ink-info', '--bp-chip-ok-tint', '--bp-chip-ok-ink'];
    const vars = (theme: 'light' | 'dark') => {
        const map = brandCssVariableMap(theme);
        const { page, card } = GROUNDS[theme];
        const ink = theme === 'light' ? GROUNDS.dark.page : GROUNDS.light.card;
        return [`--page:${page}`, `--card:${card}`, `--ink:${ink}`, ...roles.map(r => `${r}:${map[r]}`)].join(';');
    };
    return `
:root{${vars('light')};color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{${vars('dark')}}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;-webkit-text-size-adjust:100%}
main{max-width:30rem;margin:0 auto;padding:1.5rem 1rem 3rem}
.card{background:var(--card);border-radius:1rem;padding:1.25rem;box-shadow:0 1px 4px rgba(0,0,0,.18);margin-bottom:1rem}
.kicker{margin:0 0 .75rem;font-size:.9rem;font-weight:600;color:var(--bp-ink-accent);overflow-wrap:anywhere}
.photo{display:block;width:100%;max-height:22rem;object-fit:cover;border-radius:.75rem;margin:0 0 .75rem;background:var(--page)}
.kind{display:inline-block;padding:.15rem .6rem;border-radius:999px;background:var(--bp-chip-ok-tint);color:var(--bp-chip-ok-ink);font-weight:700;font-size:.85rem;margin:0 0 .5rem}
h1{margin:0 0 .25rem;font-size:1.45rem;line-height:1.25;overflow-wrap:anywhere}
.where{margin:0 0 .75rem;font-size:.95rem;color:var(--bp-ink-brand);overflow-wrap:anywhere}
.words{margin:0 0 .75rem;white-space:pre-line;overflow-wrap:anywhere}
.note{margin:0 0 1rem;font-size:.9rem;overflow-wrap:anywhere}
.doors{display:grid;gap:.75rem}
.door{display:block;min-height:48px;padding:.8rem 1rem;border-radius:.75rem;text-align:center;text-decoration:none;font-weight:700;font-size:1rem;overflow-wrap:anywhere}
.primary{background:var(--bp-commit-fill);color:var(--bp-commit-on)}
.primary:hover{background:var(--bp-commit-hover)}
.secondary{border:1px solid var(--bp-ink-info);color:var(--bp-ink-info)}
.quiet{color:var(--bp-ink-brand);text-decoration:underline;font-weight:600}
.facts{list-style:none;margin:0;padding:0;display:grid;gap:.35rem;font-size:.95rem}
.facts li{overflow-wrap:anywhere}
h2{margin:0 0 .5rem;font-size:1.1rem;overflow-wrap:anywhere}
a:focus-visible{outline:3px solid var(--bp-ink-info);outline-offset:2px}
`;
}

export interface PeekPageInput {
    post: MarketplacePost;
    ticket: string;
    card: CommunityCard;
    /** The community's address as the link named it: `https://<host>`. */
    origin: string;
    lang: Lang | null;
    device: PeekDevice;
}

/** The links the page's doors open, each built from the checked post id, ticket and address. */
export function peekPageLinks(input: Pick<PeekPageInput, 'post' | 'ticket' | 'origin' | 'device'>): { app: string | null; store: string | null; browser: string } {
    const id = encodeURIComponent(input.post.id);
    const t = encodeURIComponent(input.ticket);
    const browser = `/app?post=${id}&peek=${t}`;
    // The app's own peek screen (apps/native app/peek.tsx), which reads the post from this community as a visitor.
    const appQuery = `node=${encodeURIComponent(input.origin)}&post=${id}&peek=${t}`;
    if (input.device === 'android') {
        // Google Play carries the peek through the install (apps/native utils/install-referrer.ts), so the app opens on it.
        const store = `${PLAY_BASE_URL}&referrer=${encodeURIComponent(`peek=${input.ticket}&post=${input.post.id}&server=${input.origin}`)}`;
        return {
            app: `intent://peek?${appQuery}#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(store)};end`,
            store,
            browser,
        };
    }
    if (input.device === 'ios') return { app: `beanpool://peek?${appQuery}`, store: APP_STORE_URL, browser };
    return { app: null, store: null, browser };
}

/** The share page: no script (APP_DOCUMENT_CSP), every value escaped, Open Graph tags for a chat's preview. */
export function renderPeekPage(input: PeekPageInput): string {
    const { post, card, origin } = input;
    const w = wordsIn(input.lang);
    const W = PEEK_WORDS;
    const lang = input.lang ?? 'en';
    const e = escapeHtml;
    const community = communityCardName(card, w);
    const facts = communityCardFacts(card, w);
    const links = peekPageLinks(input);

    const kind = peekKindWord(post.type);
    const price = (post.type === 'offer' || post.type === 'need') && typeof post.credits === 'number' && post.credits > 0
        ? w.tn(post.credits, W.beans.one, W.beans.other, { n: post.credits.toLocaleString('en') }) : null;
    const kindLine = [kind ? w.t(kind) : null, price].filter(Boolean).join(' · ');
    const description = typeof post.description === 'string' ? post.description : '';
    const photo = Array.isArray(post.photos) && typeof post.photos[0] === 'string' && post.photos[0].startsWith('/') ? `${origin}${post.photos[0]}` : null;
    const onBeanPool = w.t(W.onBeanPool, { community });
    const preview = [onBeanPool, description ? cut(description, PREVIEW_WORDS_MAX, true) : null].filter(Boolean).join(' · ');

    const doors: string[] = [];
    if (links.app) doors.push(`<a class="door primary" data-door="app" href="${e(links.app)}">${e(w.t(W.openInApp))}</a>`);
    if (links.store) doors.push(`<a class="door secondary" data-door="store" href="${e(links.store)}" rel="noopener">${e(w.t(W.getApp))}</a>`);
    doors.push(`<a class="door ${links.app ? 'secondary' : 'primary'}" data-door="browser" href="${e(links.browser)}">${e(w.t(W.seeInBrowser))}</a>`);
    if (card.globalUrl) doors.push(`<a class="door quiet" data-door="global" href="${e(card.globalUrl)}" rel="noopener">${e(w.t(COMMUNITY_CARD_WORDS.lookAround))}</a>`);

    return `<!doctype html>
<html lang="${e(lang)}"${RTL.has(lang) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(post.title)}</title>
<meta name="description" content="${e(preview)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="BeanPool">
<meta property="og:title" content="${e(post.title)}">
<meta property="og:description" content="${e(preview)}">
${photo ? `<meta property="og:image" content="${e(photo)}">\n` : ''}<link rel="icon" href="/assets/logo-192x192.png">
<style>${pageStyle()}</style>
</head>
<body>
<main>
<div class="card" data-testid="peek-post">
<p class="kicker">${e(w.t(W.sharedWithYou, { community }))}</p>
${photo ? `<img class="photo" src="${e(photo)}" alt="">\n` : ''}${kindLine ? `<p class="kind">${e(kindLine)}</p>\n` : ''}<h1 dir="auto">${e(post.title)}</h1>
<p class="where">${e(onBeanPool)}</p>
${description ? `<p class="words" dir="auto">${e(cut(description, PAGE_WORDS_MAX))}</p>\n` : ''}<p class="note">${e(w.t(W.namesWhenJoin, { community }))}</p>
<div class="doors">
${doors.join('\n')}
</div>
</div>
<div class="card" data-testid="peek-community">
<h2 dir="auto">${e(community)}</h2>
<ul class="facts">
${facts.members ? `<li data-fact="members">${e(facts.members)}</li>\n` : ''}${facts.area ? `<li data-fact="area" dir="auto">${e(facts.area)}</li>\n` : ''}<li data-fact="joining">${e(facts.joining)}</li>
</ul>
</div>
</main>
</body>
</html>`;
}

/**
 * `/?post=<id>&peek=<ticket>` (routes/settings.ts): the share page where the ticket opens the post, and true. A browser
 * that keeps an account here (the web app's hint) goes to the web app as before, which opens the post for a member: false.
 * A ticket that opens nothing gets the plain visitor answer at a community's address: its card, and true; on a node that
 * shows visitors its listings (the global community's lobby) the web app decides, as for any `?post=`: false.
 */
export function servePeekPage(ctx: Koa.Context): boolean {
    const postId = ctx.query.post;
    const ticket = ctx.query.peek;
    if (ctx.query.peek === undefined) return false;
    if (ctx.cookies.get(ACCOUNT_HINT_COOKIE) === '1') return false;
    const post = isPeekPostId(postId) && isPeekTicket(ticket) ? peekPost(postId, ticket) : null;
    if (!post) {
        if (getNodeProfile() === 'global' || getProfileSwitches().guestListingsOnly) return false;
        return serveCommunityCardPage(ctx);
    }
    const card = communityCard();
    useAppDocumentPolicy(ctx);
    // The link's ticket is in this page's address: no page it links to is told it.
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('X-Robots-Tag', 'noindex');
    ctx.vary('Cookie');
    ctx.vary('Accept-Language');
    ctx.vary('User-Agent');
    ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    ctx.type = 'html';
    ctx.body = renderPeekPage({
        post, ticket: ticket as string, card,
        origin: card.host ? `https://${card.host}` : ctx.origin,
        lang: cardLanguage(ctx),
        device: peekDevice(ctx),
    });
    return true;
}
