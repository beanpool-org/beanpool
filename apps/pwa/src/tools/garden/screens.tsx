/**
 * Your garden's web screens, the same as the phone's (grow-food slice G0: the planting guide; DESIGN-grow-food-fable.md
 * §3). `main` is the guide: the zone line in plain words with Change, then Sow now, Soon and every crop grown here.
 * `crop` is one crop's page, `zone` is Change. The covered page draws the frame and, while nothing is chosen, the two
 * doors. Optional help for new growers: nothing here gates anything, and nothing is sent anywhere. The rules are core's
 * (tools/garden/guide.ts), shared with the phone's screens.
 */
import { useEffect, useRef, useState } from 'react';
import {
    GARDEN_ZONES, HEMISPHERE_WORDS, ZONE_ICONS, capitalFirst, climateCreditLine, cropById, cropPage, gardenZoneFix, guideGeneralLine,
    guideView, harvestLine, soonLine, t, weeksText, withGardenClimate, zoneLineText, zoneSourceText,
    type GardenScreenProps, type GardenZoneId, type Hemisphere, type ToolPlace,
} from '@beanpool/core';
import { ToolButton, ToolChips, ToolEmpty, ToolField, ToolLive, ToolNote, ToolRow, ToolSection } from '../ui';

const BUTTONS = 'p-3 flex flex-wrap gap-2 min-w-0';

/** The place the app already has, read once a screen opens: undefined while it is being read. */
function usePlace(host: GardenScreenProps['host']): ToolPlace | null | undefined {
    const [place, setPlace] = useState<ToolPlace | null | undefined>(undefined);
    useEffect(() => {
        let gone = false;
        host.place().then((p) => { if (!gone) setPlace(p); }, () => { if (!gone) setPlace(null); });
        return () => { gone = true; };
    }, []);
    return place;
}

function Foot() {
    return (
        <ToolSection>
            <ToolNote text={guideGeneralLine()} testId="garden-general" />
            <ToolNote text={climateCreditLine()} testId="garden-credit" />
        </ToolSection>
    );
}

/** The guide. */
export function Main({ host }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const fix = gardenZoneFix(doc.settings, place ?? null);
    if (!fix && place === undefined) return <div data-testid="garden-main" className="min-w-0"><ToolNote text={t('Finding your climate…')} testId="garden-finding" /></div>;
    if (!fix) {
        return (
            <div data-testid="garden-main" className="min-w-0">
                <ToolEmpty icon="🌍" title={t('Choose your climate to see what to sow when.')} testId="garden-no-zone">
                    <ToolButton kind="primary" onClick={() => host.navigate('zone')} testId="garden-choose">{t('Choose your climate')}</ToolButton>
                </ToolEmpty>
                <Foot />
            </div>
        );
    }
    const month = new Date(host.now()).getMonth();
    const view = guideView(fix.zone, fix.hemisphere, month);
    const open = (id: string) => host.navigate('crop', { key: id });
    return (
        <div data-testid="garden-main" className="min-w-0">
            <ToolSection>
                <ToolRow icon={ZONE_ICONS[fix.zone]} title={zoneLineText(fix.zone, fix.hemisphere)} wrap testId="garden-zone-line" />
                <ToolNote text={zoneSourceText(fix.source)} testId="garden-zone-source" />
                <div className={BUTTONS}>
                    <ToolButton onClick={() => host.navigate('zone')} testId="garden-change">{t('Change')}</ToolButton>
                </div>
            </ToolSection>
            <ToolSection title={t('Sow now')} testId="garden-now">
                {view.now.length === 0 ? <ToolNote text={t('Nothing to sow outdoors this month.')} testId="garden-now-none" /> : view.now.map((c) => (
                    <ToolRow key={c.id} icon={c.icon} title={t(c.name)} wrap state={harvestLine(c)} onClick={() => open(c.id)} testId={`garden-now-${c.id}`} />
                ))}
            </ToolSection>
            {view.soon.length > 0 && (
                <ToolSection title={t('Soon')} testId="garden-soon">
                    {view.soon.map(({ crop: c, from }) => (
                        <ToolRow key={c.id} icon={c.icon} title={t(c.name)} wrap state={soonLine(from)} onClick={() => open(c.id)} testId={`garden-soon-${c.id}`} />
                    ))}
                </ToolSection>
            )}
            <ToolSection title={t('All crops')} testId="garden-all">
                {view.all.map((c) => (
                    <ToolRow key={c.id} icon={c.icon} title={t(c.name)} wrap state={cropPage(c, fix.zone, fix.hemisphere).sow} onClick={() => open(c.id)} testId={`garden-all-${c.id}`} />
                ))}
            </ToolSection>
            <Foot />
        </div>
    );
}

