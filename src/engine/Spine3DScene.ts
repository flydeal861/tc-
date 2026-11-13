import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  DiscSpec,
  Measurement3D,
  RenderMode3D,
  SlicePlane,
  SpineStudyConfig,
  VertebraSpec,
} from '../types/radiology';

export type CameraPreset3D = 'iso' | 'anterior' | 'posterior' | 'lateral' | 'superior';

export interface Scene3DCallbacks {
  onSelectVertebra?: (vertebra: VertebraSpec | null) => void;
  onAddMeasurement3D?: (measurement: Measurement3D) => void;
  onPendingPointsChange?: (points: Array<{ x: number; y: number; z: number }>) => void;
  onContextLost?: (lost: boolean) => void;
}

export interface SlicePositionsMm {
  axialZ: number;
  coronalY: number;
  sagittalX: number;
}

const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _camTargetPos = new THREE.Vector3();
const _camTargetLook = new THREE.Vector3();

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function createProceduralBoneTextures(maxAnisotropy: number): {
  albedoMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
} {
  const size = 256;
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const aCtx = albedoCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;
  const bCtx = bumpCanvas.getContext('2d')!;

  aCtx.fillStyle = '#e7dfd0';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < 4500; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const w = 1 + rand() * 3;
    const h = 1 + rand() * 8;
    const v = rand();
    aCtx.fillStyle = v > 0.5 ? 'rgba(255,250,240,0.14)' : 'rgba(168,154,132,0.14)';
    aCtx.fillRect(x, y, w, h);

    const g = Math.round(105 + v * 50);
    bCtx.fillStyle = `rgba(${g},${g},${g},0.22)`;
    bCtx.fillRect(x, y, w, h);
  }

  const albedoMap = new THREE.CanvasTexture(albedoCanvas);
  albedoMap.colorSpace = THREE.SRGBColorSpace;
  albedoMap.wrapS = THREE.RepeatWrapping;
  albedoMap.wrapT = THREE.RepeatWrapping;
  albedoMap.repeat.set(2, 2);
  albedoMap.anisotropy = maxAnisotropy;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(2, 2);
  bumpMap.anisotropy = maxAnisotropy;

  return { albedoMap, bumpMap };
}

function createKidneyBeanShape(halfW: number, halfD: number): THREE.Shape {
  const shape = new THREE.Shape();
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const x = halfW * cosT;
    let y = halfD * sinT;
    if (sinT < 0) {
      const indent = Math.exp(-(x * x) / (2 * (halfW * 0.42) ** 2)) * (halfD * 0.28);
      y += indent;
    }
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  return shape;
}

export class Spine3DScene {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private isSoftwareGl: boolean;
  private callbacks: Scene3DCallbacks;

  private spineRoot = new THREE.Group();
  private skullGroup = new THREE.Group();
  private pelvisGroup = new THREE.Group();
  private vertebraGroups = new Map<
    string,
    { group: THREE.Group; baseY: number; spec: VertebraSpec; meshes: THREE.Mesh[] }
  >();
  private discGroups = new Map<string, { group: THREE.Group; baseY: number; spec: DiscSpec }>();
  private cordGroup = new THREE.Group();
  private mprPlanesGroup = new THREE.Group();
  private measureGroup = new THREE.Group();
  private scanBeamGroup = new THREE.Group();

  private axialPlaneMesh!: THREE.Mesh;
  private coronalPlaneMesh!: THREE.Mesh;
  private sagittalPlaneMesh!: THREE.Mesh;
  private contactShadowMesh!: THREE.Mesh;

