/**
 * Private contacts: contacts files (vCard), read and written on the device (scratch/fable-design/DESIGN-private-contacts-
 * fable.md §3.4, §3.5, §7, slice C0). Nothing here sends anything anywhere: a file is read in the app, the member chooses
 * who to bring, and only then is the list locked (contacts-crypto.ts).
 *
 * ## Reading
 *
 * vCard 2.1 (Android's exports: quoted-printable names in any charset the file names, UTF-8 by default; bare type
 * parameters; base64 photos running on until a blank line), 3.0 (iPhone's and Google's) and 4.0. Of each card only the
 * name (FN, else N, else ORG), numbers (TEL), emails (EMAIL) and the note (NOTE) are read; a photo, logo, sound or key is
 * skipped unread, whatever its size. Every field is held to contacts-list.ts's limits.
 *
 * A file made to hurt is held too (design §7): over {@link CONTACTS_FILE_MAX_BYTES} it is refused before a line is read;
 * at most {@link CONTACTS_READ_MAX} cards are read (the rest counted, never parsed); a line longer than
 * {@link VCARD_LINE_MAX} is skipped. A card cut off by the end of the file is left out and said (`cutOff`). A file with no
 * card at all is `not_vcard`. {@link vcardCards} yields one card at a time, so an app can read a big file in slices and
 * keep its screen moving; {@link readContactsFile} reads it whole.
 *
 * ## Writing
 *
 * {@link writeContactsVcard}: vCard 3.0, which every phone and Google Contacts imports: FN and N, each number and email,
 * and the note, escaped and folded at 75 bytes. Links to BeanPool members and invites are the member's own record and
 * stay in the locked list.
 */
import { Buffer } from 'buffer';
import { word, type WordKey } from './words.js';
import { CONTACTS_LIMITS, cleanContactName, cleanContactNote, type Contact, type ContactCandidate } from './contacts-list.js';

/** The biggest contacts file read (design §3.4): bigger is refused before anything is read. */
export const CONTACTS_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The most cards read from one file; the rest are counted (`more`), never parsed. */
export const CONTACTS_READ_MAX = 10_000;
/** A longer (unfolded) line is skipped: no name, number or note is anywhere near it, and a photo is skipped anyway. */
export const VCARD_LINE_MAX = 64 * 1024;

/** The sentences a refused file is answered with (design §3.4), the same in both apps. */
export const CONTACTS_FILE_WORDS = {
    notVcard: word('That file isn’t a contacts file BeanPool can read. Export it again as vCard (.vcf).'),
    tooBig: word('That file is too big to read here. Export it without photos, or in two parts.'),
} satisfies Record<string, WordKey>;

export type ContactsFileResult =
    | { ok: true; candidates: ContactCandidate[]; more: number; cutOff: boolean }
    | { ok: false; reason: 'not_vcard' | 'too_big'; words: WordKey };

/** The properties whose values are binary: skipped unread. */
const SKIPPED = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);
const WANTED = new Set(['FN', 'N', 'ORG', 'TEL', 'EMAIL', 'NOTE']);

interface RawProp {
    name: string;
    params: Map<string, string[]>;
    bare: string[];
    value: string;
}

/** One unfolded content line as its parts: the name (group dropped), its parameters, its raw value. Null when it isn't one. */
function parseLine(line: string): RawProp | null {
    // The value starts at the first colon outside a quoted parameter value.
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') quoted = !quoted;
        else if (ch === ':' && !quoted) { colon = i; break; }
    }
    if (colon <= 0) return null;
    const head = line.slice(0, colon).split(';');
    const name = head[0].replace(/^[A-Za-z0-9-]+\./, '').toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(name)) return null;
    const params = new Map<string, string[]>();
    const bare: string[] = [];
    for (const p of head.slice(1)) {
        const eq = p.indexOf('=');
        if (eq < 0) { if (p) bare.push(p.toUpperCase()); continue; }
        const key = p.slice(0, eq).toUpperCase();
        const vals = p.slice(eq + 1).split(',').map((v) => v.replace(/^"|"$/g, ''));
        params.set(key, [...(params.get(key) ?? []), ...vals]);
    }
    return { name, params, bare, value: line.slice(colon + 1) };
}

function isQuotedPrintable(p: RawProp): boolean {
    const enc = (p.params.get('ENCODING') ?? []).map((v) => v.toUpperCase());
    return enc.includes('QUOTED-PRINTABLE') || p.bare.includes('QUOTED-PRINTABLE');
}

/** Quoted-printable bytes decoded in the charset the property names (UTF-8 unless it says Latin-1 or ASCII). */
function decodeQuotedPrintable(value: string, charset: string | undefined): string {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
            bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            // A character outside ASCII in a quoted-printable value: its UTF-8 bytes, as the file had them.
            for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
        }
    }
    const cs = (charset ?? 'UTF-8').toUpperCase();
    const latin1 = cs === 'ISO-8859-1' || cs === 'LATIN1' || cs === 'WINDOWS-1252' || cs === 'CP1252' || cs === 'US-ASCII';
    return Buffer.from(bytes).toString(latin1 ? 'latin1' : 'utf8');
}

