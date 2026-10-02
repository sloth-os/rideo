/**
 * Heartbeats sent off the main thread (docs/design/engine-performance.md#rendering-in-a-background-tab): a dedicated
 * worker posts the job's heartbeat on its own timer, so neither a hidden page's throttled timers nor a main thread
 * busy for a long time (a slow GPU readback, a long synchronous step) lets the lease expire. The page tells it the
 * latest progress and hears the replies (cancelled, lease lost).
 */

export interface HeartbeatReply {
  /** The HTTP status (0: the request did not complete). */
  status: number;
  json: unknown;
}

export interface HeartbeatPump {
  readonly source: 'worker' | 'page';
  /** The latest body to send (the session and the progress). */
  update(body: string): void;
  stop(): void;
}

export interface HeartbeatRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  ms: number;
}

const SOURCE = `let t=null,r=null;
async function beat(){if(!r)return;try{const res=await fetch(r.url,{method:'POST',headers:r.headers,body:r.body,credentials:'same-origin'});let json=null;try{json=await res.json();}catch{}postMessage({status:res.status,json});}catch{postMessage({status:0,json:null});}}
onmessage=(e)=>{const m=e.data;if(m.type==='start'){r=m;clearInterval(t);t=setInterval(beat,m.ms);}else if(m.type==='body'){if(r)r.body=m.body;}else{clearInterval(t);t=null;r=null;}};`;

export function startHeartbeat(
  req: HeartbeatRequest,
  onReply: (reply: HeartbeatReply) => void,
): HeartbeatPump {
  // A blob worker has no base URL to resolve a path against: it gets the absolute one
  const absolute = { ...req, url: new URL(req.url, globalThis.location?.href ?? 'http://localhost/').href };
  let warned = false;
  const reply = (r: HeartbeatReply) => {
    if (r.status === 0 && !warned) {
      warned = true;
      console.warn('heartbeat not sent; the page sends its own with progress');
    }
    onReply(r);
  };
  try {
    if (typeof Worker === 'undefined') throw new Error('no workers');
    const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent<HeartbeatReply>) => reply(e.data);
    worker.postMessage({ type: 'start', ...absolute });
    return {
      source: 'worker',
      update: (body) => worker.postMessage({ type: 'body', body }),
      stop: () => {
        worker.postMessage({ type: 'stop' });
        worker.terminate();
      },
    };
  } catch {
    // No workers here: the page sends them (throttled when hidden)
    let body = req.body;
    const beat = () =>
      fetch(absolute.url, { method: 'POST', headers: req.headers, body, credentials: 'same-origin' })
        .then(async (res) => reply({ status: res.status, json: await res.json().catch(() => null) }))
        .catch(() => reply({ status: 0, json: null }));
    const t = setInterval(beat, req.ms);
    return {
      source: 'page',
      update: (b) => {
        body = b;
      },
      stop: () => clearInterval(t),
    };
  }
}
