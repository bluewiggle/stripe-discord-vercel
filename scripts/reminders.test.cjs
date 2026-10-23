const assert = require('node:assert/strict');
const { test } = require('node:test');
const { load } = require('./test-helper.cjs');
const { checkoutSchedule } = load('lib/checkout-date.ts');
const { reminderMessage } = load('lib/discord-messages.ts');
const { REMINDER_CHANNEL_ID, REMINDER_GUILD_ID } = load('lib/reminder-destination.ts');

test('checkout date schedules 10 am Sydney two calendar days later across both DST transitions', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(new Date(checkoutSchedule('02/10/2026', now).reminderAt).toISOString(), '2026-10-03T23:00:00.000Z');
  assert.equal(new Date(checkoutSchedule('2026-04-03', now).reminderAt).toISOString(), '2026-04-05T00:00:00.000Z');
  assert.equal(new Date(checkoutSchedule('30/12/2026', now).reminderAt).toISOString(), '2026-12-31T23:00:00.000Z');
  assert.equal(checkoutSchedule('28/02/2028', now).checkoutDate, '2028-02-28');
  for (const date of ['31/02/2026', '29/02/2026', '10/28/2026', 'tomorrow', '', '2026-13-01']) {
    assert.throws(() => checkoutSchedule(date, now), /valid checkout date/);
  }
  // Sydney is already on 2 January at this UTC instant.
  assert.throws(() => checkoutSchedule('01/01/2026', Date.parse('2026-01-01T14:00:00Z')), /before today/);
});

const record = () => ({ paymentIntentId: 'pi_example', amount: 300, note: 'John @everyone',
  createdBy: '123', channelId: '456', guildId: REMINDER_GUILD_ID, checkoutDate: '2026-10-28', reminderAt: 1000, createdAt: 1 });

test('reminder mentions only its creator and contains release/capture actions', () => {
  const message = reminderMessage(record());
  assert.match(message.content, /^<@123>/);
  assert.deepEqual(JSON.parse(JSON.stringify(message.allowed_mentions)), { parse: [], users: ['123'] });
  assert.equal(message.components[0].components[0].custom_id, 'hold:release:pi_example');
  assert.equal(message.components[0].components[1].custom_id, 'hold:capture:pi_example');
  assert.equal(message.nonce, reminderMessage(record()).nonce);
  assert.equal(message.enforce_nonce, true);
});

function workerHarness(status = 'requires_capture', sendError = false) {
  let hold = record(), locked = false, queued = true;
  const sent = [], removed = [], retry = [];
  const store = {
    listDueReminderIds: async () => queued ? ['pi_example'] : [],
    acquireHoldLock: async () => { if (locked) return null; locked = true; return 'lock'; },
    releaseHoldLock: async () => { locked = false; },
    getHold: async () => hold,
    clearReminderQueue: async () => { queued = false; },
    removeHold: async id => { removed.push(id); queued = false; hold = null; },
    markReminderSent: async (_, id, channel) => { hold.reminderMessageId = id; hold.reminderChannelId = channel; queued = false; },
    retryReminderLater: async id => retry.push(id),
  };
  const stripe = { paymentIntents: { retrieve: async () => ({ status }) } };
  const { sendDueReminders } = load('lib/hold-reminders.ts', {
    './holds': store,
    './discord-messages': { reminderMessage, closeReminder: async () => {}, discordRequest: async (...args) => {
      if (sendError) throw new Error('Discord temporarily unavailable');
      sent.push(args); return { id: 'message1' };
    } },
  });
  return { run: now => sendDueReminders(stripe, now ?? 2000), sent, removed, retry, setHold: value => { hold = value; }, store };
}

test('overlapping cron runs and repeated runs send exactly one reminder', async () => {
  const h = workerHarness();
  await Promise.all([h.run(), h.run()]);
  await h.run();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], `/channels/${REMINDER_CHANNEL_ID}/messages`);
  assert.equal((await h.store.getHold()).reminderChannelId, REMINDER_CHANNEL_ID);
  assert.equal((await h.store.getHold()).channelId, '456');
});

test('holds from a different server never send into the central channel', async () => {
  const h = workerHarness();
  h.setHold({ ...record(), guildId: 'other-server' });
  assert.equal((await h.run()).failed, 1);
  assert.equal(h.sent.length, 0);
});

