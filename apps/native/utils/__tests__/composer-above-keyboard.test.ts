/**
 * With the keyboard up, the text field and Send stay above it on every composer screen, with every optional bar shown
 * above the box, both as a full-screen screen and as an iPhone page sheet (Rob, iPhone, 17 Nov: a DM opened from a
 * listing had its "About: …" bar sitting on the keyboard and the message box under it). The same holds for the form
 * sheets whose fields a caret-follow keeps in view: New Event, New Poll and a listing's own page (Rob's first report,
 * 3 Nov, was a form sheet).
 *
 * The cause: react-native-keyboard-controller's KeyboardAvoidingView pads by its frame in its parent less the keyboard's
 * top in the WINDOW. A listing (post/[id]) is a sheet, native-stack presents any route pushed after a sheet as a sheet too
 * (getModalRouteKeys), an RN Modal with presentationStyle="pageSheet" is a sheet, and a sheet starts ~50 pt down the
 * window, so the padding came up short by that much and the box (about as tall) went under the keyboard. Each of them now
 * passes the screen's top in the window as keyboardVerticalOffset (components/useScreenKeyboardOffset.ts,
 * utils/screen-keyboard-offset.ts).
 *
 * Part 1, one table: every keyboard view that takes the offset × card or sheet × every optional bar it can show. Each row
 * reads the screen's own source for what it hands its KeyboardAvoidingView (none = 0, the hook = the measured offset) and
 * whether the screen's root feeds the hook's measure, puts the bars and the box inside the KeyboardAvoidingView (so the
 * padding lifts them), and then lays the column out with the library's own padding formula and checks where the box lands.
 * The form sheets also run the caret-follow's own arithmetic (scrollTargetForCaret) on a field low in a long form.
 *
 * Part 2 closes the class: a scan of every <KeyboardAvoidingView in app/ and components/. Each one is in the table above
 * or on the named exemption list below, whose reason the test checks against the source (a full-window Modal, a tab, a
 * full-window route). A new keyboard view in neither fails here first. Every caret-follow ScrollView
 * (useKeepCaretVisible) sits inside one of them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { keyboardViewPadding, screenKeyboardOffset } from '../screen-keyboard-offset';
import { scrollTargetForCaret } from '../scroll-caret-visible';

const NATIVE = path.join(__dirname, '..', '..');

type Screen = {
    file: string;
    /** The component that renders the KeyboardAvoidingView. */
    component: string;
    /** The tag of the box the member types in (inside the KeyboardAvoidingView); null when the fields come in as a prop. */
    composer: string | null;
    /** The optional bars this screen can show above the box, by tag (each must sit inside the KeyboardAvoidingView). */
    bars: string[];
    /** True when the KeyboardAvoidingView is the screen's root view (it measures itself). */
    kavIsRoot: boolean;
    /** A form whose ScrollView a caret-follow (useKeepCaretVisible) keeps the focused field in. */
    caretForm?: boolean;
};

