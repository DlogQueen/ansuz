/* Receptionist console.
 *
 * A read-only window onto a running receptionist server. It holds no logic of
 * its own about how calls are handled — it asks /api/console/* and renders the
 * answer. Anything it cannot show, it says why rather than showing an empty
 * screen, because "no calls yet" and "your token is wrong" look identical
 * otherwise and only one of them is your fault.
 */
(function () {
  'use strict';

  var KEY = 'bm.receptionist.config';

  function loadConfig() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveConfig(c) {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* private mode */ }
  }

  var cfg = loadConfig();

  // --- helpers -------------------------------------------------------------

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** E.164 is unreadable at a glance; group US numbers, leave others alone. */
  function phone(p) {
    if (!p) return 'Unknown number';
    var m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
    return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : p;
  }

  function when(iso, tz) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var opts = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
    if (tz) opts.timeZone = tz;
    try { return d.toLocaleString(undefined, opts); } catch (e) { return d.toLocaleString(); }
  }

  function ago(iso) {
    if (!iso) return '';
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (isNaN(mins)) return '';
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    if (mins < 1440) return Math.round(mins / 60) + 'h';
    return Math.round(mins / 1440) + 'd';
  }

  function empty(title, detail) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' + esc(detail || '') + '</div>';
  }

  function configured() {
    return Boolean(cfg.url && cfg.token && cfg.slug);
  }

  var NOT_SET = empty(
    'Not connected yet',
    'Open Setup and enter your server address, console token and business.'
  );

  // --- api -----------------------------------------------------------------

  function api(route, params) {
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var qs = Object.keys(params || {})
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    var url = base + '/api/console/' + route + (qs ? '?' + qs : '');

    return fetch(url, {
      headers: { Authorization: 'Bearer ' + cfg.token },
      cache: 'no-store',
    }).then(function (r) {
      return r.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) { body = null; }
        if (r.ok) return body;

        // Turn the codes into something a person can act on. A 401 here almost
        // always means the token, not the account.
        var msg =
          r.status === 401 ? 'The server rejected the token. Check it matches RECEPTIONIST_CONSOLE_TOKEN exactly.'
          : r.status === 404 ? ((body && body.error) || 'Not found — check the business name.')
          : r.status === 0 ? 'Could not reach the server.'
          : (body && body.error) || ('Server returned ' + r.status + '.');
        var err = new Error(msg);
        err.status = r.status;
        throw err;
      });
    }, function () {
      throw new Error('Could not reach ' + base + '. Check the address and that the server is running.');
    });
  }

  // --- views ---------------------------------------------------------------

  function renderToday() {
    var box = el('today-body');
    if (!configured()) { box.innerHTML = NOT_SET; return; }
    box.innerHTML = empty('Loading…', '');

    api('summary', { business: cfg.slug }).then(function (d) {
      var p = d.performance || {};
      var tz = d.business && d.business.timezone;
      var html = '';

      html += '<div class="tiles">' +
        tile(p.calls, 'calls') +
        tile(p.booked, 'booked') +
        tile(p.messages_taken, 'messages') +
        tile(p.escalated, 'escalated', p.escalated > 0) +
        '</div>';

      if (d.unhandled_messages > 0) {
        html += '<div class="note crit"><span class="lbl">Waiting on you</span><p>' +
          d.unhandled_messages + ' message' + (d.unhandled_messages === 1 ? '' : 's') +
          ' nobody has handled yet. They are under Calls.</p></div>';
      }

      var next = d.next_appointments || [];
      html += '<h3 style="margin:8px 0 0;font-size:15px">Next up</h3>';
      html += next.length
        ? next.map(function (a) { return apptRow(a, tz); }).join('')
        : empty('Nothing booked', 'Appointments the receptionist books will appear here.');

      if (d.business && d.business.status === 'paused') {
        html += '<div class="note amber"><span class="lbl">Paused</span><p>' +
          esc(d.business.name) + ' is set to paused, so the receptionist is not answering.</p></div>';
      }

      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorBlock(e); });
  }

  function tile(n, k, flag) {
    return '<div class="tile' + (flag ? ' flag' : '') + '"><span class="n">' +
      (n == null ? '—' : n) + '</span><span class="k">' + esc(k) + '</span></div>';
  }

  function apptRow(a, tz) {
    return '<div class="row"><div class="top">' +
      '<span class="who">' + esc(a.caller_name || phone(a.caller_phone)) + '</span>' +
      '<span class="when">' + esc(when(a.starts_at, tz)) + '</span>' +
      '</div>' +
      (a.purpose ? '<p class="sub">' + esc(a.purpose) + '</p>' : '') +
      (a.caller_name && a.caller_phone ? '<p class="sub">' + esc(phone(a.caller_phone)) + '</p>' : '') +
      '</div>';
  }

  function renderCalls() {
    var box = el('calls-body');
    if (!configured()) { box.innerHTML = NOT_SET; return; }
    box.innerHTML = empty('Loading…', '');

    Promise.all([
      api('calls', { business: cfg.slug, limit: 25 }),
      api('messages', { business: cfg.slug }),
    ]).then(function (res) {
      var calls = res[0].calls || [];
      var msgs = res[1].messages || [];
      var html = '';

      if (msgs.length) {
        html += '<h3 style="margin:0;font-size:15px">Messages for you</h3>';
        html += msgs.map(function (m) {
          return '<div class="row"><div class="top">' +
            '<span class="who">' + esc(m.caller_name || phone(m.caller_phone)) + '</span>' +
            (m.urgency === 'urgent' ? '<span class="pill bad">urgent</span>' : '') +
            '<span class="when">' + esc(ago(m.created_at)) + '</span>' +
            '</div><p class="sub">' + esc(m.message) + '</p></div>';
        }).join('');
      }

      html += '<h3 style="margin:8px 0 0;font-size:15px">Recent calls</h3>';
      html += calls.length
        ? calls.map(callRow).join('')
        : empty('No calls yet', 'Every call will appear here with its full transcript.');

      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorBlock(e); });
  }

  var OUTCOME = {
    booked: ['good', 'booked'],
    message_taken: ['', 'message'],
    escalated: ['warn', 'escalated'],
    transferred: ['warn', 'transferred'],
    abandoned: ['bad', 'abandoned'],
    in_progress: ['', 'in progress'],
  };

  function callRow(c) {
    var o = OUTCOME[c.outcome] || ['', String(c.outcome || 'unknown')];
    var turns = Array.isArray(c.transcript) ? c.transcript : [];

    return '<details class="row call"><summary><div class="top">' +
      '<span class="who">' + esc(phone(c.from_number)) + '</span>' +
      '<span class="pill ' + o[0] + '">' + esc(o[1]) + '</span>' +
      '<span class="when">' + esc(ago(c.created_at)) + '</span>' +
      '</div>' +
      (c.escalation_reason ? '<p class="sub">' + esc(c.escalation_reason) + '</p>' : '') +
      '<p class="sub">' + turns.length + ' turn' + (turns.length === 1 ? '' : 's') +
      (turns.length ? ' · tap to read' : '') + '</p>' +
      '</summary>' +
      (turns.length
        ? '<div class="turns">' + turns.map(function (t) {
            return '<div class="turn ' + esc(t.role) + '"><span class="lbl">' +
              esc(t.role) + '</span>' + esc(t.text) + '</div>';
          }).join('') + '</div>'
        : '') +
      '</details>';
  }

  function renderDiary() {
    var box = el('diary-body');
    if (!configured()) { box.innerHTML = NOT_SET; return; }
    box.innerHTML = empty('Loading…', '');

    Promise.all([
      api('appointments', { business: cfg.slug }),
      api('summary', { business: cfg.slug }),
    ]).then(function (res) {
      var appts = res[0].appointments || [];
      var tz = res[1].business && res[1].business.timezone;
      if (!appts.length) {
        box.innerHTML = empty('Nothing booked', 'Upcoming appointments will appear here.');
        return;
      }

      // Group by local day so a week reads as days rather than one long list.
      var groups = {};
      var order = [];
      appts.forEach(function (a) {
        var d = new Date(a.starts_at);
        var opts = { weekday: 'long', month: 'short', day: 'numeric' };
        if (tz) opts.timeZone = tz;
        var label;
        try { label = d.toLocaleDateString(undefined, opts); } catch (e) { label = d.toDateString(); }
        if (!groups[label]) { groups[label] = []; order.push(label); }
        groups[label].push(a);
      });

      box.innerHTML = order.map(function (label) {
        return '<h3 style="margin:8px 0 0;font-size:15px">' + esc(label) + '</h3>' +
          groups[label].map(function (a) { return apptRow(a, tz); }).join('');
      }).join('');
    }).catch(function (e) { box.innerHTML = errorBlock(e); });
  }

  function errorBlock(e) {
    return '<div class="note crit"><span class="lbl">Couldn\'t load</span><p>' +
      esc(e && e.message ? e.message : String(e)) + '</p></div>';
  }

  // --- setup ---------------------------------------------------------------

  function fillSetup() {
    el('f-url').value = cfg.url || '';
    el('f-token').value = cfg.token || '';
    el('f-slug').value = cfg.slug || '';
  }

  el('save').addEventListener('click', function () {
    var out = el('setup-result');
    var next = {
      url: el('f-url').value.trim(),
      token: el('f-token').value.trim(),
      slug: el('f-slug').value.trim(),
    };
    if (!next.url || !next.token) {
      out.innerHTML = errorBlock(new Error('Server address and token are both required.'));
      return;
    }
    if (!/^https:\/\//i.test(next.url) && !/^http:\/\/localhost/i.test(next.url)) {
      out.innerHTML = errorBlock(new Error(
        'Use an https:// address. Sending this token over plain http would expose it.'
      ));
      return;
    }

    cfg = next;
    saveConfig(cfg);
    out.innerHTML = empty('Testing…', '');

    api('ping').then(function (d) {
      var list = (d.businesses || []).map(function (b) { return b.slug; });
      var known = !cfg.slug || list.indexOf(cfg.slug) !== -1;
      out.innerHTML =
        '<div class="note"><span class="lbl">Connected</span><p>' +
        (list.length ? 'Businesses on this server: ' + esc(list.join(', ')) + '.' : 'No businesses set up yet on this server.') +
        (known ? '' : ' <strong>"' + esc(cfg.slug) + '" is not one of them</strong> — check the spelling.') +
        '</p></div>';
      refresh();
    }).catch(function (e) { out.innerHTML = errorBlock(e); });
  });

  el('forget').addEventListener('click', function () {
    cfg = {};
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    fillSetup();
    el('setup-result').innerHTML = '<div class="note"><span class="lbl">Cleared</span>' +
      '<p>The token is no longer on this phone.</p></div>';
    refresh();
  });

  // --- tabs + refresh ------------------------------------------------------

  var current = 'today';

  function show(view) {
    current = view;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.setAttribute('aria-selected', String(t.dataset.view === view));
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (s) {
      s.hidden = s.dataset.view !== view;
    });
    refresh();
  }

  function refresh() {
    if (current === 'today') renderToday();
    else if (current === 'calls') renderCalls();
    else if (current === 'diary') renderDiary();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { show(t.dataset.view); });
  });

  el('refresh').addEventListener('click', function () {
    var b = el('refresh');
    b.classList.add('spin');
    refresh();
    setTimeout(function () { b.classList.remove('spin'); }, 600);
  });

  // Coming back to the app should show current data, not what was on screen
  // when it was backgrounded.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });

  fillSetup();
  show(configured() ? 'today' : 'setup');
})();
