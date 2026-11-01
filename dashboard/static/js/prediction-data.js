/* Prediction data adapter. The fallback bank and accuracy records are example data. */
const DAY = 86400000;
const ZONE_OFFSET = 8 * 3600000;
const DEMO_CURVES = {
  wencai: {
    a_expert: [58, 61, 60, 64, 66, 68, 71, 74],
    a_fast: [55, 57, 59, 58, 62, 64, 65, 69],
    b_expert: [52, 55, 54, 58, 57, 61, 63, 66],
    b_fast: [49, 51, 52, 54, 56, 55, 58, 60],
  },
  aime: {
    fast: [63, 65, 64, 68, 70, 69, 72, 74],
    expert: [67, 69, 71, 70, 74, 76, 75, 78],
  },
};
const DEMO_ERRORS = ["方向错误", "依据不足", "数值偏差", "时点错配"];

export function parsePredictionTime(value) {
  if (value == null || value === "") return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  let text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T23:59:59.999+08:00";
  else if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += "+08:00";
  return Date.parse(text);
}

function parts(at) {
  const date = new Date(at + ZONE_OFFSET);
  const pad = (value) => String(value).padStart(2, "0");
  return {
    day: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  };
}

export function predictionInputValue(at) {
  const value = parts(at);
  return `${value.day}T${value.time}`;
}

export function predictionTimeLabel(at, full = false) {
  const value = parts(Number(at));
  return full ? `${value.day} ${value.time}` : value.day.slice(5).replace("-", "/");
}

function endOfDay(at) {
  return Math.floor((at + ZONE_OFFSET) / DAY) * DAY - ZONE_OFFSET + DAY - 1;
}

function normalizeAccuracy(rows) {
  const records = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row || typeof row !== "object") return;
    const at = parsePredictionTime(row.at ?? row.date);
    const model = String(row.model || "");
    if (!model || !Number.isFinite(at)) return;
    const total = Number(row.total);
    const correct = Number(row.correct);
    const counted = Number.isFinite(total) && total > 0 && Number.isFinite(correct) && correct >= 0 && correct <= total;
    const accuracy = counted ? correct / total * 100 : Number(row.accuracy);
    if ((!counted && (row.accuracy == null || row.accuracy === "")) || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100) return;
    const key = `${model}/${at}`;
    const previous = records.get(key);
    if (counted && previous && previous.total != null) {
      previous.total += total;
      previous.correct += correct;
      previous.accuracy = previous.correct / previous.total * 100;
    } else {
      records.set(key, { model, at, accuracy, total: counted ? total : null, correct: counted ? correct : null });
    }
  });
  return [...records.values()].sort((a, b) => a.at - b.at);
}

function demoData(src, product, asOf) {
  const categories = ((src.input && src.input.categories && src.input.categories.task) || [])
    .filter((item) => item.name && Number(item.value) > 0);
  if (!categories.length) categories.push({ name: "未分类", value: 1 });
  const weight = categories.reduce((sum, item) => sum + Number(item.value), 0);
  const start = asOf - 14 * DAY;
  const questions = Array.from({ length: 1000 }, (_, index) => {
    let pick = ((index * 73) % 1000) / 1000 * weight;
    const category = categories.find((item) => (pick -= Number(item.value)) < 0) || categories[categories.length - 1];
    return {
      id: `example-${index + 1}`,
      category: category.name,
      answer_at: start + Math.floor(((index * 193) % 1000) / 999 * 42 * 24 * 60) * 60000,
    };
  });
  const accuracy = [];
  Object.entries(DEMO_CURVES[product] || DEMO_CURVES.wencai).forEach(([model, values]) => {
    for (let index = 0; index < 14; index += 1) {
      const at = Math.min(asOf, endOfDay(asOf - (13 - index) * DAY));
      const total = questions.filter((question) => question.answer_at <= at).length;
      const position = index / 13 * (values.length - 1);
      const left = Math.floor(position);
      const rate = values[left] + (values[Math.min(left + 1, values.length - 1)] - values[left]) * (position - left);
      accuracy.push({ model, at, total, correct: Math.round(total * rate / 100) });
    }
  });
  return { questions, accuracy };
}

