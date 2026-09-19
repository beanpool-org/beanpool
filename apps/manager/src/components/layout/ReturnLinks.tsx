import React from 'react';
import type { BackLink } from '../../lib/came-from';

/**
 * The way out of Settings: back to wherever the member came from (the phone app, the web app, or — when
 * nobody knows — the web app on this node), plus "View my profile" when a member key signed in.
 * lib/came-from.ts decides the labels and links.
 */
export type ReturnLinksValue = { back: BackLink; profile: BackLink | null };

/** Stacked rows at the top of the desktop sidebar and of the phone menu. */
export function ReturnLinks({ links, large }: { links: ReturnLinksValue; large?: boolean }) {
    const row = `w-full flex items-center gap-2.5 px-3 ${large ? 'min-h-[48px] text-sm' : 'min-h-[40px] text-xs'} rounded-xl font-bold no-underline transition-all`;
    return (
        <nav aria-label="Leave Settings" className="px-3 pt-3 space-y-1">
            <a
                href={links.back.href}
                className={`${row} text-terra-200 bg-terra-500/10 border border-terra-500/30 hover:bg-terra-500/20 hover:text-white`}
            >
                <span className="text-sm shrink-0" aria-hidden="true">{links.back.glyph}</span>
                <span className="min-w-0 break-words">{links.back.label}</span>
            </a>
            {links.profile && (
                <a
                    href={links.profile.href}
                    className={`${row} text-nature-200 border border-transparent hover:text-white hover:bg-nature-800/50`}
                >
                    <span className="text-sm shrink-0" aria-hidden="true">{links.profile.glyph}</span>
                    <span className="min-w-0 break-words">{links.profile.label}</span>
                </a>
            )}
        </nav>
    );
}

/** The phone top bar's short form: a 48px link with a glyph and one word; its accessible name is the full label. */
export function PhoneReturnLink({ back }: { back: BackLink }) {
    return (
        <a
            href={back.href}
            aria-label={back.label}
            title={back.label}
            className="shrink-0 min-w-[48px] min-h-[48px] px-2 rounded-xl flex items-center justify-center gap-1 text-xs font-bold text-terra-300 hover:text-white hover:bg-nature-800/60 no-underline"
        >
            <span aria-hidden="true" className="text-base leading-none">{back.glyph}</span>
            <span aria-hidden="true">{back.short}</span>
        </a>
    );
}
