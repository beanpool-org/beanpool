import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { searchGuide, splitBold, type OperatorGuideBlock, type OperatorGuidePage } from '@beanpool/core';
import { OPERATOR_MANUAL, SCREEN_HELP, helpPageFor, manualPage, type HelpScreen } from '../../lib/manual';

/**
 * The operator manual inside Settings: a full-screen reader opened from the sidebar's Manual button, from the
 * sign-in card, or from the "?" beside each screen's title (which opens that screen's page).
 */

interface ManualApi {
    /** Open the manual at a page, or at its contents when no slug is given. */
    openManual: (slug?: string) => void;
}

const ManualContext = createContext<ManualApi | null>(null);

export function useManual(): ManualApi | null {
    return useContext(ManualContext);
}

export function ManualProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<{ open: boolean; slug: string | null }>({ open: false, slug: null });
    const openRef = useRef(false);
    openRef.current = state.open;
    // The open manual is a history entry, so a phone's Back button closes it instead of leaving Settings.
    const openManual = useCallback((slug?: string) => {
        // Unless the entry is already the manual's: the phone menu hands its own entry over when it opens the manual.
        if (!openRef.current && typeof window !== 'undefined' && !(window.history.state as { bpManual?: boolean } | null)?.bpManual) {
            window.history.pushState({ ...(window.history.state ?? {}), bpManual: true }, '');
        }
        setState({ open: true, slug: slug && manualPage(slug) ? slug : null });
    }, []);
    const closeManual = useCallback(() => {
        setState({ open: false, slug: null });
        // Drop its history entry too, or the next Back would land on the closed manual and seem to do nothing.
        if (typeof window !== 'undefined' && (window.history.state as { bpManual?: boolean } | null)?.bpManual) {
            window.history.back();
        }
    }, []);
    useEffect(() => {
        const onPop = (e: PopStateEvent) => {
            if (!(e.state as { bpManual?: boolean } | null)?.bpManual) setState({ open: false, slug: null });
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);
    const api = useMemo(() => ({ openManual }), [openManual]);
    return (
        <ManualContext.Provider value={api}>
            {children}
            {state.open && (
                <ManualPanel
                    slug={state.slug}
                    onNavigate={(slug) => setState({ open: true, slug })}
                    onClose={closeManual}
                />
            )}
        </ManualContext.Provider>
    );
}

/** The "?" beside a screen's title. Renders nothing outside a ManualProvider. */
export function HelpLink({ screen, className = '' }: { screen: HelpScreen; className?: string }) {
    const manual = useManual();
    const page = helpPageFor(screen);
    if (!manual || !page) return null;
    return (
        <button
            type="button"
            onClick={() => manual.openManual(SCREEN_HELP[screen])}
            aria-label={`Help: ${page.title}`}
            title={`Manual: ${page.title}`}
            className={`inline-flex items-center justify-center min-w-[48px] min-h-[48px] -my-2 rounded-full group shrink-0 ${className}`}
        >
            <span className="w-7 h-7 rounded-full border border-nature-600 bg-nature-900 text-nature-200 text-sm font-black flex items-center justify-center group-hover:border-terra-400 group-hover:text-terra-300 transition-colors">
                ?
            </span>
        </button>
    );
}

function Rich({ text }: { text: string }) {
    return (
        <>
            {splitBold(text).map((part, i) =>
                part.bold ? <strong key={i} className="text-white font-bold">{part.text}</strong> : <React.Fragment key={i}>{part.text}</React.Fragment>,
            )}
        </>
    );
}

export function resolveImageSrc(src: string): string {
    const base = (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.BASE_URL) || '/settings/';
    const cleanBase = base.endsWith('/') ? base : `${base}/`;
    const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
    return `${cleanBase}${cleanSrc}`;
}

function StandaloneImage({
    img,
    onEnlarge,
    inGrid = false,
}: {
    img: Extract<OperatorGuideBlock, { type: 'img' }>;
    onEnlarge: (img: { src: string; alt: string }) => void;
    inGrid?: boolean;
}) {
    if (inGrid) {
        return (
            <figure className="rounded-xl border border-nature-800 bg-nature-900/50 overflow-hidden flex flex-col">
                <button
                    type="button"
                    onClick={() => onEnlarge({ src: img.src, alt: img.alt })}
                    className="w-full aspect-[16/10] bg-nature-950 block text-left group relative overflow-hidden focus:outline-none focus:ring-2 focus:ring-terra-400"
                    aria-label={`Enlarge: ${img.alt}`}
                >
                    <img
                        src={resolveImageSrc(img.src)}
                        alt={img.alt}
                        loading="lazy"
                        className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
                        <span className="px-2 py-1 rounded-full bg-nature-950/85 border border-nature-700 text-[10px] font-bold text-white shadow flex items-center gap-1">
                            <span>🔍</span> Enlarge
                        </span>
                    </div>
                </button>
                <figcaption className="p-2 text-xs text-nature-400 border-t border-nature-800 bg-nature-900/80 line-clamp-2 leading-snug flex-1">
                    {img.alt}
                </figcaption>
            </figure>
        );
    }
    return (
        <figure className="my-4 rounded-xl border border-nature-800 bg-nature-900/50 overflow-hidden max-w-full">
            <button
                type="button"
                onClick={() => onEnlarge({ src: img.src, alt: img.alt })}
                className="w-full block text-left group relative focus:outline-none focus:ring-2 focus:ring-terra-400"
                aria-label={`Enlarge: ${img.alt}`}
            >
                <img
                    src={resolveImageSrc(img.src)}
                    alt={img.alt}
                    loading="lazy"
                    className="w-full h-auto block rounded-t-xl"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
                    <span className="px-3 py-1.5 rounded-full bg-nature-950/85 border border-nature-700 text-xs font-bold text-white shadow-lg flex items-center gap-1.5">
                        <span>🔍</span> Tap to enlarge
                    </span>
                </div>
            </button>
            <figcaption className="px-3 py-2 text-xs text-nature-400 border-t border-nature-800 bg-nature-900/80">
                <span className="leading-snug">{img.alt}</span>
            </figcaption>
        </figure>
    );
}

function LinkedImageCard({
    img,
    onOpen,
}: {
    img: Extract<OperatorGuideBlock, { type: 'img' }>;
    onOpen: (slug: string) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onOpen(img.href!)}
            aria-label={`Open ${img.alt}`}
            className="group w-full text-left rounded-xl border border-nature-800 bg-nature-900/60 overflow-hidden hover:border-terra-500/60 transition-all focus:outline-none focus:ring-2 focus:ring-terra-400 flex flex-col"
        >
            <div className="aspect-[16/10] bg-nature-950 overflow-hidden w-full relative">
                <img
                    src={resolveImageSrc(img.src)}
                    alt={img.alt}
                    loading="lazy"
                    className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform duration-200"
                />
            </div>
            <div className="p-2.5 flex items-center justify-between gap-2 border-t border-nature-800/80 bg-nature-900/40 w-full flex-1">
                <span className="text-xs font-bold text-nature-200 group-hover:text-terra-300 line-clamp-2 leading-snug">
                    {img.alt}
                </span>
                <span className="text-xs font-bold text-nature-500 group-hover:text-terra-400 shrink-0">
                    →
                </span>
            </div>
        </button>
    );
}

