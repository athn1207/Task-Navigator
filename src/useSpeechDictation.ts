import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react'

/** Web Speech API（Chrome / Safari webkit）。DOM lib に無い場合の最小定義 */
interface SpeechGrammarList {
  readonly length: number
  addFromString: (string: string, weight?: number) => void
  item: (index: number) => SpeechGrammar
}

interface SpeechGrammar {
  src: string
  weight: number
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResult {
  readonly length: number
  item: (index: number) => SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionResultList {
  readonly length: number
  item: (index: number) => SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface SpeechRecognition extends EventTarget {
  grammars: SpeechGrammarList
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
  onnomatch: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null
  onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  abort: () => void
  start: () => void
  stop: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return typeof window !== 'undefined' && getSpeechRecognitionCtor() !== null
}

const HOLD_MS = 280

type SetText = (updater: string | ((prev: string) => string)) => void

function mergeRecognitionText(base: string, finalSoFar: string, interim: string): string {
  return [base.trimEnd(), finalSoFar.trim(), interim.trim()].filter(Boolean).join(' ')
}

/**
 * フッター入力向け音声入力。
 * - 短いタップ: 聞き取り開始 ↔ 終了のトグル
 * - 約 280ms 以上押し続けたあと離す: 押している間だけ聞き取り（離すと終了）
 */
export function useSpeechDictation(
  inputValue: string,
  setInputValue: SetText,
  disabled: boolean,
  /** 音声の onresult は setState より先に走ることがあるため、送信時はここを同期して最新文字列を保つ */
  draftSyncRef?: MutableRefObject<string>,
) {
  const [isListening, setIsListening] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const listeningRef = useRef(false)
  const inputValueRef = useRef(inputValue)
  const baseTextRef = useRef('')
  const finalBufferRef = useRef('')
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdingSessionRef = useRef(false)
  const tapStopArmRef = useRef(false)

  useEffect(() => {
    inputValueRef.current = inputValue
  }, [inputValue])

  /** onresult / 終了時に ref と React state を同時更新 */
  const commitRecognizedText = useCallback(
    (merged: string) => {
      if (draftSyncRef) draftSyncRef.current = merged
      setInputValue(merged)
    },
    [draftSyncRef, setInputValue],
  )

  const flushPendingRecognition = useCallback(() => {
    const merged = mergeRecognitionText(baseTextRef.current, finalBufferRef.current, '')
    if (merged.trim()) commitRecognizedText(merged)
  }, [commitRecognizedText])

  const stopInternal = useCallback(() => {
    flushPendingRecognition()
    listeningRef.current = false
    setIsListening(false)
    const r = recognitionRef.current
    if (r) {
      try {
        r.onresult = null
        r.onerror = null
        r.onend = null
        r.stop()
      } catch {
        /* noop */
      }
    }
    recognitionRef.current = null
    baseTextRef.current = ''
    finalBufferRef.current = ''
  }, [flushPendingRecognition])

  const startInternal = useCallback(() => {
    if (disabled) return
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      setSpeechError('このブラウザでは音声入力を利用できません')
      return
    }
    setSpeechError(null)
    try {
      const r = new Ctor()
      r.lang = 'ja-JP'
      r.continuous = true
      r.interimResults = true
      r.maxAlternatives = 1

      baseTextRef.current = draftSyncRef?.current ?? inputValueRef.current
      finalBufferRef.current = ''

      r.onresult = (event: SpeechRecognitionEvent) => {
        let interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i]
          const piece = res[0]?.transcript ?? ''
          if (res.isFinal) finalBufferRef.current += piece
          else interim += piece
        }
        const merged = mergeRecognitionText(baseTextRef.current, finalBufferRef.current, interim)
        commitRecognizedText(merged)
      }

      r.onerror = (ev: SpeechRecognitionErrorEvent) => {
        const code = ev.error ?? 'unknown'
        if (code === 'aborted' || code === 'no-speech') {
          stopInternal()
          return
        }
        const msg =
          code === 'not-allowed'
            ? 'マイクの使用が許可されていません。ブラウザの設定を確認してください。'
            : code === 'audio-capture'
              ? 'マイクを取得できませんでした。'
              : `音声認識エラー: ${code}`
        setSpeechError(msg)
        stopInternal()
      }

      r.onend = () => {
        flushPendingRecognition()
        recognitionRef.current = null
        if (listeningRef.current) {
          listeningRef.current = false
          setIsListening(false)
        }
      }

      recognitionRef.current = r
      listeningRef.current = true
      setIsListening(true)
      r.start()
    } catch {
      setSpeechError('音声入力を開始できませんでした')
      stopInternal()
    }
  }, [disabled, commitRecognizedText, flushPendingRecognition, stopInternal])

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }, [])

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture?.(e.pointerId)
      tapStopArmRef.current = false
      holdingSessionRef.current = false
      clearHoldTimer()

      if (listeningRef.current) {
        tapStopArmRef.current = true
        return
      }

      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null
        holdingSessionRef.current = true
        startInternal()
      }, HOLD_MS)
    },
    [disabled, clearHoldTimer, startInternal],
  )

  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      if (e.button !== 0) return
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      } catch {
        /* noop */
      }

      if (tapStopArmRef.current) {
        tapStopArmRef.current = false
        clearHoldTimer()
        stopInternal()
        return
      }

      if (holdingSessionRef.current) {
        holdingSessionRef.current = false
        clearHoldTimer()
        stopInternal()
        return
      }

      clearHoldTimer()
      if (!listeningRef.current) {
        startInternal()
      }
    },
    [disabled, clearHoldTimer, startInternal, stopInternal],
  )

  const onPointerCancel = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      } catch {
        /* noop */
      }
      clearHoldTimer()
      if (holdingSessionRef.current) {
        holdingSessionRef.current = false
        stopInternal()
      }
      tapStopArmRef.current = false
    },
    [disabled, clearHoldTimer, stopInternal],
  )

  useEffect(() => {
    return () => {
      clearHoldTimer()
      const r = recognitionRef.current
      if (r) {
        try {
          r.abort()
        } catch {
          try {
            r.stop()
          } catch {
            /* noop */
          }
        }
      }
    }
  }, [clearHoldTimer])

  useEffect(() => {
    if (disabled && listeningRef.current) {
      clearHoldTimer()
      holdingSessionRef.current = false
      tapStopArmRef.current = false
      stopInternal()
    }
  }, [disabled, clearHoldTimer, stopInternal])

  return {
    isListening,
    speechError,
    setSpeechError,
    micPointerHandlers: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
    },
  }
}
