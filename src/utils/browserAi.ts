export interface BrowserVisualHints {
  dominantColor?: string;
  surfaceTheme?: 'dark' | 'light';
  width?: number;
  height?: number;
}

export const DEFAULT_GEMINI_BUILDER_MODEL_ID = 'mesh::auto';

export const VALID_GEMINI_MODEL_IDS = [
  'mesh::auto',
  'mesh::fast',
  'mesh::coder',
  'mesh::reasoning',
  'mesh::creative',
] as const;

export function normalizeBuilderModelId(rawId?: string | null): string {
  const trimmed = (rawId || '').trim();
  if (!trimmed) return DEFAULT_GEMINI_BUILDER_MODEL_ID;
  if (trimmed.startsWith('agentrouter::')) return trimmed;
  const matched = VALID_GEMINI_MODEL_IDS.find((id) => id === trimmed);
  // Legacy stored ids (e.g. gemini::gemini-4-hydrogen) map to the free mesh.
  return matched || DEFAULT_GEMINI_BUILDER_MODEL_ID;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  );
}

export async function analyzeAttachmentVisualHints(
  dataUrl?: string | null
): Promise<BrowserVisualHints | null> {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !dataUrl ||
    !dataUrl.startsWith('data:image/')
  ) {
    return null;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => resolve(null), 2200);

    img.onload = () => {
      window.clearTimeout(timer);
      try {
        const w = Math.max(1, img.naturalWidth || img.width || 1);
        const h = Math.max(1, img.naturalHeight || img.height || 1);
        const canvas = document.createElement('canvas');
        const sampleSize = 24;
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ width: w, height: h });
          return;
        }
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const pixels = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

        let lumSum = 0;
        let pixelCount = 0;
        let vividScoreBest = -1;
        let vividR = 124;
        let vividG = 58;
        let vividB = 237;
        let avgR = 0;
        let avgG = 0;
        let avgB = 0;

        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3];
          if (alpha < 40) continue;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          avgR += r;
          avgG += g;
          avgB += b;
          pixelCount += 1;

          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lumSum += lum;

          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          const sat = maxC - minC;
          if (sat > 42 && lum > 25 && lum < 235 && sat > vividScoreBest) {
            vividScoreBest = sat;
            vividR = r;
            vividG = g;
            vividB = b;
          }
        }

        if (pixelCount === 0) {
          resolve({ width: w, height: h });
          return;
        }

        const meanLum = lumSum / pixelCount;
        const dominantColor =
          vividScoreBest > 42
            ? rgbToHex(vividR, vividG, vividB)
            : rgbToHex(avgR / pixelCount, avgG / pixelCount, avgB / pixelCount);

        resolve({
          dominantColor,
          surfaceTheme: meanLum < 118 ? 'dark' : 'light',
          width: w,
          height: h,
        });
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };

    img.src = dataUrl;
  });
}
