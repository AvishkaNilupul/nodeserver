import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateReply } from './text-policy.mjs';

const executable = fileURLToPath(new URL('../private/operator-draft', import.meta.url));
const safeLogin = value => typeof value === 'string' && /^[a-z0-9_]{1,25}$/i.test(value);
const clean = (value, limit) => typeof value === 'string'
  && value.trim().length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const noReply = () => fail('no_reply', 'There’s nothing useful to reply to here.');

// A small model can describe the exchange even when asked for the words to
// send. Keep that commentary out of the editable reply.
function isCommentary(text) {
  return /^(?:no[_ -]reply\b|no (?:reply|action|response) (?:is )?(?:required|needed|necessary)\b|(?:suggested|draft|possible|operator(?:'s)?) (?:reply|response)\b|(?:reply|response|analysis|summary|action|operator)\s*:)/i.test(text)
    || /^(?:acknowledged|acknowledges?|acknowledging|recognizes?|recognizing|responds? to|responding to|summarizes?|summarizing)\s+(?:(?:the|their|this|that|your)\s+)?(?:comment|message|viewer|user|question|sentiment|observation|opinion|concern)\b/i.test(text)
    || /^(?:(?:the|this|that|their)\s+)?(?:message|comment|statement|question|viewer|user|speaker)\s+(?:contains|expresses|asks|states|suggests|is asking|is expressing|is making|does not|doesn't|indicates|appears)\b/i.test(text)
    || /^(?:this|that|it) (?:is|was) (?:an? )?(?:subjective|factual|neutral|negative) (?:statement|comment|observation|opinion)\b/i.test(text)
    || /\b(?:no factual (?:claims?|information) to (?:verify|check)|(?:operator|assistant) should (?:reply|respond|acknowledge)|as (?:an? )?(?:ai|language model))\b/i.test(text)
    || /^(?:\*.*\*|\(.*\)|\[.*\])$/u.test(text)
    || /^(?:thanks for sharing (?:your (?:thoughts|opinion|perspective)|that)|i understand your (?:sentiment|perspective)|great (?:question|point)|interesting (?:point|perspective))[.! ]*$/i.test(text);
}

function message(row) {
  return safeLogin(row?.author) && clean(row.text, 500) ? { author: row.author, text: row.text.trim() } : null;
}

function payload(context, selectedConversation) {
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
  return JSON.stringify({ account: context.account, channel: context.channel, stream, messages, target, selectedConversation });
}

// Operator only. This process returns editable text. It has no chat transport,
// cloud provider or access to helper credentials through its environment.
export async function generateOperatorDraft(context, { signal, spawnImpl = spawn, timeoutMs = 30_000, selectedConversation = false } = {}) {
  const body = payload(context, selectedConversation === true);
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
        if (result?.disposition === 'no_reply') return finish(noReply());
        if (!clean(result?.text, 300)) throw new Error();
        const reply = validateReply(result.text);
        // Also withhold plain-domain links that would autolink in a chat client.
        if (/(?:[\p{L}0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,63})\b|\b[a-z][a-z0-9+.-]*:\/\//iu.test(reply)) throw new Error();
        if (isCommentary(reply)) return finish(noReply());
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
