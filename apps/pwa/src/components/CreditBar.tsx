/**
 * CreditBar (web): the member's own credit card on the Ledger (DESIGN-credit-bar-amend-fable.md, slice R1; Marty, 14 Nov
 * 2026). The rainbow stays: same track, same dot, same label above it. Around it: two sentences with the totals, the limit
 * at the bar's left end, "+200" at its own place, a word or two under each mark (and its one line from 640 px wide), the
 * strip under the left half that shows what the line is made of (solid: earned by trading; outlined: someone stands
 * behind it), stripes over the part Offers have not opened, one note, and the parts line, always the whole line.
 *
 * Every figure and sentence comes from core's credit-standing.ts, the same as the phone's card: nothing is composed here.
 * The whole card is one button, never a meter (F11): its label is core's spoken sentence; the drawing is hidden from screen
 * readers. Colours: the rainbow is core's picture (CREDIT_RAINBOW); everything else a library role as a CSS variable.
 */
import {
    CREDIT_RAINBOW,
    creditBarPicture,
    creditLabelColours,
    creditMeterCss,
    creditNoteColours,
    creditStandingCard,
    type CreditStandingAnswer,
} from '@beanpool/core';

const METER = creditMeterCss();
const RAINBOW = `linear-gradient(90deg, ${CREDIT_RAINBOW.stops.map((c, i) => `${c} ${Math.round(CREDIT_RAINBOW.at[i]! * 100)}%`).join(', ')})`;
/** The closed part: stripes in the card's own colour, with one edge. */
const STRIPES = 'repeating-linear-gradient(45deg, var(--bg-card) 0 5px, transparent 5px 10px)';

interface Props {
    /** The member's own balance answer (every money field whole hundredths), and `vouchedBy` beside it. */
    answer: CreditStandingAnswer;
    /** What a tap opens. */
    onOpen?: () => void;
    className?: string;
}

