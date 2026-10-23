/**
 * The shopfront's parts on the web (slice S8 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md §3, §6): the
 * phone's components/shopfront/Shopfront.tsx (S5), drawn by pages/TreasuryDetailPage.tsx in the same order from the same
 * fields. Their words and reads are lib/shopfront.ts.
 *
 * At 320 px and 1.3× text every part is one column and wraps rather than clips; colours are the page's nature scale with
 * its dark pairs and the central bp-* tokens (@beanpool/core brand-colours); every word goes through t(). Pictures are the
 * node's own (the logo is the avatar, the tiles the listings' small copies), never a new copy, never enlarged past the
 * node's 800 px (memory: photos stay 800px). The banner is a quiet block in its kind's emoji: the shop row keeps no photo.
 */
import { useState, type ReactNode } from 'react';
import { formatCount, listPhotoUrl, t, upperCase, type ShopKind } from '@beanpool/core';
import { resolveAvatarUrl } from '../lib/avatar';
import { Sentence } from './Sentence';
import {
    SHOP_KIND_WORDS, categoryEmoji, categoryLabel, keeperBadgeLine, keeperRoleWord, listingPriceLine, listingStateLine,
    type ShopfrontKeeper, type ShopfrontListing, type ShopSection,
} from '../lib/shopfront';

/** How many rows a section shows before "Show all". */
const SECTION_ROWS = 5;

const card = 'bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 shadow-sm';
const heading = 'm-0 mb-2 text-base font-extrabold text-nature-900 dark:text-white';
const muted = 'text-sm text-nature-600 dark:text-nature-300';
const linkButton = 'min-h-[44px] px-1 -mx-1 bg-transparent border-none cursor-pointer text-sm font-bold text-bp-ink-brand hover:underline';

/** "More" / "Less" under a text that runs past its lines. */
function MoreLess({ open, onClick, testID }: { open: boolean; onClick: () => void; testID?: string }) {
    return (
        <button type="button" onClick={onClick} aria-expanded={open} className={linkButton} data-testid={testID}>
            {open ? t('Less', undefined, 'show less of a text') : t('More', undefined, 'show the rest of a text')}
        </button>
    );
}

/**
 * The top of the shopfront: the banner (a quiet block with its kind's emoji), the logo over its foot (the avatar the
 * account already has), the name, and the lines under it: its kind and since when, and any other.
 */
export function ShopfrontHeader({ name, logoUrl, kind, fallbackEmoji, lines }: {
    name: string;
    logoUrl: string | null | undefined;
    kind: ShopKind | null;
    /** The banner's and the logo's emoji when there is no kind or picture. */
    fallbackEmoji: string;
    /** The lines under the name, in order; an empty one is left out. */
    lines: Array<string | null | undefined>;
}) {
    const [failed, setFailed] = useState<string | null>(null);
    const logo = resolveAvatarUrl(logoUrl);
    const showLogo = !!logo && logo !== failed;
    return (
        <div data-testid="shopfront-header">
            <div
                data-testid="shopfront-banner"
                aria-hidden="true"
                className="h-32 rounded-2xl bg-bp-chip-ok-tint border border-nature-200 dark:border-nature-800 flex items-center justify-center text-5xl overflow-hidden"
            >
                {kind ? SHOP_KIND_WORDS[kind].emoji : fallbackEmoji}
            </div>
            <div data-testid="shopfront-logo" className="-mt-8 ml-3 w-[4.5rem] h-[4.5rem] rounded-full border-4 border-white dark:border-nature-950 bg-white dark:bg-nature-950 overflow-hidden relative">
                {showLogo ? (
                    <img src={logo!} alt={name} onError={() => setFailed(logo)} className="w-full h-full rounded-full object-cover" />
                ) : (
                    <div data-testid="enterprise-avatar-placeholder" aria-hidden="true" className="w-full h-full rounded-full bg-nature-100 dark:bg-nature-800 flex items-center justify-center text-3xl">
                        {fallbackEmoji}
                    </div>
                )}
            </div>
            {/* Wraps rather than truncating: at 320px with 1.3x text "Community Eggs" needs two lines. */}
            <h1 data-testid="shopfront-name" className="m-0 mt-2 text-2xl font-black text-nature-900 dark:text-white leading-tight break-words">{name}</h1>
            {lines.filter((l): l is string => !!l).map((l, i) => (
                <p key={i} data-testid={`shopfront-line-${i}`} className="m-0 mt-0.5 text-sm text-nature-600 dark:text-nature-300 break-words">{l}</p>
            ))}
        </div>
    );
}

