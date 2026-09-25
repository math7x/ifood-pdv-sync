const {chromium}=require('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage();
 let parent='',option='',posts=[],persist=true,ok=true;
 const input=(n,v)=>`<input name="${n}" value="${v}">`;
 const group={index:3,id:3,title:'Adicionais',attribute_template_id:7,options:[],max_choices:5};
 const product=()=>`<form id="form-item-new" action="/cardapio/action/update-product?id=1"><select id="product-category_id" name="Product[category_id]"><option selected value="5">Porções</option></select>${input('Product[name]','Batatas')}<div id="div-item-model-new">${[1,2].map(i=>input(`ProductItem[${i}][id]`,i)+input(`ProductItem[${i}][name]`,i===1?'Batata palito':'Batata grande')+input(`ProductItem[${i}][remote_code]`,i===1?parent:'101')+input(`ProductItem[${i}][priceInput]`,'21,90')).join('')}</div></form><div id="div-list-attributes"><div data-attributes='${JSON.stringify(group)}'></div></div>`;
 const template=()=>`<form id="form-attribute-template" action="/cardapio/action/update-attribute-template?id=7">${input('AttributeTemplate[title]','Adicionais')}${input('AttributeTemplate[max_choices]','5')}${input('AttributeOptionTemplate[0][id]','9')}${input('AttributeOptionTemplate[0][label]','Bacon')}${input('AttributeOptionTemplate[0][remote_code]',option)}${input('AttributeOptionTemplate[0][valueInput]','4,90')}</form>`;
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());let body='';
  if(req.method()==='POST'){
   const p=new URLSearchParams(req.postData());posts.push({path:url.pathname,data:Object.fromEntries(p)});
   if(persist&&ok){if(url.pathname.endsWith('update-product'))parent=p.get('ProductItem[1][remote_code]');else option=p.get('AttributeOptionTemplate[0][remote_code]');}
   return route.fulfill({contentType:'application/json',body:JSON.stringify({success:ok})});
  }
  if(url.pathname.includes('form-product'))body=product();
  else if(url.pathname.includes('form-attribute-template'))body=template();
  else body='<div id="grid-products"><div data-productid="1"></div></div>';
  await route.fulfill({contentType:'text/html',body});
 });
 await page.goto('https://test.dashboard-abrahao.goomer.app/cardapio/all');
 await page.evaluate(()=>{
  window.store={ifpsSaiposRows:[
   {Tipo:'PRATO','Código Saipos':'100','Descrição':'Batata palito'},
   {Tipo:'PRATO','Código Saipos':'101','Descrição':'Batata grande'},
   {Tipo:'COMPLEMENTO','Código Saipos':'101.200',Complemento:'ADICIONAIS - BACON'},
   ...Array.from({length:105},(_,i)=>({Tipo:'PRATO','Código Saipos':String(1000+i),'Descrição':'Outro '+i}))
  ]};window.listeners=[];
  window.chrome={storage:{local:{get:async k=>typeof k==='string'?{[k]:store[k]}:store,set:async p=>Object.assign(store,p)}},runtime:{onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async msg=>{if(msg.type==='GOOMER_OPEN'){window.scanId=msg.id;store['goomer:'+msg.id]={id:msg.id,origin:location.origin,rows:[],busy:true};return {ok:true};}}}};
  window.send=msg=>new Promise(resolve=>listeners[0](msg,{},resolve));
 });
 for(const name of ['matching.js','goomer-matching.js','goomer.js'])await page.addScriptTag({content:fs.readFileSync(name,'utf8')});
 const sharedCategoryScore=await page.evaluate(()=>({
  plain: ifpsScoreProduto('Menta','SODA ITALIANA DE MENTA'),
  withCategory: ifpsScoreProdutoComCategoria('Menta','SODA ITALIANA DE MENTA','SODA ITALIANA','BEBIDAS NÃO ALCOÓLICAS')
 }));
 assert(sharedCategoryScore.withCategory >= 0.72);
 assert(sharedCategoryScore.withCategory > sharedCategoryScore.plain);
 await page.evaluate(()=>send({type:'GOOMER_START'}));
 await page.waitForFunction(()=>store['goomer:'+scanId]?.busy===false);
 let report=await page.evaluate(()=>store['goomer:'+scanId]);
 assert.equal(report.error,undefined);assert.equal(posts.length,0);assert.equal(report.rows.length,3);
 let p=report.rows.find(r=>r.name==='Batata palito'),c=report.rows.find(r=>r.name==='Bacon');
 assert.equal(p.code,'100');assert.equal(p.confidence,'alta');assert.equal(p.choices.length,107);
 assert.equal(p.contexts[0].category1,'Porções');
 assert.equal(p.contexts[0].category2,'Batatas');
 assert.equal(p.contexts[0].category,'Batatas');
 assert.equal(c.shared,true);assert.equal(c.confidence,'media');assert.equal(c.contexts.length,2);
 assert.equal(report.rows.find(r=>r.name==='Batata grande').confidence,'correto');
 const skewer=await page.evaluate(()=>GoomerMatching.match(
  {id:'parent:2:1',kind:'parent',name:'Frango',current:'33810468',contexts:[{id:'2:1',name:'Frango',code:'33810468',category1:'Espetinhos',category2:'FRANGO',category:'FRANGO'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'Lanches Especiais','Código Saipos':'34077863','Descrição':'FRANGO EGG'},
   {Tipo:'PRATO',Categoria:'Espetinhos','Código Saipos':'33810468','Descrição':'ESPETINHO FRANGO'}
  ])
 ));
 assert.equal(skewer.code,'33810468');
 assert.equal(skewer.confidence,'correto');
 const additional=await page.evaluate(()=>GoomerMatching.match(
  {id:'parent:3:1',kind:'parent',name:'Adc Bacon',current:'33975465',contexts:[{id:'3:1',name:'Adc Bacon',code:'33975465',category1:'Lanches',category2:'ADICIONAIS PARA LANCHES',category:'ADICIONAIS PARA LANCHES'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'LANCHES','Código Saipos':'33840428','Descrição':'LAMBRETA (CHURRASCO NO PÃO)'},
   {Tipo:'PRATO',Categoria:'ADICIONAIS','Código Saipos':'33975465','Descrição':'ADC BACON'}
  ])
 ));
 assert.equal(additional.code,'33975465');
 assert.equal(additional.confidence,'correto');
 const h2o=await page.evaluate(()=>GoomerMatching.match(
  {id:'parent:4:1',kind:'parent',name:'Agua Sabor H2oh zero Limoneto Noite',current:'34069751',contexts:[{id:'4:1',name:'Agua Sabor H2oh zero Limoneto Noite',code:'34069751',category1:'Bebidas não alcoólicas',category2:'ÁGUA SABORIZADA H2OH',category:'ÁGUA SABORIZADA H2OH'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33842221','Descrição':'ÁGUA SEM GÁS'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'34069751','Descrição':'ÁGUA SABORIZADA H2O ZERO LIMÃO'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33844179','Descrição':'ÁGUA SABORIZADA H2O LIMÃO'}
  ])
 ));
 assert.equal(h2o.code,'34069751');
 assert.equal(h2o.confidence,'correto');
 const juice=await page.evaluate(()=>GoomerMatching.match(
  {id:'parent:6:1',kind:'parent',name:'Abacaxi - 300ml',current:'33843858',contexts:[{id:'6:1',name:'Abacaxi - 300ml',code:'33843858',category1:'Bebidas não alcoólicas',category2:'SUCOS NATURAIS',category:'SUCOS NATURAIS'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33843858','Descrição':'SUCO NATURAL ABACAXI 300ML'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33842221','Descrição':'ÁGUA SEM GÁS'}
  ])
 ));
 assert.equal(juice.code,'33843858');
 assert.equal(juice.confidence,'correto');
 const soda=await page.evaluate(()=>['Menta','Pessego','Morango'].map((name,idx)=>GoomerMatching.match(
  {id:'parent:soda:'+idx,kind:'parent',name,current:['37932116','37932119','37932113'][idx],contexts:[{id:'soda:'+idx,name,code:['37932116','37932119','37932113'][idx],category1:'Bebidas não alcoólicas',category2:'SODA ITALIANA',category:'SODA ITALIANA'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'37932116','Descrição':'SODA ITALIANA DE MENTA'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'37932119','Descrição':'SODA ITALIANA DE PÊSSEGO'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'37932113','Descrição':'SODA ITALIANA DE MORANGO'},
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33842221','Descrição':'ÁGUA SEM GÁS'}
  ])
 )));
 assert.deepEqual(soda.map(r=>r.code),['37932116','37932119','37932113']);
 assert(soda.every(r=>r.confidence==='correto'));
 const pizzaFlavor=await page.evaluate(()=>GoomerMatching.match(
  {id:'template:8:1',kind:'template',name:'Confete (mozzarella, chocolate preto e confete.)',current:'x.23327486',group:'Escolha o sabor da sua pizza pequena',contexts:[{id:'8:1',name:'Pizza 25 Cm',code:'34166642',category1:'Pizzas',category2:'Pizza Pequena',category:'Pizza Pequena'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'IFOOD - PIZZAS','Código Saipos':'34166642','Descrição':'IFOOD - PIZZA PEQUENA'},
   {Tipo:'COMPLEMENTO',Categoria:'IFOOD - PIZZAS','Código Saipos':'34166642.23327484',Complemento:'IFOOD - SABORES PIZZAS - CHOCOLATE BRANCO'},
   {Tipo:'COMPLEMENTO',Categoria:'IFOOD - PIZZAS','Código Saipos':'34166642.23327485',Complemento:'IFOOD - SABORES PIZZAS - CHOCOLATE PRETO'},
   {Tipo:'COMPLEMENTO',Categoria:'IFOOD - PIZZAS','Código Saipos':'34166642.23327486',Complemento:'IFOOD - SABORES PIZZAS - CONFETE'},
   {Tipo:'COMPLEMENTO',Categoria:'IFOOD - PIZZAS','Código Saipos':'34166642.23327488',Complemento:'IFOOD - SABORES PIZZAS - PRESTÍGIO'}
  ])
 ));
 assert.equal(pizzaFlavor.code,'x.23327486');
 assert.equal(pizzaFlavor.confidence,'correto');
 assert.equal(pizzaFlavor.suggested,'IFOOD - SABORES PIZZAS - CONFETE');
 const addByGroup=await page.evaluate(()=>GoomerMatching.match(
  {id:'template:add:1',kind:'template',name:'Picanha',current:'',group:'Adicionais',contexts:[{id:'add:1',name:'Combo Hot dog + batata P + Coca Cola 200ml',code:'141906530',category1:'Combos',category2:'Combo Hot dog + batata P + Coca Cola 200ml',category:'Combo Hot dog + batata P + Coca Cola 200ml'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'COMBOS','Código Saipos':'141906530','Descrição':'HOT DOG + BATATA P + COCA COLA 200ML'},
   {Tipo:'COMPLEMENTO',Categoria:'ADICIONAIS','Código Saipos':'141906530.204',Complemento:'ADICIONAL PICANHA'},
   {Tipo:'COMPLEMENTO',Categoria:'ADICIONAIS','Código Saipos':'141906530.205',Complemento:'ADICIONAL MIGNON'}
  ])
 ));
 assert.equal(addByGroup.code,'x.204');
 assert.equal(addByGroup.confidence,'alta');
 const corona=await page.evaluate(()=>GoomerMatching.match(
  {id:'parent:5:1',kind:'parent',name:'Corona Long Neck Zero 330ml',current:'33943144',contexts:[{id:'5:1',name:'Corona Long Neck Zero 330ml',code:'33943144',category1:'Cervejas',category2:'CERVEJAS LONG NECK',category:'CERVEJAS LONG NECK'}]},
  GoomerMatching.catalogs([
   {Tipo:'PRATO',Categoria:'BEBIDAS NÃO ALCOÓLICAS','Código Saipos':'33842221','Descrição':'ÁGUA SEM GÁS'},
   {Tipo:'PRATO',Categoria:'CERVEJAS','Código Saipos':'33943140','Descrição':'CERVEJA LONG NECK CORONA'},
   {Tipo:'PRATO',Categoria:'CERVEJAS','Código Saipos':'33943144','Descrição':'CERVEJA LONG NECK SEM ÁLCOOL'}
  ])
 ));
 assert.notEqual(corona.code,'33842221');
 const result=await page.evaluate(async ({pid,cid})=>send({type:'GOOMER_APPLY_FRAME',id:scanId,changes:[{id:pid,code:'100'},{id:cid,code:'x.200'}]}),{pid:p.id,cid:c.id});
 assert.equal(result.ok,true);assert(result.results.every(r=>r.ok));assert.equal(posts.length,2);
 assert.equal(posts[0].data['ProductItem[2][remote_code]'],'101');assert.equal(posts[0].data['ProductItem[1][priceInput]'],'21,90');
 assert.equal(posts[0].data['ProductAttribute[3][attribute_template_id]'],'7');assert.equal(posts[1].data['AttributeTemplate[max_choices]'],'5');
 const invalid=await page.evaluate(()=>send({type:'GOOMER_APPLY_FRAME',id:'expired',changes:[]}));assert(invalid.error);
 const unknown=await page.evaluate(pid=>send({type:'GOOMER_APPLY_FRAME',id:scanId,changes:[{id:pid,code:'unknown'}]}),p.id);assert(unknown.error);assert.equal(posts.length,2);
 // Re-read verification must reject a success response without persistence.
 persist=false;
 const unconfirmed=await page.evaluate(pid=>send({type:'GOOMER_APPLY_FRAME',id:scanId,changes:[{id:pid,code:'101'}]}),p.id);
 assert.equal(unconfirmed.results[0].ok,false);assert.match(unconfirmed.results[0].error,/releitura/);
 // Concurrency check rejects external edits before sending a POST.
 parent='external';const count=posts.length;
 const conflict=await page.evaluate(pid=>send({type:'GOOMER_APPLY_FRAME',id:scanId,changes:[{id:pid,code:'101'}]}),p.id);
 assert.equal(conflict.results[0].ok,false);assert.equal(posts.length,count);
 // Cross-category border/dough cannot be a high-confidence suggestion.
 const category=await page.evaluate(()=>GoomerMatching.match({kind:'template',name:'Tradicional',group:'Borda',current:'',contexts:[{code:'1'}]},GoomerMatching.catalogs([{Tipo:'COMPLEMENTO','Código Saipos':'1.2',Complemento:'MASSA ITALIANA - Tradicional'}])));
 assert.equal(category.code,'');
 // UI allows marking first, rejects invalid codes and enables a valid pasted PDV.
 const ui=await browser.newPage({viewport:{width:1440,height:1000}});await ui.route('**/*',r=>{
  const name=new URL(r.request().url()).pathname.split('/').pop();
  return r.fulfill(name==='review.css'||name==='review-goomer.css'
   ?{contentType:'text/css',body:fs.readFileSync(name,'utf8')}
   :{contentType:'text/html',body:fs.readFileSync('review-goomer.html','utf8').replace(/<script.*?<\/script>/g,'')});
 });
 await ui.goto('https://review.invalid/?id=demo');
 report.rows[0]={...p,confidence:'baixa',code:'',suggested:''};report.rows=[report.rows[0],c];report.busy=false;
 await ui.evaluate(report=>{window.chrome={storage:{local:{get:async()=>({'goomer:demo':report})},onChanged:{addListener:()=>{}}},runtime:{sendMessage:async()=>({ok:true})}};},report);
 await ui.addScriptTag({content:fs.readFileSync('review-goomer.js','utf8')});
 await ui.locator('.rv-sec-baixa > summary').click();
 assert(await ui.locator('[data-check="0"]').isDisabled());
 assert(await ui.locator('#rv-btn-apply').isDisabled());
 await ui.locator('[data-search="0"]').fill('100');assert(await ui.locator('#rv-btn-apply').isEnabled());
 assert(await ui.locator('[data-check="0"]').isChecked());
 await ui.locator('[data-search="0"]').fill('invalid');assert(await ui.locator('#rv-btn-apply').isDisabled());
 assert(await ui.locator('[data-check="0"]').isDisabled());
 await ui.locator('[data-search="0"]').fill('100');
 const master=ui.locator('.rv-sec-baixa [data-check-all]');
 await master.uncheck();assert(!(await ui.locator('[data-check="0"]').isChecked()));
 await master.check();assert(await ui.locator('#rv-btn-apply').isEnabled());
 assert.equal(await ui.locator('.rv-sec-baixa').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(30, 32, 36)');
 assert.equal(await ui.locator('[data-search="0"]').evaluate(el=>getComputedStyle(el).fontSize),'11px');
 await ui.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'goomer-review-parent.png'),fullPage:true});
 await ui.locator('[data-tab="complement"]').click();
 await ui.locator('.rv-sec-media > summary').click();
 await ui.locator('.rv-sec-media [data-check-all]').check();assert(await ui.locator('[data-check="1"]').isChecked());
 assert(await ui.locator('[data-search="1"]').isVisible());
 await ui.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'goomer-review-complement.png'),fullPage:true});
 console.log('PASS: scan, name suggestions, 107 searchable parents, shared groups, confirmed writes, preserved fields, stale/invalid requests, concurrent edits, border/dough guard, selection and paste. No live store requests.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
