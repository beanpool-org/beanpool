/**
 * The worldwide community's forum as plain HTML pages anyone can read with no script (slice F7; DESIGN-forums-fable.md §7),
 * built from engine/forum-public.ts's answers, which hold only what a public answer may (@beanpool/core FORUM_PUBLIC_FIELDS).
 *
 *   /forum            the sections and the newest topics          /forum/s/<id>   one section
 *   /forum/t/<id>     one topic, 30 posts a page                  /forum/sitemap.xml and /robots.txt
 *
 * A writer shows as a coloured initial, their name and the community label they chose: never a picture, a key, a profile link
 * or an area. Every link inside a post is `nofollow ugc`. Search engines (Marty, Q2): a topic is `noindex` until its opening
 * post has been public 2 days, and always in "Introduce yourself" or any section its owners leave unlisted; the section
 * page of such a section too. English at the plain address, another language at `?hl=<code>`, the plain address canonical.
 * The doors: Join to reply (the web app, then that topic), Open in the app and the two stores, the same for every reader.
 */
import { PEEK_WORDS, forumWordRuns, forumStarterSection, isLang, word, wordn, type Lang } from '@beanpool/core';
import type { ForumPublicPost, ForumPublicSection, ForumPublicTopic, ForumPublicWriter } from './engine/forum-public.js';
import { wordsIn } from './member-words.js';
import { pageStyle, APP_STORE_URL, PLAY_BASE_URL } from './routes/peek.js';

export const FORUM_PAGE_WORDS = {
    forum: word('Forum'),
    sections: word('Sections'),
    newest: word('Newest topics'),
    none: word('No topics here yet.'),
    replies: wordn('{n} reply', '{n} replies'),
    topics: wordn('{n} topic', '{n} topics'),
    joinToReply: word('Join to reply'),
    more: word('More'),
    edited: word('edited'),
    pinned: word('Pinned'),
    closed: word('Closed'),
    replyingTo: word('Replying to #{n}'),
    anyoneReads: word('Anyone can read this forum. Join BeanPool’s worldwide community to write in it.'),
    topicGone: word('This topic isn’t here any more.'),
    sectionGone: word('This section isn’t here any more.'),
} as const;

const RTL: ReadonlySet<string> = new Set(['ar', 'fa', 'ur']);

function e(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The page's language from `?hl=`: one of ours, else English (the plain address). */
export function forumPageLang(hl: unknown): Lang | null {
    return isLang(hl) && hl !== 'en' ? hl : null;
}

export interface ForumPageContext {
    lang: Lang | null;
    /** This community's public address (`https://<host>`), or null when the server knows none: then no canonical. */
    publicOrigin: string | null;
    /** The address the app's door names this community by. */
    appOrigin: string;
}

type W = ReturnType<typeof wordsIn>;

/** A starter section reads its word in the page's language; a renamed one as its owners typed it. */
function sectionName(s: ForumPublicSection, w: W): string {
    if (s.name) return s.name;
    const starter = forumStarterSection(s.starter);
    return starter ? w.t(starter.name) : '';
}

function writerLine(writer: ForumPublicWriter, w: W): string {
    const label = writer.community;
    if (label?.kind === 'community' && label.community) return w.t('{name} · {community}', { name: writer.name, community: label.community });
    if (label?.kind === 'waiting') return w.t('{name} · waiting to join', { name: writer.name });
    return writer.name;
}

/** A coloured initial where a picture would be: the colour from the name, never from a key. */
function initial(name: string): string {
    const first = Array.from(name.trim())[0] ?? '?';
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
    return `<span class="initial" aria-hidden="true" style="background:hsl(${h} 45% 40%)">${e(first.toUpperCase())}</span>`;
}

const day = (isoTime: string) => `<time datetime="${e(isoTime)}">${e(isoTime.slice(0, 10))}</time>`;

/** A post's words, its links tappable and marked `nofollow ugc` (every public post's writer is known). */
function wordsHtml(words: string): string {
    return forumWordRuns(words, true).map((run) => {
        if (!run.isUrl) return e(run.text);
        const href = /^https?:\/\//i.test(run.text) ? run.text : `https://${run.text}`;
        return `<a href="${e(href)}" rel="nofollow ugc noopener" target="_blank">${e(run.text)}</a>`;
    }).join('');
}

/** A link to `path` in the page's language. */
function here(path: string, ctx: ForumPageContext, extra: Record<string, string | number> = {}): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
    if (ctx.lang) q.set('hl', ctx.lang);
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
}

