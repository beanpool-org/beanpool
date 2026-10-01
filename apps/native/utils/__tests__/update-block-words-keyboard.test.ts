/**
 * "Add my 12 words to this phone" inside the full-screen "Update required" (components/ForceUpdateBlock.tsx) keeps its
 * boxes above the keyboard.
 *
 * #1415's third deciding review (NON-BLOCKING, ForceUpdateBlock.tsx:303, fix before the build): the page was a plain
 * ScrollView in an edge-to-edge Modal. From Android 11 on the keyboard no longer shrinks that Modal's window, and
 * automaticallyAdjustKeyboardInsets is iOS only, so on a small phone the lower rows and Save sat under the keyboard.
 * Settings hosts the same form in react-native-keyboard-controller's KeyboardAwareScrollView; so does the block now.
 *
 * And never a second KeyboardProvider inside a Modal (memory keyboard-avoidance-pattern, measured 2026-09-17): an
 * Android dialog holds one dismiss listener, so a nested provider's watcher replaces the root's and keyboard avoidance
 * stays dead across the app until it is killed. The root provider already hears the Modal's keyboard.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '../..');
/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => code(fs.readFileSync(path.join(NATIVE, rel), 'utf8'));
const block = read('components/ForceUpdateBlock.tsx');

/** The add-words page's branch of the block's render. */
function addWordsPage(): string {
    const start = block.indexOf("page.kind === 'add-words'");
    const end = block.indexOf("page.kind === 'leave'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return block.slice(start, end);
}

describe('the block\'s "Add my 12 words to this phone" page and the keyboard', () => {
    it("uses react-native-keyboard-controller's KeyboardAwareScrollView, as Settings does for the same form", () => {
        expect(block).toMatch(/import \{ KeyboardAwareScrollView \} from 'react-native-keyboard-controller';/);
        const settings = read('app/(tabs)/settings.tsx');
        expect(settings).toMatch(/import \{ KeyboardAwareScrollView \} from 'react-native-keyboard-controller';/);
        expect(settings).toContain('<AddWordsForm');
    });

    it('the form is in that scroll view, inside the no-capture window, and nowhere else in the block', () => {
        const page = addWordsPage();
        expect(page).toMatch(/<WordsWindow[^>]*>\s*\{typingPageScroll\(wordsAdded \?/);
        expect(page).toContain('<AddWordsForm');
        expect(block.match(/<AddWordsForm/g)).toHaveLength(1);
        const scroll = block.match(/const typingPageScroll = \(children: ReactNode\) => \(([\s\S]*?)\);\n/);
        expect(scroll).not.toBeNull();
        expect(scroll![1]).toMatch(/^\s*<KeyboardAwareScrollView [^>]*contentContainerStyle=\{styles\.scroll\}/);
        expect(scroll![1]).toMatch(/<KeyboardAwareScrollView [^>]*keyboardShouldPersistTaps="handled"/);
        expect(scroll![1]).toMatch(/<KeyboardAwareScrollView [^>]*bottomOffset=\{\d+\}/);
        expect(scroll![1]).toContain('<View style={card}>{children}</View>');
        expect(scroll![1]).toMatch(/<\/KeyboardAwareScrollView>\s*$/);
    });

    it("the scroll view's content can grow past the screen (flexGrow, not a fixed height), so the boxes can be scrolled up", () => {
        expect(block).toMatch(/scroll: \{ flexGrow: 1,[^}]*\}/);
        expect(block).not.toMatch(/scroll: \{[^}]*\bheight:/);
    });

    it('never a KeyboardProvider inside the block, or in any other component: only the root one in app/_layout.tsx', () => {
        expect(block).not.toContain('KeyboardProvider');
        const files = (fs.readdirSync(path.join(NATIVE, 'components'), { recursive: true }) as string[])
            .filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__'))
            .map((f) => `components/${f}`);
        expect(files.length).toBeGreaterThan(10);
        for (const f of files) expect(read(f), f).not.toMatch(/<KeyboardProvider\b/);
        const layout = read('app/_layout.tsx');
        expect(layout.match(/<KeyboardProvider\b/g)).toHaveLength(1);
        // The block is inside it, so its KeyboardAwareScrollView hears the keyboard.
        expect(layout.indexOf('<KeyboardProvider>')).toBeLessThan(layout.indexOf('<ForceUpdateBlock />'));
        expect(layout.indexOf('<ForceUpdateBlock />')).toBeLessThan(layout.indexOf('</KeyboardProvider>'));
    });
});
