import { memo, useDeferredValue, useMemo, useState } from "react";

const params = () => new URLSearchParams(location.search);

function expensiveValue(seed: number, cost: number): number {
  let s = 0;
  for (let i = 0; i < cost; i++) s += Math.sqrt(i + seed);
  return Math.round(s);
}

// ---------------------------------------------------------------------------
// Scenario 1: unnecessary re-render — fix with React.memo. Lights up scriptMs.
// ---------------------------------------------------------------------------
function Row({ index }: { index: number }) {
  return (
    <li>
      row {index}: {expensiveValue(index, 4000)}
    </li>
  );
}
function HeavyListImpl({ size }: { size: number }) {
  return (
    <ul>
      {Array.from({ length: size }, (_, i) => (
        <Row key={i} index={i} />
      ))}
    </ul>
  );
}
const HeavyListMemo = memo(HeavyListImpl);

function Rerender({ fixed }: { fixed: boolean }) {
  const [n, setN] = useState(0);
  const List = fixed ? HeavyListMemo : HeavyListImpl;
  return (
    <main>
      <h1>rerender {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="inc" type="button" onClick={() => setN((v) => v + 1)}>
        +1
      </button>
      <span id="count">{n}</span>
      <List size={8000} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Scenario 2: forced synchronous layout (reflow thrash) — fix by batching
// reads then writes. Lights up render.layoutCount / layoutMs.
// ---------------------------------------------------------------------------
const REFLOW_N = 2000;
function Reflow({ fixed }: { fixed: boolean }) {
  const run = () => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".reflow-item"),
    );
    if (fixed) {
      // batch: all writes, then all reads -> layout computed once
      items.forEach((el, i) => {
        el.style.width = `${100 + (i % 40)}px`;
      });
      const heights = items.map((el) => el.offsetHeight);
      items.forEach((el, i) => (el.dataset.h = String(heights[i])));
    } else {
      // thrash: write then read each iteration -> forced sync layout every time
      items.forEach((el, i) => {
        el.style.width = `${100 + (i % 40)}px`;
        el.dataset.h = String(el.offsetHeight);
      });
    }
  };
  return (
    <main>
      <h1>reflow {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="thrash" type="button" onClick={run}>
        reflow
      </button>
      <div id="done">ready</div>
      {Array.from({ length: REFLOW_N }, (_, i) => (
        <div key={i} className="reflow-item" style={{ height: 8 }}>
          {i}
        </div>
      ))}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: expensive synchronous work on every keystroke — fix with
// useDeferredValue so typing stays responsive. Lights up INP.
// ---------------------------------------------------------------------------
function InputFilter({ fixed }: { fixed: boolean }) {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q);
  const listQuery = fixed ? deferred : q;
  // A fixed, heavy synchronous compute per render. Slow: runs on every keystroke
  // (blocks key->paint => high INP). Fixed: useDeferredValue runs it in a
  // low-priority render so the input stays responsive (low INP).
  const heavy = useMemo(
    () => expensiveValue(listQuery.length, 120_000_000),
    [listQuery],
  );
  return (
    <main>
      <h1>input {fixed ? "(fixed)" : "(slow)"}</h1>
      <input
        id="q"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="filter"
      />
      <div id="rowcount">{heavy}</div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Scenario 4: serial request waterfall — fix by parallelizing. Lights up
// network.waves / busyMs (no CPU cost involved).
// ---------------------------------------------------------------------------
function Network({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const load = async () => {
    setStatus("loading");
    const urls = [1, 2, 3, 4].map((id) => `/api/slow?ms=200&id=${id}`);
    if (fixed) {
      await Promise.all(urls.map((u) => fetch(u).then((r) => r.text())));
    } else {
      for (const u of urls) await fetch(u).then((r) => r.text());
    }
    setStatus("done");
  };
  return (
    <main>
      <h1>network {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="load" type="button" onClick={load}>
        load
      </button>
      <div id="status">{status}</div>
    </main>
  );
}

export function App() {
  const p = params();
  const fixed = p.has("fixed");
  switch (p.get("scenario")) {
    case "reflow":
      return <Reflow fixed={fixed} />;
    case "input":
      return <InputFilter fixed={fixed} />;
    case "network":
      return <Network fixed={fixed} />;
    default:
      return <Rerender fixed={fixed} />;
  }
}
