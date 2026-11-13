import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { CameraPreset3D, Spine3DScene } from '../engine/Spine3DScene';
import { SpineStudyConfig } from '../types/radiology';

export interface Viewport3DHandle {
  resetCamera: () => void;
}

interface Viewport3DProps {
  study: SpineStudyConfig;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export const Viewport3D = React.forwardRef<Viewport3DHandle, Viewport3DProps>(function Viewport3D(
  { study, isExpanded, onToggleExpand },
  ref
) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Spine3DScene | null>(null);
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const scene = new Spine3DScene(el, {
      onContextLost: (lost) => setContextLost(lost),
    });
    scene.setShowMprPlanes(false);
    scene.setShowCord(false);
    scene.setShowSkullAndPelvis(true);
    sceneRef.current = scene;

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (sceneRef.current && study) {
      sceneRef.current.loadStudy(study);
      sceneRef.current.setShowMprPlanes(false);
      sceneRef.current.setShowCord(false);
      sceneRef.current.setShowSkullAndPelvis(true);
    }
  }, [study]);

  useImperativeHandle(ref, () => ({
    resetCamera: () => sceneRef.current?.setCameraPreset('iso', true),
  }));

  const handlePreset = (preset: CameraPreset3D) => {
    sceneRef.current?.setCameraPreset(preset, true);
  };

  return (
    <div className="relative flex flex-col bg-[#05070B] border border-slate-800/80 rounded-md overflow-hidden h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0B0F17] border-b border-slate-800/80 shrink-0">
        <span className="text-xs font-semibold text-slate-100 whitespace-nowrap">
          Reconstrucción 3D · Cráneo, Raquis y Cadera
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => handlePreset('iso')}
            title="Restablecer vista 3D"
            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            title={isExpanded ? 'Ver cuadrícula 2×2' : 'Expandir reconstrucción 3D'}
            className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-[#05070B]">
        <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />
        {contextLost && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#05070B] text-xs text-slate-300">
            Restaurando vista 3D...
          </div>
        )}
      </div>
    </div>
  );
});
