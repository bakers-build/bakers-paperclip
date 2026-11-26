// Sets up one bakers.build group in the running Paperclip, the way README › Set up a group
// describes it by hand: company, secrets, PM agent from agent/*, bakers-bridge config.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from '../../bakers-bridge/bakers-client.mjs';
import { PAPERCLIP, ok, session } from './paperclip.mjs';

const root = new URL('../../', import.meta.url);
const file = (path) => readFileSync(new URL(path, root), 'utf8');
export const env = {
  ...Object.fromEntries(
    (() => {
      try {
        return file('.env');
      } catch {
        return '';
      }
    })()
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/=(.*)/s)),
  ),
  ...process.env,
};
export const WEBHOOK = `${PAPERCLIP}/api/plugins/bakers-bridge/webhooks/bakers`;
// The local bakers.build (docker compose --profile bakers up, pnpm bakers:seed): from this machine,
// and as Paperclip reaches it inside the compose network.
export const BAKERS = env.BAKERS_HOST_URL ?? 'http://bakers.localhost:8080';
const BAKERS_IN_COMPOSE = 'http://bakers-gateway';
/** The seeded PM agent service account's MCP session. */
export const bakers = () => connect(`${BAKERS}/mcp`, env.BAKERS_E2E_API_KEY);
/** One bakers.build tool's result, as the service account. */
export const tool = (client, name, args) => client.call(`tool_api__bakers_${name}`, args);

let adminSession;
export const admin = () => (adminSession ??= session({ email: 'admin@example.org', name: 'Ada Admin' }));

/** The board admin, with the instance claimed and the plugin installed and ready. */
export async function instance() {
  const a = await admin();
  const health = ok(await a.api('GET', '/api/health'));
  if (health.bootstrapStatus !== 'ready') ok(await a.api('POST', '/api/bootstrap/claim'));
  const plugin = await a.api('GET', '/api/plugins/bakers-bridge');
  if (plugin.status === 404) ok(await a.api('POST', '/api/plugins/install', { packageName: '/opt/bakers-paperclip/bakers-bridge', isLocalPath: true }));
  return a;
}

/** A fresh company for one group, with its PM agent and bridge config. */
export async function group(name = `Group ${randomUUID().slice(0, 8)}`) {
  const a = await instance();
  const company = ok(await a.api('POST', '/api/companies', { name }));
  const secret = async (key, value) => ok(await a.api('POST', `/api/companies/${company.id}/secrets`, { name: key, value })).id;
  // Each group signs with a secret of its own, as each bakers.build group's webhook will.
  const signing = randomUUID();
  const webhookSecret = await secret('BAKERS_WEBHOOK_SECRET', signing);
  const bakersKey = await secret('BAKERS_API_KEY', env.BAKERS_E2E_API_KEY);
  const adapterConfig = JSON.parse(file('agent/adapter-config.json'));
  adapterConfig.env.BAKERS_API_KEY.secretId = bakersKey;
  adapterConfig.env.BAKERS_URL.value = BAKERS_IN_COMPOSE;
  const agent = ok(
    await a.api('POST', `/api/companies/${company.id}/agents`, {
      name: 'PM Agent',
      role: 'pm',
      adapterType: 'claude_local',
      runner: 'legacy',
      adapterConfig,
      instructionsBundle: { files: { 'AGENTS.md': file('agent/AGENTS.md') } },
    }),
  );
  ok(
    await a.api('POST', '/api/plugins/bakers-bridge/config', {
      companyId: company.id,
      configJson: {
        bakersUrl: BAKERS_IN_COMPOSE,
        language: 'de',
        agentId: agent.id,
        webhookSecret: { type: 'secret_ref', secretId: webhookSecret },
        bakersApiKey: { type: 'secret_ref', secretId: bakersKey },
      },
    }),
  );
  // One Paperclip project per bakers.build project of the group (README › Set up a group).
  const projects = {};
  for (const [key, name] of [['DEMO', 'Demo Shop'], ['DEMO2', 'Demo Blog']]) {
    projects[key] = ok(await a.api('POST', `/api/companies/${company.id}/projects`, { name, description: `bakers.build: ${key}`, status: 'in_progress' }));
  }
  return { admin: a, company, agent, projects, signing };
}

/** A task in the company and a demo ticket that links it, as the PM agent leaves them. */
export async function linkedTicket({ admin: a, company, projects }, title = 'Gutscheine im Checkout', key = 'DEMO') {
  const issue = ok(await a.api('POST', `/api/companies/${company.id}/issues`, { title, description: 'e2e', projectId: projects[key].id }));
  const client = await bakers();
  const ticket = await tool(client, 'ticket_create', { title, workflow: 'bb_work', project: key, description: 'e2e' });
  await tool(client, 'ticket_update', { ticket: ticket.id, links_add: [{ uri: `${PAPERCLIP}/${company.issuePrefix}/issues/${issue.identifier}`, title: 'Paperclip task' }] });
  return { issue, ticket, bakers: client };
}

/** The task's comment bodies, oldest first. */
export async function comments(a, issue) {
  const list = ok(await a.api('GET', `/api/issues/${issue.id}/comments`));
  return [...list].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
}

/** A bakers.build event about `ticket`, as its webhook will send it. */
export const event = (type, data, ticket) => ({ event_id: randomUUID(), type, occurred_at: new Date().toISOString(), ticket: { uuid: ticket.id, identifier: ticket.identifier }, data });

/** POSTs an event signed with `secret` (a group's `signing`) straight to the bridge, as bakers.build would; returns the HTTP status. */
export async function deliver(event, secret) {
  const body = JSON.stringify(event);
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bakers-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      'x-bakers-timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body,
  });
  if (res.status !== 200) console.warn(`bridge answered ${res.status}: ${await res.text()}`);
  return res.status;
}

export async function until(check, { tries = 100, ms = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, ms));
  }
  return check();
}

/**
 * A requester in the group's company: invited as `operator`, then stripped of every grant
 * (README › Invite a requester), so they file and follow tasks and configure nothing.
 */
export async function requester({ admin: a, company }, email = `requester-${randomUUID().slice(0, 8)}@example.org`) {
  const invite = ok(await a.api('POST', `/api/companies/${company.id}/invites`, { allowedJoinTypes: 'human', humanRole: 'operator' }));
  const r = await session({ email, name: 'Rita Requester' });
  ok(await r.api('POST', `/api/invites/${invite.token ?? invite.inviteUrl.split('/').pop()}/accept`, { requestType: 'human' }));
  const members = ok(await a.api('GET', `/api/companies/${company.id}/members`));
  const member = (members.members ?? members).find((m) => JSON.stringify(m).includes(email));
  ok(await a.api('PATCH', `/api/companies/${company.id}/members/${member.id}/role-and-grants`, { membershipRole: 'operator', grants: [] }));
  return { ...r, email };
}
