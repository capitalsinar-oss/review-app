const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rp = (n) => "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");
const rb = (n) => { n = Math.round(Number(n) || 0); return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(".", ",") + "jt" : Math.round(n / 1000) + "rb"; };
const CH = { "Airbnb": "#FF5A5F", "Booking.com": "#003580", "Trip.com": "#287DFA", "Google": "#34A853" };
const GOALS = { "Airbnb": { n: 15, score: 4.85, max: 5 }, "Booking.com": { n: 15, score: 9.5, max: 10 }, "Trip.com": { n: 15, score: 9.5, max: 10 }, "Google": { n: 50, score: 4.9, max: 5 } };
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const dot = (ch) => `<i class="dot" style="background:${CH[ch] || "#999"}"></i>`;

// faces
$$("[data-face]").forEach((el) => { el.innerHTML = FACES[el.dataset.face] || ""; });
$$("[data-stars5]").forEach((el) => { el.innerHTML = [1, 2, 3, 4, 5].map((i) => FACES.star_small.replace("<svg", `<svg class="s${i}"`)).join(""); });
$$(".yr").forEach((el) => (el.textContent = new Date().getFullYear()));

// ---------- state & api ----------
let villas = [], operators = [], roles = [], me = null, session = store("rg-session") || "", kind = store("rg-kind") || "";
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { "content-type": "application/json", "x-session": session, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({ error: "The site didn't answer properly. Try again." }));
  if (r.status === 401 && d.error === "signin") { logout(); throw new Error("Please log in again."); }
  if (!r.ok) throw new Error(d.error || d.message || "Something went wrong. Try again.");
  return d;
};
function show(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === "s-" + id));
  $("#nav").hidden = !["home", "stash"].includes(id);
  $("#nav-home").classList.toggle("on", id === "home"); $("#nav-stash").classList.toggle("on", id === "stash");
  window.scrollTo(0, 0);
}
function logout() { session = ""; kind = ""; me = null; store("rg-session", null); store("rg-kind", null); show("welcome"); }
$$("[data-go]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); if (b.dataset.first) { $("#signin-title").textContent = "Set up my PIN"; $("#signin-sub").textContent = "Your starting PIN is 8888. You'll choose your own next."; $("#pin-label").textContent = "Starting PIN (8888)"; } else if (b.dataset.go === "signin") { $("#signin-title").textContent = "Welcome back"; $("#signin-sub").textContent = "Good to see you. Let's check in."; $("#pin-label").textContent = "Your 4-digit PIN"; } go(b.dataset.go); }));
$$("[data-logout]").forEach((b) => b.addEventListener("click", logout));
async function go(id) {
  if (id === "home") await loadHome();
  if (id === "stash") await loadStash();
  if (id === "admin") await loadAdmin();
  show(id);
}

// ---------- villas & sign in ----------
async function loadVillas() {
  const d = await api("/api/villas");
  villas = d.villas; operators = d.operators || []; roles = d.roles || [];
  const opts = villas.map((v) => `<option value="${esc(v.key)}">${esc(v.name)}</option>`).join("");
  $("#company").innerHTML = '<option value="">Choose your company</option>' + operators.map((o) => `<option value="${esc(o.key)}">${esc(o.name)}</option>`).join("");
  $("#villa").innerHTML = '<option value="">Choose your villa</option>' + opts;
  $("#q-villa").innerHTML = '<option value="">All villas</option>' + opts;
  $("#rp-villa").innerHTML = opts; $("#g-villa").innerHTML = opts;
}
const ROLE_LABEL = { host: "Host", supervisor: "Supervisor", housekeeper: "Housekeeper", pool: "Pool", garden: "Garden", security: "Security" };
// Sign in: company → villa → designation → name → PIN
$("#company").addEventListener("change", () => {
  const op = $("#company").value;
  $("#villa").innerHTML = '<option value="">Choose your villa</option>' + villas.filter((v) => v.operator === op).map((v) => `<option value="${esc(v.key)}">${esc(v.name)}</option>`).join("");
  $("#step-villa").hidden = !op; $("#step-role").hidden = true; $("#signin-more").hidden = true;
});
$("#villa").addEventListener("change", () => {
  const v = villas.find((x) => x.key === $("#villa").value);
  const present = v ? roles.filter((r) => v.staff.some((s) => s.role === r)) : [];
  $("#role").innerHTML = '<option value="">Choose your designation</option>' + present.map((r) => `<option value="${esc(r)}">${esc(ROLE_LABEL[r] || r)}</option>`).join("");
  $("#step-role").hidden = !v; $("#signin-more").hidden = true;
});
$("#role").addEventListener("change", () => {
  const v = villas.find((x) => x.key === $("#villa").value), role = $("#role").value;
  const people = v && role ? v.staff.filter((s) => s.role === role) : [];
  $("#who").innerHTML = '<option value="">Choose your name</option>' + people.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("#signin-more").hidden = !people.length;
});
$("#f-signin").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#signin-err").textContent = "";
  try {
    const d = await api("/api/auth/staff", { method: "POST", body: JSON.stringify({ operator: $("#company").value, villa: $("#villa").value, role: $("#role").value, staff_id: $("#who").value, pin: $("#pin").value }) });
    session = d.token; kind = "staff"; store("rg-session", session); store("rg-kind", kind); me = d.me; $("#pin").value = "";
    if (d.must_change_pin) show("newpin"); else go("home");
  } catch (err) { $("#signin-err").textContent = err.message; }
});
$("#f-newpin").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#newpin-err").textContent = "";
  if ($("#pin1").value !== $("#pin2").value) { $("#newpin-err").textContent = "The two PINs don't match."; return; }
  try { await api("/api/auth/staff/pin", { method: "POST", body: JSON.stringify({ new_pin: $("#pin1").value }) }); $("#pin1").value = $("#pin2").value = ""; go("home"); }
  catch (err) { $("#newpin-err").textContent = err.message; }
});
$("#f-admin").addEventListener("submit", async (e) => {
  e.preventDefault(); $("#admin-err").textContent = "";
  try { const d = await api("/api/auth/admin", { method: "POST", body: JSON.stringify({ name: $("#aname").value, password: $("#apass").value }) }); session = d.token; kind = "admin"; store("rg-session", session); store("rg-kind", kind); $("#apass").value = ""; go("admin"); }
  catch (err) { $("#admin-err").textContent = err.message; }
});

