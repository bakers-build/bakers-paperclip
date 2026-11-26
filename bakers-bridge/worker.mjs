// The bakers-bridge worker: Paperclip's I/O around core.mjs.
import { readFileSync } from 'node:fs';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { connect } from './bakers-client.mjs';
import { deliver, drain } from './core.mjs';

const MESSAGES = JSON.parse(readFileSync(new URL('./messages.json', import.meta.url), 'utf8'));
let ctx;

// shortcut: resolved secrets stay in this worker's memory for 60 s, never persisted or logged.
// Paperclip allows 30 resolutions per company and minute, which one busy run's events exceed;
// a rotated secret takes effect within a minute. Upgrade when Paperclip offers a webhook-secret binding.
const TTL_MS = 60_000;
const resolved = new Map();
async function secret(ref, companyId) {
  const key = `${companyId}:${ref?.secretId}`;
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await ctx.secrets.resolve(ref, { companyId });
  resolved.set(key, { value, at: Date.now() });
  return value;
}

// One group's bakers access and task posts, under its own key and company. The key is resolved
// only when core.mjs reads a ticket, that is for the group whose webhook secret verified.
function group(config, companyId, webhookSecret) {
  const g = { companyId, agentId: config.agentId };
  let client;
  const bakers = async () => (client ??= await connect(`${config.bakersUrl.replace(/\/+$/, '')}/mcp`, await secret(config.bakersApiKey, companyId)));
  const call = async (tool, args) => (await bakers()).call(`tool_api__bakers_${tool}`, args);
  const read = (ticket) => call('ticket_read', { ticket, newest: 1000 });
  return {
    secret: webhookSecret,
    messages: MESSAGES[config.language ?? 'de'],
    readTicket: read,
    runs: async (t) => (await call('run_list', { ticket: t.id, limit: 1 }))?.runs?.[0] ?? null,
    // The read has no parent; the search row has. It matches title and description, not the identifier.
    // shortcut: the parent is found among the 50 newest tickets of that title; upgrade when the read returns it.
    async parentOf(t) {
      const row = (await call('ticket_search', { query: t.title }))?.tickets?.find((r) => r.identifier === t.identifier);
      const p = row?.parent;
      return p ? read(typeof p === 'string' ? p : (p.uuid ?? p.identifier)) : null;
    },
    holds: async (task) => Boolean(await ctx.issues.get(task.issue, g.companyId).catch(() => null)),
    async post(task, text) {
      const issue = await ctx.issues.get(task.issue, g.companyId);
      if (!issue) throw new Error(`no task ${task.issue} in company ${g.companyId}`);
      // Attributed to the PM agent: a plugin's agent comments wake nobody.
      await ctx.issues.createComment(issue.id, text, g.companyId, { authorAgentId: g.agentId });
    },
    close: () => client?.close(),
  };
}

// Every company with a bridge config is one group; the secret that verifies picks it.
async function groups() {
  const configs = [];
  for (const company of await ctx.companies.list({ limit: 1000 })) {
    const config = await ctx.config.get(company.id).catch(() => null);
    if (config?.webhookSecret && config.bakersApiKey && config.agentId) configs.push([company.id, config]);
  }
  return Promise.all(configs.map(async ([companyId, config]) => group(config, companyId, await secret(config.webhookSecret, companyId))));
}

// Deliveries, the queue and what was posted live in the plugin's state: they survive a restart.
const key = (stateKey) => ({ scopeKind: 'instance', stateKey });
const deps = (gs) => ({
  groups: gs,
  now: Date.now,
  store: { get: (k) => ctx.state.get(key(k)), set: (k, v) => ctx.state.set(key(k), v) },
  log: (level, message, meta) => ctx.logger[level](message, meta),
});

async function drainAll() {
  const gs = await groups();
  try {
    await drain(deps(gs));
  } finally {
    await Promise.all(gs.map((g) => g.close()));
  }
}
const drainNow = () => drainAll().catch((e) => ctx.logger.warn(`bakers drain failed: ${e.message}`));

const plugin = definePlugin({
  async setup(c) {
    ctx = c;
    // Picks up what a failed post, or a restart, left in the queue.
    ctx.jobs.register('drain', drainNow);
  },
  async onHealth() {
    return { status: 'ok', message: 'bakers-bridge ready' };
  },
  async onWebhook(input) {
    const res = await deliver(input, deps(await groups()));
    // The host answers a thrown delivery with 502 and records it as failed; bakers.build retries it.
    if (res.status !== 200) throw new Error(`${res.status} ${res.reason}`);
    // Answered at once: bakers.build gives up after 5 s. The read and the posts follow.
    void drainNow();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
