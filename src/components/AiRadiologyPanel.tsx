import React, { useState } from 'react';
import {
  AlertTriangle,
  Bone,
  CheckCircle2,
  Crosshair,
  Loader2,
  Send,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import {
  AiAnalysisResult,
  DetectedPathology,
  IdentifiedStructure,
} from '../types/radiology';

interface AiRadiologyPanelProps {
  analysis: AiAnalysisResult | null;
  isAnalyzing: boolean;
  error: string | null;
  selectedMarkerId: string | null;
  onRunAnalysis: () => void;
  onFocusStructure: (item: IdentifiedStructure) => void;
  onFocusPathology: (item: DetectedPathology) => void;
  onAskQuestion: (question: string) => Promise<string>;
}

function getSeverityDisplay(severity: DetectedPathology['severity']) {
  switch (severity) {
    case 'Severa':
      return {
        label: 'Severa',
        textClass: 'text-rose-400',
        borderClass: 'border-rose-500/40',
        Icon: ShieldAlert,
      };
    case 'Moderada':
      return {
        label: 'Moderada',
        textClass: 'text-amber-400',
        borderClass: 'border-amber-500/40',
        Icon: AlertTriangle,
      };
    case 'Leve':
      return {
        label: 'Leve',
        textClass: 'text-sky-400',
        borderClass: 'border-sky-500/40',
        Icon: AlertTriangle,
      };
    default:
      return {
        label: 'Hallazgo Normal',
        textClass: 'text-emerald-400',
        borderClass: 'border-emerald-500/40',
        Icon: CheckCircle2,
      };
  }
}

export const AiRadiologyPanel: React.FC<AiRadiologyPanelProps> = ({
  analysis,
  isAnalyzing,
  error,
  selectedMarkerId,
  onRunAnalysis,
  onFocusStructure,
  onFocusPathology,
  onAskQuestion,
}) => {
  const [activeTab, setActiveTab] = useState<'pathologies' | 'structures' | 'report'>('pathologies');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [qaHistory, setQaHistory] = useState<Array<{ q: string; a: string }>>([]);
  const [qaError, setQaError] = useState<string | null>(null);

  const handleSendQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || asking) return;
    const currentQ = question.trim();
    setQuestion('');
    setAsking(true);
    setQaError(null);
    try {
      const answer = await onAskQuestion(currentQ);
      setQaHistory((prev) => [...prev, { q: currentQ, a: answer }]);
    } catch (err: unknown) {
      setQaError(err instanceof Error ? err.message : 'No se pudo procesar la consulta.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <aside className="flex flex-col bg-[#0B0F17] border-l border-slate-800/90 h-full min-h-0">
      {/* Panel Header */}
      <div className="px-3.5 py-2.5 border-b border-slate-800/90 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-cyan-400 shrink-0" />
            <h2 className="text-xs font-semibold text-slate-100 whitespace-nowrap">
              Identificación IA de Raquis
            </h2>
          </div>
          {analysis && (
            <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
              {analysis.analyzedAt}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onRunAnalysis}
          disabled={isAnalyzing}
          className="mt-2.5 w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-60 transition-colors whitespace-nowrap"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analizando cortes MPR y 3D...
            </>
          ) : (
            <>Identificar estructuras y patologías</>
          )}
        </button>

        {error && (
          <div className="mt-2 p-2 rounded bg-rose-950/50 border border-rose-500/40 text-[11px] text-rose-200 leading-snug">
            {error}
          </div>
        )}
      </div>

      {/* Segmented Section Selector */}
      <div className="px-3 py-2 border-b border-slate-800/80 shrink-0">
        <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#07090E] rounded border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab('pathologies')}
            className={`px-2 py-1.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${
              activeTab === 'pathologies'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Patologías {analysis ? `(${analysis.pathologies.length})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('structures')}
            className={`px-2 py-1.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${
              activeTab === 'structures'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Estructuras {analysis ? `(${analysis.structures.length})` : ''}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('report')}
            className={`px-2 py-1.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${
              activeTab === 'report'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Informe
          </button>
        </div>
      </div>

      {/* Scrollable Results Content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-h-0">
        {!analysis && !isAnalyzing && (
          <div className="p-3.5 rounded border border-slate-800 bg-[#080C13] text-xs text-slate-300 space-y-2 leading-relaxed">
            <p className="font-medium text-slate-100">
              Análisis multimodal sobre cortes Axial, Coronal, Sagital y 3D
            </p>
            <p className="text-slate-400 text-[11px]">
              Pulsa el botón superior para que la inteligencia artificial identifique automáticamente
              cuerpos vertebrales, pedículos, láminas, discos y posibles patologías como hernias,
              fracturas o estenosis del canal en la zona visualizada.
            </p>
          </div>
        )}

        {isAnalyzing && !analysis && (
          <div className="space-y-2.5">
            {[1, 2, 3].map((item) => (
              <div
                key={item}
                className="p-3 rounded border border-slate-800/90 bg-[#080C13] space-y-2"
              >
                <div className="h-3 w-2/3 bg-slate-800 rounded" />
                <div className="h-2.5 w-full bg-slate-800/70 rounded" />
                <div className="h-2.5 w-4/5 bg-slate-800/70 rounded" />
              </div>
            ))}
          </div>
        )}

        {analysis && activeTab === 'pathologies' && (
          <div className="space-y-2.5">
            {analysis.pathologies.map((p) => {
              const sev = getSeverityDisplay(p.severity);
              const SevIcon = sev.Icon;
              const isActive = selectedMarkerId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onFocusPathology(p)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    isActive
                      ? 'bg-[#111927] border-rose-400/70'
                      : 'bg-[#080C13] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100 leading-snug">
                      {p.title}
                    </span>
                    <span className={`inline-flex items-center gap-1 text-[11px] font-medium shrink-0 ${sev.textClass}`}>
                      <SevIcon className="w-3 h-3" />
                      {sev.label}
                    </span>
                  </div>

                  <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
                    <span>{p.location}</span>
                    <span aria-hidden="true">·</span>
                    <span>Confianza {p.confidencePercent}%</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-cyan-400 inline-flex items-center gap-0.5">
                      <Crosshair className="w-3 h-3" /> {p.plane}
                    </span>
                  </div>

                  <p className="mt-2 text-[11px] text-slate-300 leading-relaxed">
                    {p.radiologicalSigns}
                  </p>
                  <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                    Repercusión: {p.clinicalImpact}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {analysis && activeTab === 'structures' && (
          <div className="space-y-2">
            {analysis.structures.map((st) => {
              const isActive = selectedMarkerId === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => onFocusStructure(st)}
                  className={`w-full text-left p-2.5 rounded border transition-colors ${
                    isActive
                      ? 'bg-[#111927] border-cyan-400/70'
                      : 'bg-[#080C13] border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                      <Bone className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      {st.name}
                    </span>
                    <span className="text-[11px] font-mono text-cyan-300 shrink-0">
                      {st.vertebralLevel}
                    </span>
                  </div>

                  <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
                    <span>{st.category}</span>
                    <span aria-hidden="true">·</span>
                    <span>{st.estimatedHu}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-sky-400">{st.plane}</span>
                  </div>

                  <p className="mt-1.5 text-[11px] text-slate-300 leading-relaxed">
                    {st.dimensionsNote}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        {analysis && activeTab === 'report' && (
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded border border-slate-800 bg-[#080C13] space-y-1.5">
              <div className="text-[11px] font-mono text-slate-400">Impresión Diagnóstica</div>
              <p className="text-slate-200 leading-relaxed">{analysis.summary}</p>
            </div>
            <div className="p-3 rounded border border-slate-800 bg-[#080C13] space-y-1.5">
              <div className="text-[11px] font-mono text-slate-400">Alineación Sagital y Coronal</div>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                {analysis.alignmentAssessment}
              </p>
            </div>
            <div className="p-3 rounded border border-slate-800 bg-[#080C13] space-y-1.5">
              <div className="text-[11px] font-mono text-slate-400">Valoración Morfométrica</div>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                {analysis.measurementInterpretation}
              </p>
            </div>
          </div>
        )}

        {/* Clinical Q&A history */}
        {qaHistory.length > 0 && (
          <div className="pt-2 border-t border-slate-800 space-y-2">
            <div className="text-[11px] font-mono text-slate-400">Consultas sobre la zona</div>
            {qaHistory.map((item, idx) => (
              <div key={idx} className="p-2.5 rounded border border-slate-800 bg-[#080C13] space-y-1">
                <div className="text-[11px] font-medium text-cyan-300">{item.q}</div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Follow-up Clinical Query Input */}
      <form
        onSubmit={handleSendQuestion}
        className="p-2.5 border-t border-slate-800/90 bg-[#090D14] shrink-0"
      >
        {qaError && (
          <p className="mb-1.5 text-[11px] text-rose-400">{qaError}</p>
        )}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Consultar sobre corte o hallazgo..."
            className="flex-1 min-w-0 bg-[#06080D] border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
          <button
            type="submit"
            disabled={asking || !question.trim()}
            aria-label="Enviar consulta radiológica"
            className="p-1.5 rounded bg-slate-800 text-cyan-300 hover:bg-slate-700 disabled:opacity-40 transition-colors shrink-0"
          >
            {asking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </form>
    </aside>
  );
};
