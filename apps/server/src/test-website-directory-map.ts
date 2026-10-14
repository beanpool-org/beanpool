/**
 * beanpool.org's map of communities shows what each community published as text, never as markup (E3 of
 * scratch/global-node/REPORT-sensitive-data-opus.md).
 *
 * The map's popups are built from the public directory's rows, and anyone who runs a node can publish a row. beanpool.org
 * is the same site as the registrar's admin page (A9), so markup in a row was script on that site. This loads the
 * website's own scripts, in the order apps/website/index.html loads them, into a DOM (jsdom), with Leaflet and the
 * Supabase client replaced by fakes: the fake client answers the directory read with the rows below, and the fake Leaflet
 * keeps what each marker's popup was given and fills a popup with it as Leaflet does (text as HTML, a node as itself).
 * Contacts nothing: no network, no Supabase, no Cloudflare.
 *
 *  1. Rows whose name, email, phone and member count hold `<img src=x onerror=...>`, `"><script>`, and `javascript:`
 *     links: no element the popup doesn't build itself, no event handler, no link but mailto: and tel:, and each value
 *     shows as the text it is.
 *     A node_url that isn't an https address with a real host name (javascript:, http:, an IP, localhost, a
 *     user:password@ address) is no link; the last three each have a row of their own that only that rule turns away.
 *  2. A normal row still gets its mailto: and tel: links, its member count and its radius, and a link to its address.
 *  3. A row whose place isn't a number (Leaflet throws on it) is left off the map, and the rows after it still show.
 *  4. The totals count communities and whole-number member counts only.
 *  5. An empty directory says the apps' one "none" sentence with Start a community (the site's own #run-a-node); a
 *     first read that fails says the list isn't available, never "none", and offers no Start.
 *
 * Run: pnpm exec tsx src/test-website-directory-map.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FIND_COMMUNITY_WORDS } from '@beanpool/core';

// jsdom is the manager's and the web app's test DOM, found in the root node_modules (.npmrc: node-linker=hoisted). Its
// types aren't installed, so it is read untyped.
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

const WEBSITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'website');

let run = 0;
let passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const IMG = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = '"><script>window.__pwned=1</script>';
const JS_LINK = 'javascript:window.__pwned=1';

// What a community could put in the directory's public table.
const HOSTILE_ROWS = [
    {
        node_id: 'hostile-1', community_name: IMG, contact_email: SCRIPT, contact_phone: JS_LINK,
        member_count: 3, service_radius: { lat: -28.5, lng: 153.4, radiusKm: 10 }, node_url: JS_LINK,
    },
    {
        node_id: 'hostile-2', community_name: SCRIPT, contact_email: `${JS_LINK}//@example.com`, contact_phone: IMG,
        member_count: '<b onmouseover="window.__pwned=1">9</b>', service_radius: { lat: -37.0, lng: 144.2, radiusKm: 0 },
        node_url: 'http://plain.example.org',
    },
    {
        node_id: 'hostile-3', callsign: JS_LINK, contact_email: 'someone@example.com?body=' + IMG, contact_phone: `tel:+61;${JS_LINK}`,
        member_count: 4, service_radius: { lat: 51.5, lng: -0.1, radiusKm: `"><svg onload="window.__pwned=1">` },
        node_url: 'https://user:pw@10.0.0.1:8443',
    },
];
// One rule each: a row with a real place and nothing else to link, whose node_url only that rule turns away, so dropping
// the rule from nodeHref (apps/website/main.js) puts a link in that row's popup.
const URL_RULE_ROWS = [
    { rule: 'a user:password@ address', row: { node_id: 'userinfo', community_name: 'Userinfo Row', member_count: 2, service_radius: { lat: -33.9, lng: 151.2, radiusKm: 5 }, node_url: 'https://user:pw@good.example.org' } },
    { rule: 'an IP address', row: { node_id: 'ip', community_name: 'IP Row', member_count: 5, service_radius: { lat: -27.5, lng: 153.0, radiusKm: 5 }, node_url: 'https://10.0.0.1' } },
    { rule: 'localhost', row: { node_id: 'localhost', community_name: 'Localhost Row', member_count: 6, service_radius: { lat: -31.9, lng: 115.9, radiusKm: 5 }, node_url: 'https://localhost' } },
];
const NOT_A_PLACE = { node_id: 'nowhere', community_name: 'Nowhere', member_count: 1, service_radius: { lat: 'north', lng: 'east', radiusKm: 5 }, node_url: 'https://localhost' };
const NORMAL = {
    node_id: 'mullum', community_name: 'Mullum Creek', contact_email: 'hello@mullum.example', contact_phone: '+61 (2) 6684-0000',
    member_count: 42, service_radius: { lat: -28.55, lng: 153.5, radiusKm: 25 }, node_url: 'mullum.example.org/',
};
// The place that isn't one comes before the normal row, so the normal row shows only if the map goes on past it.
const ROWS = [...HOSTILE_ROWS, ...URL_RULE_ROWS.map((r) => r.row), NOT_A_PLACE, NORMAL];

/** The website's own scripts, in the order index.html loads them (the CDN ones are replaced by fakes). */
/** The map's empty-state box exactly as index.html has it, so the test runs on the page's own markup. */
function emptyStateMarkup(): string {
    const html = fs.readFileSync(path.join(WEBSITE, 'index.html'), 'utf-8');
    const m = html.match(/<div id="map-empty-state"[\s\S]*?<\/div>/);
    if (!m) throw new Error('index.html has no #map-empty-state');
    return m[0];
}

