/**
 * A thing, as its owner sees it (the Tool shed's `thing`, DESIGN-tool-library-fable.md §2.2): its photo, name and state,
 * the buttons its state allows, and its details. The phone's twin is apps/native/tools/things/thing.tsx.
 *
 * - On the shelf: List in your shop (the composer opens with the thing's draft and photo; nothing is posted until the
 *   member taps Post there, and the composer says first if their community wants a profile photo), then link it to the
 *   Offer they posted; lend it to someone outside BeanPool; edit; delete.
 * - In the shop: Take out of your shop (its Offer paused and kept); taken out: Put back in your shop (the same Offer
 *   resumed). An Offer gone from the Market is said, with List it again.
 * - Lent outside BeanPool: It's back. A listed thing's Offer is paused while it is lent and resumed when it is back.
 * - Out on a loan through BeanPool, or asked for: the deal's words; it is answered and returned in the deal itself.
 *
 * Every change that asks the community's server waits for its answer: when there is none, nothing changes and the screen
 * says so. Never a false success.
 */
import { useEffect, useMemo, useState } from 'react';
import {
    BACK_AROUND_DAYS, THINGS_NAME_CHARS, backAroundChip, backAroundIn, findThing, forgetOffer, lendOutside, linkOffer, markBack,
    offersToLink, openDealsByPost, removeThing, setListed, t, takeOutOfShop, thingCategory, thingConditionName, thingListDraft,
    thingState, thingStateLine, tn,
    type ThingsDoc, type ThingsScreenProps, type ToolOwnOffer, type ToolPostStatus, type ToolPriceHint,
} from '@beanpool/core';
import { ToolButton, ToolChips, ToolEmpty, ToolField, ToolInput, ToolNote, ToolPhoto, ToolRow, ToolSection } from '../ui';
import { BUTTONS, keep, useDeals } from './parts';

