const assert = require('node:assert/strict');
const { test } = require('node:test');
const { load } = require('./test-helper.cjs');
const { checkoutPicker, pickerMonths } = load('lib/checkout-picker.ts', { '@upstash/redis': { Redis: { fromEnv: () => ({}) } } });

test('every calendar date is selectable within Discord limits, including leap days', () => {
  const now = Date.parse('2027-03-01T00:00:00Z');
  for (const month of pickerMonths(now)) {
    const picker = checkoutPicker('123', month, now);
    const children = picker.components.flatMap(row => row.components);
    assert.ok(picker.components.length + children.length <= 40);
    assert.ok(picker.components.every(row => row.components.length <= 5));
    assert.equal(children[0].options.length, 24);
    assert.equal(children[0].options.filter(x => x.default)[0].value, month);
    const days = children.filter(c => c.type === 2);
    const [year, m] = month.split('-').map(Number);
    assert.equal(days.length, new Date(Date.UTC(year, m, 0)).getUTCDate());
    assert.equal(new Set(children.map(c => c.custom_id)).size, children.length);
    if (month === '2028-02') assert.match(days.at(-1).custom_id, /2028-02-29$/);
  }
});

test('Sydney date rollover disables yesterday and bounds month navigation', () => {
  const now = Date.parse('2026-10-23T14:00:00Z');
  const days = checkoutPicker('123', '2026-10', now).components.slice(1).flatMap(row => row.components);
  assert.equal(days[22].disabled, true);
  assert.equal(days[23].disabled, false);
  assert.throws(() => checkoutPicker('123', '2026-09', now), /next two years/);
  assert.throws(() => checkoutPicker('123', 'invalid', now), /next two years/);
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
  const date = pickerMonths()[1] + '-01';
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
  const month = pickerMonths()[1];
  const nav = await h.send(3, { custom_id: 'checkout:month:123', values: [month] });
  assert.equal(nav.type, 7);
  assert.equal(h.callbacks.length, 0);
  const selected = await h.send(3, { custom_id: `checkout:day:123:${month}-28` }, 'owner', '456');
  assert.equal(selected.type, 6);
  assert.equal(h.creates.length, 0);
  await h.callbacks[0]();
  assert.equal(h.creates[0].checkoutDate, `${month}-28`);
  assert.equal(h.creates[0].interactionId, '123');
  assert.equal(h.creates[0].userId, 'owner');
  assert.equal(h.messages[0].components[0].type, 10);
  assert.equal(h.messages[0].components[0].content, 'Stripe hold link');
  assert.equal('content' in h.messages[0], false);
  const conflict = await h.send(3, { custom_id: `checkout:day:123:${month}-27` });
  assert.equal(conflict.type, 4);
  assert.equal(h.callbacks.length, 1);
  const denied = await h.send(3, { custom_id: `checkout:day:123:${month}-28` }, 'stranger');
  assert.match(denied.data.content, /not authorised/);
});