/** What a screen reader says for a suspended keeper's row. */
function suspendedKeeperLabel(name: string, project: boolean, isLead: boolean): string {
    if (project) return isLead ? t('{name}, leader, suspended', { name }) : t('{name}, collaborator, suspended', { name });
    return isLead ? t('{name}, lead keeper, suspended', { name }) : t('{name}, keeper, suspended', { name });
}

/** A member's small picture: their photo, or their first letter. */
function KeeperAvatar({ k }: { k: ShopfrontKeeper }) {
    const url = resolveAvatarUrl(k.avatarUrl);
    if (url) return <img src={url} alt="" className="w-8 h-8 rounded-full object-cover shrink-0 bg-nature-100 dark:bg-nature-800" />;
    return (
        <span aria-hidden="true" className="w-8 h-8 rounded-full shrink-0 bg-nature-200 dark:bg-nature-700 text-nature-800 dark:text-nature-100 flex items-center justify-center text-sm font-bold">
            {upperCase(k.callsign.charAt(0) || '?')}
        </span>
    );
}

/**
 * Who keeps it, each a row: their picture, name and part, and under it their badges (tier, stars, trades) when the node
 * gave them; said once that the badges are recognition and gate nothing (memory: tiers are merit badges). A tap opens the
 * keeper's own profile, where something can open one.
 */
export function ShopfrontKeepers({ keepers, project, onOpen }: { keepers: ShopfrontKeeper[]; project: boolean; onOpen?: (publicKey: string) => void }) {
    if (keepers.length === 0) return null;
    const anyBadges = keepers.some((k) => keeperBadgeLine(k) !== null);
    return (
        <section data-testid="shopfront-keepers" aria-labelledby="shopfront-keepers-heading" className={card}>
            <h2 id="shopfront-keepers-heading" className={heading}>
                {project ? t('Run by', undefined, "a project's people") : t('Kept by', undefined, "an enterprise's keepers")}
            </h2>
            <div className="flex flex-col gap-1">
                {keepers.map((k) => {
                    const role = keeperRoleWord(project, k.isLead);
                    const badges = keeperBadgeLine(k);
                    const label = [k.suspended ? suspendedKeeperLabel(k.callsign, project, k.isLead) : t('{name}, {role}', { name: k.callsign, role }), badges].filter(Boolean).join('. ');
                    const body = (
                        <>
                            <KeeperAvatar k={k} />
                            <span className="flex-1 min-w-0">
                                <span className="block text-sm font-semibold text-nature-700 dark:text-nature-300 break-words">
                                    <Sentence text={t('{name} · {role}', { role }, "a keeper's name and their part")} parts={{ name: <span className="font-bold text-nature-900 dark:text-white">{k.callsign}</span> }} />
                                </span>
                                {k.suspended && <span className="block text-xs font-bold text-bp-ink-warning">{t('Suspended')}</span>}
                                {badges && <span data-testid={`shopfront-badges-${k.publicKey}`} className="block text-xs text-nature-600 dark:text-nature-300 mt-0.5 break-words">{badges}</span>}
                            </span>
                        </>
                    );
                    const rowClass = `w-full min-h-[48px] py-1.5 flex items-start gap-2.5 text-left rounded-xl ${k.suspended ? 'opacity-80' : ''}`;
                    return onOpen ? (
                        <button
                            key={k.publicKey}
                            type="button"
                            data-testid={`shopfront-keeper-${k.publicKey}`}
                            onClick={() => onOpen(k.publicKey)}
                            aria-label={label}
                            className={`${rowClass} px-2 -mx-2 bg-transparent border-none cursor-pointer hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors`}
                        >
                            {body}
                        </button>
                    ) : (
                        <div key={k.publicKey} data-testid={`shopfront-keeper-${k.publicKey}`} role="group" aria-label={label} className={rowClass}>{body}</div>
                    );
                })}
            </div>
            {anyBadges && <p data-testid="shopfront-badges-note" className={`m-0 mt-2 ${muted}`}>{t('Badges show what each person has done here. They gate nothing.')}</p>}
        </section>
    );
}

