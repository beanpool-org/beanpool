// Invite trampoline — the landing page served at `/?invite=<code>` when the
// native app is NOT installed (an installed app intercepts the link via
// verified App Links / Universal Links and never reaches here).
//
// Its job is deliberately narrow: get the user to install the native app and
// carry the invite code across the install, WITHOUT joining/redeeming here.
//   - Android: one button that opens the app WITH the invite when it is
//     installed (an `intent://` link to `beanpool://welcome?invite=…&server=…`
//     for org.beanpool.pillar), and otherwise falls back to the Play Store with
//     the code packed into the `referrer` param, which the app reads on first
//     launch (see apps/native/app/welcome.tsx — the Install Referrer consumer).
//     An installed app reaches this page when the link didn't hand over (App
//     Links not verified on that phone, a camera's own browser): its Play page
//     only offers "Open", which starts the app with no link and no referrer, so
//     the invite was lost (Damo, 9 Nov). Every button also copies the link, so
//     the app's Paste offer has it whichever way the member gets there.
//   - iOS (no Play-referrer equivalent; DESIGN-ios-invite-paste-fable.md §4.2-4.3, Marty 21 Nov: all Fable's picks):
//     the App Store badge copies the invite link INSIDE its tap, in a way the page can check (copyInvite, below), and
//     the page says only what happened: nothing claims a copy before the tap, and a copy that failed says so, with the
//     way that needs no clipboard. That way is the second button, "Open your invite in BeanPool": the app's own
//     domain-free link with the invite in it, which goes to the top once the person comes back from the store. The
//     code card, with the address it belongs to, stays as the floor that always works. No Safari smart banner: with
//     no app it sends people to the store past the copy (the design's option D′).
//   - A de-emphasised "continue in your browser" escape hatch behind an explicit
//     confirmation routes the rare user who wants the web PWA to
//     /app?invite=<code>&webjoin=1 (the only path the PWA will redeem on).
//
// This page is fully static: it reads the code from window.location and the node
// origin from window.location.origin, so nothing user-controlled is interpolated
// server-side (no injection surface) and the code is only ever written via
// textContent / encodeURIComponent on the client.
//
// The store badges (Apple's "Download on the App Store" and Google's "Get it on Google Play", their own artwork, embedded
// unmodified in store-badge-art.ts) are plain links in the page itself, so they work with no script at all and need
// nothing from outside this node: both show, App Store first, and each links to its store. The script then points them at
// this invite (Google Play's referrer, the copied link) and, on a phone, shows only that phone's own store. Their alt text
// is the one thing written into the page by the server, in the visitor's language (`lang`, from the same ?lang= /
// Accept-Language reading as the community card): a sentence of this node's catalogs, never a request value. The artwork
// itself is English: the page around it is English too, and a badge in another language would be the only thing on the
// page in one. The owners publish localized badges (Apple 50 localizations, Google a file per language), to be used with
// the page's own words once it has them.
//
// What Apple and Google ask of the badges, and where this page keeps to it:
//   - Never changed, recoloured, cropped or redrawn: store-badge-art.ts holds the owners' files byte for byte, with a hash.
//   - At least 40 px tall on a screen (Apple) / 28 px (Google): BADGE_HEIGHT_PX, 48.
//   - Clear space round a badge of a quarter of its height (both): BADGE_CLEAR_SPACE_PX, as the padding of the link, which
//     is also its tap area. No other element sits in it.
//   - Apple's badge first when badges stand together; Google's no smaller than the other badges: App Store first in the
//     page, both the same height.
//   - Apple's preferred black badge, and a plain background that the badge's own edge stands out from.

import { brandCssVariableMap, word, type Lang } from '@beanpool/core';
import { wordsIn } from '../member-words.js';
import { RTL, escapeHtml } from './community-card.js';
import { APP_STORE_BADGE_SVG, GOOGLE_PLAY_BADGE_SVG, svgDataUri } from './store-badge-art.js';

const APP_STORE_URL = 'https://apps.apple.com/app/id6761870086';
const PLAY_BASE_URL = 'https://play.google.com/store/apps/details?id=org.beanpool.pillar';

