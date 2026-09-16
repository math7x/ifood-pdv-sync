// content.js — roda dentro da página do Portal iFood (Cardápio > PDV).
// Responsável por: expandir todos os complementos, ler os dados do DOM e
// casar com a planilha Saipos. O RESULTADO é mandado para uma aba própria
// da extensão (review.html) — a tela pesada não é mais desenhada aqui
// dentro, já que a própria página do PDV do iFood já é pesada sozinha.
// Esta página só volta a fazer algo quando a aba de revisão manda pedidos
// de "aplicar" um ou mais campos.
//
// IMPORTANTE: os seletores em IFPS_CONFIG dependem dos nomes de classe atuais
// do portal iFood (muitos são gerados automaticamente pelo build do site, tipo
// "sc-sSmyr"). Se a iFood atualizar o front-end do portal, esses nomes podem
// mudar e os seletores abaixo precisarão ser ajustados de novo.

const IFPS_CONFIG = {
  itemInputSelector: 'input[data-testid="item-pdv-input"]',
  optionInputSelector: 'input[data-testid="option-pdv-input"]',
  // O portal já mudou a classe gerada do título dos grupos algumas vezes.
  // Usar só "p.sc-sSmyr" fazia títulos visíveis como "Borda" sumirem da
  // leitura, deixando a opção "Tradicional" sem contexto. Priorizamos
  // títulos semânticos e parágrafos dentro do próprio card.
  groupHeadingSelector: 'p, h2, h3, h4, h5, h6, [class*="group"][class*="title"], [class*="group"][class*="heading"]',
  optionLabelSelector: 'span[class*="link-text__content"]',
  toggleSelector: 'label[class*="_selectable-chip-wrapper_"]',
  itemNameMaxLevels: 10,
  optionNameMaxLevels: 14,
  // Itens tipo pizza não têm input[data-testid="item-pdv-input"]. O nome do
  // item, nesse caso, é sempre o primeiro span[optionLabelSelector] dentro do
  // card (confirmado investigando o DOM real de um item "Pizzas Salgadas...":
  // é o próprio link com o nome do item, que vem antes de qualquer opção de
  // grupo tipo "Tamanho"/"Sabores" na ordem do DOM).
  pizzaCardSelector: '[data-testid^="item-card-"]',
  // Título da categoria do item na lista do PDV (ex: "*** Combos Especiais
  // ***"). Usa [class*=] em vez do nome de classe completo (que tem um sufixo
  // de hash gerado pelo build, tipo "-BJ_GIY") pra ficar um pouco mais
  // resistente a mudanças de build futuras.
  categoryHeadingSelector: '[class*="category_info__title"]',
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IFPS_START') {
    ifpsRun().catch((err) => {
      console.error('[iFood PDV Sync]', err);
      ifpsShowToast('Erro ao processar: ' + err.message, 'err');
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_APPLY_ROWS_ON_PAGE') {
    ifpsApplyRowsOnPage(msg.rows).catch((err) => {
      console.error('[iFood PDV Sync]', err);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_BACKGROUND_ERROR') {
    ifpsShowToast(msg.message, 'err');
    sendResponse({ ok: true });
    return true;
  }
});

async function ifpsRun() {
  ifpsShowToast('Expandindo todos os complementos do cardápio (pode levar alguns segundos)...', '');

  // A lista do iFood desmonta itens que saem da tela, então uma segunda
  // passada de leitura (mais devagar) evita perder item no meio do caminho.
  ifpsShowToast('Lendo tudo de novo com calma, pra não pular nenhum item...', '');
  const index = await ifpsScanAndCapture();

  const { ifpsSaiposRows } = await chrome.storage.local.get('ifpsSaiposRows');
  if (!ifpsSaiposRows || !ifpsSaiposRows.length) {
    ifpsShowToast('Nenhuma planilha carregada. Abra o popup da extensão e carregue o .xlsx primeiro.', 'err');
    return;
  }

  const matches = ifpsMatchAgainstSaipos(index, ifpsSaiposRows);
  matches.itemsScanned = index.size;

  ifpsShowToast(`Abrindo aba de revisão (${index.size} itens lidos no cardápio)...`, '');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'IFPS_OPEN_REVIEW', matches });
    if (!res || !res.ok) {
      ifpsShowToast('Não consegui abrir a aba de revisão' + (res && res.error ? ': ' + res.error : '') + '. Tente de novo pelo popup da extensão.', 'err');
      return;
    }
    ifpsShowToast('Pronto! A aba de revisão abriu (ou foi trazida pra frente) em outra guia do Chrome.', '');
  } catch (err) {
    console.error('[iFood PDV Sync]', err);
    ifpsShowToast(
      'Não consegui falar com a extensão para abrir a aba de revisão. Recarregue a extensão em chrome://extensions e depois atualize (F5) esta página antes de tentar de novo.',
      'err'
    );
  }
}

// ---------- Etapa 1: expandir tudo ----------

function ifpsSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A lista do PDV rola dentro de um CONTÊINER INTERNO com overflow próprio
// (visto ao vivo: <div data-testid="main-layout-scroll" class=
// "main-partners__scroll">) — a página/`window` em volta não rola, fica
// sempre do tamanho da viewport (document.body.scrollHeight ==
// window.innerHeight o tempo todo, mesmo com o cardápio inteiro carregado).
// `window.scrollBy`/`window.scrollY` não fazem NADA nesse caso, e a checagem
// de "chegou ao fim da lista" batia verdadeira já na primeira rodada — a
// extensão achava que tinha acabado de rolar e só capturava os itens que já
// estavam visíveis de cara, perdendo o resto do cardápio silenciosamente
// (bug real visto ao vivo: cardápio com "muitos e muitos itens pai" só teve
// 27 lidos). As funções abaixo tentam achar esse contêiner real primeiro, e
// só caem pra `window` como último recurso, pra continuar funcionando se o
// iFood mudar o layout nesse selector específico de novo.
let ifpsScrollContainerCache = null;

function ifpsFindScrollContainer() {
  if (
    ifpsScrollContainerCache &&
    document.contains(ifpsScrollContainerCache) &&
    ifpsScrollContainerCache.scrollHeight > ifpsScrollContainerCache.clientHeight
  ) {
    return ifpsScrollContainerCache;
  }

  // 1ª tentativa: o contêiner específico confirmado inspecionando o portal
  // ao vivo.
  let el = document.querySelector('[data-testid="main-layout-scroll"]');
  if (el && el.scrollHeight > el.clientHeight) {
    ifpsScrollContainerCache = el;
    return el;
  }

  // 2ª tentativa (fallback resistente a mudança de layout): qualquer
  // elemento com overflow rolável cujo conteúdo seja visivelmente maior que
  // a área visível dele — pega o de maior scrollHeight, que tende a ser o
  // contêiner principal da lista, não um dropdown/modal pequeno.
  const candidates = [...document.querySelectorAll('div, main, section')].filter((e) => {
    const cs = getComputedStyle(e);
    return /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 50;
  });
  if (candidates.length) {
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    ifpsScrollContainerCache = candidates[0];
    return candidates[0];
  }

  ifpsScrollContainerCache = null;
  return null;
}

// Pequena abstração pra rolar e checar "chegou ao fim" no contêiner CERTO
// (achado por ifpsFindScrollContainer), caindo pra `window` só se nenhum
// contêiner rolável for encontrado (layout sem contêiner próprio, ou selector
// desatualizado).
function ifpsScrollState() {
  const c = ifpsFindScrollContainer();
  if (c) {
    return {
      viewportSize: c.clientHeight,
      scrollBy: (amount) => c.scrollBy(0, amount),
      scrollToTop: () => c.scrollTo(0, 0),
      height: c.scrollHeight,
      atBottom: c.scrollTop + c.clientHeight >= c.scrollHeight - 4,
    };
  }
  return {
    viewportSize: window.innerHeight,
    scrollBy: (amount) => window.scrollBy(0, amount),
    scrollToTop: () => window.scrollTo(0, 0),
    height: document.body.scrollHeight,
    atBottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 4,
  };
}

