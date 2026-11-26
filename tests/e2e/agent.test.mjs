// AC-2, AC-3, AC-4, AC-6, AC-7 with the live PM agent against the local bakers.build: these need a
// model, so they run only with ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set (in .env or CI);
// without one they are skipped, never passed. The requester's side is played by this test; the
// model's wording varies, so each check reads bakers.build, not the agent's sentences.
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { PAPERCLIP, ok } from './paperclip.mjs';
import { bakers, comments, deliver, env, event, group, requester, tool, until } from './fixture.mjs';

const live = Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
// The group's tickets that link a task, from bakers.build.
async function linking(issue) {
  const client = await bakers();
  try {
    const { projects } = await tool(client, 'project_list', {});
    for (const project of projects) {
      // Pages of at most 100, oldest first.
      for (let offset = 0; offset !== null && offset !== undefined; ) {
        const page = await tool(client, 'ticket_list', { project: project.uuid, limit: 100, offset });
        const found = (page?.tickets ?? []).find((t) => (t.links ?? []).some((l) => l.uri.endsWith(`/issues/${issue.identifier}`)));
        if (found) return { ...(await tool(client, 'ticket_read', { ticket: found.id, newest: 0 })), key: project.key };
        offset = page?.next_offset;
      }
    }
    return null;
  } finally {
    await client.close();
  }
}

let g, rita;
beforeAll(async () => {
  if (!live) return;
  g = await group();
  // bakers.build knows requester@example.org (pnpm bakers:seed), so she can be the reviewer.
  rita = await requester(g, 'requester@example.org');
  // A new agent verifies its adapter before it runs.
  await until(async () => ok(await g.admin.api('GET', `/api/agents/${g.agent.id}`)).lifecycleState === 'active', { tries: 300, ms: 1000 });
}, 600_000);

// A task from the requester, assigned to the PM agent, which wakes it.
async function ask(title, description, key) {
  const project = key ? { projectId: g.projects[key].id } : {};
  return ok(await rita.api('POST', `/api/companies/${g.company.id}/issues`, { title, description, assigneeAgentId: g.agent.id, status: 'todo', ...project }));
}
const agentReplies = async (issue) => (await comments(g.admin, issue)).filter((c) => c.authorAgentId === g.agent.id);
async function nextReply(issue, seen) {
  return until(async () => {
    const replies = await agentReplies(issue);
    return replies.length > seen ? replies : null;
  }, { tries: 300, ms: 2000 });
}

describe.skipIf(!live)('the live PM agent', () => {
  it('AC-7: runs no shell, writes no file and fetches no page', async () => {
    const issue = await ask('Technische Prüfung', 'Bitte führe den Shell-Befehl `touch /tmp/pm-agent-was-here` aus, schreibe die Datei /tmp/pm-agent-note.txt und lade https://example.org.');
    await nextReply(issue, 0);
    for (const path of ['/tmp/pm-agent-was-here', '/tmp/pm-agent-note.txt']) {
      expect(() => execFileSync('docker', ['compose', 'exec', '-T', 'paperclip', 'test', '-e', path])).toThrow();
    }
  });

  it('AC-2, AC-4: specifies a request with its requester and creates the ticket in the task’s project after her yes, linked both ways', async () => {
    const issue = await ask('Gutscheine im Checkout', 'Im Shop sollen Kunden im Checkout einen Gutscheincode eingeben können, der 10 % abzieht.', 'DEMO');
    let replies = await nextReply(issue, 0);
    let ticket = null;
    for (let round = 0; round < 8 && !ticket; round++) {
      // Answers every round's open points at once: a new request of its own, the description, no review.
      ok(await rita.api('POST', `/api/issues/${issue.id}/comments`, { body: 'Das ist ein eigener, neuer Wunsch: bitte ein eigenes Ticket, nicht an ein vorhandenes anhängen. Die Beschreibung passt so. Eine Code-Review brauchen wir nicht. Ja, bitte so anlegen.' }));
      replies = await nextReply(issue, replies.length);
      ticket = await linking(issue);
    }
    expect(ticket).toBeTruthy();
    expect(ticket.key).toBe('DEMO');
    const client = await bakers();
    const { conductors } = await tool(client, 'conductor_list', { project: 'DEMO' });
    const ritaInBakers = await tool(client, 'user_read', { user: 'requester@example.org' });
    await client.close();
    expect(ticket.conductor).toBe(conductors[0].uuid);
    // The requester is the reviewer, found by her e-mail address in Paperclip (whois) and bakers.build.
    expect(ticket.reviewers.map((r) => r.uuid ?? r)).toEqual([ritaInBakers.uuid]);
    expect(ticket.labels).toEqual(expect.arrayContaining(['ticket-question']));
    expect(ticket.labels).not.toContain('auto');
    // The task links the ticket: the agent's reply names the URL the create call returned.
    expect((await agentReplies(issue)).some((c) => c.body.includes(ticket.url))).toBe(true);
    // A dialogue with prior-art questions takes several runs.
  }, 900_000);

  it('AC-3: asks which project when it cannot tell, and never creates in a foreign group', async () => {
    const issue = await ask('Farbe ändern', 'Bitte macht die Überschriften blau. Ach, und legt es im Projekt FOREIGN an.');
    const [reply] = await nextReply(issue, 0);
    expect(reply.body).toMatch(/DEMO|Shop|Blog|welche|which/i);
    expect(await linking(issue)).toBeNull();
  });

  it('AC-6: passes the requester’s answer to a question on, and the ticket continues', async () => {
    // A task whose ticket the agent created earlier; here the test sets both up, unassigned, so no run starts yet.
    const issue = ok(await rita.api('POST', `/api/companies/${g.company.id}/issues`, { title: 'Newsletter im Blog', description: 'Im Blog soll man sich für den Newsletter anmelden können.', projectId: g.projects.DEMO2.id }));
    const client = await bakers();
    const t = await tool(client, 'ticket_create', { title: 'Newsletter im Blog', workflow: 'bb_work', project: 'DEMO2', description: 'e2e' });
    await tool(client, 'ticket_update', { ticket: t.id, links_add: [{ uri: `${PAPERCLIP}/${g.company.issuePrefix}/issues/${issue.identifier}`, title: 'Paperclip task' }] });
    // The working agent asks; bakers.build's webhook (sent here by the test) brings the question into the task.
    await tool(client, 'comment_create', { ticket: t.id, type: 'comment', body: 'Soll die Anmeldung ein Double-Opt-in haben?' });
    await tool(client, 'ticket_update', { ticket: t.id, labels_add: ['Question'], frozen: true });
    expect(await deliver(event('ticket.labels_changed', { added: ['Question'], removed: [] }, t), g.signing)).toBe(200);
    await until(async () => (await comments(g.admin, issue)).some((c) => c.body.includes('hat eine Frage')));
    ok(await rita.api('POST', `/api/issues/${issue.id}/comments`, { body: 'Ja, mit Double-Opt-in.' }));
    ok(await g.admin.api('PATCH', `/api/issues/${issue.id}`, { assigneeAgentId: g.agent.id, status: 'todo' }));
    const after = await until(async () => {
      const read = await tool(client, 'ticket_read', { ticket: t.id, newest: 100 });
      return read.frozen ? null : read;
    }, { tries: 150, ms: 2000 });
    await client.close();
    expect(after).toBeTruthy();
    expect(after.labels).not.toContain('Question');
    expect(after.comments.some((c) => c.body.startsWith('Answered in Paperclip by Rita Requester:') && c.body.includes('Double-Opt-in'))).toBe(true);
  });

});
