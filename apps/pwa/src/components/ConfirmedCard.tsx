/**
 * Home's card about the rule of being confirmed, and Settings' row (scratch/fable-design/DESIGN-balance-rule-fable.md §1,
 * §2, §3). The card: "You're confirmed" the first time this account is seen confirmed, and again after a re-confirmation;
 * or, for a member already confirmed, when the rule reaches them or a line tightens. Which one, and when: @beanpool/core
 * ruleCardFor. Stays until OK, offers the one way out. The row: a confirmed member only, the rule under it. Both draw
 * nothing for anyone else, on an older node, or offline. The same as the phone's components/ConfirmedCard.tsx and
 * ConfirmedSettingsRow.tsx.
 */
import { useEffect, useState } from 'react';
import { KNOWN_RULE_WORDS, confirmedBody, ruleCardFor, ruleChangesTitle, ruleSeenNow, t, yourRuleLine, type RuleCard } from '@beanpool/core';
import { keepRuleSeen, memberRule, ruleSeenBy, type MemberRule } from '../lib/known-rule';
import { StepBackSheet } from './StepBackSheet';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

export function ConfirmedCard({ publicKey, onOpenGuide }: { publicKey: string; onOpenGuide: () => void }) {
    const [found, setFound] = useState<{ card: RuleCard; held: MemberRule } | null>(null);
    const [asking, setAsking] = useState(false);

    useEffect(() => {
        let live = true;
        void memberRule(publicKey).then((held) => {
            const card = held ? ruleCardFor(held.me, held.rule, ruleSeenBy(publicKey)) : null;
            if (live) setFound(card && held ? { card, held } : null);
        });
        return () => { live = false; };
    }, [publicKey]);

    if (!found) return null;
    const { card, held } = found;
    const putAway = () => {
        keepRuleSeen(publicKey, ruleSeenNow(held.me, held.rule));
        setFound(null);
    };

    return (
        <section data-testid={card.kind === 'confirmed' ? 'confirmed-card' : 'rule-changes-card'}
            className="mb-3 p-4 flex flex-col gap-2 rounded-2xl bg-bg-card border border-border-primary break-words">
            {card.kind === 'confirmed' ? (
                <>
                    <h2 className="m-0 text-base font-bold text-text-primary">{t(KNOWN_RULE_WORDS.confirmedTitle)}</h2>
                    <p className="m-0 text-sm leading-relaxed text-text-primary">{confirmedBody(held.rule)}</p>
                    <p className="m-0 text-sm leading-relaxed text-text-primary">{yourRuleLine(held.rule)}</p>
                    <button type="button" onClick={onOpenGuide}
                        className={`self-start min-h-[44px] p-0 border-0 bg-transparent text-left text-sm font-bold text-link cursor-pointer ${FOCUS}`}>
                        {t(KNOWN_RULE_WORDS.guideLine)}
                    </button>
                </>
            ) : (
                <>
                    <h2 className="m-0 text-base font-bold text-text-primary">{ruleChangesTitle(card.on)}</h2>
                    <p className="m-0 text-sm leading-relaxed text-text-primary">{yourRuleLine(held.rule)}</p>
                    {card.first && <p className="m-0 text-sm leading-relaxed text-text-primary">{t(KNOWN_RULE_WORDS.replacesEarlier)}</p>}
                    <p className="m-0 text-sm leading-relaxed text-text-primary">{t(KNOWN_RULE_WORDS.stayOut)}</p>
                </>
            )}
            <button type="button" onClick={putAway} data-testid="confirmed-card-ok"
                className={`w-full min-h-[48px] px-4 py-2 rounded-xl border-0 font-bold text-sm cursor-pointer bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on ${FOCUS}`}>
                {t(KNOWN_RULE_WORDS.ok)}
            </button>
            <button type="button" onClick={() => setAsking(true)} data-testid="confirmed-card-step-back"
                className={`w-full min-h-[48px] px-4 py-2 rounded-xl border-0 bg-transparent font-bold text-sm cursor-pointer text-text-secondary ${FOCUS}`}>
                {t(KNOWN_RULE_WORDS.stayUnconfirmed)}
            </button>
            {asking && <StepBackSheet onClose={() => setAsking(false)} onSteppedBack={() => { setAsking(false); setFound(null); }} />}
        </section>
    );
}

export function ConfirmedSettingsRow({ publicKey }: { publicKey: string }) {
    const [held, setHeld] = useState<MemberRule | null>(null);
    const [asking, setAsking] = useState(false);

    useEffect(() => {
        let live = true;
        void memberRule(publicKey).then((answer) => { if (live) setHeld(answer); });
        return () => { live = false; };
    }, [publicKey]);

    if (!held?.me.confirmed) return null;
    return (
        <section className="px-4 py-2 rounded-2xl bg-bg-card border border-border-primary break-words">
            <button type="button" onClick={() => setAsking(true)} data-testid="confirmed-settings-row"
                className={`w-full min-h-[48px] p-0 border-0 bg-transparent text-left text-sm font-bold text-link cursor-pointer ${FOCUS}`}>
                {t(KNOWN_RULE_WORDS.settingsRow)}
            </button>
            <p className="m-0 pb-2 text-sm leading-relaxed text-text-primary">{yourRuleLine(held.rule)}</p>
            {asking && <StepBackSheet onClose={() => setAsking(false)} onSteppedBack={() => { setAsking(false); setHeld(null); }} />}
        </section>
    );
}
