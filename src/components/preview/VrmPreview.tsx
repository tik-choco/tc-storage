import { ExternalLink } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { FileRecord } from '../../storage/domain.js'
import { familyAppUrl } from '../../util/familyApps.js'

export interface VrmPreviewProps {
  file: FileRecord
  dataUrl: string
  expanded?: boolean
}

type Status = 'loading' | 'ready' | 'error'

// Typed without a static import — three/@pixiv/three-vrm (and vrmScene.ts,
// which pulls them in) must only load via the dynamic import() below so they
// land in their own chunk instead of the main bundle.
type VrmSceneModule = typeof import('./vrmScene.js')
type ViewerTheme = 'light' | 'dark'
type ViewerScene = ReturnType<VrmSceneModule['createViewerScene']>
type Vrm = Awaited<ReturnType<VrmSceneModule['loadVrmFromBytes']>>
type VrmMeta = ReturnType<VrmSceneModule['vrmMetaSummary']>

function currentTheme(): ViewerTheme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function VrmPreview(props: VrmPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [meta, setMeta] = useState<VrmMeta | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    setStatus('loading')
    setMeta(null)

    const handles: {
      module?: VrmSceneModule
      viewer?: ViewerScene
      vrm?: Vrm
      stopLoop?: () => void
      themeObserver?: MutationObserver
    } = {}

    // The preview modal has wheel/touch navigation handlers on an ancestor
    // (swipe/scroll between files) — keep orbit/zoom/pan gestures local.
    const stopPropagation = (event: Event) => event.stopPropagation()
    container.addEventListener('wheel', stopPropagation, { passive: true })
    container.addEventListener('touchstart', stopPropagation, { passive: true })
    container.addEventListener('touchmove', stopPropagation, { passive: true })
    container.addEventListener('mousedown', stopPropagation)

    void (async () => {
      try {
        const sceneModule = await import('./vrmScene.js')
        if (cancelled) return
        handles.module = sceneModule

        const response = await fetch(props.dataUrl)
        const arrayBuffer = await response.arrayBuffer()
        if (cancelled) return
        const bytes = new Uint8Array(arrayBuffer)

        const viewer = sceneModule.createViewerScene(container)
        handles.viewer = viewer
        viewer.applyTheme(currentTheme())

        const themeObserver = new MutationObserver(() => viewer.applyTheme(currentTheme()))
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        handles.themeObserver = themeObserver

        const vrm = await sceneModule.loadVrmFromBytes(bytes)
        if (cancelled) {
          sceneModule.disposeVrm(vrm)
          return
        }
        handles.vrm = vrm

        sceneModule.replaceVrmInScene(viewer.scene, undefined, vrm)
        const summary = sceneModule.vrmMetaSummary(vrm)

        handles.stopLoop = sceneModule.startRenderLoop(viewer, (delta) => {
          vrm.update(delta)
        })

        setMeta(summary)
        setStatus('ready')
      } catch (error) {
        console.error('Failed to load VRM model', error)
        if (!cancelled) setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      container.removeEventListener('wheel', stopPropagation)
      container.removeEventListener('touchstart', stopPropagation)
      container.removeEventListener('touchmove', stopPropagation)
      container.removeEventListener('mousedown', stopPropagation)
      handles.themeObserver?.disconnect()
      handles.stopLoop?.()
      if (handles.vrm && handles.module) handles.module.disposeVrm(handles.vrm)
      handles.viewer?.dispose()
    }
  }, [props.dataUrl])

  return (
    <div class="vrm-preview">
      <div class="vrm-preview-canvas" ref={containerRef} />
      <a class="vrm-preview-app-link" href={familyAppUrl('tc-vrm-viewer')} target="_blank" rel="noopener noreferrer" title="tc-vrm-viewer アプリを開く">
        <ExternalLink size={15} />
      </a>
      {status === 'loading' ? <div class="vrm-preview-status vrm-preview-loading">読み込み中…</div> : null}
      {status === 'error' ? <div class="vrm-preview-status vrm-preview-error">VRMを読み込めませんでした</div> : null}
      {status === 'ready' && meta && (meta.name || meta.authors.length > 0) ? (
        <div class="vrm-preview-meta">
          {meta.name ? <strong>{meta.name}</strong> : null}
          {meta.authors.length > 0 ? <span>{meta.authors.join(', ')}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
