// SPDX-License-Identifier: GPL-3.0-only
import type { Readable, Writable } from 'node:stream';
import { MAX_MESSAGE_BYTES } from '../protocol/index.js';
export type RpcMessage = {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};
/** LSP uses UTF-8 byte framing; source positions remain UTF-16. */
export class RpcStream {
  private bytes = Buffer.alloc(0);
  private length?: number;
  private failed = false;
  constructor(
    input: Readable,
    private output: Writable,
    receive: (message: RpcMessage) => void,
    fatal: (error: Error) => void,
  ) {
    input.on('data', (chunk: Buffer) => {
      if (this.failed) return;
      try {
        this.bytes = Buffer.concat([this.bytes, Buffer.from(chunk)]);
        while (true) {
          if (this.length === undefined) {
            const end = this.bytes.indexOf('\r\n\r\n');
            if (end < 0) {
              if (this.bytes.length > 8192) throw new Error('LSP header too large');
              return;
            }
            if (end > 8192) throw new Error('LSP header too large');
            const lengths = this.bytes
              .subarray(0, end)
              .toString('ascii')
              .split('\r\n')
              .filter((line) => /^content-length:/i.test(line));
            if (lengths.length !== 1 || !/^content-length:\s*[0-9]+\s*$/i.test(lengths[0]))
              throw new Error('Invalid LSP Content-Length');
            this.length = Number(lengths[0].split(':')[1]);
            if (
              !Number.isSafeInteger(this.length) ||
              this.length < 1 ||
              this.length > MAX_MESSAGE_BYTES
            )
              throw new Error('LSP message too large');
            this.bytes = this.bytes.subarray(end + 4);
          }
          if (this.bytes.length < this.length) return;
          const body = this.bytes.subarray(0, this.length);
          this.bytes = this.bytes.subarray(this.length);
          this.length = undefined;
          const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          if (
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message) ||
            message.jsonrpc !== '2.0'
          )
            throw new Error('Invalid JSON-RPC message');
          receive(message);
        }
      } catch (error) {
        this.failed = true;
        fatal(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  send(message: RpcMessage) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_MESSAGE_BYTES) throw new Error('Outgoing LSP message too large');
    this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
}

export type Position = { line: number; character: number };
export function offsetAt(text: string, position: Position): number {
  if (
    !position ||
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new Error('Invalid UTF-16 source position');
  let start = 0;
  for (let i = 0; i < position.line; i++) {
    const end = text.indexOf('\n', start);
    if (end < 0) throw new Error('Source line outside buffer');
    start = end + 1;
  }
  const newline = text.indexOf('\n', start);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text[end - 1] === '\r') end--;
  if (position.character > end - start) throw new Error('Source character outside line');
  const offset = start + position.character;
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[offset])
  )
    throw new Error('Position splits a surrogate pair');
  return offset;
}
export function positionAt(text: string, offset: number): Position {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
    throw new Error('Source offset outside buffer');
  const prefix = text.slice(0, offset),
    start = prefix.lastIndexOf('\n') + 1;
  return { line: prefix.split('\n').length - 1, character: offset - start };
}
