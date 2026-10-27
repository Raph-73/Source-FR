# Guided workshop

## Exercise 1: understand the folder

Ask your agent to explain module.json and index.js without changing files.
A manifest identifies/configures the module. JavaScript supplies data using the
exports Player calls. Player owns the UI, playback controls and local storage.
The source owns its catalogue and media availability. An AI agent writes code on
your computer; it does not run inside the finished module.

## Exercise 2: create a starter

Ask the agent: "Create MyModule/ by copying templates/module.movie.template.json
to MyModule/module.json and templates/index.movie.template.js to MyModule/index.js.
For a manga source use the corresponding manga templates. Do not implement yet."

Review the new files. Change the ID, name, family and authorized source URL together.
Use a beta version. Placeholder identity 0 is only for development and may require
maintainer allocation before import on a strict app build. Never reuse official IDs.
The `.test` domains are intentionally non-working placeholders.

## Exercise 3: research and implement

Use prompts/01-research.md with one source you own or have permission to integrate.
Review the map of search, details, list and content endpoints. Then use
prompts/02-build.md. Every TODO needs real implementation and test evidence.
For a first exercise, prefer your own small catalogue and direct MP4/image files
over login-protected or complicated third-party players.

## Exercise 4: inspect and package

```text
node --test tests/kit.test.cjs
node tools/run_checks.cjs MyModule --query "Exact Title" --result 1 --ep 1 --lang sub
node templates/package.cjs --dir MyModule --version 1.0.0-beta.1
```

The packager writes a ZIP and .sha256 under MyModule/dist/. It includes only
module.json and index.js, not prompts, personal accounts, test logs or API keys.
Inspect the ZIP contents in your file manager. A successful package is not a test
result and does not publish anything. The Node tool works without a system `zip` command.

## Exercise 5: test inside Player

Transfer the module ZIP to your device. In Player, open Settings, Media & Sources,
then the file/package import action (labels vary by version). Choose the module ZIP,
not this kit ZIP or the extracted folder. Select the source after import.

Confirm the displayed module version. Check home artwork and pagination, search,
details, episode/chapter order and exact content. For video, watch with sound, seek,
pause/resume, change quality/server, check subtitles and download/offline separately.
For manga, inspect first/middle/last pages, page order and protected image headers.
Keep an existing working source installed so a failed test does not block your use.

## Final handoff

Complete docs/09-test-report.md. Send the beta ZIP, hash and sanitized evidence to
the maintainer. Ask for identity allocation and S2 certification for video releases.
Publish to a testing catalogue only after approval, verify the downloaded bytes, and
move to stable only after the release gate passes. Creating a repository index or
signing a release is a separate maintainer task, not part of this beginner kit.
