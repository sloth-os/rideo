import { startMockGateway } from './index';

const gw = await startMockGateway({
  port: Number(process.env.MOCK_GATEWAY_PORT ?? 8790),
  host: process.env.MOCK_GATEWAY_HOST ?? '127.0.0.1',
  apiKey: process.env.MOCK_GATEWAY_API_KEY || undefined,
  latencyMs: Number(process.env.MOCK_LATENCY_MS ?? 300),
  logger: process.env.MOCK_GATEWAY_LOG === '1',
});
console.log(`mock mm-gateway listening on ${gw.url}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void gw.close().then(() => process.exit(0));
  });
}
