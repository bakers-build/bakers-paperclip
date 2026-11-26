import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { deliver } from '../bakers-bridge/core.mjs';

const { de } = JSON.parse(readFileSync(new URL('../bakers-bridge/messages.json', import.meta.url), 'utf8'));
const SECRET = 'test-secret';
const NOW = Date.parse('2026-11-26T10:00:00Z');
const PAPERCLIP = 'http://localhost:3100';

const ticket = (over = {}) => ({
  id: 't-1',
  identifier: 'SHOP-7',
  title: 'Gutscheine im Checkout',
  url: 'https://app.bakers.build/acme/ticket/shop-7',
  state: 'working',
  labels: [],
  frozen: false,
  links: [{ uri: `${PAPERCLIP}/ACM/issues/ACM-3`, title: 'Paperclip task' }],
  comments: [],
  ...over,
});

function sign(event, { secret = SECRET, at = NOW } = {}) {
  const rawBody = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, headers: { 'x-bakers-signature': `sha256=${sig}`, 'x-bakers-timestamp': String(Math.floor(at / 1000)) } };
}

const event = (type, data = {}, t = {}) => ({
  event_id: `ev-${type}-${JSON.stringify(data)}`,
  type,
  occurred_at: '2026-11-26T09:59:00Z',
  ticket: { uuid: 't-1', identifier: 'SHOP-7', ...t },
  data,
});

let tickets, comments, posts, logs, seen, deps;
beforeEach(() => {
  tickets = { 't-1': ticket() };
  comments = {};
  posts = [];
  logs = [];
  seen = new Set();
  deps = {
    now: () => NOW,
    messages: de,
    seen: { has: async (id) => seen.has(id), add: async (id) => void seen.add(id) },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    groups: [
      // Another group first: its secret does not verify, so its key never reads this group's tickets.
      { secret: 'other-group-secret', readTicket: async () => tickets['t-1'], post: async () => posts.push('wrong group') },
      {
        secret: SECRET,
        readTicket: async (uuid) => tickets[uuid] ?? null,
            post: async (task, text) => void posts.push({ task, text }),
      },
    ],
  };
});

describe('deliver: refusals', () => {
  it('refuses a wrong signature with 401 and logs it, posting nothing', async () => {
    const res = await deliver(sign(event('run.started', { state_at_start: 'working' }), { secret: 'other' }), deps);
    expect(res.status).toBe(401);
    expect(posts).toEqual([]);
    expect(logs.some((l) => l.level === 'warn' && /signature/.test(l.message))).toBe(true);
  });

  it('reads and posts with the group whose secret signed the delivery, only', async () => {
    await deliver(sign(event('run.started', { state_at_start: 'working' })), deps);
    expect(posts).toEqual([{ task: expect.any(Object), text: 'Wir arbeiten jetzt daran.' }]);
  });

  it('with a secret shared by several groups, posts with the group whose company holds the task', async () => {
    const elsewhere = [];
    deps.groups.unshift({ ...deps.groups[1], holds: async () => false, post: async (task, text) => void elsewhere.push(text) });
    await deliver(sign(event('run.started', { state_at_start: 'working' })), deps);
    expect(elsewhere).toEqual([]);
    expect(posts.map((p) => p.text)).toEqual(['Wir arbeiten jetzt daran.']);
  });

  it('refuses a delivery older than five minutes', async () => {
    const res = await deliver(sign(event('run.started', { state_at_start: 'working' }), { at: NOW - 6 * 60 * 1000 }), deps);
    expect(res.status).toBe(401);
    expect(posts).toEqual([]);
  });

  it('refuses an unknown ticket with 404 and logs it', async () => {
    const res = await deliver(sign(event('run.started', { state_at_start: 'working' }, { uuid: 'nope', identifier: 'X-1' })), deps);
    expect(res.status).toBe(404);
    expect(posts).toEqual([]);
    expect(logs.some((l) => l.level === 'warn' && /unknown ticket/.test(l.message))).toBe(true);
  });

  it('takes no other /issues/ link for the task: a GitHub issue, or a task of another company', async () => {
    tickets['t-1'] = ticket({ links: [{ uri: 'https://github.com/o/r/issues/12', title: 'GitHub' }, { uri: 'https://elsewhere.example/ZZZ/issues/ZZZ-9', title: 'x' }] });
    deps.groups[1].holds = async (task) => task.issue !== 'ZZZ-9';
    const res = await deliver(sign(event('run.started', { state_at_start: 'working' })), deps);
    expect(res.status).toBe(404);
    expect(posts).toEqual([]);
  });

  it('refuses a ticket without a Paperclip task, nor an ancestor with one, with 404', async () => {
    tickets['t-1'] = ticket({ links: [] });
    const res = await deliver(sign(event('run.started', { state_at_start: 'working' })), deps);
    expect(res.status).toBe(404);
  });

  it('refuses a body that is no event with 400', async () => {
    const rawBody = '{"hello":1}';
    const sig = createHmac('sha256', SECRET).update(rawBody).digest('hex');
    const res = await deliver({ rawBody, headers: { 'x-bakers-signature': `sha256=${sig}`, 'x-bakers-timestamp': String(NOW / 1000) } }, deps);
    expect(res.status).toBe(400);
  });
});

