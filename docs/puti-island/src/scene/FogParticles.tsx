/**
 * FogParticles：罩住石碑和蓮花的雲霧，progress 越高散得越開
 *
 * 一顆粒子＝一片柔邊圓形雲片（gl.POINTS + 自訂 ShaderMaterial）。
 * - 每顆粒子帶 aSeed：x 離開門檻、y 速度、z 相位、w 大小。越外圈門檻越低 → 由外往內一層一層被吹開，
 *   最後才露出中間的石碑和蓮花。
 * - uProgress（0～1）超過門檻後，那顆粒子沿著「往外＋往吹的方向＋往上」飄走、變大、變淡（Fade out）。
 * - uGust（0～1）是當下的吹氣力道：還沒散的雲會跟著翻湧一下，讓玩家馬上感覺到「有吹到」。
 * - progress、gust 用 ref 傳進來，在 useFrame 裡直接寫 uniform，不觸發 React 重畫。
 *
 * 跟原生版 islands/index.html 的雲霧（PT3.fog）是同一份 shader。
 */
import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

export interface FogParticlesProps {
  /** 0～1 的吹散進度；傳數字或 ref 都可以（建議 ref，配合 useBlowDetection().progressRef） */
  progress: number | MutableRefObject<number>;
  /** 0～1 當下的吹氣力道（useBlowDetection().gustRef） */
  gust?: number | MutableRefObject<number>;
  /** 粒子數：手機 1100、電腦 1800 左右 */
  count?: number;
  /** 雲團半徑（寬、高、深） */
  radius?: [number, number, number];
  /** 吹的方向（世界座標，水平）；不給就用「鏡頭 → 雲團中心」 */
  blowDir?: THREE.Vector3;
  /** 夜晚 0～1：雲帶一點藍紫、變暗 */
  night?: number;
  /** 系統設定「減少動態效果」時，只保留散開，不飄動 */
  reduceMotion?: boolean;
  position?: [number, number, number];
}

const read = (v: number | MutableRefObject<number> | undefined, d = 0) => (v == null ? d : typeof v === 'number' ? v : v.current);

