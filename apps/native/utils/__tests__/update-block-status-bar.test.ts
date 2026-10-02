/**
 * The status bar's icons over the full-screen "Update required" (components/ForceUpdateBlock.tsx) are readable on its
 * background, in the light theme and the dark one, on iOS and Android, and go back to the screens' when it comes down.
 *
 * Seen on the emulator at 320dp and 1.3x font (#1443):
 * - the block set no style of its own, so with Welcome beneath (light icons for its dark page) it showed white icons on
 *   its light page; and on Android its Modal copies the app window's icons once, as it opens (ReactModalHostView
 *   updateSystemAppearance, RN 0.83);
 * - a StatusBar entry pushed with the block lost to Welcome's, which mounts a new one with every step: dark icons over
 *   the block's dark page. So the block holds its style on top of the stack (utils/status-bar-hold.ts).
 *
 * The hold is driven here against a status bar with React Native's stack rules (newest entry wins; the phone is called
 * only when the merged style changes, plus setBarStyle's outright call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Props = { barStyle?: string; animated?: boolean };
type Entry = { props: Props };

/** React Native's StatusBar stack, as its public calls behave (Libraries/Components/StatusBar/StatusBar.js). */
const bar = vi.hoisted(() => {
    const state = {
        stack: [] as Entry[],
        /** What the stack last sent the phone. */
        current: null as string | null,
        /** What the phone shows. */
        phone: null as string | null,
        defaultStyle: 'default',
    };
    const update = () => {
        const top = [...state.stack].reverse().find((e) => e.props.barStyle !== undefined);
        const merged = top?.props.barStyle ?? state.defaultStyle;
        if (merged !== state.current) {
            state.current = merged;
            state.phone = merged;
        }
    };
    const StatusBar = {
        pushStackEntry(props: Props): Entry {
            const entry = { props };
            state.stack.push(entry);
            update();
            return entry;
        },
        popStackEntry(entry: Entry): void {
            const i = state.stack.indexOf(entry);
            if (i !== -1) state.stack.splice(i, 1);
            update();
        },
        setBarStyle(style: string): void {
            state.defaultStyle = style;
            state.phone = style;
        },
    };
    /** A screen's StatusBar mounting (componentDidMount); the function returned unmounts it. */
    const screen = (barStyle: string) => {
        const entry = StatusBar.pushStackEntry({ barStyle });
        return () => StatusBar.popStackEntry(entry);
    };
    return { state, StatusBar, screen };
});

vi.mock('react-native', () => ({ StatusBar: bar.StatusBar }));

const NATIVE = path.resolve(__dirname, '../..');
/** The source without comments, so a pin can't be met by a comment. */
const code = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const block = code(fs.readFileSync(path.join(NATIVE, 'components/ForceUpdateBlock.tsx'), 'utf8'));
const fn = block.slice(block.indexOf('export default function ForceUpdateBlock()'));

const originalPush = bar.StatusBar.pushStackEntry;

beforeEach(() => {
    bar.state.stack = [];
    bar.state.current = null;
    bar.state.phone = null;
    bar.state.defaultStyle = 'default';
    bar.StatusBar.pushStackEntry = originalPush;
});

describe('holdStatusBarStyle (utils/status-bar-hold.ts)', () => {
    it("sets the block's icons over the screen beneath's, and gives the screen's back on release", async () => {
        const { holdStatusBarStyle } = await import('../status-bar-hold');
        bar.screen('dark-content');
        const welcome = bar.screen('light-content');
        expect(bar.state.phone).toBe('light-content');
        const release = holdStatusBarStyle('dark-content');
        expect(bar.state.phone).toBe('dark-content');
        release();
        expect(bar.state.phone).toBe('light-content');
        expect(bar.StatusBar.pushStackEntry).toBe(originalPush);
        welcome();
        expect(bar.state.phone).toBe('dark-content');
    });

    it("stays on top when a screen beneath mounts a StatusBar while it holds (Welcome's next step)", async () => {
        const { holdStatusBarStyle } = await import('../status-bar-hold');
        bar.screen('light-content');
        const release = holdStatusBarStyle('light-content');
        const step = bar.screen('dark-content');
        expect(bar.state.phone).toBe('light-content');
        const another = bar.screen('dark-content');
        expect(bar.state.phone).toBe('light-content');
        release();
        // Back to the newest screen's.
        expect(bar.state.phone).toBe('dark-content');
        another();
        step();
        expect(bar.state.phone).toBe('light-content');
    });

    it('asks the phone outright, even when the stack believes the icons already right (a write it did not make)', async () => {
        const { holdStatusBarStyle } = await import('../status-bar-hold');
        bar.screen('light-content');
        // The development build's launcher writes the bar behind the stack's back.
        bar.state.phone = 'dark-content';
        const release = holdStatusBarStyle('light-content');
        expect(bar.state.phone).toBe('light-content');
        release();
    });

    it('a second hold replaces the first (a theme flip): one entry, the newest style, and one release gives all back', async () => {
        const { holdStatusBarStyle } = await import('../status-bar-hold');
        bar.screen('light-content');
        const first = holdStatusBarStyle('dark-content');
        const second = holdStatusBarStyle('light-content');
        expect(bar.state.stack).toHaveLength(2);
        expect(bar.state.phone).toBe('light-content');
        first();
        expect(bar.state.stack).toHaveLength(2);
        second();
        expect(bar.state.stack).toHaveLength(1);
        expect(bar.StatusBar.pushStackEntry).toBe(originalPush);
    });

    it('never throws: a status bar that refuses leaves things as they were', async () => {
        const { holdStatusBarStyle } = await import('../status-bar-hold');
        bar.StatusBar.pushStackEntry = () => { throw new Error('no status bar'); };
        expect(() => holdStatusBarStyle('dark-content')()).not.toThrow();
    });
});

