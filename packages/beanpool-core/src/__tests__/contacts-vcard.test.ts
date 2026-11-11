import { describe, it, expect } from 'vitest';
import { Buffer } from 'buffer';
import { CONTACTS_FILE_WORDS, CONTACTS_READ_MAX, VCARD_LINE_MAX, readContactsFile, vcardCards, writeContactsVcard } from '../contacts-vcard.js';

// Contacts files (DESIGN-private-contacts-fable.md §3.4, §7, §11 "vCard fixtures"): each ends in the right contacts or the
// right sentence.

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

const ANDROID_21 = crlf([
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0;=E4=B8=89;;;',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E5=BC=A0=E4=B8=89',
    'TEL;CELL:+61 412 345 678',
    'TEL;HOME:02 6600 0000',
    'EMAIL;HOME:zhang@example.org',
    'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E7=AC=AC=E4=B8=80=E8=A1=8C=0A=',
    '=E7=AC=AC=E4=BA=8C=E8=A1=8C',
    'PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK',
    ' CwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQU',
    '',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:Walker;Dee;;;',
    'FN:Dee Walker',
    'TEL;CELL;PREF:0412 345 678',
    'PHOTO;ENCODING=BASE64;TYPE=JPEG:',
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK',
    'CwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQU',
    '',
    'EMAIL:dee@example.org',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Ren=E9e Dupr=E9',
    'TEL:+33 6 12 34 56 78',
    'END:VCARD',
]);

const IPHONE_30 = crlf([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iPhone OS 17.0//EN',
    'N:Jones;Sam;;;',
    'FN:Sam Jones',
    'ORG:Byron Seed Library;',
    'item1.TEL;type=pref:+61 400 000 001',
    'TEL;type=CELL;type=VOICE:(02) 6600 0001',
    'item2.EMAIL;type=INTERNET;type=pref:sam@example.org',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA',
    ' 6ABAAMAAAABAAEAAKACAAQAAAABAAAAQKADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAA',
    ' ABDUHYzZjwCjqwPGs6hT2KNm',
    'NOTE:Met at the market\\, Saturday\\nBrings seedlings',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:;;;;',
    'ORG:Byron Food Co-op;',
    'TEL;type=WORK:02 6600 0002',
    'END:VCARD',
]);

const GOOGLE = crlf([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Ana Li',
    'N:Li;Ana;;;',
    'EMAIL;TYPE=INTERNET;TYPE=HOME:ana@example.com',
    'TEL;TYPE=CELL:+61 400 000 002',
    'CATEGORIES:myContacts',
    'END:VCARD',
]);

const V40 = crlf([
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Tom O\'Brien',
    'N:O\'Brien;Tom;;;',
    'TEL;VALUE=uri;TYPE="voice,cell":tel:+61-400-000-003',
    'EMAIL:tom@example.net',
    'PHOTO:data:image/jpeg;base64,MIICajCCAdOgAwIBAgICBEUwDQYJKoZIhvcN',
    ' AQEEBQAwdzELMAkGA1UEBhMCVVMxLDAqBgNVBAoTI05ldHNjYXBlIENvbW11bmlj',
    'END:VCARD',
]);

const SCRIPTS = crlf([
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:سامي الأحمد', 'TEL:+971 50 000 0000', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:சாமி நாதன்', 'TEL:+91 90000 00000', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:山姆', 'TEL:+86 130 0000 0000', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:<script>alert(1)</script>', 'TEL:000 111', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:‮gpj.exe Sam', 'TEL:000 222', 'END:VCARD',
]);

function many(n: number): string {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push('BEGIN:VCARD', 'VERSION:3.0', `FN:Person ${i}`, `TEL:0400 ${String(i).padStart(6, '0')}`, 'END:VCARD');
    return crlf(out);
}

function names(text: string | Uint8Array) {
    const r = readContactsFile(text);
    if (!r.ok) throw new Error(`refused: ${r.reason}`);
    return r;
}

