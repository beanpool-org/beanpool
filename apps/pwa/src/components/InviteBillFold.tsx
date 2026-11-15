/**
 * The invite panel's bill fold (DESIGN-getting-paid-fable.md §4.5, slice B3), as on the phone (components/InviteBillFold.tsx):
 * "Add a bill for them (optional)", folded. Open, what it is for and how many Beans, the send sheet's own labels (core
 * billLines), what the maker receives after the 1.5% once the amount reads as one, and that nothing is taken by itself.
 * Whoever joins with the invite is its payer; the node checks every rule again. Shown only where bills are on, and never for
 * an offline ticket (the page refuses that).
 *
 * Every control is at least 44 px and wraps at 320 px with 130% text; an amount is never clipped.
 */
import { billLines, inviteBillFromForm, inviteBillLines } from '@beanpool/core';

export interface InviteBillFoldProps {
    open: boolean;
    onOpen: (open: boolean) => void;
    whatFor: string;
    onWhatFor: (text: string) => void;
    beans: string;
    onBeans: (text: string) => void;
}

const INPUT = 'w-full min-h-[44px] p-3 rounded-xl border border-nature-200 dark:border-nature-500 bg-white dark:bg-nature-900 text-nature-950 dark:text-white text-[15px] font-medium mb-3 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none';
const LABEL = 'block mb-1 text-[14px] font-bold text-nature-950 dark:text-white';
const LINE = 'm-0 mb-1 text-[13px] leading-snug text-nature-600 dark:text-nature-300 break-words';

export function InviteBillFold({ open, onOpen, whatFor, onWhatFor, beans, onBeans }: InviteBillFoldProps) {
    const read = inviteBillFromForm(whatFor, beans);
    return (
        <div className="mb-4 min-w-0" data-testid="invite-bill-fold">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => onOpen(!open)}
                className="w-full min-h-[44px] px-1 text-left text-[14px] font-bold text-nature-950 dark:text-white bg-transparent border-0 cursor-pointer break-words"
                data-testid="invite-bill-toggle"
            >
                {open ? '▾ ' : '▸ '}{inviteBillLines.fold()}
            </button>
            {open && (
                <div className="mt-2">
                    <label className={LABEL} htmlFor="invite-bill-what-for">{billLines.whatForLabel()}</label>
                    <input id="invite-bill-what-for" type="text" value={whatFor} maxLength={80} onChange={(e) => onWhatFor(e.target.value)} className={INPUT} data-testid="invite-bill-what-for" />
                    <label className={LABEL} htmlFor="invite-bill-beans">{billLines.amountLabel()}</label>
                    <input id="invite-bill-beans" type="text" inputMode="decimal" value={beans} onChange={(e) => onBeans(e.target.value)} className={INPUT} data-testid="invite-bill-beans" />
                    {read.bill && <p className={LINE} data-testid="invite-bill-receive">{billLines.youReceive(read.bill.amount_c)}</p>}
                    <p className={LINE}>{inviteBillLines.theyChoose()}</p>
                </div>
            )}
        </div>
    );
}
