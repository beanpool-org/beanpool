import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { inputIsInScroll, scrollTargetForCaret, type CaretVisibleArgs } from '../scroll-caret-visible';

// New Post on an iPhone with the keyboard up (3 Nov, Rob): the sheet is lifted by a KeyboardAvoidingView, so the
// ScrollView's viewport is what is left above the keyboard. Say 260 high, with 1000 of form inside it.
const base: CaretVisibleArgs = {
    scrollY: 0, viewportHeight: 260, contentHeight: 1000,
    fieldTop: 100, fieldHeight: 44, caretBottomInField: null, lineHeight: 22, gap: 24,
};

describe('the focused field and the caret stay in view above the keyboard', () => {
    it('a field already in view does not move the form', () => {
        expect(scrollTargetForCaret(base)).toBeNull();
    });

    it('a field below the viewport (the Price under a long form) scrolls into view, with the gap under it', () => {
        expect(scrollTargetForCaret({ ...base, fieldTop: 500 })).toBe(500 + 44 + 24 - 260);
    });

    it('a field above the viewport (scrolled past) scrolls back up to it', () => {
        expect(scrollTargetForCaret({ ...base, scrollY: 400, fieldTop: 300 })).toBe(300 - 24);
    });

    it('a Description that grows keeps its last line in view: the caret follows the content size', () => {
        // Fits the viewport: the whole field is kept in view, so the caret is too.
        expect(scrollTargetForCaret({ ...base, fieldTop: 120, fieldHeight: 200, caretBottomInField: 200 })).toBe(120 + 200 + 24 - 260);
        // Grown past the viewport: the caret's line, not the field's top, is what stays in view.
        const grown = { ...base, fieldTop: 120, fieldHeight: 400, caretBottomInField: 400 };
        expect(scrollTargetForCaret(grown)).toBe(120 + 400 + 24 - 260);
        // One more line: the target moves down by the line.
        expect(scrollTargetForCaret({ ...grown, scrollY: 284, fieldHeight: 422, caretBottomInField: 422 })).toBe(120 + 422 + 24 - 260);
    });

    it('typing in the middle of a long Description follows the caret, not the end of the field', () => {
        const a = { ...base, fieldTop: 120, fieldHeight: 400, caretBottomInField: 100, scrollY: 284 };
        // the caret's line is 198..220 in content and the viewport shows 284..544: scroll up to it
        expect(scrollTargetForCaret(a)).toBe(120 + 100 - 22 - 24);
        expect(scrollTargetForCaret({ ...a, scrollY: 150 })).toBeNull();
    });

    it('a field taller than the viewport with no caret yet shows its start', () => {
        expect(scrollTargetForCaret({ ...base, fieldTop: 500, fieldHeight: 400 })).toBe(500 + 22 + 24 - 260);
    });

    it('never scrolls past the content, never above 0', () => {
        expect(scrollTargetForCaret({ ...base, contentHeight: 600, fieldTop: 540, fieldHeight: 44 })).toBe(340);
        expect(scrollTargetForCaret({ ...base, scrollY: 50, fieldTop: 10 })).toBe(0);
    });

    it('nothing to do before the viewport is measured', () => {
        expect(scrollTargetForCaret({ ...base, viewportHeight: 0, fieldTop: 500 })).toBeNull();
        expect(scrollTargetForCaret({ ...base, fieldHeight: 0, fieldTop: 500 })).toBeNull();
    });

    it('a tiny viewport (320 dp, 130% text, keyboard up) still keeps the field in view', () => {
        // the gap is capped to a quarter of the viewport (22.5)
        expect(scrollTargetForCaret({ ...base, viewportHeight: 90, fieldTop: 300 })).toBe(300 + 44 + 22.5 - 90);
    });
});

// The sheets that use it, and what the hook must not do (memory keyboard-avoidance-pattern: no second KeyboardProvider,
// nothing else that resets Android's soft-input mode, or a sheet double-lifts on Android 10 and below).
const NATIVE = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(NATIVE, f), 'utf8');

