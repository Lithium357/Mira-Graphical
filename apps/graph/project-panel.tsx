// SPDX-License-Identifier: GPL-3.0-only
import React, { useState, useRef, useEffect } from 'react';
import type { State } from '../../packages/core/index.js';
const displayUri = (uri: string) => {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
};
export function ProjectPanel({
  state,
  shared,
  onClose,
  onError,
}: {
  state: State;
  shared: State[];
  onClose: () => void;
  onError: (s: string) => void;
}) {
  const [uris, setUris] = useState(state.projectSources ?? []),
    [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const candidates = [...new Set([...shared.map((s) => s.uri), ...uris])].filter(
    (uri) => uri !== state.uri,
  );
  return (
    <section
      className="workspace-overlay"
      aria-label="Project sources"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="simulation-heading">
        <h2 ref={heading} tabIndex={-1}>
          Project sources
        </h2>
        <span className="toolbar-spacer" />
        <button onClick={onClose}>Close project sources</button>
      </div>
      <p>
        Link explicitly shared editor buffers to resolve definitions across files. Unsaved changes
        are included. No definitions are copied and no source files are saved.
      </p>
      <p>
        Linked projects support hierarchy browsing, simulation, saved tests and state diagrams. Edit
        HDL in your editor while linked; disconnect the sources to resume graph construction. All
        linked files must remain shared. VHDL and Verilog/SystemVerilog cannot be mixed.
      </p>
      <fieldset>
        <legend>Other source files (maximum 15)</legend>
        {candidates.length ? (
          candidates.map((uri) => (
            <label className="project-source" key={uri}>
              <input
                type="checkbox"
                checked={uris.includes(uri)}
                onChange={(e) =>
                  setUris((old) =>
                    e.target.checked ? [...old, uri] : old.filter((u) => u !== uri),
                  )
                }
              />
              {displayUri(uri).split('/').pop()}{' '}
              {!shared.some((s) => s.uri === uri) && '(not shared)'}
              <small>{displayUri(uri)}</small>
            </label>
          ))
        ) : (
          <p>Share another HDL file from your editor to link it here.</p>
        )}
      </fieldset>
      <button
        disabled={busy || uris.length > 15}
        onClick={async () => {
          setBusy(true);
          try {
            await window.mira.command({ type: 'projectSources', uri: state.uri, uris });
            onClose();
          } catch (e) {
            onError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Apply project sources
      </button>
      <button
        disabled={busy || !state.projectSources?.length}
        onClick={async () => {
          try {
            await window.mira.command({ type: 'projectSources', uri: state.uri, uris: [] });
            onClose();
          } catch (e) {
            onError(String(e));
          }
        }}
      >
        Disconnect all sources
      </button>
    </section>
  );
}
