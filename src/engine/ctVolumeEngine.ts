import {
  CtAcquisitionParams,
  DiscSpec,
  SlicePlane,
  SpineStudyConfig,
  VertebraSpec,
} from '../types/radiology';

export interface CTVolume {
  studyId: string;
  nx: number;
  ny: number;
  nz: number;
  spacingX: number;
  spacingY: number;
  spacingZ: number;
  originX: number;
  originY: number;
  originZ: number;
  data: Int16Array;
}

const volumeCache = new Map<string, CTVolume>();

function hash3(x: number, y: number, z: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  const nx00 = n000 + (n100 - n000) * ux;
  const nx10 = n010 + (n110 - n010) * ux;
  const nx01 = n001 + (n101 - n001) * ux;
  const nx11 = n011 + (n111 - n011) * ux;

  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;

  return nxy0 + (nxy1 - nxy0) * uz;
}

function sdCapsule(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number
): number {
  const pax = px - ax;
  const pay = py - ay;
  const paz = pz - az;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz || 1e-6;
  let h = (pax * bax + pay * bay + paz * baz) / denom;
  if (h < 0) h = 0;
  else if (h > 1) h = 1;
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  const dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

function vertebralBodyField(
  lx: number,
  ly: number,
  lz: number,
  v: VertebraSpec
): { inside: boolean; distToSurface: number; isEndplate: boolean } {
  const halfW = v.bodyWidthMm * 0.5;
  const halfD = v.bodyDepthMm * 0.5;
  let effectiveH = v.bodyHeightMm;

  if (v.compressionFactor && v.compressionFactor < 1) {
    const antFactor = v.compressionFactor;
    const postFactor = Math.min(1, v.compressionFactor + 0.24);
    const apT = Math.max(0, Math.min(1, (ly + halfD) / (2 * halfD)));
    effectiveH = v.bodyHeightMm * (antFactor + (postFactor - antFactor) * apT);
  }

  const halfH = effectiveH * 0.5;
  if (Math.abs(lz) > halfH + 3.5) {
    return { inside: false, distToSurface: 99, isEndplate: false };
  }

  const zNorm = Math.min(1, Math.abs(lz) / Math.max(1, halfH));
  const waistScale = 0.91 + 0.09 * zNorm * zNorm;

  const osteo = v.osteophyteScore ?? 0;
  const endplateFlare = osteo > 0 ? osteo * 2.8 * Math.pow(zNorm, 4) : 0;

  const rx = halfW * waistScale + endplateFlare * 0.6;
  const ry = halfD * waistScale + (ly < 0 ? endplateFlare : 0);

  const canalIndent = ly > 0 ? Math.exp(-(lx * lx) / (2 * (halfW * 0.42) ** 2)) * (halfD * 0.28) : 0;
  const adjustedY = ly + canalIndent;

  const radial = Math.sqrt((lx / rx) ** 2 + (adjustedY / ry) ** 2);
  const radDist = (1 - radial) * Math.min(rx, ry);
  const zDist = halfH - Math.abs(lz);

  const distToSurface = Math.min(radDist, zDist);
  const inside = distToSurface >= 0;
  const isEndplate = zDist <= 2.3;

  return { inside, distToSurface, isEndplate };
}

function getBodyEnvelopeAtZ(
  study: SpineStudyConfig,
  zMm: number
): { rx: number; ry: number; centerY: number; isHead: boolean; isNeck: boolean; isPelvis: boolean } {
  if (study.id === 'full-spine') {
    if (zMm > 165) {
      // Head / Cranium silhouette
      const dz = (zMm - 238) / 86;
      const taper = Math.sqrt(Math.max(0.18, 1 - Math.min(0.88, dz * dz * 0.72)));
      return { rx: 86 * taper, ry: 102 * taper, centerY: -12, isHead: true, isNeck: false, isPelvis: false };
    }
    if (zMm > 74) {
      // Neck
      return { rx: 56, ry: 58, centerY: -4, isHead: false, isNeck: true, isPelvis: false };
    }
    if (zMm > 30) {
      // Shoulder transition
      const t = (74 - zMm) / 44;
      return {
        rx: 56 + t * 102,
        ry: 58 + t * 42,
        centerY: -4 + t * 8,
        isHead: false,
        isNeck: false,
        isPelvis: false,
      };
    }
    if (zMm > -180) {
      // Thorax -> Waist -> Upper Pelvis
      const waistDip = Math.exp(-((zMm + 110) ** 2) / (2 * 45 * 45)) * 22;
      return { rx: 154 - waistDip, ry: 100 - waistDip * 0.4, centerY: 4, isHead: false, isNeck: false, isPelvis: false };
    }
    // Pelvis / Hips / Upper Thighs
    return { rx: 162, ry: 104, centerY: 4, isHead: false, isNeck: false, isPelvis: true };
  }

  if (study.id === 'cervical-stenosis') {
    if (zMm > 8) {
      const dz = (zMm - 68) / 82;
      const taper = Math.sqrt(Math.max(0.25, 1 - Math.min(0.82, dz * dz * 0.6)));
      return { rx: 84 * taper, ry: 98 * taper, centerY: -12, isHead: true, isNeck: false, isPelvis: false };
    }
    return { rx: 58, ry: 56, centerY: 2, isHead: false, isNeck: true, isPelvis: false };
  }

  if (study.id === 'lumbar-hernia') {
    const isPelvis = zMm < -60;
    return { rx: isPelvis ? 156 : 132, ry: isPelvis ? 96 : 88, centerY: 4, isHead: false, isNeck: false, isPelvis };
  }

  return { rx: 86, ry: 76, centerY: 2, isHead: false, isNeck: false, isPelvis: false };
}

export function getOrGenerateCTVolume(study: SpineStudyConfig): CTVolume {
  const cached = volumeCache.get(study.id);
  if (cached) return cached;

  const { nx, ny, nz, spacingX, spacingY, spacingZ } = study.volumeDims;
  const originX = -((nx - 1) * spacingX) / 2;
  const originY = -((ny - 1) * spacingY) / 2;
  const originZ = -((nz - 1) * spacingZ) / 2;

  const data = new Int16Array(nx * ny * nz);

  // 1. Base Soft Tissue, Muscles, Lungs/Viscera & Air Envelope
  for (let iz = 0; iz < nz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const env = getBodyEnvelopeAtZ(study, zMm);

    for (let iy = 0; iy < ny; iy++) {
      const yMm = originY + iy * spacingY;
      const dyBody = (yMm - env.centerY) / env.ry;

      for (let ix = 0; ix < nx; ix++) {
        const xMm = originX + ix * spacingX;
        const dxBody = xMm / env.rx;
        const ellip = dxBody * dxBody + dyBody * dyBody;
        const idx = iz * nx * ny + iy * nx + ix;

        if (ellip > 1.0) {
          data[idx] = -1000;
          continue;
        }

        if (ellip > 0.8) {
          data[idx] = Math.round(-88 + (hash3(ix, iy, iz) - 0.5) * 14);
          continue;
        }

        let hu = env.isNeck ? 38 : 26;

        // Bilateral lungs in thoracic zone of full-spine CT!
        if (study.id === 'full-spine' && zMm <= 45 && zMm >= -72) {
          const lungL = ((xMm + 62) / 44) ** 2 + ((yMm + 8) / 52) ** 2;
          const lungR = ((xMm - 62) / 44) ** 2 + ((yMm + 8) / 52) ** 2;
          if (lungL < 1.0 || lungR < 1.0) {
            hu = -780;
          }
          // Heart / Mediastinum anteriorly
          const heart = ((xMm - 10) / 34) ** 2 + ((yMm + 36) / 28) ** 2;
          if (heart < 1.0 && zMm < 8 && zMm > -55) {
            hu = 42;
          }
        }

        // Paraspinal erector spinae / neck muscles
        const erectorL = ((xMm + (env.isNeck ? 16 : 24)) / (env.isNeck ? 14 : 20)) ** 2 + ((yMm - (env.isNeck ? 22 : 34)) / (env.isNeck ? 14 : 20)) ** 2;
        const erectorR = ((xMm - (env.isNeck ? 16 : 24)) / (env.isNeck ? 14 : 20)) ** 2 + ((yMm - (env.isNeck ? 22 : 34)) / (env.isNeck ? 14 : 20)) ** 2;
        if (!env.isHead && (erectorL < 1.0 || erectorR < 1.0)) {
          hu = 48;
        }

        // Psoas & abdominal aorta in lumbar region
        if (!env.isHead && !env.isNeck && zMm < -60 && zMm > -215) {
          const psoasL = ((xMm + 34) / 16) ** 2 + ((yMm + 8) / 16) ** 2;
          const psoasR = ((xMm - 34) / 16) ** 2 + ((yMm + 8) / 16) ** 2;
          if (psoasL < 1.0 || psoasR < 1.0) hu = 50;

          const aortaR = Math.hypot(xMm + 8, yMm + 44);
          if (aortaR < 8.5) hu = aortaR > 7.1 ? 165 : 40;
          const ivcR = Math.hypot(xMm - 11, yMm + 42);
          if (ivcR < 8.0) hu = 38;
        } else if (env.isNeck) {
          const tracheaR = Math.hypot(xMm, yMm + 30);
          if (tracheaR < 8.2) hu = -960;
        }

        data[idx] = Math.round(hu + (hash3(ix, iy, iz) - 0.5) * 14);
      }
    }
  }

  // 2. Spinal canal & dural sac continuous tube
  for (let iz = 0; iz < nz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const zStart = study.vertebrae[study.vertebrae.length - 1].centerMm.z - 20;
    const zEnd = study.vertebrae[0].centerMm.z + 20;
    if (zMm < zStart || zMm > zEnd) continue;

    let bestW = 0;
    let spineY = -14;
    let isCervicalZ = false;
    for (const v of study.vertebrae) {
      const dz = zMm - v.centerMm.z;
      const w = Math.exp(-(dz * dz) / (2 * 24 * 24));
      if (w > 0.001) {
        if (bestW === 0) spineY = 0;
        spineY += (v.centerMm.y + v.bodyDepthMm * 0.5 + v.canalApMm * 0.5) * w;
        bestW += w;
        if (dz < 14 && v.region === 'cervical') isCervicalZ = true;
      }
    }
    if (bestW > 0.001) spineY /= bestW;

    const canalRx = isCervicalZ ? 11.5 : 12.0;
    const canalRy = isCervicalZ ? 7.2 : 8.5;
    const minIx = Math.max(0, Math.floor(((-canalRx - 2) - originX) / spacingX));
    const maxIx = Math.min(nx - 1, Math.ceil(((canalRx + 2) - originX) / spacingX));
    const minIy = Math.max(0, Math.floor(((spineY - canalRy - 2) - originY) / spacingY));
    const maxIy = Math.min(ny - 1, Math.ceil(((spineY + canalRy + 2) - originY) / spacingY));

    for (let iy = minIy; iy <= maxIy; iy++) {
      const yMm = originY + iy * spacingY;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMm = originX + ix * spacingX;
        const cNorm = (xMm / canalRx) ** 2 + ((yMm - spineY) / canalRy) ** 2;
        if (cNorm <= 1.0) {
          const idx = iz * nx * ny + iy * nx + ix;
          data[idx] = cNorm < 0.72 ? 14 : -62;
        }
      }
    }
  }

  // 3. Skull (Cráneo) when enabled
  if (study.hasSkull && study.skullCenterMm) {
    stampSkullIntoVolume(study.skullCenterMm, data, nx, ny, nz, originX, originY, originZ, spacingX, spacingY, spacingZ);
  }

  // 4. Pelvis & Hips (Cadera) when enabled
  if (study.hasPelvis && study.pelvisCenterMm) {
    stampPelvisIntoVolume(study.pelvisCenterMm, data, nx, ny, nz, originX, originY, originZ, spacingX, spacingY, spacingZ);
  }

  // 5. Intervertebral Discs & Vertebrae
  for (const d of study.discs) {
    stampDiscIntoVolume(d, data, nx, ny, nz, originX, originY, originZ, spacingX, spacingY, spacingZ);
  }
  for (const v of study.vertebrae) {
    stampVertebraIntoVolume(v, data, nx, ny, nz, originX, originY, originZ, spacingX, spacingY, spacingZ);
  }

  // 6. Optional Ribs / Clavicles hint in full-spine thoracic segment for anatomical realism
  if (study.id === 'full-spine') {
    stampRibCageHint(data, nx, ny, nz, originX, originY, originZ, spacingX, spacingY, spacingZ);
  }

  const volume: CTVolume = {
    studyId: study.id,
    nx,
    ny,
    nz,
    spacingX,
    spacingY,
    spacingZ,
    originX,
    originY,
    originZ,
    data,
  };

  volumeCache.set(study.id, volume);
  return volume;
}

