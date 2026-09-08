import { createHash } from 'node:crypto'
import type { AuthInfo } from '@modelcontextprotocol/server'

/** Identity comes only from the embedding host's verified authentication result. */
export function principalKey(auth?: Pick<AuthInfo, 'clientId'> & Partial<AuthInfo>): string | undefined {
  if (!auth) return undefined
  const extra = auth.extra ?? {}
  const subject = extra.subject ?? extra.sub
  const claims = subject !== undefined
    ? [extra.issuer ?? extra.iss, extra.tenant ?? extra.tid, subject, auth.clientId]
    : [auth.clientId, auth.token ?? 'missing-token']
  return 'principal_' + createHash('sha256').update(JSON.stringify(claims)).digest('hex')
}