test('resolved reminders edit their actual destination and support older messages', async () => {
  const calls = [];
  const { closeReminder } = load('lib/discord-messages.ts', {}, {
    process: { env: { DISCORD_BOT_TOKEN: 'fake' } },
    fetch: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return new Response('{}'); },
  });
  const hold = { ...record(), reminderMessageId: 'message1' };
  await closeReminder({ ...hold, reminderChannelId: REMINDER_CHANNEL_ID }, 'released');
  await closeReminder(hold, 'released');
  assert.equal(calls[0][0], `https://discord.com/api/v10/channels/${REMINDER_CHANNEL_ID}/messages/message1`);
  assert.equal(calls[1][0], 'https://discord.com/api/v10/channels/456/messages/message1');
  assert.equal(calls[0][1].components.length, 0);
});

test('old reminder buttons remain valid in their original channel', () => {
  const { matchesReminder } = load('lib/hold-actions.ts', { './holds': {}, './discord-messages': {} });
  const hold = { ...record(), reminderMessageId: 'message1' };
  assert.equal(matchesReminder(hold, { channelId: '456', guildId: REMINDER_GUILD_ID, messageId: 'message1' }), true);
});

test('released, captured, and expired/cancelled holds are not notified', async () => {
  for (const status of ['canceled', 'succeeded', 'processing']) {
    const h = workerHarness(status);
    await h.run();
    assert.equal(h.sent.length, 0);
    assert.equal(h.removed.length, 1);
  }
});

test('not-yet-due, missing, already sent, and legacy holds do not send', async () => {
  const early = workerHarness();
  await early.run(500);
  assert.equal(early.sent.length, 0);
  for (const hold of [null, { ...record(), reminderMessageId: 'existing' }, { ...record(), createdBy: undefined }]) {
    const h = workerHarness(); h.setHold(hold); await h.run();
    assert.equal(h.sent.length, 0);
  }
});

test('delivery failure keeps the reminder queued for retry', async () => {
  const h = workerHarness('requires_capture', true);
  assert.equal((await h.run()).failed, 1);
  assert.equal(h.retry.length, 1);
  assert.equal((await h.store.getHold()).reminderMessageId, undefined);
});

function actionHarness(status = 'requires_capture') {
  let hold = { ...record(), reminderMessageId: '123456', reminderChannelId: REMINDER_CHANNEL_ID }, locked = false;
  const calls = [], closed = [];
  const store = {
    acquireHoldLock: async () => { if (locked) return null; locked = true; return 'lock'; },
    releaseHoldLock: async () => { locked = false; },
    getHold: async () => hold,
    removeHold: async () => { hold = null; },
  };
  const stripe = { paymentIntents: {
    retrieve: async () => ({ status, amount_capturable: 30000 }),
    cancel: async (...args) => { calls.push(['cancel', ...args]); status = 'canceled'; return { status }; },
    capture: async (...args) => { calls.push(['capture', ...args]); status = 'succeeded'; return { status, amount_received: args[1].amount_to_capture }; },
  } };
  const actions = load('lib/hold-actions.ts', { './holds': store, './discord-messages': { closeReminder: async (...args) => closed.push(args) } });
  return { ...actions, stripe, calls, closed, input: { paymentIntentId: 'pi_example', interactionId: 'interaction1', origin: { channelId: REMINDER_CHANNEL_ID, guildId: REMINDER_GUILD_ID, messageId: '123456' } } };
}

test('release acts once, cleans the hold and removes reminder actions', async () => {
  const h = actionHarness();
  await h.performHoldAction(h.stripe, { ...h.input, action: 'release' });
  assert.equal(h.calls[0][0], 'cancel');
  assert.equal(h.closed[0][1], 'released');
  await assert.rejects(h.performHoldAction(h.stripe, { ...h.input, action: 'release' }), /no longer active/);
  assert.equal(h.calls.length, 1);
});

test('capture validates amount and origin, charges only the entered amount, and releases the remainder', async () => {
  const h = actionHarness();
  for (const amount of ['', '0', '-1', 'NaN', '1e2', '1.234', '301']) {
    await assert.rejects(h.performHoldAction(h.stripe, { ...h.input, action: 'capture', amount }));
  }
  await assert.rejects(h.performHoldAction(h.stripe, { ...h.input, action: 'capture', amount: '200', origin: { ...h.input.origin, channelId: 'other' } }), /no longer active/);
  assert.equal(h.calls.length, 0);
  await h.performHoldAction(h.stripe, { ...h.input, action: 'capture', amount: '125.50' });
  assert.equal(h.calls[0][2].amount_to_capture, 12550);
  assert.equal(h.calls[0][2].final_capture, true);
});

