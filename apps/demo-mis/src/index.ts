import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  ApiError,
  methods,
  requireValid,
  IdentificationSchema,
  ConfirmationSchema,
} from '@rt/contracts';
export const demoCredentials = {
  identifier: '0000000000000001',
  birthDate: '2000-01-01',
  name: 'Тестовый Пациент',
  accessCode: '246810',
  token: 'DEMO-ACCESS-0001',
  phone: '+79990000000',
  otp: '123456',
};
export async function createDemo(
  options: {
    key?: string;
    ttl?: number;
    scenario?: 'normal' | 'empty' | 'invalid' | 'unavailable';
    beforeIdentification?: () => Promise<void>;
  } = {},
) {
  const app = Fastify({ logger: false });
  const sessions = new Map<string, number>();
  const challenges = new Map<string, { expires: number; attempts: number }>();
  const session = () => {
    const sessionId = randomUUID(),
      expiresAt = new Date(Date.now() + (options.ttl ?? 300000)).toISOString();
    sessions.set(sessionId, Date.parse(expiresAt));
    return { sessionId, expiresAt, patient: { displayName: 'Тестовый пациент' } };
  };
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (req.headers.authorization !== `Bearer ${options.key ?? 'demo-only-key'}`)
      throw new ApiError('UNAUTHORIZED', 401);
    if (options.scenario === 'unavailable') throw new ApiError('MIS_UNAVAILABLE', 503);
  });
  app.setErrorHandler((e, req, reply) => {
    const err = e instanceof ApiError ? e : new ApiError('INTERNAL_ERROR', 500);
    reply.code(err.status).send({ error: { code: err.code, correlationId: req.id } });
  });
  app.get('/integration/v1/capabilities', async () => ({ apiVersion: '1', methods }));
  app.post('/integration/v1/identifications', async (req) => {
    const body = requireValid(IdentificationSchema, req.body);
    await options.beforeIdentification?.();
    if (body.method === 'phone-otp') {
      if (body.identifier !== demoCredentials.phone) throw new ApiError('UNAUTHORIZED', 401);
      const challengeId = randomUUID(),
        expires = Date.now() + 120000;
      challenges.set(challengeId, { expires, attempts: 0 });
      return { challengeId, expiresAt: new Date(expires).toISOString() };
    }
    const valid = ['barcode', 'qr'].includes(body.method)
      ? body.identifier === demoCredentials.token
      : body.method === 'oms-birth'
        ? body.identifier === demoCredentials.identifier &&
          'proof' in body &&
          body.proof === demoCredentials.birthDate
        : body.method === 'oms-name'
          ? body.identifier === demoCredentials.identifier &&
            'proof' in body &&
            body.proof === demoCredentials.name
          : body.identifier === '000001' &&
            'proof' in body &&
            body.proof === demoCredentials.accessCode;
    if (!valid) throw new ApiError('UNAUTHORIZED', 401);
    return session();
  });
  app.post('/integration/v1/identifications/confirm', async (req) => {
    const b = requireValid(ConfirmationSchema, req.body),
      c = challenges.get(b.challengeId);
    if (!c || c.expires < Date.now() || ++c.attempts > 5) throw new ApiError('UNAUTHORIZED', 401);
    if (b.code !== demoCredentials.otp) throw new ApiError('UNAUTHORIZED', 401);
    challenges.delete(b.challengeId);
    return session();
  });
  app.addHook('preHandler', async (req) => {
    const p = req.params as { sessionId?: string };
    if (p.sessionId && (sessions.get(p.sessionId) ?? 0) < Date.now())
      throw new ApiError('SESSION_EXPIRED', 410);
  });
  app.get<{ Params: { sessionId: string }; Querystring: { cursor?: string } }>(
    '/integration/v1/sessions/:sessionId/results',
    async (req) => {
      if (options.scenario === 'invalid') return { items: [{ id: 42 }], nextCursor: null };
      if (options.scenario === 'empty') return { items: [], nextCursor: null };
      if (req.query.cursor && req.query.cursor !== 'page-2') throw new ApiError('VALIDATION_ERROR');
      return {
        items: req.query.cursor
          ? [
              {
                id: 'pending',
                title: 'Заключение специалиста',
                date: '2026-10-24',
                category: 'Консультации',
                status: 'pending',
                pdfAvailable: false,
              },
            ]
          : [
              {
                id: 'blood',
                title: 'Клинический анализ крови с лейкоцитарной формулой',
                date: '2026-10-24',
                category: 'Лабораторные исследования',
                status: 'ready',
                pdfAvailable: true,
              },
              {
                id: 'biochemistry',
                title: 'Биохимический анализ крови',
                date: '2026-10-23',
                category: 'Лабораторные исследования',
                status: 'ready',
                pdfAvailable: true,
              },
            ],
        nextCursor: req.query.cursor ? null : 'page-2',
      };
    },
  );
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('ResultsTerminal / DEMONSTRATION', {
    x: 50,
    y: 780,
    size: 19,
    font,
    color: rgb(0.09, 0.42, 0.4),
  });
  page.drawText('Synthetic document. No medical data. Not for diagnosis.', {
    x: 50,
    y: 735,
    size: 11,
    font,
  });
  page.drawText('Patient: Demo Patient  /  2000-01-01', { x: 50, y: 695, size: 13, font });
  page.drawText('Result: Demonstration laboratory report', { x: 50, y: 650, size: 13, font });
  page.drawText('This PDF validates integration, preview and printing.', {
    x: 50,
    y: 605,
    size: 11,
    font,
  });
  const bytes = Buffer.from(await pdf.save());
  app.get<{ Params: { sessionId: string; resultId: string } }>(
    '/integration/v1/sessions/:sessionId/results/:resultId/pdf',
    async (req, reply) => {
      if (!['blood', 'biochemistry'].includes(req.params.resultId))
        throw new ApiError('NOT_FOUND', 404);
      return reply.type('application/pdf').send(bytes);
    },
  );
  app.delete<{ Params: { sessionId: string } }>(
    '/integration/v1/sessions/:sessionId',
    async (req, reply) => {
      sessions.delete(req.params.sessionId);
      reply.code(204).send();
    },
  );
  const timer = setInterval(() => {
    for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k);
    for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  }, 30000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  return app;
}
