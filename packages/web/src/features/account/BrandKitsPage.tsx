import type { BrandKit, BrandSlot, LowerThirdTemplate } from '@rideo/shared';
import { Palette, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Field, Input, SectionHeader, Select } from '../../components/ui';
import { api, brandFileUrl } from '../../lib/api';
import { reportError, useUi } from '../../store/ui';
import { AppHeader } from '../workspace/AppHeader';

const SLOTS: { slot: BrandSlot; label: string; accept: string }[] = [
  { slot: 'title_font', label: 'Title font', accept: '.ttf,.otf,font/ttf,font/otf' },
  { slot: 'body_font', label: 'Body font', accept: '.ttf,.otf,font/ttf,font/otf' },
  { slot: 'logo', label: 'Logo', accept: 'image/png,image/jpeg,image/webp' },
  {
    slot: 'intro',
    label: 'Intro bumper',
    accept: 'video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp',
  },
  {
    slot: 'outro',
    label: 'Outro bumper',
    accept: 'video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp',
  },
];

/** The studio's brand kits (docs/design/brand-kits.md#surfaces). */
export function BrandKitsPage() {
  const [kits, setKits] = useState<BrandKit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = () =>
    api
      .brandKits()
      .then((k) => {
        setKits(k);
        setSelected((s) => s ?? k[0]?.id ?? null);
      })
      .catch(reportError);
  useEffect(() => {
    void load();
  }, []);
  const replace = (kit: BrandKit) => setKits((ks) => (ks ?? []).map((k) => (k.id === kit.id ? kit : k)));
  const kit = kits?.find((k) => k.id === selected) ?? null;
  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto max-w-5xl space-y-4 px-3 py-4 sm:px-6">
        <SectionHeader
          title="Brand kits"
          subtitle="Fonts, colors, logo, bumpers and lower thirds that projects take on. Applying a kit copies its files into the project."
        />
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            api
              .createBrandKit({ name: name.trim() })
              .then((k) => {
                setKits((ks) => [...(ks ?? []), k]);
                setSelected(k.id);
                setName('');
              })
              .catch(reportError);
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Kit name, e.g. Northwind"
            className="max-w-xs"
            data-testid="kit-name"
          />
          <Button
            type="submit"
            icon={<Plus className="size-4" />}
            disabled={!name.trim()}
            data-testid="kit-create"
          >
            New kit
          </Button>
        </form>
        {kits && kits.length === 0 ? (
          <EmptyState icon={<Palette className="size-8" />} title="No brand kits yet">
            Create one, then apply it to a project from its overview.
          </EmptyState>
        ) : null}
        {kits?.length ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <ul className="space-y-1" data-testid="kits">
              {kits.map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(k.id)}
                    className={`flex w-full items-center gap-2 rounded-[var(--radius-control)] border px-2.5 py-2 text-left text-[13px] ${k.id === selected ? 'border-accent bg-accent/10' : 'border-border'}`}
                    data-testid="kit-row"
                  >
                    <span className="size-3 rounded-full" style={{ background: k.colors.accent }} />
                    <span className="min-w-0 flex-1 truncate">{k.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {kit ? (
              <KitEditor
                key={kit.id}
                kit={kit}
                onChange={replace}
                onDeleted={() => {
                  setSelected(null);
                  void load();
                }}
              />
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function KitEditor({
  kit,
  onChange,
  onDeleted,
}: {
  kit: BrandKit;
  onChange: (k: BrandKit) => void;
  onDeleted: () => void;
}) {
  // Optimistic: the change shows at once; the server's kit replaces it (or the old one comes back on an error)
  const save = (patch: Parameters<typeof api.updateBrandKit>[1]) => {
    onChange({
      ...kit,
      ...(patch.name ? { name: patch.name } : {}),
      colors: { ...kit.colors, ...patch.colors },
      bug: { ...kit.bug, ...patch.bug },
      ...(patch.lowerThirds ? { lowerThirds: patch.lowerThirds } : {}),
    });
    return api
      .updateBrandKit(kit.id, patch)
      .then(onChange)
      .catch((err) => {
        onChange(kit);
        reportError(err);
      });
  };
  return (
    <Card className="space-y-4 p-4" data-testid="kit-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-semibold">{kit.name}</h3>
        <Badge>by {kit.createdBy.name}</Badge>
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="size-3.5" />}
          onClick={() => api.deleteBrandKit(kit.id).then(onDeleted).catch(reportError)}
          data-testid="kit-delete"
        >
          Delete
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['text', 'accent', 'box'] as const).map((c) => (
          <Field key={c} label={c === 'box' ? 'Box' : c === 'text' ? 'Text' : 'Accent'}>
            <input
              type="color"
              value={kit.colors[c]}
              onChange={(e) => void save({ colors: { [c]: e.target.value.toUpperCase() } })}
              className="h-9 w-full cursor-pointer rounded border border-border bg-surface-2"
              data-testid={`kit-color-${c}`}
            />
          </Field>
        ))}
        <Field label={`Box opacity ${Math.round(kit.colors.boxOpacity * 100)}%`}>
          <Input
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={kit.colors.boxOpacity}
            onMouseUp={(e) =>
              void save({ colors: { boxOpacity: Number((e.target as HTMLInputElement).value) } })
            }
            onTouchEnd={(e) =>
              void save({ colors: { boxOpacity: Number((e.target as HTMLInputElement).value) } })
            }
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {SLOTS.map((s) => (
          <FileSlot
            key={s.slot}
            kit={kit}
            slot={s.slot}
            label={s.label}
            accept={s.accept}
            onChange={onChange}
          />
        ))}
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Brand bug</div>
        <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={kit.bug.enabled}
              onChange={(e) => void save({ bug: { enabled: e.target.checked } })}
              className="accent-[var(--color-accent)]"
              data-testid="kit-bug-enabled"
            />
            On by default
          </label>
          <Field label="Corner">
            <Select
              value={kit.bug.corner}
              onChange={(e) => void save({ bug: { corner: e.target.value as BrandKit['bug']['corner'] } })}
              data-testid="kit-bug-corner"
            >
              <option value="top_left">Top left</option>
              <option value="top_right">Top right</option>
              <option value="bottom_left">Bottom left</option>
              <option value="bottom_right">Bottom right</option>
            </Select>
          </Field>
          <Field label={`Size ${Math.round(kit.bug.size * 100)}%`}>
            <Input
              type="range"
              min={0.04}
              max={0.3}
              step={0.01}
              defaultValue={kit.bug.size}
              onMouseUp={(e) => void save({ bug: { size: Number((e.target as HTMLInputElement).value) } })}
              onTouchEnd={(e) => void save({ bug: { size: Number((e.target as HTMLInputElement).value) } })}
            />
          </Field>
          <Field label={`Opacity ${Math.round(kit.bug.opacity * 100)}%`}>
            <Input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              defaultValue={kit.bug.opacity}
              onMouseUp={(e) => void save({ bug: { opacity: Number((e.target as HTMLInputElement).value) } })}
              onTouchEnd={(e) =>
                void save({ bug: { opacity: Number((e.target as HTMLInputElement).value) } })
              }
            />
          </Field>
        </div>
      </div>
      <LowerThirds kit={kit} onSave={(lowerThirds) => void save({ lowerThirds })} />
    </Card>
  );
}

function FileSlot({
  kit,
  slot,
  label,
  accept,
  onChange,
}: {
  kit: BrandKit;
  slot: BrandSlot;
  label: string;
  accept: string;
  onChange: (k: BrandKit) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const asset =
    slot === 'title_font'
      ? kit.fonts.title
      : slot === 'body_font'
        ? kit.fonts.body
        : slot === 'logo'
          ? kit.logo
          : slot === 'intro'
            ? kit.intro?.asset
            : kit.outro?.asset;
  const upload = async (f: File) => {
    setBusy(true);
    try {
      onChange(await api.uploadBrandFile(kit.id, slot, f));
      useUi.getState().toast(`${label}: ${f.name}`, 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div
      className="flex items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 p-2 text-[13px]"
      data-testid={`kit-slot-${slot}`}
    >
      {slot === 'logo' && asset ? (
        <img src={brandFileUrl(kit.id, asset.file)} alt="" className="size-8 rounded object-contain" />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted">{label}</div>
        <div className="truncate" data-testid={`kit-slot-${slot}-name`}>
          {asset ? asset.name : '—'}
          {asset?.durationSec ? ` · ${asset.durationSec.toFixed(1)} s` : ''}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
        data-testid={`kit-file-${slot}`}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        loading={busy}
        icon={<Upload className="size-3.5" />}
        onClick={() => input.current?.click()}
        aria-label={`Upload the ${label.toLowerCase()}`}
      />
    </div>
  );
}

function LowerThirds({ kit, onSave }: { kit: BrandKit; onSave: (t: LowerThirdTemplate[]) => void }) {
  const set = (k: number, patch: Partial<LowerThirdTemplate>) =>
    onSave(kit.lowerThirds.map((t, i) => (i === k ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="kit-lower-thirds">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Lower thirds</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7"
          icon={<Plus className="size-3.5" />}
          onClick={() =>
            onSave([
              ...kit.lowerThirds,
              {
                id: `template-${kit.lowerThirds.length + 1}`,
                name: `Template ${kit.lowerThirds.length + 1}`,
                position: 'left',
                font: 'body',
                color: 'text',
                box: true,
              },
            ])
          }
          data-testid="kit-lower-third-add"
        >
          Template
        </Button>
      </div>
      {kit.lowerThirds.map((t, k) => (
        <div key={t.id} className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="kit-lower-third">
          <Input
            defaultValue={t.name}
            onBlur={(e) => e.target.value.trim() && set(k, { name: e.target.value.trim() })}
            aria-label="Name"
          />
          <Select
            value={t.position}
            onChange={(e) => set(k, { position: e.target.value as LowerThirdTemplate['position'] })}
            aria-label="Position"
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </Select>
          <Select
            value={t.font}
            onChange={(e) => set(k, { font: e.target.value as LowerThirdTemplate['font'] })}
            aria-label="Font"
          >
            <option value="body">Body font</option>
            <option value="title">Title font</option>
          </Select>
          <Select
            value={t.color}
            onChange={(e) => set(k, { color: e.target.value as LowerThirdTemplate['color'] })}
            aria-label="Color"
          >
            <option value="text">Text color</option>
            <option value="accent">Accent color</option>
          </Select>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={t.box}
              onChange={(e) => set(k, { box: e.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            Box
          </label>
        </div>
      ))}
    </div>
  );
}