const SCREENS: Screen[] = [
    // The DM: About (opened from a listing), Reply, Editing; the paused-key and lock lines are the composer's own notice.
    { file: 'app/chat/[id].tsx', component: 'ChatScreen', composer: 'ChatComposer', bars: ['ChatAboutBanner', 'ChatReplyBanner', 'ChatEditBanner'], kavIsRoot: false },
    // Groups and enterprise threads: Reply and Editing.
    { file: 'components/GroupChatView.tsx', component: 'GroupChatView', composer: 'ChatComposer', bars: ['ChatReplyBanner', 'ChatEditBanner'], kavIsRoot: true },
    // Event chats.
    { file: 'components/EventChatView.tsx', component: 'EventChatView', composer: 'ChatComposer', bars: [], kavIsRoot: true },
    // A guest's chat and a chat with someone in another community.
    { file: 'app/guest-chat/[id].tsx', component: 'GuestChatScreen', composer: 'TextInput', bars: [], kavIsRoot: false },
    { file: 'app/outside-chat/[id].tsx', component: 'OutsideChatScreen', composer: 'TextInput', bars: [], kavIsRoot: false },
    // A forum topic's reply box (its link picker and report box are sheets of their own) and a new topic.
    { file: 'app/forum/[id].tsx', component: 'ForumTopicScreen', composer: 'ChatComposer', bars: [], kavIsRoot: false },
    { file: 'app/forum/new.tsx', component: 'NewForumTopicScreen', composer: 'TextInput', bars: [], kavIsRoot: false },
    // New message, contacts (add by hand) and the address card: their fields sit in the same kind of column.
    { file: 'app/new-message.tsx', component: 'NewMessageScreen', composer: 'TextInput', bars: [], kavIsRoot: false },
    { file: 'app/contacts.tsx', component: 'ContactsScreen', composer: null, bars: [], kavIsRoot: false },
    { file: 'app/address-card.tsx', component: 'AddressCardScreen', composer: 'TextInput', bars: [], kavIsRoot: false },
    // The form sheets: New Event and New Poll are RN Modals with presentationStyle="pageSheet" (the keyboard view is the
    // Modal's root); a listing's own page (its reply, rating and edit fields) is always a sheet (sheetOptions).
    { file: 'components/NewEventModal.tsx', component: 'NewEventModal', composer: 'ScrollView', bars: [], kavIsRoot: true, caretForm: true },
    { file: 'components/NewPollModal.tsx', component: 'NewPollModal', composer: 'ScrollView', bars: [], kavIsRoot: true, caretForm: true },
    { file: 'app/post/[id].tsx', component: 'PostDetailModal', composer: 'ScrollView', bars: [], kavIsRoot: false, caretForm: true },
];

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;

function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, fs.readFileSync(path.join(NATIVE, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function tagName(node: ts.Node): string | null {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
    return null;
}

function findComponent(sf: ts.SourceFile, name: string): ts.Node {
    let found: ts.Node | undefined;
    const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
        else ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error(`${name} not found in ${sf.fileName}`);
    return found;
}

function elements(root: ts.Node, tag: string): Jsx[] {
    const out: Jsx[] = [];
    const visit = (n: ts.Node) => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === tag) out.push(n);
        ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
}

function attrs(node: Jsx): ts.JsxAttributes {
    return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function attr(node: Jsx, name: string): string | undefined {
    const a = attrs(node).properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name) as ts.JsxAttribute | undefined;
    if (!a) return undefined;
    // A bare attribute (`transparent`) is true.
    return a.initializer ? a.initializer.getText() : '{true}';
}

/** The JSX elements around `node`, nearest first. */
function jsxAncestors(node: ts.Node): Jsx[] {
    const out: Jsx[] = [];
    for (let p = node.parent; p; p = p.parent) if (ts.isJsxElement(p)) out.push(p);
    return out;
}

/** The variable the screen holds useScreenKeyboardOffset() in, or null when it never calls it. */
function hookVariable(component: ts.Node): string | null {
    let name: string | null = null;
    const visit = (n: ts.Node) => {
        if (name) return;
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
            && n.initializer.expression.getText() === 'useScreenKeyboardOffset' && ts.isIdentifier(n.name)) name = n.name.text;
        else ts.forEachChild(n, visit);
    };
    visit(component);
    return name;
}

