// 渲染进程: 拖入 / label 列表 (虚拟滚动) / 按钮状态机
// 状态规则 (规范 3-6/8/10):
//   打包: 有任意 label 即亮
//   解包: 恰好 1 个 label 且它是本工具归档才亮 (多 label 灰)
//   name: 当前首个 label 的 <basename>.zip (无 label 为空)
const dropEl = document.getElementById('drop');
const viewport = document.getElementById('labels');
const spacer = document.getElementById('list-spacer');
const nameEl = document.getElementById('name');
const packBtn = document.getElementById('pack');
const unpackBtn = document.getElementById('unpack');

const ROW_H = 26;             // 虚拟滚动的固定行高 (css .label height 与之一致)
const items = [];             // {path, base, isDir, isOurs}

const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

async function addPaths(paths) {
    for (const p of paths) {
        if (!p) { continue; }
        if (items.some((it) => it.path === p)) { continue; }   // 重复拖入去重
        const info = await window.api.inspect(p);
        items.push({ path: p, base: baseName(p), isDir: info.isDir, isOurs: !!info.isOurs });
    }
    refresh();
    renderList();
}

function refresh() {
    nameEl.textContent = items.length ? items[0].base + '.zip' : '';
    packBtn.disabled = items.length === 0;
    unpackBtn.disabled = !(items.length === 1 && items[0].isOurs);
    dropEl.classList.toggle('has-items', items.length > 0);
}

// 虚拟滚动: 固定高度 spacer 撑起全部行 (滚动高度恒定), 只渲染可视区 ±3 行,
// 绝对定位摆在 spacer 上。绝不清空 viewport 重排 —— 否则滚动高度瞬间塌缩,
// 浏览器把 scrollTop 钳回 0, 滚轮/拖动进度条都会失效。
// 入场动画: 每个条目只在其行首次渲染时播放 (.enter), 之后的重建/滚动不再重播。
function renderList() {
    spacer.style.height = (items.length * ROW_H) + 'px';
    const vh = viewport.clientHeight || 400;
    const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - 3);
    const end = Math.min(items.length, Math.ceil((viewport.scrollTop + vh) / ROW_H) + 3);
    spacer.querySelectorAll('.label').forEach((el) => el.remove());
    for (let i = start; i < end; i++) {
        const it = items[i];
        const row = document.createElement('div');
        row.className = 'label';
        row.dataset.index = String(i);
        row.style.top = (i * ROW_H) + 'px';
        row.title = it.path;
        if (!it.entered) { row.classList.add('enter'); it.entered = true; }
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = it.isDir ? '\u{1F4C1}' : (it.isOurs ? '\u{1F5C3}\uFE0F' : '\u{1F4C4}');
        const txt = document.createElement('span');
        txt.className = 'txt';
        txt.textContent = it.base;
        row.appendChild(icon);
        row.appendChild(txt);
        row.addEventListener('click', () => removeItem(i, row));   // 点击删除 (要求 9)
        spacer.appendChild(row);
    }
}
viewport.addEventListener('scroll', renderList);

// 删除一项: 被点行淡出退场, 下方行经 top 过渡平滑上移顶上; 动画结束后重建同步虚拟窗口。
// 动画期间挡住新的删除 (最简语义), 滚动触发的重建会直接收敛到最终位置, 无害。
let removing = false;
function removeItem(index, rowEl) {
    if (removing) { return; }
    removing = true;
    if (!rowEl) { rowEl = spacer.querySelector('.label[data-index="' + index + '"]'); }
    if (rowEl) { rowEl.classList.add('exit'); }
    spacer.querySelectorAll('.label').forEach((el) => {
        const idx = Number(el.dataset.index);
        if (idx > index) {
            el.style.top = ((idx - 1) * ROW_H) + 'px';
            el.dataset.index = String(idx - 1);
        }
    });
    items.splice(index, 1);
    refresh();
    setTimeout(() => { renderList(); removing = false; }, 200);
}

// 拖放
['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('over'); });
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
dropEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropEl.classList.remove('over');
    const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.api.getPathForFile(f))
        .filter(Boolean);
    addPaths(paths);
});

// 打包 / 解包 (运行期间两键置灰, 结束后按状态机恢复)
let busy = false;
function setBusy(b) {
    busy = b;
    if (b) { packBtn.disabled = true; unpackBtn.disabled = true; }
    else { refresh(); }
}

packBtn.addEventListener('click', async () => {
    if (busy || !items.length) { return; }
    setBusy(true);
    const r = await window.api.pack(items.map((it) => it.path));
    setBusy(false);
    if (!r.ok) { console.error('pack failed:', r.error); }
});

unpackBtn.addEventListener('click', async () => {
    if (busy || !(items.length === 1 && items[0].isOurs)) { return; }
    setBusy(true);
    const r = await window.api.unpack(items[0].path);
    setBusy(false);
    if (!r.ok) { console.error('unpack failed:', r.error); }
});

// selftest 钩子 (与真实拖放走同一条 addPaths / 删除路径)
window.__testAddPath = (p) => addPaths([p]);
window.__testRemoveAt = (i) => { items.splice(i, 1); refresh(); renderList(); };
window.__testRemoveAnimated = (i) => removeItem(i);   // 走动画删除路径 (含退场/上移/重建)
window.__testScrollTo = (y) => { viewport.scrollTop = y; renderList(); };
window.__testState = () => ({
    name: nameEl.textContent,
    pack: !packBtn.disabled,
    unpack: !unpackBtn.disabled,
    labels: items.length,
});
window.__testScrollState = () => {
    const first = Math.floor(viewport.scrollTop / ROW_H);
    const row = spacer.querySelector('.label');
    const cs = row ? getComputedStyle(row) : null;
    return {
        scrollTop: viewport.scrollTop,
        spacerHeight: spacer.style.height,
        renderedRows: spacer.querySelectorAll('.label').length,
        firstVisible: items[first] ? items[first].base : null,
        rowProbe: cs ? 'opacity=' + cs.opacity + ',anim=' + cs.animationName : 'no-row',
    };
};
