/**
 * One recovery truth on the welcome screens (rehearsal 14 Oct S5): the "Your 12 Words Are Everything" card told a
 * words-only member that recovery "requires operator-assisted re-enrolment", and the Safety Backup step a screen
 * later says "Nobody can reset them: not us, not this community." The card now says the second screen's sentence.
 *
 * On the phone, How it Works' Getting Back In card carried the sentence until slice S5 of
 * scratch/fable-design/DESIGN-onboarding-home-landing-fable.md took that screen off the join (§3.1): it is now said on the
 * way-back step itself, Safety Backup, beside the paper line, and in the 12-words member's note (components/WordsDoor.tsx).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = fs.readFileSync(path.resolve(__dirname, 'pages/WelcomePage.tsx'), 'utf8');
const PHONE = fs.readFileSync(path.resolve(__dirname, '../../native/app/welcome.tsx'), 'utf8');
const PHONE_WORDS_DOOR = fs.readFileSync(path.resolve(__dirname, '../../native/components/WordsDoor.tsx'), 'utf8');
const TRUTH = 'Nobody can reset them: not us, not this community.';

/** The phone's Safety Backup step: from its render branch to the next step's. */
function phoneSafetyBackup(): string {
    const start = PHONE.indexOf("if (mode === 'seedBackup' && pendingIdentity) {");
    expect(start, 'the phone still has a Safety Backup step').toBeGreaterThan(-1);
    const rest = PHONE.slice(start + 1);
    const next = rest.search(/\n {4}(\/\/ --- |if \(mode === ')/);
    return next === -1 ? rest : rest.slice(0, next);
}

describe('welcome screens tell one recovery truth', () => {
    for (const [name, src] of [['web WelcomePage', WEB], ['phone welcome', PHONE]] as const) {
        it(`${name} never promises an operator re-enrolment`, () => {
            expect(src).not.toMatch(/operator-assisted re-enrolment/);
        });
        it(`${name} says the Safety Backup step's sentence`, () => {
            expect(src).toContain(TRUTH);
        });
    }

    it("the phone says it on the way-back step itself (Safety Backup), now How it Works is off the join", () => {
        const step = phoneSafetyBackup();
        expect(step).toContain(`t('${TRUTH}')`);
        // A 12-words member reads it in the note drawn on the same step.
        expect(step).toContain('<WordsBackupNote');
        expect(PHONE_WORDS_DOOR).toContain(`word('${TRUTH} If you lose them and this phone, the account is gone for good.')`);
    });
});
