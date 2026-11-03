/**
 * Canvas 層：島上的 3D（雲霧、石碑、蓮花、光柱）。只吃 ref，不吃 React state：
 * 吹氣時每秒 60 幀的變化都在 useFrame 裡處理，UI 層重畫不會拖慢 3D。
 */
import { useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { FogParticles } from './FogParticles';
import { PureLotus } from './PureLotus';
import { WisdomStele } from './WisdomStele';

export interface PutiSceneRefs {
  /** 雲霧吹散進度 0～1（吹氣中跟著 progress；今天已雲開就是 1） */
  fog: MutableRefObject<number>;
  /** 吹氣力道 0～1 */
  gust: MutableRefObject<number>;
  /** 蓮花綻放＆金字浮現 0～1（cleared 後由 0 慢慢長到 1） */
  bloom: MutableRefObject<number>;
}

function LightShaft({ bloom }: { bloom: MutableRefObject<number> }) {
  const m = useRef<THREE.MeshBasicMaterial>(null), mesh = useRef<THREE.Mesh>(null);
  const map = useMemo(() => {
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 128;
    const c = cv.getContext('2d')!, g = c.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.35, 'rgba(255,255,255,0.55)'); g.addColorStop(0.85, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 8, 128); return new THREE.CanvasTexture(cv);
  }, []);
  useFrame(({ clock }) => {
    const e = bloom.current; if (!mesh.current || !m.current) return;
    mesh.current.visible = e > 0.005; m.current.opacity = e * 0.3; mesh.current.rotation.y = clock.elapsedTime * 0.08;
  });
  return (
    <mesh ref={mesh} position={[0, 12, 0.6]} visible={false}>
      <cylinderGeometry args={[1.4, 3.6, 24, 28, 1, true]} />
      <meshBasicMaterial ref={m} map={map} color="#fff0b8" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function PutiScene({ refs, night = 0, reduceMotion = false, mobile = false }: { refs: PutiSceneRefs; night?: number; reduceMotion?: boolean; mobile?: boolean }) {
  return (
    <group>
      <WisdomStele reveal={refs.bloom} position={[0, 0, -1.4]} />
      <PureLotus bloom={refs.bloom} position={[0, 0.5, 2.7]} />
      <LightShaft bloom={refs.bloom} />
      <FogParticles progress={refs.fog} gust={refs.gust} count={mobile ? 1100 : 1800} position={[0, 0, -0.2]} night={night} reduceMotion={reduceMotion} />
      {/* 島本體、菩提樹、小靈山、蓮池、石燈…依群島現有的模型函式組裝，這裡省略 */}
    </group>
  );
}

/** 單獨展示用的 Canvas（嵌進群島時直接用 <PutiScene/>） */
export function PutiCanvas({ children, ...props }: { refs: PutiSceneRefs; night?: number; reduceMotion?: boolean; mobile?: boolean; children?: ReactNode }) {
  return (
    <Canvas camera={{ fov: 30, position: [0, 12, 31] }} shadows dpr={[1, props.mobile ? 1.5 : 2]}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }} onCreated={({ camera }) => camera.lookAt(0, 2.8, 0)}>
      <hemisphereLight intensity={1.6} color="#fff6e6" groundColor="#7fa86a" />
      <directionalLight position={[60, 110, 50]} intensity={2.4} castShadow />
      <PutiScene {...props} />
      {children}
    </Canvas>
  );
}
