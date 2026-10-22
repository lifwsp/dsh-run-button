# dsh-run-button

<p align="center">
  <b>English</b> · <a href="README.ja.md">日本語</a> · <a href="README.zh.md">中文</a>
</p>

**A Run button for every shell code block in a DSH reply.** Press it and the command runs on your machine, in the session's workspace and sandbox. The output streams into a small dock in the bottom-right corner, and you can answer prompts like `yes/no` or a `sudo` password without leaving DSH.

<p align="center">
  <img src="assets/interactive.png" alt="A sudo password prompt answered from the Run dock" width="560">
</p>

> Verified on DSH `0.2.1-rc.1` (macOS): run and stop commands, answer `read -p` / `sudo` / `ssh` host-key prompts, Dock and Panel output.

## Install

**From the plugin market:** Settings → Plugin Market → search `dsh-run-button` → Install.

**From the `dsh` CLI:**

```bash
dsh plugin --profile web add dsh-run-button
# or pin to the latest release / the repository source
dsh plugin --profile web add "https://github.com/lifwsp/dsh-run-button/releases/latest/download/dsh-run-button.tgz"
dsh plugin --profile web add github:lifwsp/dsh-run-button
```

Remove it with `dsh plugin --profile web remove dsh-run-button`. Plain `npm install` does not mount the plugin in DSH.

## Using it

1. Ask the agent for a command, or write one in a `bash` / `powershell` code block.
2. Click **▶ Run** in the block's header. Click **▶ Run→AI** instead to have the agent read the result and reply when the command finishes.
3. The output appears in the bottom-right **dock**. Stop a live run, collapse its output, or close the card.
4. While a run waits for input, type in the field under its output and press **Enter**.
   - The field hides what you type when the prompt looks like a password (`Password:`, `パスワード:`, `passphrase`, …). **mask** toggles it by hand.
   - **^C** sends Ctrl-C to the program without stopping the run. **^D** sends end-of-input.
5. Click the **cwd** chip next to Run to choose another working directory for that block.

The strip above the message box shows live runs and the most recent finished one; older runs sit behind **+N** (with **Clear finished**). It fades while nothing is running. The icons on its right pick where output goes; hover them for their names.

| Mode | Output goes to | Needs |
| --- | --- | --- |
| **Dock** (default) | A floating card per run in the bottom-right corner | nothing |
| **Panel** | A tab per run in the right sidebar or the bottom workbench | [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) |
| **Off** | Nowhere; the Run button still shows the status | nothing |

## Supported code blocks

| Language tag | Button |
| --- | --- |
| `bash`, `sh`, `zsh`, `shell`, `shellscript` | `▶ Run` |
| `console` | `▶ console` |
| `powershell`, `pwsh`, `ps1` | `▶ PowerShell` |
| `cmd`, `bat`, `batch`, `dos` | `▶ cmd` |

Other languages (`js`, `python`, …) get no button.

## Safety

- A run can do no more than the agent in the same session: it uses the session's **sandbox policy** and **workspace**.
- The command runs exactly as written in the block. Nothing from the model is pasted into it.
- What you type is **never logged or saved** — not in the plugin log, the browser storage, or the Run→AI result. Password prompts turn the terminal echo off, so a password never shows up in the output.
- Runs are stopped when the plugin stops or updates, so nothing keeps running after a reload.

## Limitations

- **`sudo` and `ssh` prompts only work in a `danger-full-access` session.** In `read-only` and `workspace-write`, the macOS sandbox blocks the terminal they read from; the input row says so. Prompts that read normal input (`read -p`, installers) work in every mode.
- Answering prompts needs DSH 0.2 on macOS or Linux. Elsewhere the command still runs, but without an input field.
- Output is plain text: colors are removed, and full-screen programs (`vim`, `less`, `top`) do not work.
- Output is kept for 10 minutes after a run ends and survives a page reload, but not a DSH restart. Each stream is capped at 256 KB (1 MB for runs that accept input). Runs that accept input stop after 30 minutes.

## Development

How it works, tests, and host API notes: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

MIT — see [LICENSE](LICENSE). Originally created by [EdwardXiao-bit](https://github.com/EdwardXiao-bit/dsh-run-button); this fork adds DSH 0.2 support, Run→AI, Panel placement, and interactive input.