function ImageGroup({
    items,
    onOpen,
    onEnlarge,
}: {
    items: Extract<OperatorGuideBlock, { type: 'img' }>[];
    onOpen: (slug: string) => void;
    onEnlarge: (img: { src: string; alt: string }) => void;
}) {
    if (items.length === 1 && !items[0].href) {
        return <StandaloneImage img={items[0]} onEnlarge={onEnlarge} inGrid={false} />;
    }

    return (
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 sm:grid-cols-3 gap-3 my-4">
            {items.map((img, i) =>
                img.href ? (
                    <LinkedImageCard key={i} img={img} onOpen={onOpen} />
                ) : (
                    <StandaloneImage key={i} img={img} onEnlarge={onEnlarge} inGrid={true} />
                ),
            )}
        </div>
    );
}

type GroupedBlock =
    | { kind: 'block'; block: Exclude<OperatorGuideBlock, { type: 'img' }> }
    | { kind: 'images'; items: Extract<OperatorGuideBlock, { type: 'img' }>[] };

function groupBlocks(blocks: OperatorGuideBlock[]): GroupedBlock[] {
    const result: GroupedBlock[] = [];
    let currentImgs: Extract<OperatorGuideBlock, { type: 'img' }>[] = [];

    for (const b of blocks) {
        if (b.type === 'img') {
            currentImgs.push(b);
        } else {
            if (currentImgs.length > 0) {
                result.push({ kind: 'images', items: currentImgs });
                currentImgs = [];
            }
            result.push({ kind: 'block', block: b });
        }
    }
    if (currentImgs.length > 0) {
        result.push({ kind: 'images', items: currentImgs });
    }
    return result;
}

