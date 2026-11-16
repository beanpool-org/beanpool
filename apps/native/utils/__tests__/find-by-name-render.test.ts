// @vitest-environment jsdom
/**
 * Find by exact name on the phone (slice N1: components/FindByName.tsx, on app/address-card.tsx), rendered for real at the
 * floor's window (320 x 569 dp, text at 1.3x), in light and dark: react-dom in jsdom, React Native's host components as plain
 * tags carrying their props and styles, as address-fallback-card-render.test.ts does. The look-up and the switch are stood in
 * for (the server's half is apps/server/src/test-find-by-name.ts).
 *
 * Checked: the switch is off until turned on, in core's words; on asks the community and opens this phone's door; the step
 * asks only once both fields are typed, with what was typed trimmed; "nobody" is core's one sentence and hands nothing on; a
 * card is handed to the screen; a refusal reads in core's words by its code; nothing is fixed-width or cut to a line count,
 * and every target is at least 44 dp tall, so the step wraps rather than running off a 320 dp screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const flat = (s: unknown): Record<string, unknown> => Object.assign({}, ...[s].flat(3).filter(Boolean));
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, testID, numberOfLines, disabled, style, value, onChangeText, onValueChange } = props;
        const attrs: Record<string, unknown> = { 'data-style': JSON.stringify(flat(style)) };
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole) attrs['data-role'] = accessibilityRole;
        if (testID) attrs['data-testid'] = testID;
        if (numberOfLines) attrs['data-lines'] = numberOfLines;
        if (disabled) attrs['aria-disabled'] = 'true';
        if (tag === 'input' && onChangeText) { attrs.value = value; attrs.onChange = (e: any) => onChangeText(e.target.value); }
        if (tag === 'switch') return createElement('input', { ...attrs, type: 'checkbox', checked: !!value, onChange: (e: any) => onValueChange(e.target.checked) });
        return createElement(tag, attrs, children);
    };
    return {
        Platform: { OS: 'android' },
        View: el('div'), Text: el('span'), Pressable: el('button'), TextInput: el('input'), Switch: el('switch'),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const here = vi.hoisted(() => ({
    findable: false,
    found: null as any,
    refuse: null as null | string,
    setFindMe: [] as boolean[],
    asked: [] as Array<[string, string]>,
    doors: [] as boolean[],
}));
vi.mock('../outside-mail', () => {
    class OutsideMailError extends Error {
        constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
    }
    return {
        OutsideMailError,
        findMeOn: vi.fn(async () => here.findable),
        setFindMe: vi.fn(async (_ctx: unknown, on: boolean) => { here.setFindMe.push(on); here.findable = on; return on; }),
        setDoor: vi.fn(async (_store: unknown, open: boolean) => { here.doors.push(open); }),
        findByName: vi.fn(async (_ctx: unknown, home: string, name: string) => {
            here.asked.push([home, name]);
            if (here.refuse) throw new OutsideMailError(429, 'words from the server', here.refuse);
            return here.found;
        }),
    };
});
vi.mock('../outside-chat-live', () => ({
    outsideContext: vi.fn(async () => ({ nodeUrl: 'https://b.example', identity: { publicKey: 'b'.repeat(64) }, store: {}, isBlocked: async () => false })),
    outsideErrorWords: (e: unknown) => (e instanceof Error ? e.message : 'error'),
}));

import { FIND_DAY_USED, FIND_ME_HELP, FIND_ME_SWITCH, FIND_NOBODY } from '@beanpool/core';
import { FindByNameStep, FindMeSwitch } from '../../components/FindByName';
import { lightColors, darkColors, type AppColors } from '../../constants/colors';

const roots: Root[] = [];
async function render(node: any): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => { root.render(node); });
    await act(async () => {});
    return host;
}
const byId = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const type = async (host: HTMLElement, id: string, value: string) => {
    const input = byId(host, id) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const press = async (host: HTMLElement, id: string) => { await act(async () => { byId(host, id).click(); }); await act(async () => {}); };

beforeEach(() => {
    here.findable = false;
    here.found = null;
    here.refuse = null;
    here.setFindMe = [];
    here.asked = [];
    here.doors = [];
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => { r.unmount(); });
    document.body.innerHTML = '';
});

describe('the switch (FindMeSwitch)', () => {
    it("off until turned on, in core's words; on asks the community and opens this phone's door; off again", async () => {
        const opened = vi.fn();
        const host = await render(createElement(FindMeSwitch, { colors: lightColors, onDoorOpened: opened }));
        const sw = byId(host, 'find-me-switch') as HTMLInputElement;
        expect(sw.checked).toBe(false);
        expect(host.textContent).toContain(FIND_ME_SWITCH);
        expect(host.textContent).toContain(FIND_ME_HELP);
        await press(host, 'find-me-switch');
        expect((byId(host, 'find-me-switch') as HTMLInputElement).checked).toBe(true);
        expect(here.setFindMe).toEqual([true]);
        expect(here.doors).toEqual([true]);
        expect(opened).toHaveBeenCalledTimes(1);
        await press(host, 'find-me-switch');
        expect((byId(host, 'find-me-switch') as HTMLInputElement).checked).toBe(false);
        expect(here.setFindMe).toEqual([true, false]);
        expect(here.doors).toEqual([true]);
    });
});

describe('the look-up (FindByNameStep)', () => {
    it('asks only once both are typed, trimmed; nobody is the one sentence and hands nothing on', async () => {
        const onCard = vi.fn();
        const host = await render(createElement(FindByNameStep, { colors: lightColors, onCard }));
        expect(byId(host, 'find-them').getAttribute('aria-disabled')).toBe('true');
        await type(host, 'find-home', ' riverside.example ');
        expect(byId(host, 'find-them').getAttribute('aria-disabled')).toBe('true');
        await type(host, 'find-name', '  Wren Tallowmere ');
        await press(host, 'find-them');
        expect(here.asked).toEqual([['riverside.example', 'Wren Tallowmere']]);
        expect(byId(host, 'find-note').textContent).toBe(FIND_NOBODY);
        expect(onCard).not.toHaveBeenCalled();
    });

    it('a card is handed to the screen, with no note', async () => {
        here.found = { v: 1, key: 'c'.repeat(64), home: 'riverside.example', name: 'Wren Tallowmere', sig: 'x' };
        const onCard = vi.fn();
        const host = await render(createElement(FindByNameStep, { colors: lightColors, onCard }));
        await type(host, 'find-home', 'riverside.example');
        await type(host, 'find-name', 'wren tallowmere');
        await press(host, 'find-them');
        expect(onCard).toHaveBeenCalledWith(here.found);
        expect(byId(host, 'find-note')).toBeNull();
    });

    it("a refusal reads in core's words by its code, never the server's English", async () => {
        here.refuse = 'find_day_used';
        const host = await render(createElement(FindByNameStep, { colors: lightColors, onCard: vi.fn() }));
        await type(host, 'find-home', 'riverside.example');
        await type(host, 'find-name', 'Wren Tallowmere');
        await press(host, 'find-them');
        expect(byId(host, 'find-note').textContent).toBe(FIND_DAY_USED);
        expect(host.textContent).not.toContain('words from the server');
    });
});

describe('320 dp, text at 1.3x, light and dark', () => {
    for (const [theme, colors] of [['light', lightColors], ['dark', darkColors]] as Array<[string, AppColors]>) {
        it(`${theme}: nothing fixed-width or cut to a line count; every target at least 44 dp; words in the theme's text colours`, async () => {
            here.findable = true;
            here.refuse = 'not_reached';
            const host = await render(createElement('div', null,
                createElement(FindMeSwitch, { colors }), createElement(FindByNameStep, { colors, onCard: vi.fn() })));
            await type(host, 'find-home', 'riverside.example');
            await type(host, 'find-name', 'Wren Tallowmere');
            await press(host, 'find-them');
            for (const node of Array.from(host.querySelectorAll('[data-style]'))) {
                const style = JSON.parse(node.getAttribute('data-style')!);
                expect(style.width, node.outerHTML.slice(0, 80)).toBeUndefined();
                expect(style.height, node.outerHTML.slice(0, 80)).toBeUndefined();
                expect(node.getAttribute('data-lines')).toBeNull();
            }
            for (const id of ['find-home', 'find-name', 'find-them']) expect(JSON.parse(byId(host, id).getAttribute('data-style')!).minHeight).toBeGreaterThanOrEqual(44);
            const words = [colors.text.body, colors.text.secondary, colors.feedback.warning.fg];
            for (const span of Array.from(host.querySelectorAll('span'))) expect(words).toContain(JSON.parse(span.getAttribute('data-style')!).color);
        });
    }
});
