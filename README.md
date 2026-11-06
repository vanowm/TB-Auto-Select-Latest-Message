# Auto Select Latest Message

A Thunderbird add-on that selects and displays a message when Thunderbird starts or you open a folder.

Supports Thunderbird **128–161**.

Tested with Thunderbird **159.0**. The package is capped at `161.*` to match [ATN's registered application versions](https://addons.thunderbird.net/en-US/thunderbird/pages/appversions/); Daily 162 is currently excluded.

## Features

- Select the newest message, or the first unread message with the newest as a fallback.
- Remember your selection when returning to a folder, including unified folders.
- Optionally override remembered selections and focus the message list.
- Use cached unified-folder results while the full search continues.
- Respect manual selection and deselection, and cancel scans when you interact.
- Select available cached messages after cancelling a startup password prompt.

## Installation

1. Download an XPI from [GitHub Releases](https://github.com/vanowm/TB-Auto-Select-Latest-Message/releases), or build one locally.
2. Open **Add-ons and Themes** in Thunderbird.
3. Choose **Install Add-on From File** from the gear menu and select the XPI.

## Settings

Open **Thunderbird Settings → General**. The add-on's controls appear below the Start Page settings.

| Setting | Behavior |
| --- | --- |
| Automatically select | Choose default Thunderbird behavior, newest message, or first unread message. |
| Override remembered selection | Select according to the chosen mode instead of restoring a previous selection. |
| Focus the message list | Move keyboard focus to the message list after opening a folder. |

Changes in General settings save automatically. The add-on's Preferences page in Add-ons Manager uses the same settings; click **Save settings** there to save changes.

Folder-selection memory lasts for the current session. **Override remembered selection** bypasses it.

## Development

Install the locked dependencies, apply formatting, and build the add-on:

```sh
npm ci
npm run format
npm run format:check
npm run lint
npm run privacy:check
npm run build
```

The XPI is written to:

```text
dist/auto-select-latest-message-<version>.xpi
```

Formatting follows the project's `.eslintrc.js` and `.stylelintrc.js` configurations.
`npm run lint` checks all ESLint and Stylelint rules, including code errors and warnings. The manifest uses a local schema for this add-on's Thunderbird fields, including experiment APIs.

Builds and release checks reject unreviewed files in `src/` and check publishable repository text for common credentials and personal home paths. Keep Thunderbird profiles, account databases, local credentials, and private keys outside the source tree. The release workflow uploads only the XPI and its checksum.

### Debugging in VS Code

1. Open [Auto Select Latest Message.code-workspace](<.vscode/Auto Select Latest Message.code-workspace>).
2. Select the **Latest** launch configuration.
3. Press **F5**.

The workspace launches Thunderbird with `src/` and a persistent development profile. Stopping debugging leaves Thunderbird running; F5 reconnects to it. Quit Thunderbird normally when finished.

### Optional local tests

When the local `tests/` directory is available:

```sh
npm test
npm run test:thunderbird
```

The Thunderbird smoke test uses an isolated profile under `dist/`. It checks selection behavior, unified folders, folder memory, settings persistence, and cleanup. Test profiles suppress onboarding and What's New pages.

To test another Thunderbird installation, pass its executable after `--`:

```sh
npm run test:thunderbird -- "C:/path/to/thunderbird.exe"
```

## Releases

Versions use **`YY.M.D.hmm`** in the **America/New_York** timezone.

For example, `26.11.6.1210` represents November 6, 2026 at 12:10 PM. Version components omit leading zeros.

To publish a new version:

1. Run `npm version <version> --no-git-tag-version` to update `package.json` and `package-lock.json`.
2. Set the same version in `src/manifest.json`.
3. Run `npm run format`, `npm run lint`, and `npm run release:check`. Release checks verify that ATN recognizes the declared minimum and maximum Thunderbird versions.
4. Commit with your configured GPG signing key and push to `master`.

The [Release workflow](.github/workflows/release.yml) checks formatting and release metadata, builds the XPI, and publishes a GitHub release with generated notes and a SHA-256 checksum. It can also run for a matching `v<version>` tag or be started manually on `master`.

Published releases are preserved. An interrupted draft release can be resumed by rerunning the workflow.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/` | Current add-on implementation. |
| `src_v3/` | Archived legacy implementation. |
| `scripts/` | Formatting and release validation tools. |
| `.github/workflows/` | GitHub release automation. |
| `dist/` | Generated packages and local test artifacts; ignored by Git. |
