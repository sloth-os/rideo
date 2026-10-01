import { formatDuration, type Timeline, timelineDuration } from '@rideo/shared';
import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { MediaPool } from '../editor/engine/media-pool';
import { Player } from '../editor/engine/player';

/**
 * Plays the animatic with the editor's player (docs/design/storyboard.md#animatic): stills, the dialogue mixes,
 * temp music and captions, clocked by the AudioContext.
 */
export function AnimaticPlayer({ projectId, timeline }: { projectId: string; timeline: Timeline }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const size = useMemo(() => {
    const scale = Math.min(1, 640 / timeline.width);
    return {
      width: Math.round((timeline.width * scale) / 2) * 2,
      height: Math.round((timeline.height * scale) / 2) * 2,
    };
  }, [timeline.width, timeline.height]);
  useEffect(() => {
    if (!canvasRef.current) return;
    const pool = new MediaPool(projectId, size);
    const player = new Player(canvasRef.current, pool, timeline);
    player.onTime = setTime;
    player.onPlaying = setPlaying;
    playerRef.current = player;
    void player.draw();
    return () => {
      player.dispose();
      pool.dispose();
      playerRef.current = null;
    };
  }, [projectId, size.width, size.height]);
  useEffect(() => {
    playerRef.current?.setTimeline(timeline);
  }, [timeline]);
  const duration = timelineDuration(timeline);
  return (
    <div className="space-y-2" data-testid="animatic-player">
      <canvas
        ref={canvasRef}
        width={size.width}
        height={size.height}
        className="aspect-video w-full rounded-[var(--radius-control)] bg-black"
        data-testid="animatic-canvas"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          onClick={() => (playing ? playerRef.current?.pause() : void playerRef.current?.play())}
          aria-label={playing ? 'Pause the animatic' : 'Play the animatic'}
          data-testid="play-animatic"
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.04}
          value={Math.min(time, duration)}
          onChange={(e) => void playerRef.current?.seek(Number(e.target.value))}
          className="min-w-0 flex-1 accent-[var(--color-accent)]"
          aria-label="Seek the animatic"
        />
        <span className="tabular text-[12px] text-muted" data-testid="animatic-time">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}
