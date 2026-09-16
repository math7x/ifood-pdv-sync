// background.js — service worker. Só faz o papel de mensageiro:
// 1) recebe os resultados calculados na aba do iFood e abre a aba de revisão;
// 2) recebe pedidos de "aplicar" vindos da aba de revisão e repassa pra aba
//    correta do iFood, que é quem de fato tem os campos no DOM.
//
// Tudo aqui usa async/await e só chama sendResponse() depois do trabalho
// terminar, com "return true" no listener — isso evita que o Chrome encerre
// o service worker no meio do processo (comum em Manifest V3 quando a parte
// assíncrona roda "solta", sem o listener sinalizar que ainda tem resposta
// pendente).

let ifpsReviewTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IFPS_OPEN_REVIEW') {
    handleOpenReview(msg, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[iFood PDV Sync/background] falha ao abrir a aba de revisão:', err);
        if (sender.tab && sender.tab.id) {
          chrome.tabs
            .sendMessage(sender.tab.id, {
              type: 'IFPS_BACKGROUND_ERROR',
              message: 'Não consegui abrir a aba de revisão: ' + err.message,
            })
            .catch(() => {});
        }
        sendResponse({ ok: false, error: String(err && err.message) });
      });
    return true; // mantém o canal aberto até handleOpenReview terminar
  }

  if (msg.type === 'IFPS_SAIPOS_GET_CATEGORIES') {
    resolveSaiposTab()
      .then((tabId) => {
        if (!tabId) {
          sendResponse({
            ok: false,
            error: 'não encontrei nenhuma aba aberta do Saipos (conta.saipos.com). Abra o Saipos numa aba do Chrome e tente de novo.',
          });
          return;
        }
        return chrome.tabs
          .sendMessage(tabId, { type: 'IFPS_SAIPOS_GET_CATEGORIES_ON_PAGE' })
          .then((res) => sendResponse(res));
      })
      .catch((err) => {
        console.error('[iFood PDV Sync/background] falha ao buscar categorias do Saipos:', err);
        sendResponse({ ok: false, error: String(err && err.message) });
      });
    return true;
  }

  if (msg.type === 'IFPS_SAIPOS_CREATE_PRODUCT') {
    resolveSaiposTab()
      .then((tabId) => {
        if (!tabId) {
          sendResponse({
            ok: false,
            reason: 'não encontrei nenhuma aba aberta do Saipos (conta.saipos.com). Abra o Saipos numa aba do Chrome e tente de novo.',
          });
          return;
        }
        return chrome.tabs
          .sendMessage(tabId, { type: 'IFPS_SAIPOS_CREATE_PRODUCT_ON_PAGE', payload: msg.payload })
          .then((res) => sendResponse(res));
      })
      .catch((err) => {
        console.error('[iFood PDV Sync/background] falha ao cadastrar produto no Saipos:', err);
        sendResponse({ ok: false, reason: String(err && err.message) });
      });
    return true;
  }

  if (msg.type === 'IFPS_APPLY_ROWS') {
    resolveTargetTab(msg.targetTabId)
      .then((tabId) => {
        if (!tabId) {
          sendResponse({
            ok: false,
            error:
              'não encontrei nenhuma aba aberta do Portal iFood na tela Cardápio > PDV. Abra essa tela (ela pode ter sido fechada, ou trocada por uma aba nova) e clique em "Aplicar selecionados" de novo.',
          });
          return;
        }
        return chrome.tabs
          .sendMessage(tabId, { type: 'IFPS_APPLY_ROWS_ON_PAGE', rows: msg.rows })
          .then(() => sendResponse({ ok: true }));
      })
      .catch((err) => {
        console.error('[iFood PDV Sync/background] falha ao repassar aplicação:', err);
        sendResponse({ ok: false, error: String(err && err.message) });
      });
    return true;
  }

  return false;
});

async function handleOpenReview(msg, sender) {
  const sourceTabId = sender.tab ? sender.tab.id : null;

  await chrome.storage.local.set({
    ifpsMatches: msg.matches,
    ifpsSourceTabId: sourceTabId,
    ifpsSavedAt: Date.now(),
  });

  const existingTab = ifpsReviewTabId !== null ? await getTabSafe(ifpsReviewTabId) : null;

  if (existingTab) {
    await chrome.tabs.update(ifpsReviewTabId, { active: true });
    // review.html é uma página da própria extensão (não um content script),
    // então falamos com ela via runtime, não via tabs.
    chrome.runtime.sendMessage({ type: 'IFPS_RESULTS_UPDATED' }).catch(() => {});
  } else {
    ifpsReviewTabId = null;
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    ifpsReviewTabId = tab.id;
  }
}

// Antes, "aplicar" mandava sempre pra aba de id que foi salva no momento da
// leitura do cardápio (ifpsSourceTabId). Isso quebra fácil: se essa aba foi
// fechada e o Portal iFood foi reaberto numa aba NOVA (id diferente), ou se
// o usuário tinha mais de uma aba do Portal aberta, a extensão tentava falar
// com uma aba que não existe mais (ou que não é a certa) e nada acontecia —
// provavelmente a causa de "parece que não tem acesso ao portal iFood".
// Agora sempre procuramos, na hora de aplicar, qual aba do PDV está
// realmente aberta AGORA, em vez de confiar só no id antigo.
async function resolveTargetTab(cachedTabId) {
  const tabs = await chrome.tabs.query({ url: 'https://portal.ifood.com.br/menu/list/pdv*' });
  if (tabs.length > 0) {
    // Se a aba original ainda estiver entre as abertas, prioriza ela —
    // assim não pula pra outra aba do PDV à toa quando a certa ainda existe.
    const cached = tabs.find((t) => t.id === cachedTabId);
    return (cached || tabs[0]).id;
  }
  // Nenhuma aba com essa URL agora — como último recurso, tenta a antiga,
  // caso ela ainda exista mas com a URL momentaneamente diferente.
  if (cachedTabId) {
    const stale = await getTabSafe(cachedTabId);
    if (stale) return cachedTabId;
  }
  return null;
}

// Mesma lógica do resolveTargetTab acima, mas pro Saipos: sempre busca uma
// aba ABERTA AGORA em conta.saipos.com, em vez de guardar um id de aba fixo
// (não faria sentido aqui — a aba do Saipos nem existe no momento em que a
// planilha é lida no iFood, só quando o usuário abre pra cadastrar).
async function resolveSaiposTab() {
  const tabs = await chrome.tabs.query({ url: 'https://conta.saipos.com/*' });
  return tabs.length > 0 ? tabs[0].id : null;
}

function getTabSafe(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) resolve(null);
      else resolve(tab);
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === ifpsReviewTabId) ifpsReviewTabId = null;
});
