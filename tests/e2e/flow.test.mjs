// AC3–AC7, AC10, AC11: a real ticket goes through its states in the local bakers.build, and its
// Demo group webhook (pnpm bakers:seed) brings each text into the task once. No event is built
// here: the test changes the ticket through MCP as the conductor and the agents would.
import { expect, it } from 'vitest';
import { claim, group, linkedTicket, nudge, posted, tool } from './fixture.mjs';

it('plan → working → claim → cancel → question → review with preview → done, each once in the task', async () => {
  const g = await group();
  const { issue, ticket, bakers: client } = await linkedTicket(g);
  const call = (name, args) => tool(client, name, { ticket: ticket.id, ...args });
  const moveTo = async (to) => expect(await call('ticket_transition', { state: to })).toMatchObject({ state: to });
  // Each step waits for a comment that contains its text: bakers.build delivers on its cron.
  const sees = (text) => posted(g.admin, issue, (b) => b.some((body) => body.includes(text)));

  await moveTo('plan');
  await sees('Diese Anfrage ist ausgearbeitet und wartet auf die Freigabe, damit wir anfangen können.');
  await moveTo('working');
  await sees('Die Arbeit daran hat begonnen.');

  // A conductor claims it: the first run outside qualification is `claimed`.
  const { conductors } = await tool(client, 'conductor_list', { project: 'DEMO' });
  await call('ticket_update', { conductor: conductors[0].uuid });
  claim(ticket);
  await sees('Wir arbeiten jetzt daran.');
  // The run is cancelled: `run_ended`, and the newest run says how.
  await call('run_cancel', { reason: 'e2e' });
  await sees('Die Arbeit ist wegen eines Problems unterbrochen; die Entwickler sehen es sich an.');

  // A question: no activity for the label or the freeze, so it comes with the next one.
  await call('comment_create', { type: 'comment', body: 'Soll die Änderung für alle Kunden gelten oder nur für angemeldete?' });
  await call('ticket_update', { labels_add: ['Question'], frozen: true });
  await nudge(client, ticket);
  await sees('Soll die Änderung für alle Kunden gelten oder nur für angemeldete?');
  await call('comment_create', { type: 'comment', body: 'Answered in Paperclip by Rita Requester:\n\nNur für angemeldete Kunden.' });
  await call('ticket_update', { labels_remove: ['Question'], frozen: false });

  // A preview link, also without an activity of its own: it comes with the move to review.
  const preview = `https://${ticket.identifier.toLowerCase()}.ddev.site/`;
  await call('ticket_update', { links_add: [{ uri: preview, title: 'Preview' }] });
  await moveTo('review');
  await sees(`Es gibt etwas zum Ansehen:\n${preview}`);
  await moveTo('done');
  const bodies = await sees('Das ist fertig und bereit zum Ausprobieren.' + `\n\n[${ticket.identifier} · Gutscheine im Checkout](${ticket.url})`);
  await client.close();

  expect(bodies).toEqual([
    'Diese Anfrage ist ausgearbeitet und wartet auf die Freigabe, damit wir anfangen können.',
    'Die Arbeit daran hat begonnen.',
    'Wir arbeiten jetzt daran.',
    'Die Arbeit ist wegen eines Problems unterbrochen; die Entwickler sehen es sich an.',
    `${ticket.identifier} · „Gutscheine im Checkout“ hat eine Frage:\n\nSoll die Änderung für alle Kunden gelten oder nur für angemeldete?`,
    'Die Arbeit ist fertig und wird geprüft.',
    `Es gibt etwas zum Ansehen:\n${preview}`,
    `Das ist fertig und bereit zum Ausprobieren.\n\n[${ticket.identifier} · Gutscheine im Checkout](${ticket.url})`,
  ]);
  // Ten steps, each waiting for bakers.build's cron and the bridge's drain.
}, 900_000);

it('a sub-ticket’s state change reaches its parent’s task, behind its identifier', async () => {
  const g = await group();
  const { issue, ticket, bakers: client } = await linkedTicket(g);
  const sub = await tool(client, 'ticket_create', { title: 'Teil: Gutscheinfeld', workflow: 'bb_work', project: 'DEMO', description: 'e2e', parent: ticket.id });
  await tool(client, 'ticket_transition', { ticket: sub.id, state: 'plan' });
  await client.close();
  await posted(g.admin, issue, (b) => b.some((body) => body === `${sub.identifier} · Diese Anfrage ist ausgearbeitet und wartet auf die Freigabe, damit wir anfangen können.`));
});
