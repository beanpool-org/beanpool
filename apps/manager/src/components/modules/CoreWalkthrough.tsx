import React, { useEffect, useRef, useState } from 'react';
import { createAddressLookup, type AddressLookup, type AddressResult } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import { t } from '../../lib/fresh-proof';
import {
    type Shape,
    type KnownFloorDraft,
    type KnownFloorShape,
    type RecoveryCopies,
    DOOR_PRESETS,
    RECOVERY_COPIES_CHOICES,
    confirmCoreSettings,
    saveCommunityPlace,
    getConsequenceSentence,
    hoursWording,
    knownFloorChange,
    knownFloorDraftOf,
    knownFloorUnchanged,
    recoveryCopiesName,
} from '../../lib/community-shape';
import { CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX } from '@beanpool/core';
import { beansFigure, beansRefusalText, parseBeans, typedHundredths } from '../../lib/beans';

/**
 * The first-run walkthrough of Core settings (DESIGN-core-settings-fable.md §3). Offered, never forced: the community runs
 * on its choices from its first second. Every step has Back, Next and "Leave for now"; nothing is written until the last
 * step's Confirm and lock, and leaving writes nothing. A community with members opens it at the review (§7): its choices
 * are already made, so Confirm and lock sends no change at all.
 */
/** `voucherBudget` and `memberGift` are review rows only, never steps: they are changed on their own rows, beside the known floor. */
export type WalkStep = 'intro' | 'place' | 'join' | 'wordsDoor' | 'beans' | 'knownFloor' | 'voucherBudget' | 'memberGift' | 'decisions' | 'shareOutside' | 'recoveryCopies' | 'review';

export interface CoreDraft {
    join: 'members' | 'admins';
    wordsDoor: boolean | undefined;
    beans: boolean;
    /** The floor and cap as typed, in Beans (text); the node takes them as whole hundredths (knownFloorChange). */
    knownFloor: KnownFloorDraft;
    decisions: boolean;
    shareOutside: boolean | undefined;
    recoveryCopies: RecoveryCopies | undefined;
}

/** The door the community has: the stored one, paused or not. */
export function currentDoor(shape: Shape): 'members' | 'admins' {
    const j = shape.settings.join;
    if (j.door) return j.door;
    return j.value === 'admins' || (j.value === 'paused' && j.configured === 'admins') ? 'admins' : 'members';
}

/** The choices the community has now: what the walkthrough starts from, and what Confirm and lock leaves alone. */
export function draftFrom(shape: Shape): CoreDraft {
    const s = shape.settings;
    const kf: KnownFloorShape = s.knownFloor.value;
    return {
        join: currentDoor(shape),
        wordsDoor: s.wordsDoor?.value,
        beans: s.beans.value,
        knownFloor: knownFloorDraftOf(kf),
        decisions: s.decisions.value,
        shareOutside: s.shareOutside?.value,
        recoveryCopies: s.recoveryCopies?.value,
    };
}

/**
 * The server's lock on the known floor as the DRAFT sees it. The `beans_off` lock describes Beans as they are now: a
 * community whose Beans are off and who chooses On in the walkthrough is choosing the floor too (the server takes both
 * in one lock request), so that lock does not hold the floor once the draft has Beans on.
 */
export function knownFloorLock(shape: Shape, d: CoreDraft) {
    const lock = shape.settings.knownFloor.lock;
    return lock && !(lock.code === 'beans_off' && d.beans) ? lock : null;
}

/** Only the settings the owner changed, and none a server lock holds (the global kind's door, a moved ledger...). */
export function changesFrom(shape: Shape, d: CoreDraft): Record<string, unknown> {
    const s = shape.settings;
    const now = draftFrom(shape);
    const out: Record<string, unknown> = {};
    if (!s.join.lock && d.join !== now.join) out.join = d.join;
    if (s.wordsDoor && !s.wordsDoor.lock && d.wordsDoor !== now.wordsDoor) out.wordsDoor = d.wordsDoor;
    if (!s.beans.lock && d.beans !== now.beans) out.beans = d.beans;
    // The known floor is only a question while Beans are on. Sent as the node takes it, `{ on, floor_c, cap_c }` in whole
    // hundredths, and only when it differs from what the shape has (the shape's figures are hundredths too).
    if (d.beans && !knownFloorLock(shape, d)) {
        const change = knownFloorChange(d.knownFloor);
        if (change && !knownFloorUnchanged(change, s.knownFloor.value)) out.knownFloor = change;
    }
    if (!s.decisions.lock && d.decisions !== now.decisions) out.decisions = d.decisions;
    if (s.shareOutside && !s.shareOutside.lock && d.shareOutside !== now.shareOutside) out.shareOutside = d.shareOutside;
    if (s.recoveryCopies && !s.recoveryCopies.lock && d.recoveryCopies !== now.recoveryCopies) out.recoveryCopies = d.recoveryCopies;
    return out;
}

