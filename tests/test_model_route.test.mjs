/**
 * The pure rules of src/model-route.ts: which model each attempt of a model call goes to, and how long the primary
 * model cools down after it stalls (issue #6). On 14 Sep 2026 deepseek-flash held every request for ~900 s for about
 * three hours while deepseek-v4-pro answered in under 2 s on the same key: a stalled call goes to the fallback model,
 * and so does every call until the primary has cooled down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_COOLDOWN_MS,
  FALLBACK_MIN_FIRST_EVENT_MS,
  MAX_FALLBACK_COOLDOWN_MS,
  ModelRouter
} from '../dist/model-route.js';

const P = 'deepseek-flash';
const F = 'deepseek-v4-pro';

test('the cooldown starts at 60 s, doubles to at most 10 min, and a fallback attempt waits at least 60 s', () => {
  assert.equal(FALLBACK_COOLDOWN_MS, 60000);
  assert.equal(MAX_FALLBACK_COOLDOWN_MS, 600000);
  assert.equal(FALLBACK_MIN_FIRST_EVENT_MS, 60000);
});

test('without a fallback every attempt goes to the primary, and a stall changes nothing', () => {
  const router = new ModelRouter(P, null);
  assert.deepEqual(router.route(0, null), { model: P, fallback: null });
  assert.equal(router.noteStall(P, 0), 0);
  assert.deepEqual(router.route(1, P), { model: P, fallback: null });
  assert.deepEqual(router.route(2, null), { model: P, fallback: null });
});

test('a stall on the primary sends the next attempt to the fallback at once', () => {
  const router = new ModelRouter(P, F);
  assert.deepEqual(router.route(0, null), { model: P, fallback: null });
  assert.equal(router.noteStall(P, 0), 60000);
  assert.deepEqual(router.route(1, P), { model: F, fallback: 'stall' });
});

test('during the cooldown every call goes to the fallback; after it the primary is tried again', () => {
  const router = new ModelRouter(P, F);
  router.noteStall(P, 1000);
  assert.deepEqual(router.route(1000 + 59_999, null), { model: F, fallback: 'cooldown' });
  assert.deepEqual(router.route(1000 + 60_000, null), { model: P, fallback: null });
});

test('stalls of the primary in a row double the cooldown, up to 10 minutes', () => {
  const router = new ModelRouter(P, F);
  const cooldowns = [];
  for (let at = 0; cooldowns.length < 6; at += 1_000_000) {
    cooldowns.push(router.noteStall(P, at));
  }
  assert.deepEqual(cooldowns, [60000, 120000, 240000, 480000, 600000, 600000]);
});

test('an answer from the primary ends the cooldown; an answer from the fallback does not', () => {
  const router = new ModelRouter(P, F);
  router.noteStall(P, 0);
  router.noteStall(P, 70_000);
  assert.equal(router.noteAnswer(F), false);
  assert.deepEqual(router.route(80_000, null), { model: F, fallback: 'cooldown' });
  assert.equal(router.noteAnswer(P), true);
  assert.deepEqual(router.route(80_001, null), { model: P, fallback: null });
  assert.equal(router.noteAnswer(P), false, 'no cooldown left to end');
  assert.equal(router.noteStall(P, 90_000), 60000, 'the next stall starts again at 60 s');
});

test('a stall on the fallback sends the next attempt to the primary, and starts no cooldown', () => {
  const router = new ModelRouter(P, F);
  router.noteStall(P, 0);
  assert.equal(router.noteStall(F, 1), 0);
  assert.deepEqual(router.route(2, F), { model: P, fallback: null });
});

test('an attempt on the fallback waits at least 60 s for its first event: its prompt cache starts cold', () => {
  const router = new ModelRouter(P, F);
  assert.equal(router.firstEventTimeoutMs({ model: F, fallback: 'stall' }, 15000), 60000);
  assert.equal(router.firstEventTimeoutMs({ model: F, fallback: 'cooldown' }, 300000), 300000);
  assert.equal(router.firstEventTimeoutMs({ model: P, fallback: null }, 15000), 15000);
});
