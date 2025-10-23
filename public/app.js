// public/app.js
// Client-side JS for the Draw page (supports multi-tier/budget gifts).
// Expects backend /api/me and /api/draw to return recipients grouped by tier.
// Also uses window.triggerConfetti(themeIndex, durationMs) if available.

(function () {
  // Helpers to get token from querystring
  const params = new URLSearchParams(location.search);
  const token = params.get("token");

  // DOM refs
  const titleEl = document.getElementById("title");
  const helloEl = document.getElementById("hello");
  const eventNameEl = document.getElementById("eventName");
  const gppEl = document.getElementById("gpp");
  const recipientsEl = document.getElementById("recipients");
  const noneEl = document.getElementById("none");
  const drawBtn = document.getElementById("drawBtn");
  const errorEl = document.getElementById("error");
  const noteEl = document.getElementById("note");
  const resendBtn = document.getElementById("resendBtn"); // may be null if not added
  const wishlistBtn = document.getElementById("wishlistBtn");

  if (!token) {
    if (errorEl) errorEl.textContent = "Invalid or missing invite link.";
    if (drawBtn) drawBtn.disabled = true;
    throw new Error("Missing token");
  }

  // Render recipients grouped by tier (ordered list)
  function renderByTier(list) {
    recipientsEl.innerHTML = "";
    if (!Array.isArray(list) || list.length === 0) {
      noneEl.style.display = "block";
      return;
    }
    noneEl.style.display = "none";

    // create list items: "Gift 1 ($100): Alice"
    for (const t of list) {
      const li = document.createElement("li");
      const dollars = (t.budget_cents / 100).toFixed(0);
      const recipientText = t.recipient ? t.recipient : "—";
      li.textContent = `${t.name} ($${dollars}): ${recipientText}`;
      recipientsEl.appendChild(li);
    }
  }

  // Load /api/me
  async function loadMe() {
    errorEl.textContent = "";
    try {
      const res = await fetch(`/api/me?token=${encodeURIComponent(token)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load user data");
      }

      // Update UI
      titleEl.textContent = `${data.event.name} — Draw`;
      helloEl.textContent = `Hello, ${data.me.name} (${data.me.email})`;
      eventNameEl.textContent = data.event.name;
      // Show number of tiers instead of "gifts per person"
      gppEl.textContent = (Array.isArray(data.event.tiers) ? data.event.tiers.length : 0);

      renderByTier(data.recipients_by_tier);

      const haveAll = (Array.isArray(data.recipients_by_tier) && data.recipients_by_tier.every(t => !!t.recipient));
      const canDraw = !data.me.has_drawn || !haveAll;
      drawBtn.disabled = !canDraw;

      // After computing `haveAll` and `canDraw`
      const wlUrl = `/wishlists?token=${encodeURIComponent(token)}`;
      if (wishlistBtn) {
        const hasAnyRecipient = Array.isArray(data.recipients_by_tier) && data.recipients_by_tier.some(t => !!t.recipient);
        if (data.me.has_drawn && hasAnyRecipient) {
          wishlistBtn.style.display = "";   // show
          wishlistBtn.disabled = false;
          wishlistBtn.onclick = () => { location.href = wlUrl; };
        } else {
          wishlistBtn.style.display = "none"; // hide until drawn
          wishlistBtn.onclick = null;
        }
      }

      if (!canDraw) {
        noteEl.textContent = "You’re all set! A confirmation email has been sent.";
      } else {
        noteEl.textContent = "";
      }

      // If present, toggle resend button availability
      if (resendBtn) {
        resendBtn.disabled = !(Array.isArray(data.recipients_by_tier) && data.recipients_by_tier.some(t => !!t.recipient));
      }

      return data;
    } catch (err) {
      errorEl.textContent = String(err.message || err);
      drawBtn.disabled = true;
      if (resendBtn) resendBtn.disabled = true;
      return null;
    }
  }

  // Draw action: reveals preassigned recipients and triggers email on server
  async function draw() {
    drawBtn.disabled = true;
    errorEl.textContent = "";
    const origText = drawBtn.textContent;
    drawBtn.textContent = "Drawing…";
    try {
      const resp = await fetch("/api/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "Draw failed");
      }

      // Fire confetti for 5s unless user prefers reduced motion
      try {
        const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!prefersReducedMotion && window.triggerConfetti) {
          window.triggerConfetti(0, 5000);
        }
      } catch (e) {
        // ignore confetti errors
        // console.warn("Confetti error", e);
      }

      // refresh UI to show recipients
      await loadMe();
    } catch (err) {
      errorEl.textContent = String(err.message || err);
      // keep button enabled so user can retry if recoverable
      drawBtn.disabled = false;
    } finally {
      drawBtn.textContent = origText;
    }
  }

  // Optional: resend assignment email if server supports /api/resend
  async function resendEmail() {
    if (!resendBtn) return;
    resendBtn.disabled = true;
    errorEl.textContent = "";
    const orig = resendBtn.textContent;
    resendBtn.textContent = "Sending…";
    try {
      const res = await fetch("/api/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Resend failed");
      noteEl.textContent = "Email re-sent. Check your inbox.";
    } catch (err) {
      errorEl.textContent = String(err.message || err);
    } finally {
      resendBtn.textContent = orig;
      // allow resend again
      resendBtn.disabled = false;
    }
  }

  // Wire up events
  drawBtn.addEventListener("click", draw);
  if (resendBtn) resendBtn.addEventListener("click", resendEmail);

  // initial load
  loadMe();
})();
