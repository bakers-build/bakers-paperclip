// The bakers-bridge worker: Paperclip's I/O around core.mjs.
import { readFileSync } from 'node:fs';
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { connect } from './bakers-client.mjs';
import { deliver } from './core.mjs';

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

// One group's bakers access and task posts, under its own key and company.
function group(config, companyId, secret, key) {
  const g = { companyId, agentId: config.agentId };
  let client;
  const bakers = async () => (client ??= await connect(`${config.bakersUrl.replace(/\/+$/, '')}/mcp`, key));
  const read = async (uuid) => (await bakers()).call('bakers_ticket_read', { ticket: uuid, newest: 1000 });
  return {
    secret,
    paperclipUrl: config.paperclipUrl,
    zones: (config.previewZones ?? '').split(',').map((z) => z.trim().toLowerCase()).filter(Boolean),
    messages: MESSAGES[config.language ?? 'de'],
    readTicket: read,
    readComment: async (uuid, id) => (await read(uuid))?.comments?.find((c) => c.id === id) ?? null,
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

const plugin = definePlugin({
  async setup(c) {
    ctx = c;
  },
  async onHealth() {
    return { status: 'ok', message: 'bakers-bridge ready' };
  },
  async onWebhook(input) {
    // Every company with a bridge config is one group; the secret that verifies picks it.
    const configs = [];
    for (const company of await ctx.companies.list({ limit: 1000 })) {
      const config = await ctx.config.get(company.id).catch(() => null);
      if (config?.webhookSecret && config.bakersApiKey && config.agentId) configs.push([company.id, config]);
    }
    const groups = await Promise.all(
      configs.map(async ([companyId, config]) =>
        group(config, companyId, await secret(config.webhookSecret, companyId), await secret(config.bakersApiKey, companyId)),
      ),
    );
    const scope = (id) => ({ scopeKind: 'instance', stateKey: `event:${id}` });
    try {
      const res = await deliver(input, {
        groups,
        now: Date.now,
        seen: { has: async (id) => (await ctx.state.get(scope(id))) !== null, add: (id) => ctx.state.set(scope(id), true) },
        log: (level, message, meta) => ctx.logger[level](message, meta),
      });
      // The host answers a thrown delivery with 502 and records it as failed.
      if (res.status !== 200) throw new Error(`${res.status} ${res.reason}`);
    } finally {
      await Promise.all(groups.map((g) => g.close()));
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
