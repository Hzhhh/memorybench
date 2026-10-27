// update.mjs — atlas update_detector 的 JS 移植（零 LLM，纯规则）
// 门控三重：①query 值期望 ②句含 UPDATE_MARKERS + 值 ③主题词重叠 ≥2
// 输出：最新值所在轮的索引（按写入顺序=时间序取最后一个命中）

const UPDATE_MARKERS = new RegExp(
  '\\b(actually|now|updated?|changed?|reschedul\\w*|no longer|previously|' +
  'instead of|decided to|switch(?:ed)?(?: to)?|moved to|revised|' +
  'new (?:target|goal|deadline|date|schedule|budget|number|total)|' +
  'bumped|increased to|decreased to|reduced to|raised to|lowered to|' +
  'cut (?:it|down) to|upped? (?:it|to)|set (?:it|the \\w+) to|adjusted to|' +
  'final(?:ly)? (?:date|deadline|target)|as of (?:now|today))\\b', 'i')

const VALUE_RE = new RegExp(
  '(\\$?\\d[\\d,.]*\\s*(?:%|k|hours?|hrs?|words?|dollars?|bucks?|miles?|km|minutes?|mins?|days?|weeks?|months?|years?)?|' +
  '\\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2}\\b|' +
  '\\b\\d{1,2}:\\d{2}\\s?(?:AM|PM|am|pm)?\\b)')

const VALUE_EXPECT = new RegExp(
  '\\b(how\\s+many|how\\s+much|how\\s+long|what\\s+is|what\\s+are|what\\s+was|' +
  'when\\s+is|when\\s+was|when\\s+does|when\\s+did|which\\s+\\w+|do\\s+i|am\\s+i|' +
  'have\\s+i|is\\s+my|are\\s+my|was\\s+my|what(?:\'s| is)\\s+my|current|latest|' +
  'target|budget|deadline|total)\\b', 'i')

const STOP = new Set(('actually now updated changed rescheduled longer previously instead decided ' +
  'switched moved revised bumped increased decreased reduced raised lowered adjusted finally ' +
  'will would have has had the a an and or but for with about from this that these those your ' +
  'you i we they it its was were is are been said says just really very much more most some any ' +
  'all can could should may might want wanted think thought know knew like love enjoy prefer ' +
  'favorite thing things time today tomorrow yesterday one two three four five six seven eight nine ten ' +
  'what which who whom whose when where why how').split(/\s+/))

function stem(w) {
  for (const [suf, fix] of [['ies', 'y'], ['ing', ''], ['ed', ''], ['ly', ''], ['es', ''], ['s', '']]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf) + fix
  }
  return w
}

function topicWords(s) {
  const out = new Set()
  for (const w of String(s ?? '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
    if (STOP.has(w)) continue
    out.add(stem(w))
  }
  return out
}

/**
 * 找 query 主题对应的"最新值"轮（写入顺序最靠后的 marker+value+主题重叠命中轮）。
 * @returns {number|null} turns 数组索引
 */
export function findLatestUpdateTurn(query, turns) {
  if (!VALUE_EXPECT.test(query)) return null
  const qTopic = topicWords(query)
  if (qTopic.size < 1) return null
  let best = null
  for (let i = 0; i < turns.length; i++) {
    const c = turns[i].content ?? ''
    if (!UPDATE_MARKERS.test(c) || !VALUE_RE.test(c)) continue
    const tw = topicWords(c)
    let overlap = 0
    for (const w of qTopic) if (tw.has(w)) overlap++
    if (overlap >= 2) best = i // 保留最后命中（时间序最新）
  }
  return best
}
