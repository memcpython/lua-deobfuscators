function applyEdits(source, edits) {
  if (!edits || edits.length === 0) return { code: source, applied: 0 };
  const normalized = edits
    .filter(e => e && Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end >= e.start)
    .map((e, i) => ({ ...e, order: i, text: e.text == null ? '' : String(e.text) }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);

  const accepted = [];
  let rightBoundary = source.length + 1;
  for (const edit of normalized) {
    if (edit.end > rightBoundary) continue;
    accepted.push(edit);
    rightBoundary = edit.start;
  }

  let out = source;
  for (const edit of accepted) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { code: out, applied: accepted.length };
}

function replaceNode(node, text, reason) {
  return { start: node.start, end: node.end, text, reason };
}

function removeNode(node, reason) {
  return { start: node.start, end: node.end, text: '', reason };
}

module.exports = { applyEdits, replaceNode, removeNode };

// Keep the widest edits first when ranges nest. Useful for expression folding.
function selectOutermost(edits) {
  const sorted = [...edits].sort((a,b) => (b.end-b.start)-(a.end-a.start) || a.start-b.start);
  const chosen=[];
  for(const e of sorted){ if(chosen.some(c => e.start >= c.start && e.end <= c.end)) continue; chosen.push(e); }
  return chosen;
}

module.exports.selectOutermost = selectOutermost;
