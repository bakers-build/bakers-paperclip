// The bakers-bridge plugin manifest. Each company configures its own bakers.build group: its PM
// agent, its webhook secret and its bakers key.
const secretRef = { type: 'object', title: 'Company secret', properties: { type: { const: 'secret_ref' }, secretId: { type: 'string' } }, required: ['type', 'secretId'] };

export default {
  id: 'bakers-bridge',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'bakers.build bridge',
  description: 'Posts what happens to a bakers.build ticket into the Paperclip task it came from.',
  author: 'bakers.build',
  categories: ['automation'],
  capabilities: ['webhooks.receive', 'companies.read', 'issues.read', 'issue.comments.create', 'plugin.state.read', 'plugin.state.write', 'secrets.read-ref', 'http.outbound'],
  entrypoints: { worker: './worker.mjs' },
  webhooks: [{ endpointKey: 'bakers', displayName: 'bakers.build events', description: 'Signed bakers.build ticket events.' }],
  // Per company: each company is one bakers.build group.
  instanceConfigSchema: {
    type: 'object',
    required: ['bakersUrl', 'agentId', 'webhookSecret', 'bakersApiKey'],
    properties: {
      bakersUrl: { type: 'string', title: 'bakers.build URL', default: 'https://app.bakers.build' },
      language: { type: 'string', title: 'Language of the fixed texts', enum: ['de', 'en'], default: 'de' },
      agentId: { type: 'string', title: 'PM agent ID, the author of the posts' },
      webhookSecret: { ...secretRef, title: 'The group’s webhook signing secret' },
      bakersApiKey: { ...secretRef, title: 'The group’s service-account API key' },
    },
  },
};
