// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import type { RecoveryEntry, RecoverySnapshot } from '../../packages/core/recovery.js';

export function RecoveryPanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<RecoveryEntry[]>([]),
    [id, setId] = useState('');
  const [saved, setSaved] = useState<RecoverySnapshot>(),
    [preview, setPreview] = useState(true);
  const [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const selection = useRef(0);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const refresh = async () => {
    try {
      setEntries(await window.mira.command({ type: 'recoveryList' }));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    dialog.current!.showModal();
    void refresh();
  }, []);
  const select = async (value: string) => {
    const request = ++selection.current;
    setId(value);
    setSaved(undefined);
    setStatus('');
    setError('');
    try {
      const result = await window.mira.command({ type: 'recoveryRead', id: value });
      if (request === selection.current) {
        setSaved(result);
        setPreview(result.previewText !== undefined);
      }
    } catch (e) {
      if (request === selection.current) setError(String(e));
    }
  };
  const act = async (compare: boolean) => {
    try {
      await window.mira.command({
        type: 'recoveryOpen',
        id,
        preview: preview && saved?.previewText !== undefined,
        compare,
        expectedHash: saved?.snapshotHash,
      });
      setError('');
      setStatus(
        compare ? 'Comparison requested in VS Code.' : 'Recovered copy requested in VS Code.',
      );
    } catch (e) {
      setError(String(e));
    }
  };
  const text = saved ? (preview ? (saved.previewText ?? saved.text) : saved.text) : '';
  return (
    <dialog
      ref={dialog}
      className="recovery-dialog"
      aria-labelledby="recovery-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="recovery-heading">
        <h2 id="recovery-title">Recovery</h2>
        <button onClick={close} aria-label="Close recovery">
          ×
        </button>
      </div>
      <p>
        Review saved source buffers and graph drafts. Recovered copies open separately in VS Code;
        your current buffer stays intact.
      </p>
      <div className="recovery-content">
        <section className="recovery-list" aria-label="Saved snapshots">
          <button onClick={() => void refresh()}>Refresh snapshots</button>
          {!entries.length && (
            <p>No recovery snapshots yet. Live buffers are checkpointed automatically.</p>
          )}
          {entries.map((entry) => (
            <button
              key={entry.id}
              aria-pressed={entry.id === id}
              onClick={() => void select(entry.id)}
            >
              <strong>
                {entry.uri
                  ? decodeURIComponent(entry.uri.split('/').pop()!)
                  : entry.checkpoint
                    ? 'Latest checkpoint'
                    : 'Saved recovery'}
              </strong>
              <small>
                {entry.checkpoint ? 'Latest checkpoint' : (entry.reason ?? 'Saved recovery')}
              </small>
              <span>{new Date(entry.at).toLocaleString()}</span>
              <small>{Math.ceil(entry.bytes / 1024)} KB</small>
            </button>
          ))}
        </section>
        <section className="recovery-preview" aria-label="Recovery preview">
          {saved ? (
            <>
              <h3>{decodeURIComponent(saved.uri.split('/').pop() ?? saved.uri)}</h3>
              <p className="recovery-reason">
                {saved.reason} · source version {saved.version}
              </p>
              <p className="recovery-path">{saved.uri}</p>
              {saved.previewText === undefined && saved.graphEdits.length > 0 && (
                <p>
                  This snapshot includes saved edit intentions that could not be rendered safely as
                  source. The source buffer is available below.
                </p>
              )}
              {saved.previewText !== undefined && (
                <label>
                  <input
                    type="checkbox"
                    checked={preview}
                    onChange={(e) => setPreview(e.target.checked)}
                  />{' '}
                  Include pending graph changes
                </label>
              )}
              <pre tabIndex={0} aria-label="Recovered source">
                {text.slice(0, 100_000)}
              </pre>
              {text.length > 100_000 && (
                <p>
                  Preview shows the first 100,000 characters. Open or copy the complete snapshot
                  below.
                </p>
              )}
              <div className="recovery-actions">
                <button onClick={() => void act(true)}>Compare in VS Code</button>
                <button onClick={() => void act(false)}>Open recovered copy</button>
                <button
                  onClick={() => {
                    void window.mira
                      .command({ type: 'copyText', text })
                      .then(() => {
                        setStatus('Recovery text copied.');
                        setError('');
                      })
                      .catch((e) => setError(String(e)));
                  }}
                >
                  Copy text
                </button>
              </div>
            </>
          ) : (
            <p>
              Choose a snapshot to inspect its source and pending changes. Up to 100 recent
              snapshots are listed. Existing files are never automatically deleted.
            </p>
          )}
        </section>
      </div>
      {error && <p role="alert">{error}</p>}
      <p role="status">{status}</p>
    </dialog>
  );
}
