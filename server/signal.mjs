/**
 * T24 — signaling server (I.net). WebRTC handshake relay only: rooms by
 * join code, SDP/ICE forwarding. No game logic, stateless beyond room
 * membership. Run: `npm run signal` (PORT env overrides, default 8787).
 */
import { WebSocketServer } from 'ws'
import { RoomManager } from './rooms.mjs'

const port = Number(process.env.PORT ?? 8787)
const wss = new WebSocketServer({ port })
const manager = new RoomManager()
const sockets = new Map()
let nextClientId = 1

function deliver(outbound) {
  for (const { to, msg } of outbound) {
    const ws = sockets.get(to)
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
}

wss.on('connection', (ws) => {
  const id = nextClientId++
  sockets.set(id, ws)
  deliver(manager.connect(id))

  ws.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      ws.send(JSON.stringify({ t: 'error', message: 'invalid JSON' }))
      return
    }
    deliver(manager.handleMessage(id, msg))
  })

  ws.on('close', () => {
    sockets.delete(id)
    deliver(manager.disconnect(id))
  })

  ws.on('error', () => {
    /* close handler does the cleanup */
  })
})

console.log(`[signal] listening on ws://localhost:${port}`)
