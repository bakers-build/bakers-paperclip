// bakers-demo: the bakers.build stand-in for the local demo and the e2e tests.
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDemo } from '../demo/server.mjs';
import { connect } from '../bakers-bridge/bakers-client.mjs';
import { verify } from '../bakers-bridge/core.mjs';

const KEY = 'demo-key';
const SECRET = 'demo-secret';
// The tools' schemas as bakers.build served them (bakers tools <name> --schema), recorded 2026-11-26.
const dir = new URL('../demo/tools/', import.meta.url);
const fixtures = Object.fromEntries(readdirSync(dir).map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));

let demo, hook, deliveries, bakers;
beforeEach(async () => {
  deliveries = [];
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      deliveries.push({ headers: req.headers, rawBody: body, event: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise((r) => hook.listen(0, r));
  demo = await startDemo({ port: 0, apiKey: KEY, secret: SECRET, webhookUrl: `http://127.0.0.1:${hook.address().port}/hook`, stepMs: 1 });
  bakers = await connect(`${demo.url}/mcp`, KEY);
});
afterEach(async () => {
  await bakers.close();
  await demo.close();
  hook.close();
});

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('bakers-demo tools', () => {
  it('serves exactly the allowlisted tools, in the shapes bakers.build serves them', async () => {
    const tools = await bakers.list();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.values(fixtures).map((f) => f.name).sort());
    for (const t of tools) expect(t.inputSchema).toEqual(fixtures[t.name.replace('bakers_', '')].inputSchema);
  });

  it('refuses a wrong key', async () => {
    await expect(connect(`${demo.url}/mcp`, 'wrong')).rejects.toThrow();
  });

  it('lists its group’s readable projects and refuses the foreign group’s', async () => {
    expect((await bakers.call('bakers_project_read', { project: 'DEMO' })).name).toBeTruthy();
    expect(await bakers.call('bakers_project_read', { project: 'FOREIGN' })).toBeNull();
    expect(await bakers.call('bakers_ticket_create', { title: 'x', workflow: 'bb_work', project: 'FOREIGN' })).toBeNull();
  });

  it('creates, reads, comments, labels and links a ticket, and shows it in /state', async () => {
    const requester = await bakers.call('bakers_user_read', { user: 'requester@example.org' });
    const t = await bakers.call('bakers_ticket_create', { title: 'Gutscheine', workflow: 'bb_work', project: 'DEMO', description: 'd', reviewers: [requester.uuid] });
    expect(t).toMatchObject({ identifier: 'DEMO-2', state: 'qualification', reviewers: [{ uuid: requester.uuid, mail: 'requester@example.org' }] });
    expect(t.url).toMatch(/^http/);
    await bakers.call('bakers_comment_create', { ticket: t.uuid, type: 'qualification', body: 'q' });
    await bakers.call('bakers_ticket_update', { ticket: t.uuid, labels_add: ['human-accept'], links_add: [{ uri: 'http://localhost:3100/ACM/issues/ACM-1', title: 'Paperclip task' }] });
    const read = await bakers.call('bakers_ticket_read', { ticket: 'DEMO-2' });
    expect(read).toMatchObject({ id: t.uuid, labels: ['human-accept'], links: [{ uri: 'http://localhost:3100/ACM/issues/ACM-1' }] });
    expect(read.comments.map((c) => c.type)).toEqual(['qualification']);
    const state = await (await fetch(`${demo.url}/state`)).json();
    expect(state.tickets.find((x) => x.id === t.uuid).title).toBe('Gutscheine');
  });

  it('finds an existing ticket for the prior-art probe', async () => {
    expect((await bakers.call('bakers_ticket_search', { query: 'ticket', project: 'DEMO' })).length).toBeGreaterThan(0);
  });
});

describe('bakers-demo events', () => {
  it('signs every event so the bridge accepts it', async () => {
    const t = await bakers.call('bakers_ticket_create', { title: 'x', workflow: 'bb_work', project: 'DEMO' });
    await bakers.call('bakers_ticket_transition', { ticket: t.uuid, state: 'working' });
    await until(() => deliveries.length >= 1);
    expect(verify(deliveries[0].headers, deliveries[0].rawBody, SECRET, Date.now())).toBeNull();
    expect(deliveries[0].event).toMatchObject({ type: 'ticket.state_changed', ticket: { uuid: t.uuid }, data: { from: 'qualification', to: 'working' } });
  });

  it('POST /emit sends a signed custom event', async () => {
    const res = await fetch(`${demo.url}/emit`, { method: 'POST', body: JSON.stringify({ type: 'run.started', ticket: 'DEMO-1', data: { state_at_start: 'working' } }) });
    expect(res.status).toBe(200);
    await until(() => deliveries.length === 1);
    expect(deliveries[0].event).toMatchObject({ type: 'run.started', ticket: { identifier: 'DEMO-1' } });
  });

  it('the simulated conductor plays its scripted run once: start, summary, question; after the answer review, done and a preview', async () => {
    const t = await bakers.call('bakers_ticket_create', { title: 'x', workflow: 'bb_work', project: 'DEMO' });
    await bakers.call('bakers_ticket_transition', { ticket: t.uuid, state: 'working' });
    const [conductor] = await bakers.call('bakers_conductor_list', { project: 'DEMO' });
    await bakers.call('bakers_ticket_update', { ticket: t.uuid, conductor: conductor.uuid });
    await until(() => deliveries.some((d) => d.event.type === 'ticket.labels_changed'));
    const asked = await bakers.call('bakers_ticket_read', { ticket: t.uuid });
    expect(asked).toMatchObject({ state: 'working', frozen: true, labels: ['Question'] });

    await bakers.call('bakers_comment_create', { ticket: t.uuid, type: 'comment', body: 'Answered in Paperclip by Rita:\n\nJa.' });
    await bakers.call('bakers_ticket_update', { ticket: t.uuid, labels_remove: ['Question'], frozen: false });
    await until(() => deliveries.some((d) => d.event.type === 'ticket.state_changed' && d.event.data.to === 'done'));
    await new Promise((r) => setTimeout(r, 50));

    const steps = deliveries.map((d) => `${d.event.type}:${d.event.data.to ?? d.event.data.state_at_start ?? d.event.data.type ?? d.event.data.added?.[0] ?? d.event.data.state ?? ''}`);
    expect(steps).toEqual([
      'ticket.state_changed:working',
      'run.started:working',
      'comment.created:summary',
      'comment.created:comment',
      'ticket.labels_changed:Question',
      'run.finished:working',
      'comment.created:comment',
      'ticket.labels_changed:',
      'run.started:working',
      'ticket.state_changed:review',
      'run.finished:working',
      'run.started:review',
      'comment.created:summary',
      'ticket.link_added:',
      'ticket.state_changed:done',
      'run.finished:review',
    ]);
    expect(new Set(deliveries.map((d) => d.event.event_id)).size).toBe(deliveries.length);
  });
});
