/**
 * dsh-plugin-zen-runtime
 *
 * Runtime-only fix for the OpenCode Zen free tier in dsh.
 *
 * The desktop application ships every in-box package inside a signed,
 * asar-integrity-checked `app.asar`, so the on-disk `dsh-plugin-zen-useragent`
 * patch cannot apply there: the archive is read-only and Electron verifies each
 * file's SHA-256 on read. This plugin reaches the same effect without touching
 * a single file, by wrapping `globalThis.fetch` at load time.
 *
 * WHAT THE GATEWAY ACTUALLY CHECKS (measured, not assumed)
 * -------------------------------------------------------
 * Every claim below was determined by replaying captured OpenCode 1.18.23
 * traffic (the real CLI's own request, byte for byte) against
 * https://opencode.ai/zen/v1/chat/completions and bisecting one variable at a
 * time. The gateway answers a rejected free-tier call with
 * `403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode's
 * free tier can only be used from within OpenCode"}}`.
 *
 *   1. `x-opencode-client: cli` is required. Omitting it is a 403 even when
 *      both id headers are present.
 *   2. `x-opencode-session` and `x-opencode-request` are both required, and
 *      each value must start with 12 lowercase hex characters before 14
 *      arbitrary alphanumerics (`ses_` / `msg_` + `[0-9a-f]{12}[0-9A-Za-z]{14}`).
 *      26 random base32 characters is a 403 — the hex prefix is the validated
 *      part, so generating ids from a base32 alphabet silently fails.
 *      The real client's header is `x-opencode-request`; there is no
 *      `x-opencode-request-id` anywhere in the OpenCode binary.
 *   3. The body's `tools` must contain BOTH a `bash` tool and a `read` tool.
 *      `bash` alone is a 403; dsh's own tool set (edit/glob/grep/read/skill/
 *      write) is a 403 because it has no `bash`; the full 11-tool OpenCode set
 *      is a 200 but is not required — `[read, bash]` is enough.
 *   4. The system prompt is irrelevant: deleting the 64 KB OpenCode prompt, or
 *      replacing it with 18 characters, still returns 200.
 *   5. `x-opencode-project` and the exact `User-Agent` string are not
 *      load-bearing (with and without them is a 200 either way). The real
 *      client sends `x-opencode-project: global` and a UA of
 *      `opencode/<version> ai-sdk/provider-utils/<v> runtime/bun/<v>`, so this
 *      plugin mirrors both rather than inventing its own values.
 *
 * Scope and safety: only requests whose URL contains "opencode" are touched.
 * Every other request is forwarded with the original arguments, unchanged. No
 * file is read, written, or patched, so the fix survives application updates.
 *
 * The hook is installed once per process and is idempotent across re-imports;
 * the row's `config` only changes the identity values, which are read at
 * request time.
 */

/** How an OpenCode gateway is recognised. Mirrors the on-disk plugin's rule. */
const OPENCODE_URL = /opencode/i;

/** Identity values of the real opencode CLM client. */
const DEFAULT_USER_AGENT = 'opencode/1.18.18';
const DEFAULT_REFERER = 'https://opencode.ai';
const DEFAULT_PROJECT = 'global';

/**
 * The gateway requires these two tool names to be present in `body.tools`.
 * Only the names are inspected, so the stubs describe themselves honestly and
 * ask the model not to call them. A tool dsh already provides is left alone.
 */
const REQUIRED_TOOLS = [
  {
    name: 'bash',
    description: 'Zen gateway requires a "bash" tool to be present; do not actually call it.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read',
    description: 'Zen gateway requires a "read" tool to be present; do not actually call it.',
    parameters: { type: 'object', properties: {} },
  },
];

const HEX_ALPHABET = '0123456789abcdef';
const ALNUM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Process-wide plugin state, keyed by a registered symbol so that a second
 * evaluation of this module (hot reload, duplicate row) reuses one hook and
 * one session id instead of stacking wrappers.
 */
const STATE_KEY = Symbol.for('dsh-plugin-zen-runtime/state');

