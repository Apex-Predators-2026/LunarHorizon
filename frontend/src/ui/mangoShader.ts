// The "mango mesh": a domain-warped, grainy peach / coral gradient (#FFB08C, #FF634A), drawn by a small
// WebGL fragment shader. Shared by <InteractiveGrainGradient> and the static texture used for sliders.

export const MANGO_VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const MANGO_FRAGMENT = `
precision highp float;
uniform vec2  uRes;       // canvas size in pixels
uniform float uTime;      // seconds (slow)
uniform vec2  uMouse;     // smoothed pointer, 0..1 (y up)
uniform vec2  uVel;       // smoothed pointer velocity
uniform float uInfluence; // 0..1: how much the pointer is near
uniform float uGrain;     // film grain amount
uniform float uScale;     // >1 packs more of the pattern into small elements

const vec3 PEACH = vec3(1.0, 0.690, 0.549);   // #FFB08C
const vec3 CORAL = vec3(1.0, 0.388, 0.290);   // #FF634A

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.02 + 7.1; a *= 0.5; }
  return v;
}
vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  // Pattern units are measured in element heights, never stretched: a longer element simply shows more of
  // the field (and one that grows, like a slider fill, reveals more instead of rescaling it).
  vec2 stretch = vec2(aspect, 1.0);
  vec2 p = (uv * stretch) * uScale - 0.5;

  // ---- Pointer: a gentle disturbance of the liquid under the surface -------------------------------
  // The coordinates are pushed (not painted over), so no colour centre appears at the pointer: the
  // field is dragged along the pointer's motion, swirled a little, and a soft damped ripple travels out.
  vec2 m = (uMouse * stretch) * uScale - 0.5;
  vec2 d = p - m;
  vec2 dn = vec2((uv.x - uMouse.x) * min(aspect, 2.5), uv.y - uMouse.y);   // element-relative reach
  float reach = exp(-dot(dn, dn) * 3.2) * uInfluence;
  float ripple = sin(length(dn) * 16.0 - uTime * 1.6) * exp(-length(dn) * 2.2);
  p -= uVel * stretch * reach * 1.1 * uScale;
  p += vec2(-d.y, d.x) * reach * 0.14;
  p += normalize(d + 1e-4) * ripple * reach * 0.05 * uScale;

  // ---- One continuous field: rotate, sine-warp, then fbm-warp twice ---------------------------------
  float t = uTime * 0.04;
  vec2 q = rot(p, 0.55 + (noise(vec2(t * 0.35, 1.7)) - 0.5) * 1.4);
  q.x += sin(q.y * 1.5 + t * 2.1) * 0.38;
  q.y += sin(q.x * 2.0 - t * 1.7) * 0.26;
  vec2 w1 = vec2(fbm(q * 0.85 + vec2(0.0, t)), fbm(q * 0.85 + vec2(5.2, 1.3) - t));
  q += (w1 - 0.5) * 2.3;
  vec2 w2 = vec2(fbm(q * 0.75 + w1 * 2.0 + vec2(1.7, 9.2) + t), fbm(q * 0.75 + w1 * 2.0 + vec2(8.3, 2.8) - t));
  q += (w2 - 0.5) * 1.7;

  // A smooth ramp across the warped domain (not distance from any point), so the colour flows in
  // long soft folds with no visible centres.
  float s = q.x * 0.62 + q.y * 0.30;
  float band = 0.5 + 0.5 * sin(s * 4.4 + 1.2 * sin(s * 3.1 + q.y * 1.1));
  float k = smoothstep(0.12, 0.88, band);
  vec3 col = mix(PEACH, CORAL, k);

  // Depth from the same warp, kept faint: a lighter peach sheen and slightly deeper coral folds.
  float sheen = (w2.x - w1.y) * 1.3;
  col = mix(col, mix(PEACH, vec3(1.0, 0.85, 0.76), 0.55), clamp(sheen, 0.0, 1.0) * 0.28);
  col *= 1.0 - clamp(-sheen, 0.0, 1.0) * 0.07;

  // ---- Fine film grain, a separate layer fixed to the screen (the liquid moves beneath it) ----------
  float g = hash(gl_FragCoord.xy + fract(uTime * 0.7) * 61.0) - 0.5;
  col += g * uGrain;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

export interface MangoGL {
  gl: WebGLRenderingContext
  draw: (o: { time: number; mouse: [number, number]; vel: [number, number]; influence: number; grain: number; scale?: number }) => void
  resize: (w: number, h: number) => void
  dispose: (loseContext?: boolean) => void // loseContext only for throwaway canvases: React StrictMode re-runs effects on the same canvas
}

/** Compile the shader on a canvas. Returns null when WebGL is unavailable. */
export function createMangoGL(canvas: HTMLCanvasElement, opts: { preserveDrawingBuffer?: boolean } = {}): MangoGL | null {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', ...opts }) as WebGLRenderingContext | null
  if (!gl) return null
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = compile(gl.VERTEX_SHADER, MANGO_VERTEX)
  const fs = compile(gl.FRAGMENT_SHADER, MANGO_FRAGMENT)
  if (!vs || !fs) return null
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW) // one big triangle
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u = (n: string) => gl.getUniformLocation(prog, n)
  const uRes = u('uRes'), uTime = u('uTime'), uMouse = u('uMouse'), uVel = u('uVel'), uInf = u('uInfluence'), uGrain = u('uGrain'), uScale = u('uScale')

  return {
    gl,
    draw: ({ time, mouse, vel, influence, grain, scale = 1 }) => {
      gl.uniform1f(uScale, scale)
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, time)
      gl.uniform2f(uMouse, mouse[0], mouse[1])
      gl.uniform2f(uVel, vel[0], vel[1])
      gl.uniform1f(uInf, influence)
      gl.uniform1f(uGrain, grain)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    resize: (w, h) => {
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
    },
    dispose: (loseContext = false) => {
      gl.deleteProgram(prog)
      gl.deleteBuffer(buf)
      if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

export const MANGO_FALLBACK_CSS = 'linear-gradient(135deg, #FFB08C 0%, #FF8F70 45%, #FF634A 100%)'

/** One still frame of the mango mesh as a PNG data URL (used for slider tracks). Null if WebGL is unavailable. */
export function renderMangoDataUrl(width = 512, height = 64, time = 12): string | null {
  const canvas = document.createElement('canvas')
  const g = createMangoGL(canvas, { preserveDrawingBuffer: true })
  if (!g) return null
  g.resize(width, height)
  g.draw({ time, mouse: [0.5, 0.5], vel: [0, 0], influence: 0, grain: 0.07 })
  const url = canvas.toDataURL('image/png')
  g.dispose(true)
  return url
}

/** Sets --mango-img (used by slider tracks) to a still of the mango mesh; keeps the CSS gradient if WebGL is unavailable. */
export function installMangoTexture() {
  const url = renderMangoDataUrl()
  if (url) document.documentElement.style.setProperty('--mango-img', `url("${url}")`)
}
