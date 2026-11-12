import { useRef, useId, type KeyboardEvent } from 'react';
import { brandSwatch, lookSwatchSets, t } from '@beanpool/core';
import { THEME_PREFERENCE_OPTIONS, type ThemePreference } from '../lib/useTheme';

/**
 * Settings -> Appearance: the look, as one list of four rows (Same as device, Classic, Light, Dark). A tap applies it at
 * once; there is no Save. Each row is a radio: its dots (the page, the card and the accent, read from the colour library for
 * that look, so the swatch cannot drift from the real colours), its name, a line under it, and a tick when it is the
 * chosen one. The chosen row also has a border in the heading's ink, so the choice never rests on colour alone.
 *
 * Keyboard: the group is one tab stop, on the chosen row; the arrow keys, Home and End move to a row and choose it (the
 * way a native radio group does). A screen reader hears the name, then the line as its description, then "selected".
 * Rows are at least 48 px tall, full width, and wrap their words (320 px wide at 1.3x text: the dots overlap, like a stack of
 * avatars, so the words keep the room, in a column as wide for every row so the names line up). The dots and the tick are decoration and are hidden from a screen reader.
 */
export function AppearanceChoice({ value, onChange }: { value: ThemePreference; onChange: (next: ThemePreference) => void }) {
    const id = useId();
    const rows = useRef<Array<HTMLButtonElement | null>>([]);

    const move = (to: number) => {
        const count = THEME_PREFERENCE_OPTIONS.length;
        const index = (to + count) % count;
        onChange(THEME_PREFERENCE_OPTIONS[index].value);
        rows.current[index]?.focus();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const at = THEME_PREFERENCE_OPTIONS.findIndex(o => o.value === value);
        switch (e.key) {
            case 'ArrowDown': case 'ArrowRight': move(at + 1); break;
            case 'ArrowUp': case 'ArrowLeft': move(at - 1); break;
            case 'Home': move(0); break;
            case 'End': move(THEME_PREFERENCE_OPTIONS.length - 1); break;
            default: return;
        }
        e.preventDefault();
    };

    return (
        <div role="radiogroup" aria-label={t('Appearance')} onKeyDown={onKeyDown} className="mt-3 space-y-1.5">
            {THEME_PREFERENCE_OPTIONS.map((option, i) => {
                const selected = value === option.value;
                const nameId = `${id}-name-${option.value}`;
                const lineId = `${id}-line-${option.value}`;
                return (
                    <button
                        key={option.value}
                        ref={el => { rows.current[i] = el; }}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-labelledby={nameId}
                        aria-describedby={lineId}
                        // Only the chosen row is a tab stop; the arrow keys do the rest. (Nothing chosen cannot happen: a value
                        // this build does not know is read as Classic before it gets here.)
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onChange(option.value)}
                        className={`w-full min-h-[48px] flex items-center gap-2.5 px-3 py-2 rounded-xl border-2 text-left cursor-pointer transition-colors ${selected
                            ? 'border-nature-900 dark:border-white bg-nature-100 dark:bg-nature-800'
                            : 'border-nature-200 dark:border-nature-800 bg-transparent'}`}
                    >
                        <span aria-hidden="true" data-testid="appearance-dots" className="flex shrink-0 items-center -space-x-1.5 w-[30px]">
                            {lookSwatchSets(option.value).flatMap(set => {
                                const dots = brandSwatch(set, 'web');
                                const own = lookSwatchSets(option.value).length === 1;
                                // One look shows three dots (page, card, accent); Same as device shows the two pages.
                                return (own ? [dots.page, dots.card, dots.accent] : [dots.page]).map((hex, d) => (
                                    <span key={`${set}-${d}`} className="inline-block w-3.5 h-3.5 rounded-full border border-nature-400" style={{ backgroundColor: hex }} />
                                ));
                            })}
                        </span>
                        <span className="flex-1 min-w-0">
                            <span id={nameId} className="block text-[14px] leading-tight font-bold text-nature-900 dark:text-white break-words">{t(option.label)}</span>
                            <span id={lineId} className="block text-xs leading-snug text-nature-700 dark:text-nature-300 break-words">{t(option.line)}</span>
                        </span>
                        <span aria-hidden="true" className="shrink-0 w-4 text-center text-base font-bold text-nature-900 dark:text-white">{selected ? '✓' : ''}</span>
                    </button>
                );
            })}
        </div>
    );
}
