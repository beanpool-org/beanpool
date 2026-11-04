/**
 * The cards with nothing to show now, in Arrange (DESIGN-home-arrange-in-place-fable.md §2.4, slice A1): one quiet block,
 * a full row of the grid, under the last card Home draws and before the + Add a card tile. A card that is on the member's
 * list but has nothing to say today is not in the grid, so the cards a member sees are the cards they move; here it keeps
 * its saved place and is drawn there the day it has something. Each row is the card's name and, where there is one,
 * what it would say ("All tips seen"), then Settings… (a type that has them) and Remove, each a 48 px target with the
 * full label a screen reader reads. No arrows: a card you can't see is not moved.
 */
import { useId } from 'react';
import { t } from '@beanpool/core';
import { PackedBlock } from './HomeCard';

export interface StripRow {
    id: string;
    /** The card's name as the screen reader says it: a saved search by its words (lib/home-layout.ts `cardLabelName`). */
    name: string;
    /** What the card would say now ("All tips seen", the sun and moon's own line); absent: nothing. */
    note?: string;
    /** The type has settings, so Settings… is offered. */
    hasSettings: boolean;
}

interface Props {
    rows: readonly StripRow[];
    onSettings: (id: string) => void;
    onRemove: (id: string) => void;
    /** The packed child's height, for the grid (absent at one column, where nothing is packed). */
    onHeight?: (height: number) => void;
    style?: React.CSSProperties;
}

const ACTION = 'min-h-[48px] min-w-[48px] px-2 bg-transparent border-0 text-sm font-bold text-text-secondary hover:text-text-primary cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

export function ArrangeStrip({ rows, onSettings, onRemove, onHeight, style }: Props) {
    const headingId = useId();
    return (
        <PackedBlock tag="div" onHeight={onHeight} data-testid="home-arrange-strip" style={style} className="mb-3 min-w-0">
            {/* A surface of its own, so its words never sit on the page's pattern; dashed, like the tile, because it is a place and no card. */}
            <section aria-labelledby={headingId} className="rounded-2xl border border-dashed border-border-primary bg-bg-card px-4 pt-3 pb-1 min-w-0">
                <h2 id={headingId} className="m-0 mb-1 text-[0.7rem] font-extrabold uppercase tracking-wider text-text-secondary break-words">{t('Nothing to show now')}</h2>
                <ul className="m-0 p-0 list-none">
                    {rows.map(row => (
                        <li key={row.id} data-testid={`home-arrange-strip-row-${row.id}`} className="py-1 flex flex-wrap items-center justify-between gap-x-2 min-w-0 min-h-[48px]">
                            <span className="min-w-0 flex-1 basis-24 break-words text-sm font-semibold text-text-primary">
                                {row.name}
                                {row.note && <span data-testid={`home-arrange-strip-note-${row.id}`} className="block text-xs font-normal text-text-secondary">{row.note}</span>}
                            </span>
                            <span className="ml-auto flex flex-wrap items-center justify-end gap-x-1 min-w-0">
                                {row.hasSettings && (
                                    <button type="button" className={ACTION} data-testid={`home-arrange-settings-${row.id}`} aria-label={t('Settings for {card}', { card: row.name })} onClick={() => onSettings(row.id)}>{t('Settings…')}</button>
                                )}
                                <button type="button" className={ACTION} data-testid={`home-arrange-remove-${row.id}`} aria-label={t('Remove {card} from Home', { card: row.name })} onClick={() => onRemove(row.id)}>{t('Remove')}</button>
                            </span>
                        </li>
                    ))}
                </ul>
            </section>
        </PackedBlock>
    );
}
