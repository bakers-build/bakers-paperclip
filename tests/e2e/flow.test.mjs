// Q15, AC-5, AC-6 (bridge side): the simulated conductor's whole run reaches the task, each step once.
// The PM agent's part (the answer) is played here by its MCP calls; tests/e2e/agent.test.mjs runs the model.
import { expect, it } from 'vitest';
import { comments, group, linkedTicket, until } from './fixture.mjs';

it('request ticket → run → question → answer → review → done → preview, each once in the task', async () => {
  const g = await group();
  const { issue, ticket, bakers } = await linkedTicket(g);
  await bakers.call('bakers_ticket_transition', { ticket: ticket.uuid, state: 'working' });
  const [conductor] = await bakers.call('bakers_conductor_list', { project: 'DEMO' });
  await bakers.call('bakers_ticket_update', { ticket: ticket.uuid, conductor: conductor.uuid });
  const asked = await until(async () => (await comments(g.admin, issue)).some((c) => c.body.includes('hat eine Frage')));
  expect(asked).toBe(true);

  // The PM agent's answer path (AGENTS.md › Answers).
  await bakers.call('bakers_comment_create', { ticket: ticket.uuid, type: 'comment', body: 'Answered in Paperclip by Rita Requester:\n\nNur für angemeldete Kunden.' });
  await bakers.call('bakers_ticket_update', { ticket: ticket.uuid, labels_remove: ['Question'], frozen: false });
  const done = await until(async () => (await comments(g.admin, issue)).some((c) => c.body.startsWith('Das ist fertig')), { tries: 150 });
  expect(done).toBe(true);
  await new Promise((r) => setTimeout(r, 1000));

  const bodies = (await comments(g.admin, issue)).map((c) => c.body);
  expect(bodies).toEqual([
    'Die Arbeit daran hat begonnen.',
    'Wir arbeiten jetzt daran.',
    'Die Umsetzung hat begonnen. Für den nächsten Schritt brauchen wir eine Entscheidung.',
    `${ticket.identifier} · „Gutscheine im Checkout“ hat eine Frage:\n\nSoll die Änderung für alle Kunden gelten oder nur für angemeldete?`,
    'Wir arbeiten jetzt daran.',
    'Die Arbeit ist fertig und wird geprüft.',
    'Wir prüfen die Arbeit.',
    'Die Änderung ist fertig und geprüft.',
    `Es gibt etwas zum Ansehen: die Vorschau\nhttps://${ticket.identifier.toLowerCase()}.preview.example.org/`,
    `Es gibt etwas zum Ansehen: Design\nhttps://${ticket.identifier.toLowerCase()}.designbook.example.org/`,
    expect.stringMatching(/^Das ist fertig und bereit zum Ausprobieren\.\n\nWo und wie du es testen kannst:\n\nÖffne \[die Vorschau\]/),
  ]);
  await bakers.close();
});
