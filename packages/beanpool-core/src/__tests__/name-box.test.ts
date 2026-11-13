import { describe, expect, it } from 'vitest';
import { hasWebAddress, inviteForInviteBox, notANameIn, notANameLine, NAME_BOX_READ_CHARS, NAME_BOX_WORDS } from '../name-box';
import { inviteShareText } from '../invite-share-text';

// What Dee Dee's name box held on 5 Sep (card callsign-link-guard), and the share message a member sends.
const DEE_DEE = 'https://mullum.beanpool.org/?invite=INV-K7Q2-BSXA';
const MESSAGE = inviteShareText({ name: 'Byron Shire BeanPool', link: 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA', code: 'INV-K7Q2-BSXA', address: 'byron.beanpool.org' });

describe('notANameIn', () => {
    it('reads an invite link, the whole message and the code alone as an invite', () => {
        expect(notANameIn(DEE_DEE)).toBe('inviteLink');
        expect(notANameIn(MESSAGE)).toBe('inviteLink');
        expect(notANameIn('INV-K7Q2-BSXA')).toBe('inviteCode');
        expect(notANameIn('  bp-ab12-cd34 ')).toBe('inviteCode');
        expect(notANameIn('BP-eyJhIjoiYiIsImMiOiJkIn0abcdefghijk')).toBe('inviteCode');
    });
    it('reads a web address as one, the link the name box cut short included', () => {
        for (const s of [
            DEE_DEE.slice(0, 20), // "https://mullum.beanp": what a 20-character box kept of her paste
            'http://192.168.1.20',
            'mullum.beanpool.org',
            'byron.beanpool.org/',
            'www.example.net',
            'see example.com',
            'beanpool.org',
            'mystore.shop/me',
            '10.0.0.7',
            'ftp://x',
            'HTTPS://A.B',
        ]) expect(notANameIn(s), s).toBe('webLink');
    });
    it('leaves a name a name, dots, dashes and other scripts included', () => {
        for (const s of ['Dee Dee', 'J.R. Smith', 'St.Kilda', 'Dr.Who', 'Mary-Jane', 'Ana B.', 'O\'Brien', 'Marty', 'Nguyễn Văn A', '李小龙', 'Bean Counter 2', 'Inv Smith', 'BP Garage', 'v1.2', 'Mr. Bean', 'Bob.Smithers', '', '   ']) {
            expect(notANameIn(s), s).toBeNull();
        }
    });
    it('still finds a scheme longer than the 32 characters the pattern reads, by its end', () => {
        expect(notANameIn(`${'a'.repeat(40)}://x`)).toBe('webLink');
        expect(notANameIn('chrome-extension://abc')).toBe('webLink');
    });
    it(`reads the first ${NAME_BOX_READ_CHARS} characters after any leading spaces, and no further`, () => {
        // The whole Share message is read (its invite is found), and so is a link after a run of spaces a node trims.
        expect(MESSAGE.length).toBeLessThan(NAME_BOX_READ_CHARS);
        expect(notANameIn(`${' '.repeat(NAME_BOX_READ_CHARS * 2)}https://example.org`)).toBe('webLink');
        expect(notANameIn(`${'\n'.repeat(NAME_BOX_READ_CHARS * 2)}${DEE_DEE}`)).toBe('inviteLink');
        // A link that starts past the read is past any name a node keeps (32 characters at most), so it is never read.
        expect(notANameIn(`Ann ${'a'.repeat(NAME_BOX_READ_CHARS)} https://example.org`)).toBeNull();
        expect(notANameIn(`Ann ${'a'.repeat(NAME_BOX_READ_CHARS - 30)} https://example.org`)).toBe('webLink');
    });
    // Review of #3122 (name-box.ts:35): the scheme pattern had no bound, so its time grew with the square of the text's length,
    // and a node reads a name from a body of up to 2 MB before any sign-in (150,000 characters held the node 11.9 s).
    // Bounded, these take a few milliseconds; unbounded, the first takes about 10 s, so 1 s is far from both.
    it('answers a 150,000-character text and a 2 MB name each well under a second', () => {
        const SLOW_MS = 1000;
        const timed = (f: () => unknown) => { const t0 = performance.now(); f(); return performance.now() - t0; };
        const letters = 'a'.repeat(150_000);
        // The pattern alone, on the whole text: its own bound, not the name box's cut.
        const whole = timed(() => expect(hasWebAddress(letters)).toBe(false));
        expect(whole, `the pattern on 150,000 letters took ${whole.toFixed(0)} ms`).toBeLessThan(SLOW_MS);
        for (const [label, text] of [['150,000 characters', `Ann ${letters}`], ['2 MB', `Ann ${'a'.repeat(2 * 1024 * 1024)}`]] as const) {
            const ms = timed(() => expect(notANameIn(text)).toBeNull());
            expect(ms, `a ${label} name took ${ms.toFixed(0)} ms`).toBeLessThan(SLOW_MS);
        }
    });
});

describe('notANameLine', () => {
    it('says one plain line for each kind, and nothing for a name', () => {
        expect(notANameLine(DEE_DEE)).toBe(NAME_BOX_WORDS.inviteLink);
        expect(notANameLine('INV-K7Q2-BSXA')).toBe(NAME_BOX_WORDS.inviteCode);
        expect(notANameLine('www.example.net')).toBe(NAME_BOX_WORDS.webLink);
        expect(notANameLine('Dee Dee')).toBeNull();
        expect(NAME_BOX_WORDS.inviteLink).toBe('That looks like an invite link: it goes in the invite box, not your name.');
    });
});

describe('inviteForInviteBox', () => {
    it('moves an invite as it was pasted, never a plain address or a name', () => {
        expect(inviteForInviteBox(` ${DEE_DEE}\n`)).toBe(DEE_DEE);
        expect(inviteForInviteBox('INV-K7Q2-BSXA')).toBe('INV-K7Q2-BSXA');
        expect(inviteForInviteBox(MESSAGE)).toBe(MESSAGE.trim());
        expect(inviteForInviteBox('www.example.net')).toBeNull();
        expect(inviteForInviteBox('Dee Dee')).toBeNull();
    });
});
