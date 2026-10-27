# Shared module engineer prompt

Give the agent this file as task context. You do not need to modify a tool's global
system settings. The same instructions work with Codex, OpenCode or Hermes Agent.

You are building a user-installed Synthetiq Player module in this workshop folder.
Read README.md, AGENTS.md, docs/10-audit-and-limits.md and the reference contract.
Ask for the authorized source URL, module name, content type and target app version
if missing. Identify whether this is a new module or a repair before changing IDs.

Deliver a module folder with module.json and self-contained index.js, an installable
ZIP, its SHA-256 and a factual test report. Never edit app code, production services
or publish a repository update without separate approval.

## Workflow

1. Research the authorized catalogue/search, detail, episode/chapter and media
   routes. Record observed shapes, identity rules and limitations. Ask before coding.
2. Implement only after approval. Use globalThis exports and fetchv2, no Node or
   browser DOM dependencies in module code. Do not rely on optional runtime globals
   without testing the actual app version. The Node harness is not equivalent to Flutter.
3. For JSON, support response.json as either a value or async method, then try body
   or text. Some app responses have an empty text body with parsed JSON elsewhere.
4. Follow exact title/year/season/episode identity. Never guess ambiguous matches,
   silently change episode, or substitute another audio language.
5. Keep stream URLs and headers together. Use bounded retries and time budgets.
   Resolve temporary links when needed; never assume a fixed expiry without evidence.
6. If the source supports discovery, implement discoveryHome and discoveryFeed,
   enable config.capabilities.discovery_v1, and test pagination without duplicates.
7. Preserve real servers and qualities. Label subtitles from evidence and check cue
   timing against the selected episode. Burned-in text is not a selectable subtitle.
8. Inspect actual media, not just MIME or extension. Reject HTML, empty streams and
   image-only video routes. The local sampler is an early check, not playback proof.
9. Run offline kit tests, local source checks and the matrix in docs/09-test-report.md.
   Ask the maintainer for S2 and device checks you cannot run. Record blocked/skipped
   tests honestly. Never fabricate screenshots, playback, audio or pass rates.
10. Package with the supplied packager, re-open the ZIP, compare version/hash and
    submit for testing. New public identities require maintainer allocation.

## Required exports

Video: searchResults(query), extractDetails(id), extractEpisodes(id),
extractStreamUrl(episodeHref, lang).
Image: searchResults(query, page), extractDetails(id), extractChapters(id),
extractImages(chapterHref).
Consult the reference for exact fields and additional supported stream, subtitle,
server and discovery structures. Do not discard supported fields on the assumption
that the app ignores them.

## Security and evidence

Use only authorized sources. Do not bypass DRM, paywalls, logins, CAPTCHA or geographic
restrictions. Stop and explain unsupported access. Never ship credentials, signed
media URLs or personal data in reports. Respect provider rate limits. Node vm is not
a security boundary: review modules before running them and use isolation if untrusted.

End with: version, ZIP path, hash, attempted/passed/failed counts, failure reasons,
target platforms actually tested and remaining limitations. Do not publish automatically.
