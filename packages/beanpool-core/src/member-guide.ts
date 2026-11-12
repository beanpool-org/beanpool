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
 *
 * The guide's titles and summaries in the member's language (slice S5a): each language's titles file
 * (packages/beanpool-guide/content/<lang>/manifest.json, bundled by each app) is laid over the English with
 * guideInLanguage, below. The page bodies stay English until slice S5b.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { PSEUDO_LANG, isLang, pseudoLocalise, type Lang, type UiLang } from './words.js';

/** Bump when the JSON shape changes in a way an older app could not read. An app refuses other schemas. */
export const GUIDE_SCHEMA = 2;
export const GUIDE_URL = 'https://beanpool.org/guide/guide.json';
export const GUIDE_CACHE_KEY = 'beanpool_member_guide_v2';

export function guideUrl(lang: string = 'en'): string {
    return lang === 'en' ? GUIDE_URL : `https://beanpool.org/guide/${lang}/guide.json`;
}

export function guideCacheKey(lang: string = 'en'): string {
    return lang === 'en' ? GUIDE_CACHE_KEY : `${GUIDE_CACHE_KEY}:${lang}`;
}

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
    /** One or two sentences for the "?" sheet on the screen this page explains (help-map.ts), written for "you are here". */
    help?: string;
    blocks: B[];
    /**
     * Set by guideInLanguage: the English of each line it shows in the member's language instead, and only those. Search
     * finds the page by these too, and a Learn video matches the English title.
     */
    english?: { title?: string; summary?: string; help?: string };
    sourceHash?: string;
    'source-hash'?: string;
    /** English blocks kept when a page is shown in another language, for English search and "Read in English". */
    englishBlocks?: B[];
    /** Whether the translated body is current, behind the English body, or missing. */
    bodyState?: 'current' | 'behind' | 'missing';
    /** Whether the translated body is behind today's English body. */
    newerInEnglish?: boolean;
    /** Whether the body remains English while in another language. */
    bodyInEnglish?: boolean;
}

export type OperatorGuidePage = GuidePage<OperatorGuideBlock>;

export interface GuideSection {
    id: string;
    title: string;
    summary: string;
    /** The pages in this section, in reading order. */
    slugs: string[];
    /** Set by guideInLanguage: the English of each line it shows in the member's language instead. */
    english?: { title?: string; summary?: string };
}