/** The failed copy's line: the warning chip's pair from core's one colour library, in dark (this page is dark only). */
const DARK = brandCssVariableMap('dark');
export const WARN = { tint: DARK['--bp-chip-warn-tint'], ink: DARK['--bp-chip-warn-ink'] } as const;

/** Both badges are this tall, in px (Apple asks 40 at least, Google 28; Google's must be no smaller than Apple's). */
export const BADGE_HEIGHT_PX = 48;
/** Clear space round a badge: a quarter of its height (Apple and Google both). */
export const BADGE_CLEAR_SPACE_PX = BADGE_HEIGHT_PX / 4;
/** The artwork's own shape (its viewBox), for the width the image holds before it loads. */
const APP_STORE_ASPECT = 119.66407 / 40;
const GOOGLE_PLAY_ASPECT = 238.96 / 70.87;

/** The badges' alt text, which is what a screen reader says; the pictures themselves say it in English. */
export const BADGE_WORDS = {
    appStore: word('Download on the App Store'),
    googlePlay: word('Get it on Google Play'),
} as const;

/**
 * The page's words on an iPhone (DESIGN-ios-invite-paste-fable.md §4.2), in the visitor's language as the badges' alt text
 * is. The rest of the page is still English; its words join the catalogs in a later slice.
 */
export const INVITE_PAGE_WORDS = {
    /** Over the App Store badge: the one line a newcomer needs. "I have an invite" is the app's own button. */
    lead: word('New here? Get BeanPool, then tap “I have an invite”.'),
    /** Under the badge, before and after a copy that worked: what the tap does, never that it has happened. */
    copies: word('Tapping the badge copies your invite.'),
    /** In its place when the copy failed: the way that needs no clipboard. Names the button below by its words. */
    notCopied: word('Your invite wasn’t copied. After installing, come back here and tap Open your invite in BeanPool.'),
    /** The second button, a real one, under the badge. */
    openFirst: word('Have BeanPool already? Open your invite in it'),
    /** The same button, solid and on top, once the person is back from the store. */
    openBack: word('Open your invite in BeanPool'),
    codeLabel: word('Your invite code'),
    /** Under the code: the community's address, which the app asks for when the code is typed. */
    codeAt: word('at {address}'),
    copy: word('Copy'),
    copied: word('Copied'),
} as const;

