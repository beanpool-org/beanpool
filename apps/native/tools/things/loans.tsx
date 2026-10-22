/**
 * Loans (the Tool shed's `loans`, round 2 §7 shelf 1): everything of the member's that is out or asked for, from the
 * document (lent outside BeanPool) and host.deals() (out on a loan through BeanPool, or asked to borrow), overdue first.
 * Each row opens its thing. What it couldn't check is said, never shown as nothing out.
 */
import React, { useMemo } from 'react';
import { openDealsByPost, t, thingCategory, thingStateLine, thingsLoans, type ThingLoan, type ThingsScreenProps } from '@beanpool/core';
import { ToolEmpty, ToolNote, ToolRow, ToolScreen, ToolSection } from '../ui';
import { useDeals } from './parts';

export function LoansScreen({ host }: ThingsScreenProps) {
    const doc = host.doc.get();
    const { deals, failed } = useDeals(host);
    const open = useMemo(() => openDealsByPost(deals), [deals]);
    const now = host.now();
    const loans = thingsLoans(doc, deals, now);
    const of = (state: ThingLoan['state']) => loans.filter((l) => l.state === state);
    const row = (l: ThingLoan) => (
        <ToolRow
            key={l.thing.id}
            image={l.thing.photo ? host.photos.uri(l.thing.photo) : null}
            icon={thingCategory(l.thing.category).emoji}
            title={l.thing.name}
            state={thingStateLine(l.thing, open, now)}
            onPress={() => host.navigate('thing', { key: l.thing.id })}
            testID={`loan-row-${l.thing.id}`}
        />
    );
    const lent = of('lent');
    const out = of('out');
    const asked = of('asked');
    return (
        <ToolScreen testID="things-loans-screen">
            {loans.length === 0 && deals !== null && !failed ? (
                <ToolEmpty icon="🤝" text={t('Nothing of yours is out or asked for right now.')} testID="loans-none" />
            ) : null}
            {lent.length > 0 ? <ToolSection title={t('Lent outside BeanPool')} testID="loans-outside">{lent.map(row)}</ToolSection> : null}
            {out.length > 0 ? <ToolSection title={t('Out on a loan through BeanPool')} testID="loans-beanpool">{out.map(row)}</ToolSection> : null}
            {asked.length > 0 ? <ToolSection title={t('Asked to borrow')} testID="loans-asked">{asked.map(row)}</ToolSection> : null}
            {failed || lent.length > 0 ? (
                <ToolSection>
                    {failed ? <ToolNote tone="warning" text={t("Loans through BeanPool couldn't be checked just now.")} testID="loans-unchecked" /> : null}
                    {lent.length > 0 ? <ToolNote text={t('When something lent outside BeanPool is due back, this phone reminds you. You can turn that off in Settings.')} /> : null}
                </ToolSection>
            ) : null}
        </ToolScreen>
    );
}
