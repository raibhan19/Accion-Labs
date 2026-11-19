/**
 * AudioRecorder.tsx — NVIDIA NeMo-Speech.cpp Realtime Transcription
 *
 * Our responsibility: audio capture, realtime WebSocket streaming to port 8003,
 * live Doctor/Patient transcript display, file upload replay.
 *
 * Team B's responsibility: everything after onSuccess(encounter) is called.
 *
 * Visual design matches Team B's clinical theme (Inter, clinical-* palette, Tailwind).
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  Square,
  Upload,
  CheckCircle2,
  Loader2,
  AlertCircle,
  User,
  Stethoscope,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import type { Encounter } from "../../types/clinical";

// ── Config ────────────────────────────────────────────────────────────────
// Our transcription service runs on port 8003.
// NeMo-Speech.cpp serves on port 8090 (backend talks to it directly).
const TRANSCRIPTION_BASE = ""  // Use Vite proxy — routes /test/* to port 8003;

interface TranscriptSegment {
  segment_id: string;
  role: string;
  text: string;
  status: "LIVE" | "STABLE" | "FINAL";
  speaker_id: string;
  version: number;
}

interface AudioRecorderProps {
  onSuccess: (encounter: Encounter) => void;
}

export default function AudioRecorder({ onSuccess }: AudioRecorderProps) {
  // ── State ────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<"idle" | "connecting" | "live" | "finalizing" | "done">("idle");
  const [patientId, setPatientId] = useState("");
  const [patientName, setPatientName] = useState("");
  const [segments, setSegments] = useState<Record<string, TranscriptSegment>>({});
  const [segmentOrder, setSegmentOrder] = useState<string[]>([]);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [nemoReachable, setNemoReachable] = useState<boolean | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // ── Health check ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${TRANSCRIPTION_BASE}/health`)
      .then((r) => r.json())
      .then((d) => setNemoReachable(d.nemo_reachable ?? false))
      .catch(() => setNemoReachable(false));
  }, []);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segmentOrder.length]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopAudio();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Segment update ────────────────────────────────────────────────────────
  const updateSegment = useCallback((seg: TranscriptSegment) => {
    setSegments((prev) => ({ ...prev, [seg.segment_id]: seg }));
    setSegmentOrder((prev) =>
      prev.includes(seg.segment_id) ? prev : [...prev, seg.segment_id]
    );
  }, []);

  // ── Audio helpers ─────────────────────────────────────────────────────────
  const stopAudio = () => {
    scriptNodeRef.current?.disconnect();
    scriptNodeRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
  };

  // ── Start live session ────────────────────────────────────────────────────
  const startSession = async () => {
    setError(null);
    setSegments({});
    setSegmentOrder([]);
    setDuration(0);
    setMode("connecting");

    try {
      // 1. Create session on our backend
      const startRes = await fetch(`${TRANSCRIPTION_BASE}/test/realtime/start`, {
        method: "POST",
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to start session");
      }
      const { session_id } = await startRes.json();
      sessionIdRef.current = session_id;

      // 2. Open WebSocket to our backend
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${window.location.host}/test/realtime/${session_id}/stream`
      );
      wsRef.current = ws;

      ws.onopen = async () => {
        // 3. Start mic capture
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true },
        });
        mediaStreamRef.current = stream;

        const ctx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(2048, 1, 1);
        scriptNodeRef.current = node;

        node.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const input = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(pcm.buffer);
        };

        source.connect(node);
        node.connect(ctx.destination);

        setMode("live");
        timerRef.current = window.setInterval(
          () => setDuration((d) => d + 1),
          1000
        );
        toast.info("Recording started — speak naturally");
      };

      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === "segment_update" && ev.segment) {
            updateSegment(ev.segment);
          } else if (ev.type === "final_summary" && ev.all_segments) {
            ev.all_segments.forEach(updateSegment);
            setMode("done");
            handleFinalTranscript(session_id, ev.all_segments);
          } else if (ev.type === "session_status") {
            console.log("[NVIDIA]", ev.message);
          }
        } catch {
          /* ignore parse error */
        }
      };

      ws.onerror = () => {
        setError("WebSocket error — check that our transcription service is running on port 8003");
        setMode("idle");
        stopAudio();
      };

      ws.onclose = () => {
        stopAudio();
        if (timerRef.current) clearInterval(timerRef.current);
      };
    } catch (err: any) {
      setError(err.message ?? "Could not start session");
      setMode("idle");
      stopAudio();
    }
  };

  // ── Stop session ──────────────────────────────────────────────────────────
  const stopSession = async () => {
    setMode("finalizing");
    if (timerRef.current) clearInterval(timerRef.current);
    stopAudio();

    // Send stop over WebSocket
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: "stop" }));
    }

    // Also call stop endpoint to flush final audio
    if (sessionIdRef.current) {
      try {
        const res = await fetch(
          `${TRANSCRIPTION_BASE}/test/realtime/${sessionIdRef.current}/stop`,
          { method: "POST" }
        );
        const data = await res.json();
        if (data.segments?.length) {
          data.segments.forEach(updateSegment);
          handleFinalTranscript(sessionIdRef.current, data.segments);
        }
      } catch (err: any) {
        setError(err.message);
      }
    }
  };

  // ── File upload replay ────────────────────────────────────────────────────
  const handleFileUpload = async () => {
    if (!selectedFile) return;
    setError(null);
    setSegments({});
    setSegmentOrder([]);
    setMode("connecting");

    const formData = new FormData();
    formData.append("upload_file", selectedFile);

    try {
      const res = await fetch(`${TRANSCRIPTION_BASE}/test/realtime/replay`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Replay failed");
      const data = await res.json();
      const segs = data.result?.segments ?? [];
      segs.forEach(updateSegment);
      setMode("done");
      handleFinalTranscript(data.result?.session_id ?? "replay", segs);
    } catch (err: any) {
      setError(err.message ?? "File replay failed");
      setMode("idle");
    }
  };

  // ── Build Team B encounter payload from our transcript ────────────────────
  const handleFinalTranscript = async (
    sessionId: string,
    finalSegments: TranscriptSegment[]
  ) => {
    const consultationId = sessionId.replace(/[^A-Za-z0-9_.:\-]/g, "_").slice(0, 128);

    // Normalize to Team B TranscriptPayload format
    const payload = {
      consultation_id: consultationId,
      language: "en-US",
      patient_id: patientId.trim() || undefined,
      patient_name: patientName.trim() || undefined,
      segments: finalSegments
        .filter((s) => s.text?.trim())
        .map((s) => ({
          speaker: s.role?.toUpperCase() === "PATIENT" ? "PATIENT" : "DOCTOR",
          start_time: 0.0,
          end_time: 0.0,
          text: s.text,
          confidence: 0.95,
        })),
    };

    if (payload.segments.length === 0) {
      toast.warning("No transcript segments to process");
      setMode("idle");
      return;
    }

    toast.loading("Sending transcript to clinical pipeline…", { id: "pipeline" });
    try {
      // Send to Team B's pipeline via their processTranscript endpoint
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? ""}/api/encounters/pipeline/from-transcript`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || "Pipeline failed");
      }
      const encounter: Encounter = await res.json();
      toast.success("Encounter created!", {
        id: "pipeline",
        description: `Encounter ${encounter.encounter_id} ready for physician review.`,
      });
      onSuccess(encounter);
    } catch (err: any) {
      toast.error("Pipeline error", { id: "pipeline", description: err.message });
      setMode("idle");
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60)
      .toString()
      .padStart(2, "0")}`;

  const isLive = mode === "live";
  const isBusy = mode === "connecting" || mode === "finalizing";
  const hasTranscript = segmentOrder.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-2xl border border-clinical-200/80 bg-white p-6 shadow-lift">

      {/* Header */}
      <div className="flex items-center justify-between border-b border-ink-100 pb-4">
        <div>
          <h2 className="text-lg font-bold text-ink-900">Live Consultation Recording</h2>
          <p className="text-xs text-ink-500">
            Record speech directly in browser or upload recorded encounter audio.
            Transcription and diarization powered by NVIDIA NeMo local inference.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isLive ? (
            <span className="inline-flex animate-pulse items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">
              <span className="h-2 w-2 rounded-full bg-red-600" />
              Live · {fmt(duration)}
            </span>
          ) : nemoReachable === true ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
              <CheckCircle2 size={12} /> Ready
            </span>
          ) : nemoReachable === false ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
              <AlertCircle size={12} /> NeMo offline
            </span>
          ) : null}
        </div>
      </div>

      {/* Patient fields */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Patient ID (Optional)
          </label>
          <input
            type="text"
            placeholder="e.g. PT-98214"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            disabled={isLive || isBusy}
            className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm text-ink-900 placeholder-ink-400 focus:border-clinical-500 focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Patient Name (Optional)
          </label>
          <input
            type="text"
            placeholder="e.g. Jane Doe"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            disabled={isLive || isBusy}
            className="mt-1 w-full rounded-xl border border-ink-200 px-3 py-2 text-sm text-ink-900 placeholder-ink-400 focus:border-clinical-500 focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl bg-ink-50 p-4">
        {!isLive ? (
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={startSession}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-soft hover:bg-red-700 disabled:opacity-50"
          >
            {isBusy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Mic size={16} />
            )}
            {mode === "connecting" ? "Connecting…" : mode === "finalizing" ? "Finalizing…" : "Start Recording"}
          </motion.button>
        ) : (
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            onClick={stopSession}
            className="inline-flex items-center gap-2 rounded-xl bg-clinical-900 px-4 py-2.5 text-sm font-semibold text-white shadow-lift hover:bg-clinical-800"
          >
            <Square size={16} /> Stop &amp; Generate Note
          </motion.button>
        )}

        <div className="h-6 w-px bg-ink-200 hidden sm:block" />

        {/* File upload */}
        <div className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLive || isBusy}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 shadow-soft hover:border-clinical-300 disabled:opacity-50"
          >
            <Upload size={14} />
            {selectedFile ? selectedFile.name.slice(0, 20) : "Choose Audio File"}
          </button>
          {selectedFile && !isLive && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleFileUpload}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-clinical-700 px-3 py-2 text-xs font-semibold text-white hover:bg-clinical-800 disabled:opacity-50"
            >
              {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
              Process File
            </motion.button>
          )}
        </div>

        {isBusy && (
          <div className="ml-auto flex items-center gap-2 text-xs font-medium text-clinical-800 animate-pulse">
            <Loader2 size={14} className="animate-spin" />
            {mode === "finalizing" ? "Flushing final audio…" : "Connecting to NVIDIA NeMo…"}
          </div>
        )}
      </div>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live transcript feed */}
      <AnimatePresence>
        {hasTranscript && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="mt-5"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Live Transcript
              </span>
              <span className="text-xs text-ink-400">
                {segmentOrder.filter((id) => segments[id]?.status === "FINAL").length} finalized
              </span>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-ink-100 bg-ink-50/50 p-3 scrollbar-thin">
              {segmentOrder.map((id) => {
                const seg = segments[id];
                if (!seg) return null;
                const isDoctor = seg.role?.toLowerCase().includes("doc");
                const isPatient = seg.role?.toLowerCase().includes("pat");
                const isLiveSeg = seg.status === "LIVE";
                return (
                  <motion.div
                    key={id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex gap-2.5 ${isPatient ? "flex-row-reverse" : ""}`}
                  >
                    {/* Avatar */}
                    <div
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white ${
                        isDoctor
                          ? "bg-clinical-700"
                          : isPatient
                          ? "bg-emerald-600"
                          : "bg-ink-400"
                      }`}
                    >
                      {isDoctor ? (
                        <Stethoscope size={13} />
                      ) : isPatient ? (
                        <User size={13} />
                      ) : (
                        <Mic size={13} />
                      )}
                    </div>

                    {/* Bubble */}
                    <div
                      className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-soft ${
                        isDoctor
                          ? "rounded-tl-sm border border-clinical-200/60 bg-clinical-50 text-clinical-900"
                          : isPatient
                          ? "rounded-tr-sm border border-emerald-200/60 bg-emerald-50 text-emerald-900"
                          : "border border-ink-200 bg-white text-ink-700"
                      }`}
                    >
                      <div
                        className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
                          isDoctor
                            ? "text-clinical-600"
                            : isPatient
                            ? "text-emerald-600"
                            : "text-ink-400"
                        }`}
                      >
                        {seg.role || "Speaking…"}
                      </div>
                      <span>
                        {seg.text}
                        {isLiveSeg && (
                          <span className="ml-1 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-current align-middle opacity-60" />
                        )}
                      </span>
                    </div>
                  </motion.div>
                );
              })}
              <div ref={transcriptEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}



