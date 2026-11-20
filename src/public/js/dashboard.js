// Dashboard behavior: profile menu, copy buttons, QR, confirm dialog, password change, live usage.
(function () {
  'use strict';

  var $ = function (selector) {
    return document.querySelector(selector);
  };
  var panelPath = $('#panel-path').value;
  var csrf = $('#csrf-token').value;

  // ----- Profile menu -----
  var dropdown = $('#profile-dropdown');
  var overlay = $('#profile-menu-overlay');
  var trigger = $('#profile-trigger-btn');

  function setMenu(open) {
    dropdown.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  trigger.addEventListener('click', function () {
    setMenu(!dropdown.classList.contains('open'));
  });
  document.addEventListener('click', function (e) {
    if (!$('#profile-menu').contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setMenu(false);
  });

  // ----- Dialogs -----
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (dialog) {
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog || (e.target.hasAttribute && e.target.hasAttribute('data-close'))) dialog.close();
    });
  });

  // ----- Copy -----
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return false; }
      );
    }
    return new Promise(function (resolve) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'absolute';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* ignored */ }
      area.remove();
      resolve(ok);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (button) {
    var idle = button.textContent;
    var timer;
    button.addEventListener('click', function () {
      copyText(button.getAttribute('data-copy')).then(function (ok) {
        button.textContent = ok ? 'Copied' : 'Copy failed';
        clearTimeout(timer);
        timer = setTimeout(function () { button.textContent = idle; }, 1800);
      });
    });
  });

  // ----- QR code -----
  var qrButton = $('#open-qr');
  if (qrButton) {
    qrButton.addEventListener('click', function () {
      try {
        $('#qr-img').innerHTML = qrSvg(qrButton.getAttribute('data-link'));
      } catch (e) {
        $('#qr-img').textContent = 'This link is too long for a QR code.';
      }
      $('#qr-modal').showModal();
    });
  }

  // ----- Confirm before regenerating -----
  var pending = null;
  Array.prototype.forEach.call(document.querySelectorAll('[data-confirm]'), function (button) {
    button.addEventListener('click', function (e) {
      e.preventDefault();
      pending = button;
      $('#confirm-text').textContent = button.getAttribute('data-confirm');
      $('#confirm-modal').showModal();
    });
  });
  $('#confirm-ok').addEventListener('click', function () {
    if (!pending) return;
    var form = pending.form;
    var field = document.createElement('input');
    field.type = 'hidden';
    field.name = pending.name;
    field.value = pending.value;
    form.appendChild(field);
    form.submit();
  });

  // ----- Change password -----
  $('#open-password').addEventListener('click', function () {
    setMenu(false);
    $('#password-error').hidden = true;
    $('#current-password').value = '';
    $('#new-password').value = '';
    $('#password-modal').showModal();
  });
  $('#password-save').addEventListener('click', function () {
    var error = $('#password-error');
    fetch(panelPath + '/settings/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _csrf: csrf,
        currentPassword: $('#current-password').value,
        newPassword: $('#new-password').value
      })
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (result.ok) {
          $('#password-modal').close();
          return;
        }
        error.textContent = result.body.error || 'Could not change the password.';
        error.hidden = false;
      })
      .catch(function () {
        error.textContent = 'Network error. Try again.';
        error.hidden = false;
      });
  });

  // ----- Live usage -----
  function formatBytes(n) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(2)) + ' ' + units[i];
  }
  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  // Rebuilds the per-client table. Cells are filled with textContent, so IPs are never parsed as HTML.
  function renderClients(clients) {
    var body = document.getElementById('u-clients');
    if (!body) return;
    body.textContent = '';
    if (!clients.length) {
      var empty = body.insertRow();
      var cell = empty.insertCell();
      cell.colSpan = 4;
      cell.className = 'muted';
      cell.textContent = 'No clients yet.';
      return;
    }
    clients.forEach(function (client) {
      var row = body.insertRow();
      var ip = document.createElement('code');
      ip.textContent = client.ip;
      var wrap = document.createElement('span'); // keeps the flag and the IP on one line
      wrap.className = 'client';
      row.insertCell().appendChild(wrap);
      if (client.country) {
        var flag = document.createElement('img');
        flag.className = 'flag';
        flag.src = panelPath + '/flags/' + client.country.toLowerCase() + '.svg';
        flag.alt = client.country;
        flag.title = client.country;
        flag.width = 24;
        flag.height = 18;
        wrap.appendChild(flag);
      }
      wrap.appendChild(ip);
      row.insertCell().textContent = formatBytes(client.up);
      row.insertCell().textContent = formatBytes(client.down);
      row.insertCell().textContent = client.connections;
    });
  }
  function refreshUsage() {
    fetch(panelPath + '/api/stats', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        setText('u-live', data.live);
        Object.keys(data.modes).forEach(function (mode) {
          setText('u-' + mode + '-up', formatBytes(data.modes[mode].up));
          setText('u-' + mode + '-down', formatBytes(data.modes[mode].down));
          setText('u-' + mode + '-connections', data.modes[mode].connections);
        });
        setText('u-total-up', formatBytes(data.total.up));
        setText('u-total-down', formatBytes(data.total.down));
        setText('u-total-connections', data.total.connections);
        renderClients(data.clients || []);
      })
      .catch(function () { /* ignored: the next poll retries */ });
  }
  setInterval(function () {
    if (!document.hidden) refreshUsage();
  }, 5000);
})();
