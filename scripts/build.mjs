// SPDX-License-Identifier: GPL-3.0-only
import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { copyFileSync, existsSync } from 'node:fs';
await bundle({entryPoints:['extensions/vscode/extension.ts'],outfile:'extensions/vscode/dist/extension.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],sourcemap:true});
await bundle({entryPoints:['extensions/vscode/smoke.ts'],outfile:'extensions/vscode/dist/smoke.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode']});
await bundle({entryPoints:['apps/graph/preload.ts'],outfile:'dist/apps/graph/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron']});
await vite({root:'apps/graph',base:'./',build:{outDir:'dist',emptyOutDir:true},logLevel:'warn'});
copyFileSync('LICENSE','extensions/vscode/LICENSE');
if(existsSync('docs/THIRD_PARTY_NOTICES.txt'))copyFileSync('docs/THIRD_PARTY_NOTICES.txt','extensions/vscode/THIRD_PARTY_NOTICES.txt');
