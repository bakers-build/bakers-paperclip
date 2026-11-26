// bakers-demo: a bakers.build stand-in for the local demo and the e2e tests. Not a replica:
// it serves only the PM agent's allowlisted tools, with the schemas bakers.build serves
// (demo/tools/), over one seeded group, keeps everything in memory, sends signed webhook
// events to the bridge, and plays a scripted conductor run (no model).
//
//   GET  /state  everything, for tests and curious humans
//   POST /emit   {type, ticket, data}: send one signed custom event
//   POST /mcp    the MCP endpoint, Authorization: Bearer <DEMO_BAKERS_API_KEY>

import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS_DIR = new URL('./tools/', import.meta.url);
const TOOLS = readdirSync(TOOLS_DIR).map((f) => JSON.parse(readFileSync(new URL(f, TOOLS_DIR), 'utf8')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed(base) {
  const group = 'demo-group';
  const users = [
    { uuid: randomUUID(), name: 'PM Agent Demo', mail: 'pm-agent@example.org', service_account: true, profiles: [{ workspace: group, position: 'Project manager', background: 'Specifies requests with their requester.' }] },
    { uuid: randomUUID(), name: 'Rita Requester', mail: 'requester@example.org', service_account: false, profiles: [] },
    { uuid: randomUUID(), name: 'Devon Developer', mail: 'developer@example.org', service_account: false, profiles: [] },
  ];
  const projects = [
    { uuid: randomUUID(), key: 'DEMO', name: 'Demo Shop', description: 'The online shop: catalogue, cart and checkout.', group, repository: 'https://example.org/demo/shop.git', readable: true },
    { uuid: randomUUID(), key: 'DEMO2', name: 'Demo Blog', description: 'The company blog and its newsletter sign-up.', group, repository: 'https://example.org/demo/blog.git', readable: true },
    { uuid: randomUUID(), key: 'FOREIGN', name: 'Another customer', description: 'A project of another group.', group: 'other-group', readable: false },
  ];
  const conductors = [{ uuid: randomUUID(), project: projects[0].uuid, label: 'demo-box · Demo Shop', active: true, online: true, assignment: 'allow', owner: users[2].uuid }];
  const tickets = projects.slice(0, 2).map((p) => ({
    id: randomUUID(), identifier: `${p.key}-1`, title: 'Existing ticket', description: 'An older ticket, so the prior-art probe finds a row.',
    url: `${base}/ticket/${p.key.toLowerCase()}-1`, state: 'done', project: p.uuid, workflow: 'bb_work', type: 'feature', recipe: 'matt',
    labels: [], frozen: false, links: [], comments: [], reviewers: [], assignee: null, conductor: null, origin: null, parent: null,
  }));
  return { users, projects, conductors, tickets, events: [] };
}

export async function startDemo({ port = 8090, host = '127.0.0.1', apiKey, secret, webhookUrl, stepMs = 1000, publicUrl } = {}) {
  let base = publicUrl;
  const state = seed(publicUrl ?? 'http://bakers-demo');
  let sending = Promise.resolve();

  function emit(type, t, data) {
    const event = { event_id: randomUUID(), type, occurred_at: new Date().toISOString(), ticket: { uuid: t.id, identifier: t.identifier, ...(t.parent && { parent_uuid: t.parent }) }, data };
    state.events.push(event);
    if (!webhookUrl) return;
    const rawBody = JSON.stringify(event);
    const headers = {
      'content-type': 'application/json',
      'x-bakers-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
      'x-bakers-timestamp': String(Math.floor(Date.now() / 1000)),
    };
    // In order, one at a time; a failed delivery is logged, not retried (the real one retries 24 h).
    sending = sending.then(() =>
      fetch(webhookUrl, { method: 'POST', headers, body: rawBody })
        .then((r) => (event.delivered = r.status))
        .catch((e) => console.error(`bakers-demo: delivery failed: ${e.message}`)),
    );
  }

  const ticket = (ref) => state.tickets.find((t) => (t.id === ref || t.identifier === ref) && project(t.project));
  const project = (ref) => state.projects.find((p) => (p.uuid === ref || p.key === ref) && p.readable);
  const user = (ref) => state.users.find((u) => u.uuid === ref || u.mail.toLowerCase() === String(ref).toLowerCase() || u.name === ref);
  const person = (uuid) => (u => u && { uuid: u.uuid, name: u.name, mail: u.mail })(user(uuid));

  function comment(t, type, body) {
    const c = { id: randomUUID(), type, body, created: new Date().toISOString(), author: state.users[0].name };
    t.comments.push(c);
    emit('comment.created', t, { comment_id: c.id, type });
    return c;
  }
  function transition(t, to) {
    const from = t.state;
    t.state = to;
    emit('ticket.state_changed', t, { from, to });
  }
  function labels(t, add = [], remove = []) {
    const added = add.filter((l) => !t.labels.includes(l));
    const removed = remove.filter((l) => t.labels.includes(l));
    t.labels = [...t.labels.filter((l) => !removed.includes(l)), ...added];
    if (added.length || removed.length) emit('ticket.labels_changed', t, { added, removed });
  }

  // The simulated conductor: a scripted run in two halves around one question (Q15).
  async function conduct(t) {
    if (!t.conductor || t.state !== 'working' || t.run) return;
    t.run = 'asking';
    emit('run.started', t, { state_at_start: 'working' });
    await sleep(stepMs);
    comment(t, 'summary', '### 🎯 Outcome\nDie Umsetzung hat begonnen. Für den nächsten Schritt brauchen wir eine Entscheidung.\n');
    await sleep(stepMs);
    comment(t, 'comment', 'Soll die Änderung für alle Kunden gelten oder nur für angemeldete?');
    t.frozen = true;
    labels(t, ['Question']);
    emit('run.finished', t, { state: 'done', state_at_start: 'working' });
    t.run = 'asked';
  }
  async function resume(t) {
    if (t.run !== 'asked' || t.frozen || t.labels.includes('Question')) return;
    t.run = 'finishing';
    emit('run.started', t, { state_at_start: 'working' });
    await sleep(stepMs);
    transition(t, 'review');
    emit('run.finished', t, { state: 'done', state_at_start: 'working' });
    await sleep(stepMs);
    emit('run.started', t, { state_at_start: 'review' });
    await sleep(stepMs);
    const preview = `https://${t.identifier.toLowerCase()}.preview.example.org/`;
    comment(t, 'summary', `### 🎯 Outcome\nDie Änderung ist fertig und geprüft.\n\n### 🧪 Manual review\nÖffne [die Vorschau](${preview}) und probiere es aus.\n`);
    const design = `https://${t.identifier.toLowerCase()}.designbook.example.org/`;
    t.links.push({ uri: design, title: 'Design' });
    emit('ticket.link_added', t, { uri: design, title: 'Design' });
    transition(t, 'done');
    emit('run.finished', t, { state: 'done', state_at_start: 'review' });
    t.run = 'done';
  }

  const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] });
  const ok = (text, value) => ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(value) }] });
  const view = (t, newest = 2) => ({ ...t, run: undefined, comments: t.comments.slice(-Math.max(0, newest ?? 2)), reviewers: t.reviewers.map(person) });

  const handlers = {
    bakers_user_read: ({ user: ref }) => {
      const u = ref ? user(ref) : state.users[0];
      return u ? ok(`Read user ${u.name}.`, { uuid: u.uuid, name: u.name, mail: u.mail, profiles: u.profiles, teams: [], machines: [] }) : refuse('No such user.');
    },
    bakers_project_read: ({ project: ref }) => {
      const p = project(ref);
      return p ? ok(`Read project ${p.key}.`, { uuid: p.uuid, key: p.key, name: p.name, description: p.description, group: p.group, repository: p.repository, environments: [] }) : refuse('No readable project.');
    },
    bakers_conductor_list: ({ project: ref }) => {
      const p = project(ref);
      if (!p) return refuse('No readable project.');
      return ok('Conductors listed.', state.conductors.filter((c) => c.project === p.uuid).map((c) => ({ ...c, owner: person(c.owner) })));
    },
    bakers_ticket_create: ({ title, workflow, project: ref, description = '', type = null, recipe = null, parent = null, reviewers = [], assignee = null }) => {
      const p = project(ref);
      if (!p) return refuse('No readable project.');
      const n = state.tickets.filter((t) => t.project === p.uuid).length + 1;
      const t = {
        id: randomUUID(), identifier: `${p.key}-${n}`, title, description, url: `${base}/ticket/${p.key.toLowerCase()}-${n}`, state: 'qualification',
        project: p.uuid, workflow, type, recipe, labels: [], frozen: false, links: [], comments: [], origin: null, conductor: null,
        parent: parent ? ticket(parent)?.id ?? null : null, reviewers: (reviewers ?? []).filter((u) => user(u)), assignee: assignee && user(assignee) ? assignee : null,
      };
      state.tickets.push(t);
      return ok(`Created ${t.identifier}.`, { uuid: t.id, identifier: t.identifier, state: t.state, assignee: person(t.assignee), reviewers: t.reviewers.map(person), url: t.url });
    },
    bakers_ticket_read: ({ ticket: ref, newest }) => {
      const t = ticket(ref);
      return t ? ok('Ticket read.', view(t, newest)) : refuse('No readable ticket.');
    },
    bakers_ticket_search: ({ query = '', project: ref }) => {
      const p = ref ? project(ref) : null;
      if (ref && !p) return refuse('No readable project.');
      const q = query.toLowerCase();
      const rows = state.tickets.filter((t) => project(t.project) && (!p || t.project === p.uuid) && `${t.title} ${t.description}`.toLowerCase().includes(q));
      return ok(`${rows.length} found.`, rows.map((t) => ({ uuid: t.id, identifier: t.identifier, title: t.title, state: t.state, parent: t.parent })));
    },
    bakers_ticket_update: (a) => {
      const t = ticket(a.ticket);
      if (!t) return refuse('No readable ticket.');
      if (a.conductor && !state.conductors.some((c) => c.uuid === a.conductor && c.project === t.project)) return refuse('No active conductor of this project.');
      if (a.title != null) t.title = a.title;
      if (a.description != null) t.description = a.description;
      if (a.reviewers_add) t.reviewers = [...new Set([...t.reviewers, ...a.reviewers_add.filter((u) => user(u))])];
      for (const l of a.links_add ?? []) {
        const known = t.links.find((x) => x.uri === l.uri);
        if (known) known.title = l.title ?? known.title;
        else {
          t.links.push({ uri: l.uri, title: l.title ?? '' });
          emit('ticket.link_added', t, { uri: l.uri, title: l.title ?? '' });
        }
      }
      if (a.labels_add || a.labels_remove) labels(t, a.labels_add ?? [], a.labels_remove ?? []);
      if (a.frozen != null) t.frozen = a.frozen;
      if (a.conductor) {
        t.conductor = a.conductor;
        t.assignee ??= state.conductors.find((c) => c.uuid === a.conductor).owner;
      }
      conduct(t);
      resume(t);
      return ok(`Updated ${t.identifier}.`, view(t, 0));
    },
    bakers_ticket_transition: ({ ticket: ref, state: to }) => {
      const t = ticket(ref);
      if (!t) return refuse('No readable ticket.');
      transition(t, to);
      conduct(t);
      return ok(`${t.identifier} is ${to}.`, { uuid: t.id, identifier: t.identifier, state: t.state });
    },
    bakers_ticket_classify: ({ ticket: ref, type, recipe }) => {
      const t = ticket(ref);
      if (!t) return refuse('No readable ticket.');
      Object.assign(t, type && { type }, recipe && { recipe });
      return ok(`Classified ${t.identifier}.`, { uuid: t.id, type: t.type, recipe: t.recipe });
    },
    bakers_comment_create: ({ ticket: ref, type, body }) => {
      const t = ticket(ref);
      if (!t) return refuse('No readable ticket.');
      const c = comment(t, type, body);
      return ok('Comment published.', { id: c.id, type });
    },
  };

  const http = createServer(async (req, res) => {
    const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'GET' && req.url === '/state') return json(200, state);
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true });
    if (req.method === 'POST' && req.url === '/emit') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { type, ticket: ref, data = {} } = JSON.parse(body || '{}');
      const t = ticket(ref);
      if (!t || !type) return json(404, { error: 'unknown ticket or no type' });
      emit(type, t, data);
      await sending;
      return json(200, state.events.at(-1));
    }
    if (req.url === '/mcp') {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return json(401, { error: 'unauthorized' });
      const server = new Server({ name: 'bakers-demo', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const handler = handlers[params.name];
        return handler ? handler(params.arguments ?? {}) : refuse(`Unknown tool ${params.name}.`);
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      return transport.handleRequest(req, res);
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => http.listen(port, host, r));
  const url = `http://${host}:${http.address().port}`;
  if (!base) {
    base = url;
    for (const t of state.tickets) t.url = t.url.replace('http://bakers-demo', url);
  }
  return {
    url,
    state,
    close: async () => {
      await sending;
      await new Promise((r) => http.close(r));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  for (const name of ['DEMO_BAKERS_API_KEY', 'BAKERS_WEBHOOK_SECRET']) if (!env[name]) throw new Error(`${name} must be set`);
  const demo = await startDemo({
    port: Number(env.PORT ?? 8090),
    host: '0.0.0.0',
    apiKey: env.DEMO_BAKERS_API_KEY,
    secret: env.BAKERS_WEBHOOK_SECRET,
    webhookUrl: env.BRIDGE_WEBHOOK_URL,
    stepMs: Number(env.DEMO_STEP_MS ?? 2000),
    publicUrl: env.DEMO_PUBLIC_URL,
  });
  console.log(`bakers-demo on ${demo.url}, events to ${env.BRIDGE_WEBHOOK_URL ?? 'nowhere'}`);
}
