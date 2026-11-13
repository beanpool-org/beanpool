import { describe, expect, it } from 'vitest';
import { inviteForInviteBox, notANameIn, notANameLine, NAME_BOX_WORDS } from '../name-box';
import { inviteShareText } from '../invite-share-text';

// What Dee Dee's name box held on 5 Sep (card callsign-link-guard), and the share message a member sends.
const DEE_DEE = 'https://mullum.beanpool.org/?invite=INV-K7Q2-BSXA';
const MESSAGE = inviteShareText({ name: 'Byron Shire BeanPool', link: 'https://byron.beanpool.org/?invite=INV-K7Q2-BSXA', code: 'INV-K7Q2-BSXA', address: 'byron.beanpool.org' });

describe('notANameIn', () => {
    it('reads an invite link, the whole message and the code alone as an invite', () => {
        expect(notANameIn(DEE_DEE)).toBe('invite-link');
        expect(notANameIn(MESSAGE)).toBe('invite-link');
        expect(notANameIn('INV-K7Q2-BSXA')).toBe('invite-code');
        expect(notANameIn('  bp-ab12-cd34 ')).toBe('invite-code');
        expect(notANameIn('BP-eyJhIjoiYiIsImMiOiJkIn0abcdefghijk')).toBe('invite-code');
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
        ]) expect(notANameIn(s), s).toBe('web-link');
    });
    it('leaves a name a name, dots, dashes and other scripts included', () => {
        for (const s of ['Dee Dee', 'J.R. Smith', 'St.Kilda', 'Dr.Who', 'Mary-Jane', 'Ana B.', 'O\'Brien', 'Marty', 'Nguyễn Văn A', '李小龙', 'Bean Counter 2', 'Inv Smith', 'BP Garage', 'v1.2', 'Mr. Bean', 'Bob.Smithers', '', '   ']) {
            expect(notANameIn(s), s).toBeNull();
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