function stampSkullIntoVolume(
  center: { x: number; y: number; z: number },
  data: Int16Array,
  nx: number,
  ny: number,
  nz: number,
  originX: number,
  originY: number,
  originZ: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number
) {
  const rx = 74;
  const ry = 88;
  const rz = 72;
  const minIx = Math.max(0, Math.floor((center.x - rx - 8 - originX) / spacingX));
  const maxIx = Math.min(nx - 1, Math.ceil((center.x + rx + 8 - originX) / spacingX));
  const minIy = Math.max(0, Math.floor((center.y - ry - 20 - originY) / spacingY));
  const maxIy = Math.min(ny - 1, Math.ceil((center.y + ry + 8 - originY) / spacingY));
  const minIz = Math.max(0, Math.floor((center.z - rz - 50 - originZ) / spacingZ));
  const maxIz = Math.min(nz - 1, Math.ceil((center.z + rz + 8 - originZ) / spacingZ));

  for (let iz = minIz; iz <= maxIz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const dz = zMm - center.z;
    for (let iy = minIy; iy <= maxIy; iy++) {
      const yMm = originY + iy * spacingY;
      const dy = yMm - center.y;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMm = originX + ix * spacingX;
        const dx = xMm - center.x;
        const idx = iz * nx * ny + iy * nx + ix;

        // Cranial vault (neurocranium)
        const rNorm = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2 + ((dz - 14) / rz) ** 2);
        // Foramen magnum opening at inferior base
        const inForamenMagnum = dz < -36 && dz > -68 && Math.hypot(dx, dy - 6) < 16;

        if (rNorm <= 1.0 && dz > -52 && !inForamenMagnum) {
          if (rNorm >= 0.87) {
            data[idx] = Math.round(1220 + (hash3(ix, iy, iz) - 0.5) * 160);
          } else {
            // Brain parenchyma + lateral ventricles
            const vent = (Math.abs(dx) < 16 && Math.abs(dy) < 28 && dz > 0 && dz < 26);
            data[idx] = vent ? 8 : Math.round(35 + (hash3(ix, iy, iz) - 0.5) * 8);
          }
        }

        // Facial skeleton, orbits, maxillary sinuses & mandible (anterior/inferior)
        if (dz <= -6 && dz >= -62 && dy < -18 && dy > -96) {
          // Bilateral orbits
          const orbL = ((dx + 28) / 16) ** 2 + ((dy + 72) / 18) ** 2 + ((dz + 16) / 14) ** 2;
          const orbR = ((dx - 28) / 16) ** 2 + ((dy + 72) / 18) ** 2 + ((dz + 16) / 14) ** 2;
          if (orbL < 1.0 || orbR < 1.0) {
            data[idx] = orbL > 0.82 || orbR > 0.82 ? 1050 : 6;
            continue;
          }

          // Nasal cavity & maxillary sinuses (air-filled)
          if (Math.abs(dx) < 24 && dy < -56 && dy > -88 && dz < -18 && dz > -44) {
            data[idx] = Math.abs(dx) < 3 ? 650 : -920;
            continue;
          }

          // Mandibular U-arch (lower jaw)
          const jawArc = Math.abs(Math.hypot(dx * 1.15, (dy + 42) * 0.9) - 44);
          if (dz < -40 && dz > -62 && dy < -12 && jawArc < 5.2) {
            data[idx] = 1120;
          }
        }
      }
    }
  }
}

