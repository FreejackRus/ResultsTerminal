export { Type } from '@sinclair/typebox';
export type { Static, TSchema } from '@sinclair/typebox';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
export function validate<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return !!ajv.validate(schema, value);
}
const text = (max = 200) => Type.String({ minLength: 1, maxLength: max });
const color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
export const methods = [
  'oms-birth',
  'oms-name',
  'barcode',
  'qr',
  'order-code',
  'contract-code',
  'patient-code',
  'phone-otp',
] as const;
export type Method = (typeof methods)[number];
export const MethodSchema = Type.Union(methods.map((m) => Type.Literal(m)));
export const IdentificationSchema = Type.Union(
  methods.map((method) =>
    Type.Object(
      {
        method: Type.Literal(method),
        identifier: text(256),
        ...(['barcode', 'qr', 'phone-otp'].includes(method)
          ? {}
          : { proof: method === 'oms-birth' ? Type.String({ format: 'date' }) : text(200) }),
      },
      { additionalProperties: false },
    ),
  ),
);
export type Identification = Static<typeof IdentificationSchema>;
export const HardwareSchema = Type.Object(
  {
    printer: Type.String({ maxLength: 200 }),
    hidDeviceId: Type.Optional(Type.String({ maxLength: 300 })),
    pdfHelper: Type.Optional(Type.String({ maxLength: 500 })),
    scannerMode: Type.Union([Type.Literal('hid'), Type.Literal('serial')]),
    serialPort: Type.String({ maxLength: 200 }),
    baudRate: Type.Integer({ minimum: 1200, maximum: 115200 }),
    scanPattern: Type.String({ maxLength: 120 }),
  },
  { additionalProperties: false },
);
export type Hardware = Static<typeof HardwareSchema>;
export const TimersSchema = Type.Object(
  {
    idleSeconds: Type.Integer({ minimum: 15, maximum: 600 }),
    warningSeconds: Type.Integer({ minimum: 15, maximum: 300 }),
    successSeconds: Type.Integer({ minimum: 5, maximum: 120 }),
  },
  { additionalProperties: false },
);
export const ConfigSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    brand: Type.Object(
      {
        name: text(120),
        primary: color,
        background: color,
        logo: Type.String({
          maxLength: 500000,
          pattern: '^(|data:image/(png|webp);base64,[A-Za-z0-9+/=]+)$',
        }),
        contacts: Type.String({ maxLength: 300 }),
        help: Type.String({ maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
    languages: Type.Array(
      Type.Union([Type.Literal('ru'), Type.Literal('en'), Type.Literal('zh')]),
      { minItems: 1, uniqueItems: true },
    ),
    defaultLanguage: Type.Union([Type.Literal('ru'), Type.Literal('en'), Type.Literal('zh')]),
    highContrast: Type.Boolean(),
    preview: Type.Boolean(),
    printing: Type.Boolean(),
    methods: Type.Array(MethodSchema, { minItems: 1, uniqueItems: true }),
    timers: TimersSchema,
    hardware: HardwareSchema,
  },
  { additionalProperties: false },
);
export type Config = Static<typeof ConfigSchema>;
export const defaults: Config = {
  version: 1,
  brand: {
    name: 'ResultsTerminal',
    primary: '#176B68',
    background: '#F2F6F5',
    logo: '',
    contacts: '',
    help: 'Обратитесь к сотруднику учреждения, если вам нужна помощь.',
  },
  languages: ['ru', 'en', 'zh'],
  defaultLanguage: 'ru',
  highContrast: false,
  preview: true,
  printing: true,
  methods: ['oms-birth', 'barcode', 'qr', 'order-code'],
  timers: { idleSeconds: 45, warningSeconds: 45, successSeconds: 15 },
  hardware: {
    printer: '',
    scannerMode: 'hid',
    serialPort: '',
    baudRate: 9600,
    scanPattern: '^[A-Za-z0-9_-]{4,128}$',
  },
};
export function effectiveConfig(
  config: Config,
  hardware: Partial<Hardware>,
  supported: string[],
  timers: Partial<Config['timers']> = {},
): Config {
  return {
    ...config,
    methods: config.methods.filter((m) => supported.includes(m)),
    hardware: { ...config.hardware, ...hardware },
    timers: { ...config.timers, ...timers },
  };
}
export const ResultSchema = Type.Object(
  {
    id: text(128),
    title: text(500),
    date: Type.String({ format: 'date' }),
    category: text(100),
    status: Type.Union([Type.Literal('ready'), Type.Literal('pending')]),
    pdfAvailable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type MedicalResult = Static<typeof ResultSchema>;
export const ResultsSchema = Type.Object(
  {
    items: Type.Array(ResultSchema, { maxItems: 100 }),
    nextCursor: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Results = Static<typeof ResultsSchema>;
export const CapabilitiesSchema = Type.Object(
  { apiVersion: Type.Literal('1'), methods: Type.Array(MethodSchema, { uniqueItems: true }) },
  { additionalProperties: false },
);
export const SessionSchema = Type.Object(
  {
    sessionId: text(256),
    expiresAt: Type.String({ format: 'date-time' }),
    patient: Type.Object({ displayName: text(120) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export type Session = Static<typeof SessionSchema>;
export const ChallengeSchema = Type.Object(
  { challengeId: text(256), expiresAt: Type.String({ format: 'date-time' }) },
  { additionalProperties: false },
);
export const ConfirmationSchema = Type.Object(
  { challengeId: text(256), code: Type.String({ pattern: '^[0-9]{4,8}$' }) },
  { additionalProperties: false },
);
export const errorCodes = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'SESSION_EXPIRED',
  'NO_RESULTS',
  'UNSUPPORTED_METHOD',
  'MIS_UNAVAILABLE',
  'INVALID_MIS_RESPONSE',
  'RATE_LIMITED',
  'CONFLICT',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
export class ApiError extends Error {
  constructor(
    public code: (typeof errorCodes)[number],
    public status = 400,
  ) {
    super(code);
  }
}
export function requireValid<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!validate(schema, value)) throw new ApiError('VALIDATION_ERROR');
  return value;
}
export const themes = {
  neutral: defaults.brand,
  clinic: {
    name: 'Клиника «Север»',
    primary: '#245B94',
    background: '#F1F5FA',
    logo: '',
    contacts: '+7 (000) 000-00-01',
    help: 'Помощь с получением результатов — на стойке администратора.',
  },
  center: {
    name: 'Медицинский центр «Линия»',
    primary: '#6B5733',
    background: '#F8F5EE',
    logo: '',
    contacts: '+7 (000) 000-00-02',
    help: 'Нужна помощь? Обратитесь в регистратуру.',
  },
};

export const DeviceStateSchema = Type.Union(
  ['ready', 'busy', 'error', 'disconnected', 'unknown'].map((v) => Type.Literal(v)),
);
export const HealthSchema = Type.Object(
  {
    checkedAt: Type.String({ format: 'date-time' }),
    os: Type.String({ maxLength: 60 }),
    uptimeSeconds: Type.Integer({ minimum: 0 }),
    cpuPercent: Type.Number({ minimum: 0, maximum: 100 }),
    memoryTotalMb: Type.Number({ minimum: 0 }),
    memoryUsedMb: Type.Number({ minimum: 0 }),
    diskFreeGb: Type.Number({ minimum: 0 }),
    scanner: Type.Object(
      {
        state: DeviceStateSchema,
        code: Type.Union(
          ['OK', 'PORT_UNAVAILABLE', 'NOT_CONFIGURED', 'HID_UNVERIFIED', 'HID_NOT_FOUND'].map((v) =>
            Type.Literal(v),
          ),
        ),
      },
      { additionalProperties: false },
    ),
    printer: Type.Object(
      {
        state: DeviceStateSchema,
        code: Type.Union(
          [
            'OK',
            'NOT_CONFIGURED',
            'OFFLINE',
            'PAPER_OR_TONER',
            'QUEUE_ERROR',
            'DRIVER_UNAVAILABLE',
            'CHECK_FAILED',
          ].map((v) => Type.Literal(v)),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Health = Static<typeof HealthSchema>;

export const EffectiveConfigSchema = Type.Object(
  { ...ConfigSchema.properties, methods: Type.Array(MethodSchema, { uniqueItems: true }) },
  { additionalProperties: false },
);
