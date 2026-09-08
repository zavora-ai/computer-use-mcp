import { randomUUID } from 'node:crypto'
const issued = new Map<string, { expiresAt: number; consumed: boolean }>()
function purge() { for (const [id, record] of issued) if (record.expiresAt <= Date.now()) issued.delete(id) }
/** Issued-state allowlist means a restart rejects old approvals even with a persistent signing key. */
export function issueApproval(): string {
  purge()
  if (issued.size >= 4096) throw new Error('Outstanding approval limit reached')
  const id = randomUUID()
  issued.set(id, { expiresAt: Date.now() + 600000, consumed: false })
  return id
}
export function useApproval(id: string | undefined, preflight: boolean): boolean {
  purge()
  const record = id ? issued.get(id) : undefined
  if (!record || record.consumed) return false
  if (!preflight) record.consumed = true
  return true
}