function stampPelvisIntoVolume(
  center: { x: number; y: number; z: number },
  data: Int16Array,
  nx: number,
  ny: number,
  nz: number,
  originX: number,
  originY: number,
  originZ: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number
) {
  const boundX = 148;
  const boundY = 82;
  const boundZ = 95;
  const minIx = Math.max(0, Math.floor((center.x - boundX - originX) / spacingX));
  const maxIx = Math.min(nx - 1, Math.ceil((center.x + boundX - originX) / spacingX));
  const minIy = Math.max(0, Math.floor((center.y - boundY - originY) / spacingY));
  const maxIy = Math.min(ny - 1, Math.ceil((center.y + boundY - originY) / spacingY));
  const minIz = Math.max(0, Math.floor((center.z - boundZ - originZ) / spacingZ));
  const maxIz = Math.min(nz - 1, Math.ceil((center.z + boundZ - originZ) / spacingZ));

  for (let iz = minIz; iz <= maxIz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const dz = zMm - center.z;
    for (let iy = minIy; iy <= maxIy; iy++) {
      const yMm = originY + iy * spacingY;
      const dy = yMm - center.y;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMm = originX + ix * spacingX;
        const dx = xMm - center.x;
        const absX = Math.abs(dx);
        const idx = iz * nx * ny + iy * nx + ix;

        // Urinary bladder in anterior lower pelvis
        const bladder = (dx / 26) ** 2 + ((dy + 26) / 22) ** 2 + ((dz + 16) / 22) ** 2;
        if (bladder < 1.0) {
          data[idx] = 10;
        }

        // Bilateral Iliac Wings (fanning laterally & superiorly from sacroiliac joint)
        const dIlium = sdCapsule(
          absX,
          dy,
          dz,
          30,
          12,
          14,
          108,
          -14,
          44,
          11
        );
        const dIliumLower = sdCapsule(
          absX,
          dy,
          dz,
          36,
          10,
          8,
          88,
          -6,
          -10,
          12
        );

        // Pubic rami & pubic symphysis anteriorly
        const dPubis = sdCapsule(absX, dy, dz, 2, -46, -24, 72, -16, -20, 7.5);
        // Ischial tuberosities inferior-posteriorly
        const dIschium = sdCapsule(absX, dy, dz, 48, 12, -48, 76, -8, -18, 9.0);

        // Acetabular socket & Femoral Head + Neck + Proximal Shaft!
        const hipCenterX = 88;
        const hipCenterY = -10;
        const hipCenterZ = -22;
        const femHeadDist = Math.hypot(absX - hipCenterX, dy - hipCenterY, dz - hipCenterZ);
        const dFemNeck = sdCapsule(
          absX,
          dy,
          dz,
          hipCenterX,
          hipCenterY,
          hipCenterZ,
          hipCenterX + 34,
          hipCenterY + 6,
          hipCenterZ - 26,
          10.5
        );
        const dFemShaft = sdCapsule(
          absX,
          dy,
          dz,
          hipCenterX + 34,
          hipCenterY + 6,
          hipCenterZ - 26,
          hipCenterX + 32,
          hipCenterY + 4,
          hipCenterZ - 85,
          13.0
        );

        const minBoneDist = Math.min(dIlium, dIliumLower, dPubis, dIschium, dFemNeck, dFemShaft);

        if (femHeadDist <= 22 || minBoneDist <= 0) {
          const surfaceDist = femHeadDist <= 22 ? Math.min(22 - femHeadDist, -minBoneDist) : -minBoneDist;
          const grain = (smoothNoise3(xMm * 0.25, yMm * 0.25, zMm * 0.25) - 0.5) * 140;
          const hu = surfaceDist < 2.6 ? 1120 + grain : 310 + grain;
          data[idx] = Math.round(Math.max(data[idx], hu));
        }
      }
    }
  }
}