/** A heading and a text in the owner's words, four lines until "More" (About, what it is for); in a quiet box when `boxed`. */
export function ShopfrontText({ title, text, boxed, lines = 4, testID }: { title: string; text: string; boxed?: boolean; lines?: 3 | 4; testID: string }) {
    const [open, setOpen] = useState(false);
    const long = text.length > 180 || text.split('\n').length > lines;
    const clamp = open || !long ? '' : lines === 3 ? 'line-clamp-3' : 'line-clamp-4';
    const body = <p className={`m-0 text-base leading-relaxed text-nature-800 dark:text-nature-100 whitespace-pre-line break-words ${clamp}`}>{text}</p>;
    return (
        <section data-testid={testID} aria-labelledby={`${testID}-heading`} className={card}>
            <h2 id={`${testID}-heading`} className={heading}>{title}</h2>
            {boxed ? <div className="rounded-xl p-3 bg-nature-50 dark:bg-nature-800/60 border border-nature-200 dark:border-nature-700">{body}</div> : body}
            {long && <MoreLess open={open} onClick={() => setOpen(!open)} testID={`${testID}-more`} />}
        </section>
    );
}

/** A listing's picture: its own photo (the node's small copy), or its category's emoji on a quiet ground. */
function ListingPicture({ l, className, emojiClass }: { l: ShopfrontListing; className: string; emojiClass: string }) {
    const [failed, setFailed] = useState(false);
    const url = l.photo && !failed ? resolveAvatarUrl(listPhotoUrl(l.photo)) : null;
    return (
        <span className={`${className} bg-nature-100 dark:bg-nature-800 flex items-center justify-center overflow-hidden`} aria-hidden="true">
            {url ? <img src={url} alt="" onError={() => setFailed(true)} className="w-full h-full object-cover" /> : <span className={emojiClass}>{categoryEmoji(l.category)}</span>}
        </span>
    );
}