describe('the form sheets use it', () => {
    const sheets = ['app/new-listing.tsx', 'components/NewEventModal.tsx', 'components/NewPollModal.tsx', 'app/post/[id].tsx'];

    for (const f of sheets) {
        it(`${f}: the ScrollView carries the hook's props, and the lift is a keyboard-controller KeyboardAvoidingView`, () => {
            const src = read(f);
            expect(src).toMatch(/useKeepCaretVisible\(/);
            expect(src).toMatch(/<ScrollView\s+ref=\{(scrollViewRef|scrollRef)\}\s+\{\.\.\.keepCaretVisible\}/);
            // post/[id] also imports the library's KeyboardAwareScrollView, for its decline-offer card.
            expect(src).toMatch(/import \{ KeyboardAvoidingView(, KeyboardAwareScrollView)? \} from 'react-native-keyboard-controller'/);
            expect(src).not.toMatch(/KeyboardProvider/);
        });
    }

    it('New Post has one KeyboardAvoidingView around its sheet (the hook adds no lift)', () => {
        expect(read('app/new-listing.tsx').match(/<KeyboardAvoidingView/g)).toHaveLength(1);
    });

    it('the hook asks for no soft-input mode and no second provider', () => {
        const src = read('components/useKeepCaretVisible.ts');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/useKeyboardHandler|useKeyboardAnimation|useReanimatedKeyboardAnimation|useResizeMode|KeyboardProvider|setInputMode|setDefaultMode|KeyboardAwareScrollView|KeyboardAvoidingView/);
        expect(code).toMatch(/useFocusedInputHandler/);
        expect(code).toMatch(/useReanimatedFocusedInput/);
    });
});

// The TagPicker's Modal renders inside the form's ScrollView but its search box is measured in the modal's own
// coordinates: the hook must leave it alone (Opus review of #2798) and act only on the form's own inputs.
describe('inputIsInScroll: only the own ScrollView focused input counts', () => {
    const FORM = 41; // findNodeHandle(the form's ScrollView)
    const formField = { target: 7, parentScrollViewTarget: FORM };
    const tagSearchInModal = { target: 9, parentScrollViewTarget: 57 }; // the Modal has its own scroll parent
    const unscrolledField = { target: 11, parentScrollViewTarget: -1 }; // not inside any ScrollView

    it('the form own input counts, with or without an event', () => {
        expect(inputIsInScroll(formField, FORM)).toBe(true);
        expect(inputIsInScroll(formField, FORM, 7)).toBe(true);
    });

    it('an input in another ScrollView or Modal does not: no scroll for focus, keystrokes or lift frames', () => {
        expect(inputIsInScroll(tagSearchInModal, FORM)).toBe(false);
        expect(inputIsInScroll(tagSearchInModal, FORM, 9)).toBe(false);
        expect(inputIsInScroll(unscrolledField, FORM, 11)).toBe(false);
    });

    it('an event about another input than the focused one is dropped', () => {
        expect(inputIsInScroll(formField, FORM, 9)).toBe(false);
    });

    it('nothing focused, or the ScrollView not laid out yet, counts for nothing', () => {
        expect(inputIsInScroll(null, FORM)).toBe(false);
        expect(inputIsInScroll(undefined, FORM, 7)).toBe(false);
        expect(inputIsInScroll(formField, -1)).toBe(false);
        expect(inputIsInScroll({ target: 7, parentScrollViewTarget: -1 }, -1)).toBe(false);
        expect(inputIsInScroll(formField, 0)).toBe(false);
    });
});

describe('the hook applies the guard to every way it can be triggered', () => {
    const code = read('components/useKeepCaretVisible.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    it('caret events are judged against the focused input and the handle of this ScrollView', () => {
        expect(code).toMatch(/onSelectionChange[\s\S]*?inputIsInScroll\(input\.value, scrollHandle\.value, e\.target\)[\s\S]*?scheduleOnRN\(onCaret/);
    });

    it('focus and field-height changes are guarded, and the handle comes from findNodeHandle of the ScrollView', () => {
        expect(code.match(/inputIsInScroll\(input\.value, scrollHandle\.value\)/g)).toHaveLength(2);
        expect(code).toMatch(/scrollHandle\.value = findNodeHandle\(scrollRef\.current\)/);
    });

    it('the measure does nothing while the focused input is not in this ScrollView (layout frames, a Modal field)', () => {
        expect(code).toMatch(/const ensure = useCallback\(\(\) => \{\s*if \(ownInput\.current === -1\) return;/);
        expect(code).toMatch(/if \(cur !== prev\) scheduleOnRN\(onFocusOrResize, cur\)/); // -1 (focus left) is passed on, so it clears
    });
});
