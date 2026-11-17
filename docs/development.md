# Developing Anvil

Use Node.js 22.18 or newer. Run `npm ci` from the repository root to install the
versions recorded in `package-lock.json`.

## Folder layout

| Path | Contents |
| --- | --- |
| `src/extension.ts` | VS Code activation and feature wiring |
| `src/chat/`, `src/inline/` | Chat sessions and selection-scoped edits |
| `src/context/`, `src/workspace/` | Retrieval, code graphs, and workspace access |
| `src/drafts/`, `src/review/` | Pending proposals, persistence, and Keep/Reject |
| `src/forge/`, `src/models/`, `src/mcp/` | TrueForge integration, model limits, and editor tools |
| `src/shared/` | Contracts shared by the extension and webview |
| `webview/` | Preact components and VS Code theme styles |
| `agents/` | The TrueForge agent definition |
| `scripts/` | Builds, local services, setup, previews, and diagnostics |
| `scripts/lib/` | Helpers for standalone scripts |
| `test/unit/` | Tests grouped by source feature, plus standalone script tests |
| `test/webview/`, `test/e2e/` | Component tests and real VS Code integration tests |
| `test/eval/`, `test/live/` | Retrieval evaluations and tests against real models |
| `test/config/`, `test/support/`, `test/fixtures/` | Suite configuration, shared helpers, and sample projects |
| `docs/examples/` | Copyable configuration examples |

Keep editor-independent logic in its feature folder. Shared message contracts
belong in `src/shared/`; browser components stay in `webview/`. Put new unit tests
under the matching `test/unit/<feature>/` folder. Use `test/support/paths.ts` for
fixture and project paths so tests do not depend on their nesting depth.

## Checks and builds

```sh
npm run check       # host/webview typechecks and unit/component tests
npm run build       # development extension and webview bundles
npm run package     # production bundles
npm run build:e2e   # bundle the VS Code test entry point
npm run test:e2e    # build and run the review suite inside VS Code
```

To run one feature's tests, use `npm test -- test/unit/drafts`. Use
`npm run test:watch` while editing. Test configuration lives in `test/config/`;
the npm scripts select the correct suite and share the same repository root.

The VS Code suite normally downloads a test copy of the editor. For an offline
run, set `VSCODE_EXECUTABLE_PATH` to an existing VS Code executable. The suite
opens a temporary fixture workspace and uses isolated editor settings.

## Optional integration tests

`npm run eval` checks retrieval against Flask 3.1.3. By default, Flask lives at
`../flask`; set `FLASK_DIR` to another checkout, either an absolute path or a path
relative to this repository. The evaluation skips when Flask is absent.
Graphify is optional: set `GRAPHIFY_BIN` to its executable if it is not on PATH.
Generated graphs stay under `.cache/`.

`npm run test:live` needs the same Flask checkout, a running TrueForge server,
and configured model providers. Follow the README's `forge` and `setup` steps.
The Python environment must have Flask's test dependencies installed. Activate it
before testing, or set `PYTHON_BIN` to its Python executable.
These tests call real models and are separate from `npm run check`.

## Local files

Copy `.env.example` to `.env` for local keys. Keep credentials, generated bundles,
test editor downloads, previews, and caches out of Git; `.gitignore` covers
these paths. Only blank config examples belong in the repository.
