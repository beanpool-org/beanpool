/**
 * The members' guide and manual ("BeanPool: help and how it works") — the client half, shared by the member app
 * and the web app so both read, check, search and update the guide the same way.
 *
 * One source: packages/beanpool-guide/content/*.md. Its build writes one guide.json that each app bundles
 * (@beanpool/guide/generated/guide.json) AND the same bytes to beanpool.org/guide/guide.json. The bundled copy
 * works offline from the first launch. When online the app fetches the website's copy and keeps it only if it is a
 * HIGHER version and passes validation; the last good copy is cached. Nothing here ever blocks the screen.
 *
 * A fetched copy is untrusted input. It is rendered as plain text only — no links, no HTML, no web view — and
 * anything outside the small block model is refused whole.
 *
 * I/O (storage, fetch) is passed in, so this is testable anywhere and has no platform imports.
 */

/** Bump when the JSON shape changes in a way an older app could not read. An app refuses other schemas. */
export const GUIDE_SCHEMA = 2;
export const GUIDE_URL = 'https://beanpool.org/guide/guide.json';
export const GUIDE_CACHE_KEY = 'beanpool_member_guide_v2';

/** The pages the BeanPool sheet links to by name, above the manual. */
export const GUIDE_SLUGS = { howItWorks: 'how-it-works', rules: 'rules', faq: 'faq', whatsNew: 'whats-new' } as const;
/** The section that holds the four guides above; every other section is the how-to manual. */
export const GUIDE_ABOUT_SECTION = 'about';

export type GuideBlock =
    | { type: 'h2' | 'h3' | 'p'; text: string }
    | { type: 'ul'; items: string[] };

export type OperatorGuideBlock =
    | GuideBlock
    | { type: 'img'; src: string; alt: string; href?: string };

export interface GuidePage<B = GuideBlock> {
    slug: string;
    title: string;
    summary: string;
    /** The id of the section this page belongs to. */
    section: string;
    /** Slugs of other pages worth reading next. */
    related: string[];
    /** A YouTube video id from the Learn lane that shows this task, if one has been made. */
    video?: string;
    blocks: B[];
}

export type OperatorGuidePage = GuidePage<OperatorGuideBlock>;

export interface GuideSection {
    id: string;
    title: string;
    summary: string;
    /** The pages in this section, in reading order. */
    slugs: string[];
}

export interface Guide<P = GuidePage> {
    schema: number;
    version: number;
    hash: string;
    sections: GuideSection[];
    guides: P[];
}

export type OperatorGuide = Guide<OperatorGuidePage>;

/** Where the guide on screen came from. */
export type GuideSource = 'bundled' | 'cached' | 'website';

export interface LoadedGuide {
    guide: Guide;
    source: GuideSource;
}

export const GUIDE_MAX_BYTES = 1024 * 1024;
const MAX_GUIDES = 120;
const MAX_SECTIONS = 20;
const MAX_BLOCKS = 400;
const MAX_ITEMS = 60;
const MAX_RELATED = 8;
const MAX_TEXT = 4000;
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const VIDEO_RE = /^[A-Za-z0-9_-]{6,20}$/;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * A guide object, or null if anything about it is off. Never throws. Picture blocks are for the operator manual
 * only: the members' guide rejects them, so the apps' readers never see one.
 */
export function validateGuide(raw: unknown, options?: { allowImages?: false }): Guide | null;
export function validateGuide(raw: unknown, options: { allowImages: true }): OperatorGuide | null;
export function validateGuide(raw: unknown, { allowImages = false }: { allowImages?: boolean } = {}): OperatorGuide | null {
    try {
        return validate(raw, allowImages);
    } catch {
        return null;
    }
}

