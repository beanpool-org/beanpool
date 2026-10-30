import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSource, scanTree, parseColour, formatReport, topOpaqueFiles, type ContrastReport } from '../button-contrast';

/**
 * The button-contrast scanner (utils/button-contrast.ts) on small fixture screens. The whole-tree run is
 * e2e/button-contrast.check.ts; THIS file proves the scanner finds each known shape of the Save-Profile fault, stays quiet on
 * the shapes that are fine, and that its exceptions list cannot go stale. A scanner gone blind passes the whole tree for
 * the wrong reason, so every shape it must catch is a canary here.
 *
 * Tokens used (apps/native/constants/colors.ts): in darkColors text.heading and text.inverse are BOTH #ffffff, so
 * heading under inverse is 1:1 in dark and 17:1 in light. palette.green600 under white is 3.3:1: under the normal bar,
 * over the large-text bar.
 */
const FILE = 'app/fixture.tsx';
const scanRaw = (src: string, exceptions: Parameters<typeof scanSource>[2] = []) => scanSource(FILE, src, exceptions);
// A screen's `colors` comes from its hook; a bare `colors` is the module's import, which is the light set in both themes.
// The prefix is on the fixture's first line, so the line numbers the tests quote are the fixture's own.
const scan = (src: string, exceptions: Parameters<typeof scanSource>[2] = []) =>
    scanRaw(`function Fixture() { const { colors, theme } = useTheme(); ${src}\n}`, exceptions);
const themes = (r: ContrastReport) => r.findings.map((f) => f.theme).sort();

const SAVE_PROFILE = `
export function Save() {
    const { colors } = useTheme();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        primaryBtn: { backgroundColor: colors.text.heading, padding: 16 },
        primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    }));
    return (
        <Pressable style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Save</Text>
        </Pressable>
    );
}`;

