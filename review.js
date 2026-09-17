// review.js — roda numa aba própria da extensão (leve, sem o peso do
// portal iFood). Lê os resultados calculados pelo content.js (via
// chrome.storage.local), mostra tudo separado por etapa, e manda pedidos de
// "aplicar" de volta para a aba original do iFood através do background.

let rvData = null; // { rows, produtosPai, semPlanilha, semCodigoPai, skippedInativo }
let rvSourceTabId = null;
let rvRowsById = new Map();
// Qual aba está visível agora ('complemento', 'produto' ou 'saipos') — o
// botão "Aplicar selecionados" só olha pros checkboxes marcados dentro da
// aba ativa, pra não misturar seleção de uma aba com a outra sem querer.
let rvActiveTab = 'complemento';

// Estado da aba "Criar no Saipos": mapa de categorias (nome -> id) buscado
// sob demanda na aba do Saipos, e o id da última linha aplicada (só pra
// controle de UI, nada é persistido entre sessões).
let rvSaiposCategorias = null; // null = ainda não buscado
let rvSaiposLoading = false;

// Itens da aba "Produtos pai" que o usuário marcou manualmente (a partir do
// botão "🆕 Criar no Saipos" numa linha de "para revisar") pra também
// aparecerem na aba "Criar no Saipos", mesmo não sendo semCorrespondencia
// (ou seja, mesmo tendo achado ALGUM prato parecido, só que errado/fraco o
// bastante pro usuário decidir que o certo é cadastrar do zero). Guarda só
// rowId — nada é persistido entre sessões, some se a página recarregar.
let rvManualSaiposRowIds = new Set();

document.addEventListener('DOMContentLoaded', () => {
  loadAndRender();
  // Registrados uma única vez aqui: o container #rv-main persiste entre
  // re-renderizações (só o innerHTML dele muda), então esses listeners não
  // podem ser recriados a cada render() — duplicariam a cada nova rodada.
  document.getElementById('rv-main').addEventListener('change', (ev) => {
    onAltSelectChange(ev);
    onSaiposCategoriaChange(ev);
    updateApplyButtonCount();
  });

  document.getElementById('rv-main').addEventListener('click', (ev) => {
    onSaiposMainClick(ev);
  });

  document.getElementById('rv-tabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.rv-tab-btn');
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'IFPS_RESULTS_UPDATED') {
    loadAndRender();
  } else if (msg.type === 'IFPS_APPLY_RESULT') {
    handleApplyResult(msg.rowId, msg.ok, msg.reason);
  } else if (msg.type === 'IFPS_APPLY_DONE') {
    finishApply();
  }
});

async function loadAndRender() {
  const { ifpsMatches, ifpsSourceTabId, ifpsSavedAt } = await chrome.storage.local.get([
    'ifpsMatches',
    'ifpsSourceTabId',
    'ifpsSavedAt',
  ]);

  if (!ifpsMatches) {
    document.getElementById('rv-empty').style.display = 'block';
    return;
  }

  rvData = ifpsMatches;
  rvSourceTabId = ifpsSourceTabId;
  rvRowsById = new Map([...rvData.rows, ...(rvData.produtosPai || [])].map((r) => [r.rowId, r]));

  const when = ifpsSavedAt ? new Date(ifpsSavedAt).toLocaleString('pt-BR') : '';
  document.getElementById('rv-meta').textContent = `Gerado em ${when}${rvData.itemsScanned != null ? ` · ${rvData.itemsScanned} itens do cardápio lidos` : ''}${rvData.skippedInativo ? ` · ${rvData.skippedInativo} linha(s) "Inativo" da planilha foram ignoradas` : ''}${rvData.semOpcaoNoIfood ? ` · ${rvData.semOpcaoNoIfood} linha(s) da planilha sem opção correspondente no iFood (ignoradas — não têm campo pra preencher)` : ''}`;

  render();
}

function bucketize(rows) {
  // Item pausado/inativo no iFood entra na mesma classificação de confiança
  // que qualquer outro (correto/alta/média/baixa) — não fica mais separado
  // numa seção própria escondida por padrão. A única diferença visual é o
  // destaque de cor na linha (ver rvRowInativoClass), pra você ainda
  // conseguir identificar rapidinho quais são sem precisar abrir uma seção
  // à parte.
  const b = { correto_ok: [], correto_suspeito: [], alta: [], media: [], baixa: [] };
  for (const r of rows) {
    if (r.confidence === 'correto') (r.nomeSuspeito ? b.correto_suspeito : b.correto_ok).push(r);
    else if (r.confidence === 'alta') b.alta.push(r);
    else if (r.confidence === 'media') b.media.push(r);
    else b.baixa.push(r);
  }
  return b;
}

// Classe CSS extra pra destacar (cor de fundo diferente) a linha de um item
// pausado/inativo no iFood, agora que ele aparece misturado com os ativos
// em vez de numa seção separada.
function rvRowInativoClass(row) {
  return row.itemInativo ? ' rv-row-inativo' : '';
}

function rvInativoTag(row) {
  return row.itemInativo ? ' <span class="rv-inativo-tag" title="Item pausado/inativo no iFood agora">🔕 inativo</span>' : '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function altSelectHtml(row) {
  if (!row.alternativas || !row.alternativas.length) return '';
  return `<select class="rv-alt-select" data-rowid="${row.rowId}">
    <option value="">— manter sugestão / ignorar —</option>
    ${row.alternativas
      .map((a) => `<option value="${escapeHtml(a.inputId || '')}" data-optionid="${escapeHtml(a.optionid || '')}">${escapeHtml(a.optionName)}${a.groupHeading ? ' — ' + escapeHtml(a.groupHeading) : ''}</option>`)
      .join('')}
  </select>`;
}

