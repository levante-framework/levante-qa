/**
 * Deterministic, pixel-based solver for Mental Rotation items — the "authentic"
 * oracle. Instead of reading the app's `.correct` key, it independently decides
 * which choice is the target under a PURE ROTATION (vs. the mirror distractor),
 * straight from the silhouette images.
 *
 * The trick mirrors how the task is built: of the two choices, one is the target
 * shape rotated, the other is its mirror image. A pure rotation preserves
 * chirality; a reflection flips it. So for each choice we measure how well the
 * target overlaps it under rotation ALONE vs. under reflection+rotation, and pick
 * the choice that is best explained by rotation only:
 *
 *   score(choice) = max_theta IoU(R_theta(target), choice)
 *                 - max_theta IoU(R_theta(mirror(target)), choice)
 *
 * The rotation-correct choice scores high-positive (matches the un-mirrored
 * target); the mirror distractor scores negative (only matches the mirrored
 * target). argmax(score) is the answer. The spec cross-checks this against the
 * app's `.correct` key and logs disagreements — a true differential test.
 *
 * Images are public black-on-white silhouettes (.webp) from levante-assets-dev;
 * sizes differ by family (380/756/980 px), so each mask is normalized to be
 * translation- and scale-invariant (centroid-centered, radius-of-gyration scaled)
 * before matching. Decoded masks are cached by URL.
 */
import sharp from 'sharp';

export interface MentalRotationSolveRequest {
  targetUrl: string;
  choiceUrls: string[];
  /** Rotation search step in degrees (default 6). */
  angleStepDeg?: number;
  /** Normalized mask resolution (default 88). */
  gridN?: number;
}

export interface ChoiceScore {
  rot: number;
  mirror: number;
  score: number;
}

export interface MentalRotationSolveResult {
  /** Predicted choice index (best explained by rotation alone), or -1. */
  index: number;
  perChoice: ChoiceScore[];
  /** Winner score minus runner-up score; small ⇒ ambiguous item. */
  margin: number;
  angleStepDeg: number;
  gridN: number;
  error?: string;
}

/** A normalized binary mask: Uint8Array of length N*N (1 = foreground). */
interface NormMask {
  n: number;
  data: Uint8Array;
}

const maskCache = new Map<string, NormMask | null>();
// Foreground = dark pixels (shapes are black-on-white after flattening on white).
const DARK_THRESHOLD = 140;
// Target radius of gyration in the normalized canvas (fraction of N).
const RG_FRACTION = 0.3;

async function decodeMask(url: string, n: number): Promise<NormMask | null> {
  const cached = maskCache.get(url);
  if (cached !== undefined) return cached;

  let norm: NormMask | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { data, info } = await sharp(buf)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // Detect foreground polarity from the border: the shape is whatever differs
    // from the (uniform) background. Targets are black-on-white, but the
    // silhouette choices are INVERTED (white shape on a black canvas), so a fixed
    // "dark = shape" rule would capture the background. Sample the four edges.
    let borderSum = 0;
    let borderN = 0;
    for (let x = 0; x < w; x++) {
      borderSum += data[x] + data[(h - 1) * w + x];
      borderN += 2;
    }
    for (let y = 0; y < h; y++) {
      borderSum += data[y * w] + data[y * w + (w - 1)];
      borderN += 2;
    }
    const bgIsLight = borderSum / borderN > 128;
    // Foreground test: opposite side of the threshold from the background.
    const isFg = (v: number): boolean => (bgIsLight ? v < DARK_THRESHOLD : v > 255 - DARK_THRESHOLD);

    // Foreground stats: centroid + second moment (radius of gyration).
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (isFg(data[row + x])) {
          count++;
          sumX += x;
          sumY += y;
        }
      }
    }
    if (count === 0) {
      maskCache.set(url, null);
      return null;
    }
    const cx = sumX / count;
    const cy = sumY / count;
    let sumR2 = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (isFg(data[row + x])) {
          sumR2 += (x - cx) * (x - cx) + (y - cy) * (y - cy);
        }
      }
    }
    const rg = Math.sqrt(sumR2 / count) || 1;

    // Inverse-map each normalized pixel back into the source so the shape is
    // centroid-centered and scaled to a fixed radius of gyration (≈ scale- and
    // translation-invariant). Rotation is applied later, on this canvas.
    const scale = (n * RG_FRACTION) / rg; // source px per normalized px = 1/scale
    const inv = 1 / scale;
    const half = n / 2;
    const out = new Uint8Array(n * n);
    for (let v = 0; v < n; v++) {
      const sy = cy + (v - half) * inv;
      const syi = Math.round(sy);
      if (syi < 0 || syi >= h) continue;
      const srow = syi * w;
      const orow = v * n;
      for (let u = 0; u < n; u++) {
        const sx = cx + (u - half) * inv;
        const sxi = Math.round(sx);
        if (sxi < 0 || sxi >= w) continue;
        if (isFg(data[srow + sxi])) out[orow + u] = 1;
      }
    }
    norm = { n, data: out };
  } catch (err) {
    norm = null;
    void err;
  }
  maskCache.set(url, norm);
  return norm;
}

