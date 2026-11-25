import sharp from 'sharp';
import { website } from './creative-render-site.js';
import { color, escapeMarkup, file, list, number, textField } from './creative-render-values.js';
import { drawNative } from './creative-render-drawing.js';
import { modelWork } from './creative-render-model.js';
import { authorWebsiteProgram, programDraftGuidance } from './creative-program-author.js';

const guides = {
  drawing: '绘图用 {"prompt":"具体场景、颜色、构图与画法"}。',
  website: '为该主题创作单页网站。spec 为 {"intro":"首页引言","accent":"#六位色值","sections":[{"heading":"栏目名","body":"该栏正文","detailLabel":"可点击的展开标题","detail":"展开后的内容"}]}。按请求设计 1–12 个栏目。无需折叠可省略 detailLabel 和 detail。可按目标选 layout=grid/editorial/timeline，font=serif/sans，align=left/center，background、ink、surface 三个 #RRGGBB 颜色。sections 中每栏可选 accent、blocks；每个 block 按内容使用 {type:"paragraph",text}、{type:"quote",text}、{type:"checklist"或"list",items:["..."]}、{type:"table",columns:["..."],rows:[["..."]]} 或 {type:"disclosure",label,text}。主导版式、色彩和可操作栏目；仅放本题有用的内容。',
  design: '创作可编辑的 SVG 卡片或海报。spec 为 {"width":800,"height":1000,"background":"#ffffff","elements":[...] }。宽高范围 160–1600。自行创作 1–64 个有次序的分层元素；每项可含 name 图层名。rect 用 type,x,y,width,height,fill,rx（圆角可省略）；ellipse 用 type,cx,cy,rx,ry,fill；path 用 type,d,fill，可选 stroke、strokeWidth；text 用 type,x,y,text,size,fill，可选 width（换行宽度）、weight（400/600/700）。所有颜色为 #RRGGBB，path 可用 none 填色。文本 x/y 为左边界、首行基线，给多行预留空间。请按用户要求排版与绘制，避免无意义的示例文字。',
  model3d: '创作由若干有名部件组成的参数化三维模型。spec 为 {"parts":[{"name":"部件名","shape":"box 或 cylinder 或 sphere 或 cone","size":[宽,高,深],"position":[中心X,中心Y,中心Z],"rotation":[绕X度,绕Y度,绕Z度],"color":"#RRGGBB"}]}。Y 轴朝上，原点可自定，相对尺寸统一，旋转可省略。1–64 个部件。把题目的外形、配色、结构与细节实际体现在这些部件中。'
};
export function creativeSpecGuidance(kind, { programWebsite = false } = {}) {
  if (!Object.hasOwn(guides, kind)) throw Error('未知的创作类型');
  if (kind === 'website' && programWebsite) return programDraftGuidance + '\n' + guides.website;
  return guides[kind];
}

function textLines(value, maxUnits) {
  const lines = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = '', units = 0;
    for (const char of paragraph) {
      const unit = /^[\x20-\x7e]$/.test(char) ? 0.6 : 1;
      if (line && units + unit > maxUnits) { lines.push(line); line = ''; units = 0; }
      line += char; units += unit;
    }
    lines.push(line);
  }
  return lines;
}
function svgLayer(e, width, height) {
  const coord = v => number(v, -3200, 3200);
  const dim = v => number(v, 0, 3200);
  const fill = e.type === 'path' && e.fill === 'none' ? 'none' : color(e.fill);
  if (e.type === 'rect') return '<rect x="' + coord(e.x) + '" y="' + coord(e.y) + '" width="' + dim(e.width) +
    '" height="' + dim(e.height) + '" rx="' + dim(e.rx ?? 0) + '" fill="' + fill + '"/>';
  if (e.type === 'ellipse') return '<ellipse cx="' + coord(e.cx) + '" cy="' + coord(e.cy) + '" rx="' +
    dim(e.rx) + '" ry="' + dim(e.ry) + '" fill="' + fill + '"/>';
  if (e.type === 'path') {
    const data = textField(e.d, 6000);
    if (!/^[mM][0-9., +\t\r\neEaAcChHlLmMqQsStTvVzZ-]+$/.test(data)) throw Error('SVG 路径格式无效');
    return '<path d="' + data + '" fill="' + fill + '" stroke="' + (e.stroke && e.stroke !== 'none' ? color(e.stroke) : 'none') +
      '" stroke-width="' + dim(e.strokeWidth ?? 1) + '"/>';
  }
  if (e.type !== 'text') throw Error('未知的设计图层');
  const x = number(e.x, 0, width), y = number(e.y, 0, height);
  const size = number(e.size, 6, Math.min(width, height));
  const weight = [400, 600, 700].includes(Number(e.weight)) ? Number(e.weight) : 400;
  const text = textField(e.text, 500);
  const lineWidth = Math.min(e.width === undefined ? width : dim(e.width), width - x);
  const lines = textLines(text, Math.max(1, lineWidth / size));
  if (y + (lines.length - 1) * size * 1.25 > height + 1) throw Error('设计文字超过画布底部');
  return '<text x="' + x + '" y="' + y + '" font-family="Noto Sans CJK SC,Microsoft YaHei,sans-serif" font-size="' +
    size + '" font-weight="' + weight + '" fill="' + fill + '">' + lines.map((v, i) => '<tspan x="' + x + '" dy="' +
      (i ? size * 1.25 : 0) + '">' + escapeMarkup(v) + '</tspan>').join('') + '</text>';
}
async function design(title, spec) {
  const width = number(spec.width, 160, 1600), height = number(spec.height, 160, 1600);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw Error('画布尺寸须为整像素');
  const layers = list(spec.elements, 64).map((e, i) => '<g id="layer-' + (i + 1) + '"><title>' +
    escapeMarkup(textField(e.name || (e.type + ' ' + (i + 1)), 120)) + '</title>' + svgLayer(e, width, height) + '</g>');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' +
    width + ' ' + height + '"><title>' + escapeMarkup(title) + '</title><g id="background"><rect width="100%" height="100%" fill="' +
    color(spec.background) + '"/></g>' + layers.join('') + '</svg>';
  const preview = await sharp(Buffer.from(svg)).png().toBuffer();
  return { files: [file('design.svg', 'image/svg+xml', svg), file('preview.png', 'image/png', preview)],
    preview: 'preview.png', downloads: ['design.svg', 'preview.png'] };
}

export async function renderCreativeWork({ kind, title, spec }, options = {}) {
  options.signal?.throwIfAborted();
  const label = textField(title, 160);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw Error('缺少作品设计稿');
  if (kind === 'drawing') return drawNative(textField(spec.prompt, 2800), options);
  if (kind === 'website' && spec.mode === 'program') return authorWebsiteProgram(label, spec, options);
  if (kind === 'website') return website(label, spec);
  if (kind === 'design') return design(label, spec);
  if (kind === 'model3d') return modelWork(label, spec);
  throw Error('未知的创作类型');
}