function rowHtml(row, { checkbox, defaultChecked }) {
  const checkCell = checkbox
    ? `<input type="checkbox" class="rv-check" data-rowid="${row.rowId}" ${defaultChecked && row.inputId ? 'checked' : ''} ${row.inputId ? '' : 'disabled'} />`
    : '';
  const opcao = row.opcaoIfood
    ? escapeHtml(row.opcaoIfood) + (row.grupoIfood ? `<div class="rv-parent-code">${escapeHtml(row.grupoIfood)}</div>` : '')
    : '<span class="rv-parent-code">nenhuma opção parecida encontrada</span>';

  return `<tr class="${rvRowInativoClass(row).trim()}">
    <td>${checkCell}</td>
    <td class="rv-categoria">${row.categoriaIfood ? escapeHtml(row.categoriaIfood) : '<span class="rv-parent-code">—</span>'}</td>
    <td class="rv-item-name" title="${escapeHtml(row.itemName)}">${escapeHtml(row.itemName)}${rvInativoTag(row)}<div class="rv-parent-code">código pai ${escapeHtml(row.parentCode)}</div>${row.saiposDescricao ? `<div class="rv-parent-code rv-saipos-desc">Saipos: ${escapeHtml(row.saiposDescricao)}</div>` : ''}</td>
    <td>${escapeHtml(row.saiposNome)}<div class="rv-parent-code">${escapeHtml(row.saiposCodigo)}</div></td>
    <td>${opcao}${checkbox ? altSelectHtml(row) : ''}</td>
    <td>${escapeHtml(row.valorAtual)}</td>
    <td><strong>${escapeHtml(row.novoCodigo)}</strong>${row.duplicataDe ? `<div class="rv-parent-code">código atual já é de "${escapeHtml(row.duplicataDe)}" (linha equivalente na planilha)</div>` : ''}</td>
    <td>${row.score.toFixed(2)}<div class="rv-status" data-status-for="${row.rowId}"></div></td>
  </tr>`;
}

function tableHtml(rows, { checkbox, defaultChecked }) {
  if (!rows.length) return '<p class="rv-section-hint">Nenhum item nessa categoria.</p>';
  const head = `<thead><tr>
    <th></th><th>Categoria (iFood)</th><th>Item (iFood)</th><th>Complemento (Saipos)</th><th>Opção sugerida</th><th>Código atual</th><th>Novo código</th><th>Score</th>
  </tr></thead>`;
  const body = rows.map((r) => rowHtml(r, { checkbox, defaultChecked })).join('');
  return `<table class="rv-table">${head}<tbody>${body}</tbody></table>`;
}

// ---------- seção "produtos pai" (compara o item inteiro, não os complementos) ----------

function produtoAltSelectHtml(row) {
  if (!row.alternativas || !row.alternativas.length) return '';
  return `<select class="rv-alt-select" data-rowid="${row.rowId}" data-mode="produto">
    <option value="">— manter sugestão / ignorar —</option>
    ${row.alternativas
      .map((a) => `<option value="${escapeHtml(a.codigo || '')}">${escapeHtml(a.descricao)} — ${escapeHtml(a.codigo)}</option>`)
      .join('')}
  </select>`;
}

// Botão/selo que aparece na coluna do prato sugerido, só nos buckets "média"
// e "baixa" (score alto e "já corretos" já são sugestões confiáveis o
// bastante pra não precisar dessa saída) — deixa o usuário mandar um item
// direto pra aba "Criar no Saipos" quando percebe que a sugestão da
// planilha está errada e o produto na verdade está FALTANDO no Saipos.
function saiposInlineActionHtml(row) {
  if (row.semCorrespondencia) {
    return '<div class="rv-parent-code rv-produto-saipos-flag">✔ já está na aba "Criar no Saipos" (sem correspondência)</div>';
  }
  if (rvManualSaiposRowIds.has(row.rowId)) {
    return `<button type="button" class="rv-produto-btn-saipos rv-produto-btn-saipos-undo" data-rowid="${row.rowId}">✔ na aba "Criar no Saipos" — desfazer</button>`;
  }
  return `<button type="button" class="rv-produto-btn-saipos" data-rowid="${row.rowId}">🆕 Criar no Saipos</button>`;
}

function produtoRowHtml(row, { checkbox, defaultChecked, showSaiposAction }) {
  const canApply = !!row.novoCodigo && row.novoCodigo !== row.codigoAtual;
  const checkCell = checkbox
    ? `<input type="checkbox" class="rv-check" data-rowid="${row.rowId}" ${defaultChecked && canApply ? 'checked' : ''} ${canApply ? '' : 'disabled'} />`
    : '';
  const prato = row.pratoNome
    ? escapeHtml(row.pratoNome) + `<div class="rv-parent-code">${escapeHtml(row.novoCodigo)}</div>`
    : '<span class="rv-parent-code">nenhum prato parecido encontrado na planilha</span>';

  return `<tr class="${rvRowInativoClass(row).trim()}">
    <td>${checkCell}</td>
    <td class="rv-categoria">${row.categoriaIfood ? escapeHtml(row.categoriaIfood) : '<span class="rv-parent-code">—</span>'}</td>
    <td class="rv-item-name" title="${escapeHtml(row.itemName)}">${escapeHtml(row.itemName)}${rvInativoTag(row)}</td>
    <td>${row.codigoAtual ? escapeHtml(row.codigoAtual) : '<span class="rv-parent-code">(vazio)</span>'}</td>
    <td>${prato}${checkbox ? produtoAltSelectHtml(row) : ''}${showSaiposAction ? saiposInlineActionHtml(row) : ''}</td>
    <td>${row.score.toFixed(2)}<div class="rv-status" data-status-for="${row.rowId}"></div></td>
  </tr>`;
}

