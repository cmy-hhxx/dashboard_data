/* Data-only hierarchy normalization and navigation, shared by every ring card. */
export function classificationHierarchy(input = {}, product) {
  const categories = input.categories || {};
  if (categories.tree && typeof categories.tree === "object") {
    const tree = Array.isArray(categories.tree) ? { children: categories.tree } : categories.tree;
    return { ...tree, name: tree.name || "全部分类", value: input.total ?? tree.value };
  }
  const valueOf = (node) => {
    const supplied = node.value ?? node.sessions;
    return supplied != null && Number.isFinite(Number(supplied))
      ? Math.max(0, Number(supplied))
      : (node.children || []).reduce((sum, child) => sum + valueOf(child), 0);
  };
  let tasks = (categories.task || []).filter((node) => node.name !== "未标注").map((node) => ({ ...node }));
  if (product === "wencai") tasks = tasks.filter((node) => !["其他", "其它"].includes(node.name));
  else {
    const other = tasks.find((node) => node.name === "其他");
    const alias = tasks.find((node) => node.name === "其它");
    if (alias) {
      if (other) {
        other.value = valueOf(other) + valueOf(alias);
        if (other.children || alias.children) other.children = [...(other.children || []), ...(alias.children || [])];
      } else tasks.push({ ...alias, name: "其他" });
      tasks = tasks.filter((node) => node.name !== "其它");
    }
  }
  return {
    name: "全部分类",
    value: input.total ?? tasks.reduce((sum, task) => sum + valueOf(task), 0),
    children: tasks.map((task) => {
      // Preserve every supplied level. Only the legacy flat schema needs adapting.
      if (Array.isArray(task.children)) return task;
      const children = (categories.task_subtask?.[task.name] || [])
        .filter((node) => node.name !== "未标注" && valueOf(node) > 0)
        .map((node) => ({ ...node }));
      const sum = children.reduce((total, child) => total + valueOf(child), 0);
      if (children.length && valueOf(task) > sum) {
        children.push({ name: children.some((node) => node.name === "其他") ? "其余" : "其他", value: valueOf(task) - sum });
      }
      return { ...task, children };
    }),
  };
}

export function normalizeHierarchy(source) {
  function visit(raw, parentKey, depth) {
    const name = String(raw.name ?? "未命名");
    // Paths disambiguate repeated names/IDs in different branches and survive reordering.
    const segment = raw.key ?? raw.id ?? name;
    const key = `${parentKey}/${encodeURIComponent(String(segment))}`;
    const children = (Array.isArray(raw.children) ? raw.children : [])
      .filter((child) => child && typeof child === "object")
      .map((child) => visit(child, key, depth + 1))
      .filter((child) => child.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "zh-Hans-CN"));
    const supplied = raw.value ?? raw.sessions;
    const value = supplied != null && Number.isFinite(Number(supplied))
      ? Math.max(0, Number(supplied))
      : children.reduce((sum, child) => sum + child.value, 0);
    const items = Number(raw.items ?? raw.count);
    return {
      key, name, value, depth, children,
      items: Number.isFinite(items) ? Math.max(0, items) : children.reduce((sum, child) => sum + child.items, 0),
    };
  }
  const root = visit(source || { name: "全部", value: 0 }, "", 0);
  function shares(node) {
    const sum = node.children.reduce((total, child) => total + child.value, 0);
    node.children.forEach((child) => {
      child.share = sum ? child.value / sum * 100 : 0;
      shares(child);
    });
  }
  root.share = 100;
  shares(root);
  return root;
}

export function hierarchyDepth(root) {
  return root.children.length ? 1 + Math.max(...root.children.map(hierarchyDepth)) : 0;
}

export function createHierarchyState(initialRoot) {
  let root = initialRoot;
  let currentKey = root.key;
  let expandedKey = "";
  let paths = new Map();
  function index() {
    paths = new Map();
    function walk(node, trail) {
      paths.set(node.key, [...trail, node]);
      node.children.forEach((child) => walk(child, [...trail, node]));
    }
    walk(root, []);
  }
  function snapshot() {
    const path = paths.get(currentKey) || [root];
    const current = path.at(-1);
    const expanded = current.children.find((child) => child.key === expandedKey) || null;
    return { root, current, expanded, path, canBack: Boolean(expanded) || path.length > 1 };
  }
  index();
  return {
    snapshot,
    update(nextRoot) {
      root = nextRoot;
      index();
      const current = paths.get(currentKey)?.at(-1);
      if (!current || !current.children.length) currentKey = root.key;
      if (!snapshot().expanded) expandedKey = "";
      return snapshot();
    },
    select(key) {
      const { current, expanded } = snapshot();
      const base = current.children.find((child) => child.key === key);
      if (base?.children.length) {
        expandedKey = expandedKey === key ? "" : key;
        return true;
      }
      const child = expanded?.children.find((node) => node.key === key);
      if (!child?.children.length) return false;
      currentKey = child.key;
      expandedKey = "";
      return true;
    },
    back() {
      const { path } = snapshot();
      if (expandedKey) expandedKey = "";
      else if (path.length > 1) currentKey = path.at(-2).key;
      else return false;
      return true;
    },
  };
}
