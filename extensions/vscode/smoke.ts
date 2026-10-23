// SPDX-License-Identifier: GPL-3.0-only
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function run() {
  const folder = vscode.workspace.workspaceFolders![0];
  const uri = vscode.Uri.joinPath(folder.uri, 'adder.v');
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const original = doc.getText();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), '// unsaved smoke checkpoint 🙂\n');
  const startOp = original.indexOf('+');
  edit.replace(uri, new vscode.Range(doc.positionAt(startOp), doc.positionAt(startOp + 1)), '-');
  await vscode.workspace.applyEdit(edit);
  assert(doc.isDirty);
  const unsaved = doc.getText();
  await vscode.commands.executeCommand('mira.open');
  const start = Date.now();
  while (Date.now() - start < 45_000 && !doc.getText().includes('a * b')) await sleep(100);
  assert.equal(
    doc.getText(),
    unsaved.replace('a - b', 'a * b'),
    'Graph patch must target the unsaved live buffer',
  );
  assert(doc.isDirty);
  const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  assert.equal(disk, original, 'Disk source must stay untouched');
  await vscode.commands.executeCommand('undo');
  assert.equal(doc.getText(), unsaved, 'Native undo restores the source operator');
  const afterUndo = Date.now();
  let reflected = false;
  while (Date.now() - afterUndo < 20_000) {
    const s = JSON.parse(
      Buffer.from(
        await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(folder.uri, '.hdlgraph', 'smoke-state.json'),
        ),
      ).toString(),
    );
    if (s.status === 'Synced' && s.version === doc.version && s.op === '-') {
      reflected = true;
      break;
    }
    await sleep(100);
  }
  assert(reflected, 'Undo must propagate back to the graph after inactivity');
  const comboURI = vscode.Uri.joinPath(folder.uri, 'combinational.v');
  const combo = await vscode.workspace.openTextDocument(comboURI);
  const comboOriginal = combo.getText();
  await vscode.window.showTextDocument(combo);
  await vscode.commands.executeCommand('mira.open');
  const comboStart = Date.now();
  while (Date.now() - comboStart < 40_000 && !combo.getText().includes("8'h2A")) await sleep(100);
  assert.equal(
    combo.getText(),
    comboOriginal
      .replace("8'h0F", "8'h2A")
      .replace('a[7:0]', 'a[3:0]')
      .replace('= select_a ?', '= select_b ?'),
  );
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(comboURI)).toString('utf8'),
    comboOriginal,
  );
  await vscode.commands.executeCommand('undo');
  assert.equal(
    combo.getText(),
    comboOriginal,
    'All three changes undo as one native workspace edit',
  );
  assert.equal(doc.getText(), unsaved, 'Editing the second module must not change the first');
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(folder.uri, '.hdlgraph', 'vscode-smoke-result.json'),
    Buffer.from(
      JSON.stringify(
        {
          passed: true,
          pass: process.env.MIRA_SMOKE_PASS,
          unsaved: true,
          undo: true,
          undoReflectedInGraph: true,
          diskUnchanged: true,
          multiDocument: true,
          literalSliceSelector: true,
          realDebounceMs: 15000,
        },
        null,
        2,
      ),
    ),
  );
  await vscode.commands.executeCommand('mira.connect');
}
