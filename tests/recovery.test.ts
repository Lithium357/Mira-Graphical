// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session, type Recovery, type Clock } from '../packages/core/index.js';
import { RecoveryStore } from '../packages/core/recovery.js';
const fixture = readFileSync('fixtures/adder.v', 'utf8');
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'mira-recovery-')),
    directory = join(workspace, '.hdlgraph');
  mkdirSync(directory);
  const uri = pathToFileURL(join(workspace, 'adder.v')).href;
  const saved: Recovery = {
    at: new Date().toISOString(),
    uri,
    version: 7,
    text: '// unsaved 🧪\r\n' + fixture,
    previewText: '// preview\n' + fixture,
    graphEdits: [],
    reason: 'Pending construction',
  };
  return {
    workspace,
    directory,
    uri,
    saved,
    store: new RecoveryStore(directory, workspace),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}
test('crash checkpoints survive a new store and preserve the previous draft before a new session replaces it', () => {
  const s = setup();
  try {
    s.store.checkpoint(s.saved);
    const restarted = new RecoveryStore(s.directory, s.workspace);
    assert.deepEqual(restarted.read(restarted.list()[0].id), s.saved);
    restarted.checkpoint({ ...s.saved, text: fixture, previewText: undefined });
    const entries = restarted.list();
    assert.equal(entries.length, 2);
    assert.equal(
      restarted.read(entries.find((e) => !e.checkpoint)!.id).previewText,
      s.saved.previewText,
    );
    assert.equal(restarted.read(entries.find((e) => e.checkpoint)!.id).text, fixture);
    assert.equal(readdirSync(s.directory).filter((n) => n.endsWith('.tmp')).length, 0);
  } finally {
    s.cleanup();
  }
});
test('recovery validates paths, schemas, source scope and file bounds without executing saved actions', () => {
  const s = setup();
  try {
    for (const id of [
      '../connection.json',
      'connection.json',
      'recovery-x.json',
      'checkpoint-' + '.'.repeat(64) + '.json',
    ])
      assert.throws(() => s.store.read(id));
    assert.throws(
      () =>
        s.store.archive({
          ...s.saved,
          uri: pathToFileURL(join(s.workspace, '..', 'outside.v')).href,
        }),
      /outside/,
    );
    assert.throws(() => s.store.archive({ ...s.saved, text: 'x'.repeat(1_000_001) }), /data/);
    assert.throws(() => s.store.archive({ ...s.saved, version: -1 }), /data/);
    const id = s.store.archive({
      ...s.saved,
      graphActions: [{ kind: 'import', definitions: ['untrusted data'] }],
    });
    assert.equal(s.store.read(id).text, s.saved.text);
    writeFileSync(join(s.directory, id), '{bad JSON');
    assert.throws(() => s.store.read(id));
    assert(
      s.store.list().some((e) => e.id === id),
      'Corrupt snapshots remain visible for investigation',
    );
    writeFileSync(join(s.directory, id), Buffer.alloc(12 * 1024 * 1024 + 1));
    assert.throws(() => s.store.read(id), /size limit/);
  } finally {
    s.cleanup();
  }
});
test('recovery refuses file symlinks without changing their targets', (t) => {
  const s = setup();
  try {
    const target = join(s.workspace, 'target.json');
    writeFileSync(target, JSON.stringify(s.saved));
    const id = 'checkpoint-' + 'a'.repeat(64) + '.json';
    try {
      symlinkSync(target, join(s.directory, id));
    } catch (e) {
      if (['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) {
        t.skip('File symlink permission unavailable');
        return;
      }
      throw e;
    }
    assert.throws(() => s.store.read(id), /regular file/);
    assert(!s.store.list().some((e) => e.id === id));
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).text, s.saved.text);
  } finally {
    s.cleanup();
  }
});
test('semantic changes checkpoint immediately before debounce, layout movement does not rewrite the journal', () => {
  const s = setup();
  let fire = () => {},
    writes = 0;
  const clock: Clock = {
    now: () => 15000,
    set(fn) {
      fire = fn;
      return 1;
    },
    clear() {},
  };
  try {
    const session = new Session(
      s.uri,
      1,
      fixture,
      {
        publish() {},
        patch() {},
        recover(r) {
          s.store.archive(r);
        },
        persist() {},
        checkpoint(r) {
          writes++;
          s.store.checkpoint(r);
        },
      },
      clock,
    );
    assert.equal(writes, 1);
    fire();
    assert.equal(writes, 1);
    session.circuitAction({
      kind: 'create',
      component: 'operation',
      name: 'draft_sum',
      width: 8,
      operator: '+',
    });
    assert.equal(writes, 2);
    const id = s.store.list().find((e) => e.checkpoint)!.id;
    assert(s.store.read(id).previewText!.includes('assign draft_sum'));
    const node = session.state.previewGraph!.nodes[0];
    session.move(node.id, 400, 200);
    assert.equal(writes, 2);
    // Read without closing the original session: no graceful shutdown snapshot can help this assertion.
    assert(
      new RecoveryStore(s.directory, s.workspace)
        .read(id)
        .previewText!.includes('assign draft_sum'),
    );
    session.userText(2, 'unfinished source');
    assert.equal(s.store.read(id).text, 'unfinished source');
    assert.equal(s.store.read(id).previewText, undefined);
    assert(s.store.list().some((e) => !e.checkpoint));
    session.close();
  } finally {
    s.cleanup();
  }
});
test('failed checkpoint writes warn visibly and preserve an editable live session', () => {
  let fire = () => {},
    fail = true;
  const session = new Session(
    'file:///adder.v',
    1,
    fixture,
    {
      publish() {},
      patch() {},
      recover() {},
      persist() {},
      checkpoint() {
        if (fail) throw new Error('disk full');
      },
    },
    {
      now: () => 15000,
      set(fn) {
        fire = fn;
        return 1;
      },
      clear() {},
    },
  );
  assert.match(session.state.recoveryWarning!, /disk full/);
  fire();
  assert(session.state.canConstruct);
  session.circuitAction({ kind: 'create', component: 'wire', name: 'spare', width: 8 });
  assert(session.state.previewGraph!.nodes.some((n) => n.label === 'spare'));
  fail = false;
  session.circuitAction({ kind: 'create', component: 'wire', name: 'next_spare', width: 8 });
  assert.equal(session.state.recoveryWarning, undefined);
  session.close();
});

