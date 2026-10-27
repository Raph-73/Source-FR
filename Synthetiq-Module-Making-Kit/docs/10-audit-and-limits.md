# Workshop audit and limits

Audit date: 17 September 2026. The original kit contains useful contract snapshots,
movie/manga templates and historical examples. It was not sufficient as an unattended
beginner workshop: setup, verification and packaging had material gaps.

## Corrections in this edition

- Added Codex, OpenCode and Hermes setup, research/build/repair prompts, a guided
  exercise, an evidence form and explicit project guardrails.
- Replaced the checker that rejected HLS MIME types while accepting arbitrary
  octet-stream responses. The new bounded sampler recognizes container signatures,
  follows a simple HLS variant to media, and rejects image/HTML masquerading as video.
- Added string URL and labelled stream-pair handling, route-specific headers,
  explicit selection bounds and preliminary discovery checks.
- Capped media reads and local bridge responses. Cross-origin redirects strip
  explicit Cookie/Authorization headers. Added a module-load timeout and cleared
  completed handler timers. These changes do not make Node vm safe for hostile code.
- Replaced the external `zip` dependency with a small portable ZIP writer. Added
  version/path validation, runtime entry and identity checks. Unallocated identities
  cannot produce a stable package. A successful beta package still needs app import.
- Made the movie starter fail closed until the author implements real validation,
  rather than returning anything that happened to give HTTP 200.

## Read these before the historical notes

1. The example modules are source snapshots, not promises that their providers work
   today. Their official identity numbers belong to their existing module families.
   Copying them unchanged can collide with installed modules. Develop a new identity.
2. Old runtime notes say certain globals never exist. Treat these as conservative
   compatibility constraints, not a guarantee across every platform/version. The
   local VM exposes some JavaScript globals that a target engine may not. Test Flutter.
3. The Node cookie jar is deliberately incomplete: it does not implement browser
   path/domain/expiry/SameSite behavior or every redirect/compression rule. Stateful
   sources need actual-runtime checks. Do not use this harness for private accounts.
4. The local checker does not prove media decoding, all playlist variants/segments,
   audio language, subtitles, title identity or device lifecycle behavior. Some valid
   HLS forms need the full tester. A signature is structural evidence only.
5. URLs with image extensions require byte inspection. A genuine image cannot be
   passed off as a normal video segment. Unsupported wrappers require separate
   compatibility work; do not rename or relabel them to force a pass.
6. The two-file format is this starter's packaging convention. The full contract
   supports more layouts/features. The supplied packager intentionally includes only
   module.json and index.js. Bundle source code into index.js if your project grows.
7. Templates remain incomplete by design. Replace all TODOs, placeholder URLs and
   metadata. A missing source or credentials is not something the kit can supply.
8. Public access is not permission to redistribute. Review source terms and rights.
   Keep personal provider keys out of distributable code and archives.

## Verification scope

The kit's offline tests cover the modified helper behavior with synthetic fixtures.
The final run reported 17 passing tests (including nested end-to-end cases), zero
failures. Node ran the helper and local HTTP fixture checks on macOS. The portable
packager has no platform-specific shell dependency, but Windows execution was not
tested on a Windows device in this audit.
The audit compares the reference contract with the local Player documentation.
No production app or official module/repository was changed. No reference module
received live S2 or physical-device certification in this workshop audit. Participants
need their own authorized source and the maintainer's release gate.
