// SPDX-License-Identifier: GPL-3.0-only
export const PROTOCOL_VERSION = 1;
export const DEBOUNCE_MS = 15_000;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const operators = ['+', '-', '*', '&', '|', '^'] as const;
export type Operator = typeof operators[number];
export type Edit = { start: number; end: number; text: string };
export type EditorMessage =
  | { type: 'hello'; protocolVersion: 1; token: string; editor: 'vscode'; workspace: string }
  | { type: 'document.open'; uri: string; version: number; text: string }
  | { type: 'document.change'; uri: string; version: number; text: string; origin: 'user' | 'sync'; originToken?: string }
  | { type: 'document.close'; uri: string }
  | { type: 'document.patchResult'; uri: string; patchId: string; ok: boolean; currentVersion: number; text: string; error?: string };
export type ServiceMessage =
  | { type: 'hello.ok'; protocolVersion: 1 }
  | { type: 'document.applyPatch'; uri: string; baseVersion: number; baseHash: string; patchId: string; edits: Edit[] }
  | { type: 'status'; uri: string; status: string; detail?: string }
  | { type: 'error'; error: string };
export interface EditorAdapter { send(message: ServiceMessage): void }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validateMessage(v: unknown): v is EditorMessage {
  if (!record(v) || typeof v.type !== 'string') return false;
  if (v.type === 'hello') return v.protocolVersion === 1 && v.editor === 'vscode' && typeof v.token === 'string' && v.token.length <= 256 && typeof v.workspace === 'string';
  if (typeof v.uri !== 'string' || v.uri.length > 8192) return false;
  if (v.type === 'document.close') return true;
  if (v.type === 'document.patchResult') return typeof v.patchId === 'string' && typeof v.ok === 'boolean' && Number.isSafeInteger(v.currentVersion) && typeof v.text === 'string';
  if (v.type === 'document.open' || v.type === 'document.change') return Number.isSafeInteger(v.version) && Number(v.version) > 0 && typeof v.text === 'string' && (v.type === 'document.open' || (['user', 'sync'].includes(String(v.origin)) && (v.originToken === undefined || typeof v.originToken === 'string')));
  return false;
}
