/**
 * Pictures from Wikimedia Commons for a draft of Local knowledge (DESIGN-learn-web-pictures-fable.md §6.1, §6.5, §9 slice 2;
 * Marty, 22 Nov 2026, "All six of Fable's picks"). The one door from the web to a Learn page:
 *
 * - **Only a file's page on Commons**, https://commons.wikimedia.org/wiki/File:…, never a picture's own address: the assistant
 *   names the file, and this server builds every request itself, to Commons' fixed hosts.
 * - **The node reads the licence and the maker itself**, in one question to Commons' API for all the files of a draft
 *   (prop=imageinfo|categories, iiurlwidth=960), and takes a picture only when what it reads is plainly one of the open set
 *   (Question 2): public domain, CC0, CC BY 4.0, CC BY-SA 4.0. Anything else, anything unclear, a file marked not free and a
 *   file up for deletion (Commons says so only in its categories) is refused in words that name what Commons said. The table
 *   is pinned to Commons' real answers (test-commons-pictures.ts, fixtures/commons/).
 * - **Commons' own 960 px copy**, from its picture host only, through the safe fetch photos use (agent/owner-photos.ts
 *   fetchFixedHost: one at a time, 5 MB, 8 seconds, no redirect), then the steps every photo takes (owner-posts.ts
 *   storableImage: 800 px, nothing hidden in it). Never the original.
 * - **Each picture is a try in the assistant's photo day** (admitAgentPhoto), counted before the question is asked.
 * - **The credit** (core KnowledgePhotoCredit): the file's page, its name, the maker (plain text, cleaned, capped), the
 *   licence's own short name and page, Commons' notes on other rights, the day read. The engine keeps it with the picture
 *   (engine/knowledge.ts creditRowOf).
 * - Commons sees this server's address and a BeanPool user agent naming this server's own address when it has one, as a
 *   Pulse link's host does. It never sees a member: the apps load the node's copy. The log names the host, never a path.
 *
 * Every word here is MCP tool text an assistant reads, outside the members' word index.
 */
import { KNOWLEDGE_LIMITS, type KnowledgePhotoCredit } from '@beanpool/core';
import {
    PayloadTooLargeError, ProhibitedContentTypeError, RequestTimeoutError, type SsrfSafeResponse,
} from '../engine/pulse-resolver.js';
import { cleanMemberText, fence } from './fence.js';
import { admitAgentPhoto, agentPhotosPerDay, agentPhotosToday } from './limits.js';
import { logger } from '../logger.js';
import { fetchFixedHost, photoDayFull, PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES } from './owner-photos.js';
import { AGENT_PHOTO_MAX_INPUT_SIDE, storableImage } from './owner-posts.js';

/** Commons' own host: its file pages and its API. */
export const COMMONS_HOST = 'commons.wikimedia.org';
/** Where Commons serves its pictures' copies (its real answers give thumb.wikimedia.org; older ones upload.wikimedia.org). */
export const COMMONS_PICTURE_HOSTS: readonly string[] = ['upload.wikimedia.org', 'thumb.wikimedia.org'];
/** The copy asked for: a size Commons serves (it serves fixed sizes; 960 is one), made 800 px here. */
export const COMMONS_COPY_WIDTH = 960;
/** Commons' answer about at most 3 files: far under this. */
const ANSWER_MAX_BYTES = 2 * 1024 * 1024;
/** The maker as kept: the label holds less (core knowledgeCreditLabel); the rest is on Commons, one tap away. */
const MAKER_MAX = 200;

/** A file's name, written into the call at most this many bytes (MediaWiki's own limit is 255 for the whole title). */
const NAME_MAX_BYTES = 240;
/** Characters no MediaWiki title holds, and the slash no file name holds. */
const NOT_IN_A_NAME = /[#<>[\]|{}/\p{Cc}]/u;

/**
 * A file's name on Commons from the address of its page, or null for anything else: https only, Commons' own host with no
 * port, user or password, the path /wiki/File:… (a query or a fragment is ignored). Spaces, underscores and percent signs read
 * as MediaWiki reads them, the first letter capitalised, so the same file in any spelling has one name.
 */
export function commonsFileName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (s.length > 2048) return null;
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || u.hostname !== COMMONS_HOST || u.port !== '' || u.username || u.password) return null;
    const m = /^\/wiki\/File:(.+)$/.exec(u.pathname);
    if (!m) return null;
    let name: string;
    // NFC as MediaWiki normalises a request: a decomposed spelling of a real file's name is the same file (review of #3351).
    try { name = decodeURIComponent(m[1]).normalize('NFC'); } catch { return null; }
    name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || NOT_IN_A_NAME.test(name) || Buffer.byteLength(name) > NAME_MAX_BYTES) return null;
    const [first, ...rest] = Array.from(name);
    return first.toUpperCase() + rest.join('');
}

