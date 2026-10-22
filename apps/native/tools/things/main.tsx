/**
 * Your things (the Tool shed's `main`, DESIGN-tool-library-fable.md §2.2): Add a thing, the filters All · In your shop ·
 * Out · On your shelf, and a row for each thing the member has, newest first, with its photo and its state; then Loans.
 * The frame above draws the count line (the manifest's row) and, while the shed is empty, the two doors.
 */
import React, { useMemo, useState } from 'react';
import {
    openDealsByPost, shedThings, t, thingCategory, thingInFilter, thingState, thingStateLine, thingsLoans, tn,
    type ThingFilter, type ThingsScreenProps,
} from '@beanpool/core';
import { ToolButton, ToolButtons, ToolChips, ToolEmpty, ToolNote, ToolRow, ToolScreen, ToolSection } from '../ui';
import { useDeals } from './parts';

export function Main({ host }: ThingsScreenProps) {
    const doc = host.doc.get();
    const [filter, setFilter] = useState<ThingFilter>('all');
    const { deals } = useDeals(host);
    const open = useMemo(() => openDealsByPost(deals), [deals]);
    const now = host.now();
    const things = shedThings(doc);
    const shown = things.filter((thing) => thingInFilter(thingState(thing, open), filter));
    const loans = thingsLoans(doc, deals, now).length;
    const filters: ReadonlyArray<{ value: ThingFilter; label: string }> = [
        { value: 'all', label: t('All') },
        { value: 'shop', label: t('In your shop') },
        { value: 'out', label: t('Out') },
        { value: 'shelf', label: t('On your shelf') },
    ];
    return (
        <ToolScreen testID="things-main">
            <ToolSection>
                <ToolButtons>
                    <ToolButton text={t('Add a thing')} primary onPress={() => host.navigate('edit')} testID="things-add" />
                </ToolButtons>
                {things.length === 0 ? (
                    <ToolEmpty icon="🧰" text={t("Nothing here yet. Add the first thing you'd lend: a drill, a ladder, a tent.")} testID="things-empty" />
                ) : (
                    <>
                        <ToolChips label={t('Show')} options={filters} value={filter} onPick={setFilter} testID="things-filter" />
                        {shown.length === 0 ? <ToolNote text={t('Nothing to show here.')} testID="things-none" /> : shown.map((thing) => (
                            <ToolRow
                                key={thing.id}
                                image={thing.photo ? host.photos.uri(thing.photo) : null}
                                icon={thingCategory(thing.category).emoji}
                                title={thing.name}
                                state={thingStateLine(thing, open, now)}
                                onPress={() => host.navigate('thing', { key: thing.id })}
                                testID={`thing-row-${thing.id}`}
                            />
                        ))}
                    </>
                )}
            </ToolSection>
            {things.length > 0 ? (
                <ToolSection>
                    <ToolRow
                        icon="🤝"
                        title={t('Loans')}
                        state={loans > 0 ? tn(loans, '{n} thing out or asked for', '{n} things out or asked for') : t('Nothing out right now')}
                        onPress={() => host.navigate('loans')}
                        testID="things-loans"
                    />
                </ToolSection>
            ) : null}
        </ToolScreen>
    );
}
