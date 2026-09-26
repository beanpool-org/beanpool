/**
 * Taking the account off the phone asks the phone's lock first, as Settings' Sign Out does (PR #1205 review 4112404471).
 *
 * Sign Out (Device Only) has always asked LocalAuth.authenticateUser before the key goes. Two other doors took it off with
 * no check:
 * - node-mismatch's "Delete this account from this phone". Since PR #1205 it asked the lock only for an account WITH 12
 *   words (the check before they are shown), leaving the account with no words, the one that can't come back, open.
 * - "Replace this phone's account?"'s Replace Account (typed WIPE only), which anyone with an unlocked phone and any
 *   valid 12 words reaches.
 *
 * - Both ask Settings' check before the removal can go ahead, so a phone with no lock is let through, as Sign Out lets it.
 * - A check that doesn't pass removes nothing and reads nothing, and the screen stays as it was.
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../../app', rel), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

const DELETE_REASON = 'Confirm authentication to delete this account from this phone.';

describe('node-mismatch: Delete this account from this phone', () => {
    const screen = () => source('node-mismatch.tsx');
    const start = () => slice(screen(), 'async function handleStartWipe() {', '\n    }\n');

    it("asks Settings' check, with the words or without", () => {
        const body = start();
        expect(screen()).toContain("import { authenticateUser } from '../utils/LocalAuth';");
        // With words: the check before they are shown is this one.
        const words = body.indexOf(`const w = await readWordsBehindLock(identity, '${DELETE_REASON}');`);
        const wordsRefused = body.indexOf('if (!w) return;');
        // Without: the same check, alone.
        const bare = body.indexOf(`if (!(await authenticateUser('${DELETE_REASON}'))) return;`);
        const opened = body.indexOf('setShowWipe(true)');
        expect(words).toBeGreaterThan(-1);
        expect(wordsRefused).toBeGreaterThan(words);
        expect(bare).toBeGreaterThan(-1);
        expect(opened).toBeGreaterThan(wordsRefused);
        expect(opened).toBeGreaterThan(bare);
    });

    it('the delete is reached only through that check: the panel it sits in opens nowhere else', () => {
        const s = screen();
        expect(count(s, 'setShowWipe(true)')).toBe(1);
        expect(count(s, 'deleteAccountFromThisPhone(')).toBe(1);
        const confirm = slice(s, 'function handleConfirmWipe() {', '\n    }\n');
        expect(confirm).toContain('await deleteAccountFromThisPhone(identity);');
        // handleConfirmWipe is drawn only inside the panel (showWipe).
        expect(count(s, 'onPress={handleConfirmWipe}')).toBe(1);
        const panel = slice(s, '{!showWipe ? (', '</ScrollView>');
        expect(panel.indexOf('onPress={handleStartWipe}')).toBeLessThan(panel.indexOf(') : ('));
        expect(panel.indexOf('onPress={handleConfirmWipe}')).toBeGreaterThan(panel.indexOf(') : ('));
    });

    it('a second tap while the check is up asks once', () => {
        const body = start();
        expect(body).toMatch(/if \(lockBusyRef\.current\) return;\s*lockBusyRef\.current = true;\s*try \{/);
        expect(body).toMatch(/\} finally \{\s*lockBusyRef\.current = false;\s*\}/);
    });
});

describe('"Replace this phone\'s account?": Replace Account', () => {
    const welcome = () => source('welcome.tsx');
    const screen = () => slice(welcome(), "if (mode === 'confirmReplace' && outgoingIdentity) {", "if (mode === 'recover') {");
    const handler = () => slice(welcome(), 'async function handleReplaceAccount() {', '\n    }\n');

    it("the button goes through Settings' check before the replace is answered", () => {
        expect(welcome()).toContain("import { authenticateUser } from '../utils/LocalAuth';");
        expect(screen()).toContain('onPress={handleReplaceAccount}');
        expect(screen()).not.toContain('answerReplace(true)');
        const body = handler();
        const asked = body.indexOf('const passed = await authenticateUser(`Confirm authentication to remove ${outCallsign} from this phone.`);');
        const refused = body.indexOf('if (!passed || outgoingIdentityRef.current !== account || !replaceAnswerRef.current) return;');
        const replaced = body.indexOf('answerReplace(true);');
        expect(asked).toBeGreaterThan(-1);
        expect(refused).toBeGreaterThan(asked);
        expect(replaced).toBeGreaterThan(refused);
    });

    it('a yes to the replace is given nowhere else', () => {
        expect(count(welcome(), 'answerReplace(true)')).toBe(1);
    });

    it('a check that answers after the screen moved on (Keep, another account) replaces nothing; a second tap asks once', () => {
        const body = handler();
        expect(body).toContain('const account = outgoingIdentity;');
        expect(body).toMatch(/if \(replaceLockBusyRef\.current\) return;\s*replaceLockBusyRef\.current = true;/);
        expect(body).toMatch(/\} finally \{\s*replaceLockBusyRef\.current = false;\s*\}/);
    });
});