function validate(raw: unknown, allowImages: boolean): OperatorGuide | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const g = raw as Record<string, unknown>;
    if (g.schema !== GUIDE_SCHEMA) return null;
    if (typeof g.version !== 'number' || !Number.isInteger(g.version) || g.version < 1) return null;
    if (typeof g.hash !== 'string' || g.hash.length > 128) return null;
    if (!Array.isArray(g.guides) || g.guides.length === 0 || g.guides.length > MAX_GUIDES) return null;
    if (!Array.isArray(g.sections) || g.sections.length === 0 || g.sections.length > MAX_SECTIONS) return null;

    const guides: OperatorGuidePage[] = [];
    const seen = new Set<string>();
    for (const p of g.guides as unknown[]) {
        if (!p || typeof p !== 'object') return null;
        const page = p as Record<string, unknown>;
        if (typeof page.slug !== 'string' || !SLUG_RE.test(page.slug) || seen.has(page.slug)) return null;
        seen.add(page.slug);
        if (!isText(page.title, 120) || !isText(page.summary, 300)) return null;
        if (typeof page.section !== 'string' || !SLUG_RE.test(page.section)) return null;
        if (!Array.isArray(page.related) || page.related.length > MAX_RELATED) return null;
        if (!page.related.every(r => typeof r === 'string' && SLUG_RE.test(r))) return null;
        if (page.video !== undefined && (typeof page.video !== 'string' || !VIDEO_RE.test(page.video))) return null;
        if (!Array.isArray(page.blocks) || page.blocks.length === 0 || page.blocks.length > MAX_BLOCKS) return null;
        const blocks: OperatorGuideBlock[] = [];
        for (const b of page.blocks as unknown[]) {
            if (!b || typeof b !== 'object') return null;
            const block = b as Record<string, unknown>;
            if (block.type === 'ul') {
                if (!Array.isArray(block.items) || block.items.length === 0 || block.items.length > MAX_ITEMS) return null;
                if (!block.items.every(it => isText(it, MAX_TEXT))) return null;
                blocks.push({ type: 'ul', items: [...(block.items as string[])] });
            } else if (block.type === 'h2' || block.type === 'h3' || block.type === 'p') {
                if (!isText(block.text, MAX_TEXT)) return null;
                blocks.push({ type: block.type, text: block.text });
            } else if (block.type === 'img') {
                if (!allowImages) return null;
                if (typeof block.src !== 'string' || !block.src || block.src.length > MAX_TEXT) return null;
                if (typeof block.alt !== 'string' || !block.alt || block.alt.length > MAX_TEXT) return null;
                if (block.href !== undefined && (typeof block.href !== 'string' || !SLUG_RE.test(block.href))) return null;
                const imgBlock: OperatorGuideBlock = { type: 'img', src: block.src, alt: block.alt };
                if (block.href) (imgBlock as { href?: string }).href = block.href;
                blocks.push(imgBlock);
            } else {
                return null;
            }
        }
        const out: OperatorGuidePage = {
            slug: page.slug, title: page.title, summary: page.summary, section: page.section,
            related: [...(page.related as string[])], blocks,
        };
        if (typeof page.video === 'string') out.video = page.video;
        guides.push(out);
    }

    const sections: GuideSection[] = [];
    const sectionIds = new Set<string>();
    const placed = new Set<string>();
    for (const s of g.sections as unknown[]) {
        if (!s || typeof s !== 'object') return null;
        const sec = s as Record<string, unknown>;
        if (typeof sec.id !== 'string' || !SLUG_RE.test(sec.id) || sectionIds.has(sec.id)) return null;
        sectionIds.add(sec.id);
        if (!isText(sec.title, 80) || !isText(sec.summary, 300)) return null;
        if (!Array.isArray(sec.slugs) || sec.slugs.length === 0) return null;
        for (const slug of sec.slugs) {
            if (typeof slug !== 'string' || !seen.has(slug) || placed.has(slug)) return null;
            placed.add(slug);
        }
        sections.push({ id: sec.id, title: sec.title, summary: sec.summary, slugs: [...(sec.slugs as string[])] });
    }
    // Every page sits in exactly one section, the one it names; related pages exist.
    if (placed.size !== guides.length) return null;
    for (const page of guides) {
        const home = sections.find(s => s.id === page.section);
        if (!home || !home.slugs.includes(page.slug)) return null;
        if (!page.related.every(r => r !== page.slug && seen.has(r))) return null;
    }
    return { schema: GUIDE_SCHEMA, version: g.version, hash: g.hash, sections, guides };
}

