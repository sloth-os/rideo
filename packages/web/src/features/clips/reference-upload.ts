import type { Probe, Resource } from '@rideo/shared';
import { rememberUpload } from '../../engine/media-files';
import { api } from '../../lib/api';

/**
 * A clip made in this tab becomes a reference (docs/design/editor.md#media-preparation-uploads): uploaded with the
 * browser's probe, so the resource is ready at once, and with its poster. A recorded performance
 * (docs/design/performance.md) and the desk's reference clips (docs/design/director-desk.md#the-result) take this path.
 * `keep: false` lets the bytes go once uploaded instead of keeping them for the editor engine.
 */
export async function uploadReference(
  projectId: string,
  file: File,
  opts: { probe: Probe | null; poster: Blob | null; keep?: boolean },
): Promise<Resource> {
  const resource = await api.upload(projectId, file, {
    role: 'reference',
    probe: opts.probe,
    poster: opts.poster,
  });
  if (opts.keep !== false) rememberUpload(resource.media, file);
  return resource;
}
