import { join } from 'node:path';
import {
  type Actor,
  type Character,
  type ConsentInput,
  canonicalJson,
  dialogueMode,
  docPath,
  type Job,
  type Voice,
  voiceOf,
} from '@rideo/shared';
import type { TtsClient } from '../ai/tts';
import { AppError, invalid, notFound } from '../errors';
import { sha256 } from '../util/crypto';
import { Service } from './base';
import { consentRecord, type UploadSource } from './story';

/** Provider, voice id, sample and description: relocking an unchanged voice keeps its version (rule V6). */
export function voiceIdentityHash(v: Voice): string {
  return sha256(
    canonicalJson({
      provider: v.provider,
      voiceId: v.voiceId,
      sample: v.sample?.hash ?? null,
      description: v.description,
    }),
  );
}

const voiceLocked = (c: Character) =>
  new AppError('voice_locked', `${c.name}'s voice is locked; unlock the voice before changing it (rule V2)`);

/** Character voices (docs/design/dialogue.md#voice-of-a-character): design, pick, clone, lock. */
export class VoiceService extends Service {
  tts(): TtsClient {
    if (!this.deps.tts)
      throw new AppError(
        'tts_unavailable',
        'Voices need a TTS provider: set RIDEO_TTS_PROVIDER on the server (docs/deployment.md)',
      );
    return this.deps.tts;
  }

  private async character(projectId: string, id: string): Promise<Character> {
    const c = (await this.deps.projects.docs(projectId)).characters[id];
    if (!c) throw notFound(`character ${id}`);
    return c;
  }

  private async updateVoice(
    actor: Actor,
    projectId: string,
    id: string,
    message: (c: Character) => string,
    fn: (v: Voice, c: Character) => Voice,
  ): Promise<Character> {
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const c = structuredClone(tx.require<Character>(docPath.character(id), `character ${id}`));
        const next: Character = { ...c, voice: fn(voiceOf(c), c) };
        tx.set(docPath.character(id), next);
        return next;
      },
      { message },
    );
    return result;
  }

  /** Starts `voice.design`: three previews from the description, speaking the character's own lines. */
  async design(actor: Actor, projectId: string, id: string): Promise<Job> {
    const c = await this.character(projectId, id);
    if (voiceOf(c).lock.locked) throw voiceLocked(c);
    this.tts();
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'voice.design',
      params: { characterId: id },
      actor,
      branch: await this.branchOf(projectId),
      dedupeKey: `voice:${id}`,
      priority: 5,
    });
  }

  /** The picked preview becomes the voice (ElevenLabs saves it to the voice library). */
  async select(actor: Actor, projectId: string, id: string, candidateId: string): Promise<Character> {
    const c = await this.character(projectId, id);
    const v = voiceOf(c);
    if (v.lock.locked) throw voiceLocked(c);
    const candidate = v.candidates.find((x) => x.id === candidateId);
    if (!candidate) throw notFound(`voice candidate ${candidateId}`);
    const tts = this.tts();
    const voiceId = await tts.save({
      previewVoiceId: candidate.voiceId,
      name: c.name,
      description: v.description,
    });
    return this.updateVoice(
      actor,
      projectId,
      id,
      (x) => `Choose a voice for ${x.name}`,
      (cur, x) => {
        if (cur.lock.locked) throw voiceLocked(x);
        return {
          ...cur,
          provider: tts.provider,
          voiceId,
          source: tts.provider === 'openai' ? 'preset' : 'designed',
          sample: candidate.sample,
          consent: undefined,
        };
      },
    );
  }

  /** Instant clone of a recording; a real person's voice needs a consent record (docs/design/provenance.md). */
  async clone(
    actor: Actor,
    projectId: string,
    id: string,
    source: UploadSource,
    consentInput: ConsentInput | undefined,
  ): Promise<Character> {
    const c = await this.character(projectId, id);
    if (voiceOf(c).lock.locked) throw voiceLocked(c);
    const consent = consentRecord(actor, consentInput, 'voice sample');
    const tts = this.tts();
    if (!tts.canClone) await tts.clone({ name: c.name, audio: Buffer.alloc(0), filename: '', mime: '' });
    const upload =
      'uri' in source
        ? await this.deps.media.importUri(projectId, source.uri, {
            kind: 'voices',
            name: `${c.name}-recording`,
            maxBytes: 50 * 1024 * 1024,
          })
        : await this.deps.media.putFile(projectId, source.file, {
            kind: 'voices',
            name: `${c.name}-recording`,
            mime: source.mime,
          });
    if (!/^(audio|video)\//.test(upload.mime) || upload.hasAudio === false)
      throw invalid('a voice sample must be an audio recording');
    const local = await this.deps.media.localPath(projectId, upload);
    const voiceId = await tts.clone({
      name: c.name,
      audio: await this.deps.media.readBuffer(projectId, upload),
      filename: local.split('/').pop() ?? 'sample',
      mime: upload.mime,
    });
    // The sample (the reference audio and the judge's reference) is the first 20 s, as mono WAV.
    const sample = await this.deps.media.withTmpDir(async (dir) => {
      const out = join(dir, 'sample.wav');
      await this.deps.ff.run([
        '-i',
        local,
        '-t',
        '20',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        out,
      ]);
      return this.deps.media.putFile(projectId, out, {
        kind: 'voices',
        name: `${c.name}-sample`,
        mime: 'audio/wav',
      });
    });
    return this.updateVoice(
      actor,
      projectId,
      id,
      (x) => `Clone a voice for ${x.name}`,
      (cur, x) => {
        if (cur.lock.locked) throw voiceLocked(x);
        return { ...cur, provider: tts.provider, voiceId, source: 'cloned', sample, consent };
      },
    );
  }

  /** Lock (V1/V2): needs a sample, and the provider's voice for TTS dialogue. */
  async lock(actor: Actor, projectId: string, id: string): Promise<Character> {
    const docs = await this.deps.projects.docs(projectId);
    const tts = dialogueMode(docs.project.settings) === 'tts';
    const c = await this.updateVoice(
      actor,
      projectId,
      id,
      (x) => `Lock the voice of ${x.name}`,
      (v, x) => {
        if (v.lock.locked) return v;
        if (!v.sample || (tts && !v.voiceId))
          throw invalid(`Choose or clone a voice for ${x.name} before locking it`);
        const hash = voiceIdentityHash(v);
        const version =
          v.lock.identityHash === hash && v.lock.version > 0 ? v.lock.version : v.lock.version + 1;
        return {
          ...v,
          lock: {
            locked: true,
            version,
            lockedAt: new Date().toISOString(),
            lockedBy: actor,
            identityHash: hash,
          },
        };
      },
    );
    this.activity(
      projectId,
      actor,
      'voice.lock',
      `Locked the voice of ${c.name} (v${voiceOf(c).lock.version})`,
    );
    return c;
  }

  async unlock(actor: Actor, projectId: string, id: string): Promise<Character> {
    return this.updateVoice(
      actor,
      projectId,
      id,
      (x) => `Unlock the voice of ${x.name}`,
      (v) => ({ ...v, lock: { ...v.lock, locked: false } }),
    );
  }
}
