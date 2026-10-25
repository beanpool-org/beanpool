/**
 * The dialogs of Your shop (parity with apps/native/components/shop/ShopSheets.tsx):
 * one field at a time (name, blurb, how I deal), its category, Close for now,
 * Close my shop, and Add my live Offers.
 *
 * Fully accessible: role="dialog", aria-modal="true", focus trapped inside, Escape closes,
 * focus returns on close (using the window capture keydown pattern PictureCropDialog uses).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
    SHOP_BLURB_LIMIT, SHOP_CATEGORIES, SHOP_HOW_TO_DEAL_LIMIT, SHOP_NAME_LIMIT, t,
    type ShopCategory,
} from '@beanpool/core';
import { backOnChoices, shopCategoryLabel, type BackOnChoice, type ShopListing } from '../../lib/shop';

export interface ShopSheetRefusal {
    message: string;
    code?: string;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface BaseDialogProps {
    open: boolean;
    title: string;
    onClose: () => void;
    testId: string;
    children: ReactNode;
}

function BaseShopDialog({ open, title, onClose, testId, children }: BaseDialogProps) {
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        if (!open) return;
        const opener = document.activeElement as HTMLElement | null;
        // Focus input/textarea if present, else first focusable element inside the dialog
        const initial = dialogRef.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])')
            ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
        initial?.focus();
        return () => {
            if (opener && opener !== document.body && opener.isConnected) {
                opener.focus?.();
            }
        };
    }, [open]);

    const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
    onKey.current = (e: KeyboardEvent) => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
        }
        if (e.key !== 'Tab') return;
        const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const at = document.activeElement;
        if (!at || !dialog.contains(at)) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && at === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && at === last) {
            e.preventDefault();
            first.focus();
        }
    };

    useEffect(() => {
        if (!open) return;
        const listen = (e: KeyboardEvent) => onKey.current(e);
        window.addEventListener('keydown', listen, true);
        return () => window.removeEventListener('keydown', listen, true);
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div
            className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-4 min-w-0"
            style={{ zIndex: 1200, background: 'rgba(0,0,0,0.6)' }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-testid={testId}
                tabIndex={-1}
                className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto outline-none bg-white dark:bg-nature-950 rounded-t-2xl sm:rounded-2xl shadow-2xl p-4 min-w-0 flex flex-col gap-4 text-nature-900 dark:text-white"
            >
                <div className="flex items-center justify-between gap-2 border-b border-nature-200 dark:border-nature-800 pb-2 min-w-0">
                    <h2 id={titleId} className="m-0 text-lg font-bold text-nature-900 dark:text-white break-words line-clamp-2">
                        {title}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        data-testid={`${testId.replace(/-sheet$/, '')}-cancel`}
                        className="min-h-[44px] min-w-[44px] px-2 bg-transparent border-0 text-sm font-bold text-bp-ink-brand hover:opacity-80 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                    >
                        {t('Cancel')}
                    </button>
                </div>
                <div className="flex flex-col gap-3 min-w-0">{children}</div>
            </div>
        </div>,
        document.body
    );
}

function RefusalBox({
    refusal,
    testId,
    onDeals,
}: {
    refusal: ShopSheetRefusal | null | undefined;
    testId: string;
    onDeals?: () => void;
}) {
    if (!refusal) return null;
    return (
        <div className="flex flex-col gap-2 mt-2">
            <p data-testid={`${testId}-error`} className="m-0 text-sm font-semibold text-bp-ink-danger break-words">
                {refusal.message}
            </p>
            {refusal.code === 'shop_deals_open' && onDeals ? (
                <button
                    type="button"
                    onClick={onDeals}
                    data-testid={`${testId}-deals`}
                    className="min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-sm font-bold text-nature-900 dark:text-white cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                >
                    {t('Open my deals')}
                </button>
            ) : null}
        </div>
    );
}

// ── Text Dialog (Name · Blurb · How I deal) ───────────────────────────────────────────────────────

export type ShopTextField = 'name' | 'blurb' | 'howToDeal';

function fieldWords(field: ShopTextField, defaultName: string): { title: string; note: string; limit: number; multiline: boolean } {
    if (field === 'name') {
        return {
            title: t("Your shop's name"),
            note: t('Leave it empty and it is called "{name}".', { name: defaultName }),
            limit: SHOP_NAME_LIMIT.chars,
            multiline: false,
        };
    }
    if (field === 'blurb') {
        return {
            title: t('About your shop'),
            note: t('What it is, in a few words.'),
            limit: SHOP_BLURB_LIMIT.chars,
            multiline: true,
        };
    }
    return {
        title: t('How I deal'),
        note: t('Where to pick up, and when things come back.'),
        limit: SHOP_HOW_TO_DEAL_LIMIT.chars,
        multiline: true,
    };
}

export function ShopTextDialog({
    field,
    value,
    defaultName,
    busy,
    refusal,
    onSave,
    onClose,
}: {
    field: ShopTextField | null;
    value: string;
    defaultName: string;
    busy: boolean;
    refusal: ShopSheetRefusal | null | undefined;
    onSave: (text: string | null) => void;
    onClose: () => void;
}) {
    const [textValue, setTextValue] = useState(value);
    useEffect(() => {
        if (field) setTextValue(value);
    }, [field, value]);

    if (!field) return null;
    const w = fieldWords(field, defaultName);

    return (
        <BaseShopDialog open={!!field} title={w.title} onClose={onClose} testId="shop-text-sheet">
            <div className="flex flex-col gap-2 min-w-0">
                {w.multiline ? (
                    <textarea
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        maxLength={w.limit}
                        rows={4}
                        aria-label={w.title}
                        data-testid="shop-text-input"
                        className="w-full min-w-0 min-h-[110px] p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-nature-50 dark:bg-nature-900 text-nature-900 dark:text-white text-base resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                    />
                ) : (
                    <input
                        type="text"
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        maxLength={w.limit}
                        aria-label={w.title}
                        data-testid="shop-text-input"
                        className="w-full min-w-0 min-h-[48px] px-3 py-2 rounded-xl border border-nature-300 dark:border-nature-700 bg-nature-50 dark:bg-nature-900 text-nature-900 dark:text-white text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                    />
                )}
                <p className="m-0 text-xs text-nature-600 dark:text-nature-300 break-words">{w.note}</p>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSave(textValue.trim() ? textValue.trim() : null)}
                    data-testid="shop-text-save"
                    className="min-h-[48px] mt-2 px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                    {busy ? t('Saving…') : t('Save')}
                </button>
                <RefusalBox refusal={refusal} testId="shop-text" />
            </div>
        </BaseShopDialog>
    );
}

// ── Category Dialog ───────────────────────────────────────────────────────────────────────────────

export function ShopCategoryDialog({
    open,
    category,
    busy,
    refusal,
    onPick,
    onClose,
}: {
    open: boolean;
    category: ShopCategory | null;
    busy: boolean;
    refusal: ShopSheetRefusal | null | undefined;
    onPick: (category: ShopCategory | null) => void;
    onClose: () => void;
}) {
    return (
        <BaseShopDialog open={open} title={t('Category')} onClose={onClose} testId="shop-category-sheet">
            <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                {t('It helps neighbours find you, and picks the tools shown. It changes nothing else.')}
            </p>
            <div role="radiogroup" aria-label={t('Category')} className="flex flex-wrap gap-2 min-w-0">
                {SHOP_CATEGORIES.map((c) => {
                    const on = category === c;
                    return (
                        <button
                            key={c}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={busy}
                            onClick={() => onPick(c)}
                            data-testid={`shop-category-pick-${c}`}
                            className={`min-h-[48px] px-4 rounded-full border text-sm font-semibold break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand ${
                                on
                                    ? 'bg-bp-commit-fill text-bp-commit-on border-transparent'
                                    : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700 hover:bg-nature-50 dark:hover:bg-nature-800'
                            }`}
                        >
                            {shopCategoryLabel(c)}
                        </button>
                    );
                })}
                <button
                    type="button"
                    role="radio"
                    aria-checked={category === null}
                    disabled={busy}
                    onClick={() => onPick(null)}
                    data-testid="shop-category-pick-none"
                    className={`min-h-[48px] px-4 rounded-full border text-sm font-semibold break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand ${
                        category === null
                            ? 'bg-bp-commit-fill text-bp-commit-on border-transparent'
                            : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700 hover:bg-nature-50 dark:hover:bg-nature-800'
                    }`}
                >
                    {t('None')}
                </button>
            </div>
            <RefusalBox refusal={refusal} testId="shop-category" />
        </BaseShopDialog>
    );
}

// ── Close for now Dialog ──────────────────────────────────────────────────────────────────────────

export function ShopPauseDialog({
    open,
    busy,
    refusal,
    onPause,
    onClose,
    onDeals,
}: {
    open: boolean;
    busy: boolean;
    refusal: ShopSheetRefusal | null | undefined;
    onPause: (backOn: string | null) => void;
    onClose: () => void;
    onDeals?: () => void;
}) {
    const [back, setBack] = useState<BackOnChoice>('none');
    useEffect(() => {
        if (open) setBack('none');
    }, [open]);

    const choices = backOnChoices(new Date());

    return (
        <BaseShopDialog open={open} title={t('Close for now')} onClose={onClose} testId="shop-pause-sheet">
            <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                {t('Its Offers come off the Market and wait. Nothing goes in while it is closed. One tap reopens it.')}
            </p>
            <div className="font-bold text-sm text-nature-900 dark:text-white mt-1">{t('Say when you are back')}</div>
            <div role="radiogroup" aria-label={t('Say when you are back')} className="flex flex-wrap gap-2 min-w-0">
                {choices.map((c) => {
                    const on = back === c.id;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => setBack(c.id)}
                            data-testid={`shop-back-${c.id}`}
                            className={`min-h-[48px] px-4 rounded-full border text-sm font-semibold break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand ${
                                on
                                    ? 'bg-bp-commit-fill text-bp-commit-on border-transparent'
                                    : 'bg-white dark:bg-nature-900 text-nature-800 dark:text-nature-100 border-nature-300 dark:border-nature-700 hover:bg-nature-50 dark:hover:bg-nature-800'
                            }`}
                        >
                            {c.label}
                        </button>
                    );
                })}
            </div>
            <button
                type="button"
                disabled={busy}
                onClick={() => onPause(choices.find((c) => c.id === back)?.day ?? null)}
                data-testid="shop-pause-go"
                className="min-h-[48px] mt-2 px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
                {t('Close for now')}
            </button>
            <RefusalBox refusal={refusal} testId="shop-pause" onDeals={onDeals} />
        </BaseShopDialog>
    );
}

// ── Close my shop Dialog ──────────────────────────────────────────────────────────────────────────

export function ShopCloseDialog({
    open,
    busy,
    refusal,
    onCloseShop,
    onClose,
    onDeals,
}: {
    open: boolean;
    busy: boolean;
    refusal: ShopSheetRefusal | null | undefined;
    onCloseShop: (endOffers: boolean) => void;
    onClose: () => void;
    onDeals?: () => void;
}) {
    const [end, setEnd] = useState(false);
    useEffect(() => {
        if (open) setEnd(false);
    }, [open]);

    return (
        <BaseShopDialog open={open} title={t('Close my shop')} onClose={onClose} testId="shop-close-sheet">
            <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                {t('Your shop goes. You can open a new one any time.')}
            </p>
            <div role="radiogroup" aria-label={t('Close my shop')} className="flex flex-col gap-2 min-w-0">
                <button
                    type="button"
                    role="radio"
                    aria-checked={!end}
                    onClick={() => setEnd(false)}
                    data-testid="shop-close-keep"
                    className={`flex items-center gap-3 min-h-[48px] p-3 rounded-xl border text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand ${
                        !end
                            ? 'border-bp-commit-fill bg-emerald-50/20 dark:bg-emerald-950/20'
                            : 'border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900'
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            !end ? 'border-bp-commit-fill' : 'border-nature-400 dark:border-nature-600'
                        }`}
                    >
                        {!end && <span className="w-2.5 h-2.5 rounded-full bg-bp-commit-fill" />}
                    </span>
                    <span className="text-sm font-semibold break-words flex-1">
                        {t('Keep its Offers in the Market, on their own')}
                    </span>
                </button>
                <button
                    type="button"
                    role="radio"
                    aria-checked={end}
                    onClick={() => setEnd(true)}
                    data-testid="shop-close-end"
                    className={`flex items-center gap-3 min-h-[48px] p-3 rounded-xl border text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand ${
                        end
                            ? 'border-bp-commit-fill bg-emerald-50/20 dark:bg-emerald-950/20'
                            : 'border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900'
                    }`}
                >
                    <span
                        aria-hidden="true"
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            end ? 'border-bp-commit-fill' : 'border-nature-400 dark:border-nature-600'
                        }`}
                    >
                        {end && <span className="w-2.5 h-2.5 rounded-full bg-bp-commit-fill" />}
                    </span>
                    <span className="text-sm font-semibold break-words flex-1">
                        {t('End its Offers too')}
                    </span>
                </button>
            </div>
            <button
                type="button"
                disabled={busy}
                onClick={() => onCloseShop(end)}
                data-testid="shop-close-go"
                className="min-h-[48px] mt-2 px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
                {t('Close my shop')}
            </button>
            <RefusalBox refusal={refusal} testId="shop-close" onDeals={onDeals} />
        </BaseShopDialog>
    );
}

// ── Add my live Offers Dialog ─────────────────────────────────────────────────────────────────────

export function ShopAddOffersDialog({
    open,
    offers,
    busy,
    refusal,
    onAdd,
    onClose,
}: {
    open: boolean;
    offers: ShopListing[] | null | undefined;
    busy: boolean;
    refusal: ShopSheetRefusal | null | undefined;
    onAdd: (postIds: string[]) => void;
    onClose: () => void;
}) {
    const [picked, setPicked] = useState<string[]>([]);
    useEffect(() => {
        if (open) setPicked([]);
    }, [open]);

    const flip = (id: string) => {
        setPicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]));
    };

    return (
        <BaseShopDialog open={open} title={t('Add my live Offers')} onClose={onClose} testId="shop-add-sheet">
            {offers === undefined ? (
                <p className="m-0 text-sm text-nature-600 dark:text-nature-300 break-words">{t('Reading your Offers…')}</p>
            ) : null}
            {offers === null ? (
                <p data-testid="shop-add-unread" className="m-0 text-sm text-bp-ink-danger break-words">
                    {t("Your Offers couldn't be read just now. Try again.")}
                </p>
            ) : null}
            {offers && offers.length === 0 ? (
                <p data-testid="shop-add-empty" className="m-0 text-sm text-nature-600 dark:text-nature-300 break-words">
                    {t('Every live Offer of yours for everyone here is in your shop already.')}
                </p>
            ) : null}
            {offers && offers.length > 0 ? (
                <div className="flex flex-col gap-2 min-w-0">
                    <p className="m-0 text-sm text-nature-700 dark:text-nature-200 break-words">
                        {t('Tick the Offers to put in your shop. Only Offers for everyone here can go in.')}
                    </p>
                    <div className="flex flex-col divide-y divide-nature-200 dark:divide-nature-800 max-h-60 overflow-y-auto">
                        {offers.map((o) => {
                            const on = picked.includes(o.id);
                            return (
                                <button
                                    key={o.id}
                                    type="button"
                                    role="checkbox"
                                    aria-checked={on}
                                    onClick={() => flip(o.id)}
                                    data-testid={`shop-add-${o.id}`}
                                    className="flex items-center gap-3 py-2.5 px-2 text-left bg-transparent border-0 cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-900 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`w-6 h-6 rounded-md border flex items-center justify-center font-bold text-sm shrink-0 ${
                                            on
                                                ? 'bg-bp-commit-fill border-transparent text-bp-commit-on'
                                                : 'border-nature-400 dark:border-nature-600 bg-white dark:bg-nature-950 text-transparent'
                                        }`}
                                    >
                                        ✓
                                    </span>
                                    <span className="text-sm text-nature-900 dark:text-white break-words line-clamp-2 flex-1">
                                        {o.title}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ) : null}
            <button
                type="button"
                disabled={busy || picked.length === 0}
                onClick={() => onAdd(picked)}
                data-testid="shop-add-go"
                className="min-h-[48px] mt-2 px-4 rounded-xl border-0 bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on text-base font-bold cursor-pointer disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
                {t('Put them in my shop')}
            </button>
            <RefusalBox refusal={refusal} testId="shop-add" />
        </BaseShopDialog>
    );
}