/** JSON safe inside a `<script>` block: `<`, `>`, `&` and the two JS line terminators escaped (routes/apple-probe.ts). */
function jsonForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export function renderInviteTrampoline(opts: { webJoin: boolean; lang?: Lang | null }): string {
    const lang = opts.lang ?? null;
    const english = wordsIn(null);
    const words = wordsIn(lang);
    // A sentence in the visitor's language, and the language it is in: one the catalog does not have shows in English,
    // and says so (no language mark, so a screen reader reads it as the page's English).
    const say = (key: typeof BADGE_WORDS[keyof typeof BADGE_WORDS] | typeof INVITE_PAGE_WORDS[keyof typeof INVITE_PAGE_WORDS]) => {
        const text = words.t(key);
        const tag = lang && lang !== 'en' && text !== english.t(key) ? lang : null;
        return { text, tag, dir: tag && RTL.has(tag) ? 'rtl' as const : null };
    };
    const alt = (key: typeof BADGE_WORDS[keyof typeof BADGE_WORDS]) => {
        const { text, tag, dir } = say(key);
        return `alt="${escapeHtml(text)}"${tag ? ` lang="${escapeHtml(tag)}"${dir ? ' dir="rtl"' : ''}` : ''}`;
    };
    // The iPhone's words, for the page's script: each from this node's catalogs, never from the request.
    const iphoneWords: Record<string, { t: string; lang?: string; dir?: string }> = {};
    for (const [name, key] of Object.entries(INVITE_PAGE_WORDS)) {
        const { text, tag, dir } = say(key);
        iphoneWords[name] = { t: text, ...(tag ? { lang: tag } : {}), ...(dir ? { dir } : {}) };
    }
    const badgeImg = (svg: string, aspect: number, key: typeof BADGE_WORDS[keyof typeof BADGE_WORDS]) =>
        `<img src="${svgDataUri(svg)}" ${alt(key)} width="${Math.round(BADGE_HEIGHT_PX * aspect)}" height="${BADGE_HEIGHT_PX}">`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Your BeanPool invite</title>
<style>
  :root {
    --bg:#0c110e; --card:#121a15; --card2:#18221c; --line:#25322a;
    --ink:#eaf0ea; --muted:#93a29a; --faint:#657168;
    --accent:#37b26b; --accent-ink:#062a15; --accent-soft:#12331f;
    --danger:#e0674f;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; background:var(--bg); color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:460px; margin:0 auto; padding:32px 20px 48px; min-height:100vh;
    display:flex; flex-direction:column; }
  .logo { font-size:34px; text-align:center; }
  h1 { font-size:24px; font-weight:680; letter-spacing:-0.02em; text-align:center;
    margin:14px 0 6px; text-wrap:balance; }
  .sub { text-align:center; color:var(--muted); font-size:15px; margin:0 auto 26px; max-width:34ch; }
  .sub b { color:var(--ink); font-weight:620; }

  .codecard { background:var(--card); border:1px solid var(--line); border-radius:16px;
    padding:16px; margin-bottom:22px; }
  .codelabel { font-size:11px; text-transform:uppercase; letter-spacing:0.12em; color:var(--faint);
    margin-bottom:8px; }
  .coderow { display:flex; align-items:center; gap:10px; }
  #code { flex:1; min-width:0; font-family:ui-monospace,"SF Mono",Menlo,monospace;
    font-size:18px; font-weight:600; color:var(--accent); letter-spacing:0.04em;
    word-break:break-all; }
  .copybtn { flex-shrink:0; border:1px solid var(--line); background:var(--card2); color:var(--ink);
    font-size:13px; font-weight:600; padding:9px 13px; border-radius:10px; cursor:pointer; }
  .copybtn:active { transform:scale(0.97); }

  .steps { display:grid; gap:14px; margin:0 0 24px; padding:0; list-style:none; }
  .step { display:grid; grid-template-columns:26px 1fr; gap:12px; align-items:start; }
  .step .n { width:26px; height:26px; border-radius:999px; background:var(--accent-soft);
    color:var(--accent); font-size:13px; font-weight:700; display:grid; place-items:center;
    font-family:ui-monospace,monospace; }
  .step .t { font-size:14.5px; padding-top:2px; }
  .step .t small { display:block; color:var(--muted); font-size:12.5px; }

  .cta { display:block; width:100%; text-align:center; text-decoration:none;
    background:var(--accent); color:var(--accent-ink); font-size:16px; font-weight:700;
    padding:15px; border-radius:14px; margin-bottom:12px; border:none; cursor:pointer; }
  .cta:active { transform:scale(0.99); }
  .cta.secondary { background:var(--card2); color:var(--ink); border:1px solid var(--line);
    font-weight:600; font-size:15px; }
  /* The store badges: Apple's and Google's own artwork, the same height, the clear space they ask for as the link's own padding. */
  .badges { display:flex; flex-wrap:wrap; justify-content:center; align-items:center; margin:0 0 8px; }
  .badge { display:block; padding:${BADGE_CLEAR_SPACE_PX}px; line-height:0; border-radius:${BADGE_CLEAR_SPACE_PX}px; }
  .badge img { display:block; height:${BADGE_HEIGHT_PX}px; width:auto; }
  .badge:focus-visible { outline:3px solid var(--accent); outline-offset:-3px; }

  [hidden] { display:none !important; }
  /* The iPhone's lines round the App Store badge. The failed copy's line takes the warning chip's colours (core's brand-colours.ts, dark: this page is dark). */
  .lead { text-align:center; font-size:16px; font-weight:620; margin:0 0 4px; text-wrap:balance; }
  .copynote { text-align:center; color:var(--muted); font-size:13px; margin:0 0 16px; }
  .copynote.warn { text-align:start; background:${WARN.tint}; color:${WARN.ink}; border-radius:12px; padding:10px 12px;
    font-size:14px; font-weight:600; line-height:1.4; }
  .codeat { color:var(--muted); font-size:12.5px; margin-top:4px; overflow-wrap:anywhere; }

  .desktop-note { display:none; text-align:center; color:var(--muted); font-size:14px;
    background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px;
    margin-bottom:16px; }
  .desktop-note.show { display:block; }

  .hatch { margin-top:auto; padding-top:28px; text-align:center; }
  .hatch a { color:var(--faint); font-size:13px; text-decoration:underline; text-underline-offset:2px; }

  .banner { display:none; border-radius:12px; padding:14px 16px; margin-bottom:22px; font-size:14px; }
  .banner.show { display:block; }
  .banner.bad { background:#2a1512; border:1px solid #52251c; color:#f2b8ab; }

  .modal { position:fixed; inset:0; background:rgba(0,0,0,0.66); display:none;
    align-items:flex-end; justify-content:center; padding:0; z-index:10; }
  .modal.open { display:flex; }
  .sheet { background:var(--card); border:1px solid var(--line); border-bottom:none;
    border-radius:18px 18px 0 0; padding:24px 22px calc(24px + env(safe-area-inset-bottom));
    width:100%; max-width:460px; }
  .sheet h2 { font-size:18px; font-weight:680; margin:0 0 10px; }
  .sheet p { font-size:14px; color:var(--muted); margin:0 0 20px; }
  .sheet p b { color:var(--ink); }
  .sheet .cta { margin-bottom:10px; }
  @media (min-width:520px){ .modal { align-items:center; } .sheet { border-radius:18px; border-bottom:1px solid var(--line); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">🫘</div>
  <h1>You're invited to BeanPool</h1>
  <p class="sub" id="sub">Join <b id="community">your community</b> — install the app to get started.</p>

  <div class="banner" id="banner"></div>

  <div class="codecard" id="codecard">
    <div class="codelabel" id="codeLabel">Your invite code</div>
    <div class="coderow">
      <span id="code">—</span>
      <button class="copybtn" id="copyBtn" type="button">Copy code</button>
    </div>
    <div class="codeat" id="codeAt" hidden></div>
  </div>

  <div id="installArea">
    <ol class="steps" id="steps"></ol>
    <a class="cta" id="installBtn" href="#" rel="noopener" style="display:none;">Get the app</a>
    <p class="lead" id="iosLead" hidden></p>
    <div class="badges" id="badges">
      <a class="badge" id="iosStore" href="${escapeHtml(APP_STORE_URL)}" rel="noopener">${badgeImg(APP_STORE_BADGE_SVG, APP_STORE_ASPECT, BADGE_WORDS.appStore)}</a>
      <a class="badge" id="androidStore" href="${escapeHtml(PLAY_BASE_URL)}" rel="noopener">${badgeImg(GOOGLE_PLAY_BADGE_SVG, GOOGLE_PLAY_ASPECT, BADGE_WORDS.googlePlay)}</a>
    </div>
    <p class="copynote" id="copyNote" role="status" hidden></p>
    <a class="cta secondary" id="openAppBtn" href="#" style="margin-top:10px; display:none;">Have BeanPool already? Open your invite in it</a>
    <div class="desktop-note" id="desktopNote">Open this invite link on your phone to install the app.</div>
  </div>

  <div class="hatch" id="hatchWrap">
    <a href="#" id="hatch">Can't install the app? Continue in your browser →</a>
  </div>
</div>

<div class="modal" id="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
  <div class="sheet">
    <h2 id="modalTitle">Join in your browser?</h2>
    <p>Most people should use the app — it's faster and moves with you between phones.
       Continuing here creates an account that lives <b>only in this browser, on this device</b>.
       It won't move to the app later, and because your invite works only once, switching to the app
       afterwards means restoring your account with your 12 recovery words — not re-using the code.</p>
    <button class="cta" id="cancelWeb" type="button">Get the app instead</button>
    <button class="cta secondary" id="proceedWeb" type="button">Continue in browser</button>
  </div>
</div>

<script>
(function(){
  var params = new URLSearchParams(location.search);
  var code = (params.get('invite') || '').trim();
  // The listing an invite-and-share link was sent from (&post=<id>): only ever a place to open after the join, so it is
  // carried across the install and read for nothing else, nothing is looked up here and nothing is shown. Checked as an id
  // (an id is letters, digits, _ and -, as @beanpool/core landingPostId); anything else is no listing, and the invite
  // goes on without it exactly as it always has.
  var rawPost = (params.get('post') || '').trim();
  var post = /^[A-Za-z0-9_-]{1,100}$/.test(rawPost) ? rawPost : '';
  var origin = location.origin;
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  var isAndroid = /android/i.test(ua);
  // Whether this node offers a web PWA at all. Injected server-side from the
  // node's servePwa gateway setting — false on headless nodes, where the
  // "continue in browser" escape hatch is hidden entirely (native app only).
  var WEB_JOIN = ${opts.webJoin ? 'true' : 'false'};

  var APP_STORE = ${JSON.stringify(APP_STORE_URL)};
  var PLAY_BASE = ${JSON.stringify(PLAY_BASE_URL)};
  function playUrl(){ return PLAY_BASE + '&referrer=' + encodeURIComponent('invite=' + code + '&server=' + origin + (post ? '&post=' + post : '')); }
  // The app's own link for this invite (app/welcome.tsx reads invite, server and post from it).
  var appQuery = 'welcome?invite=' + encodeURIComponent(code) + '&server=' + encodeURIComponent(origin) + (post ? '&post=' + post : '');
  // Android: the app itself when installed, with the invite; when it isn't, the browser goes to the Play link with its referrer.
  function androidAppUrl(){ return 'intent://' + appQuery + '#Intent;scheme=beanpool;package=org.beanpool.pillar;S.browser_fallback_url=' + encodeURIComponent(playUrl()) + ';end'; }

  // The iPhone's words, in the visitor's language where this node's catalogs have them (renderInviteTrampoline).
  var W = ${jsonForScript(iphoneWords)};
  function put(el, w){
    el.textContent = w.t;
    if (w.lang) el.setAttribute('lang', w.lang); else el.removeAttribute('lang');
    if (w.dir) el.setAttribute('dir', w.dir); else el.removeAttribute('dir');
  }

  var codeEl = document.getElementById('code');
  codeEl.textContent = code || '—';
  // Copy the FULL invite link (not just the bare code): it carries the node
  // origin, which the app needs to know WHICH node to join. The app's
  // clipboard/paste parser extracts both the code and the server from it.
  var inviteLink = origin + '/?invite=' + code + (post ? '&post=' + post : '');

  // The link, copied INSIDE the tap that calls this, in a way the page can check (DESIGN-ios-invite-paste-fable.md §4.3),
  // as plain text and as a link (text/uri-list, which Safari keeps). First the old synchronous way: a copy event the page
  // fills, fired by execCommand('copy'). It works on plain http:// (where navigator.clipboard does not exist), it is done
  // before the tap leaves for the store, and it answers true or false. Only when it says no, navigator.clipboard, still in
  // the same tap. Resolves true only when a write said yes; never rejects.
  function copyInvite(){
    if (copyByEvent()) return Promise.resolve(true);
    return copyByClipboard();
  }
  function copyByEvent(){
    var filled = function(e){
      if (!e.clipboardData) return; // the browser copies the selected link below as text
      try {
        e.clipboardData.setData('text/plain', inviteLink);
        e.clipboardData.setData('text/uri-list', inviteLink);
        e.preventDefault();
      } catch (_) {}
    };
    // The link selected in a box nobody sees: Safari copies only with something selected, and a browser that ignores the
    // page's own data still copies the link. Read-only, so no keyboard; 12pt, so iOS does not zoom.
    var box = document.createElement('textarea');
    box.value = inviteLink;
    box.setAttribute('readonly', '');
    box.setAttribute('aria-hidden', 'true');
    box.style.position = 'fixed'; box.style.top = '0'; box.style.left = '-9999px';
    box.style.fontSize = '12pt'; box.style.border = '0'; box.style.padding = '0'; box.style.opacity = '0';
    var ok = false;
    try {
      document.body.appendChild(box);
      box.select();
      box.setSelectionRange(0, inviteLink.length);
      document.addEventListener('copy', filled);
      ok = document.execCommand('copy') === true;
    } catch (_) { ok = false; }
    document.removeEventListener('copy', filled);
    try { document.body.removeChild(box); } catch (_) {}
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    return ok;
  }
  function copyByClipboard(){
    var c = navigator.clipboard;
    var yes = function(){ return true; }, no = function(){ return false; };
    if (!c) return Promise.resolve(false); // plain http://: there is none
    var asText = function(){ return c.writeText ? c.writeText(inviteLink).then(yes, no) : Promise.resolve(false); };
    var Item = window.ClipboardItem;
    var bothForms = c.write && typeof Item === 'function' && !(Item.supports && !Item.supports('text/uri-list'));
    if (!bothForms) return asText();
    try {
      return c.write([new Item({
        'text/plain': new Blob([inviteLink], { type: 'text/plain' }),
        'text/uri-list': new Blob([inviteLink], { type: 'text/uri-list' })
      })]).then(yes, asText);
    } catch (_) { return asText(); }
  }
  var copyBtn = document.getElementById('copyBtn');
  // The button's words: English here, the iPhone's own below.
  var copyWord = { t: 'Copy code' }, copiedWord = { t: 'Copied ✓' };
  copyBtn.addEventListener('click', function(){
    copyInvite().then(function(ok){
      if (ok) {
        put(copyBtn, copiedWord);
        setTimeout(function(){ put(copyBtn, copyWord); }, 2000);
        return;
      }
      // Not copied: the code is selected, for the phone's own Copy.
      try { var r = document.createRange(); r.selectNode(codeEl);
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch(e){}
    });
  });

  // Open App button for existing installs (iPhone; on Android the main button opens the app itself)
  var openAppBtn = document.getElementById('openAppBtn');
  if (isIOS) {
    openAppBtn.style.display = 'block';
    openAppBtn.href = 'beanpool://' + appQuery;
    openAppBtn.addEventListener('click', function(){
      copyInvite().catch(function(){});
    });
  }

  // Platform-specific install CTA + steps
  var installBtn = document.getElementById('installBtn');
  var stepsEl = document.getElementById('steps');
  function step(n, title, note){
    var li = document.createElement('li'); li.className = 'step';
    var d = document.createElement('div'); d.className = 'n'; d.textContent = n;
    var t = document.createElement('div'); t.className = 't'; t.textContent = title;
    if (note){ var sm = document.createElement('small'); sm.textContent = note; t.appendChild(sm); }
    li.appendChild(d); li.appendChild(t); stepsEl.appendChild(li);
  }

  // The store badges are links in the page already (both, App Store first, each to its store: that is the page with no
  // script). Here they are pointed at this invite, and a phone is shown only its own store.
  var iosStore = document.getElementById('iosStore');
  var androidStore = document.getElementById('androidStore');
  iosStore.href = APP_STORE;
  androidStore.href = playUrl();

  if (isAndroid) {
    // App first: with BeanPool installed the invite opens in it; without, Google Play opens to install it, referrer and all.
    installBtn.style.display = 'block';
    installBtn.textContent = 'Open your invite in BeanPool';
    installBtn.href = androidAppUrl();
    installBtn.addEventListener('click', function(){ copyInvite().catch(function(){}); });
    // The plain store link (the Google Play badge), for a browser that can't open the app's link.
    iosStore.style.display = 'none';
    androidStore.addEventListener('click', function(){ copyInvite().catch(function(){}); });
    step('1', 'Tap Open your invite in BeanPool', 'If the app isn\\u2019t on this phone yet, Google Play opens to install it.');
    step('2', 'Your invite comes across in the app', 'Nothing to type and nothing to scan again.');
    step('3', 'Choose a callsign and you\\u2019re in');
  } else if (isIOS) {
    androidStore.style.display = 'none';
    // No install-referrer on iOS (DESIGN-ios-invite-paste-fable.md §4.2-4.3): one line over the App Store badge, one under
    // it, the second button, and the code card under them all. The badge's tap copies the link; until then nothing says
    // anything was copied, and after it only what happened.
    var installArea = document.getElementById('installArea');
    var codecard = document.getElementById('codecard');
    var lead = document.getElementById('iosLead');
    var note = document.getElementById('copyNote');
    var codeAt = document.getElementById('codeAt');
    stepsEl.style.display = 'none';
    put(lead, W.lead); lead.hidden = false;
    put(note, W.copies); note.hidden = false;
    put(openAppBtn, W.openFirst);
    put(document.getElementById('codeLabel'), W.codeLabel);
    copyWord = W.copy; copiedWord = { t: W.copied.t + ' ✓', lang: W.copied.lang, dir: W.copied.dir };
    put(copyBtn, copyWord);
    // The address the app asks for beside a typed code: the host on https, the whole origin on plain http.
    put(codeAt, { t: W.codeAt.t.split('{address}').join(location.protocol === 'https:' ? location.host : origin), lang: W.codeAt.lang, dir: W.codeAt.dir });
    codeAt.hidden = false;
    installArea.parentNode.insertBefore(codecard, installArea.nextSibling);

    // The store tap, kept for this tab (sessionStorage) so a page iOS reloads on the way back still knows it.
    var KEPT = 'beanpool-invite-store-tap';
    var tapped = false, back = false;
    function keep(copy){ try { window.sessionStorage.setItem(KEPT, JSON.stringify({ code: code, copy: copy })); } catch (_) {} }
    function failed(){ note.className = 'copynote warn'; put(note, W.notCopied); }
    // Back from the store: the button that carries the invite itself goes on top, solid. It works with or without the copy.
    function cameBack(){
      if (!tapped || back) return;
      back = true;
      installArea.insertBefore(openAppBtn, installArea.firstChild);
      openAppBtn.className = 'cta';
      openAppBtn.style.marginTop = '0';
      put(openAppBtn, W.openBack);
    }
    iosStore.addEventListener('click', function(){
      tapped = true;
      keep('pending');
      copyInvite().then(function(ok){
        keep(ok ? 'copied' : 'failed');
        if (!ok) failed();
      });
    });
    document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible') cameBack(); });
    window.addEventListener('pageshow', cameBack);
    try {
      var kept = JSON.parse(window.sessionStorage.getItem(KEPT) || 'null');
      if (kept && kept.code === code) {
        tapped = true;
        if (kept.copy === 'failed') failed();
        cameBack();
      }
    } catch (_) {}
  } else {
    // Desktop / unknown — both stores stay, plus a nudge to use a phone.
    document.getElementById('desktopNote').classList.add('show');
  }

  // Read-only preflight — greet with the community name and stop a dud code
  // BEFORE the user installs. Never consumes the invite. Fails open.
  if (code) {
    fetch(origin + '/api/invite/check?code=' + encodeURIComponent(code))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){
        if (!data) return;
        if (data.communityName) document.getElementById('community').textContent = data.communityName;
        if (data.valid === false) {
          var b = document.getElementById('banner');
          b.className = 'banner bad show';
          b.textContent = data.reason === 'used'
            ? 'This invite has already been used — each one works once. Ask whoever invited you for a fresh link.'
            : data.reason === 'expired'
              ? 'This invite has expired — invites last 30 days. Ask whoever invited you for a fresh link.'
              : "This invite code wasn't recognised. Ask whoever invited you for a fresh link.";
          document.getElementById('installArea').style.display = 'none';
        }
      })
      .catch(function(){});
  }

  // Escape hatch — shown ONLY on nodes where the web PWA is enabled. It routes
  // to /app?invite=...&webjoin=1, which is the ONLY path WelcomePage will redeem
  // on (see the webjoin gate). On headless nodes it is removed entirely.
  if (WEB_JOIN) {
    var modal = document.getElementById('modal');
    document.getElementById('hatch').addEventListener('click', function(e){ e.preventDefault(); modal.classList.add('open'); });
    document.getElementById('cancelWeb').addEventListener('click', function(){ modal.classList.remove('open'); });
    document.getElementById('proceedWeb').addEventListener('click', function(){
      location.href = '/app?invite=' + encodeURIComponent(code) + '&webjoin=1' + (post ? '&post=' + post : '');
    });
    modal.addEventListener('click', function(e){ if (e.target === modal) modal.classList.remove('open'); });
  } else {
    var hw = document.getElementById('hatchWrap'); if (hw) hw.style.display = 'none';
    var md = document.getElementById('modal'); if (md && md.parentNode) md.parentNode.removeChild(md);
  }
})();
</script>
</body>
</html>`;
}
