// Pure core of the bakers-bridge: one bakers.build webhook delivery in, the Hermes texts it
// calls for posted into the Paperclip task of its ticket. Every I/O comes through `deps`.
// Text rules are ported from hermes-bot ebfbc9e (poller/updates.mjs, questions.mjs, diff.mjs).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const QUESTION_LABEL = 'Question';
export const TECHNICAL_PROBLEM_LABEL = 'technical problem';
const MAX_SKEW_MS = 5 * 60 * 1000;
const ENDED = ['done', 'failed', 'expired', 'cancelled'];

// Words of the tool, not of the requester (updates.mjs INTERNAL).
const INTERNAL = [
  /`|\b[A-Z][A-Z0-9]*-\d+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  /\b(?:qualification|matt|superpowers|deploy-and-release|opus|sonnet|haiku|fable|claude|codex)\b/i,
];
const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|(?<!\w)[*_]|[*_](?!\w)/g, '').trim();

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

/** The lines of the first section whose heading matches `title` (diff.mjs section). */
export function section(markdown, title) {
  const lines = (markdown ?? '').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && title.test(l));
  if (start < 0) return [];
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The plain sentences among the first two of a summary's Outcome section. */
export function outcome(markdown) {
  const text = section(markdown, /outcome/i)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''))
    .join(' ')
    .trim();
  return text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .filter((s) => s && !INTERNAL.some((r) => r.test(s)))
    .map(plain);
}

// The customer-facing part of a summary's Manual review: no login links, MRs, pipelines or code lines.
function manualReview(markdown) {
  const kept = [];
  let inCode = false;
  for (const line of section(markdown, /manual review/i)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || /\/user\/(reset|login)\b|\/-\/merge_requests\/|\/pull\/\d|\/-\/pipelines\b/.test(line) || /^\s*(?:[-*]\s+)?`[^`]+`\s*$/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// A host exactly one DNS label under a zone, https, no credentials or port.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const onZone = (url, zones) => {
  const authority = /^https:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(url)?.[1].toLowerCase();
  if (!authority || !URL.canParse(url)) return false;
  return zones.some((z) => authority.endsWith(`.${z}`) && LABEL.test(authority.slice(0, -z.length - 1)));
};

/** Links of a summary's Manual review on a preview zone, each once (updates.mjs previewLinks). */
export function previewLinks(markdown, zones) {
  if (!zones.length) return [];
  const found = new Map();
  let inCode = false;
  for (const line of section(markdown, /manual review/i)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(/\[([^\]]*)\]\(\s*([^)\s]+)\s*\)|<(https:\/\/[^>\s]+)>|(https:\/\/[^\s<>()[\]]+)/gi)) {
      const url = m[2] ?? m[3] ?? m[4].replace(/[.,;:!?)]+$/, '');
      if (found.has(url) || !onZone(url, zones)) continue;
      const label = plain(m[1] ?? '');
      found.set(url, INTERNAL.some((r) => r.test(label)) ? '' : label);
    }
  }
  return [...found].map(([url, text]) => ({ url, text }));
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
      let text = m.states[d.to];
      if (!text) return [];
      if (d.to === 'done') {
        const hint = manualReview(newest(t.comments, (c) => c.type === 'summary')?.body ?? '');
        text += (hint ? `\n\n${m.testHint}\n\n${hint}` : `\n\n${m.noTestHint}`) + footer(t, m);
      }
      return [text];
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
    case 'comment.created': {
      if (d.type !== 'summary') return [];
      const c = await deps.readComment(t.id, d.comment_id);
      if (!c || c.type !== 'summary') return [];
      const out = [];
      const sentences = outcome(c.body);
      if (sentences.length) out.push(sentences.join(' '));
      for (const l of previewLinks(c.body, deps.zones ?? [])) out.push(`${m.previewLead} ${l.text}`.trim() + `\n${l.url}`);
      return out;
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
      const title = INTERNAL.some((r) => r.test(d.title ?? '')) ? '' : plain(d.title ?? '');
      return [`${m.previewLead} ${title}`.trim() + `\n${d.uri}`];
    }
    default:
      return [];
  }
}

/** The Paperclip task a ticket links: a link under PAPERCLIP_PUBLIC_URL ending in /issues/<id>. */
export function taskOf(t, paperclipUrl) {
  const base = paperclipUrl.replace(/\/+$/, '');
  for (const { uri } of t.links ?? []) {
    if (!uri.startsWith(`${base}/`)) continue;
    const issue = /\/issues\/([^/?#]+)\/?(?:[?#].*)?$/.exec(uri)?.[1];
    if (issue) return { issue: decodeURIComponent(issue), url: uri };
  }
  return null;
}

/**
 * One webhook delivery. Returns {status, reason?}: 401 bad signature or stale, 400 no event,
 * 404 unknown ticket or no task, 200 handled (also a repeated event id, posted once).
 */
export async function deliver({ headers, rawBody }, deps) {
  const bad = verify(headers ?? {}, rawBody ?? '', deps.secret, deps.now());
  if (bad) {
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
  const t = await deps.readTicket(ev.ticket.uuid);
  if (!t) {
    deps.log('warn', `refused webhook: unknown ticket ${ev.ticket.identifier ?? ev.ticket.uuid}`, { event_id: ev.event_id });
    return { status: 404, reason: 'unknown ticket' };
  }
  let task = taskOf(t, deps.paperclipUrl);
  let inherited = false;
  // shortcut: one ancestor level, from the event's parent_uuid; walk further once bakers returns parents.
  if (!task && ev.ticket.parent_uuid) {
    const parent = await deps.readTicket(ev.ticket.parent_uuid);
    task = parent && taskOf(parent, deps.paperclipUrl);
    inherited = Boolean(task);
  }
  if (!task) {
    deps.log('warn', `refused webhook: unknown ticket ${t.identifier}: no Paperclip task`, { event_id: ev.event_id });
    return { status: 404, reason: 'no task' };
  }
  for (const text of await texts(ev, t, deps)) {
    await deps.post(task, inherited && !text.startsWith(`${t.identifier} · `) ? `${t.identifier} · ${text}` : text);
  }
  // Remembered after posting: a failed post is retried by bakers' redelivery.
  await deps.seen.add(ev.event_id);
  return { status: 200 };
}