/** Said when the community's server didn't answer: nothing changed. */
const unreached = () => t("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
const notKept = () => t("Couldn't save it in this browser. Try again.");

export function ThingScreen({ host, params }: ThingsScreenProps) {
    const doc = host.doc.get();
    const thing = findThing(doc, params.key);
    const { deals, failed } = useDeals(host);
    const open = useMemo(() => openDealsByPost(deals), [deals]);
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const [goneNote, setGoneNote] = useState(false);
    const [listedNote, setListedNote] = useState(false);
    const [lending, setLending] = useState<{ name: string; days: number | null } | null>(null);
    const [asking, setAsking] = useState(false);
    const [links, setLinks] = useState<ToolOwnOffer[] | null>(null);
    const [offerStatus, setOfferStatus] = useState<ToolPostStatus | null>(null);
    const [hint, setHint] = useState<ToolPriceHint | null>(null);
    const beans = host.node.features?.beans !== false;
    const postId = thing?.postId;

    // A linked Offer as the Market has it now: gone (ended, deleted) or paused from elsewhere is said.
    useEffect(() => {
        setOfferStatus(null);
        if (!postId) return;
        let gone = false;
        host.posts.status(postId).then((s) => { if (!gone) setOfferStatus(s); }).catch(() => {});
        return () => { gone = true; };
    }, [postId]);

    // The community's price guide, where Beans are on: a hint for a fee per day or week, never a price set.
    const name = thing?.name;
    const category = thing?.category;
    useEffect(() => {
        setHint(null);
        if (!name || !beans) return;
        let gone = false;
        host.pricingGuide(category ?? 'tools', name).then((h) => { if (!gone) setHint(h); }).catch(() => {});
        return () => { gone = true; };
    }, [name, category, beans]);

    if (!thing) {
        return (
            <div data-testid="thing-screen" className="min-w-0">
                <ToolEmpty icon="🧰" title={t('This thing is no longer in your Tool shed.')} testId="thing-missing" />
            </div>
        );
    }
    const id = thing.id;
    const state = thingState(thing, open);
    const cat = thingCategory(thing.category);
    const condition = thingConditionName(thing.condition);
    // A thing in the shop may be out on a loan through BeanPool: until its deals are known, nothing that would pause its
    // Offer or delete the thing is offered.
    const held = state === 'listed' && (deals === null || failed);

    /** One change: whatever it asks of the server first, then the document; any failure says so and changes nothing. */
    const act = async (change: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setRefused(null);
        try {
            await change();
        } catch {
            setRefused(unreached());
        } finally {
            setBusy(false);
        }
    };
    const write = async (next: ThingsDoc) => {
        if (!await keep(host, next)) setRefused(notKept());
    };

    const list = () => {
        setRefused(null);
        host.offerDoor(thingListDraft(thing));
        setListedNote(true);
    };
    const takeOut = () => act(async () => {
        await host.posts.pause(postId!);
        await write(takeOutOfShop(host.doc.get(), id, host.now()));
    });
    const putBack = () => act(async () => {
        const paused = thing.pausedPostId ?? postId!;
        const status = await host.posts.status(paused);
        if (status === 'gone') {
            await write(forgetOffer(host.doc.get(), id, host.now()));
            setGoneNote(true);
            return;
        }
        if (status === 'paused') await host.posts.resume(paused);
        setOfferStatus('active');
        await write(setListed(host.doc.get(), id, paused, host.now()));
    });
    /**
     * Its Offer out of the Market while the thing is away or deleted. The server pauses only a live Offer, so one already
     * paused or gone (here or elsewhere) is left as the Market has it.
     */
    const pauseOffer = async (offerId: string) => {
        const status = await host.posts.status(offerId);
        if (status !== 'paused' && status !== 'gone') await host.posts.pause(offerId);
    };
    const lend = () => act(async () => {
        if (!lending || !lending.name.trim()) return;
        if (postId) await pauseOffer(postId);
        const now = host.now();
        await write(lendOutside(host.doc.get(), id, lending.name, lending.days ? backAroundIn(now, lending.days) : null, now));
        setLending(null);
    });
    const backHome = () => act(async () => {
        const now = host.now();
        let next = markBack(host.doc.get(), id, now);
        if (postId) {
            // Its Offer back in the Market; if the server can't be reached, it is home and taken out of the shop, as it is.
            try {
                await host.posts.resume(postId);
            } catch {
                next = takeOutOfShop(next, id, now);
            }
        }
        await write(next);
    });
    const remove = () => act(async () => {
        if (postId) await pauseOffer(postId);
        const photo = thing.photo;
        if (!await keep(host, removeThing(host.doc.get(), id, host.now()))) {
            setRefused(notKept());
            return;
        }
        if (photo) await host.photos.remove(photo).catch(() => {});
        host.back();
    });
    const findLinks = () => act(async () => {
        setLinks(offersToLink(host.doc.get(), await host.posts.mine(), id));
    });
    const link = (offer: ToolOwnOffer) => act(async () => {
        await write(linkOffer(host.doc.get(), id, offer, host.now()));
        setLinks(null);
        setListedNote(false);
    });
    const forget = () => act(async () => { await write(forgetOffer(host.doc.get(), id, host.now())); });
    const relist = () => act(async () => {
        await write(forgetOffer(host.doc.get(), id, host.now()));
        list();
    });
    const resumeHere = () => act(async () => {
        await host.posts.resume(postId!);
        setOfferStatus('active');
    });

    const hintLine = !beans || !hint || state !== 'shelf' ? null
        : hint.priceType === 'daily' ? t("Your community's price guide says about {beans} Beans a day for something like this. Free is fine too.", { beans: hint.credits })
            : hint.priceType === 'weekly' ? t("Your community's price guide says about {beans} Beans a week for something like this. Free is fine too.", { beans: hint.credits })
                : null;
    const backChips = [
        { id: 'none', label: t('No date') },
        ...BACK_AROUND_DAYS.map((d) => ({ id: String(d), label: backAroundChip(d) })),
    ];
    const canLend = state === 'shelf' || state === 'taken-out' || (state === 'listed' && !held);

    return (
        <div data-testid="thing-screen" className="min-w-0">
            <ToolSection>
                {thing.photo ? <ToolPhoto uri={host.photos.uri(thing.photo)} label={t('Photo of {name}', { name: thing.name })} testId="thing-photo" /> : null}
                <ToolRow icon={cat.emoji} title={thing.name} wrap />
                <ToolNote text={thingStateLine(thing, open, host.now())} testId="thing-state" />
                {held && failed ? <ToolNote tone="warning" text={t("Loans through BeanPool couldn't be checked just now.")} testId="thing-unchecked" /> : null}
                {refused ? <ToolNote tone="danger" text={refused} testId="thing-refused" /> : null}
                {goneNote ? <ToolNote text={t('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.')} testId="thing-gone-note" /> : null}
                {state === 'out' ? <ToolNote text={t('It is out on a loan through BeanPool. The borrower confirms it is back in the deal.')} testId="thing-deal-note" /> : null}
                {state === 'asked' ? <ToolNote text={t('Answer them in My Deals, at the top of the Market.')} testId="thing-deal-note" /> : null}
                {lending ? (
                    <div className="min-w-0">
                        <ToolInput label={t('Who has it?')} value={lending.name} onChange={(v) => setLending({ ...lending, name: v })} max={THINGS_NAME_CHARS} testId="thing-lend-name" />
                        <div className="px-3 py-2 min-w-0">
                            <ToolChips label={t('Back around')} heading chips={backChips} picked={lending.days ? String(lending.days) : 'none'}
                                onPick={(v) => setLending({ ...lending, days: v === 'none' ? null : Number(v) })} testId="thing-lend-back" />
                        </div>
                        <div className={BUTTONS}>
                            <ToolButton kind="primary" onClick={() => { void lend(); }} disabled={busy || !lending.name.trim()} testId="thing-lend-save">{t('Save')}</ToolButton>
                            <ToolButton onClick={() => setLending(null)} testId="thing-lend-cancel">{t('Cancel')}</ToolButton>
                        </div>
                    </div>
                ) : asking ? (
                    <div className="min-w-0">
                        <ToolNote tone="warning" text={t('Delete {name} from your Tool shed? Its photo and notes go too.', { name: thing.name })} testId="thing-delete-ask" />
                        <div className={BUTTONS}>
                            <ToolButton kind="danger" onClick={() => { void remove(); }} disabled={busy} testId="thing-delete-yes">{t('Delete')}</ToolButton>
                            <ToolButton onClick={() => setAsking(false)} testId="thing-delete-no">{t('Keep it')}</ToolButton>
                        </div>
                    </div>
                ) : (
                    <div className={BUTTONS}>
                        {state === 'shelf' ? <ToolButton kind="primary" onClick={list} disabled={busy} testId="thing-list">{t('List in your shop')}</ToolButton> : null}
                        {state === 'taken-out' ? <ToolButton kind="primary" onClick={() => { void putBack(); }} disabled={busy} testId="thing-put-back">{t('Put back in your shop')}</ToolButton> : null}
                        {state === 'listed' && !held && offerStatus !== 'gone' && offerStatus !== 'paused'
                            ? <ToolButton onClick={() => { void takeOut(); }} disabled={busy} testId="thing-take-out">{t('Take out of your shop')}</ToolButton> : null}
                        {state === 'lent' ? <ToolButton kind="primary" onClick={() => { void backHome(); }} disabled={busy} testId="thing-back-home">{t("It's back")}</ToolButton> : null}
                        {canLend ? <ToolButton onClick={() => { setRefused(null); setLending({ name: '', days: null }); }} disabled={busy} testId="thing-lend">{t('Lent to someone outside BeanPool')}</ToolButton> : null}
                        <ToolButton onClick={() => host.navigate('edit', { key: id })} testId="thing-edit">{t('Edit')}</ToolButton>
                        {canLend ? <ToolButton onClick={() => { setRefused(null); setAsking(true); }} disabled={busy} testId="thing-delete">{t('Delete')}</ToolButton> : null}
                    </div>
                )}
                {listedNote && state === 'shelf' ? <ToolNote text={t('Once you have posted it, link it to its Offer below, so the Tool shed knows it is in your shop.')} testId="thing-listed-note" /> : null}
                {hintLine ? <ToolNote text={hintLine} testId="thing-hint" /> : null}
            </ToolSection>
            {state === 'listed' && offerStatus === 'gone' ? (
                <ToolSection testId="thing-offer-gone">
                    <ToolNote text={t('Its Offer has gone from the Market.')} />
                    <div className={BUTTONS}>
                        <ToolButton kind="primary" onClick={() => { void relist(); }} disabled={busy} testId="thing-relist">{t('List it again')}</ToolButton>
                        <ToolButton onClick={() => { void forget(); }} disabled={busy} testId="thing-forget">{t('Forget it')}</ToolButton>
                    </div>
                </ToolSection>
            ) : null}
            {state === 'listed' && offerStatus === 'paused' ? (
                <ToolSection testId="thing-offer-paused">
                    <ToolNote text={t('Its Offer is paused in the Market.')} />
                    <div className={BUTTONS}>
                        <ToolButton kind="primary" onClick={() => { void resumeHere(); }} disabled={busy} testId="thing-resume">{t('Put back in your shop')}</ToolButton>
                    </div>
                </ToolSection>
            ) : null}
            {state === 'shelf' ? (
                <ToolSection title={t('Already in the Market?')} testId="thing-links">
                    {links === null ? (
                        <>
                            <ToolNote text={t('If you posted it from here, link it to its Offer, so the Tool shed knows it is in your shop.')} />
                            <div className={BUTTONS}>
                                <ToolButton onClick={() => { void findLinks(); }} disabled={busy} testId="thing-link">{t('Link it to your Offer')}</ToolButton>
                            </div>
                        </>
                    ) : links.length === 0 ? (
                        <ToolNote text={t('None of your Offers is free to link. Post it first with List in your shop.')} testId="thing-link-none" />
                    ) : links.map((o) => (
                        <ToolRow key={o.id} icon="🏷️" title={o.title} state={o.status === 'paused' ? t('Paused in the Market') : t('In the Market')}
                            onClick={() => { void link(o); }} testId={`thing-link-${o.id}`} />
                    ))}
                </ToolSection>
            ) : null}
            <ToolSection title={t('Details')} testId="thing-details">
                <ToolField label={t('Category')}>{[cat.emoji, cat.name].join(' ')}</ToolField>
                {condition ? <ToolField label={t('Condition')}>{condition}</ToolField> : null}
                {thing.replacementValue ? (
                    <>
                        <ToolField label={t("If it's lost or broken")}>{thing.replacementValue}</ToolField>
                        <ToolNote text={t('Settled between you and the borrower. BeanPool never holds or collects it.')} />
                    </>
                ) : null}
                {thing.lendTerms ? <ToolField label={t('How you lend it')}>{thing.lendTerms}</ToolField> : null}
                {typeof thing.lendMaxDays === 'number' ? <ToolField label={t('Longest loan')}>{tn(thing.lendMaxDays, '{n} day', '{n} days')}</ToolField> : null}
                {thing.ownerNote ? (
                    <>
                        <ToolField label={t('Your own note')}>{thing.ownerNote}</ToolField>
                        <ToolNote text={host.nodeCopy.on
                            ? t("Only you see this. Like everything on your community's server, its operator could.")
                            : t('Only you see this. It stays in this browser.')} />
                    </>
                ) : null}
            </ToolSection>
        </div>
    );
}