function stampRibCageHint(
  data: Int16Array,
  nx: number,
  ny: number,
  nz: number,
  originX: number,
  originY: number,
  originZ: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number
) {
  // Subtle posterior rib arcs + sternum for realistic thoracic Coronal/Axial CT views
  for (let iz = 0; iz < nz; iz++) {
    const zMm = originZ + iz * spacingZ;
    if (zMm > 52 || zMm < -65) continue;

    // Periodic rib rings every ~22 mm vertically
    const ribPhase = Math.abs(((zMm + 120) % 22) - 11);
    if (ribPhase > 3.8) continue;

    for (let iy = 0; iy < ny; iy++) {
      const yMm = originY + iy * spacingY;
      for (let ix = 0; ix < nx; ix++) {
        const xMm = originX + ix * spacingX;
        const rEllip = Math.sqrt((xMm / 114) ** 2 + ((yMm + 8) / 74) ** 2);
        if (Math.abs(rEllip - 1.0) < 0.045 && Math.abs(xMm) > 18) {
          const idx = iz * nx * ny + iy * nx + ix;
          data[idx] = Math.max(data[idx], 880);
        }
      }
    }
  }
}

function stampDiscIntoVolume(
  d: DiscSpec,
  data: Int16Array,
  nx: number,
  ny: number,
  nz: number,
  originX: number,
  originY: number,
  originZ: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number
) {
  const halfW = d.widthMm * 0.5;
  const halfD = d.depthMm * 0.5;
  const halfH = d.heightMm * 0.5;
  const cosP = Math.cos(d.pitchRad);
  const sinP = Math.sin(d.pitchRad);

  const boundR = Math.max(halfW, halfD) + (d.herniationMm ?? 0) + 6;
  const minIx = Math.max(0, Math.floor((d.centerMm.x - boundR - originX) / spacingX));
  const maxIx = Math.min(nx - 1, Math.ceil((d.centerMm.x + boundR - originX) / spacingX));
  const minIy = Math.max(0, Math.floor((d.centerMm.y - boundR - originY) / spacingY));
  const maxIy = Math.min(ny - 1, Math.ceil((d.centerMm.y + boundR + 14 - originY) / spacingY));
  const minIz = Math.max(0, Math.floor((d.centerMm.z - halfH - 8 - originZ) / spacingZ));
  const maxIz = Math.min(nz - 1, Math.ceil((d.centerMm.z + halfH + 8 - originZ) / spacingZ));

  for (let iz = minIz; iz <= maxIz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const dz = zMm - d.centerMm.z;
    for (let iy = minIy; iy <= maxIy; iy++) {
      const yMm = originY + iy * spacingY;
      const dy = yMm - d.centerMm.y;
      const ly = dy * cosP - dz * sinP;
      const lz = dy * sinP + dz * cosP;

      if (Math.abs(lz) > halfH + 1.2) continue;

      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMm = originX + ix * spacingX;
        const lx = xMm - d.centerMm.x;

        const canalIndent = ly > 0 ? Math.exp(-(lx * lx) / (2 * (halfW * 0.42) ** 2)) * (halfD * 0.25) : 0;
        const normR = Math.sqrt((lx / halfW) ** 2 + ((ly + canalIndent) / halfD) ** 2);

        const inDisc = normR <= 1.0 && Math.abs(lz) <= halfH;
        let isHernia = false;

        if (!inDisc && d.herniationMm && d.herniationMm > 0) {
          const hxOffset = d.herniationSide === 'right' ? -7.5 : d.herniationSide === 'left' ? 7.5 : 0;
          const hyCenter = halfD * 0.72 + d.herniationMm * 0.45;
          const hDist = Math.sqrt(
            ((lx - hxOffset) / 6.8) ** 2 +
              ((ly - hyCenter) / (d.herniationMm * 0.75)) ** 2 +
              (lz / (halfH * 0.92)) ** 2
          );
          if (hDist <= 1.0) isHernia = true;
        }

        if (inDisc || isHernia) {
          const idx = iz * nx * ny + iy * nx + ix;
          const degen = d.degeneration ?? 0;
          const baseHu = isHernia ? 88 : normR < 0.55 ? 58 - degen * 12 : 84 + degen * 18;
          if (degen > 0.75 && normR < 0.35 && Math.abs(lz) < 1.0) {
            data[idx] = -260;
          } else {
            data[idx] = Math.round(baseHu + (hash3(ix, iy, iz) - 0.5) * 14);
          }
        }
      }
    }
  }
}

