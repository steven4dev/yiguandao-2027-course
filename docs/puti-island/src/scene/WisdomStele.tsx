/**
 * 智慧石碑：兩層石座、圓頂碑身；正面刻字（灰），另一片透明面畫金字，reveal 0→1 時金字浮現
 */
import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const COLUMNS = [['雲', '開', '見', '日'], ['清', '淨', '菩', '提']];   // 由右往左讀
const W = 2.4, H = 3.8, D = 0.42, BASE = 0.92;

function steleCanvas(gold: boolean) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 406;
  const c = cv.getContext('2d')!;
  if (!gold) { c.fillStyle = '#9da397'; c.fillRect(0, 0, 256, 406); c.strokeStyle = '#7d8378'; c.lineWidth = 6; c.strokeRect(14, 14, 228, 378); }
  c.font = 'bold 76px "LXGW WenKai TC", "Noto Serif TC", serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  COLUMNS.forEach((col, k) => col.forEach((ch, i) => {
    const x = 128 + (k ? -52 : 52), y = 72 + i * 88;
    if (gold) { c.shadowColor = 'rgba(255,200,80,0.9)'; c.shadowBlur = 18; c.fillStyle = '#ffd76a'; c.fillText(ch, x, y); c.shadowBlur = 0; c.fillStyle = '#fff1b8'; c.fillText(ch, x, y); }
    else { c.fillStyle = '#6c7268'; c.fillText(ch, x + 2, y + 2); c.fillStyle = '#868c82'; c.fillText(ch, x, y); }
  }));
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function WisdomStele({ reveal, position }: { reveal: MutableRefObject<number>; position?: [number, number, number] }) {
  const goldMat = useRef<THREE.MeshBasicMaterial>(null);
  const { stone, gold, side } = useMemo(() => ({ stone: steleCanvas(false), gold: steleCanvas(true), side: new THREE.MeshLambertMaterial({ color: '#9aa094' }) }), []);
  useFrame(() => { if (goldMat.current) goldMat.current.opacity = THREE.MathUtils.smoothstep(reveal.current, 0.15, 0.9); });
  return (
    <group position={position}>
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow><boxGeometry args={[3.6, 0.6, 1.7]} /><meshLambertMaterial color="#868b83" /></mesh>
      <mesh position={[0, 0.76, 0]} castShadow receiveShadow><boxGeometry args={[3.0, 0.32, 1.25]} /><meshLambertMaterial color="#a3a89f" /></mesh>
      <mesh position={[0, BASE + H / 2, 0]} castShadow receiveShadow
        material={[side, side, side, side, new THREE.MeshLambertMaterial({ map: stone }), side]}><boxGeometry args={[W, H, D]} /></mesh>
      <mesh position={[0, BASE + H, 0]} rotation-x={-Math.PI / 2} material={side} castShadow>
        <cylinderGeometry args={[W / 2, W / 2, D, 26, 1, false, -Math.PI / 2, Math.PI]} />
      </mesh>
      <mesh position={[0, BASE + H / 2, D / 2 + 0.012]}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial ref={goldMat} map={gold} transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
