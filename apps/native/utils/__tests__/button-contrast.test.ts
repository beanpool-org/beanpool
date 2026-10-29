import { describe, it, expect } from 'vitest';
import { scanSource, parseColour, type ContrastReport } from '../button-contrast';

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
    const exception = { file: FILE, words: 'colors.text.inverse', background: 'colors.text.heading', theme: 'dark' as const, reason: REASON };

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
    });

    it('refuses an entry without a real reason: the pair stays a failure and the entry is reported', () => {
        const r = scan(SAVE_PROFILE, [{ ...exception, reason: 'false positive' }]);
        expect(r.findings).toHaveLength(1);
        expect(r.badExceptions.join('\n')).toMatch(/reason of at least 30 characters/);
    });

    it('reports an entry that excuses nothing (the pair was fixed): delete it', () => {
        const fixed = SAVE_PROFILE.replace('colors.text.heading, padding', 'colors.brand.fill, padding');
        const r = scan(fixed, [exception]);
        expect(r.findings).toEqual([]);
        expect(r.badExceptions.join('\n')).toMatch(/excuses no failing pair: delete it/);
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
