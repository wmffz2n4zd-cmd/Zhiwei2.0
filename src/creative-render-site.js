import { color, escapeMarkup, file, list, textField } from './creative-render-values.js';

const text = (value, max) => escapeMarkup(textField(value, max));

function disclosure(label, value) {
  return '<details><summary>' + text(label, 180) + '</summary><p>' + text(value, 2400) + '</p></details>';
}
function contentBlock(block) {
  if (block.type === 'paragraph') return '<p>' + text(block.text, 2400) + '</p>';
  if (block.type === 'quote') return '<blockquote>' + text(block.text, 1000) + '</blockquote>';
  if (block.type === 'disclosure') return disclosure(block.label, block.text);
  if (block.type === 'list' || block.type === 'checklist') {
    return '<ul' + (block.type === 'checklist' ? ' class="checklist"' : '') + '>' +
      list(block.items, 24).map(v => '<li>' + (block.type === 'list' ? text(v, 500) :
        '<label><input type="checkbox"> <span>' + text(v, 500) + '</span></label>') + '</li>').join('') + '</ul>';
  }
  if (block.type !== 'table') throw Error('未知的网站内容组件');
  const columns = list(block.columns, 8);
  const rows = list(block.rows, 40).map(cells => {
    if (!Array.isArray(cells) || cells.length !== columns.length) throw Error('网站表格列数不一致');
    return '<tr>' + cells.map(c => '<td>' + text(c, 500) + '</td>').join('') + '</tr>';
  });
  return '<div class="table"><table><thead><tr>' + columns.map(v => '<th scope="col">' + text(v, 100) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
}

export function website(title, spec) {
  const sections = list(spec.sections, 12).map((item, i) => {
    const heading = text(item.heading, 120);
    const body = item.body ? '<p>' + text(item.body, 2400) + '</p>' : '';
    const blocks = item.blocks?.length ? list(item.blocks, 12).map(contentBlock).join('') : '';
    const more = item.detail ? disclosure(item.detailLabel || '展开', item.detail) : '';
    if (!body && !blocks && !more) throw Error('网站栏目缺少内容');
    const accent = item.accent ? ' style="--accent:' + color(item.accent) + '"' : '';
    return { link: '<a href="#part-' + (i + 1) + '">' + heading + '</a>', article: '<section id="part-' + (i + 1) +
      '"' + accent + '><h2>' + heading + '</h2>' + body + blocks + more + '</section>' };
  });
  const layout = ['editorial','timeline','grid'].includes(spec.layout) ? spec.layout : 'grid';
  const font = spec.font === 'serif' ? '"Noto Serif CJK SC",Georgia,serif' : 'system-ui,sans-serif';
  const align = spec.align === 'center' ? 'center' : 'left';
  const css = '*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;--accent:'+color(spec.accent)+';--bg:'+
    color(spec.background || '#faf9f6')+';--ink:'+color(spec.ink || '#25272b')+';--surface:'+color(spec.surface || '#ffffff')+
    ';background:var(--bg);color:var(--ink);font:17px/1.65 '+font+';overflow-wrap:anywhere}main,header{max-width:70rem;margin:auto;padding:clamp(1rem,4vw,3rem)}'+
    'header{border-top:12px solid var(--accent);text-align:'+align+'}h1,h2{line-height:1.2;text-wrap:balance}h1{font-size:clamp(2.4rem,7vw,5.8rem);margin:.3em 0}'+
    'header p{max-width:52rem;font-size:1.2em;'+(align==='center'?'margin-inline:auto':'')+'}nav{display:flex;gap:.6rem;flex-wrap:wrap;justify-content:'+
    (align==='center'?'center':'start')+'}a{color:inherit;text-underline-offset:3px;padding:.2em .4em}main{display:grid;gap:1.4rem;padding-top:0}'+
    '.grid main{grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))}.grid section{box-shadow:0 2px 12px #17171710}'+
    '.editorial main{max-width:56rem}.editorial section{display:flow-root}.editorial h2{font-size:clamp(1.8em,4vw,2.8em)}'+
    '.timeline main{max-width:56rem;position:relative}.timeline section{position:relative;border-block-start:0;border-inline-start:.4rem solid var(--accent)}'+
    'section{min-width:0;padding:1.25em;background:var(--surface);border-block-start:4px solid var(--accent)}p,blockquote{white-space:pre-line}'+
    '.table{overflow:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid currentColor;text-align:start;padding:.45em}'+
    '.checklist{list-style:none;padding:0}.checklist label,summary{cursor:pointer}.checklist input:checked+span{text-decoration:line-through}summary{font-weight:650}'+
    'blockquote{margin:1em 0;padding:.25em 1em;border-left:.3em solid var(--accent)}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}';
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeMarkup(title) + '</title><style>' + css + '</style></head><body class="'+layout+'"><header><h1>' + escapeMarkup(title) + '</h1><p>' +
    text(spec.intro, 1000) + '</p><nav aria-label="页面目录">' + sections.map(s => s.link).join('') + '</nav></header><main>' +
    sections.map(s => s.article).join('') + '</main></body></html>';
  return { files: [file('index.html', 'text/html', html)], preview: 'index.html', downloads: ['index.html'] };
}

