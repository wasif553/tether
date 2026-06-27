import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.DATABASE_URL ?? ''
  const portMatch = url.match(/:(\d+)\//)
  const port = portMatch ? portMatch[1] : 'not found'
  const host = url.match(/@([^:]+):/)?.[1] ?? 'not found'
  return NextResponse.json({
    port,
    host,
    mode: port === '6543' ? 'transaction (correct)' : port === '5432' ? 'session (wrong)' : 'unknown'
  })
}