/** The newer of two copies; the first wins a tie. */
export function newerGuide(a: LoadedGuide, b: LoadedGuide | null): LoadedGuide {
    return b && b.guide.version > a.guide.version ? b : a;
}

export interface GuideStorage {
    getItem(key: string): Promise<string | null> | string | null;
    setItem(key: string, value: string): Promise<void> | void;
}

/** Bundled copy, or the cached website copy when that is newer. Never throws, never touches the network. */
export async function loadLocalGuide(storage: GuideStorage, bundled: Guide): Promise<LoadedGuide> {
    const base: LoadedGuide = { guide: bundled, source: 'bundled' };
    try {
        const raw = await storage.getItem(GUIDE_CACHE_KEY);
        if (!raw) return base;
        const cached = validateGuide(JSON.parse(raw));
        return newerGuide(base, cached ? { guide: cached, source: 'cached' } : null);
    } catch {
        return base;
    }
}

export type GuideFetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * Fetch the website's copy. Returns it (and caches it) only when it is valid and newer than `current`;
 * otherwise null. Never throws — offline, a slow network, a 404 or a bad file all mean "keep what you have".
 */
export async function refreshGuideFromWebsite(
    current: Guide,
    storage: GuideStorage,
    fetchImpl: GuideFetch,
    timeoutMs = 8000,
): Promise<Guide | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const res = await fetchImpl(GUIDE_URL, { signal: controller?.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.length > GUIDE_MAX_BYTES) return null;
        const remote = validateGuide(JSON.parse(text));
        if (!remote || remote.version <= current.version) return null;
        try { await storage.setItem(GUIDE_CACHE_KEY, JSON.stringify(remote)); } catch { /* shown now; cached next time */ }
        return remote;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function findGuidePage<P extends GuidePage<OperatorGuideBlock> = GuidePage>(guide: Guide<P>, slug: string): P | null {
    return guide.guides.find(g => g.slug === slug) ?? null;
}

export function findGuideSection(guide: Guide<unknown>, id: string): GuideSection | null {
    return guide.sections.find(s => s.id === id) ?? null;
}

/** The pages of a section, in its order. */
export function sectionPages<P extends GuidePage<OperatorGuideBlock> = GuidePage>(guide: Guide<P>, section: GuideSection): P[] {
    return section.slugs.map(s => findGuidePage(guide, s)).filter((p): p is P => p !== null);
}

/** The how-to manual's sections: every section but the one holding the four guides. */
export function manualSections(guide: Guide<unknown>): GuideSection[] {
    return guide.sections.filter(s => s.id !== GUIDE_ABOUT_SECTION);
}

/** The pages a page lists under "Related", skipping any that are missing. */
export function relatedPages<P extends GuidePage<OperatorGuideBlock> = GuidePage>(guide: Guide<P>, page: P): P[] {
    return page.related.map(s => findGuidePage(guide, s)).filter((p): p is P => p !== null);
}

/** "a **b** c" → [{text:'a ',bold:false},{text:'b',bold:true},{text:' c',bold:false}]. */
export function splitBold(text: string): Array<{ text: string; bold: boolean }> {
    return text.split('**')
        .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
        .filter(s => s.text.length > 0);
}

// ─── Search ──────────────────────────────────────────────────────────────────
// Offline, over the text on the phone. Every word typed must appear somewhere on a page (a word may be the start
// of a longer one: "vot" finds "voting"). Titles weigh most, then summaries, headings, then the body.

/** Words members may type that the guide deliberately says differently. */
const SEARCH_SYNONYMS: Record<string, string[]> = {
    tier: ['badge'], tiers: ['badge'], rank: ['badge'], level: ['badge'],
    escrow: ['held'], deposit: ['held'],
    demurrage: ['circulation'], tax: ['fee'],
    seed: ['words'], phrase: ['words'], password: ['words'], mnemonic: ['words'], backup: ['words'],
    chat: ['message', 'talk'], dm: ['message'], inbox: ['message'],
    money: ['beans'], coins: ['beans'], currency: ['beans'], credits: ['beans'],
    delete: ['delete', 'remove'], quit: ['leave'], ban: ['block', 'remove'],
    dark: ['dark', 'appearance'], theme: ['appearance'],
    vote: ['vote', 'decision'], proposal: ['decision'], governance: ['decision'],
    project: ['enterprise'], business: ['enterprise'],
};

// No Unicode property escapes (\p{L}) and a guarded normalize(): this module loads at app start on old Android
// engines, where either could throw. Splitting on spaces and punctuation keeps letters of every script.
function fold(s: string): string {
    let out = s.toLowerCase();
    try { out = out.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch { /* keep accents */ }
    return out.replace(/\*\*/g, '');
}
const SEPARATORS = /[\s!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u206f\u3000-\u303f]+/;
const words = (s: string) => fold(s).split(SEPARATORS).filter(Boolean);

export interface GuideSearchResult<P = GuidePage> {
    page: P;
    score: number;
    /** A short piece of the page around the first match, for the result row. */
    snippet: string;
}

function blockTexts(page: { blocks: readonly OperatorGuideBlock[] }): Array<{ text: string; heading: boolean }> {
    const out: Array<{ text: string; heading: boolean }> = [];
    for (const b of page.blocks) {
        if (b.type === 'ul') b.items.forEach(t => out.push({ text: t, heading: false }));
        else if (b.type === 'img') out.push({ text: b.alt, heading: false });
        else out.push({ text: b.text, heading: b.type !== 'p' });
    }
    return out;
}

function snippetAround(text: string, term: string, max = 110): string {
    const plain = text.replace(/\*\*/g, '');
    const at = fold(plain).indexOf(term);
    if (plain.length <= max) return plain;
    const start = Math.max(0, Math.min(at < 0 ? 0 : at - 30, plain.length - max));
    return `${start > 0 ? '…' : ''}${plain.slice(start, start + max).trim()}${start + max < plain.length ? '…' : ''}`;
}

/** Pages matching every word of `query`, best first. An empty query finds nothing. */
export function searchGuide<P extends GuidePage<OperatorGuideBlock> = GuidePage>(
    guide: Guide<P>,
    query: string,
    limit = 20,
): Array<GuideSearchResult<P>> {
    const terms = [...new Set(words(query).filter(t => t.length >= 2))].slice(0, 8);
    if (terms.length === 0) return [];
    const results: Array<GuideSearchResult<P>> = [];
    for (const page of guide.guides) {
        const title = words(page.title);
        const summary = words(page.summary);
        const blocks = blockTexts(page).map(b => ({ ...b, words: words(b.text) }));
        let score = 0;
        let firstHit: { text: string; term: string } | null = null;
        let everyTerm = true;
        for (const term of terms) {
            const alternatives = [term, ...(SEARCH_SYNONYMS[term] ?? [])];
            const hits = (ws: string[]) => ws.filter(w => alternatives.some(a => w.startsWith(a))).length;
            let termScore = hits(title) * 10 + hits(summary) * 5;
            for (const b of blocks) {
                const n = hits(b.words);
                if (n === 0) continue;
                termScore += Math.min(n, 3) * (b.heading ? 3 : 1);
                if (!firstHit) {
                    const matched = b.words.find(w => alternatives.some(a => w.startsWith(a)))!;
                    firstHit = { text: b.text, term: matched };
                }
            }
            if (termScore === 0) { everyTerm = false; break; }
            score += termScore;
        }
        if (!everyTerm) continue;
        results.push({ page, score, snippet: firstHit ? snippetAround(firstHit.text, firstHit.term) : page.summary });
    }
    return results.sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title)).slice(0, limit);
}

