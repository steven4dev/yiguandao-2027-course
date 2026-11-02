import { useEffect, useMemo, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Phase } from '../machine/lotteryMachine';
import type { LiveSensors } from '../hooks/useLotterySensors';

/**
 * 木造籤筒＋竹籤：示範「2D 感測器數值 → 3D 動畫」的綁定方式
 *
 * 綁定三原則
 *  1. 高頻數值（角度、搖晃能量、碰撞）走 `live` ref，在 useFrame 裡讀；不要放 React state。
 *  2. 低頻狀態（phase、fortuneId）才用 props，只在換階段時重繪。
 *  3. 不直接把感測器數值貼到模型上，一律用 THREE.MathUtils.damp 追目標值 → 手抖也不會抖畫面。
 */
interface Props {
  phase: Phase;
  live: MutableRefObject<LiveSensors>;
  fortuneId: number | null;
  /** 竹籤落到石桌上時呼叫（→ actions.stickLanded） */
  onLanded: () => void;
  position?: [number, number, number];
  /** 石桌桌面的世界座標高度 */
  tableY?: number;
}

const STICKS = 28;
const TUBE_H = 1.1;
const TUBE_R = 0.28;
const STICK_LEN = 1.35;
const { damp, degToRad, clamp } = THREE.MathUtils;

/** 固定的偽亂數，讓每根籤每次排列一樣 */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

