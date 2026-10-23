/**
 * Your things (the Tool shed's `main`, DESIGN-tool-library-fable.md §2.2): Add a thing, the filters All · In your shop ·
 * Out · On your shelf, and a row for each thing the member has, newest first, with its photo and its state; then Loans.
 * Under Add, the room left in things, never bytes ("Room for about 240 more things", or the shed full), against the
 * host's bound. The page above draws the count line (the manifest's row) and, while the shed is empty, the two doors.
 */
import { useMemo, useState } from 'react';
import {
    openDealsByPost, shedFullLine, shedRoom, shedRoomLine, shedThings, t, thingCategory, thingInFilter, thingRowLine, thingState, thingsLoans,
    type ThingFilter, type ThingsScreenProps,
} from '@beanpool/core';
import { ToolButton, ToolChips, ToolLive, ToolNote, ToolRow, ToolSection } from '../ui';
import { BUTTONS, useDeals } from './parts';

export function Main({ host }: ThingsScreenProps) {
    const doc = host.doc.get();
    const [filter, setFilter] = useState<ThingFilter>('all');
    const { deals, failed } = useDeals(host);
    const open = useMemo(() => openDealsByPost(deals), [deals]);
    const now = host.now();
    const things = shedThings(doc);
    const shown = things.filter((thing) => thingInFilter(thingState(thing, open), filter));
    const loans = thingsLoans(doc, deals, now).length;
    const room = shedRoom(doc, host.doc.maxBytes());
    // No count until the deals are known: before they arrive, or when they couldn't be read, it could leave out a loan.
    const loansLine = deals === null || failed ? null
        : loans > 0 ? t('Out or asked for: {count}', { count: loans }) : t('Nothing out right now');
    const filters = [
        { id: 'all', label: t('All') },
        { id: 'shop', label: t('In your shop') },
        { id: 'out', label: t('Out') },
        { id: 'shelf', label: t('On your shelf') },
    ];
    return (
        <div data-testid="things-main" className="min-w-0">
            <ToolSection>
                <div className={BUTTONS}>
                    <ToolButton kind="primary" onClick={() => host.navigate('edit')} testId="things-add">{t('Add a thing')}</ToolButton>
                </div>
                {/* A standing line, not news: no tone, so no live region (a refusal is said where it happens). */}
                <ToolNote text={room > 0 ? shedRoomLine(room) : shedFullLine()} testId="things-room" />
                {things.length === 0 ? (
                    <ToolNote text={t("Nothing here yet. Add the first thing you'd lend: a drill, a ladder, a tent.")} testId="things-empty" />
                ) : (
                    <>
                        <div className="p-3 min-w-0">
                            <ToolChips label={t('Show')} chips={filters} picked={filter} onPick={(id) => setFilter(id as ThingFilter)} testId="things-filter" />
                        </div>
                        {shown.length === 0 ? <ToolNote text={t('Nothing to show here.')} testId="things-none" /> : shown.map((thing) => (
                            <ToolRow
                                key={thing.id}
                                image={thing.photo ? host.photos.uri(thing.photo) : null}
                                icon={thingCategory(thing.category).emoji}
                                title={thing.name}
                                state={thingRowLine(thing, open, now)}
                                onClick={() => host.navigate('thing', { key: thing.id })}
                                testId={`thing-row-${thing.id}`}
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
                        state={loansLine}
                        onClick={() => host.navigate('loans')}
                        testId="things-loans"
                    />
                    <ToolLive testId="things-loans-unchecked-live">
                        {failed ? <ToolNote tone="warning" text={t("Loans through BeanPool couldn't be checked just now.")} testId="things-loans-unchecked" /> : null}
                    </ToolLive>
                </ToolSection>
            ) : null}
        </div>
    );
}
