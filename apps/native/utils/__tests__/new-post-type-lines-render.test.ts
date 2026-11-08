// @vitest-environment jsdom
/**
 * Where a member picks what kind of post to make, the phone says plainly what each kind is (core post-type-lines.ts; Marty, 9 Nov:
 * "should it have been a need or an offer? and is it free? its confusing?"): the chooser behind every + (components/NewPostTypeSheet.tsx)
 * draws one short line under each choice, an Offer "Something you'll give or do for others" and a Need "Something you're looking
 * for", with the Poll and Event lines it already had, and the new-listing form's own toggle (app/new-listing.tsx) says the same two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sent = vi.hoisted(() => ({ identity: true, picked: [] as string[] }));
vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, testID, numberOfLines } = props;
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (numberOfLines) attrs['data-lines'] = String(numberOfLines);
        if (onPress) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {} }); };
        return createElement(tag, attrs, children);
    };
    return {
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        Pressable: el('button'), Text: el('span'), View: el('div'),
        StyleSheet: { create: (s: unknown) => s },
    };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return { useStyles: (make: (t: { theme: string; colors: unknown }) => unknown) => make({ theme: 'light', colors: lightColors }) };
});
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: sent.identity ? { publicKey: 'me', callsign: 'Ana', privateKey: 'p' } : null }) }));
vi.mock('../look-door', () => ({ openLookDoor: () => {} }));

import { pseudoLocalise, setLanguage } from '@beanpool/core';
import { NewPostTypeSheet } from '../../components/NewPostTypeSheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); sent.identity = true; sent.picked.length = 0; });
afterEach(() => { act(() => root.unmount()); host.remove(); setLanguage('en'); });

const show = async () => { await act(async () => { root.render(createElement(NewPostTypeSheet as any, { visible: true, onClose: () => {}, onSelect: (t: string) => { sent.picked.push(t); } }) as any); }); };
/** The choice rows: the buttons whose screen-reader label is "Title: line" (not the backdrop, the sheet itself or Cancel). */
const rows = () => Array.from(host.querySelectorAll('button')).filter((b) => b.getAttribute('aria-label')?.includes(': '));

describe('the + chooser: one short line under each choice', () => {
    it('Offer says what you give or do, Need says what you are looking for, and Poll and Event keep their lines', async () => {
        await show();
        expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
            "Offer: Something you'll give or do for others",
            "Need: Something you're looking for",
            'Community Poll: Ask a question with 2–4 options in the feed',
            'Event: A gathering with a time and a place',
        ]);
        expect(rows().map((r) => Array.from(r.querySelectorAll('span')).map((s) => s.textContent).filter((x) => x && x.length > 3))).toEqual([
            ['Offer', "Something you'll give or do for others"],
            ['Need', "Something you're looking for"],
            ['Community Poll', 'Ask a question with 2–4 options in the feed'],
            ['Event', 'A gathering with a time and a place'],
        ]);
    });

    it('a line wraps whole (no line limit), so at 320 dp with 1.3x text nothing is cut', async () => {
        await show();
        for (const line of Array.from(host.querySelectorAll('button span')).filter((s) => /^Something |^Ask a question|^A gathering/.test(s.textContent ?? ''))) {
            expect(line.getAttribute('data-lines'), line.textContent ?? '').toBeNull();
        }
    });

    it('every line comes through t(): in the pseudo-locale each is the pseudo-localised English', async () => {
        setLanguage('xx');
        await show();
        const text = host.textContent ?? '';
        for (const line of ["Something you'll give or do for others", "Something you're looking for", 'Ask a question with 2–4 options in the feed', 'A gathering with a time and a place']) {
            expect(text, line).toContain(pseudoLocalise(line));
        }
        expect(text).not.toContain("Something you'll give");
    });

    it('choosing a row still opens that kind', async () => {
        await show();
        await act(async () => { rows()[1].click(); });
        expect(sent.picked).toEqual(['need']);
    });

    it('a visitor with no account sees no rows: Join to post, as before', async () => {
        sent.identity = false;
        await show();
        expect(host.querySelector('[data-testid="new-post-join"]')).not.toBeNull();
        expect(host.textContent).not.toContain("Something you'll give");
    });
});

describe('the new-listing form: its Offer / Need toggle says the same two lines (source check: the form has no render harness)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/new-listing.tsx'), 'utf-8');
    const lines = src.split('\n');
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));

    it("each button's own line is core's, drawn inside the button, right under its title", () => {
        for (const kind of ['offer', 'need'] as const) {
            const title = at(kind === 'offer' ? "t('🟢 Offer')" : "t('🟠 Need')");
            const hint = at(`t(POST_TYPE_LINES.${kind})`);
            expect(title, kind).toBeGreaterThan(0);
            expect(hint, kind).toBe(title + 1);
            expect(lines[hint]).toContain(`testID="type-hint-${kind}"`);
            expect(lines[hint]).toContain('styles.typeBtnHint');
        }
    });

    it('the hint wraps (no numberOfLines) and takes its colour from the central tokens', () => {
        const hint = lines.find((l) => l.includes('typeBtnHint: {')) ?? '';
        expect(hint).toContain('colors.text.secondary');
        expect(hint).not.toContain('numberOfLines');
        expect(lines.filter((l) => l.includes('styles.typeBtnHint')).every((l) => !l.includes('numberOfLines'))).toBe(true);
    });
});
