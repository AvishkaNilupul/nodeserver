import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateReply } from './text-policy.mjs';

const executable = fileURLToPath(new URL('../private/operator-draft', import.meta.url));
const safeLogin = value => typeof value === 'string' && /^[a-z0-9_]{1,25}$/i.test(value);
const clean = (value, limit) => typeof value === 'string'
  && value.trim().length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });

function message(row) {
  return safeLogin(row?.author) && clean(row.text, 500) ? { author: row.author, text: row.text.trim() } : null;
}

function payload(context) {
  const target = message(context?.target);
  if (!target || !safeLogin(context.account) || !safeLogin(context.channel) || !Array.isArray(context.messages)) {
    throw fail('invalid_context', 'Select a valid incoming chat message for the draft.');
  }
  const messages = [];
  let budget = 2200;
  // Reserve space for the target separately so a busy room cannot displace it.
  for (const raw of context.messages.slice(-12).reverse()) {
    const row = message(raw);
    if (!row || row.author === target.author && row.text === target.text) continue;
    budget -= row.text.length + row.author.length;
    if (budget < 0) break;
    messages.unshift(row);
  }
  const stream = {};
  for (const key of ['title', 'category']) {
    if (clean(context.stream?.[key], 160)) stream[key] = context.stream[key].trim();
  }
  return JSON.stringify({ account: context.account, channel: context.channel, stream, messages, target });
}

// Operator only. This process returns editable text. It has no chat transport,
// cloud provider or access to helper credentials through its environment.
export async function generateOperatorDraft(context, { signal, spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  const body = payload(context);
  const cancelled = () => fail('draft_cancelled', 'Draft cancelled.');
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [], { shell: false, stdio: ['pipe', 'pipe', 'ignore'],
        env: { HOME: homedir(), TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' } });
    } catch {
      reject(fail('model_unavailable', 'The on-device draft helper is unavailable.'));
      return;
    }
    let done = false;
    const chunks = [];
    let outputBytes = 0;
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(result);
    }
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(fail('model_timeout', 'The on-device draft timed out.')), timeoutMs);
    child.once('error', () => finish(fail('model_unavailable', 'The on-device draft helper is unavailable.')));
    child.stdin.once('error', error => {
      // The exit code gives a more useful explanation when a helper exits early.
      if (error.code !== 'EPIPE') finish(fail('model_failed', 'The on-device draft could not be prepared.'));
    });
    child.stdout.on('data', chunk => {
      if (done) return;
      outputBytes += chunk.length;
      if (outputBytes > 2048) return finish(fail('invalid_draft', 'The draft exceeded the output limit.'));
      chunks.push(chunk);
    });
    child.once('close', code => {
      if (done) return;
      if (code === 69) return finish(fail('model_unavailable', 'Apple Intelligence is unavailable on this Mac.'));
      if (code !== 0) return finish(fail('model_failed', 'The on-device model could not draft a reply.'));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!clean(result?.text, 300)) throw new Error();
        const reply = validateReply(result.text);
        // Also withhold plain-domain links that would autolink in a chat client.
        if (/(?:[\p{L}0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,63})\b|\b[a-z][a-z0-9+.-]*:\/\//iu.test(reply)) throw new Error();
        finish(null, reply);
      } catch {
        finish(fail('invalid_draft', 'The model returned no usable single-line draft.'));
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(body);
  });
}
