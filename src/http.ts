#!/usr/bin/env node

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node'
import { createComputerUseHttpHandler } from './server.js'

const host = process.env.COMPUTER_USE_HTTP_HOST ?? '127.0.0.1'
const port = Number(process.env.COMPUTER_USE_HTTP_PORT ?? 3100)

if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
  throw new Error('The bundled HTTP runner is loopback-only. Embed createComputerUseHttpHandler with verified OAuth authInfo for remote serving.')
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('COMPUTER_USE_HTTP_PORT must be an integer from 1 to 65535')
}

export function startComputerUseHttpServer() {
  const handler = createComputerUseHttpHandler()
  const handleMcp = toNodeHandler(handler, {
    onerror: error => console.error('[computer-use-mcp:http]', error.message),
  })
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()
  const http = createServer((req, res) => {
    // Node does not await this callback, so a rejection would be unhandled and
    // terminate the process. Contain it and answer the request instead.
    void (async () => {
      try {
        if (req.url !== '/mcp') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('Not found')
          return
        }
        if (!validateHost(req, res) || !validateOrigin(req, res)) return
        await handleMcp(req, res)
      } catch (error) {
        console.error('[computer-use-mcp:http]', error instanceof Error ? error.message : String(error))
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        if (!res.writableEnded) res.end('Internal error')
      }
    })()
  })
  http.listen(port, host, () => {
    console.error(`[computer-use-mcp:http] Listening on http://${host}:${port}/mcp (MCP 2026-07-28 + stateless legacy)`)
  })
  const close = async () => {
    await handler.close()
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
  return { http, handler, close }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startComputerUseHttpServer()
}
