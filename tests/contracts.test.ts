import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validate,
  IdentificationSchema,
  ConfigSchema,
  defaults,
  effectiveConfig,
} from '../packages/contracts/src/index.ts';
test('identity preserves zeros and requires second factor', () => {
  assert.equal(
    validate(IdentificationSchema, { method: 'order-code', identifier: '000017', proof: '246810' }),
    true,
  );
  assert.equal(
    validate(IdentificationSchema, { method: 'order-code', identifier: '000017' }),
    false,
  );
  assert.equal(
    validate(IdentificationSchema, { method: 'phone-otp', identifier: '+79990000000' }),
    true,
  );
  assert.equal(
    validate(IdentificationSchema, {
      method: 'oms-birth',
      identifier: '0012345678901234',
      proof: '2000-01-01',
    }),
    true,
  );
});
test('configuration bounds, methods intersection and inheritance', () => {
  assert.equal(validate(ConfigSchema, defaults), true);
  assert.equal(
    validate(ConfigSchema, {
      ...defaults,
      brand: { ...defaults.brand, primary: 'url(javascript:x)' },
    }),
    false,
  );
  const c = effectiveConfig(
    { ...defaults, methods: ['oms-birth', 'phone-otp'] },
    { printer: 'Office' },
    ['oms-birth'],
  );
  assert.deepEqual(c.methods, ['oms-birth']);
  assert.equal(c.hardware.printer, 'Office');
  assert.equal('mis' in c, false);
});

test('birth date is an actual ISO date', () =>
  assert.equal(
    validate(IdentificationSchema, {
      method: 'oms-birth',
      identifier: '0000000000000001',
      proof: '2026-02-31',
    }),
    false,
  ));
