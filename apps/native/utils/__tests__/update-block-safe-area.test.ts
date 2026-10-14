/**
 * Every page of the full-screen "Update required" (components/ForceUpdateBlock.tsx) keeps its card clear of the status
 * bar, the navigation bar and any cutout.
 *
 * Seen on the emulator at 320dp and 1.3x font (#1443): the block and its words window are edge-to-edge (an Android Modal
 * is drawn from the top of the display since Expo 55; iOS's FullWindowOverlay covers the whole window), and their scroll
 * content had a flat 16 of padding, so a page taller than the screen ("Add my 12 words to this phone") put the top of its
 * card under the status bar, and scrolled text ran under the clock. Now every page's scroll view is framed inside the
 * safe-area insets, from the root SafeAreaProvider, as the app's other full-screen Modals use them (EventDetail,
 * CreateGroupModal): the page's background fills the bars, and nothing scrolls under them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '../..');
/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const block = code(fs.readFileSync(path.join(NATIVE, 'components/ForceUpdateBlock.tsx'), 'utf8'));

describe('the update block\'s pages and the safe area', () => {
    it('reads the insets from react-native-safe-area-context, before the block can return early', () => {
        expect(block).toMatch(/import \{ useSafeAreaInsets \} from 'react-native-safe-area-context';/);
        const fn = block.slice(block.indexOf('export default function ForceUpdateBlock()'));
        const hook = fn.indexOf('const insets = useSafeAreaInsets();');
        expect(hook).toBeGreaterThan(-1);
        // A hook after `if (!block) return null` would change the hook order when the block goes up.
        expect(hook).toBeLessThan(fn.indexOf('if (!block) return null;'));
    });

    it('each scroll view is framed inside the insets, so nothing scrolls under the status bar or the navigation bar', () => {
        const m = block.match(/const scrollFrame = \{([\s\S]*?)\};/);
        expect(m).not.toBeNull();
        for (const side of ['top', 'bottom', 'left', 'right']) {
            const prop = `margin${side[0].toUpperCase()}${side.slice(1)}`;
            expect(m![1]).toMatch(new RegExp(`${prop}: insets\\.${side},?`));
        }
        // The card keeps its own space inside the frame.
        expect(block).toMatch(/const PAGE_PADDING = 16;/);
        expect(block).toMatch(/\n\s+scroll: \{ flexGrow: 1,[^}]*padding: PAGE_PADDING/);
    });

    it('every page uses it: the block, the words, adding the words and leaving', () => {
        const scrolls = block.match(/<(ScrollView|KeyboardAwareScrollView)\b[^>]*>/g) ?? [];
        // The block's own screen (main), pageScroll (the words, leaving) and typingPageScroll (adding the words).
        expect(scrolls).toHaveLength(3);
        for (const s of scrolls) {
            expect(s).toContain('style={scrollFrame}');
            expect(s).toContain('contentContainerStyle={styles.scroll}');
        }
        expect(block).toMatch(/const main = \(\s*<ScrollView style=\{scrollFrame\}/);
        expect(block).toMatch(/const pageScroll = \(children: ReactNode\) => \(\s*<ScrollView style=\{scrollFrame\}/);
        expect(block).toMatch(/const typingPageScroll = \(children: ReactNode\) => \(\s*<KeyboardAwareScrollView style=\{scrollFrame\}/);
        // Each page goes through one of them.
        const at = (s: string, from = 0) => {
            const i = block.indexOf(s, from);
            expect(i, s).toBeGreaterThan(-1);
            return i;
        };
        const wordsAt = at("if (page.kind === 'words') {");
        const addWordsAt = at("} else if (page.kind === 'add-words') {", wordsAt);
        const leaveAt = at("} else if (page.kind === 'leave') {", addWordsAt);
        const mainAt = at('const main = (', leaveAt);
        expect(block.slice(wordsAt, addWordsAt)).toContain('{pageScroll(');
        expect(block.slice(addWordsAt, leaveAt)).toContain('{typingPageScroll(');
        expect(block.slice(leaveAt, mainAt)).toContain('const content = pageScroll(');
    });
});
