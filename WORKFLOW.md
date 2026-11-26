# Paperclip — WORKFLOW

Invoke `bakers:bb-workflow` and follow it for the ticket's current state.

## bb-phase-provision

In the worktree, with `.env` from `.env.example` (README › Configuration; generate the secrets with
`openssl rand -hex 32`): `pnpm install && pnpm skills && docker compose --profile bakers up -d &&
pnpm bakers:seed`. Paperclip is then on http://localhost:3100, a local bakers.build on
http://bakers.localhost:8080 (login link: `docker compose exec bakers-php drush uli
--uri=http://bakers.localhost:8080`, mail in Mailpit on http://localhost:8125). Set up a group as
README › Local bakers.build says; `tests/e2e/fixture.mjs` does it for tests. Test personas: the
Paperclip admin `admin@example.org` and a requester (`operator` without grants, README › Invite a
requester).

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
| A change to `bakers-bridge/`, `agent/`, `scripts/`, `docker-compose.yml` or `tests/e2e/` | `pnpm test:e2e` against the provisioned stack; the live agent tests need `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |

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