const vertexShader = /* glsl */ `
  uniform float uTime, uProg, uGust, uPx, uOpacity;
  uniform vec3 uDir;
  attribute vec4 aSeed;   // x：離開門檻　y：速度　z：相位　w：大小
  varying float vA, vShade;
  void main() {
    vec3 p = position;
    float a = uTime * (0.05 + 0.06 * aSeed.y) + aSeed.z * 6.2832;       // 平常慢慢打轉、上下起伏
    p.x += cos(a) * 0.45; p.z += sin(a) * 0.45;
    p.y += sin(uTime * 0.4 + aSeed.z * 12.0) * 0.18;
    vec3 rad = vec3(p.x, 0.0, p.z);
    float rl = length(rad);
    rad = rl > 0.001 ? rad / rl : vec3(0.0, 0.0, 1.0);
    float k = clamp((uProg - aSeed.x) / 0.32, 0.0, 1.0);
    float e = k * k * (3.0 - 2.0 * k);
    vec3 dir = normalize(rad + uDir * 0.9 + vec3(0.0, 0.25 + aSeed.y * 0.35, 0.0));
    p += dir * e * (9.0 + aSeed.y * 12.0);                                  // 被吹散：往外飄走
    float edge = clamp(rl / 7.0, 0.2, 1.0);
    p += (rad * 0.7 + uDir) * uGust * (0.35 + 0.65 * aSeed.y) * (1.0 - e) * edge * 1.1;   // 吹氣當下的一陣風
    p.y += uGust * sin(uTime * 7.0 + aSeed.z * 20.0) * 0.12 * (1.0 - e);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = (1.5 + aSeed.w * 1.6) * (1.0 + e * 1.4);                  // 散開時變大
    gl_PointSize = min(size * uPx / max(1.0, -mv.z), 480.0);
    vA = uOpacity * (1.0 - e) * (0.45 + 0.25 * aSeed.y);                   // 散開時變淡
    vShade = clamp(p.y / 6.0, 0.0, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor, uShadow;
  varying float vA, vShade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float a = 1.0 - d * d; a *= a * vA;
    if (a < 0.004) discard;
    float top = clamp(0.5 - c.y, 0.0, 1.0);                                 // 上緣亮、下緣帶藍灰，看起來有厚度
    gl_FragColor = vec4(mix(uShadow, uColor, clamp(0.3 + 0.45 * top + 0.4 * vShade, 0.0, 1.0)), a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const DAY_C = new THREE.Color('#ffffff'), DAY_S = new THREE.Color('#c3d0de');
const NIGHT_C = new THREE.Color('#aab4d8'), NIGHT_S = new THREE.Color('#5f6890');

export function FogParticles({
  progress, gust = 0, count = 1800, radius = [7.2, 6.2, 7.0], blowDir, night = 0, reduceMotion = false, position = [0, 0, 0],
}: FogParticlesProps) {
  const points = useRef<THREE.Points>(null);
  const { gl, camera } = useThree();
  const tmp = useMemo(() => ({ buf: new THREE.Vector2(), dir: new THREE.Vector3(), center: new THREE.Vector3(), q: new THREE.Quaternion() }), []);

  const geometry = useMemo(() => {
    const [FX, FY, FZ] = radius;
    const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // 越往中心越濃；只取上半球（雲是蓋在地上的）
      const u = Math.pow(Math.random(), 0.55), th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 0.96);
      const x = Math.sin(ph) * Math.cos(th) * u * FX, y = 0.25 + Math.cos(ph) * u * FY, z = Math.sin(ph) * Math.sin(th) * u * FZ;
      pos.set([x, y, z], i * 3);
      const rn = Math.min(1, Math.hypot(x / FX, (y - 0.25) / FY, z / FZ));
      seed.set([(1 - rn) * 0.62 + Math.random() * 0.3, Math.random(), Math.random(), 0.7 + Math.random() * 0.6], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 34);   // 粒子在 shader 裡會飄很遠，包圍球給大一點才不會被誤剪
    return g;
  }, [count, radius]);

  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uProg: { value: 0 }, uGust: { value: 0 }, uPx: { value: 800 }, uOpacity: { value: 1 },
      uDir: { value: new THREE.Vector3(0, 0, -1) }, uColor: { value: DAY_C.clone() }, uShadow: { value: DAY_S.clone() },
    },
    vertexShader, fragmentShader, transparent: true, depthWrite: false,
  }), []);

  useFrame((state) => {
    const p = points.current; if (!p) return;
    const u = material.uniforms, prog = THREE.MathUtils.clamp(read(progress), 0, 1);
    // 門檻最高約 0.92、要再走 0.32 才完全散開，所以乘 1.3；完全散開後整團不畫，省 GPU
    u.uProg.value = prog * 1.3;
    p.visible = prog < 0.995;
    if (!p.visible) return;
    u.uTime.value = reduceMotion ? 0 : state.clock.elapsedTime;
    u.uGust.value = reduceMotion ? 0 : read(gust);
    // 粒子大小換算成像素：畫面高度的一半 × 投影矩陣的焦距
    gl.getDrawingBufferSize(tmp.buf);
    u.uPx.value = tmp.buf.y * 0.5 * camera.projectionMatrix.elements[5];
    // 吹的方向：換算到雲團自己的座標
    if (blowDir) tmp.dir.copy(blowDir);
    else { p.getWorldPosition(tmp.center); tmp.dir.subVectors(tmp.center, camera.position); }
    tmp.dir.setY(0).normalize().applyQuaternion(p.getWorldQuaternion(tmp.q).invert());
    u.uDir.value.copy(tmp.dir);
    u.uColor.value.copy(DAY_C).lerp(NIGHT_C, night);
    u.uShadow.value.copy(DAY_S).lerp(NIGHT_S, night);
  });

  return <points ref={points} geometry={geometry} material={material} position={position} renderOrder={5} />;
}
