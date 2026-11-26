// The PM agent's one way to a Paperclip user's name and e-mail address: a stdio MCP server with
// the single tool `whois`. Paperclip passes only user IDs to the agent. Started by the Claude CLI
// per agent run (agent/mcp.json); reads the company's user directory with the run's own token
// from the env Paperclip sets for every run, so it reaches no other company and holds no secret.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID } = process.env;
const api = (PAPERCLIP_API_URL ?? '').replace(/\/+$/, '').replace(/\/api$/, '');

const TOOL = {
  name: 'whois',
  description: "A member of this Paperclip company by user ID (a task's createdByUserId, a comment's authorUserId): their name and e-mail address.",
  inputSchema: { type: 'object', properties: { user_id: { type: 'string', minLength: 1, description: 'Paperclip user ID.' } }, required: ['user_id'] },
};
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const server = new Server({ name: 'whois', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== TOOL.name) return refuse(`Unknown tool ${params.name}.`);
  const id = String(params.arguments?.user_id ?? '');
  if (!api || !PAPERCLIP_API_KEY || !PAPERCLIP_COMPANY_ID) return refuse('No Paperclip run context: PAPERCLIP_API_URL, PAPERCLIP_API_KEY or PAPERCLIP_COMPANY_ID is missing.');
  const res = await fetch(`${api}/api/companies/${encodeURIComponent(PAPERCLIP_COMPANY_ID)}/user-directory`, { headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` } });
  if (!res.ok) return refuse(`Paperclip refused the user directory (HTTP ${res.status}).`);
  const member = (await res.json()).users?.find((u) => u.principalId === id && u.user);
  if (!member) return refuse(`${id} is not a member of this company.`);
  return { content: [{ type: 'text', text: JSON.stringify({ id, name: member.user.name, email: member.user.email }) }] };
});
await server.connect(new StdioServerTransport());
