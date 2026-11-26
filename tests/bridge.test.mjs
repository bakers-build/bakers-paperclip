import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { deliver, drain } from '../bakers-bridge/core.mjs';

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

// A body as bb_webhook's WebhookPayload builds it.
const event = (name, over = {}, t = {}) => ({
  event: name,
  id: randomUUID(),
  occurred: '2026-11-26T09:59:00+00:00',
  workspace: 'ws-1',
  project: 'p-1',
  ticket: { uuid: 't-1', identifier: 'SHOP-7', title: 'Gutscheine im Checkout', state: 'working', url: 'https://app.bakers.build/acme/ticket/shop-7', ...t },
  actor: null,
  previous_state: '',
  new_state: '',
  ...over,
});

// Signed as WebhookDelivery sends it: HMAC of "<timestamp>.<body>", the activity UUID as delivery.
function sign(ev, { secret = SECRET, at = NOW, rawBody = JSON.stringify(ev), sig } = {}) {
  const ts = String(Math.floor(at / 1000));
  return {
    rawBody,
    headers: {
      'x-bakers-event': ev.event,
      'x-bakers-delivery': ev.id,
      'x-bakers-timestamp': ts,
      'x-bakers-signature': sig ?? `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`,
    },
  };
}

let tickets, runs, parents, posts, logs, state, failPosts, deps;
beforeEach(() => {
  tickets = { 't-1': ticket() };
  runs = {};
  parents = {};
  posts = [];
  logs = [];
  state = new Map();
  failPosts = 0;
  deps = {
    now: () => NOW,
    store: {
      get: async (k) => state.get(k) ?? null,
      // As Paperclip's plugin_state: value_json is NOT NULL.
      set: async (k, v) => {
        if (v == null) throw new Error(`null value for ${k}`);
        state.set(k, v);
      },
    },
    log: (level, message, meta) => logs.push({ level, message, meta }),
    groups: [
      // Another group first: its secret does not verify, so its key never reads this group's tickets.
      { id: 'other', secret: 'other-group-secret', messages: de, readTicket: async () => tickets['t-1'], post: async () => posts.push('wrong group') },
      {
        id: 'acme',
        secret: SECRET,
        messages: de,
        readTicket: async (uuid) => tickets[uuid] ?? null,
        runs: async (t) => runs[t.id] ?? null,
        parentOf: async (t) => tickets[parents[t.id]] ?? null,
        post: async (task, text) => {
          if (failPosts-- > 0) throw new Error('Paperclip is down');
          posts.push({ task, text });
        },
      },
    ],
  };
});

/** Delivers and drains, as the worker does; returns the texts posted. */
const run = async (ev, opts) => {
  const res = await deliver(sign(ev, opts), deps);
  await drain(deps);
  return { res, texts: posts.map((p) => p.text) };
};
const textsOf = async (ev) => (await run(ev)).texts;

describe('deliver: signature and body', () => {
  it('accepts a delivery signed over "<timestamp>.<body>", as the guide’s verify checks it', async () => {
    const { res, texts } = await run(event('status_changed', { previous_state: 'plan', new_state: 'working' }));
    expect(res.status).toBe(200);
    expect(texts).toEqual([de.states.working]);
  });

  it('refuses a signature over the raw body alone (the assumed contract)', async () => {
    const ev = event('status_changed', { new_state: 'working' });
    const raw = JSON.stringify(ev);
    const { res, texts } = await run(ev, { sig: `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}` });
    expect(res.status).toBe(401);
    expect(texts).toEqual([]);
    expect(logs.some((l) => l.level === 'warn' && /signature/.test(l.message))).toBe(true);
  });

  it('refuses a missing signature', async () => {
    const ev = event('status_changed', { new_state: 'working' });
    const d = sign(ev);
    delete d.headers['x-bakers-signature'];
    expect((await deliver(d, deps)).status).toBe(401);
  });

  it('refuses a wrong secret', async () => {
    expect((await run(event('status_changed', { new_state: 'working' }), { secret: 'nope' })).res.status).toBe(401);
  });

  it('refuses a timestamp older than five minutes', async () => {
    const { res, texts } = await run(event('status_changed', { new_state: 'working' }), { at: NOW - 6 * 60 * 1000 });
    expect(res.status).toBe(401);
    expect(texts).toEqual([]);
  });

  it('refuses a signed body that is no event with 400', async () => {
    const ev = event('status_changed');
    expect((await deliver(sign(ev, { rawBody: '{"hello":1}' }), deps)).status).toBe(400);
    expect((await deliver(sign(ev, { rawBody: 'not json' }), deps)).status).toBe(400);
  });
});

