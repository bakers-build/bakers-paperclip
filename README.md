# bakers-paperclip

[Paperclip](https://github.com/paperclipai/paperclip) as the place where a customer hands a
request to [bakers.build](https://bakers.build). One Paperclip company per bakers.build group,
one PM agent per company serving all of the group's projects. The agent specifies a request
with its requester and creates the bakers ticket; bakers.build reports the ticket's progress
back through a signed webhook, which the `bakers-bridge` plugin posts into the request's task.

This repository is public: no secret, token or customer name belongs in it.

| Path | What it is |
|---|---|
| `docker-compose.yml` | Paperclip v2026.1117.0 (pinned by digest) with this repository mounted read-only; profile `bakers` adds a local bakers.build |
| `bakers-bridge/` | Paperclip plugin: receives the bakers webhook, posts Hermes' fixed texts into the task as the PM agent |
| `agent/AGENTS.md` | the PM agent's instructions (Hermes' persona, adapted to Paperclip tasks and several projects) |
| `agent/adapter-config.json` | the PM agent's `claude_local` adapter config: Claude CLI with every built-in tool off but the skill loader |
| `agent/mcp.json` | the agent's only tools: bakers.build MCP, a read-only code reader, Paperclip's task tools |
| `scripts/skills.sh` | `pnpm skills` builds `agent/plugin/` (gitignored), the agent's skills, from pinned sources |
| `scripts/bakers-seed.sh` | `pnpm bakers:seed` fills the local bakers.build for the e2e tests |
| `Dockerfile` | the deployable image: Paperclip plus the runtime files (README › Deploy) |

Ticket work runs through [WORKFLOW.md](WORKFLOW.md).

## Start

```sh
cp .env.example .env   # fill in the values, see Configuration
mkdir -p data/clones
docker compose up -d   # Paperclip on http://localhost:3100
```

Open Paperclip, create the first account and choose *Claim this instance*. Then install the
plugin once, as the instance admin: *Settings › Plugins › Install from local path*
`/opt/bakers-paperclip/bakers-bridge`, or

```sh
curl -X POST http://localhost:3100/api/plugins/install -H 'content-type: application/json' \
  -H 'origin: http://localhost:3100' -b <your session cookie> \
  -d '{"packageName":"/opt/bakers-paperclip/bakers-bridge","isLocalPath":true}'
```

### Local bakers.build

`docker compose --profile bakers up -d` runs a real bakers.build v0.14.0 (its standalone stack,
pinned by digest) at http://bakers.localhost:8080, with Mailpit for its sign-in mails at
http://localhost:8125. The first start installs it with `BAKERS_ADMIN_EMAIL` as admin; a login
link: `docker compose exec bakers-php drush uli --uri=http://bakers.localhost:8080`. Inside the
compose network Paperclip reaches it as `http://bakers-gateway`, a PM agent's `BAKERS_URL`;
Claude's CLI resolves every `*.localhost` name to itself, so the name from this machine fails there. It has no webhook yet, so nothing reaches the bridge from it.

`pnpm bakers:seed` fills it for the e2e tests and for trying it out: group *Demo* with projects
`DEMO` (Demo Shop, one conductor) and `DEMO2` (Demo Blog), group *Other customer* with
`FOREIGN`, the users `requester@example.org` and `developer@example.org`, and the PM agent's
service account *PM Agent E2E* in the Demo team only, whose new key it writes into `.env` as
`BAKERS_E2E_API_KEY`. Set up a group as below with `BAKERS_URL` `http://bakers-gateway` and that
key; `tests/e2e/fixture.mjs` does exactly that.

## Deploy

A tag `v<version>` builds `ghcr.io/bakers-build/bakers-paperclip:<version>`
(`.github/workflows/release.yml`): the pinned Paperclip image plus this repository's runtime files
at `/opt/bakers-paperclip` (`Dockerfile`):

- `agent/mcp.json` and `agent/whois-mcp.mjs`, which every agent run loads;
- `agent/plugin/`, the skills, built in the image from their pinned sources;
- `bakers-bridge/`, which the plugin install takes from that path;
- `node_modules`: the bridge's and whois' dependencies and the agent's filesystem and Paperclip
  MCP servers, pinned in `package.json` and the lockfile.

Run it like the upstream image, with `docker-compose.yml`'s environment and a volume for
`/paperclip`, without the repository mount. `agent/AGENTS.md` and `agent/adapter-config.json` are
not in it: they are pasted into Paperclip per group (*Set up a group*). The plugin itself is installed
once per instance (*Start*): that is a database entry pointing at
`/opt/bakers-paperclip/bakers-bridge`, so a new image brings new bridge code on restart. `sh scripts/image-smoke.sh <image>` checks an image; CI builds
and checks it on every pull request.

## Set up a group

Once per bakers.build group, as the instance admin:

0. **Skills**, once per instance: `pnpm skills` builds `agent/plugin/`, which the agent's Claude
   CLI loads from the mounted repository (`--plugin-dir`).
1. **Company.** Create a company named after the group.
2. **Secrets** (*Company › Secrets*): `BAKERS_API_KEY`, the API key of the group's bakers.build
   service account, a member of exactly the group's projects; `BAKERS_WEBHOOK_SECRET`, the
   signing secret of the group's bakers.build webhook.
3. **PM agent.** Create an agent with adapter `claude_local` and runner `legacy` (Paperclip's
   own runner refuses `extraArgs`). Paste `agent/adapter-config.json` as its adapter config and
   set `env.BAKERS_API_KEY.secretId` to the secret's ID and `env.BAKERS_URL` to the bakers.build
   URL. Give it `agent/AGENTS.md` as its instructions and fill in the two lines of its
   *Host context* section: the Paperclip URL and the company's language (`de` or `en`).
4. **Projects.** One Paperclip project per bakers.build project of the group, named like it,
   its description starting with `bakers.build: <project key>`. Requesters file a task in its
   project; the agent creates the ticket there.
5. **Code context.** Put read-only, secret-free clones of the group's projects under
   `PM_CLONES_DIR/<project key>`; the agent reads them through the code reader at `/clones`.
6. **Bridge** (*Settings › Plugins › bakers-bridge*, for this company): `bakersUrl`,
   `language`, `agentId` (the PM agent), `webhookSecret` and `bakersApiKey` (the two secrets).
7. **Webhook.** Register `<PAPERCLIP_PUBLIC_URL>/api/plugins/bakers-bridge/webhooks/bakers`
   in bakers.build for the group's projects, signed with `BAKERS_WEBHOOK_SECRET`.

### Invite a requester

Invite them to the company as `operator`, then remove every grant (*Company › Members ›
<member> › Role and grants*: role `operator`, no grants). They then file tasks, follow and
answer them, and configure nothing: `operator`'s default grants include `agents:configure`,
with which a requester could turn the PM agent's lock-down off, and `viewer` cannot file a
task. `tests/e2e/operator.test.mjs` checks this.

## Configuration

`.env` (gitignored; `.env.example` lists the keys):

| Value | Where it comes from |
|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32`, once; Paperclip's session signing key. Keep it across restarts. |
| `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` | `openssl rand -hex 32`, once, separate from the one above; signs approval-gated tool actions. |
| `PAPERCLIP_PUBLIC_URL` | the URL people open Paperclip at; the PM agent links tasks under it (its *Host context*). |
| `PAPERCLIP_PORT` | the host port, default 3100. |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | further hostnames Paperclip accepts, comma-separated; `paperclip` (the compose network name) is always added. |
| `ANTHROPIC_API_KEY` | an Anthropic API key for the PM agents' Claude CLI; or leave it empty and set the next one. |
| `CLAUDE_CODE_OAUTH_TOKEN` | a Claude subscription token: run `claude setup-token` and copy the token it prints. |
| `PM_CLONES_DIR` | the host directory with the groups' read-only project clones, default `./data/clones`. |
| `BAKERS_DB_PASSWORD`, `BAKERS_DB_ROOT_PASSWORD` | local bakers.build only: `openssl rand -hex 16` each. |
| `BAKERS_HASH_SALT` | local bakers.build only: `openssl rand -hex 32`. |
| `BAKERS_ADMIN_EMAIL` | local bakers.build only: its first admin; any address, the mail goes to Mailpit. |
| `BAKERS_E2E_API_KEY` | tests only: written by `pnpm bakers:seed`, the seeded service account's key (`<client_id>:<secret>`). |

Per group, in Paperclip (see *Set up a group*): the bakers.build service account's API key and
the webhook signing secret, both from bakers.build, as company secrets.

## The webhook

bakers.build's webhook is not built yet; the bridge accepts this contract, and the bakers.build
side should build against it or the bridge adapts.

- `POST` JSON `{event_id, type, occurred_at, ticket: {uuid, identifier, parent_uuid?}, data}`.
- Types and `data`: `ticket.state_changed {from, to}`, `ticket.labels_changed {added, removed}`,
  `comment.created {comment_id, type}`, `run.started {state_at_start}`,
  `run.finished {state, state_at_start}`, `ticket.link_added {uri, title}`.
- Headers: `X-Bakers-Signature: sha256=<hex HMAC-SHA256 of the raw body>`,
  `X-Bakers-Timestamp: <unix seconds>`, within ±5 minutes.
- The bridge reads the ticket itself with the group's key, finds the task among the ticket's
  links ending in `/<prefix>/issues/<PREFIX-n>`, the one its company holds (else its parent's,
  posting behind the sub-ticket's identifier), and posts each text once per `event_id`.
- Only fixed texts, a question's note and links reach the task: state lines (done with the
  ticket link), run lines, the lead-in of a question or technical problem with its note, and a
  new preview link (designbook, DDEV). Summaries are written for developers, so `comment.created`
  posts nothing; what came out and where to test are on the ticket, or the PM agent tells.
- Answers: 200 handled or a repeat; a wrong signature, an unknown ticket or a ticket without a
  task is refused, logged, and recorded by Paperclip as a failed delivery with status 502
  (Paperclip answers every refusal of a plugin webhook with 502).
- Delivery is at least once; there is no poller, so an event is lost when Paperclip stays
  unreachable longer than bakers.build retries (24 h). A catch-up on start is a follow-up.

What the Hermes poller said and the bridge does not: the *still working* heartbeat (no event
carries it), closing a request that stays silent for a week, and the sentences it took from
summaries (*Outcome*, *Manual review*). All are dropped.

## Tests

```sh
pnpm install
pnpm test                                # contract and unit tests
pnpm skills
docker compose --profile bakers up -d
pnpm bakers:seed
pnpm test:e2e                            # against Paperclip and the local bakers.build
```

bakers.build has no webhook yet, so the e2e tests send its events themselves, signed, while
the tickets live in the local bakers.build. `tests/e2e/agent.test.mjs` runs the live PM agent and needs `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`; without either, those tests are skipped. CI (`.github/workflows/test.yml`) runs both suites, the live ones only
when the repository secret `ANTHROPIC_API_KEY` is set.
