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
 * says so; a shop closed for now is said as that. Never a false success. A change that would take the shed past the store's bound is said before the server is
 * asked anything, as Edit does, and nothing changes.
 * What is written is made from the document as it is once the server has answered, so a sync that took the server's
 * newer copy meanwhile is never undone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    BACK_AROUND_DAYS, THINGS_NAME_CHARS, backAroundChip, backAroundIn, findThing, forgetOffer, lendOutside, linkOffer, markBack,
    isShopClosedRefusal, offersToLink, openDealsByPost, removeThing, setListed, shedFits, shedFullLine, shopClosedLine, t,
    takeOutOfShop, thingCategory,
    thingConditionName, thingListDraft, thingState, thingStateLine, tn,
    type ThingsDoc, type ThingsScreenProps, type ToolOwnOffer, type ToolPostStatus, type ToolPriceHint,
} from '@beanpool/core';
import { ToolButton, ToolChips, ToolEmpty, ToolField, ToolInput, ToolLive, ToolNote, ToolPhoto, ToolRow, ToolSection } from '../ui';
import { BUTTONS, keep, useDeals } from './parts';

/** Said when the community's server didn't answer: nothing changed. */
const unreached = () => t("Couldn't reach your community's server, so nothing changed. Try again when you're online.");
const notKept = () => t("Couldn't save it in this browser. Try again.");

/**
 * A change that asked the server first, as the server's answer leaves it: `make` it to the document as it is then;
 * `undo` puts the server back as it was, should the change no longer fit; `kept` is done once the change is kept (not
 * `then`: an async step's answer with a `then` would be awaited as a promise).
 */
