// popup.js — lê a planilha Saipos (.xlsx) e envia os dados para o content script
// rodando na aba do Portal iFood, onde a comparação e o preenchimento acontecem.

const fileInput = document.getElementById('fileInput');
const fileStatus = document.getElementById('fileStatus');
const btnStart = document.getElementById('btnStart');
const runStatus = document.getElementById('runStatus');

let parsedRows = null;

const REQUIRED_COLUMNS = ['Tipo', 'Categoria', 'Descrição', 'Complemento', 'Código Saipos'];

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
    if (!tab || !tab.url || !tab.url.startsWith('https://portal.ifood.com.br/menu/list/pdv')) {
      showStatus(
        runStatus,
        'Abra a aba "Cardápio > PDV" do Portal do Parceiro iFood antes de clicar aqui.',
        'err'
      );
      btnStart.disabled = false;
      return;
    }

    await chrome.storage.local.set({ ifpsSaiposRows: parsedRows, ifpsSavedAt: Date.now() });

    await chrome.tabs.sendMessage(tab.id, { type: 'IFPS_START' });

    showStatus(
      runStatus,
      'Processando na página do PDV (expandindo complementos e comparando com a planilha)... Isso pode levar alguns segundos. Uma aba nova vai abrir sozinha quando terminar — você pode fechar este popup, o processo continua rodando.',
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
