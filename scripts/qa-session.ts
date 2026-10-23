// SPDX-License-Identifier: GPL-3.0-only
// Native-input QA host: only disposable fixtures are shared. Close the graph twice to finish.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
const root = process.cwd(),
  workspace = join(root, 'test-results', 'native-qa-' + Date.now());
mkdirSync(workspace, { recursive: true });
const original = readFileSync('fixtures/adder.v', 'utf8');
const texts = [original, original.replaceAll('adder', 'second').replaceAll('sum', 'result')];
const uris = ['adder.v', 'second.v'].map((f) => pathToFileURL(join(workspace, f)).href);
texts.forEach((t, i) => writeFileSync(join(workspace, i ? 'second.v' : 'adder.v'), t));
const versions = [1, 1];
let patches = 0;
let firstLayout: Record<string, unknown> | undefined;
const runs: unknown[] = [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (let run = 0; run < 2; run++) {
  const child = spawn(
    createRequire(import.meta.url)('electron'),
    ['.', `--workspace=${workspace}`],
    { cwd: root, env, stdio: 'inherit', windowsHide: true },
  );
  const descriptor = join(workspace, '.hdlgraph', 'connection.json');
  while (!existsSync(descriptor)) await new Promise((r) => setTimeout(r, 100));
  const config = JSON.parse(readFileSync(descriptor, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
  ws.on('message', (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === 'hello.ok')
      uris.forEach((uri, i) =>
        ws.send(
          JSON.stringify({ type: 'document.open', uri, version: versions[i], text: texts[i] }),
        ),
      );
    if (m.type === 'document.applyPatch') {
      const i = uris.indexOf(m.uri);
      for (const e of m.edits)
        texts[i] = texts[i].slice(0, e.start) + e.text + texts[i].slice(e.end);
      versions[i]++;
      patches++;
      ws.send(
        JSON.stringify({
          type: 'document.patchResult',
          uri: m.uri,
          patchId: m.patchId,
          ok: true,
          currentVersion: versions[i],
          text: texts[i],
        }),
      );
    }
    if (m.type === 'status')
      writeFileSync(join(workspace, 'status.json'), JSON.stringify({ run, ...m }));
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', ...config, editor: 'vscode' }));
  console.log(`QA RUN ${run + 1}: ${workspace}`);
  await new Promise((r) => child.once('exit', r));
  ws.close();
  const layouts = Object.fromEntries(
    readdirSync(join(workspace, '.hdlgraph'))
      .filter((f) => f.startsWith('layout-'))
      .map((f) => [f, JSON.parse(readFileSync(join(workspace, '.hdlgraph', f), 'utf8'))]),
  );
  if (run === 0) firstLayout = layouts;
  runs.push({
    run,
    layouts,
    patches,
    window: JSON.parse(readFileSync(join(workspace, '.hdlgraph', 'window.json'), 'utf8')),
  });
  if (run === 1)
    writeFileSync(
      join(root, 'test-results', 'native-qa.json'),
      JSON.stringify({ workspace, runs, texts, firstLayout }, null, 2),
    );
}
console.log(`Native QA complete: ${patches} semantic patches. ${workspace}`);
