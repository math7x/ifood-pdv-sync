// matching.js — normalização de texto e cálculo de similaridade entre o nome do
// complemento no Saipos e o nome da opção mostrada no PDV do iFood.
// Sem dependências externas: usa coeficiente de Dice sobre bigramas de caracteres,
// que lida bem com abreviações e pequenas diferenças de grafia.

const IFPS_STOPWORDS_PREFIX = [
  /^IF\s*[-\/]\s*/i,
  /^CW\s*[-\/]\s*/i,
];

function ifpsStripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Extrai o "núcleo" do nome do complemento na planilha Saipos.
// Ex: "IF - SABORES PIZZA SALGADA - CALABRESA" -> { core: "CALABRESA", hint: "SABORES PIZZA SALGADA" }
// Ex: "IF - ADICIONAIS - *ADICIONAL 1/2 GRANDE- BACON FATIADO*" -> { core: "BACON FATIADO", hint: "ADICIONAIS" }
function ifpsParseComplementoField(raw) {
  const original = String(raw || '').trim();
  const parts = original.split('-').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return { core: '', hint: '', original };

  let core = parts[parts.length - 1];
  let hintParts = parts.slice(0, -1);

  // Casos tipo "**GG-BORDA CHEDDAR**" / "**PQ-BORDA CHEDDAR**": como o hífen
  // ali é colado (sem espaço), o split acima separa a marca curta de tamanho
  // (GG/PQ/GR/...) do resto do nome. Sem isso "GG-BORDA CHEDDAR" e
  // "PQ-BORDA CHEDDAR" viram o mesmo core ("BORDA CHEDDAR") e a extensão
  // perde justamente o pedaço que diferencia qual tamanho é qual — puxamos
  // essa marca de volta pro core.
  if (hintParts.length > 0) {
    const lastHintToken = hintParts[hintParts.length - 1].replace(/\*/g, '').trim();
    if (/^[A-Za-zÀ-ÿ]{1,4}$/.test(lastHintToken)) {
      core = lastHintToken + '-' + core;
      hintParts = hintParts.slice(0, -1);
    }
  }

  const hint = hintParts.join(' ').replace(/^IF\s*/i, '').trim();

  core = core.replace(/\*/g, '').trim();

  return { core, hint, original };
}

const IFPS_SIZE_TAG_ALIASES = new Map([
  ['P', 'PQ'],
  ['PQ', 'PQ'],
  ['PEQ', 'PQ'],
  ['M', 'MD'],
  ['MD', 'MD'],
  ['MED', 'MD'],
  ['G', 'GR'],
  ['GR', 'GR'],
  ['GG', 'GG'],
  ['F', 'FM'],
  ['FM', 'FM'],
]);

function ifpsCanonicalSizeTag(tag) {
  const norm = ifpsStripAccents(String(tag || '')).toUpperCase();
  return IFPS_SIZE_TAG_ALIASES.get(norm) || norm;
}

// Marca curta de tamanho colada por hífen no começo (planilha Saipos, depois
// do ajuste acima: "GG-BORDA CHEDDAR"), no fim (opção do iFood: "Borda
// Cheddar-Pq") ou entre parênteses no produto ("Marmitex Cupim (M)"). Usada
// só pra desempate — ver ifpsScoreMatch e ifpsScoreProduto.
function ifpsExtractSizeTag(s) {
  const str = String(s || '').trim();
  const front = /^([A-Za-zÀ-ÿ]{1,3})-/.exec(str);
  if (front) return ifpsCanonicalSizeTag(front[1]);
  const back = /-([A-Za-zÀ-ÿ]{1,3})$/.exec(str);
  if (back) return ifpsCanonicalSizeTag(back[1]);
  const paren = /\(([A-Za-zÀ-ÿ]{1,3})\)/.exec(str);
  if (paren) return ifpsCanonicalSizeTag(paren[1]);
  return '';
}

