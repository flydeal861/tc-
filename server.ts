import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('La clave GEMINI_API_KEY no está configurada en el entorno del servidor.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function stripDataUrlPrefix(dataUrl: string): { mimeType: string; data: string } | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/analyze-spine', async (req, res) => {
    try {
      const {
        studyTitle,
        regionLabel,
        sliceInfo,
        windowSettings,
        measurementsSummary,
        images,
      } = req.body as {
        studyTitle?: string;
        regionLabel?: string;
        sliceInfo?: string;
        windowSettings?: { ww: number; wl: number; preset: string };
        measurementsSummary?: string;
        images?: { axial?: string; coronal?: string; sagittal?: string; view3d?: string };
      };

      const ai = getGeminiClient();

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

      const imageEntries: Array<{ label: string; dataUrl?: string }> = [
        { label: 'Corte Axial (plano XY)', dataUrl: images?.axial },
        { label: 'Corte Coronal (plano XZ)', dataUrl: images?.coronal },
        { label: 'Corte Sagital (plano YZ)', dataUrl: images?.sagittal },
        { label: 'Reconstrucción 3D anatómica', dataUrl: images?.view3d },
      ];

      for (const entry of imageEntries) {
        if (entry.dataUrl) {
          const parsed = stripDataUrlPrefix(entry.dataUrl);
          if (parsed) {
            parts.push({ text: `Imagen diagnóstica — ${entry.label}:` });
            parts.push({ inlineData: parsed });
          }
        }
      }

      if (parts.length === 0) {
        return res.status(400).json({
          error: 'No se recibieron imágenes de corte axial, coronal o sagital para analizar.',
        });
      }

      const prompt = [
        'Actúa como neurorradiólogo especialista en columna vertebral (TC de raquis y reconstrucción multiplanar MPR/3D).',
        'Analiza visualmente las imágenes proporcionadas (cortes axial, coronal, sagital y reconstrucción 3D) y responde SIEMPRE en español médico riguroso.',
        `Estudio activo: ${studyTitle || 'TC de Raquis'} (${regionLabel || 'Columna vertebral'}).`,
        `Posición de cortes actual: ${sliceInfo || 'Estándar'}.`,
        `Ventana TC: ${windowSettings?.preset || 'Ósea'} (WW=${windowSettings?.ww ?? 1800}, WL=${windowSettings?.wl ?? 450} HU).`,
        measurementsSummary
          ? `Mediciones realizadas por el operador: ${measurementsSummary}.`
          : 'Sin mediciones manuales registradas aún.',
        '',
        'Instrucciones de salida:',
        '1. Identifica automáticamente las estructuras óseas y anatómicas visibles en los cortes (cuerpos vertebrales, pedículos, láminas, apófisis espinosas y transversas, canal raquídeo, forámenes intervertebrales, discos, articulaciones facetarias).',
        '2. Detecta posibles patologías visibles en la zona (hernias o protrusiones discales, estenosis de canal, fracturas por compresión o estallido, retropulsión ósea, espondilolistesis, osteofitos marginales, escoliosis, lesiones líticas/blásticas) o indica hallazgo normal si no hay patología significativa.',
        '3. Para cada estructura y patología, proporciona coordenadas normalizadas aproximadas (u, v entre 0.1 y 0.9) sobre el plano más representativo ("axial", "coronal" o "sagittal") y sliceRatio (0.0 a 1.0) para permitir la localización interactiva sobre el visor.',
      ].join('\n');

      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: {
                type: Type.STRING,
                description: 'Impresión radiológica general concisa y profesional en español.',
              },
              alignmentAssessment: {
                type: Type.STRING,
                description: 'Evaluación de la alineación sagital y coronal del raquis.',
              },
              measurementInterpretation: {
                type: Type.STRING,
                description: 'Interpretación anatómica de las mediciones activas o dimensiones clave del canal/cuerpos.',
              },
              structures: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    name: { type: Type.STRING },
                    vertebralLevel: { type: Type.STRING },
                    category: {
                      type: Type.STRING,
                      description: 'Uno de: Óseo, Discal, Canal / Neural, Articular',
                    },
                    estimatedHu: { type: Type.STRING },
                    dimensionsNote: { type: Type.STRING },
                    plane: { type: Type.STRING, description: 'axial, coronal, o sagittal' },
                    u: { type: Type.NUMBER },
                    v: { type: Type.NUMBER },
                    sliceRatio: { type: Type.NUMBER },
                  },
                  required: ['id', 'name', 'vertebralLevel', 'category', 'estimatedHu', 'dimensionsNote', 'plane', 'u', 'v', 'sliceRatio'],
                },
              },
              pathologies: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    location: { type: Type.STRING },
                    severity: {
                      type: Type.STRING,
                      description: 'Uno de: Leve, Moderada, Severa, Hallazgo Normal',
                    },
                    confidencePercent: { type: Type.INTEGER },
                    radiologicalSigns: { type: Type.STRING },
                    clinicalImpact: { type: Type.STRING },
                    recommendation: { type: Type.STRING },
                    plane: { type: Type.STRING, description: 'axial, coronal, o sagittal' },
                    u: { type: Type.NUMBER },
                    v: { type: Type.NUMBER },
                    sliceRatio: { type: Type.NUMBER },
                  },
                  required: [
                    'id',
                    'title',
                    'location',
                    'severity',
                    'confidencePercent',
                    'radiologicalSigns',
                    'clinicalImpact',
                    'recommendation',
                    'plane',
                    'u',
                    'v',
                    'sliceRatio',
                  ],
                },
              },
            },
            required: ['summary', 'alignmentAssessment', 'measurementInterpretation', 'structures', 'pathologies'],
          },
        },
      });

      const rawText = (response.text ?? '{}').trim();
      const parsedJson = JSON.parse(rawText);
      res.json({
        ...parsedJson,
        analyzedAt: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al procesar el análisis de TC con Gemini.';
      console.error('Error /api/analyze-spine:', err);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/ask-radiology', async (req, res) => {
    try {
      const { question, contextSummary, images } = req.body as {
        question: string;
        contextSummary?: string;
        images?: { axial?: string; coronal?: string; sagittal?: string };
      };

      if (!question || !question.trim()) {
        return res.status(400).json({ error: 'Escribe una consulta radiológica.' });
      }

      const ai = getGeminiClient();
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

      if (images?.axial) {
        const p = stripDataUrlPrefix(images.axial);
        if (p) parts.push({ inlineData: p });
      }
      if (images?.sagittal) {
        const p = stripDataUrlPrefix(images.sagittal);
        if (p) parts.push({ inlineData: p });
      }
      if (images?.coronal) {
        const p = stripDataUrlPrefix(images.coronal);
        if (p) parts.push({ inlineData: p });
      }

      parts.push({
        text: [
          'Eres un médico especialista en radiología musculoesquelética y neurorradiología de columna.',
          'Responde de forma clara, precisa y didáctica en español (máximo 150 palabras), basándote en los cortes de TC adjuntos y el contexto del estudio.',
          contextSummary ? `Contexto del estudio: ${contextSummary}` : '',
          `Pregunta: ${question.trim()}`,
        ].join('\n\n'),
      });

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
      });

      res.json({ answer: (response.text ?? '').trim() });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error en la consulta radiológica.';
      console.error('Error /api/ask-radiology:', err);
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RaquisView MPR server listening on http://localhost:${PORT}`);
  });
}

startServer();
