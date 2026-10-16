/**
 * Start a community, in the web app (scratch/global-node/DESIGN-global-showcase-fable.md §3): the phone's
 * /start-community in the same words (lib/start-community.ts), what to know before the link, then the node's own
 * "how to run a node" page and the setup chapter. Opened from the 🏘️ sheet and the strip, over whatever screen is open.
 *
 * Nothing here talks to the node: the details are copied to this device's clipboard and go nowhere else; the links
 * open in a new tab. The start link is the node's `startCommunityUrl` (beanpool.org's when it names none).
 */

import { useEffect, useRef, useState } from 'react';
import { useDialogFocus } from './dialog-focus';
import { startCommunityUrl, useCommunityInfo } from '../lib/features';
import { useCoversScreen } from '../lib/screen-cover';
import {
    START_COMMUNITY_COPY as COPY, START_COMMUNITY_KNOW as KNOW, SETUP_CHAPTER_URL, canCopyDetails, communityDetailsText,
} from '../lib/start-community';

const FIELD = 'w-full rounded-xl border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 px-3 py-2.5 text-[15px] text-nature-900 dark:text-nature-50 placeholder:text-nature-400 dark:placeholder:text-nature-500 focus:outline-none focus:ring-2 focus:ring-terra-500';

export function StartCommunityScreen({
    onClose,
    onNearYou,
    returnFocus,
}: {
    onClose: () => void;
    onNearYou?: () => void;
    returnFocus?: () => HTMLElement | null | undefined;
}) {
    const info = useCommunityInfo();
    useCoversScreen();
    const dialog = useRef<HTMLDivElement>(null);
    const backRef = useRef<HTMLButtonElement>(null);
    const [name, setName] = useState('');
    const [place, setPlace] = useState('');
    const [contact, setContact] = useState('');
    const [copied, setCopied] = useState<'yes' | 'no' | null>(null);

    useDialogFocus(dialog, onClose, {
        initialFocus: () => backRef.current,
        fallback: returnFocus,
    });

    const details = { name, place, contact };
    async function copy() {
        try {
            await navigator.clipboard.writeText(communityDetailsText(details));
            setCopied('yes');
        } catch {
            setCopied('no');
        }
    }

    return (
        <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="start-community-title"
            data-testid="start-community-screen"
            className="fixed inset-0 z-[1210] overflow-y-auto bg-nature-50 dark:bg-nature-950"
        >
            <div className="mx-auto max-w-2xl px-4 pb-10 pt-4">
                <div className="mb-4 flex items-center gap-2">
                    <button ref={backRef} type="button" onClick={onClose} aria-label="Back"
                        className="-ml-2 shrink-0 rounded-lg px-2 py-1 text-xl text-nature-600 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-800">←</button>
                    <h1 id="start-community-title" className="min-w-0 text-2xl font-extrabold text-nature-900 dark:text-nature-50">{COPY.title}</h1>
                </div>
                <p className="mb-5 text-[15px] leading-relaxed text-nature-700 dark:text-nature-200">{COPY.intro}</p>

                <ul className="mb-6 flex flex-col gap-3">
                    {COPY.ways.map((w) => (
                        <li key={w.title} className="flex gap-3 rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-4">
                            <span className="shrink-0 text-2xl" aria-hidden="true">{w.icon}</span>
                            <div className="min-w-0">
                                <h2 className="font-bold text-nature-900 dark:text-nature-50">{w.title}</h2>
                                <p className="text-sm text-nature-600 dark:text-nature-300">{w.body}</p>
                            </div>
                        </li>
                    ))}
                </ul>

                <section className="mb-6 rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-4" data-testid="start-community-know">
                    <h2 className="mb-2 font-extrabold text-nature-900 dark:text-nature-50">{KNOW.heading}</h2>
                    <dl className="flex flex-col gap-2">
                        {KNOW.lines.map((l) => (
                            <div key={l.label}>
                                <dt className="text-sm font-bold text-nature-800 dark:text-nature-100">{l.label}</dt>
                                <dd className="text-sm text-nature-600 dark:text-nature-300">{l.body}</dd>
                            </div>
                        ))}
                    </dl>
                    <p className="mt-3 text-sm text-nature-700 dark:text-nature-200">{KNOW.steps}</p>
                    <div className="mt-4 flex flex-col gap-2">
                        <a href={startCommunityUrl(info)} target="_blank" rel="noopener noreferrer" data-testid="start-community-run-a-node"
                            className="w-full rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover px-4 py-3 text-center font-bold text-bp-cta-on">{COPY.website} ↗</a>
                        <a href={SETUP_CHAPTER_URL} target="_blank" rel="noopener noreferrer" data-testid="start-community-setup"
                            className="w-full rounded-xl border border-nature-300 dark:border-nature-600 px-4 py-3 text-center font-bold text-nature-800 dark:text-nature-100 hover:bg-nature-50 dark:hover:bg-nature-800">{KNOW.setupChapter} ↗</a>
                    </div>
                </section>

                <p className="mb-4 text-sm text-nature-700 dark:text-nature-200">{COPY.after}</p>

                <section className="mb-6 rounded-2xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900 p-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-bold text-nature-800 dark:text-nature-100">Community name
                            <input className={`${FIELD} mt-1`} value={name} onChange={(e) => { setName(e.target.value); setCopied(null); }} placeholder="e.g. Riverbend" />
                        </label>
                        <label className="text-sm font-bold text-nature-800 dark:text-nature-100">Place
                            <input className={`${FIELD} mt-1`} value={place} onChange={(e) => { setPlace(e.target.value); setCopied(null); }} placeholder="A town or area" />
                        </label>
                        <label className="text-sm font-bold text-nature-800 dark:text-nature-100">Contact
                            <input className={`${FIELD} mt-1`} value={contact} onChange={(e) => { setContact(e.target.value); setCopied(null); }} placeholder="How people can reach you" />
                        </label>
                    </div>
                    <button type="button" onClick={copy} disabled={!canCopyDetails(details)} data-testid="start-community-copy"
                        className="mt-3 w-full rounded-xl border border-nature-300 dark:border-nature-600 px-4 py-3 font-bold text-nature-800 dark:text-nature-100 hover:bg-nature-50 dark:hover:bg-nature-800 disabled:cursor-not-allowed">
                        📋 {COPY.copyButton}
                    </button>
                    {copied === 'yes' && <p className="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400" role="status">{COPY.copied}</p>}
                    {copied === 'no' && <p className="mt-2 text-sm text-nature-700 dark:text-nature-200" role="status">This browser wouldn’t copy. Write the details down, or copy them from here by hand.</p>}
                </section>

                {onNearYou && (
                    <button type="button" onClick={() => { onClose(); onNearYou(); }}
                        className="w-full rounded-xl px-4 py-3 font-bold text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/50">
                        Or find a community near you ›
                    </button>
                )}
            </div>
        </div>
    );
}
