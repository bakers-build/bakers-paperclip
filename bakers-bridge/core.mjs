// Pure core of the bakers-bridge: bakers.build's webhook (bb_webhook) in, the Hermes texts it
// calls for posted into the Paperclip task of its ticket. Every I/O comes through `deps`.
// Only fixed texts, the question's note and links reach the task: summaries are written for
// developers, so nothing from them is passed on (decided 2026-11-26).
// Rules are ported from hermes-bot ebfbc9e (poller/updates.mjs, questions.mjs, diff.mjs).
//
// `deliver` verifies and queues a delivery and answers at once (bakers.build waits 5 s);
// `drain` reads the ticket and posts, and keeps a delivery whose post failed for the next drain.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const QUESTION_LABEL = 'Question';
export const TECHNICAL_PROBLEM_LABEL = 'technical problem';
const MAX_AGE_S = 5 * 60;
const PAUSED = ['failed', 'expired', 'cancelled'];
// A drained delivery keeps this in its `delivery:<id>` key, so a later retry is still a duplicate.
const DONE = 'done';
// Sub-ticket levels walked up to a task, against a parent cycle.
const MAX_LEVELS = 10;

// A delivery remembers which secrets verified it by their hash, never the secret: at drain time
// every group that holds one of them may read the ticket, also one configured in between.
const fingerprint = (secret) => createHash('sha256').update(String(secret)).digest('hex');

const header = (headers, name) => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * bb_webhook's signature, as its guide's `verify`: `X-Bakers-Signature: sha256=<hex HMAC-SHA256 of
 * "<X-Bakers-Timestamp>.<raw body>">`, compared in constant time, the timestamp under 5 min old.
 */
export function verify(headers, rawBody, secret, now) {
  const sig = header(headers, 'x-bakers-signature') ?? '';
  const ts = header(headers, 'x-bakers-timestamp') ?? '';
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(sig)) return 'missing or malformed signature';
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'signature mismatch';
  if (!(Math.abs(now / 1000 - Number(ts)) < MAX_AGE_S)) return 'timestamp older than 5 min';
  return null;
}

// A link of kind design or ddev (updates.mjs preview).
function isPreview(uri) {
  if (/\/-\/merge_requests\/|\/artifacts\/|playwright-report/.test(uri)) return false;
  if (uri.includes('designbook')) return true;
  return !/\/-\/(pipelines|jobs|tree|commits|branches)/.test(uri) && uri.includes('.ddev.site');
}

const labelsOf = (t) => (t.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
const newest = (comments, keep) =>
  [...(comments ?? [])].filter(keep).sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];

function footer(t, m) {
  if (!t.url) return '';
  let text = `\n\n[${t.identifier} · ${t.title}](${t.url})`;
  if (t.origin) text += `\n${m.originLead} ${/^https?:\/\//i.test(t.origin) ? `<${t.origin}>` : t.origin}`;
  return text;
}

const isOpen = (t) => {
  const labels = labelsOf(t);
  return labels.includes(QUESTION_LABEL) || labels.includes(TECHNICAL_PROBLEM_LABEL);
};

/** The texts one event calls for, given the ticket as bakers.build returns it now. */
export async function texts(ev, t, deps) {
  const m = deps.messages;
  switch (ev.event) {
    case 'status_changed': {
      const text = m.states[ev.new_state];
      if (!text) return [];
      return [ev.new_state === 'done' ? text + footer(t, m) : text];
    }
    case 'claimed': {
      // The body's state is the one the ticket was claimed in; the read may be later.
      const text = m.runStart[ev.ticket.state ?? t.state];
      return text ? [text] : [];
    }
    case 'run_ended': {
      // bakers.build sends run_ended for failed, expired and cancelled runs only, without the
      // run's end: the newest run tells it. A run that moved the ticket on is told by its state
      // line, an open note by its lead-in.
      if (t.frozen || isOpen(t)) return [];
      const run = await deps.runs(t);
      return run && PAUSED.includes(run.state) && run.state_at_start === t.state ? [m.runPaused] : [];
    }
    default:
      return [];
  }
}

/**
 * What the ticket shows now that no event announces (bakers.build writes no activity for a label,
 * a freeze or a link): an open question or technical problem, and its preview links. Each has a
 * key, so it is posted once, with whichever event comes first.
 */
function extras(t, deps) {
  const m = deps.messages;
  const out = [];
  if (t.frozen && isOpen(t)) {
    const kind = labelsOf(t).includes(TECHNICAL_PROBLEM_LABEL) ? 'technicalProblemLead' : 'questionLead';
    // shortcut: the note is the newest non-summary comment; Hermes also bounded it by frozen_at, which the read does not return.
    const note = newest(t.comments, (c) => c.type !== 'summary');
    if (note) {
      const lead = m[kind].replace('{identifier}', () => t.identifier).replace('{title}', () => t.title);
      out.push({ key: `note:${note.id}`, text: `${lead}\n\n${note.body}` });
    }
  }
  for (const { uri } of t.links ?? []) {
    if (uri && isPreview(uri)) out.push({ key: `preview:${t.id}:${uri}`, text: `${m.previewLead}\n${uri}` });
  }
  return out;
}

