// AC-5, AC-6 (bridge side), Q15: a ticket's whole run reaches its task, each step once.
// The local bakers.build holds the ticket; the test plays the conductor's steps on it through
// MCP and, as bakers.build has no webhook yet, sends each step's signed event to the bridge.
// The PM agent's part (the answer) is played by its MCP calls; tests/e2e/agent.test.mjs runs the model.
import { expect, it } from 'vitest';
import { comments, deliver, event, group, linkedTicket, tool, until } from './fixture.mjs';

it('request ticket → run → question → answer → review → done → preview, each once in the task', async () => {
  const g = await group();
  const { issue, ticket, bakers } = await linkedTicket(g);
  const call = (name, args) => tool(bakers, name, { ticket: ticket.id, ...args });
  const send = async (type, data) => expect(await deliver(event(type, data, ticket))).toBe(200);
  const moveTo = async (from, to) => {
    expect(await call('ticket_transition', { state: to })).toMatchObject({ state: to });
    await send('ticket.state_changed', { from, to });
  };
  const comment = async (type, body) => {
    const c = await call('comment_create', { type, body });
    await send('comment.created', { comment_id: c.id, type });
  };

  await moveTo('qualification', 'working');
  await send('run.started', { state_at_start: 'working' });
  await comment('summary', '### 🎯 Outcome\nDie Umsetzung hat begonnen. Für den nächsten Schritt brauchen wir eine Entscheidung.\n');
  await comment('comment', 'Soll die Änderung für alle Kunden gelten oder nur für angemeldete?');
  await call('ticket_update', { labels_add: ['Question'], frozen: true });
  await send('ticket.labels_changed', { added: ['Question'], removed: [] });
  await send('run.finished', { state: 'done', state_at_start: 'working' });

  // The PM agent's answer path (AGENTS.md › Answers).
  await comment('comment', 'Answered in Paperclip by Rita Requester:\n\nNur für angemeldete Kunden.');
  await call('ticket_update', { labels_remove: ['Question'], frozen: false });
  await send('ticket.labels_changed', { added: [], removed: ['Question'] });

  await send('run.started', { state_at_start: 'working' });
  await moveTo('working', 'review');
  await send('run.finished', { state: 'done', state_at_start: 'working' });
  await send('run.started', { state_at_start: 'review' });
  const preview = `https://${ticket.identifier.toLowerCase()}.preview.example.org/`;
  await comment('summary', `### 🎯 Outcome\nDie Änderung ist fertig und geprüft.\n\n### 🧪 Manual review\nÖffne [die Vorschau](${preview}) und probiere es aus.\n`);
  const design = `https://${ticket.identifier.toLowerCase()}.designbook.example.org/`;
  await call('ticket_update', { links_add: [{ uri: design, title: 'Design' }] });
  await send('ticket.link_added', { uri: design, title: 'Design' });
  await moveTo('review', 'done');
  await send('run.finished', { state: 'done', state_at_start: 'review' });
  await bakers.close();

  const bodies = await until(async () => {
    const list = (await comments(g.admin, issue)).map((c) => c.body);
    return list.some((b) => b.startsWith('Das ist fertig')) ? list : null;
  });
  expect(bodies).toEqual([
    'Die Arbeit daran hat begonnen.',
    'Wir arbeiten jetzt daran.',
    'Die Umsetzung hat begonnen. Für den nächsten Schritt brauchen wir eine Entscheidung.',
    `${ticket.identifier} · „Gutscheine im Checkout“ hat eine Frage:\n\nSoll die Änderung für alle Kunden gelten oder nur für angemeldete?`,
    'Wir arbeiten jetzt daran.',
    'Die Arbeit ist fertig und wird geprüft.',
    'Wir prüfen die Arbeit.',
    'Die Änderung ist fertig und geprüft.',
    `Es gibt etwas zum Ansehen: Design\n${design}`,
    expect.stringMatching(/^Das ist fertig und bereit zum Ausprobieren\.\n\nWo und wie du es testen kannst:\n\nÖffne \[die Vorschau\]/),
  ]);
});
