/**
 * Voucher card modal (§5, §10, §11 on the web): opens when clicking a voucher row in the Vouchers block
 * on People → Invites. Shows their budget summary, the "Set budget to" control (quick levels 500 · 1,000 · 1,500 · 2,000
 * and 100-step stepper, raise or lower), Budget history, and See who they brought in.
 */
import { useEffect, useState, useRef } from 'react';
import { formatNumber, formatDate, t, tn } from '@beanpool/core';
import { getVoucherCard, setVoucherBudget, type VoucherCardData } from '../lib/api';
import { useDialogFocus } from './dialog-focus';

export interface VoucherCardModalProps {
    memberPubkey: string;
    onClose: () => void;
    onUpdated?: () => void;
}

const QUICK_LEVELS = [500, 1000, 1500, 2000];

export function VoucherCardModal({ memberPubkey, onClose, onUpdated }: VoucherCardModalProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);

    const [card, setCard] = useState<VoucherCardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [targetLevel, setTargetLevel] = useState<number>(1000);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'budget' | 'history' | 'people'>('budget');

    const load = async () => {
        try {
            setLoading(true);
            const data = await getVoucherCard(memberPubkey);
            setCard(data);
            setTargetLevel(data.level);
        } catch (e: any) {
            setError(e?.message || t('Failed to load voucher card'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
    }, [memberPubkey]);

    const handleSetBudget = async () => {
        if (!card) return;
        setSaving(true);
        setError(null);
        try {
            const updated = await setVoucherBudget(memberPubkey, targetLevel);
            setCard(updated);
            onUpdated?.();
        } catch (e: any) {
            setError(e?.message || e?.error || t('Could not set budget'));
        } finally {
            setSaving(false);
        }
    };

    const minLevel = card ? card.held : 100;
    const maxLevel = 2000;

    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[320] flex items-end sm:items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="voucher-card-title"
            data-testid="voucher-card-modal"
            onClick={onClose}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                }
            }}
        >
            <div className="absolute inset-0 bg-black/50" />
            <div
                className="relative w-full sm:max-w-[500px] max-h-[90vh] overflow-y-auto p-5 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                        <h2 id="voucher-card-title" tabIndex={-1} className="m-0 text-lg font-extrabold text-nature-950 dark:text-white outline-none">
                            {card?.callsign ? t('{name} · Voucher', { name: card.callsign }) : t('Voucher')}
                        </h2>
                        {card?.madeByCallsign && (
                            <p className="m-0 text-xs text-nature-500 dark:text-nature-400 mt-0.5">
                                {t('made a voucher by @{name}', { name: card.madeByCallsign })}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded-lg text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-0 cursor-pointer"
                        aria-label={t('Close')}
                    >
                        ✕
                    </button>
                </div>

                {loading ? (
                    <div className="p-8 text-center text-sm text-nature-500 dark:text-nature-400">
                        {t('Loading...')}
                    </div>
                ) : card ? (
                    <>
                        {/* Tabs */}
                        <div className="flex gap-2 border-b border-nature-200 dark:border-nature-800 pb-2 mb-4">
                            <button
                                type="button"
                                onClick={() => setActiveTab('budget')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-0 cursor-pointer transition-colors ${
                                    activeTab === 'budget'
                                        ? 'bg-bp-commit-fill text-bp-commit-on'
                                        : 'bg-transparent text-nature-600 dark:text-nature-400 hover:bg-nature-200/50 dark:hover:bg-nature-800'
                                }`}
                            >
                                {t('Their budget')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('history')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-0 cursor-pointer transition-colors ${
                                    activeTab === 'history'
                                        ? 'bg-bp-commit-fill text-bp-commit-on'
                                        : 'bg-transparent text-nature-600 dark:text-nature-400 hover:bg-nature-200/50 dark:hover:bg-nature-800'
                                }`}
                            >
                                {t('Budget history ({count})', { count: card.history.length })}
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveTab('people')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-0 cursor-pointer transition-colors ${
                                    activeTab === 'people'
                                        ? 'bg-bp-commit-fill text-bp-commit-on'
                                        : 'bg-transparent text-nature-600 dark:text-nature-400 hover:bg-nature-200/50 dark:hover:bg-nature-800'
                                }`}
                            >
                                {t('See who they brought in ({count})', { count: card.people.length })}
                            </button>
                        </div>

                        {error && (
                            <div role="alert" className="p-3 mb-4 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs font-bold text-red-700 dark:text-red-300">
                                {error}
                            </div>
                        )}

                        {activeTab === 'budget' && (
                            <div className="space-y-4">
                                {/* Budget stats */}
                                <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 space-y-1.5 text-xs text-nature-700 dark:text-nature-300">
                                    <div className="text-sm font-extrabold text-nature-950 dark:text-white pb-1 border-b border-nature-100 dark:border-nature-800">
                                        {t('{left} of {total} left', { left: formatNumber(card.left), total: formatNumber(card.level) })}
                                    </div>
                                    <div>{t('Vouched {amount} to {people} who joined', { amount: formatNumber(card.vouched), people: tn(card.peopleVouched, '{n} person', '{n} people') })}</div>
                                    <div>{t('Held {amount} on {invites} not used yet', { amount: formatNumber(card.held), invites: tn(card.heldInvites, '{n} invite', '{n} invites') })}</div>
                                    <div>{t('Invites sent with a vouch: {count}', { count: card.invitesWithVouch })}</div>
                                    <div>{t('{below} of {total} below zero · written off {off}', { below: card.belowZero, total: card.peopleVouched, off: formatNumber(card.writtenOff) })}</div>
                                    <div>{t('Trading: {others} with others · {inside} inside only', { others: card.trading.withOthers, inside: card.trading.insideOnly })}</div>
                                    <div>{t('Passed on: {amount} of their {vouched} to {people}', { amount: formatNumber(card.passedOn.amount), vouched: formatNumber(card.vouched), people: tn(card.passedOn.people, '{n} person', '{n} people') })}</div>
                                </div>

                                {/* Set budget to control (§10) */}
                                {card.canChange !== false && (
                                    <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400">
                                                {t('Set budget to')}
                                            </span>
                                            <span className="text-xs text-nature-500 dark:text-nature-400">
                                                {t('{left} left · {held} held', { left: formatNumber(card.left), held: formatNumber(card.held) })}
                                            </span>
                                        </div>

                                        {/* Quick levels */}
                                        <div className="grid grid-cols-4 gap-2 mb-3">
                                            {QUICK_LEVELS.map((lvl) => (
                                                <button
                                                    key={lvl}
                                                    type="button"
                                                    onClick={() => setTargetLevel(lvl)}
                                                    disabled={lvl < minLevel}
                                                    className={`min-h-[40px] px-2 py-1.5 rounded-lg text-xs font-extrabold border cursor-pointer transition-colors ${
                                                        targetLevel === lvl
                                                            ? 'bg-bp-commit-fill text-bp-commit-on border-transparent'
                                                            : 'bg-oat-50 dark:bg-nature-950 text-nature-800 dark:text-nature-200 border-nature-200 dark:border-nature-800 hover:border-nature-400'
                                                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                                                >
                                                    {formatNumber(lvl)}
                                                </button>
                                            ))}
                                        </div>

                                        {/* Stepper */}
                                        <div className="flex items-center gap-3 mb-4">
                                            <button
                                                type="button"
                                                onClick={() => setTargetLevel((prev) => Math.max(minLevel, prev - 100))}
                                                disabled={targetLevel <= minLevel || saving}
                                                className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-base bg-oat-100 dark:bg-nature-800 text-nature-900 dark:text-white border-0 cursor-pointer disabled:opacity-40"
                                                aria-label={t('Decrease budget')}
                                            >
                                                −
                                            </button>
                                            <div className="flex-1 text-center font-extrabold text-base text-nature-950 dark:text-white">
                                                {t('Set budget to: {level}', { level: formatNumber(targetLevel) })}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setTargetLevel((prev) => Math.min(maxLevel, prev + 100))}
                                                disabled={targetLevel >= maxLevel || saving}
                                                className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-base bg-oat-100 dark:bg-nature-800 text-nature-900 dark:text-white border-0 cursor-pointer disabled:opacity-40"
                                                aria-label={t('Increase budget')}
                                            >
                                                +
                                            </button>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={handleSetBudget}
                                            disabled={saving || targetLevel === card.level}
                                            className="w-full min-h-[44px] py-2 px-4 rounded-xl text-sm font-bold bg-bp-commit-fill text-bp-commit-on border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {saving ? t('Saving...') : t('Set budget to: {level}', { level: formatNumber(targetLevel) })}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'history' && (
                            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                                {card.history.length === 0 ? (
                                    <div className="p-4 text-center text-xs text-nature-500">
                                        {t('No budget history yet.')}
                                    </div>
                                ) : (
                                    card.history.map((h, i) => (
                                        <div
                                            key={i}
                                            className="p-2.5 rounded-lg border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-xs"
                                        >
                                            <div className="flex items-center justify-between font-bold text-nature-950 dark:text-white">
                                                <span>
                                                    {t('{amount} Beans ({kind})', { amount: h.amount > 0 ? `+${formatNumber(h.amount)}` : formatNumber(h.amount), kind: h.kind })}
                                                </span>
                                                <span className="text-[11px] text-nature-400 font-normal">
                                                    {formatDate(new Date(h.at), 'day-month-year')}
                                                </span>
                                            </div>
                                            <div className="text-nature-500 dark:text-nature-400 mt-0.5 flex flex-wrap gap-x-2">
                                                <span>{h.actorCallsign ? t('by @{name}', { name: h.actorCallsign }) : t('actor: {actor}', { actor: h.actor })}</span>
                                                {h.person && <span>{t('for @{name}', { name: h.person.callsign })}</span>}
                                                {h.why && <span className="opacity-80">({h.why})</span>}
                                                {h.outcome && <span className="opacity-80">[{h.outcome}]</span>}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {activeTab === 'people' && (
                            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                                {card.people.length === 0 ? (
                                    <div className="p-4 text-center text-xs text-nature-500">
                                        {t('Has not vouched for anyone yet.')}
                                    </div>
                                ) : (
                                    card.people.map((p, i) => (
                                        <div
                                            key={i}
                                            className="p-3 rounded-lg border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 text-xs flex items-center justify-between gap-2"
                                        >
                                            <div>
                                                <div className="font-extrabold text-nature-950 dark:text-white">
                                                    @{p.callsign}
                                                </div>
                                                <div className="text-nature-500 dark:text-nature-400 mt-0.5">
                                                    {t('{amount} Beans{raised} · {source}', {
                                                        amount: formatNumber(p.amount),
                                                        raised: p.raised ? t(' (raised)') : '',
                                                        source: p.byInvite ? t('by invite') : t('from profile'),
                                                    })}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                {p.belowZero && (
                                                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 font-bold text-[10px]">
                                                        {t('below zero')}
                                                    </span>
                                                )}
                                                <div className="text-[11px] text-nature-400 mt-0.5">
                                                    {t('trading: {state}', { state: p.trading })}
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}
                    </>
                ) : null}
            </div>
        </div>
    );
}
