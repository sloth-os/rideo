import { type Character, dialogueMode, isTerminalJob, voiceOf, voiceReady } from '@rideo/shared';
import { AudioLines, Check, Lock, Mic, Sparkles, Unlock } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConsentDialog } from '../../components/ConsentDialog';
import { Editable } from '../../components/Editable';
import { JobRow } from '../../components/JobProgress';
import { Badge, Button, cx } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useConfig } from '../../lib/config';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

function Sample({ projectId, path, label }: { projectId: string; path: string; label: string }) {
  return (
    // biome-ignore lint/a11y/useMediaCaption: voice previews are speech samples with no visual track to caption
    <audio
      controls
      preload="none"
      src={mediaUrl(projectId, path)}
      aria-label={label}
      className="h-8 w-full min-w-0 sm:max-w-xs"
      data-testid="voice-sample"
    />
  );
}

/**
 * A character's voice (docs/design/dialogue.md#voice-of-a-character): design previews, pick one or clone a
 * recording with consent, then lock it. The lock is independent of the face.
 */
export function VoicePanel({ c }: { c: Character }) {
  const { projectId, jobs, docs } = useProject();
  const cfg = useConfig();
  const [pending, setPending] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!projectId || !docs) return null;
  const v = voiceOf(c);
  const mode = dialogueMode(docs.project.settings);
  const tts = cfg?.features.tts ?? null;
  const locked = v.lock.locked;
  const job = Object.values(jobs).find(
    (j) => !isTerminalJob(j) && j.kind === 'voice.design' && j.params.characterId === c.id,
  );
  const lockable = !!v.sample && (mode !== 'tts' || !!v.voiceId);
  const chosen = (hash: string) => v.sample?.hash === hash;
  return (
    <section className="border-t border-border px-4 py-3" data-testid="voice-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex flex-1 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
          <AudioLines className="size-3.5" /> Voice
        </h4>
        {locked ? (
          <Badge tone="success" title={`Locked ${v.lock.lockedAt ?? ''}`} testid="voice-locked">
            <Lock className="size-3" /> voice v{v.lock.version}
          </Badge>
        ) : v.sample ? (
          <Badge tone="info">{v.source === 'cloned' ? 'cloned' : 'chosen'}</Badge>
        ) : mode !== 'off' && voiceReady(c, mode) === false ? (
          <Badge tone="warning">no voice yet</Badge>
        ) : null}
        {locked ? (
          <Button
            size="sm"
            icon={<Unlock className="size-3.5" />}
            onClick={() => api.unlockVoice(projectId, c.id).catch(reportError)}
            data-testid="unlock-voice"
          >
            Unlock voice
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              icon={<Sparkles className="size-3.5" />}
              disabled={!tts || !!job}
              title={tts ? 'Design three voices from the description' : 'Needs a TTS provider on the server'}
              onClick={() => api.designVoice(projectId, c.id).catch(reportError)}
              data-testid="design-voice"
            >
              Design
            </Button>
            {tts?.clone ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Mic className="size-3.5" />}
                  onClick={() => fileRef.current?.click()}
                  data-testid="clone-voice"
                >
                  Clone
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="audio/*,video/*"
                  hidden
                  data-testid="upload-voice"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setPending(f);
                    e.target.value = '';
                  }}
                />
              </>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              icon={<Lock className="size-3.5" />}
              disabled={!lockable}
              title={lockable ? 'Lock this voice' : 'Choose or clone a voice first'}
              onClick={() => api.lockVoice(projectId, c.id).catch(reportError)}
              data-testid="lock-voice"
            >
              Lock voice
            </Button>
          </>
        )}
      </div>
      {!tts ? (
        <p className="mt-2 text-[12px] text-muted">
          Voices need a TTS provider on the server (RIDEO_TTS_PROVIDER).
        </p>
      ) : mode === 'off' ? (
        <p className="mt-2 text-[12px] text-muted">
          Dialogue audio is off for this project (Overview → Settings).
        </p>
      ) : null}
      <div className="mt-2 text-[13px]">
        {locked ? (
          <p className="text-muted">{v.description || '—'}</p>
        ) : (
          <Editable
            value={v.description}
            placeholder="How the voice sounds: age, pitch, accent, texture"
            onSave={(description) =>
              api
                .updateCharacter(projectId, c.id, { voice: { description } }, `voice:${c.id}`)
                .catch(reportError)
            }
            ariaLabel={`${c.name} voice description`}
          />
        )}
      </div>
      {job ? (
        <div className="mt-2">
          <JobRow job={job} projectId={projectId} compact />
        </div>
      ) : null}
      {v.sample ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">{c.name}:</span>
          <Sample projectId={projectId} path={v.sample.path} label={`${c.name} voice`} />
          {v.consent?.depictsRealPerson ? (
            <Badge tone="info" title={`Consent by ${v.consent.grantedBy} on ${v.consent.grantedAt}`}>
              real person
            </Badge>
          ) : null}
        </div>
      ) : null}
      {!locked && v.candidates.length ? (
        <ul className="mt-2 space-y-1.5" data-testid="voice-candidates">
          {v.candidates.map((cand, i) => (
            <li
              key={cand.id}
              className={cx(
                'flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border px-2 py-1.5',
                chosen(cand.sample.hash) ? 'border-success' : 'border-border',
              )}
              data-testid="voice-candidate"
            >
              <span className="w-14 text-[12px] font-medium">Voice {i + 1}</span>
              <div className="min-w-0 flex-1">
                <Sample projectId={projectId} path={cand.sample.path} label={`${c.name} voice ${i + 1}`} />
              </div>
              {chosen(cand.sample.hash) ? (
                <Badge tone="success">
                  <Check className="size-3" /> chosen
                </Badge>
              ) : (
                <Button
                  size="sm"
                  onClick={() => api.selectVoice(projectId, c.id, cand.id).catch(reportError)}
                  data-testid="select-voice"
                >
                  Use
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <ConsentDialog
        open={!!pending}
        what="voice sample"
        fileName={pending?.name}
        onCancel={() => setPending(null)}
        onConfirm={async (consent) => {
          if (!pending) return;
          try {
            await api.cloneVoice(projectId, c.id, pending, consent);
            setPending(null);
          } catch (err) {
            reportError(err);
          }
        }}
      />
    </section>
  );
}