describe('deliver: each event once', () => {
  it('posts a redelivered event id once', async () => {
    const delivery = sign(event('run.started', { state_at_start: 'working' }));
    expect((await deliver(delivery, deps)).status).toBe(200);
    expect((await deliver(delivery, deps)).status).toBe(200);
    expect(posts).toHaveLength(1);
  });

  it('posts into the task the ticket links, as its identifier names it', async () => {
    await deliver(sign(event('run.started', { state_at_start: 'working' })), deps);
    expect(posts[0].task).toEqual({ issue: 'ACM-3', url: `${PAPERCLIP}/ACM/issues/ACM-3` });
  });
});

describe('deliver: texts', () => {
  const textOf = async (ev) => {
    await deliver(sign(ev), deps);
    return posts.map((p) => p.text);
  };

  it('a state change says the new state in plain words', async () => {
    expect(await textOf(event('ticket.state_changed', { from: 'plan', to: 'working' }))).toEqual(['Die Arbeit daran hat begonnen.']);
  });

  it('done says it is ready to try and links the ticket, nothing from the summaries', async () => {
    tickets['t-1'] = ticket({ state: 'done', comments: [{ id: 'c2', type: 'summary', created: '2026-11-26T09:00:00Z', body: '### 🧪 Manual review\nOpen https://shop.example.org/cart.' }] });
    expect(await textOf(event('ticket.state_changed', { from: 'review', to: 'done' }))).toEqual([
      'Das ist fertig und bereit zum Ausprobieren.\n\n[SHOP-7 · Gutscheine im Checkout](https://app.bakers.build/acme/ticket/shop-7)',
    ]);
  });

  it('a run start says what happens now', async () => {
    expect(await textOf(event('run.started', { state_at_start: 'plan' }))).toEqual(['Wir schreiben auf, wie wir es umsetzen.']);
  });

  it('a run that ends done without moving the ticket waits for a decision', async () => {
    expect(await textOf(event('run.finished', { state: 'done', state_at_start: 'working' }))).toEqual([de.runWaiting]);
  });

  it('a run that fails on an unfrozen ticket says the work is paused', async () => {
    expect(await textOf(event('run.finished', { state: 'failed', state_at_start: 'working' }))).toEqual([de.runPaused]);
  });

  it('a run that ends on a frozen ticket with a question says nothing: the question says it', async () => {
    tickets['t-1'] = ticket({ frozen: true, labels: ['Question'] });
    expect(await textOf(event('run.finished', { state: 'done', state_at_start: 'working' }))).toEqual([]);
  });

  it('a run that moved the ticket on says nothing: the state line says it', async () => {
    tickets['t-1'] = ticket({ state: 'review' });
    expect(await textOf(event('run.finished', { state: 'done', state_at_start: 'working' }))).toEqual([]);
  });

  it('a new comment, a summary too, posts nothing: summaries are written for developers', async () => {
    comments.s1 = { id: 's1', type: 'summary', body: '### 🎯 Outcome\nVouchers can now be redeemed.' };
    expect(await textOf(event('comment.created', { comment_id: 's1', type: 'summary' }))).toEqual([]);
  });

  it('a question posts its lead-in and the note', async () => {
    tickets['t-1'] = ticket({
      frozen: true,
      labels: ['Question'],
      comments: [
        { id: 'q0', type: 'summary', created: '2026-11-26T09:58:00Z', body: 'summary' },
        { id: 'q1', type: 'comment', created: '2026-11-26T09:57:00Z', body: 'Soll der Gutschein auch für Versand gelten?' },
      ],
    });
    expect(await textOf(event('ticket.labels_changed', { added: ['Question'], removed: [] }))).toEqual([
      'SHOP-7 · „Gutscheine im Checkout“ hat eine Frage:\n\nSoll der Gutschein auch für Versand gelten?',
    ]);
  });

  it('a technical problem posts its lead-in and the note, even beside a question', async () => {
    tickets['t-1'] = ticket({
      frozen: true,
      labels: ['Question', 'technical problem'],
      comments: [{ id: 'p1', type: 'comment', created: '2026-11-26T09:57:00Z', body: 'Die Datenbank ist nicht erreichbar.' }],
    });
    expect(await textOf(event('ticket.labels_changed', { added: ['technical problem'], removed: [] }))).toEqual([
      'Die Arbeit am Ticket „Gutscheine im Checkout“ hängt an einem technischen Problem, das keytec lösen muss:\n\nDie Datenbank ist nicht erreichbar.',
    ]);
  });

  it('another label added to a ticket frozen with a question posts nothing again', async () => {
    tickets['t-1'] = ticket({
      frozen: true,
      labels: ['Question', 'human-accept'],
      comments: [{ id: 'q1', type: 'comment', created: '2026-11-26T09:57:00Z', body: 'Soll der Gutschein auch für Versand gelten?' }],
    });
    expect(await textOf(event('ticket.labels_changed', { added: ['human-accept'], removed: [] }))).toEqual([]);
  });

  it('a label change on an unfrozen ticket posts nothing', async () => {
    tickets['t-1'] = ticket({ labels: ['Question'] });
    expect(await textOf(event('ticket.labels_changed', { added: ['Question'], removed: [] }))).toEqual([]);
  });

  it('a new preview link is posted behind the lead-in, without its agent-written title', async () => {
    expect(await textOf(event('ticket.link_added', { uri: 'https://shop-7.designbook.example.org/', title: 'Design SHOP-7' }))).toEqual([
      'Es gibt etwas zum Ansehen:\nhttps://shop-7.designbook.example.org/',
    ]);
  });

  it('a link that is no preview (a merge request) posts nothing', async () => {
    expect(await textOf(event('ticket.link_added', { uri: 'https://github.com/o/r/pull/3', title: 'MR' }))).toEqual([]);
  });

  it('an unknown event type posts nothing and is accepted', async () => {
    const res = await deliver(sign(event('ticket.renamed', {})), deps);
    expect(res.status).toBe(200);
    expect(posts).toEqual([]);
  });
});

describe('deliver: sub-tickets', () => {
  it('a sub-ticket without a task posts into its parent ticket’s task, behind its identifier', async () => {
    tickets['t-2'] = ticket({ id: 't-2', identifier: 'SHOP-8', title: 'Teil', links: [] });
    await deliver(sign(event('run.started', { state_at_start: 'working' }, { uuid: 't-2', identifier: 'SHOP-8', parent_uuid: 't-1' })), deps);
    expect(posts).toEqual([{ task: { issue: 'ACM-3', url: `${PAPERCLIP}/ACM/issues/ACM-3` }, text: 'SHOP-8 · Wir arbeiten jetzt daran.' }]);
  });
});
