# Hackathon project – API3 part

- TUM Blockchain Hackathon, one project for the BSV and API3 tracks, theme agentic payments. Submission Sat 31.10. 15:00 on Devfolio
- My part: contract on Base Sepolia that verifies signed AirnodeHub responses and acts on them, plus the tamper test and the judge script
- Basics (addresses, chain, commands, checks, setup, wallets, anvil, branch workflow, parallel chats): see `API3-NOTES.md`. Read it before answering API3 questions
- Stack: Foundry, Node ≥ 22.18, pnpm, starter template `api3dao/airnodehub-hackathon-starter`
- The contract project lives in `api3/`: run forge and pnpm there. Deployer key in `.env`, agent key in `.env.agent` (both gitignored)
- The repo root `CLAUDE.md` / `AGENTS.md` describe the BSV monorepo (packages, release, governance). They do not apply inside `api3/`, which is a standalone Foundry project. Don't follow them here and don't touch files outside `api3/`

## Contract rules
- Testnet only. Keys only from `.env` / `.env.agent`, never log, print or commit them
- Never trust `airnode` or `requestHash` from a response, always the values stored in the contract
- Keep the three checks (signer, request, time) and replay protection in every change, run `forge test` after each change
- Check the API3 docs instead of guessing, quote the exact error
- Respect shared API quotas: cache responses, no polling loops

## Merge-ready design (API3 now, BSV later)
- The contract is a **verified-data gate others can consume**: every accepted value is stored (view function) and emitted as an event with everything a consumer needs (value, measured-at, signed-at, request hash, operation id). Chain-agnostic, no BSV logic in Solidity, no BSV code in `api3/`. The bridge/agent belongs to the team, not to this folder
- Airnode address and request hash are set at deploy/config time, never hardcoded (the feed may still change, Nodary has no BSV/USD)
- Expose a small TypeScript client in `api3/` (fetch signed response, verify off-chain, submit, read result) and keep deployed addresses in a JSON file, so the BSV side can import instead of rewriting
- The API3 standalone path (tamper test, judge script, demo on Base Sepolia) must never depend on BSV
- Agree the event/view/client interface with the BSV and bridge teammates **before** deploy. Changing it later is a big change

## Workflow rules
- **Plan first.** Before any non-trivial change, state the plan in 3–5 lines and wait for my ok
- **Second opinion only where it pays off.** A "big change" = touches signer/request/time/replay checks, adds a new contract or deploy, changes storage or the public interface, or spans more than ~80 lines across several files
  - Before a big change that is hard to undo (contract design, replay strategy, what gets deployed): spawn one Opus 5.5 subagent to check the approach, give it the relevant files and the plan
  - After a big change: spawn one Opus 5.5 review subagent (bugs, missed checks, weak tests), then fix what it finds
  - Scripts, tests, docs and small fixes: no subagent, `forge test` is enough
  - From Sat 12:00 no more subagents
- **Never break the working demo.** After every green step: commit + push. When something demo-worthy works, note the commit hash in `HANDOFF.md` as "last demo-ok". Risky changes only on top of a green state, if it goes wrong go back to that hash
- **Committing on the shared branch.** Before every commit check `git diff --cached` for private keys / RPC keys. Only stage files inside `api3/`, never `git add -A` at the root. Before push `git pull --rebase`, never force-push
- **Record deployments immediately.** Every deployed address + tx hash goes into `API3-NOTES.md` and the README right after deploy
- **New chat when the topic changes.** When a change is done and a new topic starts that would work better in a fresh chat, tell me. Before that: `forge test` green, update `api3/HANDOFF.md` (5–10 lines: what works, what's open, deployed addresses, last demo-ok hash), commit + push. A new chat reads `HANDOFF.md` first
- **Deadline.** Feature freeze Sat 11:00, after that only bugfixes, README, judge script and video. Submitted on Devfolio by Sat 13:30, not at 14:59

## Communication
- Write code, comments and docs in English. Talk to me in German, short and concrete, explain blockchain terms simply when I ask