// Tamanho por extenso no nome do ITEM/produto (no iFood ou na descrição da
// Saipos) — ex: item "Pizza individual (4 fatias)" = pequena; "Pizza
// gigante Santa Casa" = GG. Diferente de ifpsExtractSizeTag (que pega a
// marca curta tipo "-Pq"/"GG-" colada por hífen no nome da OPÇÃO), isto lê o
// nome do item inteiro — necessário quando o grupo de complemento (ex:
// "Bordas e Massas") tem só uma opção sem marca nenhuma de tamanho no
// próprio nome, e a única forma de saber o tamanho certo é olhando pro item.
const IFPS_SIZE_WORDS = [
  [/\bINDIVIDUA(L|IS)\b/, 'PQ'],
  [/\bPEQUEN[AO]S?\b/, 'PQ'],
  [/\bBROTINHOS?\b/, 'PQ'],
  [/\bM[EÉ]DI[AO]S?\b/, 'MD'],
  [/\bGRANDES?\b/, 'GR'],
  [/\bGIGANTES?\b/, 'GG'],
  [/\bFAM[IÍ]LIA(O)?S?\b/, 'FM'],
];

function ifpsSizeWordTag(text) {
  const norm = ifpsNormalize(text);
  for (const [re, tag] of IFPS_SIZE_WORDS) {
    if (re.test(norm)) return tag;
  }
  return '';
}

// Mesma lista de IFPS_SIZE_WORDS, mas como um único regex pra FILTRAR (tirar)
// a palavra de tamanho de um conjunto de palavras — usado em
// ifpsScoreProduto pra não confundir "GRANDE" (item) x "GR" (prato,
// abreviado) como se fossem conceitos diferentes: tamanho já tem seu próprio
// desempate dedicado mais abaixo (por sigla), então a palavra por extenso
// não deve contar como "palavra de conteúdo que sobra" nessa comparação.
const IFPS_SIZE_WORD_TOKEN_RE = /^(INDIVIDUAL|INDIVIDUAIS|PEQUEN[AO]S?|BROTINHOS?|M[EÉ]DI[AO]S?|GRANDES?|GIGANTES?|FAM[IÍ]LIA[SO]?)$/;

// Abreviações comuns nos nomes da Saipos que, sem isso, atrapalham a
// comparação de texto porque o nome da opção no iFood normalmente vem por
// extenso (ex: Saipos "LOMBO REQ CREMOSO" x iFood "Lombo C/ Requeijão
// Cremoso" — sem expandir "REQ", o núcleo do nome bate muito menos com a
// opção certa do que bateria com um "*Adicional ... Requeijão Cremoso*" de
// outro grupo, que por acaso usa a palavra por extenso).
const IFPS_ABBREVIATIONS = [
  [/\bREQ\b/g, 'REQUEIJAO'],
  // "PQ - CHOC BRANCO" (Saipos, abreviado) x "Chocolate branco" (iFood, por
  // extenso) — sem expandir, "CHOC BRANCO" bate pior com a opção certa do
  // que "CHOCOLATE BRANCO COM MORANGOS" bate por conter "chocolate branco"
  // inteiro como substring, e a extensão sugeria misturar os dois sabores.
  [/\bCHOC\b/g, 'CHOCOLATE'],
  // Números por extenso na Saipos ("QUATRO QUEIJOS") x número em algarismo
  // no iFood ("4 Queijos") — outro caso real visto (Sete x Quatro Queijos).
  [/\bUM\b/g, '1'],
  [/\bUMA\b/g, '1'],
  [/\bDOIS\b/g, '2'],
  [/\bDUAS\b/g, '2'],
  [/\bTRES\b/g, '3'],
  [/\bQUATRO\b/g, '4'],
  [/\bCINCO\b/g, '5'],
  [/\bSEIS\b/g, '6'],
  [/\bSETE\b/g, '7'],
  [/\bOITO\b/g, '8'],
  [/\bNOVE\b/g, '9'],
  [/\bDEZ\b/g, '10'],
  [/\bH2OH\b/g, 'H2O'],
  [/\bLIMONETO\b/g, 'LIMAO'],
];

