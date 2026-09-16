// saipos.js — content script separado, roda só em conta.saipos.com. Cuida
// do cadastro de "produtos pai" que faltam no Saipos (itens que já existem
// no cardápio do iFood mas não têm nenhum prato correspondente na planilha
// Saipos) — a pedido explícito do usuário, seguindo o passo a passo que ele
// mesmo descreveu:
//   Cardápio > categoria > "Cadastrar outros produtos" >
//   nome (maiúsculo) > preço zero > só Delivery marcado > Salvar.
//
// Diferente do content.js (que só sugere e corrige um campo de integração
// do iFood), aqui a extensão está criando produto DE VERDADE no cardápio
// real do Saipos — por isso o fluxo roda item por item, sempre com
// confirmação explícita antes de cada cadastro (ver review.js), nunca em
// lote silencioso.

const IFPS_SAIPOS_CATEGORIES_HASH = '#/app/v2/cardapio/categories/0';

function ifpsSaiposCreateUrlHash(idCategoria) {
  return `#/app/v2/cardapio/products/create/other?idStoreCategoryItem=${encodeURIComponent(idCategoria)}`;
}

function ifpsSaiposSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ifpsSaiposGoToHash(hash) {
  location.hash = hash;
}

async function ifpsSaiposWaitFor(checkFn, { timeout = 8000, interval = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = checkFn();
    if (val) return val;
    await ifpsSaiposSleep(interval);
  }
  return null;
}

// ---------- Etapa 1: mapear categorias (nome -> id) ----------
//
// O Saipos não expõe o id da categoria em nenhum atributo do DOM (conferido
// ao vivo) — só descobrimos o id olhando pra URL depois de clicar na
// categoria (ela vira "#/app/v2/cardapio/categories/<id>"). A lista de
// categorias (barra à esquerda) continua no DOM mesmo depois de entrar numa
// categoria específica, então dá pra clicar em cada uma em sequência sem
// precisar voltar pra tela de listagem entre uma e outra.
async function ifpsSaiposGetCategoryMap() {
  ifpsSaiposGoToHash(IFPS_SAIPOS_CATEGORIES_HASH);
  const ready = await ifpsSaiposWaitFor(() => document.querySelectorAll('a.categories-list-item-link').length > 0, {
    timeout: 8000,
  });
  if (!ready) return [];
  await ifpsSaiposSleep(400);

  const names = [...document.querySelectorAll('a.categories-list-item-link')]
    .map((a) => a.innerText.trim().split('\n')[0])
    .filter((n) => n && n !== 'Todos os produtos');

  const map = [];
  for (const name of names) {
    // Rebusca o link a cada volta — a lista é recriada pelo Angular a cada
    // navegação, então um elemento guardado de uma volta anterior pode
    // estar "solto" (desconectado do DOM) e não reagir a clique.
    const link = [...document.querySelectorAll('a.categories-list-item-link')].find(
      (a) => a.innerText.trim().split('\n')[0] === name
    );
    if (!link) continue;
    link.click();
    await ifpsSaiposSleep(650);
    const m = /categories\/(\d+)/.exec(location.hash);
    if (m) map.push({ nome: name, id: m[1] });
  }

  // Deixa a aba na lista de categorias no final — uma tela neutra, sem
  // formulário nenhum aberto.
  ifpsSaiposGoToHash(IFPS_SAIPOS_CATEGORIES_HASH);

  return map;
}

// ---------- Etapa 2: cadastrar um produto faltante ----------

function ifpsSaiposFindVisibleCurrencyInput() {
  return [...document.querySelectorAll('input[currencymask]')].find((el) => el.offsetParent);
}

function ifpsSaiposSetNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// O campo de preço usa uma diretiva de máscara de moeda que só reage a
// eventos de teclado de verdade — setar o .value direto e disparar só
// "input"/"change" muda o texto na tela, mas o formulário Angular continua
// "pristine" (confirmado ao vivo: a classe ng-pristine não sai do campo, ou
// seja, o Angular não registrou nada). Precisa simular o teclado, do mesmo
// jeito que foi preciso pro campo do iFood.
async function ifpsSaiposFillZeroPrice(el) {
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '0', code: 'Digit0', keyCode: 48, which: 48 }));
  el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: '0', code: 'Digit0', keyCode: 48, which: 48 }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: '0', code: 'Digit0', keyCode: 48, which: 48 }));
  await ifpsSaiposSleep(150);
  el.blur();
}

