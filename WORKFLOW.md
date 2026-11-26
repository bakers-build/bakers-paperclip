# Paperclip — WORKFLOW

Invoke `bakers:bb-workflow` and follow it for the ticket's current state.

## bb-phase-provision

No runtime yet. The ticket that adds a local Paperclip setup also writes this section.

## bb-phase-work

Apply all matching rows.

| When | Skill |
|---|---|
| Agent instructions (the PM agent's persona, skills, other model-facing texts) | `mattpocock-skills:writing-for-agents` |

## bb-phase-validate

Apply all matching rows to the plan and final diff. Run each distinct command once per revision.

| When | Command |
|---|---|
| Any change | None yet. The ticket that adds the first tests also adds their command here. |

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
