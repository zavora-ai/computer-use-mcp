import { createHash } from 'node:crypto'

export const AUDIT_EXPORT_SCHEMA_URI = 'computer://audit/schema'

/** Stable, disclosure-safe schema for paginated v8 event exports. */
export const AUDIT_EXPORT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: AUDIT_EXPORT_SCHEMA_URI,
  title: 'Computer Use v8 Audit Export',
  type: 'object',
  additionalProperties: false,
  required: ['schema_uri', 'schema_digest', 'events', 'next_sequence'],
  properties: {
    schema_uri: { const: AUDIT_EXPORT_SCHEMA_URI },
    schema_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    next_sequence: { type: 'integer', minimum: 0 },
    events: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'eventId', 'sequence', 'sessionId', 'type', 'at', 'payload'],
        properties: {
          schemaVersion: { const: 1 },
          eventId: { type: 'string', minLength: 1 },
          sequence: { type: 'integer', minimum: 1 },
          sessionId: { type: 'string', minLength: 1 },
          actionId: { type: 'string', minLength: 1 },
          type: { type: 'string', minLength: 1 },
          at: { type: 'string', format: 'date-time' },
          principalId: { type: 'string', minLength: 1 },
          payload: { type: 'object' },
          integrity: {
            type: 'object',
            additionalProperties: false,
            required: ['previousHash', 'hash'],
            properties: {
              previousHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
      },
    },
  },
} as const

export const AUDIT_EXPORT_SCHEMA_DIGEST = createHash('sha256')
  .update(JSON.stringify(AUDIT_EXPORT_SCHEMA))
  .digest('hex')
