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
  while (Date.now() - comboStart < 40_000 && !combo.getText().includes('assign product = a * b;'))
    await sleep(100);
  assert.equal(
    combo.getText(),
    comboOriginal
      .replace("8'h0F", "8'h2A")
      .replace('a[7:0]', 'a[3:0]')
      .replace('= select_a ?', '= select_b ?')
      .replace('endmodule', '    wire [7:0] product;\n    assign product = a * b;\nendmodule'),
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
  const hierarchyURI = vscode.Uri.joinPath(folder.uri, 'hierarchy.v');
  const hierarchy = await vscode.workspace.openTextDocument(hierarchyURI),
    hierarchyOriginal = hierarchy.getText();
  await vscode.window.showTextDocument(hierarchy);
  await vscode.commands.executeCommand('mira.open');
  const hierarchyStart = Date.now();
  while (
    Date.now() - hierarchyStart < 40000 &&
    !hierarchy.getText().includes('assign result_copy1 = a * b;')
  )
    await sleep(100);
  const changed = hierarchyOriginal.replace('a + b', 'a * b'),
    last = changed.lastIndexOf('endmodule');
  assert.equal(
    hierarchy.getText(),
    changed.slice(0, last) +
      '    wire [15:0] pair;\n    assign pair = {a, b};\n    wire [7:0] result_copy1;\n    assign result_copy1 = a * b;\n' +
      changed.slice(last),
    'Scoped hierarchy, bus and duplicate changes must remain exact',
  );
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(hierarchyURI)).toString('utf8'),
    hierarchyOriginal,
  );
  await vscode.commands.executeCommand('undo');
  assert.equal(
    hierarchy.getText(),
    hierarchyOriginal,
    'A native Undo restores the complete child-module construction batch',
  );
  assert.equal(combo.getText(), comboOriginal);
  assert.equal(doc.getText(), unsaved);
  for (const ext of ['sv', 'vhd', 'vhdl']) {
    const nativeUri = vscode.Uri.joinPath(folder.uri, `hierarchy.${ext}`);
    const native = await vscode.workspace.openTextDocument(nativeUri);
    const diskSource = native.getText();
    await vscode.window.showTextDocument(native);
    const prefix = `${ext === 'sv' ? '//' : '--'} unsaved native HDL checkpoint 🧪\n`;
    const prefixEdit = new vscode.WorkspaceEdit();
    prefixEdit.insert(nativeUri, new vscode.Position(0, 0), prefix);
    await vscode.workspace.applyEdit(prefixEdit);
    const liveSource = native.getText();
    await vscode.commands.executeCommand('mira.open');
    const nativeStart = Date.now();
    while (Date.now() - nativeStart < 45000 && !native.getText().includes('a - b'))
      await sleep(100);
    assert(native.getText().startsWith(prefix.trimEnd()), `${ext} preserves the unsaved comment`);
    assert(native.getText().includes('a - b'), `${ext} native operator patch`);
    assert(
      native.getText().includes(ext === 'sv' ? 'assign pair = {a, b};' : 'pair <= a & b;'),
      `${ext} native construction`,
    );
    assert.equal(
      Buffer.from(await vscode.workspace.fs.readFile(nativeUri)).toString('utf8'),
      diskSource,
    );
    await vscode.commands.executeCommand('undo');
    assert.equal(native.getText(), liveSource, `${ext} entire batch uses one native undo`);
  }
  const recoveryUri = vscode.Uri.joinPath(folder.uri, 'hierarchy.vhdl');
  const recoveryCurrent = await vscode.workspace.openTextDocument(recoveryUri);
  const recoveryOriginal = recoveryCurrent.getText();
  const recoveryDisk = Buffer.from(await vscode.workspace.fs.readFile(recoveryUri)).toString(
    'utf8',
  );
  const recovered = '-- recovery copy smoke\n' + recoveryOriginal;
  const preview = '-- recovery preview smoke\n' + recoveryOriginal;
  const requestUri = vscode.Uri.joinPath(
    folder.uri,
    '.hdlgraph',
    `recovery-request-${process.env.MIRA_SMOKE_PASS}.json`,
  );
  await vscode.workspace.fs.writeFile(
    requestUri,
    Buffer.from(
      JSON.stringify({ phase: 'copy', uri: recoveryUri.toString(), text: recovered, preview }),
    ),
  );
  const copyStart = Date.now();
  while (
    Date.now() - copyStart < 15000 &&
    !vscode.window.activeTextEditor?.document.getText().startsWith('-- recovery copy smoke')
  )
    await sleep(50);
  const copy = vscode.window.activeTextEditor!.document;
  assert(copy.isUntitled, 'Recovered source must open as a separate untitled copy');
  assert.equal(copy.getText().replaceAll('\r\n', '\n'), recovered.replaceAll('\r\n', '\n'));
  assert.equal(copy.languageId, 'vhdl');
  await vscode.workspace.fs.writeFile(
    requestUri,
    Buffer.from(
      JSON.stringify({ phase: 'compare', uri: recoveryUri.toString(), text: recovered, preview }),
    ),
  );
  const diffStart = Date.now();
  const recoveryDiff = () =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.modified.toString() === recoveryUri.toString() &&
          tab.input.original.scheme === 'untitled',
      );
  while (Date.now() - diffStart < 15000 && !recoveryDiff()) await sleep(50);
  assert(recoveryDiff(), 'Recovery preview must open in the native diff editor');
  assert(
    vscode.workspace.textDocuments.some(
      (d) => d.isUntitled && d.getText().startsWith('-- recovery preview smoke'),
    ),
  );
  assert.equal(
    recoveryCurrent.getText(),
    recoveryOriginal,
    'Recovery review must not overwrite unsaved current work',
  );
  assert.equal(
    Buffer.from(await vscode.workspace.fs.readFile(recoveryUri)).toString('utf8'),
    recoveryDisk,
  );
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
          constructionWiring: true,
          hierarchyBusesDuplicate: true,
          nativeLanguages: ['systemverilog', 'vhd', 'vhdl'],
          recoveryReviewCopy: true,
          realDebounceMs: 15000,
        },
        null,
        2,
      ),
    ),
  );
  await vscode.commands.executeCommand('mira.connect');
}