describe('the block holds it (components/ForceUpdateBlock.tsx)', () => {
    it('with the rule every screen uses, dark icons on light and light on dark, only while it is up, on both phones', () => {
        expect(block).toMatch(/import \{ holdStatusBarStyle \} from '\.\.\/utils\/status-bar-hold';/);
        expect(fn).toMatch(/const \{ colors, theme \} = useTheme\(\);/);
        expect(fn).toMatch(/const barStyle = theme === 'dark' \? 'light' : 'dark';/);
        expect(fn).toMatch(/useEffect\(\(\) => \{\s*if \(!showing\) return;\s*return holdStatusBarStyle\(barStyle === 'light' \? 'light-content' : 'dark-content'\);\s*\}, \[showing, barStyle\]\);/);
        // The same rule as the root layout's.
        const layout = code(fs.readFileSync(path.join(NATIVE, 'app/_layout.tsx'), 'utf8'));
        expect(layout).toContain("<StatusBar style={theme === 'dark' ? 'light' : 'dark'} />");
        // No StatusBar entry of its own, which a later screen's would beat.
        expect(block).not.toMatch(/<StatusBar\b/);
        expect(fn.indexOf('return holdStatusBarStyle(')).toBeLessThan(fn.indexOf('if (!block) return null;'));
    });

    it("Android: the block's window opens only once the hold has set the icons, and afresh when the theme flips", () => {
        expect(fn).toMatch(/const barsSet = Platform\.OS !== 'android' \|\| barsSetFor === barStyle;/);
        const effect = fn.match(/useEffect\(\(\) => \{\s*if \(!showing \|\| Platform\.OS !== 'android'\) \{ setBarsSetFor\(null\); return; \}([\s\S]*?)\}, \[showing, barStyle\]\);/);
        expect(effect).not.toBeNull();
        expect(effect![1]).toMatch(/const timer = setTimeout\(\(\) => setBarsSetFor\(barStyle\), BAR_SETTLE_MS\);/);
        expect(effect![1]).toMatch(/return \(\) => clearTimeout\(timer\);/);
        // The hold's effect runs first.
        expect(fn.indexOf('return holdStatusBarStyle(')).toBeLessThan(fn.indexOf('setTimeout(() => setBarsSetFor(barStyle), BAR_SETTLE_MS)'));
        const settle = block.match(/const BAR_SETTLE_MS = (\d+);/);
        expect(settle).not.toBeNull();
        expect(Number(settle![1])).toBeGreaterThanOrEqual(50);
        expect(Number(settle![1])).toBeLessThanOrEqual(300);
        const android = fn.slice(fn.lastIndexOf('if (!barsSet) return null;'));
        expect(android).toMatch(/^if \(!barsSet\) return null;\s*return \(\s*<Modal\s+key=\{barStyle\}\s+visible/);
        expect(fn.indexOf('const [barsSetFor, setBarsSetFor]')).toBeLessThan(fn.indexOf('if (!block) return null;'));
    });

    it("Android: the words' window opens only once the block's own window is open, so the block never covers it", () => {
        // Opened afresh for a theme flip, both windows would otherwise open in one go, and the inner one can open first.
        expect(fn).toMatch(/<Modal\s+key=\{barStyle\}[^>]*onShow=\{\(\) => setBlockWindowOpen\(true\)\}/);
        expect(fn).toMatch(/useEffect\(\(\) => \{ if \(!barsSet\) setBlockWindowOpen\(false\); \}, \[barsSet\]\);/);
        expect(fn).toContain("{Platform.OS === 'android' && wordsPage && !blockWindowOpen ? null : pageView}");
        expect(fn.match(/\{pageView\}/g)).toBeNull();
        expect(fn.indexOf('const [blockWindowOpen, setBlockWindowOpen]')).toBeLessThan(fn.indexOf('if (!block) return null;'));
    });
});
