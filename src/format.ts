import type { FileRecord } from './domain.js'

export function shortNode(nodeId: string): string {
  if (nodeId.startsWith('did:key:')) return nodeId.length > 24 ? `${nodeId.slice(0, 14)}...${nodeId.slice(-6)}` : nodeId
  return nodeId.length > 12 ? `${nodeId.slice(0, 6)}...${nodeId.slice(-4)}` : nodeId
}

export function shortCid(cid: string): string {
  return cid.length > 18 ? `${cid.slice(0, 9)}...${cid.slice(-6)}` : cid
}

export function shortHash(hash: string): string {
  if (!hash || hash === 'seed') return hash || '-'
  return hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash
}

export function dateLabel(value: string | undefined): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function isTextLike(file: Pick<FileRecord, 'mimeType' | 'name'>): boolean {
  const name = file.name.toLowerCase()
  return (
    file.mimeType.startsWith('text/') ||
    file.mimeType === 'application/json' ||
    file.mimeType === 'application/xml' ||
    ['.md', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.ts', '.tsx'].some((suffix) =>
      name.endsWith(suffix),
    )
  )
}
