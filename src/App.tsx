import React, { useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import axialCtImg from './assets/images/ct_axial_lumbar_1794611797856.jpg';
import coronalCtImg from './assets/images/ct_coronal_spine_hips_1794611799832.jpg';
import sagittalCtImg from './assets/images/ct_sagittal_spine_skull_1794611800480.jpg';
import { Viewport3D, Viewport3DHandle } from './components/Viewport3D';
import { SPINE_STUDIES } from './data/spineStudies';
import { ViewportId } from './types/radiology';

interface CtImagePaneProps {
  title: string;
  src: string;
  alt: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const CtImagePane: React.FC<CtImagePaneProps> = ({
  title,
  src,
  alt,
  isExpanded,
  onToggleExpand,
}) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="relative flex flex-col bg-[#000000] border border-slate-800/80 rounded-md overflow-hidden h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0B0F17] border-b border-slate-800/80 shrink-0">
        <span className="text-xs font-semibold text-slate-100 whitespace-nowrap">{title}</span>
        <button
          type="button"
          onClick={onToggleExpand}
          title={isExpanded ? 'Ver cuadrícula 2×2' : `Expandir ${title}`}
          className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
        >
          {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center bg-[#000000] p-1">
        {imgError ? (
          <div className="flex flex-col items-center justify-center text-center p-4 text-xs text-slate-400">
            <span>{title}</span>
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className="max-w-full max-h-full w-full h-full object-contain select-none"
          />
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [expandedViewport, setExpandedViewport] = useState<ViewportId | null>(null);
  const viewport3DRef = useRef<Viewport3DHandle>(null);

  const toggleExpand = (id: ViewportId) => {
    setExpandedViewport((prev) => (prev === id ? null : id));
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#05070B] text-slate-100">
      {/* Clean Single-Row Header */}
      <header className="flex items-center justify-between gap-8 px-5 h-11 bg-[#0B0F17] border-b border-slate-800/80 shrink-0">
        <span className="text-sm font-bold tracking-tight text-white whitespace-nowrap shrink-0">
          RaquisView TC
        </span>

        <nav className="flex items-center gap-6 text-xs font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setExpandedViewport(null)}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              expandedViewport === null ? 'text-white underline underline-offset-4 decoration-cyan-400' : ''
            }`}
          >
            Cuadrícula 2×2
          </button>
          <button
            type="button"
            onClick={() => setExpandedViewport('axial')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              expandedViewport === 'axial' ? 'text-white underline underline-offset-4 decoration-cyan-400' : ''
            }`}
          >
            Axial
          </button>
          <button
            type="button"
            onClick={() => setExpandedViewport('coronal')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              expandedViewport === 'coronal' ? 'text-white underline underline-offset-4 decoration-cyan-400' : ''
            }`}
          >
            Coronal
          </button>
          <button
            type="button"
            onClick={() => setExpandedViewport('sagittal')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              expandedViewport === 'sagittal' ? 'text-white underline underline-offset-4 decoration-cyan-400' : ''
            }`}
          >
            Sagital
          </button>
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => {
              setExpandedViewport('3d');
              viewport3DRef.current?.resetCamera();
            }}
            className="px-3.5 py-1 text-xs font-semibold text-slate-950 bg-cyan-500 hover:bg-cyan-400 rounded transition-colors whitespace-nowrap shrink-0"
          >
            Vista 3D
          </button>
        </div>
      </header>

      {/* Pure 2×2 Grid: Real Anatomical CT Slices + Clean 3D Reconstruction */}
      <main className="flex-1 min-h-0 p-2 bg-[#05070B]">
        <div
          className={`grid gap-2 h-full w-full ${
            expandedViewport ? 'grid-cols-1 grid-rows-1' : 'grid-cols-2 grid-rows-2'
          }`}
        >
          {(expandedViewport === null || expandedViewport === 'axial') && (
            <CtImagePane
              title="Corte Axial"
              src={axialCtImg}
              alt="Tomografía computarizada de columna en corte axial con cuerpo vertebral, pedículos, láminas y canal medular"
              isExpanded={expandedViewport === 'axial'}
              onToggleExpand={() => toggleExpand('axial')}
            />
          )}

          {(expandedViewport === null || expandedViewport === 'coronal') && (
            <CtImagePane
              title="Corte Coronal"
              src={coronalCtImg}
              alt="Tomografía computarizada de raquis en corte coronal desde base del cráneo hasta pelvis y caderas"
              isExpanded={expandedViewport === 'coronal'}
              onToggleExpand={() => toggleExpand('coronal')}
            />
          )}

          {(expandedViewport === null || expandedViewport === 'sagittal') && (
            <CtImagePane
              title="Corte Sagital"
              src={sagittalCtImg}
              alt="Tomografía computarizada de columna en corte sagital desde cráneo y columna cervical hasta sacro"
              isExpanded={expandedViewport === 'sagittal'}
              onToggleExpand={() => toggleExpand('sagittal')}
            />
          )}

          {(expandedViewport === null || expandedViewport === '3d') && (
            <Viewport3D
              ref={viewport3DRef}
              study={SPINE_STUDIES['full-spine']}
              isExpanded={expandedViewport === '3d'}
              onToggleExpand={() => toggleExpand('3d')}
            />
          )}
        </div>
      </main>
    </div>
  );
}