function produtoTableHtml(rows, { checkbox, defaultChecked, showSaiposAction }) {
  if (!rows.length) return '<p class="rv-section-hint">Nenhum item nessa categoria.</p>';
  const head = `<thead><tr>
    <th></th><th>Categoria (iFood)</th><th>Item (iFood)</th><th>Código pai atual</th><th>Prato Saipos (nome sugerido / código)</th><th>Score</th>
  </tr></thead>`;
  const body = rows.map((r) => produtoRowHtml(r, { checkbox, defaultChecked, showSaiposAction })).join('');
  return `<table class="rv-table">${head}<tbody>${body}</tbody></table>`;
}

function render() {
  const b = bucketize(rvData.rows);
  const main = document.getElementById('rv-main');
  document.getElementById('rv-empty').style.display = 'none';

  const totalCorreto = b.correto_ok.length + b.correto_suspeito.length;
  const pAll = rvData.produtosPai || [];
  const pSuspeitos = pAll.filter((r) => !r.itemInativo && r.confidence !== 'correto').length;
  const totalInativos = rvData.rows.filter((r) => r.itemInativo).length;

  document.getElementById('rv-summary-bar').innerHTML = `
    <div class="rv-stat"><strong>${totalInativos}</strong> em itens inativos 🔕</div>
    <div class="rv-stat"><strong>${totalCorreto}</strong> já corretos</div>
    <div class="rv-stat"><strong>${b.alta.length}</strong> prontos para aplicar</div>
    <div class="rv-stat"><strong>${b.media.length + b.baixa.length}</strong> para você analisar</div>
    <div class="rv-stat"><strong>${rvData.semPlanilha.length}</strong> itens sem linha na planilha</div>
    <div class="rv-stat"><strong>${rvData.semCodigoPai.length}</strong> itens sem código pai</div>
    ${pAll.length ? `<div class="rv-stat"><strong>${pSuspeitos}</strong> produtos pai a revisar 🍕</div>` : ''}
  `;

  // ---- Aba "Produtos pai": compara o item inteiro (não os complementos)
  // contra as linhas tipo PRATO da planilha, pra conferir se o código pai
  // que você já digitou no iFood é mesmo o produto certo.
  const sectionsProduto = [];
  const p = bucketize(rvData.produtosPai || []);
  const pTotalCorreto = p.correto_ok.length + p.correto_suspeito.length;

  if (rvData.produtosPai && rvData.produtosPai.length) {
    sectionsProduto.push(`
      <details class="rv-section rv-sec-correto">
        <summary>Já corretos <span class="rv-count-badge">${pTotalCorreto}</span></summary>
        <div class="rv-section-body">
          <p class="rv-section-hint">
            ${p.correto_ok.length} desses o código pai já bate com o nome do item — nada a revisar.
            ${p.correto_suspeito.length ? `Os ${p.correto_suspeito.length} abaixo têm o código atual considerado certo (não achamos nenhum prato pra sugerir no lugar), mas vale um olhar rápido: ou outro prato da planilha ficou quase empatado no nome, ou o nome do item ficou bem diferente do nome do prato mesmo sendo o melhor candidato — pode ser só uma diferença de descrição, ou o código pai pode estar errado sem prato correspondente cadastrado na planilha.` : ''}
          </p>
          ${p.correto_suspeito.length ? produtoTableHtml(p.correto_suspeito, { checkbox: false }) : ''}
        </div>
      </details>
    `);

    sectionsProduto.push(`
      <details class="rv-section rv-sec-alta" open>
        <summary>Prontos para aplicar — alta confiança <span class="rv-count-badge">${p.alta.length}</span></summary>
        <div class="rv-section-body">
          <p class="rv-section-hint">O código pai atual do campo não bate com o nome do item, mas achamos um prato na planilha que bate bem — já vem marcado. Desmarque o que não quiser aplicar.</p>
          ${produtoTableHtml(p.alta, { checkbox: true, defaultChecked: true })}
        </div>
      </details>
    `);

    sectionsProduto.push(`
      <details class="rv-section rv-sec-media">
        <summary>Para revisar — confiança média <span class="rv-count-badge">${p.media.length}</span></summary>
        <div class="rv-section-body">
          <p class="rv-section-hint">Nome parecido, mas não o suficiente pra aplicar sozinho. Marque manualmente ou troque a sugestão. Se a sugestão bateu com o produto errado (o certo é que esse item nem existe na planilha), clique em "🆕 Criar no Saipos" pra mandar direto pra aba de cadastro.</p>
          ${produtoTableHtml(p.media, { checkbox: true, defaultChecked: false, showSaiposAction: true })}
        </div>
      </details>
    `);

    sectionsProduto.push(`
      <details class="rv-section rv-sec-baixa">
        <summary>Score baixo / sem correspondência <span class="rv-count-badge">${p.baixa.length}</span></summary>
        <div class="rv-section-body">
          <p class="rv-section-hint">Ou o nome do item ficou bem diferente do prato sugerido, ou não achamos nenhum prato parecido na planilha pra esse código pai. Confira manualmente, ou clique em "🆕 Criar no Saipos" se o produto realmente estiver faltando.</p>
          ${produtoTableHtml(p.baixa, { checkbox: true, defaultChecked: false, showSaiposAction: true })}
        </div>
      </details>
    `);
  } else {
    sectionsProduto.push(`<p class="rv-section-hint">A planilha carregada não tem linhas do tipo "PRATO" (produto), então não há o que comparar aqui.</p>`);
  }

  // ---- Aba "Complementos": fluxo original.
  const sectionsComplemento = [];

  // Já corretos — só a contagem some aqui em cima; se algum nome bater mal
  // mesmo com o código já certo, mostramos separado pra você conferir (pode
  // ser coincidência de código, não necessariamente a opção certa).
  sectionsComplemento.push(`
    <details class="rv-section rv-sec-correto">
      <summary>Já corretos <span class="rv-count-badge">${totalCorreto}</span></summary>
      <div class="rv-section-body">
        <p class="rv-section-hint">
          ${b.correto_ok.length} desses o código já bate e o nome do complemento também é parecido o bastante — nada a revisar.
          ${b.correto_suspeito.length ? `Os ${b.correto_suspeito.length} abaixo têm o código atual considerado certo, mas vale um olhar rápido: ou o nome ficou bem diferente do da planilha (pode ser coincidência de código), ou o código atual bate com OUTRA linha da planilha pro mesmo sabor/produto (planilha com entrada duplicada) — nesse caso "Novo código" e "Código atual" podem aparecer diferentes mesmo os dois estando certos.` : ''}
        </p>
        ${b.correto_suspeito.length ? tableHtml(b.correto_suspeito, { checkbox: false }) : ''}
      </div>
    </details>
  `);

  sectionsComplemento.push(`
    <details class="rv-section rv-sec-alta" open>
      <summary>Prontos para aplicar — alta confiança <span class="rv-count-badge">${b.alta.length}</span></summary>
      <div class="rv-section-body">
        <p class="rv-section-hint">Já vêm marcados. Desmarque o que não quiser aplicar.</p>
        ${tableHtml(b.alta, { checkbox: true, defaultChecked: true })}
      </div>
    </details>
  `);

  sectionsComplemento.push(`
    <details class="rv-section rv-sec-media">
      <summary>Para revisar — confiança média <span class="rv-count-badge">${b.media.length}</span></summary>
      <div class="rv-section-body">
        <p class="rv-section-hint">Nome parecido, mas não o suficiente pra aplicar sozinho. Marque manualmente ou troque a opção sugerida.</p>
        ${tableHtml(b.media, { checkbox: true, defaultChecked: false })}
      </div>
    </details>
  `);

  sectionsComplemento.push(`
    <details class="rv-section rv-sec-baixa">
      <summary>Score baixo — confira com atenção <span class="rv-count-badge">${b.baixa.length}</span></summary>
      <div class="rv-section-body">
        <p class="rv-section-hint">Achou uma opção no iFood pra comparar, mas o nome ficou bem diferente do da planilha. Escolha manualmente se souber qual é, ou ignore.</p>
        ${tableHtml(b.baixa, { checkbox: true, defaultChecked: false })}
      </div>
    </details>
  `);

  if (rvData.semPlanilha.length || rvData.semCodigoPai.length) {
    sectionsComplemento.push(`
      <details class="rv-section rv-sec-misc">
        <summary>Itens do iFood fora do casamento <span class="rv-count-badge">${rvData.semPlanilha.length + rvData.semCodigoPai.length}</span></summary>
        <div class="rv-section-body">
          ${rvData.semPlanilha.length ? `<p class="rv-section-hint"><strong>Sem linha na planilha</strong> (código pai preenchido no iFood, mas nenhum complemento com esse código na Saipos):</p><div class="rv-misc-list">${rvData.semPlanilha.map((i) => escapeHtml(i.itemName) + ' <span class="rv-parent-code">(' + escapeHtml(i.parentCode) + ')' + (i.itemInativo ? ' · inativo' : '') + '</span>').join('<br />')}</div>` : ''}
          ${rvData.semCodigoPai.length ? `<p class="rv-section-hint" style="margin-top:12px;"><strong>Sem código pai preenchido no iFood ainda:</strong></p><div class="rv-misc-list">${rvData.semCodigoPai.map((i) => escapeHtml(i.itemName) + (i.itemInativo ? ' <span class="rv-parent-code">· inativo</span>' : '')).join('<br />')}</div>` : ''}
        </div>
      </details>
    `);
  }

  // ---- Aba "Criar no Saipos": itens do iFood que não acharam NENHUM
  // prato parecido na planilha — candidatos a produto que falta cadastrar
  // no Saipos de verdade. Inclui os pausados/inativos também (só destacados
  // na linha), igual nas outras abas.
  const saiposFaltantes = (rvData.produtosPai || []).filter(
    (r) => r.semCorrespondencia || rvManualSaiposRowIds.has(r.rowId)
  );

  main.innerHTML = `
    <div class="rv-tab-panel" data-tab="complemento" ${rvActiveTab === 'complemento' ? '' : 'hidden'}>${sectionsComplemento.join('')}</div>
    <div class="rv-tab-panel" data-tab="produto" ${rvActiveTab === 'produto' ? '' : 'hidden'}>${sectionsProduto.join('')}</div>
    <div class="rv-tab-panel" data-tab="saipos" ${rvActiveTab === 'saipos' ? '' : 'hidden'}>${saiposPanelHtml(saiposFaltantes)}</div>
  `;

  updateTabCounts(b, p, saiposFaltantes.length);
  document.getElementById('rv-btn-apply').disabled = false;
  updateApplyButtonCount();
  updateApplyWrapVisibility();
}

