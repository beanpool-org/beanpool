/**
 * A text colour that reads on its background: WCAG 2's 4.5:1 for text that isn't large (under 18.66 px bold), as the
 * Market's no-area line's action is at 13 px x 1.3. `fg` itself when it already does; else the same hue moved toward black
 * on a light background (white on a dark one), in small steps, until it does. For a pair the palette can't be relied on to
 * reach that ratio (the review of #1778, finding 9, found one at 4.17:1 on its own box) without changing the palette
 * every screen shares. #rrggbb only; anything else comes back as given.
 */
const HEX = /^#[0-9a-f]{6}$/i;

function channels(hex: string): number[] {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex: string): number {
    const [r, g, b] = channels(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

export function readableOn(fg: string, bg: string, min = 4.5): string {
    if (!HEX.test(fg) || !HEX.test(bg) || contrastRatio(fg, bg) >= min) return fg;
    const toward = luminance(bg) > 0.18 ? 0 : 255;
    const start = channels(fg);
    for (let step = 1; step <= 20; step++) {
        const mixed = '#' + start.map(c => Math.round(c + (toward - c) * (step / 20)).toString(16).padStart(2, '0')).join('');
        if (contrastRatio(mixed, bg) >= min) return mixed;
    }
    return toward === 0 ? '#000000' : '#ffffff';
}
