/*
 * The person check at the 12-words door, on an origin of its own (see README.md). It runs Cloudflare's widget and hands
 * the result straight back. It says nothing itself, on purpose: Cloudflare's widget speaks the browser's language, and
 * everything else, "that didn't work" above all, is said by the app, in the member's language, beside the sign-in door.
 *
 * ES5 throughout, with nothing newer than an old Android WebView has: if this file doesn't run, nobody is told why.
 */
(function () {
    'use strict';

    // The only addresses a token may go to. Turnstile trusts this page's hostname, so a token sent anywhere else would
    // let any website have its visitors make tokens for it: that is why this is a list, in the source, and not a parameter.
    // Someone running their own copy of this page lists their own node here.
    var RETURN_ORIGINS = ['https://global.beanpool.org', 'https://test.beanpool.org'];
    var RETURN_PATH = '/app/auth/check';
    var ACTION = 'join';
    var WAIT_FOR_WIDGET_MS = 15000;

    function fields(hash) {
        var out = {};
        var parts = hash.replace(/^#/, '').split('&');
        for (var i = 0; i < parts.length; i++) {
            var at = parts[i].indexOf('=');
            if (at < 1) continue;
            try { out[parts[i].slice(0, at)] = decodeURIComponent(parts[i].slice(at + 1)); } catch (e) { /* not ours */ }
        }
        return out;
    }

    var asked = fields(window.location.hash);
    var embedded = !!(window.ReactNativeWebView && window.ReactNativeWebView.postMessage);
    var returnsTo = RETURN_ORIGINS.indexOf(asked['return']) !== -1 ? asked['return'] : null;

    if (asked.theme === 'dark' || asked.theme === 'light') document.documentElement.className = asked.theme;

    // Nothing here is a secret, but nothing here is anyone's to change either: no way back, no widget.
    if (!asked.sitekey || !/^[0-9a-f]{32}$/.test(asked.cdata || '') || (!embedded && !returnsTo)) return;

    var over = false;
    function finish(result) {
        if (over) return;
        over = true;
        if (embedded) {
            window.ReactNativeWebView.postMessage(JSON.stringify(result));
            return;
        }
        var key = result.token ? 'token' : 'error';
        window.location.replace(returnsTo + RETURN_PATH + '#' + key + '=' + encodeURIComponent(result.token || result.error));
    }

    if (!embedded) {
        var back = document.getElementById('back');
        back.hidden = false;
        back.onclick = function () { finish({ error: 'closed' }); return false; };
    }

    var waiting = setTimeout(function () { finish({ error: 'wont_load' }); }, WAIT_FOR_WIDGET_MS);

    window.onDoorCheckReady = function () {
        clearTimeout(waiting);
        try {
            window.turnstile.render('#widget', {
                sitekey: asked.sitekey,
                action: ACTION,
                cData: asked.cdata,
                theme: asked.theme === 'dark' || asked.theme === 'light' ? asked.theme : 'auto',
                size: window.innerWidth >= 320 ? 'flexible' : 'compact',
                retry: 'never',
                callback: function (token) { finish({ token: token }); },
                'error-callback': function () { finish({ error: 'failed' }); return true; },
                'expired-callback': function () { finish({ error: 'failed' }); },
                'timeout-callback': function () { finish({ error: 'failed' }); },
                'unsupported-callback': function () { finish({ error: 'wont_load' }); }
            });
            if (embedded) window.ReactNativeWebView.postMessage(JSON.stringify({ ready: true }));
        } catch (e) {
            finish({ error: 'wont_load' });
        }
    };

    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onDoorCheckReady';
    script.async = true;
    script.onerror = function () { finish({ error: 'wont_load' }); };
    document.head.appendChild(script);
}());
