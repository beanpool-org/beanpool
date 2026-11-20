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
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));

import { lightColors, darkColors } from '../../constants/colors';
import { DmKeyChangedBanner } from '../../components/chat/DmKeyChangedBanner';
import { DmKeyChangedNotice } from '../../components/chat/DmKeyChangedNotice';
import { dmKeyChangedNoticeText, dmKeyCodeCopy, dmKeyCodeState, dmKeyCodeShowsVerified } from '../dm-key-change';
import { CHAT_MEMORY_RESET_WORDS } from '../dm-guard-list';
import { MyKeyCodeCard } from '../../components/MyKeyCodeCard';
import { dmKeyChangeStyleSpec, DM_KEY_CHANGE_TEXT_ON, DM_KEY_CHANGE_TOUCH_TARGETS, dmKeyChangeCopy, rekeyedOnText, dmKeyBannerMaxHeight } from '../dm-key-change';
import { keyCodeOf, keyCodeSpoken } from '../key-code';

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
        const codeEl = host.querySelector('[aria-label^="Key code:"]')!;
        const code = codeEl.textContent!;
        expect(code).toMatch(CODE);
        expect(code).toBe(keyCodeOf(newKey));
        // A screen reader says each digit, never "four thousand…" (#1873 review, finding 9).
        expect(codeEl.getAttribute('aria-label')).toBe(`Key code: ${keyCodeSpoken(code)}`);
        expect(codeEl.getAttribute('aria-label')).not.toMatch(/\d\d/);
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
        expect(host.querySelector('[aria-label^="Key code:"]')).toBeNull();
        expect(host.querySelector('[role="checkbox"]')).toBeNull();
        expect(button('Continue with the new key')).toBeNull();
        expect(button('Not now')).not.toBeNull();
        expect(host.textContent).toContain("This community doesn't list a single key for Ben in this chat, so there is no key to continue with.");
    });

    // Signal's model, S2 (DESIGN-dm-key-signal-model §4, §7): first sight, the reset's re-seed and rule 5 take a single listed
    // key by themselves, so no card of theirs names a key, and their opening sentences ("checking this chat from the start",
    // the reset's, and rule 5's body with a code) are gone. A card with a code is a verified person's, whatever else it says.
    it('a card with a code says only the verified person\'s words: the first-sight, reset and rule-5 bodies are gone (S2)', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: true, unplaced: true, verified: true }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).toContain('You marked Ben as verified, so this phone is asking before it sends to a new key. Anything you send now would go to the new key.');
        expect(host.textContent).not.toContain('checking this chat from the start');
        expect(host.textContent).not.toContain("can't match this chat to one key");
        expect(host.textContent).not.toContain('The earlier messages here came from');
    });

    it('rule 5 with no single key listed: no code, no tick, no Continue; only "Not now"', () => {
        render(createElement(DmKeyChangedBanner, { peerName: null, change: { offeredPeer: null, firstSight: true, unplaced: true }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.querySelector('[aria-label^="Key code:"]')).toBeNull();
        expect(host.querySelector('[role="checkbox"]')).toBeNull();
        expect(button('Continue with the new key')).toBeNull();
        expect(button('Not now')).not.toBeNull();
        expect(host.textContent).toContain("This community doesn't list a single key for the other person in this chat, so there is no key to continue with.");
    });

    it('the node\'s re-key date is a line of words only when it gives one', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false, verified: true, rekeyedAt: '2026-10-03T09:00:00.000Z' }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).toContain('This community says the account was re-keyed on 3 Oct 2026.');
        expect(rekeyedOnText('not a date')).toBeNull();
    });

    // Confirmation 11, finding 7 (mutant KC7, the date read in local time, survived): the node fixed the re-key to a UTC day, and
    // the banner says that day in every zone. Near midnight UTC a zone east of it is already on the next day, one west still on
    // the one before; the guards check the zone really moved the local day, or the case would prove nothing.
    it('the re-key date is the UTC day the node gave, whatever zone the phone is in', () => {
        const tz = process.env.TZ;
        try {
            for (const zone of ['Australia/Melbourne', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Pago_Pago', 'UTC']) {
                process.env.TZ = zone;
                expect(rekeyedOnText('2026-10-03T23:30:00.000Z'), zone).toBe('3 Oct 2026');
                expect(rekeyedOnText('2026-10-03T00:30:00.000Z'), zone).toBe('3 Oct 2026');
            }
            process.env.TZ = 'Australia/Melbourne';
            expect(new Date('2026-10-03T23:30:00.000Z').getDate()).toBe(4);
            process.env.TZ = 'America/Los_Angeles';
            expect(new Date('2026-10-03T00:30:00.000Z').getDate()).toBe(2);
        } finally {
            if (tz === undefined) delete process.env.TZ;
            else process.env.TZ = tz;
        }
    });

    it('a change after a sync never says the phone is checking from the start, and no date line without a date', () => {
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).not.toContain('checking this chat from the start');
        expect(host.textContent).not.toContain('This community says');
    });

    it('Settings → My key code shows the same code Ben\'s banner shows on Ana\'s phone', () => {
        render(createElement(MyKeyCodeCard, { publicKey: newKey }));
        expect(host.textContent).toContain('My key code');
        const mine = host.querySelector('[aria-label^="My key code:"]')!;
        expect(mine.textContent).toBe(keyCodeOf(newKey));
        expect(mine.getAttribute('aria-label')).toBe(`My key code: ${keyCodeSpoken(keyCodeOf(newKey)!)}`);
        expect(mine.getAttribute('aria-label')).not.toMatch(/\d\d/);
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
    const CODE = '1111 2222 3333 4444 5555';
    it('with no name for the key (the directory has none), a whole sentence for each: never the conversation id (#1873 review, finding 2), never an English "this person" pasted into a translated one (15 Oct words design, D4)', () => {
        for (const peerName of [null, undefined, '', '  ', 'Loading...']) {
            const plain = dmKeyChangeCopy({ peerName, code: CODE });
            expect(plain.title).toBe('The key behind this chat changed.');
            expect(plain.body).toBe('Anything you send now would go to the new key. If the other person got a new phone and re-keyed, check with them first, in person or on a call: their key code should be');
            expect(plain.confirm).toBe('I checked with them: the key code in their Settings matches this one.');
            expect(dmKeyChangeCopy({ peerName, code: null }).body).toBe("This community doesn't list a single key for the other person in this chat, so there is no key to continue with. Nothing will be sent here. Check with them in person or on a call.");
            for (const copy of [plain, dmKeyChangeCopy({ peerName, code: null })]) {
                expect(JSON.stringify(copy)).not.toMatch(/this person|Loading/);
            }
        }
    });
    it('with a name, the same sentences say it', () => {
        const ben = dmKeyChangeCopy({ peerName: 'Ben', code: CODE });
        expect(ben.title).toBe('The key behind "Ben" changed.');
        expect(ben.confirm).toBe('I checked with Ben: the key code in their Settings matches this one.');
        expect(dmKeyChangeCopy({ peerName: 'Ben', code: null }).body).toBe("This community doesn't list a single key for Ben in this chat, so there is no key to continue with. Nothing will be sent here. Check with Ben in person or on a call.");
    });
    it('no single key (a pause of several, or rule 5 with none: D2 (c)): Not now only, and never "start a new chat", which opens this same chat', () => {
        for (const verified of [false, true]) {
            const copy = dmKeyChangeCopy({ peerName: 'Ben', code: null, verified });
            expect(copy.body).toBe("This community doesn't list a single key for Ben in this chat, so there is no key to continue with. Nothing will be sent here. Check with Ben in person or on a call.");
            expect([copy.confirm, copy.continueLabel]).toEqual([null, null]);
            expect(copy.notNowLabel).toBe('Not now');
        }
        for (const peerName of ['Ben', null]) for (const code of [CODE, null]) for (const verified of [false, true]) {
            expect(JSON.stringify(dmKeyChangeCopy({ peerName, code, verified }))).not.toMatch(/new chat/i);
        }
    });
});

