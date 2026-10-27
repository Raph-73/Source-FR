# Agent setup

Hermes here means **Hermes Agent by Nous Research**, not a Synthetiq-hosted service.
Each participant uses their own account. The kit includes no model credits or keys.
Instructions checked against official documentation on 17 September 2026. UI labels
and supported providers can change; use the linked official instructions if they differ.

## Preparation for every tool

Extract the kit. Install current Node.js LTS (22+) from https://nodejs.org/ and run
`node --version` and `npm --version`. Open a terminal in the extracted kit folder,
not inside the ZIP. Use `pwd` on macOS/Linux or `Get-Location` in PowerShell to check.
Run `node --test tests/kit.test.cjs`. You do not need Flutter to run these local tests.

Give the agent access only to this project, with approval prompts enabled. Model
credentials belong in the tool's sign-in/settings, never in module.json or chat logs.
Review the tool's provider pricing and spending limit before a long run.

## Codex

Install the official Codex app and open the extracted folder as a project, or use
the CLI: `npm install -g @openai/codex`, then run `codex` inside the folder. Sign in
through the tool. Ask it to read AGENTS.md and SYSTEM_PROMPT.md, then use
prompts/01-research.md. Review the plan before sending prompts/02-build.md.

CLI reference: https://developers.openai.com/codex/cli/
Official CLI source/install guide: https://github.com/openai/codex

## OpenCode

Install with `npm install -g opencode-ai`, then run `opencode` in the kit folder.
Use `/connect` to configure your provider. Select a model available to your account.
The kit already has AGENTS.md; review it rather than replacing it with `/init` output.
Use Plan mode for the research prompt, then Build mode after you approve the plan.
Attach/read SYSTEM_PROMPT.md and the selected prompt file.

Official instructions and Windows guidance: https://opencode.ai/docs/
Windows users can use the documented native installation or WSL route. Run Node and
the agent in the same environment so paths refer to the same extracted folder.

## Hermes Agent

Install through the official Hermes Desktop installer or follow the CLI installation
page for your operating system. Review shell installers before running them.
Run `hermes setup` to configure your model/provider, or `hermes model` to change it.
Open a terminal in the extracted kit and run `hermes`. Explicitly ask it to read the
workshop files and report its working directory. Use the research prompt, review it,
then send the build prompt. No Discord gateway, scheduled job or VPS is needed.
Use `hermes doctor` when setup fails. Container users must mount the workshop folder
and verify generated files appear on the host before closing the session.

https://hermes-agent.nousresearch.com/docs/getting-started/installation
https://hermes-agent.nousresearch.com/docs/getting-started/quickstart

## When something fails

- Command not found: restart the terminal and check the official installation/PATH steps.
- Model/authentication error: check the agent account, provider configuration and credits.
- File missing: confirm the working folder and extract the entire ZIP.
- Node check passes but Player fails: collect the app version and sanitized playback
  report. This is a runtime/device issue until investigated, not proof of bad Wi-Fi.
- Never approve a request to disable security protections or share your account key
  merely to make a workshop example run.
