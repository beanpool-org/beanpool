import React, { useEffect, useMemo, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';
import { getTfaSessionToken } from '../../lib/node-client';
import { useTimeout } from '../../lib/use-timeout';
import { t } from '../../lib/fresh-proof';
import {
    type Shape,
    type ShapeSettings,
    fetchCommunityShape,
    updateCommunityShape,
    getConsequenceSentence,
    REMOVAL_DECIDER_CHOICES,
    removalDeciderName,
} from '../../lib/community-shape';
import { RowControls, ShapeRow, visitorsDisplay } from './ShapeRows';
import { ChangesLog } from './ChangesLog';

/**
 * The everyday rules that used to sit in "How this community works" and now sit where they are used (Core settings design
 * §6.1): Pause new members and Requests to join under People & Safety → Invites & QR; the message, limits and safety
 * switches under Triage & Moderation; being found under Appliance & Data → Node Identity; connections under Gateway &
 * Peers. The same rows, the same consequence sentences and the same owner-only save as before. They ask no fresh proof,
 * locked or not (Core settings is the lock's page, not this one); admins read.
 */
export type EverydayGroup = 'taking' | 'rules' | 'found' | 'connections';

/** The settings each card shows the Changes lines of. */
const GROUP_LOG: Record<EverydayGroup, string[]> = {
    taking: ['join', 'knocks'],
    rules: ['dmRequests', 'probation', 'autoHide', 'autoHideReports', 'autoMute', 'removalDecider'],
    found: ['listed', 'doorCheck', 'shareLocation', 'shareMemberCount', 'shareEmail', 'sharePhone', 'shareHealth'],
    connections: [],
};

type BoolKey = 'knocks' | 'doorCheck' | 'dmRequests' | 'probation' | 'autoHide' | 'autoMute' | 'shareLocation' | 'shareMemberCount' | 'shareEmail' | 'sharePhone' | 'shareHealth';

interface BoolRow { key: BoolKey; icon: string; name: string; summary: string; label: string; display?: (on: boolean) => string }

export interface EverydayRuleRowsProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    group: EverydayGroup;
    /** The card's heading. */
    title: string;
    intro?: string;
}

/** Pausing, or un-pausing back to the door the community has (never a Core change: server config/core-settings.ts). */
function pauseTarget(shape: Shape, paused: boolean): 'paused' | 'members' | 'admins' {
    return paused ? 'paused' : (shape.settings.join.door ?? (shape.settings.join.configured === 'admins' ? 'admins' : 'members'));
}

