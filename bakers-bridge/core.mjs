// Pure core of the bakers-bridge: one bakers.build webhook delivery in, the Hermes texts it
// calls for posted into the Paperclip task of its ticket. Every I/O comes through `deps`.
// Only fixed texts, the question's note and links reach the task: summaries are written for
// developers, so nothing from them is passed on (decided 2026-11-26).
// Rules are ported from hermes-bot ebfbc9e (poller/updates.mjs, questions.mjs, diff.mjs).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const QUESTION_LABEL = 'Question';
export const TECHNICAL_PROBLEM_LABEL = 'technical problem';
const MAX_SKEW_MS = 5 * 60 * 1000;
const ENDED = ['done', 'failed', 'expired', 'cancelled'];

const header = (headers, name) => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Checks `X-Bakers-Signature: sha256=<hex HMAC of the raw body>` and a timestamp within ±5 min. */
export function verify(headers, rawBody, secret, now) {
  const sig = /^sha256=([0-9a-f]{64})$/.exec(header(headers, 'x-bakers-signature') ?? '')?.[1];
  const at = Number(header(headers, 'x-bakers-timestamp')) * 1000;
  if (!secret || !sig) return 'missing or malformed signature';
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), expected)) return 'signature mismatch';
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) return 'timestamp outside ±5 min';
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

/** The texts one event calls for, given the ticket as bakers.build returns it now. */
export async function texts(ev, t, deps) {
  const m = deps.messages;
  const d = ev.data ?? {};
  const labels = labelsOf(t);
  const open = labels.includes(QUESTION_LABEL) || labels.includes(TECHNICAL_PROBLEM_LABEL);
  switch (ev.type) {
    case 'ticket.state_changed': {
      const text = m.states[d.to];
      if (!text) return [];
      return [d.to === 'done' ? text + footer(t, m) : text];
    }
    case 'run.started':
      return m.runStart[d.state_at_start] ? [m.runStart[d.state_at_start]] : [];
    case 'run.finished': {
      // A run that moved the ticket on is told by its state line; an open note by its lead-in.
      if (!ENDED.includes(d.state) || d.state_at_start !== t.state || open) return [];
      if (d.state === 'done') return [m.runWaiting];
      // shortcut: Hermes waited one poll for a late label or freeze; here the ticket read decides at once.
      return t.frozen ? [] : [m.runPaused];
    }
    case 'ticket.labels_changed': {
      if (!t.frozen || !open) return [];
      const kind = labels.includes(TECHNICAL_PROBLEM_LABEL) ? 'technicalProblemLead' : 'questionLead';
      // shortcut: the note is the newest non-summary comment; Hermes also bounded it by frozen_at, which the read does not return.
      const note = newest(t.comments, (c) => c.type !== 'summary');
      if (!note) return [];
      const lead = m[kind].replace('{identifier}', () => t.identifier).replace('{title}', () => t.title);
      return [`${lead}\n\n${note.body}`];
    }
    case 'ticket.link_added': {
      if (!d.uri || !isPreview(d.uri)) return [];
      return [`${m.previewLead}\n${d.uri}`];
    }
    default:
      return [];
  }
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

/**
 * One webhook delivery. `deps.groups` holds one entry per bakers.build group: its webhook
 * `secret` and its own `readTicket`, `holds` and `post`. The secret that verifies the
 * signature picks the group, so a delivery reads only its own group's tickets.
 * Returns {status, reason?}: 401 bad signature or stale, 400 no event, 404 unknown ticket or
 * no task, 200 handled (also a repeated event id, posted once).
 */
export async function deliver({ headers, rawBody }, deps) {
  let bad = 'no group configured';
  const verified = [];
  for (const g of deps.groups) {
    const why = verify(headers ?? {}, rawBody ?? '', g.secret, deps.now());
    if (why) bad = why;
    else verified.push(g);
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
  if (!ev?.event_id || !ev.type || !ev.ticket?.uuid) {
    deps.log('warn', 'refused webhook: not an event');
    return { status: 400, reason: 'not an event' };
  }
  if (await deps.seen.has(ev.event_id)) return { status: 200, reason: 'duplicate' };
  // Several groups may share a secret: the one that reads the ticket and holds its task posts.
  let t = null;
  let task = null;
  let inherited = false;
  let group = null;
  for (const g of verified) {
    const mine = await g.readTicket(ev.ticket.uuid);
    if (!mine) continue;
    t ??= mine;
    const held = async (candidates) => {
      for (const c of candidates) if (await (g.holds?.(c) ?? true)) return c;
      return null;
    };
    let found = await held(tasksOf(mine));
    let up = false;
    // shortcut: one ancestor level, from the event's parent_uuid; walk further once bakers returns parents.
    if (!found && ev.ticket.parent_uuid) {
      const parent = await g.readTicket(ev.ticket.parent_uuid);
      found = parent && (await held(tasksOf(parent)));
      up = Boolean(found);
    }
    if (found) {
      [t, task, inherited, group] = [mine, found, up, g];
      break;
    }
  }
  if (!t) {
    deps.log('warn', `refused webhook: unknown ticket ${ev.ticket.identifier ?? ev.ticket.uuid}`, { event_id: ev.event_id });
    return { status: 404, reason: 'unknown ticket' };
  }
  if (!task) {
    deps.log('warn', `refused webhook: unknown ticket ${t.identifier}: no Paperclip task`, { event_id: ev.event_id });
    return { status: 404, reason: 'no task' };
  }
  // The group's own settings (its language) over the shared ones.
  deps = { ...deps, ...group };
  for (const text of await texts(ev, t, deps)) {
    await deps.post(task, inherited && !text.startsWith(`${t.identifier} · `) ? `${t.identifier} · ${text}` : text);
  }
  // Remembered after posting: a failed post is retried by bakers' redelivery.
  await deps.seen.add(ev.event_id);
  return { status: 200 };
}
