'use strict';
const { types } = require('node:util');
const policy = require('./policy.cjs');
const unavailable = () => { throw new Error('Native handoff is unavailable.'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const choice = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Bind human handoff intents to the current window, main frame and project epoch. */
function installNativeHandoffIpc(ipcMain, { getSession, host }) {
  function scope(event) {
    const session = getSession(), window = session?.window, contents = window?.webContents, frame = event?.senderFrame;
    if (!session || !window || window.isDestroyed() || !contents || contents.isDestroyed() || event.sender !== contents ||
        !frame || frame !== contents.mainFrame || !policy.validOrigin(session.origin) ||
        !policy.navigationAllowed(session.origin, frame.url) || new URL(frame.url).href !== frame.url ||
        session.epoch === null || session.epoch === undefined) unavailable();
    return { window, contents, frame, url: frame.url, origin: session.origin, epoch: session.epoch };
  }
  for (const action of ['launch', 'list', 'revoke']) ipcMain.handle('arcane:native-handoff-' + action, async (event, ...args) => {
    try {
      const before = scope(event);
      let input;
      if (action === 'list') { if (args.length) unavailable(); }
      else if (action === 'revoke') {
        if (args.length !== 1 || typeof args[0] !== 'string' || !uuid.test(args[0])) unavailable();
        input = args[0];
      } else {
        const value = args[0];
        if (args.length !== 1 || !value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
            Reflect.ownKeys(value).length !== 2) unavailable();
        const selected = {};
        for (const name of ['model', 'effort']) {
          const field = Object.getOwnPropertyDescriptor(value, name);
          if (!field?.enumerable || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || !choice.test(field.value)) unavailable();
          selected[name] = field.value;
        }
        input = Object.freeze(selected);
      }
      const response = action === 'list' ? await host.list() : await host[action](input);
      const after = scope(event);
      if (Object.keys(before).some(key => !Object.is(before[key], after[key]))) unavailable();
      return response;
    } catch { unavailable(); }
  });
}

module.exports = { installNativeHandoffIpc };
