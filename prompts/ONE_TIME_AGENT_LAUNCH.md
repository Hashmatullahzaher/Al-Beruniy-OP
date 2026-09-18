# One-Time Agent Launch Guide

Use these prompts once when starting each connected coding agent.

## Claude
Open:
`prompts/CLAUDE_MASTER_PROMPT.md`

Instruction to send:
> Read and execute `prompts/CLAUDE_MASTER_PROMPT.md` exactly. Use the repository as the source of truth. Coordinate continuously through WORK_STATUS and RELEASE_READINESS. Do not wait for module-by-module prompts.

## Codex
Open:
`prompts/CODEX_MASTER_PROMPT.md`

Instruction to send:
> Read and execute `prompts/CODEX_MASTER_PROMPT.md` exactly. On a fresh build, claim WP-0001 and continue through eligible work packages using repository state. Do not wait for module-by-module prompts.

## Antigravity
Open:
`prompts/ANTIGRAVITY_MASTER_PROMPT.md`

Instruction to send:
> Read and execute `prompts/ANTIGRAVITY_MASTER_PROMPT.md` exactly. Coordinate through repository state, avoid duplicating claimed work, and continue through eligible work/review until Release 1 is complete or externally blocked.

## Important
The agents do not receive separate prompts for Sales, Finance, Construction, HR, AI, Telegram or any later module. They discover and execute the next work from:
- `docs/04-delivery/BUILD_WORK_PACKAGES.md`
- `docs/04-delivery/WORK_STATUS.md`
- `docs/04-delivery/AGENT_COORDINATION.md`
- `docs/04-delivery/MASTER_BUILD_RUNBOOK.md`
- `docs/04-delivery/RELEASE_READINESS.md`
