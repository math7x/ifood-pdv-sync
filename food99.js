// food99.js — integração com o Cardápio online do 99Food.
// A leitura percorre as categorias e captura os produtos visíveis. A escrita
// só acontece depois da revisão e usa a edição rápida de Código PDV em Itens.

const IFPS99_MENU_PATH = '/pt-BR/manager/micro-merchandish/merchant-item/menu';
const IFPS99_MAX_ALTERNATIVAS = 60;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IFPS_START') {
    ifps99Run().catch((err) => {
      console.error('[PDV Sync/99Food]', err);
      ifps99ShowToast('Erro ao ler o 99Food: ' + err.message, 'err');
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_APPLY_ROWS_ON_PAGE') {
    ifps99ApplyRows(msg.rows || []).catch((err) => {
      console.error('[PDV Sync/99Food]', err);
      ifps99ShowToast('Erro ao aplicar no 99Food: ' + err.message, 'err');
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_BACKGROUND_ERROR') {
    ifps99ShowToast(msg.message, 'err');
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function ifps99Sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ifps99WaitFor(check, { timeout = 12000, interval = 150 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = check();
    if (value) return value;
    await ifps99Sleep(interval);
  }
  return null;
}

function ifps99Text(el) {
  return String(el && (el.innerText || el.textContent) || '').trim();
}

function ifps99Visible(el) {
  return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
}

function ifps99FindByText(selector, text, root = document) {
  return [...root.querySelectorAll(selector)].find((el) => ifps99Visible(el) && ifps99Text(el) === text) || null;
}

async function ifps99Run() {
  if (!location.pathname.startsWith(IFPS99_MENU_PATH)) {
    throw new Error('abra a tela "Cardápio online" do 99Food antes de iniciar');
  }

  ifps99ShowToast('Lendo categorias e produtos do 99Food...', '');
  const items = await ifps99ScanMenu();
  const { ifpsSaiposRows } = await chrome.storage.local.get('ifpsSaiposRows');
  if (!ifpsSaiposRows || !ifpsSaiposRows.length) {
    throw new Error('nenhuma planilha Saipos foi carregada');
  }

  const matches = ifps99MatchProducts(items, ifpsSaiposRows);
  matches.platform = '99food';
  matches.itemsScanned = items.length;

  ifps99ShowToast(`Abrindo revisão (${items.length} produtos lidos no 99Food)...`, '');
  const response = await chrome.runtime.sendMessage({ type: 'IFPS_OPEN_REVIEW', matches });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : 'não consegui abrir a revisão');
  ifps99ShowToast('Pronto! Confira as sugestões na aba de revisão.', '');
}

async function ifps99ScanMenu() {
  const categoryNames = await ifps99WaitFor(() => {
    const names = [...document.querySelectorAll('.category-item .category-name')]
      .filter(ifps99Visible)
      .map(ifps99Text)
      .filter(Boolean);
    return names.length ? names : null;
  });
  if (!categoryNames) throw new Error('não encontrei a lista de categorias; confirme que está no Cardápio online');

  const captured = [];
  for (let categoryIndex = 0; categoryIndex < categoryNames.length; categoryIndex++) {
    const categoryName = categoryNames[categoryIndex];
    ifps99ShowToast(`Lendo categoria ${categoryIndex + 1}/${categoryNames.length}: ${categoryName}`, '');

    const category = ifps99FindByText('.category-item .category-name', categoryName);
    if (!category) continue;
    const categoryItem = category.closest('.category-item');
    if (!categoryItem.classList.contains('active')) {
      categoryItem.click();
      await ifps99WaitFor(() => {
        const active = document.querySelector('.category-item.active .category-name');
        return active && ifps99Text(active) === categoryName;
      });
    }

    const expectedCount = Number(ifps99Text(categoryItem.querySelector('.category-count'))) || 0;
    const loaded = await ifps99WaitFor(() => document.querySelectorAll('.item-container .item-name').length === expectedCount, { timeout: 10000 });
    if (!loaded) {
      throw new Error(`a categoria "${categoryName}" não carregou os ${expectedCount} produto(s) esperados`);
    }
    await ifps99Sleep(300);

    const nameOccurrences = new Map();
    const productEls = [...document.querySelectorAll('.item-container')].filter(ifps99Visible);
    for (const productEl of productEls) {
      const name = ifps99Text(productEl.querySelector('.item-name'));
      if (!name) continue;
      const normalizedName = ifpsNormalize(name);
      const ordinal = nameOccurrences.get(normalizedName) || 0;
      nameOccurrences.set(normalizedName, ordinal + 1);
      const status = ifps99Text(productEl.querySelector('.status-label'));
      captured.push({
        itemName: name,
        categoryName,
        itemOrdinal: ordinal,
        inativo: !!status && status.toUpperCase() !== 'DISPONÍVEL',
        codigoAtual: '',
        codigoAtualLido: false,
      });
    }
  }
  ifps99ShowToast('Lendo os Códigos PDV que já estão preenchidos...', '');
  await ifps99AttachCurrentCodes(captured);
  return captured;
}

function ifps99IsActiveSheetRow(row) {
  return String(row['Inativo'] == null ? '' : row['Inativo']).trim().toUpperCase() !== 'INATIVO';
}

// No 99Food, produtos e pratos são comparados diretamente. Se os dois nomes
// informam volume, ele precisa ser exatamente o mesmo: 350 ml nunca pode
// receber o código de 2 litros, nem 500 ml o código de 1 litro.
function ifps99ScoreProduto(itemName, pratoDescricao) {
  const itemVolume = ifpsExtractVolumeMl(itemName);
  const pratoVolume = ifpsExtractVolumeMl(pratoDescricao);
  if (itemVolume != null && pratoVolume != null && itemVolume !== pratoVolume) return 0;
  const baseScore = ifpsScoreProduto(itemName, pratoDescricao);
  return baseScore + (itemVolume != null && pratoVolume != null ? 0.3 : 0);
}

function ifps99ProductKey(itemName, categoryName) {
  return `${ifpsNormalize(categoryName || '')}\u0001${ifpsNormalize(itemName || '')}`;
}

function ifps99ItemsPageSignature() {
  const rows = [...document.querySelectorAll('.item-row-wrapper')].filter(ifps99Visible);
  if (!rows.length) return '';
  const first = ifps99Text(rows[0].querySelector('.item-name'));
  const last = ifps99Text(rows[rows.length - 1].querySelector('.item-name'));
  return `${rows.length}\u0001${first}\u0001${last}`;
}

function ifps99CaptureVisibleCodeRows() {
  return [...document.querySelectorAll('.item-row-wrapper')]
    .filter(ifps99Visible)
    .map((row) => ({
      itemName: ifps99Text(row.querySelector('.item-name')),
      categoryName: ifps99Text(row.querySelector('.col-category')),
      codigoAtual: ifps99ReadInlineCode(row),
    }))
    .filter((row) => row.itemName);
}

async function ifps99AttachCurrentCodes(items) {
  if (!(await ifps99EnsureItemsList())) {
    throw new Error('não consegui abrir a aba Itens para conferir os Códigos PDV atuais');
  }

  const search = ifps99VisibleSearchInput();
  if (search && search.value) {
    const beforeClear = ifps99ItemsPageSignature();
    ifps99SetSearchValue(search, '');
    await ifps99WaitFor(() => {
      const signature = ifps99ItemsPageSignature();
      return signature && signature !== beforeClear;
    }, { timeout: 8000, interval: 80 });
  }

  const firstPage = [...document.querySelectorAll('li.number')]
    .find((el) => ifps99Visible(el) && ifps99Text(el) === '1');
  const activePage = document.querySelector('li.number.active');
  if (firstPage && (!activePage || ifps99Text(activePage) !== '1')) {
    const previousSignature = ifps99ItemsPageSignature();
    firstPage.click();
    const loadedFirst = await ifps99WaitFor(() => {
      const active = document.querySelector('li.number.active');
      const signature = ifps99ItemsPageSignature();
      return active && ifps99Text(active) === '1' && signature && signature !== previousSignature;
    }, { timeout: 8000, interval: 80 });
    if (!loadedFirst) throw new Error('a primeira página de Itens não terminou de carregar');
  }

  const codeRows = [];
  for (let pageGuard = 0; pageGuard < 20; pageGuard++) {
    const ready = await ifps99WaitFor(() => ifps99ItemsPageSignature(), { timeout: 8000, interval: 80 });
    if (!ready) throw new Error('uma página da lista de Itens não terminou de carregar');
    codeRows.push(...ifps99CaptureVisibleCodeRows());

    const next = [...document.querySelectorAll('.btn-next')].find(ifps99Visible);
    if (!next || next.disabled || next.hasAttribute('disabled') || next.classList.contains('disabled')) break;
    const previousSignature = ifps99ItemsPageSignature();
    next.click();
    const changed = await ifps99WaitFor(() => {
      const signature = ifps99ItemsPageSignature();
      return signature && signature !== previousSignature;
    }, { timeout: 8000, interval: 80 });
    if (!changed) throw new Error('a próxima página de Itens não terminou de carregar');
  }

  if (!codeRows.length) throw new Error('não encontrei produtos na aba Itens para conferir os Códigos PDV');
  const codesByKey = new Map();
  for (const row of codeRows) {
    const key = ifps99ProductKey(row.itemName, row.categoryName);
    if (!codesByKey.has(key)) codesByKey.set(key, []);
    codesByKey.get(key).push(row.codigoAtual);
  }

  const menuItemsByKey = new Map();
  for (const item of items) {
    const key = ifps99ProductKey(item.itemName, item.categoryName);
    if (!menuItemsByKey.has(key)) menuItemsByKey.set(key, []);
    menuItemsByKey.get(key).push(item);
  }

  for (const [key, menuItems] of menuItemsByKey) {
    const codes = codesByKey.get(key) || [];
    if (codes.length === 1 && menuItems.length === 1) {
      menuItems[0].codigoAtual = codes[0];
      menuItems[0].codigoAtualLido = true;
      continue;
    }
    const uniqueCodes = [...new Set(codes)];
    if (codes.length === menuItems.length && uniqueCodes.length === 1) {
      menuItems.forEach((item) => {
        item.codigoAtual = uniqueCodes[0];
        item.codigoAtualLido = true;
      });
    }
  }
}

function ifps99MatchProducts(items, saiposRowsRaw) {
  const saiposRows = saiposRowsRaw.filter(ifps99IsActiveSheetRow);
  const pratoRows = saiposRows.filter((row) => String(row['Tipo']).trim().toUpperCase() === 'PRATO');
  let rowId = 0;
  let jaCorretos = 0;
  let pdvPreenchidosIncorretos = 0;

  const produtosPai = items.map((item) => {
    const scored = pratoRows
      .map((row) => ({ row, score: ifps99ScoreProduto(item.itemName, row['Descrição']) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    const chosen = best && best.score >= IFPS_CONFIDENCE.MEDIUM ? best.row : null;
    const novoCodigo = chosen ? String(chosen['Código Saipos'] || '').trim() : '';
    const codigoAtual = String(item.codigoAtual || '').trim();
    const pratoAtual = codigoAtual
      ? pratoRows.find((row) => String(row['Código Saipos'] || '').trim().toLowerCase() === codigoAtual.toLowerCase()) || null
      : null;
    const scoreAtual = pratoAtual ? ifps99ScoreProduto(item.itemName, pratoAtual['Descrição']) : 0;
    const atualCoerente = item.codigoAtualLido && codigoAtual && pratoAtual && scoreAtual >= IFPS_CONFIDENCE.MEDIUM;
    if (atualCoerente) {
      jaCorretos++;
      return null;
    }
    if (item.codigoAtualLido && codigoAtual) pdvPreenchidosIncorretos++;
    const alternatives = scored
      .filter((entry) => !chosen || entry.row !== chosen)
      .slice(0, IFPS99_MAX_ALTERNATIVAS)
      .map((entry) => ({
        codigo: String(entry.row['Código Saipos'] || '').trim(),
        descricao: entry.row['Descrição'] || '',
      }))
      .filter((entry) => entry.codigo)
      .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR'));

    return {
      rowId: rowId++,
      itemName: item.itemName,
      categoriaIfood: item.categoryName,
      categoria99: item.categoryName,
      itemOrdinal: item.itemOrdinal,
      itemInativo: item.inativo,
      codigoAtual,
      codigoAtualLido: item.codigoAtualLido,
      pratoAtualNome: pratoAtual ? pratoAtual['Descrição'] || '' : '',
      scoreAtual: ifpsDisplayScore(scoreAtual),
      pratoNome: chosen ? chosen['Descrição'] || '' : '',
      novoCodigo,
      inputId: novoCodigo ? '99food-pdv' : '',
      itemid: '',
      optionid: '',
      score: best ? ifpsDisplayScore(best.score) : 0,
      confidence: best ? ifpsClassify(best.score) : 'baixa',
      nomeSuspeito: false,
      semCorrespondencia: !chosen,
      alternativas: alternatives,
      qtdComplementos: 0,
      gruposComplementos: [],
    };
  }).filter(Boolean);

  return {
    rows: [],
    produtosPai,
    pratosSaipos: pratoRows
      .map((row) => ({
        codigo: String(row['Código Saipos'] || '').trim(),
        descricao: String(row['Descrição'] || '').trim(),
      }))
      .filter((row, index, all) => row.codigo && all.findIndex((other) => other.codigo.toLowerCase() === row.codigo.toLowerCase()) === index)
      .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR')),
    semPlanilha: [],
    semCodigoPai: [],
    semOpcaoNoIfood: 0,
    skippedInativo: saiposRowsRaw.length - saiposRows.length,
    jaCorretos,
    pdvPreenchidosIncorretos,
  };
}

function ifps99VisibleSearchInput() {
  return [...document.querySelectorAll('input.filter-input[placeholder="Pesquisar"]')].find(ifps99Visible) || null;
}

function ifps99SetSearchValue(search, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  search.focus();
  setter.call(search, value);
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.dispatchEvent(new Event('change', { bubbles: true }));
  const enter = { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
  search.dispatchEvent(new KeyboardEvent('keydown', enter));
  search.dispatchEvent(new KeyboardEvent('keypress', enter));
  search.dispatchEvent(new KeyboardEvent('keyup', enter));
  search.blur();
}

async function ifps99EnsureItemsList() {
  if (!location.pathname.startsWith(IFPS99_MENU_PATH)) {
    const backText = ifps99FindByText('a, button, span, div', 'Voltar');
    const clickable = backText && (backText.closest('a,button') || backText);
    if (!clickable) return false;
    clickable.click();
    const returned = await ifps99WaitFor(() => location.pathname.startsWith(IFPS99_MENU_PATH));
    if (!returned) return false;
  }

  const itemsTab = document.getElementById('tab-items');
  if (!itemsTab) return false;
  if (!itemsTab.classList.contains('is-active')) itemsTab.click();

  return !!(await ifps99WaitFor(() => {
    const activeTab = document.getElementById('tab-items');
    return activeTab && activeTab.classList.contains('is-active') && ifps99VisibleSearchInput();
  }, { timeout: 10000, interval: 80 }));
}

function ifps99FindItemRows(row) {
  const wantedName = ifpsNormalize(row.itemName);
  const wantedCategory = ifpsNormalize(row.categoria99 || row.categoriaIfood || '');
  const sameName = [...document.querySelectorAll('.item-row-wrapper')].filter((el) => {
    return ifps99Visible(el) && ifpsNormalize(ifps99Text(el.querySelector('.item-name'))) === wantedName;
  });
  if (!wantedCategory) return sameName;
  const sameCategory = sameName.filter((el) => {
    return ifpsNormalize(ifps99Text(el.querySelector('.col-category'))) === wantedCategory;
  });
  return sameCategory.length ? sameCategory : (sameName.length === 1 ? sameName : []);
}

async function ifps99SearchItem(row) {
  const search = ifps99VisibleSearchInput();
  if (!search) return null;
  const query = String(row.itemName || '').trim();
  if (search.value !== query) ifps99SetSearchValue(search, query);

  return ifps99WaitFor(() => {
    const visibleNames = [...document.querySelectorAll('.item-row-wrapper .item-name')]
      .filter(ifps99Visible)
      .map((el) => ifpsNormalize(ifps99Text(el)));
    const wantedName = ifpsNormalize(query);
    if (!visibleNames.length || visibleNames.some((name) => !name.includes(wantedName))) return null;
    const candidates = ifps99FindItemRows(row);
    return candidates[Number(row.itemOrdinal) || 0] || candidates[0] || null;
  }, { timeout: 8000, interval: 80 });
}

function ifps99ReadInlineCode(itemRow) {
  const value = ifps99Text(itemRow && itemRow.querySelector('.col-code-text'));
  return value === '-' ? '' : value;
}

function ifps99VisibleSaveError() {
  const selectors = '.pb-message--error, .pb-notification--error, .pb-form-item__error';
  return [...document.querySelectorAll(selectors)].filter(ifps99Visible).map(ifps99Text).find(Boolean) || '';
}

function ifps99SetNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || '0' }));
  input.blur();
}

async function ifps99ApplyRow(row) {
  if (!row.novoCodigo) return { ok: false, reason: 'sem código associado' };
  if (!(await ifps99EnsureItemsList())) return { ok: false, reason: 'não consegui abrir a aba Itens do 99Food' };

  const itemRow = await ifps99SearchItem(row);
  if (!itemRow) return { ok: false, reason: `produto "${row.itemName}" não encontrado na aba Itens` };
  const wantedCode = String(row.novoCodigo).trim();
  if (ifps99ReadInlineCode(itemRow).toLowerCase() === wantedCode.toLowerCase()) {
    return { ok: true, reason: 'já estava correto' };
  }

  itemRow.scrollIntoView({ block: 'center' });
  const codeCell = itemRow.querySelector('.col-code');
  if (!codeCell) return { ok: false, reason: 'a coluna Código PDV não apareceu para esse produto' };
  codeCell.click();
  const codeInput = await ifps99WaitFor(() => {
    const currentRow = ifps99FindItemRows(row)[Number(row.itemOrdinal) || 0] || ifps99FindItemRows(row)[0];
    return currentRow && currentRow.querySelector('input.pdv-code-input');
  }, { timeout: 2500, interval: 50 });
  if (!codeInput) return { ok: false, reason: 'o campo de edição rápida do Código PDV não abriu' };

  ifps99SetNativeValue(codeInput, wantedCode);
  const saved = await ifps99WaitFor(() => {
    const currentRow = ifps99FindItemRows(row)[Number(row.itemOrdinal) || 0] || ifps99FindItemRows(row)[0];
    if (currentRow && ifps99ReadInlineCode(currentRow).toLowerCase() === wantedCode.toLowerCase()) return true;
    return null;
  }, { timeout: 8000, interval: 80 });
  if (!saved) return { ok: false, reason: ifps99VisibleSaveError() || 'o 99Food não confirmou o Código PDV salvo' };
  return { ok: true, reason: '' };
}

async function ifps99ApplyRows(rows) {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    let result;
    ifps99ShowToast(`Aplicando ${index + 1}/${rows.length}: ${row.itemName}`, '');
    try {
      result = await ifps99ApplyRow(row);
    } catch (err) {
      result = { ok: false, reason: String(err && err.message || err) };
    }
    chrome.runtime.sendMessage({ type: 'IFPS_APPLY_RESULT', rowId: row.rowId, ok: result.ok, reason: result.reason }).catch(() => {});
    await ifps99Sleep(80);
  }
  const search = ifps99VisibleSearchInput();
  if (search && search.value) ifps99SetSearchValue(search, '');
  chrome.runtime.sendMessage({ type: 'IFPS_APPLY_DONE' }).catch(() => {});
  ifps99ShowToast('Aplicação rápida no 99Food concluída.', '');
}

function ifps99ShowToast(message, kind) {
  let toast = document.getElementById('ifps-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ifps-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = kind === 'err' ? 'ifps-toast-err' : '';
  clearTimeout(window._ifps99ToastTimer);
  window._ifps99ToastTimer = setTimeout(() => toast.remove(), 9000);
}