describe('the shapes of the white-on-white fault are caught', () => {
    it('a StyleSheet pair (Save Profile): dark fails, light passes, both colours named with their lines', () => {
        const r = scan(SAVE_PROFILE);
        expect(themes(r)).toEqual(['dark']);
        const f = r.findings[0];
        expect(f.ratio).toBeCloseTo(1, 5);
        expect(f.min).toBe(4.5);
        expect(f.words).toMatchObject({ expr: 'colors.text.inverse', hex: '#ffffff', line: 6 });
        expect(f.background).toMatchObject({ expr: 'colors.text.heading', hex: '#ffffff', line: 5 });
        expect(f.line).toBe(10);
        expect(r.stats.checked).toEqual({ light: 1, dark: 1 });
    });

    it('inline styles on a View and a Text', () => {
        const r = scan(`<View style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>x</Text></View>`);
        expect(themes(r)).toEqual(['dark']);
    });

    it('a Text with its own background and colour', () => {
        const r = scan(`<Text style={{ backgroundColor: colors.text.heading, color: colors.text.inverse }}>x</Text>`);
        expect(themes(r)).toEqual(['dark']);
    });

    it('words several elements below the background', () => {
        const r = scan(`<Pressable style={{ backgroundColor: colors.text.heading }}><View><View><Text style={{ color: colors.text.inverse }}>x</Text></View></View></Pressable>`);
        expect(themes(r)).toEqual(['dark']);
    });

    it('a pressed state: `({ pressed }) => [...]`, reported with the switch it assumes', () => {
        const r = scan(`<Pressable style={({ pressed }) => [{ backgroundColor: colors.brand.fill }, pressed && { backgroundColor: colors.text.heading }]}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`);
        expect(themes(r)).toEqual(['dark']);
        expect(r.findings[0].when).toEqual(['pressed']);
    });

    it('a component that takes its label\'s style as a prop', () => {
        const r = scan(`<Button style={{ backgroundColor: colors.text.heading }} textStyle={{ color: colors.text.inverse }} />`);
        expect(themes(r)).toEqual(['dark']);
    });

    it('a theme ternary is folded per theme: the wrong arm in dark fails, the right one passes', () => {
        const bad = scan(`<View style={{ backgroundColor: theme === 'dark' ? colors.text.heading : colors.brand.fill }}><Text style={{ color: colors.text.inverse }}>x</Text></View>`);
        expect(themes(bad)).toEqual(['dark']);
        const good = scan(`<View style={{ backgroundColor: theme === 'dark' ? colors.brand.fill : colors.text.heading }}><Text style={{ color: colors.text.inverse }}>x</Text></View>`);
        expect(themes(good)).toEqual([]);
        // `dark` and `isDark` fold the same way, and so do their negations
        const flag = scan(`<View style={{ backgroundColor: !isDark ? colors.brand.fill : colors.text.heading }}><Text style={{ color: colors.text.inverse }}>x</Text></View>`);
        expect(themes(flag)).toEqual(['dark']);
    });

    it('palette tokens and literals resolve, the same in both themes', () => {
        const r = scan(`<View style={{ backgroundColor: palette.green600 }}><Text style={{ color: '#fff' }}>x</Text></View>`);
        expect(themes(r)).toEqual(['dark', 'light']);
        expect(r.findings[0].ratio).toBeCloseTo(3.3, 1);
    });

    it('a fill laid translucent over the page is measured over the page', () => {
        const r = scan(`<View style={{ backgroundColor: 'rgba(255,255,255,0.5)' }}><Text style={{ color: '#ffffff' }}>x</Text></View>`);
        expect(themes(r)).toEqual(['dark', 'light']);
    });

    it('a StyleSheet reached through useMemo(() => makeStyles(...)) and a `later entry wins` array', () => {
        const src = `
            function makeStyles(colors) {
                return StyleSheet.create({
                    btn: { backgroundColor: colors.text.heading },
                    btnText: { color: colors.text.inverse },
                });
            }
            function A() {
                const styles = useMemo(() => makeStyles(colors), [colors]);
                return <Pressable style={[styles.btn, { backgroundColor: colors.brand.fill }]}><Text style={styles.btnText}>x</Text></Pressable>;
            }
            function B() {
                const styles = useMemo(() => makeStyles(colors), [colors]);
                return <Pressable style={styles.btn}><Text style={styles.btnText}>x</Text></Pressable>;
            }`;
        const r = scan(src);
        // A overrides the fill (fine); only B draws the bad pair
        expect(themes(r)).toEqual(['dark']);
        expect(r.findings[0].line).toBe(14);
    });

    it('several tables destructured from one makeStyles call: each name reads its own table (the welcome screen)', () => {
        const src = (name: string) => `
            export function Screen() {
                const { colors, dark } = useTheme();
                const { styles, profileStyles } = useMemo(() => makeStyles(colors, dark), [colors, dark]);
                return <Pressable style={${name}.btn}><Text style={${name}.btnText}>Save</Text></Pressable>;
            }
            function makeStyles(colors, dark) {
                const styles = StyleSheet.create({ btn: { backgroundColor: colors.brand.fill }, btnText: { color: colors.text.onBrand } });
                const profileStyles = StyleSheet.create({ btn: { backgroundColor: colors.text.heading }, btnText: { color: colors.text.inverse } });
                return { styles, profileStyles };
            }`;
        // the same entry names in both tables: only profileStyles is the faulty pair, and `styles` is not read for it
        const bad = scanRaw(src('profileStyles'));
        expect(themes(bad)).toEqual(['dark']);
        expect(bad.findings[0].words).toMatchObject({ expr: 'colors.text.inverse', line: 9 });
        expect(bad.stats.unreadTables.size).toBe(0);
        const good = scanRaw(src('styles'));
        expect(good.findings).toEqual([]);
        expect(good.stats.checked).toEqual({ light: 1, dark: 1 });
    });

    it('a makeStyles function handed to useStyles by name: `useStyles(makeStyles)`', () => {
        const screen = `function Screen() { const styles = useStyles(makeStyles); return <Pressable style={styles.btn}><Text style={styles.btnText}>x</Text></Pressable>; }`;
        const table = `{ btn: { backgroundColor: colors.text.heading }, btnText: { color: colors.text.inverse } }`;
        for (const make of [
            `const makeStyles = ({ colors }) => StyleSheet.create(${table});`,
            `function makeStyles({ colors }) { return StyleSheet.create(${table}); }`,
        ]) {
            const r = scanRaw(`${screen}\n${make}`);
            expect(themes(r), make).toEqual(['dark']);
            expect(r.stats.unreadTables.size, make).toBe(0);
        }
    });
});