function Block({ block }: { block: Exclude<OperatorGuideBlock, { type: 'img' }> }) {
    if (block.type === 'ul') {
        return (
            <ul className="list-disc pl-5 my-3 space-y-1.5 text-[0.95rem] leading-relaxed text-nature-200">
                {block.items.map((item, i) => <li key={i}><Rich text={item} /></li>)}
            </ul>
        );
    }
    if (block.type === 'h2') return <h2 className="text-lg font-black text-white mt-7 mb-2"><Rich text={block.text} /></h2>;
    if (block.type === 'h3') return <h3 className="text-base font-bold text-white mt-5 mb-1.5"><Rich text={block.text} /></h3>;
    return <p className="text-[0.95rem] leading-relaxed text-nature-200 my-3"><Rich text={block.text} /></p>;
}

function PageButton({ page, onOpen, snippet }: { page: OperatorGuidePage; onOpen: (slug: string) => void; snippet?: string }) {
    return (
        <li>
            <button
                type="button"
                onClick={() => onOpen(page.slug)}
                className="w-full text-left min-h-[48px] px-4 py-3 rounded-xl border border-nature-800 bg-nature-900/60 hover:border-terra-500/50 transition-colors"
            >
                <span className="block font-bold text-white">{page.title}</span>
                <span className="block text-sm text-nature-400 mt-0.5">{snippet ?? page.summary}</span>
            </button>
        </li>
    );
}

