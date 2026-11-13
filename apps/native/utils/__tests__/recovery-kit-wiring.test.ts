/**
 * Where the recovery kit's buttons sit (components/RecoveryKitButtons.tsx): under the 12 words on the joining step's
 * Safety Backup and on Settings' two reveals, optional everywhere. The screens cannot be rendered here (see
 * vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8'));
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('joining: the Safety Backup step', () => {
    const step = () => slice(read('app/welcome.tsx'), "if (mode === 'seedBackup' && pendingIdentity)", "if (mode === 'onboardingGuide'");

    it('offers the kit for the words it shows, after the words', () => {
        const s = step();
        expect(s).toContain('<RecoveryKitButtons words={pendingWords}');
        expect(s.indexOf('<RecoveryKitButtons')).toBeGreaterThan(s.indexOf('</NoScreenCapture>'));
    });

    it('still lets the member go on with neither button pressed: Next waits only on its own request', () => {
        const s = step();
        const next = slice(s, '<Pressable', 'Next →');
        const nextBlock = s.slice(s.lastIndexOf('<Pressable', s.indexOf('Next →')), s.indexOf('Next →'));
        expect(nextBlock).toContain('disabled={loading}');
        expect(nextBlock).toContain("setMode('onboardingGuide')");
        expect(nextBlock).not.toMatch(/kit|Kit/);
        expect(nextBlock).not.toContain('seedConfirmed &&');
        expect(next.length).toBeGreaterThan(0);
    });

    it('keeps the words behind the screenshot block', () => {
        const s = step();
        const words = s.indexOf('{pendingWords ? pendingWords.map');
        expect(words).toBeGreaterThan(s.indexOf('<NoScreenCapture'));
        expect(s.indexOf('</NoScreenCapture>')).toBeGreaterThan(words);
        expect(s.indexOf('<NoScreenCapture')).toBeGreaterThan(-1);
    });
});

describe("Settings: both reveals of the 12 words", () => {
    const settings = () => read('app/(tabs)/settings.tsx');

    it('offers the kit under Account Protection’s words and View Recovery Phrase’s words', () => {
        const s = settings();
        expect(count(s, '<RecoveryKitButtons')).toBe(2);
        expect(s).toContain("<RecoveryKitButtons words={mnemonicWords ? mnemonicWords.split(' ') : null}");
        expect(s).toContain('<RecoveryKitButtons words={seedWords}');
    });

    it('keeps both word grids behind the screenshot block', () => {
        const s = settings();
        expect(s).toMatch(/<NoScreenCapture>\s*\{mnemonicWords\?\.split\(' '\)\.map/);
        expect(s).toMatch(/<NoScreenCapture>\s*\{seedWords\?\.map/);
    });
});

// Review of #3113 (tier A; the director's rule): the kit coming back is never "kept" (components/RecoveryKitButtons.tsx asks
// "Did you keep it somewhere safe?", and only Yes calls onKept: onboarding-components-words-render.test.ts). Every entry
// to the kit hands it a Yes that records "I still have my 12 words" for its account (utils/words-kept.ts keepWords).
describe('every entry to the kit records a Yes the same way', () => {
    it('the joining step, and both of Settings\' reveals (where the Home card\'s Show my 12 words lands), pass onKept to keepWords', () => {
        const welcome = slice(read('app/welcome.tsx'), "if (mode === 'seedBackup' && pendingIdentity)", "if (mode === 'onboardingGuide'");
        expect(welcome).toContain('<RecoveryKitButtons words={pendingWords} colors={colors} onKept={keptFromKit} />');
        expect(slice(welcome, 'const keptFromKit = () => {', '};')).toContain('keepWords(u, who)');
        const settings = read('app/(tabs)/settings.tsx');
        expect(count(settings, 'onKept={keptFromKit}')).toBe(2);
        expect(count(settings, '<RecoveryKitButtons')).toBe(2);
        expect(slice(settings, 'const keptFromKit = () => {', '};')).toContain('keepWords(u, who)');
    });

    // The parity read of D2 against D3 (row 3): the web's tick "I've saved these words" records words_kept when the member
    // carries it past Next (pages/WelcomePage.tsx); the phone's set only an analytics value, so a member who ticked on the
    // phone was still "not kept" on the account, and the reminder ran on every device.
    it('the tick "I\'ve saved these words", carried past Next, records it on the account the same way, and only when ticked', () => {
        const welcome = slice(read('app/welcome.tsx'), "if (mode === 'seedBackup' && pendingIdentity)", "if (mode === 'onboardingGuide'");
        const next = slice(welcome, "recordOnboardingEvent('protection_choice'", "setMode('onboardingGuide')");
        const ticked = slice(next, 'if (seedConfirmed) {', '}');
        expect(ticked).toContain("AsyncStorage.getItem('beanpool_anchor_url')");
        expect(ticked).toContain('keepWords(u, who)');
        expect(count(next, 'keepWords(')).toBe(1);
        // The tick itself only ticks: nothing is said until Next, so unticking first says nothing.
        expect(slice(welcome, 'onPress={() => setSeedConfirmed(!seedConfirmed)}', 'accessibilityRole')).not.toContain('keepWords');
    });

    it('the buttons call onKept only from the Yes, never from the kit\'s own result', () => {
        const buttons = read('components/RecoveryKitButtons.tsx');
        expect(count(buttons, 'onKept?.()')).toBe(1);
        expect(slice(buttons, 'testID="kit-kept-ask"', 'testID="kit-kept-yes"')).toContain('onKept?.()');
        expect(slice(buttons, 'const run = async', 'return (')).not.toContain('onKept?.(');
    });
});

describe('the buttons themselves', () => {
    it('log nothing and write nothing of their own: the file is made and deleted in utils/recovery-kit.ts', () => {
        const buttons = read('components/RecoveryKitButtons.tsx');
        const kit = read('utils/recovery-kit.ts');
        for (const src of [buttons, kit]) {
            expect(src).not.toMatch(/console\./);
            expect(src).not.toMatch(/AsyncStorage|SecureStore|writeAsStringAsync|Clipboard/);
        }
        expect(buttons).not.toMatch(/expo-print|expo-sharing|expo-file-system/);
        expect(buttons).toContain('KIT_FAILED_LINE');
    });

    it('hold at 320dp with 1.3x text: 48dp targets, labels that wrap', () => {
        const buttons = read('components/RecoveryKitButtons.tsx');
        expect(buttons).toContain('minHeight: 48');
        expect(buttons).not.toContain('numberOfLines');
        expect(buttons).toMatch(/btnText: \{ flexShrink: 1/);
    });
});