/** What the screen's source hands its KeyboardAvoidingView, read off the tree: the offset it passes and who measures it. */
function wiring(screen: Screen) {
    const sf = parse(screen.file);
    const component = findComponent(sf, screen.component);
    const kavs = elements(component, 'KeyboardAvoidingView');
    if (kavs.length !== 1) throw new Error(`${screen.file}: expected one KeyboardAvoidingView, found ${kavs.length}`);
    const kav = kavs[0];
    const hook = hookVariable(component);
    const offsetAttr = attr(kav, 'keyboardVerticalOffset');
    const passesMeasuredOffset = !!hook && offsetAttr === `{${hook}.keyboardVerticalOffset}`;
    // The measure: the KeyboardAvoidingView's own onLayout when it is the root, else the nearest JSX element above it.
    const measuredBy: Jsx = screen.kavIsRoot ? kav : jsxAncestors(kav)[0];
    const measured = !!hook && !!measuredBy && attr(measuredBy, 'onLayout') === `{${hook}.onScreenLayout}`;
    const inside = (tag: string) => elements(kav, tag).length > 0;
    const outside = (tag: string) => elements(component, tag).length - elements(kav, tag).length;
    return { passesMeasuredOffset, measured, offsetAttr, inside, outside, measuredByTag: measuredBy ? tagName(measuredBy) : null };
}

// A 390 × 844 iPhone (Rob's), a 320 × 568 small one; the keyboard with its QuickType strip; the page sheet's top
// (status bar + 10). Heights in points; the bars as drawn at 1.3× text.
const PHONES = [
    { name: '390 × 844', window: 844, keyboard: 336, sheetTop: 57 },
    { name: '320 × 568', window: 568, keyboard: 253, sheetTop: 30 },
];
const HEADER = 64;
const BAR = 52;
const COMPOSER = 58;
// The caret-follow's own numbers (components/useKeepCaretVisible.ts).
const CARET_GAP = 24;
const CARET_LINE = 22;

describe('composer above the keyboard: every composer screen × card or iPhone sheet × every optional bar', () => {
    for (const screen of SCREENS) {
        describe(screen.file, () => {
            const w = wiring(screen);

            it('its KeyboardAvoidingView takes the measured screen offset, and the screen root feeds the measure', () => {
                expect(w.offsetAttr, 'keyboardVerticalOffset from useScreenKeyboardOffset()').toBeDefined();
                expect(w.passesMeasuredOffset).toBe(true);
                expect(w.measured, `onLayout={…onScreenLayout} on ${w.measuredByTag}`).toBe(true);
            });

            it('the box and every optional bar sit inside the KeyboardAvoidingView, so its padding lifts them', () => {
                for (const tag of [...(screen.composer ? [screen.composer] : []), ...screen.bars]) {
                    expect(w.inside(tag), `${tag} inside the KeyboardAvoidingView`).toBe(true);
                }
                for (const tag of screen.bars) expect(w.outside(tag), `${tag} outside the KeyboardAvoidingView`).toBe(0);
            });

            for (const phone of PHONES) {
                for (const presentation of ['card', 'sheet'] as const) {
                    const screenTop = presentation === 'sheet' ? phone.sheetTop : 0;
                    const screenHeight = phone.window - screenTop;
                    const keyboardTop = phone.window - phone.keyboard;
                    // The KeyboardAvoidingView's frame in its parent: under the header to the screen's bottom (the root
                    // view when it is the screen itself), and where its content ends once the padding lifts it.
                    const column = () => {
                        // What the screen hands the view on an iPhone: the hook's offset when it is wired, else nothing.
                        const offset = w.passesMeasuredOffset && w.measured
                            ? screenKeyboardOffset({ os: 'ios', windowHeight: phone.window, screenHeight })
                            : 0;
                        const frameY = screen.kavIsRoot ? 0 : HEADER;
                        const frameHeight = screenHeight - frameY;
                        const padding = keyboardViewPadding({ frameY, frameHeight, windowHeight: phone.window, keyboardHeight: phone.keyboard, keyboardVerticalOffset: offset });
                        return { frameY, contentBottom: screenTop + frameY + frameHeight - padding };
                    };

                    const barSets = [[], ...screen.bars.map((b) => [b]), ...(screen.bars.length > 1 ? [screen.bars] : [])];
                    for (const bars of barSets) {
                        it(`${phone.name}, ${presentation}, bars: ${bars.join(' + ') || 'none'}: the text field and Send are above the keyboard`, () => {
                            const { frameY, contentBottom } = column();
                            // The column packs to its bottom: the box sits on the padding, the bars on the box.
                            const composerBottom = contentBottom;
                            const composerTop = composerBottom - COMPOSER;
                            const barsTop = composerTop - BAR * bars.length;
                            expect(composerBottom, 'the box ends above the keyboard').toBeLessThanOrEqual(keyboardTop);
                            // Not lifted too far either: no gap between the box and the keyboard.
                            expect(composerBottom, 'the box sits on the keyboard').toBe(keyboardTop);
                            expect(barsTop, 'the bars and the box fit under the header').toBeGreaterThanOrEqual(screenTop + (screen.kavIsRoot ? HEADER : frameY));
                        });
                    }

                    if (screen.caretForm) {
                        it(`${phone.name}, ${presentation}: the caret-follow brings a field low in a long form fully above the keyboard`, () => {
                            // The form's ScrollView runs from under the header to the lifted column's bottom: that height is
                            // the viewport useKeepCaretVisible scrolls by (its onLayout).
                            const viewportTop = screenTop + HEADER;
                            const viewportHeight = column().contentBottom - viewportTop;
                            const field = { top: 900, height: 44 };
                            const target = scrollTargetForCaret({
                                scrollY: 0, viewportHeight, contentHeight: 1600, fieldTop: field.top, fieldHeight: field.height,
                                caretBottomInField: null, lineHeight: CARET_LINE, gap: CARET_GAP,
                            });
                            expect(target, 'the form scrolls to the field').not.toBeNull();
                            const fieldBottomInWindow = viewportTop + field.top + field.height - (target ?? 0);
                            // On main, in a sheet, this landed the sheet's top minus the gap UNDER the keyboard's top (33 pt
                            // on a 390 × 844 phone): the review's arithmetic on #3279.
                            expect(fieldBottomInWindow, 'the field ends above the keyboard, with the caret-follow\'s gap').toBe(keyboardTop - CARET_GAP);
                        });
                    }
                }
            }
        });
    }

    it('the offset is the sheet top on an iPhone, 0 when the screen fills the window, and 0 on Android', () => {
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 787 })).toBe(57);
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 844 })).toBe(0);
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 0 })).toBe(0);
        expect(screenKeyboardOffset({ os: 'android', windowHeight: 844, screenHeight: 787 })).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Part 2: every keyboard view in the app, found by a scan.

