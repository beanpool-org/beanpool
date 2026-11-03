/**
 * The 3 Nov keyboard audit, groups A, B and E (scratch/keyboard-audit/AUDIT-2026-11-03.md): the phone's full-screen forms keep
 * the field being typed in above the keyboard. They used to wrap a plain ScrollView in a keyboard-controller KeyboardAvoidingView
 * (which shrinks the page but never scrolls to the field: Rob's New Post report), or had no keyboard handling at all. Now the
 * library's KeyboardAwareScrollView (the recipe treasury-post, suggest-change and owner-words-check already use) scrolls the field
 * above the keyboard; a footer button rides on a KeyboardStickyView; a FlatList takes the same scroll view as its
 * renderScrollComponent. Not a new helper: the behaviour is the library's.
 * These read the sources (the behaviour was driven on the Android emulator); a screen that later drops its wiring fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url).href), 'utf8');
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// [file, how many KeyboardAwareScrollViews it draws]
const SCROLLS: Array<[string, number]> = [
    ['app/group-post.tsx', 1],
    ['app/propose-project.tsx', 1],
    ['app/treasury-detail.tsx', 1],
    ['components/EventDetail.tsx', 1],
    ['components/ListingCopy.tsx', 1],
    ['app/node-mismatch.tsx', 1],
    ['app/channels.tsx', 1],
    ['app/pulse-intake.tsx', 1],
    ['app/welcome.tsx', 6],
    ['app/beanpool.tsx', 1],
    ['app/old-words-unlock.tsx', 1],
    ['app/profile-setup.tsx', 1],
    ['app/post/[id].tsx', 1],
];

describe('groups A and B: each full-screen form scrolls the field being typed in above the keyboard', () => {
    for (const [file, n] of SCROLLS) {
        it(`${file}: ${n} KeyboardAwareScrollView(s) with a bottomOffset, and no React Native KeyboardAvoidingView`, () => {
            const c = code(file);
            expect(c.match(/<KeyboardAwareScrollView\b/g) ?? []).toHaveLength(n);
            expect(c.match(/<\/KeyboardAwareScrollView>/g) ?? []).toHaveLength(n);
            expect(c.match(/<KeyboardAwareScrollView\b[^>]*bottomOffset=/g) ?? []).toHaveLength(n);
            expect(c).toMatch(/import \{[^}]*KeyboardAwareScrollView[^}]*\} from 'react-native-keyboard-controller'/);
            // Never React Native's own KeyboardAvoidingView (iOS only), and never a second KeyboardProvider.
            expect(c).not.toMatch(/KeyboardAvoidingView[^}]*\} from 'react-native'/);
            expect(c).not.toMatch(/KeyboardProvider/);
        });
    }

    it('no screen wraps the library scroll view in a second KeyboardAvoidingView (the two race, and the lift is doubled)', () => {
        for (const [file] of SCROLLS) {
            if (file === 'app/post/[id].tsx') continue; // the page itself keeps #2798's KeyboardAvoidingView + useKeepCaretVisible
            expect(code(file), file).not.toMatch(/<KeyboardAvoidingView\b/);
        }
    });

    it('post/[id]: the page keeps its own lift and caret hook; only the decline card (an overlay on top of it) took the library scroll view', () => {
        const c = code('app/post/[id].tsx');
        expect(c).toMatch(/useKeepCaretVisible\(/);
        expect(c.match(/<KeyboardAvoidingView\b/g) ?? []).toHaveLength(1);
        const decline = c.slice(c.indexOf('rejectModalTxId && ('), c.indexOf('showContributionRequired && ('));
        expect(decline).toMatch(/<KeyboardAwareScrollView\b/);
        expect(decline).not.toMatch(/KeyboardAvoidingView/);
    });

    it('group-post: the Post button rides above the keyboard in a KeyboardStickyView, and the scroll view clears its measured height', () => {
        const c = code('app/group-post.tsx');
        expect(c).toMatch(/<KeyboardStickyView onLayout=\{\(e\) => setFooterHeight\(e\.nativeEvent\.layout\.height\)\}>/);
        expect(c).toMatch(/bottomOffset=\{footerHeight \+ 16\}/);
        expect(c.indexOf('<KeyboardStickyView')).toBeGreaterThan(c.indexOf('</KeyboardAwareScrollView>'));
        expect(c.indexOf('style={styles.footer}')).toBeGreaterThan(c.indexOf('<KeyboardStickyView'));
    });

    it('propose-project: the Start button stays hidden while the keyboard is up, so the form gets the whole space', () => {
        const c = code('app/propose-project.tsx');
        expect(c).toMatch(/\{!keyboardVisible && \(\s*<View style=\{styles\.footer\}>/);
    });

    it('channels keeps scrolling to the top of its page through the same ref', () => {
        const c = code('app/channels.tsx');
        expect(c).toMatch(/useRef<KeyboardAwareScrollViewRef>\(null\)/);
        expect(c).toMatch(/<KeyboardAwareScrollView ref=\{scrollRef\}/);
        expect(c).toMatch(/scrollRef\.current\?\.scrollTo\(/);
    });
});

describe('group B and E: the lists with a field in them take the library scroll view', () => {
    it('keyboardAwareList is the library scroll view with a bottom margin, and nothing else', () => {
        const c = code('components/keyboardAwareList.tsx');
        expect(c).toMatch(/<KeyboardAwareScrollView \{\.\.\.props\} bottomOffset=\{24\} \/>/);
        expect(c).not.toMatch(/useKeyboardHandler|KeyboardProvider|Keyboard\.addListener/);
    });

    it('the Market feed (a poll card\'s Other line is typed mid-feed) uses it', () => {
        const c = code('app/(tabs)/market.tsx');
        expect(c).toMatch(/import \{ keyboardAwareList \} from '..\/..\/components\/keyboardAwareList'/);
        expect(c.match(/renderScrollComponent=\{keyboardAwareList\}/g) ?? []).toHaveLength(1);
    });

    it('the Ledger list (the send form is in its header) uses it, with no iOS-only avoiding view or hand-made keyboard padding', () => {
        const c = code('app/(tabs)/ledger.tsx');
        expect(c).toMatch(/renderScrollComponent=\{keyboardAwareList\}/);
        expect(c).not.toMatch(/KeyboardAvoidingView|keyboardHeight|Keyboard\.addListener/);
    });
});