describe('what is fine stays quiet', () => {
    it('the library\'s sanctioned fill / words pairs pass in both themes', () => {
        const pairs: Array<[string, string]> = [
            ['colors.brand.fill', 'colors.text.onBrand'],
            ['colors.accent.fill', 'colors.text.onAccent'],
            ['colors.feedback.danger.solid', 'colors.text.onDanger'],
            ['colors.feedback.warning.solid', 'colors.text.onGold'],
            ['colors.surface.card', 'colors.text.body'],
            ['colors.feedback.danger.bg', 'colors.feedback.danger.fg'],
        ];
        for (const [bg, ink] of pairs) {
            const r = scan(`<View style={{ backgroundColor: ${bg} }}><Text style={{ color: ${ink} }}>x</Text></View>`);
            expect(r.findings, `${ink} on ${bg}`).toEqual([]);
            expect(r.stats.checked, `${ink} on ${bg} was measured`).toEqual({ light: 1, dark: 1 });
        }
    });

    it('a state\'s fill and a state\'s words are measured together, never crossed with the other state', () => {
        // Crossed, "card + inverse" is white on white in light and "brand.fill + body" is dark on dark in dark.
        const r = scan(`
            <Pressable style={[{ backgroundColor: colors.surface.card }, active && { backgroundColor: colors.brand.fill }]}>
                <Text style={[{ color: colors.text.body }, active && { color: colors.text.inverse }]}>x</Text>
            </Pressable>`);
        expect(r.findings).toEqual([]);
        expect(r.stats.checked.light).toBe(2);
    });

    it('large words: 24px, or 18.66px bold, need 3:1; 20px regular and 18px bold still need 4.5', () => {
        const at = (style: string) => scan(`<View style={{ backgroundColor: palette.green600 }}><Text style={{ color: '#ffffff', ${style} }}>x</Text></View>`);
        expect(at('fontSize: 24').findings).toEqual([]);
        expect(at("fontSize: 20, fontWeight: 'bold'").findings).toEqual([]);
        expect(at('fontSize: 20, fontWeight: 700').findings).toEqual([]);
        expect(at('fontSize: 20').findings).toHaveLength(2);
        expect(at("fontSize: 18, fontWeight: 'bold'").findings).toHaveLength(2);
        expect(at("fontSize: 20, fontWeight: '600'").findings).toHaveLength(2);
        expect(at('fontSize: 16').findings[0].min).toBe(4.5);
        expect(at('fontSize: 24').stats.checked).toEqual({ light: 1, dark: 1 });
    });

    it('a pair that exists only while the control is disabled is exempt; the same under another switch is not', () => {
        const withSwitch = (name: string) => scan(`<Pressable style={[{ backgroundColor: colors.brand.fill }, ${name} && { backgroundColor: colors.text.heading }]}><Text style={[{ color: colors.text.onBrand }, ${name} && { color: colors.text.inverse }]}>x</Text></Pressable>`);
        expect(withSwitch('disabled').findings).toEqual([]);
        expect(themes(withSwitch('busy'))).toEqual(['dark']);
    });

    it('a switch named for the disabled state is exempt however it is spelled: isDisabled, saveDisabled, props.disabled', () => {
        const withSwitch = (name: string) => scan(`<Pressable style={[{ backgroundColor: colors.brand.fill }, ${name} && { backgroundColor: colors.text.heading }]}><Text style={[{ color: colors.text.onBrand }, ${name} && { color: colors.text.inverse }]}>x</Text></Pressable>`);
        for (const name of ['isDisabled', 'saveDisabled', 'buttonDisabled', 'props.disabled', 'Boolean(isDisabled)']) {
            expect(withSwitch(name).findings, name).toEqual([]);
        }
        // a comparison that merely mentions the word says nothing about the control being inactive
        expect(themes(withSwitch("mode === 'disabled'"))).toEqual(['dark']);
        expect(themes(withSwitch('disabled === false'))).toEqual(['dark']);
    });

    it('a row styled by a local alias of the `disabled` switch is inactive too (new-message: isCreating = creating === id)', () => {
        const row = (alias: string, disabled: string) => scan(
            `const isBusy = ${alias}; <Pressable disabled={${disabled}} style={[{ backgroundColor: colors.surface.card }, isBusy && { backgroundColor: colors.accent.tint }]}><Text style={{ color: colors.text.muted }}>x</Text></Pressable>`,
        );
        // muted words on the accent tint read 3.29:1 in dark; the row is drawn so only while every row is inactive
        expect(row('busyKey === id', '!!busyKey').findings).toEqual([]);
        expect(row('id === busyKey', 'busyKey').findings).toEqual([]);
        expect(row('!!busyKey && ready', '!!busyKey').findings).toEqual([]);
        expect(row('Boolean(busyKey)', 'busyKey').findings).toEqual([]);
        // not held inactive: the control is not disabled, the alias says nothing about the switch, or it holds when the switch is empty
        expect(themes(row('busyKey === id', 'false'))).toEqual(['dark']);
        expect(themes(row('otherKey === id', '!!busyKey'))).toEqual(['dark']);
        expect(themes(row('busyKey == null', '!!busyKey'))).toEqual(['dark']);
        expect(themes(row('busyKey === undefined', '!!busyKey'))).toEqual(['dark']);
        expect(themes(row('busyKey || ready', '!!busyKey'))).toEqual(['dark']);
    });

    it('a `disabled` prop on an ancestor exempts a switch that first appears on a child: the label, or an inner View', () => {
        // grey (border.default) under white: 1.20:1 in light. The control is disabled exactly while `saving`.
        const nested = (disabled: string) => scan(
            `<Pressable disabled={${disabled}} style={{ backgroundColor: colors.brand.fill }}><View style={saving && { backgroundColor: colors.border.default }}><Text style={{ color: colors.text.inverse }}>x</Text></View></Pressable>`,
        );
        expect(nested('saving').findings).toEqual([]);
        expect(nested('!!saving').findings).toEqual([]);
        // the same fixture under a flag that is not the one the control is disabled by is still a fault
        expect(themes(nested('other'))).toEqual(['light']);
        expect(themes(nested('!saving'))).toEqual(['light']);
        // the switch on the label itself, and two levels down
        const label = (disabled: string) => scan(
            `<Pressable disabled={${disabled}} style={{ backgroundColor: colors.brand.fill }}><View><Text style={[{ color: colors.text.onBrand }, saving && { color: colors.text.inverse, backgroundColor: colors.border.default }]}>x</Text></View></Pressable>`,
        );
        expect(label('saving').findings).toEqual([]);
        expect(themes(label('other'))).toEqual(['light']);
        // a component taking its label's style: the disabled prop is on that component
        const prop = (disabled: string) => scan(
            `<Button disabled={${disabled}} style={{ backgroundColor: colors.brand.fill }} textStyle={[{ color: colors.text.onBrand }, saving && { color: colors.text.inverse, backgroundColor: colors.border.default }]} />`,
        );
        expect(prop('saving').findings).toEqual([]);
    });

    it('a control held disabled is counted, not passed silently: by its prop, by a name, or by an ancestor\'s prop', () => {
        const held = (jsx: string) => scan(jsx).stats;
        const grey = `style={[{ backgroundColor: colors.brand.fill }, saving && { backgroundColor: colors.border.default }]}`;
        // the grey look while `saving` is one label evaluation per theme, counted and not measured; the normal look is measured
        expect(held(`<Pressable disabled={saving} ${grey}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`)).toMatchObject({ inactive: 2, checked: { light: 1, dark: 1 } });
        const named = held(`<Pressable ${grey.replace('saving', 'isDisabled')}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`);
        expect(named.inactive).toBeGreaterThan(0);
        const ancestor = held(`<Pressable disabled={saving} style={{ backgroundColor: colors.brand.fill }}><View style={saving && { backgroundColor: colors.border.default }}><Text style={{ color: colors.text.inverse }}>x</Text></View></Pressable>`);
        expect(ancestor.inactive).toBe(2);
        // a control that is not disabled has none counted, and its pair is measured
        expect(held(`<Pressable disabled={other} ${grey}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`).inactive).toBe(0);
        expect(formatReport(scan(`<Pressable disabled={saving} ${grey}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`))).toMatch(/2 sit on a control held disabled \(not measured\)/);
    });

    it('JSX drawn only `on && <Text/>` is measured on the fill that setting gives, not on the other one', () => {
        const fill = (render: string) => scan(`<View style={[{ backgroundColor: colors.surface.card }, on && { backgroundColor: colors.accent.fill }]}>{${render}}</View>`);
        // the tick sits on the sage fill it is drawn over...
        const ok = fill(`on && <Text style={{ color: colors.text.onAccent }}>x</Text>`);
        expect(ok.findings).toEqual([]);
        expect(ok.stats.checked).toEqual({ light: 1, dark: 1 });
        // ...and the same words drawn while the fill is the card are caught, in a ternary arm too
        expect(themes(fill(`!on && <Text style={{ color: colors.text.onAccent }}>x</Text>`))).toEqual(['dark', 'light']);
        expect(themes(fill(`on ? null : <Text style={{ color: colors.text.onAccent }}>x</Text>`))).toEqual(['dark', 'light']);
    });

    it('a test that is false in the theme being measured draws nothing in that theme', () => {
        const at = (theme: string) => scan(`<View style={{ backgroundColor: colors.text.heading }}>{theme === '${theme}' && <Text style={{ color: colors.text.inverse }}>x</Text>}</View>`);
        expect(themes(at('dark'))).toEqual(['dark']);
        expect(at('light').findings).toEqual([]);
    });

    it('a switch that changes no colour is not named in a finding', () => {
        const r = scan(`<Pressable style={[{ backgroundColor: colors.text.heading }, patternEnabled && { opacity: 0.5 }]}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].when).toEqual([]);
    });

    it('words in a border colour are a decorative glyph: counted, not measured', () => {
        const r = scan(`<View style={{ backgroundColor: colors.surface.card }}><Text style={{ color: colors.border.strong }}>›</Text></View>`);
        expect(r.findings).toEqual([]);
        expect(r.stats.skipped.get('decorative glyph in a border colour')).toBe(2);
    });

    it('a compound test is read as its parts: `a && !b` for the words, `a` and `b` for the fill (the Submit Rating button)', () => {
        const src = (disabled: string) => `<Pressable disabled={${disabled}} style={{ backgroundColor: rating >= 1 ? (existing ? colors.brand.fill : colors.feedback.warning.solid) : colors.border.default }}>
            <Text style={[{ color: colors.text.inverse }, rating >= 1 && !existing && { color: colors.text.onGold }]}>x</Text></Pressable>`;
        // rated + existing: brand.fill with inverse; rated + new: gold with onGold; not rated: the disabled grey
        expect(scan(src('rating < 1')).findings).toEqual([]);
        // the grey with white words is the disabled look: reported only when the control is not disabled there (and only in
        // light: white words on dark mode's grey read fine)
        expect(themes(scan(src('false')))).toEqual(['light']);
    });

    it('the element\'s own `disabled` prop marks the settings that leave it inactive, whatever the test is called', () => {
        const src = `<Pressable disabled={sending || !to} style={[{ backgroundColor: colors.brand.fill }, (sending || !to) && { backgroundColor: colors.border.default }]}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>`;
        expect(scan(src).findings).toEqual([]);
        expect(scan(src.replace('disabled={sending || !to} ', '')).findings).toHaveLength(2);
    });

    it('a ScrollView\'s contentContainerStyle is the ground of what it holds', () => {
        const r = scan(`<ScrollView style={{ backgroundColor: 'rgba(0,0,0,0.5)' }} contentContainerStyle={{ backgroundColor: colors.surface.card }}><Text style={{ color: colors.text.inverse }}>x</Text></ScrollView>`);
        expect(themes(r)).toEqual(['light']);
        expect(r.findings[0].background.expr).toBe('colors.surface.card');
    });

    it('`colors` imported at module level is the light set in both themes; a hook\'s `colors` follows the theme', () => {
        const module = `
            const g = StyleSheet.create({ card: { backgroundColor: colors.surface.app }, ink: { color: palette.gray600 } });
            function A() { return <View style={g.card}><Text style={g.ink}>x</Text></View>; }`;
        const hooked = `
            function A() {
                const { colors } = useTheme();
                return <View style={{ backgroundColor: colors.surface.app }}><Text style={{ color: palette.gray600 }}>x</Text></View>;
            }`;
        expect(scanRaw(module).findings).toEqual([]);
        expect(scanRaw(module).stats.checked).toEqual({ light: 1, dark: 1 });
        expect(themes(scanRaw(hooked))).toEqual(['dark']);
    });

    it('a symbol on its own (a star, a tick) is held to 3:1 as a graphical object; words, and content it cannot read, to 4.5', () => {
        const at = (content: string) => scan(`<View style={{ backgroundColor: palette.green600 }}><Text style={{ color: '#ffffff' }}>${content}</Text></View>`);
        expect(at('✓').findings).toEqual([]);
        expect(at('★').stats.checked).toEqual({ light: 1, dark: 1 });
        expect(at('Done').findings).toHaveLength(2);
        expect(at('✓ Done').findings).toHaveLength(2);
        expect(at('{icon}').findings).toHaveLength(2);
        // ...and a symbol that misses even 3:1 is still caught (a gold star on the white card; on the dark card it reads)
        const faint = scan(`<View style={{ backgroundColor: colors.surface.card }}><Text style={{ color: palette.amber400 }}>★</Text></View>`);
        expect(faint.findings.map((f) => [f.theme, f.min])).toEqual([['light', 3]]);
    });

    it('a finding names the switches that chose its colours, not the render guards around it', () => {
        const r = scan(`{ready && <Pressable style={({ pressed }) => [{ backgroundColor: colors.brand.fill }, pressed && { backgroundColor: colors.text.heading }]}><Text style={{ color: colors.text.inverse }}>x</Text></Pressable>}`);
        expect(r.findings).toHaveLength(1);
        expect(r.findings[0].when).toEqual(['pressed']);
    });

    it('emoji, whose font ignores `color`, and disclosure chevrons are counted, not measured', () => {
        const on = (content: string) => scan(`<View style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>${content}</Text></View>`);
        for (const emoji of ['🫘', '⚠️', '✨', '{opt.emoji}', '{categoryEmoji(post.category)}']) {
            expect(on(emoji).findings, emoji).toEqual([]);
            expect(on(emoji).stats.skipped.get('emoji, drawn in its own colours'), emoji).toBe(2);
        }
        expect(on('›').findings).toEqual([]);
        expect(on('›').stats.skipped.get('decorative chevron')).toBe(2);
        // an emoji beside words, or beside an expression it cannot read, is words
        expect(themes(on('🫘 Beans'))).toEqual(['dark']);
        expect(themes(on('🫘 {count}'))).toEqual(['dark']);
        // a tick or a star is a text glyph, not an emoji: it is measured (at 3:1)
        expect(themes(on('✓'))).toEqual(['dark']);
    });

    it('words that merely mention emoji are words: only an expression NAMED for one is skipped', () => {
        const on = (content: string) => scan(`<View style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>${content}</Text></View>`);
        for (const words of ["{t('Add an emoji')}", '{emojiLabel}', '{item.emojiName}', "{t('{emoji} {tier}', { emoji: tier.emoji })}", '{emojis.length}']) {
            expect(themes(on(words)), words).toEqual(['dark']);
            expect(on(words).stats.skipped.get('emoji, drawn in its own colours'), words).toBeUndefined();
        }
        // a choice between emoji names and emoji is still an emoji; one arm that is words makes it words
        for (const emoji of ["{trust.tier?.emoji || '🌱'}", "{pulse ? '🗞️' : emoji}", '{band.emoji ?? categoryEmoji(c)}', '{item!.emoji}', "{chatEmoji('group', category)}"]) {
            expect(on(emoji).findings, emoji).toEqual([]);
            expect(on(emoji).stats.skipped.get('emoji, drawn in its own colours'), emoji).toBe(2);
        }
        expect(themes(on("{pulse ? t('News') : emoji}"))).toEqual(['dark']);
    });

    it('colours it cannot resolve are counted as skipped, not passed and not failed', () => {
        const r = scan(`
            <View style={{ backgroundColor: tone.bg }}><Text style={{ color: colors.text.inverse }}>x</Text></View>;
            <View style={{ backgroundColor: colors.text.heading }}><Text style={{ color: tone.fg }}>x</Text></View>;
            <View style={{ backgroundColor: rgbaOf('#000000', 0.5) }}><Text style={{ color: colors.text.inverse }}>x</Text></View>;`);
        expect(r.findings).toEqual([]);
        expect(r.stats.checked).toEqual({ light: 0, dark: 0 });
        expect([...r.stats.skipped.keys()].sort()).toEqual([
            'background unresolved: rgbaOf(\'#000000\', 0.5)',
            'background unresolved: tone.bg',
            'words unresolved: tone.fg',
        ]);
    });

    it('words with no background set above them are not measured (text-ink-contrast covers the standard grounds)', () => {
        const r = scan(`<View><Text style={{ color: colors.text.inverse }}>x</Text></View>`);
        expect(r.findings).toEqual([]);
        expect(r.stats.noGround).toBe(1);
    });

    it('a custom component is a boundary: its own background is unknown, so an outer fill is not assumed', () => {
        const r = scan(`<View style={{ backgroundColor: colors.text.heading }}><Card><Text style={{ color: colors.text.inverse }}>x</Text></Card></View>`);
        expect(r.findings).toEqual([]);
        expect(r.stats.checked).toEqual({ light: 0, dark: 0 });
    });

    it('JSX passed as a prop (renderItem) is not placed on the element it is passed to', () => {
        const r = scan(`<View style={{ backgroundColor: colors.text.heading }}><FlatList renderItem={() => <Text style={{ color: colors.text.inverse }}>x</Text>} /></View>`);
        expect(r.findings).toEqual([]);
    });
});

describe('the exceptions list', () => {
    const REASON = 'Drawn only over the sunken row, where this ink is 5:1; checked on a device in dark.';
    // SAVE_PROFILE writes the words' colour on line 6 and the fill on line 5 (the numbers the report prints beside them).
    const exception = {
        file: FILE, words: 'colors.text.inverse', wordsLine: 6, background: 'colors.text.heading', backgroundLine: 5, theme: 'dark' as const, reason: REASON,
    };

    it('excuses exactly the pair it names, with its reason', () => {
        const r = scan(SAVE_PROFILE, [exception]);
        expect(r.findings).toEqual([]);
        expect(r.badExceptions).toEqual([]);
        expect(r.excused).toHaveLength(1);
        expect(r.excused[0].reason).toBe(REASON);
    });

    it('does not excuse another file, another words colour, or the other theme', () => {
        expect(scan(SAVE_PROFILE, [{ ...exception, file: 'app/other.tsx' }]).findings).toHaveLength(1);
        expect(scan(SAVE_PROFILE, [{ ...exception, words: 'colors.text.heading' }]).findings).toHaveLength(1);
        expect(scan(SAVE_PROFILE, [{ ...exception, theme: 'light' as const }]).findings).toHaveLength(1);
        // the same two colours written on other lines are another pair
        expect(scan(SAVE_PROFILE, [{ ...exception, wordsLine: 7 }]).findings).toHaveLength(1);
        expect(scan(SAVE_PROFILE, [{ ...exception, backgroundLine: 4 }]).findings).toHaveLength(1);
    });

    it('excuses ONE pair, not every place in the file that writes the same two colours', () => {
        // three Save-Profile-shaped buttons, each writing the colours on its own line (3, 4 and 5)
        const three = `
            <Pressable style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>a</Text></Pressable>
            <Pressable style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>b</Text></Pressable>
            <Pressable style={{ backgroundColor: colors.text.heading }}><Text style={{ color: colors.text.inverse }}>c</Text></Pressable>`;
        expect(scan(three).findings).toHaveLength(3);
        const r = scan(three, [{ ...exception, wordsLine: 2, backgroundLine: 2 }]);
        expect(r.excused.map((f) => f.words.line)).toEqual([2]);
        expect(r.findings.map((f) => f.words.line)).toEqual([3, 4]);
        expect(r.badExceptions).toEqual([]);
    });

    it('an entry whose lines have moved says where the pair is now', () => {
        const r = scan(SAVE_PROFILE, [{ ...exception, wordsLine: 20, backgroundLine: 19 }]);
        expect(r.findings).toHaveLength(1);
        expect(r.badExceptions.join('\n')).toMatch(/excuses no failing pair: the same colours fail at words line 6 over background line 5, not at words line 20 over background line 19/);
    });

    it('refuses an entry without the lines: it would excuse the whole file', () => {
        const bare: Partial<typeof exception> = { ...exception };
        delete bare.wordsLine;
        delete bare.backgroundLine;
        const r = scan(SAVE_PROFILE, [bare as typeof exception]);
        expect(r.findings).toHaveLength(1);
        expect(r.badExceptions.join('\n')).toMatch(/wordsLine and backgroundLine are required/);
    });

    it('refuses an entry without a real reason: the pair stays a failure and the entry is reported', () => {
        const r = scan(SAVE_PROFILE, [{ ...exception, reason: 'false positive' }]);
        expect(r.findings).toHaveLength(1);
        expect(r.badExceptions.join('\n')).toMatch(/reason of at least 30 characters/);
        // the entry names the pair exactly: the reason is the only fault, so it is not also told to renumber or delete
        expect(r.badExceptions).toHaveLength(1);
        expect(r.badExceptions.join('\n')).not.toMatch(/excuses no failing pair|Renumber/);
    });

    it('reports an entry that excuses nothing (the pair was fixed): delete it', () => {
        const fixed = SAVE_PROFILE.replace('colors.text.heading, padding', 'colors.brand.fill, padding');
        const r = scan(fixed, [exception]);
        expect(r.findings).toEqual([]);
        expect(r.badExceptions.join('\n')).toMatch(/excuses no failing pair: delete it/);
    });
});

describe('what it could not read is counted and named, never silently clean', () => {
    const SCREEN = (table: string) => `
        export function Screen() {
            const { colors } = useTheme();
            ${table}
            return <Pressable style={styles.btn}><Text style={styles.btnText}>Save</Text></Pressable>;
        }`;

    it('a screen whose table it can read has none unread', () => {
        const r = scanRaw(SCREEN(`const styles = useStyles(({ colors }) => StyleSheet.create({ btn: { backgroundColor: colors.brand.fill }, btnText: { color: colors.text.onBrand } }));`));
        expect(r.stats.unreadTables.size).toBe(0);
        expect(r.stats.opaqueStyles).toBe(0);
    });

    it.each([
        ['a spec function from another file', `const styles = useStyles(({ colors }) => StyleSheet.create(importedSpec(colors)));`],
        ['a table handed over as a prop', `const { styles } = props;`],
        ['no table at all', ``],
    ])('%s: the file is named, its styles are counted, and the report says so', (_why, table) => {
        const r = scanRaw(SCREEN(table));
        expect(r.findings).toEqual([]);
        expect(r.stats.unreadTables.get(FILE)).toEqual(['styles']);
        expect(r.stats.opaqueStyles).toBeGreaterThan(0);
        expect(r.stats.opaqueByFile.get(FILE)).toBe(r.stats.opaqueStyles);
        const text = formatReport(r);
        expect(text).toMatch(/1 files use a style table the scanner could not find/);
        expect(text).toContain(`style table not found: ${FILE} (styles)`);
        expect(text).toContain(`most unread: ${FILE} (${r.stats.opaqueStyles})`);
        expect(topOpaqueFiles(r)).toEqual([`${FILE} (${r.stats.opaqueStyles})`]);
    });

    it.each([
        ['a table called `s` made by an imported function (the home cards)', `const s = homeStyles(colors);`, 's'],
        ['a table called `chat` from an imported spec (the chat screen)', `const chat = useStyles(makeChatStyles);`, 'chat'],
        ['a local object of styles', `const tone = pick ? { btn: { backgroundColor: colors.brand.fill } } : { btn: {} };`, 'tone'],
    ])('%s is a missing table whatever it is called', (_why, decl, name) => {
        const r = scanRaw(`
            export function Screen() {
                const { colors } = useTheme();
                ${decl}
                return <Pressable style={${name}.btn}><Text style={${name}.btnText}>Save</Text></Pressable>;
            }`);
        expect(r.stats.unreadTables.get(FILE)).toEqual([name]);
        expect(r.stats.opaqueStyles).toBeGreaterThan(0);
        expect(formatReport(r)).toContain(`style table not found: ${FILE} (${name})`);
    });

    it('a table called `s` that IS found is not reported, and `StyleSheet.absoluteFill` is not a table', () => {
        const r = scanRaw(`
            export function Screen() {
                const { colors } = useTheme();
                const s = useStyles(({ colors }) => StyleSheet.create({ btn: { backgroundColor: colors.brand.fill }, btnText: { color: colors.text.onBrand } }));
                return <Pressable style={[s.btn, StyleSheet.absoluteFill]}><Text style={s.btnText}>Save</Text></Pressable>;
            }`);
        expect(r.stats.unreadTables.size).toBe(0);
        expect(r.stats.checked).toEqual({ light: 1, dark: 1 });
    });

    it('scanTree reads tools/ as well as app/ and components/ (the shared ToolButton is there)', () => {
        const root = mkdtempSync(join(tmpdir(), 'button-contrast-'));
        try {
            for (const dir of ['app', 'components', 'tools']) {
                mkdirSync(join(root, dir));
                writeFileSync(join(root, dir, 'x.tsx'), SAVE_PROFILE);
            }
            expect(scanTree(root, []).findings.map((f) => f.file).sort()).toEqual(['app/x.tsx', 'components/x.tsx', 'tools/x.tsx']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a prop that is not a style table (`style`, `props.style`) is counted as unread styles but is not a missing table', () => {
        const r = scanRaw(`export function Chip({ style }) { const { colors } = useTheme(); return <View style={[{ backgroundColor: colors.text.heading }, style]}><Text style={{ color: colors.text.inverse }}>x</Text></View>; }`);
        expect(r.stats.unreadTables.size).toBe(0);
        expect(r.stats.opaqueStyles).toBeGreaterThan(0);
        expect(themes(r)).toEqual(['dark']);
    });
});

describe('colour parsing', () => {
    it.each([
        ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
        ['#10b981', { r: 16, g: 185, b: 129, a: 1 }],
        ['rgba(30, 41, 59, 0.85)', { r: 30, g: 41, b: 59, a: 0.85 }],
        ['rgb(0,0,0)', { r: 0, g: 0, b: 0, a: 1 }],
        ['transparent', { r: 0, g: 0, b: 0, a: 0 }],
    ])('%s', (raw, rgba) => {
        expect(parseColour(raw)).toEqual(rgba);
    });

    it('returns null for what it cannot read', () => {
        expect(parseColour('PlatformColor("label")')).toBeNull();
        expect(parseColour('hsl(0, 0%, 0%)')).toBeNull();
    });
});
