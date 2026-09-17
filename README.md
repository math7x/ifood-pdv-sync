# PDV Sync — Saipos, iFood e 99Food

Extensão para Google Chrome que ajuda a manter os códigos de integração do
PDV consistentes entre a planilha exportada pela Saipos e os cardápios do
iFood e do 99Food.

A extensão lê a planilha localmente, compara produtos e complementos pelo
nome, apresenta as sugestões em uma tela de revisão e só altera o cardápio
depois da confirmação do usuário. A ideia é reduzir o trabalho manual sem
eliminar a conferência humana.

> Projeto independente, sem vínculo oficial com Saipos, iFood ou 99Food.

## O que a extensão faz

| Plataforma | Leitura e comparação | Alteração assistida |
| --- | --- | --- |
| iFood | Lê produtos, códigos pai, grupos e opções do Cardápio > PDV | Preenche os códigos selecionados de produtos e complementos |
| 99Food | Percorre as categorias e compara os produtos com as linhas `PRATO` da planilha | Pesquisa cada produto na aba Itens e salva o Código PDV |
| Saipos | Lê a planilha de integração e consulta as categorias em uma aba aberta | Permite criar, com confirmação individual, produtos ausentes |

Principais recursos:

- leitura de arquivos `.xlsx` e `.xls` diretamente no navegador;
- comparação por nomes, abreviações, categorias, tamanhos e volumes;
- sugestões separadas em alta, média ou baixa confiança;
- identificação dos códigos que já estão corretos;
- escolha manual quando a sugestão automática não for suficiente;
- aplicação em lote com o resultado de cada linha;
- exportação da revisão em CSV;
- descarte das linhas marcadas como inativas na planilha.

## Fluxo geral

1. O usuário seleciona a planilha de códigos de integração da Saipos.
2. A extensão valida as colunas e mantém os dados no armazenamento local do Chrome.
3. No iFood ou no 99Food, ela percorre o cardápio e reúne os códigos atuais.
4. Os nomes são normalizados e comparados com as linhas ativas da planilha.
5. Uma nova aba mostra o que já está correto e o que precisa de revisão.
6. Somente as linhas selecionadas e confirmadas são enviadas de volta ao portal.

## Como instalar (modo desenvolvedor)

1. Extraia esta pasta em algum lugar do seu computador (ex: `Documentos/ifood-pdv-sync`).
2. No Chrome, acesse `chrome://extensions`.
3. Ative "Modo do desenvolvedor" (canto superior direito).
4. Clique em "Carregar sem compactação" e selecione a pasta `ifood-pdv-sync`.
5. O ícone da extensão vai aparecer na barra do Chrome.

## Como usar no iFood

1. **Preencha primeiro os códigos PAI** de cada item no Portal iFood (aba
   Cardápio > PDV), do jeito que você já vem fazendo.
2. Abra a planilha da Saipos com todos os itens do cardápio (mesmo formato do
   exemplo: colunas `Tipo`, `Categoria`, `Tamanho`, `Descrição`,
   `Complemento`, `Preço`, `Pesável`, `Código Saipos`, `Inativo`).
3. Na mesma aba do navegador aberta em `portal.ifood.com.br/menu/list/pdv`,
   clique no ícone da extensão.
4. Selecione o arquivo `.xlsx` da Saipos.
5. Clique em **"Verificar cardápio e sugerir códigos"**.
6. A extensão percorre o cardápio, expande os grupos de complementos e abre
   uma nova aba com o resultado. O tempo de leitura depende do tamanho do
   cardápio.
7. Na aba de revisão, os resultados vêm separados por etapa:
   - **Já corretos**: só a contagem aparece (nada pra revisar) — a menos que
     o código já bata mas o nome do complemento esteja muito diferente do da
     planilha; esses casos aparecem à parte, só pra você conferir, sem
     precisar de ação.
   - **Prontos para aplicar (alta confiança)**: já vêm marcados.
   - **Para revisar (confiança média)** e **Sem correspondência confiável**:
     não vêm marcados — escolha manualmente a opção certa num menu suspenso,
     marque a caixinha, ou ignore.
   - Linhas da planilha com a coluna **"Inativo" = Inativo** são descartadas
     antes de qualquer comparação (isso também deixa a lista de "sem
     correspondência" bem menor).
   - **"Exportar CSV"** a qualquer momento salva um relatório completo (bom
     para auditoria).
   - **"Aplicar selecionados"** manda os campos marcados de volta para a aba
     do iFood, que é quem realmente escreve nos campos. O resultado
     (sucesso/falha) aparece linha a linha, e um resumo final some no rodapé.
8. Confira o cardápio depois de aplicar, como faria com qualquer edição em
   massa.

Na aba **Criar no Saipos**, a extensão pode cadastrar um produto real com
preço inicial de `0,00` e disponibilidade para Delivery. Cada criação exige
uma confirmação própria. Complementos não são vinculados automaticamente ao
novo produto e devem ser configurados depois no Saipos.

## Como usar no 99Food

1. Abra o Cardápio online em
   `merchant.99app.com/pt-BR/manager/micro-merchandish/merchant-item/menu?tab=store-menu`.
2. Abra a extensão, selecione a planilha da Saipos e clique em
   **Verificar cardápio e sugerir códigos**.
3. Aguarde a leitura automática das categorias e dos produtos.
4. Revise as sugestões. As de alta confiança já vêm marcadas; as demais
   ficam disponíveis para escolha manual.
5. Se necessário, use **Buscar prato ou código Saipos** para escolher outro
   produto da planilha.
6. Clique em **Aplicar selecionados** e confirme.
7. Não feche nem use a aba do 99Food enquanto o lote estiver em andamento.

Antes de abrir a revisão, a extensão também consulta a aba **Itens**.
Produtos cujo Código PDV já corresponde a um prato compatível são ocultados.
Códigos ausentes, desconhecidos ou incompatíveis continuam visíveis para
correção.

Nesta versão, o 99Food recebe apenas o Código PDV dos produtos. Grupos de
adicionais e complementos ainda não são alterados.

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

## Formato esperado da planilha

A planilha deve conter, no mínimo, as colunas `Tipo`, `Categoria`,
`Descrição`, `Complemento` e `Código Saipos`. As colunas `Tamanho`,
`Preço`, `Pesável` e `Inativo` também são utilizadas quando estão
disponíveis.

## Privacidade e segurança

- A planilha é processada localmente no navegador.
- A extensão não possui servidor próprio e não envia a planilha para serviços externos.
- A leitura e a comparação não alteram o cardápio.
- A aplicação dos códigos exige seleção e confirmação do usuário.
- A criação de produtos no Saipos exige confirmação separada para cada item.

As permissões ficam restritas aos portais do iFood, 99Food e Saipos, além do
armazenamento local necessário para levar os dados até a tela de revisão.

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

## Tecnologias

- JavaScript, HTML e CSS;
- Chrome Extensions Manifest V3;
- SheetJS para leitura das planilhas;
- armazenamento local e APIs de abas do Chrome.

Versão atual: `1.3.6`.