describe('deliver: once per X-Bakers-Delivery', () => {
  it('posts a retried delivery once, also when the retry comes after a restart (state survives, memory not)', async () => {
    const ev = event('status_changed', { new_state: 'working' });
    expect((await run(ev)).res.status).toBe(200);
    // A retry: the same delivery id, a new timestamp and signature.
    expect((await run(ev, { at: NOW + 60_000 })).res.status).toBe(200);
    expect(posts).toHaveLength(1);
  });

  it('a delivery whose queue write was lost (a crash between the two writes) is queued again by its retry and posted once', async () => {
    const ev = event('status_changed', { new_state: 'working' });
    const { set } = deps.store;
    deps.store.set = async (k, v) => {
      if (k === 'queue') throw new Error('crash');
      return set(k, v);
    };
    await expect(deliver(sign(ev), deps)).rejects.toThrow('crash');
    deps.store.set = set;
    expect((await run(ev, { at: NOW + 60_000 })).res.status).toBe(200);
    await run(ev, { at: NOW + 120_000 });
    expect(posts.map((p) => p.text)).toEqual([de.states.working]);
  });

  it('answers before reading the ticket: the read and the post wait for the drain', async () => {
    const res = await deliver(sign(event('status_changed', { new_state: 'working' })), deps);
    expect(res.status).toBe(200);
    expect(posts).toEqual([]);
    await drain(deps);
    expect(posts).toHaveLength(1);
  });

  it('keeps a delivery whose post fails and posts it once on the next drain', async () => {
    failPosts = 1;
    const { res, texts } = await run(event('status_changed', { new_state: 'working' }));
    expect(res.status).toBe(200);
    expect(texts).toEqual([]);
    await drain(deps);
    await drain(deps);
    expect(posts.map((p) => p.text)).toEqual([de.states.working]);
  });

  it('a delivery with two posts whose second fails repeats neither on the next drain', async () => {
    tickets['t-1'] = ticket({ links: [...ticket().links, { uri: 'https://shop-7.ddev.site/', title: 'Preview' }] });
    const ev = event('status_changed', { new_state: 'review' });
    await deliver(sign(ev), deps);
    const post = deps.groups[1].post;
    let n = 0;
    deps.groups[1].post = async (task, text) => {
      if (n++ === 1) throw new Error('Paperclip is down');
      return post(task, text);
    };
    await drain(deps);
    await drain(deps);
    expect(posts.map((p) => p.text)).toEqual([de.states.review, `${de.previewLead}\nhttps://shop-7.ddev.site/`]);
  });
});

