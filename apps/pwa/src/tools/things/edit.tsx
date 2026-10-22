/**
 * Add or edit a thing (the Tool shed's `edit`, DESIGN-tool-library-fable.md §2.2, round 2 row 9): one column at 320 px.
 * A photo (one, kept in this browser at 800 px, never on the node until a listing is posted with it), its name, category
 * and condition, what it is worth if lost or broken in the lender's own words and money (settled between the people,
 * never held by BeanPool), how they lend it, the longest loan, and a note only they see. Save keeps it and goes back.
 * The phone's twin is apps/native/tools/things/edit.tsx.
 *
 * A save is refused, in one sentence and with nothing written, for a 101st thing and for a shed past the store's bound
 * (64 KB, as core reports it). A photo chosen and not kept is taken out of the store again.
 */
import { useRef, useState } from 'react';
import {
    THING_CONDITIONS, THING_INPUT_CHARS, findThing, normalizeCategory, saveThing, shedFits, shedFullLine, shedHasRoom, shedTooBigLine,
    t, thingCategories, thingCategory, thingConditionName, thingInput, thingInputProblems,
    type ThingCondition, type ThingInput, type ThingsScreenProps, type ToolPhoto as Photo,
} from '@beanpool/core';
import { ToolButton, ToolChips, ToolEmpty, ToolInput, ToolNote, ToolPhoto, ToolRow, ToolSection } from '../ui';
import { BUTTONS, newThingId } from './parts';