/** Horizontal flip (reflection); any reflection axis is equivalent under the
 * full rotation search that follows. */
function mirrorMask(mask: NormMask): NormMask {
  const { n, data } = mask;
  const out = new Uint8Array(n * n);
  for (let v = 0; v < n; v++) {
    const row = v * n;
    for (let u = 0; u < n; u++) {
      out[row + (n - 1 - u)] = data[row + u];
    }
  }
  return { n, data: out };
}

/** IoU of `src` rotated by `theta` (radians, about the canvas center) against
 * the static `dst` mask. Inverse-maps dst pixels into src to avoid holes. */
function rotatedIoU(src: NormMask, dst: NormMask, theta: number): number {
  const n = src.n;
  const half = n / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const s = src.data;
  const d = dst.data;
  let inter = 0;
  let uni = 0;
  for (let v = 0; v < n; v++) {
    const dy = v - half;
    const row = v * n;
    for (let u = 0; u < n; u++) {
      const dx = u - half;
      // Inverse rotation: source coord that maps to (u,v).
      const sx = cos * dx + sin * dy + half;
      const sy = -sin * dx + cos * dy + half;
      const sxi = Math.round(sx);
      const syi = Math.round(sy);
      let srcOn = 0;
      if (sxi >= 0 && sxi < n && syi >= 0 && syi < n) srcOn = s[syi * n + sxi];
      const dstOn = d[row + u];
      if (srcOn || dstOn) {
        uni++;
        if (srcOn && dstOn) inter++;
      }
    }
  }
  return uni === 0 ? 0 : inter / uni;
}

function bestIoUOverRotations(src: NormMask, dst: NormMask, stepDeg: number): number {
  let best = 0;
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const iou = rotatedIoU(src, dst, (deg * Math.PI) / 180);
    if (iou > best) best = iou;
  }
  return best;
}

/**
 * Solve one Mental Rotation item from the target + choice image URLs. Returns the
 * predicted choice index and the per-choice rotation/mirror scores.
 */
export async function solveMentalRotation(
  req: MentalRotationSolveRequest,
): Promise<MentalRotationSolveResult> {
  const angleStepDeg = req.angleStepDeg ?? 6;
  const gridN = req.gridN ?? 88;

  const target = await decodeMask(req.targetUrl, gridN);
  const choices = await Promise.all(req.choiceUrls.map((u) => decodeMask(u, gridN)));

  if (!target || choices.some((c) => !c)) {
    return {
      index: -1,
      perChoice: [],
      margin: 0,
      angleStepDeg,
      gridN,
      error: 'decode_failed',
    };
  }

  const mirroredTarget = mirrorMask(target);
  const perChoice: ChoiceScore[] = choices.map((c) => {
    const choice = c as NormMask;
    const rot = bestIoUOverRotations(target, choice, angleStepDeg);
    const mirror = bestIoUOverRotations(mirroredTarget, choice, angleStepDeg);
    return { rot, mirror, score: rot - mirror };
  });

  let index = -1;
  let best = -Infinity;
  let second = -Infinity;
  perChoice.forEach((c, i) => {
    if (c.score > best) {
      second = best;
      best = c.score;
      index = i;
    } else if (c.score > second) {
      second = c.score;
    }
  });

  return {
    index,
    perChoice,
    margin: second === -Infinity ? best : best - second,
    angleStepDeg,
    gridN,
  };
}

/** Clear the decoded-mask cache (used by tests). */
export function _resetMaskCache(): void {
  maskCache.clear();
}