test('new-session checkpoints archive changed edit intentions even when source text is unchanged', () => {
  const s = setup();
  try {
    s.store.checkpoint({
      ...s.saved,
      previewText: undefined,
      graphEdits: [['node', { kind: 'operator', value: '*' }]],
    });
    const restarted = new RecoveryStore(s.directory, s.workspace);
    restarted.checkpoint({ ...s.saved, previewText: undefined });
    const archive = restarted.list().find((e) => !e.checkpoint)!;
    assert.equal(restarted.read(archive.id).graphEdits[0][1].value, '*');
  } finally {
    s.cleanup();
  }
});

test('recovery history lists the latest 100 files without deleting older snapshots', () => {
  const s = setup();
  try {
    let newest = '';
    for (let i = 0; i < 105; i++) {
      newest = s.store.archive(s.saved);
      utimesSync(join(s.directory, newest), i + 1, i + 1);
    }
    assert.equal(s.store.list().length, 100);
    assert.equal(s.store.list()[0].id, newest);
    assert.equal(readdirSync(s.directory).length, 105);
  } finally {
    s.cleanup();
  }
});

test('token edits rebased over newer source retain a safe recovery preview before synchronization', () => {
  const s = setup();
  let fire = () => {};
  try {
    const session = new Session(
      s.uri,
      1,
      fixture,
      {
        publish() {},
        patch() {},
        persist() {},
        recover(r) {
          s.store.archive(r);
        },
        checkpoint(r) {
          s.store.checkpoint(r);
        },
      },
      {
        now: () => 15000,
        set(fn) {
          fire = fn;
          return 1;
        },
        clear() {},
      },
    );
    fire();
    const op = session.state.graph!.nodes.find((n) => n.kind === 'op')!;
    session.userText(2, '// newer unsaved text\n' + fixture);
    session.graphEdit(op.id, '*');
    const saved = s.store.read(s.store.list().find((e) => e.checkpoint)!.id);
    assert(saved.previewText!.includes('a * b'));
    assert(saved.previewText!.startsWith('// newer unsaved text'));
    session.close();
  } finally {
    s.cleanup();
  }
});
