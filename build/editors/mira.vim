" SPDX-License-Identifier: GPL-3.0-only
" Minimal Vim 8+ LSP client for Mira, with strict live-buffer edit guards.
if exists('g:loaded_mira_companion') | finish | endif
let g:loaded_mira_companion = 1
let s:job = v:null
let s:ready = 0
let s:rx = ''
let s:documents = {}
let s:version = 0
let s:applying = 0

function! s:Send(message) abort
  let body = json_encode(a:message)
  call ch_sendraw(job_getchannel(s:job), 'Content-Length: '.strlen(body)."\r\n\r\n".body)
endfunction
function! s:Uri(path) abort
  let path = substitute(fnamemodify(a:path, ':p'), '\\', '/', 'g')
  let encoded = ''
  for i in range(0, strlen(path)-1)
    let byte = strpart(path, i, 1)
    let encoded .= byte =~# '[A-Za-z0-9/_:~.-]' ? byte : printf('%%%02X', char2nr(byte))
  endfor
  return (path =~# '^/' ? 'file://' : 'file:///').encoded
endfunction
function! s:Text(buf) abort
  let newline = getbufvar(a:buf, '&fileformat') ==# 'dos' ? "\r\n" : "\n"
  return join(getbufline(a:buf, 1, '$'), newline).(getbufvar(a:buf, '&endofline') ? newline : '')
endfunction
function! s:Snapshot() abort
  if !s:ready || s:applying || &buftype !=# '' || expand('%:e') !~? '^\(v\|sv\|vhd\|vhdl\)$' | return | endif
  let uri = s:Uri(expand('%:p'))
  let text = s:Text(bufnr('%'))
  if strlen(text) > 1000000 | echoerr 'Mira: HDL buffer exceeds 1 MB' | return | endif
  if has_key(s:documents, uri) && s:documents[uri].text ==# text
    let s:documents[uri].tick = b:changedtick
    return
  endif
  let s:version += 1
  let opened = has_key(s:documents, uri)
  let s:documents[uri] = {'buf':bufnr('%'), 'version':s:version, 'tick':b:changedtick, 'text':text}
  if opened
    call s:Send({'jsonrpc':'2.0','method':'textDocument/didChange','params':{'textDocument':{'uri':uri,'version':s:version},'contentChanges':[{'text':text}]}})
  else
    call s:Send({'jsonrpc':'2.0','method':'textDocument/didOpen','params':{'textDocument':{'uri':uri,'version':s:version,'languageId':'verilog','text':text}}})
  endif
endfunction
function! s:Offset(text, position) abort
  let lines = split(a:text, "\n", 1)
  if a:position.line < 0 || a:position.line >= len(lines) || a:position.character < 0 | throw 'Invalid source position' | endif
  let line = substitute(lines[a:position.line], "\r$", '', '')
  let units = 0
  let chars = 0
  while units < a:position.character
    let codepoint = strgetchar(line, chars)
    if codepoint < 0 | throw 'Source character outside line' | endif
    let units += codepoint > 65535 ? 2 : 1
    let chars += 1
  endwhile
  if units != a:position.character | throw 'Position splits a surrogate pair' | endif
  let offset = byteidxcomp(line, chars)
  if offset < 0 | throw 'Invalid source character' | endif
  if a:position.line > 0
    for previous in lines[:a:position.line-1] | let offset += strlen(previous)+1 | endfor
  endif
  return offset
endfunction
function! s:Apply(request) abort
  let previous = bufnr('%')
  let view = winsaveview()
  let applied = v:false
  let reason = ''
  try
    let changes = a:request.params.edit.documentChanges
    if len(changes) != 1 | throw 'Expected one versioned buffer edit' | endif
    let change = changes[0]
    if !has_key(s:documents, change.textDocument.uri) | throw 'Buffer is not shared' | endif
    let doc = s:documents[change.textDocument.uri]
    if !bufloaded(doc.buf) || getbufvar(doc.buf,'&readonly') || !getbufvar(doc.buf,'&modifiable') || doc.version != change.textDocument.version || getbufvar(doc.buf,'changedtick') != doc.tick || s:Text(doc.buf) !=# doc.text
      throw 'Live buffer changed; refusing stale graph edit'
    endif
    if empty(change.edits) || len(change.edits) > 256 | throw 'Invalid edit count' | endif
    let edits = []
    for edit in change.edits
      call add(edits, {'start':s:Offset(doc.text,edit.range.start),'end':s:Offset(doc.text,edit.range.end),'text':edit.newText})
    endfor
    call sort(edits, {a,b -> b.start-a.start})
    let text = doc.text
    let bound = strlen(text)
    for edit in edits
      if edit.start < 0 || edit.end < edit.start || edit.end > bound | throw 'Invalid or overlapping edit span' | endif
      let text = strpart(text,0,edit.start).edit.text.strpart(text,edit.end)
      let bound = edit.start
    endfor
    if strlen(text) > 1000000 | throw 'Updated buffer exceeds size limit' | endif
    if (text =~# "\n$") != getbufvar(doc.buf,'&endofline') | throw 'Edit would change the EOF newline option; adjust it in Vim first' | endif
    let s:applying = 1
    execute 'noautocmd keepalt keepjumps hide buffer '.doc.buf
    " Close the preceding user edit without discarding its Undo history.
    let &l:undolevels = &l:undolevels
    let lines = split(text,"\n",1)
    let final_newline = text =~# "\n$"
    if final_newline | call remove(lines,-1) | endif
    if empty(lines) | let lines=[''] | endif
    if &fileformat ==# 'dos' | call map(lines, {_,line -> substitute(line,"\r$",'','')}) | endif
    call setline(1,lines)
    if line('$') > len(lines)
      undojoin
      execute (len(lines)+1).',$delete _'
    endif
    let &l:endofline = final_newline
    let applied = s:Text(doc.buf) ==# text ? v:true : v:false
    let s:applying = 0
    call s:Snapshot()
  catch
    let reason = v:exception
  finally
    let s:applying = 0
    if bufloaded(previous) | execute 'noautocmd keepalt keepjumps hide buffer '.previous | call winrestview(view) | endif
  endtry
  call s:Send({'jsonrpc':'2.0','id':a:request.id,'result':{'applied':applied,'failureReason':reason}})
endfunction
function! s:Handle(message) abort
  if has_key(a:message,'error') | echom 'Mira: '.a:message.error.message | return | endif
  if get(a:message,'id',0) == 1 && has_key(a:message,'result')
    let s:ready = 1
    call s:Send({'jsonrpc':'2.0','method':'initialized','params':{}})
    call s:Snapshot()
  elseif get(a:message,'method','') ==# 'workspace/applyEdit'
    call s:Apply(a:message)
  elseif get(a:message,'method','') ==# 'window/logMessage'
    echom 'Mira: '.strpart(a:message.params.message,0,1000)
  endif
endfunction
function! s:Read(channel, data) abort
  let s:rx .= a:data
  try
    while 1
      let header = stridx(s:rx,"\r\n\r\n")
      if header < 0
        if strlen(s:rx) > 8192 | throw 'Oversized LSP header' | endif
        return
      endif
      let length = str2nr(matchstr(strpart(s:rx,0,header),'\cContent-Length:\s*\zs\d\+'))
      if length < 1 || length > 2097152 | throw 'Invalid LSP message length' | endif
      if strlen(s:rx) < header+4+length | return | endif
      let message = json_decode(strpart(s:rx,header+4,length))
      let s:rx = strpart(s:rx,header+4+length)
      call s:Handle(message)
    endwhile
  catch
    echom 'Mira: '.v:exception
    call s:Disconnect()
  endtry
endfunction
function! s:Disconnect() abort
  if type(s:job) == v:t_job && job_status(s:job) ==# 'run' | call job_stop(s:job) | endif
  let s:ready = 0
  let s:documents = {}
  let s:rx = ''
endfunction
function! s:Connect(workspace) abort
  if !has('job') || !has('channel') || &encoding !=# 'utf-8' | echoerr 'Mira needs Vim 8+ with jobs, channels and UTF-8' | return | endif
  if !exists('g:mira_lsp_command') || type(g:mira_lsp_command) != v:t_list | echoerr 'Set g:mira_lsp_command; see the bundled editor setup guide' | return | endif
  call s:Disconnect()
  let s:version = 0
  let s:job = job_start(g:mira_lsp_command, {'out_mode':'raw','out_cb':function('s:Read'),'err_mode':'nl','err_cb':{channel,line -> execute('echom '.string('Mira: '.line))}})
  if job_status(s:job) !=# 'run' | echoerr 'Mira companion could not start' | return | endif
  call s:Send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'rootUri':s:Uri(empty(a:workspace)?getcwd():a:workspace),'clientInfo':{'name':'Mira Vim companion'},'capabilities':{'workspace':{'applyEdit':v:true,'workspaceEdit':{'documentChanges':v:true}}}}})
endfunction
function! s:Close(buf) abort
  for [uri,doc] in items(copy(s:documents))
    if doc.buf == a:buf
      if s:ready | call s:Send({'jsonrpc':'2.0','method':'textDocument/didClose','params':{'textDocument':{'uri':uri}}}) | endif
      call remove(s:documents,uri)
    endif
  endfor
endfunction
command! -nargs=? -complete=dir MiraConnect call s:Connect(<q-args>)
command! MiraDisconnect call s:Disconnect()
command! MiraShare call s:Snapshot()
augroup mira_companion
  autocmd!
  autocmd TextChanged,TextChangedI,InsertLeave,BufEnter,BufWritePost * call s:Snapshot()
  autocmd BufUnload * call s:Close(str2nr(expand('<abuf>')))
  autocmd VimLeavePre * call s:Disconnect()
augroup END
