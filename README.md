# Claude Reader Assistant for Zotero

A Zotero plugin that adds a chat panel to the left of the PDF reader. Ask questions about the open document and get answers from [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), using your own Claude Code login and default model.

- The document's text and metadata are sent as context with the first question.
- Follow-up questions continue the same conversation, so earlier questions, answers and the document stay in context.
- Answers stream in and render as GitHub-flavored Markdown (tables, lists, code blocks, links).
- Select text in the reader and choose **✦ Claude에게 묻기** ("Ask Claude") to quote it in your question.
- Right-click an answer to copy the selected text or the whole answer as Markdown.

> The UI text is currently in Korean. Claude replies in the language you write in.

## Requirements

| Requirement | Notes |
|---|---|
| Zotero 7.0 – 10.x | Tested on Zotero 10.0.5 (macOS) |
| Claude Code CLI | Installed and logged in (`claude` runs in a terminal) |
| macOS or Linux | Tested on macOS only. Windows is not supported yet |

The plugin looks for the CLI at `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`, then on `PATH`. Set `claudePath` (see [Settings](#settings)) if yours is elsewhere.

## Installation

1. Download `zotero-reader-assistant.xpi` from the [latest release](../../releases/latest).
2. In Zotero, open **Tools → Plugins**.
3. Click the gear icon, choose **Install Plugin From File…**, and select the `.xpi` file.

Zotero checks the release page for updates automatically.

## Usage

1. Open a PDF in Zotero. The assistant panel appears to the left of the reader.
2. Type a question and press **Enter** (**Shift+Enter** inserts a new line).
3. Press **중지** (Stop) to cancel an answer that is in progress.
4. Press **새 대화** (New chat) to clear the conversation and send the document again with the next question.

Use the **✦ Claude** button in the reader toolbar to show or hide the panel. Drag the panel's right edge to resize it.

The panel header shows the model that answered, as reported by Claude Code.

## How it works

For each question, the plugin runs the Claude Code CLI in print mode:

```sh
claude -p --output-format stream-json --verbose --include-partial-messages \
  --tools "" --strict-mcp-config --system-prompt "<reading assistant prompt>" \
  [--model <model>] [--resume <session-id>]
```

- **Context**: The first question includes the attachment text from Zotero's full-text index (`item.attachmentText`), up to `maxContextChars` characters, plus title, authors, year, publication and DOI.
- **Conversation**: Each reader tab keeps its own Claude Code session. Follow-up questions use `--resume`, so Claude Code reloads the whole conversation from its session history. Session IDs are kept in memory only, so restarting Zotero starts new conversations.
- **Account and model**: The CLI uses your Claude Code login. Without the `model` setting, it uses the default model from your Claude Code settings (`~/.claude/settings.json`). Usage counts against your Claude account.
- **No tools**: `--tools ""` and `--strict-mcp-config` disable all tools and MCP servers. Claude can only answer. It cannot read files or run commands.
- **Working directory**: The CLI runs in `<Zotero data directory>/claude-reader-assistant`. Session history is stored by Claude Code under `~/.claude/projects/`.

## Settings

Open **Zotero Settings → Advanced → Config Editor** and search for `extensions.claude-reader-assistant`.

| Preference | Default | Description |
|---|---|---|
| `claudePath` | `""` | Path to the `claude` executable. Empty means auto-detect. |
| `model` | `""` | Model passed with `--model` (for example `sonnet` or `opus`). Empty means the Claude Code default. |
| `maxContextChars` | `400000` | Maximum number of document characters sent as context. Longer text is truncated. |
| `panelWidth` | `380` | Panel width in pixels. Updated when you resize the panel. |

## Privacy and security

- The document text and your questions are sent to Anthropic through Claude Code. Check your organization's policy before using the plugin with confidential documents.
- The panel runs in Zotero's privileged window. Rendered answers are parsed in an inert document, and only an allowlist of tags and attributes is copied into the panel. Scripts, images, event handlers and non-web links are removed.
- Links in answers open in your default browser. Only `http`, `https` and `mailto` links are opened.

## Known limitations

- The panel appears only in reader tabs, not in readers opened in a separate window.
- Scanned PDFs without a text layer send metadata only. The panel shows a warning.
- When a reader tab is reloaded (for example, after Zotero unloads a background tab), the document text is sent again into the same conversation.
- Math (LaTeX) is shown as plain text.
- On macOS, double-clicking the title bar to zoom the window may return it to its previous size. The cause is under investigation. **Window → Zoom** works as expected.

## Development

Run Zotero with the plugin loaded straight from the source directory:

1. Quit Zotero.
2. In your Zotero profile directory, create `extensions/claude-reader-assistant@navercorp.com`. Its only content is the absolute path to this repository's `src` directory.
3. In the profile's `prefs.js`, delete the lines that contain `extensions.lastAppBuildId` and `extensions.lastAppVersion`.
4. Start Zotero and enable the plugin in **Tools → Plugins**.

Restart Zotero to load code changes. Start Zotero with `-ZoteroDebugText` to print debug output to the terminal.

### Project layout

```
src/
  manifest.json        Plugin manifest (__REPOSITORY__ is filled in at build time)
  bootstrap.js         Zotero plugin lifecycle hooks
  prefs.js             Default preferences
  content/assistant.js Panel UI, document context, Claude Code CLI bridge
  content/lib/         marked (Markdown parser)
build.sh               Builds the .xpi and updates.json into build/
```

### Build

```sh
REPOSITORY=owner/zotero-reader-assistant ./build.sh
```

`REPOSITORY` defaults to the `origin` git remote. `VERSION` defaults to the version in `src/manifest.json`.

### Release

Push a tag that starts with `v`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The [release workflow](.github/workflows/release.yml) builds the plugin and creates a GitHub release with the `.xpi` and `updates.json`. Installed copies find new versions through `updates.json` on the latest release.

## Third-party software

- [marked](https://github.com/markedjs/marked) v18.1.1, MIT License. See `src/content/lib/marked-LICENSE`.

## License

[MIT](LICENSE)
