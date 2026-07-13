import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'

test('public approval-grant contract accepts bounded authority and rejects raw scope data', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/v8/approval-grant.schema.json', import.meta.url)))
  const fixture = JSON.parse(await readFile(new URL('../contracts/v8/approval-grant.json', import.meta.url)))
  const validate = new Ajv2020({ strict: false, formats: { 'date-time': true } }).compile(schema)
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...fixture, scope: 'whole_session' }), false)
  assert.equal(validate({ ...fixture, value: 'must-not-cross', label: 'private field' }), false)
  assert.equal(validate({ ...fixture, scope: 'session_operation', tool: '', operation: '' }), false)
})
