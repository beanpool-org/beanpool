/**
 * "Your Beans and your credit line" (web): what a tap on the member's own credit card opens (DESIGN-credit-bar-amend-fable.md
 * §6, slice R2; Marty decided the amendment on 14 Nov 2026). One sheet, the same six parts as the phone's, every word and
 * figure from core's creditSheet(): reading the bar, the credit line part by part, earning, what can change it, the two fees,
 * who can see this. Nothing is composed here. A dialog as the app's others are (MyBudgetModal): named by its heading, focus in
 * on open and back to the card on close, Escape and the ✕ (44 × 44 px) close it. Colours: the rainbow is core's picture;
 * everything else a library role (CSS variables) or the page's own tokens, so it follows the look.
 */
import { useRef } from 'react';
import { CREDIT_RAINBOW, creditMeterCss, creditSheet, t, type CreditSheetMark, type CreditSheetRow, type CreditSheetEarning, type CreditStandingAnswer } from '@beanpool/core';
import { useDialogFocus } from './dialog-focus';
import { RAINBOW } from './CreditBar';

const METER = creditMeterCss();
const STRIPES = `repeating-linear-gradient(45deg, ${METER.strip} 0 2px, transparent 2px 5px)`;
/** The marks drawn as signs, not letters (never colour alone). */
const SIGN: Partial<Record<CreditSheetMark, string>> = { open: '✓', closed: '🔒', progress: '🌱' };

/** The small mark beside a row: the bar's own shapes, in its own colours. */
function Mark({ row }: { row: CreditSheetRow }) {
    const box = 'shrink-0 w-12 flex items-center justify-center min-h-[1.25rem]';
    switch (row.mark) {
        case 'dot':
            return <span className={box}><span className="w-3.5 h-3.5 rounded-full border-[3px] border-solid" style={{ background: CREDIT_RAINBOW.dot, borderColor: CREDIT_RAINBOW.ring }} /></span>;
        case 'zero':
        case 'limit':
        case 'fee': {
            const ink = row.mark === 'zero' ? METER.zeroInk : row.mark === 'limit' ? METER.limitInk : METER.feeInk;
            return <span className={`${box} text-xs font-bold tabular-nums whitespace-nowrap`} style={{ color: ink }}>{row.mark === 'zero' ? <>⚖️ {row.figure}</> : row.figure || '·'}</span>;
        }
        case 'strip':
            return (
                <span className={`${box} gap-1`}>
                    <span className="w-4 h-2.5 rounded-sm" style={{ background: METER.strip }} />
                    <span className="w-4 h-2.5 rounded-sm" style={{ border: `1.5px solid ${METER.strip}` }} />
                </span>
            );
        case 'solid':
            return <span className={box}><span className="w-5 h-2.5 rounded-sm" style={{ background: METER.strip }} /></span>;
        case 'outlined':
            return <span className={box}><span className="w-5 h-2.5 rounded-sm" style={{ border: `1.5px solid ${METER.strip}` }} /></span>;
        case 'stripes':
            return <span className={box}><span className="w-8 h-2.5 rounded-sm" style={{ background: STRIPES, border: `1px solid ${METER.strip}` }} /></span>;
        case 'colours':
            return <span className={box}><span className="w-10 h-2.5 rounded-full" style={{ background: RAINBOW }} /></span>;
        case 'left':
        case 'right':
            // The rainbow's own half: drawn twice as wide, with only that half showing.
            return <span className={box}><span className="w-6 h-2.5 rounded-full" style={{ background: RAINBOW, backgroundSize: '200% 100%', backgroundPosition: row.mark === 'left' ? 'left center' : 'right center' }} /></span>;
        case 'total':
            return <span className={box} />;
        default:
            return row.mark && SIGN[row.mark] ? <span className={`${box} text-sm font-extrabold`} style={{ color: METER.quietInk }}>{SIGN[row.mark]}</span> : <span className={box} />;
    }
}

export interface CreditSheetProps {
    answer: CreditStandingAnswer;
    earning?: CreditSheetEarning;
    onClose: () => void;
    /** "What people who give credit see ›": the member's own reading of it, on the Levels tab. None where it isn't drawn. */
    onGivers?: () => void;
    /** "More in the guide ›": the guide's credit-line page. */
    onGuide?: (slug: string) => void;
}

export function CreditSheet({ answer, earning, onClose, onGivers, onGuide }: CreditSheetProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    const sheet = creditSheet(answer, earning);
    const link = 'w-full min-h-[44px] text-left px-3 rounded-xl border border-solid border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-sm font-bold text-nature-900 dark:text-white flex items-center justify-between gap-2 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800';
    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="credit-sheet-title"
            data-testid="credit-sheet"
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-[560px] max-h-[88vh] overflow-y-auto p-5 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-2 mb-2">
                    <h2 id="credit-sheet-title" tabIndex={-1} className="m-0 text-base font-extrabold text-nature-950 dark:text-white outline-none">{sheet.title}</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] shrink-0 rounded-lg flex items-center justify-center text-base text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-0 cursor-pointer"
                        aria-label={t('Close')}
                    >
                        ✕
                    </button>
                </div>
                {sheet.parts.map((part, i) => (
                    <section key={part.id} data-testid={`credit-sheet-part-${part.id}`} className={`${i > 0 ? 'mt-4 pt-4 border-0 border-t border-solid border-nature-200 dark:border-nature-800' : ''}`}>
                        <h3 className="m-0 mb-2 text-sm font-extrabold text-nature-950 dark:text-white">
                            <span aria-hidden="true" className="mr-1.5 text-nature-500 dark:text-nature-300 tabular-nums">{i + 1}.</span>{part.title}
                        </h3>
                        <ul className="m-0 p-0 list-none flex flex-col gap-2">
                            {part.rows.map((row, j) => (
                                <li key={j} className="flex items-start gap-2" data-mark={row.mark ?? ''} data-kind={row.kind ?? ''}>
                                    {part.id !== 'who' && <span aria-hidden="true"><Mark row={row} /></span>}
                                    <span className="min-w-0 [overflow-wrap:anywhere]">
                                        <span className={`block text-[0.84375rem] leading-snug text-nature-800 dark:text-nature-100 ${row.mark === 'total' || row.kind ? 'font-bold' : ''}`}>{row.text}</span>
                                        {row.line && <span className="block mt-0.5 text-xs leading-snug text-nature-600 dark:text-nature-300">{row.line}</span>}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {part.id === 'who' && (
                            <div className="mt-3 flex flex-col gap-2">
                                {onGivers && (
                                    <button type="button" className={link} onClick={onGivers} data-testid="credit-sheet-givers">
                                        <span>{sheet.links.givers}</span><span aria-hidden="true">›</span>
                                    </button>
                                )}
                                {onGuide && (
                                    <button type="button" className={link} onClick={() => onGuide(sheet.links.guideSlug)} data-testid="credit-sheet-guide">
                                        <span>{sheet.links.guide}</span><span aria-hidden="true">›</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </section>
                ))}
            </div>
        </div>
    );
}
