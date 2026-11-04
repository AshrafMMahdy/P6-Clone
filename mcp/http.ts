// The MCP server's HTTP mode: the Streamable HTTP transport (httpTransport.ts) on the server's own messages.
import { handleMessage } from './stdio.ts';
import { serveMcpHttp } from './httpTransport.ts';

export function startHttp(o: { port: number; host: string; token: string | null }): void {
  void serveMcpHttp(o, (m, session) => handleMessage(m, session)).then(({ port }) =>
    process.stderr.write(`P6 Clone MCP listening on http://${o.host}:${port}/mcp${o.token ? ' (bearer token required)' : ''}\n`));
}
