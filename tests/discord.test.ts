import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidWebhookUrl, maskWebhookUrl, toDiscordPayload } from '../src/discord';

test('toDiscordPayload sends embeds, drops empty fields and never allows mentions', () => {
  const payload = toDiscordPayload({
    content: '## Daily Tech Digest',
    embeds: [{ title: '🧠 New AI models', color: 0x5865f2, fields: [{ name: 'n', value: 'v' }] }],
  });

  assert.equal(payload.content, '## Daily Tech Digest');
  assert.equal(payload.embeds?.length, 1);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });

  const continuation = toDiscordPayload({ embeds: [{ title: 'Cool builds' }] });
  assert.ok(!('content' in continuation), 'continuation messages omit content entirely');

  const textOnly = toDiscordPayload({ content: 'hi' });
  assert.equal(textOnly.content, 'hi');
  assert.equal(textOnly.embeds, undefined, 'an empty embed list is never sent');
});

test('isValidWebhookUrl accepts real webhook URLs and rejects anything else', () => {
  assert.ok(isValidWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abc-DEF_123'));
  assert.ok(isValidWebhookUrl('https://canary.discordapp.com/api/v10/webhooks/1/token'));

  assert.ok(!isValidWebhookUrl('https://discord.com/api/webhooks/123'));
  assert.ok(!isValidWebhookUrl('https://example.com/api/webhooks/123/token'));
  assert.ok(!isValidWebhookUrl(undefined));
});

test('maskWebhookUrl hides the token and keeps the id', () => {
  assert.equal(
    maskWebhookUrl('https://discord.com/api/webhooks/123456789012345678/super-secret'),
    'https://discord.com/api/webhooks/123456789012345678/***',
  );
  assert.equal(maskWebhookUrl('https://discord.com/api/webhooks/'), 'https://discord.com/api/webhooks/***');
});
