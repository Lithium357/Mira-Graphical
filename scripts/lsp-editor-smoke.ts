// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SyncService } from '../packages/core/service.js';
const root = process.cwd(),
  output = resolve('test-results/lsp-editors');
mkdirSync(output, { recursive: true });
const disk = 'module editor_test(input [7:0] a,b,output [7:0] y);assign y=a+b;endmodule\n';
const selected = process.argv.find((a) => a.startsWith('--editor='))?.slice(9);
if (selected && !['neovim', 'vim'].includes(selected)) throw new Error('Unknown editor test');
for (const editor of selected ? [selected] : ['neovim', 'vim']) {
  const workspace = join(output, editor + ' project');
  mkdirSync(workspace, { recursive: true });
  const file = join(workspace, 'test.sv');
  // Fresh directory per run makes stale result/ack files impossible.
  const session = join(workspace, String(Date.now()));
  mkdirSync(session);
  const actualResult = join(session, 'editor-result.json'),
    actualAck = join(session, 'undo-seen'),
    editAck = join(session, 'edit-seen');
  writeFileSync(file, disk);
  const service = new SyncService(workspace);
  await service.ready();
  const uri = pathToFileURL(file).href;
  let sent = false,
    changed = false,
    undone = false;
  const unsubscribe = service.subscribe((states) => {
    const state = states.find((s) => s.uri === uri);
    if (state?.status !== 'Synced') return;
    const op = state.graph?.nodes.find((n) => n.kind === 'op');
    if (!sent && op) {
      sent = true;
      assert(!state.readOnly);
      service.graphEdit(uri, op.id, '*');
    } else if (op?.op === '*') {
      changed = true;
      writeFileSync(editAck, 'ok');
    } else if (changed && op?.op === '+') {
      undone = true;
      writeFileSync(actualAck, 'ok');
    }
  });
  const cmd = [process.execPath, resolve('dist/editors/mira-lsp.cjs'), '--stdio'];
  let executable: string, args: string[], script: string;
  if (editor === 'neovim') {
    script = join(session, 'smoke.lua');
    writeFileSync(
      script,
      `local ok,err=pcall(function()
vim.cmd('edit '..vim.fn.fnameescape(${JSON.stringify(file)}))
vim.api.nvim_buf_set_lines(0,0,0,false,{'// UNSAVED editor marker'})
vim.cmd('let &undolevels = &undolevels')
local caps=vim.lsp.protocol.make_client_capabilities()
caps.workspace.applyEdit=true
caps.workspace.workspaceEdit.documentChanges=true
local client=vim.lsp.start({name='mira',cmd=${JSON.stringify(cmd).replace(/^\[/, '{').replace(/\]$/, '}')},root_dir=${JSON.stringify(workspace)},capabilities=caps})
assert(client,'LSP client did not start')
assert(vim.wait(65000,function() return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n'):find('a*b',1,true)~=nil end,25),'Graph edit did not reach Neovim')
assert(vim.wait(5000,function() return vim.fn.filereadable(${JSON.stringify(editAck)})==1 end,25),'Graph edit was not acknowledged')
vim.cmd('undo')
local text=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')
assert(text:find('a+b',1,true) and text:find('UNSAVED editor marker',1,true),'Native Undo lost the original unsaved buffer')
assert(vim.wait(25000,function() return vim.fn.filereadable(${JSON.stringify(actualAck)})==1 end,25),'Undo was not reflected in Mira')
vim.fn.writefile({vim.fn.json_encode({passed=true,editor='neovim',unsaved=true,nativeUndo=true,undoReflected=true})},${JSON.stringify(actualResult)})
vim.lsp.stop_client(client)
end)
if not ok then vim.fn.writefile({tostring(err)},${JSON.stringify(join(session, 'failure.txt'))});vim.cmd('cquit 1') end
vim.cmd('qa!')
`,
    );
    executable = process.env.MIRA_NVIM_EXE ?? 'nvim';
    args = ['--headless', '-u', 'NONE', '-n', '-c', 'luafile ' + script];
  } else {
    const plugin = resolve('build/editors/mira.vim');
    assert(existsSync(plugin));
    const quote = (s: string) => "'" + s.replaceAll('\\', '/').replaceAll("'", "''") + "'";
    script = join(session, 'smoke.vim');
    writeFileSync(
      script,
      `set nocompatible
set encoding=utf-8
set noswapfile
execute 'source ' . fnameescape(${quote(plugin)})
let g:mira_lsp_command=${JSON.stringify(cmd)}
execute 'edit ' . fnameescape(${quote(file)})
call append(0,'// UNSAVED editor marker')
let &undolevels = &undolevels
setfiletype systemverilog
execute 'MiraConnect ' . ${quote(workspace)}
function! WaitFor(expression,seconds) abort
 let deadline=reltimefloat(reltime())+a:seconds
 while !eval(a:expression)
  if reltimefloat(reltime())>deadline | throw 'Timed out: '.a:expression | endif
  doautocmd <nomodeline> TextChanged
  sleep 25m
 endwhile
endfunction
try
 call WaitFor("stridx(join(getline(1,'$'), '\\n'), 'a*b')>=0",65)
 call WaitFor(${quote('filereadable(' + quote(editAck) + ')')},5)
 undo
 if join(getline(1,'$'),'\\n') !~# 'a+b' || getline(1) !~# 'UNSAVED editor marker' | throw 'Native Undo lost the unsaved buffer' | endif
 call WaitFor(${quote('filereadable(' + quote(actualAck) + ')')},25)
 call writefile([json_encode({'passed':v:true,'editor':'vim','unsaved':v:true,'nativeUndo':v:true,'undoReflected':v:true})],${quote(actualResult)})
catch
 call writefile([v:exception,v:throwpoint],${quote(join(session, 'failure.txt'))})
 cquit 1
endtry
qa!
`,
    );
    executable = process.env.MIRA_VIM_EXE ?? 'vim';
    args = ['-Nu', 'NONE', '-n', '-es', '-S', script];
  }
  try {
    await new Promise<void>((ok, fail) => {
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let log = '';
      child.stdout.on('data', (b) => {
        log += b.toString();
      });
      child.stderr.on('data', (b) => {
        log += b.toString();
      });
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`${editor} exceeded 100 seconds`));
      }, 100000);
      child.on('error', (error) => {
        clearTimeout(timer);
        fail(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        writeFileSync(join(session, 'process.log'), log);
        code === 0 ? ok() : fail(new Error(`${editor} exited ${code}: ${log}`));
      });
    });
    const report = JSON.parse(readFileSync(actualResult, 'utf8'));
    assert(report.passed && sent && changed && undone);
    assert.equal(readFileSync(file, 'utf8'), disk);
    writeFileSync(
      join(output, editor + '.json'),
      JSON.stringify({ ...report, diskUnchanged: true }, null, 2),
    );
    console.log(`${editor}: unsaved buffer, native graph edit and Undo passed`);
  } finally {
    unsubscribe();
    await service.close();
  }
}