/**
 * The known floor's own limits, as the row checks them: each typed figure Beans to the cent (parseHundredths; a minus is the
 * floor below 0), the floor no more than the cap, and the cap from 2,000 to 5,000 Beans (core CREDIT_CAP_DEFAULT and
 * CREDIT_CAP_MAX, whole hundredths, as the node checks it: config/known-floor.ts checkKnownFloorSettings).
 */
export function knownFloorProblem(kf: KnownFloorDraft): string | null {
    if (!kf.on) return null;
    const floor = parseBeans(kf.floor);
    const cap = parseBeans(kf.cap);
    if (!floor.ok) return floor.refusal === 'negative' ? t("The known floor can't be negative.") : beansRefusalText(floor.refusal);
    if (!cap.ok) return beansRefusalText(cap.refusal);
    if (floor.value > cap.value) return t("The known floor can't be more than the cap.");
    if (cap.value < CREDIT_CAP_DEFAULT || cap.value > CREDIT_CAP_MAX) return t('The cap must be between 2,000 and 5,000 Beans.');
    return null;
}

export interface CoreWalkthroughProps {
    activeNode: NodeProfile;
    shape: Shape;
    /** 'review' for a community with members: straight to the last step. */
    startAt?: 'intro' | 'review';
    onLeave: () => void;
    onLocked: (shape: Shape, told: 'members' | 'nobody') => void;
}

