import type { Recipe, RecipeParam } from '@rideo/shared';
import { BookOpen, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

/** The prompts an agent can use (docs/design/agents.md#prompts). */
export const AGENT_PROMPTS = [
  'direct_scene',
  'address_review_notes',
  'cast_voices',
  'dub_film',
  'make_variations',
];

/**
 * Recipes of the studio (docs/design/agents.md#recipes): what each does, *Run* with its parameters on this project,
 * and *Delete* for the studio's own.
 */
export function RecipesCard() {
  const { docs, projectId } = useProject();
  const { can } = useProjectRole(docs?.project);
  const [recipes, setRecipes] = useState<Recipe[] | null>(null);
  const [running, setRunning] = useState<Recipe | null>(null);
  const load = () =>
    api
      .recipes()
      .then(setRecipes)
      .catch(() => setRecipes([]));
  useEffect(() => {
    void load();
  }, []);
  if (!docs || !projectId) return null;
  return (
    <Card className="p-4" data-testid="recipes-card">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <BookOpen className="size-4 text-muted" /> Recipes
      </div>
      <p className="mb-1 text-[13px] text-muted">
        Sequences of steps an agent or you can run on any project. Agents also have these prompts:
      </p>
      <ul className="mb-2 flex flex-wrap gap-1" data-testid="agent-prompts">
        {AGENT_PROMPTS.map((p) => (
          <li key={p}>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[12px] break-all">{p}</code>
          </li>
        ))}
      </ul>
      {recipes === null ? null : recipes.length === 0 ? (
        <p className="text-[13px] text-muted">No recipes.</p>
      ) : (
        <ul className="space-y-1.5">
          {recipes.map((r) => (
            <li
              key={r.id}
              className="rounded-[var(--radius-control)] border border-border bg-surface-2 p-2 text-[13px]"
              data-testid="recipe-row"
              data-recipe-id={r.id}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-medium" data-testid="recipe-name">
                  {r.name}
                </span>
                {r.builtin ? <Badge>built-in</Badge> : <Badge tone="info">by {r.createdBy.name}</Badge>}
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  icon={<Play className="size-3.5" />}
                  disabled={!can('project.edit')}
                  onClick={() => setRunning(r)}
                  data-testid="recipe-run"
                >
                  Run
                </Button>
                {!r.builtin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    aria-label={`Delete ${r.name}`}
                    icon={<Trash2 className="size-3.5" />}
                    onClick={() => api.deleteRecipe(r.id).then(load).catch(reportError)}
                    data-testid="recipe-delete"
                  />
                ) : null}
              </div>
              {r.description ? <p className="mt-0.5 text-[12px] text-muted">{r.description}</p> : null}
              <p className="mt-0.5 font-mono text-[11px] text-muted">
                {r.steps.map((s) => s.tool).join(' → ')}
              </p>
            </li>
          ))}
        </ul>
      )}
      {running ? <RunDialog recipe={running} projectId={projectId} onClose={() => setRunning(null)} /> : null}
    </Card>
  );
}

function initial(p: RecipeParam): string | boolean {
  if (p.type === 'boolean') return p.default === undefined ? false : Boolean(p.default);
  if (p.default === undefined) return '';
  return Array.isArray(p.default) ? p.default.join(', ') : String(p.default);
}

function value(p: RecipeParam, raw: string | boolean): unknown {
  if (p.type === 'boolean') return raw;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (p.type === 'number') return Number(s);
  if (p.type === 'ids')
    return s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return s;
}

function RunDialog({
  recipe,
  projectId,
  onClose,
}: {
  recipe: Recipe;
  projectId: string;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(recipe.params.map((p) => [p.name, initial(p)])),
  );
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const params = Object.fromEntries(
        recipe.params
          .map((p) => [p.name, value(p, form[p.name] ?? '')] as const)
          .filter(([, v]) => v !== undefined),
      );
      await api.runRecipe(projectId, recipe.id, params);
      useUi.getState().toast(`${recipe.name}: started`, 'success');
      onClose();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Run “${recipe.name}”`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()} data-testid="recipe-start">
            Run
          </Button>
        </>
      }
    >
      <ol className="mb-3 list-decimal space-y-0.5 pl-5 text-[13px] text-muted">
        {recipe.steps.map((s, k) => (
          <li key={k}>{s.label ?? s.tool}</li>
        ))}
      </ol>
      <div className="space-y-2">
        {recipe.params.map((p) => (
          <Field key={p.name} label={`${p.name}${p.required ? ' *' : ''}`} hint={p.description}>
            {p.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={form[p.name] === true}
                onChange={(e) => setForm({ ...form, [p.name]: e.target.checked })}
                className="accent-[var(--color-accent)]"
                data-testid={`recipe-param-${p.name}`}
              />
            ) : (
              <Input
                type={p.type === 'number' ? 'number' : 'text'}
                value={String(form[p.name] ?? '')}
                onChange={(e) => setForm({ ...form, [p.name]: e.target.value })}
                placeholder={p.type === 'ids' ? 'ids, separated by commas' : undefined}
                data-testid={`recipe-param-${p.name}`}
              />
            )}
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