// ---------- home ----------
let homeData = null, goalVilla = "";
async function loadHome() {
  homeData = await api("/api/me");
  me = homeData.me;
  if (homeData.must_change_pin) { show("newpin"); throw new Error("pin"); }
  const roleName = me.role.charAt(0).toUpperCase() + me.role.slice(1);
  $("#home-role").textContent = `${roleName} · ${me.villas.length} villa${me.villas.length === 1 ? "" : "s"}`;
  $("#home-hi").textContent = `Hi, ${me.name}`;
  const st = homeData.stash;
  $("#home-stash-label").textContent = me.villas.length > 1 ? `My stash · all ${me.villas.length} villas` : "My stash";
  $("#home-stash").textContent = rp(st.total);
  $("#home-payday").textContent = `Payday ${st.payday.label} · ${st.payday.days} day${st.payday.days === 1 ? "" : "s"} to go`;
  $("#home-villas").innerHTML = me.villas.map((v) => { const b = st.by_villa.find((x) => x.villa === v); return `<span><span>${esc(v)}</span><span>${rb(b ? b.amount : 0)}</span></span>`; }).join("");
  goalVilla = me.villas.includes(goalVilla) ? goalVilla : me.villas[0];
  renderGoals();
  $("#upvilla").innerHTML = me.villas.map((v) => `<option value="${esc(v)}">${esc(villas.find((x) => x.key === v)?.name || v)}</option>`).join("");
}
function renderGoals() {
  $("#goal-tabs").innerHTML = me.villas.map((v) => `<button role="tab" class="${v === goalVilla ? "on" : ""}" data-v="${esc(v)}">${esc(v)}</button>`).join("");
  $$("#goal-tabs button").forEach((b) => (b.onclick = () => { goalVilla = b.dataset.v; renderGoals(); }));
  const g = (homeData.goals || {})[goalVilla] || {};
  const shared = ["Kapuk", "Palem", "Jati"].includes(goalVilla);
  $("#goal-rows").innerHTML = Object.keys(GOALS).map((ch) => {
    const t = GOALS[ch], cur = g[ch] || {};
    const count = cur.count || 0, score = cur.score;
    const pct = Math.min(100, Math.round((count / t.n) * 100));
    const toGo = Math.max(0, t.n - count);
    const status = !cur.updated ? "Numbers not entered yet" : score != null && score < t.score ? "score needs a lift" : toGo ? `${toGo} to go` : "goal reached";
    return `<div class="goal"><div class="between" style="font-size:14px;font-weight:800"><span>${dot(ch)}${esc(ch)}${shared && ch === "Google" ? " (Oasis)" : ""}</span><span>${count} / ${t.n} reviews${score != null ? ` · score ${score}` : ""}</span></div><div class="bar"><i style="width:${pct}%;background:${CH[ch]}"></i></div><span class="g">Goal ${t.n} at ${t.score}+ · ${status}${shared && ch === "Google" ? " · shared by 3 Oasis villas" : ""}</span></div>`;
  }).join("");
}

