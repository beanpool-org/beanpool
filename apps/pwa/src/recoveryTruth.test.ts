/**
 * One recovery truth on the welcome screens (rehearsal 14 Oct S5): the "Your 12 Words Are Everything" card told a
 * words-only member that recovery "requires operator-assisted re-enrolment", and the Safety Backup step a screen
 * later says "Nobody can reset them: not us, not this community." The card now says the second screen's sentence.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = fs.readFileSync(path.resolve(__dirname, 'pages/WelcomePage.tsx'), 'utf8');
const PHONE = fs.readFileSync(path.resolve(__dirname, '../../native/app/welcome.tsx'), 'utf8');

describe('welcome screens tell one recovery truth', () => {
    for (const [name, src] of [['web WelcomePage', WEB], ['phone welcome', PHONE]] as const) {
        it(`${name} never promises an operator re-enrolment`, () => {
            expect(src).not.toMatch(/operator-assisted re-enrolment/);
        });
        it(`${name} says the Safety Backup step's sentence`, () => {
            expect(src).toContain('Nobody can reset them: not us, not this community.');
        });
    }
});
