import React from 'react';
import type { ShapeLock, JoinState, ShapeLogLine } from '../../lib/community-shape';
import { recoveryCopiesName, removalDeciderName } from '../../lib/community-shape';
import { t } from '../../lib/fresh-proof';
import { beansFigure } from '../../lib/beans';

/**
 * The rows of "Core settings" and of the everyday-rule cards (People & Safety → Invites & QR and Triage & Moderation,
 * Appliance & Data → Node Identity): one row look, one controls block, and the words the Changes log is drawn in.
 */

export function joinDisplay(val: JoinState): string {
    switch (val) {
        case 'members': return t('Any member invites');
        case 'admins': return t('Only admins invite');
        case 'paused': return t('Paused');
        case 'open': return t('Open');
        default: return String(val);
    }
}

export function joinRadioTitle(opt: 'members' | 'admins' | 'paused'): string {
    switch (opt) {
        case 'members': return t('Invite: any member invites');
        case 'admins': return t('Known: only admins invite');
        case 'paused': return t('Paused: nobody new for now');
    }
}

export function joinRadioDescription(opt: 'members' | 'admins' | 'paused'): string {
    switch (opt) {
        case 'members': return t('Any member can make an invite, from the app or the web app, and answer a request to join. This is how every community starts.');
        case 'admins': return t('Only owners and admins can make invites and answer requests to join. Members are told to ask an admin, and their app shows no invite to make.');
        case 'paused': return t('Nobody new can join. Invites already made cannot be used while new members are paused.');
    }
}

export function visitorsDisplay(val: 'nothing' | 'listings' | 'open'): string {
    switch (val) {
        case 'nothing': return t('See nothing');
        case 'listings': return t('Listings only');
        case 'open': return t('Open');
        default: return String(val);
    }
}

export function logActorDisplay(entry: ShapeLogLine): { name: string; role?: string } {
    if (entry.actor === 'owner:password' || entry.actor === 'password') {
        // History: a change logged before nodes dropped the admin password still says so.
        return { name: t('the owner (old admin password)') };
    }
    if (entry.actorCallsign) {
        return { name: `@${entry.actorCallsign}`, role: entry.actorRole ?? undefined };
    }
    const shortKey = entry.actor.length > 12 ? `${entry.actor.slice(0, 8)}…` : entry.actor;
    return { name: shortKey, role: entry.actorRole ?? undefined };
}

export function logSettingName(setting: string): string {
    const table: Record<string, string> = {
        join: t('Who can join'),
        wordsDoor: t('12 words at the open door'),
        doorCheck: t('A person check on busy days'),
        knocks: t('Requests to join'),
        beans: t('Beans'),
        knownFloor: t('Known floor for confirmed members'),
        'knownFloor.on': t('Known floor for confirmed members'),
        'knownFloor.floor': t('Confirmed members owe up to'),
        'knownFloor.cap': t('Floor cap'),
        voucherBudget: t('Budget per voucher'),
        memberGift: t('Members giving part of their credit line'),
        dmRequests: t('First message from someone new'),
        contacts: t("Keep members' locked contact lists"),
        shareOutside: t('Members may share listings outside the community'),
        decisions: t('Community votes (Decisions)'),
        listed: t('Listed in the BeanPool directory'),
        shareLocation: t('Share location & radius'),
        shareMemberCount: t('Share member count'),
        shareEmail: t('Share email'),
        sharePhone: t('Share phone'),
        shareHealth: t('Share health'),
        shareListingsFromHere: t("Our name on members' listings on the global community"),
        probation: t('Limits on new accounts'),
        autoHide: t('Reported posts hidden and message requests cleared automatically'),
        autoHideReports: t('Reported posts hidden and message requests cleared automatically'),
        autoMute: t('Repeat offenders muted automatically'),
        recoveryCopies: t("Where members' copies go"),
        removalDecider: t('Who decides a removal'),
        'core.lock': t('Core settings'),
        'core.unlock': t('Core settings'),
    };
    return table[setting] ?? setting;
}

/** The log's `setting` for advice to the owners about a Core setting: `advice.<setting>` (server config/core-advice.ts). */
export const ADVICE_LINE_PREFIX = 'advice.';

/**
 * The log's whole line for a core row (design §8.5), or null for any other: "Core settings confirmed and locked",
 * "unlocked Beans", "advised the owners about Beans". An advice line's words are the admin's own: they arrive as the entry's
 * `note` and ChangesLog draws them as text, quoted, after this line.
 */
