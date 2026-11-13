import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import {
  classifyHuTissue,
  computeCircularRoiStats,
  CTVolume,
  extractMprSlice,
  renderSliceToImageData,
} from '../engine/ctVolumeEngine';
import {
  CtAcquisitionParams,
  CustomImageSliceSet,
  Measurement2D,
  MeasurementTool,
  Point2D,
  SlicePlane,
} from '../types/radiology';

export interface MprSliceViewportHandle {
  getSnapshotDataUrl: () => string | null;
}

interface MprSliceViewportProps {
  plane: SlicePlane;
  volume: CTVolume | null;
  customSlices?: CustomImageSliceSet | null;
  sliceIndex: number;
  maxSliceIndex: number;
  crosshairU: number; // [0..1]
  crosshairV: number; // [0..1]
  ww: number;
  wl: number;
  invertGray: boolean;
  acquisition?: CtAcquisitionParams;
  activeTool: MeasurementTool;
  measurements: Measurement2D[];
  aiMarkers: Array<{
    id: string;
    label: string;
    kind: 'structure' | 'pathology';
    u: number;
    v: number;
    active: boolean;
  }>;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSliceChange: (nextIndex: number) => void;
  onCrosshairMove: (plane: SlicePlane, u: number, v: number) => void;
  onWindowChange: (nextWw: number, nextWl: number) => void;
  onAddMeasurement: (m: Measurement2D) => void;
  onMarkerSelect?: (id: string, kind: 'structure' | 'pathology') => void;
}

const PLANE_META: Record<
  SlicePlane,
  {
    title: string;
    accentColor: string;
    crosshairHColor: string;
    crosshairVColor: string;
    orientations: { top: string; bottom: string; left: string; right: string };
  }
> = {
  axial: {
    title: 'Corte Axial',
    accentColor: '#06b6d4',
    crosshairVColor: '#f59e0b', // Sagittal X
    crosshairHColor: '#10b981', // Coronal Y
    orientations: { top: 'A', bottom: 'P', left: 'D', right: 'I' },
  },
  coronal: {
    title: 'Corte Coronal',
    accentColor: '#10b981',
    crosshairVColor: '#f59e0b', // Sagittal X
    crosshairHColor: '#06b6d4', // Axial Z
    orientations: { top: 'S', bottom: 'I', left: 'D', right: 'I' },
  },
  sagittal: {
    title: 'Corte Sagital',
    accentColor: '#f59e0b',
    crosshairVColor: '#10b981', // Coronal Y
    crosshairHColor: '#06b6d4', // Axial Z
    orientations: { top: 'S', bottom: 'I', left: 'A', right: 'P' },
  },
};

function computeDistanceMm(
  p1: Point2D,
  p2: Point2D,
  widthMm: number,
  heightMm: number
): number {
  const dx = (p2.u - p1.u) * widthMm;
  const dy = (p2.v - p1.v) * heightMm;
  return Math.sqrt(dx * dx + dy * dy);
}