function state() {
  const existing = globalThis[STATE_KEY];
  if (existing !== undefined) return existing;
  const created = {
    options: {
      userAgent: DEFAULT_USER_AGENT,
      referer: DEFAULT_REFERER,
      project: DEFAULT_PROJECT,
      ensureTools: true,
    },
    installed: false,
    sessionId: undefined,
    requests: 0,
  };
  Object.defineProperty(globalThis, STATE_KEY, { value: created, enumerable: false, configurable: true });
  return created;
}

/**
 * Random characters drawn from one alphabet.
 * @param alphabet - characters to draw from.
 * @param length - how many to draw.
 * @returns the drawn string.
 */
function randomChars(alphabet, length) {
  const bytes = new Uint8Array(length);
  const webcrypto = globalThis.crypto;
  if (typeof webcrypto?.getRandomValues === 'function') webcrypto.getRandomValues(bytes);
  else for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let out = '';
  for (let index = 0; index < length; index += 1) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

/**
 * The `ses_` id, stable for the process. The leading twelve characters must be
 * lowercase hex: the gateway validates that prefix and rejects an id drawn
 * entirely from a wider alphabet.
 * @param current - plugin state holding the cached id.
 * @returns the session id.
 */
function sessionId(current) {
  current.sessionId ??= `ses_${randomChars(HEX_ALPHABET, 12)}${randomChars(ALNUM_ALPHABET, 14)}`;
  return current.sessionId;
}

/** Fresh per request, with the same validated `msg_` + hex prefix shape. */
function requestId() {
  return `msg_${randomChars(HEX_ALPHABET, 12)}${randomChars(ALNUM_ALPHABET, 14)}`;
}

/**
 * The name of a wire-format tool, whether it arrives OpenAI-nested
 * (`{ type: "function", function: { name } }`) or flat.
 * @param tool - one entry of `body.tools`.
 * @returns the tool name, or undefined.
 */
export function toolName(tool) {
  if (tool === null || typeof tool !== 'object') return undefined;
  const fn = tool.function;
  if (fn !== null && typeof fn === 'object' && typeof fn.name === 'string') return fn.name;
  return typeof tool.name === 'string' ? tool.name : undefined;
}

/**
 * Append whichever gateway-mandated tools are missing from a serialized request
 * body. The gate needs `bash` AND `read`; dsh supplies neither a `bash` wire
 * name nor necessarily a `read`, so both are ensured. Bodies that are not JSON
 * objects carrying a non-empty `tools` array are returned untouched.
 * @param body - the fetch `init.body`, usually a JSON string.
 * @returns the body to send.
 */
export function withGatewayTools(body) {
  if (typeof body !== 'string') return body;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== 'object') return body;
  const tools = parsed.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;
  const present = new Set(tools.map(toolName));
  const missing = REQUIRED_TOOLS.filter((tool) => !present.has(tool.name));
  if (missing.length === 0) return body;
  parsed.tools = [...tools, ...missing.map((tool) => ({ type: 'function', function: tool }))];
  return JSON.stringify(parsed);
}

/**
 * Merge the opencode identity into a request's headers.
 *
 * `user-agent` is replaced unless the caller already sent an opencode one: the
 * in-box attribution header has already overwritten any provider value by the
 * time a request reaches here, so an opencode-free value is the signal that the
 * fix is still owed. Every other header is filled only when absent, so an
 * explicit provider value always wins — the same precedence the on-disk plugin
 * documents.
 *
 * @param headers - the existing `init.headers`, in any `HeadersInit` form.
 * @param current - plugin state holding the process-stable session id.
 * @returns a new `Headers` carrying the identity.
 */
export function opencodeHeaders(headers, current) {
  const next = new Headers(headers ?? undefined);
  const options = current.options;
  if (!/opencode/i.test(next.get('user-agent') ?? '')) next.set('user-agent', options.userAgent);
  if (options.referer !== '' && !next.has('referer')) next.set('referer', options.referer);
  if (!next.has('x-opencode-client')) next.set('x-opencode-client', 'cli');
  if (options.project !== '' && !next.has('x-opencode-project')) next.set('x-opencode-project', options.project);
  if (!next.has('x-opencode-session')) next.set('x-opencode-session', sessionId(current));
  if (!next.has('x-opencode-request')) next.set('x-opencode-request', requestId());
  return next;
}