// Expande os complementos E captura os itens na mesma travessia. Antes a
// extensão rolava o cardápio inteiro uma vez só para expandir e depois uma
// segunda vez só para ler; numa lista grande isso praticamente dobrava o
// tempo de cada rodada. `items` é o índice acumulado usado pelo scan.
async function ifpsExpandAll(items) {
  let stableRounds = 0;
  let lastHeight = -1;
  const maxRounds = 80;

  for (let round = 0; round < maxRounds; round++) {
    // Guarda o que já está montado nesta posição antes de qualquer clique —
    // inclui produtos sem complemento e opções que já estavam expandidas.
    if (items) ifpsCaptureSnapshot(items);

    const toggles = [...document.querySelectorAll(IFPS_CONFIG.toggleSelector)].filter(
      (el) => /^Complementos/i.test(el.innerText.trim()) && !/chips--checked/.test(el.className)
    );

    for (const t of toggles) {
      t.click();
    }

    if (toggles.length > 0) {
      await ifpsSleep(120);
      // Captura antes de sair desta posição: numa lista virtualizada, o card
      // pode ser desmontado assim que rolar e as opções recém-abertas
      // desapareceriam do DOM antes da leitura.
      if (items) ifpsCaptureSnapshot(items);
    }

    const scroll = ifpsScrollState();
    scroll.scrollBy(Math.round(scroll.viewportSize * 0.85));
    await ifpsSleep(220);
    if (items) ifpsCaptureSnapshot(items);

    const after = ifpsScrollState();
    const newHeight = after.height;
    const reachedBottom = after.atBottom;

    if (toggles.length === 0 && newHeight === lastHeight && reachedBottom) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = newHeight;
  }

  ifpsScrollState().scrollToTop();
  await ifpsSleep(150);
  if (items) ifpsCaptureSnapshot(items);
}

// ---------- Etapa 2: ler o DOM ----------

