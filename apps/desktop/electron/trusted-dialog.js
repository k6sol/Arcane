'use strict';
// Trusted Arcane decision window page (trusted-dialog.html). Reads its one question from the dedicated preload, renders it
// with textContent only, focuses the default button (Enter activates the focused button), keeps Tab inside the buttons,
// answers the cancel button on Esc, and answers exactly once. The host treats closing, a timeout or a crash as cancel.
(() => {
  const bridge = window.arcaneTrustedDialog;
  const root = document.getElementById('trusted-dialog'), title = document.getElementById('trusted-dialog-title');
  const body = document.getElementById('trusted-dialog-body'), actions = document.getElementById('trusted-dialog-actions');
  if (!bridge || !root || !title || !body || !actions) return;
  let request = null, done = false;
  const buttons = [];
  function answer(index) {
    if (done || !request) return;
    done = true;
    for (const button of buttons) button.disabled = true;
    bridge.answer(index).catch(() => { /* the host answers cancel on timeout or close */ });
  }
  function onKey(event) {
    if (done || !request) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answer(request.cancelId); return; }
    if (event.key === 'Tab' && buttons.length) {
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      const next = index < 0 ? request.defaultId : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }
  bridge.request().then(value => {
    request = value;
    root.dataset.type = value.type;
    if (value.type === 'warning' || value.type === 'error') root.setAttribute('role', 'alertdialog');
    title.textContent = value.title; document.title = value.title;
    if (value.message) { const p = document.createElement('p'); p.className = 'trusted-dialog-message'; p.textContent = value.message; body.append(p); }
    for (const part of value.detail.split(/\n{2,}/).map(text => text.trim()).filter(Boolean)) {
      const p = document.createElement('p'); p.className = 'trusted-dialog-detail'; p.textContent = part; body.append(p);
    }
    // The last button that is not the cancel button is the primary (red) action; the others stay quiet.
    let primary = -1;
    for (let i = value.buttons.length - 1; i >= 0; i--) if (i !== value.cancelId) { primary = i; break; }
    value.buttons.forEach((label, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.dataset.response = String(index);
      button.className = index === primary ? 'trusted-dialog-button trusted-dialog-primary' : 'trusted-dialog-button';
      if (index === value.defaultId) button.dataset.default = 'true';
      button.addEventListener('click', event => { if (event.isTrusted) answer(index); });
      buttons.push(button); actions.append(button);
    });
    root.hidden = false;
    document.addEventListener('keydown', onKey, true);
    (buttons[value.defaultId] ?? root).focus({ preventScroll: true });
    return bridge.ready(Math.ceil(document.documentElement.scrollHeight));
  }).catch(() => { /* nothing to show; the host times out to cancel */ });
  // Refocus the default button when the window regains focus with nothing focused.
  window.addEventListener('focus', () => { if (!done && request && !buttons.includes(document.activeElement)) (buttons[request.defaultId] ?? root).focus({ preventScroll: true }); });
})();
