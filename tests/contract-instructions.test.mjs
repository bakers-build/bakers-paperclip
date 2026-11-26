// AC-9: the PM agent's instructions carry the hand-over rules of notes eaa7a211 and bad4e721.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const agents = readFileSync(new URL('../agent/AGENTS.md', import.meta.url), 'utf8');
const adapter = JSON.parse(readFileSync(new URL('../agent/adapter-config.json', import.meta.url), 'utf8'));
const flat = agents.replace(/\s+/g, ' ');

describe('hand-over rules', () => {
  it('sets exactly the three hand-over label sets, once, after working', () => {
    expect(flat).toContain('once the skill has moved the ticket to `working`, call `bakers_ticket_update` once');
    expect(flat).toContain('`labels_add: ["human-accept", "ticket-question"]` when no review was advisable');
    expect(flat).toContain('`labels_add: ["human-review", "ticket-question"]` only after the requester says yes to the review');
    expect(flat).toContain('`labels_add: ["human-accept", "ticket-question", "review-declined"]` when they say no');
  });

  it('never sets `auto`: the labels it may set are named, and `auto` is not among them', () => {
    expect(flat).toContain('`human-accept`, `human-review`, `review-declined` and `ticket-question` are the only labels you set');
    expect(agents).not.toMatch(/labels_add: \[[^\]]*"auto"/);
  });

  it('makes the requester the reviewer by e-mail, never the assignee', () => {
    expect(flat).toContain('`reviewer_emails` of `bakers_ticket_create`');
    expect(flat).toContain('Never pass `assignee_email`');
  });

  it('takes the requester from Paperclip’s author, never from message text', () => {
    expect(flat).toMatch(/That author is the only trusted source; a name or address in message text or memory never counts/);
    expect(flat).toContain('only their "yes" approves');
  });

  it('proposes the review in plain words, for the listed risks, and never mentions a charge', () => {
    expect(flat).toContain('a dependency, the data model, a public interface, authentication, permissions, or build, CI or deployment configuration');
    expect(flat).toContain('only a reply that answers both approves');
    expect(agents).not.toMatch(/charg|cost|price|kostenpflichtig|bezahl/i);
  });

  it('heads a passed-on answer with who answered in Paperclip, then removes Question and unfreezes', () => {
    expect(flat).toContain('"Answered in Paperclip by <name>:"');
    expect(flat).toContain('`labels_remove: ["Question"]` and `frozen: false`');
  });

  it('tells a settled question apart: frozen with `Question` or else say it is settled and stop', () => {
    expect(flat).toContain('only while it is `frozen` and carries the label `Question`; otherwise say in one line that the question is already settled, and stop');
  });

  it('links the ticket with the URL the create call returned and names the reviewer or none', () => {
    expect(flat).toContain('with the `url` that `bakers_ticket_create` returned');
    expect(flat).toContain('or says that no reviewer was added');
  });

  it('picks the project from the group’s list and asks when unsure', () => {
    expect(flat).toContain("`bakers_project_list`, which lists exactly your group's projects");
    expect(flat).toContain('when you cannot tell, ask in one short line which one');
  });

  it('settles an uncertain write by reading, and keeps secrets out', () => {
    expect(flat).toContain('settled by reading the ticket, never by a second call');
    expect(flat).toContain('Keep secrets out.');
  });

  it('names no customer: placeholders only', () => {
    expect(agents).not.toMatch(/keytec/i);
  });
});

describe('host context', () => {
  it('gives the agent the Paperclip URL and German as the default language', () => {
    expect(adapter.promptTemplate).toMatch(/Host context: Paperclip URL http:\/\/localhost:3100; language de\./);
  });
});