// ---------- aba "Criar no Saipos" ----------

function saiposPanelHtml(faltantes) {
  if (!faltantes.length) {
    return `<p class="rv-section-hint">Nenhum item do iFood ficou sem prato correspondente na planilha — nada faltando pra cadastrar no Saipos.</p>`;
  }

  const warning = `
    <div class="rv-saipos-warning">
      <strong>⚠️ Isso cria produto de verdade no cardápio do Saipos</strong> — diferente do resto da extensão (que só corrige
      um campo de integração do iFood), aqui a extensão escreve direto na fonte de dados real do seu cardápio. Confira o nome e a
      categoria de cada item antes de clicar em "Criar no Saipos". O cadastro roda um item por vez, com confirmação antes de cada um.
      Itens pausados/inativos no iFood agora aparecem destacados na linha — provavelmente não vale a pena cadastrar ainda.
      <br /><strong>⚠️ O produto criado nasce sem nenhum complemento vinculado</strong> — se a coluna "Complementos no iFood" mostrar
      que o item tem grupos (tamanho, sabores, adicionais etc.), você vai precisar montar esses complementos manualmente no Saipos
      depois de criar o produto básico; a extensão não faz essa parte.
    </div>
    <div class="rv-saipos-load-row">
      <button id="rv-saipos-load-categories" type="button" class="rv-btn-safe">🔄 Carregar categorias do Saipos</button>
      <span id="rv-saipos-load-status" class="rv-muted">
        ${rvSaiposCategorias ? `${rvSaiposCategorias.length} categoria(s) carregada(s).` : 'Abra o Saipos numa aba do Chrome e clique aqui antes de criar o primeiro item.'}
      </span>
    </div>
  `;

  const rows = faltantes.map((r) => saiposRowHtml(r)).join('');
  const table = `<table class="rv-table">
        <thead><tr>
          <th>Categoria (iFood)</th><th>Item (iFood)</th><th>Complementos no iFood</th><th>Nome do produto (Saipos)</th><th>Categoria (Saipos)</th><th>Ação</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

  return warning + table;
}

function saiposCategoriaOptionsHtml(selectedId) {
  if (!rvSaiposCategorias) {
    return `<option value="">— carregue as categorias acima —</option>`;
  }
  const opts = rvSaiposCategorias
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map((c) => `<option value="${escapeHtml(c.id)}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`)
    .join('');
  return `<option value="">— selecione —</option>${opts}`;
}

