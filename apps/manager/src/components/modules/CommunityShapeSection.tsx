import React, { useState, useEffect, useMemo } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';
import { getTfaSessionToken } from '../../lib/node-client';
import { useTimeout } from '../../lib/use-timeout';
import { t } from '../../lib/fresh-proof';
import {
    type Shape,
    type ShapeSettings,
    type ShapeLock,
    type JoinState,
    type KnownFloorShape,
    fetchCommunityShape,
    updateCommunityShape,
    getConsequenceSentence,
    hoursWording,
    BEANS_PER_HOUR,
} from '../../lib/community-shape';

export interface CommunityShapeSectionProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    onNavigate?: (tab: string, subTab?: string) => void;
}

export function CommunityShapeSection({
    activeNode,
    viewer,
    onNavigate,
}: CommunityShapeSectionProps) {
    const isOwner = viewer?.kind === 'password' || viewer?.role === 'owner';

    const [shape, setShape] = useState<Shape | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Row expansion: only one row open at a time
    const [openSetting, setOpenSetting] = useState<keyof ShapeSettings | null>(null);
    const [draftValue, setDraftValue] = useState<any>(null);
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);
    const [rowError, setRowError] = useState<string | null>(null);
    const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
    const successTimer = useTimeout();

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
        } catch (err: any) {
            setError(err.message || 'Failed to load community shape');
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
    }, [activeNode.id, activeNode.url]);

    const handleOpenRow = (settingKey: keyof ShapeSettings, currentValue: any) => {
        if (!isOwner || shape?.standby) return;
        const lock = shape?.settings[settingKey]?.lock;
        const canOpenWithLock = settingKey === 'listed' && Boolean(
            lock && (
                lock.code === 'held_back' ||
                lock.code === 'schedule_never' ||
                (lock.code === 'server_env' && shape?.settings.listed.configured)
            )
        );
        if (lock && !canOpenWithLock) return;

        if (openSetting === settingKey) {
            setOpenSetting(null);
            setDraftValue(null);
            setRowError(null);
            setNote('');
            return;
        }

        setOpenSetting(settingKey);
        setRowError(null);
        setSaveSuccess(null);
        setNote('');

        if (settingKey === 'knownFloor') {
            const kf = currentValue as KnownFloorShape;
            setDraftValue({
                on: kf.on,
                floor: kf.floor,
                cap: kf.cap,
            });
        } else {
            setDraftValue(currentValue);
        }
    };

    const handleCancel = () => {
        setOpenSetting(null);
        setDraftValue(null);
        setRowError(null);
        setNote('');
    };

    const handleSave = async (settingKey: keyof ShapeSettings) => {
        if (!shape || !isOwner || shape.standby) return;
        setSaving(true);
        setRowError(null);

        // Validation for knownFloor
        if (settingKey === 'knownFloor') {
            const kf = draftValue as { on: boolean; floor: number; cap: number };
            if (kf.on) {
                if (kf.floor > kf.cap) {
                    setRowError(t("The known floor can't be more than the cap."));
                    setSaving(false);
                    return;
                }
                if (kf.floor < 0) {
                    setRowError(t("The known floor can't be negative."));
                    setSaving(false);
                    return;
                }
                if (kf.cap < 2000 || kf.cap > 5000) {
                    setRowError(t("The cap must be between 2,000 and 5,000 Beans."));
                    setSaving(false);
                    return;
                }
            }
        }

        try {
            const res = await updateCommunityShape(
                activeNode.url,
                nodeCredential(activeNode),
                { [settingKey]: draftValue },
                note,
                getTfaSessionToken(activeNode.id),
            );
            setShape(res.shape);
            setOpenSetting(null);
            setDraftValue(null);
            setNote('');
            setSaveSuccess(
                res.told === 'members'
                    ? t('Saved, and every member is told.')
                    : t('Saved!'),
            );
            successTimer.schedule(() => setSaveSuccess(null), 4000);
        } catch (err: any) {
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
                <p className="text-sm text-nature-400 m-0">{t('Loading how this community works…')}</p>
            </div>
        );
    }

    if (error || !shape) {
        return (
            <div data-testid="community-shape-section" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl max-w-2xl w-full mx-auto font-sans space-y-4">
                <p className="text-sm text-red-400 m-0">{error || t('Could not load community shape.')}</p>
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

    return (
        <div data-testid="community-shape-section" className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl max-w-2xl w-full mx-auto font-sans space-y-6">
            {/* Header */}
            <div>
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span aria-hidden="true">🧭</span>
                    <span>{t('How this community works')}</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5 leading-relaxed">
                    {t('What this community does right now, and the one place to change it.')}
                </p>
                <p data-testid="shape-role-hint" className="text-xs text-nature-400 m-0 mt-1">
                    {standby ? (
                        <span className="text-bp-ink-warning">{t('This is a standby: change it on the main server.')}</span>
                    ) : !isOwner ? (
                        <span className="text-nature-300">{t("You're an admin: this page is read-only.")}</span>
                    ) : (
                        <span>{t('Only an owner changes these. Members see the same facts on their Home.')}</span>
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

            {/* ── WHO CAN JOIN ── */}
            <div className="space-y-4">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('WHO CAN JOIN')}
                </h4>
                <div className="space-y-3">
                    {/* join */}
                    <ShapeRow
                        id="join"
                        icon="🚪"
                        name={t('Who can join')}
                        summary={t('Members make invites and answer requests to join.')}
                        displayValue={joinDisplay(settings.join.value)}
                        lock={settings.join.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'join'}
                        onToggle={() => handleOpenRow('join', settings.join.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t('Who can join')}>
                                <legend className="sr-only">{t('Who can join')}</legend>
                                {(['members', 'admins', 'paused'] as const).map((opt) => (
                                    <label key={opt} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                        <input
                                            type="radio"
                                            name="shape-join-radio"
                                            value={opt}
                                            checked={draftValue === opt}
                                            onChange={() => setDraftValue(opt)}
                                            className="mt-0.5 accent-terra-500"
                                        />
                                        <div>
                                            <span className="font-bold">{joinRadioTitle(opt)}</span>
                                            <p className="text-[11px] text-nature-400 m-0 mt-0.5">{joinRadioDescription(opt)}</p>
                                        </div>
                                    </label>
                                ))}
                            </fieldset>
                            <RowControls
                                onSave={() => handleSave('join')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.join.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* knocks */}
                    <ShapeRow
                        id="knocks"
                        icon="🔔"
                        name={t('Requests to join')}
                        summary={t('People who find you can ask; a member answers with an invite.')}
                        displayValue={settings.knocks.value ? t('On') : t('Off')}
                        lock={settings.knocks.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'knocks'}
                        onToggle={() => handleOpenRow('knocks', settings.knocks.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Take requests to join')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('knocks')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.knocks.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* preview */}
                    <ShapeRow
                        id="preview"
                        icon="🔒"
                        name={t('Private preview')}
                        summary={t('On, only people the owner or an admin invites get in and visitors see nothing.')}
                        displayValue={settings.preview.value ? t('On') : t('Off')}
                        serverBadge={t('Set on the server')}
                        lock={settings.preview.lock}
                        isOwner={false}
                        isOpen={false}
                        onToggle={() => {}}
                    />

                    {/* wordsDoor (if present) */}
                    {settings.wordsDoor !== undefined && (
                        <ShapeRow
                            id="wordsDoor"
                            icon="🔑"
                            name={t('12 words at the open door')}
                            summary={t('People can join with 12 secret words without a sign-in.')}
                            displayValue={settings.wordsDoor.value ? t('On') : t('Off')}
                            lock={settings.wordsDoor.lock}
                            isOwner={isOwner && !standby}
                            isOpen={openSetting === 'wordsDoor'}
                            onToggle={() => handleOpenRow('wordsDoor', settings.wordsDoor?.value)}
                        >
                            <div className="space-y-3 pt-2">
                                <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(draftValue)}
                                        onChange={(e) => setDraftValue(e.target.checked)}
                                        className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                    />
                                    <span>{t('Allow joining with 12 secret words')}</span>
                                </label>
                                <RowControls
                                    onSave={() => handleSave('wordsDoor')}
                                    onCancel={handleCancel}
                                    consequence={consequenceText}
                                    note={note}
                                    onNoteChange={setNote}
                                    saving={saving}
                                    error={rowError}
                                    saveDisabled={draftValue === settings.wordsDoor?.value}
                                />
                            </div>
                        </ShapeRow>
                    )}
                </div>
            </div>

            {/* ── MONEY ── */}
            <div className="space-y-4 pt-2 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('MONEY')}
                </h4>
                <div className="space-y-3">
                    {/* beans */}
                    <ShapeRow
                        id="beans"
                        icon="🫘"
                        name={t('Beans')}
                        summary={t('Trades, credit and the Commons run on Beans.')}
                        extraLine={t('Includes trades held in escrow, enterprises and crowdfunding.')}
                        displayValue={settings.beans.value ? t('On') : t('Off')}
                        lock={settings.beans.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'beans'}
                        onToggle={() => handleOpenRow('beans', settings.beans.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Beans active')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('beans')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.beans.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* knownFloor */}
                    <ShapeRow
                        id="knownFloor"
                        icon="🤝"
                        name={t('Known floor for confirmed members')}
                        summary={t('An admin confirms a member on the names list; they can then owe up to this while they keep an offer listed.')}
                        extraLine={t('Cap for one member\'s raise: {cap}.').replace('{cap}', settings.knownFloor.value.cap.toLocaleString('en'))}
                        displayValue={settings.knownFloor.value.on ? t('On · {floor} Beans').replace('{floor}', settings.knownFloor.value.floor.toLocaleString('en')) : t('Off')}
                        lock={settings.knownFloor.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'knownFloor'}
                        onToggle={() => handleOpenRow('knownFloor', settings.knownFloor.value)}
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

                            <RowControls
                                onSave={() => handleSave('knownFloor')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={
                                    draftValue?.on === settings.knownFloor.value.on &&
                                    draftValue?.floor === settings.knownFloor.value.floor &&
                                    draftValue?.cap === settings.knownFloor.value.cap
                                }
                            />
                        </div>
                    </ShapeRow>
                </div>
            </div>

            {/* ── TALKING ── */}
            {settings.dmRequests !== undefined && (
                <div className="space-y-4 pt-2 border-t border-nature-800/80">
                    <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                        {t('TALKING')}
                    </h4>
                    <div className="space-y-3">
                        <ShapeRow
                            id="dmRequests"
                            icon="💬"
                            name={t('First message from someone new')}
                            summary={t('On: it waits under Requests until the person accepts.')}
                            displayValue={settings.dmRequests.value ? t('Waits under Requests') : t('Arrives straight away')}
                            lock={settings.dmRequests.lock}
                            isOwner={isOwner && !standby}
                            isOpen={openSetting === 'dmRequests'}
                            onToggle={() => handleOpenRow('dmRequests', settings.dmRequests?.value)}
                        >
                            <div className="space-y-3 pt-2">
                                <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(draftValue)}
                                        onChange={(e) => setDraftValue(e.target.checked)}
                                        className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                    />
                                    <span>{t('Hold first message under Requests')}</span>
                                </label>
                                <RowControls
                                    onSave={() => handleSave('dmRequests')}
                                    onCancel={handleCancel}
                                    consequence={consequenceText}
                                    note={note}
                                    onNoteChange={setNote}
                                    saving={saving}
                                    error={rowError}
                                    saveDisabled={draftValue === settings.dmRequests?.value}
                                />
                            </div>
                        </ShapeRow>
                    </div>
                </div>
            )}

            {/* ── DECIDING TOGETHER ── */}
            <div className="space-y-4 pt-2 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('DECIDING TOGETHER')}
                </h4>
                <div className="space-y-3">
                    <ShapeRow
                        id="decisions"
                        icon="🗳️"
                        name={t('Community votes (Decisions)')}
                        summary={t('Members who have completed a trade, and admins, propose; members vote.')}
                        displayValue={settings.decisions.value ? t('On') : t('Off')}
                        lock={settings.decisions.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'decisions'}
                        onToggle={() => handleOpenRow('decisions', settings.decisions.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Community votes active')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('decisions')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.decisions.value}
                            />
                        </div>
                    </ShapeRow>
                </div>
            </div>

            {/* ── BEING FOUND ── */}
            <div className="space-y-4 pt-2 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('BEING FOUND')}
                </h4>
                <div className="space-y-3">
                    {/* listed */}
                    <ShapeRow
                        id="listed"
                        icon="📡"
                        name={t('Listed in the BeanPool directory')}
                        summary={t('People nearby can find this community on beanpool.org and in the app.')}
                        displayValue={settings.listed.value ? t('Yes') : t('No')}
                        lock={settings.listed.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'listed'}
                        onToggle={() => handleOpenRow('listed', settings.listed.configured)}
                        allowExpandWithLock={
                            isOwner && !standby && Boolean(
                                settings.listed.lock && (
                                    settings.listed.lock.code === 'held_back' ||
                                    settings.listed.lock.code === 'schedule_never' ||
                                    (settings.listed.lock.code === 'server_env' && settings.listed.configured)
                                )
                            )
                        }
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => {
                                        if (settings.listed.lock?.code === 'server_env' && e.target.checked) return;
                                        setDraftValue(e.target.checked);
                                    }}
                                    disabled={settings.listed.lock?.code === 'server_env' && !draftValue}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500 disabled:opacity-50"
                                />
                                <span>{t('Publish to directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('listed')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={
                                    draftValue === settings.listed.configured ||
                                    (settings.listed.lock?.code === 'server_env' && draftValue === true)
                                }
                            />
                        </div>
                    </ShapeRow>

                    {/* shareLocation */}
                    <ShapeRow
                        id="shareLocation"
                        icon="📍"
                        name={t('Share location & radius')}
                        summary={t('On: anyone sees roughly where you are (to about a kilometre). Off: only members do.')}
                        displayValue={settings.shareLocation.value ? t('On') : t('Off')}
                        lock={settings.shareLocation.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'shareLocation'}
                        onToggle={() => handleOpenRow('shareLocation', settings.shareLocation.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Share location and radius in directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('shareLocation')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.shareLocation.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* shareMemberCount */}
                    <ShapeRow
                        id="shareMemberCount"
                        icon="👥"
                        name={t('Share member count')}
                        summary={t('Shows the total number of users registered on your node in the directory.')}
                        displayValue={settings.shareMemberCount.value ? t('On') : t('Off')}
                        lock={settings.shareMemberCount.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'shareMemberCount'}
                        onToggle={() => handleOpenRow('shareMemberCount', settings.shareMemberCount.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Share member count in directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('shareMemberCount')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.shareMemberCount.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* shareEmail */}
                    <ShapeRow
                        id="shareEmail"
                        icon="📧"
                        name={t('Share email')}
                        summary={t('Puts the contact email in the public directory and on the map.')}
                        displayValue={settings.shareEmail.value ? t('On') : t('Off')}
                        lock={settings.shareEmail.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'shareEmail'}
                        onToggle={() => handleOpenRow('shareEmail', settings.shareEmail.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Share email in directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('shareEmail')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.shareEmail.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* sharePhone */}
                    <ShapeRow
                        id="sharePhone"
                        icon="📞"
                        name={t('Share phone')}
                        summary={t('Puts the contact phone in the public directory and on the map.')}
                        displayValue={settings.sharePhone.value ? t('On') : t('Off')}
                        lock={settings.sharePhone.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'sharePhone'}
                        onToggle={() => handleOpenRow('sharePhone', settings.sharePhone.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Share phone in directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('sharePhone')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.sharePhone.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* shareHealth */}
                    <ShapeRow
                        id="shareHealth"
                        icon="🖥️"
                        name={t('Share health')}
                        summary={t('Shares node health diagnostics with the BeanPool team for monitoring.')}
                        displayValue={settings.shareHealth.value ? t('On') : t('Off')}
                        lock={settings.shareHealth.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'shareHealth'}
                        onToggle={() => handleOpenRow('shareHealth', settings.shareHealth.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Share node health diagnostics')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('shareHealth')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.shareHealth.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* visitors */}
                    <ShapeRow
                        id="visitors"
                        icon="👀"
                        name={t('Visitors')}
                        summary={t('What visitors see from outside the community.')}
                        displayValue={visitorsDisplay(settings.visitors.value)}
                        serverBadge={t('Set by this server\'s kind')}
                        lock={settings.visitors.lock}
                        isOwner={false}
                        isOpen={false}
                        onToggle={() => {}}
                    />
                </div>
            </div>

            {/* ── SAFETY ── */}
            <div className="space-y-4 pt-2 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('SAFETY')}
                </h4>
                <div className="space-y-3">
                    {/* probation */}
                    <ShapeRow
                        id="probation"
                        icon="⏳"
                        name={t('Limits on new accounts')}
                        summary={t('New accounts have small daily limits for their first days.')}
                        displayValue={settings.probation.value ? t('On') : t('Off')}
                        lock={settings.probation.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'probation'}
                        onToggle={() => handleOpenRow('probation', settings.probation.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Apply limits to new accounts')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('probation')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.probation.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* autoHide */}
                    <ShapeRow
                        id="autoHide"
                        icon="🛡️"
                        name={t('Reported posts hidden automatically')}
                        summary={t('Reports from three independent groups hide a post until a moderator looks.')}
                        displayValue={settings.autoHide.value ? t('On') : t('Off')}
                        lock={settings.autoHide.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'autoHide'}
                        onToggle={() => handleOpenRow('autoHide', settings.autoHide.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Hide posts after three reports')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('autoHide')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.autoHide.value}
                            />
                        </div>
                    </ShapeRow>

                    {/* autoMute */}
                    <ShapeRow
                        id="autoMute"
                        icon="🔇"
                        name={t('Repeat offenders muted automatically')}
                        summary={t('Three posts removed in 30 days stop a member posting and messaging until a moderator lifts it.')}
                        displayValue={settings.autoMute.value ? t('On') : t('Off')}
                        lock={settings.autoMute.lock}
                        isOwner={isOwner && !standby}
                        isOpen={openSetting === 'autoMute'}
                        onToggle={() => handleOpenRow('autoMute', settings.autoMute.value)}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draftValue)}
                                    onChange={(e) => setDraftValue(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500"
                                />
                                <span>{t('Mute members after repeat removals')}</span>
                            </label>
                            <RowControls
                                onSave={() => handleSave('autoMute')}
                                onCancel={handleCancel}
                                consequence={consequenceText}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draftValue === settings.autoMute.value}
                            />
                        </div>
                    </ShapeRow>
                </div>
            </div>

            {/* ── CONNECTIONS ── */}
            <div className="space-y-4 pt-2 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('CONNECTIONS')}
                </h4>
                <div className="space-y-3">
                    <ShapeRow
                        id="connections"
                        icon="🌐"
                        name={t('Connections to other communities')}
                        summary={t('Connect to other BeanPool communities over the network.')}
                        displayValue={settings.connections.value ? t('On') : t('Off')}
                        serverBadge={t('Set on the server')}
                        lock={settings.connections.lock}
                        isOwner={false}
                        isOpen={false}
                        onToggle={() => {}}
                    />
                </div>
            </div>

            {/* ── CHANGES (Audit Trail) ── */}
            <div className="space-y-4 pt-4 border-t border-nature-800/80">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">
                    {t('CHANGES')}
                </h4>
                {log.length === 0 ? (
                    <p className="text-xs text-nature-400 m-0">{t('No changes recorded yet.')}</p>
                ) : (
                    <div data-testid="shape-audit-log" className="space-y-2">
                        {log.slice(0, 50).map((entry) => (
                            <div key={`${entry.kept}-${entry.id}`} className="text-xs text-nature-300 py-1 border-b border-nature-800/50 break-words leading-relaxed">
                                <span className="font-mono text-nature-400">
                                    {formatLogDate(entry.at)}
                                </span>{' '}
                                ·{' '}
                                <span className="font-semibold text-white">
                                    {entry.actorCallsign ? `@${entry.actorCallsign}` : entry.actor}
                                </span>
                                {entry.actorRole && (
                                    <span className="text-nature-400"> ({entry.actorRole})</span>
                                )}{' '}
                                ·{' '}
                                <span className="text-white">{entry.setting}</span>
                                {entry.from !== null && entry.to !== null && (
                                    <span>: {entry.from} → {entry.to}</span>
                                )}
                                {entry.note && (
                                    <span className="text-nature-400 italic"> · &ldquo;{entry.note}&rdquo;</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Helpers & Subcomponents ──────────────────────────────────────────────────

function joinDisplay(val: JoinState): string {
    switch (val) {
        case 'members': return t('Any member invites');
        case 'admins': return t('Only admins invite');
        case 'paused': return t('Paused');
        case 'open': return t('Open');
        default: return String(val);
    }
}

function joinRadioTitle(opt: 'members' | 'admins' | 'paused'): string {
    switch (opt) {
        case 'members': return t('Invite: any member invites');
        case 'admins': return t('Known: only admins invite');
        case 'paused': return t('Paused: nobody new for now');
    }
}

function joinRadioDescription(opt: 'members' | 'admins' | 'paused'): string {
    switch (opt) {
        case 'members': return t('Any member can make an invite, from the app or the web app, and answer a request to join. This is how every community starts.');
        case 'admins': return t('Only owners and admins can make invites and answer requests to join. Members are told to ask an admin, and their app shows no invite to make.');
        case 'paused': return t('Nobody new can join. Invites already made cannot be used while new members are paused.');
    }
}

function visitorsDisplay(val: 'nothing' | 'listings' | 'open'): string {
    switch (val) {
        case 'nothing': return t('See nothing');
        case 'listings': return t('Listings only');
        case 'open': return t('Open');
        default: return String(val);
    }
}

function formatLogDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return isoDate;
    }
}

interface ShapeRowProps {
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
}

function ShapeRow({
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
                <div className="flex items-center gap-1.5 ml-auto shrink-0">
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

            {/* In-place expansion */}
            {isOpen && children && (
                <div className="pt-2 border-t border-nature-800/80">
                    {children}
                </div>
            )}
        </div>
    );
}

interface RowControlsProps {
    onSave: () => void;
    onCancel: () => void;
    consequence?: string;
    note: string;
    onNoteChange: (val: string) => void;
    saving: boolean;
    error?: string | null;
    saveDisabled?: boolean;
}

function RowControls({
    onSave,
    onCancel,
    consequence,
    note,
    onNoteChange,
    saving,
    error,
    saveDisabled,
}: RowControlsProps) {
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

            {error && (
                <div role="alert" className="p-2.5 rounded-xl bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-medium break-words">
                    {error}
                </div>
            )}

            <div className="flex items-center gap-2 pt-1">
                <button
                    type="button"
                    disabled={saving || saveDisabled}
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
        </div>
    );
}