describe('drain: which task', () => {
  it('posts into the task the ticket links, with the group whose secret signed the delivery', async () => {
    await run(event('status_changed', { new_state: 'working' }));
    expect(posts).toEqual([{ task: { issue: 'ACM-3', url: `${PAPERCLIP}/ACM/issues/ACM-3` }, text: de.states.working }]);
  });

  it('with a secret shared by several groups, posts with the group whose company holds the task', async () => {
    const elsewhere = [];
    deps.groups.unshift({ ...deps.groups[1], id: 'shared', holds: async () => false, post: async (task, text) => void elsewhere.push(text) });
    await run(event('status_changed', { new_state: 'working' }));
    expect(elsewhere).toEqual([]);
    expect(posts.map((p) => p.text)).toEqual([de.states.working]);
  });

  it('a company set up with the secret after the delivery came in still gets its post, and no secret is stored', async () => {
    const ev = event('status_changed', { new_state: 'working' });
    const acme = deps.groups.pop();
    deps.groups.push({ ...acme, id: 'old', holds: async () => false });
    await deliver(sign(ev), deps);
    deps.groups.push(acme);
    await drain(deps);
    expect(posts.map((p) => p.text)).toEqual([de.states.working]);
    expect(JSON.stringify([...state.values()])).not.toContain(SECRET);
  });

  it('takes no other /issues/ link for the task: a GitHub issue, or a task of another company', async () => {
    tickets['t-1'] = ticket({ links: [{ uri: 'https://github.com/o/r/issues/12', title: 'GitHub' }, { uri: 'https://elsewhere.example/ZZZ/issues/ZZZ-9', title: 'x' }] });
    deps.groups[1].holds = async (task) => task.issue !== 'ZZZ-9';
    const { res, texts } = await run(event('status_changed', { new_state: 'working' }));
    expect(res.status).toBe(200);
    expect(texts).toEqual([]);
  });

  it('a ticket without a task (a group webhook sends every ticket) is answered 2xx, posts nothing, and is no failure', async () => {
    tickets['t-1'] = ticket({ links: [] });
    const { res, texts } = await run(event('status_changed', { new_state: 'working' }));
    expect(res.status).toBe(200);
    expect(texts).toEqual([]);
    expect(logs.filter((l) => l.level !== 'debug')).toEqual([]);
    expect(await deps.store.get('queue')).toEqual([]);
  });

  it('an unreadable ticket is answered 2xx, posts nothing, and is no failure', async () => {
    const { res, texts } = await run(event('status_changed', { new_state: 'working' }, { uuid: 'nope', identifier: 'X-1' }));
    expect(res.status).toBe(200);
    expect(texts).toEqual([]);
    expect(logs.filter((l) => l.level !== 'debug')).toEqual([]);
  });

  it('a sub-sub-ticket without a task posts into its grandparent’s task, behind its identifier', async () => {
    tickets['t-2'] = ticket({ id: 't-2', identifier: 'SHOP-8', title: 'Teil', links: [] });
    tickets['t-3'] = ticket({ id: 't-3', identifier: 'SHOP-9', title: 'Teil vom Teil', links: [] });
    parents['t-3'] = 't-2';
    parents['t-2'] = 't-1';
    await run(event('status_changed', { new_state: 'working' }, { uuid: 't-3', identifier: 'SHOP-9' }));
    expect(posts).toEqual([{ task: { issue: 'ACM-3', url: `${PAPERCLIP}/ACM/issues/ACM-3` }, text: `SHOP-9 · ${de.states.working}` }]);
  });
});

describe('drain: texts per event', () => {
  it('status_changed says the new state in plain words', async () => {
    expect(await textsOf(event('status_changed', { previous_state: 'plan', new_state: 'working' }))).toEqual([de.states.working]);
  });

  it('status_changed to done says it is ready to try and links the ticket, nothing from the summaries', async () => {
    tickets['t-1'] = ticket({ state: 'done', comments: [{ id: 'c2', type: 'summary', created: '2026-11-26T09:00:00Z', body: '### 🧪 Manual review\nOpen https://shop.example.org/cart.' }] });
    expect(await textsOf(event('status_changed', { previous_state: 'review', new_state: 'done' }))).toEqual([
      'Das ist fertig und bereit zum Ausprobieren.\n\n[SHOP-7 · Gutscheine im Checkout](https://app.bakers.build/acme/ticket/shop-7)',
    ]);
  });

  it('claimed says what happens now in the state it was claimed in', async () => {
    expect(await textsOf(event('claimed', {}, { state: 'plan' }))).toEqual([de.runStart.plan]);
  });

  it('run_ended says paused when the newest run failed in the ticket’s state and it is not frozen', async () => {
    runs['t-1'] = { state: 'failed', state_at_start: 'working' };
    expect(await textsOf(event('run_ended'))).toEqual([de.runPaused]);
  });

  it('run_ended says paused for an expired or cancelled run too', async () => {
    runs['t-1'] = { state: 'cancelled', state_at_start: 'working' };
    expect(await textsOf(event('run_ended'))).toEqual([de.runPaused]);
  });

  it('run_ended on a frozen ticket says nothing', async () => {
    tickets['t-1'] = ticket({ frozen: true });
    runs['t-1'] = { state: 'failed', state_at_start: 'working' };
    expect(await textsOf(event('run_ended'))).toEqual([]);
  });

  it('run_ended for a run that started in another state says nothing: the state line says it', async () => {
    tickets['t-1'] = ticket({ state: 'review' });
    runs['t-1'] = { state: 'failed', state_at_start: 'working' };
    expect(await textsOf(event('run_ended'))).toEqual([]);
  });

  it.each(['created', 'assigned', 'review_requested', 'review_completed', 'renamed'])('%s posts nothing and is answered 2xx', async (name) => {
    const { res, texts } = await run(event(name));
    expect(res.status).toBe(200);
    expect(texts).toEqual([]);
  });
});