// Selo mostrando se o item tem grupo(s) de complemento no iFood — importante
// saber ANTES de clicar em "Criar no Saipos", porque o produto novo nasce
// "seco" (sem nenhum complemento vinculado); se o item tinha complemento, é
// preciso montar isso à parte no Saipos depois de criar o produto básico.
function saiposComplementosBadgeHtml(row) {
  const qtd = row.qtdComplementos || 0;
  if (!qtd) {
    return '<span class="rv-comp-badge rv-comp-none">— sem complementos</span>';
  }
  const grupos = row.gruposComplementos && row.gruposComplementos.length ? row.gruposComplementos : [];
  const gruposTxt = grupos.length ? escapeHtml(grupos.join(', ')) : '';
  return `<span class="rv-comp-badge rv-comp-has">🧩 ${qtd} opç${qtd === 1 ? 'ão' : 'ões'}${grupos.length ? ` em ${grupos.length} grupo${grupos.length === 1 ? '' : 's'}` : ''}</span>${gruposTxt ? `<div class="rv-parent-code">${gruposTxt}</div>` : ''}`;
}

function saiposRowHtml(row) {
  return `<tr data-saipos-rowid="${row.rowId}" class="${rvRowInativoClass(row).trim()}">
    <td class="rv-categoria">${row.categoriaIfood ? escapeHtml(row.categoriaIfood) : '<span class="rv-parent-code">—</span>'}</td>
    <td class="rv-item-name" title="${escapeHtml(row.itemName)}">${escapeHtml(row.itemName)}${rvInativoTag(row)}${row.codigoAtual ? `<div class="rv-parent-code">código pai atual: ${escapeHtml(row.codigoAtual)}</div>` : ''}</td>
    <td>${saiposComplementosBadgeHtml(row)}</td>
    <td><input type="text" class="rv-saipos-nome" data-rowid="${row.rowId}" value="${escapeHtml(String(row.itemName || '').toUpperCase())}" /></td>
    <td><select class="rv-saipos-categoria-select" data-rowid="${row.rowId}">${saiposCategoriaOptionsHtml('')}</select></td>
    <td>
      <button type="button" class="rv-saipos-btn-criar" data-rowid="${row.rowId}" disabled>Criar no Saipos</button>
      <div class="rv-status" data-saipos-status-for="${row.rowId}"></div>
    </td>
  </tr>`;
}