/** Why a keyboard view may go without the offset: each kind is a claim about where its view starts, checked below. */
type ExemptKind =
    /** Inside an RN <Modal> with no sheet presentationStyle: iOS presents it over the whole window (overFullScreen when
     *  transparent, fullScreen otherwise), so the view's parent starts at the window's top and the offset is 0 anyway. */
    | 'full-window Modal'
    /** In a tab: the tabs are the root stack's first screen, a full-screen card with no presentation, never a sheet. */
    | 'tab'
    /** A route the root stack presents as a transparentModal, which react-native-screens shows over the full window
     *  (RNSScreen.mm: UIModalPresentationOverFullScreen). */
    | 'full-window route';

type Exempt = { file: string; component: string; count: number; kind: ExemptKind; why: string };

const EXEMPT: Exempt[] = [
    { file: 'components/TagPicker.tsx', component: 'TagPicker', count: 1, kind: 'full-window Modal', why: 'the tag sheet is a transparent Modal' },
    { file: 'components/TotpCodeDialog.tsx', component: 'TotpCodeDialog', count: 1, kind: 'full-window Modal', why: 'the code dialog is a transparent Modal' },
    { file: 'components/RemovalReplySheet.tsx', component: 'RemovalReplySheet', count: 1, kind: 'full-window Modal', why: 'the reply sheet is a transparent Modal' },
    { file: 'components/ReviewModal.tsx', component: 'ReviewModal', count: 1, kind: 'full-window Modal', why: 'the review sheet is a transparent Modal' },
    { file: 'app/(tabs)/people.tsx', component: 'PeopleScreen', count: 1, kind: 'tab', why: 'the People tab keeps its own tuned offset (88) for the tab bar' },
    { file: 'app/new-listing.tsx', component: 'NewListingScreen', count: 1, kind: 'full-window route', why: 'New Post is a transparentModal route over the whole window' },
];

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(NATIVE, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            out.push(...sourceFiles(rel));
        } else if (/\.tsx$/.test(entry.name)) out.push(rel);
    }
    return out;
}