function stampVertebraIntoVolume(
  v: VertebraSpec,
  data: Int16Array,
  nx: number,
  ny: number,
  nz: number,
  originX: number,
  originY: number,
  originZ: number,
  spacingX: number,
  spacingY: number,
  spacingZ: number
) {
  const cosP = Math.cos(v.pitchRad);
  const sinP = Math.sin(v.pitchRad);
  const cosR = Math.cos(v.rollRad);
  const sinR = Math.sin(v.rollRad);

  const halfW = v.bodyWidthMm * 0.5;
  const halfD = v.bodyDepthMm * 0.5;
  const isCervical = v.region === 'cervical';
  const isSacral = v.region === 'sacral';

  const pedicleYStart = halfD * 0.65;
  const pedicleYEnd = halfD + v.canalApMm * 0.58;
  const pedicleX = isCervical ? halfW * 0.76 : halfW * 0.66;
  const pedicleR = isCervical ? 3.2 : 5.2;

  const laminaApexY = halfD + v.canalApMm + (isCervical ? 4.5 : 7.0);
  const laminaR = isCervical ? 2.8 : 4.2;

  const spinousTipY = laminaApexY + (isCervical ? 14 : isSacral ? 12 : 24);
  const spinousTipZ = isCervical ? -4 : isSacral ? -6 : -8;
  const spinousR = isCervical ? 2.6 : 3.6;

  const transX = halfW + (isCervical ? 8 : isSacral ? 18 : 19);
  const transY = pedicleYEnd + 2;
  const transR = isCervical ? 2.6 : 3.8;

  const boundX = transX + 6;
  const boundYMin = -halfD - 8;
  const boundYMax = spinousTipY + 6;
  const boundZ = v.bodyHeightMm * 0.5 + 14;

  const minIx = Math.max(0, Math.floor((v.centerMm.x - boundX - originX) / spacingX));
  const maxIx = Math.min(nx - 1, Math.ceil((v.centerMm.x + boundX - originX) / spacingX));
  const minIy = Math.max(0, Math.floor((v.centerMm.y + boundYMin - originY) / spacingY));
  const maxIy = Math.min(ny - 1, Math.ceil((v.centerMm.y + boundYMax - originY) / spacingY));
  const minIz = Math.max(0, Math.floor((v.centerMm.z - boundZ - originZ) / spacingZ));
  const maxIz = Math.min(nz - 1, Math.ceil((v.centerMm.z + boundZ - originZ) / spacingZ));

  for (let iz = minIz; iz <= maxIz; iz++) {
    const zMm = originZ + iz * spacingZ;
    const dz = zMm - v.centerMm.z;
    for (let iy = minIy; iy <= maxIy; iy++) {
      const yMm = originY + iy * spacingY;
      const dy = yMm - v.centerMm.y;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const xMm = originX + ix * spacingX;
        const dx = xMm - v.centerMm.x;

        const rx = dx * cosR - dz * sinR;
        const rz0 = dx * sinR + dz * cosR;
        const ly = dy * cosP - rz0 * sinP;
        const lz = dy * sinP + rz0 * cosP;

        const bodyCheck = vertebralBodyField(rx, ly, lz, v);

        let archDist = 99;
        if (ly >= pedicleYStart - 3) {
          const dPedL = sdCapsule(rx, ly, lz, -pedicleX, pedicleYStart, 2, -pedicleX * 1.02, pedicleYEnd, 1, pedicleR);
          const dPedR = sdCapsule(rx, ly, lz, pedicleX, pedicleYStart, 2, pedicleX * 1.02, pedicleYEnd, 1, pedicleR);
          const dLamL = sdCapsule(rx, ly, lz, -pedicleX * 1.02, pedicleYEnd, 1, 0, laminaApexY, -1, laminaR);
          const dLamR = sdCapsule(rx, ly, lz, pedicleX * 1.02, pedicleYEnd, 1, 0, laminaApexY, -1, laminaR);
          const dSpin = sdCapsule(rx, ly, lz, 0, laminaApexY - 1, -1, 0, spinousTipY, spinousTipZ, spinousR);
          const dTransL = sdCapsule(rx, ly, lz, -pedicleX, pedicleYEnd, 1, -transX, transY + 3, 2, transR);
          const dTransR = sdCapsule(rx, ly, lz, pedicleX, pedicleYEnd, 1, transX, transY + 3, 2, transR);
          const dFacetSupL = sdCapsule(rx, ly, lz, -pedicleX * 0.92, pedicleYEnd + 1, 2, -pedicleX * 0.88, pedicleYEnd + 2, 10, 3.2);
          const dFacetSupR = sdCapsule(rx, ly, lz, pedicleX * 0.92, pedicleYEnd + 1, 2, pedicleX * 0.88, pedicleYEnd + 2, 10, 3.2);
          const dFacetInfL = sdCapsule(rx, ly, lz, -pedicleX * 0.84, pedicleYEnd + 3, -1, -pedicleX * 0.82, pedicleYEnd + 3.5, -10, 3.0);
          const dFacetInfR = sdCapsule(rx, ly, lz, pedicleX * 0.84, pedicleYEnd + 3, -1, pedicleX * 0.82, pedicleYEnd + 3.5, -10, 3.0);

          archDist = Math.min(
            dPedL,
            dPedR,
            dLamL,
            dLamR,
            dSpin,
            dTransL,
            dTransR,
            dFacetSupL,
            dFacetSupR,
            dFacetInfL,
            dFacetInfR
          );
        }

        let inFragment = false;
        let fragmentEdge = false;
        if (v.retropulsionMm && v.retropulsionMm > 0) {
          const fragY = halfD + v.retropulsionMm * 0.55;
          const fragNorm = (rx / (halfW * 0.46)) ** 2 + ((ly - fragY) / (v.retropulsionMm * 0.52)) ** 2 + (lz / 6.5) ** 2;
          if (fragNorm <= 1.0) {
            inFragment = true;
            fragmentEdge = fragNorm > 0.65;
          }
        }

        if (!bodyCheck.inside && archDist > 0 && !inFragment) continue;

        const idx = iz * nx * ny + iy * nx + ix;
        const trabecularPattern = smoothNoise3(xMm * 0.35, yMm * 0.35, zMm * 0.35);

        let boneHu = v.trabecularHu + (trabecularPattern - 0.5) * 140;

        if (bodyCheck.inside) {
          if (bodyCheck.distToSurface < 2.2 || bodyCheck.isEndplate) {
            boneHu = 1080 + (trabecularPattern - 0.5) * 260;
          }
          if (Math.abs(lz) < 2.2 && ly > 0 && ly < halfD * 0.9 && Math.abs(rx) < 3.0) {
            boneHu = 110;
          }
          if (v.compressionFactor && v.compressionFactor < 0.8) {
            const cleftA = Math.abs(rx * 0.7 + ly * 0.6 - 2.5);
            const cleftB = Math.abs(rx * 0.5 - ly * 0.8 + 4.0);
            if (cleftA < 1.1 || cleftB < 1.0) {
              boneHu = 65;
            }
          }
        }

        if (archDist <= 0) {
          const archSurfaceDist = -archDist;
          if (archSurfaceDist < 1.8) {
            boneHu = 1150 + (trabecularPattern - 0.5) * 220;
          } else {
            boneHu = Math.max(boneHu, v.trabecularHu + 60 + (trabecularPattern - 0.5) * 120);
          }
        }

        if (inFragment) {
          boneHu = fragmentEdge ? 1240 : 480;
        }

        data[idx] = Math.round(Math.max(data[idx], boneHu));
      }
    }
  }
}

