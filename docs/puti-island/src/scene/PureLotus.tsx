/**
 * 清淨蓮花：三圈花瓣，樞紐在花心；bloom 0→1 時花瓣繞根部往外倒（含苞 → 綻放），並且漸漸發光
 */
import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const RINGS: [n: number, r0: number, bud: number, open: number, inner: boolean, scale: number, offset: number][] = [
  [8, 0.12, 0.22, 1.2, false, 1, 0], [6, 0.07, 0.1, 0.72, true, 0.86, Math.PI / 6], [5, 0.03, 0.04, 0.38, true, 0.66, 0.2],
];

export function PureLotus({ bloom, position }: { bloom: MutableRefObject<number>; position?: [number, number, number] }) {
  const petals = useRef<THREE.Mesh[]>([]);
  const glow = useRef<THREE.Sprite>(null);
  const group = useRef<THREE.Group>(null);
  const { geo, outer, inner, pod, glowMap } = useMemo(() => {
    // 上窄下寬、尖端微微往外翹的花瓣
    const g = new THREE.SphereGeometry(1, 16, 10); g.scale(0.24, 0.58, 0.1).translate(0, 0.58, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) / 1.16; p.setZ(i, p.getZ(i) + 0.14 * y * y); p.setX(i, p.getX(i) * (1 - 0.35 * y * y)); }
    g.computeVertexNormals();
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const c = cv.getContext('2d')!, gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,236,190,0.95)'); gr.addColorStop(0.4, 'rgba(255,190,210,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
    return {
      geo: g,
      outer: new THREE.MeshLambertMaterial({ color: '#f5b3c8', emissive: '#ff9ec0', emissiveIntensity: 0.04, side: THREE.DoubleSide }),
      inner: new THREE.MeshLambertMaterial({ color: '#fde3ec', emissive: '#ffd0e0', emissiveIntensity: 0.04, side: THREE.DoubleSide }),
      pod: new THREE.MeshLambertMaterial({ color: '#f2c94c', emissive: '#f2a93b', emissiveIntensity: 0.05 }),
      glowMap: new THREE.CanvasTexture(cv),
    };
  }, []);
  const specs = useMemo(() => RINGS.flatMap(([n, r0, bud, open, isInner, s, off]) =>
    Array.from({ length: n }, (_, i) => ({ a: off + (i / n) * Math.PI * 2, r0, bud, open, isInner, s }))), []);

  useFrame(({ clock }) => {
    const b = THREE.MathUtils.clamp(bloom.current, 0, 1), e = b * b * (3 - 2 * b), br = Math.sin(clock.elapsedTime * 1.6) * 0.04;
    petals.current.forEach((m, i) => { const sp = specs[i]; m.rotation.x = sp.bud + (sp.open - sp.bud) * Math.min(1, e * (sp.open > 1 ? 1.15 : 0.95)) + (b > 0.99 ? br * sp.open * 0.3 : 0); });
    group.current?.scale.setScalar(0.85 + 0.25 * e);
    outer.emissiveIntensity = 0.04 + 0.42 * e; inner.emissiveIntensity = 0.04 + 0.55 * e; pod.emissiveIntensity = 0.05 + 0.7 * e;
    if (glow.current) { glow.current.material.opacity = e * (0.85 + br * 2); glow.current.scale.setScalar(0.1 + e * 3.4); }
  });

  return (
    <group ref={group} position={position}>
      {specs.map((sp, i) => (
        <group key={i} position={[Math.sin(sp.a) * sp.r0, 0.03, Math.cos(sp.a) * sp.r0]} rotation-y={sp.a}>
          <mesh ref={(m) => { if (m) petals.current[i] = m; }} geometry={geo} material={sp.isInner ? inner : outer} scale={sp.s} rotation-x={sp.bud} />
        </group>
      ))}
      <mesh position={[0, 0.22, 0]} material={pod}><cylinderGeometry args={[0.15, 0.1, 0.12, 14]} /></mesh>
      <sprite ref={glow} position={[0, 0.5, 0]}>
        <spriteMaterial map={glowMap} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
    </group>
  );
}