/** One crop's page. */
export function Crop({ host, params }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const crop = cropById(params.key ?? '');
    const fix = gardenZoneFix(doc.settings, place ?? null);
    if (!crop) return <div data-testid="garden-crop" className="min-w-0"><ToolEmpty icon="🌱" title={t('This crop isn\'t in this version of the app.')} testId="garden-crop-missing" /></div>;
    if (!fix) {
        return (
            <div data-testid="garden-crop" className="min-w-0">
                <ToolSection>
                    <ToolRow icon={crop.icon} title={t(crop.name)} wrap testId="garden-crop-name" />
                    <ToolField label={t('From sowing to first harvest')}><span data-testid="garden-crop-weeks">{weeksText(crop)}</span></ToolField>
                </ToolSection>
                {place !== undefined && (
                    <div className={BUTTONS}><ToolButton kind="primary" onClick={() => host.navigate('zone')} testId="garden-choose">{t('Choose your climate')}</ToolButton></div>
                )}
            </div>
        );
    }
    const page = cropPage(crop, fix.zone, fix.hemisphere);
    return (
        <div data-testid="garden-crop" className="min-w-0">
            <ToolSection>
                <ToolRow icon={crop.icon} title={t(crop.name)} wrap testId="garden-crop-name" />
                <ToolField label={t('Your climate')}><span data-testid="garden-crop-zone">{zoneLineText(fix.zone, fix.hemisphere)}</span></ToolField>
                {page.sow && <ToolField label={t('Sow')}><span data-testid="garden-crop-sow">{page.sow}</span></ToolField>}
                {page.harvest && <ToolField label={t('First harvest')}><span data-testid="garden-crop-harvest">{page.harvest}</span></ToolField>}
                <ToolField label={t('From sowing to first harvest')}><span data-testid="garden-crop-weeks">{page.weeks}</span></ToolField>
                {page.note && <ToolNote text={page.note} testId="garden-crop-note" />}
            </ToolSection>
            <Foot />
        </div>
    );
}

/** Change: the member's own choice of climate, which beats the place; or back to the place. */
export function Zone({ host }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const found = gardenZoneFix({}, place ?? null);
    const current = gardenZoneFix(doc.settings, place ?? null);
    /**
     * The hemisphere a zone is chosen in: the member's pick on this screen, else the choice's or the place's. Worked out
     * as the screen draws, so it is the place's in the same draw as "Your place gives …": a tap can't keep the default.
     */
    const [picked, setPicked] = useState<Hemisphere | null>(null);
    const hemisphere: Hemisphere = picked ?? current?.hemisphere ?? 'north';
    /**
     * Set once a choice is being kept: a second tap before the first lands would go back twice, out of the guide too
     * (the web's stack would empty). Cleared only when the write fails, so the member can tap again; the sentence then
     * says it wasn't kept (a browser whose store refused it, as the Tool shed's Save says it), and the screen stays.
     */
    const keeping = useRef(false);
    const [problem, setProblem] = useState<string | null>(null);
    const keep = async (climate: { zone: GardenZoneId; hemisphere: Hemisphere } | null) => {
        if (keeping.current) return;
        keeping.current = true;
        setProblem(null);
        try {
            await host.doc.set(withGardenClimate(host.doc.get(), climate));
        } catch {
            keeping.current = false;
            setProblem(t("Couldn't save it in this browser. Try again."));
            return;
        }
        host.back();
    };
    const choose = (zone: GardenZoneId) => keep({ zone, hemisphere });
    const usePlaceAgain = () => keep(null);
    const hemispheres = (['north', 'south'] as const).map((h) => ({ id: h, label: capitalFirst(t(HEMISPHERE_WORDS[h])) }));
    return (
        <div data-testid="garden-zone" className="min-w-0">
            <ToolSection title={t('Your climate')}>
                <ToolNote text={t('Pick the one closest to where you grow. Hills and coasts can differ from the map.')} />
                <div className="px-3 pb-2 min-w-0">
                    <ToolChips label={t('Hemisphere')} heading chips={hemispheres} picked={hemisphere} onPick={(id) => setPicked(id === 'south' ? 'south' : 'north')} testId="garden-hemisphere" />
                </div>
                {GARDEN_ZONES.map((z) => {
                    // Only the member's own choice is "(chosen)": a zone worked out from the place is the note below.
                    const on = current?.source === 'chosen' && current.zone === z.id && current.hemisphere === hemisphere;
                    return (
                        <ToolRow key={z.id} wrap icon={on ? '✅' : ZONE_ICONS[z.id]} title={on ? t('{zone} (chosen)', { zone: t(z.name) }) : t(z.name)} state={t(z.line)}
                            onClick={() => { void choose(z.id); }} testId={`garden-zone-${z.id}`} />
                    );
                })}
                <ToolLive testId="garden-zone-problem-live">{problem ? <ToolNote tone="danger" text={problem} testId="garden-zone-problem" /> : null}</ToolLive>
            </ToolSection>
            {found && (
                <ToolSection>
                    <ToolNote text={t('Your place gives: {line}', { line: zoneLineText(found.zone, found.hemisphere) })} testId="garden-zone-found" />
                    {doc.settings.zone && (
                        <div className={BUTTONS}>
                            <ToolButton onClick={() => { void usePlaceAgain(); }} testId="garden-zone-reset">{t('Use my place again')}</ToolButton>
                        </div>
                    )}
                </ToolSection>
            )}
            <ToolSection><ToolNote text={climateCreditLine()} testId="garden-credit" /></ToolSection>
        </div>
    );
}

export const SCREENS = { main: Main, crop: Crop, zone: Zone };