export interface Guide<P = GuidePage> {
    schema: number;
    version: number;
    hash: string;
    language?: string;
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
        // Optional and tolerant: a help line that isn't one is left out (the sheet falls back to the summary), never the guide.
        if (isText(page.help, 160)) out.help = page.help as string;
        const sh = (typeof page.sourceHash === 'string' && /^[0-9a-f]{16}$/.test(page.sourceHash)) ? page.sourceHash
            : (typeof page['source-hash'] === 'string' && /^[0-9a-f]{16}$/.test(page['source-hash'])) ? page['source-hash'] : undefined;
        if (sh) {
            out.sourceHash = sh;
            out['source-hash'] = sh;
        }
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
        const isLangGuide = typeof g.language === 'string';
        if (!isLangGuide && !page.related.every(r => r !== page.slug && seen.has(r))) return null;
        if (isLangGuide && !page.related.every(r => r !== page.slug && SLUG_RE.test(r))) return null;
    }
    const result: OperatorGuide = { schema: GUIDE_SCHEMA, version: g.version, hash: g.hash, sections, guides };
    if (typeof g.language === 'string') result.language = g.language;
    return result;
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
    lang = 'en',
): Promise<Guide | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const url = guideUrl(lang);
        const cacheKey = guideCacheKey(lang);
        const res = await fetchImpl(url, { signal: controller?.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.length > GUIDE_MAX_BYTES) return null;
        const remote = validateGuide(JSON.parse(text));
        if (!remote || remote.version <= current.version) return null;
        try { await storage.setItem(cacheKey, JSON.stringify(remote)); } catch { /* shown now; cached next time */ }
        return remote;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Bundled or cached copy of a language's guide, or null if not yet cached. */
export async function loadCachedLanguageGuide(
    storage: GuideStorage,
    lang: string,
): Promise<Guide | null> {
    if (lang === 'en' || (!isLang(lang) && lang !== 'xx')) return null;
    try {
        const raw = await storage.getItem(guideCacheKey(lang));
        if (!raw) return null;
        const g = validateGuide(JSON.parse(raw));
        if (!g || g.language !== lang) return null;
        return g;
    } catch {
        return null;
    }
}

/**
 * Fetch a language's guide from the website (beanpool.org/guide/<lang>/guide.json).
 * Saves to storage under GUIDE_CACHE_KEY + ':' + lang only when newer than current.
 * Never throws.
 */
export async function refreshLanguageGuideFromWebsite(
    current: Guide | null,
    storage: GuideStorage,
    fetchImpl: GuideFetch,
    lang: string,
    timeoutMs = 8000,
): Promise<Guide | null> {
    if (lang === 'en' || (!isLang(lang) && lang !== 'xx')) return null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const res = await fetchImpl(guideUrl(lang), { signal: controller?.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.length > GUIDE_MAX_BYTES) return null;
        const remote = validateGuide(JSON.parse(text));
        if (!remote || remote.language !== lang || (current && remote.version <= current.version)) return null;
        try { await storage.setItem(guideCacheKey(lang), JSON.stringify(remote)); } catch { /* shown now; cached next time */ }
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
// of a longer one: "vot" finds "voting"; a plural finds its singular: "gifts" finds "gift"). Titles weigh most, then
// summaries, headings, then the body. A page whose title (best) or summary has more of the typed words comes before
// one that only says them in its body, however often (the credit-risk page says "gift" in most paragraphs; the page
// named for sending one is "Sending a gift"). Pages that tie on that are ordered by score, then title. The question and
// filler words of a query ("how do I", "what is the", "cómo puedo") are not among the words that must match. If any was
// left out, a query that is exactly a page's title still puts that page first ("your deals" is "Your deals", not one of
// the four pages named "deals").

/** Words members may type that the guide deliberately says differently. */
export const GUIDE_SEARCH_SYNONYMS: Record<string, string[]> = {
    tier: ['badge'], tiers: ['badge'], rank: ['badge'], level: ['badge'],
    escrow: ['held'], deposit: ['held'],
    demurrage: ['circulation'], tax: ['fee'],
    seed: ['words'], phrase: ['words'], password: ['words'], mnemonic: ['words'], backup: ['words'],
    chat: ['message', 'talk'], dm: ['message'], inbox: ['message'],
    money: ['beans'], coins: ['beans'], currency: ['beans'], credits: ['beans'],
    give: ['gift'],
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
// Beside ASCII and general punctuation: the Devanagari danda (\u0964\u0965) and the Arabic comma, semicolon and question
// mark and the Urdu full stop (\u060c\u061b\u061f\u06d4), which normalize() leaves as they are, so that a question typed in
// Hindi, Arabic, Persian or Urdu does not carry its "?" into its last word. (Full-width marks fold to ASCII ones.)
const SEPARATORS = /[\s!-/:-@[-`{-~\u00a0-\u00bf\u2000-\u206f\u3000-\u303f\u0964\u0965\u060c\u061b\u061f\u06d4]+/;
const words = (s: string) => fold(s).split(SEPARATORS).filter(Boolean);

// ─── Question and filler words ───────────────────────────────────────────────
// Members type questions ("how do I send a gift"), but the page that answers one never says "how" or "do". So the words
// that only make a sentence a question, or only join its parts (articles, "can", "my", "of"), do not have to match: they
// are dropped from the query before it is matched, unless nothing else is left (a query made only of them, "how do I",
// searches as typed). One list for each language the guide has, drafted from that language's commonest question openers,
// helpers, articles, prepositions and "I/my" words, as members type them (a word is listed as written; accents and case
// are folded when the list is read, so "Cómo" and "como" are one).
// A search drops the words of TWO lists only: that of the language the guide is shown in (the `lang` the screens pass),
// and English, because members often type English whatever their language is (the guide is searched by both). Never the
// lists of all 25 together: a word that is filler in one language is a real word in another ("beni" is Turkish "me" and
// Italian "goods", as in "I Beni comuni"; "dư" folds to French "du"), and a query must not lose its words to a language
// it is not in. English is compared as typed, accents and all, in another language's guide: Vietnamese "dò" (survey)
// folds to "do" but is not the English "do". Nothing goes on the English list that is a word of another language's page
// titles (French "don" is "gift": it stays off), unless that language lists it too ("in", Italian and German), and
// nothing goes on any list that is a search synonym (GUIDE_SEARCH_SYNONYMS: Vietnamese "ban" stays off). The guide tests
// check the first against every translated title and the second against GUIDE_SEARCH_SYNONYMS.
// Chinese and Japanese are written without spaces, so only a question word typed as a word of its own is dropped there.
// A word of one letter is never searched, so none is listed.
const list = (s: string): readonly string[] => s.split(' ');
export const GUIDE_FILLER_WORDS: Readonly<Record<Lang, readonly string[]>> = {
    en: list('how do does did doing can could should would will what whats where when who whom whose why which is are am was were be it its the an of to for in on at with from about into and or if me my we us our you your there please want wanna doesn didn isn aren wasn weren couldn shouldn wouldn ll ve re'),
    es: list('como que donde cuando quien quienes cual cuales cuanto cuantos porque por es son esta estan el la los las un una unos unas de del al en con para mi mis me yo se lo puedo puede pueden hago hay quiero'),
    pt: list('como que onde quando quem qual quais quanto quantos porque por esta estao sao um uma uns umas os as de do da dos das em na nos nas com para pra ou eu me meu minha meus minhas posso pode podem se ao aos pelo pela quero faco fazer'),
    hi: list('कैसे क्या कहाँ कहां कब कौन क्यों कौनसा मैं मुझे मेरा मेरी मेरे को का की के से में पर है हैं यह ये वह वो और या लिए करें करना करूं कर सकता सकती सकते हो कृपया चाहिए चाहता चाहती हूँ हूं तरीका'),
    bn: list('কিভাবে কীভাবে কি কী কোথায় কখন কে কেন কোন আমি আমার আমাকে এবং এই সেই একটি একটা করতে করব করি করবো করুন পারি পারব পারবো হয় আছে কিছু জন্য থেকে সম্পর্কে'),
    fr: list('comment que quoi ou quand qui pourquoi quel quelle quels quelles combien est sont ce cet cette ces qu je me mon ma mes le la les un une des du de au aux en dans sur pour avec et peux peut puis dois veux faire il on'),
    ar: list('كيف كيفية ما ماذا ماهو هل أين اين متى من لماذا في على إلى الى عن هو هي أنا انا لي أن ان مع هذا هذه ذلك أو او أريد اريد أستطيع استطيع يمكنني يمكن ممكن'),
    id: list('bagaimana gimana bagaimanakah apa apakah siapa kapan kenapa mengapa mana dimana di ke dari yang ini itu adalah ada dan atau untuk dengan pada saya aku bisa bisakah dapat cara tolong ingin mau sebuah suatu'),
    ru: list('как что где когда кто почему зачем какой какая какое какие какую это мне мой моя мое мои можно ли на по для от до из со во или но же бы хочу могу сделать делать'),
    'zh-Hans': list('怎么 怎样 如何 怎么样 什么 是什么 哪里 哪儿 什么时候 为什么 为何 可以 能否 请问 我的 我想 我要 我该 有没有 怎么才能'),
    'zh-Hant': list('怎麼 怎樣 如何 怎麼樣 什麼 是什麼 哪裡 哪裏 哪兒 什麼時候 為什麼 為何 可以 能否 請問 我的 我想 我要 我該 有沒有 怎麼才能'),
    it: list('come cosa che cos dove quando chi perche quale quali quanto sono il lo la gli le un uno una di del dello della dei degli delle al allo alla agli alle da dal dalla in nel nella su sul sulla con per mio mia miei mie mi io posso voglio faccio fare'),
    de: list('wie was wo wann wer wen wem warum wieso weshalb welche welcher welches welchen ist sind kann kannst konnen ich mich mir mein meine meinen meiner meinem der die das den dem des ein eine einen einem einer und oder zu zum zur von vom fur mit in im auf an am bei man wird muss es gibt habe mochte will'),
    tr: list('nasıl nasil ne nedir nelerdir nerede nereden nereye neden niçin kim kimin hangi kaç mı mi mu mü bir bu ve ile için ben bana benim beni var yapılır yapilir yapabilirim edebilirim olur da de ki ya'),
    sw: list('jinsi vipi nini wapi lini nani kwa ya wa za la kwenye na ni mimi yangu wangu langu zangu naweza ninaweza ninawezaje unaweza je hii huu huo hili hizi ile kuhusu ili au pia'),
    ml: list('എങ്ങനെ എന്ത് എന്താണ് എവിടെ എപ്പോൾ ആര് ആരാണ് എന്തിന് ഞാൻ എന്റെ എനിക്ക് ഒരു ചെയ്യാം ചെയ്യണം ചെയ്യാൻ എങ്ങനെയാണ് ഉണ്ടോ ആണ് പറ്റുമോ കഴിയുമോ വേണം'),
    ta: list('எப்படி என்ன என்னது எங்கே எங்கு எப்போது யார் ஏன் எது எந்த நான் என் எனக்கு என்னுடைய ஒரு இந்த அந்த மற்றும் அல்லது உள்ள இருக்கிறது முடியுமா செய்வது செய்ய வேண்டும் எவ்வாறு'),
    uk: list('як що де коли хто чому навіщо який яка яке які це мені мій моя моє мої можна чи на із по для від до та але хочу можу зробити робити'),
    ur: list('کیسے کیا کہاں کب کون کیوں کونسا میں مجھے میرا میری میرے کو کا کی کے سے پر ہے ہیں یہ وہ اور یا لیے ہو ہوں کر کرنا کروں کریں سکتا سکتی سکتے چاہتا چاہتی'),
    fa: list('چگونه چطور چه چی چیست کجا کی چرا آیا کدام من ما را به در از که این آن با برای یا است هست می توانم میتوانم میخواهم خواهم کنم بکنم'),
    vi: list('lam the nao sao nhu gi la dau đâu khi toi minh cua va hoac voi trong tren de để co mot cac nhung'),
    el: list('πώς τι ποιος ποια ποιο ποιοι ποιες που πότε γιατί είναι το οι τα των του της τον την ένα μια ενας και να για με σε από στο στη στην στον στα μου μας μπορώ θέλω θα κάνω κάνει'),
    fil: list('paano ano anong saan kailan sino bakit alin ang ng sa mga ko ako ba at na ay para isang mo ka natin namin maaari pwede puwede po kung ito iyon yung'),
    ja: list('どう どうやって どのように どうすれば どうやったら 方法 やり方 ですか ますか とは について できますか できる したい ください 教えて どこ いつ なぜ だれ どれ どの これ それ あの'),
    ko: list('어떻게 무엇 어디 언제 누가 누구 어떤 무슨 어느 제가 내가 나는 저는 에서 으로 하는 하나요 할까요 있나요 있어요 방법 알려줘 알려주세요 인가요 이란 하려면 뭐예요 무엇인가요 가능한가요'),
};

const fillerSets = new Map<Lang, ReadonlySet<string>>();
/** One language's filler words, folded the way a query is. */
function fillerSet(lang: Lang): ReadonlySet<string> {
    let set = fillerSets.get(lang);
    if (!set) {
        set = new Set(GUIDE_FILLER_WORDS[lang].flatMap(w => words(w)));
        fillerSets.set(lang, set);
    }
    return set;
}

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

/** `words(query)` with the accents kept, to tell a Vietnamese "dò" from the English "do" (`words` folds both to "do"). */
function accentedWords(query: string): string[] {
    let out = query.toLowerCase();
    try { out = out.normalize('NFKD'); } catch { /* keep accents */ }
    return out.replace(/\*\*/g, '').split(SEPARATORS).filter(Boolean);
}

/**
 * The words of `query` that are searched: each one once, none of one letter, the first eight. Question and filler words
 * (the lists of `lang` and of English: "how", "do", "the", "cómo", "wie"...) are left out, but never all of it: a query
 * made only of them is searched as typed. `dropped` says whether any filler word was left out. A language the guide does
 * not have (the pseudo-locale, or none given) gets the English list only.
 */
function searchTerms(query: string, lang: string | undefined): { terms: string[]; dropped: boolean } {
    const key: Lang = isLang(lang) ? lang : 'en';
    const own = fillerSet(key);
    const english = key === 'en' ? null : fillerSet('en');
    const folded = words(query);
    const kept = accentedWords(query);
    const lined = kept.length === folded.length;
    // A word is filler for the language of the guide when it is on that list (accents folded: "como" for "cómo"), or for
    // English when it is on that list and was typed without accents.
    const isFiller = (w: string, i: number) => own.has(w) || (english !== null && english.has(w) && (!lined || kept[i] === w));
    // Each word once, as filler only when every time it was typed it was.
    const fillerOnly = new Map<string, boolean>();
    folded.forEach((w, i) => { if (w.length >= 2) fillerOnly.set(w, (fillerOnly.get(w) ?? true) && isFiller(w, i)); });
    const typed = [...fillerOnly.keys()];
    const asked = typed.filter(w => !fillerOnly.get(w));
    if (asked.length === 0) return { terms: typed.slice(0, 8), dropped: false };
    return { terms: asked.slice(0, 8), dropped: asked.length < typed.length };
}

const sameWords = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Pages matching every word of `query`, best first. An empty query finds nothing. The question and filler words of a
 * query ("how do I send a gift") do not have to match; see GUIDE_FILLER_WORDS. Only the words of `lang` (the language the
 * guide is shown in; else the guide's own `language`; else none) and of English are left out, never another language's.
 */
export function searchGuide<P extends GuidePage<OperatorGuideBlock> = GuidePage>(
    guide: Guide<P>,
    query: string,
    limit = 20,
    lang?: string,
): Array<GuideSearchResult<P>> {
    const { terms, dropped } = searchTerms(query, lang ?? guide.language);
    if (terms.length === 0) return [];
    const typedWords = dropped ? words(query) : [];
    const results: Array<{ result: GuideSearchResult<P>; named: number; exact: number }> = [];
    for (const page of guide.guides) {
        // A page shown in the member's language is found by its English too: a member may type either.
        const title = [...words(page.title), ...(page.english?.title ? words(page.english.title) : [])];
        const summary = [...words(page.summary), ...(page.english?.summary ? words(page.english.summary) : [])];
        const allBlocks = page.englishBlocks ? [...page.blocks, ...page.englishBlocks] : page.blocks;
        const blocks = blockTexts({ blocks: allBlocks as readonly OperatorGuideBlock[] }).map(b => ({ ...b, words: words(b.text) }));
        let score = 0;
        /** How well the page's title and summary have the typed words: each word counts 2 if the title has it, else 1 if the summary does. */
        let named = 0;
        let firstHit: { text: string; term: string } | null = null;
        let everyTerm = true;
        for (const term of terms) {
            const alternatives = [term, ...(GUIDE_SEARCH_SYNONYMS[term] ?? [])];
            // A plural also finds the whole singular word (not its prefix: "beans" must not find every "BeanPool").
            const singular = term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : null;
            const matches = (w: string) => alternatives.some(a => w.startsWith(a)) || w === singular;
            const hits = (ws: string[]) => ws.filter(matches).length;
            const inTitle = hits(title);
            const inSummary = hits(summary);
            let termScore = inTitle * 10 + inSummary * 5;
            for (const b of blocks) {
                const n = hits(b.words);
                if (n === 0) continue;
                termScore += Math.min(n, 3) * (b.heading ? 3 : 1);
                if (!firstHit) firstHit = { text: b.text, term: b.words.find(matches)! };
            }
            if (termScore === 0) { everyTerm = false; break; }
            score += termScore;
            named += inTitle > 0 ? 2 : inSummary > 0 ? 1 : 0;
        }
        if (!everyTerm) continue;
        /** 1 when filler was left out of the query and what was typed is the page's whole title (or its English one). */
        const exact = dropped && (sameWords(typedWords, words(page.title)) || (page.english?.title !== undefined && sameWords(typedWords, words(page.english.title)))) ? 1 : 0;
        results.push({ result: { page, score, snippet: firstHit ? snippetAround(firstHit.text, firstHit.term) : page.summary }, named, exact });
    }
    return results
        .sort((a, b) => b.exact - a.exact || b.named - a.named || b.result.score - a.result.score || a.result.page.title.localeCompare(b.result.page.title))
        .slice(0, limit)
        .map(r => r.result);
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
//   - the video's title is the page's title (ignoring case, spaces and punctuation): its English title, as BeanPool's
//     videos are titled, when the page is shown in another language.

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
    const key = titleKey(page.english?.title ?? page.title);
    return safe.find(x => titleKey(x.v.title) === key)?.v ?? null;
}

// ─── The guide in the member's language (slice S5a) ──────────────────────────
// English is the source. Each language has one titles file (packages/beanpool-guide/content/<lang>/manifest.json; its
// shape and checks are in packages/beanpool-guide/src/titles.mjs) holding section titles and summaries and each page's
// title, summary and help line, each entry with the hash of the English it was drafted from. A line shows in the
// member's language only while that hash is the hash of the English the app is showing: when a newer guide (bundled or
// from beanpool.org) says something else in English, the English shows until the next drafting round. Never a stale
// translation, never a blank line. In the pseudo-locale every line is pseudo-localised, so the 320 dp checks measure it.

/** One translated line: the words, and the hash of the English they were drafted from (guideSourceHash). */
export interface GuideTitleEntry {
    text: string;
    sourceHash: string;
}

/** A language's titles file. Any entry may be missing: that line stays English. */
export interface GuideTitles {
    sections?: Record<string, { title?: GuideTitleEntry; summary?: GuideTitleEntry }>;
    pages?: Record<string, { title?: GuideTitleEntry; summary?: GuideTitleEntry; help?: GuideTitleEntry }>;
}

/** The hex digits of sha256 a titles entry keeps (packages/beanpool-guide/src/titles.mjs keeps the same). */
export const GUIDE_SOURCE_HASH_LENGTH = 16;
const sourceHashes = new Map<string, string>();

/** The hash of an English line, as a titles entry records it: the first 16 hex digits of the sha256 of its UTF-8. */
export function guideSourceHash(english: string): string {
    let hash = sourceHashes.get(english);
    if (hash === undefined) {
        hash = bytesToHex(sha256(utf8ToBytes(english))).slice(0, GUIDE_SOURCE_HASH_LENGTH);
        if (sourceHashes.size >= 4000) sourceHashes.clear();
        sourceHashes.set(english, hash);
    }
    return hash;
}

/**
 * The hash of an English page body (the canonical JSON of its blocks): the first 16 hex digits of sha256.
 * Both the build and the client apps compute this from the page's blocks.
 */
export function guideBodyHash(pageOrBlocks: { blocks: readonly OperatorGuideBlock[] } | readonly OperatorGuideBlock[]): string {
    const blocks: readonly OperatorGuideBlock[] = Array.isArray(pageOrBlocks)
        ? (pageOrBlocks as readonly OperatorGuideBlock[])
        : (pageOrBlocks as { blocks: readonly OperatorGuideBlock[] }).blocks;
    const canonical = blocks.map((b: OperatorGuideBlock) => b.type === 'ul' ? { type: 'ul', items: b.items } : { type: b.type, text: (b as { text: string }).text });
    return guideSourceHash(JSON.stringify(canonical));
}

const ownObject = (o: unknown, key: string): Record<string, unknown> => {
    if (!o || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, key)) return {};
    const v = (o as Record<string, unknown>)[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
};

/** The translation of one line, or null: missing, not a line the apps take, or drafted from other English (stale). */
function translatedLine(entry: unknown, english: string, max: number): string | null {
    if (!entry || typeof entry !== 'object') return null;
    const { text, sourceHash } = entry as Record<string, unknown>;
    if (typeof text !== 'string' || typeof sourceHash !== 'string' || !text.trim() || text.length > max) return null;
    return sourceHash === guideSourceHash(english) ? text : null;
}

/**
 * The guide with its titles, summaries and help lines in `lang` wherever `titles` (that language's titles file) has a
 * current translation, else English; in the pseudo-locale, every one pseudo-localised.
 * When `translatedGuide` (slice S5b) holds translated pages:
 *   - matching source-hash: shows translated body;
 *   - behind: shows translated body with newerInEnglish = true;
 *   - missing / none: shows English body with bodyInEnglish = true.
 */
export function guideInLanguage<P extends GuidePage<OperatorGuideBlock>>(
    guide: Guide<P>,
    lang: UiLang,
    titles?: unknown,
    translatedGuide?: Guide | null,
): Guide<P> {
    const pseudo = lang === PSEUDO_LANG;
    if (!pseudo && (!isLang(lang) || lang === 'en')) return guide;
    try {
        const line = (entry: unknown, english: string, max: number): string | null =>
            pseudo ? pseudoLocalise(english) : translatedLine(entry, english, max);
        const sectionTitles = ownObject(titles, 'sections');
        const pageTitles = ownObject(titles, 'pages');
        const translatedPages = new Map<string, GuidePage<OperatorGuideBlock>>();
        if (translatedGuide && (!translatedGuide.language || translatedGuide.language === lang) && Array.isArray(translatedGuide.guides)) {
            for (const tp of translatedGuide.guides) {
                if (tp && typeof tp.slug === 'string') translatedPages.set(tp.slug, tp as GuidePage<OperatorGuideBlock>);
            }
        }
        let changed = false;
        const sections = guide.sections.map((s): GuideSection => {
            const e = ownObject(sectionTitles, s.id);
            const title = line(e.title, s.title, 80);
            const summary = line(e.summary, s.summary, 300);
            if (title === null && summary === null) return s;
            changed = true;
            return {
                ...s, title: title ?? s.title, summary: summary ?? s.summary,
                english: { ...(title !== null ? { title: s.title } : {}), ...(summary !== null ? { summary: s.summary } : {}) },
            };
        });
        const guides = guide.guides.map((p): P => {
            const e = ownObject(pageTitles, p.slug);
            const tp = translatedPages.get(p.slug);
            let title = line(e.title, p.title, 120);
            let summary = line(e.summary, p.summary, 300);
            const help = p.help !== undefined ? line(e.help, p.help, 160) : null;
            let blocks = p.blocks;
            let englishBlocks: typeof p.blocks | undefined = undefined;
            let bodyState: 'current' | 'behind' | 'missing';
            let newerInEnglish: boolean;
            let bodyInEnglish: boolean;
            let sourceHash = p.sourceHash;

            if (tp) {
                const enHash = guideBodyHash(p);
                const tpHash = tp.sourceHash ?? tp['source-hash'];
                sourceHash = tpHash;
                const isCurrent = tpHash === enHash;
                englishBlocks = p.blocks;
                blocks = tp.blocks as typeof p.blocks;
                if (!title && tp.title) title = tp.title;
                if (!summary && tp.summary) summary = tp.summary;
                bodyInEnglish = false;
                if (isCurrent) {
                    bodyState = 'current';
                    newerInEnglish = false;
                } else {
                    bodyState = 'behind';
                    newerInEnglish = true;
                }
            } else {
                bodyState = 'missing';
                bodyInEnglish = title !== null || summary !== null;
                newerInEnglish = false;
            }

            if (title === null && summary === null && help === null && !tp && !translatedGuide) return p;
            changed = true;
            return {
                ...p,
                title: title ?? p.title,
                summary: summary ?? p.summary,
                ...(help !== null ? { help } : {}),
                blocks,
                ...(englishBlocks ? { englishBlocks } : {}),
                bodyState,
                newerInEnglish,
                bodyInEnglish,
                ...(sourceHash ? { sourceHash, 'source-hash': sourceHash } : {}),
                english: {
                    ...(title !== null ? { title: p.title } : {}),
                    ...(summary !== null ? { summary: p.summary } : {}),
                    ...(help !== null ? { help: p.help } : {}),
                },
            };
        });
        return changed ? { ...guide, sections, guides } : guide;
    } catch {
        return guide;
    }
}

/**
 * Whether a page's body is in English while shown in another language (missing translation or offline fallback).
 * A translated page (current or behind) returns false.
 */
export function guidePageBodyInEnglish(page: GuidePage<OperatorGuideBlock>): boolean {
    if (page.bodyInEnglish === false || page.newerInEnglish) return false;
    if (page.bodyInEnglish === true) return true;
    return page.english?.title !== undefined || page.english?.summary !== undefined;
}

/** Whether a translated page is behind the English body ("This page is newer in English."). */
export function guidePageNewerInEnglish(page: GuidePage<OperatorGuideBlock>): boolean {
    return !!page.newerInEnglish;
}

/** Whether a page's body is current, behind the English body, or missing a translation. */
export function guidePageBodyState(page: GuidePage<OperatorGuideBlock>): 'current' | 'behind' | 'missing' {
    return page.bodyState ?? 'missing';
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