/** A text value with its 3.0/4.0 escapes undone: `\n`, `\,`, `\;`, `\\`. */
function unescapeText(v: string): string {
    return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** A structured value's parts (N, ORG), split at unescaped semicolons, each unescaped. */
function splitStructured(v: string): string[] {
    const parts: string[] = [];
    let cur = '';
    for (let i = 0; i < v.length; i++) {
        if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue; }
        if (v[i] === ';') { parts.push(cur); cur = ''; continue; }
        cur += v[i];
    }
    parts.push(cur);
    return parts.map(unescapeText);
}

function textOf(p: RawProp): string {
    return isQuotedPrintable(p) ? decodeQuotedPrintable(p.value, p.params.get('CHARSET')?.[0]) : p.value;
}

/** One card's properties made a candidate; null when it holds nothing to call the person by. */
function candidateOf(props: RawProp[]): ContactCandidate | null {
    let fn = '';
    let n = '';
    let org = '';
    let note = '';
    const phones: string[] = [];
    const emails: string[] = [];
    for (const p of props) {
        const text = textOf(p);
        switch (p.name) {
            case 'FN': if (!fn) fn = unescapeText(text); break;
            case 'N': if (!n) {
                // Family; Given; Middle; Prefix; Suffix → "Prefix Given Middle Family Suffix".
                const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitStructured(text);
                n = [prefix, given, middle, family, suffix].map((s) => s.trim()).filter(Boolean).join(' ');
            } break;
            case 'ORG': if (!org) org = splitStructured(text).map((s) => s.trim()).filter(Boolean).join(' '); break;
            case 'TEL': {
                const v = unescapeText(text).replace(/^tel:/i, '').trim();
                if (v && phones.length < CONTACTS_LIMITS.phones * 2) phones.push(v);
            } break;
            case 'EMAIL': {
                const v = unescapeText(text).replace(/^mailto:/i, '').trim();
                if (v && emails.length < CONTACTS_LIMITS.emails * 2) emails.push(v);
            } break;
            case 'NOTE': if (!note) note = unescapeText(text); break;
            default: break;
        }
    }
    const name = cleanContactName(fn) || cleanContactName(n) || cleanContactName(org);
    const keptPhones = dedupe(phones.map((v) => v.replace(/\s+/g, ' ').trim()).filter((v) => /\d/.test(v) && v.length <= CONTACTS_LIMITS.phoneChars), (v) => v.replace(/\D/g, ''), CONTACTS_LIMITS.phones);
    const keptEmails = dedupe(emails.filter((v) => v.length <= CONTACTS_LIMITS.emailChars && /^[^\s@]+@[^\s@]+$/.test(v)), (v) => v.toLowerCase(), CONTACTS_LIMITS.emails);
    if (!name && keptPhones.length === 0 && keptEmails.length === 0) return null;
    return { name: name || keptPhones[0] || keptEmails[0], phones: keptPhones, emails: keptEmails, note: cleanContactNote(note) };
}

function dedupe(values: string[], same: (v: string) => string, max: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const k = same(v);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(v);
        if (out.length >= max) break;
    }
    return out;
}

/** What {@link vcardCards} yields: each card that ends with END:VCARD, then a last word on the file. */
export type VcardStep = { kind: 'card'; candidate: ContactCandidate | null } | { kind: 'end'; cards: number; cutOff: boolean };

/**
 * The cards of a contacts file's text, one at a time (a card with nothing to call the person by yields a null candidate),
 * then `{ kind: 'end' }`: how many cards ended properly, and whether the file ended inside one. Lines are unfolded as
 * they come (a line starting with a space or tab continues the one before; a quoted-printable line ending in `=` runs
 * on); a 2.1 base64 value runs on until a blank line or the next property, and is never kept.
 */
