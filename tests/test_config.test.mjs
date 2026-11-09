import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PRESERVED_DEEPSEEK_CONFIG,
  resolveReasoningParams,
  resolveIterationLimit,
  resolveRequestTimeoutMs
} = await import(path.resolve(__dirname, '../dist/config.js'));

// ---------------------------------------------------------------------------
// Secret purge allow-list
// ---------------------------------------------------------------------------

test('PRESERVED_DEEPSEEK_CONFIG lists every documented DEEPSEEK_* setting and no secret', () => {
  for (const name of [
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_MODEL',
    'DEEPSEEK_TEMPERATURE',
    'DEEPSEEK_THINKING',
    'DEEPSEEK_REASONING_EFFORT',
    'DEEPSEEK_REQUEST_TIMEOUT_MS'
  ]) {
    assert.ok(PRESERVED_DEEPSEEK_CONFIG.has(name), `${name} must survive the secret purge`);
  }
  for (const secret of ['DEEPSEEK_API_KEY', 'DEEPSEEK_AUTH_TOKEN', 'DEEPSEEK_TOKEN', 'DEEPSEEK_SECRET']) {
    assert.equal(PRESERVED_DEEPSEEK_CONFIG.has(secret), false, `${secret} must be purged`);
  }
});

// ---------------------------------------------------------------------------
// Thinking / reasoning effort
// ---------------------------------------------------------------------------

test('resolveReasoningParams: nothing configured leaves the API default untouched', () => {
  assert.deepEqual(resolveReasoningParams({}), { params: {}, warnings: [] });
  assert.deepEqual(resolveReasoningParams({ DEEPSEEK_THINKING: '', DEEPSEEK_REASONING_EFFORT: '  ' }), {
    params: {},
    warnings: []
  });
});

test('resolveReasoningParams: DEEPSEEK_THINKING=disabled sends thinking.type=disabled (case and spaces ignored)', () => {
  assert.deepEqual(resolveReasoningParams({ DEEPSEEK_THINKING: 'disabled' }).params, {
    thinking: { type: 'disabled' }
  });
  assert.deepEqual(resolveReasoningParams({ DEEPSEEK_THINKING: '  Disabled ' }).params, {
    thinking: { type: 'disabled' }
  });
});

test('resolveReasoningParams: DEEPSEEK_THINKING=enabled sends thinking.type=enabled', () => {
  assert.deepEqual(resolveReasoningParams({ DEEPSEEK_THINKING: 'enabled' }).params, {
    thinking: { type: 'enabled' }
  });
});

test('resolveReasoningParams: DEEPSEEK_REASONING_EFFORT=none disables thinking', () => {
  assert.deepEqual(resolveReasoningParams({ DEEPSEEK_REASONING_EFFORT: 'none' }).params, {
    thinking: { type: 'disabled' }
  });
});

test('resolveReasoningParams: a real effort level is passed as reasoning_effort', () => {
  for (const effort of ['low', 'medium', 'high', 'max']) {
    assert.deepEqual(resolveReasoningParams({ DEEPSEEK_REASONING_EFFORT: effort.toUpperCase() }).params, {
      reasoning_effort: effort
    });
  }
});

test('resolveReasoningParams: enabled thinking and an effort level are both sent', () => {
  assert.deepEqual(
    resolveReasoningParams({ DEEPSEEK_THINKING: 'enabled', DEEPSEEK_REASONING_EFFORT: 'max' }).params,
    { thinking: { type: 'enabled' }, reasoning_effort: 'max' }
  );
});