function ifpsNormalize(s) {
  let out = ifpsStripAccents(String(s || ''));
  out = out.toUpperCase();
  out = out.replace(/\*/g, ' ');
  for (const re of IFPS_STOPWORDS_PREFIX) out = out.replace(re, '');
  out = out.replace(/[^A-Z0-9 ]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  for (const [re, full] of IFPS_ABBREVIATIONS) out = out.replace(re, full);
  return out;
}

// Convenção específica dessa pizzaria pros sabores de pizza doce: na Saipos,
// um sabor tipo "PRESTIGIO BRANCO" ou "CHOCONFETE PRETO" (topping + só a COR)
// significa, na prática, "<topping> com chocolate <cor>" — o iFood mostra o
// nome completo ("Prestígio com chocolate branco"). Sem "chocolate" escrito,
// esse núcleo batia por acaso mais parecido com OUTRO sabor que tem a
// palavra "chocolate" escrita de verdade (ex: "Chocolate branco com
// morangos") do que com a opção certa — foi um bug real visto ao vivo.
// Só mexe quando o hint é de pizza doce (evita mexer em núcleo de qualquer
// outro grupo que por acaso termine em "branco"/"preto").
function ifpsExpandDessertColorShorthand(core, hint) {
  const normHint = ifpsNormalize(hint || '');
  if (!/\bDOCE\b/.test(normHint)) return core;
  if (/\b(CHOCOLATE|CHOC)\b/i.test(core)) return core;
  const m = /^(.*\S)\s+(BRANCO|PRETO)$/i.exec(String(core || '').trim());
  if (!m) return core;
  return `${m[1]} com chocolate ${m[2]}`;
}

function ifpsBigrams(s) {
  const arr = [];
  for (let i = 0; i < s.length - 1; i++) arr.push(s.substring(i, i + 2));
  return arr;
}

// Coeficiente de Dice sobre bigramas de caracteres. Retorna 0..1.
function ifpsDiceCoefficient(a, b) {
  const na = ifpsNormalize(a);
  const nb = ifpsNormalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const bA = ifpsBigrams(na.replace(/ /g, ''));
  const bB = ifpsBigrams(nb.replace(/ /g, ''));
  if (bA.length === 0 || bB.length === 0) return na === nb ? 1 : 0;

  const bBCopy = bB.slice();
  let matches = 0;
  for (const bg of bA) {
    const idx = bBCopy.indexOf(bg);
    if (idx !== -1) {
      matches++;
      bBCopy.splice(idx, 1);
    }
  }
  return (2 * matches) / (bA.length + bB.length);
}

// Bônus quando um nome contém o outro por inteiro (após normalizar) — comum quando
// um lado é uma versão abreviada/expandida do outro.
function ifpsContainmentBonus(a, b) {
  const na = ifpsNormalize(a);
  const nb = ifpsNormalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 0.25;
  if (na.includes(nb) || nb.includes(na)) return 0.15;
  return 0;
}

// Categoria "grosseira" do complemento, pelas palavras-chave típicas usadas
// tanto na categoria da Saipos (hint) quanto na pergunta do grupo no iFood
// (groupHeading). Isso é mais confiável do que comparar os dois textos por
// semelhança de string (ifpsDiceCoefficient): "ADICIONAIS *ADICIONAL 1
// PEQUENA" e "Aceita borda pizza pequena?" batem bastante por causa da
// palavra "PEQUENA" que os dois têm, mesmo sendo categorias totalmente
// diferentes (adicional x borda) — foi exatamente isso que fez a extensão
// sugerir um "Adicional Requeijão Cremoso" (e até um sabor "Lombo Req
// Cremoso") no lugar de "Borda de requeijão cremoso". Palavra-chave de
// categoria não tem esse problema: só bate quando o CONCEITO é o mesmo.
const IFPS_CATEGORY_KEYWORDS = [
  ['borda', /\b(BORDA|BORDAS|MASSA|MASSAS)\b/],
  ['adicional', /\b(ADICIONAL|ADICIONAIS)\b/],
  // "DOCE"/"SALGADA" entraram aqui além de "SABOR(ES)" por causa de um caso
  // real: um grupo promocional de upsell no iFood ("Aproveite pequena doce
  // de R$49,90 por R$29,90:") não tem heading do tipo "Escolha o sabor..." —
  // só esse texto de marketing mesmo — então nem "sabor" nem qualquer outra
  // palavra-chave batia, o classificador voltava vazio, e uma opção de sabor
  // de pizza doce ("Pq- Chocolate Ao leite") acabou sendo sugerida pra um
  // complemento de BORDA ("Pq-Borda Choc Preto") só por coincidência de
  // "chocolate"+"pq" no nome. "Doce"/"Salgada" aparecem o bastante em
  // headings e promoções desse tipo de cardápio pra servir de sinal
  // confiável de categoria "sabor" mesmo sem a palavra "sabor" escrita.
  ['sabor', /\b(SABOR|SABORES|DOCES?|SALGADAS?)\b/],
  ['tamanho', /\bTAMANHO\b/],
  ['bebida', /\b(BEBIDA|BEBIDAS|REFRIGERANTE|SUCO)\b/],
];

function ifpsCategoryOf(text) {
  const norm = ifpsNormalize(text);
  for (const [key, re] of IFPS_CATEGORY_KEYWORDS) {
    if (re.test(norm)) return key;
  }
  return '';
}

// Detecta volume/capacidade tipo "600ml", "2l", "1,5 L", "2 litros" — normaliza
// tudo pra MILILITROS pra dar pra comparar mesmo quando um lado escreve "2L"
// e o outro "2000ml". Roda sobre o texto ORIGINAL (antes de ifpsNormalize
// tirar a pontuação), porque "1,5L" viraria "1 5L" e perderia a vírgula
// decimal se normalizasse primeiro. Usado só como desempate — ver
// ifpsScoreMatch: sem isso, "Guaraná Antarctica 2L" (Saipos) e "Guaraná
// Antarctica 600ml" (opção do iFood) batiam quase 100% pelo nome (o volume é
// só um número + uma unidade genérica, ambos ignorados pelo filtro de
// palavra "de conteúdo" abaixo) e a extensão sugeria o refrigerante do
// tamanho errado — bug real visto ao vivo numa pizza + bebida em combo.
function ifpsExtractVolumeMl(text) {
  const str = ifpsStripAccents(String(text || '')).toUpperCase();
  const m = /(\d+(?:[.,]\d+)?)\s*(ML|LITROS?|LT|L)\b/.exec(str);
  if (!m) return null;
  const value = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(value) || value <= 0) return null;
  return m[2] === 'ML' ? Math.round(value) : Math.round(value * 1000);
}