/**
 * The doors: Join to reply, Open in the app, and each store. The same for every reader: the page is one copy per address in a
 * shared cache, so nothing in it may follow the reader's browser (the shared-listing page, never cached, picks by device).
 */
export function forumPageDoors(ctx: ForumPageContext, topicId: string | null): { join: string; app: string; appStore: string; googlePlay: string } {
    const join = topicId ? `/app?forumTopic=${encodeURIComponent(topicId)}` : '/app?forum=1';
    const appQuery = `node=${encodeURIComponent(ctx.appOrigin)}${topicId ? `&topic=${encodeURIComponent(topicId)}` : ''}`;
    return { join, app: `beanpool://forum?${appQuery}`, appStore: APP_STORE_URL, googlePlay: PLAY_BASE_URL };
}

function doorsHtml(ctx: ForumPageContext, topicId: string | null, w: W): string {
    const d = forumPageDoors(ctx, topicId);
    return `<div class="doors">
<a class="door primary" data-door="join" href="${e(d.join)}">${e(w.t(FORUM_PAGE_WORDS.joinToReply))}</a>
<a class="door secondary" data-door="app" href="${e(d.app)}">${e(w.t(PEEK_WORDS.openInApp))}</a>
<p class="note">${e(w.t(PEEK_WORDS.getApp))}: <a class="quiet" data-door="app-store" href="${e(d.appStore)}" rel="noopener">App Store</a> · <a class="quiet" data-door="google-play" href="${e(d.googlePlay)}" rel="noopener">Google Play</a></p>
</div>`;
}

const FORUM_STYLE = `
.crumbs{margin:0 0 .75rem;font-size:.9rem}
.crumbs a,.row a,.sec a{color:var(--bp-ink-info)}
.list{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.row h2,.sec h2{margin:0;font-size:1.05rem}
.meta{margin:.15rem 0 0;font-size:.85rem;color:var(--bp-ink-brand);overflow-wrap:anywhere}
.post{border-top:1px solid rgba(127,127,127,.25);padding:.75rem 0}
.post:first-of-type{border-top:0}
.who{display:flex;align-items:center;gap:.5rem;font-weight:600;overflow-wrap:anywhere}
.initial{display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;flex:none;border-radius:50%;color:#fff;font-weight:700}
.post img{display:block;width:100%;max-height:22rem;object-fit:cover;border-radius:.75rem;margin:.5rem 0 0}
.more{display:inline-block;margin:.75rem 0 0;color:var(--bp-ink-info);font-weight:600}
`;

