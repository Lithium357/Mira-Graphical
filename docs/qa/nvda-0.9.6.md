# Fresh-profile and NVDA review — 2026-10-25

An agent operated real Windows windows with portable NVDA 2026.2 active, using Mira 0.9.6 development sources at `b846dff` and the released 0.9.6 companion VSIX. VS Code was 1.143.1 (`e646868227c3e3a9e3f24277c8c7220be42c0be7`, x64). Mira, VS Code, extension installation and NVDA each used disposable profiles. Only copied public fixtures were shared; the owner's project was untouched.

NVDA's installer matched its publisher SHA-256 and had a valid NV Access signature. Speech synthesis was disabled; the observations below use NVDA's actual speech-output log, Windows accessibility trees and screenshots. They do not assess audible pronunciation, speech pacing or an experienced blind user's workflow. Raw logs stay local because they can include unrelated foreground-window titles.

## Observed results

| Journey                  | Evidence and result                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-run setup          | NVDA announced Mira, Setup help, the connection dialog, Close setup help, Waiting for VS Code and Choose project folder. Tab reached the folder control; Escape closed the dialog.                                                                                                                                                                                                                               |
| First share              | Installed the released VSIX into a fresh extension directory. In the real VS Code command palette, ran **RTL Graph: Open Current Module** on a copied `adder.v`. After the normal debounce Mira showed Synced, four nodes and three connections. NVDA announced Synced.                                                                                                                                          |
| Component selection      | Chose ADD through **View → Component navigator** using End/Enter, then Tab/Enter on Inspect component. NVDA read the component kind, eight-bit width, two incoming/one outgoing connections, Source signal and named wiring/operation controls.                                                                                                                                                                  |
| Combinational simulation | Set `a=2`, then Tab to `b=3`, Tab/Enter to sample. Graph output was `sum=0x05`. NVDA announced both labelled edits and the sample count.                                                                                                                                                                                                                                                                         |
| Sample-table navigation  | Used Tab/Enter to expand Sample values, Down to enter its table, then NVDA table navigation. NVDA read the caption, four rows/two columns, Signal, row `a`, Sample 0 and `0x02`. The accessibility tree exposed row `sum` with `0x05`. Speech navigation through every row was not completed.                                                                                                                    |
| Recovery                 | Keyboard-selected the adder checkpoint. Tab reached and read the complete recovered source, Compare in VS Code and Open recovered copy. Activating Open recovered copy produced a separate Untitled-1 editor containing the original source; the original adder tab remained open.                                                                                                                               |
| Clock/reset              | Shared the copied `clocked-hierarchy.sv` as `pipeline.sv` and used its `register_stage` definition. Sampling reset high cleared `q` to `0x00`. With reset low, enable high and `d=4`, Step clk produced `q=0x05`. NVDA announced labelled reset/enable/data edits, Step clk and the updated clocked sample count. These stimuli used indexed accessibility controls, rather than a fully keyboard-only sequence. |

Selected speech excerpts, restricted to synthetic QA content:

```text
Simulation input a, edit, 0
Simulation input b, edit, 0
1 sample · combinational
table, with 4 rows and 2 columns, caption, Sampled signal values
out of caption, row 1, column 1, Signal
row 2, a
Sample 0, column 2, 0x02
ADD: op, 8 bits. 2 incoming connections, 1 outgoing connections.
Compare in VS Code, button
Open recovered copy, button
Recovered copy requested in VS Code.
Step clk, button
2 samples · clocked
```

## Limits and follow-up

The earlier minimized-window automation obstacle was overcome by refreshing the target window and capturing its geometry before input. A native minimize/reopen regression independently confirmed Mira already restored correctly; no product restoration defect was established.

The Windows helper sometimes returned stale accessibility text immediately after an action. A screenshot confirmed the recovered copy before the text tree caught up. After NVDA table chords, its log also briefly recorded Ctrl/Alt on subsequent keys; sending the standalone modifier keys cleared this. These observations limit claims about a completely uninterrupted keyboard journey.

No graph edit was committed during this NVDA session: the attempted operation-replacement control was outside the visible inspector area. Wiring transactions, graph edits, native Undo, diagnostic locations and register construction retain separate automated coverage, but need their own speech-assisted acceptance. Diagnostics, every sample-table row, trace export, installation through speech, JAWS and a fully keyboard-only end-to-end session remain to be tried by an experienced screen-reader user. An unfamiliar person's onboarding trial also remains separate from this agent-assisted fresh-profile review.
