# iFood PDV Sync (Saipos)

Extensão para o Chrome que lê a planilha de "Códigos de integração" da Saipos,
casa cada complemento com a opção correspondente no cardápio PDV do Portal do
Parceiro iFood, e preenche os campos `x.XXXXX` — com uma etapa de revisão
antes de qualquer escrita no seu cardápio.

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
     não vêm marcados. O complemento do iFood permanece fixo; no menu da
     coluna **Complemento Saipos sugerido**, escolha qualquer linha ativa do
     tipo `COMPLEMENTO` vinculada ao código pai desse produto no Excel. A
     lista inclui inclusive complementos já usados em outros casamentos.
     Depois, marque a caixinha ou ignore.
   - Linhas da planilha com a coluna **"Inativo" = Inativo são descartadas
     antes de qualquer comparação** (isso também deixa a lista de "sem
     correspondência" bem menor).
   - **"Exportar CSV"** a qualquer momento salva um relatório completo (bom
     para auditoria).
   - **"Aplicar selecionados"** manda os campos marcados de volta para a aba
     do iFood, que é quem realmente escreve nos campos. O resultado
     (sucesso/falha) aparece linha a linha, e um resumo final some no rodapé.
     Após preencher cada campo, a extensão força a saída de foco como um
     clique fora. O aviso verde **"PDV atualizado com sucesso"** é a
     confirmação preferencial; quando o portal não o exibe, mas mantém o
     valor sem erro e sem marcar o campo como inválido, a extensão também
     considera a gravação aceita e informa isso na própria linha.
     Os campos são reencontrados pelos identificadores estáveis do item,
     mesmo que o portal descarte o identificador temporário após a rolagem.
     O preenchimento seleciona o conteúdo do campo, insere o novo código e
    move o foco para outro campo PDV real para confirmar o `onBlur`; a busca
    do iFood fica como alternativa quando só existe um campo na página.
   - Na aba **Produtos pai**, a busca por nome ou código consulta todas as
     linhas ativas do tipo `PRATO` da planilha, sem limite de quantidade.
     É possível marcar a linha primeiro e depois colar o código PDV; quando
     o código existe no Excel, ele é reconhecido imediatamente.
     Se o código pai atual já existe em uma linha ativa da planilha, ele tem
     prioridade sobre diferenças de nome e aparece como **PDV já correto**,
     sem botão de aplicação porque não há mudança a realizar.
     Se o produto escolhido tiver o mesmo código pai que já está no iFood,
     ele é classificado como correto e nenhuma alteração é sugerida.
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

- A extensão só funciona na página `portal.ifood.com.br/menu/list/pdv`.
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
