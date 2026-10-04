import { BUNDLE_EXTENSION, formatBytes } from '@rideo/shared';
import { HardDrive, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Dialog, Progress } from '../../components/ui';
import { ApiError, api, projectExportUrl } from '../../lib/api';
import { liveClient } from '../../lib/live-bridge';
import { reportError, useUi } from '../../store/ui';
import { storageEstimate, TRASH_DAYS, workspaceEnabled, workspaceStore } from '../../workspace';
import { downloadBlob, exportFromBrowser, importIntoBrowser, readProjectFile } from '../../workspace/bundle';
import { useWorkspaceStatus } from '../../workspace/status';

/**
 * Project files (docs/design/browser-storage.md#project-files-export-and-import): export and import from the
 * dashboard and the project overview. Projects in this browser are packed and unpacked here; others by the server.
 */

/** Downloads a project as a `.rideo` file. */
export async function exportProject(project: { id: string; title: string }): Promise<void> {
  if (workspaceEnabled()) {
    const store = await workspaceStore();
    if ((await store.stat(`/projects/${project.id}`))?.isDir) {
      const { blob, filename } = await exportFromBrowser(store, project.id);
      downloadBlob(blob, filename);
      return;
    }
  }
  const a = document.createElement('a');
  a.href = projectExportUrl(project.id);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type Choice = 'replace' | 'copy';

/** Imports a project file; asks what to do when the project is already here. */
export function ImportProjectButton({ onImported }: { onImported: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<{ title: string; onlyCopy: boolean } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const toast = useUi((s) => s.toast);

  const finish = (r: { id: string; title: string }) => {
    toast(`Imported “${r.title}”`, 'success');
    onImported(r.id);
  };

  const run = async (f: File, choice: Choice | null) => {
    setConflict(null);
    setProgress(0);
    try {
      if (!workspaceEnabled()) {
        try {
          finish(await api.importProject(f, choice ?? 'new'));
        } catch (err) {
          if (err instanceof ApiError && err.code === 'conflict' && !choice) {
            setFile(f);
            setConflict({ title: f.name, onlyCopy: false });
            return;
          }
          throw err;
        }
        return;
      }
      // This browser keeps the projects: read the file here, and write it here unless a copy is needed.
      const project = await readProjectFile(f);
      const id = project.manifest.projectId;
      const store = await workspaceStore();
      const here = !!(await store.stat(`/projects/${id}`))?.isDir;
      const { elsewhere } = await api.projectIdTaken(id);
      if ((here || elsewhere) && !choice) {
        setFile(f);
        setConflict({ title: project.manifest.title, onlyCopy: elsewhere });
        return;
      }
      if (choice === 'copy' || elsewhere) {
        // A copy gets a new id and a rewritten history: the server makes it and stores it in this browser.
        finish(await api.importProject(f, 'copy'));
        return;
      }
      const r = await importIntoBrowser(store, project, here ? 'replace' : 'new', (done, total) =>
        setProgress(total ? done / total : 1),
      );
      liveClient()?.attachWorkspace([r.id]);
      finish(r);
    } catch (err) {
      reportError(err);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={`${BUNDLE_EXTENSION},.tar,application/x-tar`}
        className="hidden"
        data-testid="import-project-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f, null);
        }}
      />
      <Button
        size="sm"
        icon={<Upload className="size-4" />}
        loading={progress !== null}
        onClick={() => input.current?.click()}
        data-testid="import-project"
      >
        Import
      </Button>
      {progress !== null ? (
        <span className="w-24">
          <Progress value={progress} label="import" />
        </span>
      ) : null}
      <Dialog
        open={!!conflict}
        onClose={() => setConflict(null)}
        title="This project is already here"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConflict(null)}>
              Cancel
            </Button>
            {conflict?.onlyCopy ? null : (
              <Button
                variant="danger"
                onClick={() => file && void run(file, 'replace')}
                data-testid="import-replace"
              >
                Replace it
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => file && void run(file, 'copy')}
              data-testid="import-copy"
            >
              Keep both
            </Button>
          </>
        }
      >
        <p className="text-[13px]">
          {conflict?.onlyCopy
            ? `“${conflict.title}” is open in this studio from another browser. It is imported as a copy, with its own id and history.`
            : `“${conflict?.title}” is already in ${workspaceEnabled() ? 'this browser' : 'the studio'}. Replace it (the current one goes to the trash), or keep both (the import becomes a copy).`}
        </p>
      </Dialog>
    </>
  );
}

/** Where projects are, when it is this browser: how much space they use and what to do to keep them. */
export function BrowserStorageNote() {
  const enabled = useWorkspaceStatus((s) => s.enabled);
  const [estimate, setEstimate] = useState<Awaited<ReturnType<typeof storageEstimate>>>(null);
  useEffect(() => {
    if (enabled) void storageEstimate().then(setEstimate);
  }, [enabled]);
  if (!enabled) return null;
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3 text-[13px]" data-testid="browser-storage">
      <HardDrive className="size-5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Projects are stored in this browser</div>
        <div className="text-muted">
          Export project files to keep a copy or open them elsewhere; deleted projects stay {TRASH_DAYS} days.
          {estimate?.quota
            ? ` ${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} used${estimate.persisted ? ', kept by the browser' : ''}.`
            : ''}
        </div>
      </div>
    </Card>
  );
}