export function* vcardCards(text: string): Generator<VcardStep, void, undefined> {
    let inCard = false;
    let props: RawProp[] = [];
    let cards = 0;
    let pending: string | null = null;
    // Inside a skipped binary value: its continuation lines are passed over unread.
    let skipping = false;
    let skippingBare = false;

    const finish = (line: string): RawProp | null => {
        if (line.length > VCARD_LINE_MAX) return null;
        return parseLine(line);
    };

    const take = function* (line: string): Generator<VcardStep, void, undefined> {
        const p = finish(line);
        if (!p) return;
        if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VCARD') { inCard = true; props = []; return; }
        if (!inCard) return;
        if (p.name === 'END' && p.value.trim().toUpperCase() === 'VCARD') {
            inCard = false;
            cards++;
            yield { kind: 'card', candidate: candidateOf(props) };
            props = [];
            return;
        }
        if (WANTED.has(p.name)) props.push(p);
    };

    let start = 0;
    const len = text.length;
    while (start <= len) {
        let end = text.indexOf('\n', start);
        if (end < 0) end = len;
        let line = text.slice(start, end);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        start = end + 1;

        // A skipped binary value's continuation: folded lines, or (2.1) bare base64 lines until a blank one.
        if (skipping) {
            if (line.startsWith(' ') || line.startsWith('\t')) continue;
            if (skippingBare && line !== '' && !line.includes(':')) continue;
            skipping = false;
            skippingBare = false;
            if (line === '') { if (end >= len) break; continue; }
        }

        if (pending !== null) {
            if (line.startsWith(' ') || line.startsWith('\t')) {
                if (pending.length <= VCARD_LINE_MAX) pending += line.slice(1);
                if (end >= len) break;
                continue;
            }
            // A quoted-printable soft break: the next line runs on, as it is.
            if (pending.endsWith('=') && /QUOTED-PRINTABLE/i.test(pending.slice(0, Math.max(0, pending.indexOf(':'))))) {
                if (pending.length <= VCARD_LINE_MAX) pending = pending.slice(0, -1) + line;
                if (end >= len) break;
                continue;
            }
            yield* take(pending);
            pending = null;
        }

        if (line === '') { if (end >= len) break; continue; }
        // A binary property: never read, nor its continuation lines.
        const nameEnd = line.search(/[;:]/);
        const name = nameEnd > 0 ? line.slice(0, nameEnd).replace(/^[A-Za-z0-9-]+\./, '').toUpperCase() : '';
        if (SKIPPED.has(name)) {
            skipping = true;
            const head = line.slice(0, Math.max(0, line.indexOf(':'))).toUpperCase();
            skippingBare = /(^|;)(ENCODING=)?BASE64(;|$)/.test(head);
            if (end >= len) break;
            continue;
        }
        pending = line;
        if (end >= len) break;
    }
    if (pending !== null) yield* take(pending);
    yield { kind: 'end', cards, cutOff: inCard };
}

/**
 * A whole contacts file read (bytes as picked, or text already read as UTF-8). Refused over
 * {@link CONTACTS_FILE_MAX_BYTES} (`too_big`) before a line is read, or with no card in it (`not_vcard`), each with its
 * sentence. Otherwise up to {@link CONTACTS_READ_MAX} candidates, `more` counting the cards past them, and `cutOff` when
 * the file ended inside a card (that card is left out).
 */
export function readContactsFile(input: string | Uint8Array): ContactsFileResult {
    const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.length;
    if (bytes > CONTACTS_FILE_MAX_BYTES) return { ok: false, reason: 'too_big', words: CONTACTS_FILE_WORDS.tooBig };
    const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
    const candidates: ContactCandidate[] = [];
    let more = 0;
    let cards = 0;
    let cutOff = false;
    for (const step of vcardCards(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) {
        if (step.kind === 'end') { cards = step.cards; cutOff = step.cutOff; break; }
        if (!step.candidate) continue;
        if (candidates.length < CONTACTS_READ_MAX) candidates.push(step.candidate);
        else more++;
    }
    if (cards === 0) return { ok: false, reason: 'not_vcard', words: CONTACTS_FILE_WORDS.notVcard };
    return { ok: true, candidates, more, cutOff };
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────────────

function escapeText(v: string): string {
    return v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** A content line folded at 75 bytes (RFC 6350 §3.2), never inside a character: CRLF and a space before each run-on. */
function fold(line: string): string {
    const out: string[] = [];
    let cur = '';
    let curBytes = 0;
    for (const ch of line) {
        const b = Buffer.byteLength(ch, 'utf8');
        const max = out.length === 0 ? 75 : 74;
        if (curBytes + b > max) {
            out.push(cur);
            cur = '';
            curBytes = 0;
        }
        cur += ch;
        curBytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
}

/**
 * The contacts as a vCard 3.0 file (design §3.9, "Save a copy as a file"): not locked, which the app says before it
 * saves. Each contact's name, numbers, emails and note; nothing else of the locked list.
 */
export function writeContactsVcard(contacts: readonly Pick<Contact, 'name' | 'phones' | 'emails' | 'note'>[]): string {
    const lines: string[] = [];
    for (const c of contacts) {
        lines.push('BEGIN:VCARD', 'VERSION:3.0');
        lines.push(fold(`FN:${escapeText(c.name)}`));
        lines.push(fold(`N:;${escapeText(c.name)};;;`));
        for (const p of c.phones) lines.push(fold(`TEL:${escapeText(p)}`));
        for (const e of c.emails) lines.push(fold(`EMAIL:${escapeText(e)}`));
        if (c.note) lines.push(fold(`NOTE:${escapeText(c.note)}`));
        lines.push('END:VCARD');
    }
    return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}
