# Synthetiq Player Module Making Kit

Workshop edition, 17 September 2026. Build video (movies, shows, anime) and image
(manga/comics) modules with Codex, OpenCode or Hermes Agent by Nous Research.
Text and Live modules are outside this workshop's scope.

## Start here

1. Extract this entire kit into a writable folder. Do not import the kit ZIP into Player.
2. Install a supported Node.js LTS release, version 22 or newer, from https://nodejs.org/.
   Run `node --version`. The kit tools use Node built-ins, with no npm install needed.
3. Read `docs/07-agent-setup.md` for your chosen agent. A model account is separate
   from this kit and may cost money. Keep credentials outside the project.
4. Run the offline checks: `node --test tests/kit.test.cjs`.
5. Open `docs/08-workshop.md` and start the guided exercise.

## Folder map

| Path | Purpose |
| --- | --- |
| `SYSTEM_PROMPT.md` | Shared instructions for any coding agent |
| `Synthetiq-Module-Workshop.pptx` | 22-slide teaching deck with presenter notes |
| `AGENTS.md` | Project guardrails for agents that read this file |
| `prompts/` | Copy-ready research, build and repair requests |
| `docs/01` through `docs/06` | Module concepts, contracts and site-specific reference notes |
| `docs/07-agent-setup.md` | Codex, OpenCode and Hermes setup |
| `docs/08-workshop.md` | Beginner exercise, packaging and importing |
| `docs/09-test-report.md` | Test matrix and handoff template |
| `docs/10-audit-and-limits.md` | What changed and what remains unverified |
| `reference/` | Snapshot of app contract documentation, not the full app |
| `templates/` | Incomplete video/image starters and a portable packager |
| `examples/` | Historical source examples for study, not certified releases |
| `tools/` | Partial Node runtime and bounded structural media checks |
| `tests/` | Offline regression tests of the kit tools |

## Common commands

Run these from the extracted kit root. Use quotes around paths containing spaces.

```text
node --test tests/kit.test.cjs
node tools/run_checks.cjs MyModule --query "Exact Title" --result 1 --ep 1 --lang sub
node templates/package.cjs --dir MyModule --version 1.0.0-beta.1
```

`--result` and `--ep` mean 1-based list positions, not title IDs or episode
numbers. Confirm the selected title and episode in the output. Out-of-range
positions fail instead of silently choosing another episode.

The module ZIP contains `module.json` and `index.js` at its root. The kit ZIP
contains this whole workshop. They are different files with different purposes.

## What this kit does and does not contain

It supplies the source templates, documentation and tools needed to develop a
module. You still need an authorized source, source-specific extraction code,
Synthetiq Player for import/playback testing, and a model account for AI assistance.
The complete Flutter app, S2 tester, official registry and signing credentials
are not included. Ask the maintainer to run S2 before an official video release.

The local checker samples container signatures, a single HLS route, or the first
and last manga image. It cannot certify audio language, subtitle sync, full-file
integrity, all qualities, device decoding, downloads or offline playback.
HLS encryption, init maps and byte ranges need the full tester. A checker failure
can be a checker limitation, not proof the source is broken.

## Important rules

- Node `vm` is not a secure sandbox. Inspect code before running it. Use a disposable
  container or separate account with no secrets for untrusted modules.
- Only use content/APIs you have permission to access and distribute. Public
  accessibility does not establish permission. No access-control or DRM bypass.
- Never publish the example identities as your own. Keep lineage when repairing
  an existing module; obtain an allocated identity for a new public module.
- Templates intentionally contain TODOs and `.test` domains. They are not working modules.
- Legacy examples may have changed upstream. Movie Direct needs personal TMDB
  configuration for private testing. Do not ship account keys inside a public ZIP.
- Keep app code and production repositories out of the agent's scope. Publish only
  after maintainer approval, actual app testing and a version/hash check.

When guidance conflicts, use the verified target app contract and the corrections
in `docs/10-audit-and-limits.md`. The local harness is only a partial approximation.
