/**
 * Every chat keeps the keyboard off its composer (1.2.61 regression, 16 Oct).
 *
 * react-native-keyboard-controller's KeyboardAvoidingView pads by its frame IN ITS PARENT: y + height − the keyboard's
 * top. That is only right when the parent starts at the top of the screen, so the view must be the screen's root (group,
 * event) or a direct child of it (the DM, under its SafeAreaView). #1872 wrapped the DM's view in a measuring View that
 * started under the header; the padding came up short by the header and the keyboard covered the message box.
 *
 * Also checked: one KeyboardAvoidingView per chat, behavior "padding", imported from keyboard-controller (RN's does
 * nothing under edge-to-edge), and every chat sets the soft-input mode itself (useChatSoftInputMode), so the view is the
 * only thing that moves the composer (memory keyboard-avoidance-pattern).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const NATIVE = path.join(__dirname, '..', '..');

const CHATS: { file: string; component: string; parent: string | null }[] = [
    // The DM: its KeyboardAvoidingView sits straight under the screen's SafeAreaView, below the header and banners.
    { file: 'app/chat/[id].tsx', component: 'ChatScreen', parent: 'SafeAreaView' },
    // Groups and enterprises: the KeyboardAvoidingView is the screen.
    { file: 'components/GroupChatView.tsx', component: 'GroupChatView', parent: null },
    // Event chats: the same.
    { file: 'components/EventChatView.tsx', component: 'EventChatView', parent: null },
];

function parse(file: string): ts.SourceFile {
    return ts.createSourceFile(file, fs.readFileSync(path.join(NATIVE, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function tagName(node: ts.Node): string | null {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
    if (ts.isJsxFragment(node)) return '<>';
    return null;
}

function findComponent(sf: ts.SourceFile, name: string): ts.Node {
    let found: ts.Node | undefined;
    const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
        else ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) throw new Error(`${name} not found in ${sf.fileName}`);
    return found;
}

/** Every KeyboardAvoidingView in the component, with the nearest enclosing JSX element (null when it is the root). */
function keyboardViews(component: ts.Node): { node: ts.JsxElement | ts.JsxSelfClosingElement; parent: string | null }[] {
    const out: { node: ts.JsxElement | ts.JsxSelfClosingElement; parent: string | null }[] = [];
    const visit = (n: ts.Node) => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === 'KeyboardAvoidingView') {
            let p: ts.Node | undefined = n.parent;
            while (p && !tagName(p) && !ts.isFunctionLike(p)) p = p.parent;
            out.push({ node: n, parent: p && tagName(p) ? tagName(p) : null });
        }
        ts.forEachChild(n, visit);
    };
    visit(component);
    return out;
}

function attr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | undefined {
    const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
    const a = attrs.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name) as ts.JsxAttribute | undefined;
    return a?.initializer?.getText();
}

describe('chat keyboard: the composer stays above the keyboard in every chat', () => {
    for (const chat of CHATS) {
        describe(chat.file, () => {
            const sf = parse(chat.file);
            const component = findComponent(sf, chat.component);

            it('has exactly one KeyboardAvoidingView, behavior padding, from react-native-keyboard-controller', () => {
                const views = keyboardViews(component);
                expect(views).toHaveLength(1);
                expect(attr(views[0].node, 'behavior')).toBe('"padding"');
                expect(sf.text).toMatch(/import\s*\{[^}]*\bKeyboardAvoidingView\b[^}]*\}\s*from\s*'react-native-keyboard-controller'/);
            });

            it(chat.parent ? `its KeyboardAvoidingView is a direct child of the screen's ${chat.parent}, not a wrapper` : 'its KeyboardAvoidingView is the screen itself', () => {
                // The library pads by y + height in the parent's frame: a wrapper that starts under the header shortens
                // the padding by the header's height (the 1.2.61 DM regression).
                expect(keyboardViews(component)[0].parent).toBe(chat.parent);
            });

            it('sets the soft-input mode on mount (useChatSoftInputMode)', () => {
                expect(component.getText()).toMatch(/\buseChatSoftInputMode\(\)/);
            });
        });
    }
});