test('resolveReasoningParams: disabled thinking wins over an effort level and says so', () => {
  const { params, warnings } = resolveReasoningParams({
    DEEPSEEK_THINKING: 'disabled',
    DEEPSEEK_REASONING_EFFORT: 'high'
  });
  assert.deepEqual(params, { thinking: { type: 'disabled' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /DEEPSEEK_REASONING_EFFORT/);
});

test('resolveReasoningParams: enabled thinking with effort none is a conflict, thinking stays disabled', () => {
  const { params, warnings } = resolveReasoningParams({
    DEEPSEEK_THINKING: 'enabled',
    DEEPSEEK_REASONING_EFFORT: 'none'
  });
  assert.deepEqual(params, { thinking: { type: 'disabled' } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conflict/i);
});

test('resolveReasoningParams: unknown values are ignored with a warning that names the variable', () => {
  const thinking = resolveReasoningParams({ DEEPSEEK_THINKING: 'banana' });
  assert.deepEqual(thinking.params, {});
  assert.equal(thinking.warnings.length, 1);
  assert.match(thinking.warnings[0], /DEEPSEEK_THINKING/);

  const effort = resolveReasoningParams({ DEEPSEEK_REASONING_EFFORT: 'extreme' });
  assert.deepEqual(effort.params, {});
  assert.equal(effort.warnings.length, 1);
  assert.match(effort.warnings[0], /DEEPSEEK_REASONING_EFFORT/);
});

// ---------------------------------------------------------------------------
// Iteration limit
// ---------------------------------------------------------------------------

test('resolveIterationLimit: defaults are 15, and 25 for coder models and coder/builder roles', () => {
  assert.equal(resolveIterationLimit({}, 'deepseek-flash').limit, 15);
  assert.equal(resolveIterationLimit({}, 'deepseek-coder').limit, 25);
  assert.equal(resolveIterationLimit({ AGENT_ROLE: 'coder' }, 'deepseek-flash').limit, 25);
  assert.equal(resolveIterationLimit({ AGENT_ROLE: 'builder' }, 'deepseek-flash').limit, 25);
  assert.equal(resolveIterationLimit({}, 'deepseek-flash').source, 'default');
});

test('resolveIterationLimit: ACP_MAX_ITERATIONS=10000 is honoured', () => {
  const resolved = resolveIterationLimit({ ACP_MAX_ITERATIONS: '10000' }, 'deepseek-flash');
  assert.equal(resolved.limit, 10000);
  assert.equal(resolved.source, 'ACP_MAX_ITERATIONS');
  assert.deepEqual(resolved.warnings, []);
});

test('resolveIterationLimit: BUZZ_MAX_ITERATIONS is the fallback and ACP_MAX_ITERATIONS wins', () => {
  assert.equal(resolveIterationLimit({ BUZZ_MAX_ITERATIONS: '50' }, 'deepseek-flash').limit, 50);
  assert.equal(
    resolveIterationLimit({ ACP_MAX_ITERATIONS: '70', BUZZ_MAX_ITERATIONS: '50' }, 'deepseek-flash').limit,
    70
  );
});

test('resolveIterationLimit: surrounding spaces are tolerated and an empty value counts as unset', () => {
  assert.equal(resolveIterationLimit({ ACP_MAX_ITERATIONS: ' 40 ' }, 'deepseek-flash').limit, 40);
  assert.equal(
    resolveIterationLimit({ ACP_MAX_ITERATIONS: '', BUZZ_MAX_ITERATIONS: '33' }, 'deepseek-flash').limit,
    33
  );
});

test('resolveIterationLimit: invalid values fall back with a warning instead of being half-parsed', () => {
  for (const bad of ['abc', '0', '-5', '1.5', '10abc', '1e3']) {
    const resolved = resolveIterationLimit({ ACP_MAX_ITERATIONS: bad }, 'deepseek-flash');
    assert.equal(resolved.limit, 15, `"${bad}" must not be accepted`);
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /ACP_MAX_ITERATIONS/);
  }
});

test('resolveIterationLimit: an invalid ACP value still lets a valid BUZZ value apply', () => {
  const resolved = resolveIterationLimit(
    { ACP_MAX_ITERATIONS: 'nope', BUZZ_MAX_ITERATIONS: '25' },
    'deepseek-flash'
  );
  assert.equal(resolved.limit, 25);
  assert.equal(resolved.source, 'BUZZ_MAX_ITERATIONS');
  assert.equal(resolved.warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Request timeout
// ---------------------------------------------------------------------------

test('resolveRequestTimeoutMs: defaults to 90000 and accepts a positive integer', () => {
  assert.deepEqual(resolveRequestTimeoutMs({}), { timeoutMs: 90000, warnings: [] });
  assert.deepEqual(resolveRequestTimeoutMs({ DEEPSEEK_REQUEST_TIMEOUT_MS: '30000' }), {
    timeoutMs: 30000,
    warnings: []
  });
});

test('resolveRequestTimeoutMs: invalid values fall back to the default with a warning', () => {
  for (const bad of ['abc', '0', '-1', '12.5', '5s']) {
    const resolved = resolveRequestTimeoutMs({ DEEPSEEK_REQUEST_TIMEOUT_MS: bad });
    assert.equal(resolved.timeoutMs, 90000, `"${bad}" must not be accepted`);
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /DEEPSEEK_REQUEST_TIMEOUT_MS/);
  }
});
