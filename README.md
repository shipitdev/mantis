# Mantis

Mantis is a thin, model-flexible fork of [Pi](https://github.com/earendil-works/pi), based on Pi v1.4.0 with upstream changes through commit `ede2c9b46`. It preserves Pi's package identities and APIs, and uses Pi's MIT license ([LICENSE](LICENSE)). The source is maintained at [shipitdev/mantis](https://github.com/shipitdev/mantis).

## Run from source

Requires Node.js 22.19 or newer.

```bash
npm ci --ignore-scripts
npm run hydrate:model-data
./mantis --help
```

Model-data hydration fetches public provider catalog data; it does not submit prompts or require model credentials. Run `./mantis` from the project directory where you want the agent to work. Configure credentials through the command's login flow or in the private `~/.mantis/agent/` files. Submitting prompts may incur provider charges.

Mantis is in development. Its command is `mantis`; additional harness capabilities are not yet claimed as available.

## Mantis and upstream Pi

Pi provides the agent, tools, providers, and sessions. Mantis uses the existing UI and reads its name, display title, config directory, and self-update policy from package metadata. Future Mantis features belong in separate extension files under `mantis-layer/` rather than another copy of Pi's core.

The exact upstream source commit and the intentional changes to Pi-owned files are recorded in [mantis-layer/upstream.json](mantis-layer/upstream.json). Check the boundary with:

```bash
node mantis-layer/check-upstream.mjs
```

This checks changed file paths, not API compatibility or correctness. The Mantis CI checks the combined application. Its manually triggered **Mantis Upstream Sync Report** workflow tries a selected stable Pi tag in a disposable checkout and retains the diff, conflicts, and check results. It does not commit, push, merge into the integration branch, or publish.

After accepting an upstream update, record its version and exact commit in `mantis-layer/upstream.json`, review the remaining patch list, and rerun the checks before committing.

## Development

The Nix build uses the catalog revision pinned in [nix/model-catalog.json](nix/model-catalog.json). For source updates, use reviewed changes from the [Mantis fork](https://github.com/shipitdev/mantis). The [Pi project](https://github.com/earendil-works/pi) remains the upstream foundation.

Application self-update is disabled so it cannot replace Mantis with upstream Pi. Update this fork through reviewed upstream releases. `mantis update --extensions` and `mantis update --models` remain available.
