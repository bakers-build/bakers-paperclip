// AC-1, AC-11: `docker compose up` runs the pinned Paperclip with bakers-bridge; a group is set up from agent/*.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ok } from './paperclip.mjs';
import { group, instance } from './fixture.mjs';

const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

it('runs Paperclip v2026.1117.0 from the pinned image digest', async () => {
  expect(compose).toContain('ghcr.io/paperclipai/paperclip@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1');
  const a = await instance();
  const health = ok(await a.api('GET', '/api/health'));
  // The v2026.1117.0 tag's commit.
  expect(health).toMatchObject({ status: 'ok', deploymentMode: 'authenticated', commit: 'c0f132898d2a2677312d8c72096187b27a3d9a38' });
});

it('has bakers-bridge installed and ready, with its webhook', async () => {
  const a = await instance();
  const plugin = ok(await a.api('GET', '/api/plugins/bakers-bridge'));
  expect(plugin.status).toBe('ready');
  expect(plugin.manifestJson.webhooks.map((w) => w.endpointKey)).toEqual(['bakers']);
});

it('sets up a group: company, PM agent with the repository’s locked-down config, bridge config', async () => {
  const { admin, agent } = await group();
  const saved = ok(await admin.api('GET', `/api/agents/${agent.id}`));
  const repo = JSON.parse(readFileSync(new URL('../../agent/adapter-config.json', import.meta.url), 'utf8'));
  expect(saved.adapterType).toBe('claude_local');
  expect(saved.adapterConfig).toMatchObject({ engine: 'cli', dangerouslySkipPermissions: false, extraArgs: repo.extraArgs });
});
