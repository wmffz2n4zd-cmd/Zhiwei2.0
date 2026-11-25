import { createHash } from 'node:crypto';

// This function is the entire trusted script in the downloadable offline viewer.
// Art content enters as GLB bytes. No model-provided text is evaluated as script.
function startViewer() {
  'use strict';
  const el = id => document.getElementById(id);
  const canvas = el('view'), context = canvas.getContext('2d');
  const types = ['width', 'height', 'depth'];
  let asset, binary, triangles, yaw = 28, pitch = -14, center = [0,0,0], radius = 1;
  let dragging = null, pending = 0;
  function validTriplet(v, positive, count = 3) {
    return Array.isArray(v) && v.length === count && v.every(n => Number.isFinite(n) &&
      Math.abs(n) <= 100000 && (!positive || n >= 0.0001));
  }
  function parse(buffer) {
    if (buffer.byteLength < 32 || buffer.byteLength > 8 * 1024 * 1024) throw Error();
    const view = new DataView(buffer);
    const read = at => view.getUint32(at, true);
    if (read(0) !== 0x46546c67 || read(4) !== 2 || read(8) !== buffer.byteLength || read(16) !== 0x4e4f534a) throw Error();
    const offset = read(12) + 20;
    if (offset > buffer.byteLength - 8 || read(offset + 4) !== 0x004e4942 || read(offset) !== buffer.byteLength - offset - 8) throw Error();
    const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, offset - 20)));
    if (doc.asset?.version !== '2.0' || !Array.isArray(doc.nodes) || !doc.nodes.length || doc.nodes.length > 64) throw Error();
    const bin = new Uint8Array(buffer.slice(offset + 8));
    for (const node of doc.nodes) {
      if (!Number.isInteger(node.mesh) || !validTriplet(node.scale, true) || !validTriplet(node.translation, false) ||
          !validTriplet(node.rotation, false, 4) || Math.abs(Math.hypot(...node.rotation) - 1) > .001) throw Error();
      const prim = doc.meshes[node.mesh].primitives[0];
      const acc = doc.accessors[prim.attributes.POSITION], src = doc.bufferViews[acc.bufferView];
      const bytes = (src.byteOffset || 0) + (acc.byteOffset || 0);
      if (prim.mode !== 4 || prim.indices !== undefined || acc.componentType !== 5126 || acc.type !== 'VEC3' ||
          !Number.isInteger(acc.count) || acc.count < 3 || acc.count % 3 || acc.count > 2000 ||
          src.buffer !== 0 || src.byteStride || bytes < 0 || bytes + acc.count * 12 > bin.byteLength ||
          !validTriplet(doc.materials[prim.material].pbrMetallicRoughness.baseColorFactor, false, 4)) throw Error();
    }
    return { doc, bin };
  }
  function rebuild() {
    triangles = [];
    const low = [Infinity,Infinity,Infinity], high = [-Infinity,-Infinity,-Infinity];
    for (const node of asset.nodes) {
      const [qx, qy, qz, qw] = node.rotation;
      const prim = asset.meshes[node.mesh].primitives[0];
      const acc = asset.accessors[prim.attributes.POSITION], src = asset.bufferViews[acc.bufferView];
      const data = new Float32Array(binary.buffer, (src.byteOffset || 0) + (acc.byteOffset || 0), acc.count * 3);
      const rgb = asset.materials[prim.material].pbrMetallicRoughness.baseColorFactor.slice(0,3).map(value =>
        Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1/2.4) - .055)));
      for (let i = 0; i < data.length; i += 9) {
        const verts = [];
        for (let j = 0; j < 9; j += 3) {
          const x = data[i+j]*node.scale[0], y = data[i+j+1]*node.scale[1], z = data[i+j+2]*node.scale[2];
          const tx = 2*(qy*z - qz*y), ty = 2*(qz*x - qx*z), tz = 2*(qx*y - qy*x);
          const p = [x + qw*tx + qy*tz - qz*ty + node.translation[0],
            y + qw*ty + qz*tx - qx*tz + node.translation[1], z + qw*tz + qx*ty - qy*tx + node.translation[2]];
          if (!p.every(Number.isFinite)) throw Error();
          p.forEach((v, k) => { low[k] = Math.min(low[k],v); high[k] = Math.max(high[k],v); });
          verts.push(p);
        }
        triangles.push({ verts, rgb });
      }
    }
    center = low.map((v, i) => (v + high[i]) / 2);
    radius = Math.max(...high.map((v, i) => v - low[i]), .0001);
    schedule();
  }
  function display() {
    pending = 0;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(w*dpr)); canvas.height = Math.max(1, Math.round(h*dpr));
    context.scale(dpr,dpr); context.clearRect(0,0,w,h);
    const a = yaw*Math.PI/180, b = pitch*Math.PI/180, scale = Math.min(w,h)*.67/radius;
    const faces = triangles.map(({verts, rgb}) => {
      const points = verts.map(p => {
        const [x,y,z] = p.map((v,i) => v-center[i]);
        const sx = x*Math.cos(a)+z*Math.sin(a), sz = -x*Math.sin(a)+z*Math.cos(a);
        return [sx, y*Math.cos(b)-sz*Math.sin(b), sz*Math.cos(b)+y*Math.sin(b)];
      });
      const [p,q,r] = points, u = q.map((v,i)=>v-p[i]), v = r.map((n,i)=>n-p[i]);
      const nx = u[1]*v[2]-u[2]*v[1], ny = u[2]*v[0]-u[0]*v[2], nz = u[0]*v[1]-u[1]*v[0];
      const normal = Math.hypot(nx,ny,nz) || 1;
      const light = .48 + .52*Math.max(0,(-.35*nx+.65*ny+.67*nz)/normal);
      return { points, depth:(p[2]+q[2]+r[2])/3, color:'rgb('+rgb.map(c=>Math.round(c*light)).join(',')+')' };
    });
    faces.sort((a,b)=>a.depth-b.depth);
    for (const f of faces) {
      context.fillStyle = f.color; context.beginPath();
      f.points.forEach(([x,y],i)=>context[i?'lineTo':'moveTo'](w/2+x*scale,h/2-y*scale));
      context.closePath(); context.fill();
    }
  }
  function schedule() { if (!pending) pending = requestAnimationFrame(display); }
  function fields() {
    const node = asset.nodes[el('part').selectedIndex];
    types.forEach((id,i)=>{ el(id).value = node.scale[i]; });
  }
  function load(buffer) {
    const {doc,bin} = parse(buffer);
    const prev = {asset,binary};
    try { asset = doc; binary = bin; rebuild(); }
    catch (error) { asset = prev.asset; binary = prev.binary; if (asset) rebuild(); throw error; }
    el('part').replaceChildren(...doc.nodes.map((n,i)=>new Option(String(n.name || ('部件 '+(i+1))).slice(0,120),i)));
    fields();
  }
  function encode() {
    const data = new TextEncoder().encode(JSON.stringify(asset));
    const len = Math.ceil(data.length/4)*4, at = 20+len;
    const out = new Uint8Array(at+8+binary.length), view = new DataView(out.buffer);
    const put = (p,n)=>view.setUint32(p,n,true);
    put(0,0x46546c67); put(4,2); put(8,out.length); put(12,len); put(16,0x4e4f534a);
    out.fill(32,20,at); out.set(data,20); put(at,binary.length); put(at+4,0x004e4942); out.set(binary,at+8);
    return out;
  }
  const data = Uint8Array.from(atob(el('payload').textContent), c => c.charCodeAt(0));
  load(data.buffer);
  el('part').addEventListener('change',fields);
  types.forEach((id,axis)=>el(id).addEventListener('change',()=>{
    const value = el(id).valueAsNumber, node = asset.nodes[el('part').selectedIndex];
    if (!Number.isFinite(value) || value < .0001 || value > 10000) { fields(); return; }
    node.scale[axis] = value; rebuild(); el('status').textContent='尺寸已更新';
  }));
  el('export').addEventListener('click',()=>{
    const link=document.createElement('a'), url=URL.createObjectURL(new Blob([encode()],{type:'model/gltf-binary'}));
    link.href=url;link.download='model-edited.glb';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  });
  el('import').addEventListener('change',async()=>{
    const file=el('import').files[0]; if(!file) return;
    try { if(file.size>8*1024*1024)throw Error();load(await file.arrayBuffer());el('status').textContent='已导入 '+file.name; }
    catch { el('status').textContent='无法读取此模型，需使用此工具导出的 GLB。'; }
    el('import').value='';
  });
  el('yaw').addEventListener('input',()=>{ yaw=+el('yaw').value; schedule(); });
  el('reset').addEventListener('click',()=>{yaw=28; pitch=-14; el('yaw').value=yaw; schedule();});
  canvas.addEventListener('pointerdown',e=>{dragging=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{
    if(!dragging)return;
    yaw=((yaw+(e.clientX-dragging[0])*.6+540)%360)-180;
    pitch=Math.max(-89,Math.min(89,pitch+(e.clientY-dragging[1])*.6));
    dragging=[e.clientX,e.clientY];el('yaw').value=yaw;schedule();
  });
  canvas.addEventListener('lostpointercapture',()=>{dragging=null;});
  new ResizeObserver(schedule).observe(canvas);
}

