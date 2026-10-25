// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
export function SetupGuide({ workspace }: { workspace: string }) {
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('Checking local connection…');
  const [versions, setVersions] = useState<{ desktop: string; companion?: string }>();
  const [packaged, setPackaged] = useState(false);
  const [shared, setShared] = useState(0);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const snapshot = await window.mira.command({ type: 'snapshot' });
        if (active) {
          setConnected(snapshot.editorConnected === true);
          setPackaged(snapshot.packaged === true);
          setShared(snapshot.states.length);
          setVersions({ desktop: snapshot.version, companion: snapshot.companionVersion });
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
      <h2>Get your first circuit on screen</h2>
      <p role="status" aria-atomic="true">
        {message}
      </p>
      <p className="setup-next-step">
        <strong>Next step: </strong>
        {connected && versions?.desktop !== versions?.companion
          ? 'Update the companion below, then run Developer: Reload Window in VS Code.'
          : connected && shared === 0
            ? 'Open an HDL file in VS Code and run RTL Graph: Open Current Module.'
            : connected
              ? 'Your file is shared. Wait for the synchronization countdown; check any diagnostic shown above.'
              : 'Install the companion below, open this project in VS Code, then share an HDL file.'}
      </p>
      {versions && (
        <p>
          Desktop {versions.desktop} · Companion {versions.companion ?? 'not reported'}
          {connected && versions.desktop !== versions.companion
            ? ' — update the companion to match Mira.'
            : ''}
        </p>
      )}
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
        <li>
          In VS Code, use File → Open Folder to open the workspace shown above. Trust only projects
          you recognize.
        </li>
        <li>
          {packaged ? (
            <>
              Use <strong>Show VS Code extension…</strong> above to locate the VSIX, then select it
              with <strong>Extensions: Install from VSIX…</strong> in VS Code's command palette
              (Ctrl+Shift+P). The file is <code>resources/companion/mira-graphical.vsix</code>{' '}
              inside the app's installation folder.
            </>
          ) : (
            <>
              Install the companion: Extensions → … → Install from VSIX →{' '}
              <code>mira-graphical-{versions?.desktop ?? 'current'}.vsix</code> from{' '}
              <code>dist/packages</code>.
            </>
          )}{' '}
          After updating an active companion, run <strong>Developer: Reload Window</strong> once.
        </li>
        <li>
          Open a <code>.v</code>, <code>.sv</code>, <code>.vhd</code> or <code>.vhdl</code> file
          inside that folder. Run <strong>RTL Graph: Open Current Module</strong> from the command
          palette (Ctrl+Shift+P). Sharing reads your current buffer, including unsaved changes.
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
            : 'Choose the same project folder in Mira and VS Code. The companion reconnects automatically after Mira restarts. If you manually disconnected, run RTL Graph: Open Current Module to connect and share the active file again.'}
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
          Supported subsets include combinational logic, clocked hierarchy and registers in Verilog,
          SystemVerilog and VHDL. Unsupported syntax appears as a diagnostic. Use Recovery to
          inspect checkpointed text after a crash.
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
