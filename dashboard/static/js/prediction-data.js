/* Prediction data adapter: absent sources stay empty until data is connected. */
const DAY = 86400000;
const ZONE_OFFSET = 8 * 3600000;

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

export function predictionData(src = {}, generatedAt) {
  const source = src.prediction || {};
  const parsed = parsePredictionTime(source.as_of ?? generatedAt);
  const asOf = Math.floor((Number.isFinite(parsed) ? parsed : Date.now()) / 60000) * 60000;
  const hasQuestions = Array.isArray(source.questions);
  return {
    asOf,
    hasQuestions,
    questions: (hasQuestions ? source.questions : []).filter((question) => question && typeof question === "object").map((question, index) => ({
      id: String(question.id ?? index),
      category: String(question.category || "未分类"),
      answerAt: parsePredictionTime(question.answer_at),
    })),
    accuracy: normalizeAccuracy(source.accuracy),
    attribution: source.attribution || null,
  };
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
  const times = data.questions.length ? [...new Set([start, ...buckets.keys(), at])].sort((a, b) => a - b) : [];
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
    hasQuestions: data.hasQuestions,
    distribution,
    cumulative,
    accuracy,
    attribution: data.attribution,
  };
}