const script = '(' + startViewer.toString() + ')();';
export const creativeViewerScriptHash = "'sha256-" + createHash('sha256').update(script.replace(/\r\n?/g,'\n')).digest('base64') + "'";

export function makeViewer(title, glb) {
  const safe = String(title).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>'+safe+'</title><style>*{box-sizing:border-box}body{font:16px/1.45 system-ui,sans-serif;color:#222c32;max-width:68rem;margin:auto;padding:1rem}'+
    'h1{font-size:clamp(1.5rem,4vw,2.5rem)}canvas{display:block;width:100%;height:clamp(13rem,50vh,32rem);background:#f1f0eb;touch-action:none;cursor:grab}'+
    '.bar{display:flex;align-items:center;gap:.6rem 1.1rem;flex-wrap:wrap;margin:.9rem 0}input[type=number]{width:6em}button,select,input{font:inherit}'+
    'button,label{padding:.25rem}button{cursor:pointer}#payload{display:none}</style><body><h1>'+safe+'</h1><canvas id="view" aria-label="三维模型，可拖动旋转"></canvas>'+
    '<div class="bar"><label>旋转 <input id="yaw" type="range" min="-180" max="180" value="28"></label><button id="reset">复位视角</button></div>'+
    '<div class="bar"><label>部件 <select id="part"></select></label>'+['宽|width','高|height','深|depth'].map(p=>p.split('|')).map(([n,id])=>
      '<label>'+n+' <input type="number" min=".0001" max="10000" step="any" id="'+id+'"></label>').join('')+'</div>'+
    '<div class="bar"><button id="export">导出当前 GLB</button><label>导入作品 GLB <input id="import" type="file" accept=".glb"></label></div>'+
    '<p id="status" role="status"></p><span hidden id="payload">'+glb.toString('base64')+'</span><script>'+script+'</script></body></html>';
}

