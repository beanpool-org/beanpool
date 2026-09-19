// The members' guide in the app ("BeanPool: help and how it works").
//
// One source: packages/beanpool-guide/content/*.md. Its build writes the guide.json bundled here AND the
// same bytes to beanpool.org/guide/guide.json. The app always has the bundled copy, so the guides work
// offline from the first launch. When online it fetches the website's copy and keeps it if it is a HIGHER
// version and passes validation; the last good copy is cached and outlives restarts. Nothing here ever
// blocks the sheet: the bundled copy (or the cache) renders at once and a newer one swaps in quietly.
//
// A fetched copy is untrusted input. It is rendered as plain <Text> only — no links, no HTML, no web
// view — and anything outside the small block model is refused whole.
//
// I/O is passed in (storage, fetch) so the logic is testable without a device.

import bundledGuide from '@beanpool/guide/generated/guide.json';

export const GUIDE_SCHEMA = 1;
export const GUIDE_URL = 'https://beanpool.org/guide/guide.json';
export const GUIDE_CACHE_KEY = 'beanpool_member_guide_v1';
/** The four guides the BeanPool sheet links to by name. */
export const GUIDE_SLUGS = { howItWorks: 'how-it-works', rules: 'rules', faq: 'faq', whatsNew: 'whats-new' } as const;

export type GuideBlock =
    | { type: 'h2' | 'h3' | 'p'; text: string }
    | { type: 'ul'; items: string[] };

export interface GuidePage {
    slug: string;
    title: string;
    summary: string;
    blocks: GuideBlock[];
}

export interface Guide {
    schema: number;
    version: number;
    hash: string;
    guides: GuidePage[];
}

/** Where the guide on screen came from. */
export type GuideSource = 'bundled' | 'cached' | 'website';

export interface LoadedGuide {
    guide: Guide;
    source: GuideSource;
}

const MAX_BYTES = 512 * 1024;
const MAX_GUIDES = 40;
const MAX_BLOCKS = 400;
const MAX_ITEMS = 60;
const MAX_TEXT = 4000;
const SLUG_RE = /^[a-z0-9-]{1,40}$/;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** A guide object, or null if anything about it is off. Never throws. */
export function validateGuide(raw: unknown): Guide | null {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    if (g.schema !== GUIDE_SCHEMA) return null;
    if (typeof g.version !== 'number' || !Number.isInteger(g.version) || g.version < 1) return null;
    if (typeof g.hash !== 'string' || g.hash.length > 128) return null;
    if (!Array.isArray(g.guides) || g.guides.length === 0 || g.guides.length > MAX_GUIDES) return null;
    const seen = new Set<string>();
    const guides: GuidePage[] = [];
    for (const p of g.guides as unknown[]) {
        if (!p || typeof p !== 'object') return null;
        const page = p as Record<string, unknown>;
        if (typeof page.slug !== 'string' || !SLUG_RE.test(page.slug) || seen.has(page.slug)) return null;
        seen.add(page.slug);
        if (!isText(page.title, 120) || !isText(page.summary, 300)) return null;
        if (!Array.isArray(page.blocks) || page.blocks.length === 0 || page.blocks.length > MAX_BLOCKS) return null;
        const blocks: GuideBlock[] = [];
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
            } else {
                return null;
            }
        }
        guides.push({ slug: page.slug, title: page.title, summary: page.summary, blocks });
    }
    return { schema: GUIDE_SCHEMA, version: g.version, hash: g.hash, guides };
}

const BUNDLED = validateGuide(bundledGuide);

/** The copy shipped inside this build of the app. */
export function getBundledGuide(): Guide {
    // The package's own tests validate this file, and this app's tests validate it with this function.
    if (!BUNDLED) throw new Error('The bundled members\' guide is invalid');
    return BUNDLED;
}

/** The newer of two copies; the first wins a tie. */
export function newerGuide(a: LoadedGuide, b: LoadedGuide | null): LoadedGuide {
    return b && b.guide.version > a.guide.version ? b : a;
}

export interface GuideStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/** Bundled copy, or the cached website copy when that is newer. Never throws, never touches the network. */
export async function loadLocalGuide(storage: GuideStorage, bundled: Guide = getBundledGuide()): Promise<LoadedGuide> {
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

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * Fetch the website's copy. Returns it (and caches it) only when it is valid and newer than `current`;
 * otherwise null. Never throws — offline, a slow network, a 404 or a bad file all mean "keep what you have".
 */
export async function refreshGuideFromWebsite(
    current: Guide,
    storage: GuideStorage,
    fetchImpl: FetchLike,
    timeoutMs = 8000,
): Promise<Guide | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const res = await fetchImpl(GUIDE_URL, { signal: controller?.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.length > MAX_BYTES) return null;
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

export function findGuidePage(guide: Guide, slug: string): GuidePage | null {
    return guide.guides.find(g => g.slug === slug) ?? null;
}

/** "a **b** c" → [{text:'a ',bold:false},{text:'b',bold:true},{text:' c',bold:false}]. */
export function splitBold(text: string): Array<{ text: string; bold: boolean }> {
    return text.split('**')
        .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
        .filter(s => s.text.length > 0);
}