describe('drain: question, technical problem and preview, on whichever event comes next', () => {
  const asked = (over = {}) =>
    ticket({
      frozen: true,
      labels: ['Question'],
      comments: [
        { id: 'q0', type: 'summary', created: '2026-11-26T09:58:00Z', body: 'summary' },
        { id: 'q1', type: 'comment', created: '2026-11-26T09:57:00Z', body: 'Soll der Gutschein auch für Versand gelten?' },
      ],
      ...over,
    });

  it('a frozen ticket with a question posts its lead-in and the note, once across events', async () => {
    tickets['t-1'] = asked();
    runs['t-1'] = { state: 'failed', state_at_start: 'working' };
    await run(event('run_ended'));
    await run(event('assigned'));
    expect(posts.map((p) => p.text)).toEqual(['SHOP-7 · „Gutscheine im Checkout“ hat eine Frage:\n\nSoll der Gutschein auch für Versand gelten?']);
  });

  it('a technical problem posts its lead-in and the note, even beside a question', async () => {
    tickets['t-1'] = asked({ labels: ['Question', 'technical problem'], comments: [{ id: 'p1', type: 'comment', created: '2026-11-26T09:57:00Z', body: 'Die Datenbank ist nicht erreichbar.' }] });
    expect(await textsOf(event('assigned'))).toEqual([
      'Die Arbeit am Ticket „Gutscheine im Checkout“ hängt an einem technischen Problem, das keytec lösen muss:\n\nDie Datenbank ist nicht erreichbar.',
    ]);
  });

  it('a comment added while still frozen (the answer, before the unfreeze) posts no second lead-in', async () => {
    tickets['t-1'] = asked();
    await run(event('assigned'));
    tickets['t-1'] = asked({ comments: [{ id: 'a1', type: 'comment', created: '2026-11-26T11:00:00Z', body: 'Answered in Paperclip by Requester: ja.' }] });
    await run(event('assigned'));
    expect(posts).toHaveLength(1);
  });

  it('a later question, after the ticket was seen unfrozen, posts again', async () => {
    tickets['t-1'] = asked();
    await run(event('assigned'));
    tickets['t-1'] = ticket();
    await run(event('assigned'));
    tickets['t-1'] = asked({ comments: [{ id: 'q2', type: 'comment', created: '2026-11-26T11:00:00Z', body: 'Und für Geschenkkarten?' }] });
    await run(event('assigned'));
    expect(posts.map((p) => p.text)).toEqual([expect.stringContaining('Versand'), expect.stringContaining('Geschenkkarten')]);
  });

  it('an unfrozen ticket with the label posts no question', async () => {
    tickets['t-1'] = asked({ frozen: false });
    expect(await textsOf(event('assigned'))).toEqual([]);
  });

  it('a preview link is posted once behind the lead-in, without its title; a merge request link is not', async () => {
    tickets['t-1'] = ticket({
      links: [...ticket().links, { uri: 'https://shop-7.designbook.example.org/', title: 'Design SHOP-7' }, { uri: 'https://github.com/o/r/pull/3', title: 'MR' }],
    });
    await run(event('status_changed', { new_state: 'review' }));
    await run(event('review_requested'));
    expect(posts.map((p) => p.text)).toEqual([de.states.review, `${de.previewLead}\nhttps://shop-7.designbook.example.org/`]);
  });
});
