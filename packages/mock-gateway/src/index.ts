import type { AddressInfo } from 'node:net';
import { buildMockGateway, type MockGatewayApp, type MockGatewayOptions } from './app';

export { buildMockGateway, type MockGatewayApp, type MockGatewayOptions } from './app';
export { MOCK_MODELS } from './models';
export { signatureColor } from './signature';

export interface RunningMockGateway extends MockGatewayApp {
  url: string;
  port: number;
}

/** Starts the mock gateway on a port (0 = random) and returns its base URL. */
export async function startMockGateway(
  opts: MockGatewayOptions & { port?: number; host?: string } = {},
): Promise<RunningMockGateway> {
  const gw = await buildMockGateway(opts);
  await gw.app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  const port = (gw.app.server.address() as AddressInfo).port;
  return {
    ...gw,
    port,
    url: `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${port}`,
  };
}
