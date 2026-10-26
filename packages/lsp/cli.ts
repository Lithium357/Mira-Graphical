// SPDX-License-Identifier: GPL-3.0-only
import { LspCompanion } from './index.js';
import { RpcStream } from './rpc.js';
if (!process.argv.includes('--stdio')) {
  process.stderr.write('Mira editor companion: launch with --stdio from an LSP client.\n');
  process.exit(1);
}
const companion = new LspCompanion(
  (message) => rpc.send(message),
  (code) => process.exit(code),
);
const rpc = new RpcStream(
  process.stdin,
  process.stdout,
  (message) => {
    void companion.receive(message);
  },
  (error) => {
    process.stderr.write(String(error) + '\n');
    companion.close();
    process.exitCode = 1;
    process.stdin.destroy();
  },
);
process.stdin.on('end', () => companion.close());
process.on('SIGTERM', () => {
  companion.close();
  process.exit(0);
});
