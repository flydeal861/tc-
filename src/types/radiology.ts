export type SlicePlane = 'axial' | 'coronal' | 'sagittal';

export type ViewportId = SlicePlane | '3d';

export type StudyCaseId =
  | 'full-spine'
  | 'lumbar-hernia'
  | 'thoracolumbar-fracture'
  | 'cervical-stenosis'
  | 'custom-upload';

export type MeasurementTool =
  | 'crosshair'
  | 'distance'
  | 'angle'
  | 'cobb'
  | 'roi'
  | 'window';

export type RenderMode3D = 'bone' | 'xray' | 'hu-map';

export interface WindowPreset {
  id: string;
  label: string;
  ww: number;
  wl: number;
}

export interface Point2D {
  /** Normalized coordinate [0, 1] across slice width */
  u: number;
  /** Normalized coordinate [0, 1] across slice height */
  v: number;
}

export interface Measurement2D {
  id: string;
  plane: SlicePlane;
  sliceIndex: number;
  type: 'distance' | 'angle' | 'cobb' | 'roi';
  points: Point2D[];
  valueLabel: string;
  numericValue: number;
  unit: string;
  roiStats?: {
    areaMm2: number;
    meanHu: number;
    minHu: number;
    maxHu: number;
    stdHu: number;
  };
}

export interface Measurement3D {
  id: string;
  type: 'distance' | 'angle';
  points: Array<{ x: number; y: number; z: number }>;
  valueLabel: string;
  numericValue: number;
  unit: string;
}

export interface VertebraSpec {
  id: string;
  label: string;
  region: 'cervical' | 'thoracic' | 'lumbar' | 'sacral';
  /** Center position in volume millimeters (X: left-right, Y: ant-post, Z: inf-sup) */
  centerMm: { x: number; y: number; z: number };
  /** Pitch tilt in radians (lordosis/kyphosis) */
  pitchRad: number;
  /** Roll tilt in radians (scoliosis) */
  rollRad: number;
  /** Vertebral body width (RL), depth (AP), height (SI) in mm */
  bodyWidthMm: number;
  bodyDepthMm: number;
  bodyHeightMm: number;
  /** Spinal canal AP diameter in mm */
  canalApMm: number;
  /** Canal transverse diameter in mm */
  canalWidthMm: number;
  /** Pathology flags encoded into both 3D geometry and CT HU volume */
  compressionFactor?: number;
  retropulsionMm?: number;
  anteriorSlipMm?: number;
  osteophyteScore?: number;
  lyticLesion?: boolean;
  /** Mean trabecular density HU */
  trabecularHu: number;
}

export interface DiscSpec {
  id: string;
  label: string;
  upperVertebra: string;
  lowerVertebra: string;
  centerMm: { x: number; y: number; z: number };
  pitchRad: number;
  widthMm: number;
  depthMm: number;
  heightMm: number;
  herniationMm?: number;
  herniationSide?: 'central' | 'left' | 'right';
  degeneration?: number; // 0..1
}

export interface SpineStudyConfig {
  id: Exclude<StudyCaseId, 'custom-upload'>;
  title: string;
  regionLabel: string;
  modalityInfo: string;
  sliceThicknessMm: number;
  pixelSpacingMm: number;
  volumeDims: {
    nx: number;
    ny: number;
    nz: number;
    spacingX: number;
    spacingY: number;
    spacingZ: number;
  };
  hasSkull?: boolean;
  skullCenterMm?: { x: number; y: number; z: number };
  hasPelvis?: boolean;
  pelvisCenterMm?: { x: number; y: number; z: number };
  kvp: number;
  mas: number;
  clinicalNote: string;
  vertebrae: VertebraSpec[];
  discs: DiscSpec[];
}

export interface IdentifiedStructure {
  id: string;
  name: string;
  vertebralLevel: string;
  category: 'Óseo' | 'Discal' | 'Canal / Neural' | 'Articular';
  estimatedHu: string;
  dimensionsNote: string;
  plane: SlicePlane;
  /** Normalized slice coordinates [0..1] */
  u: number;
  v: number;
  sliceRatio: number;
}

export interface DetectedPathology {
  id: string;
  title: string;
  location: string;
  severity: 'Leve' | 'Moderada' | 'Severa' | 'Hallazgo Normal';
  confidencePercent: number;
  radiologicalSigns: string;
  clinicalImpact: string;
  recommendation: string;
  plane: SlicePlane;
  u: number;
  v: number;
  sliceRatio: number;
}

export interface AiAnalysisResult {
  summary: string;
  alignmentAssessment: string;
  measurementInterpretation: string;
  structures: IdentifiedStructure[];
  pathologies: DetectedPathology[];
  analyzedAt: string;
}

export interface CustomImageSliceSet {
  axial?: { dataUrl: string; width: number; height: number; name: string };
  coronal?: { dataUrl: string; width: number; height: number; name: string };
  sagittal?: { dataUrl: string; width: number; height: number; name: string };
  calibrationMmPerPx: number;
}

export interface CtAcquisitionParams {
  kvp: 100 | 120 | 140;
  mas: number;
  sliceThicknessMm: 1.25 | 2.5 | 5.0;
}
