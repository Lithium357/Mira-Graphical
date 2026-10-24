// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
export function SetupGuide({ workspace }: { workspace: string }) {
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('Checking local connection…');
  const [packaged, setPackaged] = useState(false);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const snapshot = await window.mira.command({ type: 'snapshot' });
        if (active) {
          setConnected(snapshot.editorConnected === true);
          setPackaged(snapshot.packaged === true);
          setMessage(snapshot.editorConnected ? 'VS Code connected' : 'Waiting for VS Code');
        }
      } catch {
        if (active) setMessage('Connection status unavailable. Restart Mira for this workspace.');
      }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section aria-label="Workspace setup" className="setup-guide">
      <p role="status">{message}</p>
      <p>
        <strong>Workspace:</strong> <code>{workspace}</code>
      </p>
      <button
        onClick={() =>
          void window.mira.command({ type: 'chooseWorkspace' }).catch((e) => setMessage(String(e)))
        }
      >
        Choose project folder…
      </button>
      {packaged && (
        <button
          onClick={() =>
            void window.mira
              .command({ type: 'installCompanion' })
              .catch((e) => setMessage(String(e)))
          }
        >
          Show VS Code extension…
        </button>
      )}
      <ol>
        <li>In VS Code, open this same folder and trust it when appropriate.</li>
        <li>
          {packaged ? (
            <>
              Install the companion: Extensions → … → Install from VSIX → Use{' '}
              <strong>Show VS Code extension…</strong> above to locate the VSIX, then select it with
              Extensions: Install from VSIX in VS Code. The file is{' '}
              <code>resources/companion/mira-graphical.vsix</code> inside the app's installation
              folder.
            </>
          ) : (
            <>
              <code>mira-graphical-0.8.0.vsix</code> from <code>dist/packages</code>.
            </>
          )}
        </li>
        <li>
          Open a <code>.v</code>, <code>.sv</code>, <code>.vhd</code> or <code>.vhdl</code> file
          inside that folder. Run <strong>RTL Graph: Open Current Module</strong> from the command
          palette.
        </li>
        <li>
          Wait 15 quiet seconds for the graph. Graph edits use the same delay and update the live
          editor buffer; save in VS Code when ready.
        </li>
      </ol>
      <details>
        <summary>Connection troubleshooting and keyboard controls</summary>
        <p>
          {connected
            ? 'Connected with no graph? Share the active file and check diagnostics after the countdown.'
            : 'Choose the same project folder in Mira and VS Code. After restarting Mira, run RTL Graph: Connect/Disconnect, then share the file again.'}
        </p>
        <p>
          For multi-root workspaces, Open Current Module connects to the active file’s folder. Check
          the RTL Graph output channel for details. Only the explicitly shared live buffers are
          available here.
        </p>
        <p>
          Use Tab and Shift+Tab to move between controls. View → Component navigator selects a node
          without a mouse; Inspect component opens its wiring controls. Add component focuses the
          palette. Escape closes the inspector or dialog. Pane dividers support arrow keys.
        </p>
        <p>
          The first release supports unsigned combinational subsets. Unsupported syntax appears as a
          diagnostic. Use Recovery to inspect checkpointed text after a crash.
        </p>
      </details>
    </section>
  );
}
export function SetupPanel({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="setup-dialog"
      aria-labelledby="setup-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="pane-heading">
        <h2 id="setup-title">Connect your workspace</h2>
        <button onClick={onClose} aria-label="Close setup help">
          ×
        </button>
      </div>
      <SetupGuide workspace={workspace} />
    </dialog>
  );
}
