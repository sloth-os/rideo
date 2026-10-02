import { lowerThirdItem, type ProjectBrand, type TimelineOp } from '@rideo/shared';
import { Clapperboard, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Field, Input, Select } from '../../components/ui';

/**
 * The brand in the editor (docs/design/brand-kits.md#a-projects-brand): a lower third from a template at the
 * playhead, and the intro and outro bumpers.
 */
export function BrandTools({
  brand,
  time,
  apply,
}: {
  brand: ProjectBrand | null;
  time: number;
  apply: (ops: TimelineOp[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(brand?.lowerThirds[0]?.id ?? '');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  if (!brand) return null;
  const bumper = (position: 'intro' | 'outro') => {
    const b = brand[position];
    if (!b) return;
    apply([
      {
        op: 'add_bumper',
        position,
        source: { type: 'media', media: b.media },
        durationSec: b.durationSec,
      },
    ]);
  };
  const t = brand.lowerThirds.find((x) => x.id === template) ?? brand.lowerThirds[0];
  return (
    <>
      {brand.lowerThirds.length ? (
        <Button
          icon={<Rows3 className="size-4" />}
          onClick={() => setOpen(true)}
          data-testid="lower-third-open"
        >
          Lower third
        </Button>
      ) : null}
      {brand.intro ? (
        <Button
          icon={<Clapperboard className="size-4" />}
          onClick={() => bumper('intro')}
          data-testid="add-intro"
        >
          Intro
        </Button>
      ) : null}
      {brand.outro ? (
        <Button
          icon={<Clapperboard className="size-4" />}
          onClick={() => bumper('outro')}
          data-testid="add-outro"
        >
          Outro
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add a lower third"
        footer={
          <Button
            variant="primary"
            disabled={!name.trim() || !t}
            onClick={() => {
              if (!t) return;
              apply([
                { op: 'add_text', item: lowerThirdItem(brand, t, { name, role, start: Math.max(0, time) }) },
              ]);
              setOpen(false);
              setName('');
              setRole('');
            }}
            data-testid="lower-third-add"
          >
            Add at the playhead
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Template">
            <Select
              value={t?.id ?? ''}
              onChange={(e) => setTemplate(e.target.value)}
              data-testid="lower-third-template"
            >
              {brand.lowerThirds.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              data-testid="lower-third-name"
            />
          </Field>
          <Field label="Role">
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              maxLength={120}
              data-testid="lower-third-role"
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