export function coreLogWords(entry: ShapeLogLine): string | null {
    if (entry.setting === 'core.lock') return t('🔒 Core settings confirmed and locked');
    if (entry.setting === 'core.unlock') return t('🔓 Unlocked {setting}').replace('{setting}', logSettingName(entry.to ?? ''));
    if (entry.setting.startsWith(ADVICE_LINE_PREFIX)) {
        return t('💬 Advised the owners about {setting}').replace('{setting}', logSettingName(entry.setting.slice(ADVICE_LINE_PREFIX.length)));
    }
    return null;
}

/**
 * A money setting's value as the log keeps it: whole hundredths in text ('150000' is 1,500 Beans; server
 * config/community-shape-write.ts and config/known-floor.ts log String(hundredths)), in words; text that isn't one, as it is.
 */
function logBeans(val: string): string {
    return /^-?\d{1,15}$/.test(val) ? beansFigure(Number(val)) : val;
}

export function logValueDisplay(setting: string, val: string | null): string {
    if (val === null || val === undefined) return '';
    if (setting === 'join') {
        return joinDisplay(val as JoinState);
    }
    if (setting === 'recoveryCopies') return recoveryCopiesName(val);
    if (setting === 'removalDecider') return removalDeciderName(val);
    if (setting === 'voucherBudget') return t('{n} Beans').replace('{n}', logBeans(val));
    // The known floor and its cap, as their row reads them.
    if (setting === 'knownFloor.floor' || setting === 'knownFloor.cap') return t('{n} Beans').replace('{n}', logBeans(val));
    // The members' credit-line gift (G1): as its row reads it, "On · up to 100 Beans" or "Off".
    if (setting === 'memberGift') return val === '0' ? t('Off') : t('On · up to {n} Beans').replace('{n}', logBeans(val));
    if (val === 'on' || val === 'true') return t('On');
    if (val === 'off' || val === 'false') return t('Off');
    return val;
}

export function formatLogDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return isoDate;
    }
}

export interface ShapeRowProps {
    id: string;
    icon: string;
    name: string;
    summary: string;
    extraLine?: string;
    displayValue: string;
    serverBadge?: string;
    lock?: ShapeLock | null;
    isOwner: boolean;
    isOpen: boolean;
    onToggle: () => void;
    children?: React.ReactNode;
    allowExpandWithLock?: boolean;
    /** The core lock line (Core settings once locked): shown under the row, above what opens. */
    coreLockLine?: React.ReactNode;
    /** What an owner presses to open a locked Core row (Unlock to change), or says why they can't. */
    coreAction?: React.ReactNode;
}