// ─── Learn videos ────────────────────────────────────────────────────────────
// Videos are extra: every page works fully from its text. A page shows "Watch: <title>" only when the member's
// community has a matching BeanPool video in the Pulse's Learn lane.
//
// Only BeanPool's own videos can link from the guide. Any member can add a channel to the Learn lane, and an RSS
// channel lets them pick any title and any https link, so a member's item titled like a guide page must never turn
// into an unattributed "Watch:" on, say, "Your 12 words". A video counts only when the feed marks it
// source === 'curated' (the items the server seeds from CURATED_LEARN_ITEMS) AND its link is a YouTube watch or
// youtu.be link. The resolver does NOT mark new items from the BeanPool channel as curated, so a new official video
// links from the guide only once it has been added to CURATED_LEARN_ITEMS.
//
// A curated video matches a page when EITHER
//   - the page names the video's YouTube id (`video:` in the page's front matter), or
//   - the video's title is the page's title (ignoring case, spaces and punctuation).

export interface LearnVideo {
    title: string;
    url: string;
    /** The feed item's `source`. Only 'curated' (BeanPool's own) videos ever link from the guide. */
    source?: string | null;
}

const titleKey = (s: string) => words(s).join(' ');
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a YouTube watch link (https://www.youtube.com/watch?v=ID) or https://youtu.be/ID, else null. */
export function youtubeWatchId(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') {
        const parts = u.pathname.split('/').filter(Boolean);
        id = parts.length === 1 ? parts[0] : null;
    } else if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
        id = u.pathname === '/watch' ? u.searchParams.get('v') : null;
    }
    return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Learn-lane feed items as LearnVideos, keeping `source` so findGuideVideo can tell BeanPool's videos from members'. */
