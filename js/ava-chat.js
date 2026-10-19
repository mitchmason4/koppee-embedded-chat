/*
 * Koppee embedded AVA chat.
 * Talks to the same Genesys Cloud Messenger deployment as the stock widget, but over the
 * Web Messaging guest WebSocket API so the UI lives directly in the page.
 *
 * Domain for the WebSocket: use1 -> mypurecloud.com (change for other regions, e.g. usw2 -> usw2.pure.cloud).
 */
(function () {
    'use strict';

    var CONFIG = {
        deploymentId: 'YOUR_DEPLOYMENT_ID',
        domain: 'mypurecloud.com',
        heartbeatMs: 25000,
        welcomeOnOpen: true            // send a Presence Join so the flow's greeting fires (same as Messenger auto-start)
    };

    var root = document.getElementById('ava-chat');
    if (!root) return;

    var els = {
        log: root.querySelector('.ava-chat__log'),
        form: root.querySelector('.ava-chat__form'),
        input: root.querySelector('.ava-chat__input'),
        send: root.querySelector('.ava-chat__send'),
        status: root.querySelector('.ava-chat__status'),
        close: root.querySelector('.ava-chat__close')
    };

    var ws = null, token = null, heartbeat = null, ready = false, joined = false;
    var queue = [], typingEl = null, repliesEl = null, retries = 0, seen = {};

    /* ---------- helpers ---------- */
    function uuid() {
        return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
            });
    }
    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function format(text) {   // escape first, then allow *bold*, _italic_ and links
        return escapeHtml(text)
            .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
            .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1<em>$2</em>')
            .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    }
    function setStatus(t) { els.status.textContent = t; }
    function scroll() { els.log.scrollTop = els.log.scrollHeight; }

    function open() {
        if (!root.classList.contains('is-open')) root.classList.add('is-open');
        if (!ws) connect();
    }
    function collapse() { root.classList.remove('is-open'); }

    /* ---------- rendering ---------- */
    function clearReplies() { if (repliesEl) { repliesEl.remove(); repliesEl = null; } }
    function addMessage(kind, text) {
        hideTyping();
        var row = document.createElement('div');
        row.className = 'ava-msg ava-msg--' + kind;
        if (kind === 'bot') row.appendChild(avatar());
        var b = document.createElement('div');
        b.className = 'ava-msg__bubble';
        b.innerHTML = format(text);
        row.appendChild(b);
        els.log.appendChild(row);
        scroll();
    }
    function avatar() {
        var a = document.createElement('div');
        a.className = 'ava-msg__avatar';
        a.innerHTML = '<i class="fa fa-coffee"></i>';
        return a;
    }
    function showTyping() {
        if (typingEl) return;
        typingEl = document.createElement('div');
        typingEl.className = 'ava-msg ava-msg--bot ava-typing';
        typingEl.appendChild(avatar());
        typingEl.insertAdjacentHTML('beforeend', '<div class="ava-msg__bubble"><span></span><span></span><span></span></div>');
        els.log.appendChild(typingEl);
        scroll();
    }
    function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }
    function showReplies(list) {
        clearReplies();
        repliesEl = document.createElement('div');
        repliesEl.className = 'ava-chat__replies';
        list.forEach(function (q) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = q.text;
            btn.addEventListener('click', function () { sendText(q.text, q.payload || q.text); });
            repliesEl.appendChild(btn);
        });
        els.log.appendChild(repliesEl);
        scroll();
    }

    /* ---------- socket ---------- */
    function sendRaw(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    }
    function sendMessage(message) {
        if (!ready) { queue.push(message); return; }
        sendRaw({ action: 'onMessage', token: token, message: message });
    }

    function connect() {
        token = sessionStorage.getItem('koppeeAvaToken');
        var fresh = !token;
        if (fresh) { token = uuid(); sessionStorage.setItem('koppeeAvaToken', token); }
        setStatus('Connecting…');
        ws = new WebSocket('wss://webmessaging.' + CONFIG.domain + '/v1?deploymentId=' + CONFIG.deploymentId);

        ws.onopen = function () {
            sendRaw({ action: 'configureSession', deploymentId: CONFIG.deploymentId, token: token });
        };
        ws.onmessage = function (evt) {
            var data; try { data = JSON.parse(evt.data); } catch (e) { return; }
            handle(data);
        };
        ws.onclose = function () {
            ready = false; clearInterval(heartbeat); ws = null; hideTyping();
            setStatus('Disconnected');
            if (root.classList.contains('is-open') && retries < 3) {
                retries++;
                setTimeout(connect, 1500 * retries);
            }
        };
        ws.onerror = function () { setStatus('Connection error'); };
    }

    function handle(data) {
        if (data.type === 'response' && data.class === 'SessionResponse') {
            if (!data.body.connected) { setStatus('Unavailable'); return; }
            ready = true; retries = 0;
            setStatus('Online');
            heartbeat = setInterval(function () {
                sendRaw({ action: 'echo', message: { type: 'Text', text: 'ping' } });
            }, CONFIG.heartbeatMs);
            if (CONFIG.welcomeOnOpen && !joined && data.body.newSession !== false) {
                joined = true;
                sendMessage({ type: 'Event', events: [{ eventType: 'Presence', presence: { type: 'Join' } }] });
                showTyping();
            }
            queue.splice(0).forEach(sendMessage);
            return;
        }
        if (data.type === 'response' && data.class === 'string' && data.code === 429) {
            addMessage('system', 'Too many messages — please slow down.');
            return;
        }
        if (data.type === 'message' && data.class === 'StructuredMessage') {
            var b = data.body;
            if (b.direction !== 'Outbound') return;          // ignore echoes of our own messages
            if (b.id && seen[b.id]) return;
            if (b.id) seen[b.id] = 1;

            if (b.type === 'Event' || (b.events && !b.text)) {
                (b.events || []).forEach(function (ev) {
                    if (ev.eventType === 'Typing') {
                        if (ev.typing && ev.typing.type === 'On') showTyping(); else hideTyping();
                    }
                    if (ev.eventType === 'Presence' && ev.presence && ev.presence.type === 'Disconnect') {
                        addMessage('system', 'The conversation has ended.');
                        sessionStorage.removeItem('koppeeAvaToken'); joined = false;
                    }
                });
                return;
            }
            if (b.text) addMessage('bot', b.text);
            var replies = (b.content || []).filter(function (c) { return c.contentType === 'QuickReply'; })
                .map(function (c) { return c.quickReply; });
            if (replies.length) showReplies(replies);
        }
    }

    /* ---------- sending ---------- */
    function sendText(text, payload) {
        text = (text || '').trim();
        if (!text) return;
        open();
        clearReplies();
        addMessage('user', text);
        var msg = { type: 'Text', text: text };
        if (payload) msg.content = [{ contentType: 'ButtonResponse', buttonResponse: { text: text, payload: payload, type: 'QuickReply' } }];
        sendMessage(msg);
        showTyping();
    }

    /* ---------- wiring ---------- */
    els.form.addEventListener('submit', function (e) {
        e.preventDefault();
        var t = els.input.value;
        els.input.value = '';
        sendText(t);
    });
    els.input.addEventListener('focus', open);
    els.close.addEventListener('click', collapse);

    // suggestion chips under the bar
    Array.prototype.forEach.call(document.querySelectorAll('.ava-chat__chips button'), function (b) {
        b.addEventListener('click', function () { sendText(b.textContent); });
    });

    // rotating "typed" placeholder until the visitor interacts
    var prompts = ['Where\u2019s my order?', 'Change my subscription\u2026', 'Best beans for cold brew?',
        'How do I brew the perfect cup?', 'What grind do I need?'];
    var pi = 0, ci = 0, typingTimer = null;
    function typePlaceholder() {
        if (document.activeElement === els.input || els.input.value || root.classList.contains('is-open')) {
            els.input.placeholder = 'Ask Koppee anything\u2026'; return;
        }
        var full = prompts[pi];
        ci++;
        els.input.placeholder = 'Ask Koppee: ' + full.slice(0, ci) + (ci < full.length ? '|' : '');
        if (ci < full.length) { typingTimer = setTimeout(typePlaceholder, 55); }
        else { pi = (pi + 1) % prompts.length; ci = 0; typingTimer = setTimeout(typePlaceholder, 2200); }
    }
    if (!window.matchMedia || !matchMedia('(prefers-reduced-motion: reduce)').matches) typePlaceholder();
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') collapse(); });
})();
