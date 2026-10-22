/**
 * A thing, as its owner sees it (the Tool shed's `thing`, DESIGN-tool-library-fable.md §2.2): its photo, name and state,
 * the buttons its state allows, and its details.
 *
 * - On the shelf: List in your shop (the host's List sheet with the thing's draft; nothing is posted until the member taps
 *   Post in the composer), then link it to the Offer they posted; lend it to someone outside BeanPool; edit; delete.
 * - In the shop: Take out of your shop (its Offer paused and kept); taken out: Put back in your shop (the same Offer
 *   resumed). An Offer gone from the Market is said, with List it again.
 * - Lent outside BeanPool: It's back. A listed thing's Offer is paused while it is lent and resumed when it is back.
 * - Out on a loan through BeanPool, or asked for: the deal's words; it is answered and returned in the deal itself.
 *
 * Every change that asks the community's server (pause, resume) waits for its answer: when there is none, nothing
 * changes and the screen says so. Never a false success.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
    BACK_AROUND_DAYS, THINGS_NAME_CHARS, backAroundChip, backAroundIn, findThing, forgetOffer, lendOutside, linkOffer, markBack,
    offersToLink, openDealsByPost, removeThing, setListed, t, takeOutOfShop, thingCategory, thingConditionName, thingListDraft,
    thingState, thingStateLine, tn,
    type ThingsScreenProps, type ToolOwnOffer, type ToolPostStatus, type ToolPriceHint,
} from '@beanpool/core';
import {
    ToolButton, ToolButtons, ToolChips, ToolEmpty, ToolField, ToolInput, ToolNote, ToolPhoto, ToolRow, ToolScreen, ToolSection,
} from '../ui';
import { keep, useDeals } from './parts';

/** Said when the community's server didn't answer: nothing changed. */
const unreached = () => t("Couldn't reach your community's server, so nothing changed. Try again when you're online.");

