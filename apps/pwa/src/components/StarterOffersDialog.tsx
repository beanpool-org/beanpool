/**
 * What could you offer? (scratch/fable-design/DESIGN-cold-start-trades-fable.md §3.1, slice O2): what "Post your first
 * Offer" on First steps opens, the phone's sheet (components/home/StarterOffersSheet.tsx) in Home's dialog. Three rows drawn
 * from the categories the member starred (core `starterSheet`, the same rows the phone draws), each a title and, where Beans
 * show, its price from the community's guide; a tap opens the composer with that draft filled in (`openComposer`, the
 * tools' door). "Something else" is the blank composer, and Cancel is always there.
 *
 * A door, not a form: nothing is posted, saved or sent here, and it never says so. The photo, the place and Post are the
 * composer's and the member's (market-photos-mandatory). It asks for no browser permission. A real dialog like the
 * picker's: `role="dialog"`, labelled by its heading, focus moved in and kept there, Escape closes it, focus goes back to
 * what opened it (components/dialog-focus.ts). Every control is at least 44 px.
 */
import { useRef } from 'react';
import { t, type StarterRow, type StarterSheet } from '@beanpool/core';
import { HomeLine } from './HomeCard';
import { Shell } from './AddCardDialog';
import { useDialogFocus } from './dialog-focus';

function Row({ emoji, title, price, label, testId, onClick }: {
    emoji: string; title: string; price?: string | null; label: string; testId: string; onClick: () => void;
}) {
    return (
        <li className="border-b border-nature-100 dark:border-nature-800 last:border-b-0 px-3 min-w-0">
            <HomeLine onClick={onClick} label={label} testId={testId}>
                <span aria-hidden="true" className="shrink-0 w-8 text-center text-xl">{emoji}</span>
                <span className="flex-1 min-w-0 break-words">
                    <span className="block font-semibold">{title}</span>
                    {price ? <span data-testid={`${testId}-price`} className="block text-xs text-text-secondary">{price}</span> : null}
                </span>
                <span aria-hidden="true" className="shrink-0 text-text-secondary">›</span>
            </HomeLine>
        </li>
    );
}

export function StarterOffersDialog({ sheet, onPick, onOther, onClose, returnFocus }: {
    sheet: StarterSheet;
    onPick: (row: StarterRow) => void;
    /** "Something else": the blank composer. */
    onOther: () => void;
    onClose: () => void;
    /** Where focus goes on close when what opened the dialog has gone. */
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose, { fallback: returnFocus });
    return (
        <Shell id="home-starter-title" testId="home-starter-dialog" title={sheet.title} onClose={onClose} dialog={dialog} closeText={t('Cancel')}>
            <p data-testid="home-starter-note" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-200">{sheet.note}</p>
            <ul className="list-none m-0 p-0 rounded-xl border border-nature-200 dark:border-nature-800">
                {sheet.rows.map((row) => (
                    <Row key={row.id} emoji={row.emoji} title={row.title} price={row.price} label={row.label} testId={`home-starter-${row.id}`} onClick={() => onPick(row)} />
                ))}
                <Row emoji="✏️" title={sheet.other.title} label={sheet.other.label} testId="home-starter-other" onClick={onOther} />
            </ul>
        </Shell>
    );
}
