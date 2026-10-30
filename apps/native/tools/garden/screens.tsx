/**
 * Your garden's phone screens (grow-food slice G0: the planting guide; DESIGN-grow-food-fable.md §3). `main` is the
 * guide: the zone line in plain words with Change, then Sow now, Soon and every crop grown here. `crop` is one crop's
 * page, `zone` is Change. The frame around each (the header, the "…" menu, and the two doors while nothing is chosen)
 * is the host route's. Optional help for new growers: nothing here gates anything, and nothing leaves the phone. The
 * rules are core's (tools/garden/guide.ts), shared with the web's screens.
 */
import React, { useEffect, useState } from 'react';
import {
    GARDEN_ZONES, HEMISPHERE_WORDS, ZONE_ICONS, capitalFirst, climateCreditLine, cropById, cropPage, gardenZoneFix, guideGeneralLine,
    guideView, harvestLine, soonLine, t, withGardenClimate, zoneLineText, zoneSourceText,
    type GardenScreenProps, type Hemisphere, type ToolPlace,
} from '@beanpool/core';
import { ToolButton, ToolButtons, ToolEmpty, ToolField, ToolChips, ToolNote, ToolRow, ToolScreen, ToolSection } from '../ui';

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
            <ToolNote text={guideGeneralLine()} testID="garden-general" />
            <ToolNote text={climateCreditLine()} testID="garden-credit" />
        </ToolSection>
    );
}

/** The guide. */
export function Main({ host }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const fix = gardenZoneFix(doc.settings, place ?? null);
    if (!fix && place === undefined) return <ToolScreen testID="garden-main"><ToolNote text={t('Finding your climate…')} testID="garden-finding" /></ToolScreen>;
    if (!fix) {
        return (
            <ToolScreen testID="garden-main">
                <ToolEmpty icon="🌍" text={t('Choose your climate to see what to sow when.')} testID="garden-no-zone"
                    action={<ToolButton text={t('Choose your climate')} primary onPress={() => host.navigate('zone')} testID="garden-choose" />} />
                <Foot />
            </ToolScreen>
        );
    }
    const month = new Date(host.now()).getMonth();
    const view = guideView(fix.zone, fix.hemisphere, month);
    const line = zoneLineText(fix.zone, fix.hemisphere);
    const open = (id: string) => host.navigate('crop', { crop: id });
    return (
        <ToolScreen testID="garden-main">
            <ToolSection>
                <ToolRow icon={ZONE_ICONS[fix.zone]} title={line} wrap state={zoneSourceText(fix.source)} testID="garden-zone-line" />
                <ToolButtons>
                    <ToolButton text={t('Change')} a11y={t('Change your climate')} onPress={() => host.navigate('zone')} testID="garden-change" />
                </ToolButtons>
            </ToolSection>
            <ToolSection title={t('Sow now')} testID="garden-now">
                {view.now.length === 0 ? <ToolNote text={t('Nothing to sow outdoors this month.')} testID="garden-now-none" /> : view.now.map((c) => (
                    <ToolRow key={c.id} icon={c.icon} title={t(c.name)} state={harvestLine(c)} onPress={() => open(c.id)} testID={`garden-now-${c.id}`} />
                ))}
            </ToolSection>
            {view.soon.length > 0 ? (
                <ToolSection title={t('Soon')} testID="garden-soon">
                    {view.soon.map(({ crop: c, from }) => (
                        <ToolRow key={c.id} icon={c.icon} title={t(c.name)} state={soonLine(from)} onPress={() => open(c.id)} testID={`garden-soon-${c.id}`} />
                    ))}
                </ToolSection>
            ) : null}
            <ToolSection title={t('All crops')} testID="garden-all">
                {view.all.map((c) => (
                    <ToolRow key={c.id} icon={c.icon} title={t(c.name)} state={cropPage(c, fix.zone, fix.hemisphere).sow} onPress={() => open(c.id)} testID={`garden-all-${c.id}`} />
                ))}
            </ToolSection>
            <Foot />
        </ToolScreen>
    );
}