interface AfterServer {
    make: (doc: ThingsDoc) => ThingsDoc;
    undo?: () => Promise<void>;
    kept?: () => void | Promise<void>;
}

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
    /**
     * How many times a change here has said how its Offer stands, once the server answered it: a read sent before that and
     * landing after is older, and never puts back how the Offer stood before Take out, Put back or It's back.
     */
    const statusAt = useRef(0);
    const showStatus = (s: ToolPostStatus) => { statusAt.current++; setOfferStatus(s); };
    const [hint, setHint] = useState<ToolPriceHint | null>(null);
    const beans = host.node.features?.beans !== false;
    const postId = thing?.postId;
    /** Its Offer, in the shop or taken out of it: what Lend and Delete pause. */
    const linked = postId ?? thing?.pausedPostId;
    /** Whether the member has left this screen: a Delete that lands after they have doesn't go back again. */
    const left = useRef(false);
    // Set again on each mount: StrictMode mounts twice.
    useEffect(() => {
        left.current = false;
        return () => { left.current = true; };
    }, []);

    // A linked Offer as the Market has it now: gone (ended, deleted) or paused from elsewhere is said, and so is a taken-out
    // one put back up without the Tool shed (its shop's reopen, the Market's own resume). Its answer is dropped when a change
    // here has said how the Offer stands since it was asked: a slow read never undoes a Take out or a Put back.
    useEffect(() => {
        setOfferStatus(null);
        if (!linked) return;
        let gone = false;
        const at = statusAt.current;
        host.posts.status(linked).then((s) => { if (!gone && statusAt.current === at) setOfferStatus(s); }).catch(() => {});
        return () => { gone = true; };
    }, [linked]);

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
    // A thing in the shop, or taken out of it (its Offer may be up again), may be out on a loan through BeanPool: until its
    // deals are known, nothing that would pause its Offer or delete the thing is offered.
    const held = (state === 'listed' || state === 'taken-out') && (deals === null || failed);

    /** One change: whatever it asks of the server first, then the document; any failure says so and changes nothing. */
    const act = async (change: () => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setRefused(null);
        try {
            await change();
        } catch (e) {
            // The server answered that the shop is closed for now (Put back): said, never "couldn't reach".
            setRefused(isShopClosedRefusal(e) ? shopClosedLine() : unreached());
        } finally {
            setBusy(false);
        }
    };
    /** Keep a changed document: true once kept; else the screen says why not (the shed is full, or it wasn't kept). */
    const write = async (next: ThingsDoc) => {
        const why = await keep(host, next);
        if (why) setRefused(why === 'too-big' ? shedFullLine() : notKept());
        return why === null;
    };
    /**
     * Whether a change that makes the document bigger fits the host's bound, checked before the server is asked anything
     * (as Edit checks): one that doesn't says the shed is full, and nothing changes, here or in the Market. One that makes
     * it no bigger always fits, so a shed already past the bound can be made smaller (core shedFits).
     */
    const fits = (next: ThingsDoc) => {
        if (shedFits(next, host.doc.maxBytes(), host.doc.get())) return true;
        setRefused(shedFullLine());
        return false;
    };
    /**
     * One change that asks the server first, then the document: Take out, Put back, Lend, It's back and Delete each go
     * through here. `first`, the change as the document stands before the server is asked, must fit (else the shed is
     * said to be full and nothing is asked). `ask` asks the server and says what to change. The change is made to the
     * document as it is once the server has answered, never to one read before: the open's sync may have taken the
     * server's newer copy meanwhile (a thing added on another device), and writing a document from before would undo it,
     * here and on the server at the next sync. Should the change no longer fit then, the server is put back as it was and
     * the shed is said to be full.
     */
    const serverFirst = async (ask: () => Promise<AfterServer>, first?: (doc: ThingsDoc) => ThingsDoc) => {
        if (first && !fits(first(host.doc.get()))) return;
        const { make, undo, kept } = await ask();
        const next = make(host.doc.get());
        if (!fits(next)) {
            await undo?.();
            return;
        }
        if (await write(next)) await kept?.();
    };
    /**
     * Its Offer out of the Market while the thing is away or deleted, as its owner's own pause. Asked of a live Offer and of
     * one already paused alike: a paused one may be its shop's ("closed for now"), which the shop's reopen would put back
     * up, and the owner's pause makes it theirs, so it stays down. One gone is left as the Market has it. What it returns
     * puts back a pause it made of a live Offer: the Offer resumed, or, when the server can't be reached then, the screen
     * says it is paused, with Put back. The screen holds the Offer as paused once it is, or gone (Take out keeps the same
     * Offer, so nothing reads it again, and the screen's first read, should it land later, is dropped): never "up in the
     * Market again" over a pause just made.
     */
    const pauseOffer = async (offerId: string): Promise<(() => Promise<void>) | undefined> => {
        const status = await host.posts.status(offerId);
        if (status === 'gone') {
            showStatus('gone');
            return undefined;
        }
        await host.posts.pause(offerId);
        showStatus('paused');
        if (status === 'paused') return undefined;
        return () => host.posts.resume(offerId).then(() => showStatus('active'), () => {});
    };

    const list = () => {
        setRefused(null);
        host.offerDoor(thingListDraft(thing));
        setListedNote(true);
    };
    const takeOut = () => act(async () => {
        const out = (d: ThingsDoc) => takeOutOfShop(d, id, host.now());
        await serverFirst(async () => ({ make: out, undo: await pauseOffer(postId!) }), out);
    });
    const putBack = () => act(async () => {
        const paused = thing.pausedPostId ?? postId!;
        await serverFirst(async () => {
            const status = await host.posts.status(paused);
            if (status === 'gone') return { make: (d: ThingsDoc) => forgetOffer(d, id, host.now()), kept: () => setGoneNote(true) };
            if (status === 'paused') await host.posts.resume(paused);
            showStatus('active');
            return { make: (d: ThingsDoc) => setListed(d, id, paused, host.now()) };
        });
    });
    const lend = () => act(async () => {
        if (!lending || !lending.name.trim()) return;
        const now = host.now();
        const lent = (d: ThingsDoc) => lendOutside(d, id, lending.name, lending.days ? backAroundIn(now, lending.days) : null, now);
        await serverFirst(async () => ({ make: lent, undo: linked ? await pauseOffer(linked) : undefined, kept: () => setLending(null) }), lent);
    });
    const backHome = () => act(async () => {
        const now = host.now();
        const home = (d: ThingsDoc) => markBack(d, id, now);
        await serverFirst(async () => {
            if (!postId) return { make: home };
            // Its Offer back in the Market, as the Market has it now (the server resumes only a paused one): paused, it is
            // resumed; put back meanwhile, it is left live; gone, it is forgotten and the thing is on the shelf. If the
            // server can't be reached, it is home and taken out of the shop, as it is.
            try {
                const status = await host.posts.status(postId);
                if (status === 'paused') await host.posts.resume(postId);
                showStatus(status === 'paused' ? 'active' : status);
                if (status === 'gone') return { make: (d: ThingsDoc) => forgetOffer(home(d), id, now), kept: () => setGoneNote(true) };
                return { make: home };
            } catch {
                return { make: (d: ThingsDoc) => takeOutOfShop(home(d), id, now) };
            }
        });
    });
    const remove = () => act(async () => {
        const photo = thing.photo;
        await serverFirst(async () => {
            if (linked) await pauseOffer(linked);
            return {
                make: (d: ThingsDoc) => removeThing(d, id, host.now()),
                kept: async () => {
                    if (photo) await host.photos.remove(photo).catch(() => {});
                    // The member went back while it was asked: back again would go a screen too far.
                    if (!left.current) host.back();
                },
            };
        });
    });
    const findLinks = () => act(async () => {
        setLinks(offersToLink(host.doc.get(), await host.posts.mine(), id));
    });
    // A link or a fresh listing that couldn't be kept leaves the screen as it was, with the sentence that says so.
    const link = (offer: ToolOwnOffer) => act(async () => {
        if (!(await write(linkOffer(host.doc.get(), id, offer, host.now())))) return;
        setLinks(null);
        setListedNote(false);
    });
    const forget = () => act(async () => { await write(forgetOffer(host.doc.get(), id, host.now())); });
    const relist = () => act(async () => {
        if (await write(forgetOffer(host.doc.get(), id, host.now()))) list();
    });
    const resumeHere = () => act(async () => {
        await host.posts.resume(postId!);
        showStatus('active');
    });

    const hintLine = !beans || !hint || state !== 'shelf' ? null
        : hint.priceType === 'daily' ? t("Your community's price guide says about {beans} Beans a day for something like this. Free is fine too.", { beans: hint.credits })
            : hint.priceType === 'weekly' ? t("Your community's price guide says about {beans} Beans a week for something like this. Free is fine too.", { beans: hint.credits })
                : null;
    const backChips = [
        { id: 'none', label: t('No date') },
        ...BACK_AROUND_DAYS.map((d) => ({ id: String(d), label: backAroundChip(d) })),
    ];
    const canLend = state === 'shelf' || ((state === 'listed' || state === 'taken-out') && !held);

    return (
        <div data-testid="thing-screen" className="min-w-0">
            <ToolSection>
                {thing.photo ? <ToolPhoto uri={host.photos.uri(thing.photo)} label={t('Photo of {name}', { name: thing.name })} testId="thing-photo" /> : null}
                <ToolRow icon={cat.emoji} title={thing.name} wrap />
                <ToolNote text={thingStateLine(thing, open, host.now())} testId="thing-state" />
                <ToolLive testId="thing-unchecked-live">
                    {held && failed ? <ToolNote tone="warning" text={t("Loans through BeanPool couldn't be checked just now.")} testId="thing-unchecked" /> : null}
                </ToolLive>
                <ToolLive testId="thing-refused-live">{refused ? <ToolNote tone="danger" text={refused} testId="thing-refused" /> : null}</ToolLive>
                {goneNote ? <ToolNote text={t('Its Offer has gone from the Market, so it is back on your shelf. List it again to make a new one.')} testId="thing-gone-note" /> : null}
                {state === 'taken-out' && offerStatus === 'active' ? <ToolNote text={t('Its Offer is up in the Market again.')} testId="thing-offer-live" /> : null}
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