// Garante que só "Delivery" fica marcado entre as opções de disponibilidade.
// Por padrão um produto novo já nasce só com Delivery marcado (conferido ao
// vivo no formulário real), mas checamos e corrigimos mesmo assim em vez de
// confiar cego nesse padrão, que pode mudar sem aviso nenhum de uma
// atualização do Saipos pra outra.
function ifpsSaiposEnsureOnlyDelivery() {
  const changed = [];
  const deliveryEl = document.getElementById('product-available-delivery');
  if (deliveryEl && !deliveryEl.checked) {
    deliveryEl.click();
    changed.push('delivery:ligado');
  }
  const others = [
    'product-available-table-order',
    'product-available-site-delivery',
    'product-available-digital-menu',
    'product-available-totem',
  ];
  for (const id of others) {
    const el = document.getElementById(id);
    if (el && el.checked) {
      el.click();
      changed.push(id + ':desligado');
    }
  }
  return changed;
}

async function ifpsSaiposCreateProduct({ nome, idCategoria }) {
  if (!nome || !idCategoria) {
    return { ok: false, reason: 'nome ou categoria faltando' };
  }

  ifpsSaiposGoToHash(ifpsSaiposCreateUrlHash(idCategoria));

  const nameEl = await ifpsSaiposWaitFor(() => document.getElementById('product-name'), { timeout: 8000 });
  if (!nameEl) {
    return { ok: false, reason: 'não consegui abrir o formulário de cadastro (a categoria ainda existe no Saipos?)' };
  }
  await ifpsSaiposSleep(500);

  // Confirma que a categoria pré-selecionada pela URL é mesmo a que
  // pedimos — se o id não existir mais (categoria excluída depois do
  // mapeamento, por exemplo), o campo fica vazio ou mostra outra coisa.
  const catLabelEl = document.querySelector('.ng-value-label');
  const catLabel = catLabelEl ? catLabelEl.innerText.trim() : '';

  ifpsSaiposSetNativeValue(nameEl, String(nome).toUpperCase());

  const priceEl = ifpsSaiposFindVisibleCurrencyInput();
  if (priceEl) {
    await ifpsSaiposFillZeroPrice(priceEl);
  }

  ifpsSaiposEnsureOnlyDelivery();
  await ifpsSaiposSleep(250);

  const saveBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Salvar');
  if (!saveBtn) {
    return { ok: false, reason: 'não achei o botão "Salvar" na tela' };
  }

  const urlBeforeSave = location.hash;
  saveBtn.click();

  // Depois de salvar com sucesso o Saipos tira a gente da tela de cadastro
  // (volta pra lista de produtos da categoria) — usamos isso como sinal de
  // sucesso, já que não temos acesso à resposta da chamada de rede feita
  // pelo próprio Saipos. Se a URL não mudar em alguns segundos, tratamos
  // como falha (pode ser campo obrigatório faltando, nome duplicado, etc. —
  // nesses casos o Saipos normalmente destaca o campo com problema na tela).
  const navigated = await ifpsSaiposWaitFor(() => location.hash !== urlBeforeSave, { timeout: 6000, interval: 200 });

  if (navigated) {
    return { ok: true, categoriaConfirmada: catLabel };
  }

  const invalidField = document.querySelector('.is-invalid, .ng-invalid.ng-touched');
  return {
    ok: false,
    reason: invalidField
      ? 'o Saipos recusou algum campo — confira essa aba manualmente'
      : 'não consegui confirmar se salvou (a tela não mudou depois de clicar em Salvar) — confira essa aba manualmente',
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IFPS_SAIPOS_GET_CATEGORIES_ON_PAGE') {
    ifpsSaiposGetCategoryMap()
      .then((categorias) => sendResponse({ ok: true, categorias }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true;
  }

  if (msg.type === 'IFPS_SAIPOS_CREATE_PRODUCT_ON_PAGE') {
    ifpsSaiposCreateProduct(msg.payload)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, reason: 'erro inesperado: ' + String(err && err.message) }));
    return true;
  }

  return false;
});