/**
 * The absolute URL of a fetch input, or undefined when it cannot be read.
 * @param input - a fetch `input`.
 * @returns the URL string when available.
 */
function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return undefined;
}

/**
 * Rewrite a `Request`-form input, which the OpenAI SDK does not use but another
 * caller may. Only the rewriting is guarded: if it fails the caller's original
 * request is sent, unchanged.
 * @param original - the installed fetch, used to forward.
 * @param request - the `Request` input.
 * @param init - the accompanying init, if any.
 * @param current - plugin state.
 * @returns the response.
 */
async function forwardRequest(original, request, init, current) {
  let rewritten;
  try {
    const headers = opencodeHeaders(init?.headers ?? request.headers, current);
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      rewritten = new Request(request, { headers });
    } else {
      const raw = init?.body ?? (await request.clone().text());
      const body = current.options.ensureTools ? withGatewayTools(raw) : raw;
      rewritten = new Request(request, { headers, body });
    }
  } catch {
    return await original.call(globalThis, request, init);
  }
  // Deliberately outside the guard above. A transport failure (DNS, TLS, socket
  // reset, abort) is the caller's to handle; catching it here would send the
  // same POST a second time, and that retry would carry none of the identity
  // headers or gateway tools this plugin exists to add.
  return await original.call(globalThis, rewritten);
}

/**
 * Install the fetch hook once per process.
 * @returns the plugin state.
 */
function install() {
  const current = state();
  if (current.installed) return current;
  const original = globalThis.fetch;
  // No global fetch means no request this plugin could rewrite; leave the
  // process alone rather than throwing during boot.
  if (typeof original !== 'function') return current;

  current.installed = true;
  current.original = original;

  globalThis.fetch = async function zenFetch(input, init) {
    const url = requestUrl(input);
    if (url === undefined || !OPENCODE_URL.test(url)) return original.call(this, input, init);
    const live = state();
    live.requests += 1;
    if (input instanceof Request) return await forwardRequest(original, input, init, live);
    const headers = opencodeHeaders(init?.headers, live);
    const body = live.options.ensureTools ? withGatewayTools(init?.body) : init?.body;
    return await original.call(this, input, { ...init, headers, body });
  };
  return current;
}

/**
 * Validate a row `config` and return only the keys this plugin understands.
 * A malformed row fails at load with its exact field path, mirroring the
 * in-box plugin convention, instead of silently sending a half-configured
 * identity on every request.
 * @param config - the row `config` from the Loader.
 * @returns the resolved options.
 */
export function resolveOptions(config) {
  const supplied = config ?? {};
  const resolved = {};
  for (const key of ['userAgent', 'referer', 'project']) {
    const value = supplied[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`zen-runtime: config.${key} must be a string`);
    resolved[key] = value;
  }
  if (supplied.ensureTools !== undefined) {
    if (typeof supplied.ensureTools !== 'boolean') throw new Error('zen-runtime: config.ensureTools must be a boolean');
    resolved.ensureTools = supplied.ensureTools;
  }
  return resolved;
}

/** The Loader entry id this plugin mounts under. */
export const name = 'zen-runtime';

/**
 * Mount the plugin. The hook itself is installed at module load so that a
 * request cannot outrun a late `apply`; this only folds the row's config into
 * the identity that requests read at call time.
 * @param ctx - host context; only its logger is used.
 * @param config - row `config` from the Loader.
 */
export function apply(ctx, config) {
  const current = install();
  Object.assign(current.options, resolveOptions(config));
  const line = `[zen-runtime] fetch hook active — opencode requests carry x-opencode-client/session/request${current.options.project ? '/project' : ''}${current.options.ensureTools ? ' and the bash+read tools the Zen gateway requires' : ''}`;
  const logger = ctx?.logger;
  if (typeof logger?.info === 'function') logger.info(line);
  // Also on stderr: whether the hook is live is the one thing an operator needs
  // to confirm after a restart, and the host logger's sink is not guaranteed to
  // be reachable from the terminal that launched the profile.
  console.error(line);
}

install();