export function EverydayRuleRows({ activeNode, viewer, group, title, intro }: EverydayRuleRowsProps) {
    const isOwner = viewer?.kind === 'password' || viewer?.role === 'owner';
    const [shape, setShape] = useState<Shape | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [open, setOpen] = useState<string | null>(null);
    const [draft, setDraft] = useState<any>(null);
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);
    const [rowError, setRowError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string | null>(null);
    const savedTimer = useTimeout();

    const load = async () => {
        setLoadError(null);
        try {
            const data = await fetchCommunityShape(activeNode.url, nodeCredential(activeNode), getTfaSessionToken(activeNode.id));
            // An answer that is not a shape (an older node, an error body) is a failed load, never a crash.
            if (!data?.settings || !Array.isArray(data.log)) throw new Error(t('Could not load these rules.'));
            setShape(data);
        } catch (err: any) {
            setLoadError(err?.message || t('Could not load these rules.'));
        }
    };
    useEffect(() => {
        void load();
        setOpen(null);
        setDraft(null);
    }, [activeNode.id, activeNode.url]);

    const rows: BoolRow[] = useMemo(() => {
        const onOff = (on: boolean) => (on ? t('On') : t('Off'));
        const all: Record<EverydayGroup, BoolRow[]> = {
            taking: [
                { key: 'knocks', icon: '🔔', name: t('Requests to join'), summary: t('People who find you can ask; a member answers with an invite.'), label: t('Take requests to join'), display: onOff },
            ],
            rules: [
                { key: 'dmRequests', icon: '💬', name: t('First message from someone new'), summary: t('On: it waits under Message requests until the person accepts.'), label: t('Hold first message under Message requests'), display: (on) => (on ? t('Waits under Message requests') : t('Arrives straight away')) },
                { key: 'probation', icon: '⏳', name: t('Limits on new accounts'), summary: t('New accounts have small daily limits for their first days.'), label: t('Apply limits to new accounts'), display: onOff },
                { key: 'autoHide', icon: '🛡️', name: t('Reported posts hidden and message requests cleared automatically'), summary: t('Reports from three independent groups hide a post until a moderator looks. Reports from the people a sender wrote to can clear their message requests too.'), label: t('Hide reported posts and clear reported message requests'), display: onOff },
                { key: 'autoMute', icon: '🔇', name: t('Repeat offenders muted automatically'), summary: t('Three posts removed in 30 days stop a member posting and messaging until a moderator lifts it.'), label: t('Mute members after repeat removals'), display: onOff },
            ],
            found: [
                { key: 'doorCheck', icon: '🛡️', name: t('A person check on busy days'), summary: t('When lots of people are joining, a 12-words join starts with a Cloudflare check. Needs the TURNSTILE keys on the server; without them it does nothing.'), label: t('Ask for a person check on busy days'), display: onOff },
                { key: 'shareLocation', icon: '📍', name: t('Share location & radius'), summary: t('On: anyone sees roughly where you are (to about a kilometre). Off: only members do.'), label: t('Share location and radius in directory'), display: onOff },
                { key: 'shareMemberCount', icon: '👥', name: t('Share member count'), summary: t('Shows the total number of users registered on your node in the directory.'), label: t('Share member count in directory'), display: onOff },
                { key: 'shareEmail', icon: '📧', name: t('Share email'), summary: t('Puts the contact email in the public directory and on the map.'), label: t('Share email in directory'), display: onOff },
                { key: 'sharePhone', icon: '📞', name: t('Share phone'), summary: t('Puts the contact phone in the public directory and on the map.'), label: t('Share phone in directory'), display: onOff },
                { key: 'shareHealth', icon: '🖥️', name: t('Share health'), summary: t('Shares node health diagnostics with the BeanPool team for monitoring.'), label: t('Share node health diagnostics'), display: onOff },
            ],
            connections: [],
        };
        return all[group];
    }, [group]);

    if (!shape) {
        return (
            <div data-testid={`everyday-${group}`} className="p-4 rounded-xl bg-nature-900/80 border border-nature-800 space-y-2">
                <h4 className="text-xs font-bold text-nature-400 tracking-wider m-0 uppercase">{title}</h4>
                {loadError ? (
                    <div className="space-y-2">
                        <p className="text-xs text-red-400 m-0">{loadError}</p>
                        <button type="button" onClick={() => void load()} className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white min-h-[40px]">{t('Retry')}</button>
                    </div>
                ) : (
                    <p className="text-xs text-nature-400 m-0">{t('Loading…')}</p>
                )}
            </div>
        );
    }

    const { settings, standby } = shape;
    const canEdit = isOwner && !standby;

    const toggle = (key: string, current: unknown) => {
        if (!canEdit) return;
        if (open === key) {
            setOpen(null);
            setDraft(null);
            setNote('');
            setRowError(null);
            return;
        }
        setOpen(key);
        setDraft(current);
        setNote('');
        setRowError(null);
        setSaved(null);
    };
    const cancel = () => {
        setOpen(null);
        setDraft(null);
        setNote('');
        setRowError(null);
    };
    const save = async (settingKey: string, value: unknown) => {
        setSaving(true);
        setRowError(null);
        try {
            const res = await updateCommunityShape(activeNode.url, nodeCredential(activeNode), { [settingKey]: value }, note, getTfaSessionToken(activeNode.id));
            setShape(res.shape);
            setOpen(null);
            setDraft(null);
            setNote('');
            setSaved(res.told === 'members' ? t('Saved, and every member is told.') : t('Saved!'));
            savedTimer.schedule(() => setSaved(null), 4000);
        } catch (err: any) {
            setRowError(err?.message || t('Failed to save change'));
        } finally {
            setSaving(false);
        }
    };
    const consequence = open && draft !== null
        ? getConsequenceSentence((open === 'pause' ? 'join' : open) as keyof ShapeSettings, open === 'pause' ? pauseTarget(shape, Boolean(draft)) : draft, shape)
        : '';

    const checkbox = (label: string) => (
        <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
            <input type="checkbox" checked={Boolean(draft)} onChange={(e) => setDraft(e.target.checked)}
                className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500" />
            <span>{label}</span>
        </label>
    );

    const logLines = shape.log.filter((l) => GROUP_LOG[group].includes(l.setting.split('.')[0]));
    const paused = settings.join.value === 'paused';
    const listedLock = settings.listed.lock;
    const listedOpenWithLock = Boolean(listedLock && (listedLock.code === 'held_back' || listedLock.code === 'schedule_never' || (listedLock.code === 'server_env' && settings.listed.configured)));

    return (
        <div data-testid={`everyday-${group}`} className="p-4 sm:p-5 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-4">
            <div>
                <h4 className="text-sm font-bold text-white m-0">{title}</h4>
                {intro && <p className="text-xs text-nature-400 m-0 mt-0.5 leading-relaxed">{intro}</p>}
                {!canEdit && (
                    <p data-testid={`everyday-${group}-hint`} className="text-xs text-nature-400 m-0 mt-1">
                        {standby ? t('This is a standby: change it on the main server.') : t("You're an admin: this card is read-only.")}
                    </p>
                )}
            </div>
            {saved && <div role="status" className="p-3 rounded-xl bg-bp-chip-ok-tint text-bp-chip-ok-ink text-xs font-semibold">{saved}</div>}
            <div className="space-y-3">
                {group === 'taking' && (
                    <ShapeRow
                        id="pause"
                        icon="⏸️"
                        name={t('Pause new members')}
                        summary={t('Nobody new can join while it is paused. Invites already made cannot be used.')}
                        displayValue={paused ? t('Paused') : t('Taking new members')}
                        lock={settings.join.lock}
                        isOwner={canEdit}
                        isOpen={open === 'pause'}
                        onToggle={() => toggle('pause', paused)}
                    >
                        <div className="space-y-3 pt-2">
                            {checkbox(t('Pause new members'))}
                            <RowControls
                                onSave={() => save('join', pauseTarget(shape, Boolean(draft)))}
                                onCancel={cancel}
                                consequence={consequence}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={Boolean(draft) === paused}
                            />
                        </div>
                    </ShapeRow>
                )}
                {group === 'found' && (
                    <ShapeRow
                        id="listed"
                        icon="📡"
                        name={t('Listed in the BeanPool directory')}
                        summary={t('People nearby can find this community on beanpool.org and in the app.')}
                        displayValue={settings.listed.value ? t('Yes') : t('No')}
                        lock={listedLock}
                        isOwner={canEdit}
                        isOpen={open === 'listed'}
                        onToggle={() => {
                            if (listedLock && !listedOpenWithLock) return;
                            toggle('listed', settings.listed.configured);
                        }}
                        allowExpandWithLock={canEdit && listedOpenWithLock}
                    >
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={Boolean(draft)}
                                    onChange={(e) => {
                                        if (listedLock?.code === 'server_env' && e.target.checked) return;
                                        setDraft(e.target.checked);
                                    }}
                                    disabled={listedLock?.code === 'server_env' && !draft}
                                    className="rounded border-nature-700 bg-nature-950 text-bp-ink-terra accent-terra-500 disabled:opacity-50"
                                />
                                <span>{t('Publish to directory')}</span>
                            </label>
                            <RowControls
                                onSave={() => save('listed', draft)}
                                onCancel={cancel}
                                consequence={consequence}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draft === settings.listed.configured || (listedLock?.code === 'server_env' && draft === true)}
                            />
                        </div>
                    </ShapeRow>
                )}
                {rows.map((r) => {
                    const setting = settings[r.key as keyof ShapeSettings] as { value: boolean; lock: any } | undefined;
                    if (!setting) return null;
                    return (
                        <ShapeRow
                            key={r.key}
                            id={r.key}
                            icon={r.icon}
                            name={r.name}
                            summary={r.summary}
                            displayValue={(r.display ?? ((on: boolean) => (on ? t('On') : t('Off'))))(setting.value)}
                            lock={setting.lock}
                            isOwner={canEdit}
                            isOpen={open === r.key}
                            onToggle={() => toggle(r.key, setting.value)}
                        >
                            <div className="space-y-3 pt-2">
                                {checkbox(r.label)}
                                <RowControls
                                    onSave={() => save(r.key, draft)}
                                    onCancel={cancel}
                                    consequence={consequence}
                                    note={note}
                                    onNoteChange={setNote}
                                    saving={saving}
                                    error={rowError}
                                    saveDisabled={draft === setting.value}
                                />
                            </div>
                        </ShapeRow>
                    );
                })}
                {/* Who decides a removal (removal jury, DESIGN-removal-jury-fable.md §6): its lock refuses only A jury, so the row
                    opens whatever it says, and A jury is the one choice it holds back while fewer than 36 could serve. */}
                {group === 'rules' && settings.removalDecider && (
                    <ShapeRow
                        id="removalDecider"
                        icon="⚖️"
                        name={t('Who decides a removal')}
                        summary={t('When an admin pauses a member, a vote decides whether they are removed.')}
                        extraLine={t('{n} members could serve on a jury today.').replace('{n}', settings.removalDecider.poolSize.toLocaleString('en'))}
                        displayValue={removalDeciderName(settings.removalDecider.configured)}
                        lock={settings.removalDecider.lock}
                        isOwner={canEdit}
                        isOpen={open === 'removalDecider'}
                        onToggle={() => toggle('removalDecider', settings.removalDecider!.configured)}
                        allowExpandWithLock={canEdit}
                    >
                        <div className="space-y-3 pt-2">
                            <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t('Who decides a removal')}>
                                <legend className="sr-only">{t('Who decides a removal')}</legend>
                                {REMOVAL_DECIDER_CHOICES.map((choice) => {
                                    const heldBack = choice.rule === 'jury' && settings.removalDecider!.lock?.code === 'pool_too_small';
                                    return (
                                        <label key={choice.rule} className={`flex items-start gap-2.5 text-xs text-white select-none ${heldBack ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                                            <input
                                                type="radio"
                                                name="shape-removal-decider-radio"
                                                value={choice.rule}
                                                checked={draft === choice.rule}
                                                disabled={heldBack}
                                                onChange={() => setDraft(choice.rule)}
                                                className="mt-0.5 accent-terra-500"
                                            />
                                            <div>
                                                <span className="font-bold">{choice.name}</span>
                                                <p className="text-[11px] text-nature-400 m-0 mt-0.5">{choice.words}</p>
                                            </div>
                                        </label>
                                    );
                                })}
                            </fieldset>
                            <RowControls
                                onSave={() => save('removalDecider', draft)}
                                onCancel={cancel}
                                consequence={consequence}
                                note={note}
                                onNoteChange={setNote}
                                saving={saving}
                                error={rowError}
                                saveDisabled={draft === settings.removalDecider.configured}
                            />
                        </div>
                    </ShapeRow>
                )}
                {group === 'found' && (
                    <>
                        <ShapeRow
                            id="visitors"
                            icon="👀"
                            name={t('Visitors')}
                            summary={t('What visitors see from outside the community.')}
                            displayValue={visitorsDisplay(settings.visitors.value)}
                            serverBadge={t("Set by this server's kind")}
                            lock={settings.visitors.lock}
                            isOwner={false}
                            isOpen={false}
                            onToggle={() => {}}
                        />
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
                    </>
                )}
                {group === 'connections' && (
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
                )}
            </div>
            {GROUP_LOG[group].length > 0 && (
                <div className="space-y-2 pt-3 border-t border-nature-800/80">
                    <h5 className="text-[11px] font-bold text-nature-400 tracking-wider m-0 uppercase">{t('CHANGES')}</h5>
                    <ChangesLog lines={logLines} limit={10} />
                </div>
            )}
        </div>
    );
}