export function EditScreen({ host, params }: ThingsScreenProps) {
    const existing = params.key ? findThing(host.doc.get(), params.key) : null;
    const [input, setInput] = useState<ThingInput>(() => thingInput(existing));
    const [tried, setTried] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [categoriesOpen, setCategoriesOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    /** Photos chosen here and not yet kept by a save: taken out of the store again if the member leaves without one. */
    const chosen = useRef<string[]>([]);

    if (params.key && !existing) {
        return (
            <div data-testid="thing-edit-screen" className="min-w-0">
                <ToolEmpty icon="🧰" title={t('This thing is no longer in your Tool shed.')} testId="thing-missing" />
            </div>
        );
    }
    const problems = tried ? thingInputProblems(input) : [];
    const field = (key: keyof ThingInput) => (value: string) => setInput((was) => ({ ...was, [key]: value }));
    const cat = thingCategory(input.category);

    const took = (photo: Photo | null) => {
        if (!photo) return;
        chosen.current.push(photo.ref);
        setInput((was) => ({ ...was, photo: photo.ref }));
    };
    const pick = async () => { took(await host.photos.pick().catch(() => null)); };
    const take = async () => { took(await host.camera.take().catch(() => null)); };
    /** Photos no longer used once `kept` is the thing's photo: what was chosen here, and the one it had. */
    const unused = (kept: string | null) => [...chosen.current, ...(existing?.photo ? [existing.photo] : [])].filter((ref) => ref !== kept);

    const save = async () => {
        if (busy) return;
        setTried(true);
        setProblem(null);
        if (thingInputProblems(input).length > 0) return;
        const doc = host.doc.get();
        if (!existing && !shedHasRoom(doc)) { setProblem(shedFullLine()); return; }
        const now = host.now();
        const next = saveThing(doc, input, { id: existing?.id ?? null, newId: newThingId(now), now });
        if (!shedFits(next)) { setProblem(shedTooBigLine()); return; }
        setBusy(true);
        try {
            await host.doc.set(next);
        } catch {
            setBusy(false);
            setProblem(t("Couldn't save it in this browser. Try again."));
            return;
        }
        const drop = unused(input.photo);
        chosen.current = [];
        await Promise.all(drop.map((ref) => host.photos.remove(ref).catch(() => {})));
        host.back();
    };
    const cancel = async () => {
        const drop = chosen.current.filter((ref) => ref !== existing?.photo);
        chosen.current = [];
        await Promise.all(drop.map((ref) => host.photos.remove(ref).catch(() => {})));
        host.back();
    };

    return (
        <div data-testid="thing-edit-screen" className="min-w-0">
            <ToolSection title={t('Photo')}>
                {input.photo ? <ToolPhoto uri={host.photos.uri(input.photo)} label={t('Photo of {name}', { name: input.name.trim() || cat.name })} testId="edit-photo" /> : null}
                <div className={BUTTONS}>
                    <ToolButton onClick={() => { void take(); }} testId="edit-photo-take">{t('Take a photo')}</ToolButton>
                    <ToolButton onClick={() => { void pick(); }} testId="edit-photo-pick">{t('Choose a photo')}</ToolButton>
                    {input.photo ? <ToolButton onClick={() => setInput((was) => ({ ...was, photo: null }))} testId="edit-photo-remove">{t('Remove photo')}</ToolButton> : null}
                </div>
                <ToolNote text={t('Kept in this browser. It goes to the Market only with a listing you post.')} />
            </ToolSection>
            <ToolSection>
                <ToolInput label={t('What is it?')} value={input.name} onChange={field('name')} max={THING_INPUT_CHARS.name}
                    error={problems.includes('name') ? t('Give it a name.') : null} testId="edit-name" />
                <ToolRow icon={cat.emoji} title={t('Category')} state={cat.name} onClick={() => setCategoriesOpen((o) => !o)} testId="edit-category-open" />
                {categoriesOpen ? (
                    <div className="p-3 min-w-0">
                        <ToolChips label={t('Category')} picked={normalizeCategory(input.category)}
                            chips={thingCategories().map((c) => ({ id: c.id, label: `${c.emoji} ${c.name}` }))}
                            onPick={(v) => { field('category')(v); setCategoriesOpen(false); }} testId="edit-category" />
                    </div>
                ) : null}
                <div className="px-3 py-2 min-w-0">
                    <ToolChips label={t('Condition')} heading picked={input.condition || null}
                        chips={THING_CONDITIONS.map((c) => ({ id: c, label: thingConditionName(c) ?? c }))}
                        onPick={(v) => setInput((was) => ({ ...was, condition: was.condition === v ? '' : v as ThingCondition }))} testId="edit-condition" />
                </div>
                <ToolInput label={t("If it's lost or broken")} value={input.replacementValue} onChange={field('replacementValue')} max={THING_INPUT_CHARS.replacementValue}
                    hint={t('In your own words and money, like "$120" or "like for like". Settled between you and the borrower; BeanPool never holds or collects it.')}
                    testId="edit-replacement" />
                <ToolInput label={t('How you lend it')} value={input.lendTerms} onChange={field('lendTerms')} max={THING_INPUT_CHARS.lendTerms} lines={3}
                    hint={t('For example: clean it, full tank, back within a week. Anyone who sees the listing reads this.')} testId="edit-terms" />
                <ToolInput label={t('Longest loan, in days')} value={input.lendMaxDays} onChange={field('lendMaxDays')} max={THING_INPUT_CHARS.lendMaxDays} numeric
                    error={problems.includes('lendMaxDays') ? t('A number of days from 1 to 365.') : null} testId="edit-days" />
                <ToolInput label={t('Your own note')} value={input.ownerNote} onChange={field('ownerNote')} max={THING_INPUT_CHARS.ownerNote} lines={3}
                    hint={host.nodeCopy.on
                        ? t("Where it lives, a serial number. Only you see this. Like everything on your community's server, its operator could.")
                        : t('Where it lives, a serial number. Only you see this. It stays in this browser.')}
                    testId="edit-note" />
            </ToolSection>
            <ToolSection>
                {problem ? <ToolNote tone="danger" text={problem} testId="edit-problem" /> : null}
                <div className={BUTTONS}>
                    <ToolButton kind="primary" onClick={() => { void save(); }} disabled={busy} testId="edit-save">{t('Save')}</ToolButton>
                    <ToolButton onClick={() => { void cancel(); }} testId="edit-cancel">{t('Cancel')}</ToolButton>
                </div>
            </ToolSection>
        </div>
    );
}