/** One crop's page. */
export function Crop({ host, params }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const crop = cropById(params.crop ?? '');
    const fix = gardenZoneFix(doc.settings, place ?? null);
    if (!crop) return <ToolScreen testID="garden-crop"><ToolEmpty icon="🌱" text={t('This crop isn\'t in this version of the app.')} testID="garden-crop-missing" /></ToolScreen>;
    if (!fix) {
        return (
            <ToolScreen testID="garden-crop">
                <ToolSection><ToolRow icon={crop.icon} title={t(crop.name)} wrap state={harvestLine(crop)} testID="garden-crop-name" /></ToolSection>
                {place !== undefined ? <ToolButtons><ToolButton text={t('Choose your climate')} primary onPress={() => host.navigate('zone')} testID="garden-choose" /></ToolButtons> : null}
            </ToolScreen>
        );
    }
    const page = cropPage(crop, fix.zone, fix.hemisphere);
    return (
        <ToolScreen testID="garden-crop">
            <ToolSection>
                <ToolRow icon={crop.icon} title={t(crop.name)} wrap state={zoneLineText(fix.zone, fix.hemisphere)} testID="garden-crop-name" />
                {page.sow ? <ToolField label={t('Sow')} value={page.sow} testID="garden-crop-sow" /> : null}
                {page.harvest ? <ToolField label={t('First harvest')} value={page.harvest} testID="garden-crop-harvest" /> : null}
                <ToolField label={t('From sowing')} value={page.weeks} testID="garden-crop-weeks" />
                {page.note ? <ToolNote text={page.note} testID="garden-crop-note" /> : null}
            </ToolSection>
            <Foot />
        </ToolScreen>
    );
}

/** Change: the member's own choice of climate, which beats the place; or back to the place. */
export function Zone({ host }: GardenScreenProps) {
    const doc = host.doc.get();
    const place = usePlace(host);
    const found = gardenZoneFix({}, place ?? null);
    const current = gardenZoneFix(doc.settings, place ?? null);
    const [hemisphere, setHemisphere] = useState<Hemisphere>(current?.hemisphere ?? 'north');
    useEffect(() => { if (current && !doc.settings.hemisphere) setHemisphere(current.hemisphere); }, [current?.hemisphere]);
    const choose = async (zone: (typeof GARDEN_ZONES)[number]['id']) => {
        await host.doc.set(withGardenClimate(host.doc.get(), { zone, hemisphere }));
        host.back();
    };
    const usePlaceAgain = async () => {
        await host.doc.set(withGardenClimate(host.doc.get(), null));
        host.back();
    };
    const hemispheres = (['north', 'south'] as const).map((h) => ({ value: h, label: capitalFirst(t(HEMISPHERE_WORDS[h])) }));
    return (
        <ToolScreen testID="garden-zone">
            <ToolSection title={t('Your climate')}>
                <ToolNote text={t('Pick the one closest to where you grow. Hills and coasts can differ from the map.')} />
                <ToolChips label={t('Hemisphere')} heading options={hemispheres} value={hemisphere} onPick={setHemisphere} testID="garden-hemisphere" />
                {GARDEN_ZONES.map((z) => {
                    const on = current?.zone === z.id && current.hemisphere === hemisphere;
                    return (
                        <ToolRow key={z.id} icon={on ? '✅' : ZONE_ICONS[z.id]} title={on ? t('{zone}, chosen', { zone: t(z.name) }) : t(z.name)} state={t(z.line)}
                            onPress={() => { void choose(z.id); }} testID={`garden-zone-${z.id}`} />
                    );
                })}
            </ToolSection>
            {found ? (
                <ToolSection>
                    <ToolNote text={t('Your place gives: {line}', { line: zoneLineText(found.zone, found.hemisphere) })} testID="garden-zone-found" />
                    {doc.settings.zone ? (
                        <ToolButtons>
                            <ToolButton text={t('Use my place again')} onPress={() => { void usePlaceAgain(); }} testID="garden-zone-reset" />
                        </ToolButtons>
                    ) : null}
                </ToolSection>
            ) : null}
            <ToolSection><ToolNote text={climateCreditLine()} testID="garden-credit" /></ToolSection>
        </ToolScreen>
    );
}

export const SCREENS = { main: Main, crop: Crop, zone: Zone };
