import type { StorageEscrowTransport } from './mistTransport'
import { encodeEscrowMessage, parseEscrowMessage } from './protocol'
import type { EscrowMessage } from './protocol'
import { headHash } from './head'
import type { EscrowHead } from './head'
import { sha256 } from './crypto'

/** In-memory mistl protocol double; durable data is scoped to each provider. */
export class EscrowTestServer {
  heads = new Map<string, Map<string, EscrowHead>>()
  blobs = new Map<string, Uint8Array>()
  providers = new Set(['provider-a'])
  putLog: {
    provider: string
    head: EscrowHead
  }[] = []
  pinned: (string | undefined)[] = []
  failPack = false
  dropRootAck = false
  loseProviderOnPack = false
  conflictOnce?: (head: EscrowHead) => Promise<EscrowHead>
  beforePut?: (head: EscrowHead) => Promise<void>
  private listeners = new Set<(id: string, joined: boolean) => void>()
  private puts: Promise<unknown> = Promise.resolve()
  arrive(id: string) {
    this.providers.add(id)
    for (const cb of this.listeners) cb(id, true)
  }
  depart(id: string) {
    this.providers.delete(id)
    for (const cb of this.listeners) cb(id, false)
  }
  transport(provider?: string): StorageEscrowTransport {
    this.pinned.push(provider)
    let lost = false
    const msgs = new Map<string, Set<(id: string, bytes: Uint8Array) => void>>()
    const peers = new Map<string, Set<(id: string, joined: boolean) => void>>()
    const live = new Set<string>()
    const relay = (id: string, joined: boolean) => {
      if (provider && id !== provider) return
      if (!joined && provider) lost = true
      for (const room of live) for (const cb of peers.get(room) ?? []) cb(id, joined)
    }
    const check = () => {
      if (lost) throw new Error('Escrow provider disconnected')
    }
    const deliver = (room: string, id: string, m: EscrowMessage) => {
      if (live.has(room)) for (const cb of msgs.get(room) ?? []) cb(id, encodeEscrowMessage(m))
    }
    const thisServer = this
    return {
      assertProvider: check,
      async releasePins() {},
      async join(room) {
        live.add(room)
        thisServer.listeners.add(relay)
        for (const id of thisServer.providers) relay(id, true)
      },
      leave(room) {
        live.delete(room)
        if (!live.size) thisServer.listeners.delete(relay)
      },
      onMessage(room, cb) {
        let s = msgs.get(room)
        if (!s) {
          s = new Set()
          msgs.set(room, s)
        }
        s.add(cb)
        return () => s.delete(cb)
      },
      onPeer(room, cb) {
        let s = peers.get(room)
        if (!s) {
          s = new Set()
          peers.set(room, s)
        }
        s.add(cb)
        return () => s.delete(cb)
      },
      send(room, to, bytes) {
        check()
        const message = parseEscrowMessage(bytes)
        if (!message) return
        for (const id of thisServer.providers) {
          if ((provider && id !== provider) || (to && id !== to)) continue
          const action = async () => {
            let heads = thisServer.heads.get(id)
            if (!heads) {
              heads = new Map()
              thisServer.heads.set(id, heads)
            }
            if (message.type === 'escrow_hello')
              deliver(room, id, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 32 * 1024 * 1024 })
            else if (message.type === 'escrow_get')
              deliver(room, id, {
                v: 1,
                type: 'escrow_head',
                id: message.id,
                slot: message.slot,
                head: heads.get(message.slot) ?? null,
              })
            else if (message.type === 'escrow_put') {
              const head = message.head
              thisServer.putLog.push({ provider: id, head })
              await thisServer.beforePut?.(head)
              if (thisServer.loseProviderOnPack && head.schema === 'tc-storage/content-pack/1') {
                thisServer.depart(id)
                return
              }
              if (thisServer.failPack && head.schema === 'tc-storage/content-pack/1') {
                deliver(room, id, { v: 1, type: 'escrow_error', id: message.id, code: 'quota', message: 'quota' })
                return
              }
              if (thisServer.conflictOnce && head.schema === 'tc-storage/folder-checkpoint/1') {
                const fn = thisServer.conflictOnce
                thisServer.conflictOnce = undefined
                const other = await fn(head)
                heads.set(head.slot, other)
              }
              const current = heads.get(head.slot)
              const hash = await headHash(head)
              if (
                current &&
                (await headHash(current)) !== hash &&
                (head.seq !== current.seq + 1 || head.parent !== (await headHash(current)))
              ) {
                deliver(room, id, {
                  v: 1,
                  type: 'escrow_error',
                  id: message.id,
                  code: 'conflict',
                  message: 'conflict',
                  head: current,
                })
                return
              }
              heads.set(head.slot, head)
              if (thisServer.dropRootAck && head.schema === 'tc-storage/folder-checkpoint/1') return
              deliver(room, id, { v: 1, type: 'escrow_ack', id: message.id, slot: head.slot, seq: head.seq, hash })
            }
          }
          if (message.type === 'escrow_put')
            thisServer.puts = thisServer.puts.then(action).catch((error) => {
              throw error
            })
          else void action()
        }
      },
      async storageAdd(name, bytes) {
        check()
        if (name !== 'tc-escrow.bin') throw new Error('Invalid blob name')
        const cid = await sha256(bytes)
        thisServer.blobs.set(cid, new Uint8Array(bytes))
        return cid
      },
      async storageGet(cid) {
        check()
        const b = thisServer.blobs.get(cid)
        if (!b) throw new Error('Block not found')
        return b
      },
    }
  }
}