/**
 * The Paperclip tasks a ticket may link: every link whose path ends in /<prefix>/issues/<PREFIX-n>.
 * Which one is the task decides the group's company (`holds`), not the host.
 */
export function tasksOf(t) {
  const found = [];
  for (const { uri } of t.links ?? []) {
    const issue = /\/([A-Za-z0-9]+)\/issues\/(\1-\d+)\/?(?:[?#].*)?$/.exec(uri)?.[2];
    if (issue) found.push({ issue, url: uri });
  }
  return found;
}

// One chain per kind of work: queue writes stay short, so an answer never waits for a drain.
const serial = () => {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
};
const queueWrite = serial();
const drainRun = serial();

/**
 * One webhook delivery, taken and queued. `deps.groups` holds one entry per bakers.build group:
 * its webhook `secret` and its own `readTicket`, `holds`, `runs`, `parentOf` and `post`.
 * The secrets that verify the signature pick the groups whose keys read the ticket at `drain`.
 * Returns {status, reason?}: 401 bad signature or stale, 400 not an event, 200 taken (also a
 * repeated X-Bakers-Delivery, posted once). `deps.store` is the plugin's persistent state.
 */
export async function deliver({ headers = {}, rawBody = '' }, deps) {
  let bad = 'no group configured';
  const verified = [];
  for (const g of deps.groups) {
    const why = verify(headers, rawBody, g.secret, deps.now());
    if (why) bad = why;
    else verified.push(fingerprint(g.secret));
  }
  if (!verified.length) {
    deps.log('warn', `refused webhook: ${bad}`);
    return { status: 401, reason: bad };
  }
  let ev;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    ev = null;
  }
  const id = header(headers, 'x-bakers-delivery') ?? ev?.id;
  if (!ev?.event || !ev.id || !ev.ticket?.uuid || !id) {
    deps.log('warn', 'refused webhook: not an event');
    return { status: 400, reason: 'not an event' };
  }
  const { store } = deps;
  return queueWrite(async () => {
    if (await store.get(`delivery:${id}`)) return { status: 200, reason: 'duplicate' };
    await store.set(`delivery:${id}`, { id, ev, groups: verified });
    await store.set('queue', [...((await store.get('queue')) ?? []), id]);
    return { status: 200 };
  });
}

/** Posts every queued delivery; one whose ticket read or post fails stays queued for the next drain. */
export function drain(deps) {
  return drainRun(async () => {
    for (const id of (await deps.store.get('queue')) ?? []) {
      const rec = await deps.store.get(`delivery:${id}`);
      try {
        if (rec && rec !== DONE) await handle(rec, deps);
      } catch (e) {
        deps.log('warn', `bakers delivery ${id} kept for the next drain: ${e.message}`);
        continue;
      }
      await queueWrite(async () => {
        await deps.store.set(`delivery:${id}`, DONE);
        await deps.store.set('queue', ((await deps.store.get('queue')) ?? []).filter((x) => x !== id));
      });
    }
  });
}

async function handle({ id, ev, groups }, deps) {
  // Several groups may share a secret: the one that reads the ticket and holds its task posts.
  let t = null;
  let task = null;
  let inherited = false;
  let group = null;
  for (const g of deps.groups.filter((x) => x.secret && groups.includes(fingerprint(x.secret)))) {
    const mine = await g.readTicket(ev.ticket.uuid);
    if (!mine) continue;
    t ??= mine;
    const held = async (candidates) => {
      for (const c of candidates) if (await (g.holds?.(c) ?? true)) return c;
      return null;
    };
    // bakers.build's body has no parent: a sub-ticket's own read leads up, level by level.
    let found = await held(tasksOf(mine));
    let up = mine;
    for (let level = 0; !found && level < MAX_LEVELS; level++) {
      up = await g.parentOf?.(up);
      if (!up) break;
      found = await held(tasksOf(up));
    }
    if (found) {
      [t, task, inherited, group] = [mine, found, up !== mine, g];
      break;
    }
  }
  // A group webhook sends every ticket of its projects; most have no task. Not a failure.
  if (!task) {
    deps.log('debug', `bakers delivery ${id}: ${t ? `no Paperclip task for ${t.identifier}` : `unknown ticket ${ev.ticket.identifier ?? ev.ticket.uuid}`}`);
    return;
  }
  // The group's own settings (its language) over the shared ones.
  deps = { ...deps, ...group };
  const posts = [...(await texts(ev, t, deps)).map((text, n) => ({ key: `posted:${id}:${n}`, text })), ...extras(t, deps)];
  for (const { key, text } of posts) {
    if (await deps.store.get(key)) continue;
    await deps.post(task, inherited && !text.startsWith(`${t.identifier} · `) ? `${t.identifier} · ${text}` : text);
    // Remembered after each post: a retried drain repeats none that landed.
    await deps.store.set(key, true);
  }
}
