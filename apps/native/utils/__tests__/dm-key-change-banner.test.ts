// @vitest-environment jsdom
/**
 * P10 and P12 of DESIGN-dm-peer-key-pin, on the screen: the DM screen's "key changed" banner
 * (components/chat/DmKeyChangedBanner.tsx) and Settings → "My key code" (components/MyKeyCodeCard.tsx), rendered for real
 * with react-dom in jsdom and React Native's host components as plain tags (as group-chat-refused-render.test.ts does),
 * in light and in dark; and their styles (utils/dm-key-change.ts) held to 320 dp at 1.3× text: no fixed width or
 * height, buttons stacked, touch targets 48 dp, text at 4.5:1 on its background.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { randomBytes } from 'node:crypto';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const roles: Record<string, string> = { header: 'heading', button: 'button', alert: 'alert', checkbox: 'checkbox' };
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = () => onPress();
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityRole && roles[accessibilityRole]) attrs.role = roles[accessibilityRole];
        if (accessibilityState?.checked !== undefined) attrs['aria-checked'] = String(!!accessibilityState.checked);
        if (accessibilityState?.disabled !== undefined || disabled !== undefined) attrs['aria-disabled'] = String(!!(accessibilityState?.disabled ?? disabled));
        return createElement(tag, attrs, children);
    };
    return {
        View: el('div'), Text: el('span'), Pressable: el('button'),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
    };
});
const theme = vi.hoisted(() => ({ colors: null as any }));
vi.mock('../../app/ThemeContext', () => ({
    useTheme: () => ({ colors: theme.colors }),
    useStyles: (make: (c: { colors: unknown }) => unknown) => make({ colors: theme.colors }),
}));
vi.mock('../db', () => ({}));

import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedBanner } from '../../components/chat/DmKeyChangedBanner';
import { MyKeyCodeCard } from '../../components/MyKeyCodeCard';
import { dmKeyChangeStyleSpec, DM_KEY_CHANGE_TEXT_ON, DM_KEY_CHANGE_TOUCH_TARGETS, dmKeyChangeCopy, rekeyedOnText, DM_FIRST_SIGHT_LEAD } from '../dm-key-change';
import { keyCodeOf } from '../key-code';

const CODE = /^\d{4} \d{4} \d{4} \d{4} \d{4}$/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = (node: unknown) => act(() => { root.render(node as Parameters<Root["render"]>[0]); });
const button = (name: string) => host.querySelector(`[role="button"][aria-label="${name}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement)?.click(); }); };

function luminance(hex: string): number {
    const m = hex.replace('#', '');
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

describe.each([['light', lightColors], ['dark', darkColors]] as const)('the key-changed banner and My key code in %s (320 dp at 1.3× text)', (_name, colors) => {
    beforeEach(() => { theme.colors = colors; });
    const newKey = randomBytes(32).toString('hex');

    it('says what changed in plain words, with the new key\'s code in five groups of four', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        const text = host.textContent!;
        expect(text).toContain('The key behind "Ben" changed.');
        expect(text).toContain('Anything you send now would go to the new key. If Ben got a new phone and re-keyed, check with them first');
        const code = host.querySelector('[aria-label^="Key code "]')!.textContent!;
        expect(code).toMatch(CODE);
        expect(code).toBe(keyCodeOf(newKey));
        expect(text).not.toContain('This community says');   // no date unless the node gives one (slice 3)
    });

    it('P12: "Continue with the new key" does nothing until Ana ticks that she checked the code with Ben; "Not now" only goes back', async () => {
        const onContinue = vi.fn();
        const onNotNow = vi.fn();
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue, onNotNow }));
        const go = button('Continue with the new key')!;
        expect(go.getAttribute('aria-disabled')).toBe('true');
        await click(go);
        expect(onContinue).not.toHaveBeenCalled();

        await click(button('Not now'));
        expect(onNotNow).toHaveBeenCalledTimes(1);
        expect(onContinue).not.toHaveBeenCalled();

        const tick = host.querySelector('[role="checkbox"]')!;
        expect(tick.getAttribute('aria-label')).toBe('I checked with Ben: the key code in their Settings matches this one.');
        await click(tick);
        expect(tick.getAttribute('aria-checked')).toBe('true');
        expect(button('Continue with the new key')!.getAttribute('aria-disabled')).toBe('false');
        await click(button('Continue with the new key'));
        expect(onContinue).toHaveBeenCalledWith(newKey);   // exactly the key whose code was shown
    });

    it('several keys listed: no code, no tick, no Continue; only "Not now"', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: null, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.querySelector('[aria-label^="Key code "]')).toBeNull();
        expect(host.querySelector('[role="checkbox"]')).toBeNull();
        expect(button('Continue with the new key')).toBeNull();
        expect(button('Not now')).not.toBeNull();
        expect(host.textContent).toContain('there is no one key to continue with');
    });

    it('the node\'s re-key date is a line of words only when it gives one; the first-sight case opens with the amendment\'s sentence, true after a restore or an update', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: true, rekeyedAt: '2026-10-03T09:00:00.000Z' }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).toContain('This community says the account was re-keyed on 3 Oct 2026.');
        expect(host.textContent).toContain(`${DM_FIRST_SIGHT_LEAD} The earlier messages here came from a different key than the one this community now gives for Ben.`);
        expect(DM_FIRST_SIGHT_LEAD).toBe('This phone is checking this chat from the start, as it does after you restore it or update the app.');
        expect(rekeyedOnText('not a date')).toBeNull();
    });

    it('a change after a sync (not first sight) never says the phone is checking from the start', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).not.toContain(DM_FIRST_SIGHT_LEAD);
        expect(host.textContent).not.toContain('This community says');
    });

    it('Settings → My key code shows the same code Ben\'s banner shows on Ana\'s phone', () => {
        render(createElement(MyKeyCodeCard, { publicKey: newKey }));
        expect(host.textContent).toContain('My key code');
        expect(host.querySelector('[aria-label^="My key code "]')!.textContent).toBe(keyCodeOf(newKey));
        render(createElement(MyKeyCodeCard, { publicKey: null }));
        expect(host.textContent).toContain('Your key code shows here once this phone has your key.');
    });

    const spec = dmKeyChangeStyleSpec(colors as typeof lightColors) as unknown as Record<string, Record<string, unknown>>;

    it('P10: nothing has a fixed width or height, and no text is cut to a number of lines', () => {
        for (const [k, v] of Object.entries(spec)) {
            for (const prop of ['width', 'height', 'maxHeight', 'maxWidth', 'numberOfLines']) expect(v[prop], `${k}.${prop}`).toBeUndefined();
        }
    });
    it('P10: the buttons are stacked, every touch target is at least 48 dp tall', () => {
        expect(spec.buttons.flexDirection).toBe('column');
        for (const k of DM_KEY_CHANGE_TOUCH_TARGETS) expect(Number(spec[k].minHeight), k).toBeGreaterThanOrEqual(48);
    });
    it('P10: the code fits at 320 dp with 1.3× text, as one line or wrapping between whole groups', () => {
        // 18 sp × 1.3 ≈ 23.4 dp per digit at most (tabular, bold): one group of four plus its letter spacing.
        const room = 320 - 2 * Number(spec.banner.marginHorizontal) - 2 * Number(spec.banner.padding) - 2 * Number(spec.codeBox.paddingHorizontal) - 2;
        const group = 4 * (Number(spec.code.fontSize) * 1.3 * 0.62 + Number(spec.code.letterSpacing));
        expect(group).toBeLessThan(room);
        expect(keyCodeOf('ab'.repeat(32))!.split(' ')).toHaveLength(5);   // spaces between groups: the only places it wraps
    });
    it('text is readable on its background (WCAG AA, 4.5:1)', () => {
        for (const [text, bg] of Object.entries(DM_KEY_CHANGE_TEXT_ON)) {
            const fg = String(spec[text].color);
            const back = String((spec[bg] as Record<string, unknown>).backgroundColor);
            expect(fg.startsWith('#') && back.startsWith('#'), `${text} on ${bg}: ${fg} / ${back}`).toBe(true);
            expect(contrast(fg, back), `${text} (${fg}) on ${bg} (${back})`).toBeGreaterThanOrEqual(4.5);
        }
    });
});

describe('the banner\'s words', () => {
    it('with no name for the key (the directory has none), say "this person": never the conversation id (#1873 review, finding 2)', () => {
        for (const peerName of [null, undefined, '', '  ']) {
            const copy = dmKeyChangeCopy({ peerName, code: '1111 2222 3333 4444 5555', firstSight: false });
            expect(copy.title).toBe('The key behind "this person" changed.');
            expect(copy.confirm).toBe('I checked with this person: the key code in their Settings matches this one.');
        }
    });
    it('never name the node\'s "Loading..." placeholder', () => {
        expect(dmKeyChangeCopy({ peerName: 'Loading...', code: '1111 2222 3333 4444 5555', firstSight: false }).title).toBe('The key behind "this person" changed.');
    });
});

// #1873 review: the DM screen keys the banner on the offered key, so a tick given for one code never carries over to a
// new one (mutant M14 survived every test). A source pin on [id].tsx, and the behaviour of that keying.
describe('the banner on the DM screen is keyed on the offered key', () => {
    beforeEach(() => { theme.colors = lightColors; });
    it('[id].tsx renders it with key={keyChange.offeredPeer ?? \'none\'}', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(src).toMatch(/<DmKeyChangedBanner\s+key=\{keyChange\.offeredPeer \?\? 'none'\}/);
    });
    it('a ticked banner whose offered key changes comes back unticked, and Continue does nothing until ticked again', async () => {
        const k2 = randomBytes(32).toString('hex');
        const other = randomBytes(32).toString('hex');
        const onContinue = vi.fn();
        const show = (offeredPeer: string) => render(createElement(DmKeyChangedBanner, { key: offeredPeer, peerName: 'Ben', change: { offeredPeer, firstSight: false }, onContinue, onNotNow: vi.fn() }));
        show(k2);
        await click(host.querySelector('[role="checkbox"]'));
        show(other);
        expect(host.querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('false');
        await click(button('Continue with the new key'));
        expect(onContinue).not.toHaveBeenCalled();
    });
});

// Slice 1's handover (d) and the #1873 review's findings 2 and 3, on the DM screen (a source pin: the screen itself
// needs a device). Rule 5 is asked only after the key change, whose check judges first sight first.
describe('the DM screen: the rule-5 line, the banner\'s name and its height', () => {
    it('[id].tsx asks isDmUnplaced only when no key change is waiting, disables the box with DM_UNPLACED_LINE and offers no Continue for it', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(src).toMatch(/getDmKeyChange\(id as string\)\.then\(async \(change\) => \{\s*setKeyChange\(change\);\s*setUnplaced\(change \? false : await isDmUnplaced\(id as string\)\);/);
        expect(src).toMatch(/disabled=\{keyChangePending \|\| unplaced\}/);
        expect(src).toMatch(/notice=\{keyChangePending \? dmKeyChangedLine\(keyChange\?\.name\) : unplaced \? DM_UNPLACED_LINE : lockNotice\}/);
        expect(src).toMatch(/const canSendNow = \(\) => [^;]*!unplaced/);
        // The banner is named from the key's member row (getDmKeyChange), never the screen's id-fragment fallback.
        expect(src).toMatch(/peerName=\{keyChange\.name\}/);
        // At most 55% of the window at 320 dp and 1.3× text: the thread and the paused box keep the rest.
        expect(src).toMatch(/maxHeight: Math\.round\(windowHeight \* 0\.55\)/);
    });
    it('[id].tsx draws a line from the offered key as the fixed line in the middle of the chat, never its words (#1872 handover 2)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { dmLineSlotText, DM_OFFERED_KEY_LINE } = await import('../dm-lock');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(src).toMatch(/if \(item\.unattributed \|\| item\.fromOfferedKey\) return renderUnattributedLine\(item\);/);
        const slot = src.slice(src.indexOf('const renderUnattributedLine'), src.indexOf('const renderMessage'));
        expect(slot).toMatch(/\{dmLineSlotText\(item\)\}/);
        expect(slot).not.toMatch(/\{item\.text\}/);
        expect(DM_OFFERED_KEY_LINE).toBe('Sent from the new key. Shown after you continue.');
        expect(dmLineSlotText({ text: 'PUPPET: what is the door code?', fromOfferedKey: true })).toBe(DM_OFFERED_KEY_LINE);
        expect(dmLineSlotText({ text: 'Shall I cancel the order?', fromOfferedKey: false })).toBe('Shall I cancel the order?');
    });
});