test('concurrent money actions cannot both modify the hold', async () => {
  const h = actionHarness();
  await Promise.allSettled([
    h.performHoldAction(h.stripe, { ...h.input, action: 'capture', amount: '200' }),
    h.performHoldAction(h.stripe, { ...h.input, action: 'release' }),
  ]);
  assert.equal(h.calls.length, 1);
});

test('Stripe terminal status blocks a stale reminder button without another charge', async () => {
  const h = actionHarness('canceled');
  assert.match(await h.performHoldAction(h.stripe, { ...h.input, action: 'capture', amount: '100' }), /already/);
  assert.equal(h.calls.length, 0);
});

test('cron endpoint refuses missing/wrong secrets before running any work', async () => {
  let runs = 0;
  const route = load('app/api/cron/hold-reminders/route.ts', {
    stripe: class {}, '@/lib/hold-reminders': { sendDueReminders: async () => { runs++; return { sent: 0, skipped: 0, failed: 0 }; } },
  }, { process: { env: { CRON_SECRET: 'secret', STRIPE_SECRET_KEY: 'sk_test_fake' } } });
  for (const authorization of ['', 'Bearer wrong']) {
    assert.equal((await route.GET(new Request('https://example.com', { headers: { authorization } }))).status, 401);
  }
  assert.equal(runs, 0);
  assert.equal((await route.GET(new Request('https://example.com', { headers: { authorization: 'Bearer secret' } }))).status, 200);
  assert.equal(runs, 1);
});

function componentHarness() {
  const callbacks = [], actions = [];
  const hold = { ...record(), reminderMessageId: '123456', reminderChannelId: REMINDER_CHANNEL_ID };
  const { matchesReminder } = load('lib/hold-actions.ts', { './holds': {}, './discord-messages': {} });
  const route = load('app/api/discord/route.ts', {
    'next/server': { after: fn => callbacks.push(fn) }, stripe: class {},
    'discord-interactions': {
      InteractionType: { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 },
      InteractionResponseType: { CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5, MODAL: 9 },
      verifyKey: async () => true,
    },
    '@/lib/holds': { getHold: async () => hold },
    '@/lib/create-hold': {},
    '@/lib/checkout-picker': {},
    '@/lib/hold-actions': { matchesReminder, performHoldAction: async (_, input) => { actions.push(input); return 'done'; } },
  }, { fetch: async () => new Response('{}') });
  const request = (type, custom_id, user = 'owner', components = [], channel = REMINDER_CHANNEL_ID) => new Request('https://example.com/api/discord', {
    method: 'POST', headers: { 'x-signature-ed25519': 'sig', 'x-signature-timestamp': '1' },
    body: JSON.stringify({ id: 'interaction2', application_id: 'app', token: 'token', type,
      member: { user: { id: user } }, channel_id: channel, guild_id: REMINDER_GUILD_ID, message: { id: '123456' }, data: { custom_id, components } }),
  });
  return { route, request, callbacks, actions };
}

test('capture button opens an amount form without charging; submit defers the charge', async () => {
  const h = componentHarness();
  const modal = await (await h.route.POST(h.request(3, 'hold:capture:pi_example'))).json();
  assert.equal(modal.type, 9);
  assert.equal(modal.data.custom_id, 'hold:submit:pi_example:123456');
  assert.equal(h.actions.length, 0);
  const amount = [{ type: 18, component: { type: 4, custom_id: 'amount', value: '75.50' } }];
  const response = await (await h.route.POST(h.request(5, modal.data.custom_id, 'owner', amount))).json();
  assert.equal(response.type, 5);
  assert.equal(h.actions.length, 0);
  await h.callbacks[0]();
  assert.equal(h.actions[0].amount, '75.50');
  assert.equal(h.actions[0].action, 'capture');
  assert.equal(h.actions[0].origin.messageId, '123456');
});

test('unauthorised users cannot use either button or submit a capture form', async () => {
  const h = componentHarness();
  for (const [type, id] of [[3, 'hold:release:pi_example'], [3, 'hold:capture:pi_example'], [5, 'hold:submit:pi_example:123456']]) {
    assert.match((await (await h.route.POST(h.request(type, id, 'stranger'))).json()).data.content, /not authorised/);
  }
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.actions.length, 0);
  assert.match((await (await h.route.POST(h.request(3, 'hold:capture:pi_example', 'owner', [], 'other'))).json()).data.content, /no longer active/);
});