/** A file's page on Commons, as this server writes it: the credit's link. */
export function commonsFilePage(name: string): string {
    return `https://${COMMONS_HOST}/wiki/File:${encodeURIComponent(name.replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2C/g, ',')}`;
}

// ── The licence table (Question 2) ───────────────────────────────────────────────────────────

interface OpenLicence { code: string; names: readonly string[]; name: string; url: string | null; link: RegExp | null; credit: boolean }

/**
 * The open set, as Commons' answers name each licence (extmetadata: License, LicenseShortName, LicenseUrl), pinned to its
 * real answers. A licence's page may be written with or without a slash, a deed or the legal code.
 */
export const COMMONS_OPEN_LICENCES: readonly OpenLicence[] = [
    { code: 'cc-by-4.0', names: ['CC BY 4.0'], name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', link: /^https?:\/\/creativecommons\.org\/licenses\/by\/4\.0(?:\/(?:deed\.[a-z-]+|legalcode(?:\.[a-z-]+)?)?)?$/i, credit: true },
    { code: 'cc-by-sa-4.0', names: ['CC BY-SA 4.0'], name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/', link: /^https?:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0(?:\/(?:deed\.[a-z-]+|legalcode(?:\.[a-z-]+)?)?)?$/i, credit: true },
    { code: 'cc0', names: ['CC0', 'CC0 1.0'], name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', link: /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0(?:\/(?:deed\.[a-z-]+|legalcode(?:\.[a-z-]+)?)?)?$/i, credit: false },
    { code: 'pd', names: ['Public domain'], name: 'Public domain', url: null, link: /^https?:\/\/creativecommons\.org\/publicdomain\/mark\/1\.0(?:\/(?:deed\.[a-z-]+)?)?$/i, credit: false },
];

type Meta = Record<string, { value?: unknown } | undefined>;
const metaText = (em: Meta | undefined, key: string): string => (typeof em?.[key]?.value === 'string' ? (em[key]!.value as string).trim() : '');
/** What Commons said a licence is, for the words: plain, short. */
const saidOf = (s: string): string => cleanMemberText(s, 60).replace(/[<>"]/g, '').replace(/\s+/g, ' ');
/**
 * What Commons calls a file's licence, for refusal words: the file page's own licence markup, which any uploader writes, so it
 * reaches the assistant fenced as the maker does (DESIGN §6.5 "Hostile text"; review of #3351, N1). Empty when it says nothing.
 */
export function commonsSaid(boundary: string, n: number, said: string): string {
    const fenced = fence(boundary, `commons_pictures #${n}, its licence as Commons names it`, said, 60);
    return fenced ? ` What Commons calls its licence:\n${fenced.text}` : '';
}
/** A type as Commons names one (image/jpeg, application/ogg): anything else is not echoed. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]{0,39}\/[a-z0-9][a-z0-9.+-]{0,79}$/;

export type LicenceVerdict =
    | { ok: true; licence: OpenLicence }
    | { ok: false; why: 'not_free' | 'unreadable' | 'not_open' | 'disagree'; said: string };

/**
 * The licence Commons gives a file, decided (DESIGN §9 slice 2, table A): taken only when its machine name, its short name and,
 * where it has one, its link all name the same licence of the open set; refused when Commons marks it not free, gives none it
 * can read, names one outside the set, or names two that disagree (Commons says its values can be unreliable for a file under
 * several licences). Public domain must not also be marked copyrighted.
 */
export function commonsLicence(em: Meta | undefined): LicenceVerdict {
    const short = metaText(em, 'LicenseShortName');
    const code = metaText(em, 'License').toLowerCase();
    const link = metaText(em, 'LicenseUrl');
    const said = saidOf(short || code);
    if (metaText(em, 'NonFree').toLowerCase() === 'true') return { ok: false, why: 'not_free', said };
    if (!short && !code) return { ok: false, why: 'unreadable', said };
    const byCode = COMMONS_OPEN_LICENCES.find((l) => l.code === code);
    const byName = COMMONS_OPEN_LICENCES.find((l) => l.names.some((n) => n.toLowerCase() === short.toLowerCase()));
    if (!byCode && !byName) return { ok: false, why: 'not_open', said };
    if (byCode !== byName || !byCode) return { ok: false, why: 'disagree', said };
    const linkAgrees = link ? !!byCode.link?.test(link) : byCode.url === null;
    if (!linkAgrees) return { ok: false, why: 'disagree', said };
    if (byCode.code === 'pd' && metaText(em, 'Copyrighted').toLowerCase() === 'true') return { ok: false, why: 'disagree', said };
    return { ok: true, licence: byCode };
}

/** A category that says a file is up for deletion on Commons: a request, a speedy one, or a missing licence, source or permission. */
const DELETION = /^(?:Category:)?(?:Deletion requests\b|Candidates for speedy deletion\b|Copyright violations\b|Media without a license\b|Media without a source\b|Media missing permission\b)/i;

/**
 * Whether Commons lists a file as up for deletion: only its categories say so (its answer's `categories`, and the same list in
 * extmetadata's Categories, which a long list's continuation can't cut short). Null when neither came: unclear, so refused.
 */
export function commonsUpForDeletion(page: { categories?: unknown }, em: Meta | undefined): boolean | null {
    const listed = Array.isArray(page.categories) ? page.categories.map((c) => String((c as { title?: unknown })?.title ?? '')) : null;
    const meta = typeof em?.Categories?.value === 'string' ? (em.Categories.value as string).split('|') : null;
    if (listed === null && meta === null) return null;
    return [...(listed ?? []), ...(meta ?? [])].some((c) => DELETION.test(c.trim()));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** HTML as plain text (the maker, which Commons gives as markup): tags out, entities read, hidden characters out, capped. */
export function commonsPlainText(html: string, max = MAKER_MAX): string {
    const text = html
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+|#39);/gi, (m, e: string) => {
            if (/^#x/i.test(e)) { const n = parseInt(e.slice(2), 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; }
            if (/^#/.test(e)) { const n = parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; }
            return ENTITIES[e.toLowerCase()] ?? m;
        });
    return Array.from(cleanMemberText(text, max * 8).replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

/** Still pictures Commons makes a copy of: never sound, video, a document or a moving GIF. */
const STILL = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/svg+xml'];

/** The address of Commons' copy, when it is on Commons' picture host: https, no port, user or password, under /wikipedia/commons/. */
function copyAddress(raw: unknown): URL | null {
    if (typeof raw !== 'string') return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    return u.protocol === 'https:' && COMMONS_PICTURE_HOSTS.includes(u.hostname) && u.port === '' && !u.username && !u.password
        && u.pathname.startsWith('/wikipedia/commons/') ? u : null;
}

/** The user agent Commons asks for: this server's own address as its contact when it has one (one careless node can't get every node refused). */
function userAgent(nodeUrl: string | undefined): string {
    let contact = 'https://beanpool.org';
    try { if (nodeUrl) { const u = new URL(nodeUrl); if (u.protocol === 'https:' || u.protocol === 'http:') contact = u.origin; } } catch { /* the default */ }
    return `BeanPool-Learn/1.0 (+${contact})`;
}

export type CommonsPicture = { photo: string; credit: KnowledgePhotoCredit };
export type CommonsRead = { ok: true; pictures: CommonsPicture[] } | { ok: false; error: string };

export const COMMONS_WORDS = {
    address: (n: number) => `commons_pictures #${n} must be a picture's page on Wikimedia Commons, https://${COMMONS_HOST}/wiki/File:…: never the picture's `
        + 'own address, a category or gallery, or another site.',
    twice: (n: number, first: number) => `commons_pictures #${n} is the same file as #${first}.`,
    unreachable: 'Wikimedia Commons could not be reached: file the draft without commons_pictures, or try again later.',
    missing: (n: number) => `Wikimedia Commons has no file at commons_pictures #${n}: check its page address.`,
    /** `said`: what Commons calls the licence, fenced (commonsSaid), or empty. */
    notOpen: (n: number, said: string) => `commons_pictures #${n} is under a licence this server doesn't take: it takes only public domain, CC0, `
        + `CC BY 4.0 and CC BY-SA 4.0. Pick another picture.${said}`,
    unreadable: (n: number) => `Commons gives no licence this server can read for commons_pictures #${n}: pick another picture.`,
    disagree: (n: number, said: string) => `Commons' licence details for commons_pictures #${n} don't agree, so this server can't tell `
        + `which applies: pick another picture.${said}`,
    notFree: (n: number) => `Commons marks commons_pictures #${n} as not free: pick another picture.`,
    deletion: (n: number) => `commons_pictures #${n} is up for deletion on Commons: pick another picture.`,
    deletionUnclear: (n: number) => `Commons didn't say whether commons_pictures #${n} is up for deletion: try again later, or pick another picture.`,
    notStill: (n: number, mime: string) => `commons_pictures #${n} is not a still picture (Commons lists it as ${MIME_SHAPE.test(mime) ? mime : 'something else'}): `
        + 'pick a photo or drawing.',
    noMaker: (n: number) => `Commons names nobody who made commons_pictures #${n}, and its licence needs that credit: pick another picture.`,
    tooTall: (n: number) => `commons_pictures #${n} is too tall for this server even at ${COMMONS_COPY_WIDTH} pixels wide: pick another picture.`,
    copyElsewhere: (n: number) => `Commons gave the copy of commons_pictures #${n} at an address that is not its picture host, so this server did not fetch it.`,
    longPage: (n: number) => `commons_pictures #${n} has a name too long to link to: pick another picture.`,
    copyFailed: (n: number, why: string) => `Commons' copy of commons_pictures #${n} ${why}: try again later, or file the draft without it.`,
} as const;

/** One refusal, logged with the host only. */
function refuse(grantId: string, host: string, kind: string, error: string): CommonsRead {
    logger.info('AGENT', 'Commons picture refused', { grant: grantId, host, refused: kind });
    return { ok: false, error };
}

interface CommonsPage { title?: unknown; missing?: unknown; invalid?: unknown; categories?: unknown; imageinfo?: unknown }
interface ImageInfo { mime?: unknown; thumburl?: unknown; thumbwidth?: unknown; thumbheight?: unknown; extmetadata?: Meta }

/**
 * The pictures `names` name (each a file's name, from commonsFileName), read and fetched from Commons, each with its credit, in
 * the order given; or the first refusal, in words. The photo day is checked for all of them before anything is asked, and each
 * is counted as tried. Nothing is kept here: the caller files the draft with them or drops them.
 */
export async function readCommonsPictures(grantId: string, names: readonly string[], boundary: string, nodeUrl?: string): Promise<CommonsRead> {
    if (agentPhotosToday(grantId) + names.length > agentPhotosPerDay()) return { ok: false, error: photoDayFull(grantId) };
    for (let i = 0; i < names.length; i++) if (!admitAgentPhoto(grantId)) return { ok: false, error: photoDayFull(grantId) };
    const headers = { 'User-Agent': userAgent(nodeUrl) };
    const api = new URL(`https://${COMMONS_HOST}/w/api.php`);
    for (const [k, v] of Object.entries({
        action: 'query', format: 'json', prop: 'imageinfo|categories', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(COMMONS_COPY_WIDTH),
        cllimit: 'max', titles: names.map((n) => `File:${n}`).join('|'),
    })) api.searchParams.set(k, v);
    let answer: { error?: unknown; query?: { pages?: Record<string, CommonsPage> | CommonsPage[]; normalized?: { from?: unknown; to?: unknown }[] } };
    try {
        answer = await fetchFixedHost(api, { maxBytes: ANSWER_MAX_BYTES, allowedContentTypes: ['application/json'], headers: { ...headers, Accept: 'application/json' } },
            async (res: SsrfSafeResponse) => {
                if (res.status !== 200) throw new Error(`answered ${res.status}`);
                return res.json();
            });
    } catch {
        return refuse(grantId, COMMONS_HOST, 'unreachable', COMMONS_WORDS.unreachable);
    }
    // An error inside a 200 answer (a rate limit, say), or no query in it: Commons didn't answer the question, which is not
    // "no such file" (review of #3351, N2).
    if (!answer || typeof answer !== 'object' || answer.error !== undefined || !answer.query || typeof answer.query !== 'object') {
        return refuse(grantId, COMMONS_HOST, 'api error', COMMONS_WORDS.unreachable);
    }
    const pages = Object.values(answer?.query?.pages ?? {}) as CommonsPage[];
    const renamed = new Map((answer?.query?.normalized ?? []).map((x) => [String(x.from), String(x.to)]));
    const read: { name: string; url: URL; credit: KnowledgePhotoCredit }[] = [];
    const readAt = new Date().toISOString();
    for (let i = 0; i < names.length; i++) {
        const n = i + 1;
        const asked = `File:${names[i]}`;
        const title = renamed.get(asked) ?? asked;
        const page = pages.find((p) => p.title === title);
        const info = (Array.isArray(page?.imageinfo) ? page!.imageinfo[0] : undefined) as ImageInfo | undefined;
        if (!page || page.missing !== undefined || page.invalid !== undefined || !info) return refuse(grantId, COMMONS_HOST, 'missing', COMMONS_WORDS.missing(n));
        const em = info.extmetadata;
        const licence = commonsLicence(em);
        if (!licence.ok) {
            const said = commonsSaid(boundary, n, licence.said);
            const words = { not_free: COMMONS_WORDS.notFree(n), unreadable: COMMONS_WORDS.unreadable(n), not_open: COMMONS_WORDS.notOpen(n, said), disagree: COMMONS_WORDS.disagree(n, said) }[licence.why];
            return refuse(grantId, COMMONS_HOST, `licence ${licence.why}`, words);
        }
        const deletion = commonsUpForDeletion(page, em);
        if (deletion === null) return refuse(grantId, COMMONS_HOST, 'deletion unclear', COMMONS_WORDS.deletionUnclear(n));
        if (deletion) return refuse(grantId, COMMONS_HOST, 'up for deletion', COMMONS_WORDS.deletion(n));
        const mime = typeof info.mime === 'string' ? info.mime.toLowerCase() : '';
        if (!STILL.includes(mime)) return refuse(grantId, COMMONS_HOST, 'not still', COMMONS_WORDS.notStill(n, mime));
        const maker = commonsPlainText(metaText(em, 'Artist'));
        if (!maker && licence.licence.credit) return refuse(grantId, COMMONS_HOST, 'no maker', COMMONS_WORDS.noMaker(n));
        const url = copyAddress(info.thumburl);
        if (!url) return refuse(grantId, COMMONS_HOST, 'copy elsewhere', COMMONS_WORDS.copyElsewhere(n));
        if (Number(info.thumbheight) > AGENT_PHOTO_MAX_INPUT_SIDE || Number(info.thumbwidth) > AGENT_PHOTO_MAX_INPUT_SIDE) {
            return refuse(grantId, url.hostname, 'too tall', COMMONS_WORDS.tooTall(n));
        }
        const page_ = commonsFilePage(String(page.title).replace(/^File:/, ''));
        if (page_.length > KNOWLEDGE_LIMITS.sourceUrl) return refuse(grantId, COMMONS_HOST, 'long name', COMMONS_WORDS.longPage(n));
        const restrictions = metaText(em, 'Restrictions').split('|').map((r) => r.trim().toLowerCase()).filter((r) => /^[a-z0-9-]{1,40}$/.test(r)).slice(0, 5);
        read.push({
            name: names[i], url,
            credit: { url: page_, file: cleanMemberText(String(page.title), 260), maker, licence: licence.licence.name, licenceUrl: licence.licence.url, restrictions, readAt },
        });
    }
    const pictures: CommonsPicture[] = [];
    for (let i = 0; i < read.length; i++) {
        const n = i + 1;
        const { url, credit } = read[i];
        let bytes: Buffer;
        try {
            bytes = await fetchFixedHost(url, { maxBytes: PHOTO_SOURCE_MAX_BYTES, allowedContentTypes: [...PHOTO_SOURCE_TYPES], headers: { ...headers, Accept: PHOTO_SOURCE_TYPES.join(', ') } },
                async (res) => {
                    if (res.status !== 200) throw new ProhibitedContentTypeError(`answered ${res.status}`);
                    return res.buffer();
                });
        } catch (e) {
            const why = e instanceof PayloadTooLargeError ? `is over ${PHOTO_SOURCE_MAX_BYTES / (1024 * 1024)} MB`
                : e instanceof RequestTimeoutError ? 'did not arrive in time'
                    : e instanceof ProhibitedContentTypeError ? 'is not an image this server stores' : 'could not be fetched';
            return refuse(grantId, url.hostname, why, COMMONS_WORDS.copyFailed(n, why));
        }
        const which = `commons_pictures #${n}`;
        const stored = await storableImage(bytes, {
            which, png: true,
            format: COMMONS_WORDS.copyFailed(n, 'is not an image this server stores'),
            tooWide: () => COMMONS_WORDS.tooTall(n),
            unreadable: COMMONS_WORDS.copyFailed(n, 'could not be read'),
        });
        if (!stored.ok) return refuse(grantId, url.hostname, 'not stored', stored.error);
        logger.info('AGENT', 'Commons picture fetched', { grant: grantId, host: url.hostname, bytes: bytes.length });
        pictures.push({ photo: stored.value, credit });
    }
    return { ok: true, pictures };
}