export interface ExtractedSlice {
  width: number;
  height: number;
  huValues: Int16Array;
  pixelSpacingU: number;
  pixelSpacingV: number;
  sliceCoordMm: number;
  originUMm: number;
  originVMm: number;
}

export function extractMprSlice(
  volume: CTVolume,
  plane: SlicePlane,
  sliceIndex: number
): ExtractedSlice {
  const { nx, ny, nz, spacingX, spacingY, spacingZ, originX, originY, originZ, data } = volume;

  if (plane === 'axial') {
    const iz = Math.max(0, Math.min(nz - 1, sliceIndex));
    const huValues = new Int16Array(nx * ny);
    const offset = iz * nx * ny;
    huValues.set(data.subarray(offset, offset + nx * ny));
    return {
      width: nx,
      height: ny,
      huValues,
      pixelSpacingU: spacingX,
      pixelSpacingV: spacingY,
      sliceCoordMm: originZ + iz * spacingZ,
      originUMm: originX,
      originVMm: originY,
    };
  }

  if (plane === 'coronal') {
    const iy = Math.max(0, Math.min(ny - 1, sliceIndex));
    const huValues = new Int16Array(nx * nz);
    for (let row = 0; row < nz; row++) {
      const iz = nz - 1 - row;
      const srcBase = iz * nx * ny + iy * nx;
      const dstBase = row * nx;
      for (let ix = 0; ix < nx; ix++) {
        huValues[dstBase + ix] = data[srcBase + ix];
      }
    }
    return {
      width: nx,
      height: nz,
      huValues,
      pixelSpacingU: spacingX,
      pixelSpacingV: spacingZ,
      sliceCoordMm: originY + iy * spacingY,
      originUMm: originX,
      originVMm: originZ + (nz - 1) * spacingZ,
    };
  }

  const ix = Math.max(0, Math.min(nx - 1, sliceIndex));
  const huValues = new Int16Array(ny * nz);
  for (let row = 0; row < nz; row++) {
    const iz = nz - 1 - row;
    const dstBase = row * ny;
    for (let iy = 0; iy < ny; iy++) {
      huValues[dstBase + iy] = data[iz * nx * ny + iy * nx + ix];
    }
  }
  return {
    width: ny,
    height: nz,
    huValues,
    pixelSpacingU: spacingY,
    pixelSpacingV: spacingZ,
    sliceCoordMm: originX + ix * spacingX,
    originUMm: originY,
    originVMm: originZ + (nz - 1) * spacingZ,
  };
}