/** The top-level declaration a node sits in: the component's name (a function, or a const holding one). */
function topLevelName(node: ts.Node): string {
    let top: ts.Node = node;
    while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
    if (ts.isFunctionDeclaration(top)) return top.name?.text ?? 'default';
    if (ts.isVariableStatement(top)) {
        const d = top.declarationList.declarations[0];
        return ts.isIdentifier(d.name) ? d.name.text : '?';
    }
    if (ts.isExportAssignment(top)) return 'default';
    return '?';
}

type Found = { file: string; component: string; kav: Jsx; sf: ts.SourceFile };

const FILES = [...sourceFiles('app'), ...sourceFiles('components')].sort();
const FOUND: Found[] = [];
for (const file of FILES) {
    const text = fs.readFileSync(path.join(NATIVE, file), 'utf8');
    if (!text.includes('KeyboardAvoidingView')) continue;
    const sf = parse(file);
    for (const kav of elements(sf, 'KeyboardAvoidingView')) FOUND.push({ file, component: topLevelName(kav), kav, sf });
}

const ROOT_LAYOUT = fs.readFileSync(path.join(NATIVE, 'app/_layout.tsx'), 'utf8');

/** Check an exemption's claim against the source; returns what is wrong, or null when it holds. */
function exemptionFails(found: Found, ex: Exempt): string | null {
    const modal = jsxAncestors(found.kav).find((a) => tagName(a) === 'Modal');
    if (ex.kind === 'full-window Modal') {
        if (!modal) return 'it is not inside a <Modal>';
        const style = attr(modal, 'presentationStyle');
        if (style && !['"fullScreen"', '"overFullScreen"', "{'fullScreen'}", "{'overFullScreen'}"].includes(style)) {
            return `its Modal is presentationStyle=${style}: a sheet, so it starts below the window's top and needs useScreenKeyboardOffset`;
        }
        return null;
    }
    if (modal) return 'it is inside a <Modal>, so the route it sits in says nothing about where it starts';
    if (ex.kind === 'tab') {
        if (!found.file.startsWith('app/(tabs)/')) return 'it is not a tab';
        const first = ROOT_LAYOUT.match(/<Stack\.Screen\s+name="([^"]+)"([^>]*)\/>/);
        if (!first || first[1] !== '(tabs)') return "the root stack's first screen is no longer (tabs)";
        if (/presentation/.test(first[2])) return 'the tabs have a presentation of their own';
        return null;
    }
    const route = found.file.replace(/^app\//, '').replace(/\.tsx$/, '');
    // The route's own line in the root stack: <Stack.Screen name="new-listing" options={{ presentation: … }} />
    const decl = ROOT_LAYOUT.match(new RegExp(`<Stack\\.Screen\\s+name="${route.replace(/[[\]()]/g, '\\$&')}"\\s+options=\\{([^\\n]*)\\}\\s*/>`));
    if (!decl) return `app/_layout.tsx no longer declares ${route} with inline options`;
    if (!/presentation:\s*'transparentModal'/.test(decl[1])) return `${route} is no longer a transparentModal: ${decl[1].trim()}`;
    return null;
}