function onSaiposCategoriaChange(ev) {
  if (!ev.target.classList.contains('rv-saipos-categoria-select')) return;
  const tr = ev.target.closest('tr');
  const btn = tr ? tr.querySelector('.rv-saipos-btn-criar') : null;
  if (btn) btn.disabled = !ev.target.value;
}

async function loadSaiposCategories() {
  const btn = document.getElementById('rv-saipos-load-categories');
  const status = document.getElementById('rv-saipos-load-status');
  if (rvSaiposLoading) return;
  rvSaiposLoading = true;
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Buscando categorias na aba do Saipos (pode levar alguns segundos — a aba vai navegar sozinha pra listagem de categorias)...';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'IFPS_SAIPOS_GET_CATEGORIES' });
    if (!res || !res.ok) {
      if (status) status.textContent = 'Não consegui buscar as categorias: ' + (res && res.error ? res.error : 'motivo desconhecido') + '.';
      return;
    }
    rvSaiposCategorias = res.categorias || [];
    if (status) status.textContent = `${rvSaiposCategorias.length} categoria(s) carregada(s).`;
    // Repopula os selects já na tela, mantendo a linha que o usuário estava
    // olhando (não precisa re-renderizar a tabela inteira).
    document.querySelectorAll('.rv-saipos-categoria-select').forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = saiposCategoriaOptionsHtml(current);
    });
  } catch (err) {
    console.error('[iFood PDV Sync/review]', err);
    if (status) status.textContent = 'Não consegui falar com a extensão para buscar as categorias: ' + err.message;
  } finally {
    rvSaiposLoading = false;
    if (btn) btn.disabled = false;
  }
}

async function createSaiposProduct(rowId) {
  const tr = document.querySelector(`tr[data-saipos-rowid="${rowId}"]`);
  if (!tr) return;
  const nomeInput = tr.querySelector('.rv-saipos-nome');
  const catSelect = tr.querySelector('.rv-saipos-categoria-select');
  const btn = tr.querySelector('.rv-saipos-btn-criar');
  const statusEl = tr.querySelector(`[data-saipos-status-for="${rowId}"]`);

  const nome = (nomeInput.value || '').trim();
  const idCategoria = catSelect.value;
  const nomeCategoria = catSelect.selectedOptions[0] ? catSelect.selectedOptions[0].textContent : '';

  if (!nome || !idCategoria) return;

  const confirmado = window.confirm(
    `Isso vai CRIAR um produto de verdade no cardápio do Saipos:\n\nNome: ${nome}\nCategoria: ${nomeCategoria}\nPreço: 0,00\nDisponibilidade: só Delivery\n\nConfirma?`
  );
  if (!confirmado) return;

  btn.disabled = true;
  nomeInput.disabled = true;
  catSelect.disabled = true;
  if (statusEl) {
    statusEl.textContent = 'criando...';
    statusEl.className = 'rv-status';
  }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'IFPS_SAIPOS_CREATE_PRODUCT', payload: { nome, idCategoria } });
    if (res && res.ok) {
      if (statusEl) {
        statusEl.textContent = '✔ criado' + (res.categoriaConfirmada ? ` em "${res.categoriaConfirmada}"` : '');
        statusEl.className = 'rv-status rv-ok';
      }
      // Feito — não faz sentido deixar habilitado pra criar de novo (evita
      // duplicata por clique duplo sem querer).
    } else {
      if (statusEl) {
        statusEl.textContent = '✘ ' + (res && (res.reason || res.error) ? res.reason || res.error : 'falhou');
        statusEl.className = 'rv-status rv-fail';
      }
      btn.disabled = false;
      nomeInput.disabled = false;
      catSelect.disabled = false;
    }
  } catch (err) {
    console.error('[iFood PDV Sync/review]', err);
    if (statusEl) {
      statusEl.textContent = '✘ não consegui falar com a extensão: ' + err.message;
      statusEl.className = 'rv-status rv-fail';
    }
    btn.disabled = false;
    nomeInput.disabled = false;
    catSelect.disabled = false;
  }
}

function onSaiposMainClick(ev) {
  if (ev.target.id === 'rv-saipos-load-categories') {
    loadSaiposCategories();
    return;
  }
  const criarBtn = ev.target.closest('.rv-saipos-btn-criar');
  if (criarBtn && !criarBtn.disabled) {
    createSaiposProduct(Number(criarBtn.dataset.rowid));
    return;
  }
  // Checa "desfazer" antes do botão genérico, já que o de desfazer também
  // tem a classe rv-produto-btn-saipos (pra herdar o mesmo visual base).
  const undoBtn = ev.target.closest('.rv-produto-btn-saipos-undo');
  if (undoBtn) {
    rvManualSaiposRowIds.delete(Number(undoBtn.dataset.rowid));
    render();
    return;
  }
  const enviarBtn = ev.target.closest('.rv-produto-btn-saipos');
  if (enviarBtn) {
    enviarProdutoParaSaipos(Number(enviarBtn.dataset.rowid));
  }
}

