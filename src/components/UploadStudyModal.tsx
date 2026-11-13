import React, { useState } from 'react';
import { Upload, X } from 'lucide-react';
import { CustomImageSliceSet, SlicePlane } from '../types/radiology';

interface UploadStudyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyCustomStudy: (slices: CustomImageSliceSet) => void;
}

export const UploadStudyModal: React.FC<UploadStudyModalProps> = ({
  isOpen,
  onClose,
  onApplyCustomStudy,
}) => {
  const [slices, setSlices] = useState<CustomImageSliceSet>({
    calibrationMmPerPx: 0.45,
  });

  if (!isOpen) return null;

  const handleFile = (plane: SlicePlane, file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        setSlices((prev) => ({
          ...prev,
          [plane]: {
            dataUrl,
            width: img.width,
            height: img.height,
            name: file.name,
          },
        }));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const hasAny = Boolean(slices.axial || slices.coronal || slices.sagittal);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasAny) return;
    onApplyCustomStudy(slices);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-lg bg-[#0B0F17] border border-slate-700/80 rounded-md overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-100">
            Cargar Imágenes de TC Propias (Axial / Coronal / Sagital)
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ventana"
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Sube capturas de tomografía computarizada de columna en formato PNG, JPG o WebP para
            medir dimensiones anatómicas y ejecutar la identificación automática de estructuras óseas
            y patologías con IA.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(
              [
                ['axial', 'Corte Axial'],
                ['coronal', 'Corte Coronal'],
                ['sagittal', 'Corte Sagital'],
              ] as Array<[SlicePlane, string]>
            ).map(([plane, label]) => {
              const entry = slices[plane];
              return (
                <label
                  key={plane}
                  className="flex flex-col items-center justify-center p-3 rounded border border-dashed border-slate-700 bg-[#07090E] hover:border-cyan-500/70 cursor-pointer text-center transition-colors"
                >
                  <Upload className="w-4 h-4 text-cyan-400 mb-1.5" />
                  <span className="text-xs font-medium text-slate-200">{label}</span>
                  <span className="text-[11px] text-slate-400 mt-1 truncate max-w-full">
                    {entry ? entry.name : 'Seleccionar imagen'}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleFile(plane, e.target.files?.[0])}
                  />
                </label>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-4 pt-1">
            <label className="text-xs text-slate-300">
              Calibración espacial (mm / píxel)
            </label>
            <input
              type="number"
              step="0.05"
              min="0.1"
              max="3"
              value={slices.calibrationMmPerPx}
              onChange={(e) =>
                setSlices((prev) => ({
                  ...prev,
                  calibrationMmPerPx: Math.max(0.1, Number(e.target.value) || 0.45),
                }))
              }
              className="w-24 bg-[#07090E] border border-slate-700 rounded px-2.5 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white rounded border border-slate-700 hover:bg-slate-800 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!hasAny}
              className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 rounded transition-colors"
            >
              Cargar en Visor MPR
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