export function renderSliceToImageData(
  slice: ExtractedSlice,
  ww: number,
  wl: number,
  invert: boolean,
  acquisition?: CtAcquisitionParams
): ImageData {
  const { width, height, huValues } = slice;
  const img = new ImageData(width, height);
  const out = img.data;
  const low = wl - ww * 0.5;
  const invWw = 1 / Math.max(1, ww);

  // Simulate quantum mottle noise from kVp / mAs / slice thickness in CT Simulator
  let noiseAmp = 0;
  if (acquisition) {
    const doseFactor = (240 / Math.max(40, acquisition.mas)) * (120 / acquisition.kvp);
    const thickFactor = 1.25 / acquisition.sliceThicknessMm;
    noiseAmp = Math.max(0, (doseFactor * thickFactor - 1.0) * 55);
  }

  for (let i = 0; i < huValues.length; i++) {
    let val = huValues[i];
    if (noiseAmp > 1) {
      const pseudo = (((i * 2654435761) >>> 16) & 255) / 255 - 0.5;
      val += pseudo * noiseAmp;
    }
    let norm = (val - low) * invWw;
    if (norm < 0) norm = 0;
    else if (norm > 1) norm = 1;
    if (invert) norm = 1 - norm;
    const g = Math.round(norm * 255);
    const p = i * 4;
    out[p] = g;
    out[p + 1] = g;
    out[p + 2] = g;
    out[p + 3] = 255;
  }
  return img;
}