  private clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 9999);
  private activeClipAxis: SlicePlane | 'none' = 'none';

  private boneAlbedoMap: THREE.CanvasTexture;
  private boneBumpMap: THREE.CanvasTexture;
  private baseBoneMaterial: THREE.MeshStandardMaterial;
  private corticalRimMaterial: THREE.MeshStandardMaterial;
  private contextBoneMaterial: THREE.MeshStandardMaterial;
  private discMaterial: THREE.MeshPhysicalMaterial;
  private herniaMaterial: THREE.MeshStandardMaterial;
  private cordMaterial: THREE.MeshStandardMaterial;
  private xrayMaterial: THREE.MeshPhysicalMaterial;
  private huMapMaterials = new Map<string, THREE.MeshStandardMaterial>();

  private raycaster = new THREE.Raycaster();
  private pointerDownPos = { x: 0, y: 0 };
  private pickableMeshes: THREE.Mesh[] = [];

  private currentRenderMode: RenderMode3D = 'bone';
  private selectedVertebraId: string | null = null;
  private explodedTarget = 0;
  private explodedCurrent = 0;
  private studyCameraDist = 540;
  private studySpanY = 650;

  private activeTool3D: 'orbit' | 'distance' | 'angle' = 'orbit';
  private pendingPoints: THREE.Vector3[] = [];
  private measurements3D: Measurement3D[] = [];

  private cameraAnimActive = false;
  private frameId = 0;
  private renderBusy = false;
  private renderDirty = false;
  private lastTimestamp = 0;
  private disposed = false;

  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, callbacks: Scene3DCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareGl();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.renderer.setSize(width, height);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070A10');
    this.scene.fog = new THREE.FogExp2('#070A10', 0.00045);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(36, width / height, 2, 3500);
    this.camera.position.set(340, 120, 480);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 75;
    this.controls.maxDistance = 1250;
    this.controls.target.set(0, 0, 0);

    this.controls.addEventListener('start', () => {
      this.cameraAnimActive = false;
    });
    this.controls.addEventListener('change', () => {
      this.requestRender();
    });

    const hemiLight = new THREE.HemisphereLight('#c8e2ff', '#161b26', 0.72);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight('#fff5e6', 1.65);
    keyLight.position.set(220, 320, 260);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -280;
    keyLight.shadow.camera.right = 280;
    keyLight.shadow.camera.top = 380;
    keyLight.shadow.camera.bottom = -380;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight('#67e8f9', 0.85);
    rimLight.position.set(-220, 140, -260);
    this.scene.add(rimLight);

    this.setupFloorAndContactShadow();

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const { albedoMap, bumpMap } = createProceduralBoneTextures(maxAniso);
    this.boneAlbedoMap = albedoMap;
    this.boneBumpMap = bumpMap;

    this.baseBoneMaterial = new THREE.MeshStandardMaterial({
      color: '#ebe3d3',
      map: albedoMap,
      bumpMap,
      bumpScale: 0.45,
      roughness: 0.56,
      metalness: 0.04,
      clippingPlanes: [this.clippingPlane],
      clipShadows: true,
    });

    this.corticalRimMaterial = new THREE.MeshStandardMaterial({
      color: '#f5efe2',
      map: albedoMap,
      bumpMap,
      bumpScale: 0.25,
      roughness: 0.38,
      metalness: 0.06,
      clippingPlanes: [this.clippingPlane],
      clipShadows: true,
    });

    this.contextBoneMaterial = new THREE.MeshStandardMaterial({
      color: '#dfd5c3',
      map: albedoMap,
      bumpMap,
      bumpScale: 0.35,
      roughness: 0.6,
      metalness: 0.04,
      clippingPlanes: [this.clippingPlane],
      clipShadows: true,
    });

    this.discMaterial = new THREE.MeshPhysicalMaterial({
      color: '#67a5c4',
      roughness: 0.34,
      metalness: 0.02,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      transparent: true,
      opacity: 0.86,
      clippingPlanes: [this.clippingPlane],
    });

    this.herniaMaterial = new THREE.MeshStandardMaterial({
      color: '#f59e0b',
      emissive: '#78350f',
      emissiveIntensity: 0.45,
      roughness: 0.32,
      metalness: 0.05,
      clippingPlanes: [this.clippingPlane],
    });

    this.cordMaterial = new THREE.MeshStandardMaterial({
      color: '#fde047',
      emissive: '#713f12',
      emissiveIntensity: 0.25,
      roughness: 0.42,
      metalness: 0.02,
      transparent: true,
      opacity: 0.82,
    });

    this.xrayMaterial = new THREE.MeshPhysicalMaterial({
      color: '#bae6fd',
      emissive: '#083344',
      emissiveIntensity: 0.3,
      roughness: 0.2,
      metalness: 0.1,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
      clippingPlanes: [this.clippingPlane],
    });

    this.scene.add(this.spineRoot);
    this.scene.add(this.skullGroup);
    this.scene.add(this.pelvisGroup);
    this.scene.add(this.cordGroup);
    this.scene.add(this.mprPlanesGroup);
    this.scene.add(this.measureGroup);
    this.scene.add(this.scanBeamGroup);

    this.mprPlanesGroup.visible = false;
    this.cordGroup.visible = false;
    this.setupMprPlanes(260, 260, 420);
    this.setupScanBeam();

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointerup', this.handlePointerUp);
    dom.addEventListener('webglcontextlost', this.handleContextLost);
    dom.addEventListener('webglcontextrestored', this.handleContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
    this.requestRender();
  }

  private setupFloorAndContactShadow() {
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.65)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);

    this.contactShadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.55,
      })
    );
    this.contactShadowMesh.rotation.x = -Math.PI / 2;
    this.contactShadowMesh.position.y = -359;
    this.scene.add(this.contactShadowMesh);
  }

  private setupScanBeam() {
    const ringGeo = new THREE.RingGeometry(155, 162, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: '#22d3ee',
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;

    const innerDisk = new THREE.Mesh(
      new THREE.CircleGeometry(155, 64),
      new THREE.MeshBasicMaterial({
        color: '#06b6d4',
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    innerDisk.rotation.x = -Math.PI / 2;

    this.scanBeamGroup.add(ring);
    this.scanBeamGroup.add(innerDisk);
    this.scanBeamGroup.visible = false;
  }

  private setupMprPlanes(wMm: number, dMm: number, hMm: number) {
    while (this.mprPlanesGroup.children.length > 0) {
      const child = this.mprPlanesGroup.children[0];
      child.traverse((o) => {
        if ((o as THREE.Mesh).isMesh || (o as THREE.LineSegments).isLineSegments) {
          (o as THREE.Mesh).geometry.dispose();
        }
      });
      this.mprPlanesGroup.remove(child);
    }

    const makePlane = (w: number, h: number, colorHex: string) => {
      const group = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0.07,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h));
      const border = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.7 })
      );
      group.add(border);
      return group;
    };

    this.axialPlaneMesh = makePlane(wMm, dMm, '#06b6d4');
    this.axialPlaneMesh.rotation.x = -Math.PI / 2;
    this.mprPlanesGroup.add(this.axialPlaneMesh);

    this.coronalPlaneMesh = makePlane(wMm, hMm, '#10b981');
    this.mprPlanesGroup.add(this.coronalPlaneMesh);

    this.sagittalPlaneMesh = makePlane(dMm, hMm, '#f59e0b');
    this.sagittalPlaneMesh.rotation.y = Math.PI / 2;
    this.mprPlanesGroup.add(this.sagittalPlaneMesh);
  }

  public loadStudy(study: SpineStudyConfig) {
    this.clearStudyMeshes();

    const { nx, ny, nz, spacingX, spacingY, spacingZ } = study.volumeDims;
    const spanX = nx * spacingX;
    const spanY = ny * spacingY;
    const spanZ = nz * spacingZ;
    this.studySpanY = spanZ;

    this.setupMprPlanes(spanX * 0.9, spanY * 0.9, spanZ * 0.95);

    const floorY = -(spanZ * 0.52);
    this.contactShadowMesh.position.y = floorY + 0.5;

    // Frame camera target vertically across the entire anatomy
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const v of study.vertebrae) {
      minZ = Math.min(minZ, v.centerMm.z);
      maxZ = Math.max(maxZ, v.centerMm.z);
    }
    if (study.hasSkull && study.skullCenterMm) {
      maxZ = Math.max(maxZ, study.skullCenterMm.z + 55);
    }
    if (study.hasPelvis && study.pelvisCenterMm) {
      minZ = Math.min(minZ, study.pelvisCenterMm.z - 65);
    }

    const midY = (minZ + maxZ) * 0.5;
    const totalHeight = Math.max(180, maxZ - minZ);
    this.studyCameraDist = totalHeight * 1.48;
    this.controls.target.set(0, midY, 0);

    for (const v of study.vertebrae) {
      const built = this.buildCompositeVertebra(v);
      this.spineRoot.add(built.group);
      this.vertebraGroups.set(v.id, built);
      this.pickableMeshes.push(...built.meshes);
    }

    for (const d of study.discs) {
      const built = this.buildCompositeDisc(d);
      this.spineRoot.add(built.group);
      this.discGroups.set(d.id, built);
    }

    if (study.hasSkull && study.skullCenterMm) {
      this.buildCompositeSkull(study.skullCenterMm);
    }

    if (study.hasPelvis && study.pelvisCenterMm) {
      this.buildCompositePelvisAndHips(study.pelvisCenterMm);
    }

    this.buildSpinalCordAndRoots(study);

    this.applyRenderMode(this.currentRenderMode);
    this.setCameraPreset('iso', false);
    this.requestRender();
  }

  private clearStudyMeshes() {
    for (const { group } of this.vertebraGroups.values()) {
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          (obj as THREE.Mesh).geometry.dispose();
        }
      });
      this.spineRoot.remove(group);
    }
    this.vertebraGroups.clear();

    for (const { group } of this.discGroups.values()) {
      group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          (obj as THREE.Mesh).geometry.dispose();
        }
      });
      this.spineRoot.remove(group);
    }
    this.discGroups.clear();

    const clearGroup = (g: THREE.Group) => {
      while (g.children.length > 0) {
        const child = g.children[0];
        child.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            (o as THREE.Mesh).geometry.dispose();
          }
        });
        g.remove(child);
      }
    };

    clearGroup(this.skullGroup);
    clearGroup(this.pelvisGroup);
    clearGroup(this.cordGroup);

    for (const mat of this.huMapMaterials.values()) {
      mat.dispose();
    }
    this.huMapMaterials.clear();

    this.pickableMeshes = [];
    this.selectedVertebraId = null;
    this.clearMeasurements3D();
  }

  private buildCompositeSkull(centerMm: { x: number; y: number; z: number }) {
    const root = new THREE.Group();
    root.position.set(centerMm.x, centerMm.z, -centerMm.y);

    // 1. Cranial vault (neurocranium)
    const craniumGeo = new THREE.SphereGeometry(72, 32, 24);
    craniumGeo.scale(0.95, 0.94, 1.18);
    // Subtle temporal flattening and occipital contour
    const pos = craniumGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y < -25) {
        pos.setY(i, -25 + (y + 25) * 0.45);
      }
      if (z > 40 && y < 10) {
        pos.setX(i, x * 0.88);
      }
    }
    craniumGeo.computeVertexNormals();
    const craniumMesh = new THREE.Mesh(craniumGeo, this.contextBoneMaterial);
    craniumMesh.position.set(0, 16, 4);
    craniumMesh.userData = { part: 'Bóveda craneal' };
    root.add(craniumMesh);
    this.pickableMeshes.push(craniumMesh);

    // 2. Supraorbital brow ridge
    const browGeo = new THREE.TorusGeometry(38, 6.5, 10, 24, Math.PI * 0.72);
    const browMesh = new THREE.Mesh(browGeo, this.corticalRimMaterial);
    browMesh.rotation.x = Math.PI / 2.2;
    browMesh.rotation.z = Math.PI * 0.14;
    browMesh.position.set(0, 0, 56);
    root.add(browMesh);

    // 3 & 4. Bilateral orbital rims & cheekbones (zygomatic arches)
    const orbitGeo = new THREE.TorusGeometry(14, 3.8, 10, 22);
    for (const side of [-1, 1]) {
      const orbit = new THREE.Mesh(orbitGeo, this.corticalRimMaterial);
      orbit.position.set(side * 25, -14, 72);
      orbit.rotation.y = side * 0.22;
      root.add(orbit);

      const zygoCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 38, -20, 62),
        new THREE.Vector3(side * 58, -18, 36),
        new THREE.Vector3(side * 56, -14, 10),
      ]);
      const zygoGeo = new THREE.TubeGeometry(zygoCurve, 10, 4.0, 8, false);
      const zygoMesh = new THREE.Mesh(zygoGeo, this.corticalRimMaterial);
      root.add(zygoMesh);
    }

    // 5. Maxilla & Nasal Bridge
    const maxillaGeo = new THREE.CylinderGeometry(28, 22, 30, 18);
    maxillaGeo.scale(1.1, 1.0, 0.85);
    const maxillaMesh = new THREE.Mesh(maxillaGeo, this.contextBoneMaterial);
    maxillaMesh.position.set(0, -34, 58);
    root.add(maxillaMesh);

    const nasalGeo = new THREE.ConeGeometry(8, 22, 12);
    const nasalMesh = new THREE.Mesh(nasalGeo, this.corticalRimMaterial);
    nasalMesh.position.set(0, -14, 78);
    nasalMesh.rotation.x = 0.45;
    root.add(nasalMesh);

    // 6. Mandible (U-arch + ascending rami to TMJ)
    const jawCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-48, -18, 18),
      new THREE.Vector3(-44, -52, 34),
      new THREE.Vector3(-24, -64, 64),
      new THREE.Vector3(0, -66, 74),
      new THREE.Vector3(24, -64, 64),
      new THREE.Vector3(44, -52, 34),
      new THREE.Vector3(48, -18, 18),
    ]);
    const jawGeo = new THREE.TubeGeometry(jawCurve, 28, 6.2, 10, false);
    const jawMesh = new THREE.Mesh(jawGeo, this.corticalRimMaterial);
    jawMesh.userData = { part: 'Mandíbula' };
    root.add(jawMesh);
    this.pickableMeshes.push(jawMesh);

    // 7. Occipital base / Foramen Magnum collar connecting above C1
    const baseRingGeo = new THREE.TorusGeometry(22, 7.5, 10, 24);
    const baseRingMesh = new THREE.Mesh(baseRingGeo, this.corticalRimMaterial);
    baseRingMesh.rotation.x = Math.PI / 2;
    baseRingMesh.position.set(0, -44, -4);
    root.add(baseRingMesh);

    this.skullGroup.add(root);
  }

  private buildCompositePelvisAndHips(centerMm: { x: number; y: number; z: number }) {
    const root = new THREE.Group();
    root.position.set(centerMm.x, centerMm.z, -centerMm.y);

    // 1 & 2. Bilateral Iliac Wings (flaring contoured ExtrudeGeometry)
    const iliacShape = new THREE.Shape();
    iliacShape.moveTo(0, 0);
    iliacShape.quadraticCurveTo(28, 48, 76, 56);
    iliacShape.quadraticCurveTo(92, 34, 78, -6);
    iliacShape.quadraticCurveTo(56, -24, 34, -22);
    iliacShape.quadraticCurveTo(14, -14, 0, 0);

    const iliacGeo = new THREE.ExtrudeGeometry(iliacShape, {
      depth: 11,
      bevelEnabled: true,
      bevelThickness: 3.5,
      bevelSize: 3.0,
      bevelSegments: 3,
      curveSegments: 18,
    });
    iliacGeo.center();

    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(iliacGeo, this.contextBoneMaterial);
      wing.position.set(side * 66, 18, 4);
      wing.rotation.y = side * -0.52;
      wing.rotation.z = side * -0.18;
      wing.scale.x = side;
      wing.userData = { part: side < 0 ? 'Ilíaco derecho' : 'Ilíaco izquierdo' };
      root.add(wing);
      this.pickableMeshes.push(wing);
    }

    // 3. Pelvic Ring / Pubic Rami & Pubic Symphysis anteriorly
    const pubisCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-82, -16, 10),
      new THREE.Vector3(-48, -26, 38),
      new THREE.Vector3(0, -28, 48),
      new THREE.Vector3(48, -26, 38),
      new THREE.Vector3(82, -16, 10),
    ]);
    const pubisGeo = new THREE.TubeGeometry(pubisCurve, 26, 7.5, 10, false);
    const pubisMesh = new THREE.Mesh(pubisGeo, this.corticalRimMaterial);
    root.add(pubisMesh);

    // 4. Inferior Ischial Tuberosity arches
    for (const side of [-1, 1]) {
      const ischCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 82, -16, 10),
        new THREE.Vector3(side * 62, -52, -10),
        new THREE.Vector3(side * 20, -38, 32),
      ]);
      const ischGeo = new THREE.TubeGeometry(ischCurve, 14, 8.0, 10, false);
      const ischMesh = new THREE.Mesh(ischGeo, this.contextBoneMaterial);
      root.add(ischMesh);
    }

    // 5. Bilateral Acetabula + Proximal Femurs (Femoral Head, Neck, Trochanter & Shaft)
    const hipX = 88;
    const hipY = -20;
    const hipZ = 12;

    const cupGeo = new THREE.SphereGeometry(25, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    const headGeo = new THREE.SphereGeometry(20.5, 22, 18);

    for (const side of [-1, 1]) {
      // Acetabular socket
      const cup = new THREE.Mesh(cupGeo, this.contextBoneMaterial);
      cup.position.set(side * (hipX - 4), hipY + 2, hipZ);
      cup.rotation.z = side * (Math.PI * 0.65);
      root.add(cup);

      // Spherical femoral head
      const head = new THREE.Mesh(headGeo, this.corticalRimMaterial);
      head.position.set(side * hipX, hipY, hipZ);
      head.userData = { part: side < 0 ? 'Cabeza femoral derecha' : 'Cabeza femoral izquierda' };
      root.add(head);
      this.pickableMeshes.push(head);

      // Femoral neck + greater trochanter + proximal shaft
      const femurCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * hipX, hipY, hipZ),
        new THREE.Vector3(side * (hipX + 32), hipY - 20, hipZ - 4),
        new THREE.Vector3(side * (hipX + 34), hipY - 52, hipZ - 4),
        new THREE.Vector3(side * (hipX + 30), hipY - 96, hipZ - 2),
      ]);
      const femurGeo = new THREE.TubeGeometry(femurCurve, 18, 12.2, 12, false);
      const femurMesh = new THREE.Mesh(femurGeo, this.contextBoneMaterial);
      femurMesh.userData = { part: side < 0 ? 'Fémur proximal derecho' : 'Fémur proximal izquierdo' };
      root.add(femurMesh);
      this.pickableMeshes.push(femurMesh);

      // Greater trochanter prominence
      const trochGeo = new THREE.SphereGeometry(13.5, 14, 12);
      trochGeo.scale(0.9, 1.35, 0.9);
      const troch = new THREE.Mesh(trochGeo, this.corticalRimMaterial);
      troch.position.set(side * (hipX + 38), hipY - 14, hipZ - 6);
      root.add(troch);
    }

    // 6. Sacral continuation / Coccyx
    const coccyxCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 16, -2),
      new THREE.Vector3(0, -14, -14),
      new THREE.Vector3(0, -34, -4),
    ]);
    const coccyxGeo = new THREE.TubeGeometry(coccyxCurve, 10, 7.0, 10, false);
    const coccyxMesh = new THREE.Mesh(coccyxGeo, this.contextBoneMaterial);
    root.add(coccyxMesh);

    this.pelvisGroup.add(root);
  }

  private buildCompositeVertebra(v: VertebraSpec): {
    group: THREE.Group;
    baseY: number;
    spec: VertebraSpec;
    meshes: THREE.Mesh[];
  } {
    const group = new THREE.Group();
    const threeY = v.centerMm.z;
    const threeZ = -v.centerMm.y;
    group.position.set(v.centerMm.x, threeY, threeZ);
    group.rotation.set(-v.pitchRad, 0, -v.rollRad);

    const meshes: THREE.Mesh[] = [];
    const halfW = v.bodyWidthMm * 0.5;
    const halfD = v.bodyDepthMm * 0.5;
    const effH = v.bodyHeightMm * (v.compressionFactor ? v.compressionFactor + 0.12 : 1);
    const isCervical = v.region === 'cervical';
    const isSacral = v.region === 'sacral';

    const bodyShape = createKidneyBeanShape(halfW * 0.94, halfD * 0.94);
    const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
      depth: Math.max(5, effH - 3.6),
      bevelEnabled: true,
      bevelThickness: 1.8,
      bevelSize: 1.4,
      bevelSegments: 3,
      curveSegments: 22,
    });
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.center();

    if (v.compressionFactor && v.compressionFactor < 1) {
      const pos = bodyGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i);
        const apT = (z + halfD) / (2 * halfD);
        const scaleY = 1 - (1 - v.compressionFactor) * 0.45 * Math.max(0, apT);
        pos.setY(i, pos.getY(i) * scaleY);
      }
      bodyGeo.computeVertexNormals();
    }

    const bodyMesh = new THREE.Mesh(bodyGeo, this.baseBoneMaterial);
    bodyMesh.castShadow = !this.isSoftwareGl;
    bodyMesh.receiveShadow = !this.isSoftwareGl;
    bodyMesh.userData = { vertebraId: v.id, part: 'Cuerpo vertebral' };
    group.add(bodyMesh);
    meshes.push(bodyMesh);

    const flare = 1.03 + (v.osteophyteScore ?? 0) * 0.1;
    const endplateGeo = new THREE.ExtrudeGeometry(createKidneyBeanShape(halfW * flare, halfD * flare), {
      depth: 1.4,
      bevelEnabled: true,
      bevelThickness: 0.6,
      bevelSize: 0.6,
      bevelSegments: 2,
      curveSegments: 18,
    });
    endplateGeo.rotateX(Math.PI / 2);
    endplateGeo.center();

    const supEndplate = new THREE.Mesh(endplateGeo, this.corticalRimMaterial);
    supEndplate.position.y = effH * 0.46;
    supEndplate.userData = { vertebraId: v.id, part: 'Platillo superior' };
    group.add(supEndplate);
    meshes.push(supEndplate);

    const infEndplate = new THREE.Mesh(endplateGeo.clone(), this.corticalRimMaterial);
    infEndplate.position.y = -effH * 0.46;
    infEndplate.userData = { vertebraId: v.id, part: 'Platillo inferior' };
    group.add(infEndplate);
    meshes.push(infEndplate);

    const pedicleX = isCervical ? halfW * 0.74 : halfW * 0.66;
    const pedicleZStart = -halfD * 0.65;
    const pedicleZEnd = -(halfD + v.canalApMm * 0.58);
    const pedicleR = isCervical ? 3.0 : 4.8;

    for (const side of [-1, 1]) {
      const curve = new THREE.LineCurve3(
        new THREE.Vector3(side * pedicleX, 2, pedicleZStart),
        new THREE.Vector3(side * pedicleX * 1.04, 1, pedicleZEnd)
      );
      const pedGeo = new THREE.TubeGeometry(curve, 6, pedicleR, 10, false);
      const pedMesh = new THREE.Mesh(pedGeo, this.corticalRimMaterial);
      pedMesh.userData = { vertebraId: v.id, part: side < 0 ? 'Pedículo derecho' : 'Pedículo izquierdo' };
      group.add(pedMesh);
      meshes.push(pedMesh);
    }

    const laminaApexZ = -(halfD + v.canalApMm + (isCervical ? 4.5 : 7.0));
    const laminaR = isCervical ? 2.6 : 4.0;
    for (const side of [-1, 1]) {
      const curve = new THREE.LineCurve3(
        new THREE.Vector3(side * pedicleX * 1.04, 1, pedicleZEnd),
        new THREE.Vector3(0, -1, laminaApexZ)
      );
      const lamGeo = new THREE.TubeGeometry(curve, 6, laminaR, 10, false);
      const lamMesh = new THREE.Mesh(lamGeo, this.baseBoneMaterial);
      lamMesh.userData = { vertebraId: v.id, part: side < 0 ? 'Lámina derecha' : 'Lámina izquierda' };
      group.add(lamMesh);
      meshes.push(lamMesh);
    }

    const spinousEndZ = laminaApexZ - (isCervical ? 14 : isSacral ? 12 : 24);
    const spinousEndY = isCervical ? -5 : isSacral ? -7 : -9;
    const spinousCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, laminaApexZ + 1),
      new THREE.Vector3(0, spinousEndY * 0.45, (laminaApexZ + spinousEndZ) * 0.5),
      new THREE.Vector3(0, spinousEndY, spinousEndZ),
    ]);
    const spinousGeo = new THREE.TubeGeometry(spinousCurve, 8, isCervical ? 2.4 : 3.5, 8, false);
    const spinousMesh = new THREE.Mesh(spinousGeo, this.corticalRimMaterial);
    spinousMesh.userData = { vertebraId: v.id, part: 'Apófisis espinosa' };
    group.add(spinousMesh);
    meshes.push(spinousMesh);

    const transX = halfW + (isCervical ? 8 : isSacral ? 18 : 19);
    const transZ = pedicleZEnd - 2;
    const transR = isCervical ? 2.4 : 3.5;
    for (const side of [-1, 1]) {
      const curve = new THREE.LineCurve3(
        new THREE.Vector3(side * pedicleX, 1, pedicleZEnd),
        new THREE.Vector3(side * transX, 2, transZ - 3)
      );
      const transGeo = new THREE.TubeGeometry(curve, 5, transR, 8, false);
      const transMesh = new THREE.Mesh(transGeo, this.baseBoneMaterial);
      transMesh.userData = {
        vertebraId: v.id,
        part: side < 0 ? 'Apófisis transversa derecha' : 'Apófisis transversa izquierda',
      };
      group.add(transMesh);
      meshes.push(transMesh);
    }

    const facetGeo = new THREE.CapsuleGeometry(isCervical ? 2.4 : 3.2, 5.5, 4, 8);
    for (const side of [-1, 1]) {
      const supFacet = new THREE.Mesh(facetGeo, this.corticalRimMaterial);
      supFacet.position.set(side * pedicleX * 0.9, 6.2, pedicleZEnd - 1.5);
      supFacet.userData = { vertebraId: v.id, part: 'Carilla articular superior' };
      group.add(supFacet);
      meshes.push(supFacet);

      const infFacet = new THREE.Mesh(facetGeo, this.corticalRimMaterial);
      infFacet.position.set(side * pedicleX * 0.85, -6.2, pedicleZEnd - 3);
      infFacet.userData = { vertebraId: v.id, part: 'Carilla articular inferior' };
      group.add(infFacet);
      meshes.push(infFacet);
    }

    if (v.retropulsionMm && v.retropulsionMm > 0) {
      const fragGeo = new THREE.DodecahedronGeometry(v.retropulsionMm * 0.72, 1);
      fragGeo.scale(1.6, 1.0, 0.75);
      const fragMesh = new THREE.Mesh(fragGeo, this.herniaMaterial);
      fragMesh.position.set(0, 1, -(halfD + v.retropulsionMm * 0.45));
      fragMesh.userData = { vertebraId: v.id, part: 'Fragmento óseo retropulsado (Canal)' };
      group.add(fragMesh);
      meshes.push(fragMesh);
    }

    return { group, baseY: threeY, spec: v, meshes };
  }

  private buildCompositeDisc(d: DiscSpec): {
    group: THREE.Group;
    baseY: number;
    spec: DiscSpec;
  } {
    const group = new THREE.Group();
    const threeY = d.centerMm.z;
    const threeZ = -d.centerMm.y;
    group.position.set(d.centerMm.x, threeY, threeZ);
    group.rotation.set(-d.pitchRad, 0, 0);

    const halfW = d.widthMm * 0.48;
    const halfD = d.depthMm * 0.48;
    const discShape = createKidneyBeanShape(halfW, halfD);
    const discGeo = new THREE.ExtrudeGeometry(discShape, {
      depth: Math.max(2.5, d.heightMm - 1.2),
      bevelEnabled: true,
      bevelThickness: 0.7,
      bevelSize: 0.7,
      bevelSegments: 2,
      curveSegments: 20,
    });
    discGeo.rotateX(Math.PI / 2);
    discGeo.center();

    const discMesh = new THREE.Mesh(discGeo, this.discMaterial);
    discMesh.userData = { discId: d.id };
    group.add(discMesh);

    if (d.herniationMm && d.herniationMm > 0) {
      const hGeo = new THREE.SphereGeometry(d.herniationMm * 0.72, 16, 12);
      hGeo.scale(1.15, 0.65, 1.05);
      const hMesh = new THREE.Mesh(hGeo, this.herniaMaterial);
      const xShift = d.herniationSide === 'right' ? -7.5 : d.herniationSide === 'left' ? 7.5 : 0;
      hMesh.position.set(xShift, 0, -(halfD * 0.8 + d.herniationMm * 0.38));
      hMesh.userData = { discId: d.id, pathology: 'Hernia discal' };
      group.add(hMesh);
    }

    return { group, baseY: threeY, spec: d };
  }

  private buildSpinalCordAndRoots(study: SpineStudyConfig) {
    if (study.vertebrae.length < 2) return;

    const canalPoints: THREE.Vector3[] = [];
    for (const v of study.vertebrae) {
      const canalCenterY_ct = v.centerMm.y + v.bodyDepthMm * 0.5 + v.canalApMm * 0.48;
      canalPoints.push(new THREE.Vector3(v.centerMm.x, v.centerMm.z, -canalCenterY_ct));
    }

    const cordCurve = new THREE.CatmullRomCurve3(canalPoints);
    const cordGeo = new THREE.TubeGeometry(cordCurve, 64, 4.2, 12, false);
    const cordMesh = new THREE.Mesh(cordGeo, this.cordMaterial);
    this.cordGroup.add(cordMesh);

    for (const d of study.discs) {
      const threeY = d.centerMm.z;
      const canalThreeZ = -(d.centerMm.y + d.depthMm * 0.5 + 7.5);
      for (const side of [-1, 1]) {
        const rootCurve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(side * 2.2, threeY + 2, canalThreeZ),
          new THREE.Vector3(side * 16, threeY - 3, canalThreeZ + 5),
          new THREE.Vector3(side * 28, threeY - 11, canalThreeZ + 12),
        ]);
        const rootGeo = new THREE.TubeGeometry(rootCurve, 8, 1.35, 6, false);
        const rootMesh = new THREE.Mesh(rootGeo, this.cordMaterial);
        this.cordGroup.add(rootMesh);
      }
    }
  }

  public applyRenderMode(mode: RenderMode3D) {
    this.currentRenderMode = mode;

    // Update skull & pelvis material for xray vs bone
    const contextMat = mode === 'xray' ? this.xrayMaterial : this.contextBoneMaterial;
    this.skullGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = contextMat;
      }
    });
    this.pelvisGroup.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).material = contextMat;
      }
    });

    for (const [id, entry] of this.vertebraGroups.entries()) {
      const isSelected = id === this.selectedVertebraId;
      let mat: THREE.Material = this.baseBoneMaterial;
      if (mode === 'xray') {
        mat = this.xrayMaterial;
      } else if (mode === 'hu-map') {
        let huMat = this.huMapMaterials.get(id);
        if (!huMat) {
          const hu = entry.spec.trabecularHu;
          const color = entry.spec.compressionFactor
            ? '#ef4444'
            : entry.spec.anteriorSlipMm
            ? '#f59e0b'
            : hu > 340
            ? '#38bdf8'
            : '#2dd4bf';
          huMat = new THREE.MeshStandardMaterial({
            color,
            roughness: 0.42,
            metalness: 0.08,
            emissive: isSelected ? '#0e7490' : '#000000',
            emissiveIntensity: isSelected ? 0.55 : 0,
            clippingPlanes: [this.clippingPlane],
          });
          this.huMapMaterials.set(id, huMat);
        }
        mat = huMat;
      }

      for (const mesh of entry.meshes) {
        if (mesh.userData.part?.includes('Fragmento')) {
          mesh.material = this.herniaMaterial;
          continue;
        }
        if (isSelected && mode !== 'xray') {
          const highlightMat = (mat as THREE.MeshStandardMaterial).clone();
          highlightMat.emissive = new THREE.Color('#0891b2');
          highlightMat.emissiveIntensity = 0.45;
          mesh.material = highlightMat;
        } else {
          mesh.material = mat;
        }
      }
    }

    for (const entry of this.discGroups.values()) {
      entry.group.visible = mode !== 'xray';
    }

    this.requestRender();
  }

  public setSelectedVertebra(vertebraId: string | null) {
    this.selectedVertebraId = vertebraId;
    this.applyRenderMode(this.currentRenderMode);
  }

  public setShowCord(visible: boolean) {
    this.cordGroup.visible = visible;
    this.requestRender();
  }

  public setShowMprPlanes(visible: boolean) {
    this.mprPlanesGroup.visible = visible;
    this.requestRender();
  }

  public setShowSkullAndPelvis(visible: boolean) {
    this.skullGroup.visible = visible;
    this.pelvisGroup.visible = visible;
    this.requestRender();
  }

  public setScanBeam(active: boolean, zMm: number) {
    this.scanBeamGroup.visible = active;
    this.scanBeamGroup.position.set(0, zMm, 0);
    this.requestRender();
  }

  public updateSlicePlanes(pos: SlicePositionsMm) {
    this.axialPlaneMesh.position.set(0, pos.axialZ, 0);
    this.coronalPlaneMesh.position.set(0, 0, -pos.coronalY);
    this.sagittalPlaneMesh.position.set(pos.sagittalX, 0, 0);

    this.updateClippingPlaneValue(pos);
    this.requestRender();
  }

  public setClipAxis(axis: SlicePlane | 'none', pos: SlicePositionsMm) {
    this.activeClipAxis = axis;
    this.updateClippingPlaneValue(pos);
    this.requestRender();
  }

  private updateClippingPlaneValue(pos: SlicePositionsMm) {
    if (this.activeClipAxis === 'none') {
      this.clippingPlane.normal.set(0, -1, 0);
      this.clippingPlane.constant = 9999;
    } else if (this.activeClipAxis === 'axial') {
      this.clippingPlane.normal.set(0, -1, 0);
      this.clippingPlane.constant = pos.axialZ;
    } else if (this.activeClipAxis === 'coronal') {
      this.clippingPlane.normal.set(0, 0, -1);
      this.clippingPlane.constant = -pos.coronalY;
    } else if (this.activeClipAxis === 'sagittal') {
      this.clippingPlane.normal.set(-1, 0, 0);
      this.clippingPlane.constant = pos.sagittalX;
    }
  }

  public setExplodedFactor(factor: number) {
    this.explodedTarget = THREE.MathUtils.clamp(factor, 0, 1);
    this.requestRender();
  }

  public setTool3D(tool: 'orbit' | 'distance' | 'angle') {
    this.activeTool3D = tool;
    this.pendingPoints = [];
    this.renderPendingMarkers();
    this.callbacks.onPendingPointsChange?.([]);
    this.renderer.domElement.style.cursor = tool === 'orbit' ? 'grab' : 'crosshair';
  }

  public setCameraPreset(preset: CameraPreset3D, animate = true) {
    const target = this.controls.target;
    const dist = this.studyCameraDist;

    if (preset === 'anterior') {
      _camTargetPos.set(target.x, target.y, target.z + dist);
    } else if (preset === 'posterior') {
      _camTargetPos.set(target.x, target.y, target.z - dist);
    } else if (preset === 'lateral') {
      _camTargetPos.set(target.x + dist, target.y + 12, target.z);
    } else if (preset === 'superior') {
      _camTargetPos.set(target.x, target.y + dist, target.z + 36);
    } else {
      _camTargetPos.set(target.x + dist * 0.65, target.y + dist * 0.22, target.z + dist * 0.78);
    }

    _camTargetLook.copy(target);

    if (!animate || this.isSoftwareGl) {
      this.camera.position.copy(_camTargetPos);
      this.controls.update();
      this.cameraAnimActive = false;
      this.requestRender();
    } else {
      this.cameraAnimActive = true;
      this.requestRender();
    }
  }

  public clearMeasurements3D() {
    this.measurements3D = [];
    this.pendingPoints = [];
    this.rebuildMeasurementObjects();
    this.callbacks.onPendingPointsChange?.([]);
    this.requestRender();
  }

  public removeMeasurement3D(id: string) {
    this.measurements3D = this.measurements3D.filter((m) => m.id !== id);
    this.rebuildMeasurementObjects();
    this.requestRender();
  }

  private renderPendingMarkers() {
    this.rebuildMeasurementObjects();
    this.requestRender();
  }

  private rebuildMeasurementObjects() {
    while (this.measureGroup.children.length > 0) {
      const child = this.measureGroup.children[0];
      if ((child as THREE.Mesh).isMesh || (child as THREE.Line).isLine) {
        (child as THREE.Mesh).geometry.dispose();
        const m = (child as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
      this.measureGroup.remove(child);
    }

    const rScale = this.studySpanY > 400 ? 3.2 : 2.1;
    const sphereGeo = new THREE.SphereGeometry(rScale, 14, 14);
    const pendingMat = new THREE.MeshBasicMaterial({ color: '#f59e0b' });
    for (const pt of this.pendingPoints) {
      const marker = new THREE.Mesh(sphereGeo.clone(), pendingMat.clone());
      marker.position.copy(pt);
      this.measureGroup.add(marker);
    }

    for (const m of this.measurements3D) {
      const lineMat = new THREE.LineBasicMaterial({ color: m.type === 'distance' ? '#22d3ee' : '#fbbf24' });
      const ptMat = new THREE.MeshBasicMaterial({ color: m.type === 'distance' ? '#22d3ee' : '#fbbf24' });
      const vectors = m.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      for (const v of vectors) {
        const s = new THREE.Mesh(sphereGeo.clone(), ptMat.clone());
        s.position.copy(v);
        this.measureGroup.add(s);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(vectors);
      const line = new THREE.Line(lineGeo, lineMat);
      this.measureGroup.add(line);
    }
    sphereGeo.dispose();
    pendingMat.dispose();
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private handlePointerUp = (e: PointerEvent) => {
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    if (dx * dx + dy * dy > 25) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hits = this.raycaster.intersectObjects(this.pickableMeshes, false);

    if (hits.length === 0) {
      if (this.activeTool3D === 'orbit') {
        this.setSelectedVertebra(null);
        this.callbacks.onSelectVertebra?.(null);
      }
      return;
    }

    const hit = hits[0];
    if (this.activeTool3D === 'orbit') {
      const vId = hit.object.userData.vertebraId as string | undefined;
      if (vId && this.vertebraGroups.has(vId)) {
        this.setSelectedVertebra(vId);
        this.callbacks.onSelectVertebra?.(this.vertebraGroups.get(vId)!.spec);
      }
      return;
    }

    const pt = hit.point.clone();
    this.pendingPoints.push(pt);
    this.callbacks.onPendingPointsChange?.(this.pendingPoints.map((p) => ({ x: p.x, y: p.y, z: p.z })));

    if (this.activeTool3D === 'distance' && this.pendingPoints.length === 2) {
      const [p1, p2] = this.pendingPoints;
      const distMm = p1.distanceTo(p2);
      const measurement: Measurement3D = {
        id: `m3d-${Date.now()}`,
        type: 'distance',
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
        ],
        numericValue: distMm,
        unit: 'mm',
        valueLabel: `${distMm.toFixed(1)} mm`,
      };
      this.measurements3D.push(measurement);
      this.pendingPoints = [];
      this.callbacks.onPendingPointsChange?.([]);
      this.callbacks.onAddMeasurement3D?.(measurement);
    } else if (this.activeTool3D === 'angle' && this.pendingPoints.length === 3) {
      const [p1, p2, p3] = this.pendingPoints;
      _vec3A.subVectors(p1, p2).normalize();
      _vec3B.subVectors(p3, p2).normalize();
      const cosAngle = THREE.MathUtils.clamp(_vec3A.dot(_vec3B), -1, 1);
      const angleDeg = THREE.MathUtils.radToDeg(Math.acos(cosAngle));
      const measurement: Measurement3D = {
        id: `m3d-${Date.now()}`,
        type: 'angle',
        points: [
          { x: p1.x, y: p1.y, z: p1.z },
          { x: p2.x, y: p2.y, z: p2.z },
          { x: p3.x, y: p3.y, z: p3.z },
        ],
        numericValue: angleDeg,
        unit: '°',
        valueLabel: `${angleDeg.toFixed(1)}°`,
      };
      this.measurements3D.push(measurement);
      this.pendingPoints = [];
      this.callbacks.onPendingPointsChange?.([]);
      this.callbacks.onAddMeasurement3D?.(measurement);
    }

    this.rebuildMeasurementObjects();
    this.requestRender();
  };

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.onContextLost?.(true);
  };

  private handleContextRestored = () => {
    this.callbacks.onContextLost?.(false);
    this.requestRender();
  };

  public handleResize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.requestRender();
  }

  public captureSnapshotDataUrl(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  public requestRender() {
    if (this.disposed) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }
    this.renderBusy = true;
    this.frameId = requestAnimationFrame((now) => {
      if (this.disposed) return;
      this.renderDirty = false;
      const dt = this.lastTimestamp ? Math.min(0.05, (now - this.lastTimestamp) / 1000) : 0.016;
      this.lastTimestamp = now;

      let needsMoreFrames = false;

      if (Math.abs(this.explodedCurrent - this.explodedTarget) > 0.002) {
        this.explodedCurrent = THREE.MathUtils.damp(this.explodedCurrent, this.explodedTarget, 8, dt);
        needsMoreFrames = true;
      } else {
        this.explodedCurrent = this.explodedTarget;
      }

      if (this.vertebraGroups.size > 0) {
        const entries = Array.from(this.vertebraGroups.values());
        const midIdx = (entries.length - 1) * 0.5;
        entries.forEach((entry, i) => {
          const offset = (i - midIdx) * -14 * this.explodedCurrent;
          entry.group.position.y = entry.baseY + offset;
        });
        const discEntries = Array.from(this.discGroups.values());
        const midDisc = (discEntries.length - 1) * 0.5;
        discEntries.forEach((entry, i) => {
          const offset = (i - midDisc) * -14 * this.explodedCurrent;
          entry.group.position.y = entry.baseY + offset;
        });
      }

      if (this.cameraAnimActive) {
        const lambda = 7.5;
        this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, _camTargetPos.x, lambda, dt);
        this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, _camTargetPos.y, lambda, dt);
        this.camera.position.z = THREE.MathUtils.damp(this.camera.position.z, _camTargetPos.z, lambda, dt);
        _vec3C.copy(this.camera.position).sub(_camTargetPos);
        if (_vec3C.lengthSq() < 0.5) {
          this.camera.position.copy(_camTargetPos);
          this.cameraAnimActive = false;
        } else {
          needsMoreFrames = true;
        }
      }

      const controlsChanged = this.controls.update();
      if (controlsChanged) needsMoreFrames = true;

      this.renderer.render(this.scene, this.camera);

      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty || needsMoreFrames) {
          this.requestRender();
        }
      };

      if (this.isSoftwareGl) {
        this.afterDraw(done);
      } else {
        done();
      }
    });
  }

  public dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);
    dom.removeEventListener('webglcontextrestored', this.handleContextRestored);

    this.clearStudyMeshes();
    this.boneAlbedoMap.dispose();
    this.boneBumpMap.dispose();
    this.baseBoneMaterial.dispose();
    this.corticalRimMaterial.dispose();
    this.contextBoneMaterial.dispose();
    this.discMaterial.dispose();
    this.herniaMaterial.dispose();
    this.cordMaterial.dispose();
    this.xrayMaterial.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    if (dom.parentElement === this.container) {
      this.container.removeChild(dom);
    }
  }
}
