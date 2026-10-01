import { assertId, isDocPath } from '@rideo/shared';
import { joinPath } from './backend';

/** The only place storage paths are built (docs/design/storage-webdav.md#layout). */
export class Layout {
  constructor(readonly root: string) {}

  projectsDir(): string {
    return joinPath(this.root, 'projects');
  }

  trashDir(): string {
    return joinPath(this.root, 'trash');
  }

  project(projectId: string): string {
    return joinPath(this.projectsDir(), assertId(projectId, 'project'));
  }

  /** Work-tree copy of a versioned document. */
  doc(projectId: string, path: string): string {
    if (!isDocPath(path)) throw new Error(`not a document path: ${path}`);
    return joinPath(this.project(projectId), path);
  }

  media(projectId: string, mediaPath: string): string {
    if (
      !/^media\/[a-z0-9._/-]+$/i.test(mediaPath) ||
      mediaPath.split('/').some((s) => s === '..' || s === '.' || s === '')
    ) {
      throw new Error(`invalid media path: ${mediaPath}`);
    }
    return joinPath(this.project(projectId), mediaPath);
  }

  screenplayMarkdown(projectId: string): string {
    return joinPath(this.project(projectId), 'screenplay.md');
  }

  inbox(projectId: string): string {
    return joinPath(this.project(projectId), 'inbox');
  }

  rideoDir(projectId: string): string {
    return joinPath(this.project(projectId), '.rideo');
  }

  object(projectId: string, id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`invalid object id ${id}`);
    return joinPath(this.rideoDir(projectId), 'objects', id.slice(0, 2), `${id.slice(2)}.json`);
  }

  head(projectId: string): string {
    return joinPath(this.rideoDir(projectId), 'HEAD');
  }

  branchRef(projectId: string, name: string): string {
    return joinPath(this.rideoDir(projectId), 'refs', 'heads', name);
  }

  branchesDir(projectId: string): string {
    return joinPath(this.rideoDir(projectId), 'refs', 'heads');
  }

  tagRef(projectId: string, name: string): string {
    return joinPath(this.rideoDir(projectId), 'refs', 'tags', name);
  }

  tagsDir(projectId: string): string {
    return joinPath(this.rideoDir(projectId), 'refs', 'tags');
  }

  worktreeIndex(projectId: string): string {
    return joinPath(this.rideoDir(projectId), 'worktree.json');
  }

  jobsDir(projectId: string): string {
    return joinPath(this.rideoDir(projectId), 'jobs');
  }

  job(projectId: string, jobId: string): string {
    return joinPath(this.jobsDir(projectId), `${assertId(jobId, 'job')}.json`);
  }

  /** The studio's people and agent tokens (docs/design/accounts.md). */
  usersDir(): string {
    return joinPath(this.root, 'accounts', 'users');
  }

  user(id: string): string {
    return joinPath(this.usersDir(), `${assertId(id, 'user')}.json`);
  }

  tokensDir(): string {
    return joinPath(this.root, 'accounts', 'tokens');
  }

  token(id: string): string {
    return joinPath(this.tokensDir(), `${assertId(id, 'token')}.json`);
  }

  watermarksDir(): string {
    return joinPath(this.root, 'watermarks');
  }

  watermark(id: string): string {
    if (!/^wm_[0-9a-f]{12}$/.test(id)) throw new Error(`invalid watermark id ${id}`);
    return joinPath(this.watermarksDir(), `${id}.json`);
  }
}
