# Auto Select Latest Message

A Thunderbird add-on that selects and displays a message when Thunderbird starts or you open a folder.

Supports Thunderbird **128–161**.

The package is capped at `161.*`, a maximum accepted by [ATN's registered application versions](https://addons.thunderbird.net/en-US/thunderbird/pages/appversions/). Daily 162 is excluded by this compatibility cap.

`master` uses Thunderbird's public MailExtension APIs. The `Beta` branch preserves the experimental implementation, including its native Thunderbird integration.

## Features

- Select the newest message, or the first unread message with the newest as a fallback.
- Remember your selection when returning to a folder, including unified folders.
- Optionally override remembered selections when opening a folder.
- Respect manual selections and cancel pending work when the folder, selection, or settings change.
- Read the displayed message list, including unified folders, without experimental APIs.

## Installation

1. Download an XPI from [GitHub Releases](https://github.com/vanowm/TB-Auto-Select-Latest-Message/releases), or build one locally.
2. Open **Add-ons and Themes** in Thunderbird.
3. Choose **Install Add-on From File** from the gear menu and select the XPI.

## Settings

Open **Add-ons and Themes → Auto Select Latest Message → Preferences**.

| Setting | Behavior |
| --- | --- |
| Automatically select | Choose default Thunderbird behavior, newest message, or first unread message. |
| Override remembered selection | Select according to the chosen mode instead of restoring a previous selection. |

Click **Save settings** to apply changes. Existing settings saved in the add-on's storage are retained. Preferences from the legacy version's Thunderbird preference branch cannot be imported by the public APIs; check the Preferences page after upgrading from v3.

Folder-selection memory lasts for the current session. **Override remembered selection** bypasses it.

### Differences from Beta

Thunderbird's public APIs do not expose its General settings page or keyboard focus in the message list. Those integrations remain on `Beta`.

Selection uses the messages exposed by the displayed list. Expand collapsed threads to make all their messages available. In views that cannot use the newest-message shortcut, finding the newest message reads all result pages; large unified folders can take longer. The public APIs also do not provide the native loading, password-dialog, or input events used by Beta, so those cases use bounded retries and resume on tab or window activation.

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
`npm run lint` checks all ESLint and Stylelint rules, including code errors and warnings. The local manifest schema and package checks reject experimental APIs and privileged runtime code.

Builds and release checks reject unreviewed files in `src/` and check publishable repository text for common credentials and personal home paths. Keep Thunderbird profiles, account databases, local credentials, and private keys outside the source tree. The release workflow uploads only the XPI and its checksum.

### Debugging in VS Code

1. Open [Auto Select Latest Message.code-workspace](<.vscode/Auto Select Latest Message.code-workspace>).
2. Select the **Latest** launch configuration.
3. Press **F5**.

The workspace launches Thunderbird with `src/` and a persistent development profile. Stopping debugging leaves Thunderbird running; F5 reconnects to it. Quit Thunderbird normally when finished.

### Tests

```sh
npm test
```

The tests cover public-API selection, pagination, cancellation, folder memory, and release/privacy safeguards. They also run in the release workflow.

When the optional local Thunderbird smoke-test harness is available, close other Thunderbird debug instances and run:

```sh
npm run test:thunderbird
```

## Releases

Versions use **`YY.M.D.hmm`** in the **America/New_York** timezone.

For example, `26.11.6.1210` represents November 6, 2026 at 12:10 PM. Version components omit leading zeros.

To publish a new version:

1. Run `npm version <version> --no-git-tag-version` to update `package.json` and `package-lock.json`.
2. Set the same version in `src/manifest.json`.
3. Run `npm run format`, `npm run lint`, and `npm run release:check`. Release checks verify that ATN recognizes the declared minimum and maximum Thunderbird versions.
4. Commit with your configured GPG signing key and push to `master`.

The [Release workflow](.github/workflows/release.yml) checks formatting, tests, and release metadata, builds the XPI, and publishes a GitHub release with generated notes and a SHA-256 checksum. It can also run for a matching `v<version>` tag or be started manually on `master`.

Published releases are preserved. An interrupted draft release can be resumed by rerunning the workflow.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/` | Current add-on implementation. |
| `src_v3/` | Archived legacy implementation. |
| `scripts/` | Formatting and release validation tools. |
| `.github/workflows/` | GitHub release automation. |
| `dist/` | Generated packages and local test artifacts; ignored by Git. |