// Marca o item (da aba "Produtos pai") pra também aparecer na aba "Criar no
// Saipos", re-renderiza e já leva o usuário pra lá, com a linha em destaque
// por alguns instantes — assim ele não precisa procurar o item de novo na
// tabela nova.
function enviarProdutoParaSaipos(rowId) {
  rvManualSaiposRowIds.add(rowId);
  render();
  setActiveTab('saipos');
  requestAnimationFrame(() => {
    const tr = document.querySelector(`tr[data-saipos-rowid="${rowId}"]`);
    if (!tr) return;
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tr.classList.add('rv-row-flash');
    setTimeout(() => tr.classList.remove('rv-row-flash'), 2200);
  });
}

// O botão "Aplicar selecionados" (cabeçalho) só faz sentido nas abas de
// complemento/produto pai — na aba do Saipos cada linha tem seu próprio
// botão "Criar no Saipos", então escondemos o botão global pra não sugerir
// que ele também aplica aqui.
function updateApplyWrapVisibility() {
  const wrap = document.getElementById('rv-apply-wrap');
  if (wrap) wrap.style.display = rvActiveTab === 'saipos' ? 'none' : '';
}

function updateTabCounts(b, p, saiposCount) {
  const complementoPendentes = b.alta.length + b.media.length + b.baixa.length;
  const produtoPendentes = p.alta.length + p.media.length + p.baixa.length;
  const btnComplemento = document.querySelector('.rv-tab-btn[data-tab="complemento"]');
  const btnProduto = document.querySelector('.rv-tab-btn[data-tab="produto"]');
  const btnSaipos = document.querySelector('.rv-tab-btn[data-tab="saipos"]');
  if (btnComplemento) btnComplemento.innerHTML = `Complementos <span class="rv-tab-count">${complementoPendentes}</span>`;
  if (btnProduto) btnProduto.innerHTML = `Produtos pai 🍕 <span class="rv-tab-count">${produtoPendentes}</span>`;
  if (btnSaipos) btnSaipos.innerHTML = `Criar no Saipos 🆕 <span class="rv-tab-count">${saiposCount || 0}</span>`;
}

function setActiveTab(tab) {
  rvActiveTab = tab;
  document.querySelectorAll('.rv-tab-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.rv-tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.tab !== tab;
  });
  updateApplyWrapVisibility();
  updateApplyButtonCount();
}

function onAltSelectChange(ev) {
  if (!ev.target.classList.contains('rv-alt-select')) return;
  const rowId = Number(ev.target.dataset.rowid);
  const row = rvRowsById.get(rowId);
  const tr = ev.target.closest('tr');
  const checkbox = tr.querySelector('.rv-check');

  if (ev.target.dataset.mode === 'produto') {
    // Nas linhas de "produtos pai" todas as alternativas apontam pro MESMO
    // campo (o código pai do item) — só o código sugerido muda, o inputId
    // continua sendo sempre o campo próprio do item.
    if (ev.target.value) {
      row.novoCodigo = ev.target.value;
      const mudou = row.novoCodigo !== row.codigoAtual;
      checkbox.disabled = !mudou;
      checkbox.checked = mudou;
    } else {
      checkbox.checked = false;
    }
    return;
  }

  if (ev.target.value) {
    row.inputId = ev.target.value;
    row.optionid = ev.target.selectedOptions[0] ? ev.target.selectedOptions[0].dataset.optionid || null : null;
    checkbox.disabled = false;
    checkbox.checked = true;
  } else {
    checkbox.checked = false;
  }
}

// Só os checkboxes marcados dentro da aba ATUALMENTE visível (Complementos
// ou Produtos pai) — os da outra aba ficam de fora da contagem e do botão
// "Aplicar", mesmo que continuem marcados por baixo (você não perde a
// seleção ao trocar de aba, só não aplica os da aba que não está vendo).
function rvCheckedInActiveTab() {
  const panel = document.querySelector(`.rv-tab-panel[data-tab="${rvActiveTab}"]`);
  return panel ? [...panel.querySelectorAll('.rv-check:checked')] : [];
}

function updateApplyButtonCount() {
  const checked = rvCheckedInActiveTab().length;
  const btn = document.getElementById('rv-btn-apply');
  btn.textContent = checked ? `⚠️ Aplicar selecionados (${checked})` : '⚠️ Aplicar selecionados';
  btn.disabled = checked === 0;
}