export function CoreWalkthrough({ activeNode, shape, startAt = 'intro', onLeave, onLocked }: CoreWalkthroughProps) {
    const s = shape.settings;
    const placeNeeded = Boolean(shape.core?.place?.needed && !shape.core.place.set);
    const [draft, setDraft] = useState<CoreDraft>(() => draftFrom(shape));
    const [place, setPlace] = useState<{ lat: number; lng: number; name: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const steps: WalkStep[] = [
        'intro',
        ...(placeNeeded ? (['place'] as const) : []),
        'join',
        ...(s.wordsDoor ? (['wordsDoor'] as const) : []),
        'beans',
        ...(draft.beans && !knownFloorLock(shape, draft) ? (['knownFloor'] as const) : []),
        'decisions',
        ...(s.shareOutside ? (['shareOutside'] as const) : []),
        ...(s.recoveryCopies ? (['recoveryCopies'] as const) : []),
        'review',
    ];
    const [stepId, setStepId] = useState<WalkStep>(startAt);
    const at = Math.max(0, steps.indexOf(stepId));
    const step = steps[at];
    const go = (id: WalkStep) => { setError(null); setStepId(id); };
    const next = () => go(steps[Math.min(steps.length - 1, at + 1)]);
    const back = () => go(steps[Math.max(0, at - 1)]);

    const kfProblem = knownFloorProblem(draft.knownFloor);
    const stepBlocked =
        (step === 'place' && !place) ||
        (step === 'knownFloor' && kfProblem !== null);
    const confirmBlocked = busy || (placeNeeded && !place) || (draft.beans && !knownFloorLock(shape, draft) && kfProblem !== null);

    const confirmAndLock = async () => {
        if (confirmBlocked) return;
        setBusy(true);
        setError(null);
        try {
            // The place first (Marty, 31 Oct: mandatory for a local community), through the route Node Identity uses.
            if (placeNeeded && place) await saveCommunityPlace(activeNode.url, nodeCredential(activeNode), place);
            const res = await confirmCoreSettings(activeNode.url, nodeCredential(activeNode), changesFrom(shape, draft));
            onLocked(res.shape, res.told);
        } catch (err: unknown) {
            setError(err instanceof Error && err.message ? err.message : t('Could not confirm. Nothing was locked.'));
        } finally {
            setBusy(false);
        }
    };

    const serverHeld = (key: 'join' | 'wordsDoor' | 'beans' | 'decisions' | 'shareOutside' | 'recoveryCopies' | 'knownFloor') =>
        (key === 'knownFloor' ? knownFloorLock(shape, draft) : (s[key] as { lock: { why: string } | null } | undefined)?.lock) ?? null;

    const heldLine = (key: Parameters<typeof serverHeld>[0]) => {
        const lock = serverHeld(key);
        return lock ? (
            <p data-testid={`walk-held-${key}`} className="text-[11px] leading-relaxed m-0 p-2 rounded-lg bg-nature-900/60 text-nature-300 break-words">
                <span aria-hidden="true">🔒 </span>{lock.why}
            </p>
        ) : null;
    };

    /** Two radios, On and Off, each with what it means; the sentence of the choice not made yet shows under it. */
    const onOff = (key: 'wordsDoor' | 'beans' | 'decisions' | 'shareOutside', lead: string, name: string, extraOff?: string) => {
        const held = serverHeld(key);
        const value = draft[key] as boolean | undefined;
        const current = (key === 'beans' ? s.beans.value : (s[key] as { value: boolean } | undefined)?.value) as boolean | undefined;
        return (
            <div className="space-y-3">
                <p className="text-xs text-nature-300 m-0 leading-relaxed">{lead}</p>
                {held ? heldLine(key) : (
                    <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={name}>
                        <legend className="sr-only">{name}</legend>
                        {[true, false].map((on) => (
                            <label key={String(on)} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                <input type="radio" name={`walk-${key}`} checked={value === on}
                                    onChange={() => setDraft({ ...draft, [key]: on })} className="mt-0.5 accent-terra-500" />
                                <div>
                                    <span className="font-bold">{current === on ? (on ? t('On · now') : t('Off · now')) : (on ? t('On') : t('Off'))}</span>
                                    <p className="text-[11px] text-nature-400 m-0 mt-0.5">{getConsequenceSentence(key, on, shape)}</p>
                                    {!on && extraOff && <p className="text-[11px] text-bp-ink-warning m-0 mt-0.5">{extraOff}</p>}
                                </div>
                            </label>
                        ))}
                    </fieldset>
                )}
            </div>
        );
    };

    const reviewRow = (id: WalkStep, icon: string, name: string, value: string, held: boolean) => (
        <div key={id} data-testid={`walk-review-${id}`} className="py-2 border-b border-nature-800/60 min-w-0">
            <span className="text-xs font-bold text-white break-words"><span aria-hidden="true">{icon} </span>{name}</span>
            <p className="text-[11px] text-nature-300 m-0 mt-0.5 break-words">
                {held ? t('Set by this server') : value}
                {!held && steps.includes(id) && (
                    <>
                        {' · '}
                        <button type="button" onClick={() => go(id)} className="min-h-[40px] px-1 text-[11px] text-nature-300 underline bg-transparent border-0 cursor-pointer">
                            {t('Change')}
                        </button>
                    </>
                )}
            </p>
        </div>
    );

    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => { bodyRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [step]);

    return (
        <div data-testid="core-walkthrough" data-step={step} ref={bodyRef} className="p-3 sm:p-4 rounded-xl bg-nature-950 border border-nature-800 space-y-4">
            <p data-testid="walk-progress" className="text-[11px] font-bold text-nature-400 tracking-wider m-0 uppercase">
                {t('Step {n} of {total}').replace('{n}', String(at + 1)).replace('{total}', String(steps.length))}
            </p>

            {step === 'intro' && (
                <div className="space-y-2">
                    <h4 className="text-sm font-bold text-white m-0">{t('Core settings')}</h4>
                    <p className="text-xs text-nature-300 m-0 leading-relaxed">
                        {t('Set once, when you start your community. Changing one later affects every member, and asks you to unlock it first. Six settings, about five minutes. Your community already runs with the choices shown; this is where you make them yours.')}
                    </p>
                    <p className="text-xs text-nature-400 m-0">
                        {shape.kind === 'global' ? t('Kind of server: global community · set on the server') : t('Kind of server: local community · set on the server')}
                    </p>
                </div>
            )}

            {step === 'place' && <PlaceStep place={place} onPlace={setPlace} />}

            {step === 'join' && (
                <div className="space-y-3">
                    <h4 className="text-sm font-bold text-white m-0">{t('Who can join')}</h4>
                    <p className="text-xs text-nature-300 m-0 leading-relaxed">{t('How people get in. Invite is how every community starts. Known keeps the list of who is here with the admins.')}</p>
                    {serverHeld('join') ? heldLine('join') : (
                        <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t('Who can join')}>
                            <legend className="sr-only">{t('Who can join')}</legend>
                            {DOOR_PRESETS.map((p) => (
                                <label key={p.door} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                    <input type="radio" name="walk-join" checked={draft.join === p.door}
                                        onChange={() => setDraft({ ...draft, join: p.door })} className="mt-0.5 accent-terra-500" />
                                    <div>
                                        <span className="font-bold">{p.name}: {p.plain}</span>
                                        <p className="text-[11px] text-nature-400 m-0 mt-0.5">{p.detail}</p>
                                    </div>
                                </label>
                            ))}
                        </fieldset>
                    )}
                    {!serverHeld('join') && draft.join !== currentDoor(shape) && (
                        <p data-testid="walk-consequence" className="text-xs text-bp-ink-warning font-medium m-0 leading-relaxed">{getConsequenceSentence('join', draft.join, shape)}</p>
                    )}
                    <p className="text-[11px] text-nature-400 m-0">{t('You can pause new members any time, without unlocking this, under People & Safety → Invites & QR.')}</p>
                </div>
            )}

            {step === 'wordsDoor' && (
                <div className="space-y-2">
                    <h4 className="text-sm font-bold text-white m-0">{t('12 words at the open door')}</h4>
                    {onOff('wordsDoor', t('Whether a stranger can join this open community with 12 secret words alone, or needs a sign-in.'), t('12 words at the open door'))}
                </div>
            )}

            {step === 'beans' && (
                <div className="space-y-2">
                    <h4 className="text-sm font-bold text-white m-0">{t('Beans')}</h4>
                    {onOff('beans', t('Whether this community has prices, credit and a Commons. Off, it runs on gifts and favours.'), t('Beans'),
                        t("Off now, you can turn Beans on later. On, you can't turn them off once anyone has traded."))}
                </div>
            )}

            {step === 'knownFloor' && (
                <div className="space-y-3">
                    <h4 className="text-sm font-bold text-white m-0">{t('Known floor for confirmed members')}</h4>
                    <p className="text-xs text-nature-300 m-0 leading-relaxed">{t('How far a confirmed member can go into the community\'s trust before they must give back.')}</p>
                    <label className="flex items-center gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                        <input type="checkbox" checked={draft.knownFloor.on} onChange={(e) => setDraft({ ...draft, knownFloor: { ...draft.knownFloor, on: e.target.checked } })}
                            className="rounded border-nature-700 bg-nature-950 accent-terra-500" />
                        <span>{t('Confirmed members get the known floor')}</span>
                    </label>
                    {draft.knownFloor.on && (
                        <div className="space-y-3 pl-6">
                            <div>
                                <label htmlFor="walk-floor" className="block text-xs font-bold text-nature-300 mb-1">{t('Known floor (Beans)')}</label>
                                <input id="walk-floor" type="number" step="0.01" value={draft.knownFloor.floor}
                                    onChange={(e) => setDraft({ ...draft, knownFloor: { ...draft.knownFloor, floor: e.target.value } })}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500" />
                                <p data-testid="walk-floor-hours" className="text-[11px] text-nature-400 mt-1 m-0">{hoursWording(typedHundredths(draft.knownFloor.floor) ?? 0)}</p>
                            </div>
                            <div>
                                <label htmlFor="walk-cap" className="block text-xs font-bold text-nature-300 mb-1">{t('Cap: the most anyone may owe')}</label>
                                <input id="walk-cap" type="number" step="0.01" value={draft.knownFloor.cap}
                                    onChange={(e) => setDraft({ ...draft, knownFloor: { ...draft.knownFloor, cap: e.target.value } })}
                                    className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-terra-500" />
                            </div>
                        </div>
                    )}
                    <p className="text-xs text-bp-ink-warning font-medium m-0 leading-relaxed">{getConsequenceSentence('knownFloor', draft.knownFloor, shape)}</p>
                    {kfProblem && <p role="alert" className="text-xs text-bp-chip-danger-ink m-0">{kfProblem}</p>}
                </div>
            )}

            {step === 'decisions' && (
                <div className="space-y-2">
                    <h4 className="text-sm font-bold text-white m-0">{t('Community votes (Decisions)')}</h4>
                    {onOff('decisions', t('Whether members decide things formally, by proposal and vote, or the moderators look after things.'), t('Community votes (Decisions)'))}
                </div>
            )}

            {step === 'shareOutside' && (
                <div className="space-y-2">
                    <h4 className="text-sm font-bold text-white m-0">{t('Members may share listings outside the community')}</h4>
                    {onOff('shareOutside', t("Whether a member can show one listing to someone who isn't here, for 7 days, without names or faces."), t('Members may share listings outside the community'))}
                </div>
            )}

            {step === 'recoveryCopies' && (
                <div className="space-y-3">
                    <h4 className="text-sm font-bold text-white m-0">{t("Where members' copies go")}</h4>
                    <p className="text-xs text-nature-300 m-0 leading-relaxed">{t('When a member links Google, Apple or Facebook, where the locked copy of their account is kept.')}</p>
                    {serverHeld('recoveryCopies') ? heldLine('recoveryCopies') : (
                        <fieldset className="space-y-2 border-0 p-0 m-0" role="radiogroup" aria-label={t("Where members' copies go")}>
                            <legend className="sr-only">{t("Where members' copies go")}</legend>
                            {RECOVERY_COPIES_CHOICES.map((c) => (
                                <label key={c.rule} className="flex items-start gap-2.5 text-xs text-white cursor-pointer select-none">
                                    <input type="radio" name="walk-copies" checked={draft.recoveryCopies === c.rule}
                                        onChange={() => setDraft({ ...draft, recoveryCopies: c.rule })} className="mt-0.5 accent-terra-500" />
                                    <div>
                                        <span className="font-bold">{c.name}</span>
                                        <p className="text-[11px] text-nature-400 m-0 mt-0.5">{c.words}</p>
                                        <p className="text-[11px] text-bp-ink-warning m-0 mt-0.5">{getConsequenceSentence('recoveryCopies', c.rule, shape)}</p>
                                    </div>
                                </label>
                            ))}
                        </fieldset>
                    )}
                </div>
            )}

            {step === 'review' && (
                <div className="space-y-3">
                    <h4 className="text-sm font-bold text-white m-0">{t('Review, then confirm')}</h4>
                    <div>
                        {placeNeeded && reviewRow('place', '📍', t('Where your community is'), place ? place.name : t('Not set yet'), false)}
                        {reviewRow('join', '🚪', t('Who can join'), draft.join === 'admins' ? t('Known: only admins invite') : t('Invite: any member invites'), Boolean(serverHeld('join')))}
                        {s.wordsDoor && reviewRow('wordsDoor', '🔑', t('12 words at the open door'), draft.wordsDoor ? t('On') : t('Off'), Boolean(serverHeld('wordsDoor')))}
                        {reviewRow('beans', '🫘', t('Beans'), draft.beans ? t('On') : t('Off'), Boolean(serverHeld('beans')))}
                        {draft.beans && reviewRow('knownFloor', '🤝', t('Known floor for confirmed members'),
                            draft.knownFloor.on ? t('On · {floor} Beans').replace('{floor}', beansFigure(typedHundredths(draft.knownFloor.floor))) : t('Off'), Boolean(serverHeld('knownFloor')))}
                        {/* A Core setting with no step of its own (slices G1, V5): shown as it stands, so Confirm and lock never locks what isn't seen. */}
                        {draft.beans && s.voucherBudget && reviewRow('voucherBudget', '🎟️', t('Budget per voucher'),
                            t('{n} Beans').replace('{n}', beansFigure(s.voucherBudget.configured)), false)}
                        {draft.beans && s.memberGift && reviewRow('memberGift', '🎁', t('Members giving part of their credit line'),
                            s.memberGift.configured > 0 ? t('On · up to {n} Beans').replace('{n}', beansFigure(s.memberGift.configured)) : t('Off'), false)}
                        {reviewRow('decisions', '🗳️', t('Community votes (Decisions)'), draft.decisions ? t('On') : t('Off'), Boolean(serverHeld('decisions')))}
                        {s.shareOutside && reviewRow('shareOutside', '🔗', t('Members may share listings outside the community'), draft.shareOutside ? t('On') : t('Off'), Boolean(serverHeld('shareOutside')))}
                        {s.recoveryCopies && reviewRow('recoveryCopies', '🗝️', t("Where members' copies go"), recoveryCopiesName(draft.recoveryCopies ?? 'vault'), Boolean(serverHeld('recoveryCopies')))}
                    </div>
                    {steps.length > 2 && startAt === 'review' && (
                        <button type="button" data-testid="walk-through-them" onClick={() => go('intro')}
                            className="min-h-[44px] text-xs text-nature-300 underline bg-transparent border-0 p-0 cursor-pointer">
                            {t('Walk through them')}
                        </button>
                    )}
                    <p className="text-[11px] text-nature-400 m-0 leading-relaxed">
                        {t('After you confirm, each change asks you to unlock it first, and every owner is told.')}
                    </p>
                </div>
            )}

            {error && <div role="alert" data-testid="walk-error" className="p-2.5 rounded-xl bg-bp-chip-danger-tint text-bp-chip-danger-ink text-xs font-medium break-words">{error}</div>}

            <div className="flex flex-wrap items-center gap-2 pt-1">
                {at > 0 && (
                    <button type="button" disabled={busy} onClick={back}
                        className="py-2 px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-nature-300 hover:text-white min-h-[44px]">
                        {t('Back')}
                    </button>
                )}
                {step !== 'review' ? (
                    <button type="button" data-testid="walk-next" disabled={stepBlocked} onClick={next}
                        className="py-2 px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50 min-h-[44px]">
                        {t('Next')}
                    </button>
                ) : (
                    <button type="button" data-testid="walk-confirm" disabled={confirmBlocked} onClick={() => void confirmAndLock()}
                        className="py-2 px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50 min-h-[44px]">
                        {busy ? t('Saving...') : t('Confirm and lock')}
                    </button>
                )}
                <button type="button" data-testid="walk-leave" disabled={busy} onClick={onLeave}
                    className="py-2 px-3 text-xs text-nature-300 hover:text-white underline bg-transparent border-0 min-h-[44px] cursor-pointer">
                    {t('Leave for now')}
                </button>
            </div>
            {step === 'review' && placeNeeded && !place && (
                <p data-testid="walk-place-needed" className="text-[11px] text-bp-ink-warning m-0">
                    {t('Set where your community is first: a community confirms its core settings with its place set.')}
                </p>
            )}
        </div>
    );
}

