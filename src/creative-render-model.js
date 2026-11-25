import { makeViewer } from './creative-render-viewer.js';
import { color, number, textField } from './creative-render-values.js';

const shapes = ['box', 'cylinder', 'sphere', 'cone'];
function triple(value, min, max) {
  if (!Array.isArray(value) || value.length !== 3) throw Error('三维向量格式无效');
  return value.map(v => number(v, min, max));
}
function quaternion(angles) {
  const [x, y, z] = angles.map(v => v * Math.PI / 360);
  const sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z);
  const cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z);
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

function surface(shape) {
  const positions = [], normals = [];
  function face(a, b, c) {
    const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
    const n = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
    const length = Math.hypot(...n);
    if (length < 1e-10) return;
    const sign = n.reduce((total, x, i) => total + x * (a[i] + b[i] + c[i]), 0) >= 0 ? 1 : -1;
    const outward = n.map(x => sign * x / length);
    positions.push(...a, ...(sign > 0 ? b : c), ...(sign > 0 ? c : b));
    normals.push(...outward, ...outward, ...outward);
  }
  if (shape === 'box') {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const corners = [[-1,-1], [1,-1], [1,1], [-1,1]].map(([p,q]) => {
        const out = [];
        out[axis] = sign / 2; out[(axis + 1) % 3] = p / 2; out[(axis + 2) % 3] = q / 2;
        return out;
      });
      face(corners[0],corners[1],corners[2]); face(corners[0],corners[2],corners[3]);
    }
  } else {
    const segments = 20, slices = shape === 'sphere' ? 10 : 1;
    function point(j, i) {
      const fraction = j / slices, longitude = i * Math.PI * 2 / segments;
      const latitude = (fraction - 0.5) * Math.PI;
      const radius = shape === 'sphere' ? Math.cos(latitude) / 2 : shape === 'cone' ? (1 - fraction) / 2 : 0.5;
      return [radius * Math.cos(longitude), shape === 'sphere' ? Math.sin(latitude) / 2 : fraction - 0.5,
        radius * Math.sin(longitude)];
    }
    for (let i = 0; i < segments; i++) {
      if (shape !== 'sphere') {
        face([0,-0.5,0], point(0,i), point(0,i+1));
        if (shape === 'cylinder') face([0,0.5,0], point(1,i), point(1,i+1));
      }
      for (let j = 0; j < slices; j++) {
        const a = point(j,i), b = point(j,i+1), c = point(j+1,i+1), d = point(j+1,i);
        face(a,b,c); face(a,c,d);
      }
    }
  }
  return { positions, normals };
}

export function buildModel(parts) {
  const meshes = [], materials = [], nodes = [], bufferViews = [], accessors = [], binary = [];
  const geometries = new Map();
  let byteOffset = 0;
  function accessor(values, includeBounds) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
    const index = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target: 34962 });
    byteOffset += bytes.length; binary.push(bytes);
    const data = { bufferView: index, componentType: 5126, count: values.length / 3, type: 'VEC3' };
    if (includeBounds) {
      data.min = [Infinity, Infinity, Infinity]; data.max = [-Infinity,-Infinity,-Infinity];
      values.forEach((v, i) => {
        data.min[i % 3] = Math.min(data.min[i % 3], Math.fround(v));
        data.max[i % 3] = Math.max(data.max[i % 3], Math.fround(v));
      });
    }
    accessors.push(data);
    return accessors.length - 1;
  }
  for (const [i, p] of parts.entries()) {
    let attributes = geometries.get(p.shape);
    if (!attributes) {
      const { positions, normals } = surface(p.shape);
      attributes = { POSITION: accessor(positions, true), NORMAL: accessor(normals, false) };
      geometries.set(p.shape, attributes);
    }
    const rgb = [1,3,5].map(offset => {
      const s = parseInt(p.color.slice(offset, offset + 2), 16) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    materials.push({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.8 } });
    meshes.push({ name: p.name, primitives: [{ attributes, material: i, mode: 4 }] });
    nodes.push({ name: p.name, mesh: i, scale: p.size, translation: p.position, rotation: quaternion(p.rotation) });
  }
  const json = { asset: { version: '2.0', generator: '知微' }, scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials,
    buffers: [{ byteLength: byteOffset }], bufferViews, accessors };
  const body = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(body.length / 4) * 4;
  const header = Buffer.alloc(20 + jsonLength + 8, 0x20);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(header.length + byteOffset, 8);
  header.writeUInt32LE(jsonLength, 12); header.write('JSON', 16); body.copy(header, 20);
  header.writeUInt32LE(byteOffset, 20 + jsonLength); header.write('BIN\0', 24 + jsonLength);
  return Buffer.concat([header, ...binary]);
}

export function modelWork(title, spec) {
  if (!Array.isArray(spec.parts) || spec.parts.length < 1 || spec.parts.length > 64) throw Error('模型部件数量无效');
  const parts = spec.parts.map(p => {
    if (!shapes.includes(p.shape)) throw Error('未知的三维形体');
    return { name: textField(p.name, 100), shape: p.shape, size: triple(p.size, 0.0001, 10000),
      position: triple(p.position, -10000, 10000), rotation: triple(p.rotation ?? [0,0,0], -36000, 36000), color: color(p.color) };
  });
  const glb = buildModel(parts);
  return { files: [
    { name: 'model.glb', mime: 'model/gltf-binary', bytes: glb },
    { name: 'parameters.json', mime: 'application/json', bytes: Buffer.from(JSON.stringify({ parts }, null, 2)) },
    { name: 'viewer.html', mime: 'text/html', bytes: Buffer.from(makeViewer(title, glb)) }
  ], preview: 'viewer.html', downloads: ['model.glb', 'parameters.json', 'viewer.html'] };
}

