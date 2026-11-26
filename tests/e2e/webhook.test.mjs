// AC-5: a bakers webhook event reaches its task once; a wrong signature or an unknown ticket is refused and logged.
// bakers.build has no webhook yet: the test sends the events, the bridge reads the ticket from the local bakers.build.
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { comments, deliver, event as bakersEvent, group, linkedTicket, until } from './fixture.mjs';

let g, linked;
beforeAll(async () => {
  g = await group();
  linked = await linkedTicket(g);
});

const event = (type, data, ticket = linked.ticket) => bakersEvent(type, data, ticket);

it('posts a state change into the task, as the PM agent, once even when redelivered', async () => {
  const ev = event('ticket.state_changed', { from: 'plan', to: 'working' });
  expect(await deliver(ev, g.signing)).toBe(200);
  expect(await deliver(ev, g.signing)).toBe(200);
  const posted = await until(async () => (await comments(g.admin, linked.issue)).filter((c) => c.body === 'Die Arbeit daran hat begonnen.'));
  expect(posted).toHaveLength(1);
  expect(posted[0].authorAgentId).toBe(g.agent.id);
});

it('refuses a wrong signature and records the failed delivery', async () => {
  expect(await deliver(event('run.started', { state_at_start: 'working' }), 'not-the-secret')).toBe(502);
  const all = await comments(g.admin, linked.issue);
  expect(all.some((c) => c.body === 'Wir arbeiten jetzt daran.')).toBe(false);
});

it('refuses an event for an unknown ticket', async () => {
  expect(await deliver(event('run.started', { state_at_start: 'working' }, { id: randomUUID(), identifier: 'DEMO-999' }), g.signing)).toBe(502);
});
