"use client";
import { useEffect, useRef, useState } from 'react';
import { useMicrophone } from 'voice-glow';
import { useLocale, useTranslations } from 'next-intl';

/**
 * The browser's own speech recognition, where the platform provides it.
 *
 * On macOS and iOS this is the same dictation engine the operating system uses
 * everywhere else, which is why it is worth preferring: it needs no provider
 * key, it costs nothing per minute, and — the part that matters here — it
 * reports words as they are spoken instead of after the recording ends.
 */
interface LiveRecognition extends EventTarget {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionConstructor = new () => LiveRecognition;

function systemDictation(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

/**
 * Speech to text, live where the platform allows it.
 *
 * Two paths, and the difference a person notices is the whole reason for the
 * first. The system recognizer streams words into the box as they are said;
 * uploading a recording cannot, because there is nothing to show until the
 * speaking stops. So the recognizer is preferred wherever it exists and the
 * upload path stays as the fallback for browsers without one.
 *
 * `interim` tells the caller whether the text is still being revised. Interim
 * text replaces what came before it rather than appending, or dictating one
 * sentence would leave every half-heard draft of it in the box.
 *
 * Audio is held in memory only and released on stop, hide, error and unmount.
 */
export function useAvalVoice(onTranscript: (text: string, interim: boolean) => void) {
  const mic = useMicrophone({ constraints: { echoCancellation: true, noiseSuppression: true } });
  const t = useTranslations('MinimalChat');
  const locale = useLocale();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const dictation = useRef<LiveRecognition | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const receiving = useRef(onTranscript); useEffect(() => { receiving.current = onTranscript; }, [onTranscript]);
  const stop = () => {
    clearTimeout(timer.current);
    // `stop` finishes a dictation and keeps what was heard; `abort` throws it
    // away. Which one runs is the difference between a person pausing and a
    // person changing their mind, so the two are never collapsed.
    dictation.current?.stop();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    mic.stop();
  };
  const cancel = () => {
    generation.current++;
    request.current?.abort();
    clearTimeout(timer.current);
    const listening = dictation.current; dictation.current = null;
    listening?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    mic.stop();
    setProcessing(false);
  };
  const cancelRef = useRef(cancel); useEffect(() => { cancelRef.current = cancel; });
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancelRef.current(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); cancelRef.current(); };
  }, []);
  /**
   * Dictate through the platform's own recognizer.
   *
   * The microphone is opened alongside it so the composer's waveform has
   * something to draw. One permission covers both, and if the stream is
   * refused the words still arrive — a missing animation is not a reason to
   * stop somebody talking.
   */
  const startDictation = async (Recognition: RecognitionConstructor) => {
    const token = ++generation.current;
    const stream = await mic.start().catch(() => null);
    if (token !== generation.current) { stream?.getTracks().forEach(track => track.stop()); return; }

    const listening = new Recognition();
    dictation.current = listening;
    listening.lang = locale;
    listening.continuous = true;
    listening.interimResults = true;

    let settled = '';
    listening.onresult = event => {
      if (token !== generation.current) return;
      let pending = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) settled += result[0].transcript;
        else pending += result[0].transcript;
      }
      receiving.current((settled + pending).replace(/\s+/g, ' ').trim(), pending !== '');
    };
    listening.onerror = event => {
      // Silence is not a failure worth a message — people pause. A refused
      // microphone is, and says which one it was.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('voiceDenied') : t('voiceFailed'));
    };
    listening.onend = () => {
      dictation.current = null;
      mic.stop();
      // Settle what was heard, so the box holds finished text rather than the
      // last interim guess.
      if (token === generation.current && settled.trim()) receiving.current(settled.replace(/\s+/g, ' ').trim(), false);
    };

    try { listening.start(); } catch { dictation.current = null; mic.stop(); setError(t('voiceFailed')); }
    timer.current = setTimeout(() => listening.stop(), 60_000);
  };

  const start = async () => {
    if (dictation.current || recorder.current?.state === 'recording' || processing || mic.state === 'requesting') return;
    setError('');
    // Preferred wherever it exists: it is the only path that can show words
    // while they are being spoken.
    const Recognition = systemDictation();
    if (Recognition) return startDictation(Recognition);
    if (typeof MediaRecorder === 'undefined' || !window.isSecureContext) { setError(t('voiceUnsupported')); return; }
    const token = ++generation.current;
    const stream = await mic.start();
    if (token !== generation.current) { stream?.getTracks().forEach(track => track.stop()); return; }
    if (!stream) { setError(t('voiceDenied')); return; }
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      let chunks: Blob[] = []; let bytes = 0;
      capture.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > 8_000_000) stop(); } };
      capture.onerror = () => { cancel(); setError(t('voiceFailed')); };
      capture.onstop = async () => {
        clearTimeout(timer.current); mic.stop(); recorder.current = null;
        if (token !== generation.current) { chunks = []; return; }
        const blob = new Blob(chunks, { type: capture.mimeType }); chunks = [];
        if (!blob.size || blob.size > 8_000_000) { setError(t('voiceFailed')); return; }
        setProcessing(true); const controller = new AbortController(); request.current = controller;
        try {
          const data = new FormData(); data.append('audio', blob, capture.mimeType.includes('mp4') ? 'voice.m4a' : 'voice.webm');
          const response = await fetch('/api/assistant/transcribe', { method: 'POST', body: data, signal: controller.signal });
          const result = await response.json() as { text?: string; code?: string };
          if (!response.ok || !result.text?.trim()) throw Error(result.code === 'provider_required' ? t('voiceProviderRequired') : t('voiceFailed'));
          if (token === generation.current) receiving.current(result.text.trim(), false);
        } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('voiceFailed')); }
        finally { if (token === generation.current) setProcessing(false); }
      };
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (capture.state === 'recording') capture.stop(); }, { once: true }));
      capture.start(250); timer.current = setTimeout(stop, 60_000);
    } catch { mic.stop(); setError(t('voiceFailed')); }
  };
  return { stream: mic.stream, state: processing ? 'processing' : mic.state, processing, error, start, stop, cancel };
}
