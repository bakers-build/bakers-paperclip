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
    paperclipUrl: PAPERCLIP,
    zones: ['preview.example.org'],
    messages: de,
    seen: { has: async (id) => seen.has(id), add: async (id) => void seen.add(id) },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    groups: [
      // Another group first: its secret does not verify, so its key never reads this group's tickets.
      { secret: 'other-group-secret', readTicket: async () => tickets['t-1'], readComment: async () => null, post: async () => posts.push('wrong group') },
      {
        secret: SECRET,
        readTicket: async (uuid) => tickets[uuid] ?? null,
        readComment: async (_ticket, id) => comments[id] ?? null,
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

  it('done adds where to test from the latest summary and the ticket link', async () => {
    tickets['t-1'] = ticket({
      state: 'done',
      comments: [
        { id: 'c1', type: 'summary', created: '2026-11-25T10:00:00Z', body: '### 🧪 Manual review\nOld.' },
        { id: 'c2', type: 'summary', created: '2026-11-26T09:00:00Z', body: '### 🎯 Outcome\nDone.\n\n### 🧪 Manual review\nOpen https://shop.preview.example.org/cart and redeem a voucher.\n`git log a..b`\n\n### ➡️ Next action\nMerge.' },
      ],
    });
    const [text] = await textOf(event('ticket.state_changed', { from: 'review', to: 'done' }));
    expect(text).toBe(
      'Das ist fertig und bereit zum Ausprobieren.\n\nWo und wie du es testen kannst:\n\nOpen https://shop.preview.example.org/cart and redeem a voucher.\n\n' +
        '[SHOP-7 · Gutscheine im Checkout](https://app.bakers.build/acme/ticket/shop-7)',
    );
  });

  it('done without a manual review says the ticket does not say where to test yet', async () => {
    tickets['t-1'] = ticket({ state: 'done' });
    const [text] = await textOf(event('ticket.state_changed', { from: 'review', to: 'done' }));
    expect(text).toContain('Im Ticket steht noch nicht, wo oder wie du das testen kannst.');
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

  it('a new summary posts its first two plain Outcome sentences, without identifiers or code', async () => {
    comments.s1 = {
      id: 's1',
      type: 'summary',
      body: '### 🎯 Outcome\nVouchers can now be redeemed in the checkout. See SHOP-7 for details. The `cart` total updates.\n\n### ✅ Success\nAll green.',
    };
    expect(await textOf(event('comment.created', { comment_id: 's1', type: 'summary' }))).toEqual(['Vouchers can now be redeemed in the checkout.']);
  });

  it('a new summary posts each preview link of its Manual review on a preview zone once', async () => {
    comments.s2 = {
      id: 's2',
      type: 'summary',
      body: '### 🎯 Outcome\nReady.\n\n### 🧪 Manual review\n[Checkout](https://shop.preview.example.org/cart) and https://evil.example.com/x and https://shop.preview.example.org/cart again.',
    };
    expect(await textOf(event('comment.created', { comment_id: 's2', type: 'summary' }))).toEqual([
      'Ready.',
      'Es gibt etwas zum Ansehen: Checkout\nhttps://shop.preview.example.org/cart',
    ]);
  });

  it('a comment that is no summary posts nothing', async () => {
    comments.n1 = { id: 'n1', type: 'plan', body: '### 🎯 Outcome\nSecret plan.' };
    expect(await textOf(event('comment.created', { comment_id: 'n1', type: 'plan' }))).toEqual([]);
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

  it('a label change on an unfrozen ticket posts nothing', async () => {
    tickets['t-1'] = ticket({ labels: ['Question'] });
    expect(await textOf(event('ticket.labels_changed', { added: ['Question'], removed: [] }))).toEqual([]);
  });

  it('a new preview link is posted with its title', async () => {
    expect(await textOf(event('ticket.link_added', { uri: 'https://shop-7.designbook.example.org/', title: 'Design' }))).toEqual([
      'Es gibt etwas zum Ansehen: Design\nhttps://shop-7.designbook.example.org/',
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
