import React, { useState, useEffect, useMemo } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';
import { getTfaSessionToken } from '../../lib/node-client';
import { useTimeout } from '../../lib/use-timeout';
import { t } from '../../lib/fresh-proof';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import {
    type Shape,
    type ShapeSettings,
    type KnownFloorShape,
    fetchCommunityShape,
    updateCommunityShape,
    getConsequenceSentence,
    hoursWording,
    RECOVERY_COPIES_CHOICES,
    recoveryCopiesName,
    DOOR_PRESETS,
    coreLocked,
    coreAwaitsOwner,
    isCoreSetting,
    typedWordFor,
} from '../../lib/community-shape';
import { RowControls, ShapeRow, joinDisplay, logSettingName, ADVICE_LINE_PREFIX } from './ShapeRows';
import { AdviseTheOwners } from './AdviseTheOwners';
import { ChangesLog } from './ChangesLog';
import { CoreWalkthrough, currentDoor, knownFloorProblem } from './CoreWalkthrough';

/** The honest words under a rule for where members' copies go, as the row shows them closed. */
function recoveryCopiesWords(rule: string): string | undefined {
    return RECOVERY_COPIES_CHOICES.find((c) => c.rule === rule)?.words;
}

export interface CommunityShapeSectionProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    onNavigate?: (tab: string, subTab?: string) => void;
    /** The Home item opens the walkthrough: at its first step, or (a community with members) at the review. */
    openWalkthrough?: 'walk' | 'review' | null;
    /** Told whenever the section learns whether the menu's "!" applies: an owner's core settings not confirmed and locked yet. */
    onUnconfirmedChange?: (unconfirmed: boolean) => void;
}

/** "3 Nov 2026": the lock line's date. */
function lockDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Core settings (was "How this community works"; DESIGN-core-settings-fable.md): the eight settings members joined under, one-way
 * changes and money. An owner walks through them once and locks them; after that every change is Unlock to change, with the
 * owner's fresh proof. The everyday rules that used to share this page sit where they are used (EverydayRuleRows).
 */