function ifpsNearestLabelEl(inputEl, selector, maxLevels) {
  let el = inputEl;
  for (let i = 0; i < maxLevels && el.parentElement; i++) el = el.parentElement;

  const candidates = [...el.querySelectorAll(selector)];
  if (!candidates.length) return null;

  const inputRect = inputEl.getBoundingClientRect();
  const inputMid = (inputRect.top + inputRect.bottom) / 2;

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const mid = (r.top + r.bottom) / 2;
    const d = Math.abs(mid - inputMid);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function ifpsNearestLabel(inputEl, selector, maxLevels) {
  const el = ifpsNearestLabelEl(inputEl, selector, maxLevels);
  return el ? el.innerText.trim() : '';
}

// Itens pausados/inativos no iFood aparecem com o nome numa cor diferente do
// resto (mais apagada) — mas a cor exata do "ativo" muda conforme o tema do
// portal (claro ou escuro), então um limiar fixo de brilho não funciona nos
// dois casos. Em vez disso guardamos aqui só a cor computada do texto; a
// decisão de quem está inativo é feita depois, olhando pra cor mais comum
// entre TODOS os itens lidos (ifpsFinalizeInativoFlags) — essa cor majoritária
// vira a "linha de base" de item ativo, seja tema claro ou escuro, e qualquer
// item com cor diferente dela é marcado como inativo.
function ifpsGetColorString(el) {
  if (!el) return '';
  return getComputedStyle(el).color || '';
}

// Recalcula item.inativo pra todos os itens do índice a partir da cor mais
// frequente (ifpsGetColorString) capturada durante o scan. Autocalibra pro
// tema atual do portal em vez de depender de um valor fixo de brilho.
function ifpsFinalizeInativoFlags(items) {
  const colorCounts = new Map();
  for (const item of items.values()) {
    if (!item.nameColor) continue;
    colorCounts.set(item.nameColor, (colorCounts.get(item.nameColor) || 0) + 1);
  }

  let baselineColor = '';
  let baselineCount = 0;
  for (const [color, count] of colorCounts) {
    if (count > baselineCount) {
      baselineColor = color;
      baselineCount = count;
    }
  }

  for (const item of items.values()) {
    item.inativo = !!item.nameColor && !!baselineColor && item.nameColor !== baselineColor;
  }
}

function ifpsNearestHeadingAbove(inputEl, headings) {
  const inputRect = inputEl.getBoundingClientRect();
  let best = null;
  let bestTop = -Infinity;
  for (const h of headings) {
    if (h.rect.top <= inputRect.top + 2 && h.rect.top > bestTop) {
      bestTop = h.rect.top;
      best = h;
    }
  }
  return best ? best.text : '';
}

// Procura primeiro o título dentro do próprio card do item. Isso evita
// depender de uma classe CSS específica do build do iFood e também impede
// que um título pertencente ao card anterior seja escolhido só por estar
// geometricamente perto. O fallback global mantém compatibilidade com
// layouts em que o título fica fora do elemento item-card.
function ifpsGroupHeadingForInput(inputEl, headings) {
  const card = inputEl.closest(IFPS_CONFIG.pizzaCardSelector);
  if (card) {
    const inputRect = inputEl.getBoundingClientRect();
    const optionText = ifpsNearestLabel(inputEl, IFPS_CONFIG.optionLabelSelector, IFPS_CONFIG.optionNameMaxLevels);
    const localCandidates = [...card.querySelectorAll(IFPS_CONFIG.groupHeadingSelector)]
      .map((el) => ({
        text: (el.innerText || el.textContent || '').trim(),
        rect: el.getBoundingClientRect(),
      }))
      .filter((candidate) => {
        if (!candidate.text || candidate.text.length > 140) return false;
        if (IFPS_HEADING_BADGE_RE.test(candidate.text)) return false;
        if (candidate.text === optionText) return false;
        if (candidate.rect.width === 0 && candidate.rect.height === 0) return false;
        // O título precisa terminar antes da linha do campo; isso exclui o
        // próprio nome da opção, que fica à esquerda do input na mesma linha.
        return candidate.rect.bottom <= inputRect.top + 6;
      });

    if (localCandidates.length) {
      localCandidates.sort((a, b) => b.rect.bottom - a.rect.bottom);
      return localCandidates[0].text;
    }
  }
  return ifpsNearestHeadingAbove(inputEl, headings);
}

// Acha o título da categoria (ex: "*** Combos Especiais ***") do card de
// item mais próximo, andando pra trás no DOM: primeiro pelos irmãos
// anteriores do próprio card (e dos ancestrais dele, subindo), procurando o
// heading de categoria mais recente antes dele. A lista do PDV organiza os
// itens em blocos por categoria, cada um com esse heading no topo — não tem
// atributo tipo "categoryName" pronto no card, só o heading textual mesmo.
function ifpsNearestCategoryFor(cardEl) {
  let node = cardEl;
  while (node) {
    let sib = node.previousElementSibling;
    while (sib) {
      const heading = sib.matches(IFPS_CONFIG.categoryHeadingSelector)
        ? sib
        : sib.querySelector(IFPS_CONFIG.categoryHeadingSelector);
      if (heading) return heading.textContent.trim();
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

// A lista do PDV do iFood parece "virtualizar" as linhas: itens que saem da
// tela (rolando pra baixo, ou voltando pro topo depois) são desmontados do
// DOM. Se a gente só lê tudo UMA VEZ no final (depois de já ter rolado a
// página inteira), qualquer item que tenha saído de vista nesse meio tempo
// simplesmente não aparece mais — e vira um item "perdido" na varredura.
// Por isso a leitura agora é incremental: capturamos o que está montado a
// cada passo da rolagem e vamos ACUMULANDO num único índice (função abaixo),
// em vez de ler tudo de uma vez só no final.

function ifpsMergeOption(item, optionData) {
  if (!optionData.optionid) return;
  const idx = item.options.findIndex((o) => o.optionid === optionData.optionid);
  if (idx === -1) item.options.push(optionData);
  else item.options[idx] = optionData;
}

// Lê o que está montado no DOM agora e mescla no índice acumulado `items`
// (Map itemid -> {itemName, parentCode, categoryid, options: [...], ...}).
// Chamada várias vezes, em posições de rolagem diferentes, por
// ifpsScanAndCapture — nunca sozinha pra ler a página inteira de uma vez.
// Selo "Opcional"/"Obrigatório" que o iFood mostra logo abaixo do título de
// cada grupo de complemento usa o MESMO seletor de heading (p.sc-sSmyr) —
// então, quando esse selo fica mais perto (verticalmente) da opção do que o
// título de verdade do grupo, ifpsNearestHeadingAbove pegava o selo em vez
// do título (bug real visto ao vivo: um grupo promocional "Aproveite a
// Pequena doce por R$29,90:" virava groupHeading="Opcional", perdendo a
// palavra "doce" que o matching.js usa pra não confundir sabor de pizza com
// borda). Filtramos esses selos aqui pra sempre cair no título real.
const IFPS_HEADING_BADGE_RE = /^(OPCIONAL|OBRIGAT[OÓ]RIO)$/i;

function ifpsCaptureSnapshot(items) {
  const headings = [...document.querySelectorAll(IFPS_CONFIG.groupHeadingSelector)]
    .map((h) => ({
      text: h.innerText.trim(),
      rect: h.getBoundingClientRect(),
    }))
    .filter((h) => h.text && !IFPS_HEADING_BADGE_RE.test(h.text));

  const itemInputs = [...document.querySelectorAll(IFPS_CONFIG.itemInputSelector)];
  for (const input of itemInputs) {
    const itemid = input.getAttribute('itemid');
    if (!itemid) continue;
    const nameEl = ifpsNearestLabelEl(input, IFPS_CONFIG.optionLabelSelector, IFPS_CONFIG.itemNameMaxLevels);
    const card = input.closest(IFPS_CONFIG.pizzaCardSelector);
    const existing = items.get(itemid);
    items.set(itemid, {
      itemid,
      categoryid: input.getAttribute('categoryid') || (existing ? existing.categoryid : ''),
      categoryName: (card ? ifpsNearestCategoryFor(card) : '') || (existing ? existing.categoryName : '') || '',
      itemName: (nameEl ? nameEl.innerText.trim() : '') || (existing ? existing.itemName : '') || '(nome não encontrado)',
      nameColor: (nameEl ? ifpsGetColorString(nameEl) : '') || (existing ? existing.nameColor : '') || '',
      inativo: existing ? existing.inativo : false,
      parentCode: input.value.trim(),
      inputId: input.id,
      isPizza: false,
      pizzaParentOptionid: '',
      options: existing ? existing.options : [],
    });
  }

  // Itens "tipo pizza": não têm item-pdv-input próprio (confirmado inspecionando
  // o DOM real). O código pai fica dentro do grupo "Tamanho", na única opção
  // desse grupo — o valor lá é o código Saipos cru (sem prefixo "x."), igual ao
  // item-pdv-input normal de qualquer outro item. Detectamos esses itens pelos
  // option-pdv-input cujo itemid não apareceu no passo acima.
  const allOptionInputsForDetection = [...document.querySelectorAll(IFPS_CONFIG.optionInputSelector)];
  const orphanByItem = new Map();
  for (const input of allOptionInputsForDetection) {
    const itemid = input.getAttribute('itemid');
    if (!itemid || items.has(itemid)) continue;
    if (!orphanByItem.has(itemid)) orphanByItem.set(itemid, []);
    orphanByItem.get(itemid).push(input);
  }

  for (const [itemid, inputs] of orphanByItem) {
    const card = inputs[0].closest(IFPS_CONFIG.pizzaCardSelector);
    const titleEl = card ? card.querySelector(IFPS_CONFIG.optionLabelSelector) : null;

    // 1ª tentativa: acha a opção cujo grupo se chama "Tamanho" (ou variação
    // tipo "Escolha o tamanho"). 2ª tentativa (fallback): grupo com uma única
    // opção — é o padrão observado pro campo de tamanho da pizza.
    let parentInput = null;
    for (const input of inputs) {
      const groupHeading = ifpsGroupHeadingForInput(input, headings);
      if (/tamanho/i.test(groupHeading)) {
        parentInput = input;
        break;
      }
    }
    if (!parentInput) {
      const byGroup = new Map();
      for (const input of inputs) {
        const gid = input.getAttribute('groupid') || '';
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(input);
      }
      for (const gInputs of byGroup.values()) {
        if (gInputs.length === 1) {
          parentInput = gInputs[0];
          break;
        }
      }
    }

    const existing = items.get(itemid);
    items.set(itemid, {
      itemid,
      categoryid: card ? card.getAttribute('categoryid') || '' : existing ? existing.categoryid : '',
      categoryName: (card ? ifpsNearestCategoryFor(card) : '') || (existing ? existing.categoryName : '') || '',
      itemName: (titleEl ? titleEl.innerText.trim() : '') || (existing ? existing.itemName : '') || '(nome não encontrado)',
      nameColor: (titleEl ? ifpsGetColorString(titleEl) : '') || (existing ? existing.nameColor : '') || '',
      inativo: existing ? existing.inativo : false,
      parentCode: parentInput ? parentInput.value.trim() : existing ? existing.parentCode : '',
      inputId: parentInput ? parentInput.id : existing ? existing.inputId : '',
      isPizza: true,
      pizzaParentOptionid: parentInput ? parentInput.getAttribute('optionid') || '' : existing ? existing.pizzaParentOptionid : '',
      options: existing ? existing.options : [],
    });
  }

  const optionInputs = [...document.querySelectorAll(IFPS_CONFIG.optionInputSelector)];
  for (const input of optionInputs) {
    const itemid = input.getAttribute('itemid');
    if (!itemid || !items.has(itemid)) continue;

    const item = items.get(itemid);
    const optionid = input.getAttribute('optionid') || '';
    // A opção "Tamanho" de um item tipo pizza já virou o parentCode acima —
    // não entra de novo como se fosse um complemento comum a ser casado.
    if (item.isPizza && optionid && optionid === item.pizzaParentOptionid) continue;

    const optionName = ifpsNearestLabel(input, IFPS_CONFIG.optionLabelSelector, IFPS_CONFIG.optionNameMaxLevels);
    const groupHeading = ifpsGroupHeadingForInput(input, headings);

    ifpsMergeOption(item, {
      optionid,
      groupid: input.getAttribute('groupid') || '',
      optionName: optionName || '(opção sem nome)',
      groupHeading,
      currentValue: input.value.trim(),
      inputId: input.id,
    });
  }
}

// Antes rodava só UMA passada, mas na prática a lista do iFood às vezes
// ainda está terminando de carregar dados (rede lenta, primeira visita à
// página, etc.) e uma única passada — mesmo com toda a rolagem — pode
// terminar antes de tudo estar montado, resultando num scan incompleto (foi
// o caso relatado: "às vezes puxa tudo só na 3ª vez que rodo"). Em vez de
// depender do usuário rodar a extensão várias vezes manualmente até dar
// certo, agora ela mesma repete a passada inteira automaticamente até dois
// scans seguidos encontrarem exatamente o mesmo conjunto de itens (ou seja,
// "estabilizou") — como o índice só ACUMULA itens (nunca remove), isso é
// seguro e só faz passadas extras quando realmente aparece algo novo.
// "Assinatura" do estado atual do índice: não basta comparar só os itemids
// encontrados — um item pode já ter aparecido no Map mas com a lista de
// opções (complementos) ainda incompleta, porque o toggle "Complementos"
// dele só terminou de carregar/expandir DEPOIS dessa passada. Se a gente só
// olhasse pro conjunto de ids, duas passadas podiam "empatar" (mesmos itens)
// mesmo com uma delas tendo menos opções lidas, e a extensão parava cedo
// demais achando que tinha estabilizado. Por isso a assinatura inclui a
// identidade das opções, o código pai e o nome de cada item.
function ifpsIndexFingerprint(items) {
  const itemParts = [];
  for (const [id, item] of items) {
    // Inclui a identidade de cada opção (não só a quantidade), além do
    // código pai e do nome. Assim duas passadas só são consideradas iguais
    // quando realmente capturaram o mesmo conteúdo — segurança extra agora
    // que expansão e leitura acontecem juntas.
    const optionIds = (item.options || [])
      .map((o) => o.optionid || '')
      .filter(Boolean)
      .sort()
      .join(',');
    itemParts.push([id, item.parentCode || '', item.itemName || '', optionIds].join('|'));
  }
  return itemParts.sort().join('||');
}

// Antes rodava só UMA passada, mas na prática a lista do iFood às vezes
// ainda está terminando de carregar dados (rede lenta, primeira visita à
// página, etc.) e uma única passada — mesmo com toda a rolagem — pode
// terminar antes de tudo estar montado, resultando num scan incompleto (foi
// o caso relatado: "às vezes puxa tudo só na 3ª vez que rodo"). Em vez de
// depender do usuário rodar a extensão várias vezes manualmente até dar
// certo, agora ela mesma repete a passada inteira automaticamente até duas
// passadas seguidas baterem na mesma "assinatura" (mesmos itens, códigos e
// opções) — ou seja, até "estabilizar" de verdade. Como
// o índice só ACUMULA itens/opções (nunca remove), passadas extras são
// seguras e só custam tempo quando realmente falta algo.
async function ifpsScanAndCapture() {
  const items = new Map();
  const maxPasses = 5;
  let previousFingerprint = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    if (pass > 1) {
      ifpsShowToast(`Lendo de novo (passada ${pass}/${maxPasses}) — ${items.size} item(ns) encontrados até agora, conferindo se falta algum...`, '');
    }
    // Re-expande a cada passada (não só na primeira): se algum complemento
    // estava fora da tela (virtualizado) durante a passada de expansão
    // anterior, ele pode ter acabado de aparecer nessa rolagem — a função já
    // ignora sozinha quem já está expandido, então repetir não tem custo
    // real quando não há nada novo pra expandir.
    // A própria expansão já captura cada viewport antes e depois dos
    // cliques; não é mais necessário percorrer toda a lista uma segunda vez
    // nesta mesma rodada.
    await ifpsExpandAll(items);

    const currentFingerprint = ifpsIndexFingerprint(items);
    if (previousFingerprint !== null && currentFingerprint === previousFingerprint) break;
    previousFingerprint = currentFingerprint;
  }

  ifpsFinalizeInativoFlags(items);

  return items;
}

// ---------- Etapa 3: casar com a planilha Saipos ----------

// Lista completa das linhas Tipo=COMPLEMENTO do Excel vinculadas ao código
// pai atual. O complemento do iFood fica FIXO na linha; este menu permite
// trocar qual complemento/código Saipos será aplicado nele. Não removemos
// linhas já usadas em outro casamento, pois o usuário pediu acesso à lista
// integral para correção manual.
function ifpsSaiposAlternativasFor(complementos) {
  return complementos
    .slice()
    .sort((a, b) => String(a['Complemento'] || '').localeCompare(String(b['Complemento'] || ''), 'pt-BR'))
    .map((row) => ({
      saiposNome: row['Complemento'] || '',
      saiposCodigo: String(row['Código Saipos'] || '').trim(),
      saiposDescricao: row['Descrição'] || '',
      novoCodigo: ifpsBuildIfoodCode(row['Código Saipos']) || '',
    }));
}

function ifpsIsAtivo(row) {
  const v = String(row['Inativo'] == null ? '' : row['Inativo']).trim().toUpperCase();
  // A coluna se chama "Inativo" mas guarda o status ("Ativo"/"Inativo"). Só
  // descartamos quando o valor deixa claro que está inativo; célula vazia
  // ou qualquer outro valor é tratado como ativo, pra não jogar fora linha
  // válida por engano.
  return v !== 'INATIVO';
}

function ifpsMatchAgainstSaipos(index, saiposRowsRaw) {
  const saiposRows = saiposRowsRaw.filter(ifpsIsAtivo);
  const skippedInativo = saiposRowsRaw.length - saiposRows.length;

  const complementoRows = saiposRows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'COMPLEMENTO');

  const complementosByParent = new Map();
  // O iFood grava no campo apenas o sufixo "x.<código do complemento>".
  // A mesma opção pode aparecer na planilha vinculada a outro produto pai
  // e ainda assim ser o código correto (caso real: x.24750091 aparece como
  // "BORDA / MASSA - TRADICIONAL" sob outro pai). Este índice global serve
  // apenas para VALIDAR valores que já estão no iFood; novas sugestões
  // continuam restritas às linhas do código pai do item atual.
  const complementosByIfoodCode = new Map();
  for (const row of complementoRows) {
    const parent = ifpsParentCode(row['Código Saipos']);
    if (!complementosByParent.has(parent)) complementosByParent.set(parent, []);
    complementosByParent.get(parent).push(row);

    const ifoodCode = ifpsBuildIfoodCode(row['Código Saipos']);
    if (ifoodCode) {
      const key = ifoodCode.toLowerCase();
      if (!complementosByIfoodCode.has(key)) complementosByIfoodCode.set(key, []);
      complementosByIfoodCode.get(key).push(row);
    }
  }

  let rowId = 0;
  const flatRows = [];
  const semPlanilha = [];
  const semCodigoPai = [];
  let semOpcaoNoIfood = 0;

  for (const item of index.values()) {
    if (!item.parentCode) {
      semCodigoPai.push(item);
      continue;
    }

    const complementos = complementosByParent.get(item.parentCode);
    if (!complementos || !complementos.length) {
      // Não ter linhas Tipo=COMPLEMENTO é perfeitamente normal para um
      // produto simples (bebida, sobremesa avulsa etc.) que também não tem
      // nenhuma opção no iFood. Antes esses produtos eram mostrados como
      // "sem linha na planilha", mesmo com o código pai/PRATO correto.
      // Só há algo para revisar quando o produto POSSUI opções no iFood mas
      // a planilha não traz nenhum complemento vinculado ao código pai.
      if (item.options && item.options.length > 0) semPlanilha.push(item);
      continue;
    }

    // Tamanho do item, lido do próprio nome (ex: "Pizza individual" = Pq,
    // "Pizza gigante ..." = Gg) — usado como desempate quando o nome da
    // opção do iFood não carrega marca de tamanho nenhuma. Ver ifpsScoreMatch.
    const itemSizeTag = ifpsSizeWordTag(item.itemName);

    // Às vezes a planilha tem MAIS DE UMA linha praticamente sinônima pro
    // mesmo sabor/produto (ex: "Guaraná Antarctica zero 2l" e "Refr Guarana
    // Antarctica Zero 2l" — nomes diferentes, mesma bebida). Se o código que
    // já está no campo do iFood bate com uma dessas linhas duplicadas (não
    // necessariamente a que "ganhou" a comparação), o campo já está certo —
    // trocar por outra linha igualmente válida não corrige nada, só cria
    // trabalho e confusão. Esse mapa deixa achar rapidinho qual linha da
    // planilha (se alguma) já corresponde ao código atual do campo.
    const codeToCompRow = new Map();
    for (const compRow of complementos) {
      const code = ifpsBuildIfoodCode(compRow['Código Saipos']);
      if (code) codeToCompRow.set(code.toLowerCase(), compRow);
    }

    const usedOptionIds = new Set();
    const pairs = [];

    // Primeiro tenta comprovar os códigos que JÁ estão nos campos usando a
    // planilha inteira. Fazemos isso só quando o mesmo sufixo não existe nas
    // linhas do pai atual (essas já serão tratadas normalmente logo abaixo)
    // e apenas quando nome + grupo atingem confiança alta. Assim preservamos
    // códigos globais legítimos sem transformar mera coincidência num
    // "já correto" falso.
    const localIfoodCodes = new Set(
      complementos
        .map((row) => ifpsBuildIfoodCode(row['Código Saipos']))
        .filter(Boolean)
        .map((code) => code.toLowerCase())
    );
    for (const opt of item.options) {
      const currentKey = String(opt.currentValue || '').trim().toLowerCase();
      if (!currentKey || localIfoodCodes.has(currentKey)) continue;

      const globalRows = complementosByIfoodCode.get(currentKey) || [];
      for (const globalRow of globalRows) {
        const parsed = ifpsParseComplementoField(globalRow['Complemento']);
        if (ifpsCategoriesConflict(parsed, opt.groupHeading)) continue;
        const score = ifpsScoreMatch(parsed, opt.optionName, opt.groupHeading, itemSizeTag);
        if (score < IFPS_CONFIDENCE.HIGH) continue;

        pairs.push({
          compRow: globalRow,
          parsed,
          newCode: ifpsBuildIfoodCode(globalRow['Código Saipos']),
          opt,
          score,
          exactCurrentCode: true,
          globalCurrentMatch: true,
        });
      }
    }

    for (const compRow of complementos) {
      const parsed = ifpsParseComplementoField(compRow['Complemento']);
      const newCode = ifpsBuildIfoodCode(compRow['Código Saipos']);
      for (const opt of item.options) {
        // Um código que já coincide exatamente com a linha da planilha é
        // uma prova mais forte que qualquer semelhança de nome. Guardamos
        // esse sinal para reservar esses pares antes do casamento fuzzy —
        // assim um empate (inclusive score zero) nunca consegue inverter
        // duas opções que já estavam preenchidas corretamente no iFood.
        const exactCurrentCode = !!(
          newCode &&
          opt.currentValue &&
          newCode.toLowerCase() === opt.currentValue.trim().toLowerCase()
        );
        // Se os dois lados têm categorias reconhecíveis e incompatíveis
        // (ex.: BEBIDA x BORDA), esse par não é uma alternativa plausível.
        // Código atual exatamente igual continua prevalecendo, pois é uma
        // evidência mais forte e também protege contra eventual título de
        // grupo lido incorretamente pelo portal.
        if (ifpsCategoriesConflict(parsed, opt.groupHeading) && !exactCurrentCode) continue;

        const score = ifpsScoreMatch(parsed, opt.optionName, opt.groupHeading, itemSizeTag);
        pairs.push({ compRow, parsed, newCode, opt, score, exactCurrentCode });
      }
    }
    pairs.sort((a, b) => {
      const exactDiff = Number(b.exactCurrentCode) - Number(a.exactCurrentCode);
      return exactDiff || b.score - a.score;
    });

    const assignedSaiposRow = new Set();
    const rowsForItem = [];
    for (const pair of pairs) {
      const saiposKey = pair.compRow['Código Saipos'];
      if (assignedSaiposRow.has(saiposKey) || usedOptionIds.has(pair.opt.optionid)) continue;
      assignedSaiposRow.add(saiposKey);
      usedOptionIds.add(pair.opt.optionid);

      // Comparação sem diferenciar maiúscula/minúscula: já vimos campo do
      // iFood com "X.21619042" (X maiúsculo) igual, na prática, ao código
      // novo "x.21619042" — mas a comparação exata (===) tratava isso como
      // "diferente" e sugeria mudar pra um valor que já era o mesmo.
      const jaCorreto =
        pair.newCode && pair.opt.currentValue && pair.newCode.toLowerCase() === pair.opt.currentValue.trim().toLowerCase();

      // O código atual não é IGUAL ao que essa linha geraria, mas pode ser
      // que ele já corresponda a uma linha DIFERENTE e igualmente válida da
      // planilha pra esse mesmo sabor (ver comentário acima). Só conta como
      // "já correto por duplicata" se essa outra linha também bate BEM
      // (confiança alta) com essa mesma opção — senão um código atual
      // realmente errado (sabor trocado) poderia se disfarçar de correto só
      // por coincidir com o código de OUTRO produto qualquer da planilha.
      let jaCorretoViaDuplicata = false;
      let duplicataDe = '';
      if (!jaCorreto && pair.opt.currentValue) {
        const altRow = codeToCompRow.get(pair.opt.currentValue.trim().toLowerCase());
        if (altRow && altRow['Código Saipos'] !== pair.compRow['Código Saipos']) {
          const altParsed = ifpsParseComplementoField(altRow['Complemento']);
          const altScore = ifpsScoreMatch(altParsed, pair.opt.optionName, pair.opt.groupHeading, itemSizeTag);
          if (altScore >= IFPS_CONFIDENCE.HIGH) {
            jaCorretoViaDuplicata = true;
            duplicataDe = altRow['Complemento'] || '';
          }
        }
      }

      // Mesmo quando é "correto por duplicata", deixamos visível pra você
      // conferir com seus próprios olhos (em vez de sumir na pilha dos
      // "já corretos" comuns) — é uma inferência a mais em cima de duas
      // linhas parecidas da planilha, então vale um olhar rápido.
      const nomeSuspeito =
        (jaCorreto && pair.score < IFPS_CONFIDENCE.HIGH) ||
        jaCorretoViaDuplicata ||
        !!pair.globalCurrentMatch;
      const confidence = jaCorreto || jaCorretoViaDuplicata ? 'correto' : ifpsClassify(pair.score);

      rowsForItem.push({
        rowId: rowId++,
        itemName: item.itemName,
        categoriaIfood: item.categoryName || '',
        saiposDescricao: pair.compRow['Descrição'] || '',
        parentCode: item.parentCode,
        itemInativo: item.inativo,
        saiposNome: pair.compRow['Complemento'],
        saiposCodigo: pair.compRow['Código Saipos'],
        novoCodigo: pair.newCode,
        opcaoIfood: pair.opt.optionName,
        grupoIfood: pair.opt.groupHeading,
        valorAtual: pair.opt.currentValue,
        inputId: pair.opt.inputId,
        itemid: item.itemid,
        optionid: pair.opt.optionid,
        // pair.score é o valor cru (usado pra ordenar/desempatar, pode passar
        // de 1 quando vários sinais concordam) — pra mostrar na tela usamos a
        // versão limitada a 0..1, senão apareceria tipo "1.31" na coluna Score.
        score: ifpsDisplayScore(pair.score),
        confidence,
        nomeSuspeito,
        duplicataDe,
        codigoGlobalReutilizado: !!pair.globalCurrentMatch,
        // "já correto" nunca mostra o menu de alternativas na revisão, então
        // nem guardamos essa lista pra ele — é o que mais pesava no relatório
        // (o mesmo grupo de opções repetido em cada linha correta).
        alternativas: confidence === 'correto' ? [] : ifpsSaiposAlternativasFor(complementos),
      });
    }

    // Linhas da planilha que não acharam NENHUMA opção correspondente no
    // iFood: normalmente é porque o grupo de complementos na Saipos é
    // compartilhado entre vários tamanhos/produtos (ex: "Bordas e Massas"
    // lista Pq/Gg/Gr todas juntas), mas esse item específico no iFood só tem
    // uma parte delas cadastrada. Como não existe campo nenhum no iFood pra
    // preencher nesse caso, não tem o que revisar — só ficaria como ruído na
    // lista. Só contamos, não listamos mais linha por linha.
    for (const compRow of complementos) {
      const already = rowsForItem.find((r) => r.saiposCodigo === compRow['Código Saipos']);
      if (!already) semOpcaoNoIfood++;
    }

    flatRows.push(...rowsForItem);
  }

  const produtosPaiMatch = ifpsMatchProdutosPai(index, saiposRows, () => rowId++);

  return {
    rows: flatRows,
    produtosPai: produtosPaiMatch.rows,
    // Pool compartilhado, guardado uma única vez no relatório. Antes cada
    // linha levava até 60 alternativas próprias; além de cortar o Excel,
    // isso repetia os mesmos dados dezenas de vezes no storage da extensão.
    produtosPaiAlternativas: produtosPaiMatch.alternativas,
    semPlanilha: semPlanilha.map((i) => ({ itemName: i.itemName, parentCode: i.parentCode, itemInativo: i.inativo })),
    semCodigoPai: semCodigoPai.map((i) => ({ itemName: i.itemName, itemInativo: i.inativo })),
    semOpcaoNoIfood,
    skippedInativo,
  };
}

// Compara o NOME de cada item do iFood com as linhas tipo PRATO da planilha
// Saipos, pra conferir se o "código pai" que você já digitou no campo do
// item é mesmo o produto certo — diferente da comparação de complementos
// acima (que já ASSUME que o código pai está certo e só casa os
// complementos dentro dele). Roda pra todo item lido, tenha ele complemento
// casado ou não.
function ifpsMatchProdutosPai(index, saiposRows, nextRowId) {
  const pratoRows = saiposRows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'PRATO');
  if (!pratoRows.length) return { rows: [], alternativas: [] };

  // Lista integral dos produtos pai ativos do Excel. Fica fora das linhas
  // individuais porque é a mesma para todo item do iFood; assim podemos
  // disponibilizar centenas de produtos sem multiplicar o peso do relatório.
  const alternativas = pratoRows
    .map((row) => ({
      codigo: String(row['Código Saipos'] || '').trim(),
      descricao: row['Descrição'] || '',
    }))
    .sort((a, b) => {
      const nameDiff = a.descricao.localeCompare(b.descricao, 'pt-BR');
      return nameDiff || a.codigo.localeCompare(b.codigo, 'pt-BR');
    });

  // O código pai atual pode apontar pra uma linha da planilha que NÃO é
  // Tipo=PRATO (ex: um combo tipo "Monte a sua pizza" ou "Pizzas Brotos -
  // Escolha a sua", que algumas planilhas cadastram com outro Tipo) — isso é
  // um produto "pai" legítimo do mesmo jeito, só não devia entrar no POOL de
  // busca (pra não competir/confundir com pratos de verdade), mas se o
  // código atual já aponta pra uma dessas linhas, precisamos reconhecer isso
  // como válido. Sem esse mapa "de qualquer tipo", o item caía incorretamente
  // em "sem correspondência" (Criar no Saipos) mesmo já tendo um código pai
  // certo, só porque a busca só olhava pratRows.
  const anyRowsByCode = new Map();
  for (const row of saiposRows) {
    const code = String(row['Código Saipos'] || '').trim();
    if (!code) continue;
    if (!anyRowsByCode.has(code)) anyRowsByCode.set(code, []);
    anyRowsByCode.get(code).push(row);
  }

  const produtosPai = [];
  for (const item of index.values()) {
    const currentCode = item.parentCode || '';
    // Se houver linhas duplicadas com o mesmo código, usa a descrição que
    // melhor explica o nome do item, em vez de aceitar cegamente a primeira
    // ocorrência do Excel.
    const currentCandidates = currentCode ? anyRowsByCode.get(currentCode) || [] : [];
    const currentRanked = currentCandidates
      .map((row) => ({ row, score: ifpsScoreProduto(item.itemName, row['Descrição']) }))
      .sort((a, b) => b.score - a.score);
    const currentRow = currentRanked.length ? currentRanked[0].row : null;

    const scored = pratoRows
      .map((row) => ({ row, score: ifpsScoreProduto(item.itemName, row['Descrição']) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    // Calculado à parte de `scored` (que só cobre o pool PRATO) — assim
    // funciona mesmo quando currentRow é de outro Tipo e nunca apareceria
    // ali.
    const currentScore = currentRanked.length ? currentRanked[0].score : -Infinity;

    // A Descrição da linha do código atual pode seguir a convenção
    // "CATEGORIA - NOME" (ex: "Afoga Borda - Pesto de Azeitona Preta") — se
    // o prefixo bater com a categoria do item no iFood, é um sinal mais
    // confiável do que a semelhança de texto pura (ver comentário de
    // ifpsParsePratoDescricao/ifpsCategoriaMatchesPrefix em matching.js):
    // trata como certo direto, sem disputar pontuação de texto com outra
    // linha que só por acaso tem um nome mais "limpo".
    const currentPratoParsed = currentRow ? ifpsParsePratoDescricao(currentRow['Descrição']) : null;
    const currentCategoriaBate = !!(
      currentRow &&
      item.categoryName &&
      currentPratoParsed &&
      ifpsCategoriaMatchesPrefix(item.categoryName, currentPratoParsed.prefix)
    );

    // "Já correto" quando (a) o próprio prato do código atual É o que
    // melhor bate com o nome do item — não existe pra onde sugerir trocar,
    // então não faz sentido nenhum listar isso como "para revisar" com um
    // checkbox que não teria o que aplicar (foi visto ao vivo: linha "para
    // revisar" com o mesmo código sugerido E atual, checkbox sempre
    // desabilitado, sem forma de marcar); (b) o prefixo "CATEGORIA - NOME"
    // da descrição do código atual bate com a categoria do item no iFood
    // (ver acima); ou (c) o código existe na planilha e o nome tem ao menos
    // confiança média. Nesse último caso, a coincidência exata do código é
    // a evidência principal e o texto serve para impedir que um código de
    // produto claramente diferente seja aceito como correto.
    const currentNamesConflict = !!(
      currentRow && ifpsProductNamesClearlyConflict(item.itemName, currentRow['Descrição'])
    );
    const bestIsCurrent = !!currentRow && best.row === currentRow && !currentNamesConflict;
    const currentCodeNameCompatible = !!(
      currentRow &&
      currentScore >= IFPS_CONFIDENCE.MEDIUM &&
      !currentNamesConflict
    );
    // Para produto pai, uma coincidência EXATA do código atual com qualquer
    // linha ativa da planilha é a prova principal. O nome pode ser mais
    // comercial no iFood e mais genérico no Saipos (caso real: "Monster
    // Ultra White" x "Energético Lata 473ml"). Antes o conflito de nomes
    // anulava o código exato e jogava o produto em "sem correspondência".
    // Mantemos a diferença de nome só como aviso visual (`nomeSuspeito`),
    // nunca como motivo para sugerir a troca de um PDV que já existe.
    const currentCodeExists = currentCandidates.length > 0;
    const jaCorreto =
      currentCodeExists ||
      bestIsCurrent ||
      currentCategoriaBate ||
      currentCodeNameCompatible;

    let chosen = null;
    let novoCodigo = '';
    let confidence = 'baixa';
    let displayScore = 0;

    if (jaCorreto) {
      chosen = currentRow;
      novoCodigo = currentCode;
      confidence = 'correto';
      displayScore = currentScore;
    } else if (best.score >= IFPS_CONFIDENCE.MEDIUM) {
      chosen = best.row;
      novoCodigo = String(chosen['Código Saipos'] || '').trim();
      confidence = ifpsClassify(best.score);
      displayScore = best.score;
    }

    // "Correto" mas vale um olhar rápido: ou tinha outro prato quase
    // empatado no nome, ou (caso do bestIsCurrent) o nome do item é bem
    // diferente do nome do prato na planilha mesmo sendo, comprovadamente, o
    // melhor candidato que existe — pode ser só uma diferença de descrição,
    // mas também pode ser um código pai digitado errado sem prato
    // correspondente cadastrado na planilha.
    const nomeSuspeito = jaCorreto && !currentCodeNameCompatible && (best.row !== currentRow || currentScore < IFPS_CONFIDENCE.HIGH);

    // Quantos complementos (e em quantos grupos, tipo "Tamanho"/"Sabores"/
    // "Adicionais") esse item tem no iFood — importante saber ANTES de criar
    // o produto no Saipos do zero, porque um produto novo nasce sem nenhum
    // complemento vinculado: se o item tem grupo de complemento no iFood, o
    // usuário provavelmente vai precisar montar isso manualmente no Saipos
    // depois de criar o produto básico (a extensão não faz essa parte).
    const gruposComplementos = [
      ...new Set(
        (item.options || [])
          .map((o) => (o.groupHeading || '').trim())
          .filter(Boolean)
      ),
    ];

    produtosPai.push({
      rowId: nextRowId(),
      itemName: item.itemName,
      categoriaIfood: item.categoryName || '',
      itemInativo: item.inativo,
      codigoAtual: currentCode,
      pratoNome: chosen ? chosen['Descrição'] || '' : '',
      novoCodigo,
      inputId: item.inputId,
      itemid: item.itemid,
      optionid: item.isPizza ? item.pizzaParentOptionid : '',
      isPizza: !!item.isPizza,
      score: ifpsDisplayScore(displayScore),
      confidence,
      nomeSuspeito,
      semCorrespondencia: !chosen,
      qtdComplementos: (item.options || []).length,
      gruposComplementos,
    });
  }

  return { rows: produtosPai, alternativas };
}

// ---------- Etapa 4: aplicar (a pedido da aba de revisão) ----------

async function ifpsSetInputValueReact(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  input.scrollIntoView({ block: 'center', inline: 'nearest' });
  input.focus({ preventScroll: true });
  input.select();

  // Primeiro tenta a mesma rota de edição usada pelo navegador ao inserir
  // texto num campo selecionado. Ela aciona o input nativo e costuma ser
  // mais confiável em campos controlados pelo React do que alterar apenas a
  // propriedade value. Se o navegador recusar, cai no setter nativo.
  let insertedNatively = false;
  try {
    insertedNatively = document.execCommand('insertText', false, value) && input.value === value;
  } catch (err) {
    insertedNatively = false;
  }
  if (!insertedNatively) {
    setter.call(input, value);
  }
  // Mesmo quando insertText altera o valor visível, dispara explicitamente
  // o evento que o campo controlado do iFood usa para registrar a edição.
  // Isso é importante nas novas tentativas, quando o texto já pode estar no
  // input, mas a gravação anterior não chegou ao servidor.
  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value })
    : new Event('input', { bubbles: true });
  input.dispatchEvent(inputEvent);

  // O PDV do iFood só dispara a chamada real de salvamento (POST/PUT em
  // .../menu/v4/external-code) quando o campo recebe também eventos de
  // teclado (keydown/keyup) — os eventos input/change/blur sozinhos
  // atualizam o valor na tela (por isso parecia "aplicado"), mas o backend
  // nunca era chamado e o valor sumia ao recarregar a página. Testado ao
  // vivo: sem esses dois eventos, o campo muda visualmente mas não salva;
  // com eles, salva de verdade (confirmado via toast "PDV atualizado com
  // sucesso" e nas chamadas de rede).
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
  await ifpsSleep(80);
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // O comportamento que já funcionava em lotes era sair para OUTRO campo
  // PDV. O campo de busca não passa pelo mesmo fluxo de formulário do iFood
  // e podia deixar o código apenas visível, sem persistir no servidor.
  const pdvInputs = [...document.querySelectorAll(
    'input[data-testid="item-pdv-input"], input[data-testid="option-pdv-input"]'
  )].filter((candidate) => !candidate.disabled);
  const currentIndex = pdvInputs.indexOf(input);
  const realNextFocus =
    (currentIndex >= 0 && pdvInputs[currentIndex + 1]) ||
    pdvInputs.find((candidate) => candidate !== input);
  if (realNextFocus && realNextFocus !== input) {
    realNextFocus.focus({ preventScroll: true });
    if (document.activeElement === input) input.blur();
    await ifpsSleep(100);
    return;
  }

  // Para uma página com somente um campo PDV, usa a busca real como segunda
  // opção de click-away antes do elemento auxiliar invisível.
  const searchInput = document.querySelector('input[placeholder="Buscar um item"]');
  if (searchInput && searchInput !== input) {
    searchInput.focus({ preventScroll: true });
    if (document.activeElement === input) input.blur();
    await ifpsSleep(100);
    return;
  }

  await ifpsSleep(30);
  const focusSink = document.createElement('button');
  focusSink.type = 'button';
  focusSink.tabIndex = -1;
  focusSink.setAttribute('aria-hidden', 'true');
  focusSink.style.cssText =
    'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(focusSink);
  try {
    focusSink.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    focusSink.focus({ preventScroll: true });
    focusSink.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    focusSink.click();
    if (document.activeElement === input) input.blur();
    await ifpsSleep(80);
  } finally {
    focusSink.remove();
  }
}

// O id de elemento capturado durante a varredura pode não existir mais na
// hora de aplicar: o PDV parece desmontar/re-renderizar linhas conforme você
// rola ou muda o filtro (lista "virtualizada"), e aí o React troca o id
// interno. Por isso a busca tenta, em ordem: (1) o id antigo, mais rápido
// quando nada mudou; (2) os atributos itemid/optionid, que são estáveis e
// vêm do próprio iFood; (3) rolar a página inteira procurando por esses
// atributos, caso a linha esteja fora da área renderizada no momento.
// Confere se o elemento achado por getElementById(row.inputId) ainda é
// mesmo o campo que a linha diz que é, antes de escrever nele. Necessário
// porque a lista do PDV é virtualizada: o React desmonta/remonta linhas
// conforme você rola a página e RECICLA os elementos DOM (e o id deles) pra
// renderizar outras linhas depois. O id capturado lá atrás, na varredura,
// pode já pertencer a outro campo na hora de aplicar — inclusive o campo de
// CÓDIGO PAI (item-pdv-input) de um produto totalmente diferente — se algum
// tempo (rolagem, revisão numa aba separada) passou entre as duas etapas.
// Bug real visto ao vivo: aplicar uma linha de complemento de pizza também
// sobrescrevia o código pai de outro item, porque o id antigo tinha sido
// reciclado pro campo errado. Sem essa checagem, getElementById aceita
// QUALQUER elemento com aquele id, seja ele item-pdv-input ou
// option-pdv-input, do item certo ou não.
function ifpsElementMatchesRow(el, row) {
  if (!el) return false;
  const expectedTestId = row.optionid || row.isPizza ? 'option-pdv-input' : 'item-pdv-input';
  if (el.getAttribute('data-testid') !== expectedTestId) return false;
  if (row.itemid && el.getAttribute('itemid') !== row.itemid) return false;
  if (row.optionid && el.getAttribute('optionid') !== row.optionid) return false;
  return true;
}

// Localiza um campo que já esteja renderizado. Produtos normais possuem
// item-pdv-input. Pizzas guardam o código pai numa option-pdv-input do grupo
// Tamanho; quando o optionid não foi preservado, usamos o valor atual, o
// título do grupo ou o único campo do grupo como alternativas seguras.
function ifpsFindRenderedInput(row) {
  if (!row.itemid) return null;

  if (row.optionid) {
    return document.querySelector(
      `input[data-testid="option-pdv-input"][itemid="${CSS.escape(row.itemid)}"][optionid="${CSS.escape(row.optionid)}"]`
    );
  }

  if (!row.isPizza) {
    return document.querySelector(`input[data-testid="item-pdv-input"][itemid="${CSS.escape(row.itemid)}"]`);
  }

  const candidates = [
    ...document.querySelectorAll(`input[data-testid="option-pdv-input"][itemid="${CSS.escape(row.itemid)}"]`),
  ];
  if (!candidates.length) return null;

  const codigoAtual = String(row.codigoAtual || '').trim();
  if (codigoAtual) {
    const byCurrentValue = candidates.find((input) => String(input.value || '').trim() === codigoAtual);
    if (byCurrentValue) return byCurrentValue;
  }
  if (candidates.length === 1) return candidates[0];

  const headings = [...document.querySelectorAll(IFPS_CONFIG.groupHeadingSelector)]
    .map((h) => ({ text: (h.innerText || '').trim(), rect: h.getBoundingClientRect() }))
    .filter((h) => h.text && !IFPS_HEADING_BADGE_RE.test(h.text));
  const tamanho = candidates.find((input) => /tamanho/i.test(ifpsGroupHeadingForInput(input, headings)));
  if (tamanho) return tamanho;

  const byGroup = new Map();
  for (const input of candidates) {
    const groupid = input.getAttribute('groupid') || '';
    if (!byGroup.has(groupid)) byGroup.set(groupid, []);
    byGroup.get(groupid).push(input);
  }
  for (const groupInputs of byGroup.values()) {
    if (groupInputs.length === 1) return groupInputs[0];
  }
  return null;
}

async function ifpsFindInputElement(row) {
  if (row.inputId) {
    const byId = document.getElementById(row.inputId);
    // Só confia no id capturado na varredura se ele ainda apontar pro campo
    // certo agora — ver comentário de ifpsElementMatchesRow. Quando o id foi
    // reciclado pra outro elemento (ou quando a linha não tem itemid/optionid
    // pra conferir, ex: nenhum dos dois informado), cai pro método seguro
    // abaixo em vez de escrever no campo errado.
    if (byId && (ifpsElementMatchesRow(byId, row) || (!row.itemid && !row.optionid))) return byId;
  }

  if (!row.itemid) return null;
  let el = ifpsFindRenderedInput(row);
  if (el) return el;

  let lastHeight = -1;
  let stableRounds = 0;
  for (let i = 0; i < 60 && !el; i++) {
    // Mesmo contêiner de rolagem real usado no scan (ver ifpsScrollState) —
    // sem isso, procurar um campo mais pra baixo na lista (item fora da área
    // já renderizada) nunca rolava de verdade e a busca desistia achando que
    // já tinha chegado ao fim.
    const scroll = ifpsScrollState();
    scroll.scrollBy(Math.round(scroll.viewportSize * 0.8));
    await ifpsSleep(180);
    el = ifpsFindRenderedInput(row);
    if (el) break;

    const after = ifpsScrollState();
    const atBottom = after.atBottom;
    const h = after.height;
    if (atBottom && h === lastHeight) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = h;
  }
  return el;
}

// O iFood usa a lib Toastify pros avisos flutuantes (confirmado inspecionando
// o DOM ao vivo): quando a chamada de salvamento é recusada — na prática,
// quando aplicamos muitos códigos rápido demais em sequência e o portal
// esbarra em algum limite de velocidade dele — aparece um toast vermelho
// ".Toastify__toast-body" com o texto "Ocorreu um erro ao atualizar o PDV do
// item.". O valor do campo às vezes nem chega a "grudar" errado (o
// stuck/aria-invalid sozinhos não pegam esse caso), então esse toast é o
// sinal mais confiável de que aquela aplicação específica falhou.
const IFPS_TOAST_BODY_SELECTOR = '.Toastify__toast-body';
const IFPS_TOAST_CLOSE_SELECTOR = '.Toastify__close-button';
const IFPS_ERRO_TOAST_RE = /erro ao atualizar o pdv do item/i;
const IFPS_SUCESSO_TOAST_RE = /pdv atualizado com sucesso/i;

function ifpsIfoodErrorToastPresent() {
  return [...document.querySelectorAll(IFPS_TOAST_BODY_SELECTOR)].some((el) => IFPS_ERRO_TOAST_RE.test(el.innerText || ''));
}

function ifpsIfoodSuccessToastPresent() {
  return [...document.querySelectorAll(IFPS_TOAST_BODY_SELECTOR)].some((el) => IFPS_SUCESSO_TOAST_RE.test(el.innerText || ''));
}

// O valor permanecer no input só prova que o React atualizou a tela; não
// prova que o backend do iFood salvou. Esperamos a resposta visual oficial
// do portal e usamos o toast verde/vermelho como confirmação da requisição.
async function ifpsWaitForIfoodSaveFeedback(timeoutMs = 1800) {
  const intervalMs = 100;
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (ifpsIfoodErrorToastPresent()) return 'error';
    if (ifpsIfoodSuccessToastPresent()) return 'success';
    if (waited < timeoutMs) await ifpsSleep(intervalMs);
  }
  return 'timeout';
}

// Fecha todo toast do iFood que estiver na tela — usado (a) antes de começar
// o lote, pra não confundir um toast de erro antigo (de uma tentativa
// anterior, ainda não dispensado) com um erro novo, e (b) depois de detectar
// um erro de verdade, pra não empilhar toast em cima de toast num lote
// grande.
function ifpsDismissAllIfoodToasts() {
  document.querySelectorAll(IFPS_TOAST_CLOSE_SELECTOR).forEach((btn) => {
    try {
      btn.click();
    } catch (err) {
      // ignora — na pior das hipóteses o toast antigo fica na tela mais um
      // pouco, não afeta a detecção (comparamos só se existe erro NOVO após
      // cada linha, então um toast preso de antes não muda o resultado).
    }
  });
}

// Pausa extra entre uma aplicação e a próxima (além do tempo que
// ifpsApplyRow já espera a chamada de salvamento terminar) — dá mais fôlego
// pro iFood não recusar por excesso de chamadas em sequência.
const IFPS_APPLY_ROW_GAP_MS = 100;
// Se mesmo assim o iFood recusar (toast de erro, valor não gravado), tenta
// de novo algumas vezes com espera crescente antes de desistir da linha.
const IFPS_APPLY_MAX_ATTEMPTS = 2;
const IFPS_APPLY_RETRY_BASE_MS = 350;

async function ifpsApplyRow(row) {
  if (!row.novoCodigo) return { ok: false, reason: 'sem opção associada' };

  console.info('[IFPS APPLY] iniciando ' + JSON.stringify({
    rowId: row.rowId,
    itemid: row.itemid || '',
    optionid: row.optionid || '',
    isPizza: !!row.isPizza,
    novoCodigo: row.novoCodigo,
  }));
  const input = await ifpsFindInputElement(row);
  if (!input) {
    console.warn('[IFPS APPLY] campo não encontrado ' + JSON.stringify({ rowId: row.rowId, itemid: row.itemid || '' }));
    return {
      ok: false,
      reason: 'campo não encontrado na página mesmo após rolar tudo — verifique se o item ainda existe e tente de novo',
    };
  }

  // Cada tentativa começa sem toast antigo. Assim um sucesso da linha
  // anterior nunca é confundido com confirmação desta linha.
  ifpsDismissAllIfoodToasts();
  await ifpsSetInputValueReact(input, row.novoCodigo);
  const feedback = await ifpsWaitForIfoodSaveFeedback();

  const stuck = input.value === row.novoCodigo;
  const invalid = input.getAttribute('aria-invalid') === 'true';
  const erroToast = feedback === 'error';
  if (erroToast) ifpsDismissAllIfoodToasts();

  // O portal nem sempre mostra o toast verde, mesmo quando a gravação foi
  // concluída. Confirmado ao vivo: os códigos 41158316 e 41158328 deram
  // `timeout`, permaneceram válidos no campo e continuaram lá depois de um
  // F5 (portanto vieram novamente do servidor). Se não houve toast de erro,
  // o valor permaneceu e o iFood não marcou o campo como inválido, a linha
  // está aplicada; não devemos repetir a mesma gravação nem mostrar falha.
  const acceptedWithoutToast = feedback === 'timeout' && stuck && !invalid;
  const ok = stuck && !invalid && (feedback === 'success' || acceptedWithoutToast);
  const confirmation = feedback === 'success' ? 'toast' : acceptedWithoutToast ? 'field' : '';
  const reason = ok
    ? ''
    : erroToast
    ? 'o iFood recusou a atualização (provável limite de velocidade do próprio portal)'
    : invalid
    ? 'campo marcado como inválido pelo iFood'
    : feedback === 'timeout'
    ? 'o iFood não confirmou o salvamento (o aviso verde não apareceu)'
    : 'valor não foi mantido';

  console.info('[IFPS APPLY] resultado ' + JSON.stringify({
    rowId: row.rowId,
    feedback,
    valorEsperado: row.novoCodigo,
    valorNoCampo: input.value,
    invalid,
    confirmation,
    ok,
  }));

  return { ok, reason, confirmation };
}

// Tenta aplicar uma linha, e se falhar (toast de erro do iFood, valor não
// gravado) tenta de novo mais algumas vezes com espera crescente — na
// prática "burla" o limite de velocidade do portal sem precisar que você
// clique de novo manualmente.
async function ifpsApplyRowWithRetry(row) {
  let res;
  for (let attempt = 1; attempt <= IFPS_APPLY_MAX_ATTEMPTS; attempt++) {
    try {
      chrome.runtime.sendMessage({
        type: 'IFPS_APPLY_PROGRESS',
        rowId: row.rowId,
        attempt,
        maxAttempts: IFPS_APPLY_MAX_ATTEMPTS,
      });
    } catch (err) {
      console.error('[iFood PDV Sync]', err);
    }
    try {
      res = await ifpsApplyRow(row);
    } catch (err) {
      console.error('[iFood PDV Sync]', err);
      res = { ok: false, reason: 'erro inesperado: ' + (err && err.message ? err.message : String(err)) };
    }
    if (res.ok || attempt === IFPS_APPLY_MAX_ATTEMPTS) break;
    await ifpsSleep(IFPS_APPLY_RETRY_BASE_MS * attempt);
    // O toast de erro do iFood leva um instante pra sumir sozinho (animação
    // de saída) — garante que nenhum resto dele continue na tela quando a
    // próxima tentativa checar de novo, senão um toast antigo ainda
    // desaparecendo poderia ser lido como um erro NOVO por engano.
    ifpsDismissAllIfoodToasts();
  }
  if (!res.ok && IFPS_APPLY_MAX_ATTEMPTS > 1) {
    res = { ...res, reason: `${res.reason} (depois de ${IFPS_APPLY_MAX_ATTEMPTS} tentativas)` };
  }
  return res;
}

async function ifpsApplyRowsOnPage(rows) {
  ifpsShowToast(`Aplicando ${rows.length} código(s) no cardápio...`, '');
  // Começa limpo: um toast de erro deixado de uma aplicação anterior (que o
  // usuário não fechou) não pode ser confundido com um erro desta rodada.
  ifpsDismissAllIfoodToasts();

  for (const row of rows) {
    // Um erro inesperado numa linha (ex: exceção ao rolar/procurar o campo)
    // não pode travar o resto do lote — sem isso, a aba de revisão nunca
    // recebia o aviso de "terminou" e o botão "Aplicar" ficava preso pra
    // sempre em "Aplicando X/N...", parecendo que nada tinha acontecido.
    const res = await ifpsApplyRowWithRetry(row);
    try {
      chrome.runtime.sendMessage({
        type: 'IFPS_APPLY_RESULT',
        rowId: row.rowId,
        ok: res.ok,
        reason: res.reason,
        confirmation: res.confirmation || '',
      });
    } catch (err) {
      console.error('[iFood PDV Sync]', err);
    }
    // Pausa extra entre uma linha e a próxima — reduz a chance de o iFood
    // recusar por excesso de chamadas em sequência rápida.
    await ifpsSleep(IFPS_APPLY_ROW_GAP_MS);
  }
  try {
    chrome.runtime.sendMessage({ type: 'IFPS_APPLY_DONE' });
  } catch (err) {
    console.error('[iFood PDV Sync]', err);
  }
  ifpsShowToast('Aplicação concluída. Confira o resumo na aba de revisão.', '');
}

function ifpsShowToast(msg, kind) {
  let toast = document.getElementById('ifps-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ifps-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = kind === 'err' ? 'ifps-toast-err' : '';
  toast.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.display = 'none';
  }, 6000);
}