export function ShapeRow({
    id,
    icon,
    name,
    summary,
    extraLine,
    displayValue,
    serverBadge,
    lock,
    isOwner,
    isOpen,
    onToggle,
    children,
    allowExpandWithLock,
    coreLockLine,
    coreAction,
}: ShapeRowProps) {
    const isLocked = Boolean(lock);
    const canExpand = isOwner && (!isLocked || Boolean(allowExpandWithLock)) && !serverBadge;

    const headerContent = (
        <>
            <div className="flex items-start justify-between gap-2 flex-wrap min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base select-none shrink-0" aria-hidden="true">{icon}</span>
                    <span className="text-xs font-bold text-white break-words">{name}</span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 ml-auto min-w-0 max-w-full">
                    <span data-testid={`shape-val-${id}`} className="text-xs font-medium text-white break-words">
                        {displayValue}
                    </span>
                    {serverBadge && (
                        <span className="text-[10px] text-nature-400 bg-nature-900 border border-nature-800 px-1.5 py-0.5 rounded break-words text-right">
                            {serverBadge}
                        </span>
                    )}
                    {canExpand && (
                        <span className="text-nature-400 text-xs font-mono select-none" aria-hidden="true">
                            {isOpen ? '▲' : '›'}
                        </span>
                    )}
                </div>
            </div>
            <p className="text-[11px] text-nature-400 m-0 leading-normal break-words pl-6">{summary}</p>
            {extraLine && (
                <p className="text-[11px] text-nature-400 m-0 leading-normal break-words pl-6">{extraLine}</p>
            )}
        </>
    );

    return (
        <div
            data-testid={`shape-row-${id}`}
            className="p-3.5 sm:p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-2 transition-all"
        >
            {canExpand ? (
                <button
                    type="button"
                    data-testid={`shape-expand-${id}`}
                    aria-expanded={isOpen}
                    onClick={onToggle}
                    className="w-full text-left bg-transparent border-0 p-0 m-0 min-h-[48px] space-y-1.5 cursor-pointer hover:opacity-90 focus:outline-none focus-visible:ring-1 focus-visible:ring-terra-500 rounded"
                >
                    {headerContent}
                </button>
            ) : (
                <div
                    data-testid={`shape-expand-${id}`}
                    className="min-h-[48px] space-y-1.5"
                >
                    {headerContent}
                </div>
            )}

            {/* Lock Line */}
            {lock && (
                <div
                    data-testid={`shape-lock-${id}`}
                    role="status"
                    className={`text-[11px] leading-relaxed p-2 rounded-lg ${
                        lock.code === 'auth_hatch_open'
                            ? 'bg-bp-chip-danger-tint text-bp-chip-danger-ink font-semibold'
                            : 'bg-nature-900/60 text-nature-300'
                    }`}
                >
                    <span className="mr-1" aria-hidden="true">🔒</span>
                    <span>{lock.why}</span>
                    {lock.unlock && (
                        <span className="block mt-0.5 text-nature-400">{lock.unlock}</span>
                    )}
                </div>
            )}

            {coreLockLine && (
                <p data-testid={`shape-core-lock-${id}`} className="text-[11px] leading-relaxed m-0 p-2 rounded-lg bg-nature-900/60 text-nature-300 break-words">
                    {coreLockLine}
                </p>
            )}
            {coreAction}

            {/* In-place expansion */}
            {isOpen && children && (
                <div className="pt-2 border-t border-nature-800/80">
                    {children}
                </div>
            )}
        </div>
    );
}

export interface RowControlsProps {
    onSave: () => void;
    onCancel: () => void;
    consequence?: string;
    note: string;
    onNoteChange: (val: string) => void;
    saving: boolean;
    error?: string | null;
    saveDisabled?: boolean;
    /** A one-way change once locked: Save waits until this word is typed (design §4.2). */
    typedWord?: string | null;
    typed?: string;
    onTypedChange?: (v: string) => void;
    /** Under the buttons: the fresh-proof box. */
    below?: React.ReactNode;
}

export function RowControls({
    onSave,
    onCancel,
    consequence,
    note,
    onNoteChange,
    saving,
    error,
    saveDisabled,
    typedWord,
    typed = '',
    onTypedChange,
    below,
}: RowControlsProps) {
    const typedAsk = t('Type {word} to confirm').split('{word}');
    const typedOk = !typedWord || typed.trim().toLowerCase() === typedWord;
    return (
        <div className="space-y-3 pt-2">
            {consequence && (
                <p data-testid="shape-consequence" className="text-xs text-bp-ink-warning font-medium m-0 leading-relaxed break-words">
                    {consequence}
                </p>
            )}

            <div>
                <input
                    type="text"
                    maxLength={200}
                    value={note}
                    onChange={(e) => onNoteChange(e.target.value)}
                    placeholder={t('Optional note to members (e.g. why this changed)')}
                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500 placeholder:text-nature-500"
                />
            </div>

            {typedWord && (
                <div>
                    <label htmlFor={`shape-typed-${typedWord}`} className="block text-xs text-nature-300 mb-1">
                        {typedAsk[0]}<strong className="text-white">{typedWord}</strong>{typedAsk[1]}
                    </label>
                    <input
                        id={`shape-typed-${typedWord}`}
                        data-testid="shape-typed-word"
                        type="text"
                        value={typed}
                        onChange={(e) => onTypedChange?.(e.target.value)}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500"
                    />
                </div>
            )}

            {error && (
                <div role="alert" className="p-2.5 rounded-xl bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-medium break-words">
                    {error}
                </div>
            )}

            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    disabled={saving || saveDisabled || !typedOk}
                    onClick={onSave}
                    className="py-2 px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on transition-all disabled:opacity-50 min-h-[40px]"
                >
                    {saving ? t('Saving...') : t('Save')}
                </button>
                <button
                    type="button"
                    disabled={saving}
                    onClick={onCancel}
                    className="py-2 px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-nature-300 hover:text-white transition-all min-h-[40px]"
                >
                    {t('Cancel')}
                </button>
            </div>
            {below}
        </div>
    );
}
