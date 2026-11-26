// AC-7: the PM agent's configuration keeps it locked down. Fails when the configuration loosens.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const adapter = read('agent/adapter-config.json');
const mcp = read('agent/mcp.json');

// Note bad4e721 (the 9 tools) and the spec's project_list and project_read, as bakers.build's /mcp names them.
const BAKERS = ['ticket_create', 'ticket_read', 'ticket_search', 'ticket_update', 'ticket_transition', 'ticket_classify', 'comment_create', 'conductor_list', 'user_read', 'project_list', 'project_read'].map(
  (t) => `mcp__bakers__tool_api__bakers_${t}`,
);
const CODE = ['read_text_file', 'list_directory', 'directory_tree', 'search_files', 'get_file_info'].map((t) => `mcp__code__${t}`);
// The task tools the agent needs to read its task and answer in it.
const PAPERCLIP = ['paperclipGetIssue', 'paperclipListComments', 'paperclipAddComment', 'paperclipUpdateIssue', 'paperclipGetProject', 'paperclipListProjects'].map((t) => `mcp__paperclip__${t}`);
const CODE_WRITES = ['write_file', 'edit_file', 'create_directory', 'move_file'].map((t) => `mcp__code__${t}`);

const flag = (name) => {
  const i = adapter.extraArgs.indexOf(name);
  return i < 0 ? undefined : adapter.extraArgs[i + 1];
};

describe('adapter config', () => {
  it('runs the Claude CLI engine, where extraArgs apply, without skipping permissions', () => {
    expect(adapter.engine).toBe('cli');
    expect(adapter.dangerouslySkipPermissions).toBe(false);
    expect(adapter.chrome ?? false).toBe(false);
  });

  it('turns every built-in tool off but the skill loader: no shell, file, web or subagent tool', () => {
    // Skill only loads a skill's instructions (bb-create-ticket and its recipes); it runs nothing.
    expect(flag('--tools')).toBe('Skill');
    expect(adapter.extraArgs).not.toContain('--dangerously-skip-permissions');
  });

  it('loads the pinned skill bundle as a plugin from this repository', () => {
    expect(flag('--plugin-dir')).toBe('/opt/bakers-paperclip/agent/plugin');
  });

  it('loads only this repository’s MCP config, strictly', () => {
    expect(flag('--mcp-config')).toBe('/opt/bakers-paperclip/agent/mcp.json');
    expect(adapter.extraArgs).toContain('--strict-mcp-config');
  });

  it('allows exactly the bakers allowlist, the clone reader’s read tools and the task tools', () => {
    expect(flag('--allowedTools').split(',').sort()).toEqual(['Skill', ...BAKERS, ...CODE, ...PAPERCLIP, 'mcp__whois__whois'].sort());
  });

  it('denies the clone reader’s write tools outright', () => {
    expect(flag('--disallowedTools').split(',')).toEqual(expect.arrayContaining(CODE_WRITES));
  });

  it('takes the bakers key from a company secret, never a plain value', () => {
    expect(adapter.env.BAKERS_API_KEY.type).toBe('secret_ref');
  });
});

describe('MCP config', () => {
  it('has exactly the bakers, clone reader, Paperclip and whois servers', () => {
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['bakers', 'code', 'paperclip', 'whois']);
  });

  it('runs whois from this repository, with the run’s env only', () => {
    expect(mcp.mcpServers.whois).toEqual({ type: 'stdio', command: 'node', args: ['/opt/bakers-paperclip/agent/whois-mcp.mjs'] });
  });

  it('reaches bakers.build only over its MCP endpoint with a bearer key from the env', () => {
    expect(mcp.mcpServers.bakers).toEqual({ type: 'http', url: '${BAKERS_URL}/mcp', headers: { Authorization: 'Bearer ${BAKERS_API_KEY}' } });
  });

  it('reads code from the clones directory through a pinned filesystem server', () => {
    expect(mcp.mcpServers.code).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2.2.0', '/clones'] });
  });

  it('reaches the task through the pinned Paperclip MCP server with the run’s own key', () => {
    expect(mcp.mcpServers.paperclip).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@paperclipai/mcp-server@2026.1117.0'] });
  });

  it('commits no token: every credential is an env reference', () => {
    const text = JSON.stringify([adapter, mcp]);
    expect(text).not.toMatch(/Bearer (?!\$\{)|sk-ant-|bb_[A-Za-z0-9]{16,}|"(?:api_?key|token|secret)"\s*:\s*"[^$]/i);
  });
});
