import { useState } from 'preact/hooks'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  HardDrive,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  X,
} from 'lucide-preact'

// First-run wizard shown as a modal overlay: welcome -> profile -> data
// storage notice -> feature tour. Every step is skippable, and closing at
// any point counts as "done" — the caller owns the completion flag via
// `onClose`, so the settings screen can re-open this wizard any time.

const STEP_COUNT = 4

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement).value
}

export function Onboarding(props: { initialProfileName: string; onSaveProfileName: (name: string) => void; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [profileName, setProfileName] = useState(props.initialProfileName)

  function handleSaveProfileName() {
    const trimmed = profileName.trim()
    if (trimmed) props.onSaveProfileName(trimmed)
    setStep(2)
  }

  return (
    <div class="ob-overlay">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label="はじめてのセットアップ">
        <button class="ob-close" type="button" onClick={props.onClose} title="閉じる" aria-label="閉じる">
          <X size={18} />
        </button>

        {step === 0 && (
          <div class="ob-body">
            <div class="ob-hero">
              <HardDrive size={36} />
            </div>
            <h2 class="ob-title">tc-storage へようこそ</h2>
            <p class="ob-text">
              tc-storage は、ローカルファーストな P2P ドライブです。ファイルはサーバーには保存されず、このブラウザの中に保存されます。
            </p>
            <p class="ob-text">共有相手とは暗号化された状態で直接同期されるので、あなたのファイルは常にあなたの手元にあります。</p>
          </div>
        )}

        {step === 1 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <UserRound size={22} />
              <h2 class="ob-title">プロフィールを設定</h2>
            </div>
            <p class="ob-text">表示名は、ファイルやフォルダを共有した相手にあなたを示すために使われます。</p>
            <div class="ob-field">
              <label class="ob-label">表示名</label>
              <input
                class="ob-input"
                type="text"
                placeholder="例: たろう"
                value={profileName}
                onInput={(e) => setProfileName(inputValue(e))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveProfileName()
                }}
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <ShieldCheck size={22} />
              <h2 class="ob-title">データはこのブラウザに保存されます</h2>
            </div>
            <div class="ob-callout ob-callout-warn">
              <AlertTriangle size={18} />
              <span>
                ファイルはこのブラウザの localStorage に保存されます。サイトデータを削除すると失われるので、大切なファイルはダウンロードしてバックアップを取っておいてください。
              </span>
            </div>
            <p class="ob-text">共有リンクや QR コードには復号鍵が含まれています。渡す相手には十分注意してください。</p>
          </div>
        )}

        {step === 3 && (
          <div class="ob-body">
            <div class="ob-step-head">
              <Sparkles size={22} />
              <h2 class="ob-title">準備完了！</h2>
            </div>
            <ul class="ob-feature-list">
              <li>
                <span class="ob-feature-icon">
                  <Upload size={16} />
                </span>
                <div>
                  <strong>アップロードとフォルダ整理</strong>
                  <span>ドラッグ&ドロップでファイルを取り込み、フォルダで整理できます</span>
                </div>
              </li>
              <li>
                <span class="ob-feature-icon">
                  <QrCode size={16} />
                </span>
                <div>
                  <strong>共有リンクと QR コード</strong>
                  <span>ファイルやフォルダを暗号化されたリンクで共有できます</span>
                </div>
              </li>
              <li>
                <span class="ob-feature-icon">
                  <RefreshCw size={16} />
                </span>
                <div>
                  <strong>P2P フォルダ同期</strong>
                  <span>接続中のピアとフォルダを自動的に同期します</span>
                </div>
              </li>
              <li>
                <span class="ob-feature-icon">
                  <ShieldCheck size={16} />
                </span>
                <div>
                  <strong>DID アイデンティティ</strong>
                  <span>Ed25519 による自己認証型の ID であなたを証明します</span>
                </div>
              </li>
            </ul>
            <p class="ob-text ob-text-subtle">それでは、tc-storage をお楽しみください！</p>
          </div>
        )}

        <footer class="ob-footer">
          <div class="ob-dots" aria-hidden="true">
            {Array.from({ length: STEP_COUNT }, (_, i) => (
              <span key={i} class={'ob-dot' + (i === step ? ' is-active' : '')} />
            ))}
          </div>
          <div class="ob-footer-actions">
            {step > 0 && step < 3 && (
              <button class="ob-btn" type="button" onClick={() => setStep(step - 1)}>
                <ArrowLeft size={16} />
                戻る
              </button>
            )}
            {step === 0 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(1)}>
                はじめる
                <ArrowRight size={16} />
              </button>
            )}
            {step === 1 && (
              <>
                <button class="ob-btn ob-btn-ghost" type="button" onClick={() => setStep(2)}>
                  あとで設定する
                </button>
                <button class="ob-btn ob-btn-accent" type="button" onClick={handleSaveProfileName}>
                  保存して次へ
                  <ArrowRight size={16} />
                </button>
              </>
            )}
            {step === 2 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={() => setStep(3)}>
                次へ
                <ArrowRight size={16} />
              </button>
            )}
            {step === 3 && (
              <button class="ob-btn ob-btn-accent" type="button" onClick={props.onClose}>
                <Check size={16} />
                完了
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
