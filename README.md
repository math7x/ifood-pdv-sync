# PDV Sync (Saipos → iFood e 99Food)

Extensão para o Chrome que lê a planilha de "Códigos de integração" da Saipos,
casa cada complemento com a opção correspondente no cardápio PDV do Portal do
Parceiro iFood, e preenche os campos `x.XXXXX` — com uma etapa de revisão
antes de qualquer escrita no seu cardápio.

Também funciona no **Cardápio online do 99Food** para produtos: percorre as
categorias, compara cada nome com as linhas `PRATO` da mesma planilha e, após
revisão, usa a edição rápida da coluna **Código PDV** na aba **Itens**.
Grupos de itens adicionais do 99Food ainda não são alterados.

## Como usar no 99Food

1. Abra `https://merchant.99app.com/pt-BR/manager/micro-merchandish/merchant-item/menu?tab=store-menu`.
2. Abra a extensão, selecione a planilha Saipos e clique em **Verificar cardápio e sugerir códigos**.
3. Aguarde a leitura automática de todas as categorias.
4. Na aba de revisão, confira as sugestões. As de alta confiança já vêm marcadas. O botão **Selecionar todos** do topo controla todas as seções; a caixa do cabeçalho da primeira coluna controla somente sua própria seção (alta, média ou baixa). Produtos com volumes diferentes, como 350 ml e 2 litros, não são associados entre si.
   Em qualquer linha, o campo **Buscar prato ou código Saipos** permite pesquisar manualmente entre todos os pratos ativos da planilha; ao escolher um resultado, a linha é atualizada e marcada automaticamente.
5. Clique em **Aplicar selecionados** e confirme. Não use nem feche a aba do 99Food durante o lote.
6. A extensão abre a aba **Itens**, pesquisa cada produto por nome e categoria e salva o Código PDV diretamente na lista. Falhas são informadas linha a linha sem travar o restante do lote.

Antes de abrir a revisão, o 99Food também tem suas páginas da aba **Itens**
lidas. Produtos com um Código PDV já coerente com o prato da planilha ficam
ocultos. Códigos preenchidos que apontam para um prato incompatível, ou que
não existem na planilha ativa, continuam visíveis para correção.

## Como instalar (modo desenvolvedor)

1. Extraia esta pasta em algum lugar do seu computador (ex: `Documentos/ifood-pdv-sync`).
2. No Chrome, acesse `chrome://extensions`.
3. Ative "Modo do desenvolvedor" (canto superior direito).
4. Clique em "Carregar sem compactação" e selecione a pasta `ifood-pdv-sync`.
5. O ícone da extensão vai aparecer na barra do Chrome.

## Como usar

1. **Preencha primeiro os códigos PAI** de cada item no Portal iFood (aba
   Cardápio > PDV), do jeito que você já vem fazendo.
2. Abra a planilha da Saipos com todos os itens do cardápio (mesmo formato do
   exemplo: colunas `Tipo`, `Categoria`, `Tamanho`, `Descrição`,
   `Complemento`, `Preço`, `Pesável`, `Código Saipos`, `Inativo`).
3. Na mesma aba do navegador aberta em `portal.ifood.com.br/menu/list/pdv`,
   clique no ícone da extensão.
4. Selecione o arquivo `.xlsx` da Saipos.
5. Clique em **"Verificar cardápio e sugerir códigos"**.
6. A extensão vai expandir automaticamente todos os "Complementos" da tela
   (role a página até acabar — isso pode levar alguns segundos dependendo do
   tamanho do cardápio) e depois **abrir uma aba nova**, própria da extensão
   (`review.html`), com o resultado — a página do PDV do iFood continua
   aberta em outra aba, mas a tela de revisão não roda dentro dela (fica bem
   mais leve assim, já que o site do iFood sozinho já é pesado).
7. Na aba de revisão, os resultados vêm separados por etapa:
   - **Já corretos**: só a contagem aparece (nada pra revisar) — a menos que
     o código já bata mas o nome do complemento esteja muito diferente do da
     planilha; esses casos aparecem à parte, só pra você conferir, sem
     precisar de ação.
   - **Prontos para aplicar (alta confiança)**: já vêm marcados.
   - **Para revisar (confiança média)** e **Sem correspondência confiável**:
     não vêm marcados — escolha manualmente a opção certa num menu suspenso,
     marque a caixinha, ou ignore.
   - Linhas da planilha com a coluna **"Inativo" = Inativo são descartadas
     antes de qualquer comparação** (isso também deixa a lista de "sem
     correspondência" bem menor).
   - **"Exportar CSV"** a qualquer momento salva um relatório completo (bom
     para auditoria).
   - **"Aplicar selecionados"** manda os campos marcados de volta para a aba
     do iFood, que é quem realmente escreve nos campos. O resultado
     (sucesso/falha) aparece linha a linha, e um resumo final some no rodapé.
8. Confira o cardápio depois de aplicar, como faria com qualquer edição em
   massa.

## Como funciona o casamento de nomes

- O texto da coluna "Complemento" da Saipos é dividido nos hífens; o último
  pedaço vira o "nome núcleo" (ex: de `IF - ADICIONAIS - *ADICIONAL 1/2
  GRANDE- BACON FATIADO*` extrai `BACON FATIADO`), e os pedaços anteriores
  viram uma "dica de grupo" (`ADICIONAIS`).
- Esse nome núcleo é comparado com o nome de cada opção mostrada no PDV do
  iFood usando similaridade de texto (coeficiente de Dice sobre bigramas),
  com um bônus quando um nome contém o outro e outro pequeno bônus quando a
  dica de grupo bate com o título da seção no iFood (ex: "Escolha o sabor da
  sua pizza salgada").
- Score ≥ 0,72 → alta confiança. Entre 0,40 e 0,72 → revisar manualmente.
  Abaixo disso → sem correspondência confiável.
- **Nomes muito abreviados de forma diferente** (ex: Saipos "FRANGO REQ
  CREMOSO" vs iFood "Frango com requeijão") não batem com segurança e caem
  sempre na faixa "revisar" — é esperado, não é bug.

## Atualizando uma instalação já existente

Se você já tinha carregado uma versão anterior: depois de sobrescrever os
arquivos, vá em `chrome://extensions` e clique em **"Recarregar"** no card da
extensão. Essa versão pediu uma permissão nova (`tabs`, para abrir a aba de
revisão), então o Chrome pode pedir para você confirmar a permissão de novo —
é esperado, é só aceitar.

## Limitações e pontos de atenção

- No iFood, a extensão funciona na página `portal.ifood.com.br/menu/list/pdv`.
- No 99Food, a leitura deve começar na página `merchant-item/menu?tab=store-menu`.
- No 99Food, esta versão preenche apenas o Código PDV dos produtos; não altera grupos de itens adicionais.
- Ela lê a estrutura visual da página atual do portal. Se a iFood atualizar o
  layout do PDV, os seletores no topo de `content.js` (constante
  `IFPS_CONFIG`) podem precisar de ajuste.
- Os campos de código no iFood não têm botão de salvar separado — parecem
  salvar ao perder o foco. A extensão simula essa perda de foco a cada campo
  preenchido, mas vale sempre conferir o resultado final na tela.
- Nada é enviado para fora do seu navegador: a leitura da planilha e o
  casamento de nomes acontecem inteiramente no seu computador.
- Sempre revise as linhas amarelas e vermelhas manualmente — o matching é uma
  sugestão, não uma verdade absoluta.