describe('reading the files phones and Google make', () => {
    it('an Android 2.1 file: quoted-printable names and notes in UTF-8 and Latin-1, photos skipped, bare and folded base64 alike', () => {
        const r = names(ANDROID_21);
        expect(r.candidates).toEqual([
            { name: '张三', phones: ['+61 412 345 678', '02 6600 0000'], emails: ['zhang@example.org'], note: '第一行\n第二行' },
            { name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: '' },
            { name: 'Renée Dupré', phones: ['+33 6 12 34 56 78'], emails: [], note: '' },
        ]);
        expect(r.cutOff).toBe(false);
        // Nothing of the photos is anywhere in what was read.
        expect(JSON.stringify(r.candidates)).not.toMatch(/9j|AAQ/);
    });

    it('a quoted-printable soft break runs on into the next line as it is, even one starting with a space', () => {
        const file = crlf(['BEGIN:VCARD', 'VERSION:2.1', 'FN:Lee', 'NOTE;ENCODING=QUOTED-PRINTABLE:Back=', ' gate, Saturday=', '=0Aearly', 'END:VCARD']);
        expect(names(file).candidates[0].note).toBe('Back gate, Saturday\nearly');
    });

    it('an iPhone 3.0 file with a photo: grouped properties, escapes undone, a company only when there is no name', () => {
        expect(names(IPHONE_30).candidates).toEqual([
            { name: 'Sam Jones', phones: ['+61 400 000 001', '(02) 6600 0001'], emails: ['sam@example.org'], note: 'Met at the market, Saturday\nBrings seedlings' },
            { name: 'Byron Food Co-op', phones: ['02 6600 0002'], emails: [], note: '' },
        ]);
    });

    it('a Google Contacts export and a 4.0 file (a tel: link, a data: photo)', () => {
        expect(names(GOOGLE).candidates).toEqual([{ name: 'Ana Li', phones: ['+61 400 000 002'], emails: ['ana@example.com'], note: '' }]);
        expect(names(V40).candidates).toEqual([{ name: 'Tom O\'Brien', phones: ['+61-400-000-003'], emails: ['tom@example.net'], note: '' }]);
    });

    it('names in Arabic, Tamil and Chinese as they were; a name carrying script kept as plain text; reordering marks taken out', () => {
        expect(names(SCRIPTS).candidates.map((c) => c.name)).toEqual(['سامي الأحمد', 'சாமி நாதன்', '山姆', '<script>alert(1)</script>', 'gpj.exe Sam']);
    });

    it('bytes as picked read as text does, a byte-order mark and LF-only lines too', () => {
        const bytes = new Uint8Array(Buffer.from('﻿' + GOOGLE.replace(/\r\n/g, '\n'), 'utf8'));
        expect(names(bytes).candidates[0].name).toBe('Ana Li');
    });
});