// #1873 review: the DM screen keys the banner on the offered key, so a tick given for one code never carries over to a
// new one (mutant M14 survived every test). A source pin on [id].tsx, and the behaviour of that keying.
describe('the banner on the DM screen is keyed on the offered key', () => {
    beforeEach(() => { theme.colors = lightColors; });
    it('[id].tsx renders it (in its pane) with key={keyChange?.offeredPeer ?? \'none\'}', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(src).toMatch(/<DmKeyChangedPane\s+key=\{keyChange\?\.offeredPeer \?\? 'none'\}/);
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
    it('[id].tsx shows rule 5 through the banner (getDmKeyChange\'s unplaced change, 15 Oct words design D2), disables the box with DM_UNPLACED_LINE, and sends nothing while it lasts', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        // The key check runs BEFORE the thread is read (DESIGN-dm-key-signal-model §7 S1): its resting rule moves a person not
        // marked verified to the new key first, so no frame shows the paused box or the fixed line for them.
        // S2: the header's "Verified ✓" reads the pins between the two (getDmKeyCodeInfo reads only), still before the thread.
        // Each names the chat's community (`at`, slice S2: undefined for the community in use, as before).
        expect(src).toMatch(/const change = await getDmKeyChange\(id as string, at\)\.catch\(\(\) => undefined\);\s*(?:\/\/[^\n]*\n\s*)*const codeInfo = await getDmKeyCodeInfo\(id as string, at\)\.catch\(\(\) => undefined\);\s*let data: any\[\];\s*try \{\s*data = await getMessages\(id as string, \{ limit: msgLimitRef\.current, notices: true, community: at \}\);/);
        expect(src).toMatch(/if \(change !== undefined\) setKeyChange\(change\);/);
        expect(src).not.toMatch(/getDmKeyChange\(id as string(?:, at)?\)\.then\(setKeyChange/);
        expect(src).toMatch(/const keyChangePending = !!keyChange;\s*const unplaced = !!keyChange\?\.unplaced;/);
        expect(src).not.toMatch(/isDmUnplaced/);
        expect(src).toMatch(/disabled=\{keyChangePending\}/);
        expect(src).toMatch(/notice=\{unplaced \? t\(DM_LOCK_WORDS\.unplaced\) : keyChangePending \? dmKeyChangedLine\(keyChange\?\.name\) : lockNotice \? chatLineWords\(lockNotice\) : (?:null\}|\()/); // the three security lines first, in this order; a message request's own words may only follow them
        expect(src).toMatch(/const canSendNow = \(\) => [^;]*!keyChangePending/);
        // The banner is named from the key's member row (getDmKeyChange), never the screen's id-fragment fallback.
        expect(src).toMatch(/card=\{keyChange \? \{ peerName: keyChange\.name, change: keyChange, /);
        // The banner's cap is worked out from the measured column and the box (finding 7), never a share of the window
        // alone. The column runs from the header's bottom to the keyboard view's bottom, both read in the screen's own
        // frame, with the page (the card, then the deals strip, the listing's header and the release bar, scrolling as one)
        // between them; the box is measured whole. Nothing else stands in the column (dm-key-pane-fit-render.test.ts), so
        // there is no bar to measure (deciding review of 6775428c, finding 1).
        expect(src).toMatch(/maxHeight=\{dmKeyBannerMaxHeight\(\{ \.\.\.column, windowHeight, keyboard: keyboardHeight \}\)\}/);
        expect(src).toMatch(/const \[column, setColumn\] = useState\(\{ column: 0, composer: 0 \}\);/);
        // A keyboard already up when the pause starts comes off the banner's room (confirmation 2, finding 5).
        expect(src).toMatch(/const keyboardHeight = useKeyboardState\(s => \(s\.isVisible \? s\.height : 0\)\);/);
        expect(src).not.toMatch(/windowHeight \* 0\.55/);
        expect(src).toMatch(/if \(header > 0 && bottom > header\) setColumn\(\(c\) => \(c\.column === bottom - header \? c : \{ \.\.\.c, column: bottom - header \}\)\);/);
        const header = src.indexOf("<View style={styles.header} onLayout={measuredEdge('header')}>");
        const banner = src.indexOf('<DmKeyChangedPane');
        // The keyboard view also takes the screen's top in the window (an iPhone sheet; composer-above-keyboard.test.ts).
        const keyboardView = src.search(/<KeyboardAvoidingView\s+style=\{styles\.keyboardView\}\s+behavior="padding"\s+keyboardVerticalOffset=\{screenKeyboard\.keyboardVerticalOffset\}\s+onLayout=\{measuredEdge\('bottom'\)\}\s*>/);
        expect(header).toBeGreaterThan(-1);
        expect(banner).toBeGreaterThan(header);
        expect(keyboardView).toBeGreaterThan(banner);
        // Never a View wrapped round the keyboard view to measure it: the library pads by its frame in its parent, and a
        // wrapper starting under the header left the box under the keyboard in every DM (1.2.61; chat-keyboard-tree.test.ts).
        expect(src).not.toMatch(/measured\('column'\)/);
        expect(src).not.toMatch(/<\/KeyboardAvoidingView>\s*<\/View>/);
        expect(src).toMatch(/<View style=\{styles\.dealStrip\}>/);
        expect(src).not.toMatch(/measured\('deals'\)/);
        // The box is everything under the thread, measured whole: the edit, about and reply banners over the composer too, so
        // the card's room never counts on space they take (the thread gives way while the card is up; walk of 17 Nov).
        // Inside it the About chip is a page in its room, then the Editing or Replying to banner whole in its crop, measured
        // on its own (chatColumnFit; market-dm-fit-render.test.ts), still before the composer.
        expect(src).toMatch(/<View onLayout=\{measured\('composer'\)\}>\s*\{!editingMessage && \(\s*<ChatScrollPage testID="chat-about-page" maxHeight=\{fit\.about\}>\s*<ChatAboutBanner conversationId=\{String\(id\)\} \/>\s*<\/ChatScrollPage>\s*\)\}\s*<View testID="chat-box-banner" style=\{\{ maxHeight: fit\.banner, overflow: 'hidden', justifyContent: 'center' \}\}>\s*<View onLayout=\{\(e\) => setBannerHeight\(Math\.ceil\(e\.nativeEvent\.layout\.height\)\)\}>\s*\{editingMessage && \(\s*<ChatEditBanner/);
        const box = src.indexOf("<View onLayout={measured('composer')}>");
        expect(src.indexOf('<ChatAboutBanner', box)).toBeGreaterThan(box);
        expect(src.indexOf('<ChatReplyBanner', box)).toBeGreaterThan(box);
        expect(src.indexOf('{isPeerBlocked ? (', box)).toBeGreaterThan(src.indexOf('<ChatReplyBanner', box));
    });
    it('Settings shows My key code above the sign-in check\'s spinner, never behind it (#1873 review, finding 9)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'app', '(tabs)', 'settings.tsx'), 'utf8');
        const card = src.indexOf('<MyKeyCodeCard publicKey={identity?.publicKey} />');
        const spinner = src.indexOf('{protectionLoading ? (');
        expect(card).toBeGreaterThan(src.indexOf("{mode === 'protection' && ("));
        expect(card).toBeLessThan(spinner);
        expect(src.split('<MyKeyCodeCard').length - 1).toBe(1);
        // One keyCodeOf in the app: utils/key-code.ts's (the names list's twin is gone).
        expect(readFileSync(join(process.cwd(), 'utils', 'names-list.ts'), 'utf8')).not.toMatch(/export (const|function) keyCodeOf/);
    });
    it('[id].tsx draws a line from the offered key as the fixed line in the middle of the chat, never its words (#1872 handover 2)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { dmLineSlotText, DM_OFFERED_KEY_LINE } = await import('../dm-lock');
        const src = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(src).toMatch(/if \(item\.unattributed \|\| item\.fromOfferedKey\) return renderUnattributedLine\(item\);/);
        const slot = src.slice(src.indexOf('const renderUnattributedLine'), src.indexOf('const renderMessage'));
        // In the member's language (utils/chat-line-words: the stand-in sentences dm-crypto writes), still never its words;
        // the admins' message (their words, as written) is the slot's text untranslated, still through dmLineSlotText.
        expect(slot).toMatch(/\{item\.quoteFrom === 'admins' \? dmLineSlotText\(item\) : chatLineWords\(dmLineSlotText\(item\)\)\}/);
        expect(slot).not.toMatch(/\{item\.text\}/);
        expect(DM_OFFERED_KEY_LINE).toBe('Sent from the new key. Shown after you continue.');
        expect(dmLineSlotText({ text: 'PUPPET: what is the door code?', fromOfferedKey: true })).toBe(DM_OFFERED_KEY_LINE);
        expect(dmLineSlotText({ text: 'Shall I cancel the order?', fromOfferedKey: false })).toBe('Shall I cancel the order?');
    });
});

// The card's room on the smallest phones. #1873's review (finding 7) capped it at 55% of the column and kept a floor for the
// thread: on the walk of 17 Nov that left the verified card 219 dp at 320 × 569 and 1.3× text, its code, tick and Continue
// in a scroll inside it with no hint. Now it may take the whole room above the box; the box is still never cut. The column
// is what sits under the header (screen − nav bar unless edge-to-edge − status bar 24 − header 64); the box is the
// composer at that text size, plus the nav bar's inset in its padding when edge-to-edge (max(48, 12) instead of 12).
// The card on screen in this room: dm-key-pane-fit-render.test.ts.
describe('the card\'s room on a 320 × 533 phone and up (walk of 17 Nov)', () => {
    const composerAt: Record<number, number> = { 1: 101, 1.2: 105, 1.3: 109 };
    const phones = [
        { name: '320 × 533, 48-dp nav bar', screen: 533, nav: 48, edgeToEdge: false },
        { name: '320 × 533, edge-to-edge', screen: 533, nav: 48, edgeToEdge: true },
        { name: '320 × 568, no nav bar', screen: 568, nav: 0, edgeToEdge: false },
        { name: '360 × 640, 48-dp nav bar', screen: 640, nav: 48, edgeToEdge: false },
    ];
    for (const p of phones) for (const fontScale of [1, 1.2, 1.3]) {
        it(`${p.name} at ${fontScale}×: the box is never cut, and the card may take all the room above it`, () => {
            const windowHeight = p.edgeToEdge ? p.screen : p.screen - p.nav;
            const column = windowHeight - 24 - 64;
            const composer = composerAt[fontScale] + (p.edgeToEdge ? p.nav - 12 : 0);
            // The deals strip, the listing's header and the release bar scroll with the card in this room: they take
            // nothing off the box (dm-key-pane-fit-render.test.ts).
            const page = dmKeyBannerMaxHeight({ column, composer, windowHeight });
            expect(page + composer).toBe(column);
        });
    }
    it('a window too short for the box gives the card what is left, never less than nothing: the box is never cut', () => {
        expect(dmKeyBannerMaxHeight({ column: 200, composer: 145, windowHeight: 320 })).toBe(55);
        expect(dmKeyBannerMaxHeight({ column: 120, composer: 145, windowHeight: 320 })).toBe(0);
    });
    it('before the column is measured (the first frame), 55% of the window less the box, never more', () => {
        expect(dmKeyBannerMaxHeight({ column: 0, composer: 0, windowHeight: 485 })).toBe(267);
        expect(dmKeyBannerMaxHeight({ column: 0, composer: 109, windowHeight: 485 })).toBe(158);
        expect(dmKeyBannerMaxHeight({ column: 0, composer: 109, windowHeight: 485, keyboard: 300 })).toBe(0);
    });
    // #1872/#1873 confirmation 2, finding 5: Ana is typing when a sync makes the offer, so a 300-dp keyboard is already up
    // for the moment before the card puts it away (DmKeyChangedPane). The KeyboardAvoidingView pads the column by up to the
    // keyboard's height, so the room comes off it and the box stays above the keyboard. The columns and boxes here are the
    // RN-web replica's, with the keyboard up.
    const withKeyboard = [
        { name: '320 × 640, 48-dp nav bar', column: { 1: 503, 1.2: 496, 1.3: 493 }, box: { 1: 76, 1.2: 95, 1.3: 97 } },
        { name: '320 × 640, edge-to-edge', column: { 1: 551, 1.2: 544, 1.3: 541 }, box: { 1: 76, 1.2: 95, 1.3: 97 } },
        { name: '480 × 854, 48-dp nav bar', column: { 1: 717, 1.2: 710, 1.3: 707 }, box: { 1: 76, 1.2: 79, 1.3: 80 } },
        { name: '480 × 854, edge-to-edge', column: { 1: 765, 1.2: 758, 1.3: 755 }, box: { 1: 76, 1.2: 79, 1.3: 80 } },
    ] as const;
    for (const p of withKeyboard) for (const fontScale of [1, 1.2, 1.3] as const) {
        it(`${p.name} at ${fontScale}×, a 300-dp keyboard already up: the box sits above the keyboard, the card has what is left`, () => {
            const column = p.column[fontScale], composer = p.box[fontScale], keyboard = 300;
            const page = dmKeyBannerMaxHeight({ column, composer, windowHeight: column + 88, keyboard });
            expect(page + composer + keyboard).toBe(column);
            // With the keyboard down the card has the room as without one.
            expect(dmKeyBannerMaxHeight({ column, composer, windowHeight: column + 88, keyboard: 0 }))
                .toBe(dmKeyBannerMaxHeight({ column, composer, windowHeight: column + 88 }));
        });
    }
});

// Signal's model on the phone (DESIGN-dm-key-signal-model §3, §4, §7 S1): the verified card's first sentence, the thread's
// notice, the key code screen's words and wiring. One toBe per new sentence (amendment 7 §5).
describe('Signal\'s model: the verified card, the thread notice and the key code screen', () => {
    const newKey = 'ab'.repeat(32);

    it('the verified card opens with "You marked … as verified"; an ordinary card never says it; one sentence each, with its unknown-name twin', () => {
        const ben = dmKeyChangeCopy({ peerName: 'Ben', code: '1111 2222 3333 4444 5555', verified: true });
        expect(ben.body).toBe('You marked Ben as verified, so this phone is asking before it sends to a new key. Anything you send now would go to the new key. If Ben got a new phone and re-keyed, check with them first, in person or on a call: their key code should be');
        const nobody = dmKeyChangeCopy({ peerName: null, code: '1111 2222 3333 4444 5555', verified: true });
        expect(nobody.body.startsWith('You marked this person as verified, so this phone is asking before it sends to a new key. ')).toBe(true);
        expect(dmKeyChangeCopy({ peerName: 'Ben', code: '1111 2222 3333 4444 5555' }).body).not.toContain('You marked');
        // No single key listed: the same card for everyone, verified or not (T3).
        expect(dmKeyChangeCopy({ peerName: 'Ben', code: null, verified: true }).body).not.toContain('You marked');
        render(createElement(DmKeyChangedBanner, { peerName: 'Ben', change: { offeredPeer: newKey, firstSight: false, verified: true }, onContinue: vi.fn(), onNotNow: vi.fn() }));
        expect(host.textContent).toContain('You marked Ben as verified, so this phone is asking before it sends to a new key.');
        expect(host.querySelector('[role="checkbox"]')).not.toBeNull();
    });

    it('the thread notice: information words, one per name case, a button that opens the key code screen', async () => {
        expect(dmKeyChangedNoticeText('Ben')).toBe("Ben's key changed. This usually means they got back into their account on a new phone. Tap to see their key code.");
        for (const peerName of [null, undefined, '', 'Loading...']) {
            expect(dmKeyChangedNoticeText(peerName)).toBe("This chat's key changed. This usually means the other person got back into their account on a new phone. Tap to see their key code.");
        }
        const onPress = vi.fn();
        for (const colors of [lightColors, darkColors]) {
            theme.colors = colors;
            render(createElement(DmKeyChangedNotice, { peerName: 'Ben', onPress }));
            const b = button("Ben's key changed. This usually means they got back into their account on a new phone. Tap to see their key code.");
            expect(b).not.toBeNull();
            expect(b!.textContent).toBe(dmKeyChangedNoticeText('Ben'));
            await click(b);
        }
        expect(onPress).toHaveBeenCalledTimes(2);
        // Never the warning yellow: the notice is information (§4).
        for (const colors of [lightColors, darkColors] as Array<typeof lightColors>) {
            const spec = dmKeyChangeStyleSpec(colors);
            expect(spec.notice.backgroundColor).not.toBe(colors.feedback.warning.bg);
            expect(spec.notice.minHeight).toBeGreaterThanOrEqual(48);
        }
    });

    it('the notice at 320 dp with 1.3× text: one wrapping line of words, its longest word inside the row, no line limit', () => {
        const spec = dmKeyChangeStyleSpec(lightColors);
        const room = 320 - 2 * Number(spec.notice.marginHorizontal) - 2 * Number(spec.notice.paddingHorizontal) - 16 - Number(spec.notice.gap);
        for (const words of [dmKeyChangedNoticeText('Bartholomew'), dmKeyChangedNoticeText(null)]) {
            const longest = words.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
            expect(longest.length * 0.62 * Number(spec.noticeText.fontSize) * 1.3).toBeLessThan(room);
        }
        expect(spec.noticeText).not.toHaveProperty('numberOfLines');
    });

    it('the key code screen\'s words, each whole with its unknown-name twin; the menu item; the reset\'s new sentence', () => {
        const ben = dmKeyCodeCopy('Ben');
        expect(ben.title).toBe('Key code');
        expect(ben.heading).toBe("Ben's key code");
        expect(ben.howTo).toBe('Ask Ben to open Settings, then Account Protection, and read you My key code. Do it in person or on a call. If every digit matches, this chat is really with Ben.');
        expect(ben.mark).toBe('Mark as verified');
        expect(ben.markNote).toBe('After that, this phone asks you before it sends to a new key for Ben, in every community on this phone. Kept on this phone only.');
        expect(ben.verified).toBe('Verified ✓');
        expect(ben.verifiedNote).toBe('This phone asks you before it sends to a new key for Ben, in every community on this phone. Kept on this phone only.');
        expect(ben.remove).toBe('Remove verification');
        expect(ben.paused).toBe("Ben's key changed. The new code is at the top of the chat.");
        expect(ben.none).toBe('There is no key code to show for this chat yet.');
        expect(ben.moved).toBe("This chat's key changed while you were checking. Look at the new code and check it again.");
        expect(ben.removeConfirmTitle).toBe('Remove verification?');
        expect(ben.removeConfirmBody).toBe('This phone will stop asking before it sends to a new key for Ben, in every community on this phone.');
        expect(dmKeyCodeCopy('Ben', true).removeConfirmBody).toBe("This chat will carry on with Ben's new key, without the check.");
        const nobody = dmKeyCodeCopy(null);
        expect(nobody.heading).toBe("This chat's key code");
        expect(nobody.howTo).toBe('Ask the other person to open Settings, then Account Protection, and read you My key code. Do it in person or on a call. If every digit matches, this chat is really with them.');
        expect(nobody.markNote).toBe('After that, this phone asks you before it sends to a new key for this person, in every community on this phone. Kept on this phone only.');
        expect(nobody.verifiedNote).toBe('This phone asks you before it sends to a new key for this person, in every community on this phone. Kept on this phone only.');
        expect(nobody.paused).toBe("This chat's key changed. The new code is at the top of the chat.");
        expect(nobody.removeConfirmBody).toBe('This phone will stop asking before it sends to a new key for this person, in every community on this phone.');
        expect(dmKeyCodeCopy(null, true).removeConfirmBody).toBe("This chat will carry on with the other person's new key, without the check.");
        expect(JSON.stringify(dmKeyCodeCopy('Ben'))).not.toMatch(/safety number/i);
        // S7c (DESIGN-s7-blocks-verified-everywhere §3.4): the reset no longer costs marks, so its warning lost that sentence.
        expect(CHAT_MEMORY_RESET_WORDS).not.toHaveProperty('verifiedGo');
        expect(JSON.stringify(CHAT_MEMORY_RESET_WORDS)).not.toMatch(/verified/);
        // S2: why sending waits while no single key is listed (the S1 deciding review's note), whole with its twin.
        expect(ben.waiting).toBe("This community doesn't list a single key for Ben in this chat, so sending waits.");
        expect(nobody.waiting).toBe("This community doesn't list a single key for the other person in this chat, so sending waits.");
    });

    // S2 (#3263's deciding review, note 1): a verified person with no single key listed was 'waiting' with only "Remove
    // verification" under the code. One table for the screen's state and for "Verified ✓", which the chat's header reads too.
    it('the key code screen\'s one state and its "Verified ✓", for every flag the pins can give (S2)', () => {
        const CODE = '1111 2222 3333 4444 5555';
        const rows: Array<[string, { verified: boolean; paused: boolean; offersKey: boolean } | null, string | null, string, boolean]> = [
            ['nothing read', null, null, 'none', false],
            ['no pin (a rule-5 record)', { verified: false, paused: true, offersKey: false }, null, 'none', false],
            ['an ordinary pin', { verified: false, paused: false, offersKey: false }, CODE, 'not-verified', false],
            ['verified', { verified: true, paused: false, offersKey: false }, CODE, 'verified', true],
            ['verified, a new key waits (the card)', { verified: true, paused: true, offersKey: true }, CODE, 'paused', false],
            ['verified, no single key listed', { verified: true, paused: true, offersKey: false }, CODE, 'waiting', true],
            ['not verified, no single key listed', { verified: false, paused: true, offersKey: false }, CODE, 'waiting', false],
        ];
        for (const [what, info, code, state, shows] of rows) {
            expect(dmKeyCodeState(info, code), what).toBe(state);
            expect(dmKeyCodeShowsVerified(info, code), what).toBe(shows);
        }
    });

    it('the wiring, S2: the screen says why sending waits and shows "Verified ✓" by the one rule; the chat\'s header shows it beside "🔒 End-to-end encrypted"', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const screen = readFileSync(join(process.cwd(), 'app', 'chat', 'key-code.tsx'), 'utf8');
        expect(screen).toMatch(/const state = dmKeyCodeState\(info, code\);/);
        expect(screen).toMatch(/const showsVerified = dmKeyCodeShowsVerified\(info, code\);/);
        expect(screen).toMatch(/\{showsVerified && <Text style=\{styles\.verifiedText\}>\{copy\.verified\}<\/Text>\}/);
        expect(screen).toMatch(/\{state === 'waiting' && <Text style=\{styles\.keyCodeBody\}>\{copy\.waiting\}<\/Text>\}/);
        const chatSrc = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        // Read after the key check, so it sees the pin as the resting rule left it; the same rule as the screen's.
        expect(chatSrc).toMatch(/const change = await getDmKeyChange\(id as string, at\)\.catch\(\(\) => undefined\);\s*\/\/[^\n]*\n\s*const codeInfo = await getDmKeyCodeInfo\(id as string, at\)\.catch\(\(\) => undefined\);/);
        expect(chatSrc).toMatch(/setPeerVerified\(dmKeyCodeShowsVerified\(codeInfo, keyCodeOf\(codeInfo\?\.peer\)\)\)/);
        expect(chatSrc).toMatch(/\{isEncrypted \? t\('🔒 End-to-end encrypted'\) : t\('Connected via your community'\)\}\s*<\/Text>\s*\{isEncrypted && peerVerified && \(\s*<Text style=\{\[styles\.headerSubtitle, styles\.headerVerified\]\} numberOfLines=\{1\}>\{t\('Verified ✓'\)\}<\/Text>/);
        // "Verified ✓" never gives way at 320 dp; "🔒 End-to-end encrypted" does.
        expect(chatSrc).toMatch(/headerSubtitleText: \{ flexShrink: 1 \}/);
        expect(chatSrc).toMatch(/headerVerified: \{ flexShrink: 0, marginLeft: 6 \}/);
    });

    it('the wiring: the ⋯ menu\'s Key code (DMs only), the notice in the thread, and a plain key code screen that marks only the key it showed', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const chatSrc = readFileSync(join(process.cwd(), 'app', 'chat', '[id].tsx'), 'utf8');
        expect(chatSrc).toMatch(/label: t\('Key code'\),\s*hidden: !isEncrypted,/);
        expect(chatSrc).toMatch(/const renderMessage = \(item: any\) => \{\s*\/\/[^\n]*\n\s*if \(item\.keyChangedNotice\) return <DmKeyChangedNotice peerName=\{peerName\} onPress=\{openKeyCode\} \/>;/);
        // In place (slice S2) the key code screen gets the chat's community too, and reads and marks that community's pins.
        expect(chatSrc).toMatch(/router\.push\(\{ pathname: '\/chat\/key-code', params: at \? \{ id: String\(id\), community: at \} : \{ id: String\(id\) \} \}\)/);
        const screen = readFileSync(join(process.cwd(), 'app', 'chat', 'key-code.tsx'), 'utf8');
        expect(screen).not.toMatch(/<Modal\b/);
        expect(screen).not.toMatch(/import \{[^}]*\bModal\b[^}]*\} from 'react-native'/);
        expect(screen).not.toMatch(/numberOfLines/);
        expect(screen).toMatch(/<ScrollView/);
        expect(screen).toMatch(/markDmPeerVerified\(String\(id\), info\.peer, at\)/);
        expect(screen).toMatch(/getDmKeyCodeInfo\(String\(id\), at\)/);
        const card = readFileSync(join(process.cwd(), 'components', 'ChatMemoryCard.tsx'), 'utf8');
        // S7c: the confirmation is the reset's own sentence alone; no sentence about verified people follows it.
        expect(card).toMatch(/\{t\(CHAT_MEMORY_COPY\.confirm\)\}<\/Text>\s*<Pressable style=\{styles\.confirmBtn\}/);
        expect(card).not.toMatch(/verifiedGo/);
    });
});
