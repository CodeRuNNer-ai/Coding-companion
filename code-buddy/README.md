# Code Buddy

A VS Code companion that watches your editor, notices when you're stuck, and helps you with the **logic** instead of just handing over the answer.

## What it "sees"

Code Buddy reads your editor state, not your literal screen pixels:

- the active file (or a window around your cursor for big files)
- your cursor position and selected text
- errors and warnings from VS Code (diagnostics)
- your recent activity (idle time, write/delete churn)

This is only sent to the Anthropic API when you ask for help (or when auto-hint fires). Files matching `codeBuddy.ignoreGlobs` (`.env`, `*.pem`, ...) are never sent.

## How it detects "stuck"

- The same errors stay on screen while you keep editing
- You go idle with errors on screen
- You go idle on an unfinished line (TODO, trailing operator, empty line)
- You keep typing and deleting the same area

It then shows a message in the sidebar and a notification offering a hint (or generates one automatically if `codeBuddy.autoHint` is on).

## Help levels

Nudge -> Logic -> Pseudocode -> Solution. Start low and climb only if you need to.

## Run it

1. Open this folder in VS Code.
2. Press `F5` (Run Extension) to launch an Extension Development Host.
3. Click the robot icon in the activity bar, then the key icon (or run `Code Buddy: Set Anthropic API Key`).
4. Open a code file and start coding. Press `Ctrl+Alt+H` (`Cmd+Alt+H` on Mac) any time you're stuck.

To install permanently: `npm i -g @vscode/vsce && vsce package`, then install the `.vsix`.

## Settings

See `codeBuddy.*` in VS Code settings: model, stuckSeconds, persistentErrorSeconds, autoHint, maxContextLines, ignoreGlobs.

## Ideas for next steps

- Real screenshots (needs an OS-level capture helper) for debugging UI output or terminal text
- Read the integrated terminal output / test failures
- Streaming responses, and "apply this fix" code actions