function computeThreePointAngleDeg(
  p1: Point2D,
  vertex: Point2D,
  p3: Point2D,
  widthMm: number,
  heightMm: number
): number {
  const ax = (p1.u - vertex.u) * widthMm;
  const ay = (p1.v - vertex.v) * heightMm;
  const bx = (p3.u - vertex.u) * widthMm;
  const by = (p3.v - vertex.v) * heightMm;
  const magA = Math.hypot(ax, ay);
  const magB = Math.hypot(bx, by);
  if (magA < 1e-4 || magB < 1e-4) return 0;
  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (magA * magB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function computeCobbAngleDeg(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D,
  widthMm: number,
  heightMm: number
): number {
  const ux = (a2.u - a1.u) * widthMm;
  const uy = (a2.v - a1.v) * heightMm;
  const vx = (b2.u - b1.u) * widthMm;
  const vy = (b2.v - b1.v) * heightMm;
  const magU = Math.hypot(ux, uy);
  const magV = Math.hypot(vx, vy);
  if (magU < 1e-4 || magV < 1e-4) return 0;
  const cos = Math.max(-1, Math.min(1, Math.abs(ux * vx + uy * vy) / (magU * magV)));
  return (Math.acos(cos) * 180) / Math.PI;
}

export const MprSliceViewport = React.forwardRef<MprSliceViewportHandle, MprSliceViewportProps>(
  function MprSliceViewport(
    {
      plane,
      volume,
      customSlices,
      sliceIndex,
      maxSliceIndex,
      crosshairU,
      crosshairV,
      ww,
      wl,
      invertGray,
      acquisition,
      activeTool,
      measurements,
      aiMarkers,
      isExpanded,
      onToggleExpand,
      onSliceChange,
      onCrosshairMove,
      onWindowChange,
      onAddMeasurement,
      onMarkerSelect,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const ctCanvasRef = useRef<HTMLCanvasElement>(null);
    const [customImgEl, setCustomImgEl] = useState<HTMLImageElement | null>(null);
    const [containerSize, setContainerSize] = useState({ width: 400, height: 300 });
    const [draftPoints, setDraftPoints] = useState<Point2D[]>([]);
    const [hoverProbe, setHoverProbe] = useState<{
      u: number;
      v: number;
      hu: number | null;
      tissue: string;
    } | null>(null);

    const dragStateRef = useRef<{
      mode: 'none' | 'crosshair' | 'window';
      startX: number;
      startY: number;
      startWw: number;
      startWl: number;
    }>({ mode: 'none', startX: 0, startY: 0, startWw: ww, startWl: wl });

    const meta = PLANE_META[plane];

    const customSliceEntry = customSlices ? customSlices[plane] : undefined;

    // Load custom image if present
    useEffect(() => {
      if (!customSliceEntry?.dataUrl) {
        setCustomImgEl(null);
        return;
      }
      const img = new Image();
      img.onload = () => setCustomImgEl(img);
      img.src = customSliceEntry.dataUrl;
    }, [customSliceEntry?.dataUrl]);

    // Extract current orthogonal slice from CT volume
    const extractedSlice = useMemo(() => {
      if (!volume || customSliceEntry) return null;
      return extractMprSlice(volume, plane, sliceIndex);
    }, [volume, customSliceEntry, plane, sliceIndex]);

    // Physical slice dimensions in mm
    const physicalDims = useMemo(() => {
      if (extractedSlice) {
        return {
          widthPx: extractedSlice.width,
          heightPx: extractedSlice.height,
          widthMm: extractedSlice.width * extractedSlice.pixelSpacingU,
          heightMm: extractedSlice.height * extractedSlice.pixelSpacingV,
          coordMm: extractedSlice.sliceCoordMm,
        };
      }
      if (customSliceEntry && customSlices) {
        const w = customSliceEntry.width;
        const h = customSliceEntry.height;
        const cal = customSlices.calibrationMmPerPx || 0.5;
        return {
          widthPx: w,
          heightPx: h,
          widthMm: w * cal,
          heightMm: h * cal,
          coordMm: 0,
        };
      }
      return { widthPx: 152, heightPx: 152, widthMm: 190, heightMm: 190, coordMm: 0 };
    }, [extractedSlice, customSliceEntry, customSlices]);

    // Track viewport size for crisp SVG overlay scaling
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const obs = new ResizeObserver((entries) => {
        for (const e of entries) {
          setContainerSize({
            width: Math.max(1, e.contentRect.width),
            height: Math.max(1, e.contentRect.height),
          });
        }
      });
      obs.observe(el);
      return () => obs.disconnect();
    }, []);

    // Render CT slice pixels to offscreen/display canvas
    useEffect(() => {
      const canvas = ctCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (extractedSlice) {
        canvas.width = extractedSlice.width;
        canvas.height = extractedSlice.height;
        const imgData = renderSliceToImageData(extractedSlice, ww, wl, invertGray, acquisition);
        ctx.putImageData(imgData, 0, 0);
      } else if (customImgEl) {
        canvas.width = customImgEl.width;
        canvas.height = customImgEl.height;
        ctx.filter = invertGray ? 'invert(1)' : 'none';
        ctx.drawImage(customImgEl, 0, 0);
        ctx.filter = 'none';
      } else {
        canvas.width = 256;
        canvas.height = 256;
        ctx.fillStyle = '#07090e';
        ctx.fillRect(0, 0, 256, 256);
      }
    }, [extractedSlice, customImgEl, ww, wl, invertGray, acquisition]);

    // Reset draft points when switching tool
    useEffect(() => {
      setDraftPoints([]);
    }, [activeTool, plane]);

    useImperativeHandle(ref, () => ({
      getSnapshotDataUrl: () => {
        const canvas = ctCanvasRef.current;
        if (!canvas) return null;
        // Upscale slightly for crisp vision analysis
        const out = document.createElement('canvas');
        const targetW = 384;
        const targetH = Math.round((canvas.height / Math.max(1, canvas.width)) * targetW);
        out.width = targetW;
        out.height = targetH;
        const oCtx = out.getContext('2d');
        if (!oCtx) return null;
        oCtx.imageSmoothingEnabled = true;
        oCtx.drawImage(canvas, 0, 0, targetW, targetH);
        return out.toDataURL('image/png');
      },
    }));

    // Compute fitted image rectangle inside container
    const imageRect = useMemo(() => {
      const cw = containerSize.width;
      const ch = containerSize.height;
      const aspectImg = physicalDims.widthMm / Math.max(1, physicalDims.heightMm);
      const aspectBox = cw / Math.max(1, ch);
      let drawW = cw;
      let drawH = ch;
      if (aspectBox > aspectImg) {
        drawH = ch * 0.94;
        drawW = drawH * aspectImg;
      } else {
        drawW = cw * 0.94;
        drawH = drawW / aspectImg;
      }
      const x = (cw - drawW) * 0.5;
      const y = (ch - drawH) * 0.5;
      return { x, y, width: drawW, height: drawH };
    }, [containerSize, physicalDims]);

    const clientToNorm = (clientX: number, clientY: number): Point2D | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const u = Math.max(0, Math.min(1, (px - imageRect.x) / Math.max(1, imageRect.width)));
      const v = Math.max(0, Math.min(1, (py - imageRect.y) / Math.max(1, imageRect.height)));
      return { u, v };
    };

    const handlePointerDown = (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      if (activeTool === 'window') {
        dragStateRef.current = {
          mode: 'window',
          startX: e.clientX,
          startY: e.clientY,
          startWw: ww,
          startWl: wl,
        };
        return;
      }

      const pt = clientToNorm(e.clientX, e.clientY);
      if (!pt) return;

      if (activeTool === 'crosshair') {
        dragStateRef.current = {
          mode: 'crosshair',
          startX: e.clientX,
          startY: e.clientY,
          startWw: ww,
          startWl: wl,
        };
        onCrosshairMove(plane, pt.u, pt.v);
        return;
      }

      // Measurement point placement
      const next = [...draftPoints, pt];
      if (activeTool === 'distance' && next.length === 2) {
        const distMm = computeDistanceMm(next[0], next[1], physicalDims.widthMm, physicalDims.heightMm);
        onAddMeasurement({
          id: `m2d-${Date.now()}`,
          plane,
          sliceIndex,
          type: 'distance',
          points: next,
          numericValue: distMm,
          unit: 'mm',
          valueLabel: `${distMm.toFixed(1)} mm`,
        });
        setDraftPoints([]);
      } else if (activeTool === 'angle' && next.length === 3) {
        const deg = computeThreePointAngleDeg(
          next[0],
          next[1],
          next[2],
          physicalDims.widthMm,
          physicalDims.heightMm
        );
        onAddMeasurement({
          id: `m2d-${Date.now()}`,
          plane,
          sliceIndex,
          type: 'angle',
          points: next,
          numericValue: deg,
          unit: '°',
          valueLabel: `${deg.toFixed(1)}°`,
        });
        setDraftPoints([]);
      } else if (activeTool === 'cobb' && next.length === 4) {
        const deg = computeCobbAngleDeg(
          next[0],
          next[1],
          next[2],
          next[3],
          physicalDims.widthMm,
          physicalDims.heightMm
        );
        onAddMeasurement({
          id: `m2d-${Date.now()}`,
          plane,
          sliceIndex,
          type: 'cobb',
          points: next,
          numericValue: deg,
          unit: '°',
          valueLabel: `Cobb ${deg.toFixed(1)}°`,
        });
        setDraftPoints([]);
      } else if (activeTool === 'roi' && next.length === 2) {
        const stats = extractedSlice
          ? computeCircularRoiStats(extractedSlice, next[0].u, next[0].v, next[1].u, next[1].v)
          : { areaMm2: 0, meanHu: 0, minHu: 0, maxHu: 0, stdHu: 0 };
        onAddMeasurement({
          id: `m2d-${Date.now()}`,
          plane,
          sliceIndex,
          type: 'roi',
          points: next,
          numericValue: stats.meanHu,
          unit: 'HU',
          valueLabel: `${Math.round(stats.meanHu)} HU · ${stats.areaMm2.toFixed(0)} mm²`,
          roiStats: stats,
        });
        setDraftPoints([]);
      } else {
        setDraftPoints(next);
      }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
      const pt = clientToNorm(e.clientX, e.clientY);
      if (pt && extractedSlice) {
        const px = Math.min(extractedSlice.width - 1, Math.floor(pt.u * extractedSlice.width));
        const py = Math.min(extractedSlice.height - 1, Math.floor(pt.v * extractedSlice.height));
        const hu = extractedSlice.huValues[py * extractedSlice.width + px];
        setHoverProbe({ u: pt.u, v: pt.v, hu, tissue: classifyHuTissue(hu) });
      } else if (pt) {
        setHoverProbe({ u: pt.u, v: pt.v, hu: null, tissue: 'Imagen cargada' });
      }

      if (dragStateRef.current.mode === 'crosshair' && pt) {
        onCrosshairMove(plane, pt.u, pt.v);
      } else if (dragStateRef.current.mode === 'window') {
        const dx = e.clientX - dragStateRef.current.startX;
        const dy = e.clientY - dragStateRef.current.startY;
        const nextWw = Math.max(80, Math.min(3500, Math.round(dragStateRef.current.startWw + dx * 6)));
        const nextWl = Math.max(-900, Math.min(1500, Math.round(dragStateRef.current.startWl - dy * 4)));
        onWindowChange(nextWw, nextWl);
      }
    };

    const handlePointerUp = () => {
      dragStateRef.current.mode = 'none';
    };

    const handleWheel = (e: React.WheelEvent) => {
      if (maxSliceIndex <= 0) return;
      const step = e.deltaY > 0 ? 1 : -1;
      const next = Math.max(0, Math.min(maxSliceIndex, sliceIndex + step));
      if (next !== sliceIndex) {
        onSliceChange(next);
      }
    };

    // Scale bar: 20 mm length in SVG pixels
    const scaleBarPx = (20 / Math.max(1, physicalDims.widthMm)) * imageRect.width;

    const normToSvg = (p: Point2D) => ({
      x: imageRect.x + p.u * imageRect.width,
      y: imageRect.y + p.v * imageRect.height,
    });

    const visibleMeasurements = measurements.filter(
      (m) => m.plane === plane && (customSliceEntry ? true : Math.abs(m.sliceIndex - sliceIndex) <= 1)
    );

    const chX = imageRect.x + crosshairU * imageRect.width;
    const chY = imageRect.y + crosshairV * imageRect.height;

    return (
      <div className="relative flex flex-col bg-[#05070B] border border-slate-800/90 rounded-md overflow-hidden h-full min-h-0 select-none">
        {/* Compact Header Ribbon */}
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-[#0B0F17] border-b border-slate-800/80 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="w-2 h-2 rounded-xs shrink-0"
              style={{ backgroundColor: meta.accentColor }}
            />
            <span className="text-xs font-semibold text-slate-100 whitespace-nowrap">
              {meta.title}
            </span>
            <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
              {customSliceEntry
                ? customSliceEntry.name
                : `${physicalDims.coordMm >= 0 ? '+' : ''}${physicalDims.coordMm.toFixed(1)} mm`}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {!customSliceEntry && (
              <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
                {sliceIndex + 1}/{maxSliceIndex + 1}
              </span>
            )}
            <button
              type="button"
              onClick={onToggleExpand}
              title={isExpanded ? 'Restaurar cuadrícula 2×2' : 'Expandir vista'}
              className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Interactive Canvas + SVG Measurement Overlay */}
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            dragStateRef.current.mode = 'none';
            setHoverProbe(null);
          }}
          onWheel={handleWheel}
          className={`relative flex-1 min-h-0 overflow-hidden bg-[#04060A] ${
            activeTool === 'window'
              ? 'cursor-ns-resize'
              : 'cursor-crosshair'
          }`}
        >
          {customSlices && !customSliceEntry ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
              <p className="text-xs text-slate-400">Sin imagen cargada para {meta.title}</p>
              <p className="text-[11px] text-slate-500 mt-1">
                Sube una imagen en «Subir Estudio» para visualizar este plano.
              </p>
            </div>
          ) : (
            <canvas
              ref={ctCanvasRef}
              style={{
                position: 'absolute',
                left: `${imageRect.x}px`,
                top: `${imageRect.y}px`,
                width: `${imageRect.width}px`,
                height: `${imageRect.height}px`,
                imageRendering: 'auto',
              }}
            />
          )}

          {/* Anatomical Orientation Labels */}
          <span className="pointer-events-none absolute top-1.5 left-1/2 -translate-x-1/2 text-[10px] font-mono font-semibold text-slate-400/80">
            {meta.orientations.top}
          </span>
          <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[10px] font-mono font-semibold text-slate-400/80">
            {meta.orientations.bottom}
          </span>
          <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-slate-400/80">
            {meta.orientations.left}
          </span>
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-slate-400/80">
            {meta.orientations.right}
          </span>

          {/* Vector Crosshairs, Measurements, Scale Bar, and AI Markers */}
          <svg
            className="pointer-events-none absolute inset-0 w-full h-full"
            viewBox={`0 0 ${containerSize.width} ${containerSize.height}`}
          >
            {/* MPR Orthogonal Crosshairs */}
            {!customSlices && (
              <g opacity={0.72}>
                <line
                  x1={chX}
                  y1={imageRect.y}
                  x2={chX}
                  y2={imageRect.y + imageRect.height}
                  stroke={meta.crosshairVColor}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <line
                  x1={imageRect.x}
                  y1={chY}
                  x2={imageRect.x + imageRect.width}
                  y2={chY}
                  stroke={meta.crosshairHColor}
                  strokeWidth={1}
                  strokeDasharray="4 3"
                />
                <circle
                  cx={chX}
                  cy={chY}
                  r={4}
                  fill="none"
                  stroke={meta.accentColor}
                  strokeWidth={1.2}
                />
              </g>
            )}

            {/* 20 mm Scale Bar */}
            <g transform={`translate(${imageRect.x + 12}, ${imageRect.y + imageRect.height - 14})`}>
              <line x1={0} y1={0} x2={scaleBarPx} y2={0} stroke="#94a3b8" strokeWidth={1.5} />
              <line x1={0} y1={-3} x2={0} y2={3} stroke="#94a3b8" strokeWidth={1.5} />
              <line x1={scaleBarPx} y1={-3} x2={scaleBarPx} y2={3} stroke="#94a3b8" strokeWidth={1.5} />
              <text x={scaleBarPx + 5} y={3} fill="#94a3b8" fontSize="10" fontFamily="IBM Plex Mono, monospace">
                20 mm
              </text>
            </g>

            {/* Committed 2D Measurements */}
            {visibleMeasurements.map((m) => {
              const pts = m.points.map(normToSvg);
              if (m.type === 'distance' && pts.length === 2) {
                const midX = (pts[0].x + pts[1].x) * 0.5;
                const midY = (pts[0].y + pts[1].y) * 0.5;
                return (
                  <g key={m.id}>
                    <line
                      x1={pts[0].x}
                      y1={pts[0].y}
                      x2={pts[1].x}
                      y2={pts[1].y}
                      stroke="#22d3ee"
                      strokeWidth={1.75}
                    />
                    {pts.map((p, idx) => (
                      <circle key={idx} cx={p.x} cy={p.y} r={3} fill="#22d3ee" />
                    ))}
                    <rect
                      x={midX - 28}
                      y={midY - 19}
                      width={56}
                      height={15}
                      rx={2}
                      fill="#07090e"
                      fillOpacity={0.85}
                      stroke="#0891b2"
                      strokeWidth={0.8}
                    />
                    <text
                      x={midX}
                      y={midY - 8}
                      textAnchor="middle"
                      fill="#67e8f9"
                      fontSize="10"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {m.valueLabel}
                    </text>
                  </g>
                );
              }

              if (m.type === 'angle' && pts.length === 3) {
                return (
                  <g key={m.id}>
                    <polyline
                      points={`${pts[0].x},${pts[0].y} ${pts[1].x},${pts[1].y} ${pts[2].x},${pts[2].y}`}
                      fill="none"
                      stroke="#fbbf24"
                      strokeWidth={1.75}
                    />
                    {pts.map((p, idx) => (
                      <circle key={idx} cx={p.x} cy={p.y} r={3} fill="#fbbf24" />
                    ))}
                    <rect
                      x={pts[1].x + 6}
                      y={pts[1].y - 14}
                      width={46}
                      height={15}
                      rx={2}
                      fill="#07090e"
                      fillOpacity={0.85}
                      stroke="#d97706"
                      strokeWidth={0.8}
                    />
                    <text
                      x={pts[1].x + 29}
                      y={pts[1].y - 3}
                      textAnchor="middle"
                      fill="#fde68a"
                      fontSize="10"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {m.valueLabel}
                    </text>
                  </g>
                );
              }

              if (m.type === 'cobb' && pts.length === 4) {
                const midX = (pts[1].x + pts[3].x) * 0.5;
                const midY = (pts[1].y + pts[3].y) * 0.5;
                return (
                  <g key={m.id}>
                    <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke="#fb923c" strokeWidth={1.75} />
                    <line x1={pts[2].x} y1={pts[2].y} x2={pts[3].x} y2={pts[3].y} stroke="#fb923c" strokeWidth={1.75} />
                    <line
                      x1={(pts[0].x + pts[1].x) * 0.5}
                      y1={(pts[0].y + pts[1].y) * 0.5}
                      x2={(pts[2].x + pts[3].x) * 0.5}
                      y2={(pts[2].y + pts[3].y) * 0.5}
                      stroke="#fb923c"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                    {pts.map((p, idx) => (
                      <circle key={idx} cx={p.x} cy={p.y} r={2.8} fill="#fb923c" />
                    ))}
                    <rect
                      x={midX - 36}
                      y={midY - 8}
                      width={72}
                      height={15}
                      rx={2}
                      fill="#07090e"
                      fillOpacity={0.88}
                      stroke="#ea580c"
                      strokeWidth={0.8}
                    />
                    <text
                      x={midX}
                      y={midY + 3}
                      textAnchor="middle"
                      fill="#fed7aa"
                      fontSize="10"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {m.valueLabel}
                    </text>
                  </g>
                );
              }

              if (m.type === 'roi' && pts.length === 2) {
                const r = Math.max(6, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
                return (
                  <g key={m.id}>
                    <circle
                      cx={pts[0].x}
                      cy={pts[0].y}
                      r={r}
                      fill="#34d399"
                      fillOpacity={0.12}
                      stroke="#34d399"
                      strokeWidth={1.5}
                    />
                    <rect
                      x={pts[0].x - 54}
                      y={pts[0].y - r - 18}
                      width={108}
                      height={15}
                      rx={2}
                      fill="#07090e"
                      fillOpacity={0.88}
                      stroke="#059669"
                      strokeWidth={0.8}
                    />
                    <text
                      x={pts[0].x}
                      y={pts[0].y - r - 7}
                      textAnchor="middle"
                      fill="#a7f3d0"
                      fontSize="9.5"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {m.valueLabel}
                    </text>
                  </g>
                );
              }

              return null;
            })}

            {/* Active Draft Points Preview */}
            {draftPoints.length > 0 && (
              <g>
                {draftPoints.map((dp, idx) => {
                  const s = normToSvg(dp);
                  const preview = hoverProbe ? normToSvg({ u: hoverProbe.u, v: hoverProbe.v }) : null;
                  return (
                    <g key={idx}>
                      <circle cx={s.x} cy={s.y} r={3.5} fill="#f59e0b" />
                      {idx === draftPoints.length - 1 && preview && (
                        <>
                          {activeTool === 'roi' ? (
                            <circle
                              cx={s.x}
                              cy={s.y}
                              r={Math.max(4, Math.hypot(preview.x - s.x, preview.y - s.y))}
                              fill="none"
                              stroke="#34d399"
                              strokeWidth={1.2}
                              strokeDasharray="3 3"
                            />
                          ) : (
                            !(activeTool === 'cobb' && draftPoints.length === 2) && (
                              <line
                                x1={s.x}
                                y1={s.y}
                                x2={preview.x}
                                y2={preview.y}
                                stroke="#f59e0b"
                                strokeWidth={1.2}
                                strokeDasharray="3 3"
                              />
                            )
                          )}
                        </>
                      )}
                    </g>
                  );
                })}
                {activeTool === 'cobb' && draftPoints.length >= 2 && (
                  <line
                    x1={normToSvg(draftPoints[0]).x}
                    y1={normToSvg(draftPoints[0]).y}
                    x2={normToSvg(draftPoints[1]).x}
                    y2={normToSvg(draftPoints[1]).y}
                    stroke="#fb923c"
                    strokeWidth={1.5}
                  />
                )}
              </g>
            )}

            {/* AI Markers on this plane */}
            {aiMarkers.map((mk) => {
              const pos = normToSvg({ u: mk.u, v: mk.v });
              const color = mk.kind === 'pathology' ? '#f43f5e' : '#38bdf8';
              return (
                <g key={mk.id}>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={mk.active ? 11 : 7}
                    fill={color}
                    fillOpacity={mk.active ? 0.22 : 0.12}
                    stroke={color}
                    strokeWidth={mk.active ? 1.8 : 1.1}
                  />
                  <circle cx={pos.x} cy={pos.y} r={2} fill={color} />
                  {mk.active && (
                    <g>
                      <rect
                        x={pos.x + 12}
                        y={pos.y - 10}
                        width={Math.min(148, mk.label.length * 6.2 + 12)}
                        height={16}
                        rx={2}
                        fill="#07090e"
                        fillOpacity={0.9}
                        stroke={color}
                        strokeWidth={0.8}
                      />
                      <text
                        x={pos.x + 18}
                        y={pos.y + 1}
                        fill="#f8fafc"
                        fontSize="10"
                        fontFamily="Plus Jakarta Sans, sans-serif"
                      >
                        {mk.label.slice(0, 22)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Interactive click targets for AI markers */}
          {aiMarkers.map((mk) => {
            const pos = normToSvg({ u: mk.u, v: mk.v });
            return (
              <button
                key={`btn-${mk.id}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onMarkerSelect?.(mk.id, mk.kind);
                }}
                title={mk.label}
                style={{ left: `${pos.x - 10}px`, top: `${pos.y - 10}px` }}
                className="absolute w-5 h-5 rounded-full focus-visible:outline focus-visible:outline-cyan-400"
              />
            );
          })}

          {/* Corner Live HU Probe & WW/WL HUD */}
          <div className="pointer-events-none absolute bottom-1.5 right-2 text-right font-mono text-[10px] leading-tight text-slate-300/90 bg-[#07090E]/75 px-1.5 py-0.5 rounded border border-slate-800/70">
            {hoverProbe ? (
              <div>
                {hoverProbe.hu !== null ? (
                  <>
                    <span className="text-cyan-300">{hoverProbe.hu} HU</span>
                    <span className="text-slate-500"> · </span>
                    <span className="text-slate-300">{hoverProbe.tissue}</span>
                  </>
                ) : (
                  <span>
                    u:{(hoverProbe.u * 100).toFixed(0)}% v:{(hoverProbe.v * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            ) : (
              <div className="text-slate-400">
                WW {ww} / WL {wl}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Slice Scrubber */}
        {!customSliceEntry && maxSliceIndex > 0 && (
          <div className="flex items-center gap-2 px-2.5 py-1 bg-[#0B0F17] border-t border-slate-800/80 shrink-0">
            <input
              type="range"
              min={0}
              max={maxSliceIndex}
              value={sliceIndex}
              onChange={(e) => onSliceChange(Number(e.target.value))}
              aria-label={`Desplazar corte ${meta.title}`}
              className="clinical-slider w-full"
            />
          </div>
        )}
      </div>
    );
  }
);
