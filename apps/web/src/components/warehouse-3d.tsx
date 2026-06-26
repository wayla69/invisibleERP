'use client';

// 3D warehouse view (react-three-fiber). Each bin is a box placed at its pos (x = aisle axis, y = depth,
// z = level/height) and sized by its dims; colour encodes utilisation (green → amber → red). Click a bin to
// select it; bins matching a located item are highlighted. Rendered client-only (dynamic import, ssr:false).
import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Html } from '@react-three/drei';
import * as THREE from 'three';

export interface LayoutBin {
  bin_code: string;
  bin_type?: string;
  pos: { x: number; y: number; z: number };
  dim: { w: number; d: number; h: number };
  capacity: number | null;
  on_hand: number;
  item_count: number;
  utilization: number | null;
}

// utilisation → colour: no capacity = slate; 0 = green; 0.5 = amber; ≥1 = red
function binColor(b: LayoutBin, highlighted: boolean): string {
  if (highlighted) return '#6366f1';
  if (b.utilization == null) return '#94a3b8';
  const u = Math.min(b.utilization, 1);
  if (u > 1 - 1e-9 && b.utilization > 1) return '#dc2626';
  const hue = (1 - u) * 120; // 120=green → 0=red
  return `hsl(${hue}, 70%, 50%)`;
}

function BinBox({ bin, selected, highlighted, onSelect }: { bin: LayoutBin; selected: boolean; highlighted: boolean; onSelect: (c: string) => void }) {
  const ref = useRef<THREE.Mesh>(null);
  const [hover, setHover] = useState(false);
  const w = Math.max(bin.dim.w || 1, 0.1);
  const d = Math.max(bin.dim.d || 1, 0.1);
  const h = Math.max(bin.dim.h || 1, 0.1);
  // three.js: x = aisle, y = up (= our pos.z level), z = depth (= our pos.y). Sit the box on the floor.
  const px = bin.pos.x;
  const py = (bin.pos.z || 0) + h / 2;
  const pz = bin.pos.y;
  const color = binColor(bin, highlighted);

  useFrame(() => {
    if (selected && ref.current) ref.current.rotation.y += 0.01;
  });

  return (
    <group position={[px, py, pz]}>
      <mesh
        ref={ref}
        onClick={(e) => { e.stopPropagation(); onSelect(bin.bin_code); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
        onPointerOut={() => setHover(false)}
        scale={hover || selected ? 1.04 : 1}
      >
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} transparent opacity={highlighted || selected ? 0.95 : 0.8} emissive={selected ? color : '#000000'} emissiveIntensity={selected ? 0.3 : 0} />
      </mesh>
      {/* wire outline */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(w, h, d)]} />
        <lineBasicMaterial color="#1e293b" />
      </lineSegments>
      {(hover || selected) && (
        <Html center distanceFactor={20} position={[0, h / 2 + 0.6, 0]}>
          <div style={{ background: 'rgba(15,23,42,0.92)', color: 'white', padding: '4px 8px', borderRadius: 6, fontSize: 12, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            <b>{bin.bin_code}</b>{bin.capacity != null ? ` · ${bin.on_hand}/${bin.capacity}` : ` · ${bin.on_hand}`}{bin.utilization != null ? ` (${Math.round(bin.utilization * 100)}%)` : ''}
          </div>
        </Html>
      )}
      <Text position={[0, -h / 2 - 0.25, 0]} fontSize={0.28} color="#475569" anchorX="center" anchorY="top">{bin.bin_code}</Text>
    </group>
  );
}

export default function Warehouse3D({ bins, highlight, selected, onSelect }: { bins: LayoutBin[]; highlight: Set<string>; selected: string | null; onSelect: (c: string) => void }) {
  // center the camera over the layout extent
  const center = useMemo(() => {
    if (!bins.length) return { cx: 0, cz: 0, span: 10 };
    const xs = bins.map((b) => b.pos.x), ys = bins.map((b) => b.pos.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 6) + 6;
    return { cx, cz, span };
  }, [bins]);

  return (
    <div style={{ height: 480, width: '100%', borderRadius: 12, overflow: 'hidden', background: 'linear-gradient(180deg,#f8fafc,#e2e8f0)' }}>
      <Canvas camera={{ position: [center.cx + center.span, center.span * 0.8, center.cz + center.span], fov: 50 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 20, 10]} intensity={0.8} castShadow />
        <Grid args={[60, 60]} position={[center.cx, 0, center.cz]} cellColor="#cbd5e1" sectionColor="#94a3b8" fadeDistance={80} infiniteGrid />
        {bins.map((b) => (
          <BinBox key={b.bin_code} bin={b} selected={selected === b.bin_code} highlighted={highlight.has(b.bin_code)} onSelect={onSelect} />
        ))}
        <OrbitControls target={[center.cx, 1, center.cz]} enableDamping makeDefault />
      </Canvas>
    </div>
  );
}
