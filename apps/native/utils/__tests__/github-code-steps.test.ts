/**
 * What a member is told while GitHub's code is on screen: the Account Protection sheet (components/SsoEnrolSheet.tsx)
 * and the GitHub recovery screen (app/welcome.tsx) both draw components/GithubCodeSteps.tsx at the top of the panel.
 *
 * 1. Press and hold the first box, then Paste: the long-standing trap (the clipboard chip fills one box).
 * 2. On Android, tap ✕ to come back once GitHub says you're all set. BeanPool cannot close the tab, and its wait
 *    for GitHub does not run while the tab is in front (sso-signin.ts waitForPoll), so without this line the
 *    member sat on "Congratulations, you're all set!" not knowing to leave. iOS closes the page itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
// Host components as plain tags, so the tree can be walked without a device (vitest.config.ts).
vi.mock('react-native', () => ({
    Platform: platform,
    StyleSheet: { create: <T,>(s: T) => s },
    View: 'View',
    Text: 'Text',
}));

import { GithubCodeSteps, githubCodeStepsStyles } from '../../components/GithubCodeSteps';
import { GITHUB_CODE_STEPS, githubComeBackStep } from '../github-code-copy';

type Host = { type: string; props: Record<string, unknown>; children: Node[] };
type Node = Host | string;

function render(node: unknown): Node[] {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(render);
    const el = node as React.ReactElement<Record<string, unknown>>;
    if (el.type === React.Fragment) return render(el.props.children);
    if (typeof el.type === 'function') return render((el.type as (p: unknown) => unknown)(el.props));
    return [{ type: el.type as string, props: el.props, children: render(el.props.children) }];
}

/** Everything a member reads, one outermost Text per line. */
function textOf(nodes: Node[]): string {
    const lines: string[] = [];
    const walk = (n: Node, inText: boolean): string => {
        if (typeof n === 'string') return n;
        const inner = n.children.map(c => walk(c, inText || n.type === 'Text')).join('');
        if (n.type === 'Text' && !inText) { lines.push(inner); return ''; }
        return inner;
    };
    nodes.forEach(n => walk(n, false));
    return lines.join('\n');
}

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

beforeEach(() => { platform.OS = 'android'; });

describe('the steps', () => {
    it('Android: Paste first, then tap ✕ to come back', () => {
        expect(textOf(render(React.createElement(GithubCodeSteps)))).toBe([
            '1. On GitHub, press and hold the first box, then choose Paste.',
            'Tapping the clipboard chip above the keyboard fills only one box. Typing the 8 characters works too.',
            "2. When GitHub says you're all set, tap ✕ at the top left to come back.",
        ].join('\n'));
    });

    it('iOS: the page closes itself, so it says that instead of ✕', () => {
        platform.OS = 'ios';
        const text = textOf(render(React.createElement(GithubCodeSteps)));
        expect(text.split('\n')[0]).toBe(`1. ${GITHUB_CODE_STEPS.paste}`);
        expect(text).toContain("2. When GitHub says you're all set, BeanPool comes back by itself.");
        expect(text).not.toContain('✕');
        expect(githubComeBackStep('ios')).toBe(GITHUB_CODE_STEPS.comeBackIos);
        expect(githubComeBackStep('android')).toBe(GITHUB_CODE_STEPS.comeBackAndroid);
    });

    it('is prominent and wraps at 320dp + 1.3× text: nothing fixed-size, the steps bold and no smaller than the body', () => {
        for (const style of Object.values(githubCodeStepsStyles) as Array<Record<string, unknown>>) {
            for (const key of ['width', 'height', 'maxHeight']) expect(style[key]).toBeUndefined();
            expect(style.numberOfLines).toBeUndefined();
        }
        expect(githubCodeStepsStyles.step.fontWeight).toBe('700');
        expect(githubCodeStepsStyles.step.fontSize).toBeGreaterThanOrEqual(15);
        expect(githubCodeStepsStyles.box.borderWidth).toBeGreaterThanOrEqual(1);
    });
});

// The screens cannot be rendered here (vitest.config.ts): these check they draw the steps, first.
describe.each([
    ['the Account Protection sheet', '../../components/SsoEnrolSheet.tsx'],
    ['the GitHub recovery screen', '../../app/welcome.tsx'],
])('%s', (_name, file) => {
    it('draws the steps at the top of the code panel, above the code', () => {
        const src = read(file);
        const steps = src.indexOf('<GithubCodeSteps');
        expect(steps).toBeGreaterThan(-1);
        expect(src.indexOf('Enter this code at', steps)).toBeGreaterThan(steps);
        expect(src.slice(0, steps)).not.toContain('Enter this code at');
    });

    it('no longer says the tab closes itself, which it does not on Android, or repeats the Paste line', () => {
        const src = read(file);
        expect(src).not.toMatch(/closes itself/);
        expect(src).not.toMatch(/press and hold the first box/i);
    });
});

describe('the GitHub recovery screen', () => {
    it('on Android shows the code and the steps first, and the member opens GitHub, as the sheet does; iOS is unchanged', () => {
        const src = read('../../app/welcome.tsx');
        const onDeviceCode = src.slice(src.indexOf('onDeviceCode: (prompt) => {'), src.indexOf('signal: abort.signal,'));
        expect(onDeviceCode).toContain('setRecoveryCode(prompt);');
        expect(onDeviceCode.match(/openBrowserAsync/g)).toHaveLength(1);
        expect(onDeviceCode).toContain("if (Platform.OS === 'ios') WebBrowser.openBrowserAsync(prompt.verificationUri)");
    });
});
