(function () {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");

  const title = document.getElementById("title");
  const hello = document.getElementById("hello");
  const eventName = document.getElementById("eventName");
  const gpp = document.getElementById("gpp");
  const recipients = document.getElementById("recipients");
  const none = document.getElementById("none");
  const drawBtn = document.getElementById("drawBtn");
  const errorEl = document.getElementById("error");
  const note = document.getElementById("note");

  if (!token) {
    errorEl.textContent = "Invalid or missing invite link.";
    return;
  }

  function renderRecipients(list) {
    recipients.innerHTML = "";
    if (!list || !list.length) {
      none.style.display = "block";
    } else {
      none.style.display = "none";
      for (const r of list) {
        const li = document.createElement("li");
        li.textContent = r;
        recipients.appendChild(li);
      }
    }
  }

  async function loadMe() {
    errorEl.textContent = "";
    const res = await fetch(`/api/me?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || "Failed to load";
      drawBtn.disabled = true;
      return;
    }
    title.textContent = `${data.event.name} — Draw`;
    hello.textContent = `Hello, ${data.me.name} (${data.me.email})`;
    eventName.textContent = data.event.name;
    gpp.textContent = data.event.gifts_per_person;
    renderRecipients(data.recipients);

    const canDraw =
      !data.me.has_drawn ||
      data.recipients.length < data.event.gifts_per_person;
    drawBtn.disabled = !canDraw;
    note.textContent = canDraw
      ? ""
      : "You’re all set! A confirmation email has been sent.";
  }

  async function draw() {
    drawBtn.disabled = true;
    errorEl.textContent = "";
    drawBtn.textContent = "Drawing…";
    try {
      const r = await fetch("/api/draw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (!r.ok) {
        errorEl.textContent = d.error || "Draw failed";
      } else {
        // ✅ Fire confetti once on success
        if (window.triggerConfetti) window.triggerConfetti(0, 5000); // 5s
      }
      await loadMe();
    } catch (e) {
      errorEl.textContent = String(e);
    } finally {
      drawBtn.textContent = "Draw now";
    }
  }

  drawBtn.addEventListener("click", draw);
  loadMe();

  const resendBtn = document.getElementById("resendBtn");
  resendBtn.addEventListener("click", async () => {
    resendBtn.disabled = true;
    errorEl.textContent = "";
    try {
      const r = await fetch("/api/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Resend failed");
      note.textContent = "Email sent. Check your inbox.";
    } catch (e) {
      errorEl.textContent = String(e);
    } finally {
      resendBtn.disabled = false;
    }
  });

})();