function siteScripts(): string[] {
    const html = fs.readFileSync(path.join(WEBSITE, 'index.html'), 'utf-8');
    const out: string[] = [];
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
        const src = m[1];
        if (/^(https?:)?\/\//.test(src)) continue;
        out.push(src.replace(/[?#].*$/, ''));
    }
    return out;
}

async function main() {
    console.log('beanpool.org map popups show what the directory holds as text...\n');

    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (e: Error) => errors.push(e.message));
    virtualConsole.on('error', (...a: unknown[]) => errors.push(a.map(String).join(' ')));
    const dom = new JSDOM(
        `<!doctype html><html><body><nav id="navbar"></nav><div class="map-wrapper"><div id="nodes-map"></div>
         ${emptyStateMarkup()}</div>
         <span id="stat-nodes">—</span><span id="stat-members">—</span></body></html>`,
        { runScripts: 'dangerously', url: 'https://beanpool.org/', virtualConsole },
    );
    const w = dom.window as any;

    // Leaflet, as far as the page uses it. L.latLng throws on a coordinate that isn't a number, as Leaflet's does.
    const popups: unknown[] = [];
    const markers: { lat: number; lng: number }[] = [];
    const chain = () => ({ addTo() { return this; }, addAttribution() { return this; } });
    const latLng = (ll: unknown[]) => {
        const [lat, lng] = ll as [unknown, unknown];
        if (isNaN(lat as number) || isNaN(lng as number)) throw new Error(`Invalid LatLng object: (${lat}, ${lng})`);
        return { lat: +(lat as number), lng: +(lng as number) };
    };
    w.L = {
        map: () => ({}),
        tileLayer: chain,
        control: { attribution: chain },
        divIcon: (o: unknown) => o,
        layerGroup: () => ({ addTo() { return this; }, clearLayers() { popups.length = 0; markers.length = 0; } }),
        marker(ll: unknown[]) {
            const at = latLng(ll);
            const m = { bindPopup(content: unknown) { popups.push(content); return m; }, addTo() { markers.push(at); return m; } };
            return m;
        },
        circle(ll: unknown[]) {
            latLng(ll);
            return chain();
        },
    };
    let reads = 0;
    let currentRows: unknown[] = ROWS;
    let readFails = false;
    w.supabase = {
        createClient: () => ({
            from: (table: string) => ({
                select: async () => {
                    reads++;
                    if (readFails) return { data: null, error: new Error('the directory is down') };
                    return table === 'directory_nodes' ? { data: currentRows, error: null } : { data: [], error: null };
                },
            }),
            auth: { signUp: async () => ({ data: null, error: null }) },
        }),
    };

    const scripts = siteScripts();
    assert(scripts.includes('main.js'), `index.html loads main.js (${scripts.join(', ')})`);
    for (const src of scripts) {
        const el = w.document.createElement('script');
        el.textContent = fs.readFileSync(path.join(WEBSITE, src), 'utf-8');
        w.document.body.appendChild(el);
    }
    // The first directory read is made at load; let it settle.
    await new Promise((r) => setTimeout(r, 100));
    assert(reads >= 1, `the page read the directory (${reads} read(s))`);
    assert(errors.length === 0, `the page ran without an error (${errors.join(' | ') || 'none'})`);

    // Each popup, filled as Leaflet fills one (Popup._updateContent): a function is called, text is set as HTML, a node is
    // put in as itself.
    const opened = popups.map((content) => {
        const box = w.document.createElement('div');
        const c = typeof content === 'function' ? (content as (l: unknown) => unknown)({}) : content;
        if (typeof c === 'string') box.innerHTML = c;
        else if (c instanceof w.Node) box.appendChild(c);
        w.document.body.appendChild(box);
        return box as any;
    });

    console.log('\n── 1. what a community published shows as text ──');
    assert(markers.length === 7 && popups.length === 7, `seven communities are on the map: three hostile rows, three address rows and the normal one (${markers.length} markers, ${popups.length} popups)`);
    const hostile = opened.slice(0, HOSTILE_ROWS.length);
    const allowedTags = new Set(['DIV', 'STRONG', 'BR', 'SPAN', 'A']);
    const foreignTags = hostile.flatMap((box) => [...box.querySelectorAll('*')].filter((el: any) => !allowedTags.has(el.tagName)).map((el: any) => el.tagName));
    assert(foreignTags.length === 0, `no element a popup doesn't build itself: no img, script, svg or b (found: ${foreignTags.join(', ') || 'none'})`);
    const handlers = hostile.flatMap((box) => [...box.querySelectorAll('*')].flatMap((el: any) =>
        [...el.attributes].filter((a: any) => /^on/i.test(a.name)).map((a: any) => `${el.tagName}[${a.name}]`)));
    assert(handlers.length === 0, `no event handler on any element (found: ${handlers.join(', ') || 'none'})`);
    const links = opened.flatMap((box) => [...box.querySelectorAll('a')].map((a: any) => a.getAttribute('href') ?? ''));
    const badLinks = links.filter((href: string) => !/^(mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+|tel:\+?\d+|https:\/\/[a-z0-9.-]+\.[a-z][a-z0-9-]*(:\d+)?)$/.test(href));
    assert(badLinks.length === 0, `no link but a plain mailto:, tel: or https:// address (bad: ${badLinks.join(' | ') || 'none'})`);
    const hostileLinks = hostile.flatMap((box) => [...box.querySelectorAll('a')].map((a: any) => a.getAttribute('href')));
    assert(hostileLinks.length === 0, `none of the hostile values became a link (${hostileLinks.join(' | ') || 'none'})`);
    assert(w.__pwned === undefined, 'nothing a community published ran');
    const text = (i: number) => (hostile[i]?.textContent ?? '') as string;
    assert(text(0).includes(IMG) && text(0).includes(SCRIPT) && text(0).includes(JS_LINK),
        `the first row's name, email and phone show as the text they are (${JSON.stringify(text(0).replace(/\s+/g, ' ').trim())})`);
    assert(text(1).includes(SCRIPT) && text(1).includes(`${JS_LINK}//@example.com`) && text(1).includes(IMG),
        `the second row's name, email and phone show as the text they are (${JSON.stringify(text(1).replace(/\s+/g, ' ').trim())})`);
    assert(text(2).includes(JS_LINK) && text(2).includes('someone@example.com?body=' + IMG) && text(2).includes(`tel:+61;${JS_LINK}`),
        `the third row's name, email and phone show as the text they are (${JSON.stringify(text(2).replace(/\s+/g, ' ').trim())})`);
    assert(!text(1).includes('onmouseover') && !text(2).includes('svg'),
        `a member count or radius that isn't a number isn't shown (${JSON.stringify([text(1), text(2)].map((t) => t.replace(/\s+/g, ' ').trim()))})`);
    URL_RULE_ROWS.forEach(({ rule, row }, i) => {
        const box = opened[HOSTILE_ROWS.length + i];
        const shown = (box?.querySelector('strong')?.textContent ?? '') as string;
        const hrefs = [...(box?.querySelectorAll('a') ?? [])].map((a: any) => a.getAttribute('href'));
        assert(shown === row.community_name && hrefs.length === 0,
            `a node_url at ${rule} is no link (${row.node_url}: ${shown || 'no popup'}, links ${hrefs.join(' | ') || 'none'})`);
    });

    console.log('\n── 2. a normal row ──');
    const normal = opened[opened.length - 1];
    const normalText = (normal?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const mail = normal?.querySelector('a[href^="mailto:"]');
    const tel = normal?.querySelector('a[href^="tel:"]');
    assert(mail?.getAttribute('href') === 'mailto:hello@mullum.example' && mail?.textContent === 'hello@mullum.example',
        `its email is a mailto: link (${mail?.outerHTML ?? 'no link'})`);
    assert(tel?.getAttribute('href') === 'tel:+61266840000' && tel?.textContent === '+61 (2) 6684-0000',
        `its phone is a tel: link to the digits, showing the number as written (${tel?.outerHTML ?? 'no link'})`);
    assert(normalText.includes('Mullum Creek') && normalText.includes('42 members') && normalText.includes('25km radius'),
        `its name, member count and radius show (${JSON.stringify(normalText)})`);
    assert(normal?.querySelector('strong')?.textContent === 'Mullum Creek', 'its name is the popup\'s heading');
    const visit = normal?.querySelector('a[href^="https:"]');
    assert(visit?.getAttribute('href') === 'https://mullum.example.org' && visit?.textContent === 'Visit mullum.example.org →'
        && visit?.getAttribute('target') === '_blank' && visit?.getAttribute('rel') === 'noopener',
        `its bare node_url is a link to its https address, opening in a new tab (${visit?.outerHTML ?? 'no link'})`);

    console.log('\n── 3 and 4. a place that isn\'t one, and the totals ──');
    assert(!markers.some((m) => isNaN(m.lat)) && markers.some((m) => m.lat === -28.55),
        `the row with no real place is left off, and the normal row after it is on the map (${JSON.stringify(markers)})`);
    const statNodes = w.document.getElementById('stat-nodes').textContent;
    const statMembers = w.document.getElementById('stat-members').textContent;
    assert(statNodes === String(ROWS.length), `every community in the directory is counted (${statNodes})`);
    assert(statMembers === String(3 + 4 + 2 + 5 + 6 + 1 + 42),`members are summed from whole-number counts only (${statMembers})`);

    const emptyState = w.document.getElementById('map-empty-state');
    assert(emptyState?.style.display === 'none', 'map empty state is hidden when communities exist');

    console.log('\n── 5. map empty state ──');
    // A later read that fails changes nothing on the map: the communities from the last good read stay.
    readFails = true;
    await w.pollNodes();
    assert(emptyState?.style.display === 'none' && w.document.getElementById('stat-nodes').textContent === String(ROWS.length),
        'a failed read after a good one leaves the map as it was');
    readFails = false;
    currentRows = [];
    await w.pollNodes();
    const emptyText = w.document.getElementById('map-empty-text');
    const startLink = w.document.getElementById('map-empty-start');
    assert(emptyState?.style.display === 'block', 'map empty state is displayed when 0 communities are listed');
    assert(emptyText?.textContent === FIND_COMMUNITY_WORDS.noneNear,
        `it says the apps' one "none" sentence, "${FIND_COMMUNITY_WORDS.noneNear}" (${JSON.stringify(emptyText?.textContent)})`);
    assert(startLink?.getAttribute('href') === '#run-a-node' && startLink?.textContent === FIND_COMMUNITY_WORDS.start && startLink?.style.display !== 'none',
        `with Start a community, to the site's own how-to-run-a-node (${startLink?.outerHTML})`);
    assert(emptyState?.getAttribute('role') === 'status', 'and a screen reader hears it');
    const emptyStatNodes = w.document.getElementById('stat-nodes').textContent;
    assert(emptyStatNodes === '—', `stat-nodes is — rather than bare 0 (${emptyStatNodes})`);
    dom.window.close();

    console.log('\n── 5b. the directory never answered: no "none" ──');
    const down = new JSDOM(
        `<!doctype html><html><body><nav id="navbar"></nav><div class="map-wrapper"><div id="nodes-map"></div>
         ${emptyStateMarkup()}</div><span id="stat-nodes">—</span><span id="stat-members">—</span></body></html>`,
        { runScripts: 'dangerously', url: 'https://beanpool.org/', virtualConsole: new VirtualConsole() },
    );
    const d = down.window as any;
    d.L = w.L;
    d.supabase = { createClient: () => ({ from: () => ({ select: async () => ({ data: null, error: new Error('the directory is down') }) }), auth: { signUp: async () => ({ data: null, error: null }) } }) };
    d.console.error = () => {};
    for (const src of scripts) {
        const el = d.document.createElement('script');
        el.textContent = fs.readFileSync(path.join(WEBSITE, src), 'utf-8');
        d.document.body.appendChild(el);
    }
    await new Promise((r) => setTimeout(r, 100));
    const downText = d.document.getElementById('map-empty-text')?.textContent;
    assert(d.document.getElementById('map-empty-state')?.style.display === 'block' && downText === FIND_COMMUNITY_WORDS.notLoaded,
        `a first read that fails says the list isn't available, not that there is none (${JSON.stringify(downText)})`);
    assert(d.document.getElementById('map-empty-start')?.style.display === 'none', 'and offers no Start on a map it could not read');
    down.window.close();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The map shows what communities publish as text.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