/** Featured: up to six tiles, two a row, each its photo, title and price; a tap opens the listing. */
export function ShopfrontFeatured({ listings, showsBeans, onOpen }: { listings: ShopfrontListing[]; showsBeans: boolean; onOpen?: (id: string) => void }) {
    if (listings.length === 0) return null;
    return (
        <section data-testid="shopfront-featured" aria-labelledby="shopfront-featured-heading">
            <h2 id="shopfront-featured-heading" className={heading}>{t('Featured', undefined, "a shop's chosen Offers")}</h2>
            <div className="grid grid-cols-2 gap-4">
                {listings.map((l) => {
                    const price = listingPriceLine(l, showsBeans);
                    return (
                        <button
                            key={l.id}
                            type="button"
                            data-testid={`shopfront-featured-${l.id}`}
                            onClick={onOpen ? () => onOpen(l.id) : undefined}
                            disabled={!onOpen}
                            aria-label={price ? t('{title}, {price}', { title: l.title, price }) : l.title}
                            className="min-w-0 p-0 text-left rounded-xl overflow-hidden bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 cursor-pointer hover:border-nature-400 dark:hover:border-nature-600 transition-colors"
                        >
                            <ListingPicture l={l} className="block w-full aspect-square" emojiClass="text-4xl" />
                            <span className="block p-2">
                                <span className="block text-sm font-bold leading-snug text-nature-900 dark:text-white line-clamp-2 break-words">{l.title}</span>
                                {price && <span className="block text-sm font-extrabold text-bp-ink-brand mt-0.5">{price}</span>}
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

/**
 * "What we do together": the categories of its keepers' live Offers and its own, as chips (round 3 §0 row 8), each once:
 * an older listing's id (tools_hardware) and today's (tools) are one category.
 */
export function ShopfrontTogether({ categories }: { categories: string[] }) {
    const seen = new Map<string, string>();
    for (const c of categories) {
        const label = categoryLabel(c);
        if (!seen.has(label)) seen.set(label, t('{emoji} {category}', { emoji: categoryEmoji(c), category: label }, 'a category, after its emoji'));
    }
    if (seen.size === 0) return null;
    return (
        <section data-testid="shopfront-together" aria-labelledby="shopfront-together-heading">
            <h2 id="shopfront-together-heading" className={heading}>{t('What we do together')}</h2>
            <ul className="m-0 p-0 list-none flex flex-wrap gap-2">
                {[...seen.values()].map((chip) => (
                    <li key={chip} className="px-3 py-1.5 rounded-full bg-bp-chip-accent-tint text-bp-chip-accent-ink border border-bp-chip-accent-border text-sm font-semibold break-words">{chip}</li>
                ))}
            </ul>
        </section>
    );
}

/** Its sections, each a heading and its rows (picture, title, price or state); past five, "Show all". */
export function ShopfrontSections({ sections, showsBeans, empty, onOpen }: { sections: ShopSection[]; showsBeans: boolean; empty: string; onOpen?: (id: string) => void }) {
    const [open, setOpen] = useState<Record<string, boolean>>({});
    return (
        <section data-testid="shopfront-sections" aria-label={t('What it offers')} className={card}>
            {sections.length === 0 && <p data-testid="shopfront-sections-empty" className={`m-0 ${muted}`}>{empty}</p>}
            {sections.map((section) => {
                const all = open[section.id] === true;
                const shown = all ? section.listings : section.listings.slice(0, SECTION_ROWS);
                const hidden = section.listings.length - shown.length;
                return (
                    <div key={section.id} data-testid={`shopfront-section-${section.id}`} className="mb-3 last:mb-0">
                        <h3 className="m-0 mb-1 text-sm font-extrabold text-nature-900 dark:text-white">{section.title}</h3>
                        <ul className="m-0 p-0 list-none divide-y divide-nature-100 dark:divide-nature-800">
                            {shown.map((l) => {
                                const lines = [listingPriceLine(l, showsBeans), listingStateLine(l)].filter((x): x is string => !!x);
                                return (
                                    <li key={l.id}>
                                        <button
                                            type="button"
                                            data-testid={`shopfront-row-${l.id}`}
                                            onClick={onOpen ? () => onOpen(l.id) : undefined}
                                            disabled={!onOpen}
                                            className="w-full min-h-[56px] py-1.5 flex items-center gap-2.5 text-left bg-transparent border-none cursor-pointer rounded-lg hover:bg-nature-50 dark:hover:bg-nature-800 transition-colors"
                                        >
                                            <ListingPicture l={l} className="w-12 h-12 shrink-0 rounded-lg" emojiClass="text-2xl" />
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-sm font-semibold text-nature-900 dark:text-white line-clamp-2 break-words">{l.title}</span>
                                                {lines.length > 0 && <span className={`block ${muted}`}>{lines.join(' · ')}</span>}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                        {hidden > 0 && (
                            <button type="button" className={linkButton} onClick={() => setOpen({ ...open, [section.id]: true })} data-testid={`shopfront-section-${section.id}-all`}>
                                {t('Show all {n}', { n: formatCount(section.listings.length) }, 'the rest of a shop section')}
                            </button>
                        )}
                    </div>
                );
            })}
        </section>
    );
}

/** The Message button: a DM to the lead keeper, named. */
export function ShopfrontMessage({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            data-testid="shopfront-message"
            onClick={onClick}
            className="w-full min-h-[48px] px-4 py-2.5 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-extrabold text-base shadow-sm transition-colors break-words"
        >
            {label}
        </button>
    );
}

/** The money in one line, and "Money and backing" opening today's figures, the keepers' backing and the ledger (round 3 §0 row 9). */
export function ShopfrontMoney({ line, initiallyOpen = false, children }: { line: string; initiallyOpen?: boolean; children: ReactNode }) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
        <section data-testid="shopfront-money" aria-label={t('Money and backing')} className="space-y-4">
            <div className={card}>
                <p data-testid="shopfront-money-line" className="m-0 text-lg font-extrabold text-nature-900 dark:text-white break-words">{line}</p>
                <button
                    type="button"
                    data-testid="shopfront-money-toggle"
                    aria-expanded={open}
                    aria-controls="shopfront-money-open"
                    onClick={() => setOpen(!open)}
                    className={linkButton}
                >
                    {open ? t('Hide money and backing') : t('Money and backing ›')}
                </button>
            </div>
            {open && <div id="shopfront-money-open" data-testid="shopfront-money-open" className="space-y-6">{children}</div>}
        </section>
    );
}

/** What a visitor is told where their page ends. */
export function ShopfrontVisitorNote({ text }: { text: string }) {
    return (
        <p data-testid="shopfront-visitor" className={`m-0 rounded-2xl p-4 bg-nature-50 dark:bg-nature-800/60 border border-nature-200 dark:border-nature-700 ${muted}`}>
            {text}
        </p>
    );
}
