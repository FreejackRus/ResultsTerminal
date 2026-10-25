import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from '@rt/contracts';
import {
  ApiError,
  HealthSchema,
  ConfigSchema,
  HardwareSchema,
  TimersSchema,
  IdentificationSchema,
  ConfirmationSchema,
  SessionSchema,
  ChallengeSchema,
  CapabilitiesSchema,
  ResultsSchema,
  requireValid,
  effectiveConfig,
  type Session,
} from '@rt/contracts';
import { Store, token, digest, hashPassword, checkPassword, type Integration } from './store.ts';
import { MisClient, validBaseUrl } from './mis.ts';
type OwnedSession = {
  terminal: string;
  upstream: string;
  expires: number;
  results: Map<string, string>;
};
export async function createGateway(
  options: {
    store?: Store;
    development?: boolean;
    bootstrapToken?: string;
    tls?: { key: Buffer; cert: Buffer };
  } = {},
) {
  const store = options.store ?? new Store(resolve('var/gateway.sqlite')),
    dev = options.development ?? false;
  const app = Fastify({
    logger: false,
    bodyLimit: 800000,
    requestTimeout: 35000,
    ...(options.tls ? { https: options.tls } : {}),
  });
  await app.register(cookie);
  const admins = new Map<string, number>(),
    sessions = new Map<string, OwnedSession>(),
    challenges = new Map<
      string,
      { terminal: string; upstream: string; expires: number; attempts: number; generation: number }
    >(),
    generations = new Map<string, number>();
  const rates = new Map<string, { count: number; expires: number }>();
  const text = Type.String({ minLength: 1, maxLength: 200 });
  function rate(key: string, max: number, ms = 60000) {
    const now = Date.now();
    let r = rates.get(key);
    if (!r || r.expires < now) {
      r = { count: 0, expires: now + ms };
      rates.set(key, r);
    }
    if (++r.count > max) throw new ApiError('RATE_LIMITED', 429);
  }
  function terminal(req: FastifyRequest) {
    const header = req.headers.authorization ?? '';
    const t = store.terminalByToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!t) throw new ApiError('UNAUTHORIZED', 401);
    return t;
  }
  const mis = () => new MisClient(store.integration, dev);
  const upstreamPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const closeUpstream = async (s: OwnedSession) => {
    try {
      await mis().call(upstreamPath(s.upstream), 'DELETE');
    } catch {
      /* expiry at the MIS is the fallback */
    }
  };
  async function clearTerminal(id: string) {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    for (const [k, c] of challenges) if (c.terminal === id) challenges.delete(k);
    const closing = [];
    for (const [k, s] of sessions)
      if (s.terminal === id) {
        sessions.delete(k);
        closing.push(closeUpstream(s));
      }
    await Promise.all(closing);
  }
  function owned(req: FastifyRequest, id: string) {
    const t = terminal(req),
      s = sessions.get(id);
    if (!s || s.terminal !== t.id || s.expires <= Date.now())
      throw new ApiError('SESSION_EXPIRED', 410);
    return s;
  }
  async function attach(t: { id: string }, session: Session, generation: number) {
    if (
      generations.get(t.id) !== generation ||
      !store.db.prepare('SELECT id FROM terminals WHERE id=? AND revoked=0').get(t.id)
    ) {
      await closeUpstream({
        terminal: t.id,
        upstream: session.sessionId,
        expires: 0,
        results: new Map(),
      });
      throw new ApiError('SESSION_EXPIRED', 410);
    }
    const id = randomUUID(),
      expires = Math.min(Date.parse(session.expiresAt), Date.now() + 900000);
    if (expires <= Date.now()) throw new ApiError('SESSION_EXPIRED', 410);
    sessions.set(id, { terminal: t.id, upstream: session.sessionId, expires, results: new Map() });
    return { ...session, sessionId: id, expiresAt: new Date(expires).toISOString() };
  }
  function login(reply: any) {
    const value = token();
    admins.set(digest(value), Date.now() + 8 * 3600000);
    reply.setCookie('rt_admin', value, {
      httpOnly: true,
      secure: !dev,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: 8 * 3600,
    });
    return { ok: true };
  }
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (!dev) reply.header('Strict-Transport-Security', 'max-age=31536000');
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/admin')) {
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-rt-admin'] !== '1')
        throw new ApiError('FORBIDDEN', 403);
      if (
        !['/api/admin/status', '/api/admin/setup', '/api/admin/login'].includes(path) &&
        (admins.get(digest(req.cookies.rt_admin ?? '')) ?? 0) <= Date.now()
      )
        throw new ApiError('UNAUTHORIZED', 401);
    }
    if (path.startsWith('/api/v1') && path !== '/api/v1/enroll') terminal(req);
  });
  app.setErrorHandler((error, req, reply) => {
    const e =
      error instanceof ApiError
        ? error
        : new ApiError(
            (error as any).statusCode >= 400 && (error as any).statusCode < 500
              ? 'VALIDATION_ERROR'
              : 'INTERNAL_ERROR',
            (error as any).statusCode >= 400 && (error as any).statusCode < 500
              ? (error as any).statusCode
              : 500,
          );
    if (e.status >= 500) store.audit(e.code);
    reply.code(e.status).send({ error: { code: e.code, correlationId: req.id } });
  });
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));
  app.get('/api/admin/status', async () => ({
    setupRequired: !store.db.prepare('SELECT name FROM admins LIMIT 1').get(),
  }));
  app.post('/api/admin/setup', async (req, reply) => {
    rate('setup:' + req.ip, 5);
    const b = requireValid(
      Type.Object(
        {
          username: text,
          password: Type.String({ minLength: 12, maxLength: 128 }),
          setupToken: text,
        },
        { additionalProperties: false },
      ),
      req.body,
    );
    if (
      !options.bootstrapToken ||
      digest(b.setupToken) !== digest(options.bootstrapToken) ||
      store.db.prepare('SELECT name FROM admins LIMIT 1').get()
    )
      throw new ApiError('FORBIDDEN', 403);
    store.db.prepare('INSERT INTO admins VALUES(?,?)').run(b.username, hashPassword(b.password));
    store.audit('ADMIN_CREATED');
    return login(reply);
  });
  app.post('/api/admin/login', async (req, reply) => {
    rate('login:' + req.ip, 10, 300000);
    const b = requireValid(
      Type.Object(
        { username: text, password: Type.String({ maxLength: 128 }) },
        { additionalProperties: false },
      ),
      req.body,
    );
    const user = store.db.prepare('SELECT password FROM admins WHERE name=?').get(b.username) as
      { password: string } | undefined;
    const valid = checkPassword(b.password, user?.password ?? hashPassword('nonexistent-user'));
    if (!user || !valid) throw new ApiError('UNAUTHORIZED', 401);
    return login(reply);
  });
  app.post('/api/admin/logout', async (req, reply) => {
    admins.delete(digest(req.cookies.rt_admin ?? ''));
    reply.clearCookie('rt_admin', { path: '/api/admin' });
    return { ok: true };
  });
  app.get('/api/admin/config', async () => store.config);
  function hardwareValid(h: { scanPattern: string }) {
    try {
      new RegExp(h.scanPattern);
      return !/\(\?[=!]|\(\?<|\\[1-9]/.test(h.scanPattern);
    } catch {
      return false;
    }
  }
  async function publish(body: unknown) {
    const c = requireValid(ConfigSchema, body);
    if (
      !c.languages.includes(c.defaultLanguage) ||
      (!c.preview && !c.printing) ||
      !hardwareValid(c.hardware)
    )
      throw new ApiError('VALIDATION_ERROR');
    if (c.version !== store.config.version) throw new ApiError('CONFLICT', 409);
    store.config = { ...c, version: c.version + 1 };
    store.audit('CONFIG_PUBLISHED');
    return store.config;
  }
  app.put('/api/admin/config', async (req) => publish(req.body));
  app.get('/api/admin/export', async () => store.config);
  app.post('/api/admin/import', async (req) =>
    publish({ ...requireValid(ConfigSchema, req.body), version: store.config.version }),
  );
  app.get('/api/admin/integration', async () => {
    const i = store.integration;
    return { url: i.url, ca: i.ca, timeoutMs: i.timeoutMs, keyConfigured: !!i.key };
  });
  app.put('/api/admin/integration', async (req) => {
    const b = requireValid(
      Type.Object(
        {
          url: text,
          key: Type.Optional(Type.String({ maxLength: 4096 })),
          ca: Type.String({ maxLength: 100000 }),
          timeoutMs: Type.Integer({ minimum: 1000, maximum: 120000 }),
        },
        { additionalProperties: false },
      ),
      req.body,
    );
    if (!validBaseUrl(b.url, dev)) throw new ApiError('VALIDATION_ERROR');
    if (b.ca) {
      try {
        new (await import('node:crypto')).X509Certificate(b.ca);
      } catch {
        throw new ApiError('VALIDATION_ERROR');
      }
    }
    const next: Integration = { ...b, key: b.key ?? store.integration.key };
    if (!next.key) throw new ApiError('VALIDATION_ERROR');
    // A different MIS must never inherit IDs from an active patient session.
    await Promise.all([...generations.keys()].map((id) => clearTerminal(id)));
    store.integration = next;
    store.audit('INTEGRATION_UPDATED');
    return { ok: true };
  });
  app.post('/api/admin/integration/check', async () =>
    mis().json('/capabilities', CapabilitiesSchema),
  );
  app.get('/api/admin/terminals', async () => store.terminals());
  app.get('/api/admin/audit', async () =>
    store.db.prepare('SELECT time,event,subject FROM audit ORDER BY id DESC LIMIT 100').all(),
  );
  app.post('/api/admin/enrollments', async (req) => {
    const b = requireValid(Type.Object({ name: text }, { additionalProperties: false }), req.body);
    const code = token(),
      expires = Date.now() + 600000;
    store.db.prepare('INSERT INTO enrollment VALUES(?,?,?)').run(digest(code), b.name, expires);
    store.audit('ENROLLMENT_CREATED');
    return { code, expiresAt: new Date(expires).toISOString() };
  });
  app.put<{ Params: { id: string } }>('/api/admin/terminals/:id/settings', async (req) => {
    const body = requireValid(
      Type.Object(
        { version: Type.Integer({ minimum: 1 }), hardware: HardwareSchema, timers: TimersSchema },
        { additionalProperties: false },
      ),
      req.body,
    );
    if (!hardwareValid(body.hardware)) throw new ApiError('VALIDATION_ERROR');
    if (!store.db.prepare('SELECT id FROM terminals WHERE id=?').get(req.params.id))
      throw new ApiError('NOT_FOUND', 404);
    const current = store.config;
    if (body.version !== current.version) throw new ApiError('CONFLICT', 409);
    store.db.exec('BEGIN');
    try {
      store.db
        .prepare('UPDATE terminals SET hardware=?,timers=? WHERE id=?')
        .run(JSON.stringify(body.hardware), JSON.stringify(body.timers), req.params.id);
      store.config = { ...current, version: current.version + 1 };
      store.audit('TERMINAL_SETTINGS_UPDATED', req.params.id);
      store.db.exec('COMMIT');
    } catch (e) {
      store.db.exec('ROLLBACK');
      throw e;
    }
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/admin/terminals/:id/revoke', async (req) => {
    store.db.prepare('UPDATE terminals SET revoked=1 WHERE id=?').run(req.params.id);
    await clearTerminal(req.params.id);
    store.audit('TERMINAL_REVOKED', req.params.id);
    return { ok: true };
  });
  app.post('/api/v1/enroll', async (req) => {
    rate('enroll:' + req.ip, 10);
    const b = requireValid(Type.Object({ code: text }, { additionalProperties: false }), req.body);
    const row = store.db
      .prepare('DELETE FROM enrollment WHERE code=? AND expires>? RETURNING name')
      .get(digest(b.code), Date.now()) as { name: string } | undefined;
    if (!row) throw new ApiError('UNAUTHORIZED', 401);
    const id = randomUUID(),
      value = token();
    store.db
      .prepare('INSERT INTO terminals(id,name,token,hardware) VALUES(?,?,?,?)')
      .run(id, row.name, digest(value), '{}');
    store.audit('TERMINAL_ENROLLED', id);
    return { terminalId: id, token: value };
  });
  app.get('/api/v1/config', async (req) => {
    const t = terminal(req),
      caps = await mis().json('/capabilities', CapabilitiesSchema);
    return effectiveConfig(
      store.config,
      JSON.parse(t.hardware),
      caps.methods,
      t.timers ? JSON.parse(t.timers) : {},
    );
  });
  app.post('/api/v1/heartbeat', async (req) => {
    const t = terminal(req),
      b = requireValid(
        Type.Object(
          {
            version: Type.String({ maxLength: 40 }),
            health: Type.Optional(HealthSchema),
            error: Type.Optional(
              Type.Union(
                ['NONE', 'NETWORK', 'SCANNER', 'PRINTER', 'CONFIG'].map((v) => Type.Literal(v)),
              ),
            ),
          },
          { additionalProperties: false },
        ),
        req.body,
      );
    store.db
      .prepare('UPDATE terminals SET last_seen=?,version=?,error=?,health=? WHERE id=?')
      .run(
        Date.now(),
        b.version,
        b.error ?? 'NONE',
        b.health ? JSON.stringify(b.health) : null,
        t.id,
      );
    return { ok: true };
  });
  app.post('/api/v1/reset', async (req) => {
    await clearTerminal(terminal(req).id);
    return { ok: true };
  });
  app.post('/api/v1/identifications', async (req) => {
    const t = terminal(req);
    rate('identify:' + t.id, 30);
    const b = requireValid(IdentificationSchema, req.body);
    const caps = await mis().json('/capabilities', CapabilitiesSchema);
    if (!store.config.methods.includes(b.method) || !caps.methods.includes(b.method))
      throw new ApiError('UNSUPPORTED_METHOD', 422);
    await clearTerminal(t.id);
    const generation = generations.get(t.id)!;
    const response = await mis().json(
      '/identifications',
      Type.Union([SessionSchema, ChallengeSchema]),
      'POST',
      b,
    );
    if ('sessionId' in response) return attach(t, response, generation);
    if (generations.get(t.id) !== generation) throw new ApiError('SESSION_EXPIRED', 410);
    const id = randomUUID();
    challenges.set(id, {
      terminal: t.id,
      upstream: response.challengeId,
      expires: Math.min(Date.parse(response.expiresAt), Date.now() + 120000),
      attempts: 0,
      generation,
    });
    return { ...response, challengeId: id };
  });
  app.post('/api/v1/identifications/confirm', async (req) => {
    const t = terminal(req);
    rate('confirm:' + t.id, 10);
    const b = requireValid(ConfirmationSchema, req.body),
      c = challenges.get(b.challengeId);
    if (!c || c.terminal !== t.id || c.expires <= Date.now() || ++c.attempts > 5)
      throw new ApiError('UNAUTHORIZED', 401);
    const response = await mis().json('/identifications/confirm', SessionSchema, 'POST', {
      ...b,
      challengeId: c.upstream,
    });
    challenges.delete(b.challengeId);
    return attach(t, response, c.generation);
  });
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/api/v1/sessions/:id/results',
    async (req) => {
      const s = owned(req, req.params.id);
      const cursor = req.query.cursor;
      if (cursor && cursor.length > 200) throw new ApiError('VALIDATION_ERROR');
      const result = await mis().json(
        upstreamPath(s.upstream) +
          '/results' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        ResultsSchema,
      );
      owned(req, req.params.id);
      return {
        ...result,
        items: result.items.map((r) => {
          let id = [...s.results].find(([, upstream]) => upstream === r.id)?.[0];
          if (!id) {
            id = randomUUID();
            if (r.status === 'ready' && r.pdfAvailable) s.results.set(id, r.id);
          }
          return { ...r, id };
        }),
      };
    },
  );
  app.get<{ Params: { id: string; resultId: string } }>(
    '/api/v1/sessions/:id/results/:resultId/pdf',
    async (req, reply) => {
      const s = owned(req, req.params.id);
      if (!s.results.has(req.params.resultId)) throw new ApiError('NOT_FOUND', 404);
      const r = await mis().call(
        upstreamPath(s.upstream) +
          '/results/' +
          encodeURIComponent(s.results.get(req.params.resultId)!) +
          '/pdf',
      );
      owned(req, req.params.id);
      if (!r.type.startsWith('application/pdf') || r.bytes.subarray(0, 5).toString() !== '%PDF-')
        throw new ApiError('INVALID_MIS_RESPONSE', 502);
      return reply
        .type('application/pdf')
        .header('Content-Disposition', 'inline; filename="result.pdf"')
        .send(r.bytes);
    },
  );
  app.delete<{ Params: { id: string } }>('/api/v1/sessions/:id', async (req, reply) => {
    const s = owned(req, req.params.id);
    sessions.delete(req.params.id);
    await closeUpstream(s);
    reply.code(204).send();
  });
  const staticRoot = resolve('apps/admin/dist');
  if (existsSync(staticRoot))
    await app.register(staticFiles, { root: staticRoot, prefix: '/admin/' });
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of admins) if (v <= now) admins.delete(k);
    for (const [k, v] of rates) if (v.expires <= now) rates.delete(k);
    for (const [k, v] of challenges) if (v.expires <= now) challenges.delete(k);
    for (const [k, v] of sessions)
      if (v.expires <= now) {
        sessions.delete(k);
        void closeUpstream(v);
      }
    store.db.prepare('DELETE FROM enrollment WHERE expires<?').run(now);
  }, 30000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    sessions.clear();
    challenges.clear();
    admins.clear();
    store.close();
  });
  return app;
}
