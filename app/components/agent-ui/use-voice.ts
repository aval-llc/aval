"use client";
import { useEffect, useRef, useState } from 'react';
import { useMicrophone } from 'voice-glow';
import { useTranslations } from 'next-intl';

/** Audio is held in memory only and released on stop, hide, error and unmount. */
export function useAvalVoice(onTranscript: (text: string) => void) {
  const mic = useMicrophone({ constraints: { echoCancellation: true, noiseSuppression: true } });
  const t = useTranslations('MinimalChat');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const receiving = useRef(onTranscript); useEffect(() => { receiving.current = onTranscript; }, [onTranscript]);
  const stop = () => { clearTimeout(timer.current); if (recorder.current?.state === 'recording') recorder.current.stop(); mic.stop(); };
  const cancel = () => { generation.current++; request.current?.abort(); stop(); setProcessing(false); };
  const cancelRef = useRef(cancel); useEffect(() => { cancelRef.current = cancel; });
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancelRef.current(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); cancelRef.current(); };
  }, []);
  const start = async () => {
    if (recorder.current?.state === 'recording' || processing || mic.state === 'requesting') return;
    setError('');
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
          if (token === generation.current) receiving.current(result.text.trim());
        } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t('voiceFailed')); }
        finally { if (token === generation.current) setProcessing(false); }
      };
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (capture.state === 'recording') capture.stop(); }, { once: true }));
      capture.start(250); timer.current = setTimeout(stop, 60_000);
    } catch { mic.stop(); setError(t('voiceFailed')); }
  };
  return { stream: mic.stream, state: processing ? 'processing' : mic.state, processing, error, start, stop, cancel };
}