describe('every keyboard view in the app takes the sheet offset, or is exempt for a reason the source shows', () => {
    it('the scan finds the keyboard views (a scan that finds nothing proves nothing)', () => {
        expect(FOUND.length).toBeGreaterThanOrEqual(SCREENS.length + EXEMPT.length);
    });

    it('no file renames KeyboardAvoidingView on import (the scan looks for that tag)', () => {
        const renamed = FILES.filter((f) => /\bKeyboardAvoidingView\s+as\s+\w+/.test(fs.readFileSync(path.join(NATIVE, f), 'utf8')));
        expect(renamed).toEqual([]);
    });

    for (const found of FOUND) {
        const line = found.sf.getLineAndCharacterOfPosition(found.kav.getStart()).line + 1;
        it(`${found.file}:${line} (${found.component})`, () => {
            const inTable = SCREENS.find((s) => s.file === found.file && s.component === found.component);
            const ex = EXEMPT.find((e) => e.file === found.file && e.component === found.component);
            expect(inTable || ex, `${found.file}:${line}: a KeyboardAvoidingView in neither the table nor the exemption list. `
                + 'On an iPhone sheet it lifts short by the sheet\'s top: give it useScreenKeyboardOffset() '
                + '(keyboardVerticalOffset + onScreenLayout on the screen root) and add it to SCREENS, or, if it always starts '
                + 'at the window\'s top, add it to EXEMPT with the reason').toBeTruthy();
            if (ex) {
                expect(exemptionFails(found, ex), `${found.file}: exempt as "${ex.kind}" (${ex.why}), but`).toBeNull();
                // An exemption covers the views it was written for, not a new one added beside them.
                const here = FOUND.filter((f) => f.file === ex.file && f.component === ex.component).length;
                expect(here, `${found.file} (${found.component}): keyboard views covered by its exemption`).toBe(ex.count);
            }
        });
    }

    it('no exemption or table row is stale: each still names a keyboard view', () => {
        for (const ex of EXEMPT) expect(FOUND.some((f) => f.file === ex.file && f.component === ex.component), `${ex.file} ${ex.component}`).toBe(true);
        for (const s of SCREENS) expect(FOUND.some((f) => f.file === s.file && f.component === s.component), `${s.file} ${s.component}`).toBe(true);
    });

    it('every caret-follow ScrollView (useKeepCaretVisible) sits inside one of those keyboard views', () => {
        const users = FILES.filter((f) => /\buseKeepCaretVisible\(/.test(fs.readFileSync(path.join(NATIVE, f), 'utf8')));
        expect(users.length, 'files that call useKeepCaretVisible').toBeGreaterThanOrEqual(4);
        for (const file of users) {
            const sf = parse(file);
            // `const { scrollProps: keepCaretVisible } = useKeepCaretVisible()` (or a whole object): the name spread on the view.
            const spreads: string[] = [];
            const visit = (n: ts.Node) => {
                if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)
                    && n.initializer.expression.getText() === 'useKeepCaretVisible') {
                    if (ts.isIdentifier(n.name)) spreads.push(`${n.name.text}.scrollProps`);
                    else if (ts.isObjectBindingPattern(n.name)) {
                        for (const el of n.name.elements) {
                            if ((el.propertyName ?? el.name).getText() === 'scrollProps') spreads.push(el.name.getText());
                        }
                    }
                }
                ts.forEachChild(n, visit);
            };
            visit(sf);
            expect(spreads.length, `${file}: where its scrollProps go`).toBeGreaterThan(0);
            const views = elements(sf, 'ScrollView').filter((v) => attrs(v).properties.some((p) => ts.isJsxSpreadAttribute(p) && spreads.includes(p.expression.getText())));
            expect(views.length, `${file}: the ScrollView that spreads ${spreads.join(', ')}`).toBeGreaterThan(0);
            for (const view of views) {
                const kav = jsxAncestors(view).find((a) => tagName(a) === 'KeyboardAvoidingView');
                expect(kav, `${file}: its caret-follow ScrollView is inside a KeyboardAvoidingView (its viewport is what that view leaves above the keyboard)`).toBeDefined();
                expect(FOUND.some((f) => f.file === file && f.kav.getStart() === kav!.getStart()), `${file}: that keyboard view is one the scan above checks`).toBe(true);
            }
        }
    });
});