export function CommunityShapeSection({
    activeNode,
    viewer,
    onNavigate,
    openWalkthrough = null,
    onUnconfirmedChange,
}: CommunityShapeSectionProps) {
    const isOwner = viewer?.kind === 'password' || viewer?.role === 'owner';
    // An admin reads every Core setting and advises the owners about it (slice C4); a moderator never gets this page.
    const isAdmin = !isOwner && viewer?.kind === 'key' && viewer.role === 'admin';

    const [shape, setShape] = useState<Shape | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Row expansion: only one row open at a time
    const [openSetting, setOpenSetting] = useState<keyof ShapeSettings | null>(null);
    const [draftValue, setDraftValue] = useState<any>(null);
    const [note, setNote] = useState('');
    const [typed, setTyped] = useState('');
    const [saving, setSaving] = useState(false);
    const [rowError, setRowError] = useState<string | null>(null);
    const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
    const [walkStart, setWalkStart] = useState<'intro' | 'review' | null>(openWalkthrough === 'review' ? 'review' : openWalkthrough === 'walk' ? 'intro' : null);
    const successTimer = useTimeout();
    const proof = useFreshProof();

    const loadShape = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchCommunityShape(
                activeNode.url,
                nodeCredential(activeNode),
                getTfaSessionToken(activeNode.id),
            );
            setShape(data);
            onUnconfirmedChange?.(coreAwaitsOwner(data, isOwner));
        } catch (err: any) {
            setError(err.message || 'Failed to load core settings');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadShape();
        setOpenSetting(null);
        setDraftValue(null);
        setRowError(null);
        setSaveSuccess(null);
        proof.close();
    }, [activeNode.id, activeNode.url]);

    useEffect(() => {
        setWalkStart(openWalkthrough === 'review' ? 'review' : openWalkthrough === 'walk' ? 'intro' : null);
    }, [openWalkthrough]);

    const locked = coreLocked(shape);

    const closeRow = () => {
        setOpenSetting(null);
        setDraftValue(null);
        setRowError(null);
        setNote('');
        setTyped('');
        proof.close();
    };

    const handleOpenRow = (settingKey: keyof ShapeSettings, currentValue: any) => {
        if (!isOwner || shape?.standby) return;
        if (shape?.settings[settingKey]?.lock) return;

        if (openSetting === settingKey) {
            closeRow();
            return;
        }

        proof.close();
        setOpenSetting(settingKey);
        setRowError(null);
        setSaveSuccess(null);
        setNote('');
        setTyped('');

        if (settingKey === 'knownFloor') {
            const kf = currentValue as KnownFloorShape;
            setDraftValue({ on: kf.on, floor: kf.floor, cap: kf.cap });
        } else {
            setDraftValue(currentValue);
        }
    };

    const handleSave = async (settingKey: keyof ShapeSettings, code?: string) => {
        if (!shape || !isOwner || shape.standby) return;
        setSaving(true);
        setRowError(null);

        if (settingKey === 'knownFloor') {
            const problem = knownFloorProblem(draftValue as { on: boolean; floor: number; cap: number });
            if (problem) {
                setRowError(problem);
                setSaving(false);
                return;
            }
        }

        try {
            const res = await updateCommunityShape(
                activeNode.url,
                nodeCredential(activeNode),
                { [settingKey]: draftValue },
                note,
                getTfaSessionToken(activeNode.id),
                code,
            );
            proof.close();
            setShape(res.shape);
            setOpenSetting(null);
            setDraftValue(null);
            setNote('');
            setTyped('');
            setSaveSuccess(
                res.told === 'members'
                    ? t('Saved, and every member is told.')
                    : t('Saved!'),
            );
            successTimer.schedule(() => setSaveSuccess(null), 4000);
        } catch (err: any) {
            // A locked Core change asks the owner's fresh proof: the box opens, and its Confirm sends this save again.
            if (proof.checkError(err, (c) => handleSave(settingKey, c), code)) return;
            setRowError(err.message || 'Failed to save change');
        } finally {
            setSaving(false);
        }
    };

    const consequenceText = useMemo(() => {
        if (!openSetting || !shape || draftValue === null) return '';
        return getConsequenceSentence(openSetting, draftValue, shape);
    }, [openSetting, draftValue, shape]);

    if (loading) {
        return (
            <div data-testid="community-shape-section" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl max-w-2xl w-full mx-auto font-sans">
                <p className="text-sm text-nature-400 m-0">{t('Loading core settings…')}</p>
            </div>
        );
    }

    if (error || !shape) {
        return (
            <div data-testid="community-shape-section" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl max-w-2xl w-full mx-auto font-sans space-y-4">
                <p className="text-sm text-red-400 m-0">{error || t('Could not load core settings.')}</p>
                <button
                    type="button"
                    onClick={loadShape}
                    className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all"
                >
                    {t('Retry')}
                </button>
            </div>
        );
    }

    const { settings, kind, standby, log } = shape;
    const canEdit = isOwner && !standby;
    const coreLog = log.filter((l) => {
        const base = l.setting.split('.')[0];
        return isCoreSetting(base) || base === 'core' || (l.setting.startsWith(ADVICE_LINE_PREFIX) && isCoreSetting(l.setting.slice(ADVICE_LINE_PREFIX.length)));
    });

    // ── The lock line and the button under a locked Core row ──
    // An admin on the main server can advise the owners about any Core setting, locked or not (AdviseTheOwners).
    const advising = isAdmin && !standby;
    const lockedBy = shape.core?.lock?.byCallsign ? `@${shape.core.lock.byCallsign}` : t('an owner');
    const since = lockDate(shape.core?.lock?.at);
    const lockLine = !locked
        ? undefined
        : since
            ? (canEdit
                ? t('Locked since {date} by {callsign}. Unlock to change: it asks for your proof, and every owner is told.')
                : advising
                    ? t('Locked since {date} by {callsign}. Only an owner unlocks it; you can advise them below.')
                    : t('Locked since {date} by {callsign}. Only an owner unlocks it.')).replace('{date}', since).replace('{callsign}', lockedBy)
            : canEdit
                ? t('Locked. Unlock to change: it asks for your proof, and every owner is told.')
                : advising
                    ? t('Locked. Only an owner unlocks it; you can advise them below.')
                    : t('Locked. Only an owner unlocks it.');

    const unlockButton = (key: keyof ShapeSettings, current: unknown) => {
        if (!locked || !canEdit || settings[key]?.lock) return undefined;
        // Open, the row has its own Save and Cancel: a second Cancel here would say the same thing twice.
        if (openSetting === key) return undefined;
        return (
            <button
                type="button"
                data-testid={`shape-unlock-${key}`}
                aria-expanded={false}
                onClick={() => handleOpenRow(key, current)}
                className="min-h-[44px] w-full sm:w-auto px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 transition-all"
            >
                {t('Unlock to change')}
            </button>
        );
    };

    /** An admin's "Advise the owners" under a Core row; an owner has Unlock to change, and a standby takes no advice. */
    const adviseButton = (key: keyof ShapeSettings) => {
        if (!advising) return undefined;
        return (
            <AdviseTheOwners
                setting={key}
                settingName={logSettingName(key)}
                activeNode={activeNode}
                onSent={(next) => {
                    setShape(next);
                    setSaveSuccess(t('Sent. Every owner is told, and your words are under Changes below.'));
                    successTimer.schedule(() => setSaveSuccess(null), 6000);
                }}
            />
        );
    };

    /** The same controls for every Core row: after the lock, the typed word for a one-way change and the proof box. */
    const controls = (key: keyof ShapeSettings, saveDisabled: boolean) => {
        const word = locked ? typedWordFor(key, draftValue) : null;
        return (
            <RowControls
                onSave={() => handleSave(key)}
                onCancel={closeRow}
                consequence={consequenceText}
                note={note}
                onNoteChange={setNote}
                saving={saving}
                error={rowError}
                saveDisabled={saveDisabled}
                typedWord={word}
                typed={typed}
                onTypedChange={setTyped}
                below={locked ? <FreshProofBox proof={proof} /> : undefined}
            />
        );
    };

    const checkbox = (label: string) => (
        <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
            <input
                type="checkbox"
                checked={Boolean(draftValue)}
                onChange={(e) => setDraftValue(e.target.checked)}
                className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
            />
            <span>{label}</span>
        </label>
    );

    /** The row's shared props: a locked group has no chevron; an owner opens a row with its Unlock button. */
    const rowProps = (key: keyof ShapeSettings, current: unknown) => ({
        isOwner: canEdit && !locked,
        isOpen: openSetting === key,
        onToggle: () => handleOpenRow(key, current),
        coreLockLine: locked ? lockLine : undefined,
        coreAction: unlockButton(key, current) ?? adviseButton(key),
    });

    const door = currentDoor(shape);
    const joinValueText = settings.join.value === 'paused' ? t('{door} · paused now').replace('{door}', joinDisplay(door)) : joinDisplay(settings.join.value);

    // A server from before core settings says nothing of them: no banner, no walkthrough, no lock to speak of.
    const hasCore = Boolean(shape.core);

    return (
        <div data-testid="community-shape-section" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl max-w-2xl w-full mx-auto font-sans space-y-6">
            {/* Header */}
            <div>
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span aria-hidden="true">🧭</span>
                    <span>{t('Core settings')}</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5 leading-relaxed">
                    {t('Set once, when you start your community. Changing one later affects every member, and asks you to unlock it first.')}
                </p>
                <p data-testid="shape-role-hint" className="text-xs text-nature-400 m-0 mt-1">
                    {standby ? (
                        <span className="text-bp-ink-warning">{t('This is a standby: change it on the main server.')}</span>
                    ) : !isOwner ? (
                        <span className="text-nature-300">{t("You're an admin: you can read these and advise the owners.")}</span>
                    ) : (
                        <span>{t('Only an owner unlocks one. Admins can read these and advise you.')}</span>
                    )}
                </p>
            </div>

            {/* Kind of server card */}
            <div className="p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-1.5">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-bold text-white">
                        {kind === 'global' ? t('Kind of server: global community') : t('Kind of server: local community')}
                    </span>
                    <span className="text-[11px] font-medium text-nature-400 bg-nature-900 px-2 py-0.5 rounded-md border border-nature-800">
                        {t('Set on the server')}
                    </span>
                </div>
                <p className="text-[11px] text-nature-400 m-0 leading-normal">
                    {kind === 'global'
                        ? t('A lobby for people everywhere to meet, talk and start local communities. Whoever runs the server sets it.')
                        : t('Beans, invites, Decisions and the directory come from this. The global community is the other kind. Whoever runs the server sets it.')}
                </p>
            </div>

            {saveSuccess && (
                <div role="status" className="p-3 rounded-xl bg-bp-chip-ok-tint text-bp-chip-ok-ink text-xs font-semibold">
                    {saveSuccess}
                </div>
            )}

            {/* Not confirmed yet: offered, never forced. The community runs on its choices meanwhile. */}
            {hasCore && !locked && !standby && !(walkStart && canEdit) && (
                canEdit ? (
                    <div data-testid="core-unconfirmed-banner" className="p-3.5 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink border border-amber-800/50 space-y-2">
                        <p className="text-xs font-bold text-bp-chip-warn-ink m-0">{t('Not confirmed yet.')}</p>
                        <button
                            type="button"
                            data-testid="core-walk-start"
                            onClick={() => setWalkStart('intro')}
                            className="min-h-[44px] px-4 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on"
                        >
                            {t('Walk through them ›')}
                        </button>
                    </div>
                ) : (
                    <p data-testid="core-unconfirmed-admin" className="text-xs text-nature-300 m-0 p-3 rounded-xl bg-nature-950 border border-nature-800">
                        {t("The owners haven't confirmed the core settings yet. You can read them and advise.")}
                    </p>
                )
            )}

            {hasCore && walkStart && canEdit && !locked ? (
                <CoreWalkthrough
                    activeNode={activeNode}
                    shape={shape}
                    startAt={walkStart}
                    onLeave={() => setWalkStart(null)}
                    onLocked={(next, told) => {
                        setShape(next);
                        setWalkStart(null);
                        onUnconfirmedChange?.(false);
                        setSaveSuccess(t('Locked. From now on each change asks you to unlock it first, and every owner is told. Admins can read these and advise you.'));
                        successTimer.schedule(() => setSaveSuccess(null), 8000);
                        void told;
                    }}
                />
            ) : (
                <div className="space-y-3" data-testid="core-rows">
                    {/* join: the door (pausing new members is everyday, under Invites & QR) */}
                    <ShapeRow
                        id="join"
                        icon="🚪"
                        name={t('Who can join')}
                        summary={t('How people get in. Invite is how every community starts. Known keeps the list of who is here with the admins.')}
                        displayValue={joinValueText}
                        lock={settings.join.lock}
                        {...rowProps('join', door)}
                    >
                        <div className="space-y-3 pt-2">
                            <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t('Who can join')}>
                                <legend className="sr-only">{t('Who can join')}</legend>
                                {DOOR_PRESETS.map((p) => (
                                    <label key={p.door} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                        <input
                                            type="radio"
                                            name="shape-join-radio"
                                            value={p.door}
                                            checked={draftValue === p.door}
                                            onChange={() => setDraftValue(p.door)}
                                            className="mt-0.5 accent-terra-500"
                                        />
                                        <div>
                                            <span className="font-bold">{p.name}: {p.plain}</span>
                                            <p className="text-[11px] text-nature-400 m-0 mt-0.5">{p.detail}</p>
                                        </div>
                                    </label>
                                ))}
                            </fieldset>
                            <p className="text-[11px] text-nature-400 m-0">{t('You can pause new members any time, without unlocking this, under People & Safety → Invites & QR.')}</p>
                            {controls('join', draftValue === door)}
                        </div>
                    </ShapeRow>

                    {/* wordsDoor (global kind) */}
                    {settings.wordsDoor !== undefined && (
                        <ShapeRow
                            id="wordsDoor"
                            icon="🔑"
                            name={t('12 words at the open door')}
                            summary={t('People can join with 12 secret words without a sign-in.')}
                            displayValue={settings.wordsDoor.value ? t('On') : t('Off')}
                            lock={settings.wordsDoor.lock}
                            {...rowProps('wordsDoor', settings.wordsDoor.value)}
                        >
                            <div className="space-y-3 pt-2">
                                {checkbox(t('Allow joining with 12 secret words'))}
                                {controls('wordsDoor', draftValue === settings.wordsDoor.value)}
                            </div>
                        </ShapeRow>
                    )}

                    {/* beans */}
                    <ShapeRow
                        id="beans"
                        icon="🫘"
                        name={t('Beans')}
                        summary={t('Trades, credit and the Commons run on Beans.')}
                        extraLine={t('Includes trades held in escrow, enterprises and crowdfunding.')}
                        displayValue={settings.beans.value ? t('On') : t('Off')}
                        lock={settings.beans.lock}
                        {...rowProps('beans', settings.beans.value)}
                    >
                        <div className="space-y-3 pt-2">
                            {checkbox(t('Beans active'))}
                            {controls('beans', draftValue === settings.beans.value)}
                        </div>
                    </ShapeRow>

                    {/* knownFloor */}
                    <ShapeRow
                        id="knownFloor"
                        icon="🤝"
                        name={t('Known floor for confirmed members')}
                        summary={t('An admin confirms a member on the names list; they can then owe up to this while they keep an offer listed.')}
                        extraLine={t("Cap for one member's raise: {cap}.").replace('{cap}', settings.knownFloor.value.cap.toLocaleString('en'))}
                        displayValue={settings.knownFloor.value.on ? t('On · {floor} Beans').replace('{floor}', settings.knownFloor.value.floor.toLocaleString('en')) : t('Off')}
                        lock={settings.knownFloor.lock}
                        {...rowProps('knownFloor', settings.knownFloor.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    id="shape-known-floor-on"
                                    type="checkbox"
                                    checked={Boolean(draftValue?.on)}
                                    onChange={(e) => setDraftValue({ ...draftValue, on: e.target.checked })}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Confirmed members get the known floor')}</span>
                            </label>

                            {draftValue?.on && (
                                <div className="space-y-3 pl-6 pt-1">
                                    <div>
                                        <label htmlFor="shape-known-floor-floor" className="block text-xs font-bold text-nature-300 mb-1">
                                            {t('Known floor (Beans)')}
                                        </label>
                                        <input
                                            id="shape-known-floor-floor"
                                            type="number"
                                            value={draftValue.floor}
                                            onChange={(e) => setDraftValue({ ...draftValue, floor: Number(e.target.value) })}
                                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500"
                                        />
                                        <p data-testid="known-floor-hours" className="text-[11px] text-nature-400 mt-1 m-0">
                                            {hoursWording(draftValue.floor || 0)}
                                        </p>
                                    </div>
                                    <div>
                                        <label htmlFor="shape-known-floor-cap" className="block text-xs font-bold text-nature-300 mb-1">
                                            {t('Cap: the most anyone may owe')}
                                        </label>
                                        <input
                                            id="shape-known-floor-cap"
                                            type="number"
                                            value={draftValue.cap}
                                            onChange={(e) => setDraftValue({ ...draftValue, cap: Number(e.target.value) })}
                                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {controls(
                                'knownFloor',
                                draftValue?.on === settings.knownFloor.value.on &&
                                    draftValue?.floor === settings.knownFloor.value.floor &&
                                    draftValue?.cap === settings.knownFloor.value.cap,
                            )}
                        </div>
                    </ShapeRow>

                    {/* memberGift (slice G1), beside the known floor, on a server that has it: 0 turns the tab off in both apps */}
                    {settings.memberGift !== undefined && (
                        <ShapeRow
                            id="memberGift"
                            icon="🎁"
                            name={t('Members giving part of their credit line')}
                            summary={t('A member may give another part of the credit line someone gave them, beside Beans on Send: up to this much at once.')}
                            displayValue={settings.memberGift.value > 0
                                ? t('On · up to {n} Beans').replace('{n}', settings.memberGift.value.toLocaleString('en'))
                                : t('Off')}
                            lock={settings.memberGift.lock}
                            {...rowProps('memberGift', settings.memberGift.configured)}
                        >
                            <div className="space-y-3 pt-2">
                                <label htmlFor="shape-member-gift" className="block text-xs font-bold text-nature-300 mb-1">
                                    {t('Most one gift can be (Beans, 0 to 100; 0 is off)')}
                                </label>
                                <input
                                    id="shape-member-gift"
                                    type="number"
                                    min={0}
                                    max={100}
                                    step={1}
                                    value={typeof draftValue === 'number' ? draftValue : ''}
                                    onChange={(e) => setDraftValue(e.target.value === '' ? null : Number(e.target.value))}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500"
                                />
                                {controls('memberGift', typeof draftValue !== 'number' || draftValue === settings.memberGift.configured)}
                            </div>
                        </ShapeRow>
                    )}

                    {/* decisions */}
                    <ShapeRow
                        id="decisions"
                        icon="🗳️"
                        name={t('Community votes (Decisions)')}
                        summary={t('Members who have completed a trade, and admins, propose; members vote.')}
                        displayValue={settings.decisions.value ? t('On') : t('Off')}
                        lock={settings.decisions.lock}
                        {...rowProps('decisions', settings.decisions.value)}
                    >
                        <div className="space-y-3 pt-2">
                            {checkbox(t('Community votes active'))}
                            {controls('decisions', draftValue === settings.decisions.value)}
                        </div>
                    </ShapeRow>

                    {/* shareOutside (front doors S6), on a server that has it */}
                    {settings.shareOutside !== undefined && (
                        <ShapeRow
                            id="shareOutside"
                            icon="🔗"
                            name={t('Members may share listings outside the community')}
                            summary={t('A shared link shows one post for 7 days, without names or faces.')}
                            displayValue={settings.shareOutside.value ? t('On') : t('Off')}
                            lock={settings.shareOutside.lock}
                            {...rowProps('shareOutside', settings.shareOutside.value)}
                        >
                            <div className="space-y-3 pt-2">
                                {checkbox(t('Let members share a post outside'))}
                                {controls('shareOutside', draftValue === settings.shareOutside.value)}
                            </div>
                        </ShapeRow>
                    )}

                    {/* recoveryCopies (vault rethink VR2) */}
                    {settings.recoveryCopies !== undefined && (
                        <ShapeRow
                            id="recoveryCopies"
                            icon="🗝️"
                            name={t("Where members' copies go")}
                            summary={t('When a member links Google, Apple or Facebook, a locked copy of their account is kept, so that sign-in brings it back on a new phone.')}
                            extraLine={recoveryCopiesWords(settings.recoveryCopies.value)}
                            displayValue={recoveryCopiesName(settings.recoveryCopies.value)}
                            lock={settings.recoveryCopies.lock}
                            {...rowProps('recoveryCopies', settings.recoveryCopies.value)}
                        >
                            <div className="space-y-3 pt-2">
                                <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t("Where members' copies go")}>
                                    <legend className="sr-only">{t("Where members' copies go")}</legend>
                                    {RECOVERY_COPIES_CHOICES.map((choice) => (
                                        <label key={choice.rule} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                            <input
                                                type="radio"
                                                name="shape-recovery-copies-radio"
                                                value={choice.rule}
                                                checked={draftValue === choice.rule}
                                                onChange={() => setDraftValue(choice.rule)}
                                                className="mt-0.5 accent-terra-500"
                                            />
                                            <div>
                                                <span className="font-bold">{choice.name}</span>
                                                <p className="text-[11px] text-nature-400 m-0 mt-0.5">{choice.words}</p>
                                            </div>
                                        </label>
                                    ))}
                                </fieldset>
                                {controls('recoveryCopies', draftValue === settings.recoveryCopies.value)}
                            </div>
                        </ShapeRow>
                    )}
                </div>
            )}

            {/* Where the everyday rules went */}
            {onNavigate && (
                <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                    {t('Everyday rules sit where you use them: pausing new members under Invites & QR, the safety switches under Triage & Moderation, being found under Node Identity.')}
                </p>
            )}

            {/* ── CHANGES (Audit Trail) ── */}
            <div className="space-y-4 pt-4 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('CHANGES')}
                </h4>
                <ChangesLog lines={coreLog} />
            </div>
        </div>
    );
}
