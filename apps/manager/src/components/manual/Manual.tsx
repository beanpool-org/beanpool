import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { searchGuide, splitBold, type GuideBlock, type GuidePage } from '@beanpool/core';
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

function Block({ block }: { block: GuideBlock }) {
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

function PageButton({ page, onOpen, snippet }: { page: GuidePage; onOpen: (slug: string) => void; snippet?: string }) {
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
    const closeRef = useRef<HTMLButtonElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const page = slug ? manualPage(slug) : null;
    const results = useMemo(() => (query.trim() ? searchGuide(OPERATOR_MANUAL, query) : []), [query]);

    useEffect(() => { closeRef.current?.focus(); }, []);
    useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [slug]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const open = (next: string | null) => {
        setQuery('');
        onNavigate(next);
    };
    const section = page ? OPERATOR_MANUAL.sections.find(s => s.id === page.section) : null;
    const related = page ? page.related.map(manualPage).filter((p): p is GuidePage => p !== null) : [];

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
                            {page.blocks.map((b, i) => <Block key={i} block={b} />)}
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
                                        {s.slugs.map(sl => manualPage(sl)).filter((p): p is GuidePage => p !== null)
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
        </div>
    );
}
