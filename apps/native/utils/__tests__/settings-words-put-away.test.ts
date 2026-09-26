/**
 * Settings' two reveals of the 12 words put them away when the member leaves (PR #1205 review 4112404314).
 *
 * Account Protection's "Show My 12 Recovery Words" asks the phone's lock, but once it had passed the words stayed
 * drawn: only Hide or a second tap put them away, and the Settings tab stays mounted (no unmountOnBlur). A member who
 * left with Back or another tab without tapping Hide left them on screen, with Copy Words, for whoever next picked up
 * the unlocked phone.
 *
 * - Leaving the section (Back, another section) or the tab puts the words away, so the next Show asks the lock again.
 * - A check still answering when the member has left shows nothing.
 * - View Recovery Phrase's words go the same way.
 *
 * The screen cannot be rendered here (see vitest.config.ts): its wiring is read from its source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const settings = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;
const REASON = 'Confirm your security to view your recovery phrase.';

describe("Account Protection's Show My 12 Recovery Words", () => {
    const putAway = () => slice(settings(), 'const putProtectionWordsAway = React.useCallback(() => {', '}, []);');
    const reveal = () => slice(settings(), 'const handleRevealWords = async () => {', '\n    };\n');

    it('putting them away takes the words out of state and moves the turn on', () => {
        const body = putAway();
        expect(body).toContain('protectionWordsTurnRef.current += 1;');
        expect(body).toContain('setRevealWords(false);');
        expect(body).toContain('setMnemonicWords(null);');
    });

    it('leaving the section puts them away: Back, or any other section', () => {
        expect(settings()).toMatch(/useEffect\(\(\) => \{\s*if \(mode !== 'protection'\) putProtectionWordsAway\(\);/);
    });

    it('leaving the Settings tab puts them away (the tab stays mounted, so its state would otherwise stay)', () => {
        expect(settings()).toMatch(
            /useFocusEffect\(\s*React\.useCallback\(\(\) => \(\) => \{\s*putProtectionWordsAway\(\);\s*putSeedWordsAway\(\);\s*\}, \[putProtectionWordsAway, putSeedWordsAway\]\)\s*\);/,
        );
    });

    it('Hide and the second tap put them away the same way, and nothing else hides them half-way', () => {
        const s = settings();
        expect(s).toContain('onPress={putProtectionWordsAway}');
        expect(reveal()).toMatch(/if \(revealWords\) \{\s*putProtectionWordsAway\(\);\s*return;\s*\}/);
        // The one place each is cleared is putProtectionWordsAway: every way out takes both, and the turn.
        expect(count(s, 'setRevealWords(false)')).toBe(1);
        expect(count(s, 'setMnemonicWords(null)')).toBe(1);
    });

    it('every Show asks the lock, and one that answers after the member left shows nothing', () => {
        const body = reveal();
        const turn = body.indexOf('const turn = protectionWordsTurnRef.current;');
        const asked = body.indexOf(`await readWordsBehindLock(identity, '${REASON}')`);
        const left = body.indexOf('if (turn !== protectionWordsTurnRef.current) return;');
        const kept = body.indexOf('setMnemonicWords(words.join');
        const shown = body.indexOf('setRevealWords(true)');
        expect(turn).toBeGreaterThan(-1);
        expect(asked).toBeGreaterThan(turn);
        expect(left).toBeGreaterThan(asked);
        expect(kept).toBeGreaterThan(left);
        expect(shown).toBeGreaterThan(left);
        // The words reach the screen nowhere else.
        expect(count(settings(), 'setRevealWords(true)')).toBe(1);
        expect(settings().match(/setMnemonicWords\((?!null\)|words\.join)/g)).toBeNull();
    });
});

describe("View Recovery Phrase's words", () => {
    const putAway = () => slice(settings(), 'const putSeedWordsAway = React.useCallback(() => {', '}, []);');
    const show = () => slice(settings(), 'const handleShowSeedWords = async () => {', '\n    };\n');

    it('go when the member leaves its section or the tab', () => {
        const body = putAway();
        expect(body).toContain('seedWordsTurnRef.current += 1;');
        expect(body).toContain('setSeedVisible(false);');
        expect(body).toContain('setSeedWords(null);');
        expect(settings()).toMatch(/if \(mode !== 'seed'\) putSeedWordsAway\(\);/);
    });

    it('Show Recovery Phrase asks the lock each time, and one that answers after the member left shows nothing', () => {
        const s = settings();
        expect(s).toContain('onPress={handleShowSeedWords}');
        const body = show();
        const turn = body.indexOf('const turn = seedWordsTurnRef.current;');
        const asked = body.indexOf(`await readWordsBehindLock(identity, '${REASON}')`);
        const left = body.indexOf('if (!words || turn !== seedWordsTurnRef.current) return;');
        const kept = body.indexOf('setSeedWords(words)');
        const shown = body.indexOf('setSeedVisible(true)');
        expect(turn).toBeGreaterThan(-1);
        expect(asked).toBeGreaterThan(turn);
        expect(left).toBeGreaterThan(asked);
        expect(kept).toBeGreaterThan(left);
        expect(shown).toBeGreaterThan(left);
        expect(count(s, 'setSeedVisible(true)')).toBe(1);
        expect(count(s, 'setSeedWords(words)')).toBe(1);
    });
});
