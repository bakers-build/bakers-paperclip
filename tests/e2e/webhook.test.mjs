// AC1, AC2, AC8 against the local bakers.build and its real Demo group webhook (pnpm bakers:seed):
// a ticket change reaches its task once; a bad signature or a stale timestamp is refused; a ticket
// without a task is taken and posts nothing.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { bakers, comments, deliver, group, linkedTicket, posted, tool } from './fixture.mjs';

let g, linked;
beforeAll(async () => {
  g = await group();
  linked = await linkedTicket(g);
});

it('posts a state change into the task, as the PM agent, once', async () => {
  const call = (name, args) => tool(linked.bakers, name, { ticket: linked.ticket.id, ...args });
  expect(await call('ticket_transition', { state: 'plan' })).toMatchObject({ state: 'plan' });
  const bodies = await posted(g.admin, linked.issue, (b) => b.includes('Diese Anfrage ist ausgearbeitet und wartet auf die Freigabe, damit wir anfangen können.'));
  // One more cron run: a retry or a second delivery would show by now.
  await new Promise((r) => setTimeout(r, 15_000));
  const all = await comments(g.admin, linked.issue);
  expect(all.filter((c) => c.body === bodies[0])).toHaveLength(1);
  expect(all[0].authorAgentId).toBe(g.agent.id);
});

const body = () => ({
  event: 'status_changed',
  id: randomUUID(),
  occurred: new Date().toISOString(),
  ticket: { uuid: linked.ticket.id, identifier: linked.ticket.identifier, title: 'x', state: 'working', url: linked.ticket.url },
  previous_state: 'plan',
  new_state: 'working',
});

it('refuses a wrong signature and a timestamp older than five minutes', async () => {
  expect(await deliver(body(), 'not-the-secret')).toBe(502);
  expect(await deliver(body(), g.signing, { age: 6 * 60 })).toBe(502);
});

it('takes a ticket without a task (the group webhook sends all) and posts nothing anywhere', async () => {
  const client = await bakers();
  const lone = await tool(client, 'ticket_create', { title: 'Ohne Aufgabe', workflow: 'bb_work', project: 'DEMO', description: 'e2e' });
  await tool(client, 'ticket_transition', { ticket: lone.id, state: 'plan' });
  await client.close();
  // Two cron runs: bakers.build has sent its created and status_changed deliveries by then.
  await new Promise((r) => setTimeout(r, 30_000));
  const all = await comments(g.admin, linked.issue);
  expect(all.some((c) => c.body.includes(lone.identifier))).toBe(false);
});
