// A bakers.build MCP client: one service account's key, its tools called by name.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Connects to `<BAKERS_URL>/mcp` with `Authorization: Bearer <key>`; throws when refused. */
export async function connect(url, key) {
  const client = new Client({ name: 'bakers-paperclip', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return {
    list: async () => (await client.listTools()).tools,
    /** The tool's JSON result; null when the tool refuses (not found, not readable). */
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) return null;
      for (const block of [...res.content].reverse()) {
        if (block.type !== 'text') continue;
        try {
          return JSON.parse(block.text);
        } catch {
          // The leading message block is plain text.
        }
      }
      return null;
    },
    close: () => client.close(),
  };
}
