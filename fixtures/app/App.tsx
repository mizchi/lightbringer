import {
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

const get = (q: string) => fetch(`/api/slow?ms=150&${q}`).then((r) => r.text());

// Scenario 5: N+1 — fetch a list, then one request per item. Fix with a batch
// endpoint (one request). Lights up requestCount and waves.
function NPlusOne({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const run = async () => {
    setStatus("loading");
    await get("list");
    if (fixed) {
      await get("batch=0,1,2,3,4");
    } else {
      for (let i = 0; i < 5; i++) await get(`item=${i}`);
    }
    setStatus("done");
  };
  return (
    <main>
      <h1>n+1 {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="load" type="button" onClick={run}>
        load
      </button>
      <div id="status">{status}</div>
    </main>
  );
}

// Scenario 6: dependent chain — each request needs the previous result, so it
// can't be parallelized. Fix with a single combined endpoint. Lights up waves.
function Chain({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const run = async () => {
    setStatus("loading");
    if (fixed) {
      await get("combined");
    } else {
      let prev = "";
      for (let i = 0; i < 4; i++) prev = await get(`step=${i}&after=${prev}`);
    }
    setStatus("done");
  };
  return (
    <main>
      <h1>chain {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="load" type="button" onClick={run}>
        load
      </button>
      <div id="status">{status}</div>
    </main>
  );
}

// Scenario 7: huge DOM — rendering tens of thousands of nodes makes style/layout
// expensive. Fix: windowing/pagination (render only what's visible). Lights up
// render.nodes (and layout/style cost).
function HugeDom({ fixed }: { fixed: boolean }) {
  const [show, setShow] = useState(false);
  const n = fixed ? 100 : 30000;
  return (
    <main>
      <h1>huge-dom {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="render" type="button" onClick={() => setShow(true)}>
        render
      </button>
      <div id="status">{show ? "done" : "idle"}</div>
      {show && (
        <ul>
          {Array.from({ length: n }, (_, i) => (
            <li key={i}>row {i}</li>
          ))}
        </ul>
      )}
    </main>
  );
}

// Scenario 9: paint-bound animation. slow animates box-shadow on a big element
// every frame (repaints a large area, no layout). fixed animates transform
// (compositor-only, no paint). Lights up render.paintCount / paintMs (PERF_TRACE).
function Paint({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const ref = useRef<HTMLDivElement>(null);
  const run = () => {
    setStatus("running");
    const el = ref.current;
    if (!el) return;
    const start = performance.now();
    const step = () => {
      const t = performance.now() - start;
      if (fixed) {
        el.style.transform = `translateX(${(t / 8) % 200}px)`; // composited, no paint
      } else {
        el.style.boxShadow = `0 0 ${(t / 8) % 120}px 20px rgba(0,0,0,0.6)`; // repaints
      }
      if (t < 800) requestAnimationFrame(step);
      else setStatus("done");
    };
    requestAnimationFrame(step);
  };
  return (
    <main>
      <h1>paint {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="run" type="button" onClick={run}>
        animate
      </button>
      <div id="status">{status}</div>
      <div ref={ref} style={{ width: 600, height: 600, background: "#88f" }} />
    </main>
  );
}

// Scenario 8: layout shift (CLS). A banner is inserted at the top ~400ms after
// load, pushing content down. Fix: reserve the space up front so nothing shifts.
// Lights up vitals.CLS (visual stability — orthogonal to CPU/network/render).
function Cls({ fixed }: { fixed: boolean }) {
  const [banner, setBanner] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setBanner(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <main>
      {/* slow: height grows 0 -> 120 when the banner arrives (shift). fixed: the
          space is reserved from the start, so the banner fills it with no shift. */}
      <div style={{ minHeight: fixed ? 500 : banner ? 500 : 0 }}>
        {banner && (
          <div id="banner" style={{ height: 500, background: "#ccc" }}>
            late banner
          </div>
        )}
      </div>
      <h1 id="content">content</h1>
      {Array.from({ length: 30 }, (_, i) => (
        <p key={i}>line {i}</p>
      ))}
    </main>
  );
}

// Scenario 11: third-party scripts. slow loads analytics / ad / tag-manager
// scripts from a different origin (127.0.0.1 vs the page's localhost) that the
// app didn't ship — extra bytes, network time, and CPU. fixed loads none. The
// cost surfaces under network.thirdParty (and the drilldown's third-party self
// time), separated from first-party app code.
const TP = "http://127.0.0.1:5173/3p"; // cross-origin to the page (localhost)
function loadScript(src: string): Promise<void> {
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => resolve();
    document.head.appendChild(el);
  });
}
function ThirdParty({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const run = async () => {
    setStatus("loading");
    if (!fixed) {
      await Promise.all([
        loadScript(`${TP}/tag.js?name=analytics&ms=120&bytes=80000&cpu=40000000`),
        loadScript(`${TP}/tag.js?name=ads&ms=200&bytes=150000&cpu=70000000`),
        loadScript(`${TP}/tag.js?name=tagmanager&ms=60&bytes=40000&cpu=20000000`),
      ]);
      void fetch(`${TP}/beacon?e=pageview`, { mode: "no-cors" }).catch(() => {});
    }
    setStatus("done");
  };
  return (
    <main>
      <h1>third-party {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="load" type="button" onClick={run}>
        load
      </button>
      <div id="status">{status}</div>
    </main>
  );
}

// Scenario 12: heavy data — stresses lightbringer's own data handling, not the
// app. On click it (a) fires many concurrent requests (a large per-span request
// set) and (b) emits a flood of performance.mark()s, which become a huge batch
// of trace events. Used to verify the collector survives large Playwright/CDP
// payloads (the dataCollected batch alone can exceed the spread-call arg limit)
// and doesn't bloat the report. ?fixed does a small amount.
function Stress({ fixed }: { fixed: boolean }) {
  const [status, setStatus] = useState("idle");
  const run = async () => {
    setStatus("running");
    const reqCount = fixed ? 5 : 600;
    const markCount = fixed ? 100 : 150_000;
    // a flood of user-timing entries -> a large trace event batch
    for (let i = 0; i < markCount; i++) performance.mark(`m${i}`);
    await Promise.all(
      Array.from({ length: reqCount }, (_, i) =>
        fetch(`/api/slow?ms=0&i=${i}`).then((r) => r.text()),
      ),
    );
    setStatus("done");
  };
  return (
    <main>
      <h1>stress {fixed ? "(fixed)" : "(slow)"}</h1>
      <button id="load" type="button" onClick={run}>
        load
      </button>
      <div id="status">{status}</div>
    </main>
  );
}

// ===========================================================================
// Initialization bucket: resource problems on the scenario's initial load.
// Each shows a "ready" marker only once init is done, so the initial-load span
// captures the full init cost.
// ===========================================================================

// init-eager: expensive work done eagerly at boot that isn't needed for the
// initial view. Fix: don't do it at init (compute lazily, on demand). Deferring
// to idle would NOT help — it reschedules the work without reducing init resource
// use; the responsibility is to not spend the resource at init at all.
// (result is rendered so V8 can't dead-code-eliminate the work.)
function InitEager({ fixed }: { fixed: boolean }) {
  const [out, setOut] = useState(0);
  useEffect(() => {
    if (!fixed) setOut(expensiveValue(1, 1_500_000_000));
  }, [fixed]);
  return (
    <main>
      <div id="ready">ready</div>
      <span hidden>{out}</span>
    </main>
  );
}

// init-waterfall: boot fetches awaited one-by-one (fetch-on-render). Fix: parallel.
function InitWaterfall({ fixed }: { fixed: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      if (fixed) {
        await Promise.all([get("a"), get("b"), get("c")]);
      } else {
        await get("a");
        await get("b");
        await get("c");
      }
      setReady(true);
    })();
  }, [fixed]);
  return <div id="ready">{ready ? "ready" : "loading"}</div>;
}

// init-reflow: a mount layout effect forces a reflow per element. Fix: batch.
const INIT_REFLOW_N = 2000;
function InitReflow({ fixed }: { fixed: boolean }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(".init-item"),
    );
    if (fixed) {
      items.forEach((el, i) => (el.style.width = `${100 + (i % 40)}px`));
      const hs = items.map((el) => el.offsetHeight);
      items.forEach((el, i) => (el.dataset.h = String(hs[i])));
    } else {
      items.forEach((el, i) => {
        el.style.width = `${100 + (i % 40)}px`;
        el.dataset.h = String(el.offsetHeight);
      });
    }
    setReady(true);
  }, [fixed]);
  return (
    <main>
      <div id="ready">{ready ? "ready" : "loading"}</div>
      {Array.from({ length: INIT_REFLOW_N }, (_, i) => (
        <div key={i} className="init-item" style={{ height: 8 }}>
          {i}
        </div>
      ))}
    </main>
  );
}

export function App() {
  const p = params();
  const fixed = p.has("fixed");
  switch (p.get("scenario")) {
    case "init-eager":
      return <InitEager fixed={fixed} />;
    case "init-waterfall":
      return <InitWaterfall fixed={fixed} />;
    case "init-reflow":
      return <InitReflow fixed={fixed} />;
    case "reflow":
      return <Reflow fixed={fixed} />;
    case "input":
      return <InputFilter fixed={fixed} />;
    case "network":
      return <Network fixed={fixed} />;
    case "nplus1":
      return <NPlusOne fixed={fixed} />;
    case "chain":
      return <Chain fixed={fixed} />;
    case "huge-dom":
      return <HugeDom fixed={fixed} />;
    case "cls":
      return <Cls fixed={fixed} />;
    case "paint":
      return <Paint fixed={fixed} />;
    case "thirdparty":
      return <ThirdParty fixed={fixed} />;
    case "stress":
      return <Stress fixed={fixed} />;
    default:
      return <Rerender fixed={fixed} />;
  }
}
