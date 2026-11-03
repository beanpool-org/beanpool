/**
 * Front doors S9 shots: Settings → Use the phone app with Put your account on your phone, in each state, against a
 * stubbed relay (no request leaves the page). `?state=` code | phone | digits | wrong | done | burned | nowords.
 */
import { createRoot } from 'react-dom/client';
import { createPairInKey } from '@beanpool/core';
import { BeanPoolSettingsGroup } from '../src/pages/SettingsPage';
import { createIdentity, generateIdentity, importIdentity } from '../src/lib/identity';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const state = params.get('state') || 'code';
document.documentElement.classList.toggle('dark', params.get('dark') === '1');

const phone = createPairInKey();
let polls = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
window.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/pair/init') return json({ success: true, expiresAt: Date.now() + 120_000 });
    if (path.startsWith('/api/pair/poll')) {
        polls++;
        if (state === 'code' || state === 'phone' || state === 'nowords') return json({ status: 'waiting' });
        if (state === 'burned') return json({ status: 'burned' });
        if (state === 'done') return json(polls === 1 ? { status: 'released', phonePubHex: phone.publicKeyHex } : { status: 'collected' });
        return json({ status: 'confirming' });
    }
    if (path === '/api/pair/confirm') return json({ result: 'wrong', triesLeft: 2 }, 400);
    if (path === '/api/pair/send') return json({ success: true });
    return json({});
}) as typeof fetch;

async function main() {
    if (state === 'nowords') {
        // A legacy account, kept without its 12 words.
        const made = await generateIdentity('Sam');
        await importIdentity({ ...made, mnemonic: undefined });
    } else {
        await createIdentity('Samantha-Jane Wolfenden');
    }
    createRoot(document.getElementById('root')!).render(
        <div className="max-w-md mx-auto p-4 bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800">
            <BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} onRemoveHere={() => {}} />
        </div>,
    );
}
void main();