describe('a file made to hurt, and files that aren’t contacts', () => {
    it('a 30 MB file is refused before a line is read, with its sentence', () => {
        const big = `BEGIN:VCARD\r\nFN:A\r\nNOTE:${'x'.repeat(30 * 1024 * 1024)}\r\nEND:VCARD\r\n`;
        expect(readContactsFile(big)).toEqual({ ok: false, reason: 'too_big', words: CONTACTS_FILE_WORDS.tooBig });
        expect(readContactsFile(new Uint8Array(30 * 1024 * 1024))).toEqual({ ok: false, reason: 'too_big', words: CONTACTS_FILE_WORDS.tooBig });
    });

    it('a truncated file: the whole cards are read, the cut one left out and said', () => {
        const cut = GOOGLE + 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Half a per';
        const r = names(cut);
        expect(r.candidates.map((c) => c.name)).toEqual(['Ana Li']);
        expect(r.cutOff).toBe(true);
        expect(readContactsFile('BEGIN:VCARD\r\nFN:Only half')).toEqual({ ok: false, reason: 'not_vcard', words: CONTACTS_FILE_WORDS.notVcard });
    });

    it('not a contacts file at all', () => {
        expect(readContactsFile('name,phone\nSam,0412 345 678\n')).toEqual({ ok: false, reason: 'not_vcard', words: CONTACTS_FILE_WORDS.notVcard });
        expect(readContactsFile('')).toEqual({ ok: false, reason: 'not_vcard', words: CONTACTS_FILE_WORDS.notVcard });
    });

    it('5,000 entries are all read; past the read limit the rest are counted, never parsed', () => {
        const r = names(many(5000));
        expect(r.candidates).toHaveLength(5000);
        expect(r.candidates[4999]).toEqual({ name: 'Person 4999', phones: ['0400 004999'], emails: [], note: '' });
        const over = names(many(CONTACTS_READ_MAX + 50));
        expect(over.candidates).toHaveLength(CONTACTS_READ_MAX);
        expect(over.more).toBe(50);
    });

    it('every field is held to the limits: numbers, emails, a long name and note', () => {
        const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${'N'.repeat(300)}`, `NOTE:${'n'.repeat(1000)}`];
        for (let i = 0; i < 9; i++) lines.push(`TEL:0400 00000${i}`, `EMAIL:p${i}@example.org`);
        lines.push('END:VCARD');
        const [c] = names(crlf(lines)).candidates;
        expect(c.name).toHaveLength(100);
        expect(c.note).toHaveLength(300);
        expect(c.phones).toHaveLength(5);
        expect(c.emails).toHaveLength(3);
    });

    it('a quoted-printable value past the line limit is skipped alone: its card keeps its other fields, and every card after it is read', () => {
        // Android writes a non-ASCII note in UTF-8 quoted-printable, soft-broken every 72 characters (8 characters of 张 here).
        const encoded = '=E5=BC=A0'.repeat(8000);
        expect(encoded.length).toBeGreaterThan(VCARD_LINE_MAX);
        const softBroken = (encoded.match(/.{1,72}/g) ?? []).map((part, i, all) => (i < all.length - 1 ? `${part}=` : part));
        const huge = ['BEGIN:VCARD', 'VERSION:2.1', 'FN:Long Note', 'TEL;CELL:0400 999 999', 'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:' + softBroken[0], ...softBroken.slice(1), 'END:VCARD'];
        const after = (n: number) => {
            const out: string[] = [];
            for (let i = 0; i < n; i++) out.push('BEGIN:VCARD', 'VERSION:2.1', `FN:After ${i}`, `TEL;CELL:0400 ${String(i).padStart(6, '0')}`, 'END:VCARD');
            return out;
        };
        const longNote = { name: 'Long Note', phones: ['0400 999 999'], emails: [], note: '' };

        // In the middle of a file: card 3 of 303.
        const middle = names(crlf([...after(2).map((l) => l.replace('After', 'Before')), ...huge, ...after(300)]));
        expect(middle.candidates).toHaveLength(303);
        expect(middle.candidates[2]).toEqual(longNote);
        expect(middle.candidates[302]).toEqual({ name: 'After 299', phones: ['0400 000299'], emails: [], note: '' });
        expect(middle.cutOff).toBe(false);

        // The first card: the file is still a contacts file, with all three cards in it.
        const first = names(crlf([...huge, ...after(2)]));
        expect(first.candidates.map((c) => c.name)).toEqual(['Long Note', 'After 0', 'After 1']);
        expect(first.candidates[0]).toEqual(longNote);
        expect(first.cutOff).toBe(false);

        // A note just under the limit is still read whole, so the guard starts only past it.
        const fits = '=E5=BC=A0'.repeat(7000);
        const fitsLines = (fits.match(/.{1,72}/g) ?? []).map((part, i, all) => (i < all.length - 1 ? `${part}=` : part));
        const read = names(crlf(['BEGIN:VCARD', 'VERSION:2.1', 'FN:Fits', 'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:' + fitsLines[0], ...fitsLines.slice(1), 'END:VCARD', ...after(1)]));
        expect(read.candidates.map((c) => c.name)).toEqual(['Fits', 'After 0']);
        expect(read.candidates[0].note.length).toBeGreaterThan(0);
    });

    it('cards come one at a time, so an app can read a big file in slices', () => {
        const steps = [...vcardCards(GOOGLE + IPHONE_30)];
        expect(steps.map((s) => s.kind)).toEqual(['card', 'card', 'card', 'end']);
        expect(steps[3]).toEqual({ kind: 'end', cards: 3, cutOff: false });
    });
});

describe('writing: Save a copy as a file', () => {
    it('writes vCard 3.0 that reads back as the same contacts: escapes, line breaks, three scripts', () => {
        const people = [
            { name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: 'Seedlings; Saturdays, 6am\nBack gate' },
            { name: 'سامي · சாமி · 山姆 '.repeat(4).trim(), phones: ['+61 400 000 001', '(02) 6600 0000'], emails: [], note: '' },
        ];
        const file = writeContactsVcard(people);
        expect(file.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
        // Folded at 75 bytes, never inside a character.
        for (const line of file.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
        expect(names(file).candidates).toEqual(people);
        expect(writeContactsVcard([])).toBe('');
    });
});
