const assert = require('node:assert/strict');
const { test } = require('node:test');
const { load } = require('./test-helper.cjs');

const { createHoldLink } = load('lib/create-hold.ts');
const input = { amount: 300, name: ' John Smith ', interactionId: 'interaction-1', userId: 'owner', channelId: 'channel', guildId: 'guild', checkoutDate: '28/10/2099' };

test('a hold uses manual capture, one completion, Stripe confirmation, and webhook metadata', async () => {
  const calls = [];
  const stripe = {
    products: { create: async (params, options) => { calls.push({ params, options }); return { default_price: 'price_1' }; } },
    paymentLinks: { create: async (params, options) => { calls.push({ params, options }); return { url: 'https://buy.stripe.com/example' }; } },
  };
  const message = await createHoldLink(stripe, input);
  const [product, link] = calls;
  assert.equal(product.params.default_price_data.unit_amount, 30000);
  assert.equal(product.params.default_price_data.currency, 'aud');
  assert.equal(link.params.payment_intent_data.capture_method, 'manual');
  assert.equal(link.params.payment_method_types.join(','), 'card');
  assert.equal(link.params.restrictions.completed_sessions.limit, 1);
  assert.equal(link.params.after_completion.type, 'hosted_confirmation');
  assert.match(link.params.after_completion.hosted_confirmation.custom_message, /\$300\.00 AUD.*Funds have not been collected/);
  assert.equal(link.params.metadata.type, 'damage_deposit_hold');
  assert.equal(link.params.metadata.note, 'John Smith');
  assert.equal(link.params.payment_intent_data.metadata.created_by, 'owner');
  assert.equal(link.params.metadata.checkout_date, '2099-10-28');
  assert.equal(link.params.metadata.discord_channel_id, 'channel');
  assert.equal(link.params.metadata.discord_guild_id, 'guild');
  assert.equal('success_url' in link.params, false);
  assert.equal('guest_portal_link' in link.params.metadata, false);
  assert.match(message, /https:\/\/buy\.stripe\.com\/example/);
  await createHoldLink(stripe, input);
  assert.equal(calls[0].options.idempotencyKey, calls[2].options.idempotencyKey);
  assert.equal(calls[1].options.idempotencyKey, calls[3].options.idempotencyKey);
});

test('invalid amounts or missing name cannot create Stripe objects', async () => {
  for (const amount of [NaN, Infinity, -1, 0, 0.01, 1000000]) {
    await assert.rejects(createHoldLink({}, { ...input, amount }), /Enter an amount/);
  }
  for (const name of ['', '   ', 'a'.repeat(501)]) {
    await assert.rejects(createHoldLink({}, { ...input, name }), /Enter a name/);
  }
});

test('a failed product/price creation never creates a payment link', async () => {
  let links = 0;
  const stripe = {
    products: { create: async () => ({ default_price: null }) },
    paymentLinks: { create: async () => { links++; } },
  };
  await assert.rejects(createHoldLink(stripe, input), /did not return a price/);
  assert.equal(links, 0);
});

function routeHarness(create, validSignature = true) {
  const callbacks = [], messages = [];
  const route = load('app/api/discord/route.ts', {
    'next/server': { after: callback => callbacks.push(callback) },
    stripe: class {},
    'discord-interactions': {
      InteractionType: { PING: 1, APPLICATION_COMMAND: 2, APPLICATION_COMMAND_AUTOCOMPLETE: 4 },
      InteractionResponseType: { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 },
      verifyKey: async () => validSignature,
    },
    '@/lib/holds': {},
    '@/lib/hold-actions': {},
    '@/lib/create-hold': { createHoldLink: create },
  }, { fetch: async (url, options) => { messages.push({ url, ...JSON.parse(options.body) }); return new Response('{}'); } });
  const request = (user = 'owner') => new Request('https://example.com/api/discord', {
    method: 'POST', headers: { 'x-signature-ed25519': 'signature', 'x-signature-timestamp': '1' },
    body: JSON.stringify({ id: 'interaction-1', application_id: 'app-1', token: 'token', type: 2, channel_id: 'channel', guild_id: 'guild',
      member: { user: { id: user } }, data: { name: 'create-hold', options: [{ name: 'amount', value: 300 }, { name: 'name', value: 'John Smith' }, { name: 'checkout_date', value: '28/10/2099' }] } }),
  });
  return { route, callbacks, messages, request };
}

test('Discord gets a private acknowledgement before Stripe work, followed by the link', async () => {
  let calls = 0;
  const h = routeHarness(async (_, data) => { calls++; assert.equal(data.interactionId, 'interaction-1'); assert.equal(data.name, 'John Smith'); return 'Hold link'; });
  const response = await h.route.POST(h.request());
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  assert.equal(calls, 0);
  await h.callbacks[0]();
  assert.equal(calls, 1);
  assert.equal(h.messages[0].content, 'Hold link');
  assert.deepEqual(h.messages[0].allowed_mentions, { parse: [] });
});

test('Stripe failure finishes the deferred response with an error', async () => {
  const h = routeHarness(async () => { throw new Error('Stripe unavailable'); });
  await h.route.POST(h.request());
  await h.callbacks[0]();
  assert.equal(h.messages[0].content, 'Error: Stripe unavailable');
});

test('unsigned or unauthorised requests cannot schedule a live hold', async () => {
  const denied = routeHarness(() => assert.fail('Must not create hold'));
  const response = await denied.route.POST(denied.request('stranger'));
  assert.match((await response.json()).data.content, /not authorised/);
  assert.equal(denied.callbacks.length, 0);
  const unsigned = routeHarness(() => assert.fail('Must not create hold'), false);
  assert.equal((await unsigned.route.POST(unsigned.request())).status, 401);
  assert.equal(unsigned.callbacks.length, 0);
});

test('Payment Link webhook saves an open hold without a portal and ignores released holds', async () => {
  const saved = [];
  let status = 'requires_capture';
  const event = { type: 'checkout.session.completed', data: { object: {
    payment_intent: 'pi_hold', amount_total: 30000,
    metadata: { type: 'damage_deposit_hold', note: 'John Smith', created_by: 'owner', checkout_date: '2099-10-28', discord_channel_id: 'channel', discord_guild_id: 'guild' },
  } } };
  const route = load('app/api/stripe-webhook/route.ts', {
    'next/server': {},
    '@/lib/checkout-date': load('lib/checkout-date.ts'),
    stripe: class {
      webhooks = { constructEvent: () => event };
      paymentIntents = { retrieve: async () => ({ status, latest_charge: {
        payment_method_details: { type: 'card', card: { capture_before: 1800000000, brand: 'visa' } },
      } }) };
    },
    '@/lib/holds': { saveHold: async record => saved.push(record) },
  }, { process: { env: { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' } } });
  const request = () => new Request('https://example.com/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': 'signature' }, body: '{}' });
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].amount, 300);
  assert.equal(saved[0].captureBefore, 1800000000);
  assert.equal(saved[0].createdBy, 'owner');
  assert.equal(saved[0].checkoutDate, '2099-10-28');
  assert.equal(saved[0].channelId, 'channel');
  assert.equal(saved[0].guildId, 'guild');
  assert.ok(saved[0].reminderAt > 0);
  assert.equal('portalLink' in saved[0], false);
  status = 'canceled';
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(saved.length, 1);
});