export function FortuneTube({ phase, live, fortuneId, onLanded, position = [0, 0, 0], tableY = 0 }: Props) {
  const tube = useRef<THREE.Group>(null);
  const sticks = useRef<THREE.InstancedMesh>(null);
  const chosen = useRef<THREE.Mesh>(null);
  const falling = useRef<THREE.Mesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // 每根籤在筒口的位置、高低、微傾
  const layout = useMemo(
    () =>
      Array.from({ length: STICKS }, (_, i) => {
        const r = Math.sqrt(hash(i + 1)) * (TUBE_R - 0.05);
        const a = hash(i + 7) * Math.PI * 2;
        return {
          x: Math.cos(a) * r,
          z: Math.sin(a) * r,
          y: TUBE_H * 0.55 + hash(i + 13) * 0.12,
          tiltX: (hash(i + 21) - 0.5) * 0.18,
          tiltZ: (hash(i + 29) - 0.5) * 0.18,
          phase: hash(i + 37) * Math.PI * 2,
        };
      }),
    [],
  );

  // 出籤動畫的狀態（只在 phase 變 drawn 時初始化）
  const anim = useRef({ t: 0, stage: 'idle' as 'idle' | 'slide' | 'fall' | 'rest', vel: new THREE.Vector3(), spin: 0, landedSent: false });
  useEffect(() => {
    const a = anim.current;
    if (phase === 'drawn') Object.assign(a, { t: 0, stage: 'slide', spin: 0, landedSent: false });
    if (phase === 'purify' || phase === 'permission') a.stage = 'idle';
  }, [phase]);

  useFrame((state, delta) => {
    const L = live.current;
    const g = tube.current;
    const inst = sticks.current;
    if (!g || !inst) return;
    const t = state.clock.elapsedTime;
    const now = performance.now();

    // 沒有感測器（按鈕模擬）時，讓搖晃能量自己衰減
    if (!L.hasData) L.shakeEnergy *= Math.exp(-delta * 3);

    /* ---------- 1. 傾角 → 籤筒前傾 ---------- */
    let targetTilt = 0;
    if (phase === 'bow') targetTilt = L.bowLean * degToRad(25); // 跟著叩首點頭
    if (phase === 'pour') targetTilt = L.hasData ? degToRad(clamp(90 - L.pitch, 0, 55)) : 0;
    if (phase === 'drawn' || phase === 'reading') targetTilt = degToRad(55);
    g.rotation.x = damp(g.rotation.x, targetTilt, 6, delta); // 正角度：筒口往 +z（鏡頭方向）倒

    /* ---------- 2. 搖晃能量 → 籤筒抖動 ---------- */
    const e = phase === 'shake' ? L.shakeEnergy : 0;
    g.position.x = position[0] + Math.sin(t * 37) * 0.035 * e;
    g.position.z = position[2] + Math.cos(t * 29) * 0.025 * e;
    g.rotation.z = damp(g.rotation.z, Math.sin(t * 31) * 0.12 * e, 20, delta);

    /* ---------- 3. 碰撞事件 → 竹籤跳動 ---------- */
    // 碰撞是「瞬間事件」，用指數衰減的脈衝表現：碰到那一刻跳最高，80ms 內落回
    const impulse = phase === 'shake' ? L.lastHitIntensity * Math.exp(-(now - L.lastHitAt) / 80) : 0;
    for (let i = 0; i < STICKS; i++) {
      const s = layout[i];
      const jump = impulse * (0.04 + hash(i + 51) * 0.1) + e * Math.sin(t * 24 + s.phase) * 0.025;
      dummy.position.set(s.x, s.y + Math.max(0, jump), s.z);
      dummy.rotation.set(s.tiltX + e * Math.sin(t * 19 + s.phase) * 0.15, 0, s.tiltZ);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;

    /* ---------- 4. 出籤：先從筒口滑出，再脫離籤筒自由落下到石桌 ---------- */
    const a = anim.current;
    const c = chosen.current;
    const f = falling.current;
    if (!c || !f) return;
    a.t += delta;
    if (a.stage === 'slide') {
      c.visible = true;
      f.visible = false;
      c.position.y = TUBE_H * 0.55 + Math.min(a.t / 0.6, 1) * 0.75; // 0.6 秒滑出
      if (a.t >= 0.6) {
        // 把籤從籤筒（區域座標）換到世界座標，交給落下動畫
        c.updateWorldMatrix(true, false);
        c.getWorldPosition(f.position);
        c.getWorldQuaternion(f.quaternion);
        a.vel.set(0, 0.6, 1.1); // 往前（鏡頭方向）拋出
        a.spin = 4;
        a.stage = 'fall';
        c.visible = false;
        f.visible = true;
      }
    } else if (a.stage === 'fall') {
      a.vel.y -= 9.8 * delta;
      f.position.addScaledVector(a.vel, delta);
      f.rotateX(a.spin * delta);
      const restY = tableY + 0.03;
      if (f.position.y <= restY) {
        f.position.y = restY;
        if (Math.abs(a.vel.y) > 0.8) {
          a.vel.y *= -0.3; // 在石桌上彈一下
          a.vel.z *= 0.5;
          a.spin *= 0.4;
        } else {
          a.stage = 'rest';
          f.rotation.set(Math.PI / 2, 0, f.rotation.z); // 平躺在桌上
          if (!a.landedSent) {
            a.landedSent = true;
            onLanded();
          }
        }
      }
    } else if (a.stage === 'idle') {
      c.visible = false;
      f.visible = false;
    }
  });

  const label = fortuneId ?? 0;

  return (
    <group>
      <group ref={tube} position={position}>
        {/* 籤筒本體：開口圓柱 + 底 + 兩道竹箍 */}
        <mesh position={[0, TUBE_H / 2, 0]} castShadow>
          <cylinderGeometry args={[TUBE_R, TUBE_R * 0.92, TUBE_H, 32, 1, true]} />
          <meshStandardMaterial color="#8a5a33" roughness={0.75} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 0.02, 0]}>
          <cylinderGeometry args={[TUBE_R * 0.92, TUBE_R * 0.92, 0.04, 32]} />
          <meshStandardMaterial color="#6b4226" />
        </mesh>
        {[0.2, 0.9].map((y) => (
          <mesh key={y} position={[0, TUBE_H * y, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[TUBE_R * (1.01 - y * 0.06), 0.018, 8, 40]} />
            <meshStandardMaterial color="#c9a46a" roughness={0.6} />
          </mesh>
        ))}

        {/* 一筒竹籤：InstancedMesh 一次畫完 */}
        <instancedMesh ref={sticks} args={[undefined, undefined, STICKS]} castShadow>
          <boxGeometry args={[0.035, STICK_LEN, 0.01]} />
          <meshStandardMaterial color="#d9b77a" roughness={0.55} />
        </instancedMesh>

        {/* 被抽中的那一支（滑出階段在籤筒座標系裡） */}
        <mesh ref={chosen} visible={false} position={[0, TUBE_H * 0.55, 0]}>
          <boxGeometry args={[0.04, STICK_LEN, 0.012]} />
          <meshStandardMaterial color="#e8c88c" emissive="#b8860b" emissiveIntensity={0.25} />
        </mesh>
      </group>

      {/* 落下階段在世界座標系（脫離籤筒的旋轉） */}
      <mesh ref={falling} visible={false} userData={{ fortuneId: label }} castShadow>
        <boxGeometry args={[0.04, STICK_LEN, 0.012]} />
        <meshStandardMaterial color="#e8c88c" emissive="#b8860b" emissiveIntensity={0.25} />
      </mesh>
    </group>
  );
}