export function learnVideosFromFeed(items: unknown): LearnVideo[] {
    if (!Array.isArray(items)) return [];
    const out: LearnVideo[] = [];
    for (const i of items as Array<Record<string, unknown> | null>) {
        if (!i || i.category !== 'learn' || typeof i.url !== 'string' || typeof i.title !== 'string') continue;
        out.push({ title: i.title, url: i.url, source: typeof i.source === 'string' ? i.source : null });
    }
    return out;
}

/** The BeanPool video that goes with this page, or null. Only curated YouTube links are ever returned. */
export function findGuideVideo(page: GuidePage, videos: readonly LearnVideo[]): LearnVideo | null {
    const safe = videos
        .filter(v => v && v.source === 'curated' && typeof v.url === 'string' && isText(v.title, 300))
        .map(v => ({ v, id: youtubeWatchId(v.url) }))
        .filter(x => x.id !== null);
    if (page.video) {
        const byId = safe.find(x => x.id === page.video);
        if (byId) return byId.v;
    }
    const key = titleKey(page.title);
    return safe.find(x => titleKey(x.v.title) === key)?.v ?? null;
}

// ─── The "BeanPool" entry points ─────────────────────────────────────────────
// Settings and the BeanPool sheet each have a short BeanPool group, in the member app and the web app. All four
// read their rows from here, so "Suggest a change" hides everywhere while FEEDBACK_LIVE is false.

export const BEANPOOL_WEBSITE_URL = 'https://beanpool.org';

/** Rows of the BeanPool group in Settings: the sheet, Suggest a change (only when live), the website. */
export function beanPoolSettingsEntries(feedbackLive: boolean): Array<'help' | 'suggest' | 'website'> {
    return feedbackLive ? ['help', 'suggest', 'website'] : ['help', 'website'];
}

/** Rows of the sheet's project group: Suggest a change (only when live), What's new, the website. */
export function beanPoolSheetEntries(feedbackLive: boolean): Array<'suggest' | 'whats-new' | 'website'> {
    return feedbackLive ? ['suggest', 'whats-new', 'website'] : ['whats-new', 'website'];
}
