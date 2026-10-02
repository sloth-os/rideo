import type { BrandKit, Project } from '@rideo/shared';
import { Palette } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Badge, Button, Card, Select } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { reportError, useUi } from '../../store/ui';

/**
 * The project's brand (docs/design/brand-kits.md#a-projects-brand): which kit it applied, its colors and logo; directors
 * apply a kit (its files are copied into the project) or remove it.
 */
export function BrandCard({ project }: { project: Project }) {
  const { can } = useProjectRole(project);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const brand = project.settings.brand;
  useEffect(() => {
    api
      .brandKits()
      .then(setKits)
      .catch(() => setKits([]));
  }, []);
  useEffect(() => setChoice(brand?.kitId ?? ''), [brand?.kitId]);
  const apply = async (kitId: string | null) => {
    setBusy(true);
    try {
      await api.applyBrand(project.id, kitId);
      useUi.getState().toast(kitId ? 'Brand applied' : 'Brand removed', 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="brand-card">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Palette className="size-4 text-muted" /> Brand
        {brand ? (
          <Badge tone="accent" testid="brand-name">
            {brand.name}
          </Badge>
        ) : null}
      </div>
      {brand ? (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-muted"
          data-testid="brand-summary"
        >
          {brand.logo ? (
            <img
              src={mediaUrl(project.id, brand.logo.path)}
              alt=""
              className="h-8 w-auto rounded bg-surface-2"
            />
          ) : null}
          {(['text', 'accent', 'box'] as const).map((c) => (
            <span key={c} className="inline-flex items-center gap-1">
              <span
                className="size-3 rounded-full border border-border"
                style={{ background: brand.colors[c] }}
              />
              {c}
            </span>
          ))}
          {brand.fonts.title ? <span>title font</span> : null}
          {brand.intro ? <span>intro</span> : null}
          {brand.outro ? <span>outro</span> : null}
          {brand.bug.enabled ? <span>bug on</span> : null}
        </div>
      ) : (
        <p className="mb-3 text-[13px] text-muted">
          No brand: titles use the defaults.{' '}
          <Link to="/brand" className="underline">
            Brand kits
          </Link>
        </p>
      )}
      {can('project.manage') ? (
        <div className="flex flex-wrap gap-2">
          <Select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="max-w-56"
            aria-label="Brand kit"
            data-testid="brand-select"
          >
            <option value="">No kit</option>
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            className="h-9"
            loading={busy}
            disabled={!choice && !brand}
            onClick={() => void apply(choice || null)}
            data-testid="brand-apply"
          >
            {choice ? (brand?.kitId === choice ? 'Apply again' : 'Apply') : 'Remove'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
