// agent/whois-mcp.mjs: the PM agent's one way to a requester's name and e-mail address.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect, it } from 'vitest';

const COMPANY = 'company-1';
const TOKEN = 'run-token';
const directory = {
  users: [
    { principalId: 'u-rita', status: 'active', membershipRole: 'operator', user: { id: 'u-rita', email: 'requester@example.org', name: 'Rita Requester', image: null } },
    { principalId: 'u-ada', status: 'active', membershipRole: 'owner', user: { id: 'u-ada', email: 'admin@example.org', name: 'Ada Admin', image: null } },
  ],
};

let paperclip, client, requests;
beforeAll(async () => {
  requests = [];
  paperclip = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    const ok = req.url === `/api/companies/${COMPANY}/user-directory` && req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? directory : { error: 'forbidden' }));
  });
  await new Promise((r) => paperclip.listen(0, '127.0.0.1', r));
  client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../agent/whois-mcp.mjs', import.meta.url))],
      // As Paperclip sets them for every agent run; PAPERCLIP_API_URL may end in /api.
      env: { PATH: process.env.PATH, PAPERCLIP_API_URL: `http://127.0.0.1:${paperclip.address().port}/api`, PAPERCLIP_API_KEY: TOKEN, PAPERCLIP_COMPANY_ID: COMPANY },
    }),
  );
});
afterAll(async () => {
  await client?.close();
  paperclip?.close();
});

const whois = async (user_id) => client.callTool({ name: 'whois', arguments: { user_id } });

it('offers exactly one tool, whois', async () => {
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['whois']);
});

it('returns a member’s name and e-mail address, read with the run’s own token', async () => {
  const res = await whois('u-rita');
  expect(res.isError).toBeFalsy();
  expect(JSON.parse(res.content[0].text)).toEqual({ id: 'u-rita', name: 'Rita Requester', email: 'requester@example.org' });
  expect(requests.at(-1)).toEqual({ url: `/api/companies/${COMPANY}/user-directory`, auth: `Bearer ${TOKEN}` });
});

it('refuses an ID that is no member of the agent’s company', async () => {
  const res = await whois('u-stranger');
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toMatch(/not a member/);
});