function page(opts: { ctx: ForumPageContext; title: string; description: string; canonicalPath: string; indexable: boolean; body: string }): string {
    const lang = opts.ctx.lang ?? 'en';
    const canonical = opts.ctx.publicOrigin ? `${opts.ctx.publicOrigin}${opts.canonicalPath}` : null;
    return `<!doctype html>
<html lang="${e(lang)}"${RTL.has(lang) ? ' dir="rtl"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.indexable ? '' : '<meta name="robots" content="noindex">\n'}<title>${e(opts.title)}</title>
<meta name="description" content="${e(opts.description)}">
${canonical ? `<link rel="canonical" href="${e(canonical)}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:site_name" content="BeanPool">
<meta property="og:title" content="${e(opts.title)}">
<meta property="og:description" content="${e(opts.description)}">
<link rel="icon" href="/assets/logo-192x192.png">
<style>${pageStyle()}${FORUM_STYLE}</style>
</head>
<body>
<main>
${opts.body}
</main>
</body>
</html>`;
}

function topicRows(topics: ForumPublicTopic[], ctx: ForumPageContext, w: W): string {
    if (topics.length === 0) return `<p class="note">${e(w.t(FORUM_PAGE_WORDS.none))}</p>`;
    return `<ul class="list">\n${topics.map((t) => {
        const facts = [writerLine(t.writer, w), w.tn(t.replyCount, FORUM_PAGE_WORDS.replies.one, FORUM_PAGE_WORDS.replies.other, { n: t.replyCount }),
            t.pinned ? w.t(FORUM_PAGE_WORDS.pinned) : null, t.closed ? w.t(FORUM_PAGE_WORDS.closed) : null].filter(Boolean) as string[];
        return `<li class="row" data-topic="${e(t.id)}"><h2 dir="auto"><a href="${e(here(`/forum/t/${encodeURIComponent(t.id)}`, ctx))}">${e(t.title)}</a></h2>
<p class="meta" dir="auto">${e(facts.join(' · '))} · ${day(t.lastActivityAt)}</p></li>`;
    }).join('\n')}\n</ul>`;
}

const intro = (w: W) => `<p class="note">${e(w.t(FORUM_PAGE_WORDS.anyoneReads))}</p>`;

/** /forum: the sections and the newest topics. Listed by search engines. */
export function renderForumFront(data: { sections: ForumPublicSection[]; topics: ForumPublicTopic[]; next: number | null }, offset: number, ctx: ForumPageContext): string {
    const w = wordsIn(ctx.lang);
    const title = w.t(FORUM_PAGE_WORDS.forum);
    const sections = data.sections.map((s) => `<li class="sec" data-section="${e(s.id)}"><h2 dir="auto"><a href="${e(here(`/forum/s/${encodeURIComponent(s.id)}`, ctx))}">${e(sectionName(s, w))}</a></h2>
<p class="meta">${e(w.tn(s.topicCount, FORUM_PAGE_WORDS.topics.one, FORUM_PAGE_WORDS.topics.other, { n: s.topicCount }))}</p></li>`).join('\n');
    const body = `<div class="card">
<h1>${e(title)}</h1>
${intro(w)}
${doorsHtml(ctx, null, w)}
</div>
<div class="card">
<h2>${e(w.t(FORUM_PAGE_WORDS.sections))}</h2>
<ul class="list">
${sections}
</ul>
</div>
<div class="card" data-testid="forum-newest">
<h2>${e(w.t(FORUM_PAGE_WORDS.newest))}</h2>
${topicRows(data.topics, ctx, w)}
${data.next !== null ? `<a class="more" rel="next" href="${e(here('/forum', ctx, { offset: data.next }))}">${e(w.t(FORUM_PAGE_WORDS.more))}</a>` : ''}
</div>`;
    return page({ ctx, title, description: w.t(FORUM_PAGE_WORDS.anyoneReads), canonicalPath: offset ? `/forum?offset=${offset}` : '/forum', indexable: true, body });
}

/** /forum/s/<id>: one section's topics. `noindex` for a section its owners leave unlisted ("Introduce yourself"). */
export function renderForumSection(data: { section: ForumPublicSection; listed: boolean; topics: ForumPublicTopic[]; next: number | null }, offset: number, ctx: ForumPageContext): string {
    const w = wordsIn(ctx.lang);
    const name = sectionName(data.section, w);
    const path = `/forum/s/${encodeURIComponent(data.section.id)}`;
    const body = `<div class="card">
<p class="crumbs"><a href="${e(here('/forum', ctx))}">${e(w.t(FORUM_PAGE_WORDS.forum))}</a></p>
<h1 dir="auto">${e(name)}</h1>
${data.section.about ? `<p class="words" dir="auto">${e(data.section.about)}</p>\n` : ''}${doorsHtml(ctx, null, w)}
</div>
<div class="card">
${topicRows(data.topics, ctx, w)}
${data.next !== null ? `<a class="more" rel="next" href="${e(here(path, ctx, { offset: data.next }))}">${e(w.t(FORUM_PAGE_WORDS.more))}</a>` : ''}
</div>`;
    return page({ ctx, title: `${name} · ${w.t(FORUM_PAGE_WORDS.forum)}`, description: data.section.about || w.t(FORUM_PAGE_WORDS.anyoneReads),
        canonicalPath: offset ? `${path}?offset=${offset}` : path, indexable: data.listed, body });
}

function postHtml(p: ForumPublicPost, w: W): string {
    const photos = Array.from({ length: p.photos }, (_, n) => `<img src="/api/forum/photos/${encodeURIComponent(p.id)}/${n}" alt="" loading="lazy">`).join('\n');
    const facts = [day(p.createdAt), p.edited ? e(w.t(FORUM_PAGE_WORDS.edited)) : null, p.quotes !== null ? e(w.t(FORUM_PAGE_WORDS.replyingTo, { n: p.quotes })) : null].filter(Boolean);
    return `<article class="post" id="p${p.number}" data-post="${e(p.id)}">
<p class="who" dir="auto">${initial(p.writer.name)}<span>${e(writerLine(p.writer, w))}</span></p>
<p class="meta">${facts.join(' · ')}</p>
<p class="words" dir="auto">${wordsHtml(p.words)}</p>
${photos}
</article>`;
}

/** /forum/t/<id>: one topic and 30 of its public posts. `noindex` unless search engines may list it (Q2). */
export function renderForumTopic(data: { section: ForumPublicSection; topic: ForumPublicTopic; posts: ForumPublicPost[]; next: number | null }, after: number, ctx: ForumPageContext): string {
    const w = wordsIn(ctx.lang);
    const { topic, section } = data;
    const path = `/forum/t/${encodeURIComponent(topic.id)}`;
    const opening = data.posts.find((p) => p.number === 1);
    const description = (opening?.words ?? topic.title).replace(/\s+/g, ' ').trim().slice(0, 180);
    const facts = [w.tn(topic.replyCount, FORUM_PAGE_WORDS.replies.one, FORUM_PAGE_WORDS.replies.other, { n: topic.replyCount }),
        topic.place, topic.closed ? w.t(FORUM_PAGE_WORDS.closed) : null].filter(Boolean) as string[];
    const body = `<div class="card" data-testid="forum-topic">
<p class="crumbs"><a href="${e(here('/forum', ctx))}">${e(w.t(FORUM_PAGE_WORDS.forum))}</a> › <a href="${e(here(`/forum/s/${encodeURIComponent(section.id)}`, ctx))}" dir="auto">${e(sectionName(section, w))}</a></p>
<h1 dir="auto">${e(topic.title)}</h1>
<p class="meta" dir="auto">${e(facts.join(' · '))}</p>
${data.posts.map((p) => postHtml(p, w)).join('\n')}
${data.next !== null ? `<a class="more" rel="next" href="${e(here(path, ctx, { after: data.next }))}">${e(w.t(FORUM_PAGE_WORDS.more))}</a>\n` : ''}${doorsHtml(ctx, topic.id, w)}
</div>`;
    return page({ ctx, title: topic.title, description, canonicalPath: after ? `${path}?after=${after}` : path, indexable: topic.indexable, body });
}

/** A topic or section nobody on the web may read: the same words whether it never was, went, or is not public. */
export function renderForumGone(kind: 'topic' | 'section', ctx: ForumPageContext): string {
    const w = wordsIn(ctx.lang);
    const words = w.t(kind === 'topic' ? FORUM_PAGE_WORDS.topicGone : FORUM_PAGE_WORDS.sectionGone);
    return page({ ctx, title: words, description: words, canonicalPath: '/forum', indexable: false,
        body: `<div class="card"><h1>${e(words)}</h1>\n<p class="crumbs"><a href="${e(here('/forum', ctx))}">${e(w.t(FORUM_PAGE_WORDS.forum))}</a></p></div>` });
}

/** robots.txt on a public forum's server: the forum may be read; the web app's pages, the API, Settings and the manager not. */
export function renderForumRobots(publicOrigin: string | null): string {
    return [
        'User-agent: *',
        'Allow: /forum',
        'Disallow: /api/',
        'Disallow: /app/',
        'Disallow: /settings',
        'Disallow: /manager',
        ...(publicOrigin ? ['', `Sitemap: ${publicOrigin}/forum/sitemap.xml`] : []),
        '',
    ].join('\n');
}

/** The sitemap: the forum, its listed sections and every topic search engines may list now, at this community's address. */
export function renderForumSitemap(publicOrigin: string, data: { sections: { id: string }[]; topics: { id: string; lastActivityAt: string }[] }): string {
    const url = (path: string, lastmod?: string) => `<url><loc>${e(`${publicOrigin}${path}`)}</loc>${lastmod ? `<lastmod>${e(lastmod)}</lastmod>` : ''}</url>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[url('/forum'), ...data.sections.map((s) => url(`/forum/s/${encodeURIComponent(s.id)}`)), ...data.topics.map((t) => url(`/forum/t/${encodeURIComponent(t.id)}`, t.lastActivityAt))].join('\n')}
</urlset>
`;
}
