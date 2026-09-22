'use strict';
const reviewId = new URLSearchParams(location.search).get('id');
const storageKey = 'goomer:' + reviewId;
let data=null, tab='parent', sending=false, initialized=false;
const selected=new Set(), choices=new Map();
const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const active=r=>tab==='parent'?r.kind==='parent':r.kind!=='parent';
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();
const code=r=>choices.has(r.id)?choices.get(r.id):r.code;
const applicableAny=r=>code(r)&&!same(code(r),r.current)&&r.confidence!=='correto';
const pending=()=>data.rows.filter(r=>active(r)&&selected.has(r.id)&&applicableAny(r));
function refreshButton(){
  $('rv-btn-apply').disabled=sending||data?.busy||!pending().length;
  $('rv-btn-apply').textContent=sending?'Aplicando…':`Aplicar selecionados (${pending().length})`;
  updateMasterChecks();
}
function updateMasterChecks(){
  document.querySelectorAll('[data-check-all]').forEach(master=>{
    const table=master.closest('table');
    const boxes=table?[...table.querySelectorAll('[data-check]:not(:disabled)')]:[];
    const checked=boxes.filter(box=>box.checked).length;
    const all=boxes.length>0&&checked===boxes.length;
    master.disabled=sending||data?.busy||!boxes.length;
    master.checked=all;
    master.indeterminate=checked>0&&!all;
    master.title=all?'Desmarcar esta seção':'Selecionar toda esta seção';
  });
}
function rowHtml(r,index){
  const choice=r.choices.find(c=>c.code===code(r));
  const result=data.results?.find(v=>v.id===r.id);
  const correct=r.confidence==='correto';
  const canApply=applicableAny(r);
  const category1=[...new Set(r.contexts.map(c=>c.category1||'').filter(Boolean))].join(' / ');
  const category2=[...new Set(r.contexts.map(c=>c.category2||c.category||'').filter(Boolean))].join(' / ');
  return `<tr><td><input type="checkbox" class="rv-check" aria-label="Selecionar ${escape(r.name)}" data-check="${index}" ${selected.has(r.id)&&canApply?'checked':''} ${canApply?'':'disabled'} title="${canApply?'Selecionar para aplicar':'Escolha um código diferente do atual para aplicar'}"></td>
  <td class="rv-categoria">${category1?escape(category1):'<span class="rv-parent-code">—</span>'}</td>
  <td class="rv-categoria">${category2?escape(category2):'<span class="rv-parent-code">—</span>'}</td>
  <td class="rv-item-name">${escape(r.kind==='parent'?r.name:r.contexts.map(c=>c.name).join(' / '))}${r.kind!=='parent'?`<div class="rv-parent-code">${escape(r.contexts.map(c=>c.code||'(pai vazio)').join(' / '))}</div>`:''}</td>
  ${r.kind!=='parent'?`<td>${escape(r.name)}<div class="rv-parent-code">Grupo Goomer: ${escape(r.group||'sem nome')}</div></td>`:''}
  <td>${r.current?escape(r.current):'<span class="rv-parent-code">(vazio)</span>'}</td>
  <td class="rv-categoria" data-excel-category="${index}">${choice?.category?escape(choice.category):'<span class="rv-parent-code">—</span>'}</td>
  <td><div data-chosen="${index}">${escape(choice?.name||'nenhum prato parecido encontrado na planilha')}</div><div class="rv-parent-code" data-code="${index}">${escape(code(r))}</div>
  ${!correct?`<input type="search" class="rv-alt-search" data-search="${index}" list="options-${index}" aria-label="Pesquisar ${r.kind==='parent'?'prato':'complemento'} ou código Saipos" placeholder="Pesquisar ${r.kind==='parent'?'prato':'complemento'} ou código Saipos..." autocomplete="off"><datalist id="options-${index}">${r.choices.map(c=>`<option value="${escape(c.name+' — '+c.code)}"></option>`).join('')}</datalist>`:'<div class="rv-parent-code">✔ Este já é o código atual</div>'}
  <div class="goomer-note">${escape(r.note)}</div></td><td>${correct?'correto':r.score.toFixed(2)}<div class="rv-status ${result?.ok?'rv-ok':'rv-fail'}">${escape(result?.ok?'Salvo e confirmado.':result?.error||'')}</div></td></tr>`;
}
function render(){
  if(!data)return;
  $('rv-meta').textContent=data.status;
  $('rv-meta').textContent=[data.status,data.origin].filter(Boolean).join(' · ');
  const count=level=>data.rows.filter(r=>r.confidence===level).length;
  $('rv-summary-bar').innerHTML=`<div class="rv-stat"><strong>${count('correto')}</strong> já corretos</div><div class="rv-stat"><strong>${count('alta')}</strong> prontos para aplicar</div><div class="rv-stat"><strong>${count('media')+count('baixa')}</strong> para você analisar</div>`;
  document.querySelectorAll('[data-tab]').forEach(button=>{
    const parent=button.dataset.tab==='parent';
    const total=data.rows.filter(r=>(r.kind==='parent')===parent&&r.confidence!=='correto').length;
    button.innerHTML=`${parent?'Produtos pai':'Complementos'} <span class="rv-tab-count">${total}</span>`;
  });
  if(!data.rows.length){$('rv-main').textContent=data.error||data.status;refreshButton();return;}
  const sections=[['correto','Já corretos — nenhuma alteração necessária'],['alta','Prontos para aplicar — alta confiança'],['media','Para revisar — confiança média'],['baixa','Score baixo / sem correspondência']];
  $('rv-main').innerHTML=sections.map(([level,title])=>{
    const rows=data.rows.map((r,i)=>({r,i})).filter(({r})=>active(r)&&r.confidence===level);
    return `<details class="rv-section rv-sec-${level}" ${level==='alta'?'open':''}><summary>${title}<span class="rv-count-badge">${rows.length}</span></summary><div class="rv-section-body"><p class="rv-section-hint">${level==='alta'?'Já vêm marcados. Confira e desmarque o que não quiser aplicar.':level==='correto'?'O código atual corresponde ao produto encontrado.':'Marque os itens desejados e confira a sugestão ou busque outro código pelo nome.'}</p>${rows.length?`<div class="goomer-scroll"><table class="rv-table"><thead><tr><th><input type="checkbox" class="rv-check-all" data-check-all title="Selecionar toda esta seção" aria-label="Selecionar toda esta seção"></th><th>Categoria 1 (Goomer)</th><th>Categoria 2 (Goomer)</th><th>Item (Goomer)</th>${tab!=='parent'?'<th>Complemento (Goomer)</th>':''}<th>${tab==='parent'?'Código pai atual':'Código atual'}</th><th>Categoria (Excel)</th><th>${tab==='parent'?'Prato':'Complemento'} Saipos (nome sugerido / código)</th><th>Score / resultado</th></tr></thead><tbody>${rows.map(({r,i})=>rowHtml(r,i)).join('')}</tbody></table></div>`:'<p class="rv-section-hint">Nenhum item nesta seção.</p>'}</div></details>`;
  }).join('');
  refreshButton();
}
async function load(){
  data=(await chrome.storage.local.get(storageKey))[storageKey];
  if(!data){$('rv-main').textContent='Revisão não encontrada. Volte ao cardápio e faça uma nova leitura.';return;}
  if(!initialized&&data.rows.length){data.rows.filter(r=>r.confidence==='alta'&&!r.shared).forEach(r=>selected.add(r.id));initialized=true;}
  data.results?.filter(r=>r.ok).forEach(r=>{selected.delete(r.id);choices.delete(r.id);});
  [...selected].forEach(id=>{const r=data.rows.find(row=>row.id===id);if(!r||!applicableAny(r))selected.delete(id);});
  render();
}
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[storageKey])load();});
$('rv-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b||sending)return;tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('is-active',n===b));render();});
$('rv-main').addEventListener('change',e=>{
  if(e.target.dataset.checkAll!=null){
    const table=e.target.closest('table');
    if(!table)return;
    table.querySelectorAll('[data-check]:not(:disabled)').forEach(box=>{
      const r=data.rows[Number(box.dataset.check)];
      box.checked=e.target.checked;
      box.checked?selected.add(r.id):selected.delete(r.id);
    });
    refreshButton();
    return;
  }
  if(e.target.dataset.check==null)return;
  const r=data.rows[Number(e.target.dataset.check)];
  e.target.checked?selected.add(r.id):selected.delete(r.id);
  refreshButton();
});
$('rv-main').addEventListener('input',e=>{
  if(e.target.dataset.search==null||sending)return;
  const i=Number(e.target.dataset.search),r=data.rows[i],value=e.target.value.trim();
  const found=r.choices.find(c=>same(c.code,value)||same(c.name+' — '+c.code,value));
  choices.set(r.id,found?.code||'');
  document.querySelector(`[data-chosen="${i}"]`).textContent=found?.name||'Selecione um resultado da lista ou cole um código válido do Excel.';
  document.querySelector(`[data-code="${i}"]`).textContent=found?.code||'';
  document.querySelector(`[data-excel-category="${i}"]`).innerHTML=found?.category?escape(found.category):'<span class="rv-parent-code">—</span>';
  const box=document.querySelector(`[data-check="${i}"]`);
  const canApply=found?.code&&!same(found.code,r.current);
  if(box){box.disabled=!canApply;box.checked=!!canApply;if(canApply)selected.add(r.id);else selected.delete(r.id);}
  refreshButton();
});
$('rv-btn-apply').addEventListener('click',async()=>{
  const rows=pending();if(!rows.length||sending)return;
  const shared=rows.filter(r=>r.shared).length;
  if(!confirm(`Aplicar ${rows.length} PDVs na loja ${data.origin}?${shared?' Há '+shared+' complementos compartilhados; outros produtos que usam esses modelos também serão afetados.':''}`))return;
  sending=true;refreshButton();
  try {
    const res=await chrome.runtime.sendMessage({type:'GOOMER_APPLY',id:reviewId,changes:rows.map(r=>({id:r.id,code:code(r)}))});
    if(!res?.ok)throw new Error(res?.error||'Sem resposta. Confira o cardápio antes de repetir.');
    $('rv-meta').textContent='Aplicação iniciada na aba da Goomer. Aguarde a confirmação por releitura.';
    await load();
  }catch(e){$('rv-meta').textContent=e.message;}
  finally{sending=false;refreshButton();}
});
$('rv-btn-export').addEventListener('click',()=>{
  if(!data)return;
  const cell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const rows=[['Tipo','Categoria 1 Goomer','Categoria 2 Goomer','Produto Goomer','Grupo','PDV atual','Categoria Excel','Saipos sugerido','PDV sugerido','Confiança'],...data.rows.map(r=>{const choice=r.choices.find(c=>c.code===code(r));const category1=[...new Set(r.contexts.map(c=>c.category1||'').filter(Boolean))].join(' / ');const category2=[...new Set(r.contexts.map(c=>c.category2||c.category||'').filter(Boolean))].join(' / ');return [r.kind,category1,category2,r.name,r.group,r.current,choice?.category||'',choice?.name||r.suggested,code(r),r.confidence];})];
  const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='revisao-goomer.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
load();
