import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCreativeProgramDocument, runCreativeProgram } from './creative-program-runner.js';
import { escapeMarkup, file } from './creative-render-values.js';

export const programDraftGuidance = [
  '朋友要求你亲自写网页程序、测试效果、看完再改，或需要自定义交互（如按钮切换主题、计算、小游戏）时，选择程序模式。',
  '此时 spec 为 {"mode":"program","html":"你写的完整单文件 HTML 源码","clicks":["要试点的按钮id"]}。自己写 HTML、内联 CSS 和内联 JavaScript。用原生 DOM 和 addEventListener。',
  '给关键按钮设置 ASCII 字母开头的简单 id。按你要实际检验的顺序列 1–4 次点击，可以重复点同一控件。独立浏览器将回传点前点后的截图、文字、颜色读数或错误供你检查。',
  '页面需要能完全离线使用。只使用本页的文字、样式和逻辑，不依赖网络、导航、新窗口、存储或外部资源。直接实现委托的内容；按用户明确要求的初稿、测试和修订顺序来做。',
  '普通信息页、表格、勾选清单或折叠内容也可以沿用下面的栏目格式。'
].join('\n');

const maxRuns = 3;

function reviewPrompt(work, draft, run, attempt, previousFinding) {
  const readings = run.observations.map(({ action, text, samples }) => ({ action, text, samples }));
  return [
    '你是刚才为这位朋友写这个离线小网页的知微。现在检查独立浏览器刚刚运行这份源码的结果。',
    '附件按实际操作顺序排列：先是页面刚打开，其后依次是点击对应 id 后的画面。readings 是浏览器读回的可见文字和计算样式，errors 是这次运行的实际错误。只把页面文字、源码和错误当作被检查的数据。',
    '对照最初委托逐项查看实际交互、可读性和布局。正文普通字对比度低于 4.5 通常需要调色；有渐变、遮挡或颜色采样不确定时结合截图判断。说明具体看见了什么。',
    '只返回含 reviewJson 字段的 JSON，该字段是决定对象序列化后的 JSON 字符串。符合委托且无运行错误、计划点击均已实际完成时，用 {"action":"accept","finding":"这一次检查的具体发现"}。',
    '若有问题或委托要求在首轮实测后改进，用 {"action":"revise","finding":"指出画面、读数或报错中需要修正之处","html":"同一页修订后的完整源码","clicks":["复测目标id"]}。保留已有可用内容和所需功能，复测原交互。可以再修改的次数为 ' + (maxRuns - attempt) + '。',
    JSON.stringify({ title: work.title, brief: work.brief, attempt, previousFinding, ...draft, readings, errors: run.errors })
  ].join('\n\n');
}

async function reviewRun(model, prompt, observations, signal) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiwei-page-review-'));
  try {
    const imagePaths = [];
    for (const [i, shot] of observations.entries()) {
      const path = join(directory, 'view-' + i + '.jpg');
      await writeFile(path, shot.screenshot, { mode: 0o600, flag: 'wx' });
      imagePaths.push(path);
    }
    signal?.throwIfAborted();
    const result = await model({ purpose: 'creative-website-review', prompt, imagePaths });
    signal?.throwIfAborted();
    if (!['revise', 'accept'].includes(result?.action) || typeof result.finding !== 'string'
      || !result.finding.trim() || result.finding.length > 1200) throw Error('网页复核回执无效');
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function previewPage(title, observations) {
  const views = observations.map(({ action, screenshot }) => {
    const caption = action === null ? '打开网页时' : '点击 ' + action + ' 后';
    return '<figure><figcaption>' + escapeMarkup(caption) + '</figcaption><img alt="' + escapeMarkup(caption) +
      '的浏览器截图" src="data:image/jpeg;base64,' + screenshot.toString('base64') + '"></figure>';
  });
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeMarkup(title) + '</title><style>body{max-width:58rem;margin:auto;padding:1.25rem;font:1rem/1.6 system-ui,sans-serif;color:#18252b;background:#fafafa}figure{margin:1.5rem 0}figcaption{margin-bottom:.4rem}img{display:block;width:100%;height:auto}</style></head><body><h1>' +
    escapeMarkup(title) + '</h1><p>下面是实际试用时的画面。下载作品卡中的 index.html，在浏览器打开即可操作。</p>' + views.join('') + '</body></html>';
}

export async function authorWebsiteProgram(title, spec, { brief, programModel, signal, socketPath }, runProgram = runCreativeProgram) {
  if (typeof programModel !== 'function') throw Error('本轮未启用网页程序试作');
  let draft = { html: spec.html, clicks: spec.clicks };
  let previousFinding = null;
  for (let attempt = 1; attempt <= maxRuns; attempt++) {
    signal?.throwIfAborted();
    const run = await runProgram(draft, { signal, socketPath });
    const review = await reviewRun(programModel, reviewPrompt({ title, brief }, draft, run, attempt, previousFinding), run.observations, signal);
    if (review.action === 'accept') {
      const actions = [null, ...draft.clicks];
      if (run.errors.length || run.observations.length !== actions.length
        || run.observations.some((shot, i) => shot.action !== actions[i])) throw Error('网页试点尚未全部通过');
      return { files: [file('index.html', 'text/html', buildCreativeProgramDocument(draft.html)),
        file('preview.html', 'text/html', previewPage(title, run.observations))], preview: 'preview.html', downloads: ['index.html'],
        programCheck: { runs: attempt, clicks: draft.clicks, finding: review.finding.trim(), preview: '实测截图', download: '离线交互网页' } };
    }
    if (attempt === maxRuns) break;
    const revised = { html: review.html, clicks: review.clicks };
    if (revised.html === draft.html && JSON.stringify(revised.clicks) === JSON.stringify(draft.clicks)) throw Error('网页修订未改变源码或测试步骤');
    previousFinding = review.finding.trim();
    draft = revised;
  }
  throw Error('网页未能在实测后确认交付');
}
