// popup.js — lê a planilha Saipos (.xlsx) e envia os dados para o content script
// rodando na aba do Portal iFood, onde a comparação e o preenchimento acontecem.

const fileInput = document.getElementById('fileInput');
const fileStatus = document.getElementById('fileStatus');
const btnStart = document.getElementById('btnStart');
const runStatus = document.getElementById('runStatus');
const platformText = document.getElementById('platformText');
const step2Label = document.getElementById('step2Label');
const startHint = document.getElementById('startHint');

let parsedRows = null;

const REQUIRED_COLUMNS = ['Tipo', 'Categoria', 'Descrição', 'Complemento', 'Código Saipos'];

function platformFromUrl(url) {
  if (String(url || '').startsWith('https://portal.ifood.com.br/menu/list/pdv')) return 'ifood';
  if (/^https:\/\/merchant\.99app\.com\/pt-BR\/manager\/micro-merchandish\/merchant-item\/menu(?:\?|$)/.test(String(url || ''))) return '99food';
  return '';
}

async function refreshPlatformCopy() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const platform = platformFromUrl(tab && tab.url);
  if (platform === '99food') {
    platformText.textContent = 'Casa os produtos da planilha Saipos com o cardápio online do 99Food e preenche o Código PDV após sua revisão.';
    step2Label.textContent = '2. Confirme que está no Cardápio online do 99Food';
    startHint.textContent = 'Nesta etapa a extensão apenas lê categorias e produtos. Os códigos só serão enviados depois da sua confirmação na tela de revisão.';
  } else if (platform === 'ifood') {
    platformText.textContent = 'Casa os códigos da planilha Saipos com o cardápio PDV do iFood e revisa antes de aplicar.';
    step2Label.textContent = '2. Confirme que já preencheu os códigos PAI de todos os itens no portal iFood';
  }
}

refreshPlatformCopy();

function showStatus(el, msg, kind) {
  el.style.display = 'block';
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

fileInput.addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      showStatus(fileStatus, 'A planilha está vazia.', 'err');
      btnStart.disabled = true;
      return;
    }

    const cols = Object.keys(rows[0]);
    const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
    if (missing.length) {
      showStatus(
        fileStatus,
        'Faltam colunas esperadas: ' + missing.join(', ') + '. Confirme que exportou a planilha no mesmo formato do exemplo.',
        'err'
      );
      btnStart.disabled = true;
      return;
    }

    parsedRows = rows;
    const pratos = rows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'PRATO').length;
    const complementos = rows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'COMPLEMENTO').length;
    showStatus(
      fileStatus,
      `Planilha carregada: ${rows.length} linhas (${pratos} pratos, ${complementos} complementos).`,
      'ok'
    );
    btnStart.disabled = false;
  } catch (err) {
    console.error(err);
    showStatus(fileStatus, 'Não consegui ler esse arquivo. Confirme que é um .xlsx válido.', 'err');
    btnStart.disabled = true;
  }
});

btnStart.addEventListener('click', async () => {
  if (!parsedRows) return;
  btnStart.disabled = true;
  showStatus(runStatus, 'Enviando dados para a página do PDV...', '');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const platform = platformFromUrl(tab && tab.url);
    if (!tab || !platform) {
      showStatus(
        runStatus,
        'Abra o Cardápio > PDV do iFood ou o Cardápio online do 99Food antes de clicar aqui.',
        'err'
      );
      btnStart.disabled = false;
      return;
    }

    await chrome.storage.local.set({ ifpsSaiposRows: parsedRows, ifpsSavedAt: Date.now() });

    await chrome.tabs.sendMessage(tab.id, { type: 'IFPS_START' });

    showStatus(
      runStatus,
      platform === '99food'
        ? 'Lendo as categorias e os produtos do 99Food... Uma aba de revisão vai abrir sozinha quando terminar.'
        : 'Processando na página do PDV (expandindo complementos e comparando com a planilha)... Isso pode levar alguns segundos. Uma aba nova vai abrir sozinha quando terminar — você pode fechar este popup, o processo continua rodando.',
      'ok'
    );
  } catch (err) {
    console.error(err);
    showStatus(
      runStatus,
      'Não consegui falar com a página do PDV. Recarregue a aba do portal iFood e tente de novo.',
      'err'
    );
  } finally {
    btnStart.disabled = false;
  }
});
