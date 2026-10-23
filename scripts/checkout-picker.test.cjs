const assert = require('node:assert/strict');
const { test } = require('node:test');
const { load } = require('./test-helper.cjs');
const { checkoutPicker, pickerDates } = load('lib/checkout-picker.ts', { '@upstash/redis': { Redis: { fromEnv: () => ({}) } } });

test('picker shows exactly seven dates across month, year, leap day and DST boundaries', () => {
  for (const [start, end] of [['2026-10-28', '2026-11-03'], ['2026-12-28', '2027-01-03'], ['2028-02-27', '2028-03-04'], ['2026-10-02', '2026-10-08'], ['2026-04-03', '2026-04-09']]) {
    const now = Date.parse(start + 'T01:00:00Z');
    const dates = pickerDates(now);
    assert.equal(dates.length, 7);
    assert.equal(dates[0], start);
    assert.equal(dates[6], end);
    const picker = checkoutPicker('123', now);
    const rows = picker.components.filter(c => c.type === 1);
    const buttons = rows.flatMap(row => row.components);
    assert.ok(rows.every(row => row.components.length <= 5));
    assert.equal(buttons.length, 7);
    assert.equal(new Set(buttons.map(c => c.custom_id)).size, 7);
    assert.equal(buttons.map(b => b.custom_id.split(':').at(-1)).join(','), dates.join(','));
    if (start === '2028-02-27') assert.ok(dates.includes('2028-02-29'));
  }
});

test('window starts on today in Sydney, even when UTC is still yesterday', () => {
  const now = Date.parse('2026-10-23T14:00:00Z');
  assert.equal(pickerDates(now)[0], '2026-10-24');
  assert.equal(pickerDates(now)[6], '2026-10-30');
});

test('draft ownership, expiry, and a previously selected date are enforced', async () => {
  let saved, result = 1;
  const picker = load('lib/checkout-picker.ts', { '@upstash/redis': { Redis: { fromEnv: () => ({
    set: async (_, draft) => { saved = draft; }, get: async () => saved,
    eval: async () => result,
  }) } } });
  const draft = { amount: 300, name: 'John', interactionId: '123', userId: 'owner', channelId: 'channel', guildId: 'guild' };
  await picker.saveHoldDraft(draft);
  assert.equal(await picker.getHoldDraft('123', 'owner', 'channel', 'guild'), draft);
  for (const args of [['other', 'channel', 'guild'], ['owner', 'other', 'guild'], ['owner', 'channel', 'other']]) {
    await assert.rejects(picker.getHoldDraft('123', ...args), /another hold creator/);
  }
  const date = pickerDates()[1];
  const outside = new Date(date + 'T00:00:00Z');
  outside.setUTCDate(outside.getUTCDate() + 7);
  await assert.rejects(picker.selectCheckoutDate('123', outside.toISOString().slice(0, 10)), /next 6 days/);
  await picker.selectCheckoutDate('123', date);
  result = -1;
  await assert.rejects(picker.selectCheckoutDate('123', date), /already been selected/);
  saved = null;
  await assert.rejects(picker.getHoldDraft('123', 'owner', 'channel', 'guild'), /expired/);
});

function harness() {
  const drafts = new Map(), callbacks = [], creates = [], messages = [];
  const route = load('app/api/discord/route.ts', {
    'next/server': { after: fn => callbacks.push(fn) }, stripe: class {},
    'discord-interactions': {
      verifyKey: async () => true,
      InteractionType: { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 },
      InteractionResponseType: { CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5, DEFERRED_UPDATE_MESSAGE: 6, UPDATE_MESSAGE: 7 },
    },
    '@/lib/holds': {}, '@/lib/hold-actions': {},
    '@/lib/create-hold': { createHoldLink: async (_, data) => { creates.push(data); return 'Stripe hold link'; } },
    '@/lib/checkout-picker': {
      checkoutPicker, saveHoldDraft: async draft => drafts.set(draft.interactionId, draft),
      getHoldDraft: async (id, user) => { const draft = drafts.get(id); if (!draft || draft.userId !== user) throw new Error('Invalid draft'); return draft; },
      selectCheckoutDate: async (id, date) => {
        const draft = drafts.get(id);
        if (draft.checkoutDate && draft.checkoutDate !== date) throw new Error('Already selected');
        draft.checkoutDate = date;
      },
    },
  }, { fetch: async (_, options) => { messages.push(JSON.parse(options.body)); return new Response('{}'); } });
  const send = async (type, data, user = 'owner', id = '123') => (await route.POST(new Request('https://example.com', {
    method: 'POST', headers: { 'x-signature-ed25519': 'sig', 'x-signature-timestamp': '1' },
    body: JSON.stringify({ id, type, data, application_id: 'app', token: 'token', channel_id: 'channel', guild_id: 'guild', member: { user: { id: user } } }),
  }))).json();
  return { send, drafts, callbacks, creates, messages };
}

test('command opens private picker, navigation creates nothing, day selection defers one Stripe link', async () => {
  const h = harness();
  const data = { name: 'create-hold', options: [{ name: 'amount', value: 300 }, { name: 'name', value: 'John' }] };
  const reply = await h.send(2, data);
  assert.equal(reply.type, 4);
  assert.equal(reply.data.flags, 32768 | 64);
  assert.equal(h.creates.length, 0);
  const date = pickerDates()[1];
  const nav = await h.send(3, { custom_id: 'checkout:month:123', values: ['2099-01'] });
  assert.equal(nav.type, 7);
  assert.equal(h.callbacks.length, 0);
  assert.equal(nav.data.components.filter(c => c.type === 1).flatMap(c => c.components).length, 7);
  const selected = await h.send(3, { custom_id: `checkout:day:123:${date}` }, 'owner', '456');
  assert.equal(selected.type, 6);
  assert.equal(h.creates.length, 0);
  await h.callbacks[0]();
  assert.equal(h.creates[0].checkoutDate, date);
  assert.equal(h.creates[0].interactionId, '123');
  assert.equal(h.creates[0].userId, 'owner');
  assert.equal(h.messages[0].components[0].type, 10);
  assert.equal(h.messages[0].components[0].content, 'Stripe hold link');
  assert.equal('content' in h.messages[0], false);
  const conflict = await h.send(3, { custom_id: `checkout:day:123:${pickerDates()[2]}` });
  assert.equal(conflict.type, 4);
  assert.equal(h.callbacks.length, 1);
  const denied = await h.send(3, { custom_id: `checkout:day:123:${date}` }, 'stranger');
  assert.match(denied.data.content, /not authorised/);
});
