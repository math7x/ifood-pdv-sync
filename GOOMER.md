# PDV Sync 1.4.1 — três plataformas

A mesma extensão detecta iFood, 99Food e Goomer. Os adaptadores originais de iFood e 99Food foram preservados. A Goomer usa o mesmo `matching.js` para comparar nomes, tamanhos, volumes e grupos, com os mesmos limites de confiança (0,72 / 0,40).

## Goomer

1. Recarregue a extensão em `brave://extensions` e depois atualize o cardápio da Goomer.
2. Abra a extensão, importe o Excel da Saipos e clique em verificar.
3. Revise as abas Produtos pai e Complementos. As seções separam alta confiança, revisão, baixa confiança e já corretos.
4. Pesquise pelo nome ou cole um código do Excel. Todos os produtos pai elegíveis ficam disponíveis; complementos são filtrados pelos códigos pai atuais dos produtos vinculados, sem excluir códigos já utilizados.
5. Aplique somente os selecionados na aba visível. Se corrigiu códigos pai, faça outra leitura antes de revisar complementos.

Modelos de opcionais compartilhados são gravados uma vez e exigem seleção manual quando aparecem vinculados a vários produtos. Uma alteração nesses modelos afeta os outros usos do mesmo modelo.

A leitura não grava nada. Na aplicação, a extensão relê o formulário, verifica se o PDV não mudou desde a leitura, envia ao formulário de atualização e relê o servidor para conferir o valor. Mudanças de estrutura, sessão expirada ou campos não reconhecidos interrompem a operação com erro explícito.

## Validação e limites

Testes locais usam formulários simulados e não alteram lojas reais. Não equivalem a uma validação do salvamento na loja Goomer. Na primeira utilização, aplique um único item e confira no painel antes de usar em lote. O cadastro automático de novos produtos Saipos da revisão iFood não foi incluído na revisão Goomer.
