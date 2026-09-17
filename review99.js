let rv99Data = null;
let rv99SourceTabId = null;
let rv99RowsById = new Map();
let rv99ManualOptions = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IFPS_RESULTS_UPDATED') loadAndRender99();
  else if (msg.type === 'IFPS_APPLY_RESULT') handleApplyResult99(msg.rowId, msg.ok, msg.reason);
  else if (msg.type === 'IFPS_APPLY_DONE') finishApply99();
});

function escapeHtml99(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function bucketize99(rows) {
  const buckets = { alta: [], media: [], baixa: [] };
  for (const row of rows) {
    if (row.confidence === 'alta') buckets.alta.push(row);
    else if (row.confidence === 'media') buckets.media.push(row);
    else buckets.baixa.push(row);
  }
  return buckets;
}

function manualOptionLabel99(option) {
  return `${option.descricao} — ${option.codigo}`;
}

function manualSearch99(row) {
  if (!rv99ManualOptions.length) return '';
  return `<input type="search" class="rv-alt-search" data-rowid="${row.rowId}" list="rv99-pratos-list" placeholder="Buscar prato ou código Saipos..." autocomplete="off" />`;
}

function rowHtml99(row, defaultChecked) {
  const canApply = !!row.novoCodigo;
  const currentPdv = row.codigoAtual
    ? `<div class="rv-current-code">Atual no 99Food: <strong>${escapeHtml99(row.codigoAtual)}</strong>${row.pratoAtualNome ? ` — ${escapeHtml99(row.pratoAtualNome)}` : ' — código não encontrado na planilha ativa'}</div>`
    : '';
  return `<tr class="${row.itemInativo ? 'rv-row-inativo' : ''}">
    <td><input type="checkbox" class="rv-check" data-rowid="${row.rowId}" ${defaultChecked && canApply ? 'checked' : ''} ${canApply ? '' : 'disabled'} /></td>
    <td class="rv-categoria">${escapeHtml99(row.categoria99 || row.categoriaIfood || '')}</td>
    <td class="rv-item-name">${escapeHtml99(row.itemName)}${row.itemInativo ? ' <span class="rv-inativo-tag">🔕 indisponível</span>' : ''}</td>
    <td>${currentPdv}<div class="rv-suggestion-name" data-suggestion-name="${row.rowId}">${row.pratoNome ? escapeHtml99(row.pratoNome) : '<span class="rv-parent-code">nenhum prato confiável encontrado</span>'}</div><div class="rv-parent-code" data-suggestion-code="${row.rowId}">${row.novoCodigo ? `Sugestão: ${escapeHtml99(row.novoCodigo)}` : ''}</div>${manualSearch99(row)}</td>
    <td>${Number(row.score || 0).toFixed(2)}<div class="rv-status" data-status-for="${row.rowId}"></div></td>
  </tr>`;
}

function tableHtml99(rows, defaultChecked) {
  if (!rows.length) return '<p class="rv-section-hint">Nenhum produto nessa faixa.</p>';
  return `<table class="rv-table"><thead><tr><th><input type="checkbox" class="rv-check-all" title="Selecionar todos de todas as categorias" aria-label="Selecionar todos de todas as categorias" /></th><th>Categoria (99Food)</th><th>Produto (99Food)</th><th>Prato Saipos / Código PDV</th><th>Score</th></tr></thead>
    <tbody>${rows.map((row) => rowHtml99(row, defaultChecked)).join('')}</tbody></table>`;
}

function render99() {
  const rows = rv99Data.produtosPai || [];
  rv99ManualOptions = (rv99Data.pratosSaipos || []).filter((option) => option && option.codigo && option.descricao);
  if (!rv99ManualOptions.length) {
    const seenCodes = new Set();
    rv99ManualOptions = rows.flatMap((row) => row.alternativas || []).filter((option) => {
      const code = String(option.codigo || '').toLowerCase();
      if (!code || seenCodes.has(code)) return false;
      seenCodes.add(code);
      return true;
    }).sort((a, b) => String(a.descricao).localeCompare(String(b.descricao), 'pt-BR'));
  }
  const buckets = bucketize99(rows);
  const inativos = rows.filter((row) => row.itemInativo).length;
  const totalLidos = Number(rv99Data.itemsScanned || rows.length);
  document.getElementById('rv-summary-bar').innerHTML = `
    <div class="rv-stat"><strong>${totalLidos}</strong> produtos lidos</div>
    <div class="rv-stat"><strong>${rv99Data.jaCorretos || 0}</strong> PDVs corretos ocultados</div>
    <div class="rv-stat"><strong>${rv99Data.pdvPreenchidosIncorretos || 0}</strong> PDVs preenchidos para corrigir</div>
    <div class="rv-stat"><strong>${buckets.alta.length}</strong> prontos para aplicar</div>
    <div class="rv-stat"><strong>${buckets.media.length + buckets.baixa.length}</strong> para analisar</div>
    <div class="rv-stat"><strong>${inativos}</strong> indisponíveis 🔕</div>`;

  document.getElementById('rv-main').innerHTML = `
    <datalist id="rv99-pratos-list">${rv99ManualOptions.map((option) => `<option value="${escapeHtml99(manualOptionLabel99(option))}"></option>`).join('')}</datalist>
    <div class="rv-saipos-warning"><strong>Importante:</strong> produtos com Código PDV já coerente foram ocultados. Um código preenchido continua listado quando aponta para um prato incompatível ou não existe na planilha ativa. Revise as sugestões antes de aplicar.</div>
    <details class="rv-section rv-sec-alta" open>
      <summary>Prontos para aplicar — alta confiança <span class="rv-count-badge">${buckets.alta.length}</span></summary>
      <div class="rv-section-body"><p class="rv-section-hint">Já vêm marcados. Desmarque qualquer produto que não queira alterar.</p>${tableHtml99(buckets.alta, true)}</div>
    </details>
    <details class="rv-section rv-sec-media" open>
      <summary>Para revisar — confiança média <span class="rv-count-badge">${buckets.media.length}</span></summary>
      <div class="rv-section-body"><p class="rv-section-hint">Confira o prato sugerido. Você pode trocar pelo menu e marcar manualmente.</p>${tableHtml99(buckets.media, false)}</div>
    </details>
    <details class="rv-section rv-sec-baixa">
      <summary>Score baixo / sem correspondência <span class="rv-count-badge">${buckets.baixa.length}</span></summary>
      <div class="rv-section-body"><p class="rv-section-hint">Escolha manualmente um prato da planilha ou deixe desmarcado.</p>${tableHtml99(buckets.baixa, false)}</div>
    </details>`;

  document.querySelectorAll('.rv-check').forEach((el) => el.addEventListener('change', updateApplyCount99));
  document.querySelectorAll('.rv-check-all').forEach((el) => el.addEventListener('change', (event) => {
    setSection99(event.target, event.target.checked);
  }));
  document.querySelectorAll('.rv-alt-search').forEach((el) => {
    el.addEventListener('input', onAlternativeSearch99);
    el.addEventListener('change', onAlternativeSearch99);
  });
  updateApplyCount99();
}

async function loadAndRender99() {
  const stored = await chrome.storage.local.get(['ifpsMatches', 'ifpsSourceTabId', 'ifpsSavedAt']);
  if (!stored.ifpsMatches || stored.ifpsMatches.platform !== '99food') {
    document.getElementById('rv-empty').style.display = 'block';
    return;
  }
  rv99Data = stored.ifpsMatches;
  rv99SourceTabId = stored.ifpsSourceTabId;
  rv99RowsById = new Map((rv99Data.produtosPai || []).map((row) => [row.rowId, row]));
  const when = stored.ifpsSavedAt ? new Date(stored.ifpsSavedAt).toLocaleString('pt-BR') : '';
  document.getElementById('rv-meta').textContent = `Gerado em ${when} · ${rv99Data.itemsScanned || 0} produtos do 99Food lidos · ${rv99Data.jaCorretos || 0} já corretos ocultados${rv99Data.skippedInativo ? ` · ${rv99Data.skippedInativo} linha(s) inativa(s) da planilha ignorada(s)` : ''}`;
  render99();
}

function onAlternativeSearch99(event) {
  const row = rv99RowsById.get(Number(event.target.dataset.rowid));
  const tr = event.target.closest('tr');
  const checkbox = tr && tr.querySelector('.rv-check');
  if (!row || !checkbox) return;
  const typed = String(event.target.value || '').trim();
  if (!typed) return;
  const normalizedTyped = typed.toLocaleLowerCase('pt-BR');
  const selected = rv99ManualOptions.find((option) => {
    return manualOptionLabel99(option).toLocaleLowerCase('pt-BR') === normalizedTyped
      || String(option.codigo).toLocaleLowerCase('pt-BR') === normalizedTyped;
  });
  if (!selected) return;

  row.novoCodigo = selected.codigo;
  row.pratoNome = selected.descricao;
  event.target.value = manualOptionLabel99(selected);
  const suggestionName = tr.querySelector(`[data-suggestion-name="${row.rowId}"]`);
  const suggestionCode = tr.querySelector(`[data-suggestion-code="${row.rowId}"]`);
  if (suggestionName) suggestionName.textContent = selected.descricao;
  if (suggestionCode) suggestionCode.textContent = `Escolhido manualmente: ${selected.codigo}`;
  checkbox.disabled = false;
  checkbox.checked = true;
  updateApplyCount99();
}

function checked99() {
  return [...document.querySelectorAll('.rv-check:checked')];
}

function selectable99() {
  return [...document.querySelectorAll('.rv-check:not(:disabled)')];
}

function setAll99(checked) {
  selectable99().forEach((checkbox) => { checkbox.checked = checked; });
  updateApplyCount99();
}

function setSection99(masterCheckbox, checked) {
  const table = masterCheckbox.closest('table');
  if (!table) return;
  table.querySelectorAll('.rv-check:not(:disabled)').forEach((checkbox) => {
    checkbox.checked = checked;
  });
  updateApplyCount99();
}

function updateSelectAllButton99() {
  const button = document.getElementById('rv-btn-select-all');
  const available = selectable99();
  const selectedCount = available.filter((checkbox) => checkbox.checked).length;
  const allSelected = available.length > 0 && selectedCount === available.length;
  const isApplying = !!window._rv99ApplyTotal;
  button.disabled = available.length === 0 || !!window._rv99ApplyTotal;
  button.textContent = allSelected
    ? `Desmarcar todos (${available.length})`
    : `Selecionar todos (${available.length})`;
  document.querySelectorAll('.rv-check-all').forEach((checkbox) => {
    const table = checkbox.closest('table');
    const sectionRows = table ? [...table.querySelectorAll('.rv-check:not(:disabled)')] : [];
    const sectionSelected = sectionRows.filter((rowCheckbox) => rowCheckbox.checked).length;
    const sectionAllSelected = sectionRows.length > 0 && sectionSelected === sectionRows.length;
    checkbox.disabled = sectionRows.length === 0 || isApplying;
    checkbox.checked = sectionAllSelected;
    checkbox.indeterminate = sectionSelected > 0 && !sectionAllSelected;
    checkbox.title = sectionAllSelected ? 'Desmarcar esta seção' : 'Selecionar toda esta seção';
  });
}

function updateApplyCount99() {
  const count = checked99().length;
  const button = document.getElementById('rv-btn-apply');
  button.disabled = count === 0;
  button.textContent = count ? `⚠️ Aplicar selecionados (${count})` : '⚠️ Aplicar selecionados';
  updateSelectAllButton99();
}

document.getElementById('rv-btn-select-all').addEventListener('click', () => {
  const available = selectable99();
  const shouldSelect = available.some((checkbox) => !checkbox.checked);
  setAll99(shouldSelect);
});

document.getElementById('rv-btn-apply').addEventListener('click', () => {
  const selected = checked99();
  const rows = selected
    .map((checkbox) => rv99RowsById.get(Number(checkbox.dataset.rowid)))
    .filter((row) => row && row.novoCodigo)
    .map((row) => ({
      rowId: row.rowId,
      itemName: row.itemName,
      categoria99: row.categoria99,
      itemOrdinal: row.itemOrdinal,
      novoCodigo: row.novoCodigo,
    }));
  if (!rows.length) return;

  const confirmed = window.confirm(`Isso vai pesquisar e salvar ${rows.length} produto${rows.length === 1 ? '' : 's'} pela coluna Código PDV da aba Itens do 99Food.\n\nNão feche nem use a aba do 99Food durante o processo. Confirma?`);
  if (!confirmed) return;

  window._rv99ApplyTotal = rows.length;
  window._rv99ApplyDone = 0;
  window._rv99Results = { ok: 0, fail: 0 };
  const button = document.getElementById('rv-btn-apply');
  button.disabled = true;
  button.textContent = `Aplicando 0/${rows.length}...`;
  document.getElementById('rv-btn-select-all').disabled = true;
  selected.forEach((checkbox) => {
    const status = document.querySelector(`[data-status-for="${checkbox.dataset.rowid}"]`);
    if (status) status.textContent = 'na fila...';
  });

  chrome.runtime.sendMessage({
    type: 'IFPS_APPLY_ROWS',
    platform: '99food',
    targetTabId: rv99SourceTabId,
    rows,
  }).then((response) => {
    if (!response || !response.ok) {
      alert('Não consegui iniciar a aplicação no 99Food: ' + (response && response.error ? response.error : 'aba do cardápio não encontrada'));
      finishApply99();
    }
  }).catch((err) => {
    alert('Não consegui falar com a aba do 99Food: ' + err.message);
    finishApply99();
  });
});

function handleApplyResult99(rowId, ok, reason) {
  const status = document.querySelector(`[data-status-for="${rowId}"]`);
  if (status) {
    status.textContent = ok ? (reason === 'já estava correto' ? '✔ já correto' : '✔ aplicado') : '✘ ' + (reason || 'falhou');
    status.className = ok ? 'rv-status rv-ok' : 'rv-status rv-fail';
  }
  window._rv99ApplyDone = (window._rv99ApplyDone || 0) + 1;
  if (!window._rv99Results) window._rv99Results = { ok: 0, fail: 0 };
  window._rv99Results[ok ? 'ok' : 'fail']++;
  const button = document.getElementById('rv-btn-apply');
  if (window._rv99ApplyTotal) button.textContent = `Aplicando ${window._rv99ApplyDone}/${window._rv99ApplyTotal}...`;
}

function finishApply99() {
  const results = window._rv99Results || { ok: 0, fail: 0 };
  window._rv99ApplyTotal = null;
  window._rv99ApplyDone = null;
  window._rv99Results = null;
  updateApplyCount99();
  const footer = document.getElementById('rv-final-summary');
  footer.style.display = 'block';
  footer.innerHTML = `<strong>Resumo</strong><br />✔ ${results.ok} produto(s) concluído(s) · ✘ ${results.fail} falha(s).`;
}

document.getElementById('rv-btn-export').addEventListener('click', () => {
  if (!rv99Data) return;
  const csvRows = [['Categoria 99Food', 'Produto 99Food', 'Prato Saipos sugerido', 'Código PDV', 'Confiança', 'Score']];
  for (const row of rv99Data.produtosPai || []) {
    csvRows.push([row.categoria99 || '', row.itemName, row.pratoNome || '', row.novoCodigo || '', row.confidence, Number(row.score || 0).toFixed(3)]);
  }
  const csv = '\ufeff' + csvRows.map((cols) => cols.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `pdv-sync-99food-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

loadAndRender99();
