import { Agent, request } from 'undici';
import { ApiError, requireValid, type TSchema } from '@rt/contracts';
import type { Static } from '@rt/contracts';
import type { Integration } from './store.ts';
export function validBaseUrl(value: string, development: boolean) {
  try {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      (u.protocol === 'https:' ||
        (development &&
          u.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export class MisClient {
  private agent: Agent;
  constructor(
    private config: Integration,
    private development = false,
  ) {
    if (!validBaseUrl(config.url, development)) throw new ApiError('MIS_UNAVAILABLE', 503);
    this.agent = new Agent({
      connect: { ...(config.ca ? { ca: config.ca } : {}), rejectUnauthorized: true },
    });
  }
  async call(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) {
    try {
      const response = await request(new URL('/integration/v1' + path, this.config.url), {
        dispatcher: this.agent,
        method,
        headers: {
          authorization: `Bearer ${this.config.key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: this.config.timeoutMs,
        bodyTimeout: this.config.timeoutMs,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (response.statusCode >= 400) {
        await response.body.dump();
        if (response.statusCode === 410) throw new ApiError('SESSION_EXPIRED', 410);
        if (response.statusCode === 401 || response.statusCode === 403)
          throw new ApiError('UNAUTHORIZED', 401);
        if (response.statusCode === 404) throw new ApiError('NOT_FOUND', 404);
        if (response.statusCode === 429) throw new ApiError('RATE_LIMITED', 429);
        throw new ApiError('MIS_UNAVAILABLE', 503);
      }
      if (response.statusCode >= 300) {
        await response.body.dump();
        throw new ApiError('INVALID_MIS_RESPONSE', 502);
      }
      const limit = path.endsWith('/pdf') ? 25 * 1024 * 1024 : 1024 * 1024;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new ApiError('INVALID_MIS_RESPONSE', 502);
        chunks.push(Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '') };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('MIS_UNAVAILABLE', 503);
    } finally {
      await this.agent.close();
    }
  }
  async json<T extends TSchema>(
    path: string,
    schema: T,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<Static<T>> {
    const r = await this.call(path, method, body);
    try {
      return requireValid(schema, JSON.parse(r.bytes.toString()));
    } catch {
      throw new ApiError('INVALID_MIS_RESPONSE', 502);
    }
  }
}