// Palavras genéricas demais pra servir de sinal de "é o mesmo sabor/produto"
// — aparecem em vários itens de bebida diferentes (marca, embalagem,
// qualificador) e por isso não ajudam a distinguir UM refrigerante do
// outro. O que sobra depois de tirar essas é o nome que realmente importa
// (ex: "GUARANA", "SODA", "COCA", "LARANJA").
const IFPS_GENERIC_WORDS = new Set([
  'REFRIGERANTE', 'REFRI', 'ANTARCTICA', 'LATA', 'GARRAFA', 'PET', 'LITROS', 'LITRO', 'ML', 'COM', 'SEM', 'DE', 'DA', 'DO', 'L',
  'PESSOA', 'PESSOAS', 'NOITE', 'AGUA', 'AGUAS', 'SABOR', 'SABORIZADA',
  'SUCO', 'SUCOS', 'SUMO', 'SUMOS', 'NATURAL', 'NATURAIS',
]);

function ifpsSignificantWords(text) {
  return ifpsNormalize(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !IFPS_GENERIC_WORDS.has(w) && !/^\d+$/.test(w));
}

// Quantidade servida no nome do prato: "P/ 2 pessoas", "para 3 pessoas",
// "P 1 pessoa". Isso precisa ser comparado como dado estruturado, porque o
// número costuma ser a única diferença entre produtos quase idênticos.
function ifpsExtractServingCount(text) {
  const norm = ifpsNormalize(text);
  const m = /\b(?:P|PARA)?\s*(\d{1,2})\s+PESSOAS?\b/.exec(norm);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Calcula o score final entre um complemento do Saipos (já parseado) e uma opção do iFood.
// groupHeading é o texto do cabeçalho do grupo de complementos no iFood (ex: "Escolha o sabor da sua pizza salgada").
function ifpsScoreMatch(saiposParsed, ifoodOptionName, groupHeading, itemSizeTag) {
  const matchCore = ifpsExpandDessertColorShorthand(saiposParsed.core, saiposParsed.hint);
  let score = ifpsDiceCoefficient(matchCore, ifoodOptionName);
  score += ifpsContainmentBonus(matchCore, ifoodOptionName);

  const saiposCat = ifpsCategoryOf(saiposParsed.hint);
  const ifoodCat = ifpsCategoryOf(groupHeading);
  if (saiposCat && ifoodCat) {
    // As duas categorias deram pra reconhecer por palavra-chave — sinal
    // forte, então pesa mais que a semelhança de texto do hint.
    score += saiposCat === ifoodCat ? 0.35 : -0.9;
  } else if (saiposParsed.hint && groupHeading) {
    // Não deu pra classificar os dois lados por palavra-chave (categoria
    // nova, ou groupHeading genérico) — cai de volta pra semelhança de
    // texto, como antes.
    const hintScore = ifpsDiceCoefficient(saiposParsed.hint, groupHeading);
    score += hintScore * 0.5;
  }

  // Desempate por tamanho: quando o nome do complemento na Saipos e o nome
  // da opção no iFood têm cada um sua marca de tamanho (Pq/Gg/Gr/...), mas
  // as marcas são diferentes, é quase certo que é o complemento errado —
  // mesmo com o resto do nome idêntico (ex: "GG-Borda Cheddar" da planilha
  // não pode virar o código de "Borda Cheddar-Pq" no iFood). Se as marcas
  // batem, reforça a confiança.
  const saiposSize = ifpsExtractSizeTag(saiposParsed.core);
  const ifoodSize = ifpsExtractSizeTag(ifoodOptionName);
  if (saiposSize && ifoodSize) {
    score += saiposSize === ifoodSize ? 0.15 : -0.6;
  } else if (saiposSize && itemSizeTag) {
    // O nome da opção no iFood às vezes não carrega marca de tamanho nenhuma
    // (ex: grupo "Bordas e Massas" com uma opção só, tipo "Borda chocolate
    // preto", igual em Pq e Gg) — nesse caso não dá pra comparar pelo nome
    // da opção, então usamos o tamanho do PRÓPRIO ITEM como desempate: uma
    // linha da planilha marcada "GG" não pode aplicar num item que já é
    // claramente pequeno/individual (e vice-versa). Peso um pouco menor que
    // o desempate acima porque é uma inferência a mais (via nome do item).
    score += saiposSize === itemSizeTag ? 0.1 : -0.6;
  }

  // Desempate por volume/embalagem (refrigerantes, águas, sucos...): mesmo
  // sabor, garrafas de tamanhos diferentes (600ml x 2L x 350ml) são produtos
  // (e códigos) diferentes na Saipos. Só entra em ação quando os DOIS lados
  // têm volume detectável no nome — quando falta de um lado, não penaliza (o
  // resto do score continua valendo normalmente).
  const saiposVol = ifpsExtractVolumeMl(matchCore) ?? ifpsExtractVolumeMl(saiposParsed.original);
  const ifoodVol = ifpsExtractVolumeMl(ifoodOptionName);
  if (saiposVol != null && ifoodVol != null) {
    score += saiposVol === ifoodVol ? 0.2 : -0.9;
  }

  // Nomes tipo "Guaraná Antarctica 2l" x "Refrigerante Soda Antarctica 2l"
  // batem bastante por bigrama de caractere só por causa do texto genérico
  // em comum ("Antarctica 2l") — mas "Guaraná" e "Soda" são sabores
  // diferentes, e essa palavra que realmente importa é uma fração pequena
  // do texto todo, então o dice coefficient não pesa ela o suficiente
  // sozinho. Aqui comparamos só as palavras "de conteúdo" (tirando
  // marca/embalagem genérica): se as duas linhas têm alguma palavra
  // marcante em comum, reforça; se cada uma tem palavra marcante mas SEM
  // nenhuma em comum, é quase certo que são sabores diferentes.
  const saiposWords = ifpsSignificantWords(matchCore);
  const ifoodWords = ifpsSignificantWords(ifoodOptionName);
  if (saiposWords.length && ifoodWords.length) {
    const overlap = saiposWords.some((w) => ifoodWords.includes(w));
    score += overlap ? 0.15 : -0.9;
  }

  // Não limitamos a 1 aqui: várias linhas concorrendo pela mesma opção podem
  // somar bônus (nome + categoria + tamanho) e passar de 1 facilmente, e se
  // cortássemos ali (como era antes) elas empatavam em "1.00" e a escolha
  // de qual delas é a certa virava sorte da ordenação — foi exatamente o
  // que causou "LOMBO REQ CREMOSO" (sabor) ganhar de "PQ-BORDA REQ
  // CREMOSO" (borda) pra a opção "Borda de requeijão cremoso": as duas
  // batiam o teto de 1.00 e a diferença real entre elas (o grupo/categoria
  // bater ou não) se perdia. Quem usa o score pra ORDENAR usa o valor cru;
  // pra mostrar na tela, ifpsDisplayScore() aí embaixo aplica o teto.
  return Math.max(0, score);
}

// Versão só pra exibição (0..1) — ver comentário acima.
function ifpsDisplayScore(score) {
  return Math.max(0, Math.min(score, 1));
}

const IFPS_PRODUCT_CATEGORY_KEYWORDS = [
  ['espetinho', /\b(ESPETINHOS?|ESPETOS?)\b/],
  ['porcao', /\b(PORCAO|PORCOES)\b/],
  ['suco', /\b(SUCOS?|SUMOS?)\b/],
  ['batida', /\b(BATIDAS?)\b/],
  ['bebida', /\b(BEBIDAS?|REFRIGERANTES?|AGUAS?|CERVEJAS?)\b/],
  ['refeicao', /\b(REFEICOES?|PRATOS?\s+EXECUTIVOS?)\b/],
  ['marmitex', /\b(MARMITEX|MARMITAS?)\b/],
  ['adicional', /\b(ADICIONAIS?|EXTRAS?)\b/],
  ['lanche', /\b(LANCHES?|SANDUICHES?)\b/],
  ['hotdog', /\b(HOT\s+DOG|DOGS?)\b/],
  ['pizza', /\b(PIZZAS?)\b/],
  ['isca', /\b(ISCAS?)\b/],
  ['caldo', /\b(CALDOS?)\b/],
];

function ifpsProductCategoryOf(text) {
  const norm = ifpsNormalize(text);
  for (const [key, re] of IFPS_PRODUCT_CATEGORY_KEYWORDS) {
    if (re.test(norm)) return key;
  }
  return '';
}

function ifpsScoreProdutoCategoria(pdvCategory, excelCategory) {
  const pdv = ifpsProductCategoryOf(pdvCategory);
  const excel = ifpsProductCategoryOf(excelCategory);
  if (pdv && excel) return pdv === excel ? 0.3 : -0.55;

  const pdvNorm = ifpsNormalize(pdvCategory);
  const excelNorm = ifpsNormalize(excelCategory);
  if (!pdvNorm || !excelNorm) return 0;
  if (pdvNorm === excelNorm) return 0.2;
  if (pdvNorm.includes(excelNorm) || excelNorm.includes(pdvNorm)) return 0.12;
  return 0;
}

// Score entre o NOME DO ITEM no iFood e a Descrição de uma linha tipo PRATO
// da planilha Saipos — usado pra comparar o "código pai" que você já digitou
// no campo do item com o produto que a planilha diz que aquele código é.
// Mais simples que ifpsScoreMatch (não tem categoria/grupo pra comparar,
// já que aqui os dois lados são só o nome do prato inteiro), mas reaproveita
// o mesmo desempate de tamanho — importante numa pizzaria, onde "Calabresa
// Grande" e "Calabresa Individual" são produtos (e códigos) diferentes mas
// o nome bate quase 100% por bigrama se ignorar o tamanho.
function ifpsScoreProduto(itemName, pratoDescricao) {
  let score = ifpsDiceCoefficient(itemName, pratoDescricao);
  score += ifpsContainmentBonus(itemName, pratoDescricao);

  // Quando um nome "cabe dentro" do outro (containment bonus acima), isso
  // sozinho não é prova de que são o MESMO produto — pode ser um item menor
  // (um molho/adicional avulso) cujo nome aparece por acaso dentro do nome
  // de um produto bem maior e diferente (ex: item "Pesto de manjericão" —
  // um molho avulso — batendo 0.97 com o prato "PIZZA GR PESTO DE
  // MANJERICÃO", uma pizza inteira, só porque o nome do molho está contido
  // no nome da pizza). Aqui penalizamos por PALAVRA DE CONTEÚDO que sobra
  // de um lado e não existe no outro ("PIZZA", nesse exemplo) — se as
  // palavras que sobram forem só preposição/artigo (já filtradas por
  // ifpsSignificantWords), não penaliza; se sobrar uma palavra que muda o
  // tipo do produto, o score cai o bastante pra sair de "alta confiança" e
  // virar algo que passa por revisão manual em vez de aplicar sozinho.
  const itemWords = new Set(ifpsSignificantWords(itemName).filter((w) => !IFPS_SIZE_WORD_TOKEN_RE.test(w)));
  const pratoWords = new Set(ifpsSignificantWords(pratoDescricao).filter((w) => !IFPS_SIZE_WORD_TOKEN_RE.test(w)));
  let extraWords = 0;
  for (const w of pratoWords) if (!itemWords.has(w)) extraWords++;
  for (const w of itemWords) if (!pratoWords.has(w)) extraWords++;
  if (extraWords > 0) score -= extraWords * 0.35;

  const itemSize = ifpsSizeWordTag(itemName) || ifpsExtractSizeTag(itemName);
  const pratoSize = ifpsSizeWordTag(pratoDescricao) || ifpsExtractSizeTag(pratoDescricao);
  if (itemSize && pratoSize) {
    score += itemSize === pratoSize ? 0.15 : -0.6;
  }

  const itemServes = ifpsExtractServingCount(itemName);
  const pratoServes = ifpsExtractServingCount(pratoDescricao);
  if (itemServes != null && pratoServes != null) {
    score += itemServes === pratoServes ? 0.25 : -0.9;
  }

  const itemVol = ifpsExtractVolumeMl(itemName);
  const pratoVol = ifpsExtractVolumeMl(pratoDescricao);
  if (itemVol != null && pratoVol != null) {
    score += itemVol === pratoVol ? 0.25 : -0.9;
  }

  return Math.max(0, score);
}

function ifpsScoreProdutoComCategoria(itemName, pratoDescricao, pdvCategory, excelCategory) {
  const item = String(itemName || '').trim();
  const category = String(pdvCategory || '').trim();
  const combined = category && ifpsNormalize(category) !== ifpsNormalize(item) ? `${category} ${item}` : item;
  const nameScore = Math.max(ifpsScoreProduto(item, pratoDescricao), ifpsScoreProduto(combined, pratoDescricao));
  return Math.max(0, nameScore + ifpsScoreProdutoCategoria(pdvCategory, excelCategory));
}

const IFPS_CONFIDENCE = {
  HIGH: 0.72,
  MEDIUM: 0.4,
};

function ifpsClassify(score) {
  if (score >= IFPS_CONFIDENCE.HIGH) return 'alta';
  if (score >= IFPS_CONFIDENCE.MEDIUM) return 'media';
  return 'baixa';
}

// Extrai o código x.XXXXX a partir do "Código Saipos" de uma linha COMPLEMENTO.
// Formato esperado: "<codigoPai>.<codigoComplemento>" -> "x.<codigoComplemento>"
function ifpsBuildIfoodCode(codigoSaipos) {
  const raw = String(codigoSaipos || '').trim();
  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) return null;
  const suffix = raw.slice(dotIdx + 1).trim();
  if (!suffix) return null;
  return 'x.' + suffix;
}

function ifpsParentCode(codigoSaipos) {
  const raw = String(codigoSaipos || '').trim();
  const dotIdx = raw.indexOf('.');
  return dotIdx === -1 ? raw : raw.slice(0, dotIdx);
}