// ---------- upload sheet ----------
let pending = [];
function openSheet() { if (kind !== "staff") return; $("#sheetbg").classList.add("on"); $("#sheet").classList.add("on"); $("#up-err").textContent = ""; }
function closeSheet() { $("#sheetbg").classList.remove("on"); $("#sheet").classList.remove("on"); }
$$("[data-sheet]").forEach((b) => b.addEventListener("click", openSheet));
$("#sheetbg").addEventListener("click", closeSheet); $("#sheet-close").addEventListener("click", closeSheet);
const drop = $("#drop"), file = $("#file");
drop.addEventListener("click", () => file.click());
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
file.addEventListener("change", () => { takeFiles(file.files); file.value = ""; });
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => e.preventDefault()));
drop.addEventListener("drop", (e) => { e.preventDefault(); takeFiles(e.dataTransfer.files); });
document.addEventListener("paste", (e) => { if (kind !== "staff") return; const fs = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file" && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean); if (fs.length) { openSheet(); takeFiles(fs); } });
function takeFiles(list) {
  const fs = [...list].filter((f) => /^image\//.test(f.type));
  if (!fs.length) return;
  pending = pending.concat(fs).slice(0, 5);
  $("#thumbs").innerHTML = ""; pending.forEach((f) => { const img = new Image(); img.src = URL.createObjectURL(f); img.alt = ""; $("#thumbs").append(img); });
  $("#up-go").disabled = false; $("#up-go").textContent = pending.length > 1 ? `Grade ${pending.length} screenshots` : "Grade it";
  $("#drop b").textContent = pending.length >= 5 ? "That's the maximum (5)" : "Add another screenshot";
}
async function shrink(f) {
  const bmp = await createImageBitmap(f);
  const sc = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.85); return { media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}
const STEPS = ["Uploading…", "Reading the screenshot…", "Finding the guest's words…", "Checking for complaints…", "Looking for who they named…", "Working out the grade…", "Saving it safely…"];
let ovTimer = null;
function overlayOn() { $("#overlay").classList.add("on"); document.body.style.overflow = "hidden"; const t0 = Date.now(); clearInterval(ovTimer); const tick = () => { const s = Math.round((Date.now() - t0) / 1000); $("#ov-timer").textContent = s + " s"; $("#ov-step").textContent = STEPS[Math.min(STEPS.length - 1, Math.floor(s / 5))]; $("#ov-prog").style.width = Math.min(92, 100 * (1 - Math.exp(-s / 18))) + "%"; }; tick(); ovTimer = setInterval(tick, 1000); }
function overlayOff() { clearInterval(ovTimer); $("#overlay").classList.remove("on"); document.body.style.overflow = ""; $("#ov-prog").style.width = "0"; }
$("#up-go").addEventListener("click", async () => {
  if (!pending.length) return;
  $("#up-err").textContent = "";
  const villa = $("#upvilla").value; const fs = pending;
  closeSheet(); overlayOn();
  try {
    const images = await Promise.all(fs.map(shrink));
    const d = await api("/api/reviews", { method: "POST", body: JSON.stringify({ villa, images }) });
    store("rg-job", d.job);
    const job = await waitJob(d.job);
    store("rg-job", null);
    pending = []; $("#thumbs").innerHTML = ""; $("#up-go").disabled = true; $("#drop b").textContent = "Choose the screenshot";
    showResult(job);
  } catch (err) { overlayOff(); openSheet(); $("#up-err").textContent = err.message; }
});
async function waitJob(id) {
  for (let i = 0; i < 150; i++) {
    await sleep(i < 5 ? 2500 : 3000);
    let d; try { d = await api("/api/job?id=" + encodeURIComponent(id)); } catch (e) { if (/log in/.test(e.message)) throw e; continue; }
    if (d.status !== "working") return d;
  }
  throw new Error("This is taking too long. Check your stash in a few minutes.");
}
async function resumeJob() { const id = store("rg-job"); if (!id || kind !== "staff") return; overlayOn(); try { const job = await waitJob(id); store("rg-job", null); showResult(job); } catch { overlayOff(); store("rg-job", null); } }

// ---------- result ----------
function showResult(job) {
  overlayOff();
  if (job.status === "error") { show("home"); alertBox(job.error); return; }
  const rs = job.reviews || [];
  $("#confetti").innerHTML = ""; $("#r-more").innerHTML = ""; $("#r-second").style.display = "none";
  if (!rs.length) {
    $("#r-top").innerHTML = `<span class="breathe" data-face="cup"></span><span style="font-size:13px;font-weight:800;letter-spacing:.6px;color:var(--purple)">HMM</span><h1 style="font-size:28px;text-align:center">We couldn't find a review in that</h1><p style="margin:0;text-align:center;color:var(--mute2);font-weight:600">${esc((job.notes || []).concat(job.errors || []).join(" · ") || "Make sure the screenshot shows the guest's name, the stars and their words.")}</p>`;
    $("#r-top [data-face]").innerHTML = FACES.cup; $("#r-body").innerHTML = ""; show("result"); return;
  }
  const r = rs[0];
  const stash = homeData ? homeData.stash : null;
  const when = fmtDate(r.date_iso) || r.date || "";
  const where = `${dot(r.platform)}${esc(r.platform)} · ${esc(villas.find((v) => v.key === r.villa)?.name || r.villa)}${when ? " · " + esc(when) : ""}`;
  if (r.duplicate_of) {
    $("#r-top").innerHTML = `<span class="breathe" data-face="cloud"></span><span style="font-size:13px;font-weight:800;letter-spacing:.6px;color:var(--purple)">ALREADY IN</span><h1 style="font-size:28px;text-align:center">This one's already been uploaded</h1><p style="margin:0;text-align:center;color:var(--mute2);font-weight:600">${where}</p>`;
    $("#r-top [data-face]").innerHTML = FACES.cloud;
    $("#r-body").innerHTML = `<div class="card col" style="gap:10px"><span class="fred" style="font-size:18px">It was graded ${esc(r.duplicate_of.grade || "")} on ${esc(String(r.duplicate_of.date || "").slice(0, 10))}</span><span style="font-size:15px">A review only counts once, so nothing changes in your stash. If a different guest wrote something similar, ask an admin.</span></div>`;
  } else if (r.grade === "A") {
    const colors = ["#FFD84D", "#BFA8FF", "#FF7EB3"];
    $("#confetti").innerHTML = Array.from({ length: 12 }, (_, i) => `<i class="confetti" style="left:${6 + i * 8}%;background:${colors[i % 3]};animation-delay:${(i * 0.37) % 3.5}s;border-radius:${i % 2 ? "5px" : "3px"}"></i>`).join("");
    $("#r-top").innerHTML = `<span class="dance">${FACES.dancer}</span><div class="row" style="gap:3px">${[1, 2, 3, 4, 5].map(() => FACES.star_tiny).join("")}</div><h1 class="pop" style="font-size:38px;line-height:1.05;text-align:center;margin-top:4px">It's a Grade A review!</h1><p style="margin:0;font-size:15px;font-weight:700;color:var(--mute2);text-align:center">${where}</p>`;
    $("#r-body").innerHTML = `
      <div class="row card" style="gap:12px;padding:12px 16px;border-radius:22px">${FACES.hands}<span class="fred" style="font-size:22px">High five!</span></div>
      <div class="pay pop" style="animation-delay:.15s"><b>Into Team ${esc(r.villa)}'s pot</b><span class="amt">+${rp(r.pot)}</span></div>
      <div class="pay yellow pop" style="animation-delay:.3s"><b>Your share, into your stash</b><span class="amt">+${rp(r.share_estimate)}</span></div>
      ${(r.staff_named || []).length ? `<div class="note" style="background:var(--lilac)"><strong>The guest named ${esc(r.staff_named.map((s) => s.name).join(" and "))}.</strong> If that's you, an admin adds ${rp(stash ? stash.name_bonus : 200000)} on top.</div>` : ""}
      <div class="card col pop" style="gap:8px;border-radius:22px;animation-delay:.45s"><span style="font-size:13px;font-weight:800;letter-spacing:.6px;color:var(--purple)">A NOTE FROM THE OWNER</span><span style="font-size:17px;font-weight:600;line-height:1.45">${esc(r.owner_note)}</span><span style="font-family:'Caveat',cursive;font-size:26px;font-weight:600;color:var(--purple)">Jayne, PT Azure</span></div>
      <span style="font-size:14px;font-weight:700;color:var(--mute2);text-align:center">An admin will give it a quick look, then it's locked into your stash.</span>`;
  } else if (r.grade === "B") {
    const cav = (r.complaints || [])[0];
    const reason = cav ? cav.quote : (r.intensity || 0) < 4 ? (r.intensity_quote || r.summary) : r.summary;
    const tip = cav ? `One small "but" is all it takes. Fix ${esc(cav.issue || "that")}, and the next guest's review could be your A.` : (r.intensity || 0) < 4 ? "The guest was happy, but not over the moon. The A's come when a guest remembers one moment you made for them." : "The praise was general. When a guest can name one thing you did, that's the A.";
    $("#r-top").innerHTML = `<span class="breathe">${FACES.cloud}</span><span style="font-size:13px;font-weight:800;letter-spacing:.6px;color:var(--purple)">A BIG HUG FOR THIS ONE</span><h1 style="font-size:28px;text-align:center;text-wrap:balance">So close. This one's a B.</h1><p style="margin:0;font-size:16px;font-weight:600;color:var(--mute2);text-align:center">Full stars and a happy guest is still a good day for the villa. It just doesn't pay out this time.</p><p style="margin:0;font-size:14px;font-weight:700;color:var(--mute2);text-align:center">${where}</p>`;
    $("#r-body").innerHTML = `<div class="card col" style="gap:10px;border-radius:24px"><span class="fred" style="font-size:18px">What kept it from an A</span><div class="quote">"${esc(reason)}"</div><span style="font-size:15px">${tip}</span></div>
      <div class="card thin" style="background:var(--mint);border-radius:22px;font-size:15px"><strong>Your stash is safe and sound:</strong> ${stash ? `${rp(stash.total)}, waiting for payday on ${esc(stash.payday.label)}.` : "waiting for payday."}</div>`;
    $("#r-second").style.display = "";
  } else {
    const comp = (r.complaints || []).find((c) => c.severity === "complaint") || (r.complaints || [])[0];
    $("#r-top").innerHTML = `<span class="breathe">${FACES.cup}</span><span style="font-size:13px;font-weight:800;letter-spacing:.6px;color:var(--purple)">TAKE A BREATH</span><h1 style="font-size:28px;text-align:center;text-wrap:balance">This one was tough. It's a C.</h1><p style="margin:0;font-size:16px;font-weight:600;color:var(--mute2);text-align:center">A guest wasn't happy with something. It happens to the best teams, and it's never on one person alone.</p><p style="margin:0;font-size:14px;font-weight:700;color:var(--mute2);text-align:center">${where}</p>`;
    $("#r-body").innerHTML = `<div class="card col" style="gap:10px;border-radius:24px"><span class="fred" style="font-size:18px">What the guest felt</span><div class="quote">"${esc(comp ? comp.quote : r.summary)}"</div><span style="font-size:15px">Your host has been told. The fix goes on the Monday board, and we sort it out together.</span></div>
      <div class="card thin" style="background:var(--mint);border-radius:22px;font-size:15px"><strong>Nothing is ever taken from your stash.</strong> ${stash ? `${rp(stash.total)} is still yours on ${esc(stash.payday.label)}.` : ""}</div>
      <div class="note">Tomorrow's guest is a fresh start. You've got this.</div>`;
  }
  if (rs.length > 1) $("#r-more").innerHTML = `<h2 style="font-size:18px">Also in this upload</h2>` + rs.slice(1).map((x) => `<div class="win${x.duplicate_of ? " pending" : ""}"><span class="g">${esc(x.duplicate_of ? "=" : x.grade)}</span><span class="t">${dot(x.platform)}${esc(x.guest || "Guest")} · ${esc(x.villa)}<small>${x.duplicate_of ? "Already uploaded before" : x.grade === "A" ? "Waiting for an admin's look" : x.grade === "B" ? "A B: no payout this time" : "A C: nothing is deducted"}</small></span></div>`).join("");
  const notes = (job.notes || []).concat(job.errors || []);
  if (notes.length) $("#r-more").insertAdjacentHTML("beforeend", `<div class="small">${esc(notes.join(" · "))}</div>`);
  show("result");
}
function alertBox(msg) { const el = document.createElement("div"); el.className = "note"; el.style.background = "#F9D9C8"; el.textContent = msg; $("#s-home").insertBefore(el, $("#s-home").children[1]); setTimeout(() => el.remove(), 8000); }

// ---------- stash ----------
async function loadStash() {
  homeData = await api("/api/me");
  const st = homeData.stash; me = homeData.me;
  const roleName = me.role.charAt(0).toUpperCase() + me.role.slice(1);
  $("#stash-role").textContent = `${roleName} · ${me.villas.length} villa${me.villas.length === 1 ? "" : "s"}`;
  $("#stash-total").textContent = rp(st.total);
  $("#stash-payday").textContent = `${st.payday.days} days · ${st.payday.label}`;
  const need = Math.max(1, Math.ceil((st.next_milestone - st.total) / Math.max(1, st.share_estimate)));
  $("#stash-mile").textContent = st.total ? `${need} more Grade A${need === 1 ? "" : "'s"} and you pass ${rp(st.next_milestone).replace(".000.000", " million").replace(".000", "k")}` : "Your first Grade A starts the stash";
  $("#stash-milebar").style.width = Math.min(99, Math.round((st.total / st.next_milestone) * 100)) + "%";
  $("#stash-rate").textContent = `Each Grade A review adds about ${rp(st.share_estimate)} to your stash, plus ${rp(st.name_bonus)} whenever a guest names you.`;
  const cols = ["var(--yellow)", "var(--mint)", "var(--lav)", "var(--pink)", "var(--lilac)"];
  $("#stash-villas").innerHTML = me.villas.map((v, i) => { const b = st.by_villa.find((x) => x.villa === v) || { amount: 0, wins: 0, named: 0 }; return `<div class="tile" style="background:${cols[i % cols.length]}"><b>${esc(villas.find((x) => x.key === v)?.name || v)}</b><span class="amt">${b.amount ? "Rp " + rb(b.amount) : "Rp 0"}</span><span>${b.wins ? `${b.wins} A${b.wins === 1 ? "" : "'s"}` : "No A's yet"}${b.named ? ` + named ${b.named === 1 ? "once" : b.named + " times"}` : ""}${b.wins === 1 ? " · first of many" : ""}</span></div>`; }).join("");
  const wins = st.wins.slice(0, 8);
  $("#stash-wins").innerHTML = wins.length ? wins.map((w) => `<div class="win${w.status === "pending" ? " pending" : ""}"><span class="g">${w.status === "pending" ? "A?" : "A"}</span><span class="t"><span>${dot(w.channel)}${esc(w.channel)} · ${esc(w.villa)} · ${esc(fmtDate(w.date))}</span><small class="${w.named ? "named" : ""}">${w.status === "pending" ? "Admin is checking it" : w.named ? "The guest named you!" : "Locked in"}</small></span><span class="amt">${w.status === "pending" ? "soon" : "+" + rb(w.amount)}</span></div>`).join("") : `<div class="note">No wins yet this season. The first one is the sweetest.</div>`;
  $("#stash-more").textContent = st.wins.length > 8 ? `and ${st.wins.length - 8} more Grade A reviews` : "";
  $("#stash-paydays").innerHTML = st.paydays.map((p) => `<div class="${p.next ? "next" : ""}"><b>${esc(p.label)}</b><span>${p.next ? "Next! " : ""}${esc(p.season)}</span></div>`).join("");
}

// ---------- admin ----------
let adminData = null;
async function loadAdmin() {
  adminData = await api("/api/admin/queue?villa=" + encodeURIComponent($("#q-villa").value || ""));
  $("#admin-name").textContent = adminData.me.name;
  $("#admin-scope").textContent = adminData.me.scope ? `You see ${adminData.me.operator} villas only.` : "Owner Admin sees every villa.";
  // Villa pickers only show the villas this admin looks after.
  const vopts = adminData.villas.map((v) => `<option value="${esc(v.key)}">${esc(v.name)}</option>`).join("");
  const keep = $("#q-villa").value; $("#q-villa").innerHTML = '<option value="">All villas</option>' + vopts; $("#q-villa").value = keep;
  const rk = $("#rp-villa").value, gk = $("#g-villa").value; $("#rp-villa").innerHTML = vopts; $("#g-villa").innerHTML = vopts; if (rk) $("#rp-villa").value = rk; if (gk) $("#g-villa").value = gk;
  $("#q-count").textContent = `To confirm · ${adminData.pending.length}`;
  $("#reset-test").style.display = /owner/i.test(adminData.me.name) ? "" : "none";
  $("#queue").innerHTML = adminData.pending.length ? adminData.pending.map(queueCard).join("") : `<div class="card thin"><span class="fred" style="font-size:18px">Nothing waiting.</span><br><span class="small">New uploads appear here for a quick look.</span></div>`;
  $$("#queue [data-toggle]").forEach((b) => (b.onclick = () => { const full = $("#full-" + b.dataset.toggle), short = $("#short-" + b.dataset.toggle); const on = full.hidden; full.hidden = !on; short.hidden = on; b.textContent = on ? "Hide full review" : "Read full review with highlights"; }));
  $$("#queue [data-confirm]").forEach((b) => (b.onclick = () => confirmUI(b.dataset.confirm, b.dataset.grade)));
  $$("#queue [data-change]").forEach((b) => (b.onclick = () => { const box = $("#change-" + b.dataset.change); box.hidden = !box.hidden; }));
  $$("#queue [data-set]").forEach((b) => (b.onclick = () => confirmUI(b.dataset.set, b.dataset.grade)));
  const staffByVilla = (v) => adminData.staff.filter((s) => s.villas.includes(v));
  const fillWho = () => { $("#rp-who").innerHTML = staffByVilla($("#rp-villa").value).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""); };
  $("#rp-villa").onchange = fillWho; fillWho();
  renderGoalEditor();
  const last = adminData.audit.find((a) => a.action === "reset_pin");
  $("#rp-msg").textContent = last ? `Last reset: ${last.name} · by ${last.actor} · ${fmtDate(last.at)}` : "";
  $("#audit").innerHTML = adminData.audit.slice(0, 30).map((a) => `<span>${esc(fmtDate(a.at))} · <b>${esc(a.actor)}</b> ${esc(a.action === "reset_pin" ? "reset PIN for " + a.name : a.action + " " + (a.grade || "") + (a.suggested && a.suggested !== a.grade ? " (was " + a.suggested + ")" : "") + " · " + (a.villa || ""))}</span>`).join("") || `<span class="small">Nothing yet.</span>`;
  $("#export").href = "#"; $("#export").onclick = async (e) => { e.preventDefault(); const r = await fetch("/api/admin/export", { headers: { "x-session": session } }); const blob = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `payout-lines-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(a); a.click(); a.remove(); };
}
$("#q-villa").addEventListener("change", loadAdmin);
function highlightHTML(r) {
  let text = esc(r.review_text || "");
  const cls = { praise: "hs", recommends: "hg", staff: "hl", complaint: "ha", check: "hf" };
  (r.highlights || []).sort((a, b) => b.text.length - a.text.length).forEach((h) => { const q = esc(h.text); if (q && text.includes(q)) text = text.replace(q, `<mark class="${cls[h.type] || "hf"}">${q}</mark>`); });
  return text;
}
function queueCard(r) {
  const villaName = villas.find((v) => v.key === r.villa)?.name || r.villa;
  const top = (r.checklist || [])[0];
  const tags = [];
  (r.staff_named || []).forEach((s) => tags.push(`Names: ${esc(s.name)}`));
  const comps = (r.complaints || []).filter((c) => c.severity === "complaint"), cav = (r.complaints || []).filter((c) => c.severity !== "complaint");
  if (comps.length) tags.push(`Complaint: ${esc(comps[0].issue || "")}`); if (cav.length) tags.push(`Has a "but": ${esc(cav[0].issue || "")}`);
  if (!comps.length && !cav.length) tags.push("No complaints"); if (!(r.specifics || []).length) tags.push("General praise");
  const flags = (r.flags || []).map((f) => `<span class="tag warn">Check: ${esc(f.replace(/_/g, " "))}</span>`).join("");
  const roster = adminData.staff.filter((s) => s.villas.includes(r.villa));
  const mentions = (r.staff_named || []).length && r.grade !== "C" ? `<div class="col" style="gap:2px"><span class="small"><b>Who did the guest name?</b> Tick to pay the ${rp(200000)} name bonus.</span>${roster.map((s) => { const guess = (r.staff_named || []).some((n) => n.name.toLowerCase().split(" ").some((w) => s.name.toLowerCase().includes(w))); return `<label class="mention"><input type="checkbox" data-mention="${esc(r.id)}" value="${esc(s.id)}" ${guess ? "checked" : ""}>${esc(s.name)} <span class="small">(${esc(s.role)})</span></label>`; }).join("")}</div>` : "";
  const firstQuote = ((r.specifics || [])[0] || {}).quote || r.summary || "";
  return `<article class="card thin col" style="gap:10px;border-radius:22px" id="card-${esc(r.id)}">
    <div class="row"><span class="badge ${esc(r.grade)}">${esc(r.grade)}</span><span class="col" style="gap:0"><span style="font-size:16px;font-weight:800">Suggested ${esc(r.grade)} · ${esc(r.score)} / 100</span><span class="small">${dot(r.platform)}${esc(r.platform)} · ${esc(villaName)} · ${esc(r.rating != null ? r.rating + (r.rating_max === 10 || (r.rating > 5) ? " / 10" : " stars") : "no rating")} · ${esc(r.guest || "Guest")}</span><span class="small">Uploaded by ${esc(r.team || "")} · ${esc(fmtDate(r.graded_at))}</span></span></div>
    <p id="short-${esc(r.id)}" style="margin:0;font-size:15px;line-height:1.45;font-style:italic;color:var(--mute2)">"… ${esc(firstQuote)} …"</p>
    <div id="full-${esc(r.id)}" hidden class="col" style="gap:10px">
      <div class="legend"><span><i class="sw" style="background:#DDF7EC"></i>Praise</span><span><i class="sw" style="background:#F7E3B0"></i>Recommends</span><span><i class="sw" style="background:#EDE6FF"></i>Staff named</span><span><i class="sw" style="background:#F9D9C8"></i>Complaint</span><span><i class="sw" style="border-style:dashed"></i>Check this</span></div>
      <p style="margin:0;font-size:15px;line-height:1.6">${highlightHTML(r)}</p>
      <div class="checks">${(r.checklist || []).map((c) => `<span>${c.ok ? "✓" : "✕"} ${esc(c.text)}</span>`).join("")}</div>
    </div>
    <button class="link" data-toggle="${esc(r.id)}" style="align-self:flex-start;font-size:14px;min-height:32px">Read full review with highlights</button>
    <div class="row" style="flex-wrap:wrap;gap:6px">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}${flags}</div>
    ${mentions}
    <div class="row" style="gap:8px"><button class="abtn dark" data-confirm="${esc(r.id)}" data-grade="${esc(r.grade)}">Confirm ${esc(r.grade)}</button><button class="abtn light" data-change="${esc(r.id)}">Change grade</button></div>
    <div class="row" id="change-${esc(r.id)}" hidden style="gap:8px">${["A", "B", "C"].filter((g) => g !== r.grade).map((g) => `<button class="abtn light" data-set="${esc(r.id)}" data-grade="${g}">Make it ${g}</button>`).join("")}</div>
    <div class="err" id="err-${esc(r.id)}"></div>
  </article>`;
}
async function confirmUI(id, grade) {
  const mentions = $$(`[data-mention="${CSS.escape(id)}"]:checked`).map((c) => c.value);
  $$(`#card-${CSS.escape(id)} button`).forEach((b) => (b.disabled = true));
  try { await api(`/api/admin/reviews/${encodeURIComponent(id)}/confirm`, { method: "POST", body: JSON.stringify({ grade, name_mentions: mentions }) }); await loadAdmin(); }
  catch (e) { $("#err-" + CSS.escape(id)).textContent = e.message; $$(`#card-${CSS.escape(id)} button`).forEach((b) => (b.disabled = false)); }
}
$("#rp-go").addEventListener("click", async () => { const id = $("#rp-who").value; if (!id) return; $("#rp-go").disabled = true; try { const d = await api(`/api/admin/staff/${encodeURIComponent(id)}/reset-pin`, { method: "POST" }); $("#rp-msg").textContent = `Done: ${d.name}'s PIN is 8888 until they log in.`; } catch (e) { $("#rp-msg").textContent = e.message; } finally { $("#rp-go").disabled = false; } });
function renderGoalEditor() {
  const v = $("#g-villa").value; const g = (adminData.goals || {})[v] || {};
  $("#g-rows").innerHTML = Object.keys(GOALS).map((ch) => `<div class="row" style="gap:6px;font-size:13px;font-weight:800"><span style="flex:1">${dot(ch)}${esc(ch)}</span><input class="input" style="height:40px;width:74px;font-size:14px" type="number" min="0" placeholder="count" value="${g[ch]?.count ?? ""}" data-gcount="${esc(ch)}"><input class="input" style="height:40px;width:74px;font-size:14px" type="number" step="0.01" min="0" placeholder="score" value="${g[ch]?.score ?? ""}" data-gscore="${esc(ch)}"><button class="abtn light" style="flex:0 0 auto;min-height:40px;font-size:13px" data-gsave="${esc(ch)}">Save</button></div>`).join("");
  $$("#g-rows [data-gsave]").forEach((b) => (b.onclick = async () => { const ch = b.dataset.gsave; b.disabled = true; try { const d = await api("/api/admin/goals", { method: "POST", body: JSON.stringify({ villa: v, channel: ch, count: $(`[data-gcount="${CSS.escape(ch)}"]`).value, score: $(`[data-gscore="${CSS.escape(ch)}"]`).value }) }); adminData.goals = d.goals; b.textContent = "Saved"; setTimeout(() => (b.textContent = "Save"), 1500); } finally { b.disabled = false; } }));
}
$("#g-villa").addEventListener("change", renderGoalEditor);
let resetArmed = false;
$("#reset-test").addEventListener("click", async () => { const b = $("#reset-test"); if (!resetArmed) { resetArmed = true; b.textContent = "Tap again to wipe reviews, payouts and audit"; setTimeout(() => { resetArmed = false; b.textContent = "Reset test data"; }, 6000); return; } resetArmed = false; b.disabled = true; try { const d = await api("/api/admin/reset-test-data", { method: "POST" }); $("#reset-msg").textContent = `Done. Cleared the site and removed ${d.archived} Notion rows. PINs are kept.`; await loadAdmin(); } catch (e) { $("#reset-msg").textContent = e.message; } finally { b.disabled = false; b.textContent = "Reset test data"; } });

// ---------- start ----------
(async () => {
  try { await loadVillas(); } catch {}
  if (session && kind === "staff") { try { await go("home"); await resumeJob(); return; } catch (e) { if (e.message === "pin") return; logout(); } }
  if (session && kind === "admin") { try { await go("admin"); return; } catch { logout(); } }
  show("welcome");
})();
document.addEventListener("visibilitychange", () => { if (!document.hidden && kind === "staff" && store("rg-job")) resumeJob(); });