/** The community's place: a search, then a pick. The pin and radius are fine-tuned later in Node Identity. */
function PlaceStep({ place, onPlace }: { place: { lat: number; lng: number; name: string } | null; onPlace: (p: { lat: number; lng: number; name: string }) => void }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<AddressResult[]>([]);
    const [searching, setSearching] = useState(false);
    const lookupRef = useRef<AddressLookup | null>(null);

    useEffect(() => {
        const lookup = createAddressLookup({
            onState: (state) => {
                if (state.status === 'searching') setSearching(true);
                else if (state.status === 'idle') { setSearching(false); setResults([]); }
                else if (state.status === 'done') { setSearching(false); setResults(state.results); }
                else setSearching(false);
            },
        });
        lookupRef.current = lookup;
        return () => { lookup.dispose(); lookupRef.current = null; };
    }, []);

    return (
        <div className="space-y-3">
            <h4 className="text-sm font-bold text-white m-0">{t('Where your community is')}</h4>
            <p className="text-xs text-nature-300 m-0 leading-relaxed">
                {t('A local community is a place on the map. Search for your town or street and pick it. You can place the pin and set the radius exactly later, under Appliance & Data → Node Identity.')}
            </p>
            <label htmlFor="walk-place-search" className="block text-xs font-bold text-nature-300">{t('Search for a location...')}</label>
            <input id="walk-place-search" data-testid="walk-place-search" type="text" value={query}
                onChange={(e) => { setQuery(e.target.value); lookupRef.current?.input(e.target.value); }}
                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500" />
            {searching && <p className="text-[11px] text-nature-400 m-0" role="status">{t('Searching…')}</p>}
            {results.length > 0 && (
                <ul className="list-none p-0 m-0 space-y-1" aria-label={t('Location suggestions')}>
                    {results.map((r, i) => (
                        <li key={`${r.lat},${r.lng},${i}`}>
                            <button type="button" data-testid="walk-place-result"
                                onClick={() => { onPlace({ lat: r.lat, lng: r.lng, name: r.displayName }); setQuery(r.displayName); setResults([]); }}
                                className="w-full text-left min-h-[44px] px-3 py-2 rounded-lg bg-nature-900 hover:bg-nature-800 text-xs text-nature-100 border border-nature-800 break-words cursor-pointer">
                                {r.displayName}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {place && <p data-testid="walk-place-chosen" className="text-xs text-bp-chip-ok-ink m-0 break-words">✓ {place.name}</p>}
        </div>
    );
}