export function predictionData(src = {}, product = "wencai", generatedAt) {
  const source = src.prediction || {};
  const parsed = parsePredictionTime(source.as_of ?? generatedAt);
  const asOf = Math.floor((Number.isFinite(parsed) ? parsed : Date.now()) / 60000) * 60000;
  const prototype = !Array.isArray(source.questions);
  const raw = prototype ? demoData(src, product, asOf) : source;
  return {
    asOf,
    prototype,
    questions: raw.questions.filter((question) => question && typeof question === "object").map((question, index) => ({
      id: String(question.id ?? index),
      category: String(question.category || "未分类"),
      answerAt: parsePredictionTime(question.answer_at),
    })),
    accuracy: normalizeAccuracy(raw.accuracy),
    attribution: source.attribution || null,
  };
}

function exampleAttribution(curves) {
  const models = curves.map((curve) => curve.key);
  const flows = Object.fromEntries(curves.map((curve) => {
    const last = curve.points[curve.points.length - 1];
    const errors = last && last.total != null ? last.total - last.correct : 0;
    const first = Math.floor(errors * 0.4);
    const second = Math.floor(errors * 0.3);
    const third = Math.floor(errors * 0.2);
    return [curve.key, [first, second, third, errors - first - second - third]];
  }));
  return { models, errors: DEMO_ERRORS, flows };
}

export function predictionSnapshot(data, cutoff = data.asOf) {
  const parsed = typeof cutoff === "number" ? cutoff : parsePredictionTime(cutoff);
  const at = Number.isFinite(parsed) ? parsed : data.asOf;
  const totals = new Map();
  data.questions.forEach((question) => totals.set(question.category, (totals.get(question.category) || 0) + 1));
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const top = new Set(ranked.slice(0, ranked.length > 5 ? 4 : 5).map(([name]) => name));
  const groupFor = (question) => top.has(question.category) ? question.category : "其他";
  const groups = [...top];
  if (ranked.length > top.size && !groups.includes("其他")) groups.push("其他");
  const counts = new Map(groups.map((name) => [name, 0]));
  const buckets = new Map();
  let earliest = Infinity;
  let available = 0;
  let scheduled = 0;
  data.questions.forEach((question) => {
    if (!Number.isFinite(question.answerAt)) return;
    scheduled += 1;
    earliest = Math.min(earliest, question.answerAt);
    if (question.answerAt > at) return;
    available += 1;
    const category = groupFor(question);
    counts.set(category, (counts.get(category) || 0) + 1);
    const time = question.answerAt;
    if (!buckets.has(time)) buckets.set(time, new Map());
    const bucket = buckets.get(time);
    bucket.set(category, (bucket.get(category) || 0) + 1);
  });
  const start = Math.min(Number.isFinite(earliest) ? earliest : at, at) - DAY;
  const times = [...new Set([start, ...buckets.keys(), at])].sort((a, b) => a - b);
  const running = new Map(groups.map((name) => [name, 0]));
  const distribution = groups.map((name) => ({ name, value: counts.get(name) || 0, values: [] }));
  const cumulative = [];
  times.forEach((time) => {
    (buckets.get(time) || new Map()).forEach((value, category) => running.set(category, (running.get(category) || 0) + value));
    distribution.forEach((series) => series.values.push([time, running.get(series.name) || 0]));
    cumulative.push([time, [...running.values()].reduce((sum, value) => sum + value, 0)]);
  });
  const byModel = new Map();
  data.accuracy.filter((row) => row.at <= Math.min(at, data.asOf)).forEach((row) => {
    if (!byModel.has(row.model)) byModel.set(row.model, []);
    byModel.get(row.model).push(row);
  });
  const accuracy = [...byModel].map(([key, points]) => ({ key, points }));
  return {
    cutoff: at,
    total: data.questions.length,
    available,
    scheduled,
    pending: data.questions.length - available,
    prototype: data.prototype,
    distribution,
    cumulative,
    accuracy,
    attribution: data.prototype ? exampleAttribution(accuracy) : data.attribution,
  };
}
