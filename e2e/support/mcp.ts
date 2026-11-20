import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** An MCP client that identifies as Claude Code, like a real agent session (with `headers`: an agent token, say). */
export async function connectAgent(baseURL: string, headers?: Record<string, string>) {
  const client = new Client({ name: 'Claude Code', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${baseURL}/mcp`),
      headers ? { requestInit: { headers } } : undefined,
    ),
  );
  const call = async <T = any>(name: string, args: Record<string, unknown>): Promise<T> => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text) as T;
  };
  return { client, call };
}
