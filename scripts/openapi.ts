import { mkdirSync, writeFileSync } from 'node:fs';
import {
  ConfigSchema,
  EffectiveConfigSchema,
  defaults,
  themes,
  IdentificationSchema,
  ConfirmationSchema,
  SessionSchema,
  ChallengeSchema,
  ResultsSchema,
  CapabilitiesSchema,
  HealthSchema,
  HardwareSchema,
  Type,
} from '../packages/contracts/src/index.ts';
mkdirSync('docs/openapi', { recursive: true });
const error = {
  description: 'Structured error; code and correlationId, no internal details',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'correlationId'],
            properties: { code: { type: 'string' }, correlationId: { type: 'string' } },
          },
        },
        required: ['error'],
      },
    },
  },
};
const schemas = {
  Identification: IdentificationSchema,
  Confirmation: ConfirmationSchema,
  Session: SessionSchema,
  Challenge: ChallengeSchema,
  Results: ResultsSchema,
  Capabilities: CapabilitiesSchema,
  Configuration: EffectiveConfigSchema,
  Health: HealthSchema,
  Hardware: HardwareSchema,
};
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
function operation(summary: string, body?: object, response: object = { type: 'object' }) {
  return {
    summary,
    security: [{ BearerAuth: [] }],
    ...(body
      ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
      : {}),
    responses: {
      200: { description: 'Success', content: { 'application/json': { schema: response } } },
      400: error,
      401: error,
      403: error,
      404: error,
      409: error,
      410: error,
      422: error,
      429: error,
      502: error,
      503: error,
    },
  };
}
for (const kind of ['integration', 'terminal']) {
  const prefix = kind === 'integration' ? '/integration/v1' : '/api/v1';
  const sessionPath = prefix + '/sessions/{sessionId}';
  const params = [{ name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } }];
  const paths: any = {};
  if (kind === 'integration')
    paths[prefix + '/capabilities'] = {
      get: operation('Declared identification methods', undefined, ref('Capabilities')),
    };
  else {
    paths[prefix + '/config'] = {
      get: operation(
        'Effective published configuration, supported methods only',
        undefined,
        ref('Configuration'),
      ),
    };
    paths[prefix + '/enroll'] = {
      post: {
        ...operation(
          'Redeem a one-time enrollment code',
          Type.Object({ code: Type.String() }),
          Type.Object({ terminalId: Type.String(), token: Type.String() }),
        ),
        security: [],
      },
    };
    paths[prefix + '/heartbeat'] = {
      post: operation(
        'Device health, no patient data',
        Type.Object({
          version: Type.String(),
          error: Type.Optional(Type.String()),
          health: Type.Optional(HealthSchema),
        }),
      ),
    };
    paths[prefix + '/reset'] = {
      post: operation(
        'Close all sessions and pending challenges for this terminal',
        Type.Object({}),
      ),
    };
  }
  paths[prefix + '/identifications'] = {
    post: operation('Identify a patient or start an OTP challenge', ref('Identification'), {
      oneOf: [ref('Session'), ref('Challenge')],
    }),
  };
  paths[prefix + '/identifications/confirm'] = {
    post: operation('Confirm the OTP challenge', ref('Confirmation'), ref('Session')),
  };
  paths[sessionPath] = {
    parameters: params,
    delete: {
      ...operation('End session'),
      responses: { 204: { description: 'Ended' }, 401: error, 410: error },
    },
  };
  paths[sessionPath + '/results'] = {
    parameters: params,
    get: {
      ...operation('List results', undefined, ref('Results')),
      parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 200 } }],
    },
  };
  paths[sessionPath + '/results/{resultId}/pdf'] = {
    parameters: [
      ...params,
      { name: 'resultId', in: 'path', required: true, schema: { type: 'string' } },
    ],
    get: {
      ...operation('PDF bytes, maximum 25 MiB'),
      responses: {
        200: {
          description: 'PDF, never a filesystem path or redirect',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        401: error,
        404: error,
        410: error,
        502: error,
        503: error,
      },
    },
  };
  writeFileSync(
    `docs/openapi/${kind}.json`,
    JSON.stringify(
      {
        openapi: '3.1.0',
        info: { title: `ResultsTerminal ${kind} API`, version: '1.0.0' },
        servers: [{ url: 'https://gateway.example.invalid' }],
        paths,
        components: {
          securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
          schemas,
        },
      },
      null,
      2,
    ) + '\n',
  );
}
console.log('Generated integration and terminal OpenAPI 3.1 contracts.');

mkdirSync('examples', { recursive: true });
for (const [name, brand] of Object.entries(themes))
  writeFileSync(
    `examples/${name}-config.json`,
    JSON.stringify({ ...defaults, brand }, null, 2) + '\n',
  );
