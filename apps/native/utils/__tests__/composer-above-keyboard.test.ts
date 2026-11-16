/**
 * With the keyboard up, the text field and Send stay above it on every composer screen, with every optional bar shown
 * above the box, both as a full-screen screen and as an iPhone page sheet (Rob, iPhone, 17 Nov: a DM opened from a
 * listing had its "About: …" bar sitting on the keyboard and the message box under it).
 *
 * The cause: react-native-keyboard-controller's KeyboardAvoidingView pads by its frame in its parent less the keyboard's
 * top in the WINDOW. A listing (post/[id]) is a sheet, native-stack presents any route pushed after a sheet as a sheet too
 * (getModalRouteKeys), and a sheet starts ~50 pt down the window, so the padding came up short by that much and the box
 * (about as tall) went under the keyboard. Each screen now passes the screen's top in the window as keyboardVerticalOffset
 * (components/useScreenKeyboardOffset.ts, utils/screen-keyboard-offset.ts).
 *
 * One table: every composer screen × card or sheet × every optional bar it can show. Each row reads the screen's own
 * source for what it hands its KeyboardAvoidingView (none = 0, the hook = the measured offset) and whether the screen's
 * root feeds the hook's measure, puts the bars and the box inside the KeyboardAvoidingView (so the padding lifts them),
 * and then lays the column out with the library's own padding formula and checks where the box lands.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { keyboardViewPadding, screenKeyboardOffset } from '../screen-keyboard-offset';
import { dmKeyBannerMaxHeight } from '../dm-key-change';

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
];

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

function elements(root: ts.Node, tag: string): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
    const out: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
    const visit = (n: ts.Node) => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === tag) out.push(n);
        ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
}

function attr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | undefined {
    const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
    const a = attrs.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name) as ts.JsxAttribute | undefined;
    return a?.initializer?.getText();
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
    let measuredBy: ts.JsxElement | ts.JsxSelfClosingElement = kav;
    if (!screen.kavIsRoot) {
        let p: ts.Node | undefined = kav.parent;
        while (p && !tagName(p)) p = p.parent;
        measuredBy = p as ts.JsxElement;
    }
    const measured = !!hook && attr(measuredBy, 'onLayout') === `{${hook}.onScreenLayout}`;
    const inside = (tag: string) => elements(kav, tag).length > 0;
    const outside = (tag: string) => elements(component, tag).length - elements(kav, tag).length;
    return { passesMeasuredOffset, measured, offsetAttr, inside, outside, measuredByTag: tagName(measuredBy) };
}

// A 390 × 844 iPhone (Rob's), a 320 × 568 small one; the keyboard with its QuickType strip; the page sheet's top
// (status bar + 10), and the status bar a full-screen screen's SafeAreaView starts under. Heights in points; the bars as
// drawn at 1.3× text.
const PHONES = [
    { name: '390 × 844', window: 844, keyboard: 336, sheetTop: 57, statusBar: 47 },
    { name: '320 × 568', window: 568, keyboard: 253, sheetTop: 30, statusBar: 20 },
];
const HEADER = 64;
const BAR = 52;
const COMPOSER = 58;

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
                    const barSets = [[], ...screen.bars.map((b) => [b]), ...(screen.bars.length > 1 ? [screen.bars] : [])];
                    for (const bars of barSets) {
                        it(`${phone.name}, ${presentation}, bars: ${bars.join(' + ') || 'none'}: the text field and Send are above the keyboard`, () => {
                            const screenTop = presentation === 'sheet' ? phone.sheetTop : 0;
                            const screenHeight = phone.window - screenTop;
                            // What the screen hands the view on an iPhone: the hook's offset when it is wired, else nothing.
                            const offset = w.passesMeasuredOffset && w.measured
                                ? screenKeyboardOffset({ os: 'ios', windowHeight: phone.window, screenHeight })
                                : 0;
                            // The KeyboardAvoidingView's frame in its parent: under the header to the screen's bottom (the root
                            // view when it is the screen itself).
                            const frameY = screen.kavIsRoot ? 0 : HEADER;
                            const frameHeight = screenHeight - frameY;
                            const padding = keyboardViewPadding({ frameY, frameHeight, windowHeight: phone.window, keyboardHeight: phone.keyboard, keyboardVerticalOffset: offset });
                            // The column packs to its bottom: the box sits on the padding, the bars on the box.
                            const composerBottom = screenTop + frameY + frameHeight - padding;
                            const composerTop = composerBottom - COMPOSER;
                            const barsTop = composerTop - BAR * bars.length;
                            const keyboardTop = phone.window - phone.keyboard;
                            expect(composerBottom, 'the box ends above the keyboard').toBeLessThanOrEqual(keyboardTop);
                            // Not lifted too far either: no gap between the box and the keyboard.
                            expect(composerBottom, 'the box sits on the keyboard').toBe(keyboardTop);
                            expect(barsTop, 'the bars and the box fit under the header').toBeGreaterThanOrEqual(screenTop + (screen.kavIsRoot ? HEADER : frameY));
                        });
                    }
                }
            }
        });
    }

    // The DM since #3278: under the header its column holds the key card's page (components/chat/DmKeyChangedPane: the
    // card, then the deals strip, the listing's header and the release bar) and then the KeyboardAvoidingView (the thread,
    // the box measured whole), held by dm-key-pane-fit-render.test.ts's source check. So the view's frame in its parent
    // starts under the page, not under the header, and the page's room is dmKeyBannerMaxHeight: the column (the header's
    // bottom to the view's bottom, both read in the screen's own frame, so a sheet's top is not in it) less the box and a
    // keyboard still up. The two meet here: with the sheet's offset the view pads by the keyboard exactly, the very
    // keyboard the room takes off, so the box sits on the keyboard and the page fills the rest. No double lift (the
    // padding is never the keyboard plus the sheet's top) and no cut box (the view always holds the box under the page).
    describe('app/chat/[id].tsx with the key card\'s page above the keyboard view: the box on the keyboard and the card\'s room, card or sheet', () => {
        const dm = wiring(SCREENS[0]);
        // The page's content: nothing; one bar; the card with its bars, which fits a tall phone; a page taller than any room.
        const PAGES = [0, BAR, 360, 2000];
        // The box measured whole: the composer alone, and with the About bar over it.
        const BOXES = [COMPOSER, COMPOSER + BAR];
        for (const phone of PHONES) {
            for (const presentation of ['card', 'sheet'] as const) {
                // A full-screen screen starts under the status bar inside the SafeAreaView; a sheet starts below it.
                const safeTop = presentation === 'card' ? phone.statusBar : 0;
                for (const kb of [0, phone.keyboard]) {
                    for (const content of PAGES) {
                        for (const box of BOXES) {
                            it(`${phone.name}, ${presentation}, keyboard ${kb ? 'up' : 'down'}, page ${content}, box ${box}: the box sits on the keyboard, the page has the rest`, () => {
                                expect(dm.passesMeasuredOffset && dm.measured).toBe(true);
                                const screenTop = presentation === 'sheet' ? phone.sheetTop : 0;
                                const screenHeight = phone.window - screenTop;
                                const offset = screenKeyboardOffset({ os: 'ios', windowHeight: phone.window, screenHeight });
                                const headerBottom = safeTop + HEADER;
                                const column = screenHeight - headerBottom;
                                const room = dmKeyBannerMaxHeight({ column, composer: box, windowHeight: phone.window, keyboard: kb });
                                const page = Math.min(content, room);
                                const frameY = headerBottom + page;
                                const frameHeight = screenHeight - frameY;
                                const padding = keyboardViewPadding({ frameY, frameHeight, windowHeight: phone.window, keyboardHeight: kb, keyboardVerticalOffset: offset });
                                // The view pads by the keyboard, no more and no less, wherever the page ends.
                                expect(padding, 'the padding is the keyboard').toBe(kb);
                                const boxBottom = screenTop + frameY + frameHeight - padding;
                                expect(boxBottom, 'the box sits on the keyboard (the window\'s bottom with none)').toBe(phone.window - kb);
                                // The view holds the whole box under the page: the thread has what is left, never less than nothing.
                                const thread = frameHeight - padding - box;
                                expect(thread, 'the box is never cut').toBeGreaterThanOrEqual(0);
                                if (content > room) {
                                    // A page taller than its room fills it down to the box: the thread gives way, no strip of it left.
                                    expect(page).toBe(room);
                                    expect(thread).toBe(0);
                                    expect(screenTop + headerBottom + page, 'the page\'s cut edge is the box\'s top').toBe(boxBottom - box);
                                } else {
                                    expect(thread).toBe(room - content);
                                }
                                // Without the sheet's offset the view came up short by the sheet's top, and the room's keyboard
                                // and the padding's no longer agreed: the box went under the keyboard (Rob, 17 Nov).
                                if (presentation === 'sheet' && kb > 0) {
                                    const short = keyboardViewPadding({ frameY, frameHeight, windowHeight: phone.window, keyboardHeight: kb, keyboardVerticalOffset: 0 });
                                    expect(kb - short).toBe(phone.sheetTop);
                                }
                            });
                        }
                    }
                }
            }
        }
    });

    it('the offset is the sheet top on an iPhone, 0 when the screen fills the window, and 0 on Android', () => {
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 787 })).toBe(57);
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 844 })).toBe(0);
        expect(screenKeyboardOffset({ os: 'ios', windowHeight: 844, screenHeight: 0 })).toBe(0);
        expect(screenKeyboardOffset({ os: 'android', windowHeight: 844, screenHeight: 787 })).toBe(0);
    });
});
