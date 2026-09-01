/* ============================================================
   ZZ Geo Landing — 交互逻辑（原生 JS，零依赖）
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. 导航：滚动变实心 + 移动端菜单 ---------- */
  var nav = document.getElementById("nav");
  var burger = document.getElementById("navBurger");
  var navLinks = document.getElementById("navLinks");

  function onScroll() {
    if (window.scrollY > 24) nav.classList.add("solid");
    else nav.classList.remove("solid");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  burger.addEventListener("click", function () {
    var open = navLinks.classList.toggle("open");
    burger.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  });
  navLinks.addEventListener("click", function (e) {
    if (e.target.tagName === "A") {
      navLinks.classList.remove("open");
      burger.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
    }
  });

  /* ---------- 2. 滚动渐入（IntersectionObserver，同区块子项递增 80ms stagger） ---------- */
  var revealEls = document.querySelectorAll(".reveal, .steps, .compare-grid");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("visible", "shown"); });
  } else {
    var revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          var sibs = el.parentElement
            ? Array.prototype.filter.call(el.parentElement.children, function (c) {
                return c.classList && c.classList.contains("reveal");
              })
            : [el];
          var idx = Math.max(0, sibs.indexOf(el));
          // setTimeout 驱动：后台标签页也能到达终态
          setTimeout(function () {
            el.classList.add("visible");
            if (el.classList.contains("compare-grid")) el.classList.add("shown");
          }, Math.min(idx, 6) * 80);
          revealIO.unobserve(el);
        }
      });
    }, { threshold: 0.15 });
    revealEls.forEach(function (el) { revealIO.observe(el); });
  }

  /* ---------- 2b. Hero 标题逐行入场 ---------- */
  var heroTitle = document.getElementById("heroTitle");
  if (heroTitle) setTimeout(function () { heroTitle.classList.add("in"); }, 120);

  /* ---------- 2c. 数据对比数字滚动（与柱状生长同步） ---------- */
  var compareChart = document.getElementById("compareChart");
  if (compareChart && "IntersectionObserver" in window) {
    var cmpIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          compareChart.querySelectorAll(".cmp-val[data-count]").forEach(function (el) {
            el.textContent = (el.dataset.prefix || "") + "0%"; // 从 0 开始滚动
            countUp(el, parseFloat(el.dataset.count), 0, 1100, el.dataset.prefix || "", "%");
          });
          cmpIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    cmpIO.observe(compareChart);
  }

  /* ---------- 2d. 平台 marquee 布局：整数卡对齐 + 渐隐只盖侧向空隙 ---------- */
  var marquee = document.getElementById("platformMarquee");
  if (marquee) {
    var mqTrack = marquee.querySelector(".marquee-track");
    var layoutMarquee = function () {
      if (!mqTrack || !mqTrack.children.length) return;
      var card = mqTrack.children[0];
      var mr = parseFloat(getComputedStyle(card).marginRight) || 0;
      var step = card.getBoundingClientRect().width + mr;
      var cw = marquee.clientWidth;
      // 视口内放整数张卡，剩余宽度平分给两侧空隙（渐隐只盖空隙，不遮卡片）
      var n = Math.max(1, Math.floor((cw - 16) / step));
      var z = Math.round((cw - n * step) / 2);
      z = Math.min(Math.max(z, 8), 72);
      marquee.style.paddingLeft = z + "px";
      marquee.style.paddingRight = z + "px";
      marquee.style.setProperty("--fade", z + "px");
      // 轨道比视口窄（超宽屏）时停动画、全部展示
      marquee.classList.toggle("static", mqTrack.scrollWidth <= cw);
    };
    layoutMarquee();
    window.addEventListener("resize", layoutMarquee);
  }

  /* ---------- 3. 数字计数动画 ---------- */
  function countUp(el, target, decimals, duration, prefix, suffix) {
    var pre = prefix || "", suf = suffix || "";
    var finalText = pre + target.toFixed(decimals) + suf;
    // 后台/隐藏标签页：嵌套计时器会被浏览器钳制，直接落到终态
    if (reduceMotion || document.hidden) {
      el.textContent = finalText;
      return;
    }
    var start = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = pre + (target * eased).toFixed(decimals) + suf;
      if (t < 1) setTimeout(function () { frame(performance.now()); }, 16);
      else el.textContent = finalText;
    }
    setTimeout(function () { frame(performance.now()); }, 16);
    // 兜底：即使帧链被节流，也保证到达终态
    setTimeout(function () { el.textContent = finalText; }, duration + 150);
  }

  // Hero 关键数字
  var heroNums = document.querySelectorAll(".stat-num[data-count]");
  if (heroNums.length) {
    var heroIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          countUp(entry.target, parseFloat(entry.target.dataset.count), 0, 1400);
          heroIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.6 });
    heroNums.forEach(function (el) { heroIO.observe(el); });
  }

  // 演示区指标：进入视口先播一次
  var demoCounted = false;
  function playMetricCount() {
    countUp(document.getElementById("mMention"), 62.5, 1, 1200);
    countUp(document.getElementById("mFirst"), 38.3, 1, 1200);
    countUp(document.getElementById("mCite"), 45.8, 1, 1200);
    countUp(document.getElementById("mEvidence"), 120, 0, 1200);
    countUp(document.getElementById("mTask"), 3, 0, 1200);
  }
  var demoShell = document.getElementById("demoShell");
  if (demoShell) {
    var demoIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !demoCounted) {
          demoCounted = true;
          playMetricCount();
          demoIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.35 });
    demoIO.observe(demoShell);
  }

  /* ---------- 4. 演示区：Tab 切换 ---------- */
  var tabs = document.querySelectorAll(".ds-tab");
  var panels = document.querySelectorAll(".ds-panel");
  var demoNav = document.querySelector(".ds-nav");
  if (demoNav) {
    demoNav.setAttribute("role", "tablist");
    demoNav.setAttribute("aria-label", "产品演示页面");
  }

  function activateTab(tab, focus) {
    var panel = document.getElementById("panel-" + tab.dataset.panel);
    if (!panel) return;
    tabs.forEach(function (item) {
      var active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    });
    panels.forEach(function (item) { item.classList.toggle("active", item === panel); });
    var viewLabel = document.getElementById("demoViewLabel");
    if (viewLabel) viewLabel.textContent = tab.textContent.trim();
    if (window.matchMedia("(max-width: 720px)").matches) {
      var side = tab.closest(".ds-side");
      if (side) {
        side.scrollTo({
          left: tab.offsetLeft - (side.clientWidth - tab.offsetWidth) / 2,
          behavior: "smooth"
        });
      }
    }
    if (focus) tab.focus();

    // 切到复测报告时触发柱状生长动画
    if (tab.dataset.panel === "report") {
      var card = document.querySelector(".report-card");
      if (!card) return;
      card.classList.remove("shown");
      // 强制 reflow 以便重播动画
      void card.offsetWidth;
      if (reduceMotion) card.style.setProperty("--no-anim", "1");
      card.classList.add("shown");
    }
  }

  tabs.forEach(function (tab, index) {
    var panel = document.getElementById("panel-" + tab.dataset.panel);
    var tabId = "demo-tab-" + tab.dataset.panel;
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel ? panel.id : "");
    tab.setAttribute("aria-selected", String(tab.classList.contains("active")));
    tab.tabIndex = tab.classList.contains("active") ? 0 : -1;
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tabId);
      panel.tabIndex = 0;
    }
    tab.addEventListener("click", function () { activateTab(tab, false); });
    tab.addEventListener("keydown", function (event) {
      var nextIndex = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });

  /* ---------- 5. 演示区：折线趋势图 + 平台覆盖条 ---------- */
  // 与 v2 后台「关键指标趋势」一致：绿/蓝/橙三系列
  var trendSeries = [
    { cls: "m", data: [51.2, 54.8, 53.1, 57.6, 58.3, 60.1, 59.4, 62.5] },
    { cls: "f", data: [32.5, 34.1, 33.6, 35.8, 36.2, 37.4, 36.9, 38.3] },
    { cls: "c", data: [42.0, 43.5, 43.1, 44.2, 44.8, 45.3, 45.6, 45.8] }
  ];
  var covData = [
    { n: "DeepSeek", v: 65.0 },
    { n: "Kimi", v: 60.0 },
    { n: "豆包 · 火山方舟", v: 63.3 },
    { n: "通义千问", v: 56.7 },
    { n: "元宝搜索源 + 混元", v: 61.7 }
  ];

  function renderTrend(animate) {
    var box = document.getElementById("trendChart");
    if (!box) return;
    var n = trendSeries[0].data.length;
    var x0 = 38, x1 = 566, y0 = 200, yTop = 28;
    function X(i) { return n === 1 ? (x0 + x1) / 2 : x0 + i * (x1 - x0) / (n - 1); }
    function Y(v) { return y0 - (v / 100) * (y0 - yTop); }

    var s = '<svg viewBox="0 0 600 232" role="img" aria-label="关键指标趋势（演示）">';
    // 横向网格 + 纵轴刻度
    [0, 25, 50, 75, 100].forEach(function (g) {
      var y = Y(g);
      s += '<line class="trend-grid" x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '"/>';
      s += '<text class="trend-ylabel" x="' + (x0 - 8) + '" y="' + (y + 3) + '" text-anchor="end">' + g + '%</text>';
    });
    // 横轴标签
    for (var i = 0; i < n; i++) {
      var anchor = i === 0 ? "start" : (i === n - 1 ? "end" : "middle");
      s += '<text class="trend-xlabel" x="' + X(i) + '" y="226" text-anchor="' + anchor + '">第' + (i + 1) + '期</text>';
    }
    // 三系列折线 + 末端圆点
    trendSeries.forEach(function (ser) {
      var pts = ser.data.map(function (v, i) { return X(i).toFixed(1) + "," + Y(v).toFixed(1); }).join(" ");
      s += '<polyline class="trend-line ' + ser.cls + '" points="' + pts + '"/>';
      var lv = ser.data[n - 1];
      s += '<circle class="trend-dot" cx="' + X(n - 1).toFixed(1) + '" cy="' + Y(lv).toFixed(1) + '" r="3.5" fill="currentColor" style="color:' + (ser.cls === "m" ? "#16a34a" : ser.cls === "f" ? "#3b82f6" : "#f59e0b") + '"/>';
    });
    s += "</svg>";
    box.innerHTML = s;

    if (animate && !reduceMotion) {
      box.querySelectorAll(".trend-line").forEach(function (line, idx) {
        var len = line.getTotalLength();
        line.style.strokeDasharray = len;
        if (document.hidden) { line.style.strokeDashoffset = "0"; return; }
        var delay = 60 + idx * 150;
        var safety = setTimeout(function () { line.style.strokeDashoffset = "0"; }, delay + 1400);
        setTimeout(function () {
          var start = null;
          function step(now) {
            if (start === null) start = now;
            var t = Math.min(1, (now - start) / 1100);
            var eased = 1 - Math.pow(1 - t, 3);
            line.style.strokeDashoffset = String(len * (1 - eased));
            if (t < 1) setTimeout(function () { step(performance.now()); }, 16);
            else { clearTimeout(safety); line.style.strokeDashoffset = "0"; }
          }
          step(performance.now());
        }, delay);
      });
    }
  }

  function renderCov(grow) {
    var box = document.getElementById("covRows");
    if (!box) return;
    box.innerHTML = covData.map(function (d) {
      return '<div class="cov-row">' +
        '<span class="cov-name">' + d.n + '</span>' +
        '<div class="cov-track"><div class="cov-fill" style="--w:' + d.v.toFixed(1) + '%"></div></div>' +
        '<span class="cov-val">' + d.v.toFixed(1) + '%</span></div>';
    }).join("");
    if (grow) {
      setTimeout(function () { box.classList.add("shown"); }, reduceMotion ? 0 : 120);
    } else {
      box.classList.add("shown");
    }
  }
  renderCov(false);
  renderTrend(false); // 立即静态渲染，避免后台标签页 IO 不派发时无图

  if (demoShell) {
    var trendIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          renderTrend(true); // 首次进入视口时重放描线动画
          trendIO.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    trendIO.observe(demoShell);
  }

  /* ---------- 5b. 漂移告警可关闭 ---------- */
  var alertBtn = document.getElementById("alertDismiss");
  if (alertBtn) {
    alertBtn.addEventListener("click", function () {
      var alert = document.getElementById("driftAlert");
      alert.style.transition = "opacity .3s, transform .3s var(--ease-out)";
      alert.style.opacity = "0";
      alert.style.transform = "translateY(-6px)";
      setTimeout(function () { alert.hidden = true; }, reduceMotion ? 0 : 300);
    });
  }

  /* ---------- 6. 演示区：运行监测 ---------- */
  var runBtn = document.getElementById("runBtn");
  var runProgress = document.getElementById("runProgress");
  var runFill = document.getElementById("runProgressFill");
  var runText = document.getElementById("runProgressText");
  var runStatus = document.getElementById("runStatus");
  var running = false;
  var runCount = 0;

  var stages = [
    { p: 12, t: "正在连接 DeepSeek 联网 API…" },
    { p: 28, t: "Kimi 联网搜索采集中…" },
    { p: 45, t: "豆包 · 火山方舟采集中…" },
    { p: 62, t: "通义千问采集中…" },
    { p: 78, t: "元宝搜索源 + 混元合成采集中…" },
    { p: 90, t: "正在解析回答并计算指标…" },
    { p: 100, t: "正在写入证据库并校验哈希…" }
  ];

  var runLog = document.getElementById("runLog");

  function logLine(msg, ok) {
    if (!runLog) return;
    var now = new Date();
    var t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (n) {
      return String(n).padStart(2, "0");
    }).join(":");
    var div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = '<span class="log-time">' + t + '</span><span class="log-msg">' + msg + '</span>' +
      (ok ? '<span class="log-ok">✓</span>' : "");
    runLog.appendChild(div);
    runLog.scrollTop = runLog.scrollHeight;
  }

  runBtn.addEventListener("click", function () {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg> 监测中…';
    runStatus.textContent = "正在运行 · 5 平台 × 4 问法…";
    runProgress.hidden = false;
    runProgress.classList.add("logging");
    runFill.style.width = "0%";
    if (runLog) runLog.innerHTML = "";
    logLine("任务已创建 · 冻结基线配置，开始连接平台联网 API");

    var total = reduceMotion ? 10 : 2600;
    var per = total / stages.length;
    stages.forEach(function (s, i) {
      setTimeout(function () {
        runFill.style.width = s.p + "%";
        runText.textContent = s.t;
        logLine(s.t, i < stages.length - 1);
        if (i === stages.length - 1) finishRun();
      }, per * (i + 1));
    });
  });

  function finishRun() {
    runCount++;
    // 指标小幅“刷新”（在演示区间内波动）
    var vals = [
      { el: "mMention", v: 62.5 + runCount * 0.4, d: "较基线 +" + (4.2 + runCount * 0.4).toFixed(1), dec: 1 },
      { el: "mFirst",   v: 38.3 + runCount * 0.3, d: "较基线 +" + (2.1 + runCount * 0.3).toFixed(1), dec: 1 },
      { el: "mCite",    v: 45.8 + runCount * 0.2, d: "较基线 −" + Math.max(0.2, 1.0 - runCount * 0.2).toFixed(1), dec: 1 },
      { el: "mEvidence", v: 120 + runCount * 20,  d: "哈希上链 · 不可篡改", dec: 0 }
    ];
    vals.forEach(function (it) {
      var node = document.getElementById(it.el);
      node.textContent = "0";
      // 旧数字上滚、新数字下入
      node.classList.remove("roll");
      void node.offsetWidth;
      node.classList.add("roll");
      countUp(node, it.v, it.dec, 1100);
    });
    document.getElementById("dMention").textContent = vals[0].d;
    document.getElementById("dFirst").textContent = vals[1].d;
    document.getElementById("dCite").textContent = vals[2].d;
    logLine("指标已刷新 · 写入 20 条新证据并通过哈希校验", true);

    // 趋势图与平台覆盖追加一期
    var nm = +(62.5 + runCount * 0.4).toFixed(1);
    var nf = +(38.3 + runCount * 0.3).toFixed(1);
    var nc = +(45.8 + runCount * 0.2).toFixed(1);
    trendSeries[0].data.push(nm);
    trendSeries[1].data.push(nf);
    trendSeries[2].data.push(nc);
    renderTrend(true);
    covData.forEach(function (d) { d.v = +(d.v + 0.4).toFixed(1); });
    renderCov(false);

    setTimeout(function () {
      // 保留进度区与运行日志，便于回看本次采集过程
      runProgress.classList.remove("logging");
      runText.textContent = "采集完成 · 指标与证据已入库";
      var now = new Date();
      var hh = String(now.getHours()).padStart(2, "0");
      var mm = String(now.getMinutes()).padStart(2, "0");
      runStatus.textContent = "上次运行：今天 " + hh + ":" + mm + " · " + (120 + runCount * 20) + " 条回答已采集";
      runBtn.disabled = false;
      runBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg> 再次运行监测';
      running = false;
    }, reduceMotion ? 60 : 500);
  }

  /* ---------- 7. 演示区：证据卡片切换 ---------- */
  var evidence = [
    {
      platform: "Kimi",
      query: "“高端便携投影仪推荐”",
      time: "采集于 2026-09-01 09:31:07 · 联网 API 直采",
      hash: "a3f9…c21d",
      quote: "高端便携场景下，澄光投影 X2 系列兼顾亮度与体积，是常被提到的选择之一；其官网选购指南对参数解释较为完整……",
      status: "结论：品牌被提及，且引用了官网页面 brand-website.com/guide",
      tags: "提及 ✓ · 引用官网 ✓ · 截图 + 原文 + 哈希已存证"
    },
    {
      platform: "通义千问",
      query: "“家用投影仪哪个牌子好”",
      time: "采集于 2026-09-01 09:33:41 · 联网 API 直采",
      hash: "7bd2…e904",
      quote: "家用场景可关注亮度、ANSI 流明与噪音控制。市面常见选择包括坚果、极米等品牌，具体可按预算细分……",
      status: "结论：回答未提及品牌，竞品占位 2 席，已生成差距项 #GAP-1042",
      tags: "提及 ✗ · 引用官网 ✗ · 截图 + 原文 + 哈希已存证"
    },
    {
      platform: "元宝",
      query: "“投影仪选购避坑指南”",
      time: "采集于 2026-09-01 09:36:12 · 元宝搜索源 + 混元合成",
      hash: "c88a…13f7",
      quote: "选购投影仪重点避坑三点：虚标亮度、忽略散热噪音、盲目追高分辨率。综合表现上，澄光投影 X2 的实测数据较为扎实，可优先关注……",
      status: "结论：品牌获得首位推荐，并引用官网实测页 brand-website.com/lab",
      tags: "提及 ✓ · 首位推荐 ✓ · 截图 + 原文 + 哈希已存证"
    },
    {
      platform: "DeepSeek",
      query: "“高端便携投影仪推荐”",
      time: "采集于 2026-09-01 09:32:16 · 联网 API 直采",
      hash: "4e12…8ab6",
      quote: "在便携投影产品中，可重点比较真实亮度、散热噪音和系统易用性。澄光投影 X2 的便携尺寸与参数公开程度较高……",
      status: "结论：品牌被提及，且引用了官网参数页 brand-website.com/x2",
      tags: "提及 ✓ · 引用官网 ✓ · 原始响应 + 哈希已存证"
    },
    {
      platform: "豆包",
      query: "“预算五千投影仪怎么选”",
      time: "采集于 2026-09-01 09:35:24 · 火山方舟联网 API",
      hash: "91cc…e702",
      quote: "五千元预算应优先核对真实亮度、投射比和售后。综合这些条件，澄光投影 X2 可列入首轮比较清单……",
      status: "结论：品牌获得首位推荐，来源可见但未引用官网",
      tags: "提及 ✓ · 首位推荐 ✓ · 来源可见 · 哈希已存证"
    }
  ];
  var evCards = document.querySelectorAll(".evidence-card");
  var edEls = {
    platform: document.getElementById("edPlatform"),
    query: document.getElementById("edQuery"),
    time: document.getElementById("edTime"),
    hash: document.getElementById("edHash"),
    quote: document.getElementById("edQuote"),
    status: document.getElementById("edStatus"),
    tags: document.getElementById("edTags")
  };
  function activateEvidence(card) {
    var d = evidence[+card.dataset.ev];
    if (!d) return;
    evCards.forEach(function (item) {
      var selected = item === card;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    edEls.platform.textContent = d.platform;
    edEls.query.textContent = d.query;
    edEls.time.textContent = d.time;
    edEls.hash.textContent = d.hash;
    edEls.quote.textContent = d.quote;
    edEls.status.textContent = d.status;
    edEls.tags.textContent = d.tags;
    var detail = document.getElementById("evidenceDetail");
    detail.style.animation = "none";
    void detail.offsetWidth;
    detail.style.animation = "panel-in .35s var(--ease-out)";
  }

  evCards.forEach(function (card) {
    card.setAttribute("aria-pressed", String(card.classList.contains("selected")));
    card.addEventListener("click", function () { activateEvidence(card); });
  });

  var evidenceFilters = document.querySelectorAll("[data-ev-filter]");
  evidenceFilters.forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.classList.contains("sel")));
    button.addEventListener("click", function () {
      var filter = button.dataset.evFilter;
      evidenceFilters.forEach(function (item) {
        var selected = item === button;
        item.classList.toggle("sel", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      var firstVisible = null;
      evCards.forEach(function (card) {
        var item = evidence[+card.dataset.ev];
        var visible = filter === "all" || item.platform === filter;
        card.hidden = !visible;
        if (visible && !firstVisible) firstVisible = card;
      });
      var current = document.querySelector(".evidence-card.selected:not([hidden])");
      if (!current && firstVisible) activateEvidence(firstVisible);
    });
  });

  /* ---------- 8. 整改审批与官网复审 ---------- */
  var taskButtons = document.querySelectorAll("[data-task-action]");
  taskButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var row = button.closest(".remediation-item");
      var status = row && row.querySelector("[data-task-status]");
      if (!status) return;
      status.textContent = "已批准";
      status.classList.add("approved");
      button.textContent = "已批准";
      button.disabled = true;
      var taskCount = document.getElementById("mTask");
      taskCount.textContent = String(Math.max(0, Number(taskCount.textContent) - 1));
      document.getElementById("dTask").textContent = "审批状态已同步";
    });
  });

  var auditRun = document.getElementById("auditRun");
  if (auditRun) {
    auditRun.addEventListener("click", function () {
      auditRun.disabled = true;
      auditRun.textContent = "审计中…";
      setTimeout(function () {
        document.getElementById("auditScore").textContent = "88";
        document.getElementById("auditTime").textContent = "刚刚完成 · 12 项检查 · 2 项建议";
        auditRun.textContent = "审计完成";
        setTimeout(function () {
          auditRun.disabled = false;
          auditRun.textContent = "重新审计";
        }, reduceMotion ? 20 : 1200);
      }, reduceMotion ? 20 : 850);
    });
  }

  /* ---------- 9. FAQ 手风琴（CSS 网格行动画，同时只开一条） ---------- */
  var faqItems = document.querySelectorAll(".faq-item");
  faqItems.forEach(function (item) {
    // details 的 toggle 事件在 open 状态变化后触发
    item.addEventListener("toggle", function () {
      if (!item.hasAttribute("open")) return;
      faqItems.forEach(function (other) {
        if (other !== item) other.removeAttribute("open");
      });
    });
  });

  /* ---------- 10. PDF 按钮（演示提示） ---------- */
  var pdfBtn = document.getElementById("pdfBtn");
  if (pdfBtn) {
    pdfBtn.addEventListener("click", function () {
      var old = pdfBtn.innerHTML;
      pdfBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-5"/></svg> 已加入导出队列（演示）';
      setTimeout(function () { pdfBtn.innerHTML = old; }, 2200);
    });
  }

})();
