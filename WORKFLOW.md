# Paperclip — WORKFLOW

Invoke `bakers:bb-workflow` and follow it for the ticket's current state.

## bb-phase-provision

`docker compose --profile demo up -d` in the worktree, with `.env` from `.env.example` (README ›
Configuration; generate the secrets with `openssl rand -hex 32`). Paperclip is then on
http://localhost:3100 and `bakers-demo` on http://localhost:8090. Set up a group as README ›
Demo says; `tests/e2e/fixture.mjs` does it for tests. Test personas: the instance admin
`admin@example.org` and a requester (`operator` without grants, README › Invite a requester).

## bb-phase-work

Apply all matching rows.

| When | Skill |
|---|---|
| Agent instructions (the PM agent's persona, skills, other model-facing texts) | `mattpocock-skills:writing-for-agents` |

## bb-phase-validate

Apply all matching rows to the plan and final diff. Run each distinct command once per revision.

| When | Command |
|---|---|
| Any change | `pnpm test` |
| A change to `bakers-bridge/`, `agent/`, `demo/`, `docker-compose.yml` or `tests/e2e/` | `pnpm test:e2e` against the provisioned stack; the live agent tests need `ANTHROPIC_API_KEY` |

## bb-phase-deliver

Changes reach `main` through a GitHub pull request. Pull request titles are Conventional Commits
subjects (`feat: …`, `fix: …`, `ci: …`). This repository is public: a diff with a secret, token or
customer name is not delivered.

## bb-phase-transition

| State | Origin label |
|---|---|
| qualification | doing |
| plan | doing |
| working | doing |
| review | doing |
| done | review |