export function classifyHuTissue(hu: number): string {
  if (hu < -500) return 'Aire / Pulmón';
  if (hu < -30) return 'Tejido adiposo';
  if (hu < 28) return 'LCR / Líquido';
  if (hu < 110) return 'Tejido blando / Disco';
  if (hu < 500) return 'Hueso trabecular';
  return 'Hueso cortical';
}

export function computeCircularRoiStats(
  slice: ExtractedSlice,
  centerU: number,
  centerV: number,
  edgeU: number,
  edgeV: number
): { areaMm2: number; meanHu: number; minHu: number; maxHu: number; stdHu: number } {
  const dxMm = (edgeU - centerU) * slice.width * slice.pixelSpacingU;
  const dyMm = (edgeV - centerV) * slice.height * slice.pixelSpacingV;
  const radiusMm = Math.max(2.5, Math.sqrt(dxMm * dxMm + dyMm * dyMm));
  const areaMm2 = Math.PI * radiusMm * radiusMm;

  const cxPx = centerU * slice.width;
  const cyPx = centerV * slice.height;
  const rxPx = radiusMm / slice.pixelSpacingU;
  const ryPx = radiusMm / slice.pixelSpacingV;

  const x0 = Math.max(0, Math.floor(cxPx - rxPx));
  const x1 = Math.min(slice.width - 1, Math.ceil(cxPx + rxPx));
  const y0 = Math.max(0, Math.floor(cyPx - ryPx));
  const y1 = Math.min(slice.height - 1, Math.ceil(cyPx + ryPx));

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let minHu = 30000;
  let maxHu = -30000;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nd = ((x - cxPx) / rxPx) ** 2 + ((y - cyPx) / ryPx) ** 2;
      if (nd <= 1.0) {
        const val = slice.huValues[y * slice.width + x];
        sum += val;
        sumSq += val * val;
        if (val < minHu) minHu = val;
        if (val > maxHu) maxHu = val;
        count++;
      }
    }
  }

  if (count === 0) {
    return { areaMm2, meanHu: 0, minHu: 0, maxHu: 0, stdHu: 0 };
  }
  const meanHu = sum / count;
  const variance = Math.max(0, sumSq / count - meanHu * meanHu);
  return {
    areaMm2,
    meanHu,
    minHu,
    maxHu,
    stdHu: Math.sqrt(variance),
  };
}
