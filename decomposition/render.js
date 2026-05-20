// === Renderer ===
let currentModule = 'cli';
let allNodes = [];

function renderApp() {
  renderNav();
  selectModule(currentModule);
}

function renderNav() {
  const nav = document.getElementById('nav-list');
  nav.innerHTML = MIND_MAP.modules.map(m => {
    const count = countNodes(m.tree);
    return `<div class="nav-item" data-id="${m.id}" onclick="selectModule('${m.id}')">
      <div class="nav-dot" style="background:${m.color}"></div>
      <span>${m.icon} ${m.title}</span>
      <span class="nav-count">${count}</span>
    </div>`;
  }).join('');
  const total = MIND_MAP.modules.reduce((s, m) => s + countNodes(m.tree), 0);
  document.getElementById('stats').textContent = `9 个模块 · ${total} 个节点`;
}

function countNodes(node) {
  if (!node) return 0;
  let c = 1;
  if (node.children) {
    for (const ch of node.children) c += countNodes(ch);
  }
  return c;
}

function selectModule(id) {
  currentModule = id;
  const m = MIND_MAP.modules.find(x => x.id === id);
  if (!m) return;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
    if (el.dataset.id === id) el.style.setProperty('--module-color', m.color);
  });
  document.getElementById('title').innerHTML = `<span style="color:${m.color}">${m.icon}</span> ${m.title}`;
  document.getElementById('summary').textContent = m.summary;
  const html = `<ul class="tree" data-module="${id}">${renderNode(m.tree, id, 0)}</ul>`;
  document.getElementById('content').innerHTML = html;
  collectAllNodes();
  // Default expand top + 1 level
  document.querySelectorAll('.tree > li > ul').forEach(ul => ul.classList.remove('collapsed'));
  document.querySelectorAll('.tree > li > .node-row .toggle').forEach(t => t.classList.replace('closed', 'open'));
}

function renderNode(node, moduleId, depth) {
  if (!node) return '';
  const hasChildren = node.children && node.children.length > 0;
  const tagClass = node.tag ? `tag-${node.tag}` : '';
  const tagLabel = node.tag ? node.tag.toUpperCase() : '';
  const collapsedClass = depth >= 1 ? 'collapsed' : '';
  const toggleClass = hasChildren ? (depth >= 1 ? 'closed' : 'open') : 'empty';
  return `<li data-module="${moduleId}" data-depth="${depth}">
    <div class="node-row" onclick="toggleNode(this)">
      <span class="toggle ${toggleClass}"></span>
      <span class="node-icon">${node.icon || (hasChildren ? '◆' : '◇')}</span>
      <div class="node-content">
        <div class="node-label">${node.label || ''}${tagLabel ? `<span class="node-tag ${tagClass}">${tagLabel}</span>` : ''}</div>
        ${node.desc ? `<div class="node-desc">${node.desc}</div>` : ''}
      </div>
    </div>
    ${hasChildren ? `<ul class="${collapsedClass}">${node.children.map(c => renderNode(c, moduleId, depth + 1)).join('')}</ul>` : ''}
  </li>`;
}

function toggleNode(rowEl) {
  const li = rowEl.parentElement;
  const ul = li.querySelector(':scope > ul');
  const toggle = rowEl.querySelector('.toggle');
  if (!ul) return;
  ul.classList.toggle('collapsed');
  if (ul.classList.contains('collapsed')) {
    toggle.classList.replace('open', 'closed');
  } else {
    toggle.classList.replace('closed', 'open');
  }
}

function expandAll() {
  document.querySelectorAll('#content ul').forEach(ul => ul.classList.remove('collapsed'));
  document.querySelectorAll('#content .toggle:not(.empty)').forEach(t => {
    t.classList.remove('closed');
    t.classList.add('open');
  });
}

function collapseAll() {
  document.querySelectorAll('#content > ul ul').forEach(ul => ul.classList.add('collapsed'));
  document.querySelectorAll('#content > ul li li .toggle:not(.empty)').forEach(t => {
    t.classList.remove('open');
    t.classList.add('closed');
  });
}

function expandToDepth(maxDepth) {
  document.querySelectorAll('#content li').forEach(li => {
    const d = parseInt(li.dataset.depth);
    const ul = li.querySelector(':scope > ul');
    const toggle = li.querySelector(':scope > .node-row .toggle');
    if (!ul) return;
    if (d < maxDepth) {
      ul.classList.remove('collapsed');
      if (toggle && !toggle.classList.contains('empty')) {
        toggle.classList.replace('closed', 'open');
        toggle.classList.add('open');
        toggle.classList.remove('closed');
      }
    } else {
      ul.classList.add('collapsed');
      if (toggle && !toggle.classList.contains('empty')) {
        toggle.classList.replace('open', 'closed');
        toggle.classList.add('closed');
        toggle.classList.remove('open');
      }
    }
  });
}

function collectAllNodes() {
  allNodes = Array.from(document.querySelectorAll('#content .node-row'));
}

// Search
document.addEventListener('DOMContentLoaded', () => {
  renderApp();
  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      document.querySelectorAll('#content .node-row').forEach(r => r.classList.remove('highlight'));
      return;
    }
    let firstMatch = null;
    document.querySelectorAll('#content .node-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      if (text.includes(q)) {
        row.classList.add('highlight');
        if (!firstMatch) firstMatch = row;
        // Expand ancestors
        let p = row.parentElement;
        while (p && p.id !== 'content') {
          if (p.tagName === 'UL') p.classList.remove('collapsed');
          if (p.tagName === 'LI') {
            const t = p.querySelector(':scope > .node-row .toggle');
            if (t && !t.classList.contains('empty')) {
              t.classList.remove('closed');
              t.classList.add('open');
            }
          }
          p = p.parentElement;
        }
      } else {
        row.classList.remove('highlight');
      }
    });
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});