export function ThingScreen({ host, params }: ThingsScreenProps) {
    const doc = host.doc.get();
    const thing = findThing(doc, params.key);
    const { deals } = useDeals(host);
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
            <ToolScreen testID="thing-screen">
                <ToolEmpty icon="🧰" text={t('This thing is no longer in your Tool shed.')} testID="thing-missing" />
            </ToolScreen>
        );
    }
    const id = thing.id;
    const state = thingState(thing, open);
    const cat = thingCategory(thing.category);
    const condition = thingConditionName(thing.condition);

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
    const write = async (next: Parameters<typeof keep>[1]) => {
        if (!await keep(host, next)) setRefused(t("Couldn't save it on this phone. Try again."));
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
    const lend = () => act(async () => {
        if (!lending || !lending.name.trim()) return;
        if (postId) await host.posts.pause(postId);
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
        if (postId) await host.posts.pause(postId);
        const photo = thing.photo;
        if (!await keep(host, removeThing(host.doc.get(), id, host.now()))) {
            setRefused(t("Couldn't save it on this phone. Try again."));
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
        { value: 'none', label: t('No date') },
        ...BACK_AROUND_DAYS.map((d) => ({ value: String(d), label: backAroundChip(d) })),
    ];
    const lendButton = <ToolButton text={t('Lent to someone outside BeanPool')} onPress={() => { setRefused(null); setLending({ name: '', days: null }); }} disabled={busy} testID="thing-lend" />;
    const editButton = <ToolButton text={t('Edit')} onPress={() => host.navigate('edit', { key: id })} testID="thing-edit" />;
    const deleteButton = <ToolButton text={t('Delete')} onPress={() => { setRefused(null); setAsking(true); }} disabled={busy} testID="thing-delete" />;

    return (
        <ToolScreen testID="thing-screen">
            <ToolSection>
                {thing.photo ? <ToolPhoto uri={host.photos.uri(thing.photo)} label={t('Photo of {name}', { name: thing.name })} testID="thing-photo" /> : null}
                <ToolRow icon={cat.emoji} title={thing.name} wrap />
                <ToolNote text={thingStateLine(thing, open, host.now())} testID="thing-state" />
                {refused ? <ToolNote tone="danger" text={refused} testID="thing-refused" /> : null}
                {goneNote ? <ToolNote text={t('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.')} testID="thing-gone-note" /> : null}
                {state === 'out' ? <ToolNote text={t('It is out on a loan through BeanPool. The borrower confirms it is back in the deal.')} testID="thing-deal-note" /> : null}
                {state === 'asked' ? <ToolNote text={t('Answer them in My Deals, at the top of the Market.')} testID="thing-deal-note" /> : null}
                {lending ? (
                    <>
                        <ToolInput label={t('Who has it?')} value={lending.name} onChange={(v) => setLending({ ...lending, name: v })} max={THINGS_NAME_CHARS} testID="thing-lend-name" />
                        <ToolChips label={t('Back around')} heading options={backChips} value={lending.days ? String(lending.days) : 'none'}
                            onPick={(v) => setLending({ ...lending, days: v === 'none' ? null : Number(v) })} testID="thing-lend-back" />
                        <ToolButtons>
                            <ToolButton text={t('Save')} primary onPress={() => { void lend(); }} disabled={busy || !lending.name.trim()} testID="thing-lend-save" />
                            <ToolButton text={t('Cancel')} onPress={() => setLending(null)} testID="thing-lend-cancel" />
                        </ToolButtons>
                    </>
                ) : asking ? (
                    <>
                        <ToolNote tone="warning" text={t('Delete {name} from your Tool shed? Its photo and notes go too.', { name: thing.name })} testID="thing-delete-ask" />
                        <ToolButtons>
                            <ToolButton text={t('Delete')} danger onPress={() => { void remove(); }} disabled={busy} testID="thing-delete-yes" />
                            <ToolButton text={t('Keep it')} onPress={() => setAsking(false)} testID="thing-delete-no" />
                        </ToolButtons>
                    </>
                ) : (
                    <ToolButtons>
                        {state === 'shelf' ? <ToolButton text={t('List in your shop')} primary onPress={list} disabled={busy} testID="thing-list" /> : null}
                        {state === 'taken-out' ? <ToolButton text={t('Put back in your shop')} primary onPress={() => { void putBack(); }} disabled={busy} testID="thing-put-back" /> : null}
                        {state === 'listed' && offerStatus !== 'gone' && offerStatus !== 'paused'
                            ? <ToolButton text={t('Take out of your shop')} onPress={() => { void takeOut(); }} disabled={busy} testID="thing-take-out" /> : null}
                        {state === 'lent' ? <ToolButton text={t("It's back")} primary onPress={() => { void backHome(); }} disabled={busy} testID="thing-back-home" /> : null}
                        {state === 'shelf' || state === 'taken-out' || state === 'listed' ? lendButton : null}
                        {editButton}
                        {state === 'shelf' || state === 'taken-out' || state === 'listed' ? deleteButton : null}
                    </ToolButtons>
                )}
                {listedNote && state === 'shelf' ? <ToolNote text={t('Once you have posted it, link it to its Offer below, so the Tool shed knows it is in your shop.')} testID="thing-listed-note" /> : null}
                {hintLine ? <ToolNote text={hintLine} testID="thing-hint" /> : null}
            </ToolSection>
            {state === 'listed' && offerStatus === 'gone' ? (
                <ToolSection testID="thing-offer-gone">
                    <ToolNote text={t('Its Offer has gone from the Market.')} />
                    <ToolButtons>
                        <ToolButton text={t('List it again')} primary onPress={() => { void relist(); }} disabled={busy} testID="thing-relist" />
                        <ToolButton text={t('Forget it')} onPress={() => { void forget(); }} disabled={busy} testID="thing-forget" />
                    </ToolButtons>
                </ToolSection>
            ) : null}
            {state === 'listed' && offerStatus === 'paused' ? (
                <ToolSection testID="thing-offer-paused">
                    <ToolNote text={t('Its Offer is paused in the Market.')} />
                    <ToolButtons>
                        <ToolButton text={t('Put back in your shop')} primary onPress={() => { void resumeHere(); }} disabled={busy} testID="thing-resume" />
                    </ToolButtons>
                </ToolSection>
            ) : null}
            {state === 'shelf' ? (
                <ToolSection title={t('Already in the Market?')} testID="thing-links">
                    {links === null ? (
                        <>
                            <ToolNote text={t('If you posted it from here, link it to its Offer, so the Tool shed knows it is in your shop.')} />
                            <ToolButtons>
                                <ToolButton text={t('Link it to your Offer')} onPress={() => { void findLinks(); }} disabled={busy} testID="thing-link" />
                            </ToolButtons>
                        </>
                    ) : links.length === 0 ? (
                        <ToolNote text={t('None of your Offers is free to link. Post it first with List in your shop.')} testID="thing-link-none" />
                    ) : links.map((o) => (
                        <ToolRow key={o.id} icon="🏷️" title={o.title} state={o.status === 'paused' ? t('Paused in the Market') : t('In the Market')}
                            onPress={() => { void link(o); }} testID={`thing-link-${o.id}`} />
                    ))}
                </ToolSection>
            ) : null}
            <ToolSection title={t('Details')} testID="thing-details">
                <ToolField label={t('Category')} value={`${cat.emoji} ${cat.name}`} />
                {condition ? <ToolField label={t('Condition')} value={condition} /> : null}
                {thing.replacementValue ? (
                    <>
                        <ToolField label={t("If it's lost or broken")} value={thing.replacementValue} />
                        <ToolNote text={t('Settled between you and the borrower. BeanPool never holds or collects it.')} />
                    </>
                ) : null}
                {thing.lendTerms ? <ToolField label={t('How you lend it')} value={thing.lendTerms} /> : null}
                {typeof thing.lendMaxDays === 'number' ? <ToolField label={t('Longest loan')} value={tn(thing.lendMaxDays, '{n} day', '{n} days')} /> : null}
                {thing.ownerNote ? (
                    <>
                        <ToolField label={t('Your own note')} value={thing.ownerNote} />
                        <ToolNote text={host.nodeCopy.on
                            ? t("Only you see this. Like everything on your community's server, its operator could.")
                            : t('Only you see this. It stays on this phone.')} />
                    </>
                ) : null}
            </ToolSection>
        </ToolScreen>
    );
}
