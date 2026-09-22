/* Goomer adapter: reads fresh forms; writes only reviewed remote_code fields. */
(() => {
  'use strict';
  let session = null, busy = false;
  const text = v => String(v == null ? '' : v).trim();
  const parser = new DOMParser();
  const formPath = (kind,id) => '/cardapio/action/form-' + (kind === 'template' ? 'attribute-template' : 'product') + '?id=' + encodeURIComponent(id);
  async function request(path, body) {
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/cardapio/')) throw new Error('Endereço fora do cardápio.');
    const res = await fetch(url, {method:body ? 'POST':'GET', credentials:'same-origin', cache:'no-store',
      signal:AbortSignal.timeout(25000), headers:{'X-Requested-With':'XMLHttpRequest', ...(body ? {'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'} : {})}, body});
    if (!res.ok || (res.url && new URL(res.url).origin !== location.origin)) throw new Error('Falha na Goomer (HTTP ' + res.status + '). Reabra sua sessão.');
    const raw = await res.text();
    if (body) {
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('A Goomer não retornou confirmação de salvamento.'); }
      if (result.success !== true && result.success !== 1) throw new Error('A Goomer recusou o salvamento. Confira os dados no painel.');
      return result;
    }
    return parser.parseFromString(raw,'text/html');
  }
  function fields(root, model, nameField) {
    const records = new Map();
    for (const el of root.querySelectorAll('[name]')) {
      const m = new RegExp('^' + model + '\\[([^\\]]+)\\]\\[([^\\]]+)\\]$').exec(el.name);
      if (!m) continue;
      if (!records.has(m[1])) records.set(m[1],{});
      records.get(m[1])[m[2]] = el;
    }
    return [...records.values()].filter(r => r.id?.value && r.remote_code && r[nameField]).map(r => ({
      id:text(r.id.value), name:text(r[nameField].value), current:text(r.remote_code.value), input:r.remote_code
    }));
  }
  function attributes(doc) {
    return [...doc.querySelectorAll('#div-list-attributes [data-attributes]')].map(el => {
      let data; try { data = JSON.parse(el.dataset.attributes); } catch { throw new Error('Não consegui ler um grupo de opcionais. Leitura interrompida para não omitir itens.'); }
      return data;
    });
  }
  function refs(doc, groups) {
    const ids = new Set(groups.map(g=>text(g.attribute_template_id)).filter(v=>v && v !== '0'));
    doc.querySelectorAll('#btn-edit-attribute-template[data-id], .btn-edit-attribute-template[data-id]').forEach(el=>ids.add(text(el.dataset.id)));
    doc.querySelectorAll('input[name$="[attribute_template_id]"]').forEach(el=>{if(el.value && el.value !== '0') ids.add(text(el.value));});
    return [...ids].filter(id=>/^\d+$/.test(id));
  }
  function controls(root) {
    const data = new URLSearchParams();
    root.querySelectorAll('input[name],select[name],textarea[name]').forEach(el => {
      if (el.disabled || ['button','submit','file','reset'].includes(el.type) || (['checkbox','radio'].includes(el.type) && !el.checked)) return;
      if (el.tagName === 'SELECT' && el.multiple) [...el.selectedOptions].forEach(o=>data.append(el.name,o.value));
      else data.append(el.name,el.value);
    });
    return data;
  }
  async function update(patch) {
    const key = 'goomer:' + session.id;
    const old = (await chrome.storage.local.get(key))[key] || {};
    await chrome.storage.local.set({[key]:{...old,...patch}});
  }
  function addTarget(row) {
    const existing = session.targets.get(row.id);
    if (existing) {
      for (const c of row.contexts) if (!existing.contexts.some(v=>v.id===c.id)) existing.contexts.push(c);
    } else session.targets.set(row.id,row);
  }
  async function scan() {
    const {ifpsSaiposRows} = await chrome.storage.local.get('ifpsSaiposRows');
    if (!Array.isArray(ifpsSaiposRows) || !ifpsSaiposRows.length) throw new Error('Carregue o Excel da Saipos na extensão.');
    session.catalog = GoomerMatching.catalogs(ifpsSaiposRows);
    const queue = ['/cardapio/all/all-categories'], visited = new Set(), products = new Set();
    while (queue.length) {
      const path = queue.shift();
      if (visited.has(path)) continue;
      if (visited.size >= 500) throw new Error('Cardápio excedeu o limite de páginas de segurança. Nenhum resultado parcial será aplicado.');
      visited.add(path);
      await update({status:`Lendo categorias e páginas: ${visited.size}…`});
      const doc = await request(path);
      doc.querySelectorAll('#grid-products [data-productid]').forEach(el=>{if(/^\d+$/.test(el.dataset.productid)) products.add(el.dataset.productid);});
      doc.querySelectorAll('.groups-list a[href], #grid-products .pagination a[href]').forEach(el=>{
        const u = new URL(el.getAttribute('href'),location.origin + path);
        if (u.origin===location.origin && u.pathname.startsWith('/cardapio/') && !u.pathname.includes('/action/') && !visited.has(u.pathname+u.search)) queue.push(u.pathname+u.search);
      });
    }
    if (!products.size) throw new Error('Não encontrei produtos no formato esperado da Goomer. Nada foi alterado.');
    const templates = new Map();
    function enqueue(id, contexts) {
      if (!templates.has(id)) templates.set(id,{contexts:[], processed:new Set(),doc:null});
      const t = templates.get(id);
      contexts.forEach(c=>{if(!t.contexts.some(v=>v.id===c.id)) t.contexts.push(c);});
    }
    let done = 0;
    for (const owner of products) {
      await update({status:`Lendo produtos e opcionais: ${++done}/${products.size}…`});
      const doc = await request(formPath('parent',owner));
      if (!doc.querySelector('#form-item-new')) throw new Error('Formulário do produto não encontrado. A sessão pode ter expirado.');
      const variants = fields(doc,'ProductItem','name');
      if (!variants.length) throw new Error('Produto sem variantes reconhecidas: ' + owner);
      // A Goomer tem dois contextos úteis: a categoria administrativa do
      // painel ("Espetinhos") e o produto pai visual ("FRANGO"/"SUCOS
      // NATURAIS"). Guardamos os dois para exibir e para melhorar o match.
      const adminCategory = text(doc.querySelector('#product-category_id option:checked')?.textContent);
      const productName = text(doc.querySelector('[name="Product[name]"]')?.value);
      const category = productName || adminCategory;
      const contexts = variants.map(v=>({id:owner+':'+v.id,name:v.name,code:v.current,category,category1:adminCategory,category2:productName}));
      for (const v of variants) addTarget({id:'parent:'+owner+':'+v.id,kind:'parent',owner,fieldId:v.id,name:v.name,current:v.current,group:'',contexts:[contexts.find(c=>c.id===owner+':'+v.id)]});
      const groups = attributes(doc);
      for (const g of groups) {
        if (g.attribute_template_id && String(g.attribute_template_id)!=='0') continue;
        for (const opt of Object.values(g.options || {})) {
          if (!opt.id || !('remote_code' in opt)) throw new Error('Opcional avulso sem identificação estável; leitura interrompida.');
          addTarget({id:'inline:'+owner+':'+g.id+':'+opt.id,kind:'inline',owner,attributeId:text(g.id),fieldId:text(opt.id),name:text(opt.label || opt.name),current:text(opt.remote_code),group:text(g.title),contexts});
        }
      }
      refs(doc,groups).forEach(id=>enqueue(id,contexts));
    }
    // Propagate every parent through nested shared templates, including cycles.
    let pending = true;
    while (pending) {
      pending = false;
      for (const [owner,t] of templates) {
        const fresh = t.contexts.filter(c=>!t.processed.has(c.id));
        if (!fresh.length) continue;
        pending = true;
        fresh.forEach(c=>t.processed.add(c.id));
        if (!t.doc) {
          await update({status:`Lendo grupos de complementos: ${templates.size} encontrados…`});
          t.doc = await request(formPath('template',owner));
        }
        if (!t.doc.querySelector('#form-attribute-template')) throw new Error('Modelo de opcionais não encontrado: ' + owner);
        const group = text(t.doc.querySelector('[name="AttributeTemplate[title]"]')?.value);
        for (const v of fields(t.doc,'AttributeOptionTemplate','label')) addTarget({id:'template:'+owner+':'+v.id,kind:'template',owner,fieldId:v.id,name:v.name,current:v.current,group,contexts:[...fresh]});
        refs(t.doc,[]).forEach(id=>enqueue(id,fresh));
      }
    }
    session.rows = [...session.targets.values()].map(r=>GoomerMatching.match(r,session.catalog));
    await update({rows:session.rows,status:`${products.size} itens lidos · ${session.rows.filter(r=>r.kind==='parent').length} produtos pai · ${session.rows.filter(r=>r.kind!=='parent').length} complementos`,busy:false});
  }
  function locate(doc, row) {
    if (row.kind === 'inline') {
      const group = attributes(doc).find(g=>text(g.id)===row.attributeId);
      const opt = Object.values(group?.options || {}).find(o=>text(o.id)===row.fieldId);
      return opt ? {current:text(opt.remote_code)} : null;
    }
    return fields(doc,row.kind==='parent'?'ProductItem':'AttributeOptionTemplate',row.kind==='parent'?'name':'label').find(v=>v.id===row.fieldId);
  }
  function appendObject(body, prefix, value) {
    if (value && typeof value === 'object') {
      for (const [key,child] of Object.entries(value)) appendObject(body,`${prefix}[${key}]`,child);
    } else body.set(prefix,value == null ? '' : typeof value === 'boolean' ? (value?'1':'0') : String(value));
  }
  async function save(changes) {
    const first = changes[0].row;
    const doc = await request(formPath(first.kind,first.owner));
    const form = doc.querySelector(first.kind==='template'?'#form-attribute-template':'#form-item-new');
    if (!form) throw new Error('Formulário não encontrado. Leia o cardápio novamente.');
    const action = new URL(form.getAttribute('action') || '',location.origin);
    const expected = '/cardapio/action/update-' + (first.kind==='template'?'attribute-template':'product');
    if (action.origin!==location.origin || action.pathname!==expected || action.searchParams.get('id')!==first.owner) throw new Error('O formulário de edição mudou. Salvamento bloqueado por segurança.');
    const freshGroups = first.kind === 'template' ? [] : attributes(doc);
    for (const {row,code} of changes) {
      const found = locate(doc,row);
      if (!found) throw new Error('Campo PDV não encontrado: ' + row.name);
      if (!GoomerMatching.equal(found.current,row.current) && !GoomerMatching.equal(found.current,code)) throw new Error('PDV alterado desde a leitura: ' + row.name + '. Leia novamente.');
      if (row.kind==='inline') {
        const group = freshGroups.find(g=>text(g.id)===row.attributeId);
        const option = Object.values(group?.options || {}).find(o=>text(o.id)===row.fieldId);
        if (!option) throw new Error('Opcional não encontrado no formulário atualizado.');
        option.remote_code = code;
      } else {
        if (found.input.disabled || found.input.readOnly) throw new Error('PDV bloqueado pela Goomer: ' + row.name);
        found.input.value = code;
      }
    }
    const body = controls(form);
    if (first.kind !== 'template') {
      const variants = doc.querySelector('#div-item-model-new');
      if (variants && !form.contains(variants)) for (const [key,value] of controls(variants)) body.append(key,value);
      // Same ProductAttribute hierarchy used by the site's product form.
      for (const group of freshGroups) {
        const index = group.index ?? group.id;
        if (index == null) throw new Error('Grupo de opcionais sem índice. Salvamento bloqueado.');
        appendObject(body,`ProductAttribute[${index}]`,group);
      }
    }
    const csrfName = doc.querySelector('meta[name="csrf-param"]')?.content || document.querySelector('meta[name="csrf-param"]')?.content;
    const csrf = doc.querySelector('meta[name="csrf-token"]')?.content || document.querySelector('meta[name="csrf-token"]')?.content;
    if (csrfName && csrf && !body.has(csrfName)) body.set(csrfName,csrf);
    await request(action.href,body);
    const persisted = await request(formPath(first.kind,first.owner));
    for (const {row,code} of changes) if (!GoomerMatching.equal(locate(persisted,row)?.current,code)) throw new Error('A Goomer respondeu, mas a releitura não confirmou o PDV. Confira o painel antes de tentar novamente.');
  }
  async function apply(msg) {
    if (!session || msg.id!==session.id) throw new Error('Revisão expirada. Leia o cardápio novamente.');
    if (!Array.isArray(msg.changes) || !msg.changes.length) throw new Error('Nenhum item selecionado.');
    const groups = new Map(), seen = new Set();
    for (const change of msg.changes) {
      const row = session.rows.find(r=>r.id===change.id);
      if (!row || seen.has(row.id) || !row.choices.some(c=>c.code===change.code)) throw new Error('Seleção inválida ou código fora da planilha.');
      seen.add(row.id);
      const key = (row.kind==='template'?'template':'product')+':'+row.owner;
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push({row,code:change.code});
    }
    const results = [];
    for (const changes of groups.values()) {
      await update({status:`Aplicando ${results.length}/${msg.changes.length}…`,busy:true});
      try {
        await save(changes);
        for (const {row,code} of changes) {
          row.current=code; row.code=code; row.confidence='correto';
          row.suggested=row.choices.find(c=>c.code===code).name;
          results.push({id:row.id,ok:true});
        }
      } catch (e) { changes.forEach(({row})=>results.push({id:row.id,ok:false,error:e.message})); }
      await update({results,rows:session.rows});
    }
    await update({busy:false,status:`Concluído: ${results.filter(r=>r.ok).length}/${results.length} PDVs salvos e confirmados por releitura.`,results,rows:session.rows});
    return {ok:true,results};
  }
  chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
    if (!['GOOMER_START','GOOMER_APPLY_FRAME'].includes(msg.type)) return false;
    if (busy) {respond({error:'Já existe uma leitura ou aplicação em andamento.'}); return false;}
    busy=true;
    if (msg.type==='GOOMER_START') {
      session={id:crypto.randomUUID(),targets:new Map(),rows:[]};
      (async()=>{
        const opened=await chrome.runtime.sendMessage({type:'GOOMER_OPEN',id:session.id});
        if (!opened?.ok) throw new Error(opened?.error || 'Falha ao abrir a revisão.');
        respond({ok:true});
        await scan();
      })().catch(async e=>{respond({error:e.message}); await update({status:e.message,busy:false,error:e.message});}).finally(()=>{busy=false;});
    } else apply(msg).then(respond,async e=>{await update({busy:false,status:e.message});respond({error:e.message});}).finally(()=>{busy=false;});
    return true;
  });
})();