export function CreditBar({ answer, onOpen, className = '' }: Props) {
    const card = creditStandingCard(answer);
    const pic = creditBarPicture(answer);
    const label = creditLabelColours(pic.tone, METER);
    const note = card.note ? { ...card.note, ...creditNoteColours(card.note.tone, METER) } : null;
    const { limit, zero, fee } = pic.marks;
    return (
        <button
            type="button"
            onClick={onOpen}
            aria-label={card.spoken}
            data-testid="credit-card"
            className={`block w-full min-h-[44px] text-left bg-transparent border-0 p-0 m-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${className}`}
        >
            <span className="flex items-start justify-between gap-2">
                <span className="text-base leading-tight font-extrabold text-nature-950 dark:text-white" data-testid="credit-headline">{card.headline}</span>
                {/* The small "i": the card is a button. Drawn by CSS, so no letter sits outside the words layer. */}
                <span aria-hidden="true" data-testid="credit-info" className="shrink-0 w-5 h-5 rounded-full border-[1.5px] border-solid border-nature-600 dark:border-nature-300 text-nature-600 dark:text-nature-300 text-xs leading-[1.0625rem] text-center italic font-bold font-serif after:content-['i']" />
            </span>
            <span className="block mt-1 text-[0.84375rem] leading-snug text-nature-700 dark:text-nature-200" data-testid="credit-sentence">{card.sentence}</span>

            {/* The drawing: hidden from screen readers, whose label above says it all. */}
            <span aria-hidden="true" className="block relative mt-2 pt-7 select-none" data-testid="credit-drawing">
                <span className="block relative h-[15px] rounded-[9px]" style={{ background: RAINBOW }}>
                    <span className="absolute inset-0 rounded-[9px] overflow-hidden">
                        {pic.stripes && (
                            <span
                                className="absolute top-0 bottom-0"
                                data-testid="credit-stripes"
                                style={{ left: `${pic.stripes.from}%`, width: `${pic.stripes.width}%`, background: STRIPES, borderRight: '2px solid var(--bg-card)' }}
                            />
                        )}
                    </span>
                    <span className="absolute top-[-3px] bottom-[-3px] w-[2px] -ml-px" style={{ left: '50%', background: CREDIT_RAINBOW.zeroLine }} />
                    <span
                        className="absolute top-1/2 w-[18px] h-[18px] -mt-[9px] -ml-[9px] rounded-full border-4 border-solid z-[2] motion-safe:transition-[left] motion-safe:duration-300"
                        style={{ left: `${pic.dot}%`, background: CREDIT_RAINBOW.dot, borderColor: CREDIT_RAINBOW.ring, boxShadow: '0 2px 5px rgba(0,0,0,0.28)' }}
                    />
                </span>

                {/* The label above the dot, kept inside the card at either end; its pointer stays over the dot. */}
                <span
                    className="absolute top-0 px-2 py-[3px] rounded-[7px] text-xs font-bold whitespace-nowrap tabular-nums z-[3]"
                    style={{ left: `${pic.dot}%`, transform: `translateX(-${pic.dot}%)`, background: label.fill, color: label.on }}
                    data-testid="credit-label"
                >
                    {pic.label}
                    <span
                        className="absolute bottom-[-4px] w-0 h-0"
                        style={{ left: `clamp(8px, ${pic.dot}%, calc(100% - 8px))`, transform: 'translateX(-50%)', borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: `5px solid ${label.fill}` }}
                    />
                </span>

                {/* The strip under the left half, to scale; the +200 stem under the right. */}
                <span className="block relative h-[9px] mt-[5px]" data-testid="credit-strip">
                    {pic.blocks.map((b, i) => (
                        <span
                            key={i}
                            data-kind={b.kind}
                            className="absolute top-0 bottom-0 rounded-sm"
                            style={{
                                left: `calc(${b.from}% + 1px)`,
                                width: `calc(${b.width}% - 2px)`,
                                ...(b.solid ? { background: METER.strip } : { border: `1.5px solid ${METER.strip}` }),
                            }}
                        />
                    ))}
                    <span className="absolute top-[-5px] h-[14px] w-[2px] -ml-px" style={{ left: `${fee.at}%`, background: METER.feeInk }} />
                </span>

                {/* The figures at their marks, then a word or two under each (and each mark's line from 640 px wide). */}
                <span className="block relative h-4 mt-[3px] text-xs leading-4 font-bold tabular-nums whitespace-nowrap">
                    {limit.figure && <span className="absolute top-0 left-0" style={{ color: METER.limitInk }}>{limit.figure}</span>}
                    <span className="absolute top-0 -translate-x-1/2" style={{ left: `${zero.at}%`, color: METER.zeroInk }}>⚖️ {zero.figure}</span>
                    <span className="absolute top-0 -translate-x-1/2" style={{ left: `${fee.at}%`, color: METER.feeInk }}>{fee.figure}</span>
                </span>
                {/* Narrow: the middle word takes its own width, up to 40 % (so "balanced" is never cut inside the word),
                    and the sides share the rest equally, so it stays under 0. From 640 px wide: fixed columns, each with
                    its mark's line. */}
                <span className="grid grid-cols-[minmax(0,1fr)_fit-content(40%)_minmax(0,1fr)] sm:grid-cols-[36%_28%_36%] mt-px text-xs leading-tight text-nature-600 dark:text-nature-300">
                    <span className="min-w-0 [overflow-wrap:break-word] pr-1">{limit.words}<span className="hidden sm:block mt-[3px]">{limit.line}</span></span>
                    <span className="min-w-0 [overflow-wrap:break-word] text-center px-1.5">{zero.words}<span className="hidden sm:block mt-[3px]">{zero.line}</span></span>
                    <span className="min-w-0 [overflow-wrap:break-word] pl-1.5">{fee.words}<span className="hidden sm:block mt-[3px]">{fee.line}</span></span>
                </span>
            </span>

            {note && (
                <span className="flex gap-2 items-start mt-2.5 px-2.5 py-2 rounded-[9px] text-[0.78125rem] leading-snug" style={{ background: note.tint, color: note.ink }} data-testid="credit-note">
                    <span aria-hidden="true" className="shrink-0 font-extrabold min-w-[1.1em] text-center">{note.icon}</span>
                    <span>{note.text}</span>
                </span>
            )}
            {card.parts && (
                <span className="block mt-2.5 pt-2 border-0 border-t border-solid border-nature-200 dark:border-nature-800 text-[0.78125rem] leading-normal text-nature-700 dark:text-nature-200" data-testid="credit-parts">
                    {card.parts}
                </span>
            )}
        </button>
    );
}