document.getElementById('rv-btn-apply').addEventListener('click', () => {
  if (!rvSourceTabId) {
    alert('Não sei mais em qual aba do iFood aplicar (feche essa aba e rode o processo de novo pelo popup da extensão).');
    return;
  }
  const checked = rvCheckedInActiveTab();
  const rows = checked
    .map((cb) => rvRowsById.get(Number(cb.dataset.rowid)))
    .filter((r) => r && r.inputId && r.novoCodigo)
    .map((r) => ({ rowId: r.rowId, inputId: r.inputId, itemid: r.itemid, optionid: r.optionid, novoCodigo: r.novoCodigo }));

  if (!rows.length) return;

  // Confirmação explícita: essa ação escreve direto no cardápio do iFood,
  // então um clique sem querer no botão não pode disparar nada sozinho.
  const confirmado = window.confirm(
    `Isso vai escrever ${rows.length} código${rows.length === 1 ? '' : 's'} direto no cardápio do iFood (aba do PDV).\n\nConfirma que quer aplicar agora?`
  );
  if (!confirmado) return;

  const btn = document.getElementById('rv-btn-apply');
  btn.disabled = true;
  btn.textContent = `Aplicando 0/${rows.length}...`;
  window._rvApplyTotal = rows.length;
  window._rvApplyDone = 0;

  checked.forEach((cb) => {
    const row = rvRowsById.get(Number(cb.dataset.rowid));
    const statusEl = document.querySelector(`[data-status-for="${row.rowId}"]`);
    if (statusEl) {
      statusEl.textContent = 'na fila...';
      statusEl.className = 'rv-status';
    }
  });

  // Antes esse envio era "atire e esqueça" — se a mensagem não chegasse na
  // aba do iFood (aba fechada, recarregada, ou indo pra outra página), o
  // botão ficava travado em "Aplicando 0/N..." pra sempre, sem avisar nada
  // (foi o que aconteceu quando nada foi corrigido depois de confirmar).
  // Agora a resposta é checada e qualquer falha de comunicação aparece num
  // alerta, em vez de sumir em silêncio.
  chrome.runtime
    .sendMessage({ type: 'IFPS_APPLY_ROWS', targetTabId: rvSourceTabId, rows })
    .then((res) => {
      if (!res || !res.ok) {
        alert(
          'Não consegui aplicar os códigos: ' +
            (res && res.error ? res.error : 'a aba do iFood pode ter sido fechada, recarregada ou está em outra página.') +
            '\n\nAbra a aba do Portal iFood na tela Cardápio > PDV e clique em "Aplicar selecionados" de novo.'
        );
        btn.disabled = false;
        updateApplyButtonCount();
      }
      // se res.ok, o progresso real chega pelas mensagens IFPS_APPLY_RESULT /
      // IFPS_APPLY_DONE (tratadas em handleApplyResult / finishApply).
    })
    .catch((err) => {
      console.error('[iFood PDV Sync/review]', err);
      alert(
        'Não consegui falar com a extensão para aplicar os códigos: ' +
          err.message +
          '\n\nRecarregue a aba do Portal iFood (F5) e tente de novo.'
      );
      btn.disabled = false;
      updateApplyButtonCount();
    });
});

function handleApplyResult(rowId, ok, reason) {
  const statusEl = document.querySelector(`[data-status-for="${rowId}"]`);
  if (statusEl) {
    statusEl.textContent = ok ? '✔ aplicado' : '✘ ' + (reason || 'falhou');
    statusEl.className = ok ? 'rv-status rv-ok' : 'rv-status rv-fail';
  }
  window._rvApplyDone = (window._rvApplyDone || 0) + 1;
  const btn = document.getElementById('rv-btn-apply');
  if (window._rvApplyTotal) {
    btn.textContent = `Aplicando ${window._rvApplyDone}/${window._rvApplyTotal}...`;
  }
  if (!window._rvResults) window._rvResults = { ok: 0, fail: 0 };
  if (ok) window._rvResults.ok++;
  else window._rvResults.fail++;
}

function finishApply() {
  const btn = document.getElementById('rv-btn-apply');
  btn.disabled = false;

  const results = window._rvResults || { ok: 0, fail: 0 };
  window._rvResults = null;
  window._rvApplyTotal = null;
  window._rvApplyDone = null;
  updateApplyButtonCount();

  const b = bucketize(rvActiveTab === 'produto' ? rvData.produtosPai || [] : rvData.rows);
  const totalCorreto = b.correto_ok.length + b.correto_suspeito.length;
  const activePanel = document.querySelector(`.rv-tab-panel[data-tab="${rvActiveTab}"]`);
  const pendentes = activePanel ? activePanel.querySelectorAll('.rv-check:not(:checked):not(:disabled)').length : 0;

  const footer = document.getElementById('rv-final-summary');
  footer.style.display = 'block';
  footer.innerHTML = `
    <strong>Resumo</strong><br />
    ✔ ${results.ok} código${results.ok === 1 ? '' : 's'} alterado${results.ok === 1 ? '' : 's'} agora
    ${results.fail ? `<br />✘ ${results.fail} falharam ao aplicar (veja o motivo na linha)` : ''}
    <br />= ${totalCorreto} já estavam certos (nenhuma mudança necessária)
    <br />? ${pendentes} ainda para você analisar (não selecionados)
  `;
  footer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('rv-btn-export').addEventListener('click', () => {
  if (!rvData) return;
  const lines = [
    ['Tipo', 'Categoria iFood', 'Item', 'Código Pai', 'Complemento Saipos', 'Código Saipos', 'Opção iFood', 'Grupo iFood', 'Valor Atual', 'Novo Código', 'Confiança', 'Score'].join(';'),
  ];
  for (const r of rvData.rows) {
    lines.push(
      ['complemento', r.categoriaIfood || '', r.itemName, r.parentCode, r.saiposNome, r.saiposCodigo, r.opcaoIfood || '', r.grupoIfood, r.valorAtual, r.novoCodigo, r.confidence, r.score.toFixed(3)]
        .map((v) => '"' + String(v).replace(/"/g, '""') + '"')
        .join(';')
    );
  }
  for (const r of rvData.produtosPai || []) {
    lines.push(
      ['produto pai', r.categoriaIfood || '', r.itemName, r.codigoAtual, r.pratoNome || '', r.novoCodigo || '', '', '', r.codigoAtual, r.novoCodigo, r.confidence, r.score.toFixed(3)]
        .map((v) => '"' + String(v).replace(/"/g, '""') + '"')
        .join(';')
    );
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ifood-pdv-sync-relatorio.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
