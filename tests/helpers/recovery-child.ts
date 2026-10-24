// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from '../../packages/core/index.js';
import { RecoveryStore } from '../../packages/core/recovery.js';
const workspace = process.argv[2];
const store = new RecoveryStore(join(workspace, '.hdlgraph'), workspace);
let fire = () => {};
const session = new Session(
  pathToFileURL(join(workspace, 'source.v')).href,
  3,
  '// unsaved buffer\n' + readFileSync(join(workspace, 'source.v'), 'utf8'),
  {
    publish() {},
    patch() {
      throw new Error('Must terminate before patching');
    },
    persist() {},
    checkpoint: (r) => store.checkpoint(r),
    recover: (r) => {
      store.archive(r);
    },
  },
  {
    now: () => 0,
    set(fn) {
      fire = fn;
      return 1;
    },
    clear() {},
  },
);
fire();
session.circuitAction({
  kind: 'create',
  component: 'operation',
  name: 'pending_sum',
  width: 8,
  operator: '+',
});
process.stdout.write('CHECKPOINT_READY\n');
// No close/disconnect/shutdown hook may supply the snapshot under test.
setInterval(() => {}, 1000);
