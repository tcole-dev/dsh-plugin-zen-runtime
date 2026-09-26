/**
 * Self-test for the zen-runtime fetch hook.
 *
 * Run with any Node >= 18:  node test/runtime.spec.mjs
 *
 * Zero dependencies, no network: a stub stands in for the real fetch, so the
 * assertions cover exactly what the plugin puts on the wire. The rules encoded
 * here were measured against the live gateway — see the header comment in
 * lib/index.js for the experiments behind them.
 */
import assert from 'node:assert/strict';

const OPENCODE_URL = 'https://opencode.ai/zen/v1/chat/completions';
const OTHER_URL = 'https://api.b.ai/v1/chat/completions';
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const calls = [];
globalThis.fetch = async (input, init) => {
  calls.push({ input, init });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

// Import after the stub is in place: the module installs its hook on load.
const plugin = await import('../lib/index.js');

const checks = [];
function check(label, run) {
  try {
    run();
    checks.push(`  ok   ${label}`);
  } catch (error) {
    checks.push(`  FAIL ${label}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

/** Only `edit` is offered, so both gateway-mandated tools must be added. */
const opencodeBody = () => JSON.stringify({
  model: 'ling-3.0-flash-fin-free',
  tools: [{ type: 'function', function: { name: 'edit', parameters: { type: 'object' } } }],
});

function headersOf(call) {
  return call.init.headers instanceof Headers ? call.init.headers : new Headers(call.init.headers);
}

function toolNamesOf(call) {
  return JSON.parse(call.init.body).tools.map((tool) => plugin.toolName(tool));
}

async function callOpencode() {
  return globalThis.fetch(OPENCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.7-rc.2' },
    body: opencodeBody(),
  });
}

await callOpencode();
await callOpencode();
await globalThis.fetch(OTHER_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'deepseek-harness/0.1.7-rc.2' },
  body: opencodeBody(),
});

const [first, second, other] = calls;
const firstHeaders = headersOf(first);
const secondHeaders = headersOf(second);
const otherHeaders = headersOf(other);

check('the attribution user-agent is replaced on opencode requests', () => {
  assert.equal(firstHeaders.get('user-agent'), 'opencode/1.18.18');
});

check('x-opencode-client is set to cli (required — omitting it is a 403)', () => {
  assert.equal(firstHeaders.get('x-opencode-client'), 'cli');
});

check('x-opencode-project is set, mirroring the real client', () => {
  assert.equal(firstHeaders.get('x-opencode-project'), 'global');
});

check('x-opencode-session carries the validated hex prefix', () => {
  assert.match(firstHeaders.get('x-opencode-session'), SESSION_RE);
});

check('x-opencode-request carries the validated hex prefix', () => {
  assert.match(firstHeaders.get('x-opencode-request'), REQUEST_RE);
});

check('the invented x-opencode-request-id header is never sent', () => {
  assert.equal(firstHeaders.has('x-opencode-request-id'), false);
});

check('x-opencode-session is stable for the whole process', () => {
  assert.equal(secondHeaders.get('x-opencode-session'), firstHeaders.get('x-opencode-session'));
});

check('x-opencode-request is fresh per request', () => {
  assert.notEqual(secondHeaders.get('x-opencode-request'), firstHeaders.get('x-opencode-request'));
});

check('referer is filled in', () => {
  assert.equal(firstHeaders.get('referer'), 'https://opencode.ai');
});

check('both gateway-mandated tools are appended and existing tools are kept', () => {
  assert.deepEqual(toolNamesOf(first), ['edit', 'bash', 'read']);
});

check('mandated tools are not appended twice', () => {
  assert.deepEqual(toolNamesOf(second), ['edit', 'bash', 'read']);
});

check('a body that already names bash and read is left alone', () => {
  const body = JSON.stringify({ tools: [{ type: 'function', function: { name: 'read' } }, { function: { name: 'bash' } }] });
  assert.equal(plugin.withGatewayTools(body), body);
});

check('a non-opencode request is forwarded untouched', () => {
  assert.equal(otherHeaders.get('user-agent'), 'deepseek-harness/0.1.7-rc.2');
  assert.equal(otherHeaders.has('x-opencode-session'), false);
  assert.deepEqual(toolNamesOf(other), ['edit']);
});

check('an explicitly configured header wins over the filler', () => {
  const headers = new Headers({ 'x-opencode-session': 'ses_000000000000ABCDEFGHIJKLMNO' });
  const merged = plugin.opencodeHeaders(headers, { options: { userAgent: 'opencode/1.18.18', referer: 'https://opencode.ai', project: 'global' } });
  assert.equal(merged.get('x-opencode-session'), 'ses_000000000000ABCDEFGHIJKLMNO');
});

check('withGatewayTools leaves a body with no tools alone', () => {
  const body = JSON.stringify({ model: 'x' });
  assert.equal(plugin.withGatewayTools(body), body);
});

check('withGatewayTools leaves a non-JSON body alone', () => {
  assert.equal(plugin.withGatewayTools('not json'), 'not json');
});

check('a row config with a wrong type fails loud', () => {
  assert.throws(() => plugin.resolveOptions({ userAgent: 42 }), /config\.userAgent must be a string/);
});

check('the plugin names the row it mounts under', () => {
  assert.equal(plugin.name, 'zen-runtime');
});

console.log(checks.join('\n'));
console.log(process.exitCode === 1 ? '\nFAILED' : `\nok — ${checks.length} checks passed`);
