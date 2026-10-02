/**
 * A timer that keeps its pace in a hidden tab (docs/design/engine-performance.md#rendering-in-a-background-tab): a
 * dedicated worker posts a tick every interval, because browsers throttle a hidden page's own timers (once a second,
 * then once a minute) but not its workers'. Where workers are unavailable, a plain interval.
 */

export interface Ticker {
  /** Where the ticks come from. */
  readonly source: 'worker' | 'page';
  stop(): void;
}

const SOURCE = `let t=null;onmessage=(e)=>{clearInterval(t);t=e.data>0?setInterval(()=>postMessage(0),e.data):null;};`;

export function startTicker(ms: number, onTick: () => void): Ticker {
  try {
    if (typeof Worker === 'undefined') throw new Error('no workers');
    const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => onTick();
    worker.postMessage(ms);
    return {
      source: 'worker',
      stop: () => {
        worker.postMessage(0);
        worker.terminate();
      },
    };
  } catch {
    const t = setInterval(onTick, ms);
    return { source: 'page', stop: () => clearInterval(t) };
  }
}
