import { loadConfig } from './config';
import { buildServer } from './http/app';

try {
  process.loadEnvFile();
} catch {
  // no .env file: environment only
}

const server = await buildServer(loadConfig());
await server.start();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server
      .stop()
      .catch((err) => console.error(err))
      .finally(() => process.exit(0));
  });
}
