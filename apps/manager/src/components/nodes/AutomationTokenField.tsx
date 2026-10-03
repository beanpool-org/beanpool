import React, { useState } from 'react';
import { isAutomationToken } from '../../lib/node-client';

/**
 * A node profile's automation token (node sign-in step 7b-1): masked, pasted, held in this page's memory only like the
 * password (profiles.ts). When set, it is the only credential the profile's requests carry.
 */
export function AutomationTokenField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const [show, setShow] = useState(false);
    const trimmed = value.trim();
    const malformed = trimmed !== '' && !isAutomationToken(trimmed);

    const paste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) onChange(text.trim());
        } catch { /* the browser said no: the field still takes a paste */ }
    };

    return (
        <div>
            <label htmlFor="bp-automation-token" className="block text-nature-300 font-semibold mb-1">Automation token</label>
            <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 basis-[10rem] min-w-0">
                    <input
                        id="bp-automation-token"
                        type={show ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder="bp_…"
                        aria-invalid={malformed}
                        aria-describedby="bp-automation-token-help"
                        className="w-full bg-nature-950 border border-nature-800 pl-3.5 pr-10 py-2.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 shadow-inner"
                    />
                    <button
                        type="button"
                        onClick={() => setShow(!show)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-nature-400 hover:text-white transition-colors text-sm"
                        title={show ? 'Hide token' : 'Show token'}
                        aria-label={show ? 'Hide token' : 'Show token'}
                    >
                        {show ? '🙈' : '👁️'}
                    </button>
                </div>
                <button
                    type="button"
                    onClick={() => { void paste(); }}
                    className="min-h-[44px] px-3 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 font-bold border border-nature-700"
                >
                    Paste
                </button>
            </div>
            {malformed && (
                <p role="alert" className="text-red-400 mt-1 mb-0">That isn&rsquo;t a token: a token starts bp_ and is copied whole from Settings.</p>
            )}
            <details id="bp-automation-token-help" className="mt-1 text-nature-400">
                <summary className="cursor-pointer min-h-[32px] py-1">Where do I get one?</summary>
                <p className="m-0 mt-1 break-words">
                    In this node&rsquo;s Settings, under Automation tokens, made from your phone: open Settings with Manage in
                    the BeanPool app, or sign in on a computer by scanning the code with the app, as an owner. Pick what it may
                    do, then Make a token. It is shown once: copy it and paste it here. It stays in this page only and is asked again after a reload.
                    With a token, the password is not sent. A token never makes an owner-only change (owners, 2FA, the public
                    address, take-over, restoring): for those the manager says so and sends you to sign in with your phone.
                </p>
            </details>
        </div>
    );
}