export function ManualPanel({ slug, onNavigate, onClose }: { slug: string | null; onNavigate: (slug: string | null) => void; onClose: () => void }) {
    const [query, setQuery] = useState('');
    const [enlarged, setEnlarged] = useState<{ src: string; alt: string } | null>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const page = slug ? manualPage(slug) : null;
    const results = useMemo(() => (query.trim() ? searchGuide(OPERATOR_MANUAL, query) : []), [query]);
    const groupedBlocks = useMemo(() => (page ? groupBlocks(page.blocks) : []), [page]);

    useEffect(() => { closeRef.current?.focus(); }, []);
    useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [slug]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (enlarged) {
                    setEnlarged(null);
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enlarged, onClose]);

    const open = (next: string | null) => {
        setQuery('');
        setEnlarged(null);
        onNavigate(next);
    };
    const section = page ? OPERATOR_MANUAL.sections.find(s => s.id === page.section) : null;
    const related = page ? page.related.map(manualPage).filter((p): p is OperatorGuidePage => p !== null) : [];

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Operator manual"
            className="fixed inset-0 z-[100] bg-nature-950 text-nature-100 flex flex-col font-sans"
        >
            <div className="border-b border-nature-800 bg-nature-900/80">
                <div className="max-w-3xl mx-auto flex items-center gap-2 px-4 py-2">
                    {page ? (
                        <button type="button" onClick={() => open(null)} className="min-h-[48px] px-2 text-sm font-bold text-terra-300 hover:text-terra-200">
                            ← Contents
                        </button>
                    ) : (
                        <span className="text-sm font-bold text-white px-2">📖 Manual</span>
                    )}
                    <span className="flex-1" />
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        className="min-h-[48px] min-w-[48px] px-3 rounded-lg text-sm font-bold text-nature-200 hover:text-white border border-nature-700"
                    >
                        Close
                    </button>
                </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-4 py-5">
                    <label className="block">
                        <span className="sr-only">Search the manual</span>
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search the manual"
                            className="w-full min-h-[48px] px-4 rounded-xl bg-nature-900 border border-nature-700 text-white placeholder:text-nature-500 focus:outline-none focus:border-terra-400"
                        />
                    </label>

                    {query.trim() ? (
                        <section className="mt-5" aria-label="Search results">
                            {results.length === 0 ? (
                                <p className="text-nature-400">Nothing in the manual matches “{query.trim()}”.</p>
                            ) : (
                                <ul className="space-y-2.5">
                                    {results.map(r => <PageButton key={r.page.slug} page={r.page} snippet={r.snippet} onOpen={open} />)}
                                </ul>
                            )}
                        </section>
                    ) : page ? (
                        <article className="mt-5 break-words">
                            {section && <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">{section.title}</p>}
                            <h1 className="text-2xl font-black text-white mt-1 mb-2">{page.title}</h1>
                            <p className="text-base text-nature-300 mb-4">{page.summary}</p>
                            {groupedBlocks.map((group, i) => {
                                if (group.kind === 'block') {
                                    return <Block key={i} block={group.block} />;
                                }
                                return (
                                    <ImageGroup
                                        key={i}
                                        items={group.items}
                                        onOpen={open}
                                        onEnlarge={(img) => setEnlarged(img)}
                                    />
                                );
                            })}
                            {related.length > 0 && (
                                <>
                                    <h2 className="text-lg font-black text-white mt-8 mb-3">Related</h2>
                                    <ul className="space-y-2.5">
                                        {related.map(p => <PageButton key={p.slug} page={p} onOpen={open} />)}
                                    </ul>
                                </>
                            )}
                        </article>
                    ) : (
                        <div className="mt-5">
                            <h1 className="text-2xl font-black text-white m-0">How to run your community</h1>
                            <p className="text-nature-300 mt-2">
                                For owners and admins. Every screen in Settings has a <strong className="text-white">?</strong> beside its title that opens its page here.
                            </p>
                            {OPERATOR_MANUAL.sections.map(s => (
                                <section key={s.id} className="mt-6" aria-labelledby={`manual-${s.id}`}>
                                    <h2 id={`manual-${s.id}`} className="text-lg font-black text-white m-0">{s.title}</h2>
                                    <p className="text-sm text-nature-400 mt-1 mb-3">{s.summary}</p>
                                    <ul className="space-y-2.5">
                                        {s.slugs.map(sl => manualPage(sl)).filter((p): p is OperatorGuidePage => p !== null)
                                            .map(p => <PageButton key={p.slug} page={p} onOpen={open} />)}
                                    </ul>
                                </section>
                            ))}
                        </div>
                    )}

                    <p className="mt-10 pt-4 border-t border-nature-800 text-sm text-nature-500">
                        Manual version {OPERATOR_MANUAL.version}, matching the version this server runs. This manual is part of
                        your server's Settings and works without an internet connection.
                    </p>
                </div>
            </div>

            {enlarged && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={enlarged.alt || 'Enlarged image'}
                    className="fixed inset-0 z-[120] bg-nature-950 flex flex-col animate-in fade-in"
                    onClick={() => setEnlarged(null)}
                >
                    <div
                        className="w-full border-b border-nature-800 bg-nature-900/90 backdrop-blur-sm px-4 py-2 flex items-center justify-between gap-3 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <span className="text-xs sm:text-sm font-bold text-nature-200 truncate max-w-[80%]">
                            {enlarged.alt}
                        </span>
                        <button
                            type="button"
                            onClick={() => setEnlarged(null)}
                            aria-label="Close enlarged image"
                            className="min-h-[48px] min-w-[48px] px-3 py-2 rounded-lg bg-nature-800 border border-nature-700 text-white font-bold text-sm hover:bg-nature-700 flex items-center justify-center gap-1.5 shrink-0"
                        >
                            ✕ Close
                        </button>
                    </div>
                    <div
                        className="flex-1 overflow-y-auto overflow-x-hidden p-2 sm:p-6 flex flex-col items-center"
                        onClick={() => setEnlarged(null)}
                    >
                        <div
                            className="w-full max-w-4xl my-auto"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <img
                                src={resolveImageSrc(enlarged.src)}
                                alt={enlarged.alt}
                                className="w-full h-auto block rounded-lg shadow-2xl border border-nature-800"
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
