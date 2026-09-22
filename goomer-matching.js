/* Uses the same name scoring and confidence thresholds as iFood. */
globalThis.GoomerMatching = (() => {
  const str = v => String(v == null ? '' : v).trim();
  const equal = (a,b) => str(a).toLowerCase() === str(b).toLowerCase();
  function catalogs(raw) {
    const active = raw.filter(r => str(r.Inativo).toUpperCase() !== 'INATIVO');
    const parents = new Map(), comps = [];
    for (const r of active) {
      const code = str(r['Código Saipos']);
      if (!code) continue;
      if (str(r.Tipo).toUpperCase() === 'COMPLEMENTO') {
        const pdv = ifpsBuildIfoodCode(code);
        if (pdv) comps.push({code:pdv, name:str(r.Complemento), category:str(r.Categoria), parent:ifpsParentCode(code), description:str(r['Descrição'])});
      } else if (!code.includes('.')) {
        parents.set(code, {code, name:str(r['Descrição']), category:str(r.Categoria)});
      }
    }
    return {parents:[...parents.values()], comps};
  }
  function category(s) {
    const n = ifpsNormalize(s);
    if (/\bMASSAS?\b/.test(n) && !/\bBORDAS?\b/.test(n)) return 'massa';
    return ifpsCategoryOf(s);
  }
  function primaryOptionName(s) {
    const primary = str(s).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return primary || str(s);
  }
  function parentScore(row, candidate) {
    const ctx = row.contexts[0] || {};
    const category1 = ctx.category1 || '';
    const category2 = ctx.category2 || ctx.category || '';
    const primaryCategory = ifpsProductCategoryOf(category2) === 'adicional' ? category2 : category1;
    const fullName = category2 && !equal(category2, row.name) ? `${category2} ${row.name}` : row.name;
    const nameScore = Math.max(ifpsScoreProduto(row.name, candidate.name), ifpsScoreProduto(fullName, candidate.name));
    const base = nameScore + ifpsScoreProdutoCategoria(primaryCategory, candidate.category);
    const second = ifpsScoreProdutoCategoria(category2, candidate.category);
    const total = Math.max(0, base + second);
    return nameScore < IFPS_CONFIDENCE.MEDIUM ? Math.min(total, nameScore) : total;
  }
  function score(row, candidate) {
    if (row.kind === 'parent') return parentScore(row, candidate);
    const parsed = ifpsParseComplementoField(candidate.name);
    const a = category(parsed.hint), b = category(row.group);
    if (a && b && a !== b) return 0;
    return ifpsScoreMatch(parsed, primaryOptionName(row.name), row.group, ifpsSizeWordTag(row.contexts[0]?.name || ''));
  }
  function match(row, catalog) {
    const parentCodes = new Set(row.contexts.map(c => c.code).filter(Boolean));
    let choices = row.kind === 'parent' ? catalog.parents : catalog.comps.filter(c => parentCodes.has(c.parent));
    // All eligible Excel options remain searchable, including already used codes.
    choices = [...new Map(choices.map(c => [c.code,c])).values()];
    const ranked = choices.map(c => ({...c, score:score(row,c)})).sort((a,b) => b.score-a.score);
    const best = ranked[0], current = ranked.find(c => equal(c.code,row.current));
    const currentNameScore = current
      ? row.kind === 'parent'
        ? parentScore(row, current)
        : ifpsScoreMatch(ifpsParseComplementoField(current.name), primaryOptionName(row.name), '', ifpsSizeWordTag(row.contexts[0]?.name || ''))
      : 0;
    const correct = current && (current === best || currentNameScore >= IFPS_CONFIDENCE.HIGH || (current.score >= IFPS_CONFIDENCE.HIGH && best.score-current.score < .15));
    const chosen = correct ? current : best?.score >= IFPS_CONFIDENCE.MEDIUM ? best : null;
    const shared = row.kind !== 'parent' && row.contexts.length > 1;
    let confidence = correct ? 'correto' : ifpsClassify(chosen?.score || 0);
    const ambiguous = chosen && ranked.some(c => c.code !== chosen.code && Math.abs(c.score-chosen.score) < .08);
    if (confidence === 'alta' && (shared || ambiguous)) confidence = 'media';
    return {...row, choices:choices.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')), code:chosen?.code || '',
      suggested:chosen?.name || '', score:ifpsDisplayScore(chosen?.score || 0), confidence, shared,
      note:shared ? 'Grupo compartilhado: a alteração pode afetar outros produtos que usam este modelo.' :
        !choices.length && row.kind !== 'parent' ? 'Confira/aplique primeiro os códigos pai e depois leia o cardápio novamente.' : ''};
  }
  return {catalogs, match, equal};
})();
